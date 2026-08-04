/**
 * Browser-safe subset of `@socketlens/protocol`.
 *
 * The graphical client imports only this entry point. Every export here is pure
 * TypeScript over strings, numbers, and plain objects: no Buffer, no `node:net`, no
 * Node.js globals of any kind. The wire-level encoder and the incremental decoder are
 * deliberately absent, because in SocketLens TCP the browser never owns a TCP socket
 * and never parses protocol bytes itself. It renders {@link SltpMessageView} objects
 * produced by the bridge, which uses the very same decoder as the server and the CLI.
 */

export {
  SLTP_NAME,
  SLTP_VERSION,
  SLTP_VERSION_TOKEN,
  CRLF,
  HEADER_DELIMITER,
  CONTENT_TYPE_JSON,
  CONTENT_TYPE_TEXT,
  DEFAULT_CONTROL_PORT,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_HOST,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_LIMITS,
  MAX_RESPONSE_DELAY_MS,
  IDENTIFIER_PATTERN,
  type SltpLimits,
} from './constants.js';

export {
  SLTP_STATUS,
  SLTP_STATUS_REGISTRY,
  findStatus,
  statusPhrase,
  statusCategory,
  isSuccessStatus,
  isErrorStatus,
  isRegisteredStatus,
  type SltpStatusCode,
  type SltpStatusCategory,
  type SltpStatusDefinition,
} from './status.js';

export {
  SLTP_OPERATION,
  SLTP_OPERATION_REGISTRY,
  findOperation,
  isKnownOperation,
  isValidOperationToken,
  allOperationNames,
  controlOperationNames,
  type SltpOperation,
  type SltpOperationDefinition,
  type SltpOperationTarget,
} from './operations.js';

export {
  getHeader,
  getAllHeaders,
  hasHeader,
  headersToRecord,
  canonicalHeaderName,
  isValidHeaderName,
  isValidHeaderValue,
  type SltpHeaderField,
  type SltpHeaderList,
} from './headers.js';

export { SLTP_REASON, type SltpReason } from './errors.js';

export type {
  SltpMessageKind,
  SltpMessageView,
  SltpWireEvent,
  SltpDirection,
  SltpRole,
} from './types.js';

export {
  utf8ByteLength,
  renderRawMessage,
  escapeCrlfInline,
  truncateForDisplay,
  startLineOf,
  summariseMessage,
  requestIdOf,
  sessionIdOf,
  formatBytes,
  formatDuration,
  prettyPrintBody,
} from './display.js';
