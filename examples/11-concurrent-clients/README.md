# 11 — Two concurrent clients

## What this demonstrates

Two clients, on two TCP connections, in two sessions, doing overlapping work. One is
deliberately slow; the other must finish while the first is still waiting.

This example has no single scenario, because a scenario describes one exchange on one
connection. It is driven by a function in `examples/run-all.ts` instead.

## Run it

```
npm run examples -- --only 11
```

## What you should see

```
ok    two sessions stayed isolated (ses-11 and ses-12)
ok    the fast client finished at 1 ms while the slow client ran until 616 ms
```

Both numbers matter:

- The two session identifiers **differ**. Each client got its own isolated state.
- The fast client finished at ~1 ms, while the slow client's 600 ms mock delay ran to
  ~616 ms. The work genuinely overlapped.

The runner fails if the fast client finishes _after_ the slow one, since that would
indicate the server had serialised the connections — handling one to completion
before starting the next. On a serialising server the fast client would finish at
~600 ms, and the whole demonstration would be void.

## What "concurrent" means for a single-threaded server

Node.js runs this server on one thread, and there are no worker threads anywhere in
the project. The concurrency here is **I/O concurrency**, not parallelism.

The 600 ms delay is not a busy-wait. It is a timer, and while it runs the thread is
free. The event loop is not blocked, so a `data` event on the second connection is
dispatched immediately:

```
t=0ms     conn A: RUN_TEST arrives → mock matches → setTimeout(600ms) → thread free
t=1ms     conn B: PING arrives     → mock matches → respond → conn B done
t=601ms   conn A: timer fires      → respond      → conn A done
```

One thread, two overlapping exchanges. This works because every operation the server
performs is I/O-bound — socket reads, socket writes, timers — and none of it occupies
the CPU for a meaningful interval. Adding threads would add complexity and shared-state
hazards while buying nothing, which is why the project does not.

The corollary is that a genuinely CPU-bound handler _would_ block every other
connection, since there is no other thread to run them. The event-driven model is a
good fit for this workload specifically because the workload is I/O.

## What must be per-connection

Concurrency is only safe if each connection owns its own state. The critical piece is
the **receive buffer**.

Each connection has its own `Buffer` accumulating partial messages. If they shared
one, client A's half-received request and client B's half-received request would
interleave in a single buffer, and the decoder would frame a "message" spliced from
both. The result would be corrupt data that depends on the exact interleaving of
network events — a bug that would appear only under load and would not reproduce.

Per connection, the server keeps:

- the receive buffer and decoder state
- the connection identifier used in logs
- the rate-limiter token bucket
- the set of in-flight requests

## What must be per-session

Sessions are a separate axis from connections. Each session owns:

- its own mock rules
- its own test results
- its own ephemeral TCP mock endpoint, on its own OS-assigned port

Both clients in this example install rules with the **same identifiers** — `slow-a`
and `fast-a` — into their respective sessions. Neither `409 RULE CONFLICT`s against
the other, because rule identifiers are scoped to a session. If rules were global,
the second client's `ADD_RULE` would collide with the first's, and two engineers
could not use one server without coordinating rule names.

Connections and sessions are deliberately decoupled: a session outlives the
connection that created it, and one connection may work with several sessions. That
means a dropped connection does not destroy the work configured through it.

## Failure isolation

A malformed message from one client closes **that** connection and nothing else.
Every per-connection handler is wrapped so that a thrown error is confined to its own
connection: the socket is destroyed, its resources are released, and other
connections continue undisturbed.

This is the practical requirement behind "one client must not be able to crash the
server". Without it, the malformed input from example 09 would take down every
connected client, and a single buggy client would become a denial of service against
everyone else.
