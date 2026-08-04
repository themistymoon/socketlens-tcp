/**
 * SLTP message encoder.
 *
 * Serialises a request or response to a Buffer ready to write to a TCP socket.
 * The encoder validates every field it touches and throws SltpEncodeError on any
 * structural violation so that a bug in the caller is caught before bad bytes reach
 * the wire.
 */
import { SLTP_REASON, SltpEncodeError } from './errors.js';
import {
  canonicalHeaderName,
  isValidHeaderName,
  isValidHeaderValue,
  SLTP_HEADER,
  type SltpHeaderList,
} from './headers.js';
import { SLTP_VERSION_TOKEN, CRLF, CONTENT_TYPE_JSON, CONTENT_TYPE_TEXT } from './constants.js';
import type { SltpRequest, SltpResponse } from './types.js';

/** Options for building a request buffer. */
export interface EncodeRequestOptions {
  readonly operation: string;
  readonly headers?: Readonly<Record<string, string | number | undefined | null>>;
  readonly body?: string | Buffer | null;
  /** When true, the body is serialised as JSON and Content-Type is set automatically. */
  readonly json?: boolean;
}

/** Options for building a response buffer. */
export interface EncodeResponseOptions {
  readonly statusCode: number;
  readonly statusPhrase: string;
  readonly headers?: Readonly<Record<string, string | number | undefined | null>>;
  readonly body?: string | Buffer | null;
  readonly json?: boolean;
}

/** Serialises a request to a Buffer. */
export function encodeRequest(opts: EncodeRequestOptions): Buffer {
  const { operation, headers = {}, body, json } = opts;
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(operation)) {
    throw new SltpEncodeError(SLTP_REASON.invalidOperationToken, `Invalid operation: ${operation}`);
  }
  const startLine = `${SLTP_VERSION_TOKEN} ${operation}`;
  return encodeMessage(startLine, headers, body ?? null, json ?? false);
}

/** Serialises a response to a Buffer. */
export function encodeResponse(opts: EncodeResponseOptions): Buffer {
  const { statusCode, statusPhrase, headers = {}, body, json } = opts;
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new SltpEncodeError(SLTP_REASON.invalidStatusCode, `Invalid status code: ${statusCode}`);
  }
  if (!statusPhrase || !/^[\x20-\x7e]+$/.test(statusPhrase)) {
    throw new SltpEncodeError(
      SLTP_REASON.invalidStatusPhrase,
      `Invalid status phrase: ${JSON.stringify(statusPhrase)}`,
    );
  }
  const startLine = `${SLTP_VERSION_TOKEN} ${statusCode} ${statusPhrase}`;
  return encodeMessage(startLine, headers, body ?? null, json ?? false);
}

/** Convenience: encode a JSON body response. */
export function encodeJsonResponse(
  statusCode: number,
  statusPhrase: string,
  data: unknown,
  extraHeaders?: Readonly<Record<string, string | number | undefined | null>>,
): Buffer {
  return encodeResponse({
    statusCode,
    statusPhrase,
    headers: extraHeaders,
    body: JSON.stringify(data),
    json: true,
  });
}

/** Convenience: encode a JSON body request. */
export function encodeJsonRequest(
  operation: string,
  data: unknown,
  extraHeaders?: Readonly<Record<string, string | number | undefined | null>>,
): Buffer {
  return encodeRequest({
    operation,
    headers: extraHeaders,
    body: JSON.stringify(data),
    json: true,
  });
}

/** Re-encodes a decoded message back to its wire form. */
export function reencodeMessage(message: SltpRequest | SltpResponse): Buffer {
  if (message.kind === 'request') {
    return encodeRequest({
      operation: message.operation,
      headers: headersToRecord(message.headers),
      body: message.body || null,
    });
  }
  return encodeResponse({
    statusCode: message.statusCode,
    statusPhrase: message.statusPhrase,
    headers: headersToRecord(message.headers),
    body: message.body || null,
  });
}

// ─── internal helpers ────────────────────────────────────────────────────────

function headersToRecord(headers: SltpHeaderList): Record<string, string> {
  const record: Record<string, string> = {};
  for (const field of headers) {
    record[field.name] = field.value;
  }
  return record;
}

function encodeMessage(
  startLine: string,
  extraHeaders: Readonly<Record<string, string | number | undefined | null>>,
  body: string | Buffer | null,
  json: boolean,
): Buffer {
  // Resolve body bytes first so Content-Length is known before we write headers.
  let bodyBuf: Buffer;
  if (body === null || body === undefined) {
    bodyBuf = Buffer.alloc(0);
  } else if (Buffer.isBuffer(body)) {
    bodyBuf = body;
  } else {
    bodyBuf = Buffer.from(body, 'utf8');
  }

  const lines: string[] = [startLine];

  // Emit caller-supplied headers, validating each one.
  for (const [rawName, rawValue] of Object.entries(extraHeaders)) {
    if (rawValue === undefined || rawValue === null) continue;
    const name = canonicalHeaderName(rawName);
    const value = String(rawValue);
    if (!isValidHeaderName(name)) {
      throw new SltpEncodeError(SLTP_REASON.invalidHeaderName, `Invalid header name: ${name}`);
    }
    if (!isValidHeaderValue(value)) {
      throw new SltpEncodeError(
        SLTP_REASON.invalidHeaderValue,
        `Invalid header value for ${name}: ${JSON.stringify(value)}`,
      );
    }
    // Skip Content-Length from the caller; we always compute it ourselves.
    if (name.toLowerCase() === SLTP_HEADER.contentLength.toLowerCase()) continue;
    lines.push(`${name}: ${value}`);
  }

  // Inject Content-Type when the caller asked for JSON and did not supply one.
  const hasContentType = Object.keys(extraHeaders).some(
    (k) => k.toLowerCase() === SLTP_HEADER.contentType.toLowerCase(),
  );
  if (json && !hasContentType && bodyBuf.length > 0) {
    lines.push(`${SLTP_HEADER.contentType}: ${CONTENT_TYPE_JSON}`);
  } else if (!json && !hasContentType && bodyBuf.length > 0) {
    lines.push(`${SLTP_HEADER.contentType}: ${CONTENT_TYPE_TEXT}`);
  }

  // Content-Length is always computed from the actual byte length.
  if (bodyBuf.length > 0) {
    lines.push(`${SLTP_HEADER.contentLength}: ${bodyBuf.length}`);
  }

  // Header block ends with a blank line (CRLF CRLF).
  const headerBlock = lines.join(CRLF) + CRLF + CRLF;
  const headerBuf = Buffer.from(headerBlock, 'utf8');

  return Buffer.concat([headerBuf, bodyBuf]);
}
