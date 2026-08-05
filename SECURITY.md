# Security Policy

## Supported versions

SocketLens TCP is at version 0.1.1. Only the current release line receives security fixes.

| Version | Supported       |
| ------- | --------------- |
| 0.1.x   | Yes             |
| < 0.1   | No such release |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability, and do not disclose it publicly before it has been addressed.

Report it privately using GitHub's private vulnerability reporting, under the repository's **Security** tab, via **Report a vulnerability**. If that is unavailable to you, contact the maintainer through the address associated with the commits in this repository's history.

Include as much of the following as you can:

- The version or commit you tested.
- Your Node.js version and operating system.
- How the affected component was started, including every command-line flag. Whether `--no-rate-limit`, `--allow-target`, or a non-loopback `--host` was in use is frequently decisive.
- The exact bytes of the exchange that triggers the issue, with `\r\n` written out explicitly, as described in [CONTRIBUTING.md](CONTRIBUTING.md).
- A minimal reproduction, ideally a scenario bundle.
- Your assessment of the impact.

You can expect an acknowledgement within 7 days and an assessment within 30 days. Fixes are released as soon as a correct one is available. If you would like credit in the release notes, say so in your report.

## Scope

Understanding what this project is determines what counts as a vulnerability in it.

**SocketLens TCP is a local developer tool.** It is intended to run on a developer's own machine, alongside the endpoints being developed. It is not a service, not a hosted product, and not intended for deployment.

- **It binds to loopback by default.** The control server, the per-session mock endpoints, and the interface bridge all default to `127.0.0.1`. The default configuration is not reachable from any other machine.
- **It has no authentication and no user accounts, by design, in v0.1.** There are no credentials, no sessions in the security sense, no authorisation checks, and no multi-tenancy. Any process that can open a TCP connection to the control port has full control of the server. This is a deliberate consequence of the loopback-only, single-developer scope, and it is documented rather than accidental. See [ROADMAP.md](ROADMAP.md), where authentication is listed as future work that is not yet implemented.
- **It must not be exposed to an untrusted network.** Binding to `0.0.0.0`, to a routable interface, or forwarding the port through a tunnel or reverse proxy hands unauthenticated control of the process to anyone who can reach it. The `--host` flag makes this possible because some development workflows require it, for example reaching the tool from a container or a virtual machine on a trusted local network. Doing so is the operator's decision and the operator's responsibility. Do not do it on a network you do not control.

Because there is no authentication in v0.1, the following are **outside the scope** of this policy and will be closed as working as documented:

- Unauthenticated access to a server that has been deliberately bound to a non-loopback address.
- Absence of transport encryption. SLTP is plaintext over TCP on loopback.
- Any issue reachable only by an attacker who already has local code execution or an account on the machine. Such an attacker already has everything the tool has.

## What this tool does not do

SocketLens TCP tests **your own local endpoints and development endpoints you have explicitly configured**, and nothing else. This is enforced, not merely stated: scenario targets are restricted to loopback by default, and any other host must be named explicitly with a repeatable `--allow-target` flag when the server is started.

The project contains no functionality for, and will not accept contributions adding:

- **Network scanning** — host discovery, port scanning, or service enumeration of any kind.
- **Exploitation** — vulnerability probing, payload delivery, or any attempt to compromise a remote system.
- **Credential interception** — capture, storage, replay, or cracking of credentials, tokens, or keys.
- **Packet sniffing** — promiscuous capture of traffic. The tool observes only the byte streams on sockets it has itself opened or accepted, which is what makes its raw-bytes view of a connection legitimate.
- **Denial of service** — traffic flooding, amplification, resource exhaustion of a third party, or any load-generation feature aimed at a system you do not own.

It is a protocol design and debugging tool. The raw-byte visibility it provides exists so that a developer can see exactly how their own protocol is framed on the wire.

## Resource limits

The tool bounds its own resource use, which matters on a byte stream where a peer may never send a terminating delimiter:

- **A per-connection request rate limit**, implemented as a token bucket, defaulting to a burst of 120 requests and a sustained 60 requests per second. Exceeding it yields `429 TOO MANY REQUESTS` with a `Retry-After` value in milliseconds. It is sized to catch a runaway loop in a developer's test script rather than to throttle deliberate use, and it can be disabled with `--no-rate-limit`.
- **Message size limits** enforced by the incremental decoder: 1 MiB per message, 16 KiB per header block, 1 KiB per start line, and 64 header fields per message. Exceeding any of them yields `413 MESSAGE TOO LARGE` and closes the connection, because the remaining bytes of an oversized message cannot be safely skipped and the stream can no longer be resynchronised at a message boundary.
- **A cap on simultaneous control connections**, defaulting to 64 and configurable with `--max-connections`.
- **A ceiling on artificial response delay** of 60 seconds, so a mock configured to be slow cannot hang a test indefinitely.

These limits bound memory and connection use. They are not a security boundary, and they are not a substitute for the authentication the tool does not have. They do not make the tool safe to expose to an untrusted network.

## Data handling

SocketLens TCP v0.1 keeps sessions, mock rules, and test results **in memory only**. Nothing is written to a database and nothing is transmitted off the machine. Two things do touch the disk: the CLI's remembered current session, whose location can be set with `SOCKETLENS_STATE_FILE`, and any file you explicitly write with `result export`.

Test results include the raw bytes sent and received. If your scenarios carry sensitive values in headers or bodies, those values appear in results, in `--raw` output, and in anything you export. Treat exported result files with the same care as the data they contain.

The project has no telemetry, no analytics, and makes no network connection other than the TCP connections a user's own commands and scenarios initiate.
