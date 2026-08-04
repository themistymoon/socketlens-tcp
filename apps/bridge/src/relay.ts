/**
 * The piece that owns the real TCP socket.
 *
 * A browser cannot open a raw TCP connection — there is no API for it, by design — so
 * the graphical client cannot speak SLTP directly. The relay closes that gap: it holds
 * one `SltpClient` (the *same* client the CLI uses, over the same `node:net` socket)
 * and exposes it to the interface as a handful of loopback HTTP endpoints.
 *
 * The distinction that matters for this project's claims: HTTP here is a local control
 * surface between two processes on one machine, carrying commands *about* SLTP. The SLTP
 * conversation itself — the protocol under study — is raw TCP throughout, framed by the
 * same decoder the server and CLI use. No HTTP framing ever touches an SLTP message.
 *
 * Nothing is re-implemented for the browser. Every request is encoded by the shared
 * encoder, every response is framed by the shared incremental decoder, and the interface
 * receives {@link SltpMessageView} projections of what actually crossed the wire.
 */
import { SltpClient, SltpClientError, ProtocolLogger, type LogLevel } from '@socketlens/core';
import {
  SltpDecoder,
  toMessageView,
  getHeader,
  escapeCrlfInline,
  statusForReason,
  SLTP_HEADER,
  type SltpWireEvent,
  type SltpMessageView,
  type SltpDirection,
} from '@socketlens/protocol';
import { type EventHub } from './events.js';

/** What the relay needs to reach the SLTP control server. */
export interface RelayOptions {
  readonly serverHost: string;
  readonly serverPort: number;
  readonly timeoutMs: number;
  readonly logLevel: LogLevel;
  readonly hub: EventHub;
}

/** Connection state the interface renders in its status bar. */
export interface RelayStatus {
  readonly connected: boolean;
  readonly serverHost: string;
  readonly serverPort: number;
  /** Identifier of the current TCP connection, when one is open. */
  readonly connectionId?: string;
  /** Why the last connection ended, when it ended unexpectedly. */
  readonly lastError?: string;
  /** Number of SLTP requests sent over the lifetime of the bridge. */
  readonly requestsSent: number;
}

/** A request the interface asks the relay to send. */
export interface RelayRequest {
  readonly operation: string;
  readonly sessionId?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Structured body, encoded as JSON with the correct Content-Type. */
  readonly json?: unknown;
  /** Text body, used when `json` is absent. */
  readonly body?: string;
  readonly timeoutMs?: number;
}

/** What the interface receives back from a relayed request. */
export interface RelayExchange {
  readonly requestId: string;
  readonly durationMs: number;
  readonly request: SltpMessageView;
  readonly response: SltpMessageView;
}

/**
 * Relays interface commands onto one raw TCP connection.
 *
 * The relay deliberately keeps a single connection rather than one per request. That
 * makes the protocol's correlation model visible in the interface: several requests may
 * be in flight at once on the same socket, and each response is matched to its request
 * by `Request-ID` rather than by arrival order.
 */
export class Relay {
  private readonly options: RelayOptions;
  private readonly hub: EventHub;
  private readonly logger: ProtocolLogger;

  private client: SltpClient | undefined;
  private connecting: Promise<void> | undefined;
  private detachRawWatcher: (() => void) | undefined;
  private detachWriteWatcher: (() => void) | undefined;
  private detachCloseWatcher: (() => void) | undefined;

  /**
   * Set while {@link sendRaw} is writing, so the write tap ignores those bytes.
   *
   * Deliberately malformed bytes must not reach the sent decoder: a fatal framing fault
   * would desynchronise it and corrupt the display of every well-formed request after.
   */
  private rawWriteInProgress = false;

  /** Decodes the bytes this process sends, so the timeline shows both directions. */
  private sentDecoder = new SltpDecoder({ expect: 'request' });
  /** Decodes the bytes arriving from the server. */
  private receivedDecoder = new SltpDecoder({ expect: 'response' });

  /**
   * Views of requests seen by the write tap, keyed by `Request-ID`.
   *
   * The tap fires before `send()` resolves, so the view is already waiting here by the
   * time the caller needs it. Bounded, because a request that times out is never
   * collected and would otherwise accumulate for the life of the process.
   */
  private readonly sentViews = new Map<string, SltpMessageView>();

  private sequence = 0;
  private requestsSent = 0;
  private lastError: string | undefined;

  constructor(options: RelayOptions) {
    this.options = options;
    this.hub = options.hub;
    this.logger = new ProtocolLogger({ role: 'BRIDGE', level: options.logLevel });
  }

  /** Current connection state, for the interface's status bar. */
  get status(): RelayStatus {
    return {
      connected: this.client?.connected ?? false,
      serverHost: this.options.serverHost,
      serverPort: this.options.serverPort,
      ...(this.client?.connected ? { connectionId: this.client.id } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      requestsSent: this.requestsSent,
    };
  }

  /**
   * Opens the TCP connection, or joins an attempt already in progress.
   *
   * Two browser tabs pressing Connect at the same moment must not open two sockets, so
   * concurrent callers await the same promise.
   */
  async connect(): Promise<RelayStatus> {
    if (this.client?.connected) return this.status;
    if (this.connecting) {
      await this.connecting;
      return this.status;
    }

    this.connecting = this.openConnection();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
    return this.status;
  }

  /** Opens one connection and wires up the wire-event taps. */
  private async openConnection(): Promise<void> {
    const client = new SltpClient({
      host: this.options.serverHost,
      port: this.options.serverPort,
      timeoutMs: this.options.timeoutMs,
      logger: this.logger,
    });

    // A new connection starts a new byte stream, so the framing state must not carry
    // over from a previous one; leftover partial bytes would corrupt the first message.
    this.sentDecoder = new SltpDecoder({ expect: 'request' });
    this.receivedDecoder = new SltpDecoder({ expect: 'response' });

    try {
      await client.connect();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.lastError = reason;
      this.hub.publishNotice(`Could not connect to the SLTP server: ${reason}`, 'error');
      this.hub.publishStatus(this.status);
      throw cause;
    }

    this.client = client;
    this.lastError = undefined;

    // Every byte arriving from the server is decoded here and published, which is what
    // fills the interface's timeline. This is a tap on the same stream the client reads,
    // not a second parse of a different one.
    this.detachRawWatcher = client.onRawData((chunk) => {
      this.publishFrames(this.receivedDecoder, chunk, 'inbound');
    });

    // Requests are published at write time, not after `send()` resolves. Publishing
    // later would place every response ahead of the request that caused it, because a
    // response can arrive before the awaiting caller resumes.
    this.detachWriteWatcher = client.onRawWrite((chunk) => {
      if (this.rawWriteInProgress) return;
      const views = this.publishFrames(this.sentDecoder, chunk, 'outbound');
      for (const view of views) {
        const requestId = getHeader(view.headers, SLTP_HEADER.requestId);
        if (requestId) this.sentViews.set(requestId, view);
      }
    });

    this.detachCloseWatcher = client.onClose((reason) => {
      this.lastError = reason;
      this.client = undefined;
      this.detachRawWatcher?.();
      this.detachRawWatcher = undefined;
      this.detachWriteWatcher?.();
      this.detachWriteWatcher = undefined;
      // Any request still awaiting a response will now be rejected, so nothing will ever
      // collect its view.
      this.sentViews.clear();
      this.hub.publishNotice(`The SLTP connection closed: ${reason}`, 'warn');
      this.hub.publishStatus(this.status);
    });

    this.hub.publishNotice(
      `Connected to ${this.options.serverHost}:${this.options.serverPort} over raw TCP as ${client.id}.`,
    );
    this.hub.publishStatus(this.status);
  }

  /** Closes the connection at the interface's request. */
  async disconnect(): Promise<RelayStatus> {
    const client = this.client;
    if (!client) return this.status;

    this.detachCloseWatcher?.();
    this.detachCloseWatcher = undefined;
    this.detachRawWatcher?.();
    this.detachRawWatcher = undefined;
    this.detachWriteWatcher?.();
    this.detachWriteWatcher = undefined;
    this.sentViews.clear();
    this.client = undefined;

    await client.close();
    this.hub.publishNotice('Disconnected at your request.');
    this.hub.publishStatus(this.status);
    return this.status;
  }

  /**
   * Sends one SLTP request and returns the correlated response.
   *
   * A non-2xx status resolves normally rather than throwing. Displaying error statuses
   * with their phrases is the entire point of the tool, so `404 SESSION NOT FOUND` is a
   * result to render, not a failure to report.
   */
  async send(request: RelayRequest): Promise<RelayExchange> {
    const client = await this.requireClient();

    const exchange = await client.send({
      operation: request.operation,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.json !== undefined ? { json: request.json } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });

    this.requestsSent += 1;

    const receivedView = toMessageView(exchange.response, exchange.rawResponse);

    // The write tap already decoded and published these bytes, so the view is collected
    // here rather than parsed a second time. Decoding it again would emit a duplicate
    // timeline entry and would feed the same bytes through the decoder twice.
    const requestView = this.takeSentView(exchange.requestId);
    if (!requestView) {
      // Unreachable in practice: the encoder produced these bytes, so they frame.
      throw new Error('The relay could not decode the request it had just encoded.');
    }

    return {
      requestId: exchange.requestId,
      durationMs: exchange.durationMs,
      request: requestView,
      response: receivedView,
    };
  }

  /**
   * Writes bytes exactly as given, with no encoding and no correlation.
   *
   * This is how the interface demonstrates malformed input — a bad `Content-Length`, a
   * truncated header block — which by definition cannot be produced by the encoder. The
   * response, if any, arrives through the normal `onRawData` tap, because bytes written
   * this way carry no `Request-ID` to correlate against.
   */
  async sendRaw(bytes: string): Promise<{ readonly bytesWritten: number }> {
    const client = await this.requireClient();
    const payload = Buffer.from(bytes, 'utf8');

    this.rawWriteInProgress = true;
    try {
      await client.sendRaw(payload);
    } finally {
      this.rawWriteInProgress = false;
    }
    this.requestsSent += 1;

    // Raw bytes are deliberately not fed to the sent decoder: they may be malformed on
    // purpose, and poisoning the decoder's framing state would corrupt the display of
    // every well-formed request afterwards. They are published verbatim instead.
    this.publish({
      seq: (this.sequence += 1),
      at: new Date().toISOString(),
      direction: 'outbound',
      connectionId: client.id,
      bytes: payload.length,
      raw: escapeCrlfInline(bytes),
    });

    return { bytesWritten: payload.length };
  }

  /** Ends the connection and every event stream. */
  async close(): Promise<void> {
    this.detachCloseWatcher?.();
    this.detachRawWatcher?.();
    this.detachWriteWatcher?.();
    this.sentViews.clear();
    const client = this.client;
    this.client = undefined;
    if (client) await client.close();
  }

  /**
   * Removes and returns the view that was captured when a request was written.
   *
   * Bounded: a request that times out or whose connection closes is never collected, so
   * it would otherwise accumulate here for the life of the process.
   */
  private takeSentView(requestId: string): SltpMessageView | undefined {
    const view = this.sentViews.get(requestId);
    if (view) this.sentViews.delete(requestId);
    return view;
  }

  /** Returns the live client, connecting on demand if the interface has not yet. */
  private async requireClient(): Promise<SltpClient> {
    if (this.client?.connected) return this.client;
    await this.connect();
    const client = this.client;
    if (!client?.connected) {
      throw new SltpClientError(
        'not-connected',
        `Not connected to ${this.options.serverHost}:${this.options.serverPort}.`,
      );
    }
    return client;
  }

  /**
   * Feeds a chunk through a decoder and publishes every complete message in it.
   *
   * One chunk may hold no complete message, exactly one, or several — the decoder's
   * incremental contract — so this returns a list rather than a single view.
   */
  private publishFrames(
    decoder: SltpDecoder,
    chunk: Buffer,
    direction: SltpDirection,
  ): SltpMessageView[] {
    const views: SltpMessageView[] = [];

    for (const event of decoder.push(chunk)) {
      if (event.type === 'error') {
        this.publish({
          seq: (this.sequence += 1),
          at: new Date().toISOString(),
          direction,
          connectionId: this.client?.id ?? 'closed',
          error: {
            code: event.error.reason,
            message: event.error.message,
            status: statusForReason(event.error.reason),
          },
          bytes: event.raw.length,
          raw: escapeCrlfInline(event.raw.toString('utf8')),
        });
        continue;
      }

      const view = toMessageView(event.message, event.raw);
      views.push(view);

      const requestId = getHeader(event.message.headers, SLTP_HEADER.requestId);
      const sessionId = getHeader(event.message.headers, SLTP_HEADER.sessionId);

      this.publish({
        seq: (this.sequence += 1),
        at: new Date().toISOString(),
        direction,
        connectionId: this.client?.id ?? 'closed',
        ...(requestId ? { requestId } : {}),
        ...(sessionId ? { sessionId } : {}),
        message: view,
        bytes: event.raw.length,
        raw: escapeCrlfInline(event.raw.toString('utf8')),
      });
    }

    return views;
  }

  /** Publishes one wire event to every attached tab. */
  private publish(event: SltpWireEvent): void {
    this.hub.publishWire(event);
  }
}
