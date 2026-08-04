# 02 — Session and rules

## What this demonstrates

Sessions isolate state, and mock rules are matched in a defined order rather than
whichever order they happened to be added in.

## Run it

```
npm run examples -- --only 2
```

By hand:

```
npm run cli -- session create --name rules-demo
npm run cli -- run --file examples/02-session-and-rule/bundle.json
npm run cli -- rule list
```

## What you should see

Two rules installed, then two scenarios:

- `PING` matches **`ping-specific`**, not the catch-all, even though `*` also matches.
- `SERVER_INFO` matches **`catch-all`**, because nothing more specific applies.

The `Matched-Rule-ID` response header names the winner, which is why both scenarios
can assert on it directly.

## Why the ordering rule matters

`match: { "operation": "*" }` matches everything, so with unordered evaluation the
catch-all could swallow every request and the specific rule would be dead code. SLTP
avoids that by ordering rules **by priority descending, then by insertion order
ascending**:

```
ping-specific   priority 10   ← evaluated first
catch-all       priority  0
```

The first rule whose match specification is satisfied wins, and evaluation stops.
Insertion order is the tie-breaker, so two rules at the same priority still resolve
deterministically rather than depending on object key order or hash iteration.

This determinism is what makes a mock useful as a test fixture. A rule set that
resolved differently between runs would produce tests that fail intermittently for
reasons that have nothing to do with the code under test.

## Sessions

Each session owns its own rules, its own results, and its own ephemeral TCP mock
endpoint on an OS-assigned port. Two engineers can point their clients at one
SocketLens TCP server and configure contradictory mocks for the same operation
without interfering with each other, because a rule installed in one session is
invisible to another. Example 11 relies on exactly this property.
