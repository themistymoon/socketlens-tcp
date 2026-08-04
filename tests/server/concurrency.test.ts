/**
 * Concurrency, robustness, and lifecycle.
 *
 * The point of these tests is that one badly behaved client must never affect another.
 * Each connection has its own decoder and its own receive buffer, so a malformed byte
 * stream on one socket leaves every other socket serving normally.
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SLTP_STATUS } from '@socketlens/protocol';
import { SltpClientError } from '@socketlens/core';
import { createSession, jsonBody, startHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** Opens a bare TCP socket, writes bytes, and returns everything received. */
function rawExchange(
  host: string,
  port: number,
  payload: string,
  waitMs = 300,
): Promise<{ received: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks: Buffer[] = [];
    let closed = false;

    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ received: Buffer.concat(chunks).toString('utf8'), closed });
    };
    const timer = setTimeout(finish, waitMs);
    timer.unref?.();

    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('close', () => {
      closed = true;
      finish();
    });
    socket.on('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
}

/**
 * Attempts a TCP connection with a bounded deadline. Resolves if the port accepts,
 * rejects if it refuses or if nothing happens in time — never hangs the test runner.
 */
function connect(host: string, port: number, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(`connect to ${host}:${port} neither succeeded nor failed in ${timeoutMs}ms`),
      );
    }, timeoutMs);
    timer.unref?.();

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.on('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
}

describe('multiple simultaneous clients', () => {
  it('serves several connections at once with isolated sessions', async () => {
    harness = await startHarness();
    const clients = await Promise.all([harness.client(), harness.client(), harness.client()]);

    const sessionIds = await Promise.all(
      clients.map((client, index) => createSession(client, `s${index}`)),
    );

    expect(new Set(sessionIds).size).toBe(3);
    expect(harness.server.connectionCount).toBe(3);

    // Each client sees every session, but a rule added through one connection lands in
    // exactly one session.
    await clients[0]!.send({
      operation: 'ADD_RULE',
      sessionId: sessionIds[0]!,
      json: {
        name: 'only-here',
        match: { operation: 'PING' },
        response: { statusCode: 200, statusPhrase: 'OK' },
      },
    });

    const first = jsonBody<{ count: number }>(
      await clients[1]!.send({ operation: 'LIST_RULES', sessionId: sessionIds[0]! }),
    );
    const second = jsonBody<{ count: number }>(
      await clients[2]!.send({ operation: 'LIST_RULES', sessionId: sessionIds[1]! }),
    );

    expect(first.count).toBe(1);
    expect(second.count).toBe(0);
  });

  it('keeps interleaved requests from many clients correlated correctly', async () => {
    harness = await startHarness();
    const clients = await Promise.all(Array.from({ length: 4 }, () => harness!.client()));

    const exchanges = await Promise.all(
      clients.flatMap((client, index) =>
        Array.from({ length: 5 }, (_unused, round) =>
          client
            .send({ operation: 'PING', json: { echo: `${index}-${round}` } })
            .then((exchange) => ({ expected: `${index}-${round}`, exchange })),
        ),
      ),
    );

    for (const { expected, exchange } of exchanges) {
      expect(jsonBody<{ echo: string }>(exchange).echo).toBe(expected);
    }
  });

  it('refuses connections beyond the configured maximum with 503 SERVER UNAVAILABLE', async () => {
    harness = await startHarness({ maxConnections: 1 });
    await harness.client();

    const { received } = await rawExchange(harness.host, harness.port, '');

    expect(received).toContain(`SLTP/1.0 ${SLTP_STATUS.SERVER_UNAVAILABLE} SERVER UNAVAILABLE`);
  });
});

describe('the server survives hostile input', () => {
  it('answers a malformed start line with 400 and closes only that connection', async () => {
    harness = await startHarness();
    const healthy = await harness.client();

    const { received, closed } = await rawExchange(
      harness.host,
      harness.port,
      'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n',
    );

    expect(received).toContain('SLTP/1.0 400 BAD REQUEST');
    // A malformed start line desynchronises the stream, so the connection must close.
    expect(closed).toBe(true);

    // The other client is untouched.
    const ping = await healthy.send({ operation: 'PING' });
    expect(ping.response.statusCode).toBe(SLTP_STATUS.OK);
  });

  it('answers a duplicate Content-Length with 400 rather than guessing', async () => {
    harness = await startHarness();

    const { received } = await rawExchange(
      harness.host,
      harness.port,
      'SLTP/1.0 PING\r\nRequest-ID: req-dup\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}',
    );

    expect(received).toContain('SLTP/1.0 400 BAD REQUEST');
    expect(received).toContain('duplicate-header');
  });

  it('answers an oversized Content-Length with 413 MESSAGE TOO LARGE', async () => {
    harness = await startHarness();

    const { received } = await rawExchange(
      harness.host,
      harness.port,
      'SLTP/1.0 PING\r\nRequest-ID: req-big\r\nContent-Length: 99999999\r\n\r\n',
    );

    expect(received).toContain(`SLTP/1.0 ${SLTP_STATUS.MESSAGE_TOO_LARGE} MESSAGE TOO LARGE`);
  });

  it('answers an unregistered operation with 501 and stays connected', async () => {
    harness = await startHarness();
    const client = await harness.client();

    const rejected = await client.send({ operation: 'NOT_AN_OPERATION' });
    expect(rejected.response.statusCode).toBe(SLTP_STATUS.OPERATION_NOT_SUPPORTED);

    // 501 is recoverable: the framing was correct, so the connection continues.
    const ping = await client.send({ operation: 'PING' });
    expect(ping.response.statusCode).toBe(SLTP_STATUS.OK);
  });

  it('answers a body that is not JSON with 400 and stays connected', async () => {
    harness = await startHarness();
    const client = await harness.client();

    const rejected = await client.send({ operation: 'PING', body: 'not json at all' });
    expect(rejected.response.statusCode).toBe(SLTP_STATUS.BAD_REQUEST);

    const ping = await client.send({ operation: 'PING' });
    expect(ping.response.statusCode).toBe(SLTP_STATUS.OK);
  });

  it('splits two coalesced requests arriving in one TCP write into two responses', async () => {
    harness = await startHarness();

    const one = 'SLTP/1.0 PING\r\nRequest-ID: req-a\r\n\r\n';
    const two = 'SLTP/1.0 PING\r\nRequest-ID: req-b\r\n\r\n';
    const { received } = await rawExchange(harness.host, harness.port, one + two);

    expect(received).toContain('Request-ID: req-a');
    expect(received).toContain('Request-ID: req-b');
    expect(received.split('SLTP/1.0 200 OK')).toHaveLength(3);
  });

  it('survives a client that disconnects part-way through a message', async () => {
    harness = await startHarness();
    const healthy = await harness.client();

    await new Promise<void>((resolve) => {
      const socket = net.createConnection({ host: harness!.host, port: harness!.port }, () => {
        socket.write('SLTP/1.0 PING\r\nRequest-ID: req-tr');
        socket.destroy();
        resolve();
      });
      socket.on('error', () => resolve());
    });

    // Give the server a moment to process the abrupt close.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const ping = await healthy.send({ operation: 'PING' });
    expect(ping.response.statusCode).toBe(SLTP_STATUS.OK);
  });

  it('applies the rate limit per connection and reports Retry-After', async () => {
    harness = await startHarness({ rateLimit: { capacity: 3, refillPerSecond: 1 } });
    const limited = await harness.client();
    const other = await harness.client();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const exchange = await limited.send({ operation: 'PING' });
      statuses.push(exchange.response.statusCode);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[4]).toBe(SLTP_STATUS.TOO_MANY_REQUESTS);

    const throttled = await limited.send({ operation: 'PING' });
    expect(throttled.response.headers.find((h) => h.name === 'Retry-After')).toBeDefined();

    // The other connection has its own bucket and is unaffected.
    const fresh = await other.send({ operation: 'PING' });
    expect(fresh.response.statusCode).toBe(SLTP_STATUS.OK);
  });
});

describe('shutdown', () => {
  it('closes every session mock endpoint when the server stops', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    const session = jsonBody<{ session: { mockHost: string; mockPort: number } }>(
      await client.send({ operation: 'GET_SESSION', sessionId }),
    ).session;

    await harness.server.close(100);

    // The mock endpoint's port is no longer accepting connections.
    await expect(connect(session.mockHost, session.mockPort)).rejects.toThrow();
  });

  it('settles in-flight requests when the connection closes', async () => {
    harness = await startHarness();
    const client = await harness.client();

    const pending = client.send({ operation: 'PING' });
    await harness.server.close(0);

    // Either the response arrived first or the client reports the close, but the
    // promise must never be left hanging.
    await pending.then(
      (exchange) => expect(exchange.response.statusCode).toBeGreaterThan(0),
      (cause: unknown) => {
        expect(cause).toBeInstanceOf(SltpClientError);
        expect((cause as SltpClientError).code).toBe('closed');
      },
    );
  });
});
