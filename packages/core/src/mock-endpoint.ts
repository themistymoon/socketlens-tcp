/**
 * Per-session TCP mock endpoint.
 *
 * Each testing session owns its own `node:net` listener on an ephemeral loopback
 * port. Scenarios open a real TCP connection to that port, so fragmentation,
 * coalescing, delays, and mid-message disconnects are genuine transport behaviour
 * rather than a simulation inside a single process's memory.
 *
 * The endpoint speaks SLTP using the same decoder and encoder as the control server.
 * It answers with whichever mock rule matches, or 410 NO MATCHING RULE when none does.
 * Every connection gets its own decoder, because two connections are two independent
 * byte streams.
 */
import net from 'node:net';
import {
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
  statusForReason,
  statusPhrase,
  validateRequest,
  type SltpReason,
  type SltpRequest,
} from '@socketlens/protocol';
import { newConnectionId } from './ids.js';
import { matchRule } from './matching.js';
import type { MockRule } from './models.js';
import type { ProtocolLogger } from './logger.js';

/** Everything the endpoint needs from the session that owns it. */
export interface MockEndpointContext {
  readonly sessionId: string;
  /** Current rule set, read fresh on every request so edits take effect at once. */
  readonly rules: () => readonly MockRule[];
  /** Called when a rule fires, so the session can keep a hit count. */
  readonly onRuleHit: (ruleId: string) => void;
  readonly logger: ProtocolLogger;
}

/** A listening mock endpoint. */
export interface MockEndpoint {
  readonly host: string;
  readonly port: number;
  /** Number of connections currently open. */
  readonly openConnections: () => number;
  /** Closes the listener and destroys every open connection. */
  readonly close: () => Promise<void>;
}

/** Starts a mock endpoint on an OS-assigned loopback port. */
export async function startMockEndpoint(context: MockEndpointContext): Promise<MockEndpoint> {
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handleConnection(socket, context).catch((cause: unknown) => {
      context.logger.error(
        `mock endpoint for ${context.sessionId} failed: ${describeError(cause)}`,
      );
      socket.destroy();
    });
  });

  // A listener error must never reach the process as an uncaught exception.
  server.on('error', (cause) => {
    context.logger.error(`mock endpoint listener error: ${cause.message}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, DEFAULT_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Mock endpoint did not receive a TCP address from the operating system.');
  }

  return {
    host: address.address,
    port: address.port,
    openConnections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Serves one TCP connection.
 *
 * Resolves when the connection has closed. Errors are handled inline so that one
 * misbehaving client can never take down the endpoint or the process.
 */
async function handleConnection(socket: net.Socket, context: MockEndpointContext): Promise<void> {
  const connectionId = newConnectionId();
  // The endpoint receives requests, so its decoder expects the request shape.
  const decoder = new SltpDecoder({ expect: 'request' });

  context.logger.connection('open', connectionId, `session=${context.sessionId} role=mock`);

  /** Serialises response writes so a delayed reply cannot overtake an earlier one. */
  let chain: Promise<void> = Promise.resolve();

  socket.on('error', (cause) => {
    // ECONNRESET is normal here: scenarios deliberately abort connections.
    context.logger.connection('error', connectionId, cause.message);
  });

  socket.on('data', (chunk: Buffer) => {
    if (socket.destroyed) return;

    for (const event of decoder.push(chunk)) {
      if (event.type === 'error') {
        context.logger.frameError('received', event.error.reason, event.error.message, {
          connectionId,
          raw: event.raw,
        });

        const code = statusForReason(event.error.reason);
        chain = chain.then(() =>
          writeError(
            socket,
            context,
            connectionId,
            code,
            event.error.message,
            undefined,
            event.error.reason,
            event.error.fatal,
          ),
        );

        if (event.error.fatal) {
          // The stream is desynchronised; nothing after this point can be trusted.
          chain = chain.then(() => endSocket(socket));
          return;
        }
        continue;
      }

      const message = event.message;
      if (!isRequest(message)) {
        // A response arriving at an endpoint is a role violation, not a mock request.
        chain = chain.then(() =>
          writeError(
            socket,
            context,
            connectionId,
            SLTP_STATUS.BAD_REQUEST,
            'A mock endpoint accepts SLTP requests, not responses.',
            undefined,
            SLTP_REASON.unexpectedMessageKind,
          ),
        );
        continue;
      }

      context.logger.message('received', message, event.raw, {
        connectionId,
        peer: 'CLIENT',
      });

      chain = chain.then(() => respond(socket, context, connectionId, message));
    }
  });

  await new Promise<void>((resolve) => {
    socket.once('close', () => {
      const pending = firstDecodeFailure(decoder.end());
      if (pending) {
        context.logger.frameError('received', pending.error.reason, pending.error.message, {
          connectionId,
          raw: pending.raw,
        });
      }
      context.logger.connection('close', connectionId, `session=${context.sessionId}`);
      resolve();
    });
  });
}

/** Chooses a rule and writes its response, honouring delay, fragmentation, and disconnect. */
async function respond(
  socket: net.Socket,
  context: MockEndpointContext,
  connectionId: string,
  request: SltpRequest,
): Promise<void> {
  if (socket.destroyed) return;

  const requestId = request.headers.find(
    (field) => field.name.toLowerCase() === SLTP_HEADER.requestId.toLowerCase(),
  )?.value;

  // The endpoint's TCP port already identifies the session, so a Session-ID is not
  // required here, and any operation token is acceptable — a mock is allowed to
  // answer operations that SLTP itself does not define.
  const validation = validateRequest(request, {
    requireSession: false,
    allowUnknownOperation: true,
  });
  if (!validation.ok) {
    await writeError(
      socket,
      context,
      connectionId,
      statusForReason(validation.error.reason),
      validation.error.message,
      requestId,
      validation.error.reason,
    );
    return;
  }

  const outcome = matchRule(request, context.rules());
  if (!outcome.rule) {
    await writeError(
      socket,
      context,
      connectionId,
      SLTP_STATUS.NO_MATCHING_RULE,
      `No enabled mock rule matched ${request.operation}. ${outcome.trace.length} rule(s) evaluated.`,
      requestId,
    );
    return;
  }

  const rule = outcome.rule;
  context.onRuleHit(rule.id);

  const { response } = rule;
  if (response.delayMs !== undefined && response.delayMs > 0) {
    await delay(response.delayMs);
    if (socket.destroyed) return;
  }

  let raw: Buffer;
  try {
    raw = encodeResponse({
      statusCode: response.statusCode,
      statusPhrase: response.statusPhrase,
      headers: {
        ...response.headers,
        [SLTP_HEADER.requestId]: requestId,
        [SLTP_HEADER.matchedRuleId]: rule.id,
        [SLTP_HEADER.server]: SERVER_PRODUCT,
        [SLTP_HEADER.timestamp]: new Date().toISOString(),
      },
      body: response.body ?? null,
    });
  } catch (cause) {
    await writeError(
      socket,
      context,
      connectionId,
      SLTP_STATUS.INTERNAL_SERVER_ERROR,
      `Rule ${rule.id} produced an unencodable response: ${describeError(cause)}`,
      requestId,
    );
    return;
  }

  // A rule may cut the connection part-way through its own response, which is how a
  // scenario reproduces a peer that dies mid-message.
  if (response.disconnectAfterBytes !== undefined) {
    const prefix = raw.subarray(0, Math.min(response.disconnectAfterBytes, raw.length));
    if (prefix.length > 0) await writeChunk(socket, prefix);
    context.logger.frameError(
      'sent',
      'deliberateDisconnect',
      `rule ${rule.id} closed the connection after ${prefix.length} of ${raw.length} byte(s)`,
      { connectionId },
    );
    socket.destroy();
    return;
  }

  const chunks = response.fragment ? splitBuffer(raw, response.fragment.sizes) : [raw];

  for (const [index, chunk] of chunks.entries()) {
    if (socket.destroyed) return;
    if (index > 0 && response.fragment?.delayMs) {
      await delay(response.fragment.delayMs);
      if (socket.destroyed) return;
    }
    await writeChunk(socket, chunk);
  }

  // Log the message once, as one SLTP message, whatever the segmentation was.
  const echo = decodedMessages(new SltpDecoder({ expect: 'response' }).push(raw))[0];
  if (echo) {
    context.logger.message('sent', echo.message, raw, { connectionId, peer: 'CLIENT' });
  }
  if (chunks.length > 1) {
    context.logger.info(
      `conn=${connectionId} response written in ${chunks.length} separate write(s): ` +
        `${chunks.map((c) => c.length).join(' + ')} = ${raw.length} bytes`,
    );
  }
}

/** Writes an SLTP error response, never throwing. */
async function writeError(
  socket: net.Socket,
  context: MockEndpointContext,
  connectionId: string,
  statusCode: number,
  detail: string,
  requestId: string | undefined,
  /** Machine-readable reason, when the failure came from the framing taxonomy. */
  reason?: SltpReason,
  /**
   * Whether the connection is about to be closed. A peer holding a desynchronised
   * stream should be told so explicitly rather than left to infer it from the FIN.
   */
  closing = false,
): Promise<void> {
  if (socket.destroyed) return;
  try {
    const raw = encodeResponse({
      statusCode,
      statusPhrase: statusPhrase(statusCode),
      headers: {
        [SLTP_HEADER.requestId]: requestId,
        [SLTP_HEADER.server]: SERVER_PRODUCT,
        ...(reason ? { [SLTP_HEADER.reason]: reason } : {}),
        ...(closing ? { [SLTP_HEADER.connection]: 'close' } : {}),
      },
      body: JSON.stringify({ error: detail, ...(reason ? { reason } : {}) }),
      json: true,
    });
    await writeChunk(socket, raw);
    const echo = decodedMessages(new SltpDecoder({ expect: 'response' }).push(raw))[0];
    if (echo) {
      context.logger.message('sent', echo.message, raw, { connectionId, peer: 'CLIENT' });
    }
  } catch (cause) {
    context.logger.error(`failed to write mock error response: ${describeError(cause)}`);
  }
}

/** Writes one buffer, resolving when the kernel has accepted it. */
function writeChunk(socket: net.Socket, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.write(chunk, () => resolve());
  });
}

/** Half-closes the connection and resolves once it is fully closed. */
function endSocket(socket: net.Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.end(() => resolve());
  });
}

/**
 * Splits a buffer into segments of the given sizes.
 * Any remaining bytes form a final segment, so an incomplete size list still sends
 * the whole message.
 */
export function splitBuffer(source: Buffer, sizes: readonly number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= source.length) break;
    const end = Math.min(offset + size, source.length);
    chunks.push(source.subarray(offset, end));
    offset = end;
  }
  if (offset < source.length) chunks.push(source.subarray(offset));
  return chunks.length > 0 ? chunks : [source];
}

/** Splits a buffer into `count` roughly equal segments. */
export function splitIntoParts(source: Buffer, count: number): Buffer[] {
  const parts = Math.max(1, Math.min(count, source.length));
  const size = Math.ceil(source.length / parts);
  const sizes = Array.from({ length: parts }, () => size);
  return splitBuffer(source, sizes);
}

/** Resolves after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A readable description of an unknown thrown value. */
export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
