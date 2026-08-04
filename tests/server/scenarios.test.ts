/**
 * RUN_TEST behaviour: what a scenario actually does to the TCP connection.
 *
 * Each test here drives a real socket against a session's own mock endpoint, so the
 * fragmentation, coalescing, delay, and disconnect behaviour is genuine transport
 * behaviour rather than a simulation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SLTP_STATUS } from '@socketlens/protocol';
import type { TestResult } from '@socketlens/core';
import {
  addPingRule,
  createSession,
  jsonBody,
  startHarness,
  type Harness,
} from '../helpers/harness.js';
import type { SltpClient } from '@socketlens/core';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** Runs one scenario and returns the stored result. */
async function run(
  client: SltpClient,
  sessionId: string,
  scenario: Record<string, unknown>,
): Promise<{ statusCode: number; result: TestResult }> {
  const exchange = await client.send({
    operation: 'RUN_TEST',
    sessionId,
    timeoutMs: 10_000,
    json: { scenario },
  });
  return {
    statusCode: exchange.response.statusCode,
    result: jsonBody<{ result: TestResult }>(exchange).result,
  };
}

describe('passing and failing tests', () => {
  it('answers 210 TEST PASSED when every assertion holds', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId);

    const { statusCode, result } = await run(client, sessionId, {
      name: 'passing ping',
      request: { operation: 'PING' },
      expect: { statusCode: 200, statusPhrase: 'OK', bodyContains: 'pong' },
    });

    expect(statusCode).toBe(SLTP_STATUS.TEST_PASSED);
    expect(result.outcome).toBe('passed');
    expect(result.passed).toBe(true);
    expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(result.response?.statusCode).toBe(200);
  });

  it('answers 211 TEST FAILED and reports expected versus actual', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId);

    const { statusCode, result } = await run(client, sessionId, {
      name: 'wrong status',
      request: { operation: 'PING' },
      expect: { statusCode: 404 },
    });

    expect(statusCode).toBe(SLTP_STATUS.TEST_FAILED);
    expect(result.passed).toBe(false);
    const failed = result.assertions.find((assertion) => !assertion.passed);
    expect(failed).toMatchObject({ field: 'statusCode', expected: '404', actual: '200' });
  });

  it('matches a JSON subset of the body', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, {
      name: 'json-rule',
      response: {
        statusCode: 200,
        statusPhrase: 'OK',
        body: '{"ok":true,"detail":{"count":2},"extra":"ignored"}',
      },
    });

    const { result } = await run(client, sessionId, {
      name: 'json subset',
      request: { operation: 'PING' },
      expect: { jsonSubset: { ok: true, detail: { count: 2 } } },
    });

    expect(result.passed).toBe(true);
  });

  it('reports 410 NO MATCHING RULE when no rule fires', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const { result } = await run(client, sessionId, {
      name: 'unmatched',
      request: { operation: 'PING' },
      expect: { statusCode: SLTP_STATUS.NO_MATCHING_RULE },
    });

    expect(result.passed).toBe(true);
    expect(result.response?.statusPhrase).toBe('NO MATCHING RULE');
  });

  it('records which rule produced the response', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    const ruleId = await addPingRule(client, sessionId);

    const { result } = await run(client, sessionId, {
      name: 'matched rule',
      request: { operation: 'PING' },
    });

    expect(result.matchedRuleId).toBe(ruleId);
  });
});

describe('TCP does not preserve message boundaries', () => {
  it('reassembles a request written as several TCP segments', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId);

    const { result } = await run(client, sessionId, {
      name: 'fragmented request',
      request: { operation: 'PING' },
      transmission: { mode: 'fragmented', fragmentSizes: [7, 5, 3], interFragmentDelayMs: 5 },
      expect: { statusCode: 200 },
    });

    expect(result.passed).toBe(true);
    // Four writes: three explicit sizes plus the remainder.
    const sent = result.segments.filter((segment) => segment.direction === 'sent');
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent[0]?.bytes).toBe(7);
    expect(sent[1]?.bytes).toBe(5);
    expect(sent[2]?.bytes).toBe(3);
  });

  it('splits two messages written in a single TCP write into two responses', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId);

    const { result } = await run(client, sessionId, {
      name: 'coalesced requests',
      request: { operation: 'PING' },
      transmission: { mode: 'coalesced', coalesceWith: { operation: 'PING' } },
      expect: { statusCode: 200 },
    });

    // One write carried two complete SLTP requests, and two responses came back.
    expect(result.segments.filter((segment) => segment.direction === 'sent')).toHaveLength(1);
    expect(result.responseCount).toBe(2);
    expect(result.passed).toBe(true);
  });

  it('reassembles a response the mock endpoint wrote in fragments', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, {
      name: 'fragmented-response',
      response: {
        statusCode: 200,
        statusPhrase: 'OK',
        body: '{"pong":true}',
        fragment: { sizes: [10, 10, 10], delayMs: 5 },
      },
    });

    const { result } = await run(client, sessionId, {
      name: 'fragmented response',
      request: { operation: 'PING' },
      expect: { statusCode: 200, bodyContains: 'pong' },
    });

    expect(result.passed).toBe(true);
    expect(result.receivedSegmentCount).toBeGreaterThan(1);
    expect(result.responseCount).toBe(1);
  });

  it('frames a body containing multi-byte UTF-8 split across segments', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    const body = JSON.stringify({ message: 'สวัสดี ทดสอบ TCP' });
    await addPingRule(client, sessionId, {
      name: 'utf8-rule',
      response: {
        statusCode: 200,
        statusPhrase: 'OK',
        body,
        // Deliberately small segments, so a Thai character is cut in half on the wire.
        fragment: { sizes: [30, 7, 3, 5] },
      },
    });

    const { result } = await run(client, sessionId, {
      name: 'utf8 body',
      request: { operation: 'PING' },
      expect: { body },
    });

    expect(result.passed).toBe(true);
    expect(result.response?.bodyBytes).toBe(Buffer.byteLength(body, 'utf8'));
    // The byte length exceeds the JavaScript string length, which is exactly why
    // Content-Length must be counted in bytes.
    expect(result.response?.bodyBytes).toBeGreaterThan(body.length);
  });
});

describe('delays, timeouts, and disconnects', () => {
  it('passes when a timeout was the expected outcome', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, {
      name: 'slow-rule',
      response: { statusCode: 200, statusPhrase: 'OK', body: '{}', delayMs: 1_500 },
    });

    const { statusCode, result } = await run(client, sessionId, {
      name: 'expected timeout',
      request: { operation: 'PING' },
      timeoutMs: 150,
      expect: { timeout: true },
    });

    expect(statusCode).toBe(SLTP_STATUS.TEST_PASSED);
    expect(result.outcome).toBe('passed');
    expect(result.rawReceived).toBe('');
  });

  it('answers 408 TEST TIMEOUT when the timeout was not expected', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, {
      name: 'slow-rule',
      response: { statusCode: 200, statusPhrase: 'OK', body: '{}', delayMs: 1_500 },
    });

    const { statusCode, result } = await run(client, sessionId, {
      name: 'unexpected timeout',
      request: { operation: 'PING' },
      timeoutMs: 150,
      expect: { statusCode: 200 },
    });

    expect(statusCode).toBe(SLTP_STATUS.TEST_TIMEOUT);
    expect(result.outcome).toBe('timeout');
    expect(result.passed).toBe(false);
  });

  it('records a response delay without failing when no timeout is expected', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, {
      name: 'delayed-rule',
      response: { statusCode: 200, statusPhrase: 'OK', body: '{}', delayMs: 120 },
    });

    const { result } = await run(client, sessionId, {
      name: 'delayed response',
      request: { operation: 'PING' },
      timeoutMs: 3_000,
      expect: { statusCode: 200 },
    });

    expect(result.passed).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
  });

  it('detects a peer that closes part-way through its own response', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId, {
      name: 'truncating-rule',
      response: {
        statusCode: 200,
        statusPhrase: 'OK',
        body: '{"pong":true}',
        disconnectAfterBytes: 25,
      },
    });

    const { result } = await run(client, sessionId, {
      name: 'peer dies mid-message',
      request: { operation: 'PING' },
      timeoutMs: 2_000,
      expect: { disconnect: true },
    });

    expect(result.passed).toBe(true);
    expect(result.rawReceived.length).toBeGreaterThan(0);
    expect(result.responseCount).toBe(0);
  });

  it('reports a scenario that abandons its own request mid-message', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId);

    const { result } = await run(client, sessionId, {
      name: 'client aborts mid-request',
      request: { operation: 'PING' },
      transmission: { mode: 'single', disconnectAfterBytes: 12 },
      timeoutMs: 1_000,
      expect: { disconnect: true },
    });

    expect(result.passed).toBe(true);
    expect(result.responseCount).toBe(0);
  });
});

describe('malformed messages', () => {
  it('answers a malformed Content-Length with 400 BAD REQUEST', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);
    await addPingRule(client, sessionId);

    const { result } = await run(client, sessionId, {
      name: 'invalid content-length',
      request: {
        raw: 'SLTP/1.0 PING\r\nRequest-ID: req-bad-len\r\nContent-Length: not-a-number\r\n\r\n',
      },
      timeoutMs: 2_000,
      expect: { statusCode: SLTP_STATUS.BAD_REQUEST },
    });

    expect(result.passed).toBe(true);
    expect(result.response?.statusPhrase).toBe('BAD REQUEST');
  });

  it('answers a negative Content-Length with 400 BAD REQUEST', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const { result } = await run(client, sessionId, {
      name: 'negative content-length',
      request: {
        raw: 'SLTP/1.0 PING\r\nRequest-ID: req-neg\r\nContent-Length: -5\r\n\r\n',
      },
      timeoutMs: 2_000,
      expect: { statusCode: SLTP_STATUS.BAD_REQUEST },
    });

    expect(result.passed).toBe(true);
  });

  it('answers a request with no Request-ID with 400 BAD REQUEST', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const { result } = await run(client, sessionId, {
      name: 'missing request id',
      request: { raw: 'SLTP/1.0 PING\r\n\r\n' },
      timeoutMs: 2_000,
      expect: { statusCode: SLTP_STATUS.BAD_REQUEST },
    });

    expect(result.passed).toBe(true);
    expect(result.response?.headers['reason']).toBe('missing-request-id');
  });

  it('rejects a scenario aimed at a host that is not a development endpoint', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const { statusCode, result } = await run(client, sessionId, {
      name: 'external target',
      request: { operation: 'PING' },
      target: { host: '93.184.216.34', port: 80 },
    });

    expect(statusCode).toBe(SLTP_STATUS.TEST_FAILED);
    expect(result.outcome).toBe('error');
    expect(result.error).toContain('not a permitted development endpoint');
  });

  it('returns 422 INVALID SCENARIO for a scenario the validator rejects', async () => {
    harness = await startHarness();
    const client = await harness.client();
    const sessionId = await createSession(client);

    const exchange = await client.send({
      operation: 'RUN_TEST',
      sessionId,
      json: { scenario: { name: '', request: {} } },
    });

    expect(exchange.response.statusCode).toBe(SLTP_STATUS.INVALID_SCENARIO);
    expect(jsonBody<{ problems: string[] }>(exchange).problems.length).toBeGreaterThan(0);
  });
});
