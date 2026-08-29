# CLAUDE.md

Operational guidance for an AI coding agent working in this repository. Read the hard constraints before writing code.

## What this project is

SocketLens TCP 0.1.2 — a local developer tool for designing, mocking, testing, and debugging custom application-layer protocols over raw TCP streams.

Its protocol, SLTP (SocketLens Testing Protocol) version 1.0, is a text-based, CRLF-delimited, length-framed application-layer protocol carried over a single raw TCP byte stream using Node's built-in `node:net`. It is not HTTP. Requests begin `SLTP/1.0 <OPERATION>`, responses begin `SLTP/1.0 <code> <PHRASE>`, `\r\n\r\n` ends the header block, and `Content-Length` gives the body length **in bytes**.

MIT licence, copyright 2026 Natthakit Jantawong. Node `>=20.11.0`.

## Architecture

An npm workspaces monorepo, six workspaces, built as one TypeScript composite project.

- `packages/protocol` — SLTP message types, encoder, incremental stream decoder, validation, and the operation and status registries. It **imports no `node:` module**, but the framing implementation is Node-oriented: `encoder.ts`, `decoder.ts`, and `format.ts` use the `Buffer` global, because framing must be done on bytes. The browser therefore imports `@socketlens/protocol/browser`, the browser-safe subset — constants, both registries, header helpers, reason codes, the JSON-safe view types, and the string-only display helpers, which measure UTF-8 length with `TextEncoder`. That subset deliberately excludes Buffer-based encoding and decoding. Keep it that way: `browser.ts` must stay free of `Buffer`, `node:net`, and every Node.js global.
- `packages/core` — sessions, mock rules, matching, scenarios, assertions, the SLTP client, protocol logging. Depends on `protocol`.
- `apps/server` — the raw TCP control server on `127.0.0.1:7420`, plus an ephemeral per-session TCP mock endpoint. Each connection owns its own decoder, receive buffer, and rate limiter.
- `apps/cli` — `socketlens`, the primary client. Must stay fully functional with no interface present.
- `apps/gui` — React 19 interface, built with Vite.
- `apps/bridge` — a loopback `node:http` server that owns a TCP connection to the control server and relays for the browser. Six routes under `/bridge/*`, no web framework.

Tests are in `tests/` (`protocol`, `core`, `client`, `server`, `cli`, `bridge`, `gui`, with shared fixtures and a harness in `tests/helpers`). Eleven runnable examples are in `examples/`. Reference documentation is in `docs/`. `benchmarks/` measures SLTP against HTTP/1.1 and is not part of `verify`.

The registries in `packages/protocol/src/operations.ts` and `status.ts` are the normative source for what SLTP accepts and returns. Consult them before adding or changing an operation or a status code.

## Commands

Verified against the root `package.json`. Use these exactly.

```
npm ci                  # install from the lockfile
npm run build           # build:ts then build:gui
npm run build:ts        # tsc -b tsconfig.json, all six project references
npm run typecheck       # tsc -b tsconfig.json, then tsc -p tsconfig.tests.json
npm test                # vitest run
npm run test:watch      # vitest
npm run test:coverage   # vitest run --coverage
npm run lint            # eslint .
npm run lint:fix        # eslint . --fix
npm run format          # prettier --write .
npm run format:check    # prettier --check .
npm run examples        # build:ts, then tsx examples/run-all.ts (all eleven)
npm run verify          # format:check, lint, typecheck, test, build
```

`npm run verify` is the gate. It is exactly what CI runs, in that order, on Node 20.x, 22.x, and 24.x. Run it before declaring work finished. Run `npm run examples` as well whenever the protocol, server, or decoder changed.

Running the tool: `npm run start:server`, `npm run cli -- <args>`, `npm run dev`. Add `--raw` to any CLI command to print exact bytes.

### Build before running `tsx`

`vitest.config.ts` aliases `@socketlens/protocol`, `@socketlens/core`, and `@socketlens/server` onto their `src/` TypeScript sources, which is why `npm test` needs no prior build.

**`tsx` does not use those aliases.** It resolves workspace imports through each package's `main`/`exports` fields, which point into `dist/`. Running `tsx` against a stale `dist/` silently executes the previous build — no error, no warning, and your edit appears to do nothing. Always `npm run build:ts` first. The `dev:server`, `dev:cli`, `dev:bridge`, and `examples` scripts already do; preserve that if you add a `tsx` entry point.

## Code style

Enforced by `eslint.config.mjs` and `.prettierrc.json`; do not fight the tools.

- Prettier: print width 100, single quotes, semicolons, trailing commas everywhere, arrow parentheses always, **LF** endings. Markdown uses `proseWrap: preserve`.
- TypeScript: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `NodeNext` modules and resolution.
- `NodeNext` requires a `.js` extension on relative imports even though the source file is `.ts`: `import { EventHub } from './events.js';`
- Use inline type imports: `import { startBridge, type BridgeOptions } from './index.js';`
- `eqeqeq` is an error. `no-else-return` is an error with `allowElseIf` off — return early.
- Unused bindings must be prefixed with `_`.
- `no-console` is off deliberately; printing protocol traffic is the point. Prefer the logger in `packages/core` in library code.
- Document exported symbols with TSDoc, matching the standard already set in `packages/protocol`.

## Hard constraints

Never violate these. A change that does is wrong regardless of whether tests pass.

### The transport stays raw

SLTP is carried over raw TCP via `node:net` and nothing else. **Do not introduce HTTP, WebSocket, Socket.IO, gRPC, or any RPC framework into the protocol layer**, and do not add a dependency that abstracts the transport. If a task seems to call for one, the task has been misread. The transport being raw is the reason this project exists.

### The bridge is not the protocol

`apps/bridge` runs a small loopback HTTP server for exactly one reason: a browser cannot open a TCP socket, so the bridge holds the socket, relays commands _about_ SLTP, and streams events to the interface. It carries commands about SLTP; **it never carries SLTP framing, and it must never become the primary client-server protocol.** The CLI must remain fully functional with the bridge and the interface absent. Do not move protocol logic into the bridge, and do not reimplement SLTP there.

### TCP framing rules

TCP guarantees a reliable, ordered byte stream and nothing more. It does not preserve application message boundaries. Therefore:

- **Never assume one `socket.write()` produces one `data` event.** Example 05 sends one message in seven writes.
- **Never assume one `data` event holds a complete message.** It may end mid-header, mid-body, or in the middle of a multi-byte UTF-8 character.
- **Never assume one `data` event holds only one message.** Example 06 sends two messages in one write.

All framing logic must use **Buffer operations** on a per-connection buffer — never string concatenation, never `chunk.toString()` before a complete message is framed. Decode UTF-8 only once a full body is present; that is what makes a split multi-byte character harmless. Each connection must own exactly one decoder instance; sharing one interleaves two byte streams and corrupts both.

Any change to framing, buffering, or the decoder needs a test that splits the stream at an awkward boundary: inside `\r\n\r\n`, inside a `Content-Length` line, and inside a multi-byte character.

Size limits exist to bound memory against a peer that never sends a delimiter: 1 MiB per message, 16 KiB per header block, 1 KiB per start line, 64 headers. Exceeding one is fatal for the connection, because an oversized message's remaining bytes cannot be safely skipped and the stream cannot be resynchronised.

### Documentation must match the implementation

Documentation and implementation are expected to agree at every commit.

- **Every protocol example in any document must be valid per the current implementation** — a registered operation, a registered status code and its exact canonical phrase, real header names, CRLF line endings, and a `Content-Length` that is the correct **byte** count. Bytes and characters differ for any non-ASCII body.
- `npm run examples` enforces this for `examples/`: the runner exits non-zero when an example's README disagrees with the code. If you change protocol behaviour, update the affected example README in the same change.
- The status registry in `packages/protocol/src/status.ts` is the normative source for status codes, and the operation registry in `operations.ts` for operations. `docs/protocol-specification.md` §11 and §12, and the tables in `docs/status-codes.md`, restate both by hand — but `tests/protocol/docs-registry-consistency.test.ts` compares them against the registries on every `npm test`, so a missing, extra, reordered, or mis-phrased entry fails the suite. Change a registry and that test tells you which document to update. It checks the machine-derivable columns only; the prose columns are still yours to keep truthful. `docs/` holds fifteen documents; see the table in `README.md`.
- A protocol change that leaves a stale example anywhere is an incomplete change.

## Working notes

- Do not weaken a test to make it pass. The 20-second Vitest timeout is generous because integration tests bind real TCP ports; a test exceeding it is waiting on something that will never arrive.
- Examples 04, 08, and 10 are documented as not passing plainly — a failing assertion, a timeout, and a mid-message disconnect. The runner registers each with its documented outcome, so example 04 would fail the run if it started passing. Do not "fix" them.
- `211 TEST FAILED` is a 2xx code on purpose: a successful SLTP exchange reporting a failed test. Do not "correct" it to a 4xx.
- SLTP status codes borrow HTTP's numeric ranges for familiarity only. Their meanings are normative for SLTP, and `210`, `211`, `410`, `212`, `213`, and `214` have no HTTP counterpart. Never assume an HTTP meaning.
- v0.1 is in-memory only and loopback only, with no authentication by design. Do not add persistence or auth incidentally; both are roadmap items requiring a design discussion. See `ROADMAP.md` and `SECURITY.md`.
- Never add scanning, exploitation, credential-interception, packet-sniffing, or denial-of-service functionality. Permanently out of scope.
- On Windows, set `core.autocrlf=input` for this repository. With `true`, checked-out files gain CRLF endings and `npm run format:check` fails on files you never touched.
- Do not create git commits, push, or amend history unless explicitly asked.
