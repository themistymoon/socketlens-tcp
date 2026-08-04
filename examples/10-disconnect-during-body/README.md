# 10 — Disconnecting in the middle of a message

## What this demonstrates

Both directions of a truncated exchange: the mock hangs up part-way through writing
its response, and the client hangs up part-way through writing its request. Neither
side may crash, and neither may treat a partial message as a complete one.

## Run it

```
npm run examples -- --only 10
```

## Scenario 1 — the peer closes mid-response

The rule sets `disconnectAfterBytes: 40`, so the mock writes the first 40 bytes of its
response and then destroys the socket. The client receives something like:

```
SLTP/1.0 200 OK\r\nRequest-ID: req-1\r\nCont
```

That is a valid _prefix_. The start line is complete and parseable, one header is
complete, and the second is cut mid-name. There is no `\r\n\r\n`, so the header block
never ended, so there is no `Content-Length`, so the body length is unknown — and then
the connection ends.

The client must report a truncated read. Specifically it must **not**:

- parse the two headers it did receive and act as though the message were complete;
- treat `200 OK` as a successful response, because no complete response was received;
- hang forever waiting for bytes from a socket that is already closed.

The scenario asserts `expect.disconnect: true`, so this is the passing outcome.

## Scenario 2 — the client closes mid-request

The mirror image. The scenario's `transmission.disconnectAfterBytes: 30` stops the
client after 30 bytes of a longer request. The mock's decoder is left holding a
partial header block that will never be completed.

The mock must discard that buffer and release the connection's resources without
logging an error for an incomplete message. This is not an error condition — clients
disappear routinely, and a server that treated every abrupt disconnect as a fault
would produce unusable logs.

The rule `never-reached` exists to prove the point: it would match a complete
`ABORTED` request and answer `200 OK`. No response arrives, and the rule's `hitCount`
stays at zero — visible via `rule list` — confirming no message was ever framed from
those 30 bytes.

## Graceful versus abrupt close

TCP distinguishes two ways a connection ends, and an implementation has to handle
both:

|                | Graceful (`FIN`)        | Abrupt (`RST`)                                  |
| -------------- | ----------------------- | ----------------------------------------------- |
| Sent by        | `socket.end()`          | `socket.destroy()`, process crash, cable pulled |
| Node event     | `'end'`, then `'close'` | `'error'` (`ECONNRESET`), then `'close'`        |
| In-flight data | delivered first         | may be discarded                                |
| Meaning        | "I am done sending"     | "this connection is over now"                   |

A `FIN` is a promise about the future — the peer will send no more data — and it says
nothing about whether what it already sent was complete. So even a graceful close can
leave a half-written message in the buffer, which is exactly this example's case.

The implementation therefore treats a close during an incomplete message as a
truncation regardless of _how_ the connection ended. The distinction that matters is
"was a complete message framed?", not "was the close polite?".

`'close'` is the only event guaranteed to fire in both columns, so cleanup — clearing
the buffer, settling in-flight requests, removing the connection from the registry —
is attached there rather than to `'end'` or `'error'`. Attaching it to `'end'` would
leak every connection that reset.

## Settling in-flight requests

The client correlates responses by `Request-ID`, keeping a map of promises awaiting
replies. When the socket closes, every entry in that map is settled with a
close-reason error.

Without this, `await client.send(...)` on a dropped connection would never resolve or
reject. The promise would simply be abandoned, the caller would hang, and — because a
pending promise keeps its references alive — the request would leak. "Reject
everything outstanding on close" is what turns a dropped connection into a prompt,
diagnosable error instead of a silent hang.

## Why a testing tool needs to cause this on purpose

Truncation is genuinely common in production — process restarts during deploys,
container evictions, idle-timeout enforcement by load balancers, mobile clients
losing signal, `OOM` kills — and it is nearly impossible to reproduce by hand at a
chosen byte offset.

`disconnectAfterBytes` makes it deterministic. You can cut a response at byte 40 on
every run, which turns "it broke once in production and we could not reproduce it"
into a repeatable test case. Setting it just before and just after a structural
boundary is a quick way to find parsers that mishandle partial delimiters.
