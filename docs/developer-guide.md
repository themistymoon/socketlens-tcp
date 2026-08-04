# SocketLens TCP — Developer Guide

Version 0.1.0. This document is for people changing the code: how to get the repository
building, how the three toolchains resolve modules differently, how to run the tests, and
how to extend the protocol without leaving the codebase inconsistent with its own
documentation.

It deliberately does not restate material that lives elsewhere:

| For                                                 | Read                                                            |
| --------------------------------------------------- | --------------------------------------------------------------- |
| Why the system is shaped the way it is              | [`docs/architecture.md`](./architecture.md)                     |
| What it is required to do, and what is out of scope | [`docs/requirements.md`](./requirements.md)                     |
| The normative SLTP/1.0 wire format                  | [`docs/protocol-specification.md`](./protocol-specification.md) |
| The status registry, code by code                   | [`docs/status-codes.md`](./status-codes.md)                     |
| What is tested, at which level, and why             | [`docs/test-plan.md`](./test-plan.md)                           |
| How to drive the CLI and the interface as a user    | [`docs/user-guide.md`](./user-guide.md)                         |

One reminder before anything else, because it changes how you read the rest of the code:
**SLTP runs over raw TCP through `node:net`. It is not HTTP.** The only HTTP in the
repository is the bridge's loopback control surface, which carries commands _about_ SLTP
between the browser and the process that owns the socket. No HTTP framing ever touches an
SLTP message.

---

## 1. Getting set up

### Prerequisites

| Requirement | Value                              | Where it is declared                 |
| ----------- | ---------------------------------- | ------------------------------------ |
| Node.js     | `>=20.11.0`                        | `engines` in the root `package.json` |
| npm         | v9 or later, for workspace support | —                                    |
| Git         | any recent version                 | —                                    |

Nothing else is needed. `@socketlens/protocol`, `@socketlens/core`, `@socketlens/server`,
`@socketlens/cli` and `@socketlens/bridge` declare no runtime dependencies at all; only
`apps/gui` does, and its dependencies are React and React DOM. Everything else —
TypeScript, Vitest, Vite, ESLint, Prettier, `tsx` — is a root devDependency.

### Install

```bash
git clone https://github.com/themistymoon/socketlens-tcp.git
cd socketlens-tcp
npm ci
```

`npm ci` installs exactly what `package-lock.json` records, which is what CI does and what
keeps a local run comparable to a CI run. Use `npm install` only when you are deliberately
adding or changing a dependency. Either way, installing at the root installs for every
workspace and symlinks each `@socketlens/*` package into the root `node_modules`, which is
what makes `import ... from '@socketlens/core'` resolve at all.

### First build

```bash
npm run build
```

Two stages, in this order:

| Stage       | Command                    | Output                                                                                        |
| ----------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `build:ts`  | `tsc -b tsconfig.json`     | `packages/*/dist`, `apps/{server,cli,bridge}/dist`, plus a `tsconfig.tsbuildinfo` per project |
| `build:gui` | `vite build` in `apps/gui` | `apps/gui/dist`                                                                               |

### First test run

```bash
npm test
```

The test suite does **not** require the build: Vitest resolves every workspace import to
TypeScript source (§4). A clean checkout can go straight from `npm ci` to `npm test`.

At the time of writing that is 16 test files and 434 tests, finishing in a couple of
seconds. Roughly a quarter of them open real TCP sockets on loopback.

### Confirming the whole toolchain

```bash
npm run verify
```

This is the gate CI enforces; see §10.

### Running the thing you just built

The user guide covers this properly. The short version:

```bash
npm run start:server     # node apps/server/dist/index.js — needs a prior build
npm run cli -- ping      # node apps/cli/dist/index.js    — needs a prior build
npm run dev              # server + bridge + Vite dev server, all from source
npm run dev:server       # build:ts, then tsx watch on the server source
npm run examples         # build:ts, then the eleven example scenarios
npm run clean            # remove every dist, tsbuildinfo, and coverage directory
```

---

## 2. Repository layout

Six workspaces, declared by the root `package.json` as `packages/*` and `apps/*`.

| Path                | Package                | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                 | Depends on                                                                                                            |
| ------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol` | `@socketlens/protocol` | SLTP itself: wire constants and limits, header grammar and accessors, the encoder, the incremental `SltpDecoder`, the operation registry, the status registry, the reason taxonomy, registry-driven request validation, display helpers. Two entry points: `.` (Node, includes the encoder and decoder) and `./browser` (pure TypeScript over strings and plain objects, no `Buffer`, no encoder, no decoder). | nothing                                                                                                               |
| `packages/core`     | `@socketlens/core`     | Protocol-aware domain logic shared by every executable: domain models, identifiers, the protocol logger, rule and scenario validation, deterministic rule ordering and matching, assertion evaluation, the per-session TCP mock endpoint, the session store, the scenario test runner, the `SltpClient`, bundle and result serialisation. Two entry points: `.` and `./models`.                                | `@socketlens/protocol`                                                                                                |
| `apps/server`       | `@socketlens/server`   | The SLTP control listener: per-connection state (each with its own decoder and token bucket), admission control, concurrent dispatch, the operation handlers, ordered shutdown, and the server's own CLI entry point.                                                                                                                                                                                          | `@socketlens/core`, `@socketlens/protocol`                                                                            |
| `apps/cli`          | `@socketlens/cli`      | The primary client. Hand-written argument parsing, a command dispatch table, terminal rendering, remembered-session state, and a REPL. Speaks SLTP over a raw socket with no intermediary.                                                                                                                                                                                                                     | `@socketlens/core`, `@socketlens/protocol`                                                                            |
| `apps/bridge`       | `@socketlens/bridge`   | Loopback relay so a browser can drive a real TCP socket: one `SltpClient`, an SSE event hub, and a six-route `node:http` surface under `/bridge/*` plus optional static hosting. Reimplements no part of SLTP.                                                                                                                                                                                                 | `@socketlens/core`, `@socketlens/protocol`                                                                            |
| `apps/gui`          | `@socketlens/gui`      | The React interface. Renders `SltpMessageView` projections produced by the bridge's decoder; never parses bytes and never opens a socket.                                                                                                                                                                                                                                                                      | `@socketlens/protocol` (runtime, via `./browser`), `react`, `react-dom`; `@socketlens/core/models` for **types only** |

Note the asymmetry in the last row: `apps/gui/package.json` lists only `@socketlens/protocol`,
`react` and `react-dom`. It imports `@socketlens/core/models` for type declarations without
declaring a dependency on `core`, because it takes nothing from `core` at runtime. That
resolves locally because npm workspaces symlink every workspace package into the root
`node_modules` regardless of who declared it — see the gotcha in §9.

Directories that are not workspaces:

| Path                 | Contents                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/`             | Every Vitest suite: `protocol/`, `core/`, `server/`, `cli/`, and shared helpers in `helpers/`. Not a workspace, not compiled by `tsc`. `tests/client/` exists but is currently empty.  |
| `examples/`          | Eleven numbered example directories, each a `README.md` plus a `bundle.json`, and `run-all.ts`, which starts its own server on an OS-assigned port and checks each documented outcome. |
| `scripts/`           | `clean.mjs` (dependency-free, so it works before `npm install`) and `dev-gui.mjs` (launches bridge + Vite, optionally the server, and forwards Ctrl+C to every child).                 |
| `docs/`              | This guide and its siblings.                                                                                                                                                           |
| `.github/workflows/` | `ci.yml`: the verify matrix and the coverage job.                                                                                                                                      |

Root configuration files:

| File                                  | Governs                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `package.json`                        | Workspaces, engine floor, every script, all devDependencies                         |
| `tsconfig.base.json`                  | Compiler options every project inherits                                             |
| `tsconfig.json`                       | The solution file: `"files": []` plus project references in build order             |
| `vitest.config.ts`                    | Test environment, include/exclude globs, timeouts, coverage, and the source aliases |
| `eslint.config.mjs`                   | Flat ESLint config, in four layers                                                  |
| `.prettierrc.json`, `.prettierignore` | Formatting                                                                          |
| `.editorconfig`                       | Editor defaults                                                                     |

---

## 3. The build

### npm workspaces and TypeScript project references solve different problems

They are easy to conflate, and keeping them distinct explains most of the build's
behaviour.

- **npm workspaces** handle _installation and linking_. One `npm install` at the root
  produces one lockfile and one `node_modules`, with `node_modules/@socketlens/protocol`
  as a symlink to `packages/protocol`. This is what makes the bare specifier
  `@socketlens/protocol` resolvable by Node, by `tsc`, and by `tsx`.
- **TypeScript project references** handle _compilation_. Each workspace is a separate
  TypeScript program with its own `tsconfig.json`, and a dependent consumes its
  dependency's emitted `.d.ts` files rather than its sources.

Neither knows about the other. npm does not build anything; TypeScript does not install
anything.

### What every project inherits

`tsconfig.base.json` sets, among others:

| Option                                                                                   | Value      | Consequence                                                                                                   |
| ---------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `composite`                                                                              | `true`     | Every project is referenceable, must set `rootDir`, must emit declarations, and gets a `tsconfig.tsbuildinfo` |
| `declaration`, `declarationMap`, `sourceMap`                                             | `true`     | Dependents get types; stack traces and go-to-definition land in `src`                                         |
| `module`, `moduleResolution`                                                             | `NodeNext` | ESM with explicit `.js` specifiers in relative imports, resolved the way Node resolves them                   |
| `verbatimModuleSyntax`, `isolatedModules`                                                | `true`     | Type-only imports must be marked `type`; no cross-file const-enum tricks                                      |
| `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch` | `true`     | Indexing returns `T \| undefined`, hence the `!` assertions in a few hot paths                                |
| `target`, `lib`                                                                          | `ES2022`   | `apps/gui` overrides `lib` to add `DOM`                                                                       |
| `types`                                                                                  | `["node"]` | `apps/gui` overrides this to `["react", "react-dom"]`                                                         |
| `skipLibCheck`                                                                           | `true`     | Third-party declarations are not re-checked                                                                   |

`packages/*` and `apps/{server,cli,bridge}` add only `rootDir: "./src"`, `outDir: "./dist"`,
`include: ["src/**/*.ts"]`, `exclude: ["**/*.test.ts"]`, and their `references`.

`apps/gui/tsconfig.json` is the exception:

```jsonc
{
  "module": "ESNext",
  "moduleResolution": "Bundler", // Vite resolves the imports, not Node
  "jsx": "react-jsx",
  "noEmit": true, // Vite emits the bundle; tsc only checks types
  "types": ["react", "react-dom"],
  "lib": ["ES2022", "DOM", "DOM.Iterable"],
}
```

It has no `references` and no `paths`. Its only build output is
`apps/gui/tsconfig.tsbuildinfo`. This is the source of the second gotcha in §9.

### Why the root `tsconfig.json` is a solution file

```jsonc
{
  "files": [],
  "references": [
    { "path": "./packages/protocol" },
    { "path": "./packages/core" },
    { "path": "./apps/server" },
    { "path": "./apps/cli" },
    { "path": "./apps/bridge" },
    { "path": "./apps/gui" },
  ],
}
```

`"files": []` means the root project compiles nothing itself. It exists only to name the
set of projects that make up the repository, so that `tsc -b tsconfig.json` is a single
entry point for the whole build.

The alternative — one root `tsconfig.json` with `include: ["packages/**", "apps/**"]` —
would compile every workspace into a single program. That would work, and it would also
delete the property the design depends on: with one program, `apps/gui` could import
`apps/server/src/server.ts` and nothing would object. With project references, an
undeclared cross-workspace import fails to compile. The dependency direction described in
[`docs/architecture.md`](./architecture.md) §2.1 is therefore _enforced by the build_
rather than merely documented.

### What `tsc -b` does

`tsc -b` (`--build`) is a build orchestrator rather than a compiler invocation:

1. Reads the solution file and every referenced project, transitively.
2. Topologically sorts them by their declared `references`. Projects with no ordering
   constraint between them are processed in the order they are listed.
3. For each project, compares input timestamps against its outputs and its
   `tsconfig.tsbuildinfo`, and skips it when it is up to date.
4. Compiles the stale ones in order, emitting `.js`, `.js.map`, `.d.ts` and `.d.ts.map`
   into `outDir`.
5. Type-checks each project against its dependencies' **`.d.ts` files**, not their
   sources. A dependency's declaration file is the contract.

Add `--verbose` to see the decision for every project, and `--force` to rebuild
everything regardless of timestamps. Both are useful when a build result surprises you.

### Why build order follows the reference graph

`packages/core` cannot be checked until `packages/protocol/dist/index.d.ts` exists,
because that file _is_ `protocol`'s public type surface as far as `core` is concerned. The
reference graph is:

```
protocol  →  core  →  { server, cli, bridge }
```

so the effective order is `protocol`, `core`, then the three Node apps in any order, and
`apps/gui` last.

`apps/gui` is the one project whose position in the order comes from the root solution
file rather than from a reference: it declares none, yet it imports
`@socketlens/protocol/browser` and `@socketlens/core/models` and therefore needs both
`dist` trees. Listing it last in `references` means that in a single `tsc -b` invocation
its dependencies have already been built. It also means `tsc` has no idea that `gui`
depends on them, which is exactly what §9(b) is about.

Note that `npm run typecheck` runs `tsc -b tsconfig.json` — **the same command** as
`npm run build:ts`, so type checking the workspaces builds them — and then
`tsc -p tsconfig.tests.json`, which type checks `tests/` without emitting. The second pass
exists because `tests/` belongs to none of the six project references, so the composite
build never sees it.

---

## 4. Module resolution across the three toolchains

This is the single most confusing thing in the repository, and it is worth understanding
before you debug anything that looks like a stale-code problem.

`tsconfig.base.json` has **no `paths` and no `baseUrl`.** No `@socketlens/*` alias exists
anywhere in the TypeScript configuration. Aliases exist only in `vitest.config.ts` and
`apps/gui/vite.config.ts`, and they point at TypeScript **sources**. Every other tool
resolves the same specifiers through the workspace symlink and each package's `exports`
field, arriving at **`dist`**.

| Toolchain | Used by                                                     | How `@socketlens/*` resolves                                                           | Resolves to                                       | Needs a prior build?                                                                                                            |
| --------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -b`  | `build:ts`, `typecheck`, and therefore `build` and `verify` | Node resolution through `node_modules/@socketlens/*` → the package's `exports`/`types` | `dist/*.d.ts`                                     | It produces them itself, in reference order. `apps/gui` relies on the solution-file ordering because it declares no references. |
| Vitest    | `test`, `test:watch`, `test:coverage`                       | `resolve.alias` array in `vitest.config.ts`                                            | `packages/*/src/*.ts`, `apps/server/src/index.ts` | **No**                                                                                                                          |
| Vite      | `dev:gui`, `dev`, `build:gui`                               | `resolve.alias` array in `apps/gui/vite.config.ts`                                     | `packages/*/src/*.ts`                             | **No**                                                                                                                          |
| `tsx`     | `dev:server`, `dev:cli`, `dev:bridge`, `examples`           | Node resolution through `main`/`exports` — **no aliases**                              | `dist/*.js`                                       | **Yes**, which is why each of those scripts runs `npm run build:ts` first                                                       |
| `node`    | `start:server`, `start:gui`, `cli`                          | Node resolution, running `dist` directly                                               | `dist/*.js`                                       | **Yes**                                                                                                                         |

### The aliases, exactly

| Specifier                                                  | `vitest.config.ts`                 | `apps/gui/vite.config.ts`          |
| ---------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| `@socketlens/protocol/browser`                             | `packages/protocol/src/browser.ts` | `packages/protocol/src/browser.ts` |
| `@socketlens/protocol`                                     | `packages/protocol/src/index.ts`   | `packages/protocol/src/index.ts`   |
| `@socketlens/core/models`                                  | `packages/core/src/models.ts`      | `packages/core/src/models.ts`      |
| `@socketlens/core`                                         | `packages/core/src/index.ts`       | not aliased                        |
| `@socketlens/server`                                       | `apps/server/src/index.ts`         | not aliased                        |
| `@socketlens/cli`, `@socketlens/bridge`, `@socketlens/gui` | not aliased                        | not aliased                        |

Three consequences follow, and each one has bitten someone:

**Order in the array matters.** Aliases are matched in array order by string prefix, so
`@socketlens/protocol/browser` **must** come before `@socketlens/protocol`, and
`@socketlens/core/models` before `@socketlens/core`. Reverse either pair and the import
silently rewrites to a path like `packages/protocol/src/index.ts/browser`, which does not
exist. Both config files already put the more specific entry first; keep it that way when
adding entries.

**Either `@socketlens/core` specifier works in a test**, since both are aliased and
`tsconfig.tests.json` carries the matching `paths`. `core`'s main entry re-exports
everything in `models.ts`, so the bare specifier is the simpler default. In GUI code the
choice is forced: import `@socketlens/core/models`, because Vite aliases only that specifier
and the GUI must not pull in `core`'s Node-only runtime.

**There is no alias for `cli`, `bridge` or `gui`.** Tests for those must import by relative
path from the repository root, with the `.js` extension the app sources use:

```ts
import { dispatch, isKnownCommand } from '../../apps/cli/src/dispatch.js';
```

That is the established convention in `tests/cli/*.test.ts`; Vitest maps the `.js`
specifier onto the `.ts` file.

Finally: `tsconfig.tests.json` declares `paths` that mirror these aliases, so an import
that resolves under Vitest also type checks. Keep the two in step — **adding a Vitest alias
without the matching `paths` entry gives you an import that runs but does not type check.**
The workspace projects themselves still have no aliases at all; alias behaviour is a
property of the test and dev-server runtimes, never of the compiled output.

---

## 5. Testing

[`docs/test-plan.md`](./test-plan.md) says what is tested and why, level by level. This
section covers how to run it and what the shared machinery gives you.

### Commands

```bash
npm test                        # every suite, once
npm run test:watch              # watch mode
npm run test:coverage           # v8 coverage into ./coverage

npx vitest run tests/protocol   # one directory
npx vitest run tests/server/scenarios.test.ts
npx vitest run -t 'coalesced'   # filter by test name
npx vitest related packages/core/src/matching.ts

npm run examples                # the eleven example scenarios (builds first)
npm run examples -- --only 6    # one of them; note the -- separator npm requires
```

### Configuration that affects how you write tests

| Setting                      | Value                                                               | Why                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`                | `node`                                                              | The subject is `node:net`. There is no jsdom environment configured.                                                                                                    |
| `include`                    | `tests/**/*.test.{ts,tsx}` and `{packages,apps}/**/*.test.{ts,tsx}` | Suites live in `tests/`, but a colocated test file would also be picked up                                                                                              |
| `exclude`                    | `node_modules`, `dist`, `.tsbuild`                                  | Never run the built output                                                                                                                                              |
| `testTimeout`, `hookTimeout` | `20000` ms                                                          | Integration tests bind real ports; a generous ceiling avoids flakes on a loaded machine. It is a ceiling, not a target — the whole suite finishes in about two seconds. |
| `coverage.provider`          | `v8`                                                                | Reporters `text`, `html`, `lcov` into `./coverage`                                                                                                                      |
| `coverage.include`           | `packages/*/src/**/*.ts`, `apps/*/src/**/*.{ts,tsx}`                | Barrel `index.ts` files, `apps/gui/src/main.tsx` and `vite-env.d.ts` are excluded as having nothing to assert                                                           |

Two things to know about the boundary between Vitest and `tsc`:

- The six project references exclude `tests/`, so `tsc -b` alone never sees it. **A separate
  `tsconfig.tests.json` covers the test suite**, and `npm run typecheck` runs both. It uses
  `moduleResolution: "Bundler"` with `paths` mirroring the Vitest aliases, because that is
  how Vitest actually resolves those imports; it is also what lets one project cover both
  the Node-side tests and the `.tsx` component tests. Before it existed, a type error in a
  test surfaced only in your editor, never in CI.
- Every package `tsconfig.json` sets `exclude: ["**/*.test.ts"]`. A test file placed
  beside the code it tests will run under Vitest but will not be compiled into `dist`,
  which is the intended arrangement.

`jsdom` and `@testing-library/react` are installed, but no jsdom environment is configured
and there are no GUI component tests today. To add one, opt in per file:

```ts
// @vitest-environment jsdom
```

### Shared helpers

Three modules under `tests/helpers/`, imported by relative path.

| Module        | Provides                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wire.ts`     | Byte-level construction and delivery. `headerBlock`, `rawMessage` (computes `Content-Length` from UTF-8 bytes), `pingRequest`, `okResponse`; `pushByteByByte` and `pushInChunks(decoder, input, offsets)` for delivering one message in a caller-chosen shape; `expectMessage`, `messagesOf`, `errorsOf` for narrowing decode events. It deliberately bypasses the encoder so tests can build input the encoder would refuse to produce. |
| `harness.ts`  | Real servers. `startHarness(options)` starts an `SltpServer` on **port 0** with a silent logger and returns `{ server, host, port, client(), stop() }`; `client()` connects a real `SltpClient` and registers it for cleanup; `stop()` closes every client then the server. Plus `jsonBody(exchange)`, `createSession(client)` and `addPingRule(client, sessionId)`.                                                                     |
| `fixtures.ts` | Plain-object builders for unit tests: `request`, `response`, `mockRule`, `segment`, `assertion`, `testResult`, and `fields` for building a header list with the exact casing a peer used. Each supplies a plausible default so a test states only the field it is about. `mockRule.sequence` defaults to `1` so a test about tie-breaking has to set it explicitly rather than depend on a hidden counter.                               |

### Integration tests bind port 0

Every test that needs a listener asks the operating system for a port:

- `startHarness` passes `port: 0` to `SltpServer`.
- `SessionStore.createSession` calls `startMockEndpoint`, which calls
  `server.listen(0, '127.0.0.1')`.
- `examples/run-all.ts` starts its own server on an OS-assigned port.

Nothing in the test suite binds a fixed port, so suites never collide with each other,
never collide with parallel runs, and never collide with a server you already have running
on 7420. **Do not introduce a fixed port in a test.** If you need the address, read it
back from the value `listen()` resolved with, as the harness does.

Every helper that opens a resource also closes it. Register servers and clients for
cleanup in `afterEach`/`afterAll`; a leaked listener turns into a hanging worker rather
than a failing assertion.

---

## 6. Code style and linting

### Prettier

`.prettierrc.json`:

| Option                    | Value      |
| ------------------------- | ---------- |
| `printWidth`              | `100`      |
| `singleQuote`             | `true`     |
| `semi`                    | `true`     |
| `trailingComma`           | `all`      |
| `arrowParens`             | `always`   |
| `endOfLine`               | `lf`       |
| `proseWrap` (`*.md` only) | `preserve` |

```bash
npm run format          # prettier --write .
npm run format:check    # prettier --check . — what CI runs
```

`endOfLine: lf` matters on Windows: let Prettier normalise, and configure Git rather than
your editor to fight it. `.prettierignore` excludes `node_modules/`, `dist/`, `.tsbuild/`,
`coverage/`, `*.tsbuildinfo` and `package-lock.json`.

### ESLint

Flat config in `eslint.config.mjs`, composed as four layers:

1. A global `ignores` block: `node_modules`, `dist`, `.tsbuild`, `coverage`, `*.tsbuildinfo`.
2. `js.configs.recommended`, `tseslint.configs.recommended`, then `eslint-config-prettier`
   **last** of the three, so it can switch off the stylistic rules Prettier owns.
3. The project's own rules, with Node globals.
4. Three overrides: `apps/gui/**` adds `eslint-plugin-react-hooks` and browser globals;
   test files relax two rules; `**/*.mjs` uses `disableTypeChecked`.

The rules worth knowing:

| Rule                                         | Setting                                                          | Rationale                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `no-console`                                 | **off**                                                          | Printing protocol traffic is the product. Do not add a logger indirection to satisfy a lint rule that is deliberately disabled. |
| `eqeqeq`                                     | `error`, always                                                  |                                                                                                                                 |
| `prefer-const`, `no-var`                     | `error`                                                          |                                                                                                                                 |
| `object-shorthand`                           | `error`, `properties`                                            |                                                                                                                                 |
| `no-else-return`                             | `error`, `allowElseIf: false`                                    | Keeps the many decision tables in the handlers flat                                                                             |
| `@typescript-eslint/no-unused-vars`          | `error`, with `^_` ignored for args, vars and caught errors      | Prefix an intentionally unused binding with `_`                                                                                 |
| `@typescript-eslint/no-explicit-any`         | `warn`                                                           | Off in tests                                                                                                                    |
| `@typescript-eslint/no-non-null-assertion`   | `warn`                                                           | Off in tests. `noUncheckedIndexedAccess` makes `!` occasionally the honest choice after an explicit bounds check                |
| `@typescript-eslint/consistent-type-imports` | `error`, `prefer: type-imports`, `fixStyle: inline-type-imports` | Hence `import { type SltpRequest }`. `verbatimModuleSyntax` requires the marking; this rule enforces its spelling               |

```bash
npm run lint        # eslint .
npm run lint:fix    # eslint . --fix
```

The config uses `tseslint.configs.recommended`, not the type-checked variants, so linting
needs no type information and no prior build. That keeps `npm run lint` fast, and it means
lint will not catch anything that requires types — that is `typecheck`'s job.

### Conventions the code follows that no tool enforces

- **Relative imports carry the `.js` extension.** `NodeNext` requires it; the file on disk
  is `.ts`.
- **Every exported symbol has a doc comment**, and the comment says _why_ where the name
  does not already say _what_. The framing-critical modules (`decoder.ts`, `relay.ts`,
  `client.ts`) carry file-level comments stating their invariants; if you change one of
  those invariants, change the comment in the same commit.
- **One decoder per connection, always.** This is a correctness requirement, not a style
  preference — see [`docs/architecture.md`](./architecture.md) §5.3.
- **British spelling** in prose and identifiers (`serialise`, `summarise`, `behaviour`).

---

## 7. Adding a new SLTP operation, end to end

The worked path below adds a hypothetical `RESET_SESSION`. Work in this order; each step
depends on the previous one compiling.

### Step 1 — Register it in `packages/protocol/src/operations.ts`

Two edits in one file. Add the token to `SLTP_OPERATION`:

```ts
export const SLTP_OPERATION = {
  // ...
  RESET_SESSION: 'RESET_SESSION',
} as const;
```

and add an entry to `SLTP_OPERATION_REGISTRY`, positioned where the specification
documents it:

```ts
{
  name: 'RESET_SESSION',
  requiresSession: true,
  requiresBody: false,
  allowsBody: false,
  target: 'control',
  successStatuses: [200],
  summary: 'Clears the rules and results of a session without stopping its mock endpoint.',
},
```

Points to get right:

- The token must match `OPERATION_PATTERN` — `/^[A-Z][A-Z0-9_]{0,31}$/`. A token that is
  syntactically valid but unregistered is answered `501 OPERATION NOT SUPPORTED`.
- `requiresBody` and `allowsBody` are independent. `requiresBody: true` with
  `allowsBody: false` is contradictory and would reject every request.
- `target` decides which endpoint accepts it: `control`, `mock-endpoint`, or `both`.
  `controlOperationNames()` is derived from this field.
- `successStatuses` lists the non-error statuses the operation may return. `SERVER_INFO`
  publishes this to clients, so a wrong value is a documentation bug on the wire.
- `summary` is user-facing: it appears in `socketlens help operations`, in `SERVER_INFO`,
  and in the specification.

Nothing else in `protocol` needs changing. Everything downstream reads the registry.

### Step 2 — Validation

`validateRequest` in `packages/protocol/src/validate.ts` is entirely registry-driven and
needs **no edit**. Its five fixed steps — `Request-ID`, operation registration, body
presence, `Session-ID` scope, JSON parsing — read `requiresSession`, `requiresBody` and
`allowsBody` straight from the entry you just added. Adding an operation cannot change the
order in which faults are reported, which is what makes that order documentable.

What validation does _not_ cover is the shape of your body. Protocol-level validation
stops at "this is JSON". Semantic validation belongs in `packages/core/src/validation.ts`,
alongside `validateScenario`, `validateAddRuleInput` and `validateUpdateRuleInput`. Follow
their contract: return every problem at once rather than the first one, as
`{ ok: false, problems: string[] }`, so the client can fix a body in one round trip. The
handler turns that into `422 INVALID SCENARIO`.

Server-state checks — does the session exist, is it closed, is the rule name unique — are
not protocol validation and belong in the store, which reports them as a `StoreFailure`
carrying its own status code.

### Step 3 — The server handler

`apps/server/src/handlers.ts`, one `case` in the `switch` inside `handleOperation`:

```ts
case SLTP_OPERATION.RESET_SESSION: {
  const reset = unwrap(store.resetSession(sessionId!));
  if (!reset.ok) return reset.response;
  return { statusCode: SLTP_STATUS.OK, json: { session: reset.value } };
}
```

The rules of that file:

- A handler is a function of `(request, validated, context)` and returns a
  `HandlerResponse`. It **never touches the socket**; the connection turns the returned
  object into bytes. That is what lets the integration tests drive handlers without
  reasoning about writes.
- Never throw for a client mistake. Reporting a client mistake as a numbered status is the
  point of the protocol. A thrown exception becomes `500 INTERNAL SERVER ERROR` and the
  connection survives, but that is a safety net, not a design.
- `sessionId!` is safe only because `requiresSession: true` made `validateRequest`
  guarantee it. If your operation is not session-scoped, do not write that.
- Use `unwrap` / `fromFailure` for store results and `invalidScenario(problems)` for
  semantic faults, so the response shape matches every other operation.
- Omit `statusPhrase` and let `phraseFor` take the canonical phrase from the registry.

If the operation changes server state, add the method to `SessionStore` in
`packages/core/src/session-store.ts` and return `StoreResult<T>`. If `target` includes
`mock-endpoint`, `packages/core/src/mock-endpoint.ts` is the second place that answers
requests; note that it validates with relaxed options, because the port already identifies
the session and a mock must be able to answer tokens SLTP never registered.

### Step 4 — The CLI

Three files, and all three must agree or the command is unreachable:

| File                       | Edit                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/cli/src/options.ts`  | Add the path to `COMMAND_PATHS` (`['session', 'reset']`). Add any new flag to `KNOWN_FLAGS`, and to `VALUE_FLAGS` if it takes a value — an unknown flag is rejected, deliberately, so a typo cannot silently install a rule matching everything. |
| `apps/cli/src/commands.ts` | Write `commandSessionReset(context)`, returning `0` or `1`. Take the connected `SltpClient` from the context, send the operation, render through `context.renderer`. Commands reach only for the protocol surface, never into server internals.  |
| `apps/cli/src/dispatch.ts` | Map `'session reset'` to the new function in `TABLE`. Both one-shot invocation and the REPL go through this table, so one entry serves both.                                                                                                     |

Then update `apps/cli/src/help.ts`: the relevant section of `USAGE`, the per-command entry
in `COMMAND_HELP`, and `REPL_HELP` if the command is useful interactively. The help text is
treated as a deliverable — a reader who has never seen SLTP should be able to run a
demonstration from it alone.

`socketlens help operations` needs no edit; `printRegistries` prints
`SLTP_OPERATION_REGISTRY` directly.

### Step 5 — The GUI

Usually less work than it looks, because the interface is registry-driven and the bridge is
operation-agnostic:

- **The bridge needs no change.** `POST /bridge/request` takes `{ operation, sessionId,
headers, json, body, timeoutMs }` and passes the operation string to
  `Relay.send`. It never enumerates operations.
- **The scenario editor's operation dropdown needs no change.** It is built from
  `allOperationNames()` out of `@socketlens/protocol/browser`, so a registered operation
  appears there as soon as `packages/protocol` is rebuilt.
- **`apps/gui/src/hooks/useBridge.ts`** is where you add a typed helper, next to
  `createSession`, `closeSession`, `addRule`, `updateRule`, `deleteRule` and `runTest`,
  wrapping the generic request call and narrowing the response body.
- **Components** import types from `@socketlens/core/models` and values from
  `@socketlens/protocol/browser`. Never import `@socketlens/core` or
  `@socketlens/protocol` bare into GUI code: the first pulls in Node-only runtime and the
  second pulls in `Buffer` and the decoder.

### Step 6 — Tests

| Suite                             | What to add                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/protocol/validate.test.ts` | Only if the operation exercises a validation combination not yet covered — a body-forbidden operation sent with a body, a session-scoped operation without `Session-ID`, and so on |
| `tests/server/server.test.ts`     | The real coverage: drive the operation through `startHarness` over a real socket, assert the status code, the phrase, the headers and the body                                     |
| `tests/core/*.test.ts`            | Unit tests for any new store method or validator, including its failure statuses                                                                                                   |
| `tests/cli/options.test.ts`       | That the new command path parses, and that a near-miss flag is rejected with a suggestion                                                                                          |
| `tests/cli/dispatch.test.ts`      | That the path reaches the handler, and which SLTP request the command chose to send. It uses a stub client, so no socket is opened                                                 |
| `tests/cli/help.test.ts`          | Nothing usually — it already asserts that every registry entry appears in the printed registries, which means an unregistered or undocumented operation fails this suite           |

Use `startHarness` rather than a hand-rolled server, and let it assign the port.

### Step 7 — Documentation that must be updated

An operation that is in the registry but not in the documents is a defect, because
`SERVER_INFO`, `--help` and the specification are supposed to agree.

| Document                                                        | What to change                                                                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/protocol-specification.md`](./protocol-specification.md) | §11 Request operations: the operation table and its normative subsection. §12 if it introduces a status. §15 if it affects validation order — it should not |
| [`docs/status-codes.md`](./status-codes.md)                     | The `context` line of every status the operation can return                                                                                                 |
| [`docs/user-guide.md`](./user-guide.md)                         | §3.1 command table, and a walkthrough in §6 if the operation is demonstrable                                                                                |
| [`docs/test-plan.md`](./test-plan.md)                           | The level tables in §2, and §4 if it adds server behaviour worth listing                                                                                    |
| [`docs/requirements.md`](./requirements.md)                     | A new functional requirement, and the §5 traceability table                                                                                                 |
| [`docs/architecture.md`](./architecture.md)                     | Only if a component, a dependency edge or a lifecycle changed                                                                                               |
| `examples/`                                                     | A new numbered example plus a case in `examples/run-all.ts`, if it demonstrates a distinct transport property                                               |

Finish with `npm run verify`.

---

## 8. Adding a new status code, end to end

Suppose `205 SESSION RESET` is needed.

### Step 1 — `packages/protocol/src/status.ts`

Add the numeric constant to `SLTP_STATUS`, and the entry to `SLTP_STATUS_REGISTRY` **in
numeric order**:

```ts
{
  code: 205,
  phrase: 'SESSION RESET',
  category: 'success',
  meaning: 'The rules and results of the session were cleared; its mock endpoint kept listening.',
  context: 'RESET_SESSION only.',
  closesConnection: false,
},
```

Every field is normative, not decoration:

- `phrase` is **part of the protocol**, canonical and uppercase. `statusPhrase(code)`
  returns it, and it is what a peer reads off the wire.
- `category` must agree with the leading digit, because `statusCategory()` derives the same
  answer arithmetically. A 2xx that reports a failed test is still a 2xx —
  `211 TEST FAILED` is the precedent: the SLTP exchange succeeded, the test did not.
- `closesConnection` must match what the server actually does. It is a documented promise
  about connection lifetime.

`statusPhrase` falls back to a generic phrase per class for unregistered codes, so an
unregistered code will not crash a client — it will just be undocumented and unhelpful.
That fallback is a safety net, not a substitute for registering.

### Step 2 — Wire it to a reason, if a fault produces it

Statuses that arise from framing or validation faults are reached through the reason
taxonomy in `packages/protocol/src/errors.ts`, not from a literal at the call site:

1. Add the reason to `SLTP_REASON`.
2. Map it in `statusForReason(reason)`, which is the single place a reason becomes a status
   (currently: the size reasons → 413, `unknownOperation` → 501, `rateLimited` → 429,
   `serverShuttingDown` and `sessionLimitReached` → 503, `invalidBodyShape` → 422,
   everything else → 400).
3. Decide fatality. Membership of `FATAL_REASONS` is what closes the connection, and the
   test is whether the byte stream can still be trusted: a framing fault desynchronises the
   stream, a semantic fault does not. Add to `SIZE_REASONS` only for genuine size limits.

`frameError(reason, message, detail)` then derives `status` and `fatal` automatically.
Do not construct a frame error with a hand-written status.

A purely successful status like `205` needs none of this.

### Step 3 — Emit it

| Where                                | When                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `apps/server/src/handlers.ts`        | The normal case: return it from the operation's `case`                                      |
| `packages/core/src/session-store.ts` | When the store itself decides, as a `StoreFailure` with its `statusCode` and `statusPhrase` |
| `packages/core/src/mock-endpoint.ts` | Only for a status a mock endpoint sends, such as `410 NO MATCHING RULE`                     |

If it is a success status for an operation, add it to that operation's `successStatuses` in
the operation registry, or `SERVER_INFO` will under-report.

### Step 4 — Clients need no change

Both status pickers are registry-driven and update automatically once `packages/protocol`
is rebuilt:

- `socketlens help status` prints `SLTP_STATUS_REGISTRY` through `printRegistries`.
- The GUI rule editor's status dropdown maps over `SLTP_STATUS_REGISTRY` from
  `@socketlens/protocol/browser`, and its phrase placeholder comes from `statusPhrase`.

### Step 5 — Tests

- A server integration test in `tests/server/` asserting the code, the phrase and whether
  the connection stayed open.
- If you added a reason, a `tests/protocol/decoder.test.ts` or `validate.test.ts` case
  asserting the reason, the derived status and its fatality.
- `tests/cli/help.test.ts` already walks the whole registry, so an entry with an empty
  phrase or meaning fails there.

### Step 6 — Documentation

Both documents are normative and both are maintained **by hand**. The header comment in
`status.ts` describes `docs/status-codes.md` as generated from the same information; there
is no generator script in the repository, so "generated" states the intent, and keeping the
two identical is your responsibility.

| Document                                                        | What to change                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/status-codes.md`](./status-codes.md)                     | §2 summary table; a new numbered subsection under §4 in code order, matching the depth of its neighbours (meaning, when it is sent, when it is not, headers, an example exchange); §5 the connection-outcome quick reference |
| [`docs/protocol-specification.md`](./protocol-specification.md) | §12 Response status registry; §16 if a new fault taxonomy entry came with it; §14 if the connection outcome is new                                                                                                           |
| [`docs/architecture.md`](./architecture.md)                     | §6.3, the fault-to-response table, if the connection outcome differs from every existing code                                                                                                                                |
| [`docs/test-plan.md`](./test-plan.md)                           | §3.3 / §3.5 / §4 where the new case belongs                                                                                                                                                                                  |
| [`docs/user-guide.md`](./user-guide.md)                         | Only if a user will encounter the code while following a documented task                                                                                                                                                     |

Then `npm run verify`.

---

## 9. Gotchas

### (a) `tsx` does not use the Vitest or Vite aliases — build first

`tsx` is a TypeScript-aware Node loader, not a bundler. It has no alias table. When source
run under `tsx` imports `@socketlens/core`, resolution goes through the workspace symlink
and `packages/core/package.json`'s `exports` into **`packages/core/dist/index.js`**.

The consequence is quiet and expensive: **running `tsx` against a stale `dist/` executes
old code.** You edit `packages/core/src/matching.ts`, run something with `tsx`, and observe
the behaviour of the previous build. Nothing warns you. There is no error to search for,
because everything resolved successfully — to yesterday's bytes.

This is why the root dev scripts build first:

```json
"dev:server": "npm run build:ts && tsx watch apps/server/src/index.ts",
"dev:cli":    "npm run build:ts && tsx apps/cli/src/index.ts",
"dev:bridge": "npm run build:ts && tsx apps/bridge/src/index.ts",
"examples":   "npm run build:ts && tsx examples/run-all.ts"
```

Note what `tsx watch` does and does not watch: it watches the entry file's own import
graph, which for the server means `apps/server/src/**` and `packages/*/dist/**`. Editing a
file under `packages/core/src/` triggers **no** reload, because that file is not in the
graph. Re-run `npm run dev:server`, or keep a `tsc -b --watch` running beside it.

Vitest and Vite are immune to this, because their aliases point at sources. If a change is
visible under `npm test` but not under a `tsx` script, this is why.

### (b) `apps/gui` type-checks against built declarations, so its errors can lag a rebuild

`apps/gui/tsconfig.json` declares no `references` and no `paths`. It resolves
`@socketlens/protocol/browser` and `@socketlens/core/models` through each package's
`exports` field to **`dist/*.d.ts`** — the built declarations, not the sources Vite serves
at runtime. So the GUI is type-checked against yesterday's types and executed against
today's sources.

`tsc -b`'s own reporting shows the effect. Touch `packages/core/src/models.ts` and ask what
it considers stale:

```
$ npx tsc -b tsconfig.json --verbose --dry
Project 'apps/server/tsconfig.json' is up to date with .d.ts files from its dependencies
Project 'apps/cli/tsconfig.json'    is up to date with .d.ts files from its dependencies
Project 'apps/bridge/tsconfig.json' is up to date with .d.ts files from its dependencies
Project 'apps/gui/tsconfig.json'    is up to date because newest input
  'apps/gui/src/components/SessionPanel.tsx' is older than output 'apps/gui/tsconfig.tsbuildinfo'
```

`server`, `cli` and `bridge` are evaluated against their dependencies' declarations,
because they declare references. `apps/gui` is evaluated against **its own sources only**.
A change in `packages/core` that breaks a GUI component therefore does not necessarily mark
`gui` stale, and `npm run typecheck` can skip it and pass — misleadingly. The error appears
later, on a machine that happened to rebuild, or in CI after a fresh `npm ci`.

When you change a type in `packages/core` or `packages/protocol` and want a trustworthy
answer:

```bash
npx tsc -b tsconfig.json --force     # rebuild and re-check everything
# or
npm run clean && npm run typecheck
```

CI is safe by construction: it starts from a clean checkout, so nothing is ever up to date.
Your working tree is not.

### Other things that surprise people

| Gotcha                                         | Detail                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck` writes output                      | `npm run typecheck` runs `tsc -b tsconfig.json` — identical to `build:ts`, so it writes `dist` and `tsconfig.tsbuildinfo` — and then `tsc -p tsconfig.tests.json`, which does not emit. The workspace half is not a read-only check.                                                                                |
| Alias order in the config arrays               | Aliases match by string prefix in array order. `@socketlens/protocol/browser` must precede `@socketlens/protocol` in both `vitest.config.ts` and `apps/gui/vite.config.ts`.                                                                                                                                         |
| `@socketlens/core/models` in a test            | `vitest.config.ts` aliases it explicitly, above the bare `@socketlens/core` entry, so it resolves to `models.ts`. Without that ordering, prefix matching would rewrite it to `packages/core/src/index.ts/models`.                                                                                                   |
| No aliases for `cli`, `bridge`, `gui`          | Their tests import by relative path with the `.js` extension. Adding an alias for `apps/cli` would work in Vitest and still fail `typecheck`, which has no aliases at all.                                                                                                                                          |
| `tests/` needs its own tsconfig                | The six project references exclude it, so `tsc -b` cannot see it. `tsconfig.tests.json` covers it and `npm run typecheck` runs both. A new directory under `tests/` is picked up automatically; a test placed outside `tests/` is not.                                                                              |
| `apps/gui/.tsbuild/` is vestigial              | The directory may contain `.d.ts` files from an earlier configuration. The current `apps/gui/tsconfig.json` is `noEmit`, and a build does not refresh them. `clean.mjs` removes the directory and both ESLint and Vitest ignore it; nothing reads it.                                                               |
| `apps/gui` does not declare `@socketlens/core` | It imports `@socketlens/core/models` for types only, and resolution succeeds because npm workspaces link every workspace package into the root `node_modules` regardless of who declared it. Convenient here, deliberate here — but it also means a genuinely missing dependency declaration will not fail locally. |
| `npm run examples -- --only 6`                 | npm needs the `--` separator before flags meant for the script. Without it npm consumes them.                                                                                                                                                                                                                       |
| Windows                                        | `scripts/dev-gui.mjs` spawns `npm.cmd` with `shell: true` on `win32`. Keep new scripts platform-neutral, and keep `endOfLine: lf`.                                                                                                                                                                                  |
| Never introduce a fixed port                   | Tests, the session mock endpoints and the examples runner all bind port 0. A hard-coded port collides with a developer's running server and turns CI flaky.                                                                                                                                                         |
| `no-console` is off on purpose                 | Printing bytes is the product. Do not "fix" a console call.                                                                                                                                                                                                                                                         |
| One decoder per connection                     | Sharing a decoder between connections interleaves two byte streams and corrupts both. See [`docs/architecture.md`](./architecture.md) §5.3 before touching any code that owns a socket.                                                                                                                             |

---

## 10. Release checklist

### The `verify` script

```bash
npm run verify
```

which is exactly:

| #   | Step           | Command                      | Fails on                                                          |
| --- | -------------- | ---------------------------- | ----------------------------------------------------------------- |
| 1   | `format:check` | `prettier --check .`         | Any file Prettier would reformat                                  |
| 2   | `lint`         | `eslint .`                   | Any `error`-level rule; warnings do not fail the run              |
| 3   | `typecheck`    | `tsc -b` then `tsc -p tests` | Any type error in `packages/*/src`, `apps/*/src`, **or** `tests/` |
| 4   | `test`         | `vitest run`                 | Any failing test, in any of the six suites under `tests/`         |
| 5   | `build`        | `build:ts` then `build:gui`  | A compile error, or a failing Vite bundle of the interface        |

The chain is `&&`, so it stops at the first failure. Steps 3 and 5 share the same
`tsc -b`, so step 5 is normally near-instantaneous and mostly exercises `vite build`.

### Before tagging a release

```bash
npm run clean          # remove every dist, tsbuildinfo, and coverage directory
npm ci                 # install exactly the lockfile, as CI does
npm run verify         # the full gate, from nothing
npm run examples       # the eleven documented demonstrations, against a real server
npm run test:coverage  # coverage report into ./coverage
```

`npm run clean` before `verify` is not ceremony: it is the only way to be sure that
`apps/gui` was actually type-checked (§9b) and that no `tsx`-driven step read a stale
`dist` (§9a).

Then, by hand:

- Confirm the `version` field in the root `package.json` and in all six workspace
  `package.json` files agrees with the tag. They are all `0.1.0` today and are expected to
  move together.
- Confirm the documents still match the code, in particular the two normative registries:
  `SLTP_OPERATION_REGISTRY` against [`docs/protocol-specification.md`](./protocol-specification.md) §11,
  and `SLTP_STATUS_REGISTRY` against [`docs/status-codes.md`](./status-codes.md) and §12
  of the specification. Nothing enforces this automatically.
- Check `socketlens --help`, `socketlens help operations` and `socketlens help status`
  against [`docs/user-guide.md`](./user-guide.md) §3.1.
- Sanity-check the built artefacts by running them rather than the sources:
  `npm run start:server`, then `npm run cli -- ping`, then `npm run start:gui`.

### What CI enforces

`.github/workflows/ci.yml`, on pushes and pull requests to `main` and on manual dispatch:

| Job        | Runs                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`   | On a matrix of Node **20.x, 22.x and 24.x** with `fail-fast: false`: `npm ci`, then `format:check`, `lint`, `typecheck`, `test`, `build` — the same steps as `npm run verify`, as separate steps so the failing one is obvious in the log |
| `coverage` | On Node 22.x: `npm ci`, `npm run test:coverage`, and uploads `coverage/` as an artefact retained for 7 days                                                                                                                               |

The three-version matrix is the engine floor plus the two newer lines. `npm run examples`
is not part of CI; run it locally before a release.

---

## 11. Related documents

| Document                                                        | Contents                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`docs/requirements.md`](./requirements.md)                     | Functional and non-functional requirements, and the scope of v0.1                        |
| [`docs/architecture.md`](./architecture.md)                     | Component structure, the buffering model, concurrency, and the numbered design decisions |
| [`docs/protocol-specification.md`](./protocol-specification.md) | Normative SLTP/1.0 wire format, operations, statuses, and validation order               |
| [`docs/status-codes.md`](./status-codes.md)                     | The status registry, code by code, with example exchanges                                |
| [`docs/test-plan.md`](./test-plan.md)                           | Test levels, cases, and their mapping to requirement identifiers                         |
| [`docs/user-guide.md`](./user-guide.md)                         | Task-oriented guide to the CLI and the graphical interface                               |
| `examples/README.md`                                            | The eleven runnable examples and what each demonstrates                                  |
