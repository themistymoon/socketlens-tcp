# 03 — A passing test, and why Content-Length counts bytes

## What this demonstrates

A complete passing test with header and body assertions, whose response body proves
that `Content-Length` is a **byte** count and not a character count.

## Run it

```
npm run examples -- --only 3
```

## What you should see

The mock answers with a Thai greeting:

```
SLTP/1.0 200 OK\r\n
Request-ID: req-1\r\n
Matched-Rule-ID: greet-th\r\n
Content-Type: application/json; charset=utf-8\r\n
X-Demo: byte-length\r\n
Content-Length: 32\r\n
\r\n
{"message":"สวัสดี"}
```

The body is `{"message":"สวัสดี"}`. Count the characters and you get **20**. The
declared `Content-Length` is **32**. Both numbers are correct; they measure different
things.

## Why the difference is 12

`สวัสดี` is six Thai characters. Every one of them lives outside the Basic Latin
block, so UTF-8 encodes each as **3 bytes** instead of 1:

```
6 characters × 3 bytes = 18 bytes
6 characters × 1 char  =  6 characters
                          ─────────────
difference             = 12
```

14 ASCII characters (`{"message":"`, `"`, `}`) contribute 14 bytes either way.
`14 + 18 = 32` bytes, and `14 + 6 = 20` characters.

## Why this is a correctness issue and not a curiosity

A framing implementation that writes

```ts
headers['Content-Length'] = String(body.length); // WRONG
```

would declare 20 for this body. The peer would then read 20 bytes, stop, and treat
the remaining 12 bytes as the start of the _next_ message. Those 12 bytes are not a
valid start line, so the connection desynchronises and every subsequent message on it
is garbage. The bug would be invisible in testing against ASCII payloads and would
surface in production the first time a user typed a non-Latin character.

SLTP therefore requires the length in bytes, and this implementation never lets a
caller supply the value: `encodeMessage` computes it from the encoded buffer with
`Buffer.byteLength(body, 'utf8')` and silently discards any `Content-Length` a caller
passes in. That is a deliberate choice — a header that must equal a derived value
should be derived, not validated.

The runner asserts `Content-Length: 32`, re-measures the received body, and fails if
the body turns out to be pure ASCII, so this example cannot quietly stop
demonstrating what it claims to.

## The other half: reading a split character

Declaring the right length is only half the problem. The receiving side must also
cope with a multibyte character split across two TCP segments — bytes 1 and 2 of
`ส` arriving in one read and byte 3 in the next. Decoding a partial buffer as UTF-8
there would produce a replacement character (`�`) and corrupt the body.

The decoder avoids this by never decoding early: it accumulates raw bytes until
`Content-Length` of them have arrived and only then converts the body to a string.
Splitting a character becomes a non-event, because no decoding happens at the
boundary. Example 05 exercises that path directly.
