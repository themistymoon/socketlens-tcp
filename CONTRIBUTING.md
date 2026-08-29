# Contributing to SocketLens TCP

Thank you for considering a contribution. This document describes how to set the project up, how it builds, and what is expected of a change before it is proposed.

SocketLens TCP is a local developer tool for designing, mocking, testing, and debugging custom application-layer protocols over raw TCP streams. Its own protocol, SLTP (SocketLens Testing Protocol), runs over raw TCP using Node's built-in `node:net`. It is not HTTP, and no HTTP, WebSocket, or RPC framework is used for the protocol itself. Please read [Hard constraints](#hard-constraints) before writing code that touches the protocol or transport layers.

## Requirements

- Node.js `>=20.11.0`. Continuous integration runs on Node 20.x, 22.x, and 24.x, so a change must work on all three.
- npm, for workspace support. The repository is an npm workspaces monorepo and there is a committed `package-lock.json`.

## Setting up

```
git clone <your-fork-url>
cd socketlens-tcp
npm ci
npm run build
```

`npm ci` installs from the lockfile and links the workspaces. Use it rather than `npm install` unless you are deliberately changing dependencies.

## Repository layout

Six workspaces, declared as `packages/*` and `apps/*`:

- `packages/protocol` — SLTP message types, the encoder, the incremental stream decoder, and the operation and status registries. It imports no `node:` module, but the encoder, decoder, and `format.ts` use the `Buffer` global, since framing has to be done on bytes. The browser interface imports the browser-safe subset, `@socketlens/protocol/browser`, which excludes those and keeps the registries, header helpers, view types, and string-only display helpers.
- `packages/core` — shared domain logic: sessions, mock rules, matching, scenarios, assertions, the SLTP client, and protocol logging.
- `apps/server` — the raw TCP control server, plus the per-session mock endpoints.
- `apps/cli` — the command-line client. It is the primary client and is fully functional with no graphical interface present.
- `apps/gui` — the React interface, built with Vite.
- `apps/bridge` — the loopback bridge that lets the browser reach the process owning the TCP socket.

Tests live in the top-level `tests/` directory, and runnable example scenarios in `examples/`.

## The build

TypeScript is configured as a composite project with project references. The root `tsconfig.json` has an empty `files` array and references each workspace in dependency order, so the whole graph is built with a single `tsc -b`:

```
npm run build:ts     # tsc -b tsconfig.json, all six references
npm run build:gui    # vite build, for apps/gui only
npm run build        # both, in that order
```

`npm run typecheck` runs `tsc -b tsconfig.json` and then `tsc -p tsconfig.tests.json`. The first is the same composite build as `build:ts` — type checking and building the workspaces are one operation here — and the second checks `tests/`, which sits outside the project references and would otherwise never be type checked at all.

`npm run clean` removes build output when an incremental build gets into an inconsistent state.

The compiler settings that most often surprise newcomers are in `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, and `module`/`moduleResolution` set to `NodeNext`. `NodeNext` means relative imports in source must carry a `.js` extension even though the file on disk is `.ts`:

```ts
import { EventHub } from './events.js'; // correct
import { EventHub } from './events'; // will not resolve
```

`verbatimModuleSyntax` means type-only imports must say so. The lint rule `@typescript-eslint/consistent-type-imports` enforces the inline style the codebase uses:

```ts
import { startBridge, type BridgeOptions } from './index.js';
```

### Build first: `tsx` does not use the Vitest path aliases

This is the one gotcha worth knowing before you lose an hour to it.

`vitest.config.ts` defines `resolve.alias` entries that map `@socketlens/protocol`, `@socketlens/core`, and `@socketlens/server` directly onto their TypeScript sources under `src/`. That is why `npm test` never needs a prior build — tests run straight against source.

`tsx` does not read `vitest.config.ts` and does not share those aliases. When `tsx` runs a file that imports `@socketlens/core`, it resolves through the workspace symlink and the package's `main`/`exports` fields, both of which point into `dist/`. So a `tsx` run executes **compiled output**, not your working tree.

The consequence: editing a file under `packages/core/src/` and immediately running `tsx` silently executes the previous build. There is no error and no warning; the code just behaves as it did before your edit. If a change appears to have no effect, this is the first thing to check.

The scripts that use `tsx` guard against it by building first — `dev:server`, `dev:cli`, `dev:bridge`, and `examples` all begin with `npm run build:ts`. Preserve that ordering if you add another `tsx` entry point, and run `npm run build:ts` yourself before invoking `tsx` by hand.

## Running the project

```
npm run start:server                          # compiled server on 127.0.0.1:7420
npm run cli -- ping --raw                     # compiled CLI against it
npm run dev                                   # interface and server together, from source
```

`npm run cli` invokes the compiled entry point, so build first. Arguments after `--` are passed through to the CLI. `--raw` prints the exact bytes of every message in both directions, which is usually what you want while debugging.

## Tests

```
npm test              # vitest run, one pass
npm run test:watch    # vitest, watch mode
npm run test:coverage # vitest run --coverage, v8 provider, reports into ./coverage
```

Vitest collects `tests/**/*.test.ts`, `tests/**/*.test.tsx`, and colocated `{packages,apps}/**/*.test.{ts,tsx}`. The default environment is `node`.

Timeouts for both tests and hooks are set to 20 seconds. That ceiling is deliberate: the server tests bind real TCP ports rather than simulating them, and a generous limit avoids flakes on slow machines. Do not raise it to paper over a hang — a test that needs more than 20 seconds is almost certainly waiting on something that will never arrive.

When you add behaviour, add a test near its peers: decoder and encoder work under `tests/protocol/`, matching and assertions under `tests/core/`, socket-level behaviour under `tests/server/`, and argument parsing and rendering under `tests/cli/`. Shared fixtures and the server harness live in `tests/helpers/`.

Any change to framing, buffering, or the decoder must come with a test that splits or joins the byte stream at an awkward boundary. Splitting inside the `\r\n\r\n` delimiter, inside a `Content-Length` header line, and inside a multi-byte UTF-8 character are the three cases that catch most framing regressions.

## Linting and formatting

```
npm run lint          # eslint .
npm run lint:fix      # eslint . --fix
npm run format        # prettier --write .
npm run format:check  # prettier --check .
```

ESLint uses the flat config in `eslint.config.mjs`: `@eslint/js` recommended, `typescript-eslint` recommended, and `eslint-config-prettier` last so that formatting is Prettier's responsibility alone. `apps/gui` additionally gets `eslint-plugin-react-hooks`.

Prettier is configured in `.prettierrc.json`: print width 100, single quotes, semicolons, trailing commas everywhere, parentheses around arrow parameters, and LF line endings. Markdown uses `proseWrap: preserve`, so prose lines are left as written and are not rewrapped.

The LF setting matters on Windows. If Git is configured with `core.autocrlf=true`, checked-out files gain CRLF endings and `npm run format:check` fails on files you never touched. Set `core.autocrlf=input` for this repository, or leave it unset and rely on the `.editorconfig`.

### Code style conventions

Beyond what the tools enforce:

- `no-console` is switched off on purpose. Printing protocol traffic is the point of the tool. Route deliberate output through the logger in `packages/core` where one exists, rather than adding ad-hoc `console.log` calls in library code.
- `eqeqeq` is an error. Use `===` and `!==` without exception.
- `prefer-const`, `no-var`, and `object-shorthand` are errors.
- `no-else-return` is an error and `allowElseIf` is off. Return early rather than nesting.
- Unused variables are errors unless prefixed with `_`. That applies to arguments, bindings, and caught errors alike.
- `@typescript-eslint/no-explicit-any` and `no-non-null-assertion` are warnings in source and switched off in test files. Keep source free of both where you reasonably can; a warning left behind should have a comment explaining why.
- Exported symbols carry TSDoc comments. The existing modules are documented at a level a reader unfamiliar with SLTP can follow, and new code should match that standard.
- Comments explain why, not what. The registries in `packages/protocol` are the model to follow.

## Hard constraints

These are properties of the project, not preferences, and a change that breaks one will not be accepted.

- **SLTP stays on raw TCP.** The protocol is carried over `node:net` sockets and nothing else. Do not introduce HTTP, WebSocket, Socket.IO, gRPC, or any RPC framework into the protocol layer, and do not add a framework dependency to make the transport easier. The transport being raw is the reason the project exists.
- **The bridge is not the protocol.** `apps/bridge` runs a small HTTP server on loopback for one reason: a browser cannot open a TCP socket, so the bridge holds the socket and relays commands about SLTP and streams events back. It carries commands about SLTP; it never carries SLTP framing, and it must not become the primary client-server path. The CLI must remain fully functional with the bridge and interface absent.
- **Never assume TCP preserves message boundaries.** One `socket.write()` may arrive as several `data` events; one `data` event may hold a fragment of a message, exactly one message, or several messages, and may end mid-header, mid-body, or mid-character. All framing must be done with Buffer operations on a per-connection buffer, and each connection must own exactly one decoder instance. Examples 05 and 06 exist to make this observable.
- **Documentation must match the implementation.** Every SLTP message printed in a document must be valid per the current implementation, including its `Content-Length`, which counts bytes and not characters. The example runner enforces this for `examples/`: if an example's README disagrees with the code, `npm run examples` exits non-zero.

## The example scenarios

There are eleven runnable examples in `examples/`, each demonstrating one property of SLTP over raw TCP:

```
npm run examples                # run all eleven
npm run examples -- --list      # names and numbers
npm run examples -- --only 6    # a single example
```

The script builds first (`npm run build:ts && tsx examples/run-all.ts`), for the reason given above. The runner starts its own server on an OS-assigned port, so it will not collide with a server already listening on 7420, and it leaves nothing behind.

Each example is also a `bundle.json` in the `socketlens-scenario-bundle/1` format that you can drive through the CLI:

```
npm run start:server                                                  # terminal 1
npm run cli -- session create --name demo                             # terminal 2
npm run cli -- run --file examples/06-coalesced-messages/bundle.json --raw
```

Examples 04, 08, and 10 are documented as not producing a plain pass — a failing assertion, a timeout, and a mid-message disconnect respectively. Each is registered in the runner with its documented outcome, so example 04 would make the run fail if it ever started passing. That is intentional; do not "fix" it.

If you change protocol behaviour, run `npm run examples` and update the affected example README so the printed bytes still match what the code produces.

## Before you open a pull request

Run the full gate. It is exactly what CI runs, in the same order:

```
npm run verify
```

That chains `format:check`, `lint`, `typecheck`, `test`, and `build`. If it passes locally on Node 20.11 or newer, CI is very unlikely to disagree. Run `npm run examples` as well when your change touches the protocol, the server, or the decoder.

### Commits

- One logical change per commit. Keep formatting-only churn out of a behavioural commit.
- Write the subject in the imperative mood, under about 72 characters, with no trailing full stop: `Reject a bare LF as a framing error`.
- Explain the reasoning in the body when the change is not self-evident. Wire-format decisions in particular deserve a paragraph.
- Reference the issue the commit closes in the body, not the subject.

### Pull requests

- Describe what changed and why. If the change alters anything on the wire, show the before and after bytes.
- Say which of `npm run verify` and `npm run examples` you ran, and note anything you could not test.
- Include tests for new behaviour and for the bug you fixed. A framing fix without a byte-boundary test is not complete.
- Update the affected documentation in the same pull request. Documentation and implementation are expected to agree at every commit, so a protocol change that leaves a stale example in `examples/` or `docs/` is an incomplete change.
- Add a `CHANGELOG.md` entry under an `Unreleased` heading for anything user-visible.
- Keep the diff reviewable. Unrelated refactoring belongs in its own pull request.

## Reporting a bug

Open an issue and include:

1. What you expected to happen and what happened instead.
2. Your Node.js version (`node --version`), operating system, and the commit you are on.
3. How you started the server, including any flags such as `--max-connections` or `--no-rate-limit`.
4. The exact bytes of the exchange, obtained by re-running the case with `--raw`.
5. A minimal reproduction, ideally a scenario bundle.

### Include a reproducible SLTP message

A bug report about a protocol tool needs the bytes. Show them with `\r\n` written out explicitly, so it is unambiguous where each line ends and where the blank line separating headers from body sits. Copy the output of `--raw`, which already prints in this form.

A complete, valid exchange looks like this — a `PING` request:

```
SLTP/1.0 PING\r\n
Request-ID: req-1\r\n
\r\n
```

and its response:

```
SLTP/1.0 200 OK\r\n
Request-ID: req-1\r\n
Matched-Rule-ID: ping-ok\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 18\r\n
\r\n
{"message":"pong"}
```

Points to check before posting, because they account for most reports that turn out not to be bugs:

- Every line ends with CRLF. A bare CR or a bare LF is a framing error, not a tolerated variation.
- A single empty line ends the header block. The four bytes `\r\n\r\n` are the delimiter.
- `Content-Length` counts **bytes**, not characters. `{"message":"pong"}` is 18 bytes because it is ASCII; a body containing any non-ASCII character will have a byte count larger than its character count. Example 03 covers this.
- The start line begins with the exact token `SLTP/1.0`.

If the bug involves fragmentation, say how the bytes were split across writes, since that is usually the whole reproduction. A scenario can drive a specific split directly, as example 05 does when it sends one message in seven writes with cuts falling inside delimiters.

If the report concerns a decoder failure, include the `Reason` header from the server's error response along with the status code. `400 BAD REQUEST` covers both recoverable header faults and fatal framing faults, and the `Reason` value is what distinguishes them.

## Security issues

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

Contributions are accepted under the MIT Licence, the licence covering this project.
