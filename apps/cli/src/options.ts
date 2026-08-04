/**
 * Command-line argument parsing.
 *
 * Hand-written rather than delegated to a framework: the grammar is small, the
 * dependency budget stays at zero, and every flag can be documented in one place
 * next to the code that reads it.
 */
import { DEFAULT_CONTROL_PORT, DEFAULT_HOST, DEFAULT_TIMEOUT_MS } from '@socketlens/protocol';

/** Options that apply to every command. */
export interface GlobalOptions {
  readonly host: string;
  readonly port: number;
  /** Milliseconds to wait for each SLTP response. */
  readonly timeoutMs: number;
  /** Session identifier supplied explicitly, overriding the remembered one. */
  readonly session: string | undefined;
  /** Print every raw SLTP message, with CRLF made visible. */
  readonly raw: boolean;
  /** Print full protocol traffic rather than a one-line summary per message. */
  readonly verbose: boolean;
  /** Suppress protocol traffic entirely, leaving only command results. */
  readonly quiet: boolean;
  /** Emit machine-readable JSON instead of formatted text. */
  readonly json: boolean;
  /** Disable ANSI colour even on a TTY. */
  readonly noColour: boolean;
}

/** A parsed command line. */
export interface ParsedCommandLine {
  /** Command path, e.g. `['session', 'create']`. Empty when only flags were given. */
  readonly command: readonly string[];
  /** Positional arguments that followed the command path. */
  readonly positional: readonly string[];
  /** Named flag values, keyed by long name without the leading dashes. */
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly global: GlobalOptions;
  readonly help: boolean;
  readonly version: boolean;
}

/** Raised for a malformed command line, so `main` can exit with a usage code. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Flags that take a value. Everything else is treated as a boolean switch, which is
 * what lets `--raw` and `--name demo` be parsed without a schema per command.
 */
const VALUE_FLAGS = new Set([
  'host',
  'h',
  'port',
  'p',
  'timeout',
  'session',
  's',
  'name',
  'description',
  'echo',
  'file',
  'json-body',
  'operation',
  'status',
  'phrase',
  'body',
  'priority',
  'delay',
  'out',
  'text',
  'id',
  'scenario',
  'header',
  'fragment',
  'expect-status',
]);

/**
 * Every flag the CLI understands, after alias expansion.
 *
 * Unknown flags are rejected rather than ignored. Without this, a typo such as
 * `--match-op PING` would parse as a bare switch plus a stray positional, and the
 * rule would be installed silently matching every operation instead of PING —
 * exactly the kind of quiet wrong answer a testing tool must not produce.
 */
const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS,
  'disable',
  'enable',
  'help',
  'json',
  'no-color',
  'no-colour',
  'no-install-rules',
  'quiet',
  'raw',
  'verbose',
  'version',
]);

/** Short flags mapped to their long equivalents. */
const ALIASES: Readonly<Record<string, string>> = {
  h: 'host',
  p: 'port',
  s: 'session',
  v: 'verbose',
  q: 'quiet',
  V: 'version',
};

/** Known command paths, longest first, so `session create` beats `session`. */
const COMMAND_PATHS: readonly (readonly string[])[] = [
  ['session', 'create'],
  ['session', 'list'],
  ['session', 'show'],
  ['session', 'use'],
  ['session', 'close'],
  ['rule', 'add'],
  ['rule', 'list'],
  ['rule', 'update'],
  ['rule', 'delete'],
  ['result', 'show'],
  ['result', 'list'],
  ['result', 'export'],
  ['scenario', 'run'],
  ['scenario', 'show'],
  ['ping'],
  ['info'],
  ['run'],
  ['raw'],
  ['repl'],
  ['help'],
];

/**
 * Parses `process.argv.slice(2)`.
 *
 * Values may be written `--flag value` or `--flag=value`. A bare `--` stops flag
 * parsing, so a raw payload beginning with a dash can still be passed through.
 */
export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const words: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (passthrough) {
      words.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (token.startsWith('--')) {
      const [rawName, inlineValue] = splitInline(token.slice(2));
      if (rawName.length === 0) throw new UsageError('Found `--` with no flag name after it.');
      const name = ALIASES[rawName] ?? rawName;
      assertKnown(rawName, name, '--');

      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
        continue;
      }
      if (VALUE_FLAGS.has(rawName) || VALUE_FLAGS.has(name)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError(
            `Flag --${rawName} needs a value, for example --${rawName} <value>.`,
          );
        }
        flags[name] = value;
        index += 1;
        continue;
      }
      flags[name] = true;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const [rawName, inlineValue] = splitInline(token.slice(1));
      // `-h` is help only when it stands alone; `-h 127.0.0.1` sets the host, which is
      // why the alias table maps it to `host` and `--help` is spelled in full.
      const name = ALIASES[rawName] ?? rawName;
      assertKnown(rawName, name, '-');
      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
        continue;
      }
      if (VALUE_FLAGS.has(rawName)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          if (rawName === 'h') {
            flags['help'] = true;
            continue;
          }
          throw new UsageError(`Flag -${rawName} needs a value, for example -${rawName} <value>.`);
        }
        flags[name] = value;
        index += 1;
        continue;
      }
      flags[name] = true;
      continue;
    }

    words.push(token);
  }

  const command = matchCommand(words);
  const positional = words.slice(command.length);

  return {
    command,
    positional,
    flags,
    global: buildGlobalOptions(flags),
    help: flags['help'] === true || command[0] === 'help',
    version: flags['version'] === true,
  };
}

/**
 * Rejects a flag the CLI does not define.
 *
 * Both the written spelling and its alias expansion are checked so that `-p` and
 * `--port` are accepted while `--prot` is not.
 */
function assertKnown(rawName: string, name: string, dashes: string): void {
  if (KNOWN_FLAGS.has(rawName) || KNOWN_FLAGS.has(name)) return;
  const suggestion = nearestFlag(name);
  throw new UsageError(
    `Unknown flag ${dashes}${rawName}.${suggestion !== undefined ? ` Did you mean --${suggestion}?` : ''} ` +
      'Run `socketlens --help` for the flag list.',
  );
}

/**
 * Finds the closest known flag by edit distance, for a "did you mean" hint.
 *
 * Only close matches are offered; an unrelated word gets no suggestion at all,
 * which is more useful than a confidently wrong guess.
 */
function nearestFlag(name: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of KNOWN_FLAGS) {
    if (candidate.length === 1) continue;
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Three edits on a short flag name is already a different word.
  return bestDistance <= Math.min(3, Math.max(1, Math.floor(name.length / 2))) ? best : undefined;
}

/** Levenshtein distance, iterative single-row form. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Splits `name=value` into its parts, returning `undefined` when there is no `=`. */
function splitInline(token: string): [string, string | undefined] {
  const equals = token.indexOf('=');
  if (equals === -1) return [token, undefined];
  return [token.slice(0, equals), token.slice(equals + 1)];
}

/** Finds the longest registered command path that prefixes the given words. */
function matchCommand(words: readonly string[]): readonly string[] {
  const candidates = [...COMMAND_PATHS].sort((a, b) => b.length - a.length);
  for (const path of candidates) {
    if (path.every((segment, index) => words[index] === segment)) return path;
  }
  return words.length > 0 ? [words[0]!] : [];
}

/** Extracts the global options, validating anything numeric. */
function buildGlobalOptions(flags: Readonly<Record<string, string | boolean>>): GlobalOptions {
  return {
    host: stringFlag(flags, 'host') ?? process.env['SOCKETLENS_HOST'] ?? DEFAULT_HOST,
    port: numberFlag(flags, 'port') ?? envPort() ?? DEFAULT_CONTROL_PORT,
    timeoutMs: numberFlag(flags, 'timeout') ?? DEFAULT_TIMEOUT_MS,
    session: stringFlag(flags, 'session'),
    raw: flags['raw'] === true,
    verbose: flags['verbose'] === true,
    quiet: flags['quiet'] === true,
    json: flags['json'] === true,
    noColour: flags['no-color'] === true || flags['no-colour'] === true,
  };
}

/** Reads `SOCKETLENS_PORT`, ignoring an unusable value rather than failing to start. */
function envPort(): number | undefined {
  const raw = process.env['SOCKETLENS_PORT'];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : undefined;
}

/** Reads a flag that must be a string. */
export function stringFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  // A boolean here means the flag was written as a bare switch, e.g. `--name` with
  // nothing after it, which for a value flag is a usage mistake rather than `false`.
  if (typeof value !== 'string') throw new UsageError(`Flag --${name} needs a value.`);
  return value;
}

/** Reads a flag that must be a finite number. */
export function numberFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new UsageError(`Flag --${name} expects a number but received "${value}".`);
  }
  return parsed;
}

/** Reads a repeatable `--header Name: value` flag into a header record. */
export function headerFlags(
  flags: Readonly<Record<string, string | boolean>>,
): Record<string, string> {
  const value = flags['header'];
  if (typeof value !== 'string') return {};
  const headers: Record<string, string> = {};
  // Several `--header` flags collapse to the last one during parsing, so the value
  // may also carry a comma-separated list for the multi-header case.
  for (const entry of value.split(',')) {
    const colon = entry.indexOf(':');
    if (colon === -1) {
      throw new UsageError(`--header expects "Name: value" but received "${entry.trim()}".`);
    }
    const name = entry.slice(0, colon).trim();
    if (name.length === 0) throw new UsageError('--header was given an empty field name.');
    headers[name] = entry.slice(colon + 1).trim();
  }
  return headers;
}
