/**
 * Session, rule, and result storage.
 *
 * Creating a session starts a real TCP mock endpoint on an ephemeral loopback port,
 * so every test closes its store afterwards rather than leaking a listener.
 *
 * The store never throws: every failure comes back as a value carrying the SLTP status
 * the caller should send. The `unwrap` and `failure` helpers below mirror what the
 * server's handlers do with those values.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SLTP_STATUS } from '@socketlens/protocol';
import {
  SessionStore,
  silentLogger,
  type AddRuleInput,
  type StoreFailure,
  type StoreResult,
} from '@socketlens/core';
import { testResult } from '../helpers/fixtures.js';

let store: SessionStore | undefined;

afterEach(async () => {
  await store?.closeAll();
  store = undefined;
});

/** Builds a store whose endpoints are cleaned up by the hook above. */
function newStore(
  options: { maxSessions?: number; maxResultsPerSession?: number } = {},
): SessionStore {
  store = new SessionStore({ logger: silentLogger('SERVER'), ...options });
  return store;
}

/** The value of a successful store call, or a loud failure. */
function unwrap<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected success but the store failed with ${result.failure.statusCode} ${result.failure.statusPhrase}: ${result.failure.message}`,
    );
  }
  return result.value;
}

/** The failure of an unsuccessful store call, or a loud failure. */
function failureOf<T>(result: StoreResult<T>): StoreFailure {
  if (result.ok) throw new Error('expected the store to fail but it succeeded');
  return result.failure;
}

/** A minimal, valid rule input. */
function ruleInput(overrides: Partial<AddRuleInput> = {}): AddRuleInput {
  return {
    name: overrides.name ?? 'ping-ok',
    match: overrides.match ?? { operation: 'PING' },
    response: overrides.response ?? { statusCode: 200, statusPhrase: 'OK' },
    ...(overrides.id !== undefined ? { id: overrides.id } : {}),
    ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
    ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
  };
}

describe('sessions', () => {
  it('creates an active session with a listening mock endpoint', async () => {
    const session = unwrap(await newStore().createSession({ name: 'demo', description: 'a demo' }));

    expect(session.name).toBe('demo');
    expect(session.description).toBe('a demo');
    expect(session.state).toBe('active');
    expect(session.mockPort).toBeGreaterThan(0);
    expect(session.mockHost.length).toBeGreaterThan(0);
    expect(session.ruleCount).toBe(0);
    expect(session.resultCount).toBe(0);
    expect(session.closedAt).toBeUndefined();
  });

  it('names an unnamed session after its own identifier', async () => {
    const session = unwrap(await newStore().createSession());

    expect(session.name).toBe(session.id);
    expect(session.id).toMatch(/^ses-\d+$/);
  });

  it('gives each session its own endpoint port', async () => {
    const active = newStore();
    const first = unwrap(await active.createSession());
    const second = unwrap(await active.createSession());

    expect(first.id).not.toBe(second.id);
    expect(first.mockPort).not.toBe(second.mockPort);
  });

  it('reads a session back by identifier', async () => {
    const active = newStore();
    const created = unwrap(await active.createSession({ name: 'readable' }));

    expect(unwrap(active.getSession(created.id))).toMatchObject({
      id: created.id,
      name: 'readable',
    });
  });

  it('answers 404 SESSION NOT FOUND for an unknown session', () => {
    const failure = failureOf(newStore().getSession('ses-does-not-exist'));

    expect(failure.statusCode).toBe(SLTP_STATUS.SESSION_NOT_FOUND);
    expect(failure.statusPhrase).toBe('SESSION NOT FOUND');
    expect(failure.message).toContain('ses-does-not-exist');
  });

  it('lists every session it holds', async () => {
    const active = newStore();
    const first = unwrap(await active.createSession());
    const second = unwrap(await active.createSession());

    expect(active.listSessions().map((session) => session.id)).toEqual([first.id, second.id]);
  });

  it('refuses to exceed the configured session ceiling', async () => {
    const active = newStore({ maxSessions: 1 });
    unwrap(await active.createSession());

    const failure = failureOf(await active.createSession());

    expect(failure.statusCode).toBe(SLTP_STATUS.SERVER_UNAVAILABLE);
  });

  it('frees a slot in the ceiling when a session is closed', async () => {
    const active = newStore({ maxSessions: 1 });
    const first = unwrap(await active.createSession());
    unwrap(await active.closeSession(first.id));

    expect(unwrap(await active.createSession()).state).toBe('active');
  });

  it('closes a session, stamps closedAt, and keeps the record readable', async () => {
    const active = newStore();
    const created = unwrap(await active.createSession());

    const closed = unwrap(await active.closeSession(created.id));

    expect(closed.state).toBe('closed');
    expect(closed.closedAt).toBeDefined();
    expect(unwrap(active.getSession(created.id)).state).toBe('closed');
  });

  it('refuses to close a session twice', async () => {
    const active = newStore();
    const created = unwrap(await active.createSession());
    unwrap(await active.closeSession(created.id));

    const failure = failureOf(await active.closeSession(created.id));

    expect(failure.statusCode).toBe(SLTP_STATUS.OPERATION_NOT_ALLOWED);
    expect(failure.message).toContain('already closed');
  });

  it('reports the endpoint address of an active session and refuses a closed one', async () => {
    const active = newStore();
    const created = unwrap(await active.createSession());

    expect(unwrap(active.endpointOf(created.id))).toEqual({
      host: created.mockHost,
      port: created.mockPort,
    });

    unwrap(await active.closeSession(created.id));
    expect(failureOf(active.endpointOf(created.id)).statusCode).toBe(
      SLTP_STATUS.OPERATION_NOT_ALLOWED,
    );
  });
});

describe('rules', () => {
  it('assigns an identifier and an insertion sequence', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;

    const first = unwrap(active.addRule(sessionId, ruleInput({ name: 'first' })));
    const second = unwrap(active.addRule(sessionId, ruleInput({ name: 'second', priority: 1 })));

    expect(first.id).toMatch(/^rule-\d+$/);
    expect(second.id).not.toBe(first.id);
    expect(second.sequence).toBe(first.sequence + 1);
    expect(first.hitCount).toBe(0);
    expect(first.enabled).toBe(true);
    expect(first.priority).toBe(0);
  });

  it('honours a client-supplied rule identifier', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;

    expect(unwrap(active.addRule(sessionId, ruleInput({ id: 'my-rule' }))).id).toBe('my-rule');
  });

  it('rejects a duplicate rule identifier with 409 RULE CONFLICT', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addRule(sessionId, ruleInput({ id: 'dup', name: 'a' })));

    const failure = failureOf(
      active.addRule(sessionId, ruleInput({ id: 'dup', name: 'b', priority: 5 })),
    );

    expect(failure.statusCode).toBe(SLTP_STATUS.RULE_CONFLICT);
    expect(failure.message).toContain('dup');
  });

  it('rejects a duplicate rule name within one session', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addRule(sessionId, ruleInput({ name: 'same' })));

    const failure = failureOf(
      active.addRule(
        sessionId,
        ruleInput({ name: 'same', priority: 3, match: { operation: 'RUN_TEST' } }),
      ),
    );

    expect(failure.statusCode).toBe(SLTP_STATUS.RULE_CONFLICT);
    expect(failure.message).toContain('must be unique');
  });

  it('rejects an ambiguous rule rather than resolving it by insertion order', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addRule(sessionId, ruleInput({ name: 'first', priority: 2 })));

    const failure = failureOf(
      active.addRule(sessionId, ruleInput({ name: 'second', priority: 2 })),
    );

    expect(failure.statusCode).toBe(SLTP_STATUS.RULE_CONFLICT);
    expect(failure.message).toContain('same requests at priority 2');
  });

  it('accepts an identical match at a different priority', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addRule(sessionId, ruleInput({ name: 'first', priority: 2 })));

    expect(
      unwrap(active.addRule(sessionId, ruleInput({ name: 'second', priority: 3 }))).priority,
    ).toBe(3);
  });

  it('accepts an identical match when the new rule is disabled', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addRule(sessionId, ruleInput({ name: 'first' })));

    expect(
      unwrap(active.addRule(sessionId, ruleInput({ name: 'second', enabled: false }))).enabled,
    ).toBe(false);
  });

  it('lists rules in the order the matcher evaluates them', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addRule(sessionId, ruleInput({ id: 'a', name: 'a', priority: 0 })));
    unwrap(active.addRule(sessionId, ruleInput({ id: 'b', name: 'b', priority: 9 })));
    unwrap(
      active.addRule(
        sessionId,
        ruleInput({ id: 'c', name: 'c', priority: 0, match: { operation: 'RUN_TEST' } }),
      ),
    );

    // Priority descending first, then insertion order for the tie between a and c.
    expect(unwrap(active.listRules(sessionId)).map((rule) => rule.id)).toEqual(['b', 'a', 'c']);
  });

  it('reads one rule back and reports an unknown one as 406 RULE NOT FOUND', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    const added = unwrap(active.addRule(sessionId, ruleInput()));

    expect(unwrap(active.getRule(sessionId, added.id)).name).toBe('ping-ok');
    expect(failureOf(active.getRule(sessionId, 'rule-nope')).statusCode).toBe(
      SLTP_STATUS.RULE_NOT_FOUND,
    );
  });

  it('applies a partial update and leaves untouched fields alone', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    const added = unwrap(active.addRule(sessionId, ruleInput({ name: 'original', priority: 1 })));

    const updated = unwrap(active.updateRule(sessionId, { id: added.id, enabled: false }));

    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe('original');
    expect(updated.priority).toBe(1);
    expect(updated.sequence).toBe(added.sequence);
    expect(updated.createdAt).toBe(added.createdAt);
  });

  it('reports an update to an unknown rule as 406 RULE NOT FOUND', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;

    const failure = failureOf(active.updateRule(sessionId, { id: 'rule-nope', enabled: false }));

    expect(failure.statusCode).toBe(SLTP_STATUS.RULE_NOT_FOUND);
  });

  it('refuses an update that would duplicate another rule name', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addRule(sessionId, ruleInput({ name: 'taken' })));
    const other = unwrap(
      active.addRule(sessionId, ruleInput({ name: 'free', match: { operation: 'RUN_TEST' } })),
    );

    const failure = failureOf(active.updateRule(sessionId, { id: other.id, name: 'taken' }));

    expect(failure.statusCode).toBe(SLTP_STATUS.RULE_CONFLICT);
  });

  it('refuses an update that would make two enabled rules ambiguous', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addRule(sessionId, ruleInput({ name: 'first', priority: 0 })));
    const other = unwrap(
      active.addRule(
        sessionId,
        ruleInput({ name: 'second', priority: 0, match: { operation: 'RUN_TEST' } }),
      ),
    );

    const failure = failureOf(
      active.updateRule(sessionId, { id: other.id, match: { operation: 'PING' } }),
    );

    expect(failure.statusCode).toBe(SLTP_STATUS.RULE_CONFLICT);
    // The rejected update must not have been applied.
    expect(unwrap(active.getRule(sessionId, other.id)).match.operation).toBe('RUN_TEST');
  });

  it('deletes a rule and returns the removed one', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    const added = unwrap(active.addRule(sessionId, ruleInput()));

    expect(unwrap(active.deleteRule(sessionId, added.id)).id).toBe(added.id);
    expect(unwrap(active.listRules(sessionId))).toEqual([]);
    expect(failureOf(active.deleteRule(sessionId, added.id)).statusCode).toBe(
      SLTP_STATUS.RULE_NOT_FOUND,
    );
  });

  it('reports rule operations on an unknown session as 404', async () => {
    const active = newStore();

    expect(failureOf(active.addRule('ses-nope', ruleInput())).statusCode).toBe(
      SLTP_STATUS.SESSION_NOT_FOUND,
    );
    expect(failureOf(active.listRules('ses-nope')).statusCode).toBe(SLTP_STATUS.SESSION_NOT_FOUND);
    expect(failureOf(active.deleteRule('ses-nope', 'rule-1')).statusCode).toBe(
      SLTP_STATUS.SESSION_NOT_FOUND,
    );
  });

  it('treats a closed session as read-only for rules', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    const added = unwrap(active.addRule(sessionId, ruleInput()));
    unwrap(await active.closeSession(sessionId));

    expect(failureOf(active.addRule(sessionId, ruleInput({ name: 'later' }))).statusCode).toBe(
      SLTP_STATUS.OPERATION_NOT_ALLOWED,
    );
    expect(failureOf(active.deleteRule(sessionId, added.id)).statusCode).toBe(
      SLTP_STATUS.OPERATION_NOT_ALLOWED,
    );
    // Reads still work, which is what "read-only" means.
    expect(unwrap(active.listRules(sessionId))).toHaveLength(1);
  });

  it('counts the rules of a session in its projection', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addRule(sessionId, ruleInput()));

    expect(unwrap(active.getSession(sessionId)).ruleCount).toBe(1);
  });
});

describe('results', () => {
  it('stores a result and reads it back', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    const result = testResult({ id: 'res-a', sessionId, scenarioName: 'ping' });

    expect(unwrap(active.addResult(sessionId, result)).id).toBe('res-a');
    expect(unwrap(active.getResult(sessionId, 'res-a')).scenarioName).toBe('ping');
    expect(unwrap(active.getSession(sessionId)).resultCount).toBe(1);
  });

  it('lists results oldest first', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addResult(sessionId, testResult({ id: 'res-a', sessionId })));
    unwrap(active.addResult(sessionId, testResult({ id: 'res-b', sessionId })));

    expect(unwrap(active.listResults(sessionId)).map((result) => result.id)).toEqual([
      'res-a',
      'res-b',
    ]);
  });

  it('answers 407 RESULT NOT FOUND for an unknown result', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;

    expect(failureOf(active.getResult(sessionId, 'res-nope')).statusCode).toBe(
      SLTP_STATUS.RESULT_NOT_FOUND,
    );
  });

  it('answers 404 for results of an unknown session', () => {
    const active = newStore();

    expect(failureOf(active.listResults('ses-nope')).statusCode).toBe(
      SLTP_STATUS.SESSION_NOT_FOUND,
    );
    expect(failureOf(active.addResult('ses-nope', testResult())).statusCode).toBe(
      SLTP_STATUS.SESSION_NOT_FOUND,
    );
  });

  it('discards the oldest result once the per-session cap is reached', async () => {
    const active = newStore({ maxResultsPerSession: 2 });
    const sessionId = unwrap(await active.createSession()).id;
    for (const id of ['res-1', 'res-2', 'res-3']) {
      unwrap(active.addResult(sessionId, testResult({ id, sessionId })));
    }

    expect(unwrap(active.listResults(sessionId)).map((result) => result.id)).toEqual([
      'res-2',
      'res-3',
    ]);
  });

  it('keeps results readable after the session is closed', async () => {
    const active = newStore();
    const sessionId = unwrap(await active.createSession()).id;
    unwrap(active.addResult(sessionId, testResult({ id: 'res-kept', sessionId })));
    unwrap(await active.closeSession(sessionId));

    expect(unwrap(active.getResult(sessionId, 'res-kept')).id).toBe('res-kept');
  });
});

describe('stats', () => {
  it('aggregates sessions, rules, and results across the store', async () => {
    const active = newStore();
    const first = unwrap(await active.createSession()).id;
    const second = unwrap(await active.createSession()).id;
    unwrap(active.addRule(first, ruleInput()));
    unwrap(active.addRule(second, ruleInput()));
    unwrap(active.addResult(first, testResult({ sessionId: first })));
    unwrap(await active.closeSession(second));

    expect(active.stats()).toMatchObject({
      sessions: 2,
      activeSessions: 1,
      rules: 2,
      results: 1,
      mockConnections: 0,
    });
  });

  it('reports every session closed after closeAll', async () => {
    const active = newStore();
    unwrap(await active.createSession());
    unwrap(await active.createSession());

    await active.closeAll();

    expect(active.stats().activeSessions).toBe(0);
    expect(active.listSessions().every((session) => session.state === 'closed')).toBe(true);
  });
});
