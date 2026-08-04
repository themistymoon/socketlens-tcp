# 06 — Two messages, one TCP write

## What this demonstrates

The exact opposite of example 05. Two complete SLTP requests are concatenated into
one buffer and written with a **single** `socket.write()`. The peer must split them
apart and answer both.

## Run it

```
npm run examples -- --only 6
```

## What goes on the wire

One write, containing this — with no separator between the two messages beyond what
the framing itself provides:

```
SLTP/1.0 ECHO\r\n
Request-ID: req-coalesce-a\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 17\r\n
\r\n
{"which":"first"}SLTP/1.0 ECHO\r\n
Request-ID: req-coalesce-b\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 18\r\n
\r\n
{"which":"second"}
```

Look at the line `{"which":"first"}SLTP/1.0 ECHO`. The first message's body runs
directly into the second message's start line with nothing in between. There is no
message separator in SLTP, and there does not need to be one.

## What you should see

Two responses, from two different rules:

```
SLTP/1.0 200 OK          Matched-Rule-ID: echo-first    {"answer":"first"}
SLTP/1.0 200 OK          Matched-Rule-ID: echo-second   {"answer":"second"}
```

The runner asserts both `sentSegmentCount === 1` and `responseCount === 2`.

## Why this is the proof

This is the clearest observable demonstration in the whole project that **TCP does
not preserve message boundaries**.

One write produced two responses. If TCP delivered messages, that would be
impossible — one send would mean one receive. Since TCP delivers only a byte stream,
the number of writes and the number of messages are unrelated quantities. Example 05
sent one message in seven writes; this one sends two messages in one write. Both are
normal, and a correct implementation cannot distinguish them at the socket layer
because at that layer there is nothing to distinguish.

## How the peer knows where to cut

Only from `Content-Length`. Having parsed the first header block, the decoder knows
the first message ends exactly 17 bytes after the `\r\n\r\n`. Everything after that
offset is, by definition, the beginning of the next message.

This is why the decoder's parse step is a **loop** rather than a single pass:

```
append new bytes to the connection buffer
loop:
    try to frame one complete message from the front of the buffer
    if incomplete → break and wait for more bytes
    emit the message
    remove exactly its bytes from the buffer
    continue          ← without this, message 2 sits unparsed
```

A decoder that returned after emitting one message would frame `{"which":"first"}`,
answer it, and leave the second request sitting in the buffer indefinitely. Nothing
would appear broken: no error, no crash. The second request would simply never be
answered, and the client would eventually time out. That failure mode is
disproportionately hard to diagnose from the outside, which is why it is worth a
dedicated example.

## Why the two rules match on body content

Both requests use the same operation, `ECHO`, so operation matching alone could not
tell them apart. Matching on body content instead —
`{"which":"first"}` versus `{"which":"second"}` — means each response identifies
_which_ message it answers. Two responses both saying `first` would indicate the
decoder had framed the same bytes twice; the distinct bodies rule that out.

The two rules share priority 10 and do not conflict, because SLTP considers rules
equivalent only when operation, header matchers **and** body matcher all agree. Two
rules differing in their body matcher are legitimately distinct.

## Where coalescing comes from in practice

You rarely write two messages deliberately. It happens anyway:

- **Nagle's algorithm** buffers small writes and sends them together to avoid
  flooding the network with tiny packets.
- A client sending a **pipelined burst** of requests without waiting for responses.
- A **proxy or TLS layer** re-chunking the stream on its own boundaries.
- The receiving application being **slow to read**, so several segments accumulate in
  the kernel buffer and one `read()` returns all of them.

The last one is the most common in practice and the least intuitive: an application
under load coalesces its own input simply by not reading fast enough. This is why the
bug tends to appear in production and not in development.
