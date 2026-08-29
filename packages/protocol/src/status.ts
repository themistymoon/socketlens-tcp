/**
 * The SLTP status registry.
 *
 * These codes are defined by SLTP itself. Their numeric ranges are deliberately
 * familiar to anyone who has read HTTP, because familiarity aids debugging, but the
 * meanings below are normative for SLTP and several codes have no HTTP counterpart
 * (210 TEST PASSED, 211 TEST FAILED, 410 NO MATCHING RULE, and the rule codes).
 * Never assume an HTTP meaning for an SLTP code.
 */

/** Broad class of a status code, derived from its leading digit. */
export type SltpStatusCategory = 'success' | 'client-error' | 'server-error';

/** One entry in the status registry. */
export interface SltpStatusDefinition {
  /** Three-digit numeric code sent in the response start line. */
  readonly code: number;
  /** Canonical uppercase reason phrase sent alongside the code. */
  readonly phrase: string;
  /** Class of the code. */
  readonly category: SltpStatusCategory;
  /** Normative meaning. */
  readonly meaning: string;
  /** The situations in which a server is permitted to send this code. */
  readonly context: string;
  /** Whether the server closes the connection immediately after sending it. */
  readonly closesConnection: boolean;
}

/** Numeric constants for every registered status. */
export const SLTP_STATUS = {
  OK: 200,
  SESSION_CREATED: 201,
  TEST_ACCEPTED: 202,
  SESSION_CLOSED: 204,
  TEST_PASSED: 210,
  TEST_FAILED: 211,
  RULE_ADDED: 212,
  RULE_UPDATED: 213,
  RULE_DELETED: 214,
  BAD_REQUEST: 400,
  SESSION_NOT_FOUND: 404,
  OPERATION_NOT_ALLOWED: 405,
  RULE_NOT_FOUND: 406,
  RESULT_NOT_FOUND: 407,
  TEST_TIMEOUT: 408,
  RULE_CONFLICT: 409,
  NO_MATCHING_RULE: 410,
  MESSAGE_TOO_LARGE: 413,
  INVALID_SCENARIO: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  OPERATION_NOT_SUPPORTED: 501,
  SERVER_UNAVAILABLE: 503,
} as const;

/** Union of the numeric status codes defined by SLTP/1.0. */
export type SltpStatusCode = (typeof SLTP_STATUS)[keyof typeof SLTP_STATUS];

/**
 * The registry, ordered by code. `docs/status-codes.md` and `docs/protocol-specification.md`
 * §12 restate the same information and MUST stay identical to this table. Those documents
 * are written by hand, but they are not unchecked:
 * `tests/protocol/docs-registry-consistency.test.ts` compares their tables against this
 * registry, so a code, phrase, category, or ordering change here fails the suite until the
 * documents are updated to match. Generating them from this registry instead is tracked in
 * `ROADMAP.md`.
 */
export const SLTP_STATUS_REGISTRY: readonly SltpStatusDefinition[] = [
  {
    code: 200,
    phrase: 'OK',
    category: 'success',
    meaning: 'The operation succeeded and any requested data is in the body.',
    context:
      'PING, SERVER_INFO, GET_SESSION, LIST_SESSIONS, LIST_RULES, GET_RESULT, and LIST_RESULTS.',
    closesConnection: false,
  },
  {
    code: 201,
    phrase: 'SESSION CREATED',
    category: 'success',
    meaning:
      'A new testing session exists. The body carries the session object and the response repeats the identifier in the Session-ID header.',
    context: 'CREATE_SESSION only.',
    closesConnection: false,
  },
  {
    code: 202,
    phrase: 'TEST ACCEPTED',
    category: 'success',
    meaning:
      'Reserved for a future asynchronous RUN_TEST mode; no v0.1 code path emits it. It would mean a scenario was validated and queued for later execution, with the Result-ID header naming the pending result, retrieved with GET_RESULT.',
    context:
      'Nothing in v0.1. RUN_TEST is always synchronous and answers 210, 211, or 408; the code stays registered among its success statuses as a reservation, not a capability. Recorded as a known gap in docs/requirements.md §4.3.',
    closesConnection: false,
  },
  {
    code: 204,
    phrase: 'SESSION CLOSED',
    category: 'success',
    meaning:
      'The session moved to the closed state, its mock endpoint was shut down, and its rules stopped matching. Stored results remain readable. Unlike HTTP 204, an SLTP 204 response MAY carry a body.',
    context: 'CLOSE_SESSION only.',
    closesConnection: false,
  },
  {
    code: 210,
    phrase: 'TEST PASSED',
    category: 'success',
    meaning:
      'A test scenario executed and every assertion held. The body carries the full result, including raw sent and received bytes.',
    context: 'RUN_TEST in synchronous mode.',
    closesConnection: false,
  },
  {
    code: 211,
    phrase: 'TEST FAILED',
    category: 'success',
    meaning:
      'A test scenario executed correctly at the protocol level but at least one assertion did not hold. This is a successful SLTP exchange reporting a failed test, so it is a 2xx code; the failing assertions are listed in the body.',
    context: 'RUN_TEST in synchronous mode.',
    closesConnection: false,
  },
  {
    code: 212,
    phrase: 'RULE ADDED',
    category: 'success',
    meaning: 'A mock rule was stored in the session. The body carries the stored rule.',
    context: 'ADD_RULE only.',
    closesConnection: false,
  },
  {
    code: 213,
    phrase: 'RULE UPDATED',
    category: 'success',
    meaning: 'An existing mock rule was replaced. The body carries the updated rule.',
    context: 'UPDATE_RULE only.',
    closesConnection: false,
  },
  {
    code: 214,
    phrase: 'RULE DELETED',
    category: 'success',
    meaning: 'A mock rule was removed from the session.',
    context: 'DELETE_RULE only.',
    closesConnection: false,
  },
  {
    code: 400,
    phrase: 'BAD REQUEST',
    category: 'client-error',
    meaning:
      'The message could not be framed or parsed, or a required header was absent or malformed. The Reason header carries a machine-readable code.',
    context:
      'Any request. Framing failures are fatal and close the connection because the byte stream can no longer be resynchronised; header and body faults are recoverable and leave the connection open.',
    closesConnection: false,
  },
  {
    code: 404,
    phrase: 'SESSION NOT FOUND',
    category: 'client-error',
    meaning: 'The Session-ID is syntactically valid but no session with that identifier exists.',
    context: 'Any session-scoped operation.',
    closesConnection: false,
  },
  {
    code: 405,
    phrase: 'OPERATION NOT ALLOWED',
    category: 'client-error',
    meaning:
      'The operation is recognised but not permitted in the current context, for example a session-scoped operation on a closed session, or a control operation sent to a session mock endpoint.',
    context: 'Any request whose operation is valid but contextually forbidden.',
    closesConnection: false,
  },
  {
    code: 406,
    phrase: 'RULE NOT FOUND',
    category: 'client-error',
    meaning: 'No mock rule with the requested identifier exists in the session.',
    context: 'UPDATE_RULE and DELETE_RULE.',
    closesConnection: false,
  },
  {
    code: 407,
    phrase: 'RESULT NOT FOUND',
    category: 'client-error',
    meaning: 'No stored test result with the requested identifier exists in the session.',
    context: 'GET_RESULT only.',
    closesConnection: false,
  },
  {
    code: 408,
    phrase: 'TEST TIMEOUT',
    category: 'client-error',
    meaning:
      'A test scenario did not receive a complete SLTP response from its target within the scenario timeout, and the scenario did not declare a timeout as its expected outcome. If a timeout was expected, the server replies 210 TEST PASSED instead.',
    context: 'RUN_TEST only. Never sent for a control request.',
    closesConnection: false,
  },
  {
    code: 409,
    phrase: 'RULE CONFLICT',
    category: 'client-error',
    meaning:
      'The rule would collide with an existing rule: a duplicate identifier, a duplicate name within the session, or an identical match specification at the same priority, which would make matching non-deterministic.',
    context: 'ADD_RULE and UPDATE_RULE.',
    closesConnection: false,
  },
  {
    code: 410,
    phrase: 'NO MATCHING RULE',
    category: 'client-error',
    meaning:
      'A session mock endpoint received a well-formed request that no enabled rule matched, and the session defines no default response. It reports an unconfigured mock, not a missing session.',
    context: 'Session mock endpoints only. The control server never sends it.',
    closesConnection: false,
  },
  {
    code: 413,
    phrase: 'MESSAGE TOO LARGE',
    category: 'client-error',
    meaning:
      'A declared or observed size exceeded a configured limit: total message bytes, header block bytes, start-line bytes, or header count.',
    context:
      'Any request. Always fatal for the connection, because the remaining bytes of the oversized message cannot be safely skipped.',
    closesConnection: true,
  },
  {
    code: 422,
    phrase: 'INVALID SCENARIO',
    category: 'client-error',
    meaning:
      'The request was well-formed SLTP and the JSON body parsed, but the scenario or rule it describes is semantically invalid, for example a negative timeout, an empty fragment size list, or contradictory expectations.',
    context: 'RUN_TEST, ADD_RULE, and UPDATE_RULE.',
    closesConnection: false,
  },
  {
    code: 429,
    phrase: 'TOO MANY REQUESTS',
    category: 'client-error',
    meaning:
      'The connection exceeded its request rate allowance. The Retry-After header gives the delay in milliseconds before the allowance refills.',
    context: 'Any request on a connection that exceeded its token bucket.',
    closesConnection: false,
  },
  {
    code: 500,
    phrase: 'INTERNAL SERVER ERROR',
    category: 'server-error',
    meaning:
      'An unexpected fault occurred while handling a valid request. The server stays available and the connection stays open.',
    context: 'Any request.',
    closesConnection: false,
  },
  {
    code: 501,
    phrase: 'OPERATION NOT SUPPORTED',
    category: 'server-error',
    meaning:
      'The start line was well-formed but the operation token is not in the SLTP/1.0 operation registry, or is not implemented by this server.',
    context: 'Any request carrying an unknown operation.',
    closesConnection: false,
  },
  {
    code: 503,
    phrase: 'SERVER UNAVAILABLE',
    category: 'server-error',
    meaning:
      'The server cannot accept the request because it is shutting down or a capacity limit such as the maximum session count is exhausted.',
    context: 'Any request during shutdown; CREATE_SESSION at the session limit.',
    closesConnection: false,
  },
];

const REGISTRY_BY_CODE = new Map<number, SltpStatusDefinition>(
  SLTP_STATUS_REGISTRY.map((entry) => [entry.code, entry]),
);

/** Returns the registry entry for `code`, or `undefined` if it is not registered. */
export function findStatus(code: number): SltpStatusDefinition | undefined {
  return REGISTRY_BY_CODE.get(code);
}

/**
 * Returns the canonical reason phrase for `code`. Unregistered codes fall back to
 * a generic phrase for their class so that a response can always be serialised.
 */
export function statusPhrase(code: number): string {
  const entry = REGISTRY_BY_CODE.get(code);
  if (entry) return entry.phrase;
  if (code >= 200 && code < 300) return 'OK';
  if (code >= 400 && code < 500) return 'CLIENT ERROR';
  if (code >= 500 && code < 600) return 'SERVER ERROR';
  return 'UNKNOWN';
}

/** Classifies `code` by its leading digit. */
export function statusCategory(code: number): SltpStatusCategory {
  if (code >= 500) return 'server-error';
  if (code >= 400) return 'client-error';
  return 'success';
}

/** True when `code` is in the SLTP success class (2xx). */
export function isSuccessStatus(code: number): boolean {
  return code >= 200 && code < 300;
}

/** True when `code` reports a fault of any kind (4xx or 5xx). */
export function isErrorStatus(code: number): boolean {
  return code >= 400;
}

/** True when `code` is registered by SLTP/1.0. */
export function isRegisteredStatus(code: number): boolean {
  return REGISTRY_BY_CODE.has(code);
}
