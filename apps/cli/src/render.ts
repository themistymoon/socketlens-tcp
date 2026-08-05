/**
 * Terminal rendering for command results.
 *
 * The CLI is a protocol inspection tool, so its output is organised around the
 * message rather than the command: status code, status phrase, headers, body, byte
 * counts, and — with `--raw` — the exact bytes that crossed the socket.
 */
import {
  formatBytes,
  formatDuration,
  isSuccessStatus,
  prettyPrintBody,
  renderRawMessage,
  SLTP_HEADER,
  getHeader,
  statusPhrase,
  type SltpResponse,
} from '@socketlens/protocol';
import {
  createPalette,
  shouldUseColour,
  type AssertionResult,
  type Exchange,
  type MockRule,
  type Session,
  type TestResult,
} from '@socketlens/core';

/** How much to print and whether to colour it. */
export interface RenderOptions {
  readonly raw: boolean;
  readonly colour: boolean;
}

/** Writes lines to stdout, collected in tests. */
export type Writer = (line: string) => void;

/** The default writer. */
export const stdoutWriter: Writer = (line) => process.stdout.write(`${line}\n`);

/** A renderer bound to one output stream and palette. */
export class Renderer {
  private readonly write: Writer;
  private options: RenderOptions;
  private readonly palette: ReturnType<typeof createPalette>;

  constructor(write: Writer = stdoutWriter, options?: Partial<RenderOptions>) {
    this.write = write;
    this.options = {
      raw: options?.raw ?? false,
      colour: options?.colour ?? shouldUseColour(),
    };
    this.palette = createPalette(this.options.colour);
  }

  /**
   * Turns raw byte output on or off.
   *
   * The interactive prompt holds one renderer for its whole session, so `raw on` has
   * to reach the instance rather than the constructor. Colour is deliberately not
   * settable: the palette is built once, which is why the prompt says a restart is
   * needed to change it.
   */
  setRaw(raw: boolean): void {
    this.options = { ...this.options, raw };
  }

  /** Whether exact bytes are currently being printed. */
  get raw(): boolean {
    return this.options.raw;
  }

  /** Prints a blank line. */
  blank(): void {
    this.write('');
  }

  /** Prints an unadorned line. */
  line(text = ''): void {
    this.write(text);
  }

  /** Prints a section heading. */
  heading(text: string): void {
    this.write(this.palette.bold(text));
  }

  /** Prints a de-emphasised note. */
  note(text: string): void {
    this.write(this.palette.dim(text));
  }

  /** Prints a success line. */
  success(text: string): void {
    this.write(`${this.palette.success('✔')} ${text}`);
  }

  /** Prints a warning line. */
  warn(text: string): void {
    this.write(`${this.palette.warn('!')} ${text}`);
  }

  /** Prints an error line to stdout, keeping ordering with the surrounding output. */
  error(text: string): void {
    this.write(`${this.palette.error('✖')} ${text}`);
  }

  /** Prints `key: value` pairs aligned on the colon. */
  fields(entries: readonly (readonly [string, string | number | undefined])[]): void {
    const present = entries.filter(
      (entry): entry is readonly [string, string | number] => entry[1] !== undefined,
    );
    const width = present.reduce((max, [key]) => Math.max(max, key.length), 0);
    for (const [key, value] of present) {
      this.write(`  ${this.palette.dim(`${key.padEnd(width)} :`)} ${String(value)}`);
    }
  }

  /**
   * Prints a response: start line, headers, body, and byte counts.
   *
   * The status line is coloured by category so a 4xx is visible at a glance, but the
   * numeric code and phrase are always printed literally as well, because reading
   * them is the point of the exercise.
   */
  response(exchange: Exchange): void {
    const { response } = exchange;
    const phrase = response.statusPhrase || statusPhrase(response.statusCode);
    const ok = isSuccessStatus(response.statusCode);
    const startLine = `${response.version} ${response.statusCode} ${phrase}`;

    this.write(
      `${ok ? this.palette.success(startLine) : this.palette.error(startLine)}  ${this.palette.dim(
        `(${formatBytes(exchange.rawResponse.length)}, ${formatDuration(exchange.durationMs)})`,
      )}`,
    );

    this.headers(response);
    this.body(response);

    if (this.options.raw) {
      this.blank();
      this.heading('Raw response bytes');
      this.write(indent(renderRawMessage(exchange.rawResponse.toString('utf8'))));
      this.blank();
      this.heading('Raw request bytes');
      this.write(indent(renderRawMessage(exchange.request.toString('utf8'))));
    }
  }

  /** Prints the header block of a response. */
  private headers(response: SltpResponse): void {
    if (response.headers.length === 0) return;
    for (const header of response.headers) {
      this.write(`  ${this.palette.dim(`${header.name}:`)} ${header.value}`);
    }
  }

  /** Prints the body, pretty-printed when it is JSON. */
  private body(response: SltpResponse): void {
    if (response.body.length === 0) {
      this.note('  (no body)');
      return;
    }
    const contentType = getHeader(response.headers, SLTP_HEADER.contentType);
    this.blank();
    this.write(indent(prettyPrintBody(response.body, contentType)));
    this.note(`  body: ${formatBytes(response.bodyBytes)} as UTF-8`);
  }

  /** Prints one session. */
  session(session: Session): void {
    this.fields([
      ['id', session.id],
      ['name', session.name],
      ['state', session.state],
      ['mock endpoint', `${session.mockHost}:${session.mockPort}`],
      ['created', session.createdAt],
      ['rules', session.ruleCount],
      ['results', session.resultCount],
      ['description', session.description],
    ]);
  }

  /** Prints a compact table of sessions. */
  sessionList(sessions: readonly Session[]): void {
    if (sessions.length === 0) {
      this.note('No sessions on this server.');
      return;
    }
    for (const session of sessions) {
      const marker = session.state === 'active' ? this.palette.success('●') : this.palette.dim('○');
      this.write(
        `${marker} ${session.id}  ${this.palette.bold(session.name)}  ` +
          this.palette.dim(
            `mock=${session.mockHost}:${session.mockPort} rules=${session.ruleCount} results=${session.resultCount}`,
          ),
      );
    }
  }

  /** Prints one mock rule. */
  rule(rule: MockRule): void {
    this.fields([
      ['id', rule.id],
      ['name', rule.name],
      ['enabled', String(rule.enabled)],
      ['priority', rule.priority],
      ['sequence', rule.sequence],
      ['hits', rule.hitCount],
      [
        'match operation',
        rule.match.operation === '*' ? '* (any operation)' : rule.match.operation,
      ],
      ['match headers', formatHeaderMatch(rule.match.headers)],
      [
        'match body',
        rule.match.body ? `${rule.match.body.mode}: ${rule.match.body.value}` : undefined,
      ],
      ['response', `${rule.response.statusCode} ${rule.response.statusPhrase}`],
      ['response body', rule.response.body],
      [
        'response delay',
        rule.response.delayMs !== undefined ? `${rule.response.delayMs} ms` : undefined,
      ],
      [
        'response fragments',
        rule.response.fragment ? rule.response.fragment.sizes.join(' + ') : undefined,
      ],
      [
        'disconnect after',
        rule.response.disconnectAfterBytes !== undefined
          ? `${rule.response.disconnectAfterBytes} bytes`
          : undefined,
      ],
    ]);
  }

  /** Prints rules in evaluation order. */
  ruleList(rules: readonly MockRule[]): void {
    if (rules.length === 0) {
      this.note('No rules in this session. Add one with `socketlens rule add`.');
      return;
    }
    for (const [index, rule] of rules.entries()) {
      const state = rule.enabled ? this.palette.success('on ') : this.palette.dim('off');
      this.write(
        `${String(index + 1).padStart(2)}. ${state} ${this.palette.bold(rule.name)} ` +
          this.palette.dim(
            `priority=${rule.priority} match=${rule.match.operation} → ` +
              `${rule.response.statusCode} ${rule.response.statusPhrase} (${rule.id})`,
          ),
      );
    }
    this.note('Evaluation order: priority descending, then insertion order ascending.');
  }

  /**
   * Prints a test result: verdict, assertions, and the wire segments.
   *
   * The segment list is what demonstrates the project's central claim — several
   * writes may arrive as one read, and one write may arrive as several.
   */
  result(result: TestResult): void {
    const verdict = result.passed
      ? this.palette.success('PASSED')
      : this.palette.error(result.outcome.toUpperCase());
    this.write(
      `${verdict}  ${this.palette.bold(result.scenarioName)}  ${this.palette.dim(result.id)}`,
    );

    this.fields([
      ['outcome', result.outcome],
      ['duration', formatDuration(result.durationMs)],
      ['started', result.startedAt],
      [
        'status',
        result.response
          ? `${result.response.statusCode} ${result.response.statusPhrase}`
          : undefined,
      ],
      ['matched rule', result.matchedRuleId],
      ['sent segments', result.segments.filter((s) => s.direction === 'sent').length],
      ['received segments', result.receivedSegmentCount],
      ['responses framed', result.responseCount],
      ['error', result.error],
    ]);

    if (result.assertions.length > 0) {
      this.blank();
      this.heading('Expected versus actual');
      this.assertions(result.assertions);
    }

    if (result.segments.length > 0) {
      this.blank();
      this.heading('TCP segments');
      for (const segment of result.segments) {
        const arrow =
          segment.direction === 'sent' ? this.palette.outbound('→') : this.palette.inbound('←');
        this.write(
          `  ${arrow} ${this.palette.dim(`+${Math.round(segment.atMs)}ms`)} ${formatBytes(segment.bytes)}  ` +
            this.palette.dim(truncateInline(segment.data)),
        );
      }
      if (result.responseCount > 1) {
        this.note(
          `  ${result.responseCount} SLTP responses were framed from ${result.receivedSegmentCount} TCP segment(s): ` +
            'message boundaries are recovered by SLTP, not by TCP.',
        );
      }
    }

    if (this.options.raw) {
      this.blank();
      this.heading('Raw bytes sent');
      this.write(indent(renderRawMessage(result.rawSent)));
      this.blank();
      this.heading('Raw bytes received');
      this.write(
        result.rawReceived.length > 0
          ? indent(renderRawMessage(result.rawReceived))
          : '  (nothing received)',
      );
    }
  }

  /** Prints each assertion with its expected and actual values. */
  assertions(assertions: readonly AssertionResult[]): void {
    for (const assertion of assertions) {
      const mark = assertion.passed ? this.palette.success('✔') : this.palette.error('✖');
      this.write(`  ${mark} ${assertion.field}`);
      if (!assertion.passed) {
        this.write(`      ${this.palette.dim('expected:')} ${assertion.expected}`);
        this.write(`      ${this.palette.dim('actual  :')} ${assertion.actual}`);
        if (assertion.message) this.write(`      ${this.palette.dim(assertion.message)}`);
      }
    }
  }

  /** Prints a list of result summaries. */
  resultList(
    results: readonly {
      id: string;
      scenarioName: string;
      outcome: string;
      passed: boolean;
      durationMs: number;
      statusCode?: number;
      statusPhrase?: string;
    }[],
  ): void {
    if (results.length === 0) {
      this.note('No results in this session yet. Run a test with `socketlens run`.');
      return;
    }
    for (const result of results) {
      const mark = result.passed ? this.palette.success('PASS') : this.palette.error('FAIL');
      this.write(
        `${mark} ${this.palette.bold(result.scenarioName.padEnd(28))} ` +
          this.palette.dim(
            `${result.statusCode ?? '---'} ${result.statusPhrase ?? result.outcome} ` +
              `${formatDuration(result.durationMs)} ${result.id}`,
          ),
      );
    }
  }

  /** Prints a JSON value verbatim, for `--json`. */
  json(value: unknown): void {
    this.write(JSON.stringify(value, null, 2));
  }
}

/** Indents a multi-line block by two spaces. */
function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/** Renders a segment's payload on one line, escaped and clipped. */
function truncateInline(data: string, maxChars = 60): string {
  const escaped = data.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return escaped.length <= maxChars ? escaped : `${escaped.slice(0, maxChars)}…`;
}

/** Renders a rule's header matcher, or `undefined` when it matches any headers. */
function formatHeaderMatch(
  headers: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const entries = Object.entries(headers ?? {});
  if (entries.length === 0) return undefined;
  return entries.map(([name, value]) => `${name}: ${value}`).join(', ');
}
