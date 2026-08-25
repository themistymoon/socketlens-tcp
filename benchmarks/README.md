# Benchmarks

A reproducible comparison of SLTP/1.0 against HTTP/1.1 on the same minimal
request-response workload.

```bash
npm run benchmark -- --runs 10                     # recommended before quoting a figure
npm run benchmark                                  # default: 2000 iterations, 6 runs
npm run benchmark -- --iterations 5000 --warmup 1000
npm run benchmark -- --json                        # machine-readable
npm run benchmark -- --help
```

The suite is deliberately **not** part of `npm run verify`. A performance threshold in a
correctness gate turns an unrelated background process into a failed build.

## Why three implementations, not two

Comparing SLTP against `node:http` alone would have produced a flattering and false
result. `node:http` is a general-purpose HTTP stack: it runs `llhttp`, allocates
`IncomingMessage` and `ServerResponse` stream objects per request, supports chunked
transfer coding and trailers, and manages socket timeouts. A hand-written 100-line
framing loop will beat it, and that says nothing whatsoever about the two wire formats.

So the suite measures three things:

| Key            | What it is                                                      | What comparing it to SLTP isolates                 |
| -------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| `sltp`         | Minimal SLTP peer using the real `@socketlens/protocol` package | —                                                  |
| `http-minimal` | Minimal hand-written HTTP/1.1 over `node:net`, matched in style | **The framing design itself**, like for like       |
| `http-node`    | Node's own `node:http` server and keep-alive client             | The cost of a general-purpose library, not of HTTP |

`http-minimal` is not a usable HTTP implementation and must not be copied anywhere: it
has no chunked coding, no pipelining, no `Transfer-Encoding`, and no header validation.
It exists only so the framing comparison is fair.

## What is held equal

- Both peers bind `127.0.0.1` on an **OS-assigned port**, so a benchmark never collides
  with a control server already listening on 7420.
- `setNoDelay(true)` everywhere. Leaving Nagle's algorithm enabled on one side would add
  up to a 40 ms delay per round trip on small writes and would measure a kernel timer.
- **One persistent connection** per run, so nothing pays a TCP handshake per iteration.
- **One request in flight at a time.** HTTP/1.1 without pipelining cannot do better, and
  holding SLTP to the same rule is what makes the numbers comparable.
- The same echo workload: receive an N-byte body, send the same N bytes back.
- `node:http` keeps its **default response headers**, including `Date`. Stripping them
  would have made HTTP look artificially cheap on bytes.
- The SLTP request carries a `Request-ID`, because a real SLTP client always sends one.
  It is a genuine byte cost of the design and it is reported, not hidden.

Latency is sampled per round trip with `process.hrtime.bigint()`, a monotonic clock that
cannot be moved by NTP or by the system clock changing mid-run. Warm-up iterations are
discarded before measurement begins, and the socket byte counters are snapshotted around
the measured phase only, so warm-up traffic is excluded.

## Method: order, aggregation, and significance

Three decisions here do most of the work in making the numbers defensible. All three came
out of inspecting a 10-run sample rather than from theory.

**Every implementation is warmed up before any measurement begins.** A 10-run sample of the
original design showed the first cell measured climbing monotonically from 24,992 to 36,008
req/s across its ten runs — a 26.6% drift — while every later cell showed no trend at all.
That was V8 warming up the shared socket and `Buffer` code paths, and because the
implementation order was fixed, the whole cost landed on whichever implementation went
first. It went first every time, so the penalty was systematic rather than random. (It fell
on `sltp`, so it happened to bias _against_ this project's own protocol, but a bias that
favours you is no more acceptable than one that does not.)

**Runs are interleaved and rotated.** Ordering is run-major: run 1 of every implementation
happens before run 2 of any of them, and the implementation order rotates each round. Any
residual drift in the machine's behaviour is therefore shared out evenly instead of
accumulating against whoever was measured first.

**Headline figures are medians, and differences are decided by a paired sign test.**

- Medians, because **best-of-N is an increasing function of N**: a best-of-3 figure and a
  best-of-10 figure are not the same quantity, so a ratio between two of them is not a
  stable measurement. The best and the minimum are still shown, so the observed range is
  visible, but nothing is computed from them.
- A **paired sign test**, because absolute throughput on a developer machine wanders by tens
  of percent while the _ordering within a round_ is much steadier. Since runs are
  interleaved, run _i_ of each implementation ran under similar conditions and the runs pair
  up naturally. The test asks how often A beat B across rounds and reports an exact
  two-sided binomial p-value.

The sign test replaced an earlier min-max-spread floor, which was actively misleading: in
one sample the spread reached 58% while the faster implementation still won all ten rounds.
A range-based rule called that "no difference". It was wrong, and in the direction that
flatters this project.

## Recorded result

One machine, one Node.js version. Reproduce before citing.

| Field    | Value                                           |
| -------- | ----------------------------------------------- |
| Captured | 2026-08-25T07:20:53Z                            |
| Platform | win32 x64, Windows release 10.0.26200           |
| Node.js  | v26.5.1                                         |
| CPU      | AMD Ryzen 7 7840HS w/ Radeon 780M × 16          |
| Memory   | 28455 MiB                                       |
| Workload | 2000 measured round trips, 500 warm-up, 10 runs |

`median` is the headline. `best` and `min` bound the observed range. `medLat` is the median
run's median latency in milliseconds. Byte columns are application bytes measured at the
socket. `spread` is (max − min) / mean, which is deliberately the least flattering
dispersion measure available.

| Payload | Implementation | median     | best   | min    | medLat | req B | resp B | spread |
| ------- | -------------- | ---------- | ------ | ------ | ------ | ----- | ------ | ------ |
| empty   | `sltp`         | 27,458     | 31,483 | 17,384 | 0.030  | 41    | 90     | 53.9%  |
| empty   | `http-minimal` | **33,134** | 41,789 | 25,718 | 0.026  | 136   | 85     | 47.5%  |
| empty   | `http-node`    | 12,387     | 13,843 | 7,548  | 0.069  | 136   | 170    | 53.2%  |
| 128 B   | `sltp`         | 23,501     | 27,434 | 20,702 | 0.039  | 231   | 239    | 28.4%  |
| 128 B   | `http-minimal` | **30,221** | 33,828 | 26,060 | 0.032  | 266   | 215    | 26.1%  |
| 128 B   | `http-node`    | 10,681     | 11,871 | 9,566  | 0.088  | 266   | 300    | 21.4%  |
| 1 KiB   | `sltp`         | 20,468     | 22,363 | 19,470 | 0.045  | 1128  | 1136   | 13.9%  |
| 1 KiB   | `http-minimal` | **30,170** | 31,772 | 22,440 | 0.029  | 1163  | 1112   | 32.1%  |
| 1 KiB   | `http-node`    | 11,162     | 11,759 | 8,445  | 0.084  | 1163  | 1197   | 30.3%  |
| 16 KiB  | `sltp`         | 6,565      | 6,954  | 5,666  | 0.132  | 16489 | 16497  | 20.0%  |
| 16 KiB  | `http-minimal` | **11,980** | 12,892 | 10,356 | 0.070  | 16524 | 16473  | 21.2%  |
| 16 KiB  | `http-node`    | 6,581      | 7,452  | 5,874  | 0.137  | 16524 | 16558  | 24.1%  |

### Significance, by paired rounds

| Payload | Comparison               | Median ratio | Rounds won | p     | Verdict                  |
| ------- | ------------------------ | ------------ | ---------- | ----- | ------------------------ |
| empty   | `http-minimal` vs `sltp` | 1.21×        | 10/10      | 0.002 | significant              |
| 128 B   | `http-minimal` vs `sltp` | 1.29×        | 9/10       | 0.021 | significant              |
| 1 KiB   | `http-minimal` vs `sltp` | 1.47×        | 10/10      | 0.002 | significant              |
| 16 KiB  | `http-minimal` vs `sltp` | 1.82×        | 10/10      | 0.002 | significant              |
| empty   | `sltp` vs `http-node`    | 2.22×        | 10/10      | 0.002 | significant              |
| 128 B   | `sltp` vs `http-node`    | 2.20×        | 10/10      | 0.002 | significant              |
| 1 KiB   | `sltp` vs `http-node`    | 1.83×        | 10/10      | 0.002 | significant              |
| 16 KiB  | `sltp` vs `http-node`    | 1.00×        | 4/10       | 0.754 | **no consistent winner** |

`http-minimal` beat `sltp` in **39 of 40 paired rounds**, and the effect is significant at
every payload size.

### Reproducibility across samples

Three independent 10-run samples were taken on the same machine. Absolute throughput moved
between samples; the **ratios did not**, which is what the conclusion rests on.

| Comparison              | empty      | 128 B      | 1 KiB      | 16 KiB     |
| ----------------------- | ---------- | ---------- | ---------- | ---------- |
| `http-minimal` / `sltp` | 1.19–1.35× | 1.28–1.32× | 1.33–1.47× | 1.82–1.97× |
| `sltp` / `http-node`    | 2.22–2.46× | 2.01–2.20× | 1.83–1.88× | 0.96–1.00× |

## What the numbers say

**SLTP is not faster than HTTP/1.1.** Implemented in the same minimal style, `http-minimal`
beat `sltp` at every payload size, by a median 1.21× to 1.82×, winning 39 of 40 paired
rounds. Any claim that this project's protocol is faster than HTTP would be false, and the
benchmark exists to establish that rather than to avoid the question.

**The gap is validation, not framing.** Both benchmark implementations use comparable
framing: a CRLF-delimited header block terminated by `\r\n\r\n`, and a body length read from
an explicit `Content-Length`. Since both readers do equivalent framing work, the framing
strategy cannot explain a difference. What differs is the work each reader does once the
bytes are in hand.

This says nothing about SLTP and HTTP/1.1 being equivalent protocols — they differ in
start-line grammar, routing, status semantics, body transfer (HTTP/1.1 also has chunked
coding; SLTP has none), caching, and header vocabulary. The claim is only that the framing
strategy used by these two implementations is comparable, which is what makes isolating it
worthwhile. The SLTP decoder checks every header name and value against a grammar, rejects
duplicates of single-valued headers, enforces four separate size limits, validates the
operation token, and builds a structured message object. `http-minimal` finds the delimiter,
scans for one header, and slices. The strictness is deliberate — a tool for diagnosing
framing bugs must reject an ambiguous message rather than guess at it — and this is what it
costs.

**Against `node:http`, the purpose-built implementation wins up to 1 KiB** — a median 2.22×
at empty, 2.20× at 128 B, 1.83× at 1 KiB, each on 10/10 rounds. **At 16 KiB there is no
consistent winner**: `sltp` won 4 of 10 rounds (p = 0.754) and the median ratio is 1.00×.
Where the win exists it is a real cost a developer would pay in practice, but it is a
property of the library, not of the protocol.

**SLTP requests are smaller; SLTP responses are slightly larger.** An empty SLTP request is
41 bytes against 136 for HTTP, because `SLTP/1.0 PING` is shorter than a
method-path-version line and SLTP has no `Host` header to route by. The response is 90 bytes
against 85, because SLTP always carries a `Request-ID` so replies can be correlated out of
order.

**Variance stays large, and is reported rather than smoothed away.** The worst min-max
spread in the recorded sample is 53.9% (`sltp` at empty payload, where one run managed
17,384 req/s and another 31,483). Interleaving and the global warm-up removed the systematic
_drift_; they did not and cannot remove machine noise from a laptop with background
processes and CPU frequency scaling. That is precisely why the conclusion rests on paired
rounds rather than on the size of the gap: the ordering within a round survived noise that
the absolute numbers did not. Use `--runs 10` on an otherwise idle machine before quoting
anything.

## What these numbers do not mean

- **Loopback is not a network.** There is no propagation delay, no path MTU discovery, no
  packet loss, no reordering, and no congestion control doing anything interesting. On a
  LAN or a WAN, round-trip time dominates and every difference measured here disappears
  into the noise floor.
- **Byte counts are application bytes**, taken from Node's own socket counters. They
  exclude Ethernet, IP, and TCP header overhead, so they are not what a packet capture
  totals.
- **Neither peer is the real server.** `sltp` here is a minimal echo peer, not the
  SocketLens control server, which additionally routes operations, matches rules, stores
  results, and adds `Server` and `Timestamp` headers to every response. Real SLTP
  responses are larger and slower than these.
- **One machine, one Node.js version.** Results on a different CPU, OS, or Node release
  will differ. Node's HTTP stack in particular changes between releases.
- **This is a sequential single-connection workload.** It says nothing about behaviour
  under concurrency, many connections, or sustained load.
- **The ratios are not precise to three figures.** Across three independent 10-run samples
  the `http-minimal` / `sltp` ratio moved between 1.19× and 1.97× depending on payload and
  sample. Quote the range and the payload size, not a single number.
- **A significant sign test is not a claim about magnitude.** It says the ordering is
  consistent, not that the median ratio is the true effect size.

## Interpretation

The evaluation that draws on these numbers, including what HTTP/1.1 does better and why
this project exists regardless, is in [`../docs/evaluation.md`](../docs/evaluation.md).
