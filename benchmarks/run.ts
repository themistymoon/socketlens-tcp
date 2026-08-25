/**
 * SLTP versus HTTP/1.1 benchmark runner.
 *
 * Measures the same minimal request-response workload over both protocols and reports
 * throughput, latency percentiles, and measured application byte counts. Read
 * `benchmarks/README.md` before quoting any number from this: the caveats there are
 * not boilerplate, they are the difference between a measurement and a marketing
 * claim.
 *
 *   npm run benchmark -- --runs 10
 *   npm run benchmark
 *   npm run benchmark -- --iterations 5000 --warmup 1000
 *   npm run benchmark -- --json
 */
import {
  captureEnvironment,
  ms,
  pairedSignTest,
  relativeSpread,
  rps,
  summarise,
  type BenchmarkEnvironment,
  type LatencySummary,
} from './stats.js';
import { IMPLEMENTATIONS, type Implementation } from './protocols.js';

/** Payload sizes measured, in bytes. */
const PAYLOAD_SIZES = [0, 128, 1024, 16384] as const;

const DEFAULT_ITERATIONS = 2_000;
const DEFAULT_WARMUP = 500;
const DEFAULT_RUNS = 6;

/**
 * Fewest rounds at which a two-sided sign test can reach p < 0.05.
 *
 * With n rounds the smallest attainable p-value is 2 / 2^n, so n = 5 bottoms out at
 * 0.0625 and only n = 6 (0.031) can clear the threshold. Below this, a clean sweep is
 * still not evidence, and saying "no consistent winner" would confuse *no power to
 * detect* with *tested and found nothing*.
 */
const MIN_ROUNDS_FOR_SIGNIFICANCE = 6;

interface Options {
  readonly iterations: number;
  readonly warmup: number;
  readonly runs: number;
  readonly json: boolean;
}

/** One measured run of one implementation at one payload size. */
interface RunResult {
  readonly durationMs: number;
  readonly requestsPerSecond: number;
  readonly latency: LatencySummary;
  /** Mean application bytes written per request, measured at the socket. */
  readonly requestBytes: number;
  /** Mean application bytes read per response, measured at the socket. */
  readonly responseBytes: number;
}

/** Every run of one implementation at one payload size. */
interface CellResult {
  readonly implementation: string;
  readonly key: string;
  readonly payloadBytes: number;
  readonly runs: readonly RunResult[];
  /** Headline figure: the median run's throughput. Robust to outlier slow runs. */
  readonly medianRequestsPerSecond: number;
  /** Best single observation. Shown for transparency; not used for comparisons. */
  readonly bestRequestsPerSecond: number;
  /** Worst single observation, so the full range is visible. */
  readonly minRequestsPerSecond: number;
  readonly medianOfMediansMs: number;
  /** Spread of requests/sec across runs, as a fraction of the mean. */
  readonly runSpread: number;
}

/** Median of a sample. Returns NaN for an empty sample. */
function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2) as number;
}

function parseArgs(argv: readonly string[]): Options | { readonly error: string } {
  let iterations = DEFAULT_ITERATIONS;
  let warmup = DEFAULT_WARMUP;
  let runs = DEFAULT_RUNS;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readNumber = (): number | undefined => {
      const raw = argv[index + 1];
      index += 1;
      if (raw === undefined) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
    };

    if (arg === '--json') {
      json = true;
    } else if (arg === '--iterations') {
      const value = readNumber();
      if (value === undefined) return { error: '--iterations needs a positive number' };
      iterations = value;
    } else if (arg === '--warmup') {
      const raw = argv[index + 1];
      index += 1;
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        return { error: '--warmup needs a number of zero or more' };
      }
      warmup = Math.floor(value);
    } else if (arg === '--runs') {
      const value = readNumber();
      if (value === undefined) return { error: '--runs needs a positive number' };
      runs = value;
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else {
      return { error: `Unknown argument: ${String(arg)}` };
    }
  }

  return { iterations, warmup, runs, json };
}

const USAGE = `socketlens benchmark — SLTP/1.0 over node:net versus HTTP/1.1

  npm run benchmark -- --runs 10        # recommended before quoting a figure
  npm run benchmark
  npm run benchmark -- --iterations 5000 --warmup 1000
  npm run benchmark -- --json

Options
  --iterations <n>  measured round trips per run (default ${DEFAULT_ITERATIONS})
  --warmup <n>      discarded round trips before measuring (default ${DEFAULT_WARMUP})
  --runs <n>        repeats of every case, to expose variance (default ${DEFAULT_RUNS})
  --json            emit machine-readable JSON instead of a table
  --help            print this text

Method notes
  Every implementation is warmed up before any measurement begins, and runs are
  ordered run-major with the implementation order rotated, so no implementation
  absorbs the process's JIT warm-up on its own.
  Headline figures and all comparisons are MEDIANS across runs. Best-of-N rises
  with N, so it cannot be the basis of a stable ratio; it is shown alongside the
  minimum so the observed range is visible.

Both sides run on 127.0.0.1 on an OS-assigned port, so neither collides with a
control server already listening on 7420. Read benchmarks/README.md for what these
numbers do and do not mean.`;

/** Performs one measured run of one implementation at one payload size. */
async function oneRun(
  implementation: Implementation,
  payload: Buffer,
  options: Options,
): Promise<RunResult> {
  const server = await implementation.start();
  const client = await implementation.connect(server.port);

  try {
    for (let index = 0; index < options.warmup; index += 1) {
      await client.roundTrip(payload);
    }

    // Byte counters are snapshotted around the measured phase only, so warm-up
    // traffic and the HTTP client's priming request are excluded.
    const writtenBefore = client.bytesWritten();
    const readBefore = client.bytesRead();

    const samplesMs: number[] = new Array<number>(options.iterations);
    const startedAt = process.hrtime.bigint();
    for (let index = 0; index < options.iterations; index += 1) {
      const requestStart = process.hrtime.bigint();
      await client.roundTrip(payload);
      samplesMs[index] = Number(process.hrtime.bigint() - requestStart) / 1e6;
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const written = client.bytesWritten() - writtenBefore;
    const read = client.bytesRead() - readBefore;

    return {
      durationMs,
      requestsPerSecond: (options.iterations / durationMs) * 1000,
      latency: summarise(samplesMs),
      requestBytes: written / options.iterations,
      responseBytes: read / options.iterations,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Exercises every implementation before any measurement begins.
 *
 * Without this, the first implementation measured absorbed the whole cost of V8 warming
 * up the shared socket and Buffer code paths. A 10-run sample made the effect obvious:
 * the first cell measured climbed monotonically from 24,992 to 36,008 req/s across its
 * ten runs, a 26.6% drift, while every later cell showed no trend at all. Since the
 * implementation order was fixed, that penalty always fell on the same implementation.
 *
 * This warm-up is deliberately symmetric — every implementation runs the same number of
 * round trips at the same payload size — so it removes an order bias rather than
 * granting anyone an advantage.
 */
async function globalWarmup(options: Options): Promise<void> {
  const payload = Buffer.alloc(1024, 0x61);
  const rounds = Math.max(options.warmup, 500);
  for (const implementation of IMPLEMENTATIONS) {
    const server = await implementation.start();
    const client = await implementation.connect(server.port);
    try {
      for (let index = 0; index < rounds; index += 1) {
        await client.roundTrip(payload);
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
}

/**
 * Measures every implementation at one payload size, interleaved and rotated.
 *
 * Runs are ordered run-major rather than implementation-major: run 1 of every
 * implementation happens before run 2 of any of them, and the order within a run
 * rotates. Any residual drift in the machine's behaviour over the course of the
 * benchmark is therefore shared evenly instead of accumulating against whichever
 * implementation happened to be measured first.
 */
async function measurePayload(payloadBytes: number, options: Options): Promise<CellResult[]> {
  const payload = Buffer.alloc(payloadBytes, 0x61);
  const collected = new Map<string, RunResult[]>(IMPLEMENTATIONS.map((i) => [i.key, []]));

  for (let run = 0; run < options.runs; run += 1) {
    // Rotate the starting implementation so each one leads an equal share of runs.
    const order = IMPLEMENTATIONS.map(
      (_, index) => IMPLEMENTATIONS[(index + run) % IMPLEMENTATIONS.length] as Implementation,
    );
    for (const implementation of order) {
      if (!options.json) {
        process.stderr.write(
          `payload ${payloadBytes} B  run ${run + 1}/${options.runs}  ${implementation.key} ...`.padEnd(
            58,
          ) + '\r',
        );
      }
      const result = await oneRun(implementation, payload, options);
      collected.get(implementation.key)?.push(result);
    }
  }

  return IMPLEMENTATIONS.map((implementation) => {
    const results = collected.get(implementation.key) ?? [];
    const throughputs = results.map((result) => result.requestsPerSecond);
    return {
      implementation: implementation.label,
      key: implementation.key,
      payloadBytes,
      runs: results,
      medianRequestsPerSecond: median(throughputs),
      bestRequestsPerSecond: Math.max(...throughputs),
      minRequestsPerSecond: Math.min(...throughputs),
      medianOfMediansMs: median(results.map((result) => result.latency.medianMs)),
      runSpread: relativeSpread(throughputs),
    };
  });
}

/**
 * Describes how two cells compare.
 *
 * Two things guard against overclaiming. The ratio quoted is between **medians**, because
 * best-of-N is an increasing function of N and so cannot be the basis of a stable ratio.
 * Whether a difference is claimed at all is decided by a **paired sign test** over the
 * per-round throughputs, not by the size of the gap.
 *
 * The sign test is the right instrument here because absolute throughput on a developer
 * machine wanders by tens of percent while the ordering within a round is much steadier.
 * A range-based floor would discard real effects: in one sample the min-max spread hit 58%
 * and the faster side still won all ten rounds.
 */
function compare(left: CellResult, right: CellResult, leftName: string, rightName: string): string {
  const test = pairedSignTest(
    left.runs.map((run) => run.requestsPerSecond),
    right.runs.map((run) => run.requestsPerSecond),
  );
  const ratio = left.medianRequestsPerSecond / right.medianRequestsPerSecond;
  const winner = ratio > 1 ? leftName : rightName;
  const magnitude = ratio > 1 ? ratio : 1 / ratio;
  const wins = Math.max(test.leftWins, test.rounds - test.leftWins);
  const record = `${wins}/${test.rounds} rounds, p=${test.pValue.toFixed(3)}`;

  // Too few rounds to conclude anything either way. Say that, rather than reporting a
  // null result that the test never had the power to find.
  if (test.rounds < MIN_ROUNDS_FOR_SIGNIFICANCE) {
    return (
      `${winner} ahead ${magnitude.toFixed(2)}× on ${wins}/${test.rounds} rounds — ` +
      `too few rounds to test (needs ${MIN_ROUNDS_FOR_SIGNIFICANCE}+; use --runs 10)`
    );
  }
  if (!test.significant) {
    return `no consistent winner (${record})`;
  }
  return `${winner} ${magnitude.toFixed(2)}× ${ratio > 1 ? rightName : leftName} (${record})`;
}

/** Prints the human-readable report. */
function report(
  environment: BenchmarkEnvironment,
  options: Options,
  cells: readonly CellResult[],
): void {
  console.log('');
  console.log('SocketLens TCP — protocol benchmark');
  console.log('═'.repeat(78));
  console.log(`Captured    ${environment.capturedAt}`);
  console.log(`Platform    ${environment.platform} (release ${environment.osRelease})`);
  console.log(`Node.js     ${environment.nodeVersion}`);
  console.log(`CPU         ${environment.cpuModel} × ${environment.cpuCount}`);
  console.log(`Memory      ${environment.totalMemoryMiB} MiB`);
  console.log(
    `Workload    ${options.iterations} measured round trips after ${options.warmup} warm-up, ` +
      `${options.runs} run(s) per case`,
  );
  console.log('Transport   127.0.0.1, one persistent connection, one request in flight');
  console.log('Order       run-major and rotated, after a symmetric warm-up of every side');
  console.log('Headline    median run. "best" and "min" show the observed range.');
  console.log('');

  for (const payloadBytes of PAYLOAD_SIZES) {
    const forSize = cells.filter((cell) => cell.payloadBytes === payloadBytes);
    if (forSize.length === 0) continue;

    console.log(`Payload ${payloadBytes === 0 ? 'empty' : `${payloadBytes} B`}`);
    console.log('─'.repeat(78));
    console.log(
      'Implementation               median    best     min  medLat   req B  resp B  spread',
    );
    for (const cell of forSize) {
      const label = cell.implementation.padEnd(26);
      // Bytes are a property of the encoding, not of a run, so any run reports them.
      const anyRun = cell.runs[0] as RunResult;
      console.log(
        `${label} ${rps(cell.medianRequestsPerSecond).padStart(6)}  ` +
          `${rps(cell.bestRequestsPerSecond).padStart(6)}  ` +
          `${rps(cell.minRequestsPerSecond).padStart(6)}  ` +
          `${ms(cell.medianOfMediansMs).padStart(6)}  ` +
          `${Math.round(anyRun.requestBytes).toString().padStart(6)}  ` +
          `${Math.round(anyRun.responseBytes).toString().padStart(6)}  ` +
          `${(cell.runSpread * 100).toFixed(1).padStart(5)}%`,
      );
    }

    const sltp = forSize.find((cell) => cell.key === 'sltp');
    const minimal = forSize.find((cell) => cell.key === 'http-minimal');
    const nodeHttp = forSize.find((cell) => cell.key === 'http-node');

    // The like-for-like comparison is the one that says anything about the framing
    // strategy. Report it first, and separately from the library comparison.
    if (sltp && minimal) {
      console.log(
        `→ framing, like for like:  ${compare(sltp, minimal, 'SLTP', 'minimal HTTP/1.1')}`,
      );
    }
    if (sltp && nodeHttp) {
      console.log(`→ against node:http:       ${compare(sltp, nodeHttp, 'SLTP', 'node:http')}`);
    }
    console.log('');
  }

  const worstSpread = Math.max(...cells.map((cell) => cell.runSpread));
  if (worstSpread > 0.15) {
    console.log(
      `Note: run-to-run spread reached ${(worstSpread * 100).toFixed(1)}%. ` +
        'Treat differences smaller than that as noise, and re-run on an idle machine.',
    );
  }
  if (options.runs < MIN_ROUNDS_FOR_SIGNIFICANCE) {
    console.log(
      `Note: ${options.runs} run(s) per case cannot reach significance — a two-sided sign ` +
        `test needs at least ${MIN_ROUNDS_FOR_SIGNIFICANCE} rounds. Use --runs 10.`,
    );
  } else if (options.runs < 10) {
    console.log(`Note: ${options.runs} run(s) per case. Use --runs 10 before quoting a figure.`);
  }
  console.log('Ratios are between medians; whether a difference is claimed at all is decided');
  console.log('by a paired sign test over rounds, not by the size of the gap. Latency is');
  console.log('milliseconds. Byte counts are application bytes measured');
  console.log('at the socket, excluding Ethernet, IP, and TCP headers. Loopback results do not');
  console.log('predict LAN or WAN behaviour. See benchmarks/README.md.');
  console.log('');
}

/** Entry point. Returns a process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      console.log(USAGE);
      return 0;
    }
    console.error(`${parsed.error}\n`);
    console.error(USAGE);
    return 1;
  }

  const environment = captureEnvironment();
  const cells: CellResult[] = [];

  if (!parsed.json) process.stderr.write('warming up every implementation ...'.padEnd(58) + '\r');
  await globalWarmup(parsed);

  for (const payloadBytes of PAYLOAD_SIZES) {
    cells.push(...(await measurePayload(payloadBytes, parsed)));
  }
  if (!parsed.json) process.stderr.write(' '.repeat(58) + '\r');

  if (parsed.json) {
    console.log(
      JSON.stringify(
        {
          tool: 'socketlens-tcp benchmark',
          environment,
          workload: {
            iterations: parsed.iterations,
            warmup: parsed.warmup,
            runs: parsed.runs,
            host: '127.0.0.1',
            connectionReuse: true,
            concurrency: 1,
            globalWarmup: true,
            order: 'run-major, implementation order rotated per run',
            headlineAggregate: 'median of runs',
          },
          caveats: [
            'Loopback only. These numbers do not predict LAN or WAN behaviour.',
            'Byte counts are application bytes at the socket, excluding Ethernet/IP/TCP headers.',
            'Both peers are minimal echo servers, not the SocketLens control server.',
            'One machine and one Node.js version. Results are not universal.',
            'Comparisons use medians; best-of-N is an increasing function of N.',
          ],
          results: cells,
        },
        null,
        2,
      ),
    );
  } else {
    report(environment, parsed, cells);
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    console.error(`benchmark failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  });
