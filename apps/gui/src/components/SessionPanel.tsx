/**
 * Left panel: sessions and their mock rules.
 *
 * A session is the unit of isolation in SocketLens TCP — each one owns a dedicated TCP
 * mock endpoint on its own ephemeral port, so the port shown beside a session is the
 * real listener that scenarios connect to.
 */
import { useState, type ReactElement } from 'react';
import type { Session, MockRule, AddRuleInput, UpdateRuleInput } from '@socketlens/core/models';
import { RuleEditor } from './RuleEditor';

export interface SessionPanelProps {
  readonly sessions: readonly Session[];
  readonly currentSession: Session | undefined;
  readonly rules: readonly MockRule[];
  readonly busy: boolean;
  readonly connected: boolean;
  readonly onSelectSession: (session: Session | undefined) => void;
  readonly onCreateSession: (name: string, description?: string) => Promise<void>;
  readonly onCloseSession: (sessionId: string) => Promise<void>;
  readonly onAddRule: (input: AddRuleInput) => Promise<void>;
  readonly onUpdateRule: (input: UpdateRuleInput) => Promise<void>;
  readonly onDeleteRule: (ruleId: string) => Promise<void>;
}

export function SessionPanel(props: SessionPanelProps): ReactElement {
  const {
    sessions,
    currentSession,
    rules,
    busy,
    connected,
    onSelectSession,
    onCreateSession,
    onCloseSession,
    onAddRule,
    onUpdateRule,
    onDeleteRule,
  } = props;

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState<MockRule | 'new' | undefined>(undefined);

  const submitSession = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    await onCreateSession(trimmed, description.trim() || undefined);
    setName('');
    setDescription('');
    setCreating(false);
  };

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <h2>Sessions</h2>
          <button type="button" onClick={() => setCreating((open) => !open)} disabled={!connected}>
            {creating ? 'Cancel' : 'New session'}
          </button>
        </header>

        {creating && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSession();
            }}
          >
            <label>
              Name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="fragmentation-demo"
                autoFocus
              />
            </label>
            <label>
              Description
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="optional"
              />
            </label>
            <button type="submit" disabled={busy || name.trim().length === 0}>
              Create session
            </button>
          </form>
        )}

        {sessions.length === 0 ? (
          <p className="empty">
            {connected
              ? 'No sessions yet. Create one to get an isolated mock endpoint.'
              : 'Connect to the SLTP server to see its sessions.'}
          </p>
        ) : (
          <ul className="list">
            {sessions.map((session) => {
              const selected = session.id === currentSession?.id;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`list-item${selected ? ' selected' : ''}`}
                    onClick={() => onSelectSession(selected ? undefined : session)}
                  >
                    <span className="list-title">{session.name}</span>
                    <span className="list-detail">
                      {session.id} · mock on {session.mockHost}:{session.mockPort}
                    </span>
                    <span className="list-detail">
                      {session.ruleCount} rule(s) · {session.resultCount} result(s) ·{' '}
                      {session.state}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {currentSession && currentSession.state === 'active' && (
          <button
            type="button"
            className="subtle"
            disabled={busy}
            onClick={() => void onCloseSession(currentSession.id)}
          >
            Close {currentSession.id}
          </button>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Mock rules</h2>
          <button
            type="button"
            onClick={() => setEditing((current) => (current === undefined ? 'new' : undefined))}
            disabled={!currentSession}
          >
            {editing ? 'Cancel' : 'Add rule'}
          </button>
        </header>

        {!currentSession ? (
          <p className="empty">Select a session to see its rules.</p>
        ) : (
          <>
            {editing && (
              <RuleEditor
                rule={editing === 'new' ? undefined : editing}
                busy={busy}
                onCancel={() => setEditing(undefined)}
                onSubmit={async (input) => {
                  if (editing === 'new') {
                    await onAddRule(input);
                  } else {
                    await onUpdateRule({ id: editing.id, ...input });
                  }
                  setEditing(undefined);
                }}
              />
            )}

            {rules.length === 0 ? (
              <p className="empty">
                No rules. Without one the mock endpoint answers 404, which is itself a useful thing
                to demonstrate.
              </p>
            ) : (
              <ol className="list">
                {rules.map((rule) => (
                  <li key={rule.id}>
                    <div className={`list-item${rule.enabled ? '' : ' muted'}`}>
                      <span className="list-title">
                        {rule.name}
                        <span className="badge">priority {rule.priority}</span>
                        {!rule.enabled && <span className="badge warn">disabled</span>}
                      </span>
                      <span className="list-detail">
                        {rule.match.operation === '*' ? 'any operation' : rule.match.operation} →{' '}
                        {rule.response.statusCode} {rule.response.statusPhrase}
                      </span>
                      <span className="list-detail">
                        {rule.id} · fired {rule.hitCount}×
                        {rule.response.delayMs ? ` · ${rule.response.delayMs} ms delay` : ''}
                        {rule.response.fragment
                          ? ` · replies in ${rule.response.fragment.sizes.length} fragment(s)`
                          : ''}
                        {rule.response.disconnectAfterBytes !== undefined
                          ? ` · cuts off after ${rule.response.disconnectAfterBytes} B`
                          : ''}
                      </span>
                      <span className="row">
                        <button type="button" className="subtle" onClick={() => setEditing(rule)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="subtle"
                          disabled={busy}
                          onClick={() => void onUpdateRule({ id: rule.id, enabled: !rule.enabled })}
                        >
                          {rule.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          className="subtle danger"
                          disabled={busy}
                          onClick={() => void onDeleteRule(rule.id)}
                        >
                          Delete
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            <p className="hint">
              Rules are evaluated by priority, highest first; ties break by insertion order.
            </p>
          </>
        )}
      </section>
    </>
  );
}
