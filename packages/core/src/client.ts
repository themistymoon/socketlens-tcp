/**
 * SLTP client over a raw TCP connection.
 *
 * One instance owns one `node:net` socket and one decoder. Requests are correlated
 * to responses by the `Request-ID` header rather than by arrival order, because SLTP
 * does not promise that a slow operation's response precedes a fast one's. Several
 * requests may therefore be outstanding at once on a single connection.
 *
 * This is the shared client used by the CLI, by the browser bridge, and by the
 * integration tests. Nothing above it re-implements the protocol.
 */
import net from 'node:net';
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOST,
  DEFAULT_TIMEOUT_MS,
  decodedMessages,
  encodeRequest,
  firstDecodeFailure,
  getHeader,
  isResponse,
  SLTP_HEADER,
  SltpDecoder,
  type SltpFrameError,
  type SltpResponse,
} from '@socketlens/protocol';
import { newConnectionId, newRequestId } from './ids.js';
import { silentLogger, type ProtocolLogger } from './logger.js';

/** Connection settings. */
export interface SltpClientOptions {
  readonly host?: string;
  readonly port?: number;
  readonly logger?: ProtocolLogger;
  /** Default milliseconds to wait for a response before rejecting. */
  readonly timeoutMs?: number;
}

/** One request the caller wants sent. */
export interface SendOptions {
  readonly operation: string;
  readonly headers?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: string | null;
  readonly json?: unknown;
  readonly sessionId?: string;
  /** Overrides the client's default timeout for this request only. */
  readonly timeoutMs?: number;
}

/** A completed request-response exchange. */
export interface Exchange {
  readonly requestId: string;
  readonly request: Buffer;
  readonly response: SltpResponse;
  readonly rawResponse: Buffer;
  readonly durationMs: number;
}

/** Raised when the connection fails, a request times out, or framing breaks. */
export class SltpClientError extends Error {
  readonly code: 'not-connected' | 'connect-failed' | 'timeout' | 'closed' | 'framing' | 'encode';
  readonly detail: SltpFrameError | undefined;

  constructor(code: SltpClientError['code'], message: string, detail?: SltpFrameError) {
    super(message);
    this.name = 'SltpClientError';
    this.code = code;
    this.detail = detail;
  }
}

interface Pending {
  readonly requestId: string;
  readonly request: Buffer;
  readonly startedAt: bigint;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (exchange: Exchange) => void;
  readonly reject: (error: SltpClientError) => void;
}

/** A connected SLTP client. */
export class SltpClient {
  private socket: net.Socket | undefined;
  private decoder = new SltpDecoder({ expect: 'response' });
  private readonly pending = new Map<string, Pending>();
  private readonly logger: ProtocolLogger;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private connectionId = '-';
  private closing = false;

  /** Listeners notified when the peer closes the connection unexpectedly. */
  private readonly closeListeners = new Set<(reason: string) => void>();

  /** Listeners that see every inbound chunk exactly as it left the kernel. */
  private readonly rawListeners = new Set<(chunk: Buffer) => void>();

  /** Listeners that see every outbound chunk as it is written. */
  private readonly writeListeners = new Set<(chunk: Buffer) => void>();

  constructor(options: SltpClientOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_CONTROL_PORT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? silentLogger('CLIENT');
  }

  /** True while a socket is open. */
  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  /** The address this client connects to, for display. */
  get address(): string {
    return `${this.host}:${this.port}`;
  }

  /** Identifier used in log lines for this connection. */
  get id(): string {
    return this.connectionId;
  }

  /** Registers a callback for an unexpected disconnect. */
  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Observes inbound bytes before they reach the decoder.
   *
   * `sendRaw` deliberately writes uncorrelated bytes, so the reply to a malformed
   * message cannot be matched by Request-ID and has to be watched for directly.
   */
  onRawData(listener: (chunk: Buffer) => void): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  /**
   * Observes outbound bytes as they are written.
   *
   * The symmetric counterpart to {@link onRawData}. An observer that instead waited for
   * `send()` to resolve would learn of the request only after its response had already
   * arrived, and would render a conversation in which replies precede their requests.
   */
  onRawWrite(listener: (chunk: Buffer) => void): () => void {
    this.writeListeners.add(listener);
    return () => this.writeListeners.delete(listener);
  }

  /**
   * Collects inbound bytes for a fixed window, for use with {@link sendRaw}.
   *
   * The window is a wall-clock wait rather than a wait for a complete message: the
   * server's answer to malformed input may be a response, a close, or nothing at
   * all, and all three are results worth showing.
   */
  collectRaw(windowMs: number, onChunk: (chunk: Buffer) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const stopWatching = this.onRawData(onChunk);
      const stopListeningForClose = this.onClose(() => finish());
      let done = false;

      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stopWatching();
        stopListeningForClose();
        resolve();
      };

      const timer = setTimeout(finish, windowMs);
      timer.unref?.();
    });
  }

  /** Opens the TCP connection. Resolves once the socket is established. */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.closing = false;
    this.decoder = new SltpDecoder({ expect: 'response' });
    this.connectionId = newConnectionId();

    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);

      const onConnectError = (cause: Error): void => {
        socket.removeAllListeners();
        socket.destroy();
        reject(
          new SltpClientError(
            'connect-failed',
            `Could not connect to ${this.address}: ${cause.message}. ` +
              'Is the SocketLens TCP server running?',
          ),
        );
      };

      socket.once('error', onConnectError);
      socket.once('connect', () => {
        socket.removeListener('error', onConnectError);
        this.socket = socket;
        this.attach(socket);
        this.logger.connection('open', this.connectionId, `peer=${this.address}`);
        resolve();
      });
    });
  }

  /** Wires the long-lived socket handlers once the connection is up. */
  private attach(socket: net.Socket): void {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));

    socket.on('error', (cause) => {
      this.logger.connection('error', this.connectionId, cause.message);
    });

    socket.on('close', () => {
      const pendingPeer = firstDecodeFailure(this.decoder.end());
      const reason = this.closing
        ? 'the client closed the connection'
        : 'the server closed the connection';

      this.logger.connection('close', this.connectionId, reason);

      // Every in-flight request must be settled, or its caller waits forever.
      const inFlight = [...this.pending.values()];
      this.pending.clear();
      for (const entry of inFlight) {
        clearTimeout(entry.timer);
        entry.reject(
          new SltpClientError(
            'closed',
            pendingPeer
              ? `Connection closed mid-message: ${pendingPeer.error.message}`
              : `Connection closed before request ${entry.requestId} received a response.`,
            pendingPeer?.error,
          ),
        );
      }

      this.socket = undefined;
      if (!this.closing) {
        for (const listener of this.closeListeners) listener(reason);
      }
    });
  }

  /** Feeds received bytes to the decoder and routes each framed response. */
  private receive(chunk: Buffer): void {
    // Raw observers see the bytes first, so that a caller demonstrating malformed
    // input still gets the peer's answer even when framing it fails.
    for (const listener of this.rawListeners) listener(chunk);

    for (const event of this.decoder.push(chunk)) {
      if (event.type === 'error') {
        this.logger.frameError('received', event.error.reason, event.error.message, {
          connectionId: this.connectionId,
          raw: event.raw,
        });
        if (event.error.fatal) {
          // The byte stream can no longer be resynchronised, so the connection dies.
          this.failAll(
            new SltpClientError(
              'framing',
              `Fatal framing error from the server: ${event.error.message}`,
              event.error,
            ),
          );
          this.socket?.destroy();
        }
        continue;
      }

      const message = event.message;
      if (!isResponse(message)) {
        this.logger.warn(
          `conn=${this.connectionId} discarded a request arriving on a client connection`,
        );
        continue;
      }

      this.logger.message('received', message, event.raw, {
        connectionId: this.connectionId,
        peer: 'SERVER',
      });

      const requestId = getHeader(message.headers, SLTP_HEADER.requestId);
      if (requestId === undefined) {
        this.logger.warn(
          `conn=${this.connectionId} response ${message.statusCode} carried no ${SLTP_HEADER.requestId} and cannot be correlated`,
        );
        continue;
      }

      const entry = this.pending.get(requestId);
      if (!entry) {
        // A late response to a request that already timed out. Reported, not fatal.
        this.logger.warn(
          `conn=${this.connectionId} received a response for unknown request ${requestId}`,
        );
        continue;
      }

      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve({
        requestId,
        request: entry.request,
        response: message,
        rawResponse: event.raw,
        durationMs: Number(process.hrtime.bigint() - entry.startedAt) / 1e6,
      });
    }
  }

  /**
   * Sends a request and resolves with its correlated response.
   *
   * A non-2xx status is a normal outcome, not an error: reporting error statuses is
   * what this tool is for. Only transport, timeout, and framing problems reject.
   */
  async send(options: SendOptions): Promise<Exchange> {
    if (!this.socket || this.socket.destroyed) {
      throw new SltpClientError('not-connected', 'Not connected. Call connect() first.');
    }

    const requestId = newRequestId();
    const headers: Record<string, string | number | undefined> = {
      ...options.headers,
      [SLTP_HEADER.requestId]: requestId,
      ...(options.sessionId ? { [SLTP_HEADER.sessionId]: options.sessionId } : {}),
    };

    let raw: Buffer;
    try {
      raw =
        options.json !== undefined
          ? encodeRequest({
              operation: options.operation,
              headers,
              body: JSON.stringify(options.json),
              json: true,
            })
          : encodeRequest({
              operation: options.operation,
              headers,
              body: options.body ?? null,
            });
    } catch (cause) {
      throw new SltpClientError(
        'encode',
        `Could not encode ${options.operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    const socket = this.socket;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    const exchange = new Promise<Exchange>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new SltpClientError(
            'timeout',
            `${options.operation} (${requestId}) received no response within ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      // A pending timer must never hold the process open on its own.
      timer.unref?.();

      this.pending.set(requestId, {
        requestId,
        request: raw,
        startedAt: process.hrtime.bigint(),
        timer,
        resolve,
        reject,
      });
    });

    await new Promise<void>((resolve) => {
      socket.write(raw, () => resolve());
    });

    for (const listener of this.writeListeners) listener(raw);

    // Log the request as one message, using the same decoder the server will run.
    const echo = decodedMessages(new SltpDecoder({ expect: 'request' }).push(raw))[0];
    if (echo) {
      this.logger.message('sent', echo.message, raw, {
        connectionId: this.connectionId,
        peer: 'SERVER',
      });
    }

    return exchange;
  }

  /**
   * Writes raw bytes with no encoding and no correlation.
   *
   * This is how the CLI demonstrates malformed input against a live server. The
   * caller is responsible for whatever the server does in response.
   */
  async sendRaw(bytes: Buffer | string): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      throw new SltpClientError('not-connected', 'Not connected. Call connect() first.');
    }
    const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    const socket = this.socket;
    await new Promise<void>((resolve) => {
      socket.write(buffer, () => resolve());
    });
    for (const listener of this.writeListeners) listener(buffer);
    this.logger.info(
      `conn=${this.connectionId} wrote ${buffer.length} raw byte(s) without encoding`,
    );
  }

  /** Rejects every in-flight request with the same error. */
  private failAll(error: SltpClientError): void {
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const entry of inFlight) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  /** Closes the connection cleanly, resolving once the socket is fully closed. */
  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.closing = true;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.end();
      // If the peer never completes the close handshake, stop waiting.
      const forced = setTimeout(() => socket.destroy(), 1_000);
      forced.unref?.();
    });
    this.socket = undefined;
  }
}
