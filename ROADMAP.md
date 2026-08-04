# Roadmap

This document records what SocketLens TCP does today and what is being considered next.

**Everything in the "Not yet implemented" sections below is a plan, not a feature.** None of it exists in the code. Nothing here is a commitment to a date; this is a single-maintainer project and priorities will move in response to real use. Items are listed in rough order of intent, not in order of certainty.

## Where v0.1 stands

Version 0.1.0 is complete and usable for the job it describes: designing, mocking, testing, and debugging custom application-layer protocols over raw TCP streams. It includes the SLTP/1.0 protocol implementation, the incremental stream decoder, the TCP control server with per-session mock endpoints, the command-line client, the React interface with its loopback bridge, the test runner and assertion library, and eleven runnable example scenarios.

Two limits define the shape of this release, and both are deliberate.

**v0.1 is in-memory only.** Sessions, mock rules, and test results live in the server process and nowhere else. Restarting the server discards all of them. The only things written to disk are the CLI's remembered current session and any file you explicitly write with `result export`. There is no database, no state directory, and no automatic recovery.

**v0.1 is loopback only.** The control server, the per-session mock endpoints, and the bridge all bind to `127.0.0.1` by default, and scenario targets are restricted to loopback unless a development host is named explicitly with `--allow-target`. There is no authentication, because there is nothing to authenticate against on a single developer's machine. The tool must not be exposed to an untrusted network; see [SECURITY.md](SECURITY.md).

Everything below is written against those two facts.

## Near term

Small, contained work that fits the current architecture. Not yet implemented.

### Persistence of sessions and results

The most frequently limiting property of v0.1 is that a server restart loses everything. The intent is an opt-in, file-backed store — most likely newline-delimited JSON or SQLite — so that sessions, rules, and results survive a restart, and so a result captured on Monday can still be read on Tuesday.

The in-memory path stays the default. A developer trying the tool for ten minutes should not acquire a state directory as a side effect. Open questions: what the retention policy for raw byte captures should be, given that results carry the full bytes sent and received, and whether persisted results should be addressable across sessions.

### Richer scenario import and export

The `socketlens-scenario-bundle/1` format already carries rules and scenarios together and validates them with all problems reported at once. What it does not yet do is travel well between projects. Under consideration: importing a bundle without a running session, merging bundles, exporting a session's current rules back out as a bundle, and a stable identifier scheme so bundles can be version-controlled and diffed usefully.

Any change here will be a new format version. `socketlens-scenario-bundle/1` will keep parsing.

### Documentation of the wire format as a specification

The operation and status registries in `packages/protocol` are already the normative source, and [`docs/status-codes.md`](docs/status-codes.md) documents the status registry in full. That document is currently maintained by hand, which is exactly the drift risk the project warns about elsewhere: nothing mechanically enforces that it matches `SLTP_STATUS_REGISTRY`. Generating it from the registry instead, and extending the generator to the operation registry and the header set, would give SLTP a specification document that is checked rather than maintained by hand — consistent with the rule that documentation and implementation must agree.

### Interface parity with the CLI

The CLI is the primary client and is deliberately complete on its own. The React interface covers the common paths but not every command. Closing that gap, particularly around result inspection and raw byte views, is ongoing work rather than a single feature.

## Longer term

Larger changes that would alter the architecture or the threat model. Not yet implemented, and each would need a design discussion before any code.

### Authentication

Required before the tool could sensibly be reachable from anywhere other than loopback, and a precondition for any shared or team-facing use. A shared token passed in an SLTP header is the obvious minimum; anything more would need a considered design.

This is explicitly a change of the security model described in [SECURITY.md](SECURITY.md), not an addition to it. Until it exists, the loopback-only guidance stands without exception, and adding authentication would not by itself make exposure to an untrusted network advisable.

### Additional transports: UDP and QUIC

SLTP is defined over a reliable, ordered byte stream, and its framing — a `\r\n\r\n` delimiter plus an explicit `Content-Length` — exists precisely because TCP does not preserve message boundaries. UDP preserves datagram boundaries but guarantees neither ordering nor delivery, so it does not need that framing and cannot rely on the assumptions built around it. QUIC provides streams with different multiplexing and loss semantics again.

Supporting either means deciding what SLTP means on a transport with different guarantees, not merely swapping `node:net` for another module. The likely shape is a transport abstraction beneath the protocol layer, with the framing rules stated per transport.

This does not weaken the constraint that matters: **SLTP over TCP stays on raw TCP.** Adding a datagram or QUIC transport would never mean putting the TCP protocol path behind HTTP, WebSocket, or an RPC framework. See the hard constraints in [CONTRIBUTING.md](CONTRIBUTING.md).

### Protocol-grammar plugins

Today the tool tests SLTP, and SLTP is defined by this repository. The more general version of the idea is to let a developer describe _their own_ protocol's grammar — its framing rule, whether length-prefixed, delimiter-terminated, or fixed-header — and have SocketLens TCP decode, display, mock, and assert against it with the same raw-byte fidelity.

This is the most interesting direction available and also the largest. It would require separating the framing engine from SLTP-specific knowledge, defining a plugin contract, and deciding how much of a grammar can be declared as data before code becomes necessary. No design exists yet.

### Editor integrations

Running a scenario and reading its result without leaving the editor. A Visual Studio Code extension is the obvious first target. This depends on nothing else on this list, but it is worth less than the items above until the underlying capabilities are settled, and an extension shipped early would constrain them.

## Not planned

Stated so that the boundaries are clear.

- **Network scanning, exploitation, credential interception, packet sniffing, and denial-of-service or load-generation features.** These are permanently out of scope. See [SECURITY.md](SECURITY.md).
- **Hosting SocketLens TCP as a service.** It is a local developer tool.
- **An HTTP, WebSocket, or RPC framework for the protocol layer.** The bridge's small loopback HTTP surface exists only so a browser can reach the process that owns the TCP socket, and it will not become the primary client-server path.
- **Making the graphical interface mandatory.** The CLI must remain fully functional with the interface and bridge absent.

## Contributing to the roadmap

If one of these items matters to your work, say so in an issue — real use cases are what move things up this list. If you intend to implement one, open an issue first so the design can be discussed before you write code. The larger items, particularly protocol-grammar plugins and additional transports, will need agreement on the design before an implementation could be reviewed.
