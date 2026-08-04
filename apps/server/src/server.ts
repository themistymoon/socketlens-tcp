/**
 * The SocketLens TCP control server.
 *
 * A single `node:net` listener accepts SLTP control connections. Every connection owns
 * its own decoder, its own rate limiter, and its own receive buffer, because two TCP
 * connections are two independent byte streams and must never share framing state.
 *
 * Nothing a client sends can take the process down: framing failures, validation
 * failures, handler exceptions, and socket errors are all answered with a numbered
 * SLTP status or logged and contained on the offending connection alone.
 */
import net from 'node:net';
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOST,
  decodedMessages,
  encodeResponse,
  firstDecodeFailure,
  isRequest,
  SERVER_PRODUCT,
  SLTP_HEADER,
  SLTP_REASON,
  SLTP_STATUS,
  SltpDecoder,
  getHeader,
  statusForReason,
  statusPhrase,
  validateRequest,
  type SltpRequest,
} from '@socketlens/protocol';
import {
  newConnectionId,
  ProtocolLogger,
  SessionStore,
  describeError,
  type LogLevel,
} from '@socketlens/core';
import {
  handleOperation,
  phraseFor,
  type HandlerContext,
  type HandlerResponse,
} from './handlers.js';

/** Configuration for a control server. */
export interface SltpServerOptions {
  /** Interface to bind. Loopback by default: this is a local development tool. */
  readonly host?: string;
  /** TCP port. Use 0 to let the operating system assign one, as the tests do. */
  readonly port?: number;
  readonly logger?: ProtocolLogger;
  /** Verbosity when the server builds its own logger. */
  readonly logLevel?: LogLevel;
  /** Maximum simultaneous control connections. Further connections get 503. */
  readonly maxConnections?: number;
  /** Maximum concurrent sessions. */
  readonly maxSessions?: number;
  /** Per-connection request rate limit. Set to `false` to disable it. */
  readonly rateLimit?: RateLimitOptions | false;
  /**
   * Extra hosts a scenario may target. Empty by default; loopback is always allowed
   * and everything else is refused, because SocketLens TCP tests local endpoints only.
   */
  readonly allowedTargetHosts?: readonly string[];
}

/** Token-bucket settings applied to each connection independently. */
export interface RateLimitOptions {
  /** Burst size: how many requests may arrive back to back. */
  readonly capacity: number;
  /** Sustained rate in requests per second. */
  readonly refillPerSecond: number;
}

/** Generous defaults — this limit exists to catch runaway loops, not to throttle a user. */
export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  capacity: 120,
  refillPerSecond: 60,
};

/** Default cap on simultaneous control connections. */
export const DEFAULT_MAX_CONNECTIONS = 64;

/** The address a listening server occupies. */
export interface ServerAddress {
  readonly host: string;
  readonly port: number;
}

/** Per-connection state. */
interface ConnectionState {
  readonly id: string;
  readonly socket: net.Socket;
  readonly decoder: SltpDecoder;
  /** Token bucket, or undefined when rate limiting is disabled. */
  bucket: { tokens: number; lastRefillMs: number } | undefined;
  /** Requests currently being handled on this connection. */
  inFlight: number;
  /** Set when a response asked for the connection to close once it is idle. */
  closeWhenIdle: boolean;
  requestCount: number;
}

/**
 * A control server instance.
 *
 * Construct, `listen()`, and later `close()`. The same class backs the CLI entry point
 * and the integration tests, so the tests exercise the real server rather than a stub.
 */
export class SltpServer {
  private readonly options: SltpServerOptions;
  private readonly logger: ProtocolLogger;
  private readonly store: SessionStore;
  private readonly connections = new Set<ConnectionState>();
  private readonly rateLimit: RateLimitOptions | undefined;
  private readonly maxConnections: number;
  private server: net.Server | undefined;
  private bound: ServerAddress | undefined;
  private startedAt = Date.now();
  private shuttingDown = false;

  constructor(options: SltpServerOptions = {}) {
    this.options = options;
    this.logger =
      options.logger ??
      new ProtocolLogger({ role: 'SERVER', level: options.logLevel ?? 'summary' });
    this.store = new SessionStore({
      logger: this.logger,
      ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
    });
    this.rateLimit =
      options.rateLimit === false ? undefined : (options.rateLimit ?? DEFAULT_RATE_LIMIT);
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  }

  /** The bound address, available only while listening. */
  get address(): ServerAddress | undefined {
    return this.bound;
  }

  /** The session store, exposed so tests and the bridge can inspect server state. */
  get sessions(): SessionStore {
    return this.store;
  }

  /** Number of control connections currently open. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Binds the listener and resolves with the address actually assigned. */
  async listen(): Promise<ServerAddress> {
    if (this.bound) return this.bound;

    const host = this.options.host ?? DEFAULT_HOST;
    const port = this.options.port ?? DEFAULT_CONTROL_PORT;

    const server = net.createServer((socket) => this.accept(socket));

    // A listener-level error must be reported, never thrown into the event loop.
    server.on('error', (cause) => {
      this.logger.error(`control listener error: ${cause.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      const onListenError = (cause: NodeJS.ErrnoException): void => {
        server.removeListener('error', onListenError);
        reject(
          new Error(
            cause.code === 'EADDRINUSE'
              ? `Port ${port} on ${host} is already in use. Stop the other process or start the server with --port <n>.`
              : `Could not bind ${host}:${port}: ${cause.message}`,
          ),
        );
      };
      server.once('error', onListenError);
      server.listen(port, host, () => {
        server.removeListener('error', onListenError);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error(
        'The control listener did not receive a TCP address from the operating system.',
      );
    }

    this.server = server;
    this.startedAt = Date.now();
    this.bound = { host: address.address, port: address.port };
    this.shuttingDown = false;

    this.logger.info(
      `${SERVER_PRODUCT} listening on ${this.bound.host}:${this.bound.port} (raw TCP, SLTP/1.0)`,
    );
    return this.bound;
  }

  /**
   * Shuts down gracefully: stops accepting, answers anything still arriving with 503,
   * lets in-flight requests finish, closes every session's mock endpoint, and then
   * closes the remaining sockets.
   */
  async close(gracePeriodMs = 2_000): Promise<void> {
    const server = this.server;
    if (!server) return;

    this.shuttingDown = true;
    this.logger.info('shutting down: no longer accepting new connections');

    // `close()` stops the listener at once, but its callback only fires after every
    // connection has ended. Capturing the promise here and awaiting it last is what
    // keeps the sequence from deadlocking against its own open sockets.
    const listenerClosed = new Promise<void>((resolve) => server.close(() => resolve()));

    // Give in-flight handlers a bounded chance to finish before the sockets go.
    const deadline = Date.now() + gracePeriodMs;
    while (Date.now() < deadline && [...this.connections].some((c) => c.inFlight > 0)) {
      await sleep(25);
    }

    await this.store.closeAll();

    for (const connection of [...this.connections]) {
      connection.socket.destroy();
    }
    this.connections.clear();

    await listenerClosed;

    this.server = undefined;
    this.bound = undefined;
    this.logger.info('shutdown complete');
  }

  // ─── connections ───────────────────────────────────────────────────────────

  /** Sets up one accepted connection. */
  private accept(socket: net.Socket): void {
    const state: ConnectionState = {
      id: newConnectionId(),
      socket,
      decoder: new SltpDecoder({ expect: 'request' }),
      bucket: this.rateLimit
        ? { tokens: this.rateLimit.capacity, lastRefillMs: Date.now() }
        : undefined,
      inFlight: 0,
      closeWhenIdle: false,
      requestCount: 0,
    };

    if (this.shuttingDown || this.connections.size >= this.maxConnections) {
      const detail = this.shuttingDown
        ? 'The server is shutting down and is not accepting new connections.'
        : `The server already has ${this.connections.size} control connection(s) open, which is its configured maximum.`;
      this.logger.connection('open', state.id, 'refused');
      // Even a refused connection needs an error listener, or a reset while we write
      // the 503 would surface as an uncaught exception.
      socket.on('error', (cause) => {
        this.logger.connection('error', state.id, cause.message);
      });
      void this.writeResponse(state, undefined, {
        statusCode: SLTP_STATUS.SERVER_UNAVAILABLE,
        ...(this.shuttingDown
          ? { headers: { [SLTP_HEADER.reason]: SLTP_REASON.serverShuttingDown } }
          : {}),
        json: { error: detail },
        close: true,
      });
      return;
    }

    this.connections.add(state);
    socket.setNoDelay(true);
    this.logger.connection(
      'open',
      state.id,
      `peer=${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0} total=${this.connections.size}`,
    );

    socket.on('data', (chunk: Buffer) => this.receive(state, chunk));

    socket.on('error', (cause) => {
      // A client that vanishes mid-write produces ECONNRESET. That is a client-side
      // event, not a server fault, so it is logged and contained here.
      this.logger.connection('error', state.id, cause.message);
    });

    socket.on('close', () => {
      const truncated = firstDecodeFailure(state.decoder.end());
      if (truncated) {
        this.logger.frameError('received', truncated.error.reason, truncated.error.message, {
          connectionId: state.id,
          raw: truncated.raw,
        });
      }
      this.connections.delete(state);
      this.logger.connection(
        'close',
        state.id,
        `requests=${state.requestCount} remaining=${this.connections.size}`,
      );
    });
  }

  /** Feeds received bytes to this connection's decoder and acts on every event. */
  private receive(state: ConnectionState, chunk: Buffer): void {
    if (state.socket.destroyed) return;

    for (const event of state.decoder.push(chunk)) {
      if (event.type === 'error') {
        this.logger.frameError('received', event.error.reason, event.error.message, {
          connectionId: state.id,
          raw: event.raw,
        });

        void this.writeResponse(state, undefined, {
          statusCode: statusForReason(event.error.reason),
          headers: { [SLTP_HEADER.reason]: event.error.reason },
          json: { error: event.error.message, reason: event.error.reason },
          // A fatal error means the byte stream can no longer be resynchronised at a
          // message boundary, so continuing to read it would be guesswork.
          close: event.error.fatal,
        });

        if (event.error.fatal) return;
        continue;
      }

      const message = event.message;
      if (!isRequest(message)) {
        void this.writeResponse(state, undefined, {
          statusCode: SLTP_STATUS.BAD_REQUEST,
          headers: { [SLTP_HEADER.reason]: SLTP_REASON.unexpectedMessageKind },
          json: { error: 'The control server accepts SLTP requests, not responses.' },
          close: true,
        });
        return;
      }

      state.requestCount += 1;
      this.logger.message('received', message, event.raw, {
        connectionId: state.id,
        peer: 'CLIENT',
      });

      // Requests are handled concurrently. Responses carry the Request-ID they answer,
      // so a slow RUN_TEST never blocks a PING that arrives behind it.
      void this.dispatch(state, message);
    }
  }

  /** Runs one request through admission control, validation, and its handler. */
  private async dispatch(state: ConnectionState, request: SltpRequest): Promise<void> {
    const requestId = getHeader(request.headers, SLTP_HEADER.requestId);
    state.inFlight += 1;

    try {
      if (this.shuttingDown) {
        await this.writeResponse(state, requestId, {
          statusCode: SLTP_STATUS.SERVER_UNAVAILABLE,
          headers: { [SLTP_HEADER.reason]: SLTP_REASON.serverShuttingDown },
          json: { error: 'The server is shutting down and is not accepting new requests.' },
          close: true,
        });
        return;
      }

      const retryAfterMs = this.consumeToken(state);
      if (retryAfterMs !== undefined) {
        await this.writeResponse(state, requestId, {
          statusCode: SLTP_STATUS.TOO_MANY_REQUESTS,
          headers: {
            [SLTP_HEADER.reason]: SLTP_REASON.rateLimited,
            [SLTP_HEADER.retryAfter]: retryAfterMs,
          },
          json: {
            error:
              `This connection exceeded ${this.rateLimit?.capacity} queued request(s). ` +
              `Retry in ${retryAfterMs} ms.`,
            retryAfterMs,
          },
        });
        return;
      }

      const validation = validateRequest(request);
      if (!validation.ok) {
        this.logger.frameError('received', validation.error.reason, validation.error.message, {
          connectionId: state.id,
        });
        await this.writeResponse(state, requestId, {
          statusCode: statusForReason(validation.error.reason),
          headers: { [SLTP_HEADER.reason]: validation.error.reason },
          json: { error: validation.error.message, reason: validation.error.reason },
          close: validation.error.fatal,
        });
        return;
      }

      const response = await handleOperation(request, validation.value, this.context());
      await this.writeResponse(state, validation.value.requestId, response);
    } catch (cause) {
      // A handler bug is a server fault: report it as 500 and keep serving.
      this.logger.error(`conn=${state.id} handler failed: ${describeError(cause)}`);
      await this.writeResponse(state, requestId, {
        statusCode: SLTP_STATUS.INTERNAL_SERVER_ERROR,
        json: { error: `The server failed to handle the request: ${describeError(cause)}` },
      }).catch(() => undefined);
    } finally {
      state.inFlight -= 1;
      if (state.closeWhenIdle && state.inFlight === 0) {
        endSocket(state.socket);
      }
    }
  }

  /** Builds the context handlers run against. */
  private context(): HandlerContext {
    return {
      store: this.store,
      logger: this.logger,
      startedAt: this.startedAt,
      controlHost: this.bound?.host ?? this.options.host ?? DEFAULT_HOST,
      controlPort: this.bound?.port ?? this.options.port ?? DEFAULT_CONTROL_PORT,
      allowedTargetHosts: this.options.allowedTargetHosts ?? [],
      openConnections: () => this.connections.size,
    };
  }

  /**
   * Takes one token from the connection's bucket.
   * Returns `undefined` when the request is admitted, or the milliseconds to wait.
   */
  private consumeToken(state: ConnectionState): number | undefined {
    const limit = this.rateLimit;
    const bucket = state.bucket;
    if (!limit || !bucket) return undefined;

    const now = Date.now();
    const elapsedSeconds = (now - bucket.lastRefillMs) / 1_000;
    bucket.tokens = Math.min(
      limit.capacity,
      bucket.tokens + elapsedSeconds * limit.refillPerSecond,
    );
    bucket.lastRefillMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return undefined;
    }
    return Math.max(1, Math.ceil(((1 - bucket.tokens) / limit.refillPerSecond) * 1_000));
  }

  // ─── writing ───────────────────────────────────────────────────────────────

  /** Encodes, writes, and logs one response. Never throws. */
  private async writeResponse(
    state: ConnectionState,
    requestId: string | undefined,
    response: HandlerResponse,
  ): Promise<void> {
    if (state.socket.destroyed) return;

    const body = response.json === undefined ? null : JSON.stringify(response.json);

    let raw: Buffer;
    try {
      raw = encodeResponse({
        statusCode: response.statusCode,
        statusPhrase: phraseFor(response),
        headers: {
          ...response.headers,
          [SLTP_HEADER.requestId]: requestId,
          [SLTP_HEADER.server]: SERVER_PRODUCT,
          [SLTP_HEADER.timestamp]: new Date().toISOString(),
          ...(response.close ? { [SLTP_HEADER.connection]: 'close' } : {}),
        },
        body,
        json: true,
      });
    } catch (cause) {
      // Encoding our own response should be impossible to fail; if it does, say so
      // in the log and fall back to a minimal message the client can still parse.
      this.logger.error(`conn=${state.id} could not encode a response: ${describeError(cause)}`);
      raw = encodeResponse({
        statusCode: SLTP_STATUS.INTERNAL_SERVER_ERROR,
        statusPhrase: statusPhrase(SLTP_STATUS.INTERNAL_SERVER_ERROR),
        headers: { [SLTP_HEADER.requestId]: requestId, [SLTP_HEADER.server]: SERVER_PRODUCT },
        body: JSON.stringify({ error: 'The server produced an unencodable response.' }),
        json: true,
      });
    }

    await writeChunk(state.socket, raw);

    const echo = decodedMessages(new SltpDecoder({ expect: 'response' }).push(raw))[0];
    if (echo) {
      this.logger.message('sent', echo.message, raw, { connectionId: state.id, peer: 'CLIENT' });
    }

    if (response.close) {
      state.closeWhenIdle = true;
      // A request still being handled owns the socket; `dispatch` closes it when the
      // last in-flight handler finishes.
      if (state.inFlight === 0) endSocket(state.socket);
    }
  }
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Writes one buffer, resolving once the kernel has accepted it. */
function writeChunk(socket: net.Socket, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.write(chunk, () => resolve());
  });
}

/** Half-closes a socket, then forces it shut if the peer never completes the close. */
function endSocket(socket: net.Socket): void {
  if (socket.destroyed) return;
  socket.end();
  const forced = setTimeout(() => socket.destroy(), 1_000);
  forced.unref?.();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Convenience: construct, bind, and return a running server. */
export async function startServer(options: SltpServerOptions = {}): Promise<SltpServer> {
  const server = new SltpServer(options);
  await server.listen();
  return server;
}
