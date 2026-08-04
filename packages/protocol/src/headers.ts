/**
 * SLTP header field names, grammar, and order-preserving accessors.
 *
 * SLTP header names are case-insensitive on the wire but are emitted in a canonical
 * casing so that captured traffic is easy to read. Values are restricted to printable
 * US-ASCII plus horizontal tab; anything that needs Unicode belongs in the body,
 * which is always UTF-8.
 */

/** Header field names defined by SLTP/1.0. */
export const SLTP_HEADER = {
  /** Client-generated correlation identifier. REQUIRED on every request. */
  requestId: 'Request-ID',
  /** Session scope. REQUIRED for session-scoped operations. */
  sessionId: 'Session-ID',
  /** UTF-8 byte length of the body. REQUIRED whenever a body is present. */
  contentLength: 'Content-Length',
  /** Media type of the body. */
  contentType: 'Content-Type',
  /** ISO 8601 instant at which the sender serialised the message. */
  timestamp: 'Timestamp',
  /** `close` asks the peer to end the connection after this exchange. */
  connection: 'Connection',
  /** Milliseconds a mock endpoint waits before replying. Used to provoke timeouts. */
  responseDelay: 'Response-Delay',
  /** Identifier of the mock rule that produced a response. */
  matchedRuleId: 'Matched-Rule-ID',
  /** Identifier of a stored test result. */
  resultId: 'Result-ID',
  /** Machine-readable reason code accompanying an error status. */
  reason: 'Reason',
  /** Product token of the responding server. */
  server: 'Server',
  /** Milliseconds to wait before retrying, sent with 429 TOO MANY REQUESTS. */
  retryAfter: 'Retry-After',
} as const;

/** Union of the header names defined by SLTP/1.0. */
export type SltpHeaderName = (typeof SLTP_HEADER)[keyof typeof SLTP_HEADER];

/** One header field, preserved in the order it appeared on the wire. */
export interface SltpHeaderField {
  readonly name: string;
  readonly value: string;
}

/** An ordered list of header fields. */
export type SltpHeaderList = readonly SltpHeaderField[];

/** A header name is a non-empty token of letters, digits, hyphen, and underscore. */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A header value is printable US-ASCII (0x20-0x7E) and horizontal tab, or empty. */
export const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e]*$/;

const CANONICAL_HEADER_NAMES = new Map<string, string>(
  Object.values(SLTP_HEADER).map((name) => [name.toLowerCase(), name]),
);

/** True when `name` is a syntactically valid SLTP header name. */
export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME_PATTERN.test(name);
}

/** True when `value` is a syntactically valid SLTP header value. */
export function isValidHeaderValue(value: string): boolean {
  return HEADER_VALUE_PATTERN.test(value);
}

/**
 * Returns the preferred output casing for a header name. Known SLTP headers use
 * their registered spelling; extension headers are title-cased per hyphen segment
 * so `x-trace-id` becomes `X-Trace-Id`.
 */
export function canonicalHeaderName(name: string): string {
  const known = CANONICAL_HEADER_NAMES.get(name.toLowerCase());
  if (known) return known;
  return name
    .split('-')
    .map((segment) =>
      segment.length === 0 ? segment : segment[0]!.toUpperCase() + segment.slice(1).toLowerCase(),
    )
    .join('-');
}

/** Case-insensitive lookup of the first value for `name`, or `undefined`. */
export function getHeader(headers: SltpHeaderList, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const field of headers) {
    if (field.name.toLowerCase() === wanted) return field.value;
  }
  return undefined;
}

/** Case-insensitive lookup of every value for `name`, in wire order. */
export function getAllHeaders(headers: SltpHeaderList, name: string): string[] {
  const wanted = name.toLowerCase();
  const found: string[] = [];
  for (const field of headers) {
    if (field.name.toLowerCase() === wanted) found.push(field.value);
  }
  return found;
}

/** True when at least one field named `name` is present. */
export function hasHeader(headers: SltpHeaderList, name: string): boolean {
  return getHeader(headers, name) !== undefined;
}

/**
 * Collapses a header list into a lower-cased record. Later duplicates overwrite
 * earlier ones; SLTP rejects duplicates during decoding, so this is only used for
 * display and for headers this implementation itself produced.
 */
export function headersToRecord(headers: SltpHeaderList): Record<string, string> {
  const record: Record<string, string> = {};
  for (const field of headers) {
    record[field.name.toLowerCase()] = field.value;
  }
  return record;
}

/** Builds a header list from a plain object, dropping `undefined` and `null` values. */
export function toHeaderList(
  source: Readonly<Record<string, string | number | undefined | null>>,
): SltpHeaderField[] {
  const fields: SltpHeaderField[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    fields.push({ name: canonicalHeaderName(name), value: String(value) });
  }
  return fields;
}
