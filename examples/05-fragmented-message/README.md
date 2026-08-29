# 05 — One message, seven application writes

## What this demonstrates

A single SLTP request split across seven separate `socket.write()` calls, with the
cuts deliberately placed at the offsets most likely to break a naive parser. The peer
must reassemble them into exactly one message.

## Run it

```
npm run examples -- --only 5
```

## The request

134 bytes on the wire:

```
SLTP/1.0 ECHO\r\n
Request-ID: req-frag-1\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 26\r\n
\r\n
{"note":"split me please"}
```

## Where the cuts fall

`fragmentSizes: [6, 14, 18, 22, 47, 13, 14]` produces these boundaries. Each one was
chosen to break a different assumption:

| Cut at byte | Splits                  | What it would break                                                                                                                                                                                                                                 |
| ----------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6           | `SLTP/1` ¦ `.0 ECH`     | Mid-version-token. A parser that reads the start line from the first chunk sees a truncated version and rejects a valid message.                                                                                                                    |
| 20          | `\nReque` ¦ `st-ID:`    | Mid-header-name. A parser scanning for `:` in one chunk finds none.                                                                                                                                                                                 |
| **38**      | `rag-1\r` ¦ `\nConte`   | **Between a CR and its LF.** A parser searching for the two-byte `\r\n` sequence inside a single chunk cannot find it — the halves live in different buffers.                                                                                       |
| 60          | `pplica` ¦ `tion/j`     | Mid-header-value, so `Content-Type` is incomplete.                                                                                                                                                                                                  |
| **107**     | ` 26\r\n\r` ¦ `\n{"not` | **One byte before the end of the `\r\n\r\n` header delimiter.** The chunk ends with three of the four delimiter bytes. A parser looking for the blank line concludes the headers have not ended, then must reconsider when the fourth byte arrives. |
| 120         | `":"spl` ¦ `it me `     | Mid-body, so `Content-Length` bytes have not all arrived yet.                                                                                                                                                                                       |

Cuts 38 and 107 are the interesting ones. Both split a **delimiter**, not just data,
so the parser cannot rely on any single read containing a complete structural marker.

`interFragmentDelayMs: 25` spaces the writes 25 ms apart. Without a delay the kernel
would likely coalesce them into one segment on loopback and the test would silently
stop testing anything — it would pass for the wrong reason.

## The second scenario

`byte-at-a-time` writes the same request in **134 writes of one byte each**. This is
the pathological limit: no read contains a complete token, a complete header, a
complete delimiter, or a complete anything. It exists because a decoder that handles
this case handles every case.

## How the mock proves reassembly worked

The rule does not match on operation alone. It matches on **body content**:

```json
"match": {
  "operation": "ECHO",
  "body": { "mode": "contains", "value": "split me please" }
}
```

The body is only inspectable after the framing layer has reassembled all 134 bytes,
validated the header block, read `Content-Length: 26`, waited for all 26 body bytes,
and emitted one complete message. A `200 OK` from this rule is therefore direct
evidence that reassembly succeeded. Had the decoder mishandled any cut, the rule
could not have matched and the mock would have answered `410 NO MATCHING RULE`.

The runner additionally asserts `sentSegmentCount === 7` for the first scenario and
`> 100` for the second, so neither can quietly degenerate into a single write.

## How the decoder handles it

The decoder keeps one `Buffer` per connection and, on every `data` event, appends the
new bytes and then loops:

1. If the header delimiter `\r\n\r\n` has not been found yet, search for it. Not
   found means the headers are incomplete — **return and wait for more bytes**. The
   buffer is left untouched.
2. Once found, parse the start line and headers, and read `Content-Length`.
3. If fewer than `Content-Length` body bytes are buffered, **return and wait**. The
   header block is deliberately not consumed, so a partial body cannot be mistaken
   for a new message.
4. When all body bytes are present, emit exactly one message, remove precisely
   `headerBlock + body` bytes from the front of the buffer, and **loop again** — the
   remaining bytes may hold another complete message (see example 06).

Steps 1 and 3 are the whole trick: the decoder is a state machine over a growing
byte buffer, and "I do not have enough bytes yet" is a normal, expected condition
rather than an error.

## The underlying reason this is necessary

TCP provides a **reliable, ordered byte stream**. Those three words are the entire
guarantee:

- **Reliable** — no byte is lost or corrupted.
- **Ordered** — bytes arrive in the order they were sent.
- **Byte stream** — and that is all. There are no records, no frames, no messages.

TCP does not promise that one `write()` becomes one `read()`. The sending kernel may
split a write across segments when it exceeds the path MTU or the congestion window,
and may merge consecutive small writes into one segment — that second behaviour is
Nagle's algorithm, which is why this example pauses between fragments. The receiving
kernel delivers whatever has arrived when the application happens to ask.
`socket.write()` is not a message-sending function. It appends bytes to a stream.

Message boundaries are therefore an **application-layer** concern, and every
stream protocol has to invent them. SLTP uses the same mechanism HTTP/1.1 does: a
delimiter marking the end of the headers, and an explicit length for the body.
Example 09 shows what happens when that length cannot be trusted.
