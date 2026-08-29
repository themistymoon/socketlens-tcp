# SocketLens TCP — Requirements

Version 0.1.2. This document defines what SocketLens TCP does, what it deliberately does
not do, and the quality constraints it holds itself to. Every requirement carries a stable
identifier so that [`docs/architecture.md`](./architecture.md),
[`docs/protocol-specification.md`](./protocol-specification.md) and
[`docs/test-plan.md`](./test-plan.md) can reference it without ambiguity.

Identifiers are never reused. If a requirement is withdrawn, its identifier is retired
rather than reassigned.

---

## 1. Purpose and context

SocketLens TCP is a local tool for observing and testing an application-layer protocol as
it actually behaves on a TCP connection. It consists of a control server, three clients,
and a shared protocol implementation.

The protocol under study is **SLTP — SocketLens Testing Protocol, version 1.0**. SLTP is a
text-based, CRLF-delimited, `Content-Length`-framed request/response protocol carried
directly over **raw TCP** using `node:net`. It is not HTTP, it is not layered on HTTP, and
it does not reuse HTTP semantics; the numeric status codes it defines are its own and must
never be read as HTTP codes.

The problem the tool exists to make visible: **TCP is a reliable, ordered byte stream that
does not preserve application message boundaries.** One `write()` is not one `data` event,
and one `data` event is not one message. A single message may arrive in six chunks; three
messages may arrive in one. Correct protocol implementations must buffer incrementally per
connection. SocketLens TCP both demonstrates this and depends on getting it right.

### 1.1 Origin

The project was originally developed as **Project 1: Socket Programming** for **01418351
Computer Communications and Cloud Computing Principles** at **Kasetsart University**. The
assignment required a client-server application carried over a custom application-layer
protocol of the author's own design, which is why the requirements below treat the protocol
specification, the status registry, and the demonstrability of TCP framing behaviour as
first-class deliverables rather than implementation details. Development has continued
beyond the coursework, and every requirement in this document is held to regardless of its
origin.

### 1.2 Actors

| Actor           | Description                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Protocol author | Writes or reviews a message-framed protocol and needs to see the wire bytes.                                          |
| Test author     | Defines mock rules and scenarios that drive a peer through fragmentation, coalescing, delays, and abrupt disconnects. |
| Learner         | Uses the tool to understand stream framing without building a harness first.                                          |

### 1.3 Terminology

| Term                     | Meaning in this document                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Control server           | The SLTP server on the control port. Accepts operations such as `CREATE_SESSION` and `RUN_TEST`.                 |
| Session                  | A named container for mock rules and results, owning one dedicated mock endpoint.                                |
| Mock endpoint            | A per-session TCP listener on an OS-assigned ephemeral loopback port that answers SLTP requests from mock rules. |
| Scenario                 | A declarative description of one test exchange: what to send, how to segment it, and what to assert.             |
| Bridge                   | A loopback process that owns a real TCP socket on behalf of the browser client.                                  |
| MUST / MUST NOT / SHOULD | Requirement strength, in the ordinary RFC 2119 sense.                                                            |

---

## 2. Functional requirements

### 2.1 Protocol framing and decoding

| ID        | Requirement                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **FR-1**  | The system MUST implement SLTP/1.0 over raw TCP using `node:net`. No HTTP server, HTTP client, or HTTP framing may participate in an SLTP conversation.                                                                                                                                                                                                      |
| **FR-2**  | A message MUST consist of a start line, zero or more header fields, the four-byte delimiter `CRLF CRLF`, and an optional body whose length in bytes is given by `Content-Length`. Requests start with `SLTP/1.0 <OPERATION>`; responses start with `SLTP/1.0 <code> <PHRASE>`.                                                                               |
| **FR-3**  | Decoding MUST be incremental and stateful. The decoder MUST accept an arbitrary byte chunk and return zero, one, or many complete messages from it, retaining any partial remainder for the next chunk.                                                                                                                                                      |
| **FR-4**  | Each TCP connection MUST own exactly one decoder instance. Decoder state MUST NOT be shared between connections, and MUST be discarded and recreated when a connection is replaced.                                                                                                                                                                          |
| **FR-5**  | The decoder MUST frame bodies by UTF-8 byte length, not by JavaScript string length, and MUST decode a body to text only once all of its bytes are present, so that a multi-byte character split across chunks is reassembled correctly.                                                                                                                     |
| **FR-6**  | The decoder MUST reject malformed framing with a machine-readable reason drawn from a fixed taxonomy, and MUST classify each reason as fatal or non-fatal. A fatal reason means the byte stream can no longer be resynchronised and the connection MUST be closed.                                                                                           |
| **FR-7**  | The decoder MUST reject: bare `LF` or bare `CR` line endings, obsolete line folding, header lines without a colon, invalid header names, non-ASCII header values, duplicate `Content-Length`, `Content-Type`, `Request-ID` or `Session-ID`, non-numeric, negative or hexadecimal `Content-Length`, unsupported protocol versions, and malformed start lines. |
| **FR-8**  | The decoder MUST enforce configurable size limits and report an over-limit condition distinctly from a malformed one. Defaults: message 1 048 576 bytes, header block 16 384 bytes, start line 1 024 bytes, header count 64.                                                                                                                                 |
| **FR-9**  | On connection close, the decoder MUST report any retained partial bytes as a truncated message rather than discarding them silently.                                                                                                                                                                                                                         |
| **FR-10** | Once a fatal framing fault is observed, the decoder MUST refuse to emit further messages from that stream rather than attempt resynchronisation.                                                                                                                                                                                                             |

### 2.2 Operations, validation and status codes

| ID        | Requirement                                                                                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-11** | The system MUST define a closed registry of SLTP operations. v0.1 registers thirteen: `PING`, `SERVER_INFO`, `CREATE_SESSION`, `GET_SESSION`, `LIST_SESSIONS`, `ADD_RULE`, `UPDATE_RULE`, `DELETE_RULE`, `LIST_RULES`, `RUN_TEST`, `GET_RESULT`, `LIST_RESULTS`, `CLOSE_SESSION`. |
| **FR-12** | Each registry entry MUST declare whether the operation requires a session, whether it requires or permits a body, which endpoint it targets, and its success statuses.                                                                                                            |
| **FR-13** | Request validation MUST run in a fixed, documented order so that a request with several faults always produces the same status: `Request-ID` presence and form, operation registration, body presence, session scoping, then body parseability.                                   |
| **FR-14** | The system MUST define a closed registry of SLTP status codes with reason phrases, categories, retryability, and the context in which each is emitted.                                                                                                                            |
| **FR-15** | Every response MUST carry the `Request-ID` of the request that caused it, so that a client may have several requests in flight on one connection and correlate replies by identifier rather than by arrival order.                                                                |
| **FR-16** | An unregistered operation MUST yield `501 OPERATION NOT SUPPORTED`; a body that is not valid JSON where JSON is required MUST yield `400 BAD REQUEST`; a request whose structure is valid but whose content is not a usable scenario MUST yield `422 INVALID SCENARIO`.           |
| **FR-17** | `SERVER_INFO` MUST report the server's product string and its capability set, so a client can discover what the server supports without trial and error.                                                                                                                          |

### 2.3 Control server

| ID        | Requirement                                                                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-18** | The control server MUST accept SLTP over raw TCP on a configurable host and port, and MUST support binding port `0` to obtain an OS-assigned port.                                                                                                                |
| **FR-19** | The server MUST serve multiple simultaneous client connections, each with independent framing state, rate-limit state, and in-flight request accounting.                                                                                                          |
| **FR-20** | Requests MUST be dispatched concurrently within a connection, so that a slow operation does not block a fast one arriving after it on the same socket.                                                                                                            |
| **FR-21** | A malformed, oversized, hostile, or abruptly disconnected client MUST affect only its own connection. It MUST NOT terminate the server process, disturb other connections, or corrupt shared state.                                                               |
| **FR-22** | A handler that throws MUST be converted into `500 INTERNAL SERVER ERROR` on that connection rather than propagating as an uncaught exception.                                                                                                                     |
| **FR-23** | The server MUST apply a per-connection token-bucket rate limit, answer `429 TOO MANY REQUESTS` when it is exceeded, and include a retry hint. The limit MUST be disableable for local experimentation.                                                            |
| **FR-24** | The server MUST enforce a maximum number of concurrent connections and answer `503 SERVER UNAVAILABLE` beyond it. Default 64.                                                                                                                                     |
| **FR-25** | Shutdown MUST be graceful: stop accepting new connections, allow in-flight handlers to finish within a grace period, close every session mock endpoint, destroy remaining sockets, and only then resolve. A second interrupt signal MUST force an immediate exit. |
| **FR-26** | Closing a connection MUST half-close first and force-destroy only if the peer does not complete the handshake within a bounded time.                                                                                                                              |

### 2.4 Sessions and the mock endpoint

| ID        | Requirement                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-27** | `CREATE_SESSION` MUST create a session and start a dedicated TCP mock endpoint for it on an OS-assigned ephemeral loopback port before the session is announced to the caller.                    |
| **FR-28** | The mock endpoint MUST speak SLTP over raw TCP using the same decoder and encoder as the control server, and MUST give every inbound connection its own decoder.                                  |
| **FR-29** | Because the endpoint's port already identifies the session, the endpoint MUST NOT require a `Session-ID` header and MUST accept operation tokens that the SLTP registry does not define.          |
| **FR-30** | Requests reaching the endpoint MUST be answered from the session's rules; when no enabled rule matches, the endpoint MUST answer `410 NO MATCHING RULE` and report how many rules were evaluated. |
| **FR-31** | `CLOSE_SESSION` MUST stop the endpoint and destroy its open connections while retaining the session record, so previously recorded results remain readable.                                       |
| **FR-32** | The session store MUST enforce bounds: 32 sessions, 128 rules per session, 200 results per session, with results evicted oldest-first at the cap.                                                 |
| **FR-33** | `GET_SESSION` and `LIST_SESSIONS` MUST report each session's state and its mock endpoint address, so a caller can connect to it directly.                                                         |

### 2.5 Mock rules

| ID        | Requirement                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-34** | The system MUST support adding, updating, deleting and listing mock rules within a session.                                                                                                                                                          |
| **FR-35** | A rule MUST be able to match on operation, headers, and body, with body match modes `exact`, `contains`, `json-subset` and `regex`.                                                                                                                  |
| **FR-36** | Rule evaluation order MUST be deterministic: **priority descending, then insertion sequence ascending**. The first enabled matching rule wins. The ordering rule MUST be reported to clients rather than left implicit.                              |
| **FR-37** | Rule matching MUST produce a trace giving, for each rule that did not match, the reason it was rejected.                                                                                                                                             |
| **FR-38** | The store MUST reject conflicting rules with `409 RULE CONFLICT` in three cases: a duplicate rule identifier, a duplicate rule name within the session, and an identical match specification at the same priority among enabled rules.               |
| **FR-39** | A rule MUST be able to be disabled without being deleted.                                                                                                                                                                                            |
| **FR-40** | A rule's response MUST be able to specify a delay before the first byte, an explicit segmentation of the response into separate application writes with an optional inter-fragment delay, and a deliberate disconnect after a given number of bytes. |
| **FR-41** | Concurrent responses on one endpoint connection MUST be serialised, so that a delayed reply cannot overtake an earlier one.                                                                                                                          |
| **FR-42** | Rule hits MUST be counted, and the identifier of the rule that produced a response MUST be reported back on the response.                                                                                                                            |

### 2.6 Scenarios and test execution

| ID         | Requirement                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-43**  | A scenario MUST be declarative: a request to send, a transmission mode, optional segmentation, an optional secondary request, a timeout, and expectations.                                                                                                                                                                                                                                  |
| **FR-44**  | Scenario validation MUST report every problem at once rather than stopping at the first, and MUST reject mutually contradictory expectations — a timeout together with an expected status, a timeout together with an expected disconnect, a disconnect together with an expected status, and an exact body together with a substring expectation.                                          |
| **FR-45**  | Validation MUST bound scenario inputs: timeout at most 120 000 ms, fragment count at most 256, response delay at most 60 000 ms.                                                                                                                                                                                                                                                            |
| **FR-46**  | `RUN_TEST` MUST execute the scenario against the session's mock endpoint over a **real TCP connection**. Fragmentation and coalescing MUST be produced by genuine socket writes, never simulated in memory.                                                                                                                                                                                 |
| **FR-47**  | Three transmission modes MUST be supported: `single` — one write; `fragmented` — the message split across several writes, by explicit sizes or by a requested part count; `coalesced` — two messages written in one call.                                                                                                                                                                   |
| **FR-48**  | In `coalesced` mode with a secondary request, the runner MUST expect two responses, because two responses arriving from one write is the observable proof that TCP does not preserve message boundaries.                                                                                                                                                                                    |
| **FR-49**  | Every outbound write and every inbound chunk MUST be recorded as a wire segment with its byte count, its bytes, and its offset in milliseconds from the start of the exchange.                                                                                                                                                                                                              |
| **FR-50**  | A result MUST record the raw bytes sent, the raw bytes received, the segment list, the number of segments in each direction, and the number of complete responses framed.                                                                                                                                                                                                                   |
| **FR-51**  | The runner MUST classify each execution as `passed`, `failed`, `timeout` or `error`, and MUST evaluate assertions against status code, reason phrase, named headers, exact body, body substring, JSON subset, expected timeout, and expected mid-message disconnect. Each assertion MUST report the field checked, the expected value, the actual value, and an explanation when it failed. |
| **FR-51a** | In `coalesced` mode with a secondary request, the exchange MUST NOT be treated as complete until two responses have been framed.                                                                                                                                                                                                                                                            |
| **FR-52**  | `RUN_TEST` MUST answer `210 TEST PASSED` on success, `408 TEST TIMEOUT` when the scenario timed out, and `211 TEST FAILED` otherwise. A failing assertion is a reportable result, not a transport error.                                                                                                                                                                                    |
| **FR-53**  | Every completion path — success, assertion failure, timeout, transport error, deliberate disconnect — MUST clear its timer and destroy its socket exactly once. No scenario may leave a socket or timer behind.                                                                                                                                                                             |
| **FR-54**  | The runner MUST refuse to open a connection to a non-loopback address unless that host has been explicitly allowed at server start.                                                                                                                                                                                                                                                         |

### 2.7 Results and portability of artefacts

| ID        | Requirement                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-55** | Results MUST be retrievable individually and listable per session, and MUST be exportable in a versioned JSON envelope.                           |
| **FR-56** | Scenarios MUST be importable and exportable as a versioned bundle, and a bare single scenario MUST also be accepted where a bundle is expected.   |
| **FR-57** | Requesting an unknown result MUST yield `407 RESULT NOT FOUND`; an unknown session `404 SESSION NOT FOUND`; an unknown rule `406 RULE NOT FOUND`. |

### 2.8 Command-line client

| ID        | Requirement                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-58** | A CLI MUST speak SLTP over raw TCP **directly**, with no bridge and no intermediate process.                                                                        |
| **FR-59** | The CLI MUST cover session, rule, result and scenario management, plus `ping`, `info`, `run`, `raw`, `repl` and `help`.                                             |
| **FR-60** | The CLI MUST be able to write arbitrary bytes to the server with no encoding and no correlation, so that malformed input can be demonstrated against a live server. |
| **FR-61** | The CLI MUST offer a raw view that prints the exact bytes of each message in both directions, and a machine-readable JSON output mode.                              |
| **FR-62** | Host and port MUST be settable by flag and by environment variable, with the flag taking precedence.                                                                |
| **FR-63** | An unrecognised flag MUST be rejected with a suggestion of the closest valid flag, rather than silently ignored.                                                    |
| **FR-64** | A non-2xx SLTP status MUST be rendered as a result with its code and phrase. Only transport failures, timeouts and framing faults are client errors.                |

### 2.9 Bridge and graphical client

| ID        | Requirement                                                                                                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-65** | Because a browser cannot open a raw TCP socket, a bridge process MUST hold the real TCP connection to the SLTP server on the browser's behalf.                                                                                                                                                                                               |
| **FR-66** | The bridge MUST expose a small local HTTP surface under `/bridge/*` carrying commands _about_ SLTP. SLTP framing MUST NOT be carried over that HTTP surface; the SLTP conversation remains raw TCP between bridge and server.                                                                                                                |
| **FR-67** | The bridge MUST push wire events to the browser over Server-Sent Events at `/bridge/events`. WebSocket MUST NOT be used.                                                                                                                                                                                                                     |
| **FR-68** | The event stream MUST replay recent events to a newly attached client and MUST send periodic keep-alives, so a tab opened mid-session is not blank and an idle stream is not dropped by an intermediary. Connection-status events MUST be excluded from the replay buffer, because a stale status would misrepresent the current connection. |
| **FR-69** | The bridge MUST publish a request at the moment its bytes are written, not when the awaiting call resolves, so the timeline never shows a response before the request that caused it.                                                                                                                                                        |
| **FR-70** | Deliberately malformed raw bytes MUST be published verbatim and MUST NOT be fed through the bridge's outbound decoder, so that a poisoned decoder cannot corrupt the display of subsequent well-formed messages.                                                                                                                             |
| **FR-71** | Concurrent connect requests from several browser tabs MUST result in one TCP connection, not several.                                                                                                                                                                                                                                        |
| **FR-72** | The bridge MUST bind only a loopback interface and MUST refuse a non-loopback bind outright. It MUST refuse cross-origin requests.                                                                                                                                                                                                           |
| **FR-73** | The graphical client MUST NOT parse protocol bytes. It MUST render message projections produced by the shared decoder in the bridge, and MUST import only the browser-safe protocol subset, which contains no `Buffer`, no `node:net`, and no Node.js globals.                                                                               |
| **FR-74** | The graphical client MUST show connection status, the session and rule editors, a scenario editor, a live message timeline, a message inspector, and result views.                                                                                                                                                                           |

### 2.10 Observability, examples and developer workflow

| ID        | Requirement                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-75** | All three roles — server, client, bridge — MUST log through one logger with selectable levels including a silent level for tests and a verbose level that prints raw message bytes. |
| **FR-76** | Connection open, connection close, connection error and framing faults MUST be logged with the connection identifier, so events on one connection can be separated from another's.  |
| **FR-77** | The repository MUST ship runnable examples that exercise the protocol end to end, including examples whose expected outcome is not a plain pass.                                    |
| **FR-78** | The repository MUST provide a single verification command that runs formatting checks, linting, type checking, tests and the build.                                                 |

---

## 3. Non-functional requirements

### 3.1 Correctness

| ID        | Requirement                                                                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NFR-1** | No component may assume that one socket read yields exactly one message. Every place bytes are consumed MUST go through the shared incremental decoder. A convenience single-message decode helper may exist for tests and documentation but MUST NOT be used on a live socket. |
| **NFR-2** | The protocol implementation MUST exist in exactly one place and be shared by the server, the mock endpoint, the CLI, the bridge and the tests. No client may re-implement framing.                                                                                              |
| **NFR-3** | Behaviour MUST be deterministic where the user can observe it: rule ordering, validation order, status selection, and reported evaluation order MUST not depend on object iteration order, timing, or hashing.                                                                  |
| **NFR-4** | Framing faults MUST be distinguished from semantic faults. A stream that can no longer be trusted MUST be closed rather than guessed at.                                                                                                                                        |

### 3.2 Robustness and isolation

| ID        | Requirement                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NFR-5** | A fault in one connection MUST NOT propagate to another connection or to the process. Socket errors, including connection resets, MUST be handled per connection.                                                                           |
| **NFR-6** | Every asynchronous resource — socket, listener, timer, event subscription — MUST have an owner responsible for releasing it, and MUST be released on every exit path. Timers that merely wait MUST NOT keep the process alive on their own. |
| **NFR-7** | An abrupt disconnect MUST settle every request awaiting a response on that connection, with a reason that distinguishes "the peer closed" from "the local side closed" and reports any truncated message.                                   |
| **NFR-8** | A failing event subscriber MUST be dropped rather than allowed to break publication to the others.                                                                                                                                          |

### 3.3 Resource bounds

| ID         | Requirement                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NFR-9**  | Every accumulating structure MUST be bounded: message size, header block size, header count, connections, sessions, rules, results, replayed events, and bridge command bodies.                                   |
| **NFR-10** | Buffer scanning MUST remain linear in the number of bytes received. A delimiter search MUST resume from where the previous search ended, adjusted so that a delimiter straddling a chunk boundary is still found. |
| **NFR-11** | Memory retained per idle connection MUST be proportional to the size of the partial message in flight, not to the connection's history.                                                                           |

### 3.4 Security posture

| ID         | Requirement                                                                                                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NFR-12** | The tool is a local developer instrument. The control server, the mock endpoints and the bridge are intended for loopback use, and the mock endpoints bind loopback unconditionally.                                                    |
| **NFR-13** | The bridge MUST refuse to bind a routable interface, because it relays onto an unauthenticated TCP socket. It MUST refuse requests from an unexpected origin so that a hostile page cannot drive the socket through the user's browser. |
| **NFR-14** | Test execution MUST NOT be usable as a network probe: non-loopback targets are refused unless explicitly allowed by the operator at server start.                                                                                       |
| **NFR-15** | The static file handler MUST refuse paths that resolve outside the asset directory.                                                                                                                                                     |
| **NFR-16** | The system MUST NOT include any capability whose purpose is to attack, scan, or intrude upon a third-party system.                                                                                                                      |

### 3.5 Portability and toolchain

| ID         | Requirement                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NFR-17** | The system MUST run on Node.js 20.11.0 or later, and MUST be verified in continuous integration on Node 20.x, 22.x and 24.x.                                                                            |
| **NFR-18** | The system MUST run on Windows, macOS and Linux. Path handling and process spawning MUST account for platform differences.                                                                              |
| **NFR-19** | The protocol, core, server, CLI and bridge packages MUST have **zero runtime dependencies**. React and React DOM are the only runtime dependencies in the repository, and only in the graphical client. |
| **NFR-20** | All source MUST be TypeScript compiled to ES2022 with NodeNext resolution, under `strict` plus `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.                                                   |
| **NFR-21** | The build MUST use TypeScript project references so that each workspace compiles once and dependents consume its declarations.                                                                          |

### 3.6 Testability

| ID         | Requirement                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **NFR-22** | Tests MUST run against TypeScript sources without a prior build step.                                                                     |
| **NFR-23** | Integration tests MUST bind real TCP ports on OS-assigned ports, so tests never collide on a fixed port and the transport is never faked. |
| **NFR-24** | Test timeouts MUST accommodate real socket work; the suite uses 20 s test and hook timeouts.                                              |
| **NFR-25** | Each test MUST clean up the servers and clients it started, so the process exits when the suite ends.                                     |

### 3.7 Usability and diagnostics

| ID         | Requirement                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **NFR-26** | Error messages MUST state what was wrong and what to do about it, in full sentences, and MUST name the specific offending value where one exists.                                                                                                                                                                                          |
| **NFR-27** | Status codes MUST be reported with their reason phrases, never as bare numbers.                                                                                                                                                                                                                                                            |
| **NFR-28** | The documented operation, status and reason tables MUST be verified against the source registries by an automated check, so that they cannot silently drift from the implementation. Verification, rather than generation, is sufficient; prose columns written for a reader are outside the check and remain a reviewer's responsibility. |
| **NFR-29** | Output MUST be usable without colour, and MUST offer a machine-readable form for scripting.                                                                                                                                                                                                                                                |

---

## 4. Scope for v0.1

### 4.1 In scope

| Area      | Included in v0.1                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol  | SLTP/1.0 over raw TCP: framing, incremental decoding, 13 operations, 23 status codes, the reason taxonomy, size limits.               |
| Server    | Single-process control server, concurrent connections, per-connection rate limiting, connection cap, graceful shutdown.               |
| Sessions  | In-memory sessions, each with its own ephemeral TCP mock endpoint on an OS-assigned loopback port.                                    |
| Mocking   | Rule CRUD, deterministic ordering, conflict detection, match tracing, response delay, response fragmentation, mid-message disconnect. |
| Testing   | Declarative scenarios, real-TCP execution, three transmission modes, assertions, wire capture with timing, result classification.     |
| Storage   | In-memory only, bounded, with oldest-first eviction.                                                                                  |
| Clients   | CLI over raw TCP; loopback bridge plus React interface over SSE.                                                                      |
| Artefacts | Versioned scenario bundles and result exports as JSON files.                                                                          |
| Quality   | Vitest suite over real sockets, ESLint, Prettier, type checking, CI on three Node versions.                                           |

### 4.2 Explicitly out of scope

The following are **not** part of v0.1. They are recorded here only as possible future
work; nothing in the codebase depends on them, and no partial implementation of them
exists.

| Excluded                                                          | Note                                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and authorisation                                  | The tool is loopback-only and has no notion of a principal.                                                                                                                     |
| User accounts, roles, multi-tenancy                               | No identity model exists.                                                                                                                                                       |
| Database persistence                                              | All state lives in the server process; nothing survives a restart.                                                                                                              |
| Cloud or hosted deployment                                        | There is no deployment target beyond a developer machine.                                                                                                                       |
| Distributed or production deployment                              | The server is single-process by design.                                                                                                                                         |
| Remote packet capture                                             | The tool observes only the connections it owns.                                                                                                                                 |
| TLS and certificate management                                    | SLTP is carried over plain TCP in v0.1.                                                                                                                                         |
| UDP                                                               | The framing model assumes a reliable ordered stream.                                                                                                                            |
| QUIC                                                              | Same, plus it would require an entirely different transport layer.                                                                                                              |
| Browser extension                                                 | The graphical client is served locally by the bridge.                                                                                                                           |
| VS Code extension                                                 | Not planned for v0.1.                                                                                                                                                           |
| MCP server                                                        | Not planned for v0.1.                                                                                                                                                           |
| Plugin system or marketplace                                      | Rules and scenarios are data, not code; there is no extension point.                                                                                                            |
| Network intrusion, scanning, or any offensive-security capability | Deliberately excluded. Non-loopback targets are refused unless explicitly allowed by the operator, precisely so the tool cannot be repurposed this way — see NFR-14 and NFR-16. |

### 4.3 Known gap in v0.1

`202 TEST ACCEPTED` is present in the status registry and listed among `RUN_TEST`'s success
statuses, and its registry metadata marks it as reserved for a future asynchronous mode.
**Asynchronous test execution is not implemented in v0.1.** `RUN_TEST`
is always synchronous and answers only `210`, `211` or `408`. The code is therefore
reserved but unreachable. Asynchronous execution is future work; the registry entry should
be read as a reservation, not as a capability.

---

## 5. Traceability

| Document                                                        | Relationship to this one                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`docs/architecture.md`](./architecture.md)                     | Explains how the requirements above are met, and records the design decisions and rejected alternatives. |
| [`docs/protocol-specification.md`](./protocol-specification.md) | Normative wire format for FR-1 to FR-17.                                                                 |
| [`docs/status-codes.md`](./status-codes.md)                     | The status registry referenced by FR-14.                                                                 |
| [`docs/protocol-examples.md`](./protocol-examples.md)           | Worked byte-level examples of the framing behaviour in FR-3 to FR-9.                                     |
| [`docs/test-plan.md`](./test-plan.md)                           | Maps test cases to the identifiers above.                                                                |
| [`docs/user-guide.md`](./user-guide.md)                         | Task-oriented use of FR-58 to FR-74.                                                                     |
| [`docs/developer-guide.md`](./developer-guide.md)               | Workflow for FR-78 and the toolchain constraints in NFR-17 to NFR-25.                                    |
