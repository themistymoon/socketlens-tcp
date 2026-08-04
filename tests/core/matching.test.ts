/**
 * Mock rule ordering and matching.
 *
 * The ordering tests are the important ones. A mock whose chosen rule depends on the
 * order the rules happened to be inserted cannot reproduce a bug twice, so priority
 * and the insertion sequence tie-breaker are asserted explicitly rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalMatchKey,
  explainMatch,
  isJsonSubset,
  matchRule,
  matchesAreEquivalent,
  orderRules,
} from '@socketlens/core';
import { mockRule, request } from '../helpers/fixtures.js';

describe('explainMatch — operations', () => {
  it('matches an operation token exactly', () => {
    expect(explainMatch(request({ operation: 'PING' }), { operation: 'PING' })).toBeNull();
  });

  it('matches any operation when the specification is "*"', () => {
    expect(explainMatch(request({ operation: 'ADD_RULE' }), { operation: '*' })).toBeNull();
    expect(explainMatch(request({ operation: 'RUN_TEST' }), { operation: '*' })).toBeNull();
  });

  it('reports the operation mismatch rather than failing silently', () => {
    const reason = explainMatch(request({ operation: 'PING' }), { operation: 'RUN_TEST' });

    expect(reason).toBe('operation PING does not equal RUN_TEST');
  });

  it('does not treat the operation as case-insensitive', () => {
    expect(explainMatch(request({ operation: 'PING' }), { operation: 'ping' })).not.toBeNull();
  });
});

describe('explainMatch — headers', () => {
  it('matches a header whose name differs only in casing', () => {
    const reason = explainMatch(request({ headers: { 'X-Trace': 'abc' } }), {
      operation: '*',
      headers: { 'x-trace': 'abc' },
    });

    expect(reason).toBeNull();
  });

  it('requires every named header to be present', () => {
    const reason = explainMatch(request({ headers: { 'X-Trace': 'abc' } }), {
      operation: '*',
      headers: { 'X-Trace': 'abc', 'X-Other': 'def' },
    });

    expect(reason).toBe('header X-Other is absent');
  });

  it('compares header values exactly and quotes both sides', () => {
    const reason = explainMatch(request({ headers: { 'X-Trace': 'abc' } }), {
      operation: '*',
      headers: { 'X-Trace': 'ABC' },
    });

    expect(reason).toBe('header X-Trace is "abc", expected "ABC"');
  });

  it('matches any headers when the specification lists none', () => {
    const reason = explainMatch(request({ headers: { 'X-Trace': 'abc' } }), { operation: '*' });

    expect(reason).toBeNull();
  });
});

describe('explainMatch — body modes', () => {
  it('accepts an exact body and rejects a near miss', () => {
    const spec = { operation: '*', body: { mode: 'exact' as const, value: 'hello' } };

    expect(explainMatch(request({ body: 'hello' }), spec)).toBeNull();
    expect(explainMatch(request({ body: 'hello ' }), spec)).toBe(
      'body does not equal the expected value',
    );
  });

  it('accepts a body containing the substring', () => {
    const spec = { operation: '*', body: { mode: 'contains' as const, value: 'needle' } };

    expect(explainMatch(request({ body: 'a needle in a haystack' }), spec)).toBeNull();
    expect(explainMatch(request({ body: 'only hay' }), spec)).toBe(
      'body does not contain the expected substring',
    );
  });

  it('accepts a body that is a superset of the expected JSON', () => {
    const spec = {
      operation: '*',
      body: { mode: 'json-subset' as const, value: '{"a":1}' },
    };

    expect(explainMatch(request({ body: '{"a":1,"b":2}' }), spec)).toBeNull();
    expect(explainMatch(request({ body: '{"b":2}' }), spec)).toBe(
      'body is not a superset of the expected JSON',
    );
  });

  it('distinguishes an unparseable request body from an unparseable matcher', () => {
    expect(
      explainMatch(request({ body: 'not json' }), {
        operation: '*',
        body: { mode: 'json-subset', value: '{"a":1}' },
      }),
    ).toBe('request body is not valid JSON');

    expect(
      explainMatch(request({ body: '{"a":1}' }), {
        operation: '*',
        body: { mode: 'json-subset', value: '{oops' },
      }),
    ).toBe('rule body matcher is not valid JSON');
  });

  it('applies a regular expression to the body', () => {
    const spec = { operation: '*', body: { mode: 'regex' as const, value: '^id-[0-9]+$' } };

    expect(explainMatch(request({ body: 'id-42' }), spec)).toBeNull();
    expect(explainMatch(request({ body: 'id-x' }), spec)).toBe(
      'body does not match the regular expression',
    );
  });

  it('reports an invalid regular expression instead of throwing', () => {
    const reason = explainMatch(request({ body: 'anything' }), {
      operation: '*',
      body: { mode: 'regex', value: '([unclosed' },
    });

    expect(reason).toBe('rule body matcher is not a valid regular expression');
  });

  it('checks the operation before the body', () => {
    const reason = explainMatch(request({ operation: 'PING', body: 'wrong' }), {
      operation: 'RUN_TEST',
      body: { mode: 'exact', value: 'right' },
    });

    expect(reason).toBe('operation PING does not equal RUN_TEST');
  });
});

describe('orderRules — deterministic evaluation order', () => {
  it('sorts by priority descending', () => {
    const rules = [
      mockRule({ id: 'low', priority: 1, sequence: 1 }),
      mockRule({ id: 'high', priority: 10, sequence: 2 }),
      mockRule({ id: 'mid', priority: 5, sequence: 3 }),
    ];

    expect(orderRules(rules).map((rule) => rule.id)).toEqual(['high', 'mid', 'low']);
  });

  it('breaks a priority tie by insertion sequence, ascending', () => {
    const rules = [
      mockRule({ id: 'third', priority: 5, sequence: 3 }),
      mockRule({ id: 'first', priority: 5, sequence: 1 }),
      mockRule({ id: 'second', priority: 5, sequence: 2 }),
    ];

    expect(orderRules(rules).map((rule) => rule.id)).toEqual(['first', 'second', 'third']);
  });

  it('applies priority before sequence when the two disagree', () => {
    // The later-inserted rule wins because its priority is higher.
    const rules = [
      mockRule({ id: 'early-low', priority: 0, sequence: 1 }),
      mockRule({ id: 'late-high', priority: 9, sequence: 2 }),
    ];

    expect(orderRules(rules).map((rule) => rule.id)).toEqual(['late-high', 'early-low']);
  });

  it('orders negative priorities below zero', () => {
    const rules = [
      mockRule({ id: 'fallback', priority: -10, sequence: 1 }),
      mockRule({ id: 'normal', priority: 0, sequence: 2 }),
    ];

    expect(orderRules(rules).map((rule) => rule.id)).toEqual(['normal', 'fallback']);
  });

  it('produces the same order regardless of the order it was given', () => {
    const a = mockRule({ id: 'a', priority: 5, sequence: 1 });
    const b = mockRule({ id: 'b', priority: 5, sequence: 2 });
    const c = mockRule({ id: 'c', priority: 7, sequence: 3 });

    expect(orderRules([a, b, c]).map((rule) => rule.id)).toEqual(['c', 'a', 'b']);
    expect(orderRules([c, b, a]).map((rule) => rule.id)).toEqual(['c', 'a', 'b']);
    expect(orderRules([b, a, c]).map((rule) => rule.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the array it was given', () => {
    const rules = [
      mockRule({ id: 'low', priority: 1, sequence: 1 }),
      mockRule({ id: 'high', priority: 9, sequence: 2 }),
    ];

    orderRules(rules);

    expect(rules.map((rule) => rule.id)).toEqual(['low', 'high']);
  });
});

describe('matchRule', () => {
  it('returns no rule and an empty trace for an empty rule set', () => {
    const outcome = matchRule(request({ operation: 'PING' }), []);

    expect(outcome.rule).toBeUndefined();
    expect(outcome.trace).toEqual([]);
  });

  it('chooses the highest-priority matching rule', () => {
    const rules = [
      mockRule({ id: 'low', priority: 1, sequence: 1, match: { operation: 'PING' } }),
      mockRule({ id: 'high', priority: 8, sequence: 2, match: { operation: 'PING' } }),
    ];

    expect(matchRule(request({ operation: 'PING' }), rules).rule?.id).toBe('high');
  });

  it('breaks a tie between two equally matching rules by insertion sequence', () => {
    const rules = [
      mockRule({ id: 'later', priority: 3, sequence: 2, match: { operation: 'PING' } }),
      mockRule({ id: 'earlier', priority: 3, sequence: 1, match: { operation: 'PING' } }),
    ];

    expect(matchRule(request({ operation: 'PING' }), rules).rule?.id).toBe('earlier');
  });

  it('stops at the first match and never consults later rules', () => {
    const rules = [
      mockRule({ id: 'first', priority: 5, sequence: 1, match: { operation: '*' } }),
      mockRule({ id: 'second', priority: 5, sequence: 2, match: { operation: 'PING' } }),
    ];

    const outcome = matchRule(request({ operation: 'PING' }), rules);

    expect(outcome.rule?.id).toBe('first');
    expect(outcome.trace.map((entry) => entry.ruleId)).toEqual(['first']);
  });

  it('skips a disabled rule and records why', () => {
    const rules = [
      mockRule({
        id: 'disabled',
        enabled: false,
        priority: 9,
        sequence: 1,
        match: { operation: 'PING' },
      }),
      mockRule({ id: 'enabled', priority: 1, sequence: 2, match: { operation: 'PING' } }),
    ];

    const outcome = matchRule(request({ operation: 'PING' }), rules);

    expect(outcome.rule?.id).toBe('enabled');
    expect(outcome.trace[0]).toEqual({
      ruleId: 'disabled',
      matched: false,
      reason: 'rule is disabled',
    });
  });

  it('traces every rule it rejected, in evaluation order', () => {
    const rules = [
      mockRule({ id: 'wrong-op', priority: 9, sequence: 1, match: { operation: 'RUN_TEST' } }),
      mockRule({
        id: 'wrong-header',
        priority: 5,
        sequence: 2,
        match: { operation: 'PING', headers: { 'X-Trace': 'yes' } },
      }),
      mockRule({ id: 'catch-all', priority: 0, sequence: 3, match: { operation: '*' } }),
    ];

    const outcome = matchRule(request({ operation: 'PING' }), rules);

    expect(outcome.rule?.id).toBe('catch-all');
    expect(outcome.trace).toEqual([
      { ruleId: 'wrong-op', matched: false, reason: 'operation PING does not equal RUN_TEST' },
      { ruleId: 'wrong-header', matched: false, reason: 'header X-Trace is absent' },
      { ruleId: 'catch-all', matched: true, reason: 'matched' },
    ]);
  });

  it('returns no rule when every rule was considered and rejected', () => {
    const rules = [
      mockRule({ id: 'a', sequence: 1, match: { operation: 'RUN_TEST' } }),
      mockRule({ id: 'b', sequence: 2, enabled: false, match: { operation: '*' } }),
    ];

    const outcome = matchRule(request({ operation: 'PING' }), rules);

    expect(outcome.rule).toBeUndefined();
    expect(outcome.trace.map((entry) => entry.matched)).toEqual([false, false]);
  });
});

describe('isJsonSubset', () => {
  it('permits extra keys in the actual object', () => {
    expect(isJsonSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it('recurses into nested objects', () => {
    expect(isJsonSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true);
    expect(isJsonSubset({ a: { b: 1 } }, { a: { c: 2 } })).toBe(false);
  });

  it('requires arrays to match element for element', () => {
    expect(isJsonSubset([1, 2], [1, 2])).toBe(true);
    expect(isJsonSubset([1, 2], [1, 2, 3])).toBe(false);
    expect(isJsonSubset([1, 2], [2, 1])).toBe(false);
  });

  it('does not treat an array as an object or the reverse', () => {
    expect(isJsonSubset({ 0: 'a' }, ['a'])).toBe(false);
    expect(isJsonSubset(['a'], { 0: 'a' })).toBe(false);
  });

  it('compares primitives strictly', () => {
    expect(isJsonSubset(1, 1)).toBe(true);
    expect(isJsonSubset(1, '1')).toBe(false);
    expect(isJsonSubset(true, true)).toBe(true);
    expect(isJsonSubset(null, null)).toBe(true);
    expect(isJsonSubset(null, {})).toBe(false);
  });

  it('accepts an empty expectation against any object', () => {
    expect(isJsonSubset({}, { a: 1 })).toBe(true);
  });
});

describe('canonicalMatchKey and matchesAreEquivalent', () => {
  it('treats header names case-insensitively', () => {
    expect(
      matchesAreEquivalent(
        { operation: 'PING', headers: { 'X-Trace': 'a' } },
        { operation: 'PING', headers: { 'x-trace': 'a' } },
      ),
    ).toBe(true);
  });

  it('ignores the order headers were written in', () => {
    expect(
      matchesAreEquivalent(
        { operation: 'PING', headers: { A: '1', B: '2' } },
        { operation: 'PING', headers: { B: '2', A: '1' } },
      ),
    ).toBe(true);
  });

  it('treats an absent header map and an empty one as the same', () => {
    expect(matchesAreEquivalent({ operation: 'PING' }, { operation: 'PING', headers: {} })).toBe(
      true,
    );
  });

  it('distinguishes different operations', () => {
    expect(matchesAreEquivalent({ operation: 'PING' }, { operation: '*' })).toBe(false);
  });

  it('distinguishes header values', () => {
    expect(
      matchesAreEquivalent(
        { operation: 'PING', headers: { A: '1' } },
        { operation: 'PING', headers: { A: '2' } },
      ),
    ).toBe(false);
  });

  it('distinguishes body match modes carrying the same value', () => {
    expect(
      matchesAreEquivalent(
        { operation: 'PING', body: { mode: 'exact', value: 'x' } },
        { operation: 'PING', body: { mode: 'contains', value: 'x' } },
      ),
    ).toBe(false);
  });

  it('distinguishes a body condition from no body condition', () => {
    expect(
      matchesAreEquivalent(
        { operation: 'PING' },
        { operation: 'PING', body: { mode: 'exact', value: '' } },
      ),
    ).toBe(false);
  });

  it('produces a stable string key for equal specifications', () => {
    const key = canonicalMatchKey({ operation: 'PING', headers: { 'X-A': '1' } });

    expect(typeof key).toBe('string');
    expect(canonicalMatchKey({ operation: 'PING', headers: { 'x-a': '1' } })).toBe(key);
  });
});
