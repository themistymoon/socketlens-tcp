/**
 * Presentation helpers for SLTP traffic.
 *
 * Everything here works on strings only and uses no Node.js API, so the browser
 * interface imports it directly through `@socketlens/protocol/browser`. That is what
 * lets the graphical client render captured protocol traffic without shipping a
 * second parser or a Buffer polyfill.
 */
import { getHeader, SLTP_HEADER, type SltpHeaderList } from './headers.js';
import { statusPhrase } from './status.js';
import type { SltpMessageView } from './types.js';

/** UTF-8 byte length of a string, computed without Buffer. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Renders CR and LF as visible escapes so that a captured message can be shown
 * without the terminal or the browser collapsing its framing.
 *
 * `\r\n` becomes a literal `\r\n` followed by a real newline, which keeps the message
 * readable line by line while still proving that CRLF was used on the wire.
 */
export function renderRawMessage(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch === '\r' && raw[i + 1] === '\n') {
      // A proper CRLF: show the escape, then break the display line.
      out += '\\r\\n\n';
      i += 1;
    } else if (ch === '\r') {
      // A bare CR is a protocol violation; make it visible without breaking the line.
      out += '\\r';
    } else if (ch === '\n') {
      // A bare LF is a protocol violation; likewise kept inline.
      out += '\\n';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Renders CR and LF as inline escapes on a single line, for compact log lines. */
export function escapeCrlfInline(raw: string): string {
  return raw.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** Truncates a string for display, appending an explicit byte count when cut. */
export function truncateForDisplay(value: string, maxChars = 2_000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n… truncated, ${value.length - maxChars} more character(s)`;
}

/** The start line of a message view, reconstructed from its parsed parts. */
export function startLineOf(message: SltpMessageView): string {
  if (message.kind === 'request') {
    return `${message.version} ${message.operation ?? ''}`.trimEnd();
  }
  const code = message.statusCode ?? 0;
  const phrase = message.statusPhrase ?? statusPhrase(code);
  return `${message.version} ${code} ${phrase}`;
}

/** A one-line summary suitable for a timeline row. */
export function summariseMessage(message: SltpMessageView): string {
  const size = `${message.totalBytes}B`;
  if (message.kind === 'request') {
    return `${message.operation ?? 'UNKNOWN'} (${size})`;
  }
  return `${message.statusCode ?? '???'} ${message.statusPhrase ?? ''} (${size})`.replace(
    /\s+\(/,
    ' (',
  );
}

/** Extracts the correlation identifier from a message view, when present. */
export function requestIdOf(headers: SltpHeaderList): string | undefined {
  return getHeader(headers, SLTP_HEADER.requestId);
}

/** Extracts the session scope from a message view, when present. */
export function sessionIdOf(headers: SltpHeaderList): string | undefined {
  return getHeader(headers, SLTP_HEADER.sessionId);
}

/** Formats a byte count with a thousands separator and unit. */
export function formatBytes(count: number): string {
  return `${count.toLocaleString('en-US')} byte${count === 1 ? '' : 's'}`;
}

/** Formats a duration in milliseconds with sensible precision. */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
}

/**
 * Pretty-prints a JSON body for display, leaving non-JSON bodies untouched.
 * Never throws: an unparseable body is returned verbatim.
 */
export function prettyPrintBody(body: string, contentType?: string): string {
  if (body.length === 0) return '';
  const looksJson =
    (contentType ?? '').toLowerCase().includes('json') ||
    body.trimStart().startsWith('{') ||
    body.trimStart().startsWith('[');
  if (!looksJson) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
