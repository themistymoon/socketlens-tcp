# SLTP/1.0 Protocol Examples

Byte-level examples of SLTP exchanges. Every example in this document was captured from a
running SocketLens TCP server, not composed by hand.

`\r\n` is written explicitly wherever it appears on the wire. A line break in an example
that is not marked `\r\n` is a presentational wrap of this document, not a byte on the wire.

Timestamps, session identifiers, rule identifiers, result identifiers, ephemeral port
numbers, and `uptimeMs` differ on every run. Everything else — status codes, phrases,
reason tokens, the presence or absence of `Connection: close`, and every `Content-Length` —
is reproducible.

**Related documents**

| Document                                               | Contents                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| [protocol-specification.md](protocol-specification.md) | The normative grammar and rules                                  |
| [status-codes.md](status-codes.md)                     | Every status code with its context                               |
| [architecture.md](architecture.md)                     | How the pieces fit together                                      |
| `examples/`                                            | Eleven runnable scenario bundles, verified by `npm run examples` |

---

## Table of contents

1. [Valid exchanges](#1-valid-exchanges)
2. [Content-Length is a byte count](#2-content-length-is-a-byte-count)
3. [Invalid messages: recoverable faults](#3-invalid-messages-recoverable-faults)
4. [Invalid messages: fatal framing faults](#4-invalid-messages-fatal-framing-faults)
5. [Fragmentation: one message, many writes](#5-fragmentation-one-message-many-writes)
6. [Coalescing: many messages, one write](#6-coalescing-many-messages-one-write)
7. [Timeouts and mid-message disconnects](#7-timeouts-and-mid-message-disconnects)
8. [Reproducing these examples](#8-reproducing-these-examples)

---

## 1. Valid exchanges

### 1.1 PING — no request body

The smallest legal SLTP request. Two lines and a blank line; no `Content-Length`, because
there is no body.

**Request — 36 bytes**

```
SLTP/1.0 PING\r\n
Request-ID: req-1\r\n
\r\n
```

**Response — 273 bytes**

```
SLTP/1.0 200 OK\r\n
Request-ID: req-1\r\n
Server: SocketLens-TCP/0.1.1\r\n
Timestamp: 2026-08-04T10:35:53.138Z\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 100\r\n
\r\n
{"message":"pong","protocol":"SLTP/1.0","serverTime":"2026-08-04T10:35:53.138Z","uptimeMs":15927663}
```

Points to note:

- The response echoes `Request-ID: req-1`. That echo is what lets a client pipeline several
  requests on one connection and still pair each answer with its question, even if the
  server answers out of order.
- `Content-Length: 100` is the exact byte length of the body line. The body is pure ASCII
  here, so its character count and byte count coincide — see [§2](#2-content-length-is-a-byte-count)
  for the case where they do not.

### 1.2 CREATE_SESSION — request body, 201 response

**Request — 131 bytes**

```
SLTP/1.0 CREATE_SESSION\r\n
Request-ID: req-1\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 17\r\n
\r\n
{"name":"ex-doc"}
```

**Response — 429 bytes**, abbreviated in the body for readability

```
SLTP/1.0 201 SESSION CREATED\r\n
Session-ID: ses-3\r\n
Request-ID: req-1\r\n
Server: SocketLens-TCP/0.1.1\r\n
Timestamp: 2026-08-04T10:13:23.837Z\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 249\r\n
\r\n
{"session":{"id":"ses-3","name":"ex-doc","state":"active","mockHost":"127.0.0.1","mockPort":4045, ... }}
```

`201 SESSION CREATED` is an SLTP status, not an HTTP one. The response reports
`mockPort: 4045` — the OS-assigned port of a **real TCP listener** opened for this session
alone. Scenarios connect there, which is why fragmentation and coalescing in this tool are
genuine socket behaviour rather than an in-memory simulation.

### 1.3 ADD_RULE — 212 RULE ADDED

A rule that answers every `PING` with `200 OK` and a Thai body.

**Request — 316 bytes**, body abbreviated

```
SLTP/1.0 ADD_RULE\r\n
Request-ID: req-1\r\n
Session-ID: ses-3\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 213\r\n
\r\n
{"name":"pong","enabled":true,"priority":0,"match":{"operation":"PING"},"response":{ ... }}
```

**Response — 522 bytes**, body abbreviated

```
SLTP/1.0 212 RULE ADDED\r\n
Request-ID: req-1\r\n
Server: SocketLens-TCP/0.1.1\r\n
Timestamp: ...\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: ...\r\n
\r\n
{"rule":{"id":"rule-2","name":"pong","enabled":true,"priority":0,"sequence":1,"hitCount":0, ... }}
```

`212` exists so that a client can distinguish "a rule was installed" from a generic `200 OK`.
The response carries both `priority` and `sequence`: rules are evaluated by priority
descending, then by `sequence` ascending, so the evaluation order is fully determined and
reproducible.

### 1.4 RUN_TEST — 210 TEST PASSED

**Response start line**

```
SLTP/1.0 210 TEST PASSED\r\n
```

The result body records the outcome, the matched rule, every assertion, and every TCP
segment observed in both directions:

```
PASSED  frag-demo  res-4
  outcome           : passed
  duration          : 82 ms
  status            : 200 OK
  matched rule      : rule-2
  sent segments     : 3
  received segments : 1
  responses framed  : 1

Expected versus actual
  ✔ statusCode
```

### 1.5 RUN_TEST — 211 TEST FAILED

When a scenario expects `200` and the matching rule answers `500`, the exchange still
succeeds and the server still answers in the 2xx range:

```
SLTP/1.0 211 TEST FAILED\r\n
```

This is deliberate and is the single most-questioned decision in the protocol. An SLTP
status describes **the fate of the SLTP request**, not the verdict of the test. The server
accepted the request, ran the scenario, stored the result, and answered in full — the
request succeeded completely. A mismatch between expected and actual is the _content_ of
that successful answer.

A scenario that is malformed enough that it cannot be executed at all is a different
situation, and gets `422 INVALID SCENARIO` in the 4xx range.

---

## 2. `Content-Length` is a byte count

This is the most consequential rule in SLTP, and the easiest to get wrong.

> `Content-Length` is the length of the body **in UTF-8 bytes**, never its character count.

### 2.1 A body where the two differ

```
SLTP/1.0 200 OK\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 49\r\n
\r\n
{"message":"pong","note":"ตอบกลับ"}
```

| Measure         | Value  |
| --------------- | ------ |
| Characters      | 35     |
| **UTF-8 bytes** | **49** |

The seven Thai characters in `ตอบกลับ` occupy 3 bytes each under UTF-8 — 21 bytes — and the
28 remaining ASCII characters occupy 1 byte each. 28 + 21 = 49.

Verified directly:

```
$ node -e 'const b = `{"message":"pong","note":"ตอบกลับ"}`;
  console.log(b.length, Buffer.byteLength(b, "utf8"))'
35 49
```

### 2.2 What happens if you send the character count

Suppose the server wrote `Content-Length: 35`. The receiver reads 35 bytes of body and
stops. Fourteen bytes of that body remain in the buffer, and the decoder then tries to
parse them as the **start line of the next message**. They are not a start line, so the
connection produces an error — and if the peer is lenient, the corruption cascades through
every subsequent message on that stream.

Nothing recovers this. There is no resynchronisation point in a length-framed stream once
the length is wrong.

### 2.3 Why the bug hides

In JavaScript, `str.length` returns the number of UTF-16 code units, not bytes. For a
pure-ASCII body the two numbers are identical, so the mistake is invisible in testing and
surfaces the first time a user types a Thai character or an emoji.

The correct call is `Buffer.byteLength(body, 'utf8')`, which is what the encoder uses.

Example 03 in `examples/` uses the body `{"message":"สวัสดี"}` — **20 characters, 32 bytes** —
for exactly this reason:

```
$ node -e 'const t = `{"message":"สวัสดี"}`;
  console.log(t.length, Buffer.byteLength(t, "utf8"))'
20 32
```

### 2.4 The corresponding decoder rule

Because the count is in bytes, the decoder must do all framing arithmetic on a `Buffer` and
must not convert to a string until a complete body has arrived. That single discipline is
what makes a multi-byte character split across two TCP segments harmless: the halves are
just bytes in a buffer until the message is whole.

---

## 3. Invalid messages: recoverable faults

A fault is **recoverable** when the message boundary is still knowable. The server answers
with an error and **keeps the connection open**, because it knows exactly where this message
ended and where the next one begins.

Note the absence of `Connection: close` in every example in this section. That absence is
the observable signal.

### 3.1 Missing `Request-ID` → 400 BAD REQUEST

**Request — 17 bytes**

```
SLTP/1.0 PING\r\n
\r\n
```

**Response — 282 bytes**

```
SLTP/1.0 400 BAD REQUEST\r\n
Reason: missing-request-id\r\n
Server: SocketLens-TCP/0.1.1\r\n
Timestamp: 2026-08-04T10:36:13.668Z\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 92\r\n
\r\n
{"error":"Every SLTP request MUST carry a Request-ID header.","reason":"missing-request-id"}
```

The response cannot echo a `Request-ID`, because none was sent — so the client cannot
correlate this answer with a pending request and reports it as uncorrelated. The framing was
perfectly valid, so the connection survives.

### 3.2 Unknown operation → 501 OPERATION NOT SUPPORTED

**Request**

```
SLTP/1.0 TELEPORT\r\n
Request-ID: req-c\r\n
\r\n
```

**Response**

```
SLTP/1.0 501 OPERATION NOT SUPPORTED\r\n
Reason: unknown-operation\r\n
Request-ID: req-c\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 87\r\n
\r\n
{"error":"Operation TELEPORT is not defined by SLTP/1.0.","reason":"unknown-operation"}
```

The message framed correctly and carried a `Request-ID`, so the response echoes it and the
connection stays open. The operation registry in `packages/protocol/src/operations.ts` is
the normative list of what is accepted.

### 3.3 Unknown session → 404 SESSION NOT FOUND

**Request**

```
SLTP/1.0 LIST_RULES\r\n
Request-ID: req-e\r\n
Session-ID: ses-nope\r\n
\r\n
```

**Response**

```
SLTP/1.0 404 SESSION NOT FOUND\r\n
Request-ID: req-e\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 53\r\n
\r\n
{"error":"No session with id ses-nope.","status":404}
```

### 3.4 Validation order

When a request has more than one fault, the reported fault is fixed and testable:

1. Framing and byte-level syntax — faults here are **fatal**, see [§4](#4-invalid-messages-fatal-framing-faults)
2. `Request-ID` present and well formed
3. Operation exists in the registry
4. `Session-ID` present when the operation requires one, and the session exists
5. Body is valid JSON with the shape the operation requires

So a request that both omits `Request-ID` **and** names a nonexistent operation always
reports `missing-request-id`, because step 2 precedes step 3.

---

## 4. Invalid messages: fatal framing faults

A fault is **fatal** when the message boundary can no longer be determined. The server
answers with an error carrying `Connection: close` and then closes the connection.

The reasoning: if `Content-Length` is unusable, the receiver does not know where the body
ends, so it does not know where the next message begins. Guessing wrong means body bytes get
read as a start line, producing an unbounded cascade of errors — _decoder poisoning_. A
length-framed stream has no resynchronisation point, so closing is the only honest option.

Closing affects **only that connection**. Every connection owns its own buffer and decoder,
so other clients are unaffected.

### 4.1 Non-numeric `Content-Length` → 400 BAD REQUEST

**Request — 57 bytes**

```
SLTP/1.0 PING\r\n
Request-ID: req-b\r\n
Content-Length: abc\r\n
\r\n
```

**Response — 319 bytes**

```
SLTP/1.0 400 BAD REQUEST\r\n
Reason: invalid-content-length\r\n
Server: SocketLens-TCP/0.1.1\r\n
Timestamp: 2026-08-04T10:37:09.048Z\r\n
Connection: close\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 105\r\n
\r\n
{"error":"Content-Length must be an unsigned decimal integer: \"abc\"","reason":"invalid-content-length"}
```

`Connection: close` is present. Compare with [§3.1](#31-missing-request-id--400-bad-request),
which is also `400` but has no such header — the status code alone does not tell you whether
the connection survives; the header does.

### 4.2 Negative `Content-Length` → 400 BAD REQUEST

**Request**

```
SLTP/1.0 PING\r\n
Request-ID: req-d\r\n
Content-Length: -1\r\n
\r\n
```

**Response**

```
SLTP/1.0 400 BAD REQUEST\r\n
Reason: negative-content-length\r\n
Connection: close\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 90\r\n
\r\n
{"error":"Content-Length must not be negative: \"-1\"","reason":"negative-content-length"}
```

Note that `invalid-content-length` and `negative-content-length` are distinct reason tokens,
so a client can tell the two apart programmatically.

`Content-Length` is validated against `/^\d+$/`. That pattern rejects more than it might
first appear:

| Value  | Rejected because                    |
| ------ | ----------------------------------- |
| `-1`   | leading sign                        |
| `+1`   | leading sign                        |
| `1.5`  | not an integer                      |
| `0x10` | not decimal                         |
| `1e3`  | not decimal notation                |
| ` 1`   | leading whitespace inside the value |

### 4.3 Duplicate conflicting `Content-Length`

`Content-Length`, `Content-Type`, `Request-ID`, and `Session-ID` are single-valued. Two
`Content-Length` headers with different values make the body length ambiguous, which is
fatal for the same reason as §4.1: there is no way to choose between them, and choosing
wrong corrupts everything downstream.

### 4.4 Over-limit message → 413 MESSAGE TOO LARGE

Four limits are enforced, each bounding memory against a peer that never sends a terminating
delimiter:

| Limit         | Default                 |
| ------------- | ----------------------- |
| Whole message | 1 MiB (1,048,576 bytes) |
| Header block  | 16,384 bytes            |
| Start line    | 1,024 bytes             |
| Header count  | 64                      |

Exceeding any one is fatal. An oversized message's remaining bytes cannot be safely skipped —
skipping requires knowing how many bytes to skip, which is precisely what is in doubt — so
the stream cannot be resynchronised.

### 4.5 Recoverable versus fatal, side by side

| Fault                                  | Status | `Connection: close` | Connection |
| -------------------------------------- | ------ | :-----------------: | ---------- |
| Missing `Request-ID`                   | 400    |         no          | stays open |
| Unknown operation                      | 501    |         no          | stays open |
| Unknown session                        | 404    |         no          | stays open |
| Body is not valid JSON                 | 400    |         no          | stays open |
| Malformed scenario                     | 422    |         no          | stays open |
| Non-numeric `Content-Length`           | 400    |       **yes**       | **closed** |
| Negative `Content-Length`              | 400    |       **yes**       | **closed** |
| Duplicate conflicting `Content-Length` | 400    |       **yes**       | **closed** |
| Malformed start line                   | 400    |       **yes**       | **closed** |
| Over a size limit                      | 413    |       **yes**       | **closed** |

---

## 5. Fragmentation: one message, many writes

> **A single `socket.write()` does not produce a single `data` event, and a single `data`
> event does not necessarily hold a complete message.**

### 5.1 Seven writes, one message

Example 05 sends one 134-byte message in seven writes, with a short delay between them.
Measured result:

```
PASSED  seven-fragments  res-7
  sent segments     : 7
  received segments : 1
  responses framed  : 1
```

Seven writes went out. **One** message was framed at the far end.

The cut points are chosen to be as hostile as possible:

| Cut           | Lands                                    | Why it is hard                                          |
| ------------- | ---------------------------------------- | ------------------------------------------------------- |
| after 6 B     | mid `SLTP/1`                             | splits the version token itself                         |
| after 20 B    | mid header name                          | header name arrives in two pieces                       |
| at offset 38  | **between a CR and its LF**              | the two bytes of one line terminator are split          |
| at offset 107 | **one byte before `\r\n\r\n` completes** | the delimiter search must not match a partial delimiter |

A decoder that searched for `\r\n\r\n` in a string built by `chunk.toString()` per event
would fail at the third and fourth cuts. Buffer-based search across the accumulated buffer
handles both.

Segment trace from a live run of an ad-hoc fragmented scenario:

```
TCP segments
  → +1ms  6 bytes   SLTP/1
  → +43ms 14 bytes  .0 PING\r\nReque
  → +81ms 16 bytes  st-ID: req-5\r\n\r\n
  ← +82ms 240 bytes SLTP/1.0 200 OK\r\nRequest-ID: req-5\r\nMatched-Rule-ID: rul…
```

The second segment ends mid-`Request-ID`, in the middle of the header name.

### 5.2 One byte at a time

The second scenario in example 05 sends the same message in 134 single-byte writes — the
most extreme fragmentation possible:

```
PASSED  byte-at-a-time  res-8
  sent segments     : 134
  received segments : 1
  responses framed  : 1
```

The trace shows each byte as its own segment, including the line terminators arriving
separately:

```
  → +2ms 1 byte  2
  → +2ms 1 byte  6
  → +2ms 1 byte  \r
  → +2ms 1 byte  \n
  → +3ms 1 byte  \r
  → +3ms 1 byte  \n
  → +3ms 1 byte  {
```

Still one framed message. A decoder that survives byte-at-a-time delivery survives every
fragmentation pattern, because every other pattern is a coarser version of this one.

### 5.3 Why an inter-fragment delay is needed

Example 05 sets `interFragmentDelayMs: 25`. Without it, Nagle's algorithm may coalesce the
seven small writes back into one segment in the kernel, and the demonstration silently stops
demonstrating anything.

This is worth stating plainly: **the tool has to work against TCP in order to demonstrate
TCP.** That difficulty is itself the lesson — an application cannot control how its bytes are
grouped on the wire, so it must never assume a grouping.

### 5.4 Splitting a multi-byte character

The hardest case does not appear in the segment counts, so it is worth naming explicitly. A
3-byte Thai character can be split across two TCP segments, leaving one or two orphan bytes
at the end of a buffer.

This is harmless **only** because the decoder does all framing on the buffer and decodes
UTF-8 exactly once, after the complete body has arrived. Convert early — `chunk.toString()`
on arrival — and the orphan bytes become U+FFFD replacement characters, permanently and
silently corrupting the body. The unit tests cover this case directly.

---

## 6. Coalescing: many messages, one write

> **A single `data` event does not necessarily hold only one message.**

### 6.1 Two messages, one write

Two complete PING requests written in a single 74-byte `write()`:

```
SLTP/1.0 PING\r\nRequest-ID: req-x1\r\n\r\nSLTP/1.0 PING\r\nRequest-ID: req-x2\r\n\r\n
```

Measured result:

```
[CLIENT] conn=conn-1 wrote 74 raw byte(s) without encoding
Wrote 74 raw byte(s), received 548
SLTP/1.0 200 OK\r\n
Request-ID: req-x1\r\n
...
Request-ID: req-x2\r\n
```

**One write out. Two complete responses back**, echoing `req-x1` and `req-x2` respectively.

Example 06 measures the same thing through the scenario runner:

```
PASSED  two-messages-one-write  res-9
  sent segments     : 1
  received segments : 1
  responses framed  : 2
```

One segment in, **two** messages framed.

### 6.2 What this proves

The peer split those two messages using `Content-Length` and the header delimiter, not using
any packet boundary — there was only one write and one segment, so there was no boundary to
use.

### 6.3 The loop that makes it work

After emitting a complete message and consuming its bytes, the decoder must **loop back and
re-examine the buffer** before waiting for more data:

```
on new chunk:
  append chunk to buffer
  loop:
    find "\r\n\r\n"          — not found? keep buffer, exit loop
    parse start line + headers
    read and validate Content-Length
    body incomplete?         — keep buffer, exit loop
    emit exactly one complete message
    drop the consumed bytes
    continue the loop        ← without this, message two is stranded
```

Omit that final `continue` and the second message sits in the buffer, unprocessed, until
another `data` event happens to arrive — which may never happen. The connection appears to
hang for no visible reason, and nothing is logged. This is among the hardest TCP bugs to
diagnose in production, and it is invisible in any test that sends one message at a time.

### 6.4 The three assumptions, restated

| Assumption                              | Falsified by                                               |
| --------------------------------------- | ---------------------------------------------------------- |
| one `write()` → one `data` event        | [§5.1](#51-seven-writes-one-message) — 7 writes, 1 message |
| one `data` event → one complete message | [§5.2](#52-one-byte-at-a-time) — 134 writes, 1 message     |
| one `data` event → only one message     | [§6.1](#61-two-messages-one-write) — 1 write, 2 messages   |

---

## 7. Timeouts and mid-message disconnects

### 7.1 Timeout

Example 08 pairs a rule that delays 2500 ms with a scenario whose timeout is 500 ms. The
scenario declares `expect: { timeout: true }`, so the timeout is the asserted outcome and the
test passes by timing out.

When a scenario does **not** expect a timeout and no complete response arrives in the window,
the server answers `408 TEST TIMEOUT`.

Note that a timeout means _no complete message was framed within the window_. Bytes may well
have arrived — a partial header block, a body still short of its `Content-Length`. Partial
data is never parsed.

### 7.2 Mid-message disconnect

Example 10 cuts the stream in both directions:

- the request stops after 30 bytes (`transmission.disconnectAfterBytes: 30`)
- the response stops after 40 bytes (`response.disconnectAfterBytes: 40`)

Both declare `expect: { disconnect: true }`.

The receiving side reports a **truncated message**. It does not attempt to parse the
incomplete bytes, because a half-parsed message is more dangerous than an acknowledged
incomplete one.

This is not a failure of TCP's reliability guarantee. Reliability promises that bytes written
before the close arrive intact and in order; it promises nothing about bytes that were never
written.

---

## 8. Reproducing these examples

Start a server:

```bash
npm run build
npm run start:server
```

### Valid exchanges

```bash
npm run cli -- ping --raw
npm run cli -- session create --name ex-doc --raw
npm run cli -- rule add --name pong --operation PING --status 200 \
  --body '{"message":"pong","note":"ตอบกลับ"}'
```

### Invalid messages

The `raw` command writes bytes with no encoding and no `Request-ID` correlation, which is
how to send something the encoder would refuse to produce. In `--text`, the escapes `\r`,
`\n`, and `\t` become real control characters.

```bash
# recoverable — no Connection: close, socket stays open
npm run cli -- raw --text 'SLTP/1.0 PING\r\n\r\n'
npm run cli -- raw --text 'SLTP/1.0 TELEPORT\r\nRequest-ID: req-c\r\n\r\n'

# fatal — Connection: close, socket closes
npm run cli -- raw --text 'SLTP/1.0 PING\r\nRequest-ID: req-b\r\nContent-Length: abc\r\n\r\n'
npm run cli -- raw --text 'SLTP/1.0 PING\r\nRequest-ID: req-d\r\nContent-Length: -1\r\n\r\n'
```

### Coalescing by hand

```bash
npm run cli -- raw --text 'SLTP/1.0 PING\r\nRequest-ID: req-x1\r\n\r\nSLTP/1.0 PING\r\nRequest-ID: req-x2\r\n\r\n'
```

### Fragmentation and coalescing through the runner

```bash
npm run cli -- run examples/05-fragmented-message/bundle.json
npm run cli -- run examples/06-coalesced-messages/bundle.json
```

### All eleven examples, checked against their documentation

```bash
npm run examples
```

This runner starts its own server on an OS-assigned port, executes every scenario, and
compares the outcome against what each example's README claims. It exits non-zero when an
example's documentation disagrees with the code, which is what keeps these examples from
drifting out of date.

Examples 04, 08, and 10 are registered as **not passing on purpose** — a failing assertion,
a timeout, and a mid-message disconnect respectively. The runner knows each documented
outcome, so example 04 would fail the run if it ever started passing: an assertion checker
that stops catching a real mismatch is a worse bug than the mismatch it was meant to catch.
