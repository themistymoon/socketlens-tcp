# Evaluation

What SLTP/1.0 actually does well, what it does not, and what evidence supports each claim.

**The subject of this evaluation is the protocol.** SLTP — its grammar, its framing strategy,
its correlation mechanism, its status and error semantics — is what this project designed. The
server, CLI, bridge, interface, and test suite are a **harness**: they exist to make the
protocol's behaviour observable and its correctness checkable. Where a tool capability is
listed below, it is listed because of the protocol behaviour it demonstrates, not as a product
feature. Interface polish and user experience are out of scope and are not claimed as
achievements.

This document exists because "our protocol is good" is not a finding. Every claim below is
tagged with the kind of thing it is, and a claim of the strongest kind — a measured
performance result — appears exactly where measurement supports it and nowhere else.

## 1. How claims are classified

| Tag                 | Meaning                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| **Feature**         | Something the harness does, verifiable by running it, which exposes protocol behaviour |
| **Design property** | A structural consequence of how it is built; true by construction                      |
| **Test result**     | Asserted by an automated test that fails if the behaviour regresses                    |
| **Measured**        | A number produced by `npm run benchmark` on stated hardware                            |
| **Trade-off**       | A deliberate cost accepted in exchange for something else                              |
| **Limitation**      | Something it does not do                                                               |

A feature is not a performance advantage. A design property is not evidence of speed. The
distinction is the point of the table.

## 2. The distinguishing strength, stated once

**SLTP's distinguishing strength is not speed, and not expressiveness. It is that the
framing layer is fully observable and that its failure modes are reproducible on demand.**

Every stream protocol has to solve message framing. Almost none of them let you watch it
being solved, and almost none let you ask for the awkward cases deliberately. SLTP is
specified so that this is possible — a machine-readable `Reason` taxonomy, a fatal/non-fatal
classification, an explicit byte-counted `Content-Length`, and an order-independent
`Request-ID` — and the harness makes it visible: a developer can say "send this one message as
seven writes with the cuts inside the CRLF delimiters, then tell me exactly what arrived" and
get back the bytes, the write count, the read count, and the number of messages framed.

Those last three numbers are the point, and they are three different numbers. The scenario
chooses the write boundaries; the operating system chooses the segment boundaries; the decoder
recovers the message boundaries. A protocol that conflates them is broken, and a tool that
cannot show them apart cannot prove otherwise.

That is the claim the rest of this document supports, and the reason the benchmark section
concludes that HTTP/1.1 is the faster of the two implementations measured, without that
undermining anything.

## 3. Claim and evidence

### 3.1 Framing and the byte stream

| Claim                                                                                             | Kind            | Evidence                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One application message can be written as many separate writes and is still framed as exactly one | Test result     | `tests/protocol/decoder.test.ts` — start line split mid-token, split between a CR and its LF, split one byte before the end of the header delimiter, and byte-at-a-time delivery                |
| Several application messages written at once are framed as several messages                       | Test result     | `tests/server/concurrency.test.ts` — _"splits two coalesced requests arriving in one TCP write into two responses"_, asserting three segments after splitting on the status line                |
| Framing never depends on chunk boundaries                                                         | Design property | `packages/protocol/src/decoder.ts` — one `Buffer` per connection, delimiter search resumes from `searchOffset`, UTF-8 decoded only once a complete body is present                              |
| `Content-Length` is counted in UTF-8 **bytes**, not characters                                    | Test result     | `tests/protocol/decoder.test.ts` — _"frames a body by UTF-8 byte length, not JavaScript string length"_; the encoder computes it from `Buffer.byteLength` and ignores any caller-supplied value |
| A multi-byte character split across reads is harmless                                             | Test result     | `tests/server/scenarios.test.ts` — a body containing multibyte UTF-8 split across writes                                                                                                        |
| Each connection owns exactly one decoder                                                          | Design property | Constructed per connection in `apps/server/src/server.ts`, `packages/core/src/mock-endpoint.ts`, and `packages/core/src/client.ts`; sharing one would interleave two byte streams               |
| Deliberate write patterns cross a real kernel TCP stack, not an in-process double                 | Design property | `packages/core/src/mock-endpoint.ts` binds a real `node:net` listener per session on an OS-assigned port; the runner reaches it over an actual TCP connection                                   |
| 11 runnable examples demonstrate these properties and are checked against their own documentation | Feature         | `npm run examples` exits non-zero when an example's README disagrees with observed behaviour                                                                                                    |

### 3.2 Failure modes as first-class behaviour

| Claim                                                                          | Kind        | Evidence                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An unusable `Content-Length` is fatal for the connection, with a stated reason | Test result | `concurrency.test.ts` — a duplicate `Content-Length` answers `400` "rather than guessing"; example 09 asserts `Connection: close` accompanies the fatal fault |
| An oversized message is refused rather than buffered                           | Test result | `concurrency.test.ts` — `413 MESSAGE TOO LARGE`; the remaining bytes cannot be skipped safely, so the stream cannot be resynchronised                         |
| A disconnect mid-message is reported, not silently swallowed                   | Test result | `concurrency.test.ts` — _"survives a client that disconnects part-way through a message"_; example 10 asserts this as its documented outcome                  |
| A timeout is a distinct outcome from a failure                                 | Test result | `TestOutcome` is `passed \| failed \| timeout \| error`; example 08 asserts a timeout as the expected result                                                  |
| An unregistered operation does not kill the connection                         | Test result | `concurrency.test.ts` — `501` and the connection stays open, because framing succeeded and only semantics were wrong                                          |
| In-flight requests are settled when a connection closes                        | Test result | `concurrency.test.ts` — _"settles in-flight requests when the connection closes"_; no caller waits forever                                                    |
| Three examples deliberately do not pass, and the runner enforces that          | Feature     | Examples 04, 08, 10; example 04 would fail the run if it started passing                                                                                      |

### 3.3 Correlation, isolation, determinism

| Claim                                                                 | Kind            | Evidence                                                                                                                                                                       |
| --------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Several requests may be in flight on one connection, correlated by ID | Test result     | `concurrency.test.ts` — _"keeps interleaved requests from many clients correlated correctly"_; `client.ts` resolves by `Request-ID` from a pending map, never by arrival order |
| Concurrent clients are isolated from each other                       | Test result     | `concurrency.test.ts` — _"serves several connections at once with isolated sessions"_; separate framing state, rate limiting, and rule sets per connection and per session     |
| Rule matching does not depend on iteration order                      | Test result     | `tests/core/matching.test.ts`; priority descending, then insertion order ascending                                                                                             |
| The same decoder and encoder are used everywhere                      | Design property | The CLI, bridge, control server, and mock endpoints all import `@socketlens/protocol`; nothing re-implements framing                                                           |
| The operation and status registries are the single source of truth    | Design property | `packages/protocol/src/operations.ts` and `status.ts`; an unregistered token cannot be accepted by one component and rejected by another                                       |

### 3.4 Observability

| Claim                                                                     | Kind    | Evidence                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The exact bytes of every message are readable in both directions          | Feature | `--raw` on any CLI command; `rawSent` and `rawReceived` on every stored result                                                                                 |
| Individual writes and reads are recorded with timestamps and byte counts  | Feature | `WireSegment[]` on every result, rendered by the CLI under "Wire writes and reads"                                                                             |
| Write count, read count, and framed-message count are reported separately | Feature | `sentSegmentCount`, `receivedSegmentCount`, `responseCount` — the three numbers whose disagreement is the whole demonstration                                  |
| Traffic can be correlated with an external packet capture                 | Feature | `npm run wireshark:demo` prints the local TCP port, `Request-ID`, byte count, and write count per exchange; see [`wireshark-capture.md`](wireshark-capture.md) |

## 4. Measured performance — evidence for a design trade-off

> This section is **not** the centre of the evaluation. It exists to substantiate one design
> decision: SLTP spends work on strict validation, and that work costs throughput. The
> distinguishing strength claimed in §2 is observability, strictness, and reproducible failure
> behaviour — not speed. Nothing here should be read as a performance selling point, and the
> `node:http` figures in particular must never be used to claim that SLTP is faster than
> HTTP/1.1 in general.

Full methodology, caveats, and the recorded table are in
[`../benchmarks/README.md`](../benchmarks/README.md). Reproduce with `npm run benchmark`.

Measured on Windows (release 10.0.26200), win32 x64, Node v26.5.1, AMD Ryzen 7 7840HS × 16,
2000 measured round trips after 500 warm-up, **10 runs**, loopback, one persistent
connection, one request in flight. Figures are **medians across runs**.

| Payload | SLTP/1.0 (`node:net`) | HTTP/1.1 minimal (`node:net`) | HTTP/1.1 (`node:http`) |
| ------- | --------------------- | ----------------------------- | ---------------------- |
| empty   | 27,458 req/s          | **33,134 req/s**              | 12,387 req/s           |
| 128 B   | 23,501 req/s          | **30,221 req/s**              | 10,681 req/s           |
| 1 KiB   | 20,468 req/s          | **30,170 req/s**              | 11,162 req/s           |
| 16 KiB  | 6,565 req/s           | **11,980 req/s**              | 6,581 req/s            |

Median latency at 128 B: SLTP 0.039 ms, minimal HTTP/1.1 0.032 ms, `node:http` 0.088 ms.

Whether a difference is claimed at all is decided by a **paired sign test** over rounds, not
by the size of the gap — absolute throughput on this machine wanders by tens of percent while
the ordering within a round is far steadier.

| Comparison                 | empty        | 128 B        | 1 KiB        | 16 KiB                 |
| -------------------------- | ------------ | ------------ | ------------ | ---------------------- |
| minimal HTTP/1.1 over SLTP | 1.21×, 10/10 | 1.29×, 9/10  | 1.47×, 10/10 | 1.82×, 10/10           |
| SLTP over `node:http`      | 2.22×, 10/10 | 2.20×, 10/10 | 1.83×, 10/10 | 1.00×, 4/10 — not sig. |

Every significant cell has p ≤ 0.021; the 16 KiB `sltp` versus `node:http` cell has p = 0.754
and is reported as **no consistent winner**. Minimal HTTP/1.1 beat SLTP in **39 of 40 paired
rounds**.

Worst min-max spread in the sample: 53.9%. Three independent 10-run samples agreed on the
ratios (minimal HTTP over SLTP: 1.19–1.97× depending on payload and sample) even though
absolute throughput moved between them. Full methodology and the reproducibility table are in
[`../benchmarks/README.md`](../benchmarks/README.md).

### 4.1 What was measured, honestly

**SLTP is slower than HTTP/1.1.** Implemented in the same minimal style, a hand-written
HTTP/1.1 reader beat the SLTP implementation at every payload size, by a median 1.21× to
1.82×, winning 39 of 40 paired rounds. There is no reading of this benchmark under which SLTP
is the faster protocol.

**The gap is validation cost, not framing cost.** Both benchmark implementations use
comparable framing: a CRLF-delimited header block terminated by `\r\n\r\n`, and a body
length taken from an explicit `Content-Length`. Because the two readers do equivalent framing
work, the framing strategy does not account for the difference. What differs is what each
reader does with the bytes once it has them.

That is a statement about the two implementations measured here, not a claim that SLTP and
HTTP/1.1 are equivalent protocols. They are not: they differ in start-line grammar, routing,
status semantics, body transfer (HTTP/1.1 also has chunked coding, SLTP has none), caching,
and header vocabulary. What is comparable is the specific framing strategy these two
implementations use, which is why isolating it is meaningful.

The SLTP decoder checks every header name and value against a grammar, rejects duplicates of
single-valued headers, enforces four size limits, validates the operation token against the
registry, and builds a structured message. The minimal HTTP reader finds the delimiter, scans
for one header, and slices. **That strictness is deliberate**: a tool whose purpose is
diagnosing framing bugs must reject an ambiguous message rather than guess at it, and this is
the price.

**Against `node:http`, the purpose-built implementation is faster up to 1 KiB** — a median
2.22× at empty, 2.20× at 128 B, 1.83× at 1 KiB, each winning 10 of 10 rounds. **At 16 KiB
there is no consistent winner** (4 of 10 rounds, p = 0.754). Where the win exists it is a
real cost a developer pays in practice, but it is a property of Node's general-purpose HTTP
stack, which allocates stream objects per request and supports chunked coding and trailers.
It is not a property of HTTP.

**SLTP requests are smaller; SLTP responses are slightly larger.** An empty SLTP request is
41 bytes against HTTP's 136, because `SLTP/1.0 PING` is shorter than a method-path-version
line and SLTP has no `Host` header. The response is 90 bytes against 85, because SLTP always
carries a `Request-ID` so replies can be correlated out of order. That is a design cost, paid
knowingly.

**The measurement method was itself corrected during this work.** A 10-run sample exposed a
systematic order effect: the first implementation measured absorbed the process's JIT warm-up
and drifted 26.6% upward across its runs. Because the order was fixed, that penalty always
fell on the same implementation. It is now removed by warming every implementation before
measuring and by interleaving runs with rotated order. The headline aggregate was also
changed from best-of-3 to median, because best-of-N rises with N and cannot ground a stable
ratio. Both corrections are documented in
[`../benchmarks/README.md`](../benchmarks/README.md).

### 4.2 What is not claimed

- Not that SLTP is faster than HTTP. It is not.
- Not that SLTP is more efficient on the wire. Requests are smaller, responses are larger.
- Not that these numbers predict anything on a LAN or WAN. Loopback has no propagation delay,
  no packet loss, and no meaningful congestion control.
- Not that the byte counts are what a packet capture totals. They are application bytes from
  Node's socket counters, excluding Ethernet, IP, and TCP headers.
- Not that the measured peers are the real server. The benchmark's SLTP peer is a minimal
  echo server; the control server additionally routes operations, matches rules, stores
  results, and adds `Server` and `Timestamp` to every response.
- Not that this holds on other hardware or other Node versions.
- Not that the ratios are precise to three figures. Across three 10-run samples the
  like-for-like ratio moved between 1.19× and 1.97× depending on payload and sample.
- Not that a significant sign test measures effect size. It says the ordering is consistent,
  not that the median ratio is the true magnitude.

## 5. SLTP and HTTP/1.1 compared fairly

Not a contest. HTTP/1.1 is a mature, universally deployed protocol with an ecosystem SLTP
will never have; SLTP is a teaching and debugging vehicle with a deliberately small surface.

### 5.1 What HTTP/1.1 does better

| Area                | HTTP/1.1                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Ecosystem           | Every language, every proxy, every browser, decades of tooling. SLTP has one implementation     |
| Performance         | Faster than SLTP when framing is implemented comparably — measured, §4                          |
| Body transfer       | Chunked transfer coding sends a body of unknown length; SLTP requires `Content-Length` up front |
| Caching and proxies | A complete, specified caching model. SLTP has none                                              |
| Security            | TLS, authentication schemes, and an established threat model. SLTP v0.1 has none of these       |
| Content negotiation | `Accept`, `Content-Encoding`, compression. SLTP has none                                        |
| Routing             | Paths, query strings, methods with defined semantics. SLTP has a flat operation token           |
| Standardisation     | An IETF standard with independent interoperable implementations                                 |

### 5.2 What SLTP does differently, and why

| Area             | SLTP/1.0                                                                                          | Why                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Correlation      | Mandatory `Request-ID` echoed on every response                                                   | Several requests may be outstanding on one connection without relying on strict ordering, which HTTP/1.1 requires |
| Status semantics | `210 TEST PASSED`, `211 TEST FAILED`, `410 NO MATCHING RULE` and others have no HTTP counterpart  | A successful exchange reporting a failed assertion is a 2xx, because the _protocol_ succeeded                     |
| Failure taxonomy | A machine-readable `Reason` header from a closed registry                                         | A framing fault should be diagnosable by a program, not by string-matching an error message                       |
| Strictness       | Ambiguity is fatal: no lenient CR, no signed `Content-Length`, no duplicate single-valued headers | A debugging tool that guesses is worse than useless. HTTP implementations must be lenient for interoperability    |
| Scope            | 13 operations in a closed registry                                                                | A small closed surface can be documented exhaustively and tested completely                                       |

### 5.3 Why this project exists even though HTTP is faster and better supported

Because the goal was never to move bytes faster. It was to make the _framing problem_ visible
and reproducible.

Building on HTTP would have removed the subject matter. `node:http` frames messages for you:
you never see a delimiter, never compute a body length, and never encounter a message split
across reads, because the library has already solved it. A tool for studying and debugging
framing cannot delegate framing — there would be nothing left to observe. This is recorded as
a rejected alternative in [`architecture.md`](architecture.md).

The measured outcome supports rather than undermines this. SLTP is slower **because it
validates more**, and validating more is what makes it useful for finding framing bugs. A
protocol that accepted a negative `Content-Length` would be faster and worse.

### 5.4 Condensed comparison, for slides and the report

| Dimension       | SLTP/1.0                        | HTTP/1.1                         |
| --------------- | ------------------------------- | -------------------------------- |
| Framing         | `\r\n\r\n` + `Content-Length`   | Same, plus chunked coding        |
| Throughput here | 23,501 req/s @ 128 B            | 30,221 req/s @ 128 B (minimal)   |
| Empty request   | 41 bytes                        | 136 bytes                        |
| Correlation     | `Request-ID`, order-independent | Response order on the connection |
| Strictness      | Ambiguity is fatal              | Lenient for interoperability     |
| Scope           | 13 operations                   | General purpose                  |
| Ecosystem       | One implementation              | Universal                        |
| Purpose         | Observe and reproduce framing   | Move data between systems        |

## 6. Trade-offs accepted

| Trade-off                                             | Given up                             | Gained                                                                                    |
| ----------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Full header and token validation on every message     | Throughput — measured at 1.21×–1.82× | Ambiguous messages are rejected rather than guessed at                                    |
| Mandatory `Request-ID`                                | ~23 bytes per message                | Out-of-order responses on one connection                                                  |
| A fatal framing fault kills the connection            | Recovery after a bad message         | No possibility of misinterpreting subsequent bytes                                        |
| `Content-Length` required, no chunked coding          | Streaming a body of unknown length   | The body's end is known before it starts arriving                                         |
| Text-based, printable US-ASCII headers                | Compactness                          | A capture is readable without a dissector                                                 |
| Real TCP mock endpoints instead of in-process doubles | Test speed; real ports must be bound | Writes cross a real kernel TCP stack, so delivery and segmentation are the OS's behaviour |
| 13 operations in a closed registry                    | Extensibility without a spec change  | The registry can be documented and tested exhaustively                                    |

## 7. Limitations of v0.1.2

| Limitation                                                         | Detail                                                                                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-memory only                                                     | Stopping the server discards every session, rule, and result                                                                                                    |
| No authentication or authorisation                                 | Any process that can open the control port has full control                                                                                                     |
| Loopback only                                                      | By default and by design; the bridge refuses a non-loopback `--host` outright                                                                                   |
| No TLS, no compression, no binary framing mode                     | SLTP/1.0 is plaintext text-based framing                                                                                                                        |
| One protocol implemented                                           | Framing, rules, and assertions are SLTP-specific; `raw --text` puts arbitrary bytes on the wire but the reply is still framed as SLTP                           |
| No concurrency benchmark                                           | The suite measures one connection, sequential. Behaviour under many connections is untested for performance                                                     |
| Benchmark variance is high                                         | Up to 53.9% min-max spread across runs; the conclusion rests on a paired sign test over rounds rather than on gap size, and needs `--runs 10` on an idle system |
| Slower than a comparable HTTP/1.1 implementation                   | Measured, §4: median 1.21×–1.82×. Accepted in exchange for strictness                                                                                           |
| `docs/status-codes.md` is maintained by hand                       | Nothing mechanically prevents it drifting from the registry; generating it is a roadmap item                                                                    |
| `sentSegmentCount` / `receivedSegmentCount` are named misleadingly | They count application writes and reads, not TCP segments. The names are kept for wire compatibility; the field documentation says so explicitly                |

## 8. What a packet capture adds, and what it does not

Automated tests prove the decoder behaves correctly given a sequence of chunks. They cannot
prove anything about what the operating system actually put on the wire, because the socket
API does not expose that. A capture can.

**What a capture establishes**

- That the traffic is really TCP on the stated port, with a real three-way handshake — not an
  in-process shortcut.
- That the bytes on the wire are exactly the SLTP text the tool reports, readable in
  _Follow TCP Stream_ without a dissector.
- That application write boundaries and TCP segment boundaries are **different things**: five
  writes may appear as fewer segments, and one write may be split across several.
- That a `Content-Length` of 29 for a 17-character Thai body matches 29 bytes of payload.
- That a fatal framing fault is followed by a real FIN or RST.
- That concurrent clients occupy genuinely separate TCP streams.

**What a capture does not establish**

- Not that the decoder is correct. A capture shows bytes, not whether an implementation would
  mishandle a different split. That is what the 55 decoder tests are for.
- Not how the application observed those bytes. Wireshark shows segments; it cannot show how
  many `data` events Node delivered, and the two need not correspond.
- Not that behaviour generalises. Loopback segmentation differs from a real network's — there
  is no path MTU constraint worth speaking of and no loss.
- Not performance. Capture overhead perturbs timing.

Procedure: [`wireshark-capture.md`](wireshark-capture.md).

## 9. Summary

| Question                            | Answer                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Is SLTP faster than HTTP/1.1?       | No. Measured 1.21×–1.82× slower than a comparable implementation, losing 39 of 40 paired rounds       |
| Is it more compact?                 | Requests yes (41 vs 136 bytes empty), responses no (90 vs 85)                                         |
| Then what is it good for?           | Making the framing layer observable and its failure modes reproducible on demand                      |
| What is the strongest evidence?     | 598 automated tests, 11 self-checking examples, and a packet capture confirming the bytes on the wire |
| What is the weakest part of v0.1.2? | No persistence and no authentication, and a benchmark limited to one sequential connection            |
| Was the performance claim measured? | Yes, and it went against the project's own protocol. It is reported unchanged                         |
