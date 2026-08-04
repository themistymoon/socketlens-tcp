# 01 — Basic PING

## What this demonstrates

The smallest complete SLTP exchange: one request written in a single `socket.write()`,
one response framed and parsed from the bytes that come back.

## Run it

```
npm run examples -- --only 1
```

Or drive it by hand through the CLI. In one terminal:

```
npm run start:server
```

In another:

```
npm run cli -- session create --name ping-demo
npm run cli -- run --file examples/01-basic-ping/bundle.json --raw
```

`run` installs the bundle's rules into the current session before executing its
scenarios, so there is no separate rule-loading step.

## What you should see

A `PING` request and a `200 OK` response, both printed as raw bytes with `\r\n` made
visible:

```
SLTP/1.0 PING\r\n
Request-ID: req-1\r\n
\r\n
```

```
SLTP/1.0 200 OK\r\n
Request-ID: req-1\r\n
Matched-Rule-ID: ping-ok\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: 18\r\n
\r\n
{"message":"pong"}
```

The scenario reports `210 TEST PASSED` because all three assertions — status code,
status phrase, and the JSON body subset — matched.

## Why it matters for understanding TCP

This is the case where TCP's behaviour is invisible, and it is worth seeing first so
that the later examples have something to contrast against. The request is small
enough that the kernel almost always delivers it in one segment, so one `write()`
happens to produce one `data` event and one complete message.

**That is a coincidence, not a guarantee.** Nothing in TCP promises it. The same code
path that handles this example must also handle examples 05 and 06, where one write
arrives as several reads and two writes arrive as one. A parser that only works here
is a parser that will fail in production the first time a message crosses a segment
boundary.

Note also that `Content-Length: 18` counts **bytes**, not characters. For this ASCII
body the two numbers agree; example 03 uses a body where they do not.
