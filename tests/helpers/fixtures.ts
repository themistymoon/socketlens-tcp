/**
 * Object builders for the unit tests.
 *
 * The unit tests in `tests/core` and `tests/cli` exercise pure functions that take
 * already-decoded messages and stored domain objects. Building those by hand in every
 * test buries the one field that matters under a dozen that do not, so each builder
 * here supplies a plausible default and lets a test override only what it is about.
 *
 * Header lists are built verbatim rather than through `toHeaderList`, because several
 * tests depend on the exact casing a peer put on the wire.
 */
import {
  SLTP_VERSION_TOKEN,
  type SltpHeaderField,
  type SltpRequest,
  type SltpResponse,
} from '@socketlens/protocol';
import type { AssertionResult, MockRule, TestResult, WireSegment } from '@socketlens/core';

/** Builds a header list, preserving the exact spelling of every field name. */
export function fields(headers: Readonly<Record<string, string>>): SltpHeaderField[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/** A decoded request, as the decoder would hand it to the matcher. */
export function request(
  overrides: Partial<Omit<SltpRequest, 'kind' | 'headers'>> & {
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): SltpRequest {
  const body = overrides.body ?? '';
  return {
    kind: 'request',
    version: overrides.version ?? SLTP_VERSION_TOKEN,
    operation: overrides.operation ?? 'PING',
    headers: fields(overrides.headers ?? {}),
    body,
    bodyBytes: overrides.bodyBytes ?? Buffer.byteLength(body, 'utf8'),
  };
}

/** A decoded response, as the decoder would hand it to the assertion evaluator. */
export function response(
  overrides: Partial<Omit<SltpResponse, 'kind' | 'headers'>> & {
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): SltpResponse {
  const body = overrides.body ?? '';
  return {
    kind: 'response',
    version: overrides.version ?? SLTP_VERSION_TOKEN,
    statusCode: overrides.statusCode ?? 200,
    statusPhrase: overrides.statusPhrase ?? 'OK',
    headers: fields(overrides.headers ?? {}),
    body,
    bodyBytes: overrides.bodyBytes ?? Buffer.byteLength(body, 'utf8'),
  };
}

/**
 * A stored mock rule.
 *
 * `sequence` defaults to 1 so that a test which cares about tie-breaking has to state
 * the sequence explicitly, rather than depending on a hidden counter.
 */
export function mockRule(overrides: Partial<MockRule> = {}): MockRule {
  const id = overrides.id ?? 'rule-1';
  return {
    id,
    name: overrides.name ?? id,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 0,
    match: overrides.match ?? { operation: 'PING' },
    response: overrides.response ?? { statusCode: 200, statusPhrase: 'OK' },
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    sequence: overrides.sequence ?? 1,
    hitCount: overrides.hitCount ?? 0,
  };
}

/** One observed TCP write or read. */
export function segment(overrides: Partial<WireSegment> = {}): WireSegment {
  const data = overrides.data ?? 'SLTP/1.0 PING\r\n\r\n';
  return {
    direction: overrides.direction ?? 'sent',
    atMs: overrides.atMs ?? 0,
    bytes: overrides.bytes ?? Buffer.byteLength(data, 'utf8'),
    data,
  };
}

/** One assertion outcome. */
export function assertion(overrides: Partial<AssertionResult> = {}): AssertionResult {
  return {
    field: overrides.field ?? 'statusCode',
    passed: overrides.passed ?? true,
    expected: overrides.expected ?? '200',
    actual: overrides.actual ?? '200',
    ...(overrides.message !== undefined ? { message: overrides.message } : {}),
  };
}

/** A stored test result, for the renderer and for result serialisation. */
export function testResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: overrides.id ?? 'res-1',
    sessionId: overrides.sessionId ?? 'ses-1',
    scenarioName: overrides.scenarioName ?? 'ping the mock endpoint',
    outcome: overrides.outcome ?? 'passed',
    passed: overrides.passed ?? true,
    startedAt: overrides.startedAt ?? '2026-01-01T00:00:00.000Z',
    durationMs: overrides.durationMs ?? 7,
    assertions: overrides.assertions ?? [],
    rawSent: overrides.rawSent ?? 'SLTP/1.0 PING\r\nRequest-ID: req-1\r\n\r\n',
    rawReceived: overrides.rawReceived ?? 'SLTP/1.0 200 OK\r\nRequest-ID: req-1\r\n\r\n',
    ...(overrides.response !== undefined ? { response: overrides.response } : {}),
    ...(overrides.matchedRuleId !== undefined ? { matchedRuleId: overrides.matchedRuleId } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    segments: overrides.segments ?? [],
    sentSegmentCount: overrides.sentSegmentCount ?? 1,
    receivedSegmentCount: overrides.receivedSegmentCount ?? 1,
    responseCount: overrides.responseCount ?? 1,
  };
}
