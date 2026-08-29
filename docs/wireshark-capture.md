# Capturing SLTP with Wireshark

How to watch SLTP/1.0 on the wire, what the capture proves, and what it does not.

Wireshark is **optional**. It is not a dependency of this project, nothing in
`npm run verify` needs it, and the tool works without it. What a capture adds is
independent evidence: the automated tests prove the decoder handles a given sequence of
chunks correctly, but only a capture shows what the operating system actually put on the
wire.

Every scenario below exists to make one **SLTP design decision** visible as bytes; §6 names
which decision each one demonstrates. The scenarios are a means of observing the protocol, not
features of the tool.

Instructions are written for **Windows first**, because that is where loopback capture needs
an extra step. Linux and macOS notes are in §9.

> **Verification status of this document.** The workflow was executed on the Windows
> development machine on 2026-08-29 with Wireshark/TShark 4.6.7 and Npcap 1.88. Wireshark
> showed `\Device\NPF_Loopback (Adapter for loopback traffic capture)`, the demo helper ran
> all eight scenarios against commit `4d1c6a1`, and the saved capture was checked with
> TShark. The resulting packet files and cursor-free screenshots are in
> `evidence/wireshark-2026-08-29/`. The full capture used the capture filter
> `tcp port 7420`; consequently it records the control-server exchange for `delay`, but not
> that scenario's separate mock-endpoint connection.

---

## 1. What you need

| Requirement      | Detail                                               |
| ---------------- | ---------------------------------------------------- |
| Wireshark        | 4.x. The installer bundles Npcap                     |
| Npcap            | Installed **with loopback support enabled** — see §2 |
| Administrator    | Capturing requires it on Windows                     |
| A running server | `npm run start:server` in one terminal               |
| Traffic          | `npm run wireshark:demo` in another                  |

---

## 2. Enabling loopback capture on Windows

This is the step that catches people out. **Traffic to `127.0.0.1` never touches your
Ethernet or Wi-Fi adapter**, so selecting either of those captures nothing at all. Windows
needs Npcap's loopback support, which is a checkbox during installation.

1. Run the Wireshark installer, or the Npcap installer on its own from
   [npcap.com](https://npcap.com).
2. When Npcap's options appear, tick **"Support loopback traffic"**. Older Npcap installers
   labelled this _"Support loopback traffic ('Npcap Loopback Adapter' will be created)"_;
   the current 1.x installers drop the parenthetical and create an adapter reported as
   _"Adapter for loopback traffic capture"_ instead.
3. Finish the installation and **reboot** if prompted.

To check it worked, open Wireshark and look at the interface list on the welcome screen. You
want an entry named:

- **"Adapter for loopback traffic capture"** — Npcap 1.0 and later, device
  `\Device\NPF_Loopback`; or
- **"Npcap Loopback Adapter"** — older Npcap releases.

If neither is present, loopback support was not installed. Re-run the Npcap installer; there
is no way to capture `127.0.0.1` on Windows without it.

### Checking without opening Wireshark

Npcap ships a diagnostic that lists its adapters, which answers the question in one command
and works even if Wireshark itself is not installed:

```bash
"/c/Program Files/Npcap/DriverQuery.exe"
```

Look for this line in the output:

```
Adapters installed:
\Device\NPF_Loopback (Adapter for loopback traffic capture)
```

If `\Device\NPF_Loopback` is listed, loopback capture is available and the problem is
elsewhere — almost certainly the wrong adapter selected in Wireshark. If it is absent,
loopback support was not installed.

> A sanity check before blaming the tool: start the server, run
> `npm run wireshark:demo -- --scenario ping`, and confirm packets appear. If the interface
> list looks right but nothing arrives, you are almost certainly capturing on the wrong
> adapter.
>
> A check that needs no capture software at all: run the demo and then
> `netstat -ano -p tcp | findstr <local-port>`, using the port the demo printed. Two
> `ESTABLISHED` rows between `127.0.0.1:<local-port>` and `127.0.0.1:7420` confirm the
> traffic is real loopback TCP, which means a correctly configured capture will see it.

---

## 3. Starting a capture

1. In Wireshark, **double-click** the loopback adapter to start capturing.
2. Type this into the display filter bar and press Enter:

   ```
   tcp.port == 7420
   ```

   That is the control server's default port. Everything the CLI and the bridge send to the
   control server appears here.

3. In a terminal, start the server if it is not already running:

   ```bash
   npm run start:server
   ```

4. In a second terminal, generate labelled traffic:

   ```bash
   npm run wireshark:demo
   ```

Packets should appear immediately. If the list stays empty, revisit §2.

### Useful filters

| Filter                                         | Shows                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `tcp.port == 7420`                             | All control-server traffic                                            |
| `tcp && ip.addr == 127.0.0.1`                  | All loopback TCP, including session mock endpoints on ephemeral ports |
| `tcp.port == 54321`                            | One exchange, using the local port the demo printed                   |
| `tcp.stream eq 3`                              | One connection, after you have identified its stream number           |
| `tcp.len > 0`                                  | Hides bare ACKs, leaving only segments carrying payload               |
| `tcp contains "Request-ID: ws-ping"`           | The exchange with a specific `Request-ID`                             |
| `tcp.flags.reset == 1 \|\| tcp.flags.fin == 1` | Connection teardown, for the failure scenarios                        |

`tcp.stream` is the most useful of these once you are looking at one conversation. Wireshark
numbers each TCP connection it sees from 0; select any packet and the stream index appears in
the TCP layer of the detail pane, or right-click → **Conversation Filter → TCP**.

---

## 4. Correlating the terminal with the capture

This is why `npm run wireshark:demo` exists rather than just running the CLI. Each scenario
prints the facts needed to find itself in a capture:

```
[1] ping — one request, one response
────────────────────────────────────────────────────────────────────────────
  time            2026-08-25T05:03:36.141Z
  target          127.0.0.1:7420  (control server)
  local           127.0.0.1:13049
  Request-ID      ws-ping
  request         38 bytes in 1 application write
  expect          200 OK
  response        200 OK, 270 bytes
  reads           1 data event(s) observed
  filter          tcp.port == 13049
```

The `local` line and the ready-made `filter` line are the important ones. **The local port is
what isolates one exchange**, because the server port is shared by every connection. Copy the
printed filter straight into Wireshark.

Options for driving the capture:

```bash
npm run wireshark:demo -- --list                      # scenario names
npm run wireshark:demo -- --scenario fragmentation    # one scenario
npm run wireshark:demo -- --loop --interval 2000      # continuous, until Ctrl+C
npm run wireshark:demo -- --port 7420 --host 127.0.0.1
```

`--loop` is convenient when you want to start the capture first and take your time finding
things.

---

## 5. Reading one exchange

Right-click any packet in the conversation → **Follow → TCP Stream**. Wireshark reassembles
the whole byte stream and shows it as text, request in one colour and response in the other.

For the `ping` scenario you should see something close to:

```
SLTP/1.0 PING
Request-ID: ws-ping

SLTP/1.0 200 OK
Request-ID: ws-ping
Server: SocketLens-TCP/0.1.2
Timestamp: 2026-08-25T05:03:36.142Z
Content-Type: application/json; charset=utf-8
Content-Length: 96

{"message":"pong","protocol":"SLTP/1.0","serverTime":"2026-08-25T05:03:36.142Z","uptimeMs":4127}
```

Things to identify, in this order:

1. **The start line.** `SLTP/1.0 PING` going out; `SLTP/1.0 200 OK` coming back. Note there is
   no method, no path, and no `Host` header — this is not HTTP, and the capture shows it.
2. **The `Request-ID`.** The same value on both sides. This is what lets several requests be
   outstanding on one connection at once without depending on response order.
3. **`Content-Length`.** Count the body bytes after the blank line and check they agree.
4. **The blank line.** In _Follow TCP Stream_ it looks like an empty line; on the wire it is
   `\r\n\r\n`, four bytes. Switch the stream view to **Hex Dump** to see `0d 0a 0d 0a`
   directly.

Because SLTP headers are printable US-ASCII, all of this is readable with no dissector. That
is a deliberate design property, and a capture is where it pays off.

### Control connection versus session mock endpoint

Two kinds of listener produce traffic, and telling them apart matters:

| Connection            | Port                   | Carries                                                     |
| --------------------- | ---------------------- | ----------------------------------------------------------- |
| Control server        | 7420 by default        | `PING`, `CREATE_SESSION`, `ADD_RULE`, `RUN_TEST`, and so on |
| Session mock endpoint | Ephemeral, OS-assigned | Whatever operations your mock rules answer                  |

The `delay` scenario exercises both: it creates a session over the control connection, then
opens a **separate** connection to that session's own mock endpoint. In the capture these are
two distinct `tcp.stream` values on two different ports, which is the visible proof that mock
endpoints are real TCP listeners rather than an in-process simulation. The terminal output
labels the target `(session mock endpoint, NOT the control port)` and prints its port.

Filter with `tcp && ip.addr == 127.0.0.1` rather than `tcp.port == 7420` to see both at once.

---

## 6. The scenarios, and what to look for in each

Each scenario is chosen to expose one decision in the SLTP specification. Read the middle
column as the reason the scenario exists:

| Scenario        | SLTP decision it makes visible                                 | Spec reference              |
| --------------- | -------------------------------------------------------------- | --------------------------- |
| `ping`          | Request and response grammar; status line and canonical phrase | Start line, status registry |
| `utf8`          | `Content-Length` counts **bytes**, not characters              | Framing rules               |
| `fragmentation` | Length framing survives arbitrary write boundaries             | Framing rules               |
| `coalescing`    | Only `Content-Length` says where a message ends                | Framing rules               |
| `delay`         | Sessions own real TCP listeners; timing is protocol-visible    | Session semantics           |
| `malformed`     | Unusable framing information is fatal and stated in a header   | `Reason` taxonomy, `4xx`    |
| `disconnect`    | An incomplete message is never framed                          | Framing rules               |
| `concurrent`    | One decoder per connection; `Request-ID` scopes correlation    | Correlation, decoder state  |

### 6.1 `utf8` — `Content-Length` counts bytes

```bash
npm run wireshark:demo -- --scenario utf8
```

The body is `{"echo":"สวัสดีชาวโลก"}`. The terminal reports the Thai text as **12 characters,
36 bytes**, because each Thai character encodes as three bytes in UTF-8.

In the capture, switch _Follow TCP Stream_ to **Hex Dump** and count the payload bytes after
`\r\n\r\n`. They match `Content-Length`, not the character count. A decoder using
`string.length` here would wait forever for bytes that are never coming, then misread the
start of the next message.

### 6.2 `fragmentation` — writes are not segments

```bash
npm run wireshark:demo -- --scenario fragmentation
```

The terminal reports one message of 135 bytes in **6 application writes** with sizes
`6 + 14 + 18 + 24 + 40 + 33`, spaced 30 ms apart.

**Now compare that with the capture, and expect the numbers to differ.** Count the segments
carrying payload in that stream (`tcp.len > 0`). You may see six, or fewer.

This is the single most valuable thing a capture demonstrates here, so it is worth being
precise about why:

- The application made six `socket.write()` calls. That is a fact about the application.
- How many TCP segments carried those bytes is **the operating system's decision**, influenced
  by Nagle's algorithm, the congestion and receive windows, and the path MTU.
- On Windows loopback the effective MSS is very large — tens of kilobytes rather than the
  ~1460 bytes typical of Ethernet — so a whole SLTP message comfortably fits in one segment.
  The 30 ms delay between writes is what keeps them from being merged. Without it, they very
  likely would be.
- The demo disables Nagle with `setNoDelay(true)` for the same reason.

Whatever the segment count turns out to be, **the peer framed exactly one message** — the
terminal prints `framed 1 complete SLTP message(s)`. Write count, segment count, and message
count are three different numbers, and that is the whole lesson.

### 6.3 `coalescing` — two messages, one write

```bash
npm run wireshark:demo -- --scenario coalescing
```

Two complete requests are concatenated and written in **one** `socket.write()`. In _Follow TCP
Stream_ you see both start lines back to back with nothing between them:

```
SLTP/1.0 PING
Request-ID: ws-coal-a
...
{"echo":"first"}SLTP/1.0 PING
Request-ID: ws-coal-b
```

Note where the second message begins: immediately after the first body, with **no delimiter,
no marker, and no gap**. The only thing that says where the first message ends is its
`Content-Length`. The server answers twice, and both `Request-ID` values come back.

Together with §6.2 this is the complete argument, both halves of it from this generator's own
scenarios: the `coalescing` scenario's one application write produced two messages, and the
`fragmentation` scenario's six application writes produced one. Nothing at the socket layer
distinguishes these cases. (Example 05 makes the same point with a seven-write split; it is a
separate demonstration, and the two write counts are not interchangeable.)

### 6.4 `delay` — timing is visible

```bash
npm run wireshark:demo -- --scenario delay
```

A mock rule holds its reply for 750 ms. In the capture, look at the **Time** column between
the request segment and the response segment on the mock endpoint's stream — roughly 0.75
seconds. Set **View → Time Display Format → Seconds Since Previous Displayed Packet** to read
it directly.

This is also the scenario that produces two streams on two ports (§5).

### 6.5 `malformed` — a fatal framing fault

```bash
npm run wireshark:demo -- --scenario malformed
```

The request declares `Content-Length: -5`, which cannot be used to find the end of a body.
In the capture:

- The server answers `400 BAD REQUEST` with a `Connection: close` header and a `Reason`
  header naming the fault.
- A **FIN** follows. Filter `tcp.flags.fin == 1` to see it.

The connection dies rather than continuing because the stream cannot be resynchronised: with
no trustworthy length, there is no way to know where the next message starts. Saying so
explicitly in a header, rather than leaving the peer to infer it from the FIN, is a deliberate
choice.

### 6.6 `disconnect` — the stream stops mid-body

```bash
npm run wireshark:demo -- --scenario disconnect
```

The client sends a header block promising 400 body bytes, sends 12, and destroys the socket.
The capture shows the payload segments followed by an **RST** (or a FIN, depending on timing
and platform), with no response at all — the server was still waiting for 388 more bytes.

Filter `tcp.flags.reset == 1 || tcp.flags.fin == 1` on that stream.

### 6.7 `concurrent` — independent streams

```bash
npm run wireshark:demo -- --scenario concurrent
```

Three connections open at once. Each gets its own `tcp.stream` index and its own local port,
and each response carries the `Request-ID` of its own connection. Use **Statistics →
Conversations → TCP** to see all three listed side by side with their byte counts.

This is the visible form of a design property: each connection owns its own decoder and its
own framing state. Sharing one would interleave two byte streams and corrupt both.

---

## 7. What the capture proves, and what it does not

**Proves**

- The traffic is genuinely TCP on the stated port, with a real three-way handshake — not an
  in-process shortcut.
- The bytes on the wire are exactly the SLTP text the tool reports, readable without a
  dissector.
- Application write boundaries and TCP segment boundaries are different things.
- A declared `Content-Length` matches the actual payload byte count, including for multi-byte
  UTF-8.
- A fatal framing fault is followed by a real FIN or RST.
- Concurrent clients occupy genuinely separate TCP streams.

**Does not prove**

- **Not that the decoder is correct.** A capture shows one sequence of bytes. It cannot show
  whether a different split would be mishandled. That is what the 55 decoder tests are for.
- **Not how the application observed those bytes.** Wireshark shows segments; it cannot show
  how many `data` events Node delivered, and the two need not correspond. The terminal
  reports the read count precisely because the capture cannot.
- **Not that this generalises to a network.** Loopback has an enormous MSS, no loss, no
  reordering, and nothing interesting happening in congestion control. Real-network
  segmentation looks different.
- **Not performance.** Capturing perturbs timing. Use `npm run benchmark` for numbers, and see
  [`../benchmarks/README.md`](../benchmarks/README.md) for its own caveats.

---

## 8. A 2–3 minute demonstration

Rehearse this. It is short because it does one thing.

| #   | Step                                                                                       | Say                                                                                        |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Capture already running on the loopback adapter, filter `tcp.port == 7420` visible         | "This is real TCP on loopback, port 7420. No HTTP anywhere."                               |
| 2   | `npm run wireshark:demo -- --scenario ping`                                                | "One request, one response."                                                               |
| 3   | Follow → TCP Stream                                                                        | "`SLTP/1.0 PING`. Our own start line — no method, no path, no `Host`."                     |
| 4   | Point at `Request-ID`, then `Content-Length`, then the response status line                | "Same ID both directions, so replies can come back out of order. Length in bytes."         |
| 5   | `npm run wireshark:demo -- --scenario fragmentation`                                       | "Six application writes for one message — this generator's split, not example 05's seven." |
| 6   | Apply `tcp.len > 0`, count the payload segments, compare with six                          | "The OS decided the segmentation, not us. Still exactly one message framed."               |
| 7   | `npm run wireshark:demo -- --scenario coalescing`, Follow TCP Stream                       | "One write, two messages, no delimiter between them. Only `Content-Length` separates."     |
| 8   | `npm run wireshark:demo -- --scenario malformed`, point at `400`, `Connection: close`, FIN | "Length can't be trusted, so the stream can't be resynchronised. We say so, then close."   |

Stop there. Do not walk through all thirteen operations.

### If live capture fails

Have a fallback ready; loopback capture on an unfamiliar machine is exactly the thing that
breaks during a presentation.

1. **A saved capture.** Record a `.pcapng` beforehand with all scenarios
   (`npm run wireshark:demo`) and keep it on disk. Open it with **File → Open**. Everything in
   §5 and §6 works identically on a saved file, and this is the recommended primary plan if
   you are presenting on someone else's machine.
2. **The CLI's `--raw` output.** `npm run cli -- run --operation PING --fragment 12,8,40 --raw`
   prints the exact bytes in both directions, plus the write count, read count, and framed
   message count. It makes the same argument without a capture.
3. **`npm run examples -- --only 5` and `--only 6`.** The fragmentation and coalescing examples
   assert their own outcomes and print the counts.
4. **Screenshots.** Captured in advance, per the checklist below.

---

## 9. Linux and macOS

| Platform | Interface | Notes                                                                                 |
| -------- | --------- | ------------------------------------------------------------------------------------- |
| Linux    | `lo`      | Works without extra software. May need `sudo`, or membership of the `wireshark` group |
| macOS    | `lo0`     | Works with the bundled ChmodBPF helper installed by the Wireshark package             |

Filters and every step from §3 onward are identical. Segmentation behaviour differs between
platforms, so the segment counts in §6.2 will not necessarily match — which is itself the
point being made.

### Optional: `tshark` from the command line

Nothing in this project needs `tshark`, but it is convenient for a scripted capture.

```bash
# list interfaces and find the loopback one
tshark -D

# Windows, capture control-server traffic to a file
tshark -i "\Device\NPF_Loopback" -f "tcp port 7420" -w capture.pcapng

# Linux or macOS
tshark -i lo -f "tcp port 7420" -w capture.pcapng

# read it back, showing only payload-carrying segments
tshark -r capture.pcapng -Y "tcp.len > 0"

# print the reassembled bytes of stream 0
tshark -r capture.pcapng -q -z follow,tcp,ascii,0
```

Note that `-f` takes a **capture** filter in BPF syntax (`tcp port 7420`) while `-Y` takes a
**display** filter in Wireshark syntax (`tcp.port == 7420`). They are different languages and
mixing them up is the usual first mistake.

---

## 10. Screenshot checklist and recorded evidence

The repository includes the completed capture set in `evidence/wireshark-2026-08-29/`.
These files cover the eight claims in the original checklist:

| #   | Evidence file(s)                                                               | Purpose                                           |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| 1   | `08-loopback-interface.jpg`                                                    | Shows the capture is genuinely on loopback        |
| 2   | `01-capture-overview.jpg`, `02-ping-filtered.jpg`                              | Real TCP, real connection setup                   |
| 3   | `03-ping-follow-stream.jpg`                                                    | The protocol is our own, plaintext, and not HTTP  |
| 4   | `04-ping-hex-framing.jpg`                                                      | The header delimiter really is four bytes         |
| 5   | `09-utf8-byte-length.jpg`                                                      | `Content-Length` counts bytes, not characters     |
| 6   | `05-fragmentation-six-writes.jpg`                                              | The observed TCP segmentation for the split send  |
| 7   | `06-coalescing-one-write-two-responses.jpg`, `10-coalescing-follow-stream.jpg` | One write carries two framed messages             |
| 8   | `07-malformed-400-close.jpg`, `11-malformed-fin-close.jpg`                     | A fatal framing fault is stated and then acted on |

The fragmentation screenshot shows six payload-carrying TCP segments in this particular
loopback run. The demo output independently reports six calls to `socket.write()` with sizes
`6+14+18+24+40+33`. Those two counts happen to match here, but Wireshark cannot prove how
many application writes occurred and they must not be treated as equivalent in general.

Two packet files are retained: `socketlens-essential-4d1c6a1.pcapng` is the compact fallback
used for the core screenshots, while `socketlens-full-4d1c6a1.pcapng` is the complete
port-7420 capture from an eight-scenario generator run. Their hashes and exact scope are in
the evidence directory's `README.md`.

Optional extras: **Statistics → Conversations → TCP** during `concurrent` (three streams side
by side), and the 750 ms gap in the `delay` scenario with the time format set to seconds since
the previous displayed packet.

When you paste these into the report, caption each with what it proves — a screenshot without
a claim attached is decoration.
