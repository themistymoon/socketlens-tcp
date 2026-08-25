/**
 * Statistics and environment capture for the benchmark suite.
 *
 * Latency samples are collected with `process.hrtime.bigint()`, a monotonic clock
 * that cannot be moved by NTP or by a user changing the system time mid-run. The
 * wall clock is recorded once, for the report header only.
 */
import os from 'node:os';

/** A completed set of latency samples, in milliseconds. */
export interface LatencySummary {
  readonly count: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

/**
 * Returns the value at `fraction` through a sorted sample array, using nearest-rank.
 *
 * Nearest-rank is chosen over interpolation because it always returns an observed
 * measurement rather than a synthesised one: a reported p99 of 0.42 ms is a request
 * that actually took 0.42 ms.
 */
export function percentile(sortedMs: readonly number[], fraction: number): number {
  if (sortedMs.length === 0) return Number.NaN;
  const rank = Math.ceil(fraction * sortedMs.length);
  const index = Math.min(sortedMs.length - 1, Math.max(0, rank - 1));
  return sortedMs[index] as number;
}

/** Summarises raw latency samples. Does not mutate the input. */
export function summarise(samplesMs: readonly number[]): LatencySummary {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minMs: sorted.length > 0 ? (sorted[0] as number) : Number.NaN,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.length > 0 ? (sorted[sorted.length - 1] as number) : Number.NaN,
    meanMs: sorted.length > 0 ? total / sorted.length : Number.NaN,
  };
}

/** Relative spread of a set of values, as a fraction of the mean. */
export function relativeSpread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  return (Math.max(...values) - Math.min(...values)) / mean;
}

/** Outcome of comparing two implementations round by round. */
export interface SignTestResult {
  /** Rounds in which the left side was faster. */
  readonly leftWins: number;
  /** Rounds compared. Ties are excluded from both the count and the total. */
  readonly rounds: number;
  /** Two-sided exact binomial p-value under the null of no consistent difference. */
  readonly pValue: number;
  /** True when the null is rejected at the 5% level. */
  readonly significant: boolean;
}

/** Binomial coefficient. Exact for the small round counts this suite produces. */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return result;
}

/**
 * Paired sign test over per-round throughputs.
 *
 * Runs are executed round-major with the implementation order rotated, so run *i* of
 * every implementation happens under similar machine conditions. That makes the runs
 * pairable, which matters: a developer machine's absolute throughput wanders by tens of
 * percent, but the *ordering* within a round is far more stable.
 *
 * Using this instead of a min-max spread floor avoids discarding real effects. In one
 * observed sample the min-max spread reached 58% while the faster implementation still
 * won all ten rounds — a range-based test called that "no difference", and it was wrong.
 */
export function pairedSignTest(left: readonly number[], right: readonly number[]): SignTestResult {
  const pairs = Math.min(left.length, right.length);
  let leftWins = 0;
  let rounds = 0;
  for (let index = 0; index < pairs; index += 1) {
    const a = left[index] as number;
    const b = right[index] as number;
    if (a === b) continue; // A tie carries no directional information.
    rounds += 1;
    if (a > b) leftWins += 1;
  }

  if (rounds === 0) return { leftWins: 0, rounds: 0, pValue: 1, significant: false };

  // Two-sided exact p-value: probability of a split at least this lopsided.
  const extreme = Math.max(leftWins, rounds - leftWins);
  let tail = 0;
  for (let k = extreme; k <= rounds; k += 1) tail += choose(rounds, k);
  const pValue = Math.min(1, (2 * tail) / Math.pow(2, rounds));

  return { leftWins, rounds, pValue, significant: pValue < 0.05 };
}

/** Machine and runtime facts that make a result interpretable later. */
export interface BenchmarkEnvironment {
  readonly capturedAt: string;
  readonly platform: string;
  readonly osRelease: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemoryMiB: number;
}

/** Captures the environment the numbers were produced on. */
export function captureEnvironment(): BenchmarkEnvironment {
  const cpus = os.cpus();
  const first = cpus[0];
  return {
    capturedAt: new Date().toISOString(),
    platform: `${os.platform()} ${os.arch()}`,
    osRelease: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    cpuModel: first ? first.model.trim() : 'unknown',
    cpuCount: cpus.length,
    totalMemoryMiB: Math.round(os.totalmem() / (1024 * 1024)),
  };
}

/** Formats a millisecond figure to three decimal places. */
export function ms(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '—';
}

/** Formats a requests-per-second figure with thousands separators. */
export function rps(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—';
}
