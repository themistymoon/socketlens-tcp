/**
 * The bridge's HTTP surface, end to end.
 *
 * Nothing here is mocked: a real SLTP control server is bound to an ephemeral port, a
 * real bridge opens a real TCP socket to it, and the assertions are made with `fetch`
 * against the real loopback listener. That is the only way to test the thing the bridge
 * actually is — a process that owns a socket a browser cannot open.
 *
 * The property under test throughout is the boundary: HTTP carries commands *about*
 * SLTP, and the SLTP conversation stays raw TCP. A response body here is JSON describing
 * an exchange; it never contains SLTP framing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { DEFAULT_TIMEOUT_MS } from '@socketlens/protocol';
import { startBridge, type RunningBridge } from '../../apps/bridge/src/index.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let harness: Harness;
let bridge: RunningBridge;

/** A TCP listener that accepts a connection and then says nothing, ever. */
async function startSilentServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Base options for a bridge pointed at the test's own control server. */
function bridgeOptions(overrides: Record<string, unknown> = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    serverHost: harness.host,
    serverPort: harness.port,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    staticDir: undefined,
    open: false,
    connectOnStart: false,
    logLevel: 'silent' as const,
    help: false,
    version: false,
    ...overrides,
  };
}

/**
 * The ports `fetch` refuses to talk to at all.
 *
 * The Fetch standard blocks a fixed list of ports, and `undici` — the implementation
 * behind Node's global `fetch` — enforces it: a request to one fails with `bad port`
 * before any socket is opened. Every bridge here binds with `port: 0`, so the OS picks,
 * and on a machine whose ephemeral range starts low (this one is configured 1024
 * upwards) it will eventually pick one of these. That surfaced as a rare `fetch failed`
 * in whichever test happened to draw the port, which looked like a bridge fault and was
 * not one. Binding is retried instead, so the list only has to be avoided, not handled.
 */
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/** Starts a bridge on an ephemeral port that `fetch` is willing to reach. */
async function startFetchableBridge(
  overrides: Record<string, unknown> = {},
): Promise<RunningBridge> {
  // A rejected bridge stays bound until a good one is found, so the OS cannot hand the
  // same blocked port straight back and the retry always makes progress.
  const rejected: RunningBridge[] = [];
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = await startBridge(bridgeOptions(overrides));
      if (!FETCH_BLOCKED_PORTS.has(started.port)) return started;
      rejected.push(started);
    }

    throw new Error('could not bind the bridge to a port fetch will accept');
  } finally {
    await Promise.all(rejected.map((bridge) => bridge.close()));
  }
}

/** Issues a request against the running bridge and returns status plus parsed body. */
async function call(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** POSTs a JSON command, the shape every mutating bridge route expects. */
function post(
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return call(path, {
    method: 'POST',
    ...(payload === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
}

beforeEach(async () => {
  harness = await startHarness();
  bridge = await startFetchableBridge();
});

afterEach(async () => {
  await bridge.close();
  await harness.stop();
});

describe('connection lifecycle', () => {
  it('reports a disconnected status before anything has connected', async () => {
    const { status, body } = await call('/bridge/status');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      connected: false,
      serverHost: harness.host,
      serverPort: harness.port,
      requestsSent: 0,
    });
    expect(body.connectionId).toBeUndefined();
  });

  it('opens a real TCP connection on demand and reports its identifier', async () => {
    const { status, body } = await post('/bridge/connect');

    expect(status).toBe(200);
    expect(body.connected).toBe(true);
    expect(body.connectionId).toEqual(expect.any(String));
  });

  it('is idempotent: connecting twice keeps the same socket', async () => {
    const first = await post('/bridge/connect');
    const second = await post('/bridge/connect');

    expect(second.body.connectionId).toBe(first.body.connectionId);
  });

  // Two browser tabs pressing Connect at the same moment must not open two sockets.
  it('collapses concurrent connect attempts onto one connection', async () => {
    const results = await Promise.all([
      post('/bridge/connect'),
      post('/bridge/connect'),
      post('/bridge/connect'),
    ]);

    const ids = new Set(results.map((r) => r.body.connectionId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toEqual(expect.any(String));
  });

  it('disconnects and reports the closed state', async () => {
    await post('/bridge/connect');
    const { status, body } = await post('/bridge/disconnect');

    expect(status).toBe(200);
    expect(body.connected).toBe(false);
    expect((await call('/bridge/status')).body.connected).toBe(false);
  });

  it('treats disconnecting when idle as a no-op rather than an error', async () => {
    const { status, body } = await post('/bridge/disconnect');

    expect(status).toBe(200);
    expect(body.connected).toBe(false);
  });

  it('answers 502 with the reason when the control server is unreachable', async () => {
    const orphan = await startFetchableBridge({ serverPort: 1 });
    try {
      const response = await fetch(`http://127.0.0.1:${orphan.port}/bridge/connect`, {
        method: 'POST',
      });
      const body = (await response.json()) as Record<string, unknown>;

      // Unreachable is a reportable condition, not a bridge fault.
      expect(response.status).toBe(502);
      expect(body.error).toEqual(expect.any(String));
      expect(body.status).toMatchObject({ connected: false });
    } finally {
      await orphan.close();
    }
  });
});

describe('relaying a request', () => {
  it('sends PING over raw TCP and returns both wire views', async () => {
    const { status, body } = await post('/bridge/request', { operation: 'PING' });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      requestId: expect.any(String),
      durationMs: expect.any(Number),
      request: expect.objectContaining({ operation: 'PING' }),
      response: expect.objectContaining({ statusCode: 200 }),
    });
  });

  // The bridge connects on demand, so the interface never has to sequence a connect
  // before its first command.
  it('connects implicitly when a request arrives on an idle bridge', async () => {
    expect((await call('/bridge/status')).body.connected).toBe(false);

    await post('/bridge/request', { operation: 'PING' });

    expect((await call('/bridge/status')).body.connected).toBe(true);
  });

  it('counts every relayed request in the status', async () => {
    await post('/bridge/request', { operation: 'PING' });
    await post('/bridge/request', { operation: 'SERVER_INFO' });

    expect((await call('/bridge/status')).body.requestsSent).toBe(2);
  });

  it('carries a JSON body to the server and back', async () => {
    const { body } = await post('/bridge/request', {
      operation: 'PING',
      json: { echo: 'through the bridge' },
    });

    const response = body.response as { body: string };
    expect(response.body).toContain('through the bridge');
  });

  // Rendering error statuses with their phrases is the entire point of the tool, so a
  // 4xx from SLTP is a result to display rather than a failure to report.
  it('returns a non-2xx SLTP status as a normal 200 result', async () => {
    const { status, body } = await post('/bridge/request', {
      operation: 'GET_SESSION',
      sessionId: 'sess-does-not-exist',
    });

    expect(status).toBe(200);
    expect(body.response).toMatchObject({ statusCode: 404 });
  });

  it('rejects a command with no operation', async () => {
    const { status, body } = await post('/bridge/request', { json: {} });

    expect(status).toBe(400);
    expect(body.error).toContain('operation');
  });

  it('rejects a command whose operation is not a string', async () => {
    const { status } = await post('/bridge/request', { operation: 42 });

    expect(status).toBe(400);
  });

  it('reports a client-side timeout as a 502 carrying the error code', async () => {
    // A tiny deadline against the real server is a race: on loopback a PING can
    // complete inside a millisecond, so the request resolves and the assertion fails
    // for the wrong reason. A peer that accepts and then never answers makes the
    // timeout the only possible outcome.
    const silent = await startSilentServer();
    const waiting = await startFetchableBridge({ serverPort: silent.port, timeoutMs: 100 });
    try {
      const response = await fetch(`http://127.0.0.1:${waiting.port}/bridge/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'PING' }),
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(502);
      expect(body.code).toBe('timeout');
    } finally {
      await waiting.close();
      await silent.stop();
    }
  });

  it('runs several requests concurrently on one connection', async () => {
    await post('/bridge/connect');

    const results = await Promise.all([
      post('/bridge/request', { operation: 'PING', json: { echo: 'a' } }),
      post('/bridge/request', { operation: 'PING', json: { echo: 'b' } }),
      post('/bridge/request', { operation: 'SERVER_INFO' }),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    // Correlation is by Request-ID, not arrival order, so every reply must be distinct.
    const ids = new Set(results.map((r) => r.body.requestId));
    expect(ids.size).toBe(3);
  });
});

describe('raw byte writes', () => {
  it('puts exact bytes on the wire and reports the count', async () => {
    await post('/bridge/connect');
    const { status, body } = await post('/bridge/raw', {
      bytes: 'SLTP/1.0 PING\r\nRequest-ID: raw-1\r\nContent-Length: 0\r\n\r\n',
    });

    expect(status).toBe(200);
    // 55 bytes: the start line, two headers, and the blank line, each CRLF-terminated.
    expect(body.bytesWritten).toBe(55);
  });

  it('counts bytes rather than characters for a non-ASCII payload', async () => {
    await post('/bridge/connect');
    // 'é' is two bytes in UTF-8; a character count would report one fewer.
    const { body } = await post('/bridge/raw', { bytes: 'é' });

    expect(body.bytesWritten).toBe(2);
  });

  it('rejects a raw send with no bytes string', async () => {
    const { status, body } = await post('/bridge/raw', { bytes: 123 });

    expect(status).toBe(400);
    expect(body.error).toContain('bytes');
  });

  // Deliberately malformed bytes are the point of this route: it is how the interface
  // demonstrates a bad Content-Length, which the encoder by definition cannot produce.
  it('accepts bytes the encoder could never produce', async () => {
    await post('/bridge/connect');
    const { status } = await post('/bridge/raw', {
      bytes: 'SLTP/1.0 PING\r\nContent-Length: 9999\r\n\r\nshort',
    });

    expect(status).toBe(200);
  });
});

describe('method and route handling', () => {
  it.each([
    ['/bridge/events', 'POST'],
    ['/bridge/status', 'POST'],
    ['/bridge/connect', 'GET'],
    ['/bridge/disconnect', 'GET'],
    ['/bridge/request', 'GET'],
    ['/bridge/raw', 'GET'],
  ])('answers 405 for %s with %s', async (path, method) => {
    const { status, body } = await call(path, { method });

    expect(status).toBe(405);
    expect(body.error).toMatch(/Use (GET|POST)\./);
  });

  it('answers 404 for an unknown bridge route', async () => {
    const { status, body } = await call('/bridge/nope');

    expect(status).toBe(404);
    expect(body.error).toContain('/bridge/nope');
  });

  it('explains how to get an interface when none is configured', async () => {
    const { status, body } = await call('/');

    expect(status).toBe(404);
    expect(body.error).toContain('npm run dev:gui');
  });
});

describe('request bodies', () => {
  it('reports invalid JSON rather than crashing the handler', async () => {
    const { status, body } = await call('/bridge/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });

    expect(status).toBe(400);
    expect(body.error).toContain('not valid JSON');
  });

  it('treats an empty body as an empty command', async () => {
    // Empty parses to {}, which then fails the operation check rather than the JSON one.
    const { status, body } = await post('/bridge/request');

    expect(status).toBe(400);
    expect(body.error).toContain('operation');
  });

  it('refuses a command body beyond the size guard', async () => {
    const { status, body } = await call('/bridge/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: 'x'.repeat(1_100_000) }),
    });

    expect(status).toBe(413);
    expect(body.error).toContain('too large');
  });
});

describe('cross-origin protection', () => {
  // Only loopback is bound, but a hostile page in the user's own browser could still
  // point at it. Refusing an unexpected Origin keeps a website from driving the socket.
  it('refuses a request carrying a foreign origin', async () => {
    const { status, body } = await call('/bridge/status', {
      headers: { Origin: 'https://example.com' },
    });

    expect(status).toBe(403);
    expect(body.error).toContain('Cross-origin');
  });

  it.each(['http://127.0.0.1:5173', 'http://localhost:5173'])(
    'accepts the loopback origin %s',
    async (origin) => {
      const { status } = await call('/bridge/status', { headers: { Origin: origin } });

      expect(status).toBe(200);
    },
  );

  it('accepts a same-origin request that carries no Origin at all', async () => {
    expect((await call('/bridge/status')).status).toBe(200);
  });
});

describe('the event stream', () => {
  it('publishes both directions of an exchange to an attached tab', async () => {
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${bridge.port}/bridge/events`, {
      signal: controller.signal,
    });

    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';

    await post('/bridge/request', { operation: 'PING' });

    // Read until both the outbound request and the inbound response have appeared.
    while (!(text.includes('"direction":"outbound"') && text.includes('"direction":"inbound"'))) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    expect(text).toContain('event: wire');
    expect(text).toContain('"direction":"outbound"');
    expect(text).toContain('"direction":"inbound"');
    // The timeline shows the actual bytes, CRLF made visible rather than stripped.
    expect(text).toContain('SLTP/1.0 PING');

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe('static hosting', () => {
  it('serves the built interface and falls back to index.html for client routes', async () => {
    const withAssets = await startFetchableBridge({ staticDir: 'tests/bridge/fixtures/dist' });
    try {
      const base = `http://127.0.0.1:${withAssets.port}`;

      const index = await fetch(`${base}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await index.text()).toContain('SocketLens');

      const asset = await fetch(`${base}/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

      // Client-side routing: an unknown path is the app's problem, not a 404.
      const route = await fetch(`${base}/sessions/abc`);
      expect(route.status).toBe(200);
      expect(await route.text()).toContain('SocketLens');
    } finally {
      await withAssets.close();
    }
  });

  it('does not let a crafted path escape the asset directory', async () => {
    const withAssets = await startFetchableBridge({ staticDir: 'tests/bridge/fixtures/dist' });
    try {
      // `fetch` normalises `..` in a URL, so the traversal is sent as an encoded segment.
      const escaped = await fetch(`http://127.0.0.1:${withAssets.port}/%2e%2e/%2e%2e/package.json`);

      expect(await escaped.text()).not.toContain('"socketlens-tcp"');
    } finally {
      await withAssets.close();
    }
  });

  it('still serves the bridge routes when static hosting is on', async () => {
    const withAssets = await startFetchableBridge({ staticDir: 'tests/bridge/fixtures/dist' });
    try {
      const response = await fetch(`http://127.0.0.1:${withAssets.port}/bridge/status`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ connected: false });
    } finally {
      await withAssets.close();
    }
  });
});
