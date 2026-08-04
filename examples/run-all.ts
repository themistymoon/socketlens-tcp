/**
 * Runs every documented example against a real SocketLens TCP server.
 *
 * This is the executable form of the `examples/` directory. Each example's README
 * makes claims about what the protocol does; this script starts a server, replays
 * the example's bundle over a raw TCP connection, and checks that the claims still
 * hold. If a README and the implementation ever disagree, this exits non-zero.
 *
 * The important detail is that the expected outcome is recorded per scenario, not
 * per example. Several examples deliberately fail or deliberately time out, and a
 * runner that treated "passed" as the only acceptable result would report those as
 * broken when they are in fact working exactly as documented.
 *
 *   npm run examples              # every example
 *   npm run examples -- --only 5  # one example
 *   npm run examples -- --list    # what is available
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import {
  SltpClient,
  parseBundle,
  silentLogger,
  type AddRuleInput,
  type TestResult,
  type TestScenario,
} from '@socketlens/core';
import { SLTP_STATUS } from '@socketlens/protocol';
import { startServer, type SltpServer } from '@socketlens/server';

const EXAMPLES_DIR = path.dirname(fileURLToPath(import.meta.url));

// ─── the manifest ────────────────────────────────────────────────────────────

/** What an example's README promises about one scenario. */
interface ExpectedScenario {
  readonly scenario: string;
  /** Whether the scenario's own assertions are documented to pass. */
  readonly passes: boolean;
  /** The SLTP status the control server returns for the RUN_TEST request. */
  readonly runTestStatus: number;
  /** Extra checks on the returned TestResult, beyond pass/fail. */
  readonly check?: (result: TestResult) => string | undefined;
}

/** One example directory. */
interface Example {
  readonly id: number;
  readonly directory: string;
  readonly title: string;
  /** Scenario-level expectations, or a custom driver for examples JSON cannot express. */
  readonly expected?: readonly ExpectedScenario[];
  readonly custom?: (context: CustomContext) => Promise<void>;
}

/** What a custom example driver is handed. */
interface CustomContext {
  readonly host: string;
  readonly port: number;
  readonly bundleRules: readonly AddRuleInput[];
  readonly bundleScenarios: readonly TestScenario[];
}

const PASSED = SLTP_STATUS.TEST_PASSED;
const FAILED = SLTP_STATUS.TEST_FAILED;

/**
 * A fatal framing fault desynchronises the stream, so the peer must say it is closing
 * rather than leaving the client to infer it from the FIN.
 */
function expectConnectionClose(result: TestResult): string | undefined {
  const connection = result.response?.headers['connection'];
  return connection === 'close'
    ? undefined
    : `expected "Connection: close" on a fatal framing fault, saw ${String(connection)}`;
}

const EXAMPLES: readonly Example[] = [
  {
    id: 1,
    directory: '01-basic-ping',
    title: 'Basic PING',
    expected: [{ scenario: 'basic-ping', passes: true, runTestStatus: PASSED }],
  },
  {
    id: 2,
    directory: '02-session-and-rule',
    title: 'Session and rules',
    expected: [
      { scenario: 'priority-wins', passes: true, runTestStatus: PASSED },
      { scenario: 'fallback-applies', passes: true, runTestStatus: PASSED },
    ],
  },
  {
    id: 3,
    directory: '03-passing-test',
    title: 'Passing test with a UTF-8 body',
    expected: [
      {
        scenario: 'utf8-body-passes',
        passes: true,
        runTestStatus: PASSED,
        // The README's whole point is that 20 characters occupy 32 bytes.
        check: (result) => {
          const declared = result.response?.headers['content-length'];
          if (declared !== '32') {
            return `expected Content-Length: 32 from the mock, saw ${String(declared)}`;
          }
          const body = result.response?.body ?? '';
          if (Buffer.byteLength(body, 'utf8') !== 32) {
            return `body is ${Buffer.byteLength(body, 'utf8')} bytes, not the declared 32`;
          }
          if (body.length === Buffer.byteLength(body, 'utf8')) {
            return 'the body has no multibyte characters, so it cannot demonstrate byte framing';
          }
          return undefined;
        },
      },
    ],
  },
  {
    id: 4,
    directory: '04-failing-test',
    title: 'Expected versus actual failure',
    expected: [
      {
        scenario: 'expected-200-got-500',
        // Documented to fail. A pass here would mean the failure reporting is broken.
        passes: false,
        runTestStatus: FAILED,
        check: (result) => {
          const failed = result.assertions.filter((a) => !a.passed);
          if (failed.length !== 2) {
            return `expected 2 failed assertions (statusCode and statusPhrase), saw ${failed.length}`;
          }
          if (result.response?.statusCode !== 500) {
            return `expected the mock to answer 500, saw ${String(result.response?.statusCode)}`;
          }
          return undefined;
        },
      },
    ],
  },
  {
    id: 5,
    directory: '05-fragmented-message',
    title: 'Fragmented message',
    expected: [
      {
        scenario: 'seven-fragments',
        passes: true,
        runTestStatus: PASSED,
        check: (result) =>
          result.sentSegmentCount === 7
            ? undefined
            : `expected 7 TCP writes, the runner made ${result.sentSegmentCount}`,
      },
      {
        scenario: 'byte-at-a-time',
        passes: true,
        runTestStatus: PASSED,
        check: (result) =>
          result.sentSegmentCount > 100
            ? undefined
            : `expected the request split into >100 writes, saw ${result.sentSegmentCount}`,
      },
    ],
  },
  {
    id: 6,
    directory: '06-coalesced-messages',
    title: 'Coalesced messages',
    expected: [
      {
        scenario: 'two-messages-one-write',
        passes: true,
        runTestStatus: PASSED,
        // This is the observable proof that TCP does not preserve message boundaries.
        check: (result) => {
          if (result.sentSegmentCount !== 1) {
            return `both requests must go out in one write, saw ${result.sentSegmentCount}`;
          }
          if (result.responseCount !== 2) {
            return `expected 2 responses framed from that one write, saw ${result.responseCount}`;
          }
          return undefined;
        },
      },
    ],
  },
  {
    id: 7,
    directory: '07-delayed-response',
    title: 'Delayed response',
    expected: [
      {
        scenario: 'slow-but-within-timeout',
        passes: true,
        runTestStatus: PASSED,
        check: (result) =>
          result.durationMs >= 350
            ? undefined
            : `the 400 ms delay was not observed; the exchange took ${result.durationMs} ms`,
      },
    ],
  },
  {
    id: 8,
    directory: '08-timeout',
    title: 'Timeout',
    expected: [
      {
        // Documented to pass *because* it timed out.
        scenario: 'timeout-is-expected',
        passes: true,
        runTestStatus: PASSED,
        check: (result) =>
          result.durationMs < 2000
            ? undefined
            : `the client waited ${result.durationMs} ms; the 500 ms timeout did not fire`,
      },
    ],
  },
  {
    id: 9,
    directory: '09-malformed-content-length',
    title: 'Malformed Content-Length',
    expected: [
      {
        scenario: 'non-numeric-content-length',
        passes: true,
        runTestStatus: PASSED,
        check: expectConnectionClose,
      },
      {
        scenario: 'negative-content-length',
        passes: true,
        runTestStatus: PASSED,
        check: expectConnectionClose,
      },
      {
        scenario: 'duplicate-content-length',
        passes: true,
        runTestStatus: PASSED,
        check: expectConnectionClose,
      },
    ],
  },
  {
    id: 10,
    directory: '10-disconnect-during-body',
    title: 'Disconnect during a message',
    expected: [
      { scenario: 'peer-closes-mid-response', passes: true, runTestStatus: PASSED },
      { scenario: 'client-aborts-mid-request', passes: true, runTestStatus: PASSED },
    ],
  },
  {
    id: 11,
    directory: '11-concurrent-clients',
    title: 'Two concurrent clients',
    custom: runConcurrentClients,
  },
];

// ─── reporting ───────────────────────────────────────────────────────────────

let failures = 0;
let checks = 0;

const ok = (text: string): void => {
  checks += 1;
  process.stdout.write(`    ok    ${text}\n`);
};

const bad = (text: string): void => {
  checks += 1;
  failures += 1;
  process.stdout.write(`    FAIL  ${text}\n`);
};

// ─── driving one example ─────────────────────────────────────────────────────

/** Loads and validates an example's bundle. */
async function loadBundle(
  directory: string,
): Promise<{ rules: readonly AddRuleInput[]; scenarios: readonly TestScenario[] }> {
  const file = path.join(EXAMPLES_DIR, directory, 'bundle.json');
  const text = await readFile(file, 'utf8');
  const parsed = parseBundle(text, `${directory}/bundle.json`);
  if (!parsed.ok) {
    throw new Error(`${directory}/bundle.json is invalid:\n  • ${parsed.problems.join('\n  • ')}`);
  }
  return { rules: parsed.value.rules ?? [], scenarios: parsed.value.scenarios };
}

/**
 * Runs one bundle-driven example over a real TCP control connection.
 *
 * Every step here is a genuine SLTP request: the session is created, the rules are
 * installed and the scenarios are run by sending encoded messages down a socket,
 * which is the same path the CLI and the GUI take.
 */
async function runExample(example: Example, host: string, port: number): Promise<void> {
  process.stdout.write(`\n  ${String(example.id).padStart(2, '0')} — ${example.title}\n`);

  const { rules, scenarios } = await loadBundle(example.directory);

  if (example.custom) {
    await example.custom({ host, port, bundleRules: rules, bundleScenarios: scenarios });
    return;
  }

  const client = new SltpClient({ host, port, logger: silentLogger('CLIENT') });
  await client.connect();

  try {
    const created = await client.send({
      operation: 'CREATE_SESSION',
      json: { name: `example-${example.id}`, description: example.title },
    });
    if (created.response.statusCode !== SLTP_STATUS.SESSION_CREATED) {
      bad(`CREATE_SESSION answered ${created.response.statusCode}, expected 201`);
      return;
    }
    const sessionId = String(
      (JSON.parse(created.response.body) as { session: { id: string } }).session.id,
    );

    for (const rule of rules) {
      const added = await client.send({ operation: 'ADD_RULE', sessionId, json: rule });
      if (added.response.statusCode !== SLTP_STATUS.RULE_ADDED) {
        bad(`ADD_RULE "${rule.name}" answered ${added.response.statusCode}, expected 212`);
        return;
      }
    }

    for (const expectation of example.expected ?? []) {
      const scenario = scenarios.find((candidate) => candidate.name === expectation.scenario);
      if (!scenario) {
        bad(`the bundle has no scenario named "${expectation.scenario}"`);
        continue;
      }
      await runOneScenario(client, sessionId, scenario, expectation);
    }
  } finally {
    client.close();
  }
}

/** Sends one RUN_TEST and compares the outcome against the documented one. */
async function runOneScenario(
  client: SltpClient,
  sessionId: string,
  scenario: TestScenario,
  expectation: ExpectedScenario,
): Promise<void> {
  // The control request must outlive the scenario's own timeout, or the client would
  // give up on the server while the server is still legitimately waiting on the mock.
  const controlTimeout = (scenario.timeoutMs ?? 5_000) + 10_000;

  const exchange = await client.send({
    operation: 'RUN_TEST',
    sessionId,
    json: { scenario },
    timeoutMs: controlTimeout,
  });

  const label = `${expectation.scenario}`;

  if (exchange.response.statusCode !== expectation.runTestStatus) {
    bad(
      `${label}: RUN_TEST answered ${exchange.response.statusCode} ${exchange.response.statusPhrase}, ` +
        `documented as ${expectation.runTestStatus}`,
    );
    return;
  }

  const result = (JSON.parse(exchange.response.body) as { result: TestResult }).result;

  if (result.passed !== expectation.passes) {
    bad(
      `${label}: documented to ${expectation.passes ? 'pass' : 'fail'} but ` +
        `${result.passed ? 'passed' : `failed (${describeFailures(result)})`}`,
    );
    return;
  }

  const problem = expectation.check?.(result);
  if (problem !== undefined) {
    bad(`${label}: ${problem}`);
    return;
  }

  const verdict = expectation.passes ? 'passed' : 'failed as documented';
  ok(`${label} ${verdict} (${result.outcome}, ${result.durationMs} ms)`);
}

/** Summarises why a result failed, for the runner's own error output. */
function describeFailures(result: TestResult): string {
  const failed = result.assertions.filter((assertion) => !assertion.passed);
  if (failed.length === 0) return result.outcome;
  return failed
    .map(
      (assertion) => `${assertion.field}: expected ${assertion.expected}, got ${assertion.actual}`,
    )
    .join('; ');
}

// ─── example 11: a case JSON cannot express ──────────────────────────────────

/**
 * Two clients, two connections, two sessions, overlapping in time.
 *
 * No single scenario can express this, because a scenario describes one exchange on
 * one connection. The point being demonstrated is that the server multiplexes: the
 * fast client's PING must complete while the slow client is still blocked waiting on
 * its 600 ms mock, which is only possible if the two connections have independent
 * receive buffers and independent handler state.
 */
async function runConcurrentClients(context: CustomContext): Promise<void> {
  const { host, port, bundleRules, bundleScenarios } = context;

  const slowScenario = bundleScenarios.find((s) => s.name === 'slow-client-work');
  const fastScenario = bundleScenarios.find((s) => s.name === 'fast-client-work');
  if (!slowScenario || !fastScenario) {
    bad('the bundle is missing slow-client-work or fast-client-work');
    return;
  }

  const setUp = async (label: string): Promise<{ client: SltpClient; sessionId: string }> => {
    const client = new SltpClient({ host, port, logger: silentLogger('CLIENT') });
    await client.connect();
    const created = await client.send({
      operation: 'CREATE_SESSION',
      json: { name: `concurrent-${label}` },
    });
    const sessionId = String(
      (JSON.parse(created.response.body) as { session: { id: string } }).session.id,
    );
    for (const rule of bundleRules) {
      await client.send({ operation: 'ADD_RULE', sessionId, json: rule });
    }
    return { client, sessionId };
  };

  const slow = await setUp('slow');
  const fast = await setUp('fast');

  try {
    if (slow.sessionId === fast.sessionId) {
      bad('both clients received the same session id; sessions are not isolated');
      return;
    }

    const started = Date.now();
    const finishTimes: Record<string, number> = {};

    const [slowExchange, fastExchange] = await Promise.all([
      slow.client
        .send({
          operation: 'RUN_TEST',
          sessionId: slow.sessionId,
          json: { scenario: slowScenario },
          timeoutMs: 15_000,
        })
        .then((exchange) => {
          finishTimes['slow'] = Date.now() - started;
          return exchange;
        }),
      fast.client
        .send({
          operation: 'RUN_TEST',
          sessionId: fast.sessionId,
          json: { scenario: fastScenario },
          timeoutMs: 15_000,
        })
        .then((exchange) => {
          finishTimes['fast'] = Date.now() - started;
          return exchange;
        }),
    ]);

    for (const [label, exchange] of [
      ['slow', slowExchange],
      ['fast', fastExchange],
    ] as const) {
      if (exchange.response.statusCode !== PASSED) {
        bad(`${label} client: RUN_TEST answered ${exchange.response.statusCode}, expected 210`);
        return;
      }
    }

    const slowAt = finishTimes['slow'] ?? 0;
    const fastAt = finishTimes['fast'] ?? 0;

    if (fastAt >= slowAt) {
      bad(
        `the fast client finished at ${fastAt} ms and the slow client at ${slowAt} ms; ` +
          'the server appears to be serialising connections',
      );
      return;
    }

    ok(`two sessions stayed isolated (${slow.sessionId} and ${fast.sessionId})`);
    ok(`the fast client finished at ${fastAt} ms while the slow client ran until ${slowAt} ms`);
  } finally {
    slow.client.close();
    fast.client.close();
  }
}

// ─── entry point ─────────────────────────────────────────────────────────────

function parseOnly(argv: readonly string[]): number | undefined {
  const index = argv.indexOf('--only');
  if (index === -1) return undefined;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value)) throw new Error('--only needs an example number, e.g. --only 6');
  return value;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: npm run examples [-- --only <n>] [-- --list]\n\n' +
        'Runs every example in examples/ against a real SocketLens TCP server and\n' +
        'checks each scenario produced the outcome its README documents.\n',
    );
    return 0;
  }

  if (argv.includes('--list')) {
    for (const example of EXAMPLES) {
      process.stdout.write(`  ${String(example.id).padStart(2, '0')}  ${example.title}\n`);
    }
    return 0;
  }

  const only = parseOnly(argv);
  const selected = only === undefined ? EXAMPLES : EXAMPLES.filter((e) => e.id === only);
  if (selected.length === 0) {
    process.stderr.write(`No example numbered ${String(only)}. Try --list.\n`);
    return 1;
  }

  // Port 0 lets the OS pick, so running the examples never collides with a server
  // the user already has open on 7420.
  let server: SltpServer | undefined;
  try {
    server = await startServer({ port: 0, logLevel: 'silent' });
    const address = server.address;
    if (!address) throw new Error('the server reported no address after listening');

    process.stdout.write(`SocketLens TCP examples — server on ${address.host}:${address.port}\n`);

    for (const example of selected) {
      try {
        await runExample(example, address.host, address.port);
      } catch (cause) {
        bad(
          `${example.directory} threw: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  } finally {
    if (server) await server.close();
  }

  process.stdout.write(
    `\n${checks - failures}/${checks} check(s) passed across ${selected.length} example(s)\n`,
  );
  return failures === 0 ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    process.stderr.write(
      `examples runner failed: ${cause instanceof Error ? cause.stack : String(cause)}\n`,
    );
    process.exitCode = 1;
  });
