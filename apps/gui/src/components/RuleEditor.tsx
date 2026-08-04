/**
 * Editor for one mock rule.
 *
 * The form covers every field the protocol defines for a rule, including the ones that
 * exist purely to provoke TCP-level behaviour: a response delay to force a timeout,
 * explicit fragment sizes to split one reply across several writes, and a byte cutoff to
 * simulate a peer that dies mid-message.
 */
import { useState, type ReactElement } from 'react';
import { SLTP_STATUS_REGISTRY, statusPhrase } from '@socketlens/protocol/browser';
import type { MockRule, AddRuleInput, BodyMatchMode } from '@socketlens/core/models';
import {
  parseHeaderLines,
  formatHeaderLines,
  parseSizes,
  optionalCount,
} from '../lib/form-parsing';

export interface RuleEditorProps {
  /** The rule being edited, or `undefined` when adding a new one. */
  readonly rule: MockRule | undefined;
  readonly busy: boolean;
  readonly onSubmit: (input: AddRuleInput) => Promise<void>;
  readonly onCancel: () => void;
}

export function RuleEditor({ rule, busy, onSubmit, onCancel }: RuleEditorProps): ReactElement {
  const [name, setName] = useState(rule?.name ?? '');
  const [id, setId] = useState(rule?.id ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [priority, setPriority] = useState(String(rule?.priority ?? 0));

  const [matchOperation, setMatchOperation] = useState(rule?.match.operation ?? '*');
  const [matchHeaders, setMatchHeaders] = useState(formatHeaderLines(rule?.match.headers));
  const [bodyMode, setBodyMode] = useState<BodyMatchMode | 'none'>(
    rule?.match.body?.mode ?? 'none',
  );
  const [bodyValue, setBodyValue] = useState(rule?.match.body?.value ?? '');

  const [statusCode, setStatusCode] = useState(String(rule?.response.statusCode ?? 200));
  const [phrase, setPhrase] = useState(rule?.response.statusPhrase ?? '');
  const [responseHeaders, setResponseHeaders] = useState(formatHeaderLines(rule?.response.headers));
  const [responseBody, setResponseBody] = useState(rule?.response.body ?? '');
  const [delayMs, setDelayMs] = useState(
    rule?.response.delayMs === undefined ? '' : String(rule.response.delayMs),
  );
  const [fragmentSizes, setFragmentSizes] = useState(
    rule?.response.fragment?.sizes.join(', ') ?? '',
  );
  const [fragmentDelayMs, setFragmentDelayMs] = useState(
    rule?.response.fragment?.delayMs === undefined ? '' : String(rule.response.fragment.delayMs),
  );
  const [disconnectAfterBytes, setDisconnectAfterBytes] = useState(
    rule?.response.disconnectAfterBytes === undefined
      ? ''
      : String(rule.response.disconnectAfterBytes),
  );

  const code = Number(statusCode);
  // An unnamed status still needs a phrase on the wire, so the registry supplies the
  // canonical one whenever the user has not written their own.
  const effectivePhrase = phrase.trim() || statusPhrase(code) || 'OK';

  const submit = async (): Promise<void> => {
    const sizes = parseSizes(fragmentSizes);
    const fragmentDelay = optionalCount(fragmentDelayMs);
    const cutoff = optionalCount(disconnectAfterBytes);
    const delay = optionalCount(delayMs);

    const input: AddRuleInput = {
      ...(id.trim() ? { id: id.trim() } : {}),
      name: name.trim(),
      enabled,
      priority: Number(priority) || 0,
      match: {
        operation: matchOperation.trim() || '*',
        ...(parseHeaderLines(matchHeaders) ? { headers: parseHeaderLines(matchHeaders) } : {}),
        ...(bodyMode !== 'none' && bodyValue.length > 0
          ? { body: { mode: bodyMode, value: bodyValue } }
          : {}),
      },
      response: {
        statusCode: code,
        statusPhrase: effectivePhrase,
        ...(parseHeaderLines(responseHeaders)
          ? { headers: parseHeaderLines(responseHeaders) }
          : {}),
        ...(responseBody.length > 0 ? { body: responseBody } : {}),
        ...(delay !== undefined ? { delayMs: delay } : {}),
        ...(sizes
          ? {
              fragment: {
                sizes,
                ...(fragmentDelay !== undefined ? { delayMs: fragmentDelay } : {}),
              },
            }
          : {}),
        ...(cutoff !== undefined ? { disconnectAfterBytes: cutoff } : {}),
      },
    };

    await onSubmit(input);
  };

  return (
    <form
      className="editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3>{rule ? `Edit ${rule.id}` : 'New rule'}</h3>

      <div className="grid-2">
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="ping-ok"
            required
          />
        </label>
        <label>
          Rule ID
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="assigned if blank"
            disabled={rule !== undefined}
          />
        </label>
        <label>
          Priority
          <input
            type="number"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
      </div>

      <fieldset>
        <legend>Match</legend>
        <label>
          Operation
          <input
            value={matchOperation}
            onChange={(event) => setMatchOperation(event.target.value)}
            placeholder="* for any"
          />
        </label>
        <label>
          Required headers
          <textarea
            rows={2}
            value={matchHeaders}
            onChange={(event) => setMatchHeaders(event.target.value)}
            placeholder="X-Trace: on"
          />
        </label>
        <div className="grid-2">
          <label>
            Body match
            <select
              value={bodyMode}
              onChange={(event) => setBodyMode(event.target.value as BodyMatchMode | 'none')}
            >
              <option value="none">no body condition</option>
              <option value="exact">exact</option>
              <option value="contains">contains</option>
              <option value="json-subset">JSON subset</option>
              <option value="regex">regular expression</option>
            </select>
          </label>
          <label>
            Value
            <input
              value={bodyValue}
              onChange={(event) => setBodyValue(event.target.value)}
              disabled={bodyMode === 'none'}
            />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Response</legend>
        <div className="grid-2">
          <label>
            Status code
            <input
              list="sltp-status-codes"
              type="number"
              value={statusCode}
              onChange={(event) => setStatusCode(event.target.value)}
              required
            />
          </label>
          <label>
            Status phrase
            <input
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder={statusPhrase(code) || 'OK'}
            />
          </label>
        </div>

        <datalist id="sltp-status-codes">
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
            value={responseHeaders}
            onChange={(event) => setResponseHeaders(event.target.value)}
            placeholder="Content-Type: application/json; charset=utf-8"
          />
        </label>
        <label>
          Body
          <textarea
            rows={3}
            value={responseBody}
            onChange={(event) => setResponseBody(event.target.value)}
            placeholder='{"message":"pong"}'
          />
        </label>
        <p className="hint">
          Content-Length is computed from the UTF-8 byte length of this body, so a Thai or emoji
          body is longer in bytes than in characters. Do not set it by hand.
        </p>
      </fieldset>

      <fieldset>
        <legend>TCP behaviour</legend>
        <div className="grid-2">
          <label>
            Response delay (ms)
            <input
              type="number"
              min={0}
              value={delayMs}
              onChange={(event) => setDelayMs(event.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            Cut off after (bytes)
            <input
              type="number"
              min={0}
              value={disconnectAfterBytes}
              onChange={(event) => setDisconnectAfterBytes(event.target.value)}
              placeholder="never"
            />
          </label>
          <label>
            Reply fragment sizes
            <input
              value={fragmentSizes}
              onChange={(event) => setFragmentSizes(event.target.value)}
              placeholder="12, 30, 40"
            />
          </label>
          <label>
            Between fragments (ms)
            <input
              type="number"
              min={0}
              value={fragmentDelayMs}
              onChange={(event) => setFragmentDelayMs(event.target.value)}
              placeholder="0"
            />
          </label>
        </div>
        <p className="hint">
          A delay longer than the scenario timeout produces 408 TEST TIMEOUT. Fragment sizes split
          the reply across that many real writes, which the client must reassemble.
        </p>
      </fieldset>

      <div className="row">
        <button type="submit" disabled={busy || name.trim().length === 0}>
          {rule ? 'Save rule' : 'Add rule'}
        </button>
        <button type="button" className="subtle" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
