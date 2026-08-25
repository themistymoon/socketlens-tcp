# SocketLens TCP — User Guide

Version 0.1.2. This guide is for someone **using** SocketLens TCP. It covers installing and
building, running the server, driving it from the command line, opening the graphical
interface, and working through the six demonstrations the tool exists to make visible.

SocketLens TCP speaks **SLTP — SocketLens Testing Protocol, version 1.0** — over **raw TCP**
using `node:net`. SLTP is not HTTP and is not layered on HTTP. Its status codes are its own;
the numeric ranges are deliberately familiar because familiarity aids debugging, but a code
such as `211 TEST FAILED` has no HTTP counterpart. See
[`docs/status-codes.md`](./status-codes.md) for the registry and
[`docs/protocol-specification.md`](./protocol-specification.md) for the wire format.

---

## 1. Installing and building

Node.js **20.11.0 or later** is required. There is nothing else to install: the protocol,
core, server, CLI and bridge packages have zero runtime dependencies, and React is used only
by the graphical interface.

```bash
git clone https://github.com/themistymoon/socketlens-tcp.git
cd socketlens-tcp
npm ci
npm run build
```

`npm run build` runs two stages:

| Script              | What it does                                                                            |
| ------------------- | --------------------------------------------------------------------------------------- |
| `npm run build:ts`  | `tsc -b tsconfig.json` — compiles every TypeScript workspace through project references |
| `npm run build:gui` | `vite build` in `apps/gui` — bundles the React interface into `apps/gui/dist`           |

To check the toolchain end to end before relying on it:

```bash
npm run verify
```

That chains formatting checks, linting, type checking, the test suite, and the build. To
remove all build output:

```bash
npm run clean
```

---

## 2. Starting the server

The control server listens on TCP **127.0.0.1:7420** by default.

```bash
npm run start:server
```

That runs the built server (`node apps/server/dist/index.js`), so it requires a prior
`npm run build`. During development, use the script that rebuilds first and then watches:

```bash
npm run dev:server
```

The server binds loopback only and prints a line per connection. Press **Ctrl+C** to stop
it; a second Ctrl+C exits immediately. Shutdown closes every session's mock endpoint, so
nothing is left listening.

Server options, from `socketlens-server --help`:

| Option                  | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `-H, --host <address>`  | Interface to bind (default `127.0.0.1`)                                          |
| `-p, --port <number>`   | TCP port (default `7420`); `0` asks the operating system for one                 |
| `-v, --verbose`         | Print every raw SLTP message as well as the summary line                         |
| `-q, --quiet`           | Print nothing                                                                    |
| `--max-connections <n>` | Simultaneous control connections (default 64)                                    |
| `--allow-target <host>` | Permit scenarios to target this development host as well as loopback; repeatable |
| `--no-rate-limit`       | Disable the per-connection request rate limit                                    |
| `-h, --help`            | Show help                                                                        |
| `--version`             | Print the product version                                                        |

To pass options through npm, use the `--` separator:

```bash
npm run start:server -- --port 7500 --verbose
```

There is no HTTP interface on the server. Connect with the CLI, with the graphical
interface's bridge, or with any tool that can write bytes to a TCP socket.

---

## 3. Using the command line

The CLI is the primary client and is fully functional without the graphical interface. It
opens a raw TCP socket to the server and speaks SLTP directly — no bridge, no intermediate
process.

Run it through npm against the built output:

```bash
npm run cli -- ping
```

or, during development, against the sources (this rebuilds first):

```bash
npm run dev:cli -- ping
```

Everything after `--` is passed to the CLI. If you prefer to type `socketlens` directly,
`npm link` in `apps/cli` installs the `socketlens` binary; this guide writes `socketlens
<command>` for readability, which is equivalent to `npm run cli -- <command>`.

### 3.1 Commands

These are the commands the CLI documents in its own `--help`.

**Connectivity**

| Command | What it does                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| `ping`  | `PING` the server; prints status, phrase, uptime. `--echo <value>` proves the body round-tripped                  |
| `info`  | `SERVER_INFO`: protocol version, configured limits, capabilities, operation and status registries, current counts |
| `raw`   | Write uncorrelated bytes; shows how the server answers malformed input                                            |

**Sessions**

| Command                | What it does                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session create`       | `CREATE_SESSION`; starts a dedicated TCP mock endpoint on an ephemeral port. The new session becomes the default                                       |
| `session list`         | `LIST_SESSIONS`, with each session's mock endpoint address and counts                                                                                  |
| `session show [<id>]`  | `GET_SESSION`, including the mock endpoint address. Defaults to the remembered session                                                                 |
| `session use <id>`     | Verifies the session exists, then remembers it as the default                                                                                          |
| `session close [<id>]` | `CLOSE_SESSION`; stops the mock endpoint. Stored results stay readable; further session-scoped operations are refused with `405 OPERATION NOT ALLOWED` |

**Mock rules**

| Command                | What it does                      |
| ---------------------- | --------------------------------- |
| `rule add`             | `ADD_RULE`                        |
| `rule list`            | `LIST_RULES`, in evaluation order |
| `rule update <ruleId>` | `UPDATE_RULE`                     |
| `rule delete <ruleId>` | `DELETE_RULE`                     |

**Tests**

| Command                      | What it does                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `run [<file.json>]`          | `RUN_TEST` for each scenario in a bundle, or an ad-hoc scenario built from flags                         |
| `scenario show <file.json>`  | Validate and describe a scenario file without running it. Every problem is reported at once              |
| `result list`                | `LIST_RESULTS`, with pass and fail counts                                                                |
| `result show <resultId>`     | `GET_RESULT`, with assertions and the wire writes and reads. Exits non-zero when the result is a failure |
| `result export --out <file>` | Write every stored result to JSON                                                                        |

**Reference and interactive**

| Command           | What it does                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| `help operations` | Print both SLTP registries, operations then status codes                    |
| `help status`     | The same output; one function prints both registries                        |
| `repl`            | Interactive mode; one TCP connection is opened and reused for every command |

### 3.2 Global options

| Option               | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| `-h, --host <host>`  | Server host (default `127.0.0.1`)                    |
| `-p, --port <port>`  | Server port (default `7420`)                         |
| `--timeout <ms>`     | Response timeout (default `5000`)                    |
| `-s, --session <id>` | Act on this session, ignoring the remembered one     |
| `--raw`              | Print the exact bytes of every message               |
| `-v, --verbose`      | Print full protocol traffic                          |
| `-q, --quiet`        | Print no protocol traffic                            |
| `--json`             | Machine-readable output                              |
| `--no-color`         | Disable ANSI colour                                  |
| `--help`             | Show help; after a command, show that command's help |
| `-V, --version`      | Print the version                                    |

`-h` alone means help; `-h 127.0.0.1` sets the host. An unrecognised flag is rejected with
a suggestion of the nearest valid one rather than silently ignored, so a typo cannot quietly
become a different command.

### 3.3 Environment variables

| Variable                             | Effect                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `SOCKETLENS_HOST`, `SOCKETLENS_PORT` | Default server address; a flag takes precedence                                 |
| `SOCKETLENS_STATE_FILE`              | Where the remembered session is stored (default `~/.socketlens/cli-state.json`) |
| `NO_COLOR`                           | Disable colour                                                                  |

Each CLI invocation is a separate process with a separate TCP connection, but a session
lives on the server across invocations. The remembered session identifier is what lets
`socketlens rule add` follow `socketlens session create` without copying an identifier by
hand.

### 3.4 A first run

With the server running in another terminal:

```bash
socketlens ping --raw
socketlens session create --name demo
socketlens rule add --name pong --operation PING --status 200 --body '{"reply":"pong"}'
socketlens rule list
socketlens run --operation PING --expect-status 200 --raw
socketlens result list
```

`--raw` on `ping` prints the exact bytes in both directions with CRLF made visible. This is
the fastest way to see that SLTP is a text protocol with a `\r\n\r\n` header delimiter and a
`Content-Length`, carried on a plain socket.

### 3.5 Interactive mode

```bash
socketlens repl
```

The prompt opens **one** TCP connection and reuses it for every command. That is what makes
`Request-ID` correlation observable: several requests may be in flight on the same
connection at once, and responses are matched by identifier rather than by arrival order.

Inside the prompt, type any command without the `socketlens` prefix. In addition:

| Input                | Effect                                    |
| -------------------- | ----------------------------------------- |
| `raw on` / `raw off` | Toggle printing of exact message bytes    |
| `verbose` / `quiet`  | Change protocol logging verbosity         |
| `session`            | Show the currently selected session       |
| `help [command]`     | The command list, or help for one command |
| `exit` / `quit`      | Disconnect and leave                      |

---

## 4. Starting the graphical interface

A browser **cannot open a raw TCP socket**. That is not a limitation of this tool; it is
what the browser sandbox permits. So `apps/bridge` runs as a local process, holds the real
`node:net` connection to the SLTP server, and exposes a minimal loopback HTTP surface under
`/bridge/*` plus a Server-Sent Events stream at `/bridge/events` that pushes every wire event
to the page.

The HTTP surface carries commands _about_ SLTP. **SLTP framing never travels over it.** The
SLTP conversation is raw TCP between the bridge and the server.

```
browser  ──local HTTP /bridge/* + SSE──▶  bridge  ──raw TCP (SLTP)──▶  server
```

### 4.1 Development

One command starts the server, the bridge, and the Vite dev server together:

```bash
npm run dev
```

That runs `scripts/dev-gui.mjs --with-server`, which starts the SLTP server on
`tcp://127.0.0.1:7420`, the bridge on `http://127.0.0.1:7801`, and Vite for the React
interface. Ctrl+C stops all three. If you already have a server running, use `npm run
dev:gui`, which starts only the bridge and Vite.

Open the URL Vite prints (port 5173 by default). Vite proxies `/bridge/*` to the bridge, so
the page and the bridge appear same-origin to the browser.

### 4.2 Production build

```bash
npm run build
npm run start:gui
```

`start:gui` runs the bridge with `--static apps/gui/dist --open`, so the bridge serves the
built interface itself and opens your browser. No Vite process is involved.

Bridge options, from `socketlens-bridge --help`:

| Option                          | Meaning                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `--host <address>`              | Loopback interface to bind (default `127.0.0.1`)         |
| `--port <number>`               | Port for the HTTP relay (default `7801`)                 |
| `--server-host <addr>`          | SLTP control server host (default `127.0.0.1`)           |
| `--server-port <n>`             | SLTP control server port (default `7420`)                |
| `--timeout <ms>`                | Default SLTP response timeout (default `5000`)           |
| `--static <dir>`                | Serve the built React interface from this directory      |
| `--open`                        | Open the interface in the default browser once listening |
| `--no-connect`                  | Do not open the TCP socket until the interface asks      |
| `-v, --verbose` / `-q, --quiet` | Logging level                                            |
| `-h, --help` / `--version`      | Help and version                                         |

The bridge **refuses a non-loopback `--host`** outright rather than warning about it, and
refuses cross-origin requests. It relays onto an unauthenticated TCP socket, so it must not
be reachable from the network or drivable by a hostile page in your browser.

---

## 5. A tour of the interface

The layout is three columns: controls on the left, work in the centre, evidence on the
right.

### 5.1 Connection (left, top)

Reports the bridge's view of the TCP socket: connected or not, the server address, the
connection identifier, and how many requests have been sent. **Connect** and **Disconnect**
act on the bridge's socket, not on anything the page holds — so reloading the tab shows a
connection that is genuinely still open, because the bridge never dropped it.

### 5.2 Sessions (left)

Lists every session with its identifier, its **mock endpoint address**, its rule and result
counts, and its state. **New session** sends `CREATE_SESSION`; the server starts a dedicated
TCP listener on an OS-assigned ephemeral port before announcing the session, so the address
shown is a real listener you could connect to yourself with `nc` or `telnet`.

Selecting a session makes it the target for rules and scenarios. **Close** stops its mock
endpoint; stored results remain readable.

### 5.3 Mock rules (left)

The rules of the selected session, in the order the matcher evaluates them: **priority
descending, then insertion order ascending**. Each entry shows the match, the response
status, the rule identifier, how many times it has fired, and any delay, fragmentation or
deliberate cut-off it applies. Rules can be edited, enabled, disabled, or deleted in place.

With no rules, the mock endpoint answers `410 NO MATCHING RULE`. That is itself worth
demonstrating: it reports an unconfigured mock, not a missing session.

### 5.4 Scenario editor (centre, top)

Where a test is described. Three groups:

**Request** — an operation token with headers and a body, or, with the checkbox, **raw
bytes**. The raw mode is the only way to send something the encoder refuses to produce: a
bad `Content-Length`, a truncated header block. `\r\n` in the raw field becomes a real CR LF
pair.

**Transmission** — how the bytes reach the wire:

| Mode         | Behaviour                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `single`     | One write carrying the whole message                                                                |
| `fragmented` | Several writes, by explicit sizes or by a requested part count, with an optional pause between them |
| `coalesced`  | Two complete messages written back to back in one call                                              |

There is also **cut the connection after N bytes**, which closes the socket mid-message.

**Expected result** — a status code, phrase, headers, or a body substring; or the checkbox
for **expect a timeout** or **expect a mid-message disconnect**. Those two are mutually
exclusive with the content assertions, because when a timeout or disconnect is the expected
outcome, no complete response arrives to assert about.

### 5.5 Message timeline (centre, lower)

Every SLTP message that crossed the wire, in order, newest at the bottom. `→` is this
process writing; `←` is the server answering — the same headings the CLI and server logs
use.

The critical detail: **each entry is one complete SLTP message as the shared decoder framed
it — not one TCP segment and not one `write()`.** Several timeline entries can come from a
single write, and a single entry can be assembled from many. Each row shows the timestamp,
connection identifier, byte count, and the `Request-ID` and `Session-ID` when present.

### 5.6 Message inspector (right, lower)

Click a timeline entry to inspect it: direction, timestamp, connection, byte count, the
start line, a header table in wire order, the pretty-printed body, and the **raw bytes**
with `↵` marking each CR LF pair.

Showing both the parsed view and the raw view is deliberate — it lets you check the declared
`Content-Length` against the actual body rather than take it on trust. When a body contains
multibyte UTF-8, the inspector says so explicitly: _"N character(s) but M byte(s) — this body
contains multibyte UTF-8, which is exactly why `Content-Length` counts bytes."_

### 5.7 Result view (right, top)

Expected versus actual for the most recent run. A **PASS** or **FAIL** badge, then:

| Field        | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| Outcome      | `passed`, `failed`, `timeout`, or `error`, with a one-line explanation   |
| Duration     | Wall-clock time of the exchange                                          |
| Writes out   | Number of `socket.write()` calls, and the total bytes they carried       |
| Reads in     | Number of inbound reads (`data` events) **→** number of framed responses |
| Matched rule | Which rule produced the response                                         |
| Status       | The response's code and phrase                                           |

Then an **assertions table** — field, expected, actual, one row per assertion, marked ✓ or
✗ — and a **wire writes and reads** list showing each individual write and read with its
offset in milliseconds and its bytes.

That list is the part to point at during a demonstration. Message boundaries do not
line up with segment boundaries, and this is where you can see it.

Earlier runs in the session are listed below and can be reloaded.

---

## 6. Worked walkthroughs

Six demonstrations. Each has a matching example under `examples/`, so you can run it either
way. To run the packaged form of any of them:

```bash
npm run examples -- --only <n>
```

Or drive the bundle through the CLI, which installs the bundle's rules into the current
session before executing its scenarios:

```bash
npm run start:server                                            # terminal 1
socketlens session create --name demo                           # terminal 2
socketlens run --file examples/06-coalesced-messages/bundle.json --raw
```

### 6.1 A passing test

**Example 03.** A mock returns a JSON body of 20 characters that occupies 32 bytes.

```bash
socketlens session create --name passing
socketlens rule add --name ok --operation PING --status 200 --body '{"reply":"pong"}'
socketlens run --operation PING --expect-status 200 --raw
```

**What to look for.** The CLI prints `PASSED`, the assertion table shows expected and actual
matching, and the segment list shows the exchange. In the interface, the result panel shows
a green **PASS**, every assertion row is ✓, and the control response is `210 TEST PASSED`.

**What it proves about TCP.** On its own, not much — and that is the point of starting here.
It establishes the baseline: a request went out, a response came back, and the framing was
correct. Everything that follows is a departure from this baseline. In the packaged example,
the inspector additionally shows a 20-character body declared as 32 bytes, which is the first
hint that framing is a matter of bytes rather than characters.

### 6.2 A failing test, expected versus actual

**Example 04.** The scenario expects `200 OK`; the mock is configured to answer
`500 INTERNAL SERVER ERROR`.

```bash
npm run examples -- --only 4
```

or through the CLI:

```bash
socketlens run --file examples/04-failing-test/bundle.json
```

**What to look for.** Two assertions fail — `statusCode` and `statusPhrase` — and each shows
its expected and actual value side by side. The control response is **`211 TEST FAILED`**,
which is a **2xx** code. The CLI exits non-zero.

**Why `211` is a 2xx.** The SLTP exchange itself succeeded perfectly: a well-formed request
went out, a well-formed response came back, and the server correctly evaluated the
assertions. What failed was the _test_, not the _protocol_. Conflating the two would make it
impossible to distinguish "your mock returned the wrong status" from "your message could not
be framed". Compare `408 TEST TIMEOUT`, a 4xx, in §6.6.

### 6.3 A deliberately fragmented message

**Example 05.** One 134-byte request written as **seven** separate TCP writes of sizes
6, 14, 18, 22, 47, 13, 14, with a 25 ms pause between them. The cuts land inside the start
line, inside a header, and inside the body.

```bash
npm run examples -- --only 5
```

Ad hoc from the CLI:

```bash
socketlens run --operation PING --fragment 12,8,40 --raw
```

In the interface: set **Transmission → fragmented**, enter fragment sizes such as
`6, 14, 18, 22`, and run.

**What to look for.** The result panel reports **7 write(s)** under "Writes out". The TCP
segments list shows seven `→` entries, each with its own offset in milliseconds and its own
partial bytes — you can see a header cut in half across two entries. The **timeline**,
however, shows **one** outbound message. And the rule that fired matches on _body content_,
which could only have happened if the peer reassembled all seven fragments into one message
before matching.

The bundle also contains a `byte-at-a-time` variant that writes the same request in 134
separate writes, one byte each.

**What it proves about TCP.** A message boundary is not a write boundary. The sender chose
seven writes; the receiver saw one message. Any parser that assumes a read contains a whole
message — or even a whole line — is wrong, and the byte-at-a-time variant is the case that
breaks it fastest.

### 6.4 Two coalesced messages

**Example 06.** Two complete SLTP requests concatenated into one buffer and written **once**.
Two different rules match them, on body content.

```bash
npm run examples -- --only 6
```

In the interface: set **Transmission → coalesced**, fill in the second operation and body,
and run.

**What to look for.** The result panel reports **1 write** under "Writes out" and, under
"Reads in", _N_ read(s) **→ 2** framed response(s). The timeline shows **two** inbound
messages. The CLI result view calls this out explicitly, noting how many SLTP responses were
framed from how many reads.

**What it proves about TCP.** This is the exact inverse of §6.3, and together they are the
whole argument. One write produced two messages; seven writes produced one. **Nothing at the
socket layer can distinguish these cases, because at that layer there is nothing to
distinguish.** TCP guarantees a reliable, ordered byte stream and nothing more. Every
protocol built on it must define its own framing — SLTP uses the `\r\n\r\n` delimiter plus an
explicit `Content-Length`, and the peer here split the two messages on `Content-Length`
alone.

If you read only two examples in this repository, read 05 and 06.

### 6.5 A delayed response

**Example 07.** A rule that waits 400 ms before writing, against a scenario whose timeout is
comfortably longer.

```bash
npm run examples -- --only 7
```

From the CLI, add the delay to the rule rather than the scenario:

```bash
socketlens rule add --name slow --operation PING --status 200 --delay 400 --body '{"late":true}'
socketlens run --operation PING --expect-status 200
```

**What to look for.** The test **passes**. The result panel's Duration shows at least 400 ms,
and in the TCP segments list the inbound `←` entry carries a `+400 ms`-ish offset while the
outbound `→` entry sits near zero. The gap is visible in the segment timings.

**What it proves about TCP.** Latency is not failure. A slow peer is still a correct peer,
and the timing data is recorded per segment so you can tell "the network was slow" from "the
peer sent the wrong thing". This also sets up the contrast with the next case: the only
difference between a delay and a timeout is which side of the deadline the response lands
on.

### 6.6 A timeout

**Example 08.** A rule that waits 2500 ms, against a scenario that allows only 500 ms — and
which declares **`expect.timeout`**, making the timeout the _passing_ outcome.

```bash
npm run examples -- --only 8
```

In the interface: tick **Expect a timeout**, set the scenario timeout below the rule's delay,
and run.

**What to look for.** The result is **PASS** with outcome `timeout`, and the note reads _"No
complete response arrived before the deadline."_ The control response is `210 TEST PASSED`.
The duration is around the scenario's timeout, not the rule's delay — the client gave up on
schedule rather than waiting for the mock. No response appears in the timeline, because none
arrived.

Now remove the `expect.timeout` assertion and run it again. The same wire behaviour now
yields **`408 TEST TIMEOUT`**, a 4xx, and the test fails.

**What it proves about TCP.** An absence of bytes is information. TCP will not tell you the
peer is never going to answer — the connection is perfectly healthy, simply idle — so a
client must impose its own deadline and decide what a missed deadline means. Whether that is
a pass or a failure is the _test author's_ decision, not the protocol's, which is why the
same wire behaviour maps to `210` or to `408` depending on what was asserted.

---

## 7. Demonstrating malformed input

Two further cases are worth running, because they show what happens when framing information
is unusable rather than merely unexpected.

Write bytes directly, with no encoding and no `Request-ID` correlation:

```bash
socketlens raw --text 'SLTP/1.0 PING\r\nContent-Length: -5\r\n\r\n'
```

`raw` converts the `\r`, `\n` and `\t` escapes into real control characters, because a shell
cannot easily produce a carriage return. It then prints whatever arrives within the window
(1000 ms by default; `--timeout <ms>` to change it).

**What to look for.** The server answers `400 BAD REQUEST` with a `Reason` header naming the
specific fault — `negative-content-length`, distinct from a merely malformed one — and then
**closes the connection**, sending `Connection: close` first. Example 09 covers three
variants: non-numeric, negative, and duplicate `Content-Length`.

**Why the connection closes.** A negative or ambiguous length means the decoder cannot know
where this message ends, so it cannot know where the next one begins. The byte stream can no
longer be resynchronised at a message boundary. Guessing would risk interpreting the tail of
one message as the head of another, so the connection is closed instead. Contrast an
unregistered operation, which yields `501 OPERATION NOT SUPPORTED` and leaves the connection
**open**: that fault is semantic, the framing was fine, and the stream is still trustworthy.

Example 10 covers the other half of this: a peer that disconnects part-way through a
message, in both directions. The retained partial bytes are reported as a truncated message
rather than discarded silently or parsed as though complete.

---

## 8. Where to go next

| Document                                                        | For                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| [`docs/protocol-specification.md`](./protocol-specification.md) | The normative SLTP wire format                       |
| [`docs/status-codes.md`](./status-codes.md)                     | Every status code, its meaning, and when it is sent  |
| [`docs/protocol-examples.md`](./protocol-examples.md)           | Byte-level worked examples                           |
| [`docs/architecture.md`](./architecture.md)                     | How the pieces fit together and why                  |
| [`docs/requirements.md`](./requirements.md)                     | What the tool does and deliberately does not do      |
| [`docs/developer-guide.md`](./developer-guide.md)               | Contributing, and adding an operation or status code |
| [`examples/README.md`](../examples/README.md)                   | All eleven examples with a suggested reading order   |
