/**
 * Semantic validation of client-supplied rules and scenarios.
 *
 * These validators run after framing and JSON parsing have already succeeded, so what
 * they enforce is meaning rather than syntax. The design promise is that every problem
 * in a submission is reported at once, so several tests assert on the whole problem
 * list rather than only the first entry.
 */
import { describe, expect, it } from 'vitest';
import { MAX_RESPONSE_DELAY_MS } from '@socketlens/protocol';
import {
  MAX_FRAGMENT_COUNT,
  MAX_SCENARIO_TIMEOUT_MS,
  validateAddRuleInput,
  validateScenario,
  validateUpdateRuleInput,
  type Validated,
} from '@socketlens/core';

/** The value of a passing validation, or a loud failure listing the problems. */
function valueOf<T>(validated: Validated<T>): T {
  if (!validated.ok) {
    throw new Error(
      `expected validation to pass but it reported: ${validated.problems.join(' | ')}`,
    );
  }
  return validated.value;
}

/** The problems of a failing validation, or a loud failure. */
function problemsOf<T>(validated: Validated<T>): readonly string[] {
  if (validated.ok) throw new Error('expected validation to fail but it passed');
  return validated.problems;
}

/** A rule body that validates cleanly, overridable field by field. */
function ruleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'ping-ok',
    match: { operation: 'PING' },
    response: { statusCode: 200, statusPhrase: 'OK' },
    ...overrides,
  };
}

/** A scenario body that validates cleanly. */
function scenarioBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'ping', request: { operation: 'PING' }, ...overrides };
}

describe('validateAddRuleInput — defaults and normalisation', () => {
  it('fills in enabled and priority and trims the name', () => {
    const rule = valueOf(validateAddRuleInput(ruleBody({ name: '  spaced  ' })));

    expect(rule.name).toBe('spaced');
    expect(rule.enabled).toBe(true);
    expect(rule.priority).toBe(0);
    expect(rule.id).toBeUndefined();
  });

  it('keeps a supplied id, enabled flag, and priority', () => {
    const rule = valueOf(
      validateAddRuleInput(ruleBody({ id: 'my.rule-1', enabled: false, priority: -3 })),
    );

    expect(rule).toMatchObject({ id: 'my.rule-1', enabled: false, priority: -3 });
  });

  it('omits an empty header map rather than storing one', () => {
    const rule = valueOf(
      validateAddRuleInput(ruleBody({ match: { operation: 'PING', headers: {} } })),
    );

    expect(rule.match.headers).toBeUndefined();
  });

  it('accepts "*" as the operation and preserves a body matcher', () => {
    const rule = valueOf(
      validateAddRuleInput(
        ruleBody({ match: { operation: '*', body: { mode: 'contains', value: 'needle' } } }),
      ),
    );

    expect(rule.match.operation).toBe('*');
    expect(rule.match.body).toEqual({ mode: 'contains', value: 'needle' });
  });

  it('preserves the response fragmentation and disconnect controls', () => {
    const rule = valueOf(
      validateAddRuleInput(
        ruleBody({
          response: {
            statusCode: 200,
            statusPhrase: 'OK',
            body: '{}',
            delayMs: 50,
            fragment: { sizes: [10, 20], delayMs: 5 },
            disconnectAfterBytes: 0,
          },
        }),
      ),
    );

    expect(rule.response).toMatchObject({
      delayMs: 50,
      fragment: { sizes: [10, 20], delayMs: 5 },
      disconnectAfterBytes: 0,
    });
  });
});

describe('validateAddRuleInput — rejections', () => {
  it('rejects a non-object body', () => {
    expect(problemsOf(validateAddRuleInput('not an object'))).toEqual([
      'Request body must be a JSON object.',
    ]);
    expect(problemsOf(validateAddRuleInput([]))).toHaveLength(1);
    expect(problemsOf(validateAddRuleInput(null))).toHaveLength(1);
  });

  it('requires a non-empty name', () => {
    expect(problemsOf(validateAddRuleInput(ruleBody({ name: '   ' })))).toContain(
      'name must be a non-empty string.',
    );
  });

  it('constrains the shape of a supplied id', () => {
    expect(problemsOf(validateAddRuleInput(ruleBody({ id: 'has spaces' })))).toContain(
      'id must match [A-Za-z0-9._:-]{1,64} when supplied.',
    );
  });

  it('requires enabled and priority to have the right types', () => {
    const problems = problemsOf(validateAddRuleInput(ruleBody({ enabled: 'yes', priority: 1.5 })));

    expect(problems).toContain('enabled must be a boolean.');
    expect(problems).toContain('priority must be an integer.');
  });

  it('rejects an operation token that is not uppercase', () => {
    expect(problemsOf(validateAddRuleInput(ruleBody({ match: { operation: 'ping' } })))).toContain(
      'match.operation "ping" is not a valid operation token.',
    );
  });

  it('rejects a missing match and a missing response together', () => {
    const problems = problemsOf(validateAddRuleInput({ name: 'incomplete' }));

    expect(problems).toContain('match must be an object.');
    expect(problems).toContain('response must be an object.');
  });

  it('rejects an unknown body match mode', () => {
    const problems = problemsOf(
      validateAddRuleInput(
        ruleBody({ match: { operation: 'PING', body: { mode: 'glob', value: 'x' } } }),
      ),
    );

    expect(problems[0]).toContain('match.body.mode must be one of:');
  });

  it('rejects a regex matcher that will not compile', () => {
    const problems = problemsOf(
      validateAddRuleInput(
        ruleBody({ match: { operation: 'PING', body: { mode: 'regex', value: '([unclosed' } } }),
      ),
    );

    expect(problems[0]).toContain('match.body.value is not a valid regular expression');
  });

  it('rejects a json-subset matcher that is not JSON', () => {
    expect(
      problemsOf(
        validateAddRuleInput(
          ruleBody({ match: { operation: 'PING', body: { mode: 'json-subset', value: '{oops' } } }),
        ),
      ),
    ).toContain('match.body.value must be valid JSON when mode is "json-subset".');
  });

  it('rejects a header value outside printable US-ASCII', () => {
    expect(
      problemsOf(
        validateAddRuleInput(
          ruleBody({ match: { operation: 'PING', headers: { 'X-Th': 'ทดสอบ' } } }),
        ),
      ),
    ).toContain('match.headers.X-Th contains characters outside printable US-ASCII.');
  });

  it('rejects an invalid header name', () => {
    expect(
      problemsOf(
        validateAddRuleInput(
          ruleBody({ match: { operation: 'PING', headers: { 'Bad Header': 'v' } } }),
        ),
      ),
    ).toContain('match.headers.Bad Header is not a valid SLTP header name.');
  });

  it('rejects a status code outside 100-599', () => {
    expect(
      problemsOf(
        validateAddRuleInput(ruleBody({ response: { statusCode: 99, statusPhrase: 'X' } })),
      ),
    ).toContain('response.statusCode must be between 100 and 599.');
  });

  it('rejects an empty or non-ASCII status phrase', () => {
    expect(
      problemsOf(
        validateAddRuleInput(ruleBody({ response: { statusCode: 200, statusPhrase: '' } })),
      ),
    ).toContain('response.statusPhrase must be a non-empty string.');

    expect(
      problemsOf(
        validateAddRuleInput(ruleBody({ response: { statusCode: 200, statusPhrase: 'ตกลง' } })),
      ),
    ).toContain('response.statusPhrase must contain only printable US-ASCII characters.');
  });

  it('rejects a structured response body, directing the client to JSON text', () => {
    expect(
      problemsOf(
        validateAddRuleInput(
          ruleBody({ response: { statusCode: 200, statusPhrase: 'OK', body: { ok: true } } }),
        ),
      ),
    ).toContain('response.body must be a string. Encode structured data as JSON text.');
  });

  it('bounds the response delay', () => {
    expect(
      problemsOf(
        validateAddRuleInput(
          ruleBody({ response: { statusCode: 200, statusPhrase: 'OK', delayMs: -1 } }),
        ),
      ),
    ).toContain('response.delayMs must not be negative.');

    expect(
      problemsOf(
        validateAddRuleInput(
          ruleBody({
            response: { statusCode: 200, statusPhrase: 'OK', delayMs: MAX_RESPONSE_DELAY_MS + 1 },
          }),
        ),
      ),
    ).toContain(`response.delayMs must not exceed ${MAX_RESPONSE_DELAY_MS} ms.`);
  });

  it('requires fragment sizes to be positive integers', () => {
    const problems = problemsOf(
      validateAddRuleInput(
        ruleBody({
          response: { statusCode: 200, statusPhrase: 'OK', fragment: { sizes: [10, 0, -2] } },
        }),
      ),
    );

    expect(problems).toContain(
      'response.fragment.sizes[1] must be a positive integer number of bytes.',
    );
    expect(problems).toContain(
      'response.fragment.sizes[2] must be a positive integer number of bytes.',
    );
  });

  it('rejects an empty fragment size list', () => {
    expect(
      problemsOf(
        validateAddRuleInput(
          ruleBody({ response: { statusCode: 200, statusPhrase: 'OK', fragment: { sizes: [] } } }),
        ),
      ),
    ).toContain('response.fragment.sizes must not be empty.');
  });

  it('reports several unrelated problems in one pass', () => {
    const problems = problemsOf(
      validateAddRuleInput({
        name: '',
        enabled: 'no',
        match: { operation: 'lowercase' },
        response: { statusCode: 'two hundred' },
      }),
    );

    expect(problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe('validateUpdateRuleInput', () => {
  it('accepts a patch that changes one field', () => {
    expect(valueOf(validateUpdateRuleInput({ id: 'rule-1', enabled: false }))).toEqual({
      id: 'rule-1',
      enabled: false,
    });
  });

  it('trims a new name', () => {
    expect(valueOf(validateUpdateRuleInput({ id: 'rule-1', name: '  renamed ' })).name).toBe(
      'renamed',
    );
  });

  it('requires an id, and reports only that when it is missing', () => {
    expect(problemsOf(validateUpdateRuleInput({ enabled: false }))).toEqual([
      'id must identify the rule to update.',
    ]);
  });

  it('refuses a patch that changes nothing', () => {
    expect(problemsOf(validateUpdateRuleInput({ id: 'rule-1' }))).toEqual([
      'UPDATE_RULE must change at least one field.',
    ]);
  });

  it('validates a replacement match and response as strictly as on creation', () => {
    const problems = problemsOf(
      validateUpdateRuleInput({
        id: 'rule-1',
        match: { operation: 'lowercase' },
        response: { statusCode: 700, statusPhrase: 'NOPE' },
      }),
    );

    expect(problems).toContain('match.operation "lowercase" is not a valid operation token.');
    expect(problems).toContain('response.statusCode must be between 100 and 599.');
  });

  it('rejects a non-object patch', () => {
    expect(problemsOf(validateUpdateRuleInput(42))).toEqual([
      'Request body must be a JSON object.',
    ]);
  });
});

describe('validateScenario — requests', () => {
  it('accepts a minimal structural request', () => {
    const scenario = valueOf(validateScenario(scenarioBody()));

    expect(scenario).toEqual({ name: 'ping', request: { operation: 'PING' } });
  });

  it('trims the scenario name', () => {
    expect(valueOf(validateScenario(scenarioBody({ name: '  ping  ' }))).name).toBe('ping');
  });

  it('accepts a raw request and ignores everything alongside it', () => {
    const scenario = valueOf(
      validateScenario(
        scenarioBody({
          request: { raw: 'SLTP/1.0 PING\\r\\n\\r\\n', operation: 'IGNORED', body: 'x' },
        }),
      ),
    );

    expect(scenario.request).toEqual({ raw: 'SLTP/1.0 PING\\r\\n\\r\\n' });
  });

  it('requires either an operation or raw bytes', () => {
    expect(problemsOf(validateScenario(scenarioBody({ request: {} })))).toContain(
      'request must supply either "operation" or "raw".',
    );
  });

  it('rejects an empty raw request', () => {
    expect(problemsOf(validateScenario(scenarioBody({ request: { raw: '' } })))).toContain(
      'request.raw must be a non-empty string when supplied.',
    );
  });

  it('rejects a name that is only whitespace', () => {
    expect(problemsOf(validateScenario(scenarioBody({ name: '  ' })))).toContain(
      'name must be a non-empty string.',
    );
  });

  it('validates an explicit target address', () => {
    expect(
      valueOf(validateScenario(scenarioBody({ target: { host: '127.0.0.1', port: 9000 } }))).target,
    ).toEqual({ host: '127.0.0.1', port: 9000 });

    expect(
      problemsOf(validateScenario(scenarioBody({ target: { host: '127.0.0.1', port: 0 } }))),
    ).toContain('target.port must be an integer between 1 and 65535.');
  });

  it('bounds the scenario timeout', () => {
    expect(valueOf(validateScenario(scenarioBody({ timeoutMs: 1_000 }))).timeoutMs).toBe(1_000);
    expect(problemsOf(validateScenario(scenarioBody({ timeoutMs: 0 })))).toContain(
      'timeoutMs must be a positive integer.',
    );
    expect(
      problemsOf(validateScenario(scenarioBody({ timeoutMs: MAX_SCENARIO_TIMEOUT_MS + 1 }))),
    ).toContain(`timeoutMs must not exceed ${MAX_SCENARIO_TIMEOUT_MS} ms.`);
  });

  it('leaves timeoutMs unset when the scenario does not ask for one', () => {
    expect(valueOf(validateScenario(scenarioBody())).timeoutMs).toBeUndefined();
  });
});

describe('validateScenario — transmission', () => {
  it('accepts a single write with no extra fields', () => {
    expect(
      valueOf(validateScenario(scenarioBody({ transmission: { mode: 'single' } }))).transmission,
    ).toEqual({ mode: 'single' });
  });

  it('rejects an unknown transmission mode', () => {
    expect(
      problemsOf(validateScenario(scenarioBody({ transmission: { mode: 'dribble' } })))[0],
    ).toContain('transmission.mode must be one of:');
  });

  it('requires a fragmented scenario to say how to fragment', () => {
    expect(
      problemsOf(validateScenario(scenarioBody({ transmission: { mode: 'fragmented' } }))),
    ).toContain('transmission.mode "fragmented" requires either fragmentSizes or fragmentCount.');
  });

  it('requires a coalesced scenario to supply the second message', () => {
    expect(
      problemsOf(validateScenario(scenarioBody({ transmission: { mode: 'coalesced' } }))),
    ).toContain('transmission.mode "coalesced" requires transmission.coalesceWith.');
  });

  it('validates the coalesced second message as a request in its own right', () => {
    expect(
      problemsOf(
        validateScenario(
          scenarioBody({
            transmission: { mode: 'coalesced', coalesceWith: { operation: 'lower' } },
          }),
        ),
      ),
    ).toContain('transmission.coalesceWith.operation "lower" is not a valid operation token.');
  });

  it('bounds fragmentCount at both ends', () => {
    expect(
      problemsOf(
        validateScenario(scenarioBody({ transmission: { mode: 'fragmented', fragmentCount: 1 } })),
      ),
    ).toContain('transmission.fragmentCount must be an integer of at least 2.');

    expect(
      problemsOf(
        validateScenario(
          scenarioBody({
            transmission: { mode: 'fragmented', fragmentCount: MAX_FRAGMENT_COUNT + 1 },
          }),
        ),
      ),
    ).toContain(`transmission.fragmentCount must not exceed ${MAX_FRAGMENT_COUNT}.`);
  });

  it('bounds the number of explicit fragment sizes', () => {
    expect(
      problemsOf(
        validateScenario(
          scenarioBody({
            transmission: {
              mode: 'fragmented',
              fragmentSizes: Array.from({ length: MAX_FRAGMENT_COUNT + 1 }, () => 1),
            },
          }),
        ),
      ),
    ).toContain(
      `transmission.fragmentSizes must not contain more than ${MAX_FRAGMENT_COUNT} entries.`,
    );
  });

  it('accepts an inter-fragment delay and a mid-request disconnect', () => {
    const scenario = valueOf(
      validateScenario(
        scenarioBody({
          transmission: {
            mode: 'fragmented',
            fragmentSizes: [5, 7],
            interFragmentDelayMs: 10,
            disconnectAfterBytes: 12,
          },
        }),
      ),
    );

    expect(scenario.transmission).toEqual({
      mode: 'fragmented',
      fragmentSizes: [5, 7],
      interFragmentDelayMs: 10,
      disconnectAfterBytes: 12,
    });
  });

  it('rejects a negative disconnectAfterBytes', () => {
    expect(
      problemsOf(
        validateScenario(
          scenarioBody({ transmission: { mode: 'single', disconnectAfterBytes: -1 } }),
        ),
      ),
    ).toContain('transmission.disconnectAfterBytes must be a non-negative integer.');
  });
});

describe('validateScenario — expectations', () => {
  it('keeps every recognised expectation field', () => {
    const scenario = valueOf(
      validateScenario(
        scenarioBody({
          expect: {
            statusCode: 200,
            statusPhrase: 'OK',
            headers: { 'Content-Type': 'application/json' },
            bodyContains: 'pong',
            jsonSubset: { ok: true },
          },
        }),
      ),
    );

    expect(scenario.expect).toEqual({
      statusCode: 200,
      statusPhrase: 'OK',
      headers: { 'Content-Type': 'application/json' },
      bodyContains: 'pong',
      jsonSubset: { ok: true },
    });
  });

  it('rejects a status code outside the SLTP range', () => {
    expect(problemsOf(validateScenario(scenarioBody({ expect: { statusCode: 600 } })))).toContain(
      'expect.statusCode must be an integer between 100 and 599.',
    );
  });

  it('rejects a timeout expectation combined with a status code', () => {
    expect(
      problemsOf(validateScenario(scenarioBody({ expect: { timeout: true, statusCode: 200 } }))),
    ).toContain(
      'expect.timeout and expect.statusCode are contradictory: a timeout means no response arrived.',
    );
  });

  it('rejects expecting both a timeout and a disconnect', () => {
    expect(
      problemsOf(validateScenario(scenarioBody({ expect: { timeout: true, disconnect: true } }))),
    ).toContain('expect.timeout and expect.disconnect are contradictory outcomes.');
  });

  it('rejects a disconnect expectation combined with a status code', () => {
    expect(
      problemsOf(validateScenario(scenarioBody({ expect: { disconnect: true, statusCode: 200 } }))),
    ).toContain(
      'expect.disconnect and expect.statusCode are contradictory: a disconnect means no complete response arrived.',
    );
  });

  it('rejects using body and bodyContains together', () => {
    expect(
      problemsOf(validateScenario(scenarioBody({ expect: { body: 'a', bodyContains: 'a' } }))),
    ).toContain('Use either expect.body or expect.bodyContains, not both.');
  });

  it('accepts a bare timeout expectation on its own', () => {
    expect(valueOf(validateScenario(scenarioBody({ expect: { timeout: true } }))).expect).toEqual({
      timeout: true,
    });
  });

  it('requires jsonSubset to be an object', () => {
    expect(
      problemsOf(validateScenario(scenarioBody({ expect: { jsonSubset: [1, 2] } }))),
    ).toContain('expect.jsonSubset must be an object.');
  });

  it('rejects a non-object scenario outright', () => {
    expect(problemsOf(validateScenario('nope'))).toEqual(['Scenario must be a JSON object.']);
  });
});
