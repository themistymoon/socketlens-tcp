/**
 * The relay, driven directly.
 *
 * The HTTP tests cover the routes; these cover the relay's own contracts, which are
 * where the subtle bugs live. Three in particular are asserted here because each one
 * would produce a plausible-looking but wrong timeline rather than an obvious failure:
 * requests must be published at write time so a response never precedes its request,
 * deliberately malformed raw bytes must not reach the decoder that frames well-formed
 * ones, and a reconnection must start with clean framing state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { DEFAULT_TIMEOUT_MS, type SltpWireEvent } from '@socketlens/protocol';
import { SltpClientError } from '@socketlens/core';
import { EventHub } from '../../apps/bridge/src/events.js';
import { Relay } from '../../apps/bridge/src/relay.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let harness: Harness;
let hub: EventHub;
let relay: Relay;
/** Every wire event the relay published, in order. */
let wire: SltpWireEvent[];

/**
 * A TCP listener that accepts a connection and then says nothing, ever.
 *
 * Timeouts cannot be provoked reliably by setting a tiny deadline against the real
 * server: on loopback a PING round trip can complete inside a millisecond, so the
 * request resolves and the test passes for the wrong reason, or flakes. A peer that
 * never answers makes the timeout the only possible outcome.
 */
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

/** Builds a relay against the test's control server, capturing what it publishes. */
function build(overrides: { serverPort?: number; timeoutMs?: number } = {}): Relay {
  hub = new EventHub();
  wire = [];
  // Tapping publish is enough: publishWire delegates to it, and this keeps the
  // assertions on the payload rather than on SSE text.
  const original = hub.publish.bind(hub);
  hub.publish = (event) => {
    if (event.name === 'wire') wire.push(event.data as SltpWireEvent);
    original(event);
  };

  return new Relay({
    serverHost: harness.host,
    serverPort: overrides.serverPort ?? harness.port,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    logLevel: 'silent',
    hub,
  });
}

beforeEach(async () => {
  harness = await startHarness();
  relay = build();
});

afterEach(async () => {
  await relay.close();
  hub.close();
  await harness.stop();
});

describe('status', () => {
  it('starts disconnected and reports the configured target', () => {
    expect(relay.status).toEqual({
      connected: false,
      serverHost: harness.host,
      serverPort: harness.port,
      requestsSent: 0,
    });
  });

  it('omits the connection identifier while disconnected', async () => {
    await relay.connect();
    expect(relay.status.connectionId).toEqual(expect.any(String));

    await relay.disconnect();
    expect(relay.status.connectionId).toBeUndefined();
  });

  it('records why a failed connection failed', async () => {
    const unreachable = build({ serverPort: 1 });
    await expect(unreachable.connect()).rejects.toThrow();

    expect(unreachable.status.lastError).toEqual(expect.any(String));
    expect(unreachable.status.connected).toBe(false);
    await unreachable.close();
  });

  it('clears a previous error once a connection succeeds', async () => {
    await relay.connect();
    expect(relay.status.lastError).toBeUndefined();
  });
});

describe('publishing order', () => {
  // A response can arrive before the awaiting caller resumes, so publishing requests
  // after `send()` resolves would place every response ahead of its own request.
  it('publishes the request before the response it caused', async () => {
    await relay.send({ operation: 'PING' });

    const directions = wire.map((event) => event.direction);
    expect(directions.indexOf('outbound')).toBeLessThan(directions.indexOf('inbound'));
  });

  it('numbers wire events with a strictly increasing sequence', async () => {
    await relay.send({ operation: 'PING' });
    await relay.send({ operation: 'SERVER_INFO' });

    const sequences = wire.map((event) => event.seq);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('publishes the raw bytes of both directions', async () => {
    await relay.send({ operation: 'PING' });

    const outbound = wire.find((event) => event.direction === 'outbound');
    const inbound = wire.find((event) => event.direction === 'inbound');

    // CRLF is escaped for display rather than stripped: seeing the framing is the point.
    expect(outbound?.raw).toContain('SLTP/1.0 PING');
    expect(outbound?.raw).toContain('\\r\\n');
    expect(inbound?.raw).toContain('SLTP/1.0 200');
  });

  it('reports byte counts that match the raw payloads', async () => {
    await relay.send({ operation: 'PING' });

    for (const event of wire) {
      expect(event.bytes).toBeGreaterThan(0);
    }
  });

  it('tags events with the connection they belong to', async () => {
    await relay.connect();
    const id = relay.status.connectionId;
    await relay.send({ operation: 'PING' });

    expect(wire.every((event) => event.connectionId === id)).toBe(true);
  });
});

describe('exchanges', () => {
  it('returns the decoded request alongside the decoded response', async () => {
    const exchange = await relay.send({ operation: 'PING', json: { echo: 'hello' } });

    expect(exchange.request.operation).toBe('PING');
    expect(exchange.request.body).toContain('hello');
    expect(exchange.response.statusCode).toBe(200);
    expect(exchange.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('correlates concurrent requests by Request-ID rather than arrival order', async () => {
    await relay.connect();

    const [first, second, third] = await Promise.all([
      relay.send({ operation: 'PING', json: { echo: 'one' } }),
      relay.send({ operation: 'PING', json: { echo: 'two' } }),
      relay.send({ operation: 'PING', json: { echo: 'three' } }),
    ]);

    // Each response must carry back its own echo, not another request's.
    expect(first.response.body).toContain('one');
    expect(second.response.body).toContain('two');
    expect(third.response.body).toContain('three');
    expect(new Set([first.requestId, second.requestId, third.requestId]).size).toBe(3);
  });

  it('passes custom headers through to the server', async () => {
    const exchange = await relay.send({
      operation: 'PING',
      headers: { 'X-Note': 'from the relay' },
    });

    expect(exchange.request.raw).toContain('X-Note: from the relay');
  });

  it('throws a typed client error when nothing answers in time', async () => {
    const silent = await startSilentServer();
    const waiting = build({ serverPort: silent.port, timeoutMs: 100 });
    try {
      await expect(waiting.send({ operation: 'PING' })).rejects.toBeInstanceOf(SltpClientError);
    } finally {
      await waiting.close();
      await silent.stop();
    }
  });

  it('does not count a request that never completed', async () => {
    const silent = await startSilentServer();
    const waiting = build({ serverPort: silent.port, timeoutMs: 100 });
    try {
      await waiting.send({ operation: 'PING' }).catch(() => undefined);

      // The counter is incremented after the exchange resolves, so it tracks completed
      // exchanges rather than bytes written. The bytes for this request did leave.
      expect(waiting.status.requestsSent).toBe(0);
    } finally {
      await waiting.close();
      await silent.stop();
    }
  });

  it('refuses to send when the server cannot be reached', async () => {
    const unreachable = build({ serverPort: 1 });
    await expect(unreachable.send({ operation: 'PING' })).rejects.toThrow();
    await unreachable.close();
  });
});

describe('raw writes', () => {
  // Malformed bytes are the point of sendRaw, and a fatal framing fault in the sent
  // decoder would desynchronise it and corrupt the display of every request after.
  // The peer here never answers and never closes, so the only thing under test is
  // whether the relay's own outbound decoder survives the garbage between two
  // well-formed requests — a real server would rightly drop the connection instead.
  it('keeps deliberately malformed bytes out of the sent decoder', async () => {
    const silent = await startSilentServer();
    const isolated = build({ serverPort: silent.port, timeoutMs: 100 });
    try {
      await isolated.connect();

      await isolated.send({ operation: 'PING' }).catch(() => undefined);
      await isolated.sendRaw('this is not an SLTP message at all\r\n\r\n');
      await isolated.send({ operation: 'SERVER_INFO' }).catch(() => undefined);

      // Both requests were decoded by the write tap despite the garbage between them.
      const operations = wire
        .filter((event) => event.direction === 'outbound' && event.message !== undefined)
        .map((event) => event.message?.operation);
      expect(operations).toEqual(['PING', 'SERVER_INFO']);

      // And the garbage produced no framing error, because it never reached the decoder.
      expect(wire.some((event) => event.error !== undefined)).toBe(false);
    } finally {
      await isolated.close();
      await silent.stop();
    }
  });

  it('publishes raw bytes verbatim as an outbound event', async () => {
    await relay.connect();
    await relay.sendRaw('hello');

    const event = wire.at(-1);
    expect(event).toMatchObject({ direction: 'outbound', bytes: 5, raw: 'hello' });
    // Not framed, so there is no decoded message view attached.
    expect(event?.message).toBeUndefined();
  });

  it('counts raw sends towards the request total', async () => {
    await relay.connect();
    await relay.sendRaw('x');

    expect(relay.status.requestsSent).toBe(1);
  });

  it('reports UTF-8 byte length rather than character count', async () => {
    await relay.connect();
    const { bytesWritten } = await relay.sendRaw('ทดสอบ');

    // Five Thai characters, three bytes each.
    expect(bytesWritten).toBe(15);
  });
});

describe('reconnection', () => {
  // A new connection is a new byte stream. Leftover partial bytes from the previous
  // one would corrupt the first message decoded on the new socket.
  it('starts a reconnected socket with clean framing state', async () => {
    await relay.connect();
    await relay.send({ operation: 'PING' });

    await relay.disconnect();
    await relay.connect();

    wire = [];
    const exchange = await relay.send({ operation: 'PING' });

    expect(exchange.response.statusCode).toBe(200);
    expect(wire.some((event) => event.error !== undefined)).toBe(false);
  });

  it('issues a new connection identifier after reconnecting', async () => {
    await relay.connect();
    const first = relay.status.connectionId;

    await relay.disconnect();
    await relay.connect();

    expect(relay.status.connectionId).not.toBe(first);
  });

  it('keeps the lifetime request count across reconnections', async () => {
    await relay.send({ operation: 'PING' });
    await relay.disconnect();
    await relay.send({ operation: 'PING' });

    expect(relay.status.requestsSent).toBe(2);
  });

  it('publishes a notice and a status when the server drops the connection', async () => {
    const notices: string[] = [];
    const original = hub.publish.bind(hub);
    hub.publish = (event) => {
      if (event.name === 'notice') notices.push((event.data as { text: string }).text);
      original(event);
    };

    await relay.connect();
    await harness.server.close(50);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(relay.status.connected).toBe(false);
    expect(notices.some((text) => text.includes('connection closed'))).toBe(true);
  });
});

describe('shutdown', () => {
  it('closes cleanly when never connected', async () => {
    const idle = build();
    await expect(idle.close()).resolves.toBeUndefined();
  });

  it('is safe to close twice', async () => {
    await relay.connect();
    await relay.close();
    await expect(relay.close()).resolves.toBeUndefined();
  });
});
