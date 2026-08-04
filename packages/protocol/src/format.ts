/**
 * Buffer-aware formatting helpers.
 *
 * These complement `display.ts`, which is browser-safe. Anything that needs to look
 * at raw bytes — hex dumps, byte-accurate views of a captured frame, projecting a
 * decoded message plus its wire bytes into a JSON-safe view — lives here.
 */
import { getHeader, SLTP_HEADER } from './headers.js';
import { renderRawMessage, escapeCrlfInline } from './display.js';
import type { SltpMessage, SltpMessageView } from './types.js';

/**
 * Projects a decoded message and its wire bytes into the JSON-safe view the bridge
 * sends to the browser. No protocol logic is duplicated: the parsed fields come
 * straight from the decoder.
 */
export function toMessageView(message: SltpMessage, raw: Buffer): SltpMessageView {
  const base = {
    version: message.version,
    headers: message.headers,
    body: message.body,
    bodyBytes: message.bodyBytes,
    raw: raw.toString('utf8'),
    totalBytes: raw.length,
  };
  if (message.kind === 'request') {
    return { kind: 'request', operation: message.operation, ...base };
  }
  return {
    kind: 'response',
    statusCode: message.statusCode,
    statusPhrase: message.statusPhrase,
    ...base,
  };
}

/** Renders a captured frame with CRLF made visible, for terminal output. */
export function formatRawBuffer(raw: Buffer): string {
  return renderRawMessage(raw.toString('utf8'));
}

/** Renders a captured frame on one line, for compact single-line logs. */
export function formatRawInline(raw: Buffer): string {
  return escapeCrlfInline(raw.toString('utf8'));
}

/**
 * Classic `offset  hex  ascii` dump.
 *
 * Used when a byte-level view matters: proving that a fragment boundary fell inside a
 * multi-byte UTF-8 character, or showing exactly which bytes a truncated frame carried.
 */
export function hexDump(raw: Buffer, bytesPerLine = 16, maxBytes = 512): string {
  const limit = Math.min(raw.length, maxBytes);
  const lines: string[] = [];

  for (let offset = 0; offset < limit; offset += bytesPerLine) {
    const slice = raw.subarray(offset, Math.min(offset + bytesPerLine, limit));
    const hex: string[] = [];
    let ascii = '';

    for (const byte of slice) {
      hex.push(byte.toString(16).padStart(2, '0'));
      ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
    }

    const hexColumn = hex.join(' ').padEnd(bytesPerLine * 3 - 1, ' ');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hexColumn}  |${ascii}|`);
  }

  if (raw.length > limit) {
    lines.push(`… ${raw.length - limit} more byte(s) not shown`);
  }

  return lines.join('\n');
}

/** The reconstructed start line of a decoded message. */
export function messageStartLine(message: SltpMessage): string {
  if (message.kind === 'request') return `${message.version} ${message.operation}`;
  return `${message.version} ${message.statusCode} ${message.statusPhrase}`;
}

/** A compact description of a decoded message, for log headings. */
export function describeMessage(message: SltpMessage): string {
  const requestId = getHeader(message.headers, SLTP_HEADER.requestId);
  const sessionId = getHeader(message.headers, SLTP_HEADER.sessionId);
  const parts = [messageStartLine(message)];
  if (requestId) parts.push(`request=${requestId}`);
  if (sessionId) parts.push(`session=${sessionId}`);
  parts.push(`body=${message.bodyBytes}B`);
  return parts.join(' ');
}
