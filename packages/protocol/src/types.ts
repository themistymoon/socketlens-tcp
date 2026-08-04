/**
 * SLTP message types.
 *
 * A decoded message is immutable and carries both its parsed structure and the exact
 * bytes it occupied on the wire, so that captured traffic can be shown verbatim.
 */
import type { SltpHeaderList } from './headers.js';

/** Discriminator between the two message shapes. */
export type SltpMessageKind = 'request' | 'response';

/** Which side of the protocol a decoder or connection is acting as. */
export type SltpRole = 'client' | 'server';

/** Direction of a message relative to the process that logged it. */
export type SltpDirection = 'outbound' | 'inbound';

/** A parsed request: `SLTP/1.0 <OPERATION>` plus headers and an optional body. */
export interface SltpRequest {
  readonly kind: 'request';
  /** Protocol version token from the start line, e.g. `SLTP/1.0`. */
  readonly version: string;
  /** Operation token, e.g. `CREATE_SESSION`. May be unregistered. */
  readonly operation: string;
  /** Header fields in wire order. */
  readonly headers: SltpHeaderList;
  /** Body decoded as UTF-8. Empty string when there is no body. */
  readonly body: string;
  /** UTF-8 byte length of the body, as framed by Content-Length. */
  readonly bodyBytes: number;
}

/** A parsed response: `SLTP/1.0 <code> <PHRASE>` plus headers and an optional body. */
export interface SltpResponse {
  readonly kind: 'response';
  /** Protocol version token from the start line. */
  readonly version: string;
  /** Three-digit numeric status code. */
  readonly statusCode: number;
  /** Reason phrase exactly as received. */
  readonly statusPhrase: string;
  /** Header fields in wire order. */
  readonly headers: SltpHeaderList;
  /** Body decoded as UTF-8. Empty string when there is no body. */
  readonly body: string;
  /** UTF-8 byte length of the body, as framed by Content-Length. */
  readonly bodyBytes: number;
}

/** Either shape of SLTP message. */
export type SltpMessage = SltpRequest | SltpResponse;

/** Narrows a message to a request. */
export function isRequest(message: SltpMessage): message is SltpRequest {
  return message.kind === 'request';
}

/** Narrows a message to a response. */
export function isResponse(message: SltpMessage): message is SltpResponse {
  return message.kind === 'response';
}

/**
 * A JSON-safe projection of a decoded message together with its wire bytes.
 *
 * The bridge sends these to the browser interface. The type contains no Buffer and
 * no Node.js API, so the graphical client can reuse it without a polyfill and without
 * a second protocol parser.
 */
export interface SltpMessageView {
  readonly kind: SltpMessageKind;
  readonly version: string;
  /** Present on requests. */
  readonly operation?: string;
  /** Present on responses. */
  readonly statusCode?: number;
  /** Present on responses. */
  readonly statusPhrase?: string;
  readonly headers: SltpHeaderList;
  readonly body: string;
  readonly bodyBytes: number;
  /** The complete message as it appeared on the wire, decoded as UTF-8 for display. */
  readonly raw: string;
  /** Total size of the message on the wire, header block and body together. */
  readonly totalBytes: number;
}

/** One entry in a captured protocol conversation. */
export interface SltpWireEvent {
  /** Monotonic sequence number within the capture. */
  readonly seq: number;
  /** ISO 8601 instant at which the event was observed. */
  readonly at: string;
  /** Direction relative to the capturing process. */
  readonly direction: SltpDirection;
  /** Stable identifier of the TCP connection that carried the bytes. */
  readonly connectionId: string;
  /** Correlation identifier, when the message carried one. */
  readonly requestId?: string;
  /** Session scope, when the message carried one. */
  readonly sessionId?: string;
  /** The message, or `undefined` when the bytes could not be parsed. */
  readonly message?: SltpMessageView;
  /** Framing or validation failure, when parsing did not succeed. */
  readonly error?: { readonly code: string; readonly message: string; readonly status: number };
  /** Byte count of the event payload. */
  readonly bytes: number;
  /** Raw payload rendered for display, with CRLF made visible. */
  readonly raw: string;
}
