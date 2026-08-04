#!/usr/bin/env node
/**
 * Bridge entry point.
 *
 * Starts the loopback HTTP relay, opens the raw TCP connection to the SLTP control
 * server, and shuts both down cleanly on a signal.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProtocolLogger } from '@socketlens/core';
import { EventHub } from './events.js';
import { createRequestHandler } from './http.js';
import { Relay } from './relay.js';
import { parseArgs, BRIDGE_VERSION, USAGE, type BridgeOptions } from './options.js';

export { Relay } from './relay.js';
export type { RelayOptions, RelayStatus, RelayRequest, RelayExchange } from './relay.js';
export { EventHub } from './events.js';
export { createRequestHandler } from './http.js';
export { parseArgs, BRIDGE_VERSION, USAGE } from './options.js';
export type { BridgeOptions } from './options.js';

/** A running bridge. */
export interface RunningBridge {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly relay: Relay;
  readonly hub: EventHub;
  close(): Promise<void>;
}

/** Starts the bridge and resolves once it is listening. */
export async function startBridge(options: BridgeOptions): Promise<RunningBridge> {
  const hub = new EventHub();
  const relay = new Relay({
    serverHost: options.serverHost,
    serverPort: options.serverPort,
    timeoutMs: options.timeoutMs,
    logLevel: options.logLevel,
    hub,
  });

  const staticDir = options.staticDir === undefined ? undefined : path.resolve(options.staticDir);
  const server = http.createServer(createRequestHandler({ relay, hub, staticDir }));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${options.host}:${port}/`;

  return {
    host: options.host,
    port,
    url,
    relay,
    hub,
    async close(): Promise<void> {
      // Every event stream must end before the listener's close callback can fire: an
      // attached browser tab holds an open response, and `server.close()` waits for it.
      hub.close();
      await relay.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** CLI entry point. Returns the process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${BRIDGE_VERSION}\n`);
    return 0;
  }

  const logger = new ProtocolLogger({ role: 'BRIDGE', level: parsed.logLevel });
  const bridge = await startBridge(parsed);

  logger.info(`interface relay listening on ${bridge.url}`);
  logger.info(
    `SLTP control server is ${parsed.serverHost}:${parsed.serverPort} — the bridge speaks to it over raw TCP`,
  );
  if (parsed.staticDir === undefined) {
    logger.info('no --static directory: run `npm run dev:gui` for the Vite dev server');
  }

  if (parsed.connectOnStart) {
    try {
      await bridge.relay.connect();
    } catch (cause) {
      // Not fatal. The interface can retry once the server is up.
      logger.warn(
        `could not reach the SLTP server yet: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  if (parsed.open) await openBrowser(bridge.url, logger);

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = (signal: string): void => {
      if (closing) return;
      closing = true;
      logger.info(`${signal} received, shutting down`);
      bridge
        .close()
        .catch((cause: unknown) => {
          logger.error(
            `shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        })
        .finally(resolve);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });

  return 0;
}

/** Opens the default browser, reporting rather than failing if it cannot. */
async function openBrowser(url: string, logger: ProtocolLogger): Promise<void> {
  const command =
    process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(command, [url], {
      shell: process.platform === 'win32',
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } catch {
    logger.info(`open ${url} in your browser`);
  }
}

// Only run when executed directly, so importing this module for tests starts nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
      process.exitCode = 1;
    },
  );
}

// Referenced so the import is not flagged when the file is consumed as a module.
export const BRIDGE_ENTRY = fileURLToPath(import.meta.url);
