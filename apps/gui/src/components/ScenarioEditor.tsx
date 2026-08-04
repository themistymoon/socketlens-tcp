/**
 * Centre panel, upper half: the test scenario editor.
 *
 * This is where the tool's reason for existing is exercised. A scenario says what to put
 * on the wire, *how* to put it there — one write, several deliberate fragments, or two
 * messages jammed into one write — and what the response must look like for the test to
 * pass. Deliberate timeouts and mid-message disconnects are expressible outcomes, not
 * failures of the tool.
 */
import { useState, type ReactElement } from 'react';
import { SLTP_STATUS_REGISTRY, allOperationNames } from '@socketlens/protocol/browser';
import type { TestScenario, TransmissionMode } from '@socketlens/core/models';
import { parseHeaderLines, parseSizes, optionalCount } from '../lib/form-parsing';

export interface ScenarioEditorProps {
  readonly busy: boolean;
  readonly canRun: boolean;
  readonly mockAddress: string | undefined;
  readonly onRun: (scenario: TestScenario) => Promise<void>;
  readonly onSendRaw: (bytes: string) => Promise<void>;
}

export function ScenarioEditor(props: ScenarioEditorProps): ReactElement {
  const { busy, canRun, mockAddress, onRun, onSendRaw } = props;

  const [name, setName] = useState('my-scenario');
  const [operation, setOperation] = useState('PING');
  const [requestHeaders, setRequestHeaders] = useState('');
  const [requestBody, setRequestBody] = useState('');
  const [useRaw, setUseRaw] = useState(false);
  const [raw, setRaw] = useState('SLTP/1.0 PING\\r\\nRequest-ID: req-manual\\r\\n\\r\\n');

  const [mode, setMode] = useState<TransmissionMode>('single');
  const [fragmentSizes, setFragmentSizes] = useState('');
  const [fragmentCount, setFragmentCount] = useState('');
  const [interFragmentDelayMs, setInterFragmentDelayMs] = useState('');
  const [disconnectAfterBytes, setDisconnectAfterBytes] = useState('');
  const [coalesceOperation, setCoalesceOperation] = useState('PING');
  const [coalesceBody, setCoalesceBody] = useState('');

  const [timeoutMs, setTimeoutMs] = useState('5000');
  const [expectStatus, setExpectStatus] = useState('200');
  const [expectPhrase, setExpectPhrase] = useState('');
  const [expectHeaders, setExpectHeaders] = useState('');
  const [expectBodyContains, setExpectBodyContains] = useState('');
  const [expectTimeout, setExpectTimeout] = useState(false);
  const [expectDisconnect, setExpectDisconnect] = useState(false);

  const buildScenario = (): TestScenario => {
    const sizes = parseSizes(fragmentSizes);
    const count = optionalCount(fragmentCount);
    const interDelay = optionalCount(interFragmentDelayMs);
    const cutoff = optionalCount(disconnectAfterBytes);
    const timeout = optionalCount(timeoutMs);
    const status = optionalCount(expectStatus);

    return {
      name: name.trim() || 'unnamed-scenario',
      request: useRaw
        ? { raw }
        : {
            operation: operation.trim(),
            ...(parseHeaderLines(requestHeaders)
              ? { headers: parseHeaderLines(requestHeaders) }
              : {}),
            ...(requestBody.length > 0 ? { body: requestBody } : {}),
          },
      ...(mode === 'single' && cutoff === undefined
        ? {}
        : {
            transmission: {
              mode,
              ...(mode === 'fragmented' && sizes ? { fragmentSizes: sizes } : {}),
              ...(mode === 'fragmented' && !sizes && count !== undefined
                ? { fragmentCount: count }
                : {}),
              ...(interDelay !== undefined ? { interFragmentDelayMs: interDelay } : {}),
              ...(mode === 'coalesced'
                ? {
                    coalesceWith: {
                      operation: coalesceOperation.trim(),
                      ...(coalesceBody.length > 0 ? { body: coalesceBody } : {}),
                    },
                  }
                : {}),
              ...(cutoff !== undefined ? { disconnectAfterBytes: cutoff } : {}),
            },
          }),
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
      expect: {
        // A scenario expecting a timeout or a disconnect asserts nothing about a
        // response, because by definition no complete response arrives.
        ...(expectTimeout || expectDisconnect
          ? {}
          : {
              ...(status !== undefined ? { statusCode: status } : {}),
              ...(expectPhrase.trim() ? { statusPhrase: expectPhrase.trim() } : {}),
              ...(parseHeaderLines(expectHeaders)
                ? { headers: parseHeaderLines(expectHeaders) }
                : {}),
              ...(expectBodyContains.length > 0 ? { bodyContains: expectBodyContains } : {}),
            }),
        ...(expectTimeout ? { timeout: true } : {}),
        ...(expectDisconnect ? { disconnect: true } : {}),
      },
    };
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Test scenario</h2>
        {mockAddress && <span className="hint">target: {mockAddress}</span>}
      </header>

      {!canRun && <p className="empty">Select a session to run a scenario against its mock.</p>}

      <form
        className="editor"
        onSubmit={(event) => {
          event.preventDefault();
          void onRun(buildScenario());
        }}
      >
        <div className="grid-2">
          <label>
            Scenario name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Timeout (ms)
            <input
              type="number"
              min={1}
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(event.target.value)}
            />
          </label>
        </div>

        <fieldset>
          <legend>Request</legend>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={useRaw}
              onChange={(event) => setUseRaw(event.target.checked)}
            />
            Write raw bytes instead of encoding a message
          </label>

          {useRaw ? (
            <>
              <label>
                Raw bytes
                <textarea rows={4} value={raw} onChange={(event) => setRaw(event.target.value)} />
              </label>
              <p className="hint">
                {'\\r\\n'} becomes a real CR LF pair. This is the only way to send something the
                encoder refuses to produce — a bad Content-Length, a truncated header block.
              </p>
            </>
          ) : (
            <>
              <div className="grid-2">
                <label>
                  Operation
                  <input
                    list="sltp-operations"
                    value={operation}
                    onChange={(event) => setOperation(event.target.value)}
                  />
                </label>
              </div>
              <datalist id="sltp-operations">
                {allOperationNames().map((token) => (
                  <option key={token} value={token} />
                ))}
              </datalist>
              <label>
                Headers
                <textarea
                  rows={2}
                  value={requestHeaders}
                  onChange={(event) => setRequestHeaders(event.target.value)}
                  placeholder="X-Trace: on"
                />
              </label>
              <label>
                Body
                <textarea
                  rows={2}
                  value={requestBody}
                  onChange={(event) => setRequestBody(event.target.value)}
                  placeholder='{"probe":true}'
                />
              </label>
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>Transmission</legend>
          <label>
            Mode
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as TransmissionMode)}
            >
              <option value="single">single — one write</option>
              <option value="fragmented">fragmented — several writes</option>
              <option value="coalesced">coalesced — two messages, one write</option>
            </select>
          </label>

          {mode === 'fragmented' && (
            <>
              <div className="grid-2">
                <label>
                  Fragment sizes
                  <input
                    value={fragmentSizes}
                    onChange={(event) => setFragmentSizes(event.target.value)}
                    placeholder="6, 14, 18, 22"
                  />
                </label>
                <label>
                  or equal fragments
                  <input
                    type="number"
                    min={1}
                    value={fragmentCount}
                    onChange={(event) => setFragmentCount(event.target.value)}
                    placeholder="e.g. 134 for byte-at-a-time"
                    disabled={parseSizes(fragmentSizes) !== undefined}
                  />
                </label>
              </div>
              <label>
                Between fragments (ms)
                <input
                  type="number"
                  min={0}
                  value={interFragmentDelayMs}
                  onChange={(event) => setInterFragmentDelayMs(event.target.value)}
                  placeholder="0"
                />
              </label>
              <p className="hint">
                Explicit sizes take precedence. Cutting mid-header or between a CR and its LF is
                allowed and is the most interesting case: the peer must still frame one message.
              </p>
            </>
          )}

          {mode === 'coalesced' && (
            <>
              <div className="grid-2">
                <label>
                  Second operation
                  <input
                    list="sltp-operations"
                    value={coalesceOperation}
                    onChange={(event) => setCoalesceOperation(event.target.value)}
                  />
                </label>
                <label>
                  Second body
                  <input
                    value={coalesceBody}
                    onChange={(event) => setCoalesceBody(event.target.value)}
                  />
                </label>
              </div>
              <p className="hint">
                Both messages go out in a single write. Two responses coming back proves the peer
                split them by Content-Length rather than by segment boundary.
              </p>
            </>
          )}

          <label>
            Cut the connection after (bytes)
            <input
              type="number"
              min={0}
              value={disconnectAfterBytes}
              onChange={(event) => setDisconnectAfterBytes(event.target.value)}
              placeholder="never"
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Expected result</legend>
          <div className="row">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={expectTimeout}
                onChange={(event) => {
                  setExpectTimeout(event.target.checked);
                  if (event.target.checked) setExpectDisconnect(false);
                }}
              />
              Expect a timeout
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={expectDisconnect}
                onChange={(event) => {
                  setExpectDisconnect(event.target.checked);
                  if (event.target.checked) setExpectTimeout(false);
                }}
              />
              Expect a mid-message disconnect
            </label>
          </div>

          {!expectTimeout && !expectDisconnect && (
            <>
              <div className="grid-2">
                <label>
                  Status code
                  <input
                    list="sltp-status-codes-scenario"
                    type="number"
                    value={expectStatus}
                    onChange={(event) => setExpectStatus(event.target.value)}
                  />
                </label>
                <label>
                  Status phrase
                  <input
                    value={expectPhrase}
                    onChange={(event) => setExpectPhrase(event.target.value)}
                    placeholder="optional"
                  />
                </label>
              </div>
              <datalist id="sltp-status-codes-scenario">
                {SLTP_STATUS_REGISTRY.map((status) => (
                  <option key={status.code} value={status.code}>
                    {status.code} {status.phrase}
                  </option>
                ))}
              </datalist>
              <label>
                Headers
                <textarea
                  rows={2}
                  value={expectHeaders}
                  onChange={(event) => setExpectHeaders(event.target.value)}
                  placeholder="Matched-Rule-ID: ping-ok"
                />
              </label>
              <label>
                Body contains
                <input
                  value={expectBodyContains}
                  onChange={(event) => setExpectBodyContains(event.target.value)}
                  placeholder="pong"
                />
              </label>
            </>
          )}
        </fieldset>

        <div className="row">
          <button type="submit" disabled={busy || !canRun}>
            Run test
          </button>
          {useRaw && (
            <button
              type="button"
              className="subtle"
              disabled={busy}
              onClick={() => void onSendRaw(raw)}
            >
              Write these bytes to the control connection
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
