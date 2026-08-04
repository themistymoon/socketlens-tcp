/**
 * Expected versus actual, for the most recent scenario run.
 *
 * The segment list at the bottom is the part worth pointing at during a demonstration:
 * it shows the individual writes and reads, so a viewer can see one message arriving in
 * seven pieces, or two messages arriving in one.
 */
import type { ReactElement } from 'react';
import type { TestResult, TestResultSummary } from '@socketlens/core/models';
import { formatBytes, formatDuration, renderRawMessage } from '@socketlens/protocol/browser';

export interface ResultViewProps {
  readonly result: TestResult | undefined;
  readonly history: readonly TestResultSummary[];
  readonly onSelectResult: (resultId: string) => void;
}

/** A short, human explanation of why a run ended the way it did. */
function outcomeNote(result: TestResult): string {
  switch (result.outcome) {
    case 'passed':
      return 'Every assertion held.';
    case 'failed':
      return 'The exchange completed, but at least one assertion did not hold.';
    case 'timeout':
      return 'No complete response arrived before the deadline.';
    case 'error':
      return 'The exchange could not be completed.';
  }
}

export function ResultView({ result, history, onSelectResult }: ResultViewProps): ReactElement {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Result</h2>
        {result && (
          <span className={`verdict ${result.passed ? 'pass' : 'fail'}`}>
            {result.passed ? 'PASS' : 'FAIL'}
          </span>
        )}
      </header>

      {!result ? (
        <p className="empty">Run a scenario to see expected versus actual.</p>
      ) : (
        <>
          <dl className="facts">
            <dt>Scenario</dt>
            <dd>{result.scenarioName}</dd>
            <dt>Outcome</dt>
            <dd>
              {result.outcome} — {outcomeNote(result)}
            </dd>
            <dt>Duration</dt>
            <dd>{formatDuration(result.durationMs)}</dd>
            <dt>Writes out</dt>
            <dd>
              {result.sentSegmentCount} write(s) carrying {formatBytes(result.rawSent.length)}
            </dd>
            <dt>Segments in</dt>
            <dd>
              {result.receivedSegmentCount} segment(s) → {result.responseCount} framed response(s)
            </dd>
            {result.matchedRuleId && (
              <>
                <dt>Matched rule</dt>
                <dd>{result.matchedRuleId}</dd>
              </>
            )}
            {result.response && (
              <>
                <dt>Status</dt>
                <dd>
                  <span className={`status-code s${Math.floor(result.response.statusCode / 100)}`}>
                    {result.response.statusCode}
                  </span>{' '}
                  {result.response.statusPhrase}
                </dd>
              </>
            )}
          </dl>

          {result.error && <div className="failure">{result.error}</div>}

          <h3>Assertions</h3>
          {result.assertions.length === 0 ? (
            <p className="empty">The scenario asserted nothing.</p>
          ) : (
            <table className="assertions">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Expected</th>
                  <th>Actual</th>
                </tr>
              </thead>
              <tbody>
                {result.assertions.map((assertion, index) => (
                  <tr
                    key={`${assertion.field}-${index}`}
                    className={assertion.passed ? 'pass' : 'fail'}
                  >
                    <td>
                      {assertion.passed ? '✓' : '✗'} {assertion.field}
                    </td>
                    <td>{assertion.expected}</td>
                    <td title={assertion.message}>{assertion.actual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>TCP segments</h3>
          <ol className="segments">
            {result.segments.map((segment, index) => (
              <li key={index} className={segment.direction}>
                <span className="segment-arrow">{segment.direction === 'sent' ? '→' : '←'}</span>
                <span className="segment-meta">
                  +{Math.round(segment.atMs)} ms · {formatBytes(segment.bytes)}
                </span>
                <code className="segment-data">{renderRawMessage(segment.data)}</code>
              </li>
            ))}
          </ol>
          <p className="hint">
            Each entry is one real <code>write()</code> or one <code>data</code> event. Message
            boundaries do not line up with them, which is the whole point.
          </p>

          {history.length > 0 && (
            <>
              <h3>Earlier runs in this session</h3>
              <ul className="list">
                {history.map((summary) => (
                  <li key={summary.id}>
                    <button
                      type="button"
                      className={`list-item${summary.id === result.id ? ' selected' : ''}`}
                      onClick={() => onSelectResult(summary.id)}
                    >
                      <span className="list-title">
                        {summary.passed ? '✓' : '✗'} {summary.scenarioName}
                        {summary.statusCode !== undefined && (
                          <span className="badge">{summary.statusCode}</span>
                        )}
                      </span>
                      <span className="list-detail">
                        {summary.outcome} · {formatDuration(summary.durationMs)}
                        {summary.failedAssertions > 0
                          ? ` · ${summary.failedAssertions} failed assertion(s)`
                          : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
