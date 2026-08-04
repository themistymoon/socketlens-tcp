/**
 * Semantic validation of a decoded SLTP request.
 *
 * Framing and syntax are already settled by the decoder. This module applies the
 * rules that depend on the operation registry, in the exact order the specification
 * mandates, so that a request with several faults always reports the same one.
 *
 * Validation order (normative, see docs/protocol-specification.md §11):
 *   1. Request-ID present and well-formed          -> 400
 *   2. Operation registered                        -> 501
 *   3. Body presence matches the operation         -> 400
 *   4. Session-ID present and well-formed when the
 *      operation is session-scoped                 -> 400
 *   5. Body parses as JSON when a body is present  -> 400
 *
 * Steps that need server state (does the session exist, is it closed, is the rule
 * unique) happen afterwards in the server, because they are not protocol-level checks.
 */
import { IDENTIFIER_PATTERN } from './constants.js';
import { frameError, SLTP_REASON, type SltpFrameError } from './errors.js';
import { getAllHeaders, getHeader, SLTP_HEADER } from './headers.js';
import { findOperation } from './operations.js';
import type { SltpRequest } from './types.js';

/** Fields extracted from a request once it has passed validation. */
export interface ValidatedRequest {
  readonly requestId: string;
  readonly operation: string;
  readonly sessionId?: string;
  /** Parsed JSON body, or `undefined` when the request carried no body. */
  readonly json?: unknown;
}

/** Result of validating a request. */
export type ValidationResult =
  | { readonly ok: true; readonly value: ValidatedRequest }
  | { readonly ok: false; readonly error: SltpFrameError };

/**
 * Applies protocol-level validation to a decoded request.
 *
 * `requireSessionOverride` lets a session mock endpoint accept any operation without
 * a Session-ID, because the endpoint's TCP port already identifies the session.
 */
export function validateRequest(
  request: SltpRequest,
  options: { readonly requireSession?: boolean; readonly allowUnknownOperation?: boolean } = {},
): ValidationResult {
  // 1. Correlation identifier.
  const requestIds = getAllHeaders(request.headers, SLTP_HEADER.requestId);
  const requestId = requestIds[0];
  if (requestId === undefined) {
    return {
      ok: false,
      error: frameError(
        SLTP_REASON.missingRequestId,
        `Every SLTP request MUST carry a ${SLTP_HEADER.requestId} header.`,
      ),
    };
  }
  if (!IDENTIFIER_PATTERN.test(requestId)) {
    return {
      ok: false,
      error: frameError(
        SLTP_REASON.invalidRequestId,
        `${SLTP_HEADER.requestId} must match ${IDENTIFIER_PATTERN.source}; received ${JSON.stringify(requestId)}.`,
        { requestId },
      ),
    };
  }

  // 2. Operation registry.
  const definition = findOperation(request.operation);
  if (!definition && !options.allowUnknownOperation) {
    return {
      ok: false,
      error: frameError(
        SLTP_REASON.unknownOperation,
        `Operation ${request.operation} is not defined by SLTP/1.0.`,
        { operation: request.operation },
      ),
    };
  }

  // 3. Body presence.
  if (definition) {
    if (!definition.allowsBody && request.bodyBytes > 0) {
      return {
        ok: false,
        error: frameError(
          SLTP_REASON.unexpectedBody,
          `Operation ${request.operation} does not accept a body, but ${request.bodyBytes} byte(s) were framed.`,
          { operation: request.operation, bodyBytes: request.bodyBytes },
        ),
      };
    }
    if (definition.requiresBody && request.bodyBytes === 0) {
      return {
        ok: false,
        error: frameError(
          SLTP_REASON.missingBody,
          `Operation ${request.operation} requires a JSON body framed by ${SLTP_HEADER.contentLength}.`,
          { operation: request.operation },
        ),
      };
    }
  }

  // 4. Session scope.
  const sessionId = getHeader(request.headers, SLTP_HEADER.sessionId);
  const needsSession = options.requireSession ?? definition?.requiresSession ?? false;
  if (needsSession) {
    if (sessionId === undefined) {
      return {
        ok: false,
        error: frameError(
          SLTP_REASON.missingSessionId,
          `Operation ${request.operation} is session-scoped and requires a ${SLTP_HEADER.sessionId} header.`,
          { operation: request.operation },
        ),
      };
    }
    if (!IDENTIFIER_PATTERN.test(sessionId)) {
      return {
        ok: false,
        error: frameError(
          SLTP_REASON.invalidSessionId,
          `${SLTP_HEADER.sessionId} must match ${IDENTIFIER_PATTERN.source}; received ${JSON.stringify(sessionId)}.`,
          { sessionId },
        ),
      };
    }
  } else if (sessionId !== undefined && !IDENTIFIER_PATTERN.test(sessionId)) {
    return {
      ok: false,
      error: frameError(
        SLTP_REASON.invalidSessionId,
        `${SLTP_HEADER.sessionId} must match ${IDENTIFIER_PATTERN.source}; received ${JSON.stringify(sessionId)}.`,
        { sessionId },
      ),
    };
  }

  // 5. Structured body.
  let json: unknown;
  if (request.bodyBytes > 0) {
    const parsed = parseJsonBody(request.body);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    json = parsed.value;
  }

  return {
    ok: true,
    value: {
      requestId,
      operation: request.operation,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(json !== undefined ? { json } : {}),
    },
  };
}

/** Parses a UTF-8 body as JSON, reporting a protocol error rather than throwing. */
export function parseJsonBody(
  body: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: SltpFrameError } {
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: frameError(SLTP_REASON.invalidJsonBody, `Body is not valid JSON: ${detail}`),
    };
  }
}

/** Asserts that a parsed JSON body is a plain object, as every SLTP body must be. */
export function expectJsonObject(
  value: unknown,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: SltpFrameError } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: frameError(
        SLTP_REASON.invalidBodyShape,
        'SLTP request bodies must be a JSON object at the top level.',
      ),
    };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
