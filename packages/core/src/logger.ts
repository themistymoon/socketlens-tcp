/**
 * Protocol activity logging.
 *
 * Both the server and the client print every SLTP message they send or receive.
 * Making the traffic visible is a primary goal of this project: the log is how a
 * reader sees that TCP delivered bytes and that SLTP framed them into messages.
 *
 * Each entry shows direction, timestamp, connection, Request-ID, Session-ID, the
 * parsed operation or status, the byte length, and the raw message with CRLF made
 * visible. No secrets exist in this protocol, so nothing is redacted.
 */
import {
  describeMessage,
  formatRawBuffer,
  getHeader,
  isRequest,
  SLTP_HEADER,
  statusCategory,
  type SltpMessage,
} from '@socketlens/protocol';

/** How much protocol detail to print. */
export type LogLevel = 'silent' | 'summary' | 'verbose';

/** ANSI colour helpers, disabled when the stream is not a TTY or NO_COLOR is set. */
interface Palette {
  readonly dim: (s: string) => string;
  readonly bold: (s: string) => string;
  readonly outbound: (s: string) => string;
  readonly inbound: (s: string) => string;
  readonly success: (s: string) => string;
  readonly warn: (s: string) => string;
  readonly error: (s: string) => string;
}

const identity = (s: string) => s;

function wrap(code: string): (s: string) => string {
  return (s: string) => `[${code}m${s}[0m`;
}

/** Builds a palette, honouring NO_COLOR and non-TTY output. */
export function createPalette(enabled: boolean): Palette {
  if (!enabled) {
    return {
      dim: identity,
      bold: identity,
      outbound: identity,
      inbound: identity,
      success: identity,
      warn: identity,
      error: identity,
    };
  }
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    outbound: wrap('36'), // cyan
    inbound: wrap('35'), // magenta
    success: wrap('32'), // green
    warn: wrap('33'), // yellow
    error: wrap('31'), // red
  };
}

/** True when colour output is appropriate for the given stream. */
export function shouldUseColour(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return Boolean(stream.isTTY);
}

/** Which peer a logger is speaking as, used to build the direction heading. */
export type LoggerRole = 'CLIENT' | 'SERVER' | 'MOCK' | 'BRIDGE';

/** Configuration for a protocol logger. */
export interface ProtocolLoggerOptions {
  readonly role: LoggerRole;
  readonly level?: LogLevel;
  readonly colour?: boolean;
  /** Where to write. Defaults to `process.stdout`. */
  readonly write?: (line: string) => void;
  /** Maximum characters of a raw message to print before truncating. */
  readonly maxRawChars?: number;
}

/** Prints SLTP traffic and lifecycle events in a consistent format. */
export class ProtocolLogger {
  private readonly role: LoggerRole;
  private readonly palette: Palette;
  private readonly write: (line: string) => void;
  private readonly maxRawChars: number;
  private level: LogLevel;

  constructor(options: ProtocolLoggerOptions) {
    this.role = options.role;
    this.level = options.level ?? 'summary';
    this.palette = createPalette(options.colour ?? shouldUseColour());
    this.write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
    this.maxRawChars = options.maxRawChars ?? 4_000;
  }

  /** Changes the verbosity at runtime. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Current verbosity. */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Logs one SLTP message.
   *
   * `peer` names the other end of the exchange, which together with this logger's
   * role produces headings such as `[CLIENT -> SERVER]` and `[SERVER -> CLIENT]`.
   */
  message(
    direction: 'sent' | 'received',
    message: SltpMessage,
    raw: Buffer,
    context: { readonly connectionId: string; readonly peer?: LoggerRole | string },
  ): void {
    if (this.level === 'silent') return;

    const peer = context.peer ?? (this.role === 'CLIENT' ? 'SERVER' : 'CLIENT');
    const heading =
      direction === 'sent' ? `[${this.role} -> ${peer}]` : `[${peer} -> ${this.role}]`;
    const colour = direction === 'sent' ? this.palette.outbound : this.palette.inbound;

    const requestId = getHeader(message.headers, SLTP_HEADER.requestId) ?? '-';
    const sessionId = getHeader(message.headers, SLTP_HEADER.sessionId);

    const parsed = isRequest(message)
      ? `operation=${message.operation}`
      : `status=${message.statusCode} phrase="${message.statusPhrase}"`;

    const fields = [
      `conn=${context.connectionId}`,
      `request=${requestId}`,
      ...(sessionId ? [`session=${sessionId}`] : []),
      parsed,
      `bytes=${raw.length}`,
    ].join(' ');

    this.write(`${colour(this.palette.bold(heading))} ${this.palette.dim(timestamp())} ${fields}`);

    if (this.level === 'verbose') {
      this.write(this.palette.dim(indent(truncate(formatRawBuffer(raw), this.maxRawChars))));
    }
  }

  /**
   * Logs bytes that could not be parsed as an SLTP message. Framing failures are
   * exactly the events a protocol debugger most needs to see.
   */
  frameError(
    direction: 'sent' | 'received',
    reason: string,
    detail: string,
    context: { readonly connectionId: string; readonly raw?: Buffer },
  ): void {
    if (this.level === 'silent') return;

    const heading = direction === 'sent' ? `[${this.role} !! ]` : `[ !! ${this.role}]`;
    this.write(
      `${this.palette.error(this.palette.bold(heading))} ${this.palette.dim(timestamp())} ` +
        `conn=${context.connectionId} reason=${reason} ${detail}`,
    );

    if (this.level === 'verbose' && context.raw && context.raw.length > 0) {
      this.write(
        this.palette.dim(indent(truncate(formatRawBuffer(context.raw), this.maxRawChars))),
      );
    }
  }

  /** Logs a connection lifecycle event. */
  connection(event: 'open' | 'close' | 'error', connectionId: string, detail = ''): void {
    if (this.level === 'silent') return;
    const symbol = event === 'open' ? '+' : event === 'close' ? '-' : '!';
    const colour =
      event === 'error'
        ? this.palette.error
        : event === 'open'
          ? this.palette.success
          : this.palette.dim;
    this.write(
      `${colour(`[${this.role} ${symbol}]`)} ${this.palette.dim(timestamp())} conn=${connectionId}${
        detail ? ` ${detail}` : ''
      }`,
    );
  }

  /** Logs a plain informational line. */
  info(text: string): void {
    if (this.level === 'silent') return;
    this.write(`${this.palette.dim(`[${this.role}]`)} ${text}`);
  }

  /** Logs a warning. */
  warn(text: string): void {
    if (this.level === 'silent') return;
    this.write(`${this.palette.warn(`[${this.role} warn]`)} ${text}`);
  }

  /** Logs an error. Always shown unless the logger is silent. */
  error(text: string): void {
    if (this.level === 'silent') return;
    this.write(`${this.palette.error(`[${this.role} error]`)} ${text}`);
  }

  /** Logs a test outcome, colouring by pass or fail. */
  testOutcome(name: string, passed: boolean, detail: string): void {
    if (this.level === 'silent') return;
    const badge = passed ? this.palette.success('PASS') : this.palette.error('FAIL');
    this.write(`${badge} ${this.palette.bold(name)} ${this.palette.dim(detail)}`);
  }

  /** Colours a status code by its class, for use in composed output. */
  colourStatus(code: number, text: string): string {
    const category = statusCategory(code);
    if (category === 'success') return this.palette.success(text);
    if (category === 'client-error') return this.palette.warn(text);
    return this.palette.error(text);
  }

  /** A one-line description of a message, without printing it. */
  describe(message: SltpMessage): string {
    return describeMessage(message);
  }
}

/** Current time as an ISO 8601 instant with milliseconds. */
export function timestamp(): string {
  return new Date().toISOString();
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n    … truncated, ${text.length - maxChars} more character(s)`;
}

/** A logger that discards everything, for tests and for `--quiet`. */
export function silentLogger(role: LoggerRole = 'CLIENT'): ProtocolLogger {
  return new ProtocolLogger({ role, level: 'silent', colour: false, write: () => {} });
}
