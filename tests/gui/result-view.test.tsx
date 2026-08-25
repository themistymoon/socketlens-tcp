// @vitest-environment jsdom
/**
 * Rendering tests for the result panel.
 *
 * These assert on what a viewer must be able to read off the screen during a
 * demonstration — the verdict, the numeric status code and its phrase, each assertion's
 * expected and actual values, and the observed write and read counts. They deliberately do
 * not assert on class names, element structure, or layout, so restyling the panel cannot
 * break them. What is checked is the information, not its presentation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { TestResult, TestResultSummary } from '@socketlens/core/models';
import { ResultView } from '../../apps/gui/src/components/ResultView.js';

afterEach(cleanup);

/** A passing result, with the fields the panel reads. */
function passingResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'res-1',
    sessionId: 'ses-1',
    scenarioName: 'basic-ping',
    outcome: 'passed',
    passed: true,
    startedAt: '2026-08-04T10:00:00.000Z',
    durationMs: 12,
    assertions: [
      { field: 'statusCode', passed: true, expected: '200', actual: '200' },
      { field: 'statusPhrase', passed: true, expected: 'OK', actual: 'OK' },
    ],
    rawSent: 'SLTP/1.0 PING\r\nRequest-ID: req-1\r\n\r\n',
    rawReceived: 'SLTP/1.0 200 OK\r\nRequest-ID: req-1\r\n\r\n',
    response: {
      statusCode: 200,
      statusPhrase: 'OK',
      headers: { 'Request-ID': 'req-1' },
      body: '',
      bodyBytes: 0,
    },
    segments: [
      { direction: 'sent', atMs: 0, bytes: 36, data: 'SLTP/1.0 PING\r\n' },
      { direction: 'received', atMs: 9, bytes: 48, data: 'SLTP/1.0 200 OK\r\n' },
    ],
    sentSegmentCount: 1,
    receivedSegmentCount: 1,
    responseCount: 1,
    ...overrides,
  };
}

describe('ResultView', () => {
  it('prompts for a run when there is no result yet', () => {
    render(<ResultView result={undefined} history={[]} onSelectResult={() => {}} />);
    expect(screen.getByText(/run a scenario/i)).toBeDefined();
    // With no result there is no verdict to show.
    expect(screen.queryByText('PASS')).toBeNull();
    expect(screen.queryByText('FAIL')).toBeNull();
  });

  it('shows PASS with the numeric status code and its phrase', () => {
    render(<ResultView result={passingResult()} history={[]} onSelectResult={() => {}} />);
    expect(screen.getByText('PASS')).toBeDefined();
    // The code and phrase are separate fields in SLTP, so both must be readable. Scope
    // to the Status entry: the digits also appear in the assertions table.
    const status = screen.getByText('Status').nextElementSibling;
    expect(status?.textContent).toContain('200');
    expect(status?.textContent).toContain('OK');
  });

  it('shows FAIL and the differing expected and actual values', () => {
    const failed = passingResult({
      outcome: 'failed',
      passed: false,
      assertions: [
        {
          field: 'statusCode',
          passed: false,
          expected: '200',
          actual: '404',
          message: 'The mock returned a different status.',
        },
      ],
      response: {
        statusCode: 404,
        statusPhrase: 'SESSION NOT FOUND',
        headers: {},
        body: '',
        bodyBytes: 0,
      },
    });

    render(<ResultView result={failed} history={[]} onSelectResult={() => {}} />);

    expect(screen.getByText('FAIL')).toBeDefined();
    // Both sides of the comparison must be present, not just the verdict.
    const row = screen.getByText(/statusCode/).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('200')).toBeDefined();
    expect(within(row!).getByText('404')).toBeDefined();
  });

  it('reports a timeout as its own outcome rather than as a plain failure', () => {
    const timedOut = passingResult({
      outcome: 'timeout',
      passed: false,
      response: undefined,
      error: 'No response within 2000 ms.',
      assertions: [],
      receivedSegmentCount: 0,
      responseCount: 0,
    });

    render(<ResultView result={timedOut} history={[]} onSelectResult={() => {}} />);

    expect(screen.getByText(/no complete response arrived before the deadline/i)).toBeDefined();
    expect(screen.getByText(/no response within 2000 ms/i)).toBeDefined();
  });

  it('reports two framed responses from a single read', () => {
    // This is the coalescing claim made visible: fewer reads than messages.
    const coalesced = passingResult({
      scenarioName: 'coalesced',
      receivedSegmentCount: 1,
      responseCount: 2,
    });

    render(<ResultView result={coalesced} history={[]} onSelectResult={() => {}} />);

    expect(screen.getByText(/1 read\(s\).*2 framed response\(s\)/)).toBeDefined();
  });

  it('lists earlier runs so a failed run stays reachable after a later pass', () => {
    const history: TestResultSummary[] = [
      {
        id: 'res-0',
        scenarioName: 'earlier-failure',
        outcome: 'failed',
        passed: false,
        startedAt: '2026-08-04T09:59:00.000Z',
        durationMs: 8,
        statusCode: 404,
        failedAssertions: 1,
      },
    ];

    render(<ResultView result={passingResult()} history={history} onSelectResult={() => {}} />);

    expect(screen.getByText(/earlier-failure/)).toBeDefined();
    expect(screen.getByText(/1 failed assertion\(s\)/)).toBeDefined();
  });
});
