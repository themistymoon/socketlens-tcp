/**
 * Bridge command-line parsing.
 *
 * The parser is the only thing standing between a typo and a bridge that is either
 * misconfigured or — in the `--host` case — reachable from the network. The relay
 * forwards onto an unauthenticated TCP socket, so the loopback check is a safety
 * property rather than a convenience, and it is asserted here in both directions.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOST,
  DEFAULT_TIMEOUT_MS,
} from '@socketlens/protocol';
import { parseArgs, BRIDGE_VERSION, USAGE } from '../../apps/bridge/src/options.js';
import type { BridgeOptions } from '../../apps/bridge/src/options.js';

/** Narrows a parse that is expected to have succeeded. */
function ok(argv: readonly string[]): BridgeOptions {
  const parsed = parseArgs(argv);
  if ('error' in parsed) throw new Error(`expected a successful parse, got: ${parsed.error}`);
  return parsed;
}

/** Narrows a parse that is expected to have failed. */
function err(argv: readonly string[]): string {
  const parsed = parseArgs(argv);
  if (!('error' in parsed)) throw new Error('expected the parse to fail, but it succeeded');
  return parsed.error;
}

describe('defaults', () => {
  it('falls back to the protocol defaults when given no flags', () => {
    expect(ok([])).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_BRIDGE_PORT,
      serverHost: DEFAULT_HOST,
      serverPort: DEFAULT_CONTROL_PORT,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      staticDir: undefined,
      open: false,
      connectOnStart: true,
      logLevel: 'summary',
      help: false,
      version: false,
    });
  });

  it('connects on start unless --no-connect is given', () => {
    expect(ok([]).connectOnStart).toBe(true);
    expect(ok(['--no-connect']).connectOnStart).toBe(false);
  });
});

describe('--host', () => {
  // The bridge relays onto a socket with no authentication. Binding anything routable
  // would publish that socket to the network, so this is refused rather than warned about.
  it.each(['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]'])(
    'accepts the loopback address %s',
    (host) => {
      expect(ok(['--host', host]).host).toBe(host);
    },
  );

  it.each(['0.0.0.0', '192.168.1.10', '10.0.0.1', 'example.com', '::'])(
    'refuses the non-loopback address %s',
    (host) => {
      const message = err(['--host', host]);
      expect(message).toContain('must be a loopback address');
      expect(message).toContain(host);
    },
  );

  it('refuses a bare 127 prefix that is not a full address', () => {
    expect(err(['--host', '127.0.0'])).toContain('loopback');
  });

  it('requires a value', () => {
    expect(err(['--host'])).toBe('--host requires an address.');
  });
});

describe('numeric flags', () => {
  it('accepts port 0, which asks the OS to assign one', () => {
    expect(ok(['--port', '0']).port).toBe(0);
  });

  it('accepts the top of the port range', () => {
    expect(ok(['--port', '65535']).port).toBe(65_535);
  });

  it.each(['65536', '-1', 'eight', '80.5'])('refuses --port %s', (value) => {
    expect(err(['--port', value])).toBe('--port requires a port between 0 and 65535.');
  });

  it('requires a value for --port', () => {
    expect(err(['--port'])).toBe('--port requires a port between 0 and 65535.');
  });

  // The control server port differs from the relay port: 0 is meaningless for a port
  // you are dialling out to, so the accepted range starts at 1.
  it('refuses --server-port 0 even though --port 0 is allowed', () => {
    expect(err(['--server-port', '0'])).toBe('--server-port requires a port between 1 and 65535.');
    expect(ok(['--server-port', '1']).serverPort).toBe(1);
  });

  it.each(['0', '-5', 'soon', '1.5'])('refuses --timeout %s', (value) => {
    expect(err(['--timeout', value])).toBe('--timeout requires a positive number of milliseconds.');
  });

  it('accepts a positive timeout', () => {
    expect(ok(['--timeout', '250']).timeoutMs).toBe(250);
  });
});

describe('remaining flags', () => {
  it('takes a server host without the loopback restriction', () => {
    // Dialling out to a development endpoint on another host is a legitimate use;
    // only the interface the bridge *binds* is restricted.
    expect(ok(['--server-host', 'dev.internal']).serverHost).toBe('dev.internal');
  });

  it('requires a directory for --static', () => {
    expect(err(['--static'])).toBe('--static requires a directory path.');
    expect(ok(['--static', 'apps/gui/dist']).staticDir).toBe('apps/gui/dist');
  });

  it('maps the verbosity flags onto log levels', () => {
    expect(ok([]).logLevel).toBe('summary');
    expect(ok(['-v']).logLevel).toBe('verbose');
    expect(ok(['--verbose']).logLevel).toBe('verbose');
    expect(ok(['-q']).logLevel).toBe('silent');
    expect(ok(['--quiet']).logLevel).toBe('silent');
  });

  it('lets a later verbosity flag win', () => {
    expect(ok(['--verbose', '--quiet']).logLevel).toBe('silent');
    expect(ok(['--quiet', '--verbose']).logLevel).toBe('verbose');
  });

  it('sets the help and version flags', () => {
    expect(ok(['-h']).help).toBe(true);
    expect(ok(['--help']).help).toBe(true);
    expect(ok(['--version']).version).toBe(true);
  });

  it('sets --open', () => {
    expect(ok(['--open']).open).toBe(true);
  });
});

describe('unknown input', () => {
  it('names the flag it did not recognise', () => {
    expect(err(['--colour'])).toBe('Unknown option --colour. Run socketlens-bridge --help.');
  });

  // A bare word is not a subcommand: the bridge has no verbs, only flags.
  it('rejects a positional argument', () => {
    expect(err(['start'])).toContain('Unknown option start');
  });

  it('reports the first problem rather than the last', () => {
    expect(err(['--nope', '--also-nope'])).toContain('--nope');
  });
});

describe('usage text', () => {
  it('carries the version reported by --version', () => {
    expect(USAGE).toContain(BRIDGE_VERSION);
  });

  // A flag that exists but is undocumented is how a tool's help goes stale.
  it.each([
    '--host',
    '--port',
    '--server-host',
    '--server-port',
    '--timeout',
    '--static',
    '--open',
    '--no-connect',
    '--verbose',
    '--quiet',
    '--help',
    '--version',
  ])('documents %s', (flag) => {
    expect(USAGE).toContain(flag);
  });

  // The bridge's reason for existing is the thing most likely to be misread, so the
  // help text states it outright.
  it('states that SLTP itself is not carried over HTTP', () => {
    expect(USAGE).toContain('raw TCP');
    expect(USAGE).toMatch(/no HTTP framing ever touches it/i);
  });
});
