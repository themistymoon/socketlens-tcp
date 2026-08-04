/**
 * Server behaviour over a real TCP connection.
 *
 * These tests drive the actual `node:net` listener with the shared SLTP client, so
 * they cover framing, dispatch, status selection, and lifecycle together.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SLTP_STATUS, SLTP_VERSION_TOKEN } from '@socketlens/protocol';
import type { Session, TestResult } from '@socketlens/core';
import {
  addPingRule,
  createSession,
  jsonBody,
  startHarness,
  type Harness,
} from '../helpers/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe('PING and SERVER_INFO', () => {
  it('answers PING with 200 OK and echoes the supplied value', async () => {
    harness = await startHarness();
    const client = await harness.client();

    const exchange = await client.send({ operation: 'PING', json: { echo: 'hello' } });

    expect(exchange.response.statusCode).toBe(SLTP_STATUS.OK);
    expect(exchange.response.statusPhrase).toBe('OK');
    expect(jsonBody<{ message: string; echo: string }>(exchange)).toMatchObject({
      message: 'pong',
      echo: 'hello',
      protocol: SLTP_VERSION_TOKEN,
    });
  });

  it('correlates the response to the request by Request-ID', async () => {
    harness = await startHarness();
    const client = await harness.client();

    const exchange = await client.send({ operation: 'PING' });

    expect(exchange.response.headers.find((h) => h.name === 'Request-ID')?.value).toBe(
      exchange.requestId,
    );
  });

  it('reports the operation and status registries in SERVER_INFO', async () => {
    harness = await startHarness();
    const client = await harness.client();

    const info = jsonBody<{
      operations: { name: string }[];
      statuses: { code: number }[];
      capabilities: string[];
    }>(await client.send({ operation: 'SERVER_INFO' }));

    expect(info.operations.map((o) => o.name)).toContain('RUN_TEST');
    expect(info.statuses.map((s) => s.code)).toContain(SLTP_STATUS.TEST_FAILED);
    expect(info.capabilities).toContain('coalesced-transmission');
  });

  it('answers concurrent requests on one connection out of arrival order', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, {
      name: 'slow-ping',
      response: { statusCode: 200, statusPhrase: 'OK', body: '{}', delayMs: 200 },
    });

    // The slow RUN_TEST is sent first; the PING behind it must not wait for it.
    const slow = client.send({
      operation: 'RUN_TEST',
      sessionId,
      timeoutMs: 8_000,
      json: { scenario: { name: 'slow', request: { operation: 'PING' }, timeoutMs: 3_000 } },
    });
    const fast = await client.send({ operation: 'PING' });

    expect(fast.response.statusCode).toBe(SLTP_STATUS.OK);
    await expect(slow).resolves.toMatchObject({
      response: { statusCode: SLTP_STATUS.TEST_PASSED },
    });
  });
});

describe('sessions', () => {
  it('creates a session with its own ephemeral mock endpoint', async () => {
    harness = await startHarness();
    const client = await harness.client();

    const created = await client.send({ operation: 'CREATE_SESSION', json: { name: 'demo' } });
    const session = jsonBody<{ session: Session }>(created).session;

    expect(created.response.statusCode).toBe(SLTP_STATUS.SESSION_CREATED);
    expect(created.response.statusPhrase).toBe('SESSION CREATED');
    expect(session.name).toBe('demo');
    expect(session.state).toBe('active');
    expect(session.mockHost).toBe('127.0.0.1');
    expect(session.mockPort).toBeGreaterThan(0);
    // The identifier is repeated in the header so a client can correlate without parsing.
    expect(created.response.headers.find((h) => h.name === 'Session-ID')?.value).toBe(session.id);
  });

  it('gives each session a distinct mock endpoint port', async () => {
    harness = await startHarness();
    const client = await harness.client();

    const first = await client.send({ operation: 'CREATE_SESSION' });
    const second = await client.send({ operation: 'CREATE_SESSION' });

    expect(jsonBody<{ session: Session }>(first).session.mockPort).not.toBe(
      jsonBody<{ session: Session }>(second).session.mockPort,
    );
  });

  it('returns 404 SESSION NOT FOUND for an unknown session', async () => {
    harness = await startHarness();
    const client = await harness.client();

    const exchange = await client.send({ operation: 'GET_SESSION', sessionId: 'ses-missing' });

    expect(exchange.response.statusCode).toBe(SLTP_STATUS.SESSION_NOT_FOUND);
    expect(exchange.response.statusPhrase).toBe('SESSION NOT FOUND');
  });

  it('lists created sessions', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client, 'listed');

    const listed = jsonBody<{ count: number; sessions: Session[] }>(
      await client.send({ operation: 'LIST_SESSIONS' }),
    );

    expect(listed.count).toBe(1);
    expect(listed.sessions[0]?.id).toBe(sessionId);
  });

  it('closes a session and then refuses further operations on it with 405', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const closed = await client.send({ operation: 'CLOSE_SESSION', sessionId });
    expect(closed.response.statusCode).toBe(SLTP_STATUS.SESSION_CLOSED);
    expect(jsonBody<{ session: Session }>(closed).session.state).toBe('closed');

    const rejected = await client.send({
      operation: 'ADD_RULE',
      sessionId,
      json: {
        name: 'late',
        match: { operation: 'PING' },
        response: { statusCode: 200, statusPhrase: 'OK' },
      },
    });
    expect(rejected.response.statusCode).toBe(SLTP_STATUS.OPERATION_NOT_ALLOWED);
  });

  it('keeps results readable after the session closes', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId);
    await client.send({
      operation: 'RUN_TEST',
      sessionId,
      json: { scenario: { name: 'before close', request: { operation: 'PING' } } },
    });
    await client.send({ operation: 'CLOSE_SESSION', sessionId });

    const listed = jsonBody<{ count: number }>(
      await client.send({ operation: 'LIST_RESULTS', sessionId }),
    );

    expect(listed.count).toBe(1);
  });
});

describe('mock rules', () => {
  it('adds, lists, updates, and deletes a rule with the documented statuses', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const added = await client.send({
      operation: 'ADD_RULE',
      sessionId,
      json: {
        name: 'greeting',
        match: { operation: 'PING' },
        response: { statusCode: 200, statusPhrase: 'OK', body: 'hi' },
      },
    });
    expect(added.response.statusCode).toBe(SLTP_STATUS.RULE_ADDED);
    expect(added.response.statusPhrase).toBe('RULE ADDED');
    const ruleId = jsonBody<{ rule: { id: string } }>(added).rule.id;

    const updated = await client.send({
      operation: 'UPDATE_RULE',
      sessionId,
      json: { id: ruleId, priority: 50, enabled: false },
    });
    expect(updated.response.statusCode).toBe(SLTP_STATUS.RULE_UPDATED);
    expect(jsonBody<{ rule: { priority: number; enabled: boolean } }>(updated).rule).toMatchObject({
      priority: 50,
      enabled: false,
    });

    const listed = jsonBody<{ count: number; rules: { id: string }[] }>(
      await client.send({ operation: 'LIST_RULES', sessionId }),
    );
    expect(listed.count).toBe(1);
    expect(listed.rules[0]?.id).toBe(ruleId);

    const deleted = await client.send({
      operation: 'DELETE_RULE',
      sessionId,
      json: { id: ruleId },
    });
    expect(deleted.response.statusCode).toBe(SLTP_STATUS.RULE_DELETED);
    expect(deleted.response.statusPhrase).toBe('RULE DELETED');
  });

  it('lists rules in matcher evaluation order: priority descending, then insertion', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    await addPingRule(client, sessionId, { name: 'low', priority: 1 });
    await addPingRule(client, sessionId, { name: 'high', priority: 9 });
    await addPingRule(client, sessionId, {
      name: 'also-high',
      priority: 9,
      match: { operation: 'SERVER_INFO' },
    });

    const listed = jsonBody<{ rules: { name: string }[] }>(
      await client.send({ operation: 'LIST_RULES', sessionId }),
    );

    expect(listed.rules.map((rule) => rule.name)).toEqual(['high', 'also-high', 'low']);
  });

  it('returns 409 RULE CONFLICT for a duplicate name', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, { name: 'same-name' });

    const conflict = await client.send({
      operation: 'ADD_RULE',
      sessionId,
      json: {
        name: 'same-name',
        match: { operation: 'SERVER_INFO' },
        response: { statusCode: 200, statusPhrase: 'OK' },
      },
    });

    expect(conflict.response.statusCode).toBe(SLTP_STATUS.RULE_CONFLICT);
    expect(conflict.response.statusPhrase).toBe('RULE CONFLICT');
  });

  it('returns 409 RULE CONFLICT for an identical match at the same priority', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, { name: 'first', priority: 5 });

    const conflict = await client.send({
      operation: 'ADD_RULE',
      sessionId,
      json: {
        name: 'second',
        priority: 5,
        match: { operation: 'PING' },
        response: { statusCode: 200, statusPhrase: 'OK' },
      },
    });

    expect(conflict.response.statusCode).toBe(SLTP_STATUS.RULE_CONFLICT);
  });

  it('allows the same match at a different priority, because ordering stays deterministic', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, { name: 'first', priority: 5 });

    const accepted = await client.send({
      operation: 'ADD_RULE',
      sessionId,
      json: {
        name: 'second',
        priority: 6,
        match: { operation: 'PING' },
        response: { statusCode: 200, statusPhrase: 'OK' },
      },
    });

    expect(accepted.response.statusCode).toBe(SLTP_STATUS.RULE_ADDED);
  });

  it('returns 406 RULE NOT FOUND when deleting an unknown rule', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const exchange = await client.send({
      operation: 'DELETE_RULE',
      sessionId,
      json: { id: 'rule-nope' },
    });

    expect(exchange.response.statusCode).toBe(SLTP_STATUS.RULE_NOT_FOUND);
  });

  it('returns 422 INVALID SCENARIO for a structurally invalid rule', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const exchange = await client.send({
      operation: 'ADD_RULE',
      sessionId,
      json: { name: '', match: {}, response: {} },
    });

    expect(exchange.response.statusCode).toBe(SLTP_STATUS.INVALID_SCENARIO);
    expect(exchange.response.statusPhrase).toBe('INVALID SCENARIO');
    expect(jsonBody<{ problems: string[] }>(exchange).problems.length).toBeGreaterThan(0);
  });
});

describe('results', () => {
  it('stores a result and retrieves it by identifier', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId);

    const run = await client.send({
      operation: 'RUN_TEST',
      sessionId,
      json: { scenario: { name: 'stored', request: { operation: 'PING' } } },
    });
    const resultId = jsonBody<{ result: TestResult }>(run).result.id;
    expect(run.response.headers.find((h) => h.name === 'Result-ID')?.value).toBe(resultId);

    const fetched = await client.send({
      operation: 'GET_RESULT',
      sessionId,
      json: { id: resultId },
    });

    expect(fetched.response.statusCode).toBe(SLTP_STATUS.OK);
    expect(jsonBody<{ result: TestResult }>(fetched).result.scenarioName).toBe('stored');
  });

  it('returns 407 RESULT NOT FOUND for an unknown result', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const exchange = await client.send({
      operation: 'GET_RESULT',
      sessionId,
      json: { id: 'res-nope' },
    });

    expect(exchange.response.statusCode).toBe(SLTP_STATUS.RESULT_NOT_FOUND);
  });

  it('summarises pass and fail counts in LIST_RESULTS', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId);

    await client.send({
      operation: 'RUN_TEST',
      sessionId,
      json: {
        scenario: { name: 'good', request: { operation: 'PING' }, expect: { statusCode: 200 } },
      },
    });
    await client.send({
      operation: 'RUN_TEST',
      sessionId,
      json: {
        scenario: { name: 'bad', request: { operation: 'PING' }, expect: { statusCode: 500 } },
      },
    });

    const listed = jsonBody<{ count: number; passed: number; failed: number }>(
      await client.send({ operation: 'LIST_RESULTS', sessionId }),
    );

    expect(listed).toMatchObject({ count: 2, passed: 1, failed: 1 });
  });
});
