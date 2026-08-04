/**
 * Incremental SLTP decoder for a TCP byte stream.
 *
 * TCP delivers a reliable, ordered stream of bytes. It does **not** preserve the
 * boundaries of application messages. One `socket.write()` may arrive as several
 * `data` events, several writes may arrive as one `data` event, and a `data` event
 * may end in the middle of a header, in the middle of a body, or even in the middle
 * of a single multi-byte UTF-8 character.
 *
 * This decoder therefore never assumes anything about chunk boundaries. It appends
 * every chunk to a per-connection Buffer and repeatedly attempts to extract complete
 * messages, keeping any trailing partial bytes for the next chunk. All framing work
 * is done on bytes; UTF-8 decoding happens only once a complete body is present,
 * which is what makes a split multi-byte character harmless.
 *
 * Each connection MUST own exactly one decoder instance. Sharing one between
 * connections would interleave two byte streams and corrupt both.
 */
import {
  CR_BYTE,
  LF_BYTE,
  DEFAULT_LIMITS,
  HEADER_DELIMITER_LENGTH,
  SLTP_VERSION_TOKEN,
  type SltpLimits,
} from './constants.js';
import { frameError, SLTP_REASON, type SltpFrameError } from './errors.js';
import {
  isValidHeaderName,
  isValidHeaderValue,
  SLTP_HEADER,
  type SltpHeaderField,
} from './headers.js';
import { OPERATION_PATTERN } from './operations.js';
import type { SltpMessage, SltpMessageKind } from './types.js';

/** A successfully framed and parsed message, with the bytes it occupied. */
export interface SltpDecodedMessage {
  readonly type: 'message';
  /** The parsed message. */
  readonly message: SltpMessage;
  /** Exact wire bytes of this message, header block and body together. */
  readonly raw: Buffer;
  /** Total byte length of the message on the wire. */
  readonly totalBytes: number;
}

/** A framing or parse failure. */
export interface SltpDecodeFailure {
  readonly type: 'error';
  readonly error: SltpFrameError;
  /** The bytes available when the failure was detected, for diagnostics. */
  readonly raw: Buffer;
}

/** One decoder output event. */
export type SltpDecodeEvent = SltpDecodedMessage | SltpDecodeFailure;

/** Decoder configuration. */
export interface SltpDecoderOptions {
  /**
   * Which message shape to expect. A server decodes requests, a client decodes
   * responses. `any` accepts either and is used by inspection tooling.
   */
  readonly expect?: SltpMessageKind | 'any';
  /** Size limits. Defaults to {@link DEFAULT_LIMITS}. */
  readonly limits?: Partial<SltpLimits>;
}

/**
 * Headers that may appear at most once. A duplicate of any of these makes the
 * framing or the routing of the message ambiguous, so it is rejected outright
 * rather than resolved by a precedence rule.
 */
const SINGLE_VALUED_HEADERS = new Set<string>([
  SLTP_HEADER.contentLength.toLowerCase(),
  SLTP_HEADER.contentType.toLowerCase(),
  SLTP_HEADER.requestId.toLowerCase(),
  SLTP_HEADER.sessionId.toLowerCase(),
]);

/** `\r\n\r\n`, the four-byte header-block terminator. */
const DELIMITER = Buffer.from([CR_BYTE, LF_BYTE, CR_BYTE, LF_BYTE]);

/** Content-Length must be an unsigned decimal integer with no sign and no padding. */
const CONTENT_LENGTH_PATTERN = /^\d+$/;

/** A response start line: `SLTP/1.0 <code> <PHRASE>`. */
const STATUS_PHRASE_PATTERN = /^[\x20-\x7e]+$/;

export class SltpDecoder {
  /** Bytes received but not yet consumed by a complete message. */
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Byte offset from which the next delimiter search may safely start. Bytes before
   * it have already been scanned and cannot begin a delimiter, so a long header
   * block arriving one byte at a time still costs linear total work rather than
   * quadratic.
   */
  private searchOffset = 0;

  /** Once a fatal framing error occurs the stream is unsynchronisable. */
  private poisoned = false;

  private readonly expect: SltpMessageKind | 'any';
  private readonly limits: SltpLimits;

  constructor(options: SltpDecoderOptions = {}) {
    this.expect = options.expect ?? 'any';
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  /** Number of buffered bytes not yet consumed. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /** True when a fatal framing error has stopped this decoder. */
  get isPoisoned(): boolean {
    return this.poisoned;
  }

  /** Copy of the buffered bytes, for diagnostics and tests. */
  peek(): Buffer {
    return Buffer.from(this.buffer);
  }

  /** Discards all buffered bytes and clears the poisoned flag. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.searchOffset = 0;
    this.poisoned = false;
  }

  /**
   * Feeds one chunk of received bytes and returns every event it completes.
   *
   * A chunk may complete zero messages (partial data), exactly one, or many
   * (coalesced writes). Returning an array rather than a single message is what
   * makes coalescing safe.
   *
   * Once a fatal framing error has been reported the decoder is stopped and further
   * bytes are ignored, because the stream can no longer be resynchronised. The
   * caller is expected to have closed the connection at that point.
   */
  push(chunk: Buffer | Uint8Array | string): SltpDecodeEvent[] {
    if (this.poisoned) return [];
    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk);

    this.buffer =
      this.buffer.length === 0 ? Buffer.from(incoming) : Buffer.concat([this.buffer, incoming]);

    return this.drain();
  }

  /**
   * Signals that the peer closed the connection or ended the stream.
   *
   * Leftover bytes mean the peer stopped mid-message: a truncated frame. Reporting
   * it explicitly is what turns a silent half-message into a visible protocol error.
   */
  end(): SltpDecodeEvent[] {
    if (this.buffer.length === 0 || this.poisoned) return [];
    const leftover = this.buffer;
    this.buffer = Buffer.alloc(0);
    this.searchOffset = 0;
    this.poisoned = true;
    return [
      {
        type: 'error',
        error: frameError(
          SLTP_REASON.truncatedMessage,
          `Connection ended with ${leftover.length} byte(s) of an incomplete SLTP message in the receive buffer.`,
          { bufferedBytes: leftover.length },
        ),
        raw: leftover,
      },
    ];
  }

  // ─── framing loop ──────────────────────────────────────────────────────────

  /** Extracts as many complete messages as the buffer currently holds. */
  private drain(): SltpDecodeEvent[] {
    const events: SltpDecodeEvent[] = [];

    for (;;) {
      // 1. Locate the end of the header block. Resume from searchOffset so bytes
      //    already scanned are not scanned again, but step back three bytes so a
      //    delimiter straddling the previous chunk boundary is still found.
      const from = Math.max(0, this.searchOffset - (HEADER_DELIMITER_LENGTH - 1));
      const delimiterAt = this.buffer.indexOf(DELIMITER, from);

      if (delimiterAt === -1) {
        // No complete header block yet. Enforce limits so a peer that never sends
        // a delimiter cannot grow the buffer without bound.
        if (this.buffer.length > this.limits.maxHeaderBlockBytes) {
          events.push(
            this.fail(
              SLTP_REASON.headerBlockTooLarge,
              `Header block exceeded ${this.limits.maxHeaderBlockBytes} bytes without a CRLFCRLF delimiter.`,
              { limit: this.limits.maxHeaderBlockBytes, received: this.buffer.length },
            ),
          );
          break;
        }
        // Everything buffered has now been scanned.
        this.searchOffset = this.buffer.length;
        break;
      }

      const headerBlock = this.buffer.subarray(0, delimiterAt);

      if (headerBlock.length > this.limits.maxHeaderBlockBytes) {
        events.push(
          this.fail(
            SLTP_REASON.headerBlockTooLarge,
            `Header block is ${headerBlock.length} bytes, exceeding the ${this.limits.maxHeaderBlockBytes} byte limit.`,
            { limit: this.limits.maxHeaderBlockBytes, received: headerBlock.length },
          ),
        );
        break;
      }

      // 2. Parse the start line and headers.
      const parsed = this.parseHeaderBlock(headerBlock);
      if ('error' in parsed) {
        events.push(this.fail(parsed.error.reason, parsed.error.message, parsed.error.detail));
        break;
      }

      // 3. Resolve the framed body length from Content-Length.
      const lengthResult = this.resolveContentLength(parsed.headers);
      if ('error' in lengthResult) {
        events.push(
          this.fail(
            lengthResult.error.reason,
            lengthResult.error.message,
            lengthResult.error.detail,
          ),
        );
        break;
      }
      const bodyBytes = lengthResult.value;

      const bodyStart = delimiterAt + HEADER_DELIMITER_LENGTH;
      const totalBytes = bodyStart + bodyBytes;

      if (totalBytes > this.limits.maxMessageBytes) {
        events.push(
          this.fail(
            SLTP_REASON.messageTooLarge,
            `Message would be ${totalBytes} bytes, exceeding the ${this.limits.maxMessageBytes} byte limit.`,
            { limit: this.limits.maxMessageBytes, declared: totalBytes },
          ),
        );
        break;
      }

      // 4. Wait until the whole body has arrived. Partial bodies stay buffered.
      if (this.buffer.length < totalBytes) {
        // The header block is complete, so no further delimiter search is useful
        // until the body has been consumed; park the search cursor at the delimiter.
        this.searchOffset = delimiterAt;
        break;
      }

      // 5. A complete message is present. Decode the body only now, so a multi-byte
      //    UTF-8 character split across TCP segments is reassembled before decoding.
      const bodyBuf = this.buffer.subarray(bodyStart, totalBytes);
      const raw = Buffer.from(this.buffer.subarray(0, totalBytes));

      const message = this.buildMessage(parsed, bodyBuf.toString('utf8'), bodyBytes);
      if ('error' in message) {
        events.push(this.fail(message.error.reason, message.error.message, message.error.detail));
        break;
      }

      // 6. Consume exactly the bytes of this message and continue: the remainder may
      //    already hold further complete messages, or the head of the next one.
      this.buffer = Buffer.from(this.buffer.subarray(totalBytes));
      this.searchOffset = 0;

      events.push({ type: 'message', message: message.value, raw, totalBytes });

      if (this.buffer.length === 0) break;
    }

    return events;
  }

  /** Records a fatal or recoverable failure and poisons the stream when fatal. */
  private fail(
    reason: SltpFrameError['reason'],
    message: string,
    detail?: Record<string, string | number>,
  ): SltpDecodeFailure {
    const error = frameError(reason, message, detail);
    const raw = Buffer.from(this.buffer);
    if (error.fatal) {
      this.poisoned = true;
      this.buffer = Buffer.alloc(0);
      this.searchOffset = 0;
    }
    return { type: 'error', error, raw };
  }

  // ─── header block parsing ──────────────────────────────────────────────────

  private parseHeaderBlock(block: Buffer): ParsedHeaderBlock | ParseFault {
    const text = block.toString('utf8');
    const lines = text.split('\r\n');
    const startLine = lines[0] ?? '';

    if (startLine.length === 0) {
      return {
        error: {
          reason: SLTP_REASON.emptyStartLine,
          message: 'Message begins with an empty start line.',
        },
      };
    }

    if (Buffer.byteLength(startLine, 'utf8') > this.limits.maxStartLineBytes) {
      return {
        error: {
          reason: SLTP_REASON.startLineTooLarge,
          message: `Start line is ${Buffer.byteLength(startLine, 'utf8')} bytes, exceeding the ${this.limits.maxStartLineBytes} byte limit.`,
          detail: { limit: this.limits.maxStartLineBytes },
        },
      };
    }

    // A bare LF or bare CR anywhere in the header block is a framing error: it means
    // the sender did not use CRLF consistently, so line boundaries are ambiguous.
    for (const line of lines) {
      if (line.includes('\n')) {
        return {
          error: {
            reason: SLTP_REASON.bareLineFeed,
            message: 'Header block contains a bare LF; SLTP requires CRLF line endings.',
          },
        };
      }
      if (line.includes('\r')) {
        return {
          error: {
            reason: SLTP_REASON.bareCarriageReturn,
            message: 'Header block contains a bare CR; SLTP requires CRLF line endings.',
          },
        };
      }
    }

    const startLineResult = this.parseStartLine(startLine);
    if ('error' in startLineResult) return startLineResult;

    const headerLines = lines.slice(1);
    if (headerLines.length > this.limits.maxHeaderCount) {
      return {
        error: {
          reason: SLTP_REASON.tooManyHeaders,
          message: `Message carries ${headerLines.length} headers, exceeding the limit of ${this.limits.maxHeaderCount}.`,
          detail: { limit: this.limits.maxHeaderCount, received: headerLines.length },
        },
      };
    }

    const headers: SltpHeaderField[] = [];
    const seen = new Set<string>();

    for (const line of headerLines) {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        return {
          error: {
            reason: SLTP_REASON.obsoleteLineFolding,
            message: `Obsolete line folding is not permitted in SLTP: ${JSON.stringify(line)}`,
          },
        };
      }

      const colonAt = line.indexOf(':');
      if (colonAt <= 0) {
        return {
          error: {
            reason: SLTP_REASON.malformedHeaderLine,
            message: `Header line has no name/value separator: ${JSON.stringify(line)}`,
          },
        };
      }

      const name = line.slice(0, colonAt);
      // Optional whitespace after the colon is stripped; SLTP values never rely on it.
      const value = line.slice(colonAt + 1).trim();

      if (!isValidHeaderName(name)) {
        return {
          error: {
            reason: SLTP_REASON.invalidHeaderName,
            message: `Invalid header name: ${JSON.stringify(name)}`,
            detail: { header: name },
          },
        };
      }
      if (!isValidHeaderValue(value)) {
        return {
          error: {
            reason: SLTP_REASON.invalidHeaderValue,
            message: `Header ${name} has a value containing characters outside printable US-ASCII.`,
            detail: { header: name },
          },
        };
      }

      const lower = name.toLowerCase();
      if (SINGLE_VALUED_HEADERS.has(lower) && seen.has(lower)) {
        return {
          error: {
            reason: SLTP_REASON.duplicateHeader,
            message: `Header ${name} appears more than once but may appear at most once.`,
            detail: { header: name },
          },
        };
      }
      seen.add(lower);
      headers.push({ name, value });
    }

    return { ...startLineResult, headers };
  }

  private parseStartLine(startLine: string): StartLineParts | ParseFault {
    const firstSpace = startLine.indexOf(' ');
    if (firstSpace === -1) {
      return {
        error: {
          reason: SLTP_REASON.malformedStartLine,
          message: `Start line has no space separator: ${JSON.stringify(startLine)}`,
        },
      };
    }

    const version = startLine.slice(0, firstSpace);
    const remainder = startLine.slice(firstSpace + 1);

    if (version !== SLTP_VERSION_TOKEN) {
      return {
        error: {
          reason: SLTP_REASON.unsupportedProtocolVersion,
          message: `Unsupported protocol version token: ${JSON.stringify(version)}. This server implements ${SLTP_VERSION_TOKEN}.`,
          detail: { received: version },
        },
      };
    }

    if (remainder.length === 0) {
      return {
        error: {
          reason: SLTP_REASON.malformedStartLine,
          message: 'Start line carries a version but no operation or status code.',
        },
      };
    }

    // A response start line begins with three digits; anything else is an operation.
    const secondSpace = remainder.indexOf(' ');
    const firstToken = secondSpace === -1 ? remainder : remainder.slice(0, secondSpace);

    if (/^\d/.test(firstToken)) {
      return this.parseStatusStartLine(
        firstToken,
        secondSpace === -1 ? '' : remainder.slice(secondSpace + 1),
        version,
      );
    }

    if (this.expect === 'response') {
      return {
        error: {
          reason: SLTP_REASON.unexpectedMessageKind,
          message: `Expected an SLTP response but received a request start line: ${JSON.stringify(startLine)}`,
        },
      };
    }

    if (secondSpace !== -1) {
      return {
        error: {
          reason: SLTP_REASON.malformedStartLine,
          message: `Request start line carries unexpected trailing content: ${JSON.stringify(startLine)}`,
        },
      };
    }

    if (!OPERATION_PATTERN.test(firstToken)) {
      return {
        error: {
          reason: SLTP_REASON.invalidOperationToken,
          message: `Invalid operation token: ${JSON.stringify(firstToken)}. Operations are uppercase letters, digits, and underscores.`,
          detail: { operation: firstToken },
        },
      };
    }

    return { kind: 'request', version, operation: firstToken };
  }

  private parseStatusStartLine(
    codeToken: string,
    phrase: string,
    version: string,
  ):
    | StartLineParts
    | {
        error: {
          reason: SltpFrameError['reason'];
          message: string;
          detail?: Record<string, string | number>;
        };
      } {
    if (this.expect === 'request') {
      return {
        error: {
          reason: SLTP_REASON.unexpectedMessageKind,
          message: `Expected an SLTP request but received a response start line with status ${codeToken}.`,
        },
      };
    }

    if (!/^\d{3}$/.test(codeToken)) {
      return {
        error: {
          reason: SLTP_REASON.invalidStatusCode,
          message: `Status code must be exactly three digits: ${JSON.stringify(codeToken)}`,
          detail: { received: codeToken },
        },
      };
    }

    const statusCode = Number.parseInt(codeToken, 10);
    if (statusCode < 100 || statusCode > 599) {
      return {
        error: {
          reason: SLTP_REASON.invalidStatusCode,
          message: `Status code ${statusCode} is outside the permitted range 100-599.`,
          detail: { received: statusCode },
        },
      };
    }

    if (phrase.length === 0) {
      return {
        error: {
          reason: SLTP_REASON.missingStatusPhrase,
          message: `Response start line for status ${statusCode} has no reason phrase.`,
          detail: { statusCode },
        },
      };
    }

    if (!STATUS_PHRASE_PATTERN.test(phrase)) {
      return {
        error: {
          reason: SLTP_REASON.invalidStatusPhrase,
          message: `Reason phrase contains characters outside printable US-ASCII: ${JSON.stringify(phrase)}`,
          detail: { statusCode },
        },
      };
    }

    return { kind: 'response', version, statusCode, statusPhrase: phrase };
  }

  // ─── body framing ──────────────────────────────────────────────────────────

  private resolveContentLength(
    headers: readonly SltpHeaderField[],
  ): { value: number } | ParseFault {
    let raw: string | undefined;
    for (const field of headers) {
      if (field.name.toLowerCase() === SLTP_HEADER.contentLength.toLowerCase()) {
        raw = field.value;
        break;
      }
    }

    // No Content-Length means no body. SLTP has no chunked transfer mode, so the
    // absence of the header unambiguously frames a zero-length body.
    if (raw === undefined) return { value: 0 };

    const trimmed = raw.trim();

    if (trimmed.startsWith('-')) {
      return {
        error: {
          reason: SLTP_REASON.negativeContentLength,
          message: `Content-Length must not be negative: ${JSON.stringify(trimmed)}`,
          detail: { received: trimmed },
        },
      };
    }

    if (!CONTENT_LENGTH_PATTERN.test(trimmed)) {
      return {
        error: {
          reason: SLTP_REASON.invalidContentLength,
          message: `Content-Length must be an unsigned decimal integer: ${JSON.stringify(trimmed)}`,
          detail: { received: trimmed },
        },
      };
    }

    const value = Number.parseInt(trimmed, 10);

    if (!Number.isSafeInteger(value)) {
      return {
        error: {
          reason: SLTP_REASON.contentLengthTooLarge,
          message: `Content-Length ${trimmed} is not a safe integer.`,
          detail: { received: trimmed },
        },
      };
    }

    if (value > this.limits.maxMessageBytes) {
      return {
        error: {
          reason: SLTP_REASON.contentLengthTooLarge,
          message: `Content-Length ${value} exceeds the maximum message size of ${this.limits.maxMessageBytes} bytes.`,
          detail: { limit: this.limits.maxMessageBytes, declared: value },
        },
      };
    }

    return { value };
  }

  private buildMessage(
    parsed: ParsedHeaderBlock,
    body: string,
    bodyBytes: number,
  ):
    | { value: SltpMessage }
    | {
        error: {
          reason: SltpFrameError['reason'];
          message: string;
          detail?: Record<string, string | number>;
        };
      } {
    if (parsed.kind === 'request') {
      return {
        value: {
          kind: 'request',
          version: parsed.version,
          operation: parsed.operation,
          headers: parsed.headers,
          body,
          bodyBytes,
        },
      };
    }
    return {
      value: {
        kind: 'response',
        version: parsed.version,
        statusCode: parsed.statusCode,
        statusPhrase: parsed.statusPhrase,
        headers: parsed.headers,
        body,
        bodyBytes,
      },
    };
  }
}

/**
 * Returns the first failure in a decode event list, or `undefined` if there is none.
 *
 * Mostly used with {@link SltpDecoder.end}, where the only possible event is a
 * truncated-message error, so a caller wanting "did the peer stop mid-message?" can
 * ask directly instead of looping.
 */
export function firstDecodeFailure(
  events: readonly SltpDecodeEvent[],
): SltpDecodeFailure | undefined {
  for (const event of events) {
    if (event.type === 'error') return event;
  }
  return undefined;
}

/** Returns only the successfully framed messages from a decode event list. */
export function decodedMessages(events: readonly SltpDecodeEvent[]): SltpDecodedMessage[] {
  return events.filter((event): event is SltpDecodedMessage => event.type === 'message');
}

// ─── internal parse shapes ───────────────────────────────────────────────────

type StartLineParts =
  | { kind: 'request'; version: string; operation: string }
  | { kind: 'response'; version: string; statusCode: number; statusPhrase: string };

type ParsedHeaderBlock = StartLineParts & { headers: SltpHeaderField[] };

/**
 * The failure branch returned by the internal parse helpers.
 *
 * These helpers do not raise and do not mutate decoder state; they describe the
 * fault and leave it to {@link SltpDecoder} to decide whether it is recoverable or
 * fatal, and to build the wire-level {@link SltpFrameError}.
 */
type ParseFault = {
  error: {
    reason: SltpFrameError['reason'];
    message: string;
    detail?: Record<string, string | number>;
  };
};

/**
 * Decodes a buffer that is expected to contain exactly one complete SLTP message.
 *
 * This is a convenience for tests and for tools that already hold a whole message.
 * Never use it on a live socket: it discards the framing state that a byte stream
 * requires. Use {@link SltpDecoder} there.
 */
export function decodeSingleMessage(
  input: Buffer | string,
  options: SltpDecoderOptions = {},
): SltpDecodeEvent {
  const decoder = new SltpDecoder(options);
  const events = decoder.push(input);
  if (events.length === 0) {
    return {
      type: 'error',
      error: frameError(
        SLTP_REASON.truncatedMessage,
        'Input does not contain a complete SLTP message.',
      ),
      raw: Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8'),
    };
  }
  return events[0]!;
}
