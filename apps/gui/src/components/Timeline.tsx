/**
 * Centre panel, lower half: every message that crossed the wire, in order.
 *
 * Each entry is one complete SLTP message as the shared decoder framed it — not one TCP
 * segment and not one `write()`. That distinction is the point: several timeline entries
 * can come from a single write, and a single entry can be assembled from many.
 */
import type { ReactElement } from 'react';
import type { SltpWireEvent } from '@socketlens/protocol/browser';
import { formatBytes, summariseMessage } from '@socketlens/protocol/browser';

export interface TimelineProps {
  readonly events: readonly SltpWireEvent[];
  readonly selectedSeq: number | undefined;
  readonly onSelect: (event: SltpWireEvent) => void;
  readonly onClear: () => void;
}

/** Renders the time portion of an ISO instant, which is all that is useful here. */
function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toISOString().slice(11, 23);
}

export function Timeline({ events, selectedSeq, onSelect, onClear }: TimelineProps): ReactElement {
  return (
    <section className="panel timeline">
      <header className="panel-head">
        <h2>Message timeline</h2>
        <span className="row">
          <span className="hint">{events.length} message(s)</span>
          <button type="button" className="subtle" onClick={onClear} disabled={events.length === 0}>
            Clear
          </button>
        </span>
      </header>

      {events.length === 0 ? (
        <p className="empty">
          Nothing on the wire yet. Connect, then send a request — every SLTP message in both
          directions appears here.
        </p>
      ) : (
        <ol className="wire-list">
          {events.map((event) => {
            const outbound = event.direction === 'outbound';
            const selected = event.seq === selectedSeq;
            const label = event.message
              ? summariseMessage(event.message)
              : event.error
                ? `${event.error.code}: ${event.error.message}`
                : 'unparsed bytes';

            return (
              <li key={event.seq}>
                <button
                  type="button"
                  className={
                    `wire-item ${outbound ? 'outbound' : 'inbound'}` +
                    (selected ? ' selected' : '') +
                    (event.error ? ' failed' : '')
                  }
                  onClick={() => onSelect(event)}
                >
                  <span className="wire-arrow">{outbound ? '→' : '←'}</span>
                  <span className="wire-body">
                    <span className="wire-title">{label}</span>
                    <span className="wire-detail">
                      {clockOf(event.at)} · {event.connectionId} · {formatBytes(event.bytes)}
                      {event.requestId ? ` · ${event.requestId}` : ''}
                      {event.sessionId ? ` · ${event.sessionId}` : ''}
                    </span>
                  </span>
                  {event.error && <span className="badge warn">{event.error.status}</span>}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <p className="hint">
        {'→'} is this process writing, {'←'} is the server answering. Headings match the CLI and
        server logs: [CLIENT {'->'} SERVER] and [SERVER {'->'} CLIENT].
      </p>
    </section>
  );
}
