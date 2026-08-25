/**
 * The two implementations under comparison.
 *
 * Both sides answer the same workload: receive a request carrying an N-byte body,
 * echo those bytes back, keep the connection open for the next request. Nothing else
 * happens on either side — no sessions, no rule matching, no routing table — because
 * the question being asked is what the *framing* costs, and HTTP has no equivalent of
 * the SocketLens application layer to compare against.
 *
 * Fairness notes, since an unfair benchmark is worse than no benchmark:
 *
 * - Both servers run on `127.0.0.1` on an OS-assigned port, so neither collides with
 *   a server the developer already has running.
 * - Both disable Nagle's algorithm with `setNoDelay(true)`. Leaving it on for one side
 *   would add up to a 40 ms delay per round trip on small writes and would measure the
 *   kernel's timer rather than either protocol.
 * - Both reuse a single connection for every request, so neither pays a TCP handshake
 *   per iteration.
 * - Both are strictly sequential: one request in flight at a time. HTTP/1.1 without
 *   pipelining cannot do better, and holding SLTP to the same rule is what makes the
 *   two numbers comparable.
 * - The HTTP server keeps Node's default response headers, including `Date`. Stripping
 *   them would make HTTP look artificially cheap on bytes.
 * - The SLTP request carries a `Request-ID`, because a real SLTP client always does.
 *   That is a genuine byte cost of the design and it is reported rather than hidden.
 */
import net from 'node:net';
import http from 'node:http';
import {
  CONTENT_TYPE_JSON,
  DEFAULT_HOST,
  SLTP_HEADER,
  SLTP_STATUS,
  SltpDecoder,
  encodeRequest,
  encodeResponse,
  getHeader,
  isResponse,
  statusPhrase,
} from '@socketlens/protocol';

/** A listening benchmark server. */
export interface BenchmarkServer {
  readonly port: number;
  close(): Promise<void>;
}

/** A connected client that can perform one round trip at a time. */
export interface BenchmarkClient {
  /** Sends `payload` and resolves once the complete response has been received. */
  roundTrip(payload: Buffer): Promise<void>;
  /** Application bytes written to the socket so far, as counted by Node. */
  bytesWritten(): number;
  /** Application bytes read from the socket so far, as counted by Node. */
  bytesRead(): number;
  close(): Promise<void>;
}

/** One protocol implementation to measure. */
export interface Implementation {
  /** Machine-readable key used in JSON output. */
  readonly key: 'sltp' | 'http-node' | 'http-minimal';
  /** Human-readable label used in the report. */
  readonly label: string;
  start(): Promise<BenchmarkServer>;
  connect(port: number): Promise<BenchmarkClient>;
}

// ─── SLTP over node:net ──────────────────────────────────────────────────────

/**
 * A minimal SLTP echo server.
 *
 * This is deliberately not the SocketLens control server: it is the smallest correct
 * SLTP peer, so that what gets measured is the encoder, the incremental decoder, and
 * a socket write. It uses the project's real `@socketlens/protocol` package, so the
 * framing cost measured here is the framing cost the tool actually pays.
 *
 * One decoder per connection, as the protocol requires — two connections are two
 * independent byte streams and a shared decoder would interleave them.
 */
function startSltpServer(): Promise<BenchmarkServer> {
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    const decoder = new SltpDecoder({ expect: 'request' });

    socket.on('data', (chunk: Buffer) => {
      for (const event of decoder.push(chunk)) {
        if (event.type === 'error') {
          socket.destroy();
          return;
        }
        const request = event.message;
        const requestId = getHeader(request.headers, SLTP_HEADER.requestId);
        socket.write(
          encodeResponse({
            statusCode: SLTP_STATUS.OK,
            statusPhrase: statusPhrase(SLTP_STATUS.OK),
            headers: {
              [SLTP_HEADER.requestId]: requestId,
              [SLTP_HEADER.contentType]: CONTENT_TYPE_JSON,
            },
            body: request.body.length > 0 ? request.body : null,
          }),
        );
      }
    });
  });

  return new Promise<BenchmarkServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, DEFAULT_HOST, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('SLTP benchmark server did not receive a TCP address.'));
        return;
      }
      resolve({
        port: address.port,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** Connects a sequential SLTP client that correlates responses by `Request-ID`. */
function connectSltpClient(port: number): Promise<BenchmarkClient> {
  return new Promise<BenchmarkClient>((resolve, reject) => {
    const socket = net.createConnection({ host: DEFAULT_HOST, port });
    socket.setNoDelay(true);

    const onConnectError = (cause: Error): void => {
      socket.destroy();
      reject(cause);
    };
    socket.once('error', onConnectError);

    socket.once('connect', () => {
      socket.removeListener('error', onConnectError);
      const decoder = new SltpDecoder({ expect: 'response' });

      /** Resolver for the single in-flight request, if any. */
      let awaiting: { requestId: string; settle: () => void; fail: (e: Error) => void } | undefined;
      let counter = 0;

      socket.on('error', (cause) => {
        awaiting?.fail(cause);
        awaiting = undefined;
      });

      socket.on('data', (chunk: Buffer) => {
        for (const event of decoder.push(chunk)) {
          if (event.type === 'error') {
            awaiting?.fail(new Error(`SLTP framing error: ${event.error.message}`));
            awaiting = undefined;
            socket.destroy();
            return;
          }
          const message = event.message;
          if (!isResponse(message)) continue;
          const requestId = getHeader(message.headers, SLTP_HEADER.requestId);
          const pending = awaiting;
          if (pending === undefined) continue;
          if (requestId !== pending.requestId) {
            pending.fail(new Error(`Correlation mismatch: expected ${pending.requestId}.`));
            awaiting = undefined;
            return;
          }
          awaiting = undefined;
          pending.settle();
        }
      });

      resolve({
        roundTrip: (payload: Buffer) =>
          new Promise<void>((settle, fail) => {
            counter += 1;
            const requestId = `bench-${counter}`;
            awaiting = { requestId, settle, fail };
            socket.write(
              encodeRequest({
                operation: 'PING',
                headers: { [SLTP_HEADER.requestId]: requestId },
                body: payload.length > 0 ? payload : null,
              }),
            );
          }),
        bytesWritten: () => socket.bytesWritten,
        bytesRead: () => socket.bytesRead,
        close: () =>
          new Promise<void>((done) => {
            socket.once('close', () => done());
            socket.end();
          }),
      });
    });
  });
}

// ─── HTTP/1.1 over node:http ─────────────────────────────────────────────────

/** A minimal HTTP/1.1 echo server, using Node's own parser and default headers. */
function startHttpServer(): Promise<BenchmarkServer> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPE_JSON,
        'Content-Length': body.length,
      });
      response.end(body);
    });
  });
  // Match the SLTP side: no Nagle delay, and never time a connection out mid-run.
  // Set per-connection rather than via `server.noDelay`, which the installed @types/node
  // does not declare. Node's http server already defaults it on; being explicit keeps the
  // two sides visibly equal.
  server.on('connection', (socket) => socket.setNoDelay(true));
  server.keepAliveTimeout = 60_000;

  return new Promise<BenchmarkServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, DEFAULT_HOST, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('HTTP benchmark server did not receive a TCP address.'));
        return;
      }
      resolve({
        port: address.port,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

/**
 * Connects a keep-alive HTTP/1.1 client pinned to exactly one socket.
 *
 * The socket is captured through the agent so that Node's own `bytesWritten` and
 * `bytesRead` counters can be read, giving a measured byte count for HTTP rather than
 * an estimate reconstructed from the header strings.
 */
function connectHttpClient(port: number): Promise<BenchmarkClient> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  let captured: net.Socket | undefined;

  const originalCreateConnection = agent.createConnection.bind(agent);
  agent.createConnection = (options, callback) => {
    const socket = originalCreateConnection(options, callback) as net.Socket;
    socket.setNoDelay(true);
    captured = socket;
    return socket;
  };

  const roundTrip = (payload: Buffer): Promise<void> =>
    new Promise<void>((settle, fail) => {
      const request = http.request(
        {
          host: DEFAULT_HOST,
          port,
          method: 'POST',
          path: '/echo',
          agent,
          headers: {
            'Content-Type': CONTENT_TYPE_JSON,
            'Content-Length': payload.length,
          },
        },
        (response) => {
          // The body must be fully consumed, or the socket is not free for reuse.
          response.on('data', () => {});
          response.on('end', () => settle());
          response.on('error', fail);
        },
      );
      request.on('error', fail);
      if (payload.length > 0) request.write(payload);
      request.end();
    });

  // One priming request establishes the socket so byte counters can be read later.
  return roundTrip(Buffer.alloc(0)).then(() => ({
    roundTrip,
    bytesWritten: () => captured?.bytesWritten ?? 0,
    bytesRead: () => captured?.bytesRead ?? 0,
    close: async () => {
      agent.destroy();
    },
  }));
}

// ─── minimal HTTP/1.1 over node:net ──────────────────────────────────────────

/**
 * An incremental HTTP/1.1 message reader, written in the same style as the SLTP
 * decoder: append to a per-connection buffer, find `\r\n\r\n`, then read exactly
 * `Content-Length` body bytes.
 *
 * Its whole purpose is to make the third arm of the comparison honest. Measuring SLTP
 * against `node:http` compares a purpose-built 100-line framing loop against a
 * general-purpose HTTP stack that allocates stream objects, runs llhttp, supports
 * chunked transfer coding and trailers, and manages socket timeouts. That difference
 * is real, but it is an *implementation* difference, and reporting it as a property of
 * the two protocols would be false. This reader isolates the framing itself.
 *
 * It is deliberately not a usable HTTP implementation: no chunked coding, no
 * pipelining, no `Transfer-Encoding`, no header validation, no status-line edge cases.
 * Do not copy it into anything real.
 */
class MinimalHttpReader {
  private buffer: Buffer = Buffer.alloc(0);

  /** Feeds bytes in and returns whichever complete messages became available. */
  push(chunk: Buffer): { startLine: string; body: Buffer }[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: { startLine: string; body: Buffer }[] = [];

    for (;;) {
      const delimiter = this.buffer.indexOf('\r\n\r\n');
      if (delimiter === -1) return out;

      const headerBlock = this.buffer.subarray(0, delimiter).toString('latin1');
      const lines = headerBlock.split('\r\n');
      const startLine = lines[0] ?? '';

      let contentLength = 0;
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        if (line.slice(0, colon).trim().toLowerCase() === 'content-length') {
          contentLength = Number.parseInt(line.slice(colon + 1).trim(), 10) || 0;
        }
      }

      const bodyStart = delimiter + 4;
      if (this.buffer.length - bodyStart < contentLength) return out;

      out.push({
        startLine,
        body: this.buffer.subarray(bodyStart, bodyStart + contentLength),
      });
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
    }
  }
}

/** A minimal HTTP/1.1 echo server over a raw socket, matched in style to the SLTP one. */
function startMinimalHttpServer(): Promise<BenchmarkServer> {
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    const reader = new MinimalHttpReader();

    socket.on('data', (chunk: Buffer) => {
      for (const message of reader.push(chunk)) {
        const head = Buffer.from(
          'HTTP/1.1 200 OK\r\n' +
            `Content-Type: ${CONTENT_TYPE_JSON}\r\n` +
            `Content-Length: ${message.body.length}\r\n` +
            '\r\n',
          'latin1',
        );
        socket.write(message.body.length > 0 ? Buffer.concat([head, message.body]) : head);
      }
    });
  });

  return new Promise<BenchmarkServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, DEFAULT_HOST, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Minimal HTTP benchmark server did not receive a TCP address.'));
        return;
      }
      resolve({
        port: address.port,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** Connects a sequential client for the minimal HTTP/1.1 server. */
function connectMinimalHttpClient(port: number): Promise<BenchmarkClient> {
  return new Promise<BenchmarkClient>((resolve, reject) => {
    const socket = net.createConnection({ host: DEFAULT_HOST, port });
    socket.setNoDelay(true);

    const onConnectError = (cause: Error): void => {
      socket.destroy();
      reject(cause);
    };
    socket.once('error', onConnectError);

    socket.once('connect', () => {
      socket.removeListener('error', onConnectError);
      const reader = new MinimalHttpReader();
      let awaiting: { settle: () => void; fail: (error: Error) => void } | undefined;

      socket.on('error', (cause) => {
        awaiting?.fail(cause);
        awaiting = undefined;
      });

      socket.on('data', (chunk: Buffer) => {
        for (const _message of reader.push(chunk)) {
          const pending = awaiting;
          awaiting = undefined;
          pending?.settle();
        }
      });

      // The same header set node:http sends, so the byte counts stay comparable.
      const hostHeader = `${DEFAULT_HOST}:${port}`;

      resolve({
        roundTrip: (payload: Buffer) =>
          new Promise<void>((settle, fail) => {
            awaiting = { settle, fail };
            const head = Buffer.from(
              'POST /echo HTTP/1.1\r\n' +
                `Content-Type: ${CONTENT_TYPE_JSON}\r\n` +
                `Content-Length: ${payload.length}\r\n` +
                `Host: ${hostHeader}\r\n` +
                'Connection: keep-alive\r\n' +
                '\r\n',
              'latin1',
            );
            socket.write(payload.length > 0 ? Buffer.concat([head, payload]) : head);
          }),
        bytesWritten: () => socket.bytesWritten,
        bytesRead: () => socket.bytesRead,
        close: () =>
          new Promise<void>((done) => {
            socket.once('close', () => done());
            socket.end();
          }),
      });
    });
  });
}

/**
 * The implementations the runner compares, in report order.
 *
 * Three arms, because two would mislead:
 *
 * - `sltp` versus `http-minimal` isolates the **framing design**. Both are small
 *   hand-written loops over a per-connection buffer, so a difference here would be
 *   attributable to the wire format itself.
 * - `sltp` versus `http-node` shows what Node's **general-purpose HTTP stack** costs
 *   per request. That is a real cost a developer would pay in practice, but it is a
 *   property of the library, not of HTTP the protocol.
 */
export const IMPLEMENTATIONS: readonly Implementation[] = [
  {
    key: 'sltp',
    label: 'SLTP/1.0 (node:net)',
    start: startSltpServer,
    connect: connectSltpClient,
  },
  {
    key: 'http-minimal',
    label: 'HTTP/1.1 minimal (node:net)',
    start: startMinimalHttpServer,
    connect: connectMinimalHttpClient,
  },
  {
    key: 'http-node',
    label: 'HTTP/1.1 (node:http)',
    start: startHttpServer,
    connect: connectHttpClient,
  },
];
