/**
 * Domain models shared by the server, the CLI, and the graphical interface.
 *
 * Everything here is plain data. Behaviour lives in the stores and the test runner,
 * which keeps these types safe to serialise into SLTP bodies and into exported
 * scenario files.
 */

// ─── sessions ────────────────────────────────────────────────────────────────

/** Lifecycle state of a testing session. */
export type SessionState = 'active' | 'closed';

/** An isolated testing session with its own mock endpoint, rules, and results. */
export interface Session {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly state: SessionState;
  /** ISO 8601 creation instant. */
  readonly createdAt: string;
  /** ISO 8601 instant of the last state change or rule mutation. */
  readonly updatedAt: string;
  /** ISO 8601 instant at which the session was closed, when it has been. */
  readonly closedAt?: string;
  /** Loopback host of the session's dedicated TCP mock endpoint. */
  readonly mockHost: string;
  /** Ephemeral TCP port of the mock endpoint, assigned by the operating system. */
  readonly mockPort: number;
  readonly ruleCount: number;
  readonly resultCount: number;
}

/** Fields a client may supply when creating a session. */
export interface CreateSessionInput {
  readonly name?: string;
  readonly description?: string;
}

// ─── mock rules ──────────────────────────────────────────────────────────────

/** How a rule's body matcher compares against the received body. */
export type BodyMatchMode = 'exact' | 'contains' | 'json-subset' | 'regex';

/** The conditions under which a rule fires. */
export interface RuleMatch {
  /** Operation token the incoming request must carry. `*` matches any operation. */
  readonly operation: string;
  /**
   * Headers the request must carry. Comparison is case-insensitive on the name and
   * exact on the value. An empty object matches any headers.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional body condition. */
  readonly body?: {
    readonly mode: BodyMatchMode;
    readonly value: string;
  };
}

/** The response a rule produces when it fires. */
export interface RuleResponse {
  readonly statusCode: number;
  readonly statusPhrase: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * Milliseconds the mock endpoint waits before writing the response. Used to
   * provoke client timeouts deliberately.
   */
  readonly delayMs?: number;
  /**
   * Optional fragmentation of the response write, so that the client under test
   * receives one SLTP message across several TCP segments.
   */
  readonly fragment?: {
    readonly sizes: readonly number[];
    readonly delayMs?: number;
  };
  /**
   * Closes the connection after writing this many bytes of the response, simulating
   * a peer that dies mid-message. The remaining bytes are never sent.
   */
  readonly disconnectAfterBytes?: number;
}

/** A stored mock response rule. */
export interface MockRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** Higher priority wins. Ties are broken by creation order. */
  readonly priority: number;
  readonly match: RuleMatch;
  readonly response: RuleResponse;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Monotonic insertion sequence, used as the deterministic tie-breaker. */
  readonly sequence: number;
  /** How many times this rule has fired. */
  readonly hitCount: number;
}

/** Fields a client supplies when adding a rule. */
export interface AddRuleInput {
  readonly id?: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly match: RuleMatch;
  readonly response: RuleResponse;
}

/** Fields a client may change on an existing rule. */
export interface UpdateRuleInput {
  readonly id: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly match?: RuleMatch;
  readonly response?: RuleResponse;
}

// ─── test scenarios ──────────────────────────────────────────────────────────

/** How the client under test writes its request onto the TCP connection. */
export type TransmissionMode =
  /** One `socket.write()` carrying the whole message. */
  | 'single'
  /** Several writes of explicit sizes, exercising the peer's reassembly. */
  | 'fragmented'
  /** Two messages written back to back, exercising the peer's message splitting. */
  | 'coalesced';

/** A request the scenario sends, described either structurally or as raw bytes. */
export interface ScenarioRequest {
  /** Operation token. Ignored when `raw` is set. */
  readonly operation?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * Exact bytes to place on the wire, bypassing the encoder. This is how malformed
   * messages are tested: the encoder would refuse to produce them.
   * `\r\n` escape sequences in the string are converted to real CRLF octets.
   */
  readonly raw?: string;
}

/** Assertions compared against the response the scenario receives. */
export interface ScenarioExpectation {
  readonly statusCode?: number;
  readonly statusPhrase?: string;
  /** Headers that must be present with these exact values. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The whole body must equal this string. */
  readonly body?: string;
  /** The body must contain this substring. */
  readonly bodyContains?: string;
  /** The response body, parsed as JSON, must contain these keys and values. */
  readonly jsonSubset?: Readonly<Record<string, unknown>>;
  /**
   * When true, the scenario passes only if no complete response arrives before the
   * timeout. This is what turns a timeout from a failure into an expected outcome.
   */
  readonly timeout?: boolean;
  /** When true, the scenario passes only if the peer closes mid-message. */
  readonly disconnect?: boolean;
}

/** A complete, executable test scenario. */
export interface TestScenario {
  readonly name: string;
  readonly description?: string;
  /**
   * Where to send the request. Defaults to the session's own mock endpoint, which is
   * the normal case. An explicit target must be a loopback development endpoint.
   */
  readonly target?: {
    readonly host: string;
    readonly port: number;
  };
  readonly request: ScenarioRequest;
  readonly transmission?: {
    readonly mode: TransmissionMode;
    /** Explicit fragment sizes in bytes. Used when mode is `fragmented`. */
    readonly fragmentSizes?: readonly number[];
    /** When set instead of `fragmentSizes`, split the message into equal parts. */
    readonly fragmentCount?: number;
    /** Milliseconds to pause between fragments. */
    readonly interFragmentDelayMs?: number;
    /** A second message written immediately after the first, in the same write. */
    readonly coalesceWith?: ScenarioRequest;
    /** Closes the connection after writing this many bytes of the request. */
    readonly disconnectAfterBytes?: number;
  };
  /** Milliseconds to wait for a complete response before declaring a timeout. */
  readonly timeoutMs?: number;
  readonly expect?: ScenarioExpectation;
}

// ─── results ─────────────────────────────────────────────────────────────────

/** Outcome of one assertion. */
export interface AssertionResult {
  /** Which aspect was checked, e.g. `statusCode` or `headers.Content-Type`. */
  readonly field: string;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
  /** Explanation shown when the assertion failed. */
  readonly message?: string;
}

/** Why a scenario finished. */
export type TestOutcome = 'passed' | 'failed' | 'timeout' | 'error';

/**
 * One observed application write or read during a scenario, for the fragmentation view.
 *
 * This is an application-level event, not a TCP segment. The operating system decides
 * how the bytes of a write are carried, and the socket API never reveals it.
 */
export interface WireSegment {
  readonly direction: 'sent' | 'received';
  /** Milliseconds since the scenario started. */
  readonly atMs: number;
  readonly bytes: number;
  /** The bytes of this write or read, decoded as UTF-8 for display. */
  readonly data: string;
}

/** The stored outcome of one scenario execution. */
export interface TestResult {
  readonly id: string;
  readonly sessionId: string;
  readonly scenarioName: string;
  readonly outcome: TestOutcome;
  readonly passed: boolean;
  /** ISO 8601 instant at which execution began. */
  readonly startedAt: string;
  /** Wall-clock duration of the exchange in milliseconds. */
  readonly durationMs: number;
  readonly assertions: readonly AssertionResult[];
  /** Exact bytes written by the scenario, decoded as UTF-8. */
  readonly rawSent: string;
  /** Exact bytes received, decoded as UTF-8. Empty on timeout. */
  readonly rawReceived: string;
  /** Parsed response, when one was received and framed successfully. */
  readonly response?: {
    readonly statusCode: number;
    readonly statusPhrase: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly bodyBytes: number;
  };
  /** Identifier of the mock rule that produced the response, when applicable. */
  readonly matchedRuleId?: string;
  /** Human-readable explanation of a timeout, disconnect, or protocol error. */
  readonly error?: string;
  /** Individual writes and reads, proving fragmentation actually occurred. */
  readonly segments: readonly WireSegment[];
  /**
   * Number of separate `socket.write()` calls the request was split across. A
   * fragmented scenario that reports 1 here did not actually fragment anything.
   *
   * Named `segment` for wire compatibility, but this counts **application writes**.
   * How many TCP segments the operating system produced from them is its decision,
   * is not observable from the socket API, and may be a different number.
   */
  readonly sentSegmentCount: number;
  /**
   * Number of separate reads the response arrived in — that is, `data` events.
   *
   * A `data` event is not a TCP segment: the kernel may deliver several segments in
   * one event, or one segment across two. What this proves is only that the receiver
   * could not rely on any single read holding a whole message.
   */
  readonly receivedSegmentCount: number;
  /**
   * How many complete SLTP responses were framed from those reads. Two responses
   * arriving from one coalesced write is the observable proof that TCP does not
   * preserve message boundaries.
   */
  readonly responseCount: number;
}

/** A compact projection of a result, for list views. */
export interface TestResultSummary {
  readonly id: string;
  readonly scenarioName: string;
  readonly outcome: TestOutcome;
  readonly passed: boolean;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly statusCode?: number;
  readonly statusPhrase?: string;
  readonly failedAssertions: number;
}

/** Projects a full result into its summary form. */
export function summariseResult(result: TestResult): TestResultSummary {
  return {
    id: result.id,
    scenarioName: result.scenarioName,
    outcome: result.outcome,
    passed: result.passed,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    ...(result.response
      ? { statusCode: result.response.statusCode, statusPhrase: result.response.statusPhrase }
      : {}),
    failedAssertions: result.assertions.filter((a) => !a.passed).length,
  };
}
