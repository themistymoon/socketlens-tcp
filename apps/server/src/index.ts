#!/usr/bin/env node
/**
 * `socketlens-server` — command-line entry point for the SLTP control server.
 *
 * Parses a small set of flags, starts the server, and shuts it down cleanly on
 * SIGINT or SIGTERM so that every session's mock endpoint is released.
 */
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOST,
  SERVER_PRODUCT,
  SLTP_VERSION_TOKEN,
} from '@socketlens/protocol';
import { ProtocolLogger, type LogLevel } from '@socketlens/core';
import { DEFAULT_MAX_CONNECTIONS, SltpServer } from './server.js';

export { SltpServer, startServer } from './server.js';
export type { RateLimitOptions, ServerAddress, SltpServerOptions } from './server.js';
export { handleOperation } from './handlers.js';
export type { HandlerContext, HandlerResponse } from './handlers.js';

/** Flags accepted on the command line. */
interface CliOptions {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly maxConnections: number;
  readonly allowedTargetHosts: readonly string[];
  readonly rateLimit: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

const USAGE = `${SERVER_PRODUCT} — SocketLens Testing Protocol (${SLTP_VERSION_TOKEN}) control server

Usage:
  socketlens-server [options]

Options:
  -H, --host <address>       Interface to bind (default ${DEFAULT_HOST})
  -p, --port <number>        TCP port to listen on (default ${DEFAULT_CONTROL_PORT}); 0 asks the OS
  -v, --verbose              Print every raw SLTP message as well as the summary line
  -q, --quiet                Print nothing
      --max-connections <n>  Simultaneous control connections (default ${DEFAULT_MAX_CONNECTIONS})
      --allow-target <host>   Permit scenarios to target this development host as well as
                             loopback. May be repeated. Loopback is always permitted.
      --no-rate-limit        Disable the per-connection request rate limit
  -h, --help                 Show this help
      --version              Print the product version

The server speaks SLTP over raw TCP only. There is no HTTP interface: connect with
the CLI (\`socketlens ping\`), with the graphical interface's bridge, or with any
tool that can write bytes to a TCP socket.

Each session gets its own ephemeral TCP mock endpoint on the loopback interface, so
test scenarios exercise real TCP segmentation rather than a simulation of it.
`;

/** Parses argv, returning the options or a message explaining what was wrong. */
export function parseArgs(argv: readonly string[]): CliOptions | { readonly error: string } {
  let host = DEFAULT_HOST;
  let port = DEFAULT_CONTROL_PORT;
  let logLevel: LogLevel = 'summary';
  let maxConnections = DEFAULT_MAX_CONNECTIONS;
  const allowedTargetHosts: string[] = [];
  let rateLimit = true;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string | undefined => argv[++index];

    switch (arg) {
      case '-H':
      case '--host': {
        const value = next();
        if (!value) return { error: `${arg} requires an address.` };
        host = value;
        break;
      }
      case '-p':
      case '--port': {
        const value = next();
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
          return {
            error: `${arg} requires a port between 0 and 65535; received ${String(value)}.`,
          };
        }
        port = parsed;
        break;
      }
      case '--max-connections': {
        const value = next();
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return { error: `${arg} requires a positive integer; received ${String(value)}.` };
        }
        maxConnections = parsed;
        break;
      }
      case '--allow-target': {
        const value = next();
        if (!value) return { error: `${arg} requires a host name or address.` };
        allowedTargetHosts.push(value);
        break;
      }
      case '--no-rate-limit':
        rateLimit = false;
        break;
      case '-v':
      case '--verbose':
        logLevel = 'verbose';
        break;
      case '-q':
      case '--quiet':
        logLevel = 'silent';
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      case '--version':
        version = true;
        break;
      default:
        return { error: `Unknown option ${arg}. Run socketlens-server --help.` };
    }
  }

  return { host, port, logLevel, maxConnections, allowedTargetHosts, rateLimit, help, version };
}

/** Starts the server from argv and wires signal handling. Resolves when it exits. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${SERVER_PRODUCT}\n`);
    return 0;
  }

  const logger = new ProtocolLogger({ role: 'SERVER', level: parsed.logLevel });
  const server = new SltpServer({
    host: parsed.host,
    port: parsed.port,
    logger,
    maxConnections: parsed.maxConnections,
    allowedTargetHosts: parsed.allowedTargetHosts,
    ...(parsed.rateLimit ? {} : { rateLimit: false as const }),
  });

  try {
    await server.listen();
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }

  if (parsed.allowedTargetHosts.length > 0) {
    logger.info(`scenarios may also target: ${parsed.allowedTargetHosts.join(', ')}`);
  }
  logger.info('press Ctrl+C to stop');

  // Resolve only once a signal arrives, so the process stays up serving connections.
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) {
        // A second signal means the operator is impatient; leave immediately.
        process.exit(130);
      }
      stopping = true;
      logger.info(`received ${signal}`);
      void server
        .close()
        .catch((cause: unknown) => {
          logger.error(
            `shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        })
        .finally(resolve);
    };

    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });

  return 0;
}

// Run only when executed directly, so importing this module in a test starts nothing.
// `pathToFileURL` is required rather than string concatenation: on Windows the argv
// path is `C:\...`, which is not a valid URL on its own.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
      process.exitCode = 1;
    },
  );
}
