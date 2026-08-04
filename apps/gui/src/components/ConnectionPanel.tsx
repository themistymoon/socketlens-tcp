/**
 * Left panel, top: the control connection to the SLTP server.
 *
 * The bridge owns the socket, so this panel reports the bridge's view of it rather than
 * holding any connection state of its own. A reloaded tab therefore shows a connection
 * that is genuinely still open.
 */
import type { ReactElement } from 'react';
import type { RelayStatus } from '../hooks/useBridge';

export interface ConnectionPanelProps {
  readonly status: RelayStatus;
  readonly connecting: boolean;
  readonly onConnect: () => Promise<void>;
  readonly onDisconnect: () => Promise<void>;
}

export function ConnectionPanel(props: ConnectionPanelProps): ReactElement {
  const { status, connecting, onConnect, onDisconnect } = props;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Connection</h2>
        {status.connected ? (
          <button type="button" className="subtle" onClick={() => void onDisconnect()}>
            Disconnect
          </button>
        ) : (
          <button type="button" onClick={() => void onConnect()} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </header>

      <p className="list-title">
        <span className={`status-dot ${status.connected ? 'up' : 'down'}`} />
        {status.connected ? 'Connected over raw TCP' : 'Not connected'}
      </p>

      <dl className="facts">
        <dt>Server</dt>
        <dd>
          {status.serverHost}:{status.serverPort}
        </dd>
        {status.connectionId && (
          <>
            <dt>Connection</dt>
            <dd>{status.connectionId}</dd>
          </>
        )}
        <dt>Requests</dt>
        <dd>{status.requestsSent}</dd>
      </dl>

      {status.lastError && !status.connected && <div className="failure">{status.lastError}</div>}

      <p className="hint">
        The browser cannot open a TCP socket, so the bridge holds it. SLTP itself never runs over
        HTTP — the bridge speaks it on this machine and pushes what crosses the wire.
      </p>
    </section>
  );
}
