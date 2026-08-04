# 07 — Delayed response

## What this demonstrates

A mock rule that waits before answering. The test still passes, because the delay is
within the scenario's timeout.

## Run it

```
npm run examples -- --only 7
```

## What you should see

The `SLOW_QUERY` rule holds its response for 400 ms; the scenario allows 3000 ms:

```
scenario  slow-but-within-timeout       PASSED   (passed, 409 ms)
```

The recorded duration is the point. 409 ms is not 1 ms, so the delay genuinely
happened on the wire rather than being simulated with a fake clock. The runner
asserts `durationMs >= 350`, which fails if the delay stops being honoured.

## Why a mock needs to be able to be slow

A mock that always answers instantly can only test the happy path. Latency is where a
large fraction of real integration bugs live:

- **Timeout tuning.** You cannot tell whether a 5-second timeout is right without
  being able to produce a 4.5-second response.
- **Concurrency.** A slow response is what makes overlapping work observable. Example
  11 uses a 600 ms delay for exactly this reason: while one client waits, another must
  be able to complete.
- **Ordering assumptions.** Code that happens to work when responses return in request
  order can break when they do not. Making one response slow reorders them.
- **Cancellation and retry.** Neither can be tested against a peer that has already
  answered.

## How the delay is implemented

`response.delayMs` is honoured by the mock endpoint _after_ the rule matches and
_before_ the response bytes are written. The socket stays open and idle for the
duration; nothing is buffered and nothing is sent early.

Response writes on a single connection are serialised through a promise chain, so a
delayed response cannot be overtaken by a later, faster one on the same connection.
That preserves per-connection ordering, which matters because a client reading a
stream must be able to rely on responses arriving in a defined order relative to each
other, even when their processing times differ.

Delays are capped at `MAX_RESPONSE_DELAY_MS` (60 s). A mock able to hold a connection
open indefinitely would be a resource-exhaustion tool rather than a testing one.

## The relationship to the timeout

Two independent numbers govern this exchange:

| Value              | Set by                                   | Here    |
| ------------------ | ---------------------------------------- | ------- |
| `response.delayMs` | the mock rule — how long the peer takes  | 400 ms  |
| `timeoutMs`        | the scenario — how long the client waits | 3000 ms |

`delayMs < timeoutMs` means a response arrives in time and assertions are evaluated
normally. Example 08 inverts the comparison, and the outcome changes completely.
