/**
 * Scenario execution over a real TCP connection.
 *
 * The runner opens a genuine `node:net` connection to the target endpoint and writes
 * the scenario's request according to its transmission mode. Fragmentation is real
 * TCP segmentation produced by separate `socket.write()` calls, and coalescing is two
 * SLTP messages placed in a single write. Nothing here simulates the transport.
 *
 * Every byte written and every chunk read is timestamped and recorded, so the result
 * shows how the message was split on the wire and how it arrived — which is exactly
 * the evidence that TCP preserves byte order but not message boundaries.
 */
import net from 'node:net';
import {
  DEFAULT_TIMEOUT_MS,
  encodeRequest,
  firstDecodeFailure,
  getHeader,
  headersToRecord,
  isResponse,
  SLTP_HEADER,
  SltpDecoder,
  type SltpResponse,
} from '@socketlens/protocol';
import { evaluateExchange, type ObservedExchange } from './assertions.js';
import { newRequestId, newResultId } from './ids.js';
import { describeError, splitBuffer, splitIntoParts } from './mock-endpoint.js';
import type { ScenarioRequest, TestResult, TestScenario, WireSegment } from './models.js';
import type { ProtocolLogger } from './logger.js';

/** Everything the runner needs besides the scenario itself. */
export interface RunScenarioOptions {
  readonly sessionId: string;
  /** Default target, normally the session's own mock endpoint. */
  readonly host: string;
  readonly port: number;
  readonly logger: ProtocolLogger;
  /**
   * Hosts a scenario may target besides loopback. Empty by default: SocketLens TCP
   * is a local development tool and must not be pointed at third-party systems.
   */
  readonly allowedHosts?: readonly string[];
}

/** Loopback addresses a scenario may always target. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

/**
 * Executes one scenario and returns its stored result.
 *
 * Never throws for a protocol, timeout, or transport condition: those are outcomes
 * the tool exists to report. It throws only if the scenario itself is unencodable.
 */
export async function runScenario(
  scenario: TestScenario,
  options: RunScenarioOptions,
): Promise<TestResult> {
  const host = scenario.target?.host ?? options.host;
  const port = scenario.target?.port ?? options.port;
  const timeoutMs = scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  const resultId = newResultId();

  if (!isPermittedTarget(host, options.allowedHosts)) {
    return {
      id: resultId,
      sessionId: options.sessionId,
      scenarioName: scenario.name,
      outcome: 'error',
      passed: false,
      startedAt,
      durationMs: 0,
      assertions: [
        {
          field: 'target',
          passed: false,
          expected: 'a loopback or explicitly permitted development endpoint',
          actual: `${host}:${port}`,
          message:
            'SocketLens TCP only tests local development endpoints. ' +
            'Add the host to allowedHosts if it is a development endpoint you control.',
        },
      ],
      rawSent: '',
      rawReceived: '',
      error: `Target ${host}:${port} is not a permitted development endpoint.`,
      segments: [],
      sentSegmentCount: 0,
      receivedSegmentCount: 0,
      responseCount: 0,
    };
  }

  // Build the bytes before opening a socket, so an encoding mistake costs nothing.
  const primary = buildRequestBytes(scenario.request);
  const secondary = scenario.transmission?.coalesceWith
    ? buildRequestBytes(scenario.transmission.coalesceWith)
    : undefined;

  const mode = scenario.transmission?.mode ?? 'single';
  const payload = secondary ? Buffer.concat([primary, secondary]) : primary;

  // A coalesced write carries two requests, so two responses are expected back.
  const expectedResponses = mode === 'coalesced' && secondary ? 2 : 1;

  const chunks = planWrites(payload, scenario, mode);

  const exchange = await performExchange({
    host,
    port,
    chunks,
    timeoutMs,
    expectedResponses,
    disconnectAfterBytes: scenario.transmission?.disconnectAfterBytes,
    interFragmentDelayMs: scenario.transmission?.interFragmentDelayMs ?? 0,
  });

  const verdict = evaluateExchange(scenario.expect, exchange.observed);
  const first = exchange.responses[0];

  const result: TestResult = {
    id: resultId,
    sessionId: options.sessionId,
    scenarioName: scenario.name,
    outcome: verdict.outcome,
    passed: verdict.passed,
    startedAt,
    durationMs: exchange.durationMs,
    assertions: verdict.assertions,
    rawSent: exchange.sent.toString('utf8'),
    rawReceived: exchange.received.toString('utf8'),
    ...(first
      ? {
          response: {
            statusCode: first.statusCode,
            statusPhrase: first.statusPhrase,
            headers: headersToRecord(first.headers),
            body: first.body,
            bodyBytes: first.bodyBytes,
          },
        }
      : {}),
    ...(first && getHeader(first.headers, SLTP_HEADER.matchedRuleId)
      ? { matchedRuleId: getHeader(first.headers, SLTP_HEADER.matchedRuleId) as string }
      : {}),
    ...(exchange.observed.error ? { error: exchange.observed.error } : {}),
    segments: exchange.segments,
    sentSegmentCount: exchange.segments.filter((s) => s.direction === 'sent').length,
    receivedSegmentCount: exchange.segments.filter((s) => s.direction === 'received').length,
    responseCount: exchange.responses.length,
  };

  options.logger.testOutcome(
    scenario.name,
    result.passed,
    `outcome=${result.outcome} ${result.durationMs}ms ` +
      `sent=${exchange.sent.length}B in ${result.sentSegmentCount} write(s) ` +
      `received=${exchange.received.length}B in ${result.receivedSegmentCount} read(s) ` +
      `responses=${result.responseCount}` +
      (result.response ? ` status=${result.response.statusCode}` : ''),
  );

  return result;
}

// ─── request construction ────────────────────────────────────────────────────

/**
 * Turns a scenario request into wire bytes.
 *
 * A `raw` request bypasses the encoder completely: that is the only way to place a
 * deliberately malformed message on the wire, since the encoder refuses to produce
 * one. Escape sequences in the raw string are converted so a JSON scenario file can
 * express CRLF.
 */
export function buildRequestBytes(request: ScenarioRequest): Buffer {
  if (request.raw !== undefined) {
    return Buffer.from(unescapeWireString(request.raw), 'utf8');
  }

  const headers: Record<string, string> = { ...request.headers };
  // Every SLTP request must be correlatable, so supply a Request-ID if the scenario
  // did not. A scenario that deliberately omits it uses `raw` instead.
  const hasRequestId = Object.keys(headers).some(
    (name) => name.toLowerCase() === SLTP_HEADER.requestId.toLowerCase(),
  );
  if (!hasRequestId) headers[SLTP_HEADER.requestId] = newRequestId();

  return encodeRequest({
    operation: request.operation ?? 'PING',
    headers,
    body: request.body ?? null,
  });
}

/**
 * Converts the escape sequences a JSON scenario file can carry into real octets.
 * Only the sequences a protocol test needs are recognised; anything else is literal.
 */
export function unescapeWireString(input: string): string {
  let out = '';
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char !== '\\' || index + 1 >= input.length) {
      out += char;
      continue;
    }
    const next = input[index + 1];
    switch (next) {
      case 'r':
        out += '\r';
        index += 1;
        break;
      case 'n':
        out += '\n';
        index += 1;
        break;
      case 't':
        out += '\t';
        index += 1;
        break;
      case '0':
        out += '\0';
        index += 1;
        break;
      case '\\':
        out += '\\';
        index += 1;
        break;
      default:
        out += char;
        break;
    }
  }
  return out;
}

/** Decides how the payload is divided into individual `socket.write()` calls. */
function planWrites(payload: Buffer, scenario: TestScenario, mode: string): Buffer[] {
  if (mode !== 'fragmented') {
    // `single` and `coalesced` both write everything at once. Coalescing is precisely
    // the case where two messages share one write.
    return [payload];
  }
  const sizes = scenario.transmission?.fragmentSizes;
  if (sizes && sizes.length > 0) return splitBuffer(payload, sizes);
  return splitIntoParts(payload, scenario.transmission?.fragmentCount ?? 2);
}

// ─── the exchange ────────────────────────────────────────────────────────────

interface ExchangeInput {
  readonly host: string;
  readonly port: number;
  readonly chunks: readonly Buffer[];
  readonly timeoutMs: number;
  readonly expectedResponses: number;
  readonly disconnectAfterBytes?: number;
  readonly interFragmentDelayMs: number;
}

interface ExchangeOutput {
  readonly sent: Buffer;
  readonly received: Buffer;
  readonly segments: readonly WireSegment[];
  readonly responses: readonly SltpResponse[];
  readonly durationMs: number;
  readonly observed: ObservedExchange;
}

/**
 * Connects, writes, reads, and closes.
 *
 * Resolves exactly once. Every completion path — enough responses, timeout, peer
 * close, socket error — funnels through `finish`, so the socket is always destroyed
 * and the timer always cleared.
 */
function performExchange(input: ExchangeInput): Promise<ExchangeOutput> {
  return new Promise<ExchangeOutput>((resolve) => {
    const start = process.hrtime.bigint();
    const segments: WireSegment[] = [];
    const sentParts: Buffer[] = [];
    const receivedParts: Buffer[] = [];
    const responses: SltpResponse[] = [];
    // The client under test reads responses, so its decoder expects the response shape.
    const decoder = new SltpDecoder({ expect: 'response' });

    let settled = false;
    let clientAborted = false;
    let frameErrorMessage: string | undefined;

    const socket = net.createConnection({ host: input.host, port: input.port });
    socket.setNoDelay(true);

    const timer = setTimeout(() => finish({ timedOut: true }), input.timeoutMs);

    const elapsedMs = (): number => Number(process.hrtime.bigint() - start) / 1e6;

    function finish(state: { timedOut?: boolean; disconnected?: boolean; error?: string }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();

      const timedOut = state.timedOut === true && responses.length === 0;
      const disconnected =
        state.disconnected === true && responses.length < input.expectedResponses;

      resolve({
        sent: Buffer.concat(sentParts),
        received: Buffer.concat(receivedParts),
        segments,
        responses,
        durationMs: Math.round(elapsedMs()),
        observed: {
          ...(responses[0] ? { response: responses[0] } : {}),
          timedOut,
          disconnected,
          ...((state.error ?? frameErrorMessage)
            ? { error: state.error ?? frameErrorMessage }
            : {}),
        },
      });
    }

    socket.on('error', (cause) => {
      finish({ error: `TCP error: ${cause.message}` });
    });

    socket.on('data', (chunk: Buffer) => {
      receivedParts.push(chunk);
      segments.push({
        direction: 'received',
        atMs: Math.round(elapsedMs()),
        bytes: chunk.length,
        data: chunk.toString('utf8'),
      });

      for (const event of decoder.push(chunk)) {
        if (event.type === 'error') {
          frameErrorMessage = `${event.error.reason}: ${event.error.message}`;
          if (event.error.fatal) {
            finish({ error: frameErrorMessage });
            return;
          }
          continue;
        }
        if (isResponse(event.message)) responses.push(event.message);
      }

      if (responses.length >= input.expectedResponses) {
        // Give the peer no chance to send more; the exchange is complete.
        finish({});
      }
    });

    socket.on('close', () => {
      // Bytes still buffered in the decoder mean the peer closed mid-message.
      const pending = firstDecodeFailure(decoder.end());
      if (pending) frameErrorMessage = `${pending.error.reason}: ${pending.error.message}`;
      finish({
        disconnected: true,
        ...(clientAborted
          ? { error: 'The scenario closed the connection before finishing the request.' }
          : {}),
      });
    });

    socket.on('connect', () => {
      void (async () => {
        let written = 0;
        for (const [index, chunk] of input.chunks.entries()) {
          if (settled || socket.destroyed) return;

          if (index > 0 && input.interFragmentDelayMs > 0) {
            await sleep(input.interFragmentDelayMs);
            if (settled || socket.destroyed) return;
          }

          // A scenario may abort part-way through its own request.
          let toWrite = chunk;
          if (input.disconnectAfterBytes !== undefined) {
            const remaining = input.disconnectAfterBytes - written;
            if (remaining <= 0) {
              clientAborted = true;
              socket.destroy();
              return;
            }
            if (remaining < chunk.length) toWrite = chunk.subarray(0, remaining);
          }

          await write(socket, toWrite);
          written += toWrite.length;
          sentParts.push(toWrite);
          segments.push({
            direction: 'sent',
            atMs: Math.round(elapsedMs()),
            bytes: toWrite.length,
            data: toWrite.toString('utf8'),
          });

          if (input.disconnectAfterBytes !== undefined && written >= input.disconnectAfterBytes) {
            clientAborted = true;
            socket.destroy();
            return;
          }
        }
      })();
    });
  });
}

function write(socket: net.Socket, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.write(chunk, () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** True when a scenario is allowed to target this host. */
export function isPermittedTarget(host: string, allowedHosts: readonly string[] = []): boolean {
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return true;
  return allowedHosts.some((allowed) => allowed.toLowerCase() === host.toLowerCase());
}

export { describeError };
