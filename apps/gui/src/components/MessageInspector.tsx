/**
 * Right panel: the selected message, raw bytes and parsed structure side by side.
 *
 * The raw view is what actually travelled; the parsed view is what the decoder made of
 * it. Showing both is what lets a viewer check the Content-Length against the real body
 * length rather than take it on trust.
 */
import type { ReactElement } from 'react';
import type { SltpWireEvent } from '@socketlens/protocol/browser';
import {
  formatBytes,
  getHeader,
  prettyPrintBody,
  renderRawMessage,
  startLineOf,
  utf8ByteLength,
} from '@socketlens/protocol/browser';

export interface MessageInspectorProps {
  readonly event: SltpWireEvent | undefined;
}

export function MessageInspector({ event }: MessageInspectorProps): ReactElement {
  if (!event) {
    return (
      <section className="panel">
        <header className="panel-head">
          <h2>Inspector</h2>
        </header>
        <p className="empty">Select a message in the timeline to inspect it.</p>
      </section>
    );
  }

  const message = event.message;

  return (
    <section className="panel inspector">
      <header className="panel-head">
        <h2>Inspector</h2>
        <span className="hint">#{event.seq}</span>
      </header>

      <dl className="facts">
        <dt>Direction</dt>
        <dd>{event.direction === 'outbound' ? 'sent by this client' : 'received from server'}</dd>
        <dt>At</dt>
        <dd>{event.at}</dd>
        <dt>Connection</dt>
        <dd>{event.connectionId}</dd>
        <dt>On the wire</dt>
        <dd>{formatBytes(event.bytes)}</dd>
        {event.requestId && (
          <>
            <dt>Request-ID</dt>
            <dd>{event.requestId}</dd>
          </>
        )}
        {event.sessionId && (
          <>
            <dt>Session-ID</dt>
            <dd>{event.sessionId}</dd>
          </>
        )}
      </dl>

      {event.error && (
        <div className="failure">
          <strong>
            {event.error.status} — {event.error.code}
          </strong>
          <p>{event.error.message}</p>
        </div>
      )}

      {message && (
        <>
          <h3>Start line</h3>
          <pre className="wire">{startLineOf(message)}</pre>

          {message.statusCode !== undefined && (
            <p className="status-line">
              <span className={`status-code s${Math.floor(message.statusCode / 100)}`}>
                {message.statusCode}
              </span>
              <span className="status-phrase">{message.statusPhrase}</span>
            </p>
          )}

          <h3>Headers</h3>
          {message.headers.length === 0 ? (
            <p className="empty">No headers.</p>
          ) : (
            <table className="headers">
              <tbody>
                {message.headers.map((header, index) => (
                  <tr key={`${header.name}-${index}`}>
                    <th>{header.name}</th>
                    <td>{header.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>
            Body <span className="hint">{formatBytes(message.bodyBytes)}</span>
          </h3>
          {message.bodyBytes === 0 ? (
            <p className="empty">Empty body. No Content-Length is required.</p>
          ) : (
            <>
              <pre className="wire">
                {prettyPrintBody(message.body, getHeader(message.headers, 'Content-Type'))}
              </pre>
              {utf8ByteLength(message.body) !== message.body.length && (
                <p className="hint">
                  {message.body.length} character(s) but {message.bodyBytes} byte(s) — this body
                  contains multibyte UTF-8, which is exactly why Content-Length counts bytes.
                </p>
              )}
            </>
          )}
        </>
      )}

      <h3>
        Raw bytes <span className="hint">{formatBytes(event.bytes)}</span>
      </h3>
      <pre className="wire raw">{message ? renderRawMessage(message.raw) : event.raw}</pre>
      <p className="hint">↵ marks a CR LF pair. The blank line ends the header block.</p>
    </section>
  );
}
