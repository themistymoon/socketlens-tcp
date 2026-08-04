/**
 * Mock rule matching.
 *
 * Ordering is deterministic and total, which matters because a testing tool whose
 * mock responses depend on insertion timing is useless for reproducing a bug.
 *
 * Evaluation order:
 *   1. priority, descending  — the explicit control the user has
 *   2. sequence, ascending   — insertion order, so earlier rules win ties
 *
 * The first enabled rule whose match specification is satisfied produces the
 * response; no later rule is consulted. When nothing matches, the endpoint answers
 * 410 NO MATCHING RULE.
 */
import type { MockRule, RuleMatch } from './models.js';
import type { SltpRequest } from '@socketlens/protocol';
import { getHeader } from '@socketlens/protocol';

/** The outcome of evaluating a request against a rule set. */
export interface MatchOutcome {
  readonly rule: MockRule | undefined;
  /** Rules that were considered, in evaluation order, with the reason each failed. */
  readonly trace: readonly {
    readonly ruleId: string;
    readonly matched: boolean;
    readonly reason: string;
  }[];
}

/**
 * Sorts rules into the exact order the matcher evaluates them.
 * Exposed so that LIST_RULES can show the user the true evaluation order.
 */
export function orderRules(rules: readonly MockRule[]): MockRule[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.sequence - b.sequence;
  });
}

/** Finds the first enabled rule matching `request`, with a trace of the decision. */
export function matchRule(request: SltpRequest, rules: readonly MockRule[]): MatchOutcome {
  const trace: { ruleId: string; matched: boolean; reason: string }[] = [];

  for (const rule of orderRules(rules)) {
    if (!rule.enabled) {
      trace.push({ ruleId: rule.id, matched: false, reason: 'rule is disabled' });
      continue;
    }
    const reason = explainMatch(request, rule.match);
    if (reason === null) {
      trace.push({ ruleId: rule.id, matched: true, reason: 'matched' });
      return { rule, trace };
    }
    trace.push({ ruleId: rule.id, matched: false, reason });
  }

  return { rule: undefined, trace };
}

/**
 * Returns `null` when `request` satisfies `match`, or a human-readable reason why
 * it does not. Returning the reason is what makes the rule trace useful for debugging.
 */
export function explainMatch(request: SltpRequest, match: RuleMatch): string | null {
  if (match.operation !== '*' && match.operation !== request.operation) {
    return `operation ${request.operation} does not equal ${match.operation}`;
  }

  if (match.headers) {
    for (const [name, expected] of Object.entries(match.headers)) {
      const actual = getHeader(request.headers, name);
      if (actual === undefined) return `header ${name} is absent`;
      if (actual !== expected) {
        return `header ${name} is "${actual}", expected "${expected}"`;
      }
    }
  }

  if (match.body) {
    const { mode, value } = match.body;
    switch (mode) {
      case 'exact':
        if (request.body !== value) return 'body does not equal the expected value';
        break;
      case 'contains':
        if (!request.body.includes(value)) return 'body does not contain the expected substring';
        break;
      case 'json-subset': {
        let expectedJson: unknown;
        let actualJson: unknown;
        try {
          expectedJson = JSON.parse(value);
        } catch {
          return 'rule body matcher is not valid JSON';
        }
        try {
          actualJson = JSON.parse(request.body);
        } catch {
          return 'request body is not valid JSON';
        }
        if (!isJsonSubset(expectedJson, actualJson)) {
          return 'body is not a superset of the expected JSON';
        }
        break;
      }
      case 'regex': {
        let pattern: RegExp;
        try {
          pattern = new RegExp(value);
        } catch {
          return 'rule body matcher is not a valid regular expression';
        }
        if (!pattern.test(request.body)) return 'body does not match the regular expression';
        break;
      }
    }
  }

  return null;
}

/**
 * True when every key and value in `expected` is present in `actual`, recursively.
 * Arrays must match element for element; extra keys in `actual` are permitted.
 */
export function isJsonSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(expected, actual);
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((entry, index) => isJsonSubset(entry, actual[index]));
  }

  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;

  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(
    ([key, value]) => key in actualRecord && isJsonSubset(value, actualRecord[key]),
  );
}

/**
 * A canonical string form of a match specification.
 *
 * Two rules whose canonical forms are equal would fire on exactly the same requests,
 * so adding the second at the same priority as the first makes matching ambiguous.
 * That is the condition the server reports as 409 RULE CONFLICT.
 */
export function canonicalMatchKey(match: RuleMatch): string {
  const headers = Object.entries(match.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return JSON.stringify({
    operation: match.operation,
    headers,
    body: match.body ? { mode: match.body.mode, value: match.body.value } : null,
  });
}

/** True when two match specifications would fire on exactly the same requests. */
export function matchesAreEquivalent(a: RuleMatch, b: RuleMatch): boolean {
  return canonicalMatchKey(a) === canonicalMatchKey(b);
}
