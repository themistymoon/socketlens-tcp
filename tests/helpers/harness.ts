/**
 * Helpers for driving a real SLTP control server in tests.
 *
 * Every test gets its own server bound to an OS-assigned port, so tests never collide
 * on a fixed port and can run in parallel. Nothing here fakes the transport: the
 * client and server talk over an actual TCP connection.
 */
import { SltpClient, silentLogger, type Exchange } from '@socketlens/core';
import { SltpServer, type SltpServerOptions } from '@socketlens/server';

/** A running server plus a helper for opening clients against it. */
export interface Harness {
  readonly server: SltpServer;
  readonly host: string;
  readonly port: number;
  /** Opens and connects a client, and registers it for automatic cleanup. */
  readonly client: (timeoutMs?: number) => Promise<SltpClient>;
  /** Closes every client this harness opened, then the server. */
  readonly stop: () => Promise<void>;
}

/** Starts a silent server on an ephemeral port. */
export async function startHarness(options: SltpServerOptions = {}): Promise<Harness> {
  const server = new SltpServer({
    port: 0,
    logger: silentLogger('SERVER'),
    ...options,
  });
  const address = await server.listen();
  const clients: SltpClient[] = [];

  return {
    server,
    host: address.host,
    port: address.port,
    client: async (timeoutMs = 3_000) => {
      const client = new SltpClient({
        host: address.host,
        port: address.port,
        logger: silentLogger('CLIENT'),
        timeoutMs,
      });
      await client.connect();
      clients.push(client);
      return client;
    },
    stop: async () => {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      await server.close(200);
    },
  };
}

/** Parses an exchange's JSON body, failing loudly when it is not JSON. */
export function jsonBody<T = Record<string, unknown>>(exchange: Exchange): T {
  try {
    return JSON.parse(exchange.response.body) as T;
  } catch {
    throw new Error(
      `expected a JSON body but received ${JSON.stringify(exchange.response.body.slice(0, 200))}`,
    );
  }
}

/** Creates a session and returns its identifier. */
export async function createSession(client: SltpClient, name = 'test-session'): Promise<string> {
  const created = await client.send({ operation: 'CREATE_SESSION', json: { name } });
  const body = jsonBody<{ session: { id: string } }>(created);
  return body.session.id;
}

/** Adds a rule that answers any PING with 200 OK and a small JSON body. */
export async function addPingRule(
  client: SltpClient,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const added = await client.send({
    operation: 'ADD_RULE',
    sessionId,
    json: {
      name: 'ping-ok',
      match: { operation: 'PING' },
      response: { statusCode: 200, statusPhrase: 'OK', body: '{"pong":true}' },
      ...overrides,
    },
  });
  return jsonBody<{ rule: { id: string } }>(added).rule.id;
}
