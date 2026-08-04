# SocketLens TCP — example scenarios

Eleven runnable examples, each demonstrating one property of SLTP over raw TCP. Every
example is checked by `examples/run-all.ts`, so if an example's README disagrees with
the implementation, the runner exits non-zero.

## Running them

```
npm run examples              # all eleven
npm run examples -- --only 6  # just one
npm run examples -- --list    # names and numbers
```

The runner starts its own SocketLens TCP server on an OS-assigned port, so it will not
collide with a server you already have running on 7420. Nothing is left behind.

Each example is also a plain bundle file you can drive through the CLI:

```
npm run start:server                                                # terminal 1
npm run cli -- session create --name demo                           # terminal 2
npm run cli -- run --file examples/06-coalesced-messages/bundle.json --raw
```

`run` installs the bundle's rules into the current session before executing its
scenarios, so there is no separate rule-loading step. `--raw` prints the exact bytes
in both directions.

## The examples

| #   | Example                                                   | Demonstrates                                                          |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| 01  | [Basic PING](01-basic-ping/)                              | The smallest complete SLTP exchange.                                  |
| 02  | [Session and rules](02-session-and-rule/)                 | Session isolation and deterministic rule ordering.                    |
| 03  | [Passing test](03-passing-test/)                          | Assertions, and why `Content-Length` counts bytes not characters.     |
| 04  | [Failing test](04-failing-test/)                          | Expected-versus-actual reporting, and why `211 TEST FAILED` is a 2xx. |
| 05  | [Fragmented message](05-fragmented-message/)              | One message in seven writes, with cuts inside delimiters.             |
| 06  | [Coalesced messages](06-coalesced-messages/)              | Two messages in one write.                                            |
| 07  | [Delayed response](07-delayed-response/)                  | A slow mock, still within the timeout.                                |
| 08  | [Timeout](08-timeout/)                                    | A timeout asserted as the expected outcome.                           |
| 09  | [Malformed Content-Length](09-malformed-content-length/)  | Unrecoverable framing faults and decoder poisoning.                   |
| 10  | [Disconnect during a message](10-disconnect-during-body/) | Truncation in both directions.                                        |
| 11  | [Two concurrent clients](11-concurrent-clients/)          | I/O concurrency, per-connection buffers, session isolation.           |

## Suggested reading order

**05 and 06 are the two that matter most.** Between them they make the project's
central claim observable:

- **05** sends _one_ message in _seven_ writes.
- **06** sends _two_ messages in _one_ write.

Both are normal TCP behaviour, and no code at the socket layer can tell them apart —
because at that layer there is nothing to tell apart. TCP guarantees a **reliable,
ordered byte stream** and nothing more. It does not preserve application message
boundaries, so every protocol built on it must define its own framing. SLTP uses a
`\r\n\r\n` header delimiter plus an explicit `Content-Length`, and examples 09 and 10
show what happens when that framing information is unusable or incomplete.

If you are reviewing this project and have time for two files, read those two.

## Why some examples are documented as failing

Examples 04, 08, and 10 do not produce a plain "passed":

| Example | Outcome                            | Why that is correct                                               |
| ------- | ---------------------------------- | ----------------------------------------------------------------- |
| 04      | test **fails**                     | It exists to show what a mismatch report looks like.              |
| 08      | **timeout**, asserted as a pass    | It exists to show that the client gives up on schedule.           |
| 10      | **disconnect**, asserted as a pass | It exists to show truncation is detected, not parsed as complete. |

The runner records a documented outcome for each scenario individually rather than
assuming everything should pass. Example 04 is registered as `passes: false` and would
make the runner fail if it ever started passing — because passing is not what it is
documented to do.

## Bundle format

Each example is a single `bundle.json` in the `socketlens-scenario-bundle/1` format,
carrying both its mock rules and its scenarios:

```json
{
  "format": "socketlens-scenario-bundle/1",
  "protocol": "SLTP/1.0",
  "name": "Basic PING",
  "description": "The smallest complete SLTP exchange.",
  "rules": [
    {
      "id": "ping-ok",
      "name": "Answer PING with pong",
      "priority": 10,
      "match": { "operation": "PING" },
      "response": { "statusCode": 200, "statusPhrase": "OK", "body": "..." }
    }
  ],
  "scenarios": [
    {
      "name": "basic-ping",
      "request": { "operation": "PING" },
      "transmission": { "mode": "single" },
      "timeoutMs": 2000,
      "expect": { "statusCode": 200, "statusPhrase": "OK" }
    }
  ]
}
```

`priority` orders rule evaluation from highest to lowest; rules of equal priority are
evaluated in the order they appear. The first match wins and evaluation stops, so the
outcome is deterministic and reproducible. Both `priority` and `name` are optional —
`priority` defaults to `0` — but the examples set them explicitly, because a bundle that
relies on declaration order alone is harder to read than one that states its intent.

`parseBundle` validates every rule and scenario and reports **all** problems at once
rather than stopping at the first, so a malformed bundle produces one useful error
list instead of a series of one-line complaints. It also accepts a bare single
scenario object, which is convenient for quick one-off tests.
