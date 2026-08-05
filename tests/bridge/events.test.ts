/**
 * Server-Sent Events fan-out.
 *
 * The hub is the interface's only live channel, and it is shared by every open tab.
 * Three properties matter and are asserted here: the bytes it writes are valid
 * `text/event-stream`, a reload replays history rather than starting blank, and one
 * broken tab cannot disturb the others or the bridge.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { SltpWireEvent } from '@socketlens/protocol';
import { EventHub, REPLAY_LIMIT } from '../../apps/bridge/src/events.js';

/** A fake `ServerResponse` that records everything written to it. */
function fakeResponse() {
  const chunks: string[] = [];
  const listeners = new Map<string, (() => void)[]>();
  let head: { status: number; headers: Record<string, string> } | undefined;
  let ended = false;
  let throwOnWrite = false;

  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      head = { status, headers };
      return response;
    },
    write(chunk: string) {
      if (throwOnWrite) throw new Error('the tab is gone');
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(chunk);
      ended = true;
      return response;
    },
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return response;
    },
  };

  return {
    /** Passed to the hub, which only ever uses the members above. */
    response: response as unknown as ServerResponse,
    chunks,
    text: () => chunks.join(''),
    head: () => head,
    ended: () => ended,
    /** Makes every subsequent write throw, as a closed tab's socket would. */
    breakWrites: () => {
      throwOnWrite = true;
    },
    /** Fires a lifecycle event the hub subscribed to, e.g. 'close'. */
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

/** A minimal wire event; the hub treats the payload as opaque. */
function wireEvent(seq: number): SltpWireEvent {
  return {
    seq,
    at: '2026-01-01T00:00:00.000Z',
    direction: 'outbound',
    connectionId: 'conn-1',
    bytes: 4,
    raw: 'ping',
  } as SltpWireEvent;
}

/** Splits a stream into its `event:`/`data:` records, ignoring comments and retry. */
function records(text: string): { name: string; data: unknown }[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const [nameLine = '', dataLine = ''] = block.split('\n');
      return {
        name: nameLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)) as unknown,
      };
    });
}

describe('stream setup', () => {
  it('writes event-stream headers and a reconnection hint', () => {
    const hub = new EventHub();
    const tab = fakeResponse();

    hub.subscribe(tab.response);

    expect(tab.head()?.status).toBe(200);
    expect(tab.head()?.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(tab.head()?.headers['Cache-Control']).toContain('no-cache');
    // Proxy buffering would defeat the entire point of a push channel.
    expect(tab.head()?.headers['X-Accel-Buffering']).toBe('no');
    expect(tab.text()).toContain('retry: 2000\n\n');

    hub.close();
  });

  it('counts attached tabs and forgets one that closes', () => {
    const hub = new EventHub();
    const first = fakeResponse();
    const second = fakeResponse();

    hub.subscribe(first.response);
    hub.subscribe(second.response);
    expect(hub.subscriberCount).toBe(2);

    first.emit('close');
    expect(hub.subscriberCount).toBe(1);

    hub.close();
  });

  it('refuses a new subscriber once closed', () => {
    const hub = new EventHub();
    hub.close();

    const tab = fakeResponse();
    const detach = hub.subscribe(tab.response);

    expect(tab.head()?.status).toBe(503);
    expect(tab.ended()).toBe(true);
    expect(hub.subscriberCount).toBe(0);
    // The returned detach must still be callable, so callers need no special case.
    expect(() => detach()).not.toThrow();
  });
});

describe('event framing', () => {
  it('emits one record per event in the text/event-stream grammar', () => {
    const hub = new EventHub();
    const tab = fakeResponse();
    hub.subscribe(tab.response);

    hub.publishWire(wireEvent(1));
    hub.publishNotice('connected');

    expect(records(tab.text())).toEqual([
      { name: 'wire', data: expect.objectContaining({ seq: 1 }) },
      { name: 'notice', data: expect.objectContaining({ level: 'info', text: 'connected' }) },
    ]);

    hub.close();
  });

  // A raw newline inside a data field would split one event into two, so the payload
  // is JSON on a single line. This is the property that keeps that true.
  it('keeps a multi-line payload on one data line', () => {
    const hub = new EventHub();
    const tab = fakeResponse();
    hub.subscribe(tab.response);

    hub.publishNotice('first line\nsecond line');

    const dataLines = tab
      .text()
      .split('\n')
      .filter((line) => line.startsWith('data: '));
    expect(dataLines).toHaveLength(1);
    expect(records(tab.text())[0]?.data).toMatchObject({ text: 'first line\nsecond line' });

    hub.close();
  });

  it('defaults a notice to info and carries the level it is given', () => {
    const hub = new EventHub();
    const tab = fakeResponse();
    hub.subscribe(tab.response);

    hub.publishNotice('quiet');
    hub.publishNotice('loud', 'error');

    const levels = records(tab.text()).map((r) => (r.data as { level: string }).level);
    expect(levels).toEqual(['info', 'error']);

    hub.close();
  });

  it('reports an unserialisable payload instead of throwing', () => {
    const hub = new EventHub();
    const tab = fakeResponse();
    hub.subscribe(tab.response);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    // Losing one timeline row is preferable to losing the bridge.
    expect(() => hub.publish({ name: 'notice', data: cyclic })).not.toThrow();
    expect(records(tab.text())[0]?.data).toMatchObject({
      error: expect.stringContaining('could not serialise'),
    });

    hub.close();
  });

  it('broadcasts to every attached tab', () => {
    const hub = new EventHub();
    const first = fakeResponse();
    const second = fakeResponse();
    hub.subscribe(first.response);
    hub.subscribe(second.response);

    hub.publishWire(wireEvent(7));

    expect(records(first.text())).toHaveLength(1);
    expect(records(second.text())).toHaveLength(1);

    hub.close();
  });
});

describe('replay', () => {
  it('replays history onto a tab that attaches later', () => {
    const hub = new EventHub();
    hub.publishWire(wireEvent(1));
    hub.publishNotice('before you arrived');

    const tab = fakeResponse();
    hub.subscribe(tab.response);

    // This is what makes a page reload harmless despite the bridge keeping no database.
    expect(records(tab.text()).map((r) => r.name)).toEqual(['wire', 'notice']);

    hub.close();
  });

  // A status is a snapshot, not history: replaying a stale one would show the interface
  // a connection that has since dropped.
  it('never replays a status event', () => {
    const hub = new EventHub();
    hub.publishStatus({ connected: true });
    hub.publishNotice('kept');

    const tab = fakeResponse();
    hub.subscribe(tab.response);

    expect(records(tab.text()).map((r) => r.name)).toEqual(['notice']);

    hub.close();
  });

  it('still delivers a status to tabs already attached', () => {
    const hub = new EventHub();
    const tab = fakeResponse();
    hub.subscribe(tab.response);

    hub.publishStatus({ connected: true });

    expect(records(tab.text())).toEqual([{ name: 'status', data: { connected: true } }]);

    hub.close();
  });

  it('bounds replay history at REPLAY_LIMIT, keeping the newest', () => {
    const hub = new EventHub();
    for (let seq = 1; seq <= REPLAY_LIMIT + 20; seq += 1) hub.publishWire(wireEvent(seq));

    const tab = fakeResponse();
    hub.subscribe(tab.response);

    const replayed = records(tab.text());
    expect(replayed).toHaveLength(REPLAY_LIMIT);
    // The oldest 20 were dropped, so the window ends at the most recent event.
    expect((replayed[0]?.data as { seq: number }).seq).toBe(21);
    expect((replayed.at(-1)?.data as { seq: number }).seq).toBe(REPLAY_LIMIT + 20);

    hub.close();
  });

  it('drops nothing once closed', () => {
    const hub = new EventHub();
    const tab = fakeResponse();
    hub.subscribe(tab.response);
    hub.close();

    hub.publishNotice('after close');

    expect(records(tab.text())).toHaveLength(0);
  });
});

describe('isolation between tabs', () => {
  it('drops a tab whose write throws and keeps serving the others', () => {
    const hub = new EventHub();
    const healthy = fakeResponse();
    const broken = fakeResponse();
    hub.subscribe(healthy.response);
    hub.subscribe(broken.response);
    broken.breakWrites();

    expect(() => hub.publishNotice('still here')).not.toThrow();

    expect(hub.subscriberCount).toBe(1);
    expect(records(healthy.text()).at(-1)).toMatchObject({ name: 'notice' });

    hub.close();
  });

  it('survives a tab that throws while ending during close', () => {
    const hub = new EventHub();
    const tab = fakeResponse();
    hub.subscribe(tab.response);
    vi.spyOn(tab.response, 'end').mockImplementation(() => {
      throw new Error('already gone');
    });

    expect(() => hub.close()).not.toThrow();
    expect(hub.subscriberCount).toBe(0);
  });

  it('ends every stream on close so no tab holds the process open', () => {
    const hub = new EventHub();
    const first = fakeResponse();
    const second = fakeResponse();
    hub.subscribe(first.response);
    hub.subscribe(second.response);

    hub.close();

    expect(first.ended()).toBe(true);
    expect(second.ended()).toBe(true);
    expect(hub.subscriberCount).toBe(0);
  });
});

describe('keep-alive', () => {
  it('writes a comment line on the interval and stops when the last tab leaves', () => {
    vi.useFakeTimers();
    try {
      const hub = new EventHub();
      const tab = fakeResponse();
      hub.subscribe(tab.response);

      vi.advanceTimersByTime(15_000);
      // A comment is not an event: it proves liveness without appearing in the timeline.
      expect(tab.text()).toContain(': keep-alive\n\n');
      expect(records(tab.text())).toHaveLength(0);

      tab.emit('close');
      const before = tab.chunks.length;
      vi.advanceTimersByTime(60_000);
      expect(tab.chunks).toHaveLength(before);

      hub.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
