# SocketLens TCP — Test Plan

Version 0.1.0. This document states **what is tested, why, and how to run it**. It is a
plan, not a report: it records intent and coverage obligations. Recorded outcomes from an
actual run live in `docs/test-results.md`, which is generated separately from real output
and is not part of this document.

Requirement identifiers in the right-hand columns refer to
[`docs/requirements.md`](./requirements.md).

---

## 1. Testing strategy

The central claim of this project is that **TCP is a reliable, ordered byte stream that
does not preserve application message boundaries** (see the purpose section of
[`docs/requirements.md`](./requirements.md)). A test suite that mocked the transport would
be unable to substantiate that claim. The strategy therefore splits along a single line:

- Where behaviour is **pure and deterministic** — framing, validation, matching, assertion
  evaluation, argument parsing — it is tested as a unit, in memory, with byte chunks fed in
  by hand. This is where the awkward framing cases live, because a unit test can deliver a
  message one byte at a time or cut a multibyte character in half, which is difficult to
  provoke reliably over a real socket.
- Where behaviour is **about the transport** — concurrency, session lifecycle, real
  segmentation, timeouts, disconnects — it is tested over **real TCP sockets on
  OS-assigned ports** (NFR-23). Nothing at this level is simulated: `RUN_TEST` opens a
  genuine connection to a genuine mock endpoint and the segment counts in the result are
  counts of real `write()` calls and real `data` events (FR-46, FR-49).

Four supporting decisions follow from this.

| Decision                                                    | Rationale                                                                                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests run against TypeScript sources, never against `dist/` | `npm test` needs no prior build, so a stale build cannot produce a passing suite (NFR-22). The Vitest config aliases `@socketlens/*` to `src/`. |
| Every integration test binds port `0`                       | Two suites, or a suite and a developer's own server, can never collide on a fixed port (NFR-23, FR-18).                                         |
| Test and hook timeouts are 20 s                             | Real socket work, deliberate delays, and slow machines would otherwise produce flakes rather than findings (NFR-24).                            |
| Each test closes what it opened                             | The process must exit when the suite ends; a leaked listener or timer is itself a defect under NFR-6 and NFR-25.                                |

### 1.1 What is deliberately not tested

Recording this matters as much as recording coverage, so that a gap is never mistaken for
an oversight.

| Not covered                                    | Why                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Asynchronous `RUN_TEST` (`202 TEST ACCEPTED`)  | Not implemented in v0.1; the status is reserved but unreachable. See the known gap section of [`docs/requirements.md`](./requirements.md). |
| TLS, UDP, QUIC, remote capture, authentication | Out of scope for v0.1 by requirement, so there is no behaviour to test.                                                                    |
| Non-loopback network behaviour                 | Refused by design (NFR-14). The test asserts the refusal, not the connection.                                                              |
| Persistence across restarts                    | All state is in-process by requirement; there is nothing to persist.                                                                       |

---

## 2. Test levels

Five levels, each with a distinct purpose and its own command. The first four are Vitest
suites under `tests/`; the fifth is a standalone runner under `examples/`.

| Level              | Location          | Transport                                  | Purpose                                                  |
| ------------------ | ----------------- | ------------------------------------------ | -------------------------------------------------------- |
| Protocol unit      | `tests/protocol/` | none — byte arrays                         | Framing, encoding, validation                            |
| Core unit          | `tests/core/`     | none, except the session store's endpoints | Domain logic: matching, assertions, storage              |
| Server integration | `tests/server/`   | real TCP                                   | Operations, concurrency, scenario execution              |
| CLI unit           | `tests/cli/`      | none                                       | Argument parsing and rendering                           |
| Example scenarios  | `examples/`       | real TCP                                   | The documented demonstrations still behave as documented |

### 2.1 Commands

```bash
npm test                  # every Vitest suite, once
npm run test:watch        # the same suites in watch mode
npm run test:coverage     # with a v8 coverage report in ./coverage
npm run examples          # the eleven example scenarios, against a real server
npm run verify            # format:check, lint, typecheck, test, build
```

To run one level, pass its directory to Vitest:

```bash
npx vitest run tests/protocol
npx vitest run tests/core
npx vitest run tests/server
npx vitest run tests/cli
```

The examples runner takes its own flags, after the `--` separator that npm requires:

```bash
npm run examples -- --list      # numbers and titles
npm run examples -- --only 6    # a single example
npm run examples -- --help      # the runner's usage
```

`npm run examples` builds first (`npm run build:ts && tsx examples/run-all.ts`), because
`tsx` resolves `@socketlens/*` through each package's `exports` into `dist/` rather than
through the Vitest aliases. See the gotchas section of
[`docs/developer-guide.md`](./developer-guide.md).

### 2.2 Level 1 — protocol unit tests

`tests/protocol/` — the incremental decoder, the encoder, and semantic request validation.
This is the most important level in the suite: every framing obligation in FR-2 to FR-10
is discharged here, because a byte array can be delivered in any shape a test wants.

| File               | Covers                                                                                                                                                           | Requirements                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `decoder.test.ts`  | Complete messages, messages split across chunks, several messages per chunk, invalid framing, size limits, stream termination, request/response role enforcement | FR-2 to FR-10, NFR-1, NFR-10 |
| `encoder.test.ts`  | Serialisation, `Content-Length` computed from UTF-8 bytes, header canonicalisation, CRLF injection refusal, round-tripping through the decoder                   | FR-2, FR-5                   |
| `validate.test.ts` | Validation in the fixed documented order, fault precedence, endpoint-specific options, body helpers                                                              | FR-13, FR-16, FR-29          |

The decoder is exercised through a shared helper that pushes bytes in a caller-chosen
shape, so the same message can be delivered whole, in named chunk sizes, or one byte at a
time without duplicating the message construction.

### 2.3 Level 2 — core unit tests

`tests/core/` — the domain logic every client shares, tested without a server.

| File                    | Covers                                                                                                                                                 | Requirements                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `matching.test.ts`      | Operation, header and body matching in all four body modes; deterministic ordering; the rejection trace; JSON-subset semantics; match-equivalence keys | FR-35 to FR-38, NFR-3               |
| `assertions.test.ts`    | Expected-versus-actual for status line, headers and body; timeout and disconnect as _expected outcomes_; the no-response case                          | FR-51, FR-52                        |
| `session-store.test.ts` | Session lifecycle, rule CRUD and conflicts, result storage and eviction, aggregate stats                                                               | FR-27 to FR-34, FR-38, FR-55, FR-57 |

Two properties get particular attention here because a mistake in either is invisible until
it produces a wrong answer in a demonstration:

- **Ordering is a specification, not an implementation detail.** `orderRules` is tested to
  sort by priority descending then insertion sequence ascending, to produce the same order
  regardless of input order, and not to mutate its argument (FR-36, NFR-3).
- **A timeout or a disconnect can be the passing outcome.** `evaluateExchange` is tested
  both ways round: an expected timeout that happens passes, and an expected timeout that
  does _not_ happen fails (FR-51).

### 2.4 Level 3 — server integration tests

`tests/server/` — a real server on an OS-assigned port, driven by a real client over a real
socket. A shared harness starts and stops the server per suite.

| File                  | Covers                                                                                                                    | Requirements                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `server.test.ts`      | `PING`, `SERVER_INFO`, `Request-ID` correlation, session lifecycle, rule CRUD with documented statuses, result storage    | FR-11 to FR-17, FR-27 to FR-34, FR-55 to FR-57 |
| `concurrency.test.ts` | Several simultaneous clients, interleaved correlated requests, the connection cap, hostile input, rate limiting, shutdown | FR-19 to FR-25, NFR-5, NFR-7                   |
| `scenarios.test.ts`   | `RUN_TEST` end to end: passing, failing, fragmented, coalesced, delayed, timed out, disconnected, malformed               | FR-43 to FR-54                                 |

### 2.5 Level 4 — CLI tests

`tests/cli/` — the two parts of the CLI that are pure functions of their input.

| File              | Covers                                                                                                                                                                                            | Requirements                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `options.test.ts` | Global option defaults, environment fallback, alias expansion, longest-command-path matching, `--` passthrough, rejection of unknown flags with a nearest-match suggestion, malformed flag values | FR-59, FR-62, FR-63          |
| `render.test.ts`  | Response rendering, byte counts in UTF-8, colour on and off, session and rule listings, result verdicts, expected-versus-actual output, the segment view                                          | FR-61, FR-64, NFR-27, NFR-29 |

Command dispatch itself is covered at the server-integration level rather than mocked here,
because a mocked dispatcher would prove only that the mock was called.

Two CLI behaviours warrant explicit mention as intent:

- `-h` alone means help, but `-h 127.0.0.1` sets the host. Both spellings are covered
  (FR-62).
- An unknown flag is rejected rather than absorbed as a bare switch. A typo such as
  `--match-op PING` must not silently install a rule matching every operation (FR-63).

### 2.6 Level 5 — example-scenario checks

`examples/run-all.ts`, run by `npm run examples`. Each of the eleven examples has a README
making claims about SLTP behaviour and a `bundle.json` expressing those claims as rules and
scenarios. The runner starts its own server on an OS-assigned port, replays each bundle
over a real TCP control connection, and checks the documented outcome.

The design point worth stating: **the expected outcome is recorded per scenario, not per
example.** Several examples are documented to fail or to time out, and a runner treating
"passed" as the only acceptable result would report those as broken when they are working
exactly as documented (FR-77).

| #   | Example                     | What the runner checks beyond pass/fail                                                                     |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 01  | Basic PING                  | The smallest complete exchange                                                                              |
| 02  | Session and rules           | Priority ordering and fallback both fire as documented                                                      |
| 03  | Passing test                | The mock's `Content-Length` is 32 for a 20-character body, and the body really does contain multibyte UTF-8 |
| 04  | Failing test                | Registered as `passes: false`; exactly two assertions fail; the mock answered 500                           |
| 05  | Fragmented message          | The request went out in 7 writes; the byte-at-a-time variant in more than 100                               |
| 06  | Coalesced messages          | Both requests left in **one** write and **two** responses were framed from it                               |
| 07  | Delayed response            | The exchange really took at least 350 ms                                                                    |
| 08  | Timeout                     | The client gave up in under 2 s rather than waiting for the 2500 ms mock                                    |
| 09  | Malformed `Content-Length`  | Each of the three faults produced `Connection: close`                                                       |
| 10  | Disconnect during a message | Truncation detected in both directions                                                                      |
| 11  | Two concurrent clients      | Two distinct sessions, and the fast client finished before the slow one                                     |

Example 11 is driven by a custom function rather than a bundle, because a scenario
describes one exchange on one connection and cannot express two clients overlapping in
time.

---

## 3. Message-framing edge cases

These are the obligations that make the project's central claim testable. Each is covered
at the protocol-unit level, where the byte delivery shape is under the test's control;
those marked with a second location are additionally exercised over a real socket.

### 3.1 Reassembly — one message, several chunks

| Case                                                      | Intent                                                                                                                             | Requirements |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Header split across chunks                                | A header field cut mid-name or mid-value must be reassembled, not treated as two malformed lines                                   | FR-3         |
| Start line split mid-token                                | The version token itself may be cut; the decoder must not decide the version from a partial token                                  | FR-3         |
| `CRLF CRLF` delimiter split down the middle               | The worst case for a naive delimiter search: the boundary straddles two chunks and must still be found                             | FR-3, NFR-10 |
| Body split across chunks                                  | The body must be accumulated to its full declared byte length before the message is emitted                                        | FR-3         |
| Multibyte UTF-8 character split across chunks             | Decoding each chunk to text independently would corrupt the character. The decoder must frame by bytes and decode once, at the end | FR-5         |
| Body delivered byte by byte through a multibyte character | The pathological form of the above, and of any parser that assumes a read is a message                                             | FR-3, FR-5   |
| Whole message delivered one byte at a time                | No amount of fragmentation may change the framed result                                                                            | FR-3         |

Also covered at the server-integration level (`scenarios.test.ts`) with genuine writes: a
request written as several TCP segments, a response the _mock endpoint_ wrote in fragments,
and a body containing multibyte UTF-8 split across segments.

### 3.2 Splitting — several messages, one chunk

| Case                                             | Intent                                                                               | Requirements |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------ |
| Two complete messages in one chunk               | The decoder must return both from a single call, splitting on `Content-Length` alone | FR-3, FR-48  |
| Three coalesced messages, two carrying bodies    | The split must survive bodies of differing lengths                                   | FR-3         |
| One complete message followed by part of another | The complete one is emitted; the partial remainder is retained for the next chunk    | FR-3         |
| Exact wire bytes reported per coalesced message  | Each framed message must report its own bytes, not the chunk's                       | FR-50        |
| A body containing a `CRLF CRLF` sequence         | Framing is by declared length, so a delimiter inside a body must not end the message | FR-2         |

Also covered over a real socket: two coalesced requests in one write producing two
responses, in both `concurrency.test.ts` and `scenarios.test.ts`.

### 3.3 Malformed framing

Every case must produce a machine-readable reason from the fixed taxonomy, and must be
classified fatal or non-fatal. Fatal means the stream cannot be resynchronised and the
connection must close (FR-6, NFR-4).

| Case                                                                                                       | Expected treatment                                                                                                                        | Requirements |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Invalid start line — no space separator, empty, trailing content, lowercase operation, unsupported version | Rejected with the corresponding reason; fatal                                                                                             | FR-6, FR-7   |
| Invalid response start line — two-digit code, missing phrase, code outside 100–599                         | Rejected; fatal                                                                                                                           | FR-7         |
| Invalid header — no colon, leading colon, invalid name, non-ASCII value, obsolete line folding             | Rejected with the corresponding reason; fatal                                                                                             | FR-7         |
| Bare `LF` line endings                                                                                     | Rejected; SLTP is CRLF-delimited without exception                                                                                        | FR-7         |
| Invalid `Content-Length` — non-numeric, hexadecimal                                                        | Rejected as `invalid-content-length`; fatal                                                                                               | FR-7         |
| Negative `Content-Length`                                                                                  | Rejected **distinctly** from a merely malformed one, as `negative-content-length`                                                         | FR-7         |
| Duplicate `Content-Length`                                                                                 | Rejected rather than resolved by picking one; two lengths make the frame ambiguous                                                        | FR-7         |
| Duplicate `Request-ID` or `Session-ID`                                                                     | Rejected; correlation must not be ambiguous                                                                                               | FR-7, FR-15  |
| Message exceeding the size limit                                                                           | `413 MESSAGE TOO LARGE`, reported distinctly from a malformed message; always fatal, because the remaining bytes cannot safely be skipped | FR-8         |
| Header block, start line, or header count over limit                                                       | Each reported with its own reason                                                                                                         | FR-8         |
| A message exactly at the size limit                                                                        | Must be **accepted** — the boundary is inclusive                                                                                          | FR-8         |
| Decoder poisoning after a fatal fault                                                                      | Once a fatal fault is seen, no further messages may be emitted from that stream                                                           | FR-10        |

### 3.4 Stream termination

| Case                                   | Intent                                                        | Requirements |
| -------------------------------------- | ------------------------------------------------------------- | ------------ |
| Disconnect mid-body                    | Retained bytes reported as a truncated message, not discarded | FR-9, NFR-7  |
| Disconnect mid-header                  | The same, before the delimiter is reached                     | FR-9         |
| Disconnect on a clean message boundary | Reports **nothing** — a tidy close is not an error            | FR-9         |

### 3.5 Semantic validation

Framing succeeded; the message is nonetheless unacceptable. Validation runs in a fixed
order so that a request with several faults always yields the same status (FR-13).

| Case                                                                     | Expected status                                                                  | Requirements |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------ |
| Missing `Request-ID`                                                     | `400 BAD REQUEST`, reason `missing-request-id`                                   | FR-13, FR-15 |
| Malformed `Request-ID`                                                   | `400 BAD REQUEST`, reason `invalid-request-id`                                   | FR-13        |
| Missing `Session-ID` on a session-scoped operation                       | `400 BAD REQUEST`, reason `missing-session-id`                                   | FR-13        |
| Malformed `Session-ID`                                                   | `400 BAD REQUEST`, reason `invalid-session-id`                                   | FR-13        |
| Unregistered operation                                                   | `501 OPERATION NOT SUPPORTED`                                                    | FR-16        |
| Body on an operation that forbids one, or absent on one that requires it | `400 BAD REQUEST`                                                                | FR-12        |
| Body that is not valid JSON                                              | `400 BAD REQUEST`                                                                | FR-16        |
| Top-level array or `null` body                                           | Rejected — a body must be a JSON object                                          | FR-16        |
| Zero-length body with an explicit `Content-Length: 0`                    | **Accepted.** An empty body is legal and must not be confused with an absent one | FR-2         |

Fault precedence is asserted directly, so the order cannot drift: missing `Request-ID` is
reported before an unknown operation; an unknown operation before a missing `Session-ID`; a
missing `Session-ID` before an invalid JSON body.

Endpoint-specific relaxations are covered too, because the mock endpoint deliberately
differs from the control server: it does not require a `Session-ID` — its port already
identifies the session — and it accepts operation tokens the registry does not define
(FR-29).

---

## 4. Server behaviour

Real sockets throughout, in `tests/server/`.

### 4.1 Connectivity and correlation

| Case                                                                | Intent                                                   | Requirements |
| ------------------------------------------------------------------- | -------------------------------------------------------- | ------------ |
| `PING` answers `200 OK` and echoes the supplied value               | The smallest end-to-end proof that the round trip works  | FR-11        |
| The response carries the request's `Request-ID`                     | Correlation is by identifier, not arrival order          | FR-15        |
| `SERVER_INFO` reports the operation and status registries           | A client can discover capability without trial and error | FR-17        |
| Concurrent requests on one connection answered out of arrival order | A slow operation must not block a fast one behind it     | FR-20        |

### 4.2 Session lifecycle

| Case                                                                   | Intent                                                                                                     | Requirements |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------ |
| `CREATE_SESSION` starts a dedicated mock endpoint on an ephemeral port | The endpoint must be listening before the session is announced                                             | FR-27        |
| Each session gets a distinct port                                      | Sessions are isolated at the transport layer, not merely by identifier                                     | FR-27, FR-33 |
| Unknown session                                                        | `404 SESSION NOT FOUND`                                                                                    | FR-57        |
| `LIST_SESSIONS` reports created sessions with their endpoint addresses | A caller can connect to the mock directly                                                                  | FR-33        |
| `CLOSE_SESSION` then further operations                                | `405 OPERATION NOT ALLOWED` — the session exists but is no longer usable, which is not the same as missing | FR-31        |
| Results readable after close                                           | Closing stops the endpoint; it does not erase history                                                      | FR-31        |
| Session ceiling, and a slot freed on close                             | Bounded storage that reclaims correctly                                                                    | FR-32        |

### 4.3 Rule CRUD

| Case                                                   | Intent                                                                      | Requirements |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | ------------ |
| Add, list, update, delete with the documented statuses | `212`, `213`, `214` are distinct codes and must be emitted as such          | FR-34, FR-14 |
| `LIST_RULES` returns matcher evaluation order          | The order is reported, not left for the client to infer                     | FR-36        |
| Duplicate rule name                                    | `409 RULE CONFLICT`                                                         | FR-38        |
| Identical match at the same priority                   | `409 RULE CONFLICT` — ambiguity is refused rather than resolved arbitrarily | FR-38, NFR-3 |
| Identical match at a _different_ priority              | **Accepted** — ordering stays deterministic                                 | FR-36, FR-38 |
| Identical match where the new rule is disabled         | **Accepted** — a disabled rule cannot create ambiguity                      | FR-39        |
| Update that would duplicate a name or create ambiguity | Refused, with the same codes as on add                                      | FR-38        |
| Delete an unknown rule                                 | `406 RULE NOT FOUND`                                                        | FR-57        |
| Structurally invalid rule                              | `422 INVALID SCENARIO`                                                      | FR-16        |
| Rules on a closed session                              | Read-only; mutation refused                                                 | FR-31        |

### 4.4 Test execution

| Case                                                            | Intent                                                                                                                        | Requirements  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Passing test                                                    | `210 TEST PASSED` when every assertion holds                                                                                  | FR-52         |
| Failing test                                                    | `211 TEST FAILED` with expected-versus-actual per assertion. This is a **2xx**: the SLTP exchange succeeded; the test did not | FR-52         |
| JSON-subset body match                                          | Extra keys in the actual body are permitted                                                                                   | FR-35, FR-51  |
| No rule fires                                                   | `410 NO MATCHING RULE`, with the number of rules evaluated                                                                    | FR-30         |
| The matched rule is reported                                    | The result names the rule that produced the response                                                                          | FR-42         |
| Timeout expected                                                | `210 TEST PASSED` — the timeout was the assertion                                                                             | FR-51, FR-52  |
| Timeout not expected                                            | `408 TEST TIMEOUT`                                                                                                            | FR-52         |
| Delay within the timeout                                        | Recorded, not failed                                                                                                          | FR-40         |
| Peer closes part-way through its own response                   | Detected as a disconnect, not parsed as a complete message                                                                    | FR-40, NFR-7  |
| Scenario abandons its own request mid-message                   | The inverse direction: the runner reports it rather than hanging                                                              | FR-43, FR-53  |
| Malformed, negative, or absent framing fields inside a scenario | `400 BAD REQUEST` from the mock endpoint                                                                                      | FR-7          |
| Scenario targeting a non-development host                       | Refused. Test execution must not be usable as a network probe                                                                 | FR-54, NFR-14 |
| Scenario the validator rejects                                  | `422 INVALID SCENARIO`, with **every** problem reported at once                                                               | FR-44         |

### 4.5 Robustness — the server stays available

The obligation under test is FR-21: a hostile client affects only its own connection.
Every case below asserts both the correct answer _and_ that the server keeps serving.

| Case                                          | Expected treatment                                                                            | Requirements |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------ |
| Malformed start line                          | `400 BAD REQUEST`, and **only that connection** closes                                        | FR-21, NFR-4 |
| Duplicate `Content-Length`                    | `400 BAD REQUEST` rather than guessing which length to believe                                | FR-7, FR-21  |
| Oversized `Content-Length`                    | `413 MESSAGE TOO LARGE`                                                                       | FR-8         |
| Unregistered operation                        | `501 OPERATION NOT SUPPORTED`, connection **stays open** — the fault is semantic, not framing | FR-16, NFR-4 |
| Body that is not JSON                         | `400 BAD REQUEST`, connection stays open                                                      | FR-16        |
| Two coalesced requests in one write           | Split into two responses                                                                      | FR-3, FR-48  |
| Client disconnects part-way through a message | Survived; in-flight requests on that connection settle with a reason                          | FR-21, NFR-7 |
| Rate limit exceeded                           | `429 TOO MANY REQUESTS` with a retry hint, applied **per connection**                         | FR-23        |
| Connections beyond the maximum                | `503 SERVER UNAVAILABLE`                                                                      | FR-24        |

### 4.6 Concurrency and shutdown

| Case                                                   | Intent                                                                 | Requirements |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | ------------ |
| Several connections at once with isolated sessions     | Independent framing state and independent handler state per connection | FR-19, FR-4  |
| Interleaved requests from many clients stay correlated | Correlation holds under interleaving, not merely in isolation          | FR-15, FR-19 |
| Shutdown closes every session mock endpoint            | No listener may outlive the server                                     | FR-25, NFR-6 |
| In-flight requests settle when the connection closes   | Nothing is left awaiting a response that will never arrive             | NFR-7        |

---

## 5. Client behaviour

| Case                                                                            | Level              | Intent                                                                                       | Requirements |
| ------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- | ------------ |
| Defaults, environment fallback, flag precedence                                 | CLI unit           | `--port` beats `SOCKETLENS_PORT`; an unusable environment value is ignored rather than fatal | FR-62        |
| Unknown flag rejected with a suggestion                                         | CLI unit           | A typo must not become a silently different command                                          | FR-63        |
| Longest command path wins                                                       | CLI unit           | `session create` must beat `session`                                                         | FR-59        |
| `--` stops flag parsing                                                         | CLI unit           | A raw payload may begin with a dash                                                          | FR-60        |
| Non-2xx rendered as a result, not an error                                      | CLI unit           | Only transport failures, timeouts and framing faults are client errors                       | FR-64        |
| Raw byte view in both directions                                                | CLI unit           | The exact bytes, with CRLF made visible                                                      | FR-61        |
| UTF-8 byte counts, not character counts                                         | CLI unit           | The renderer must not repeat the mistake the protocol avoids                                 | FR-61, FR-5  |
| Colour disabled produces no escape sequences                                    | CLI unit           | Output must be usable when piped                                                             | NFR-29       |
| Several responses framed from fewer TCP segments, called out in the result view | CLI unit           | The central claim must be visible in the CLI, not only in the interface                      | FR-50, FR-61 |
| Multiple simultaneous clients                                                   | Server integration | See §4.6                                                                                     | FR-19        |
| Client disconnect                                                               | Server integration | See §4.5                                                                                     | FR-21, NFR-7 |

The bridge and the graphical client are exercised through the shared core and protocol
packages, which they consume without re-implementing (NFR-2, FR-73).

### 5.1 · Interface tests

Two interface test files exist, and both deliberately avoid asserting on markup:

| Case                                                               | Level         | Intent                                                                         |
| ------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------ |
| `Name: value` lines parsed into a header record                    | GUI unit      | The editors take protocol values from free text; that conversion must be right |
| A half-typed header line does not discard the lines already parsed | GUI unit      | The field is parsed on every keystroke                                         |
| Colons inside a header value are preserved                         | GUI unit      | A timestamp value contains colons; only the first delimits the name            |
| Fragment sizes: order preserved, zero and negative dropped         | GUI unit      | Fragment order is what reaches the wire                                        |
| An absent field yields `undefined`, an explicit `0` yields `0`     | GUI unit      | The protocol distinguishes absent from zero; a delay of `0` is an instruction  |
| Verdict, numeric status code, and status phrase all readable       | GUI component | These are the values a demonstration has to point at                           |
| A failed assertion shows both expected and actual                  | GUI component | Expected-versus-actual is the feature, not the verdict alone                   |
| A timeout is reported as its own outcome, not as a plain failure   | GUI component | 408 and a failed assertion are different situations                            |
| Two framed responses from one received segment                     | GUI component | The coalescing claim, made visible in the interface                            |
| An earlier failed run stays reachable after a later pass           | GUI component | Result history must not be overwritten by the newest run                       |

The component tests query by visible text and scope by field label rather than by class name
or element structure, so restyling the panel cannot break them. What is asserted is the
information a viewer must be able to read, never its presentation — the brittleness that
makes interface tests unwelcome comes from asserting the latter.

The remaining components and the bridge connection hook are not covered; see
[test-results.md](test-results.md) for the recorded gaps.

---

## 6. Coverage and continuous integration

```bash
npm run test:coverage
```

The v8 provider reports text, HTML and lcov into `./coverage`. Coverage is collected from
`packages/*/src/**/*.ts` and `apps/*/src/**/*.{ts,tsx}`, excluding declaration files,
barrel `index.ts` files, the interface entry point, and the tests themselves. Barrels are
excluded deliberately: a re-export file reports as covered the moment anything imports it,
which inflates the figure without indicating that anything was exercised.

Coverage is a diagnostic for finding untested branches, not a target to be satisfied. A
high figure over mocked transports would be worth less than the real-socket suites above.

CI (`.github/workflows/ci.yml`) runs on push and pull request to `main`. The `verify` job
runs the full gate on Node 20.x, 22.x and 24.x with `fail-fast: false`, so a failure on one
version does not hide the result on another (NFR-17). A separate `coverage` job uploads the
report as an artefact.

| CI step                    | Command                |
| -------------------------- | ---------------------- |
| Check formatting           | `npm run format:check` |
| Lint                       | `npm run lint`         |
| Type check                 | `npm run typecheck`    |
| Unit and integration tests | `npm run test`         |
| Build all workspaces       | `npm run build`        |

The single local equivalent is `npm run verify`, which chains the same five steps in the
same order (FR-78).

`npm run examples` is not part of the CI gate; it is the executable form of the
documentation and is run when an example or the behaviour it documents changes.

---

## 7. Related documents

| Document                                                        | Relationship                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| [`docs/requirements.md`](./requirements.md)                     | The FR and NFR identifiers referenced throughout            |
| [`docs/protocol-specification.md`](./protocol-specification.md) | The normative framing rules the protocol tests enforce      |
| [`docs/status-codes.md`](./status-codes.md)                     | The status registry the integration tests assert against    |
| [`docs/protocol-examples.md`](./protocol-examples.md)           | Byte-level worked examples of the framing cases in §3       |
| [`docs/architecture.md`](./architecture.md)                     | Why the components under test are shaped as they are        |
| [`docs/developer-guide.md`](./developer-guide.md)               | How to add a test when adding an operation or a status code |
