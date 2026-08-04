# 09 — Malformed Content-Length

## What this demonstrates

Three framing faults that make a message's boundaries unknowable. Each is rejected
with `400 BAD REQUEST` before any rule is consulted, and each closes the connection.

## Run it

```
npm run examples -- --only 9
```

This example installs **no rules**. It never gets far enough to need any.

## The three faults

### 1. Non-numeric

```
SLTP/1.0 ECHO\r\n
Request-ID: req-bad-1\r\n
Content-Length: abc\r\n
\r\n
{}
```

→ `400 BAD REQUEST`, `Reason: invalid-content-length`

### 2. Negative

```
Content-Length: -1
```

→ `400 BAD REQUEST`, `Reason: negative-content-length`

`-1` parses as a number, so a naive `parseInt` accepts it. It then produces a
negative body length, which cannot describe any range of bytes. `Content-Length` is
validated against `/^\d+$/` — unsigned decimal digits only, no sign, no padding, no
whitespace — so `-1`, `+1`, `1.5`, `0x10`, and `1e3` are all rejected. It gets its own
reason code because "you sent a negative length" is more useful diagnostically than
"unparseable".

### 3. Duplicated

```
Content-Length: 2\r\n
Content-Length: 9\r\n
```

→ `400 BAD REQUEST`

Two headers disagree about where the body ends. There is no correct choice here.
Taking the first, the last, the smaller, or the larger are all defensible, and that is
precisely the problem — a peer choosing differently from you will disagree about where
the _next_ message begins. SLTP treats `Content-Length`, `Content-Type`, `Request-ID`,
and `Session-ID` as single-valued and rejects duplicates outright.

## Why these are fatal rather than recoverable

Most protocol errors are recoverable: the server answers `400`, the connection stays
open, and the client sends something better. A missing `Request-ID`, an unknown
operation, or a body that is not valid JSON all work this way, because in each case
the server still knows exactly where the bad message ended and where the next one
begins.

A broken `Content-Length` is different in kind. The body length **is** the message
boundary. Not knowing it means not knowing how many bytes to discard, so the decoder
cannot find the start of the next message. Any bytes it reads next are at an
arbitrary offset in the middle of a body, which it would then try to interpret as a
start line — producing cascading, meaningless errors on every subsequent parse.

This condition is called **decoder poisoning**, and the only safe response is to send
the error and close the connection:

```
SLTP/1.0 400 BAD REQUEST\r\n
Reason: invalid-content-length\r\n
Connection: close\r\n
...
```

Closing is the honest action. A connection whose framing state is unknown cannot be
used, and pretending otherwise converts one clear error into an unbounded stream of
confusing ones.

Contrast the recoverable case, where the framing succeeded and only the _content_ was
wrong — the server knows the message boundary, so it can answer and continue:

| Fault                      | Status | Connection                                        |
| -------------------------- | ------ | ------------------------------------------------- |
| `Content-Length: abc`      | 400    | **closed** — boundary unknown                     |
| `Content-Length: -1`       | 400    | **closed** — boundary unknown                     |
| duplicate `Content-Length` | 400    | **closed** — boundary ambiguous                   |
| missing `Request-ID`       | 400    | stays open — framing was fine                     |
| unknown operation          | 501    | stays open — framing was fine                     |
| body is not valid JSON     | 400    | stays open — framing was fine                     |
| message exceeds size limit | 413    | **closed** — the rest of the body is still coming |

## Why these scenarios use `raw`

The bytes above cannot be produced by the encoder. `encodeMessage` computes
`Content-Length` itself from the actual body buffer and discards any value the caller
supplies, so there is no API by which a caller could emit `Content-Length: abc`.

That is a feature — it makes this class of bug unrepresentable in normal use — but it
means testing the _decoder_ against such input requires bypassing the encoder
entirely. `request.raw` does that, placing an exact byte sequence on the wire:

```json
"request": {
  "raw": "SLTP/1.0 ECHO\\r\\nRequest-ID: req-bad-1\\r\\nContent-Length: abc\\r\\n\\r\\n{}"
}
```

The `\\r\\n` in the JSON source is a literal backslash-r in the string value, which
`unescapeWireString` converts into a real CR LF octet pair before writing. Writing
actual control characters into a JSON string literal is not portable, so the escape
survives one extra round of encoding.

## Why all three scenarios are documented as passing

Each scenario asserts `statusCode: 400` and the matching `Reason` header. The
malformed input is the _stimulus_; the correct rejection is the _expected result_. A
scenario here failing would mean bad framing was accepted — the actual bug.

## The size limit

`Content-Length` is also checked against the maximum message size (1 MiB by default)
and against `Number.MAX_SAFE_INTEGER`. A declared length of `999999999999999999999`
is syntactically valid but would have the server allocate or await bytes that will
never arrive, so it is rejected with `413 MESSAGE TOO LARGE` before a single body byte
is buffered. Checking the declared length rather than the accumulated length is what
makes this bounded: the server never accumulates the oversized body at all.
