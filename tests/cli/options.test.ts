/**
 * Command-line parsing.
 *
 * The parser is the CLI's outermost contract: everything downstream trusts the
 * shape it produces. The cases that matter most are the ones where a silently
 * wrong parse would produce a confidently wrong answer — an unknown flag, a value
 * flag left without a value, or a numeric flag given a word.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONTROL_PORT, DEFAULT_HOST, DEFAULT_TIMEOUT_MS } from '@socketlens/protocol';
import {
  headerFlags,
  numberFlag,
  parseCommandLine,
  stringFlag,
  UsageError,
} from '../../apps/cli/src/options.js';

// The environment supplies fallbacks for host and port, so it is cleared first:
// a developer's own SOCKETLENS_PORT must not change what these tests assert.
beforeEach(() => {
  vi.stubEnv('SOCKETLENS_HOST', undefined);
  vi.stubEnv('SOCKETLENS_PORT', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('global options', () => {
  it('falls back to the protocol defaults when no flags are given', () => {
    const parsed = parseCommandLine(['ping']);

    expect(parsed.global).toMatchObject({
      host: DEFAULT_HOST,
      port: DEFAULT_CONTROL_PORT,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      session: undefined,
      raw: false,
      verbose: false,
      quiet: false,
      json: false,
      noColour: false,
    });
  });

  it('coerces numeric flags to numbers rather than leaving them as strings', () => {
    const parsed = parseCommandLine(['ping', '--port', '9000', '--timeout', '250']);

    expect(parsed.global.port).toBe(9000);
    expect(parsed.global.timeoutMs).toBe(250);
    // The raw flag record keeps the written text; only the globals are coerced.
    expect(parsed.flags['port']).toBe('9000');
  });

  it('accepts both `--flag value` and `--flag=value`', () => {
    const spaced = parseCommandLine(['ping', '--host', 'example.test', '--port', '9001']);
    const inline = parseCommandLine(['ping', '--host=example.test', '--port=9001']);

    expect(inline.global).toMatchObject({ host: 'example.test', port: 9001 });
    expect(inline.global).toEqual(spaced.global);
  });

  it('expands the short aliases for host, port, session, verbose, quiet, and version', () => {
    const parsed = parseCommandLine([
      'ping',
      '-h',
      '10.0.0.1',
      '-p',
      '9002',
      '-s',
      'ses-7',
      '-v',
      '-q',
    ]);

    expect(parsed.global).toMatchObject({
      host: '10.0.0.1',
      port: 9002,
      session: 'ses-7',
      verbose: true,
      quiet: true,
    });
    expect(parseCommandLine(['-V']).version).toBe(true);
  });

  it('treats a bare -h as help, because only `-h <value>` can mean host', () => {
    const bare = parseCommandLine(['-h']);

    expect(bare.help).toBe(true);
    expect(bare.global.host).toBe(DEFAULT_HOST);
  });

  it('collects the boolean switches', () => {
    const parsed = parseCommandLine(['ping', '--raw', '--json', '--no-color']);

    expect(parsed.global).toMatchObject({ raw: true, json: true, noColour: true });
  });

  it('accepts either spelling of the colour flag', () => {
    expect(parseCommandLine(['ping', '--no-colour']).global.noColour).toBe(true);
    expect(parseCommandLine(['ping', '--no-color']).global.noColour).toBe(true);
  });

  it('reads the server address from the environment when no flag overrides it', () => {
    vi.stubEnv('SOCKETLENS_HOST', 'env.test');
    vi.stubEnv('SOCKETLENS_PORT', '9100');

    expect(parseCommandLine(['ping']).global).toMatchObject({ host: 'env.test', port: 9100 });
    // An explicit flag still wins.
    expect(parseCommandLine(['ping', '--port', '9200']).global.port).toBe(9200);
  });

  it('ignores an unusable SOCKETLENS_PORT rather than refusing to start', () => {
    vi.stubEnv('SOCKETLENS_PORT', 'not-a-port');

    expect(parseCommandLine(['ping']).global.port).toBe(DEFAULT_CONTROL_PORT);
  });
});

describe('command paths', () => {
  it('prefers the longest registered path, so `session create` beats `session`', () => {
    const parsed = parseCommandLine(['session', 'create', '--name', 'demo']);

    expect(parsed.command).toEqual(['session', 'create']);
    expect(parsed.positional).toEqual([]);
    expect(parsed.flags['name']).toBe('demo');
  });

  it('keeps the words after the command path as positional arguments', () => {
    const parsed = parseCommandLine(['result', 'show', 'res-1', 'extra']);

    expect(parsed.command).toEqual(['result', 'show']);
    expect(parsed.positional).toEqual(['res-1', 'extra']);
  });

  it('separates a single-word command from its positional argument', () => {
    const parsed = parseCommandLine(['run', 'bundle.json']);

    expect(parsed.command).toEqual(['run']);
    expect(parsed.positional).toEqual(['bundle.json']);
  });

  it('leaves an unregistered word as a one-word command for the dispatcher to reject', () => {
    const parsed = parseCommandLine(['frobnicate', 'x']);

    expect(parsed.command).toEqual(['frobnicate']);
    expect(parsed.positional).toEqual(['x']);
  });

  it('returns an empty command path when only flags were given', () => {
    const parsed = parseCommandLine(['--help']);

    expect(parsed.command).toEqual([]);
    expect(parsed.help).toBe(true);
  });

  it('stops flag parsing at a bare --, so a payload may begin with a dash', () => {
    const parsed = parseCommandLine(['raw', '--', '--text', '-p']);

    expect(parsed.command).toEqual(['raw']);
    expect(parsed.positional).toEqual(['--text', '-p']);
    expect(parsed.flags['text']).toBeUndefined();
  });
});

describe('help and version', () => {
  it('reports help for the --help flag and for the help command alike', () => {
    expect(parseCommandLine(['ping', '--help']).help).toBe(true);
    expect(parseCommandLine(['help']).help).toBe(true);
    expect(parseCommandLine(['help', 'operations']).positional).toEqual(['operations']);
    expect(parseCommandLine(['ping']).help).toBe(false);
  });

  it('reports the version only for the version flag', () => {
    expect(parseCommandLine(['--version']).version).toBe(true);
    expect(parseCommandLine(['ping']).version).toBe(false);
  });
});

describe('rejecting unknown options', () => {
  it('rejects an unknown long flag instead of treating it as a bare switch', () => {
    // Silently accepting `--match-op PING` would install a rule matching every
    // operation, which is exactly the quiet wrong answer this must not produce.
    expect(() => parseCommandLine(['rule', 'add', '--match-op', 'PING'])).toThrow(UsageError);
  });

  it('suggests the nearest flag for a near miss', () => {
    try {
      parseCommandLine(['ping', '--prot', '9000']);
      expect.unreachable('an unknown flag should have been rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain('Unknown flag --prot');
      expect((error as UsageError).message).toContain('port');
    }
  });

  it('offers no suggestion for a word unlike any known flag', () => {
    try {
      parseCommandLine(['ping', '--zzzzzzzzzzzz']);
      expect.unreachable('an unknown flag should have been rejected');
    } catch (error) {
      expect((error as UsageError).message).toContain('Unknown flag --zzzzzzzzzzzz');
      expect((error as UsageError).message).not.toContain('Did you mean');
    }
  });

  it('rejects an unknown short flag', () => {
    expect(() => parseCommandLine(['ping', '-z'])).toThrow(/Unknown flag -z/);
  });

  it('rejects a lone -- with no flag name after it', () => {
    expect(() => parseCommandLine(['--=value'])).toThrow(UsageError);
  });
});

describe('malformed flag values', () => {
  it('rejects a value flag left at the end of the line', () => {
    expect(() => parseCommandLine(['session', 'create', '--name'])).toThrow(
      /Flag --name needs a value/,
    );
  });

  it('rejects a value flag followed by another flag rather than a value', () => {
    expect(() => parseCommandLine(['session', 'create', '--name', '--raw'])).toThrow(UsageError);
  });

  it('rejects a numeric flag given a word', () => {
    expect(() => parseCommandLine(['ping', '--port', 'eight'])).toThrow(
      /Flag --port expects a number but received "eight"/,
    );
  });
});

describe('flag readers', () => {
  it('stringFlag returns the value, or undefined when absent', () => {
    expect(stringFlag({ name: 'demo' }, 'name')).toBe('demo');
    expect(stringFlag({}, 'name')).toBeUndefined();
  });

  it('stringFlag rejects a value flag that arrived as a bare switch', () => {
    expect(() => stringFlag({ name: true }, 'name')).toThrow(/Flag --name needs a value/);
  });

  it('numberFlag coerces and validates', () => {
    expect(numberFlag({ priority: '10' }, 'priority')).toBe(10);
    expect(numberFlag({ delay: '2.5' }, 'delay')).toBe(2.5);
    expect(numberFlag({}, 'priority')).toBeUndefined();
    expect(() => numberFlag({ priority: 'high' }, 'priority')).toThrow(UsageError);
  });

  it('headerFlags parses "Name: value", trimming around the colon', () => {
    expect(headerFlags({ header: 'Content-Type:  application/json ' })).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('headerFlags splits a comma-separated list into several headers', () => {
    expect(headerFlags({ header: 'X-A: 1,X-B: 2' })).toEqual({ 'X-A': '1', 'X-B': '2' });
  });

  it('headerFlags returns nothing when the flag is absent', () => {
    expect(headerFlags({})).toEqual({});
  });

  it('headerFlags rejects a header with no colon and one with an empty name', () => {
    expect(() => headerFlags({ header: 'Content-Type' })).toThrow(/--header expects "Name: value"/);
    expect(() => headerFlags({ header: ': value' })).toThrow(/empty field name/);
  });
});
