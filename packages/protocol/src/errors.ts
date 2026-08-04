/**
 * Framing and validation failure taxonomy.
 *
 * Every failure carries a stable machine-readable code, an SLTP status, and a
 * `fatal` flag. `fatal` means the byte stream can no longer be resynchronised at a
 * message boundary, so the connection MUST be closed after the error response is
 * written. A non-fatal failure leaves the stream framed correctly, so the peer may
 * continue sending on the same connection.
 */
import { SLTP_STATUS } from './status.js';

/** Machine-readable reason codes emitted in the `Reason` header. */
export const SLTP_REASON = {
  emptyStartLine: 'empty-start-line',
  malformedStartLine: 'malformed-start-line',
  unsupportedProtocolVersion: 'unsupported-protocol-version',
  invalidOperationToken: 'invalid-operation-token',
  invalidStatusCode: 'invalid-status-code',
  missingStatusPhrase: 'missing-status-phrase',
  invalidStatusPhrase: 'invalid-status-phrase',
  bareLineFeed: 'bare-line-feed',
  bareCarriageReturn: 'bare-carriage-return',
  obsoleteLineFolding: 'obsolete-line-folding',
  malformedHeaderLine: 'malformed-header-line',
  invalidHeaderName: 'invalid-header-name',
  invalidHeaderValue: 'invalid-header-value',
  duplicateHeader: 'duplicate-header',
  invalidContentLength: 'invalid-content-length',
  negativeContentLength: 'negative-content-length',
  contentLengthTooLarge: 'content-length-too-large',
  startLineTooLarge: 'start-line-too-large',
  headerBlockTooLarge: 'header-block-too-large',
  tooManyHeaders: 'too-many-headers',
  messageTooLarge: 'message-too-large',
  truncatedMessage: 'truncated-message',
  unexpectedMessageKind: 'unexpected-message-kind',
  missingRequestId: 'missing-request-id',
  invalidRequestId: 'invalid-request-id',
  missingSessionId: 'missing-session-id',
  invalidSessionId: 'invalid-session-id',
  unexpectedBody: 'unexpected-body',
  missingBody: 'missing-body',
  invalidJsonBody: 'invalid-json-body',
  invalidBodyShape: 'invalid-body-shape',
  unknownOperation: 'unknown-operation',
  rateLimited: 'rate-limited',
  serverShuttingDown: 'server-shutting-down',
  sessionLimitReached: 'session-limit-reached',
} as const;

/** Union of the reason codes defined by SLTP/1.0. */
export type SltpReason = (typeof SLTP_REASON)[keyof typeof SLTP_REASON];

/** A framing or validation failure. */
export interface SltpFrameError {
  /** Stable reason code, echoed in the `Reason` response header. */
  readonly reason: SltpReason;
  /** Human-readable explanation, safe to log and to show in the interface. */
  readonly message: string;
  /** SLTP status a server should answer with. */
  readonly status: number;
  /** When true, the connection MUST be closed after responding. */
  readonly fatal: boolean;
  /** Optional structured context, for example the offending header name. */
  readonly detail?: Record<string, string | number>;
}

/** Reasons that leave the stream unsynchronisable and therefore close the connection. */
const FATAL_REASONS = new Set<string>([
  SLTP_REASON.emptyStartLine,
  SLTP_REASON.malformedStartLine,
  SLTP_REASON.unsupportedProtocolVersion,
  SLTP_REASON.invalidOperationToken,
  SLTP_REASON.invalidStatusCode,
  SLTP_REASON.missingStatusPhrase,
  SLTP_REASON.invalidStatusPhrase,
  SLTP_REASON.bareLineFeed,
  SLTP_REASON.bareCarriageReturn,
  SLTP_REASON.obsoleteLineFolding,
  SLTP_REASON.malformedHeaderLine,
  SLTP_REASON.invalidHeaderName,
  SLTP_REASON.invalidHeaderValue,
  SLTP_REASON.duplicateHeader,
  SLTP_REASON.invalidContentLength,
  SLTP_REASON.negativeContentLength,
  SLTP_REASON.contentLengthTooLarge,
  SLTP_REASON.startLineTooLarge,
  SLTP_REASON.headerBlockTooLarge,
  SLTP_REASON.tooManyHeaders,
  SLTP_REASON.messageTooLarge,
  SLTP_REASON.truncatedMessage,
  SLTP_REASON.unexpectedMessageKind,
]);

/** Reasons that report a size limit and therefore map to 413 MESSAGE TOO LARGE. */
const SIZE_REASONS = new Set<string>([
  SLTP_REASON.contentLengthTooLarge,
  SLTP_REASON.startLineTooLarge,
  SLTP_REASON.headerBlockTooLarge,
  SLTP_REASON.tooManyHeaders,
  SLTP_REASON.messageTooLarge,
]);

/** The SLTP status a given reason maps to. */
export function statusForReason(reason: SltpReason): number {
  if (SIZE_REASONS.has(reason)) return SLTP_STATUS.MESSAGE_TOO_LARGE;
  if (reason === SLTP_REASON.unknownOperation) return SLTP_STATUS.OPERATION_NOT_SUPPORTED;
  if (reason === SLTP_REASON.rateLimited) return SLTP_STATUS.TOO_MANY_REQUESTS;
  if (reason === SLTP_REASON.serverShuttingDown) return SLTP_STATUS.SERVER_UNAVAILABLE;
  if (reason === SLTP_REASON.sessionLimitReached) return SLTP_STATUS.SERVER_UNAVAILABLE;
  if (reason === SLTP_REASON.invalidBodyShape) return SLTP_STATUS.INVALID_SCENARIO;
  return SLTP_STATUS.BAD_REQUEST;
}

/** True when a failure with this reason forces the connection to close. */
export function isFatalReason(reason: SltpReason): boolean {
  return FATAL_REASONS.has(reason);
}

/** Builds a frame error, deriving status and fatality from the reason. */
export function frameError(
  reason: SltpReason,
  message: string,
  detail?: Record<string, string | number>,
): SltpFrameError {
  const error: SltpFrameError = {
    reason,
    message,
    status: statusForReason(reason),
    fatal: isFatalReason(reason),
    ...(detail ? { detail } : {}),
  };
  return error;
}

/** Error thrown by the encoder when asked to serialise a structurally invalid message. */
export class SltpEncodeError extends Error {
  readonly reason: SltpReason;

  constructor(reason: SltpReason, message: string) {
    super(message);
    this.name = 'SltpEncodeError';
    this.reason = reason;
  }
}
