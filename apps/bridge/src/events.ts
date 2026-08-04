/**
 * Server-Sent Events fan-out for the browser interface.
 *
 * ── Why SSE and not WebSocket ────────────────────────────────────────────────
 * The interface needs a live push channel: every SLTP message the bridge sends or
 * receives must appear in the timeline as it happens, not on a poll. WebSocket is
 * forbidden by this project's constraints, and rightly so — it is a distinct framed
 * protocol with its own handshake, and adding it would blur the one claim this project
 * exists to demonstrate, that the application protocol under study is SLTP over raw
 * TCP. SSE is not another protocol: it is an ordinary HTTP response with the media type
 * `text/event-stream` that is simply never closed. `node:http` can produce it with no
 * dependency, no upgrade handshake, and no extra framing layer, and the browser's own
 * parser consumes it. Push semantics are one-directional here anyway — commands travel
 * browser to bridge as plain POSTs — so SSE's lack of a client-to-server channel costs
 * nothing.
 */
import type { ServerResponse } from 'node:http';
import type { SltpWireEvent } from '@socketlens/protocol';

/** Event names the bridge publishes on the stream. */
export type BridgeEventName = 'wire' | 'status' | 'notice';

/** A payload published to every subscriber. */
export interface BridgeEvent {
  readonly name: BridgeEventName;
  readonly data: unknown;
}

/** How many past events a newly attached browser tab is replayed. */
export const REPLAY_LIMIT = 250;

/**
 * Milliseconds between keep-alive comments.
 *
 * An idle `text/event-stream` can be dropped by the runtime or by a proxy; a comment
 * line costs two bytes and proves the stream is still alive without producing an event.
 */
const KEEP_ALIVE_MS = 15_000;

/** One attached browser tab. */
interface Subscriber {
  readonly id: number;
  readonly response: ServerResponse;
}

/**
 * Broadcasts bridge events to every attached browser tab.
 *
 * Several tabs may watch the same bridge at once, and one of them failing — a closed
 * laptop lid, a reloaded page, a stalled socket — must never disturb the others or the
 * bridge itself. Every write is therefore individually guarded, and a subscriber whose
 * write throws is dropped rather than retried.
 */
export class EventHub {
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly recent: BridgeEvent[] = [];
  private nextSubscriberId = 1;
  private keepAlive: NodeJS.Timeout | undefined;
  private closed = false;

  /** Number of attached browser tabs. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Attaches a response as an event stream and replays recent history onto it.
   *
   * Replay is what makes a page reload harmless: the timeline the user was reading is
   * still there afterwards, even though the bridge keeps no database.
   */
  subscribe(response: ServerResponse): () => void {
    if (this.closed) {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('The bridge is shutting down.\n');
      return () => {};
    }

    const id = this.nextSubscriberId++;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // The interface is same-origin in both modes: served by the bridge, or served by
      // Vite which proxies /bridge to it. No CORS header is needed or wanted.
      'X-Accel-Buffering': 'no',
    });

    const subscriber: Subscriber = { id, response };
    this.subscribers.set(id, subscriber);

    // Tell the browser how long to wait before reconnecting if the stream drops.
    this.writeTo(subscriber, 'retry: 2000\n\n');
    for (const event of this.recent) this.send(subscriber, event);

    this.startKeepAlive();

    const detach = (): void => {
      this.subscribers.delete(id);
      if (this.subscribers.size === 0) this.stopKeepAlive();
    };

    response.on('close', detach);
    response.on('error', detach);
    return detach;
  }

  /** Publishes one SLTP message or framing failure to every subscriber. */
  publishWire(event: SltpWireEvent): void {
    this.publish({ name: 'wire', data: event });
  }

  /** Publishes a connection-state change. */
  publishStatus(status: unknown): void {
    this.publish({ name: 'status', data: status });
  }

  /** Publishes a human-readable notice, for example an unexpected disconnect. */
  publishNotice(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.publish({ name: 'notice', data: { level, text, at: new Date().toISOString() } });
  }

  /** Publishes an arbitrary event and remembers it for replay. */
  publish(event: BridgeEvent): void {
    if (this.closed) return;

    // `status` is a snapshot rather than a history: replaying stale connection states
    // after a reload would show the interface a connection that has since dropped.
    if (event.name !== 'status') {
      this.recent.push(event);
      while (this.recent.length > REPLAY_LIMIT) this.recent.shift();
    }

    for (const subscriber of [...this.subscribers.values()]) this.send(subscriber, event);
  }

  /** Ends every stream. Called during shutdown so no browser holds the process open. */
  close(): void {
    this.closed = true;
    this.stopKeepAlive();
    for (const subscriber of [...this.subscribers.values()]) {
      this.subscribers.delete(subscriber.id);
      try {
        subscriber.response.end();
      } catch {
        // The tab is already gone; nothing left to close.
      }
    }
  }

  /** Serialises one event in the `text/event-stream` grammar and writes it. */
  private send(subscriber: Subscriber, event: BridgeEvent): void {
    // A data field must not contain a raw newline, so the payload is JSON on one line.
    const payload = safeStringify(event.data);
    this.writeTo(subscriber, `event: ${event.name}\ndata: ${payload}\n\n`);
  }

  /** Writes to one subscriber, dropping it if the write fails. */
  private writeTo(subscriber: Subscriber, chunk: string): void {
    try {
      subscriber.response.write(chunk);
    } catch {
      // One browser's broken stream must not propagate into the bridge or the others.
      this.subscribers.delete(subscriber.id);
      if (this.subscribers.size === 0) this.stopKeepAlive();
    }
  }

  private startKeepAlive(): void {
    if (this.keepAlive !== undefined) return;
    this.keepAlive = setInterval(() => {
      for (const subscriber of [...this.subscribers.values()]) {
        this.writeTo(subscriber, ': keep-alive\n\n');
      }
    }, KEEP_ALIVE_MS);
    // A keep-alive timer must never be the reason the process stays up.
    this.keepAlive.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAlive === undefined) return;
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
  }
}

/**
 * JSON-encodes a payload, never throwing.
 *
 * A value that cannot be serialised is reported as an event rather than crashing the
 * publisher: losing one timeline row is preferable to losing the bridge.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch (cause) {
    return JSON.stringify({
      error: `The bridge could not serialise this event: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    });
  }
}
