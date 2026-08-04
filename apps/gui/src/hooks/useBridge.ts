/**
 * The interface's single connection to the bridge.
 *
 * Everything the graphical client knows about the protocol arrives through here: it
 * issues SLTP operations by name over the bridge's loopback control surface, and it
 * receives the resulting wire traffic as pushed events. The browser never frames a
 * message and never opens a socket — it renders what the shared decoder produced.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { SltpWireEvent, SltpMessageView } from '@socketlens/protocol/browser';
import type {
  Session,
  MockRule,
  AddRuleInput,
  UpdateRuleInput,
  TestScenario,
  TestResult,
  TestResultSummary,
} from '@socketlens/core/models';

/** Connection state as the bridge reports it. */
export interface RelayStatus {
  readonly connected: boolean;
  readonly serverHost: string;
  readonly serverPort: number;
  readonly connectionId?: string;
  readonly lastError?: string;
  readonly requestsSent: number;
}

/** A transient message shown under the layout. */
export interface Notice {
  readonly text: string;
  readonly level: 'info' | 'warn' | 'error';
  /** Distinguishes consecutive identical notices so each one re-triggers its timer. */
  readonly key: number;
}

/** One completed exchange, as the bridge returns it. */
interface RelayExchange {
  readonly requestId: string;
  readonly durationMs: number;
  readonly request: SltpMessageView;
  readonly response: SltpMessageView;
}

/** What a failed operation reports back to the caller. */
export class BridgeError extends Error {
  /** SLTP status code, when the exchange completed and the server answered. */
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'BridgeError';
    this.statusCode = statusCode;
  }
}

/**
 * Newest wire events kept in the timeline.
 *
 * A long session can produce thousands; the interface keeps a bounded window so that a
 * demonstration left running does not grow without limit.
 */
const TIMELINE_LIMIT = 500;

/** Reads a JSON body, tolerating an empty one. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError(`The bridge returned a body that is not JSON: ${text.slice(0, 200)}`);
  }
}

export function useBridge() {
  const [status, setStatus] = useState<RelayStatus>({
    connected: false,
    serverHost: '127.0.0.1',
    serverPort: 7420,
    requestsSent: 0,
  });
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<readonly Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | undefined>();
  const [rules, setRules] = useState<readonly MockRule[]>([]);
  const [results, setResults] = useState<readonly TestResultSummary[]>([]);
  const [lastResult, setLastResult] = useState<TestResult | undefined>();
  const [wireEvents, setWireEvents] = useState<readonly SltpWireEvent[]>([]);
  const [notice, setNotice] = useState<Notice | undefined>();

  const eventSourceRef = useRef<EventSource | undefined>(undefined);
  const noticeKey = useRef(0);

  const announce = useCallback((text: string, level: Notice['level'] = 'info'): void => {
    noticeKey.current += 1;
    setNotice({ text, level, key: noticeKey.current });
  }, []);

  // Notices are advisory, so they clear themselves. Errors stay longer, because a
  // failed operation is something the user may need to read twice.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), notice.level === 'error' ? 12_000 : 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * Sends one SLTP operation through the bridge.
   *
   * A non-2xx SLTP status is thrown as a {@link BridgeError} carrying the numeric code,
   * so callers can report `404 SESSION NOT FOUND` with its phrase rather than a generic
   * failure. The exchange itself is still displayed in the timeline either way.
   */
  const sendOperation = useCallback(
    async (
      operation: string,
      options: { sessionId?: string; json?: unknown; timeoutMs?: number } = {},
    ): Promise<{ exchange: RelayExchange; body: unknown }> => {
      const response = await fetch('/bridge/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, ...options }),
      });

      const payload = (await readJson(response)) as Record<string, unknown>;

      if (!response.ok) {
        throw new BridgeError(String(payload['error'] ?? `${operation} failed.`));
      }

      const exchange = payload as unknown as RelayExchange;
      const statusCode = exchange.response.statusCode ?? 0;

      let body: unknown = {};
      if (exchange.response.body.trim().length > 0) {
        try {
          body = JSON.parse(exchange.response.body);
        } catch {
          body = { raw: exchange.response.body };
        }
      }

      if (statusCode >= 400) {
        const detail = (body as { error?: string }).error;
        throw new BridgeError(
          `${statusCode} ${exchange.response.statusPhrase ?? ''}${detail ? ` — ${detail}` : ''}`,
          statusCode,
        );
      }

      return { exchange, body };
    },
    [],
  );

  /** Attaches the pushed event stream, if it is not already attached. */
  const attachEvents = useCallback((): void => {
    if (eventSourceRef.current) return;

    const source = new EventSource('/bridge/events');

    source.addEventListener('wire', (event) => {
      const wire = JSON.parse((event as MessageEvent<string>).data) as SltpWireEvent;
      setWireEvents((previous) => {
        const next = [...previous, wire];
        return next.length > TIMELINE_LIMIT ? next.slice(next.length - TIMELINE_LIMIT) : next;
      });
    });

    source.addEventListener('status', (event) => {
      setStatus(JSON.parse((event as MessageEvent<string>).data) as RelayStatus);
    });

    source.addEventListener('notice', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        text: string;
        level: Notice['level'];
      };
      announce(payload.text, payload.level);
    });

    eventSourceRef.current = source;
  }, [announce]);

  // ─── sessions and rules ────────────────────────────────────────────────────

  const refreshSessions = useCallback(async (): Promise<readonly Session[]> => {
    const { body } = await sendOperation('LIST_SESSIONS');
    const listed = (body as { sessions?: Session[] }).sessions ?? [];
    setSessions(listed);
    return listed;
  }, [sendOperation]);

  const refreshRules = useCallback(
    async (sessionId: string): Promise<void> => {
      const { body } = await sendOperation('LIST_RULES', { sessionId });
      setRules((body as { rules?: MockRule[] }).rules ?? []);
    },
    [sendOperation],
  );

  const refreshResults = useCallback(
    async (sessionId: string): Promise<void> => {
      const { body } = await sendOperation('LIST_RESULTS', { sessionId });
      setResults((body as { results?: TestResultSummary[] }).results ?? []);
    },
    [sendOperation],
  );

  /** Wraps an operation so failures surface as a notice rather than an unhandled rejection. */
  const guard = useCallback(
    async (label: string, work: () => Promise<void>): Promise<void> => {
      setBusy(true);
      try {
        await work();
      } catch (cause) {
        announce(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`, 'error');
      } finally {
        setBusy(false);
      }
    },
    [announce],
  );

  const connect = useCallback(async (): Promise<void> => {
    setConnecting(true);
    try {
      const response = await fetch('/bridge/connect', { method: 'POST' });
      const payload = (await readJson(response)) as Record<string, unknown>;
      if (!response.ok) {
        throw new BridgeError(String(payload['error'] ?? 'The bridge could not connect.'));
      }
      setStatus(payload as unknown as RelayStatus);
      attachEvents();
      await refreshSessions();
    } catch (cause) {
      announce(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setConnecting(false);
    }
  }, [announce, attachEvents, refreshSessions]);

  const disconnect = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/bridge/disconnect', { method: 'POST' });
      setStatus((await readJson(response)) as RelayStatus);
      setSessions([]);
      setCurrentSession(undefined);
      setRules([]);
      setResults([]);
      announce('Disconnected.');
    } catch (cause) {
      announce(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }, [announce]);

  const selectSession = useCallback(
    (session: Session | undefined): void => {
      setCurrentSession(session);
      setRules([]);
      setResults([]);
      setLastResult(undefined);
      if (!session) return;
      void guard('Could not load the session', async () => {
        await refreshRules(session.id);
        await refreshResults(session.id);
      });
    },
    [guard, refreshRules, refreshResults],
  );

  const createSession = useCallback(
    (name: string, description?: string): Promise<void> =>
      guard('Could not create the session', async () => {
        const { body } = await sendOperation('CREATE_SESSION', {
          json: { name, ...(description ? { description } : {}) },
        });
        const session = (body as { session: Session }).session;
        setSessions((previous) => [...previous, session]);
        setCurrentSession(session);
        setRules([]);
        setResults([]);
        announce(
          `Session ${session.id} created. Its mock endpoint is listening on ` +
            `${session.mockHost}:${session.mockPort}.`,
        );
      }),
    [announce, guard, sendOperation],
  );

  const closeSession = useCallback(
    (sessionId: string): Promise<void> =>
      guard('Could not close the session', async () => {
        await sendOperation('CLOSE_SESSION', { sessionId });
        await refreshSessions();
        setCurrentSession((current) => (current?.id === sessionId ? undefined : current));
        announce(`Session ${sessionId} closed.`);
      }),
    [announce, guard, refreshSessions, sendOperation],
  );

  const addRule = useCallback(
    (input: AddRuleInput): Promise<void> =>
      guard('Could not add the rule', async () => {
        const sessionId = currentSession?.id;
        if (!sessionId) throw new BridgeError('Select a session first.');
        const { body } = await sendOperation('ADD_RULE', { sessionId, json: input });
        const rule = (body as { rule: MockRule }).rule;
        await refreshRules(sessionId);
        announce(`Rule ${rule.id} added at priority ${rule.priority}.`);
      }),
    [announce, currentSession, guard, refreshRules, sendOperation],
  );

  const updateRule = useCallback(
    (input: UpdateRuleInput): Promise<void> =>
      guard('Could not update the rule', async () => {
        const sessionId = currentSession?.id;
        if (!sessionId) throw new BridgeError('Select a session first.');
        await sendOperation('UPDATE_RULE', { sessionId, json: input });
        await refreshRules(sessionId);
        announce(`Rule ${input.id} updated.`);
      }),
    [announce, currentSession, guard, refreshRules, sendOperation],
  );

  const deleteRule = useCallback(
    (ruleId: string): Promise<void> =>
      guard('Could not delete the rule', async () => {
        const sessionId = currentSession?.id;
        if (!sessionId) throw new BridgeError('Select a session first.');
        await sendOperation('DELETE_RULE', { sessionId, json: { id: ruleId } });
        await refreshRules(sessionId);
        announce(`Rule ${ruleId} deleted.`);
      }),
    [announce, currentSession, guard, refreshRules, sendOperation],
  );

  // ─── running tests ─────────────────────────────────────────────────────────

  const runTest = useCallback(
    (scenario: TestScenario): Promise<void> =>
      guard('Could not run the scenario', async () => {
        const sessionId = currentSession?.id;
        if (!sessionId) throw new BridgeError('Select a session first.');

        // The control request must outlive the scenario's own timeout, or the interface
        // would abandon the server while the server is still legitimately waiting.
        const timeoutMs = (scenario.timeoutMs ?? 5_000) + 10_000;

        const { body } = await sendOperation('RUN_TEST', {
          sessionId,
          json: { scenario },
          timeoutMs,
        });

        const result = (body as { result: TestResult }).result;
        setLastResult(result);
        await refreshResults(sessionId);
        announce(
          `${scenario.name}: ${result.outcome} in ${Math.round(result.durationMs)} ms ` +
            `(${result.sentSegmentCount} write(s) out, ${result.responseCount} response(s) framed).`,
          result.passed ? 'info' : 'warn',
        );
      }),
    [announce, currentSession, guard, refreshResults, sendOperation],
  );

  const loadResult = useCallback(
    (resultId: string): Promise<void> =>
      guard('Could not load the result', async () => {
        const sessionId = currentSession?.id;
        if (!sessionId) throw new BridgeError('Select a session first.');
        const { body } = await sendOperation('GET_RESULT', {
          sessionId,
          json: { id: resultId },
        });
        setLastResult((body as { result: TestResult }).result);
      }),
    [currentSession, guard, sendOperation],
  );

  /**
   * Writes bytes verbatim, with no encoding and no correlation.
   *
   * This is how the interface demonstrates malformed input. There is no response to
   * await: whatever the peer does arrives on the timeline through the event stream.
   */
  const sendRaw = useCallback(
    (bytes: string): Promise<void> =>
      guard('Could not write the raw bytes', async () => {
        const response = await fetch('/bridge/raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bytes }),
        });
        const payload = (await readJson(response)) as Record<string, unknown>;
        if (!response.ok) {
          throw new BridgeError(String(payload['error'] ?? 'The raw write failed.'));
        }
        announce(`Wrote ${String(payload['bytesWritten'])} raw byte(s) with no encoding.`);
      }),
    [announce, guard],
  );

  const clearTimeline = useCallback((): void => {
    setWireEvents([]);
  }, []);

  // Learn the current state on mount, so a reloaded tab rejoins a live connection
  // rather than showing a disconnected interface over an open socket.
  useEffect(() => {
    let cancelled = false;

    void fetch('/bridge/status')
      .then((response) => readJson(response))
      .then((payload) => {
        if (cancelled) return;
        const current = payload as RelayStatus;
        setStatus(current);
        if (current.connected) {
          attachEvents();
          void refreshSessions().catch(() => {
            /* The panel simply stays empty; the user can retry. */
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          announce('The bridge is not reachable. Start it with `npm run dev:bridge`.', 'error');
        }
      });

    return () => {
      cancelled = true;
    };
    // Runs once: this is the initial handshake, not a subscription to its dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The event stream is closed on unmount only, so it survives every re-render.
  useEffect(
    () => () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = undefined;
    },
    [],
  );

  return {
    status,
    connecting,
    busy,
    sessions,
    currentSession,
    rules,
    results,
    lastResult,
    wireEvents,
    notice,
    connect,
    disconnect,
    selectSession,
    createSession,
    closeSession,
    addRule,
    updateRule,
    deleteRule,
    runTest,
    loadResult,
    sendRaw,
    clearTimeline,
    refreshSessions,
  };
}

/** The value the interface consumes, named for the components' prop types. */
export type BridgeApi = ReturnType<typeof useBridge>;
