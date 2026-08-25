/**
 * Wire-level constants for SLTP (SocketLens Testing Protocol), version 1.0.
 *
 * SLTP is a text-based, CRLF-delimited, length-framed application-layer protocol
 * carried over a single TCP byte stream. Nothing in this module touches Node.js
 * APIs, so the browser interface can import it directly.
 */

/** Protocol family name. */
export const SLTP_NAME = 'SLTP';

/** Protocol version implemented by this release. */
export const SLTP_VERSION = '1.0';

/** The exact token that MUST open every SLTP start line, e.g. `SLTP/1.0 PING`. */
export const SLTP_VERSION_TOKEN = 'SLTP/1.0';

/** Carriage return octet. */
export const CR_BYTE = 0x0d;

/** Line feed octet. */
export const LF_BYTE = 0x0a;

/** Every SLTP line ends with CRLF. A bare CR or a bare LF is a framing error. */
export const CRLF = '\r\n';

/** A single empty line terminates the header block and begins the body. */
export const HEADER_DELIMITER = '\r\n\r\n';

/** Byte length of {@link HEADER_DELIMITER}. */
export const HEADER_DELIMITER_LENGTH = 4;

/** Lowest and highest status codes the grammar permits in a response start line. */
export const MIN_STATUS_CODE = 100;
export const MAX_STATUS_CODE = 599;

/**
 * Configurable size limits enforced by the incremental decoder.
 *
 * These exist to bound memory use on a byte stream where a peer may never send a
 * terminating delimiter. Exceeding a limit is always fatal for the connection,
 * because the stream can no longer be resynchronised at a message boundary.
 */
export interface SltpLimits {
  /** Maximum total size of one message: header block + delimiter + body. */
  readonly maxMessageBytes: number;
  /** Maximum size of the start line and headers, excluding the blank line. */
  readonly maxHeaderBlockBytes: number;
  /** Maximum size of the start line alone. */
  readonly maxStartLineBytes: number;
  /** Maximum number of header fields in one message. */
  readonly maxHeaderCount: number;
}

/** Default decoder limits. 1 MiB per message is ample for a local testing tool. */
export const DEFAULT_LIMITS: SltpLimits = {
  maxMessageBytes: 1_048_576,
  maxHeaderBlockBytes: 16_384,
  maxStartLineBytes: 1_024,
  maxHeaderCount: 64,
};

/** Default request timeout used by clients when a scenario does not override it. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** Default TCP port of the SLTP control server. */
export const DEFAULT_CONTROL_PORT = 7420;

/** Default port of the loopback bridge that serves the graphical interface. */
export const DEFAULT_BRIDGE_PORT = 7801;

/** SocketLens TCP binds to the loopback interface only. */
export const DEFAULT_HOST = '127.0.0.1';

/** Upper bound for any artificial delay, so a stuck test cannot hang forever. */
export const MAX_RESPONSE_DELAY_MS = 60_000;

/** Media type SLTP uses for structured bodies. */
export const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';

/** Media type SLTP uses for opaque text bodies. */
export const CONTENT_TYPE_TEXT = 'text/plain; charset=utf-8';

/** Value advertised in the `Server` response header. */
export const SERVER_PRODUCT = 'SocketLens-TCP/0.1.2';

/** Grammar for a `Request-ID` or `Session-ID` value. */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
