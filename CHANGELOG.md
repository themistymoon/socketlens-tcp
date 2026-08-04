# Changelog

All notable changes to SocketLens TCP are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-04

Initial release. SocketLens TCP is a local developer tool for designing, mocking, testing, and debugging custom application-layer protocols over raw TCP streams.

### Added

#### SLTP/1.0, the SocketLens Testing Protocol

- A text-based, CRLF-delimited, length-framed application-layer protocol carried over a single raw TCP byte stream via Node's built-in `node:net`. No HTTP, WebSocket, or RPC framework is involved in the protocol.
- Request start lines of the form `SLTP/1.0 <OPERATION>` and response start lines of the form `SLTP/1.0 <code> <PHRASE>`, with a `\r\n\r\n` header delimiter and an explicit `Content-Length` body length in bytes.
- An operation registry of thirteen operations: `PING`, `SERVER_INFO`, `CREATE_SESSION`, `GET_SESSION`, `LIST_SESSIONS`, `ADD_RULE`, `UPDATE_RULE`, `DELETE_RULE`, `LIST_RULES`, `RUN_TEST`, `GET_RESULT`, `LIST_RESULTS`, and `CLOSE_SESSION`. Each entry declares its target endpoint, whether a session and a body are required, and its permitted success codes. A syntactically valid but unregistered token is answered with `501 OPERATION NOT SUPPORTED`.
- A status registry whose numeric ranges are deliberately familiar to readers of HTTP but whose meanings are normative for SLTP. Several codes have no HTTP counterpart, including `210 TEST PASSED`, `211 TEST FAILED`, `410 NO MATCHING RULE`, and the rule lifecycle codes `212`, `213`, and `214`.
- A defined header set covering `Request-ID`, `Session-ID`, `Content-Length`, `Content-Type`, `Timestamp`, `Connection`, `Response-Delay`, `Matched-Rule-ID`, `Result-ID`, `Reason`, `Server`, and `Retry-After`.
- Message encoding and validation, with the protocol package written free of any Node.js API so that the browser interface can import it directly.

#### Incremental TCP stream decoder

- A per-connection incremental decoder that makes no assumption about chunk boundaries. It appends each chunk to a per-connection Buffer and repeatedly extracts complete messages, retaining trailing partial bytes for the next chunk.
- Correct handling of the three cases TCP permits and application code routinely gets wrong: one write arriving as several `data` events, several writes arriving as one `data` event, and a `data` event ending mid-header, mid-body, or in the middle of a multi-byte UTF-8 character. All framing is done on bytes; UTF-8 decoding happens only once a complete body is present, which makes a split multi-byte character harmless.
- Configurable, enforced size limits that bound memory use against a peer that never sends a terminating delimiter: 1 MiB per message, 16 KiB per header block, 1 KiB per start line, and 64 header fields. Exceeding a limit yields `413 MESSAGE TOO LARGE` and is fatal for the connection, because the remaining bytes of an oversized message cannot be safely skipped.
- A distinction between recoverable faults, which leave the connection open, and framing faults, which close it because the byte stream can no longer be resynchronised at a message boundary. Each carries a machine-readable `Reason`.

#### TCP server

- A raw TCP control server built on `node:net`, binding to `127.0.0.1:7420` by default. There is no HTTP interface.
- Per-connection isolation: every connection owns its own decoder, receive buffer, and rate limiter, so two byte streams can never interleave.
- Per-session ephemeral TCP mock endpoints on loopback, so scenarios exercise real TCP segmentation rather than a simulation of it.
- A per-connection token-bucket rate limit, defaulting to a burst of 120 requests and a sustained 60 requests per second, answering `429 TOO MANY REQUESTS` with a `Retry-After` delay in milliseconds. It is sized to catch runaway loops rather than to throttle a user, and can be disabled with `--no-rate-limit`.
- A cap on simultaneous control connections, defaulting to 64 and configurable with `--max-connections`.
- Scenario targets restricted to loopback by default. Additional development hosts must be named explicitly and repeatably with `--allow-target`.
- Command-line options for the bind address, port, log verbosity, connection cap, target allowances, and rate limiting, with a port of `0` asking the operating system for an ephemeral one.
- Graceful shutdown, answering requests arriving during shutdown with `503 SERVER UNAVAILABLE`.

#### Sessions and mock rules

- Isolated testing sessions, each with a dedicated TCP mock endpoint started on creation and shut down on close. Stored results remain readable after a session closes.
- Mock response rules with deterministic, documented evaluation ordering, exposed by `LIST_RULES` in the exact order the matcher applies them.
- Rule matching on operation, headers, and body, with configurable status, headers, body, and an artificial response delay bounded at 60 seconds so a stuck test cannot hang indefinitely.
- Conflict detection returning `409 RULE CONFLICT` for a duplicate identifier, a duplicate name within a session, or an identical match specification at the same priority, which would otherwise make matching non-deterministic.
- `410 NO MATCHING RULE` from a mock endpoint that receives a well-formed request no enabled rule matches and for which the session defines no default response. The control server never sends it.

#### Test runner

- Scenario execution over a real TCP connection, comparing expected against actual and returning `210 TEST PASSED` or `211 TEST FAILED`. A failed assertion is reported as a successful SLTP exchange, so `211` is a 2xx code.
- An assertion library covering status codes, status phrases, headers, and JSON body subsets, with expected-versus-actual reporting that names the specific assertion that did not hold.
- Timeouts, defaulting to 5 seconds, reported as `408 TEST TIMEOUT` unless the scenario declares a timeout as its expected outcome, in which case the run passes.
- Scenarios able to specify how a message is split across writes, so fragmentation can be reproduced deterministically.
- Synchronous and asynchronous execution modes, the latter returning `202 TEST ACCEPTED` with a `Result-ID` for later retrieval.
- Stored results including the raw bytes sent and received, retrievable individually or as a summary list.
- Scenario and rule validation that reports every problem at once rather than stopping at the first, returning `422 INVALID SCENARIO` for a well-formed message describing a semantically invalid scenario.

#### Command-line client

- `socketlens`, the primary SLTP client, fully functional with no graphical interface present.
- Commands for connectivity (`ping`, `info`, `raw`), sessions (`create`, `list`, `show`, `use`, `close`), mock rules (`add`, `list`, `update`, `delete`), tests (`run`, `scenario show`, `result list`, `result show`, `result export`), and the protocol registries (`help operations`, `help status`).
- An interactive `repl` mode that reuses a single connection.
- A `--raw` mode printing the exact bytes of every message in both directions, with CRLF made visible.
- A remembered current session, machine-readable `--json` output, colour control honouring `NO_COLOR`, and the `SOCKETLENS_HOST`, `SOCKETLENS_PORT`, and `SOCKETLENS_STATE_FILE` environment variables.

#### React interface and loopback bridge

- A local React 19 interface, built with Vite, for managing sessions, mock rules, and scenarios and for inspecting SLTP messages.
- A loopback bridge that owns the raw TCP connection to the control server and exposes a deliberately small set of `/bridge/*` routes, written directly against `node:http` with no web framework. It optionally serves the built interface as static assets.
- A live event stream feeding protocol traffic to the interface as it happens.
- A strict architectural boundary: the bridge exists solely so a browser, which cannot open a TCP socket, can reach the process that owns one. It carries commands about SLTP and never carries SLTP framing, and it is not the primary client-server protocol.

#### Example scenarios

- Eleven runnable examples, each isolating one property of SLTP over raw TCP: a basic `PING`; session and rule isolation; a passing test; a failing test; a fragmented message sent as seven writes with cuts inside delimiters; two messages coalesced into one write; a delayed response; a timeout asserted as the expected outcome; a malformed `Content-Length`; a disconnect during a message body; and two concurrent clients.
- A runner (`npm run examples`) that starts its own server on an OS-assigned port, records the documented outcome of each scenario individually rather than assuming everything should pass, and exits non-zero when an example's documentation disagrees with the implementation.
- A `socketlens-scenario-bundle/1` bundle format carrying both mock rules and scenarios in one file, usable through the CLI and validated with all problems reported at once.

#### Project infrastructure

- An npm workspaces monorepo of six workspaces: `packages/protocol`, `packages/core`, `apps/server`, `apps/cli`, `apps/gui`, and `apps/bridge`.
- A strict TypeScript composite project with `NodeNext` module resolution, built across all workspaces with a single `tsc -b`.
- A Vitest suite covering the protocol, core domain logic, the server, the CLI, and a small amount of interface logic, running against TypeScript sources so no build is required first, with integration tests binding real TCP ports. Coverage reporting uses the v8 provider.
- A separate `tsconfig.tests.json` type-checking `tests/`, which lies outside the six project references and so is invisible to `tsc -b`. `npm run typecheck` runs both passes. It uses `moduleResolution: "Bundler"` with `paths` mirroring the Vitest aliases, matching how Vitest actually resolves those imports.
- ESLint 9 flat configuration and Prettier, with a single `npm run verify` gate chaining `format:check`, `lint`, `typecheck`, `test`, and `build`.
- GitHub Actions continuous integration running that gate on Node 20.x, 22.x, and 24.x, plus a separate coverage job.

### Fixed

- The shared `testResult` test fixture omitted `sentSegmentCount`, a required field of `TestResult`, so every test built on it carried `undefined` in a non-optional field. Found by type-checking `tests/` for the first time; no test had asserted on the field, so nothing failed.
- `vitest.config.ts` had no alias for `@socketlens/core/models`, so prefix matching against the bare `@socketlens/core` entry would have rewritten it to a path that does not exist. Only type-only imports had used the specifier, so the fault had not yet surfaced at runtime.
- The rule and scenario editors each carried their own copy of `parseHeaderLines`, `parseSizes`, and `optionalCount`. The copies were behaviourally identical but free to drift; they are now one module in `apps/gui/src/lib/form-parsing.ts`.
