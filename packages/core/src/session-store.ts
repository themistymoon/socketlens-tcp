/**
 * In-memory session, rule, and result storage.
 *
 * SocketLens TCP 0.1 keeps everything in the server process. Nothing is persisted
 * between runs, which is a deliberate scope decision recorded in docs/requirements.md:
 * a protocol debugger is used interactively, and a database would add operational
 * weight without teaching anything about TCP.
 *
 * Every failure is reported as an SLTP status code rather than an exception, because
 * the caller's job is to turn it into a response.
 */
import { SLTP_STATUS, statusPhrase } from '@socketlens/protocol';
import { newRuleId, newSessionId } from './ids.js';
import { matchesAreEquivalent, orderRules } from './matching.js';
import { startMockEndpoint, type MockEndpoint } from './mock-endpoint.js';
import type {
  AddRuleInput,
  CreateSessionInput,
  MockRule,
  Session,
  TestResult,
  UpdateRuleInput,
} from './models.js';
import type { ProtocolLogger } from './logger.js';

/** A store failure, already carrying the status the client should receive. */
export interface StoreFailure {
  readonly statusCode: number;
  readonly statusPhrase: string;
  readonly message: string;
}

/** Either a value or a failure with its SLTP status. */
export type StoreResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: StoreFailure };

function fail(statusCode: number, message: string): { ok: false; failure: StoreFailure } {
  return { ok: false, failure: { statusCode, statusPhrase: statusPhrase(statusCode), message } };
}

function succeed<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** Internal mutable session record. The public {@link Session} is a projection of it. */
interface SessionRecord {
  id: string;
  name: string;
  description: string;
  state: 'active' | 'closed';
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  endpoint: MockEndpoint;
  rules: MockRule[];
  results: TestResult[];
  /** Next insertion sequence for this session's rules. */
  nextSequence: number;
}

/** Configuration for a session store. */
export interface SessionStoreOptions {
  readonly logger: ProtocolLogger;
  /** Refuse to create more sessions than this, answering 503 SERVER UNAVAILABLE. */
  readonly maxSessions?: number;
  /** Refuse to add more rules than this to one session, answering 422. */
  readonly maxRulesPerSession?: number;
  /** Keep at most this many results per session, discarding the oldest first. */
  readonly maxResultsPerSession?: number;
}

/** Default ceilings, chosen to keep an interactive tool bounded without ever being hit in a demo. */
export const STORE_LIMITS = {
  maxSessions: 32,
  maxRulesPerSession: 128,
  maxResultsPerSession: 200,
} as const;

/** Owns every session, its mock endpoint, its rules, and its results. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly logger: ProtocolLogger;
  private readonly maxSessions: number;
  private readonly maxRulesPerSession: number;
  private readonly maxResultsPerSession: number;

  constructor(options: SessionStoreOptions) {
    this.logger = options.logger;
    this.maxSessions = options.maxSessions ?? STORE_LIMITS.maxSessions;
    this.maxRulesPerSession = options.maxRulesPerSession ?? STORE_LIMITS.maxRulesPerSession;
    this.maxResultsPerSession = options.maxResultsPerSession ?? STORE_LIMITS.maxResultsPerSession;
  }

  // ─── sessions ──────────────────────────────────────────────────────────────

  /**
   * Creates a session and starts its dedicated TCP mock endpoint.
   *
   * The endpoint must be listening before the session is announced, because the
   * response carries the port a scenario will connect to.
   */
  async createSession(input: CreateSessionInput = {}): Promise<StoreResult<Session>> {
    const active = [...this.sessions.values()].filter((s) => s.state === 'active').length;
    if (active >= this.maxSessions) {
      return fail(
        SLTP_STATUS.SERVER_UNAVAILABLE,
        `The server already holds ${active} active session(s), the configured maximum. Close one first.`,
      );
    }

    const id = newSessionId();
    const now = new Date().toISOString();

    let endpoint: MockEndpoint;
    try {
      endpoint = await startMockEndpoint({
        sessionId: id,
        rules: () => this.sessions.get(id)?.rules ?? [],
        onRuleHit: (ruleId) => this.recordRuleHit(id, ruleId),
        logger: this.logger,
      });
    } catch (cause) {
      return fail(
        SLTP_STATUS.INTERNAL_SERVER_ERROR,
        `Could not start a mock endpoint for the new session: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    const record: SessionRecord = {
      id,
      name: input.name?.trim() || id,
      description: input.description?.trim() ?? '',
      state: 'active',
      createdAt: now,
      updatedAt: now,
      endpoint,
      rules: [],
      results: [],
      nextSequence: 1,
    };
    this.sessions.set(id, record);

    this.logger.info(
      `session ${id} created; mock endpoint listening on ${endpoint.host}:${endpoint.port}`,
    );

    return succeed(projectSession(record));
  }

  /** Looks up a session, failing with 404 SESSION NOT FOUND when it does not exist. */
  getSession(sessionId: string): StoreResult<Session> {
    const record = this.sessions.get(sessionId);
    if (!record) return fail(SLTP_STATUS.SESSION_NOT_FOUND, `No session with id ${sessionId}.`);
    return succeed(projectSession(record));
  }

  /** Every session, newest last. */
  listSessions(): Session[] {
    return [...this.sessions.values()].map(projectSession);
  }

  /**
   * Closes a session, stopping its mock endpoint and destroying open connections.
   * The record is retained so results stay inspectable after the session is closed.
   */
  async closeSession(sessionId: string): Promise<StoreResult<Session>> {
    const record = this.sessions.get(sessionId);
    if (!record) return fail(SLTP_STATUS.SESSION_NOT_FOUND, `No session with id ${sessionId}.`);
    if (record.state === 'closed') {
      return fail(SLTP_STATUS.OPERATION_NOT_ALLOWED, `Session ${sessionId} is already closed.`);
    }

    await record.endpoint.close();
    record.state = 'closed';
    const now = new Date().toISOString();
    record.closedAt = now;
    record.updatedAt = now;

    this.logger.info(`session ${sessionId} closed; mock endpoint stopped`);
    return succeed(projectSession(record));
  }

  /** Closes every session and stops every endpoint, for graceful server shutdown. */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (record) => {
        if (record.state === 'active') {
          await record.endpoint.close();
          record.state = 'closed';
          record.closedAt = new Date().toISOString();
        }
      }),
    );
  }

  /** The mock endpoint address of an active session, for RUN_TEST. */
  endpointOf(sessionId: string): StoreResult<{ host: string; port: number }> {
    const active = this.requireActive(sessionId);
    if (!active.ok) return active;
    return succeed({ host: active.value.endpoint.host, port: active.value.endpoint.port });
  }

  // ─── rules ─────────────────────────────────────────────────────────────────

  /**
   * Adds a rule.
   *
   * Three conflict conditions are rejected with 409 RULE CONFLICT: a duplicate rule
   * identifier, a duplicate rule name within the session, and a rule whose match
   * specification is identical to an existing enabled rule at the same priority. The
   * last case would make matching depend on insertion order in a way the user did not
   * ask for, so it is refused rather than silently resolved by the sequence tie-breaker.
   */
  addRule(sessionId: string, input: AddRuleInput): StoreResult<MockRule> {
    const active = this.requireActive(sessionId);
    if (!active.ok) return active;
    const record = active.value;

    if (record.rules.length >= this.maxRulesPerSession) {
      return fail(
        SLTP_STATUS.INVALID_SCENARIO,
        `Session ${sessionId} already holds ${record.rules.length} rules, the configured maximum.`,
      );
    }

    const id = input.id ?? newRuleId();
    if (record.rules.some((rule) => rule.id === id)) {
      return fail(
        SLTP_STATUS.RULE_CONFLICT,
        `Session ${sessionId} already has a rule with id ${id}.`,
      );
    }

    if (record.rules.some((rule) => rule.name === input.name)) {
      return fail(
        SLTP_STATUS.RULE_CONFLICT,
        `Session ${sessionId} already has a rule named "${input.name}". Rule names must be unique within a session.`,
      );
    }

    const priority = input.priority ?? 0;
    const enabled = input.enabled ?? true;

    if (enabled) {
      const clash = record.rules.find(
        (rule) =>
          rule.enabled &&
          rule.priority === priority &&
          matchesAreEquivalent(rule.match, input.match),
      );
      if (clash) {
        return fail(
          SLTP_STATUS.RULE_CONFLICT,
          `Rule ${clash.id} ("${clash.name}") already matches the same requests at priority ${priority}. ` +
            'Change the priority, narrow the match, or disable the existing rule.',
        );
      }
    }

    const now = new Date().toISOString();
    const rule: MockRule = {
      id,
      name: input.name,
      enabled,
      priority,
      match: input.match,
      response: input.response,
      createdAt: now,
      updatedAt: now,
      sequence: record.nextSequence++,
      hitCount: 0,
    };

    record.rules.push(rule);
    record.updatedAt = now;
    return succeed(rule);
  }

  /** Applies a partial update to a rule, re-checking for conflicts afterwards. */
  updateRule(sessionId: string, patch: UpdateRuleInput): StoreResult<MockRule> {
    const active = this.requireActive(sessionId);
    if (!active.ok) return active;
    const record = active.value;

    const index = record.rules.findIndex((rule) => rule.id === patch.id);
    const existing = record.rules[index];
    if (index < 0 || !existing) {
      return fail(
        SLTP_STATUS.RULE_NOT_FOUND,
        `Session ${sessionId} has no rule with id ${patch.id}.`,
      );
    }

    const now = new Date().toISOString();
    const updated: MockRule = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.match !== undefined ? { match: patch.match } : {}),
      ...(patch.response !== undefined ? { response: patch.response } : {}),
      updatedAt: now,
    };

    if (
      patch.name !== undefined &&
      record.rules.some((rule) => rule.id !== updated.id && rule.name === updated.name)
    ) {
      return fail(
        SLTP_STATUS.RULE_CONFLICT,
        `Session ${sessionId} already has another rule named "${updated.name}".`,
      );
    }

    if (updated.enabled) {
      const clash = record.rules.find(
        (rule) =>
          rule.id !== updated.id &&
          rule.enabled &&
          rule.priority === updated.priority &&
          matchesAreEquivalent(rule.match, updated.match),
      );
      if (clash) {
        return fail(
          SLTP_STATUS.RULE_CONFLICT,
          `The update would make rule ${updated.id} match the same requests as ${clash.id} at priority ${updated.priority}.`,
        );
      }
    }

    record.rules[index] = updated;
    record.updatedAt = now;
    return succeed(updated);
  }

  /** Removes a rule. */
  deleteRule(sessionId: string, ruleId: string): StoreResult<MockRule> {
    const active = this.requireActive(sessionId);
    if (!active.ok) return active;
    const record = active.value;

    const index = record.rules.findIndex((rule) => rule.id === ruleId);
    const removed = record.rules[index];
    if (index < 0 || !removed) {
      return fail(
        SLTP_STATUS.RULE_NOT_FOUND,
        `Session ${sessionId} has no rule with id ${ruleId}.`,
      );
    }

    record.rules.splice(index, 1);
    record.updatedAt = new Date().toISOString();
    return succeed(removed);
  }

  /** Rules in the exact order the matcher evaluates them. */
  listRules(sessionId: string): StoreResult<MockRule[]> {
    const record = this.sessions.get(sessionId);
    if (!record) return fail(SLTP_STATUS.SESSION_NOT_FOUND, `No session with id ${sessionId}.`);
    return succeed(orderRules(record.rules));
  }

  /** A single rule. */
  getRule(sessionId: string, ruleId: string): StoreResult<MockRule> {
    const record = this.sessions.get(sessionId);
    if (!record) return fail(SLTP_STATUS.SESSION_NOT_FOUND, `No session with id ${sessionId}.`);
    const rule = record.rules.find((candidate) => candidate.id === ruleId);
    if (!rule) {
      return fail(
        SLTP_STATUS.RULE_NOT_FOUND,
        `Session ${sessionId} has no rule with id ${ruleId}.`,
      );
    }
    return succeed(rule);
  }

  /** Increments a rule's hit count. Called by the mock endpoint when a rule fires. */
  private recordRuleHit(sessionId: string, ruleId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    const index = record.rules.findIndex((rule) => rule.id === ruleId);
    const rule = record.rules[index];
    if (index < 0 || !rule) return;
    record.rules[index] = { ...rule, hitCount: rule.hitCount + 1 };
  }

  // ─── results ───────────────────────────────────────────────────────────────

  /** Stores a test result, evicting the oldest once the per-session cap is reached. */
  addResult(sessionId: string, result: TestResult): StoreResult<TestResult> {
    const record = this.sessions.get(sessionId);
    if (!record) return fail(SLTP_STATUS.SESSION_NOT_FOUND, `No session with id ${sessionId}.`);

    record.results.push(result);
    while (record.results.length > this.maxResultsPerSession) record.results.shift();
    record.updatedAt = new Date().toISOString();
    return succeed(result);
  }

  /** A stored result. */
  getResult(sessionId: string, resultId: string): StoreResult<TestResult> {
    const record = this.sessions.get(sessionId);
    if (!record) return fail(SLTP_STATUS.SESSION_NOT_FOUND, `No session with id ${sessionId}.`);
    const result = record.results.find((candidate) => candidate.id === resultId);
    if (!result) {
      return fail(
        SLTP_STATUS.RESULT_NOT_FOUND,
        `Session ${sessionId} has no result with id ${resultId}.`,
      );
    }
    return succeed(result);
  }

  /** Every stored result for a session, oldest first. */
  listResults(sessionId: string): StoreResult<TestResult[]> {
    const record = this.sessions.get(sessionId);
    if (!record) return fail(SLTP_STATUS.SESSION_NOT_FOUND, `No session with id ${sessionId}.`);
    return succeed([...record.results]);
  }

  // ─── counters ──────────────────────────────────────────────────────────────

  /** Aggregate statistics for SERVER_INFO. */
  stats(): {
    sessions: number;
    activeSessions: number;
    rules: number;
    results: number;
    mockConnections: number;
  } {
    const records = [...this.sessions.values()];
    return {
      sessions: records.length,
      activeSessions: records.filter((record) => record.state === 'active').length,
      rules: records.reduce((total, record) => total + record.rules.length, 0),
      results: records.reduce((total, record) => total + record.results.length, 0),
      mockConnections: records.reduce(
        (total, record) =>
          total + (record.state === 'active' ? record.endpoint.openConnections() : 0),
        0,
      ),
    };
  }

  /** Resolves a session that must exist and must still be open. */
  private requireActive(sessionId: string): StoreResult<SessionRecord> {
    const record = this.sessions.get(sessionId);
    if (!record) return fail(SLTP_STATUS.SESSION_NOT_FOUND, `No session with id ${sessionId}.`);
    if (record.state === 'closed') {
      return fail(
        SLTP_STATUS.OPERATION_NOT_ALLOWED,
        `Session ${sessionId} is closed. Closed sessions are read-only.`,
      );
    }
    return succeed(record);
  }
}

/** Projects the internal record into the wire-safe {@link Session} shape. */
function projectSession(record: SessionRecord): Session {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.closedAt ? { closedAt: record.closedAt } : {}),
    mockHost: record.endpoint.host,
    mockPort: record.endpoint.port,
    ruleCount: record.rules.length,
    resultCount: record.results.length,
  };
}
