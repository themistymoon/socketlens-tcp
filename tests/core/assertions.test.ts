/**
 * Expected-versus-actual comparison.
 *
 * `evaluateExchange` is the only place a scenario's verdict is decided, so both
 * outcomes of every expectation form are covered here: the passing case proves the
 * check fires, and the failing case proves the report tells the user what went wrong.
 */
import { describe, expect, it } from 'vitest';
import { evaluateExchange, type ObservedExchange } from '@socketlens/core';
import { response } from '../helpers/fixtures.js';

/** An observation with nothing unusual about it, overridable field by field. */
function observed(overrides: Partial<ObservedExchange> = {}): ObservedExchange {
  return {
    timedOut: overrides.timedOut ?? false,
    disconnected: overrides.disconnected ?? false,
    ...(overrides.response !== undefined ? { response: overrides.response } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
  };
}

/** The single assertion recorded for `field`, failing loudly when it is absent. */
function assertionFor(
  evaluated: ReturnType<typeof evaluateExchange>,
  field: string,
): { field: string; passed: boolean; expected: string; actual: string; message?: string } {
  const found = evaluated.assertions.find((assertion) => assertion.field === field);
  if (!found) {
    throw new Error(
      `expected an assertion for "${field}" but found: ${evaluated.assertions
        .map((assertion) => assertion.field)
        .join(', ')}`,
    );
  }
  return found;
}

describe('evaluateExchange — no expectations', () => {
  it('passes when a well-formed response arrives and nothing was asserted', () => {
    const evaluated = evaluateExchange(undefined, observed({ response: response() }));

    expect(evaluated.outcome).toBe('passed');
    expect(evaluated.passed).toBe(true);
    expect(evaluated.assertions).toEqual([]);
  });

  it('passes for an empty expectation object too', () => {
    const evaluated = evaluateExchange({}, observed({ response: response() }));

    expect(evaluated.passed).toBe(true);
  });
});

describe('evaluateExchange — status line', () => {
  it('passes when the status code matches', () => {
    const evaluated = evaluateExchange(
      { statusCode: 200 },
      observed({ response: response({ statusCode: 200 }) }),
    );

    expect(evaluated.passed).toBe(true);
    expect(assertionFor(evaluated, 'statusCode')).toEqual({
      field: 'statusCode',
      passed: true,
      expected: '200',
      actual: '200',
    });
  });

  it('fails and reports expected versus actual when the status code differs', () => {
    const evaluated = evaluateExchange(
      { statusCode: 404 },
      observed({ response: response({ statusCode: 200 }) }),
    );

    expect(evaluated.outcome).toBe('failed');
    expect(evaluated.passed).toBe(false);
    expect(assertionFor(evaluated, 'statusCode')).toMatchObject({
      passed: false,
      expected: '404',
      actual: '200',
      message: 'Expected "404" but received "200".',
    });
  });

  it('compares the status phrase exactly', () => {
    const arrived = response({ statusCode: 410, statusPhrase: 'NO MATCHING RULE' });

    expect(
      evaluateExchange({ statusPhrase: 'NO MATCHING RULE' }, observed({ response: arrived }))
        .passed,
    ).toBe(true);

    const wrong = evaluateExchange(
      { statusPhrase: 'no matching rule' },
      observed({ response: arrived }),
    );
    expect(wrong.passed).toBe(false);
    expect(assertionFor(wrong, 'statusPhrase')).toMatchObject({
      expected: 'no matching rule',
      actual: 'NO MATCHING RULE',
    });
  });

  it('records one assertion per aspect when several are checked', () => {
    const evaluated = evaluateExchange(
      { statusCode: 200, statusPhrase: 'OK' },
      observed({ response: response({ statusCode: 200, statusPhrase: 'OK' }) }),
    );

    expect(evaluated.assertions.map((assertion) => assertion.field)).toEqual([
      'statusCode',
      'statusPhrase',
    ]);
  });
});

describe('evaluateExchange — headers', () => {
  it('matches a header regardless of the casing the peer used', () => {
    const evaluated = evaluateExchange(
      { headers: { 'content-type': 'application/json' } },
      observed({ response: response({ headers: { 'Content-Type': 'application/json' } }) }),
    );

    expect(evaluated.passed).toBe(true);
    expect(assertionFor(evaluated, 'headers.content-type').actual).toBe('application/json');
  });

  it('fails with a distinct message when the header is absent altogether', () => {
    const evaluated = evaluateExchange(
      { headers: { 'X-Trace': 'abc' } },
      observed({ response: response() }),
    );

    expect(evaluated.passed).toBe(false);
    expect(assertionFor(evaluated, 'headers.X-Trace')).toMatchObject({
      passed: false,
      expected: 'abc',
      actual: '(absent)',
      message: 'The response carries no X-Trace header.',
    });
  });

  it('fails with expected versus actual when the header value is wrong', () => {
    const evaluated = evaluateExchange(
      { headers: { 'X-Trace': 'abc' } },
      observed({ response: response({ headers: { 'X-Trace': 'xyz' } }) }),
    );

    expect(assertionFor(evaluated, 'headers.X-Trace')).toMatchObject({
      passed: false,
      actual: 'xyz',
      message: 'Expected "abc" but received "xyz".',
    });
  });

  it('checks every expected header, not just the first failure', () => {
    const evaluated = evaluateExchange(
      { headers: { 'X-One': '1', 'X-Two': '2' } },
      observed({ response: response({ headers: { 'X-One': 'wrong' } }) }),
    );

    expect(evaluated.assertions.map((assertion) => assertion.field)).toEqual([
      'headers.X-One',
      'headers.X-Two',
    ]);
    expect(evaluated.assertions.every((assertion) => !assertion.passed)).toBe(true);
  });
});

describe('evaluateExchange — body', () => {
  it('compares the whole body when expect.body is set', () => {
    const arrived = response({ body: '{"pong":true}' });

    expect(
      evaluateExchange({ body: '{"pong":true}' }, observed({ response: arrived })).passed,
    ).toBe(true);
    expect(
      evaluateExchange({ body: '{"pong":false}' }, observed({ response: arrived })).passed,
    ).toBe(false);
  });

  it('passes when bodyContains finds the substring', () => {
    const evaluated = evaluateExchange(
      { bodyContains: 'pong' },
      observed({ response: response({ body: '{"pong":true}' }) }),
    );

    expect(evaluated.passed).toBe(true);
    expect(assertionFor(evaluated, 'bodyContains')).toMatchObject({
      passed: true,
      expected: 'a body containing "pong"',
      actual: '{"pong":true}',
    });
  });

  it('fails bodyContains and shows the body it did search', () => {
    const evaluated = evaluateExchange(
      { bodyContains: 'pong' },
      observed({ response: response({ body: 'nothing here' }) }),
    );

    expect(evaluated.passed).toBe(false);
    expect(assertionFor(evaluated, 'bodyContains')).toMatchObject({
      passed: false,
      actual: 'nothing here',
      message: 'The substring was not found in the response body.',
    });
  });

  it('describes an empty body rather than showing nothing', () => {
    const evaluated = evaluateExchange(
      { bodyContains: 'pong' },
      observed({ response: response({ body: '' }) }),
    );

    expect(assertionFor(evaluated, 'bodyContains').actual).toBe('(empty body)');
  });

  it('truncates a very long body in the report', () => {
    const body = 'x'.repeat(500);
    const evaluated = evaluateExchange(
      { bodyContains: 'pong' },
      observed({ response: response({ body }) }),
    );

    const actual = assertionFor(evaluated, 'bodyContains').actual;
    expect(actual.length).toBeLessThan(body.length);
    expect(actual).toContain('500 characters total');
  });

  it('accepts a body that is a JSON superset of the expectation', () => {
    const evaluated = evaluateExchange(
      { jsonSubset: { ok: true, detail: { count: 2 } } },
      observed({ response: response({ body: '{"ok":true,"detail":{"count":2},"extra":1}' }) }),
    );

    expect(evaluated.passed).toBe(true);
  });

  it('fails jsonSubset when a key is missing', () => {
    const evaluated = evaluateExchange(
      { jsonSubset: { ok: true } },
      observed({ response: response({ body: '{"ok":false}' }) }),
    );

    expect(assertionFor(evaluated, 'jsonSubset')).toMatchObject({
      passed: false,
      expected: '{"ok":true}',
      message: 'The response body does not contain every expected key and value.',
    });
  });

  it('reports a body that is not JSON at all as a parse failure', () => {
    const evaluated = evaluateExchange(
      { jsonSubset: { ok: true } },
      observed({ response: response({ body: 'plain text' }) }),
    );

    const assertion = assertionFor(evaluated, 'jsonSubset');
    expect(assertion.passed).toBe(false);
    expect(assertion.actual).toContain('body is not valid JSON');
    expect(assertion.message).toBe('The response body could not be parsed as JSON.');
  });
});

describe('evaluateExchange — timeout as an expected outcome', () => {
  it('passes when the timeout the scenario expected actually happened', () => {
    const evaluated = evaluateExchange({ timeout: true }, observed({ timedOut: true }));

    expect(evaluated.outcome).toBe('passed');
    expect(evaluated.passed).toBe(true);
    expect(assertionFor(evaluated, 'timeout')).toEqual({
      field: 'timeout',
      passed: true,
      expected: 'no response before the timeout',
      actual: 'no response before the timeout',
    });
  });

  it('fails when a response arrived despite an expected timeout', () => {
    const evaluated = evaluateExchange(
      { timeout: true },
      observed({ response: response({ statusCode: 200, statusPhrase: 'OK' }) }),
    );

    expect(evaluated.outcome).toBe('failed');
    expect(assertionFor(evaluated, 'timeout')).toMatchObject({
      passed: false,
      actual: '200 OK',
      message: 'A response arrived, but the scenario expected a timeout.',
    });
  });

  it('settles arrival first and skips every content assertion', () => {
    const evaluated = evaluateExchange(
      { timeout: true, bodyContains: 'pong' },
      observed({ timedOut: true }),
    );

    expect(evaluated.assertions.map((assertion) => assertion.field)).toEqual(['timeout']);
  });

  it('reports an unexpected timeout as the timeout outcome, not a plain failure', () => {
    const evaluated = evaluateExchange({ statusCode: 200 }, observed({ timedOut: true }));

    expect(evaluated.outcome).toBe('timeout');
    expect(evaluated.passed).toBe(false);
    expect(assertionFor(evaluated, 'response')).toMatchObject({
      passed: false,
      expected: 'a complete SLTP response',
      actual: 'no response before the timeout',
    });
  });
});

describe('evaluateExchange — disconnect as an expected outcome', () => {
  it('passes when the peer closed mid-message as expected', () => {
    const evaluated = evaluateExchange({ disconnect: true }, observed({ disconnected: true }));

    expect(evaluated.outcome).toBe('passed');
    expect(assertionFor(evaluated, 'disconnect')).toMatchObject({
      passed: true,
      expected: 'the peer closes before a complete message arrives',
      actual: 'the peer closed the connection mid-message',
    });
  });

  it('fails when a complete response arrived instead of a disconnect', () => {
    const evaluated = evaluateExchange(
      { disconnect: true },
      observed({ response: response({ statusCode: 500, statusPhrase: 'INTERNAL SERVER ERROR' }) }),
    );

    expect(evaluated.passed).toBe(false);
    expect(assertionFor(evaluated, 'disconnect')).toMatchObject({
      passed: false,
      actual: '500 INTERNAL SERVER ERROR',
      message: 'The connection did not close mid-message as the scenario expected.',
    });
  });

  it('fails an expected disconnect that timed out instead', () => {
    const evaluated = evaluateExchange({ disconnect: true }, observed({ timedOut: true }));

    expect(evaluated.passed).toBe(false);
    expect(assertionFor(evaluated, 'disconnect').actual).toBe('no response before the timeout');
  });

  it('reports an unexpected disconnect as a failure', () => {
    const evaluated = evaluateExchange({ statusCode: 200 }, observed({ disconnected: true }));

    expect(evaluated.outcome).toBe('failed');
    expect(assertionFor(evaluated, 'response').actual).toBe(
      'the peer closed the connection mid-message',
    );
  });
});

describe('evaluateExchange — no response at all', () => {
  it('reports the error outcome when nothing could be framed', () => {
    const evaluated = evaluateExchange(
      { statusCode: 200 },
      observed({ error: 'malformed start line' }),
    );

    expect(evaluated.outcome).toBe('error');
    expect(evaluated.passed).toBe(false);
    expect(evaluated.error).toBe('malformed start line');
    expect(assertionFor(evaluated, 'response')).toMatchObject({
      actual: 'malformed start line',
      message: 'malformed start line',
    });
  });

  it('falls back to a generic explanation when no error was captured', () => {
    const evaluated = evaluateExchange({ statusCode: 200 }, observed());

    expect(evaluated.outcome).toBe('error');
    expect(assertionFor(evaluated, 'response')).toMatchObject({
      actual: 'no response was parsed',
      message: 'No SLTP response could be framed from the received bytes.',
    });
  });

  it('carries a transport error through even when the verdict is a pass', () => {
    const evaluated = evaluateExchange(
      { timeout: true },
      observed({ timedOut: true, error: 'read ECONNRESET' }),
    );

    expect(evaluated.passed).toBe(true);
    expect(evaluated.error).toBe('read ECONNRESET');
  });
});
