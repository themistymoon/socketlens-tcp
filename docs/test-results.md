# Test Results

Recorded results of the verification suite for SocketLens TCP 0.1.1.

> Every figure in this document is copied from actual command output. Nothing here is
> estimated, projected, or rounded up. Where a result is imperfect it is recorded as it
> was, with the reason stated.

**Test plan** — [test-plan.md](test-plan.md) describes what is tested and why.
This document records what happened when it ran.

---

## Run environment

| Item        | Value               |
| ----------- | ------------------- |
| Date of run | 2026-08-05          |
| Platform    | Windows 11, `win32` |
| Node.js     | **v26.5.1**         |
| Vitest      | 3.2.7               |
| Vite        | 6.4.3               |
| Command     | `npm run verify`    |

**On the Node version.** The recorded run used Node v26.5.1, which is the version installed
on the development machine. This is **outside** the CI matrix, which pins 20.x, 22.x, and
24.x — the range declared by the `engines` field (`>=20.11.0`). The results below therefore
confirm the suite on one version above the supported range; the CI workflow is what confirms
it on the three supported versions. This is stated rather than glossed over because a local
pass on an untested version is weaker evidence than the matrix, and the difference matters.

---

## Summary

| Gate                       | Command                  | Result                           |
| -------------------------- | ------------------------ | -------------------------------- |
| Formatting                 | `prettier --check .`     | **pass** — all matched files     |
| Linting                    | `eslint .`               | **pass** — 0 errors, 31 warnings |
| Type checking              | `tsc -b` + `tsc -p`      | **pass** — no diagnostics        |
| Unit and integration tests | `vitest run`             | **pass** — 598 / 598             |
| Production build           | `build:ts` + `build:gui` | **pass**                         |
| Runnable examples          | `npm run examples`       | **pass** — 17 / 17 checks        |

Total: **598 automated tests** across 21 files, plus **17 example checks** across 11
example bundles.

---

## 1. Test suite

```
 Test Files  21 passed (21)
      Tests  598 passed (598)
   Duration  5.31s (transform 2.07s, collect 9.81s, tests 8.43s, prepare 5.26s)
```

### Per-file results

| File                               |   Tests |    Time | Layer                                 |
| ---------------------------------- | ------: | ------: | ------------------------------------- |
| `tests/protocol/decoder.test.ts`   |      55 |   25 ms | framing, the core correctness concern |
| `tests/protocol/encoder.test.ts`   |      17 |   15 ms | message serialisation                 |
| `tests/protocol/validate.test.ts`  |      21 |   16 ms | structural validation                 |
| `tests/core/validation.test.ts`    |      56 |   26 ms | bundle, rule, and scenario validation |
| `tests/core/matching.test.ts`      |      42 |   18 ms | rule matching and ordering            |
| `tests/core/assertions.test.ts`    |      29 |   17 ms | expected-versus-actual comparison     |
| `tests/core/session-store.test.ts` |      36 |  153 ms | session and rule lifecycle            |
| `tests/cli/options.test.ts`        |      32 |   18 ms | argument parsing                      |
| `tests/cli/dispatch.test.ts`       |      29 |   86 ms | command routing                       |
| `tests/cli/render.test.ts`         |      26 |   48 ms | output formatting                     |
| `tests/cli/help.test.ts`           |      15 |   16 ms | help text                             |
| `tests/cli/repl.test.ts`           |      33 |  599 ms | interactive mode, real sockets        |
| `tests/bridge/options.test.ts`     |      50 |   13 ms | bridge argument parsing               |
| `tests/bridge/events.test.ts`      |      17 |   40 ms | Server-Sent-Events fan-out            |
| `tests/bridge/relay.test.ts`       |      25 | 3843 ms | relay contracts, real sockets         |
| `tests/bridge/http.test.ts`        |      39 | 1661 ms | bridge routes, real `fetch`           |
| `tests/gui/form-parsing.test.ts`   |      18 |    9 ms | editor field parsing                  |
| `tests/gui/result-view.test.tsx`   |       6 |  134 ms | result panel rendering                |
| `tests/server/server.test.ts`      |      20 |  462 ms | integration, real TCP sockets         |
| `tests/server/scenarios.test.ts`   |      19 |  816 ms | integration, scenario execution       |
| `tests/server/concurrency.test.ts` |      13 |  532 ms | integration, multiple clients         |
| **Total**                          | **598** |         |                                       |

The three `tests/server/*` files bind real TCP ports on the loopback interface rather than
mocking the socket layer. That is deliberate: a mocked socket would deliver bytes in exactly
the groupings the test chose, which is precisely the assumption the whole project exists to
disprove. Their longer run times — 462 ms to 816 ms against single-digit milliseconds for the
unit suites — are the cost of using a real network stack, and are worth paying.

The bridge suites make the same trade and pay more for it. `relay.test.ts` at 3843 ms and
`http.test.ts` at 1661 ms are dominated by three tests that each wait out a deliberate
timeout against a peer that accepts a connection and then never answers. A tiny deadline
against the real server would be a race — on loopback a `PING` round trip can finish inside a
millisecond — so the silent peer is what makes the timeout the only possible outcome.

### The named integration case

Vitest flagged three tests as slow enough to name in the output:

```
✓ relaying a request > reports a client-side timeout as a 502 carrying the error code  1142ms
✓ exchanges > throws a typed client error when nothing answers in time  1122ms
✓ exchanges > does not count a request that never completed  1113ms
✓ raw writes > keeps deliberately malformed bytes out of the sent decoder  1224ms
```

The first is from `http.test.ts`, the latter three from `relay.test.ts`. All four bind a silent
peer that accepts and never answers, forcing the timeout to be the only possible outcome. A
tiny deadline against the real server would be a race — on loopback a `PING` can finish inside
a millisecond.

---

## 2. Coverage

```
npx vitest run --coverage
```

### Overall

| Metric     |   Value |
| ---------- | ------: |
| Statements | 70.41 % |
| Branches   | 84.05 % |
| Functions  | 81.17 % |
| Lines      | 70.41 % |

**The overall line figure is not the useful number, and it is worth saying why.** It
averages across the React interface, which is not broadly covered, so it understates coverage
of the parts where correctness actually matters. The per-area table is the honest view.

### By area

| Area                      | % Stmts | % Branch | % Funcs | % Lines |
| ------------------------- | ------: | -------: | ------: | ------: |
| `packages/protocol/src`   |   87.57 |    90.41 |   66.19 |   87.57 |
| `packages/core/src`       |   84.85 |    84.96 |   83.87 |   84.85 |
| `apps/server/src`         |   83.87 |    70.86 |   76.92 |   83.87 |
| `apps/cli/src`            |   76.22 |    78.16 |   81.70 |   76.22 |
| `apps/bridge/src`         |   94.55 |    89.91 |     100 |   94.55 |
| `apps/gui/src/lib`        |     100 |      100 |     100 |     100 |
| `apps/gui/src/components` |   11.68 |    86.48 |   88.88 |   11.68 |
| `apps/gui/src/hooks`      |       0 |      100 |     100 |       0 |

`apps/bridge/src` moved from 0 % to 94.55 % in this release, and `cli/repl.ts` from 0 % to
97.26 %. Those were the two gaps named in the 0.1.0 results as the ones that would most
improve the suite, because both contain real logic rather than presentation.

### The files that matter most

| File                     | % Lines | Note                                   |
| ------------------------ | ------: | -------------------------------------- |
| `protocol/decoder.ts`    |   84.69 | the incremental framing decoder        |
| `protocol/encoder.ts`    |   93.27 |                                        |
| `protocol/validate.ts`   |   93.47 |                                        |
| `protocol/errors.ts`     |     100 |                                        |
| `protocol/status.ts`     |   95.34 | the status registry                    |
| `protocol/operations.ts` |   93.58 | the operation registry                 |
| `protocol/types.ts`      |     100 |                                        |
| `protocol/constants.ts`  |     100 |                                        |
| `core/matching.ts`       | **100** | rule matching and ordering             |
| `core/assertions.ts`     |   99.37 | expected-versus-actual                 |
| `core/session-store.ts`  |   96.28 |                                        |
| `core/validation.ts`     |   92.12 |                                        |
| `core/test-runner.ts`    |   88.17 |                                        |
| `core/mock-endpoint.ts`  |   82.93 |                                        |
| `core/client.ts`         |   79.44 |                                        |
| `server/handlers.ts`     |   90.90 | the 13 operation handlers              |
| `server/server.ts`       |   78.57 |                                        |
| `cli/dispatch.ts`        |     100 |                                        |
| `cli/help.ts`            |     100 |                                        |
| `cli/options.ts`         |   98.02 |                                        |
| `cli/repl.ts`            |   97.26 | interactive mode                       |
| `cli/render.ts`          |   92.36 |                                        |
| `bridge/events.ts`       |     100 | Server-Sent-Events fan-out             |
| `bridge/options.ts`      |     100 |                                        |
| `bridge/http.ts`         |   93.33 | the six `/bridge/*` routes             |
| `bridge/relay.ts`        |   90.22 | owns the TCP socket the browser cannot |

`matching.ts` at 100 % line coverage is the one to point at: deterministic rule ordering is
what makes every other test in the suite reproducible, so it is the piece least tolerable to
leave partly exercised.

### Known coverage gaps

These are recorded as gaps, not defended as acceptable.

| Area                  |   Lines | Why it is uncovered                                                                                     |
| --------------------- | ------: | ------------------------------------------------------------------------------------------------------- |
| `apps/gui/src` hooks  |     0 % | Bridge connection hook; not covered.                                                                    |
| `apps/gui/src` most   |   ~12 % | Two component tests and one pure-logic test exist; the bulk of the interface remains manually verified. |
| `core/scenarios.ts`   |  7.14 % | Bundle **parsing** is covered via `validation.ts`; the file-loading paths are not.                      |
| `protocol/format.ts`  | 44.06 % | Display formatting helpers, reached mainly through the interface.                                       |
| `cli/state.ts`        | 45.83 % | Persisted CLI session state; partly exercised.                                                          |
| `cli/commands.ts`     | 54.27 % | Command bodies; the routing that reaches them is fully covered.                                         |
| `protocol/display.ts` | 60.81 % | Display helpers for the interface.                                                                      |
| `core/logger.ts`      | 73.54 % | Output formatting branches.                                                                             |

The interface is now the largest remaining gap. The two that were named in 0.1.0 —
`apps/bridge` and `cli/repl.ts` — are closed.

---

## 3. Examples

```
npm run examples
```

The runner starts its own server on an OS-assigned port, executes every scenario, and
compares each outcome against what that example's README documents.

```
SocketLens TCP examples — server on 127.0.0.1:2824
```

| Example                        | Scenario                                      | Outcome                  |   Time |
| ------------------------------ | --------------------------------------------- | ------------------------ | -----: |
| 01 Basic PING                  | `basic-ping`                                  | passed                   |   2 ms |
| 02 Session and rules           | `priority-wins`                               | passed                   |   1 ms |
| 02 Session and rules           | `fallback-applies`                            | passed                   |   1 ms |
| 03 Passing test, UTF-8 body    | `utf8-body-passes`                            | passed                   |   1 ms |
| **04 Expected versus actual**  | `expected-200-got-500`                        | **failed as documented** |   1 ms |
| **05 Fragmented message**      | `seven-fragments`                             | passed                   | 196 ms |
| **05 Fragmented message**      | `byte-at-a-time`                              | passed                   |   3 ms |
| **06 Coalesced messages**      | `two-messages-one-write`                      | passed                   |   1 ms |
| 07 Delayed response            | `slow-but-within-timeout`                     | passed                   | 406 ms |
| 08 Timeout                     | `timeout-is-expected`                         | passed                   | 507 ms |
| 09 Malformed Content-Length    | `non-numeric-content-length`                  | passed                   |   1 ms |
| 09 Malformed Content-Length    | `negative-content-length`                     | passed                   |   1 ms |
| 09 Malformed Content-Length    | `duplicate-content-length`                    | passed                   |   1 ms |
| 10 Disconnect during a message | `peer-closes-mid-response`                    | passed                   |   1 ms |
| 10 Disconnect during a message | `client-aborts-mid-request`                   | passed                   |  36 ms |
| 11 Two concurrent clients      | sessions stayed isolated (`ses-11`, `ses-12`) | passed                   |        |
| 11 Two concurrent clients      | fast finished at 2 ms, slow ran to 617 ms     | passed                   |        |

```
17/17 check(s) passed across 11 example(s)
```

### Reading the timings

**Example 05, `seven-fragments`, 196 ms.** This is the slowest scenario in the set and it is
slow on purpose. It sets `interFragmentDelayMs: 25` across seven writes — roughly 150 ms of
deliberate waiting. Without that delay, Nagle's algorithm may coalesce the seven small writes
back into one TCP segment inside the kernel, and the demonstration silently stops
demonstrating anything. **The tool has to work against TCP in order to demonstrate TCP.**

**Example 05, `byte-at-a-time`, 3 ms.** 134 separate single-byte writes with no inter-fragment
delay complete in 3 ms. Compare that with the 196 ms above: the cost is the deliberate
waiting, not the fragmentation.

**Example 08, 507 ms** against a declared 500 ms timeout: the timeout fired within 7 ms of
its deadline.

**Example 11**, one client finishing at 2 ms while another ran to 617 ms, is direct evidence
that a slow client does not block a fast one — the event-driven server handles both
concurrently rather than serialising them.

### Example 04 is meant to fail

`expected-200-got-500` is registered with the runner as an expected failure. If it ever
started passing, `npm run examples` would exit non-zero.

That inversion is deliberate. An assertion checker that has stopped detecting a real mismatch
is a worse defect than the mismatch it was meant to catch, and it is a defect that hides —
everything goes green. Registering the expected outcome rather than the expected pass is what
makes the check meaningful.

Examples 08 (timeout) and 10 (mid-message disconnect) are likewise registered with their
documented non-standard outcomes. Both are reported above as `passed` because each declares
its outcome in `expect` — `{ timeout: true }` and `{ disconnect: true }` respectively — so
the anomaly is the assertion, and observing it is a pass.

---

## 4. Static gates

### Formatting

```
> prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### Linting

```
> eslint .
✖ 31 problems (0 errors, 31 warnings)
```

All 31 are `@typescript-eslint/no-non-null-assertion`, configured as a warning rather than an
error. They cluster where `noUncheckedIndexedAccess` widens an index result to `T | undefined`
at a point where the surrounding code has already established the index is valid — for
example immediately after a successful regular-expression match, or on an array index guarded
by a preceding length check.

| File                               | Warnings |
| ---------------------------------- | -------: |
| `apps/cli/src/commands.ts`         |        9 |
| `apps/server/src/handlers.ts`      |       11 |
| `apps/cli/src/options.ts`          |        6 |
| `apps/cli/src/repl.ts`             |        1 |
| `apps/server/src/index.ts`         |        1 |
| `packages/protocol/src/decoder.ts` |        1 |
| `packages/protocol/src/display.ts` |        1 |
| `packages/protocol/src/headers.ts` |        1 |

Recorded rather than suppressed. Each is a place where a future refactor could turn a safe
assertion into an unsafe one without the compiler objecting, and a warning that stays visible
is the point.

### Type checking

```
> tsc -b tsconfig.json && tsc -p tsconfig.tests.json
```

No diagnostics across all six project references, nor across the test suite.

**The test suite was not type checked until the final audit.** Every `tsconfig` excludes
`*.test.ts`, and `tests/` sat outside all six project references, so `tsc -b` never saw it —
Vitest transpiles without checking types, so 410 passing tests proved nothing about their
types. Adding `tsconfig.tests.json` and wiring it into `typecheck` immediately surfaced a
real defect: the shared `testResult` fixture omitted `sentSegmentCount`, a required field of
`TestResult`. Every test built on that fixture had been carrying `undefined` in a
non-optional field. Nothing asserted on it, so nothing failed.

That is the kind of defect a green suite hides, and it is recorded here rather than quietly
fixed, because the lesson is the general one: **a passing test is not a type-checked test.**
The tests project uses `moduleResolution: "Bundler"` to mirror how Vitest actually resolves
the workspace aliases, which is also what lets one project cover both the Node-side tests and
the `.tsx` component tests.

### Build

```
> vite build
✓ 45 modules transformed.
dist/index.html                   0.60 kB │ gzip:  0.38 kB
dist/assets/index-C5HW1lIC.css    7.76 kB │ gzip:  2.05 kB
dist/assets/index-B_LXEI0f.js   238.36 kB │ gzip: 73.11 kB
✓ built in 704ms
```

---

## 5. Framing coverage

The 55 decoder tests are the centre of the suite. Every case below is covered by a named
test in `tests/protocol/decoder.test.ts`.

### Splitting one message across chunks

| Case                                                  | Covered |
| ----------------------------------------------------- | :-----: |
| Start line split mid-token                            |    ✔    |
| Split inside a header name                            |    ✔    |
| Split inside a header value                           |    ✔    |
| **Split between the CR and the LF of one terminator** |    ✔    |
| **Split inside the four-byte `\r\n\r\n` delimiter**   |    ✔    |
| Split inside a `Content-Length` line                  |    ✔    |
| Body split across chunks                              |    ✔    |
| **Multi-byte UTF-8 character split across chunks**    |    ✔    |
| One byte at a time                                    |    ✔    |

Three of these rows — the split between a CR and its LF, the split inside a `Content-Length`
line, and the split inside a header value — were added during the final audit, when checking
this table against the actual test names showed the table claimed more than the suite
delivered. They are listed here because they are now real tests, not because the table said
so first.

Adding them moved no coverage percentage at all: `decoder.ts` stayed at 84.69 % lines and
91.52 % branches. That is worth recording rather than hiding, because it is a concrete
demonstration that **line coverage does not measure whether the hard cases are tested**. The
same lines execute whether the cut lands in a harmless place or in the middle of a line
terminator; only the assertion differs. A suite can reach high coverage while missing every
case that actually breaks a decoder.

### Combining messages in one chunk

| Case                                       | Covered |
| ------------------------------------------ | :-----: |
| Two complete messages in one chunk         |    ✔    |
| One complete message plus part of the next |    ✔    |
| Several messages in one chunk              |    ✔    |

### Rejecting invalid input

| Case                                   | Status | Fatal | Covered |
| -------------------------------------- | ------ | :---: | :-----: |
| Missing `Request-ID`                   | 400    |  no   |    ✔    |
| Unknown operation                      | 501    |  no   |    ✔    |
| Unknown session                        | 404    |  no   |    ✔    |
| Malformed start line                   | 400    |  yes  |    ✔    |
| Empty start line                       | 400    |  yes  |    ✔    |
| Non-numeric `Content-Length`           | 400    |  yes  |    ✔    |
| Negative `Content-Length`              | 400    |  yes  |    ✔    |
| Duplicate conflicting `Content-Length` | 400    |  yes  |    ✔    |
| Message over 1 MiB                     | 413    |  yes  |    ✔    |
| Header block over 16 KiB               | 413    |  yes  |    ✔    |
| Start line over 1 KiB                  | 413    |  yes  |    ✔    |
| More than 64 headers                   | 413    |  yes  |    ✔    |
| Disconnect before a complete message   | —      |   —   |    ✔    |

### Edge cases

| Case                                                      | Covered |
| --------------------------------------------------------- | :-----: |
| Zero-length body                                          |    ✔    |
| No `Content-Length` and no body                           |    ✔    |
| Body of exactly the declared length                       |    ✔    |
| Bytes after a zero-length body start the **next** message |    ✔    |
| Duplicate extension headers preserved in wire order       |    ✔    |
| A body that itself contains a `\r\n\r\n` sequence         |    ✔    |
| UTF-8 body where byte length ≠ character length           |    ✔    |

The third-from-last row is the "unexpected body data" case, and it was also added during the
audit. `Content-Length: 0` frames an empty body, so bytes following the delimiter belong to
the next message. A decoder that absorbed them as stray body data would silently swallow a
legitimate second request — the failure would look like a hung connection, with nothing
logged.

The `\r\n\r\n`-inside-a-body row matters for a related reason: once `Content-Length` has
framed the body, the decoder must stop searching for the header delimiter. A decoder that
kept scanning would find the sequence inside the body and split one message into two.

---

## 6. What is not covered

Stated plainly so the gaps are not mistaken for coverage.

1. **The interface is only lightly covered.** `apps/gui` has two test files — the shared field
   parsers and the result panel — and nothing else. The remaining components and the bridge
   connection hook are verified by hand against the demo script.
2. **No cross-platform CI evidence in this document.** The recorded run is Windows only. The
   CI workflow covers Linux; those results are not reproduced here.
3. **The recorded run used Node v26.5.1**, above the 20/22/24 CI matrix, as noted at the top.
4. **No load or soak testing.** Concurrency is verified with two simultaneous clients, not
   hundreds, and no test runs long enough to surface a slow resource leak.
5. **No fuzzing.** Invalid inputs are the enumerated cases above, not randomly generated ones.
   A fuzzer over the decoder would be the single highest-value addition to this suite.

---

## Reproducing these results

```bash
npm ci
npm run verify     # format:check → lint → typecheck → test → build
npm run examples   # 11 example bundles against a real server
npm run test:coverage
```

`npm run verify` is exactly what CI runs, in that order. Its `typecheck` step covers both the
six project references and the test suite.
