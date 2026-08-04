/**
 * Command-line parsing for the loopback bridge.
 *
 * Hand-written for the same reason as the CLI's parser: the grammar is tiny, the
 * dependency budget stays at zero, and every flag is documented next to the code
 * that reads it.
 */
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOST,
  DEFAULT_TIMEOUT_MS,
} from '@socketlens/protocol';
import type { LogLevel } from '@socketlens/core';

/** Everything the bridge needs to start. */
export interface BridgeOptions {
  /** Loopback interface the HTTP relay binds. Never a routable address. */
  readonly host: string;
  /** Port the HTTP relay listens on. */
  readonly port: number;
  /** Host of the SLTP control server the bridge opens a TCP socket to. */
  readonly serverHost: string;
  /** Port of the SLTP control server. */
  readonly serverPort: number;
  /** Default milliseconds to wait for an SLTP response. */
  readonly timeoutMs: number;
  /** Directory of built static assets to serve, when the interface is prebuilt. */
  readonly staticDir: string | undefined;
  /** Open the default browser once the relay is listening. */
  readonly open: boolean;
  /** Connect to the control server at startup rather than waiting for a request. */
  readonly connectOnStart: boolean;
  readonly logLevel: LogLevel;
  readonly help: boolean;
  readonly version: boolean;
}

/** Product string reported by `--version`, kept in step with the manifests. */
export const BRIDGE_VERSION = '0.1.0';

/** Usage text, printed by `--help`. */
export const USAGE = `socketlens-bridge ${BRIDGE_VERSION} — loopback relay for the SocketLens TCP interface

Usage:
  socketlens-bridge [options]

Options:
      --host <address>       Loopback interface to bind (default ${DEFAULT_HOST})
      --port <number>        Port for the HTTP relay (default ${DEFAULT_BRIDGE_PORT})
      --server-host <addr>   SLTP control server host (default ${DEFAULT_HOST})
      --server-port <n>      SLTP control server port (default ${DEFAULT_CONTROL_PORT})
      --timeout <ms>         Default SLTP response timeout (default ${DEFAULT_TIMEOUT_MS})
      --static <dir>         Serve the built React interface from this directory
      --open                 Open the interface in the default browser once listening
      --no-connect           Do not open the TCP socket until the interface asks
  -v, --verbose              Print every raw SLTP message as well as the summary line
  -q, --quiet                Print nothing
  -h, --help                 Show this help
      --version              Print the bridge version

A browser cannot open a raw TCP socket, so the bridge owns the real \`node:net\`
connection and exposes it over a minimal loopback HTTP surface under /bridge/*.
The SLTP conversation itself is raw TCP; no HTTP framing ever touches it.
`;

/**
 * Hosts the relay may bind.
 *
 * The bridge relays commands onto a real TCP socket with no authentication, because
 * the project has no accounts and needs none: it is only ever reachable from the
 * machine it runs on. Binding a routable interface would hand that socket to the
 * network, so a non-loopback `--host` is refused outright rather than warned about.
 */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Parses argv, returning the options or a message explaining what was wrong. */
export function parseArgs(argv: readonly string[]): BridgeOptions | { readonly error: string } {
  let host = DEFAULT_HOST;
  let port = DEFAULT_BRIDGE_PORT;
  let serverHost = DEFAULT_HOST;
  let serverPort = DEFAULT_CONTROL_PORT;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let staticDir: string | undefined;
  let open = false;
  let connectOnStart = true;
  let logLevel: LogLevel = 'summary';
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const next = (): string | undefined => argv[++index];

    switch (arg) {
      case '--host': {
        const value = next();
        if (!value) return { error: `${arg} requires an address.` };
        if (!isLoopbackHost(value)) {
          return {
            error:
              `${arg} must be a loopback address: the bridge relays onto an unauthenticated ` +
              `TCP socket and must not be reachable from the network. Received "${value}".`,
          };
        }
        host = value;
        break;
      }
      case '--port': {
        const parsed = Number(next());
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
          return { error: `${arg} requires a port between 0 and 65535.` };
        }
        port = parsed;
        break;
      }
      case '--server-host': {
        const value = next();
        if (!value) return { error: `${arg} requires an address.` };
        serverHost = value;
        break;
      }
      case '--server-port': {
        const parsed = Number(next());
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
          return { error: `${arg} requires a port between 1 and 65535.` };
        }
        serverPort = parsed;
        break;
      }
      case '--timeout': {
        const parsed = Number(next());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return { error: `${arg} requires a positive number of milliseconds.` };
        }
        timeoutMs = parsed;
        break;
      }
      case '--static': {
        const value = next();
        if (!value) return { error: `${arg} requires a directory path.` };
        staticDir = value;
        break;
      }
      case '--open':
        open = true;
        break;
      case '--no-connect':
        connectOnStart = false;
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
        return { error: `Unknown option ${arg}. Run socketlens-bridge --help.` };
    }
  }

  return {
    host,
    port,
    serverHost,
    serverPort,
    timeoutMs,
    staticDir,
    open,
    connectOnStart,
    logLevel,
    help,
    version,
  };
}
