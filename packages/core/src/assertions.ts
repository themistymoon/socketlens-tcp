/**
 * Expected-versus-actual comparison.
 *
 * A scenario declares what it expects; this module compares that declaration against
 * what actually came back over the TCP connection and produces one `AssertionResult`
 * per checked aspect. Every assertion is reported, passed or failed, so the user can
 * see exactly which part of the expectation was wrong rather than just "test failed".
 *
 * A scenario with no expectations at all still succeeds when a well-formed response
 * arrives — sending a message and seeing what comes back is a legitimate use of the
 * tool, not a test that vacuously passes.
 */
import type { AssertionResult, ScenarioExpectation, TestOutcome } from './models.js';
import { isJsonSubset } from './matching.js';
import { getHeader, type SltpResponse } from '@socketlens/protocol';

/** What actually happened during a scenario run. */
export interface ObservedExchange {
  /** The parsed response, when a complete SLTP response was framed. */
  readonly response?: SltpResponse;
  /** True when no complete response arrived before the scenario's timeout. */
  readonly timedOut: boolean;
  /** True when the peer closed the connection before a complete message arrived. */
  readonly disconnected: boolean;
  /** A framing or transport failure that prevented any response from being parsed. */
  readonly error?: string;
}

/** The verdict for one scenario execution. */
export interface EvaluatedExchange {
  readonly outcome: TestOutcome;
  readonly passed: boolean;
  readonly assertions: readonly AssertionResult[];
  readonly error?: string;
}

/**
 * Compares an expectation against what was observed.
 *
 * The order matters. Whether a response arrived at all is settled first, because
 * every content assertion is meaningless if there is nothing to assert against.
 */
export function evaluateExchange(
  expectation: ScenarioExpectation | undefined,
  observed: ObservedExchange,
): EvaluatedExchange {
  const expect = expectation ?? {};
  const assertions: AssertionResult[] = [];

  // ── 1. arrival: timeout, disconnect, or a response ─────────────────────────

  if (expect.timeout === true) {
    const passed = observed.timedOut;
    assertions.push({
      field: 'timeout',
      passed,
      expected: 'no response before the timeout',
      actual: describeArrival(observed),
      ...(passed ? {} : { message: 'A response arrived, but the scenario expected a timeout.' }),
    });
    return finish(assertions, observed, passed ? 'passed' : 'failed');
  }

  if (expect.disconnect === true) {
    const passed = observed.disconnected;
    assertions.push({
      field: 'disconnect',
      passed,
      expected: 'the peer closes before a complete message arrives',
      actual: describeArrival(observed),
      ...(passed
        ? {}
        : { message: 'The connection did not close mid-message as the scenario expected.' }),
    });
    return finish(assertions, observed, passed ? 'passed' : 'failed');
  }

  if (observed.timedOut) {
    assertions.push({
      field: 'response',
      passed: false,
      expected: 'a complete SLTP response',
      actual: 'no response before the timeout',
      message: 'The scenario timed out. Raise timeoutMs, or set expect.timeout to accept this.',
    });
    return finish(assertions, observed, 'timeout');
  }

  if (observed.disconnected) {
    assertions.push({
      field: 'response',
      passed: false,
      expected: 'a complete SLTP response',
      actual: 'the peer closed the connection mid-message',
      message: 'The connection closed before a complete response was framed.',
    });
    return finish(assertions, observed, 'failed');
  }

  const response = observed.response;
  if (!response) {
    assertions.push({
      field: 'response',
      passed: false,
      expected: 'a complete SLTP response',
      actual: observed.error ?? 'no response was parsed',
      message: observed.error ?? 'No SLTP response could be framed from the received bytes.',
    });
    return finish(assertions, observed, 'error');
  }

  // ── 2. start line ──────────────────────────────────────────────────────────

  if (expect.statusCode !== undefined) {
    assertions.push(compare('statusCode', String(expect.statusCode), String(response.statusCode)));
  }

  if (expect.statusPhrase !== undefined) {
    assertions.push(compare('statusPhrase', expect.statusPhrase, response.statusPhrase));
  }

  // ── 3. headers ─────────────────────────────────────────────────────────────

  for (const [name, expected] of Object.entries(expect.headers ?? {})) {
    const actual = getHeader(response.headers, name);
    assertions.push(
      compare(
        `headers.${name}`,
        expected,
        actual ?? '(absent)',
        actual === undefined ? `The response carries no ${name} header.` : undefined,
      ),
    );
  }

  // ── 4. body ────────────────────────────────────────────────────────────────

  if (expect.body !== undefined) {
    assertions.push(compare('body', expect.body, response.body));
  }

  if (expect.bodyContains !== undefined) {
    const passed = response.body.includes(expect.bodyContains);
    assertions.push({
      field: 'bodyContains',
      passed,
      expected: `a body containing "${expect.bodyContains}"`,
      actual: preview(response.body),
      ...(passed ? {} : { message: 'The substring was not found in the response body.' }),
    });
  }

  if (expect.jsonSubset !== undefined) {
    let parsed: unknown;
    let parseError: string | undefined;
    try {
      parsed = JSON.parse(response.body);
    } catch (cause) {
      parseError = cause instanceof Error ? cause.message : String(cause);
    }
    const passed = parseError === undefined && isJsonSubset(expect.jsonSubset, parsed);
    assertions.push({
      field: 'jsonSubset',
      passed,
      expected: JSON.stringify(expect.jsonSubset),
      actual: parseError ? `(body is not valid JSON: ${parseError})` : preview(response.body),
      ...(passed
        ? {}
        : {
            message: parseError
              ? 'The response body could not be parsed as JSON.'
              : 'The response body does not contain every expected key and value.',
          }),
    });
  }

  const allPassed = assertions.every((assertion) => assertion.passed);
  return finish(assertions, observed, allPassed ? 'passed' : 'failed');
}

function finish(
  assertions: readonly AssertionResult[],
  observed: ObservedExchange,
  outcome: TestOutcome,
): EvaluatedExchange {
  return {
    outcome,
    passed: outcome === 'passed',
    assertions,
    ...(observed.error ? { error: observed.error } : {}),
  };
}

function compare(
  field: string,
  expected: string,
  actual: string,
  message?: string,
): AssertionResult {
  const passed = expected === actual;
  return {
    field,
    passed,
    expected,
    actual,
    ...(passed ? {} : { message: message ?? `Expected "${expected}" but received "${actual}".` }),
  };
}

function describeArrival(observed: ObservedExchange): string {
  if (observed.timedOut) return 'no response before the timeout';
  if (observed.disconnected) return 'the peer closed the connection mid-message';
  if (observed.response) {
    return `${observed.response.statusCode} ${observed.response.statusPhrase}`;
  }
  return observed.error ?? 'no response';
}

function preview(body: string, maxChars = 200): string {
  if (body.length === 0) return '(empty body)';
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}… (${body.length} characters total)`;
}
