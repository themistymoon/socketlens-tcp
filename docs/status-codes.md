# SLTP/1.0 Status Codes

SLTP — the SocketLens Testing Protocol — is a text-based, CRLF-delimited, length-framed
application-layer protocol carried over a raw TCP byte stream via `node:net`. It is not
HTTP and is never layered on HTTP. The status codes below are defined by SLTP itself.
Their numeric ranges are deliberately familiar, because familiarity aids debugging, but
every meaning on this page is normative for SLTP alone. Several codes have no counterpart
in any other protocol at all: `210 TEST PASSED`, `211 TEST FAILED`, `410 NO MATCHING
RULE`, and the rule-lifecycle codes `212`–`214`.

The authoritative source is `SLTP_STATUS_REGISTRY` in
[`packages/protocol/src/status.ts`](../packages/protocol/src/status.ts). This document and
that table describe the same 23 codes and must stay in agreement.

---

## 1. The category scheme

A status code is three decimal digits. Its leading digit gives its category, and nothing
else does — `statusCategory()` derives the class from the digit alone:

| Range | Category     | Meaning                                                                                                                             |
| ----- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `2xx` | success      | The SLTP request was framed, validated, dispatched, and carried out.                                                                |
| `4xx` | client error | The request could not be carried out because of something in the request or in the state the client asked the server to operate on. |
| `5xx` | server error | The request could not be carried out because of a fault or a limit on the server side.                                              |

SLTP/1.0 defines no `1xx` and no `3xx` codes. The decoder's grammar accepts any code in
the range 100–599 in a response start line, so a mock rule may be configured to emit an
unregistered code on purpose — that is a deliberate testing capability, not an extension
point. `isRegisteredStatus()` distinguishes the two.

### The phrase is part of the protocol

Every response start line has the form:

```
SLTP/1.0 <code> <PHRASE>
```

The reason phrase is a fixed, uppercase, registered token — not free text and not a
human-authored message. `statusPhrase(code)` returns the canonical phrase for every
registered code, and the server always emits that phrase unless a handler deliberately
overrides it. A client may therefore match on the phrase as well as the code, and the
integration tests do. Two consequences follow:

- The phrase never carries the specific detail of a failure. That detail lives in the
  JSON body and, for framing and validation faults, in the machine-readable `Reason`
  header.
- An unregistered code still serialises: `statusPhrase()` falls back to `OK`,
  `CLIENT ERROR`, `SERVER ERROR`, or `UNKNOWN` for the class, so a response can always
  be written to the wire.

The decoder rejects a response start line whose phrase is missing
(`missing-status-phrase`) or which contains anything outside printable US-ASCII
(`invalid-status-phrase`). Both are fatal to the connection.

### Headers present on every response

These are added by the control server to every response it writes, whatever the status,
and are not repeated in the per-status sections below:

| Header           | Value                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Request-ID`     | The `Request-ID` of the request being answered, echoed verbatim. Omitted only when the request carried none — that is, when the fault was detected before or during the reading of that header. |
| `Server`         | `SocketLens-TCP/0.1.1`.                                                                                                                                                                         |
| `Timestamp`      | ISO 8601 instant at which the response was serialised.                                                                                                                                          |
| `Content-Type`   | `application/json; charset=utf-8`, present whenever a body is present.                                                                                                                          |
| `Content-Length` | UTF-8 byte length of the body, computed by the encoder and never taken from the caller.                                                                                                         |

Every response the control server produces carries a JSON body; there is no code for
which the control server writes a bodiless response. Responses written by a session's
mock endpoint carry whatever body the matched rule declares, which may be empty.

Because every response carries the `Request-ID` it answers, a client may keep several
requests in flight on one connection and correlate replies by identifier rather than by
arrival order. The server handles requests concurrently, so a slow `RUN_TEST` does not
block a `PING` that arrives behind it, and responses may therefore be interleaved.

---

## 2. Summary

| Code | Phrase                    | Category     | Meaning                                                                                                             |
| ---- | ------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| 200  | `OK`                      | success      | The operation succeeded; any requested data is in the body.                                                         |
| 201  | `SESSION CREATED`         | success      | A new testing session exists and its mock endpoint is listening.                                                    |
| 202  | `TEST ACCEPTED`           | success      | A scenario was validated and queued for asynchronous execution. Reserved; not reachable in v0.1.                    |
| 204  | `SESSION CLOSED`          | success      | The session moved to the closed state and its mock endpoint was shut down.                                          |
| 210  | `TEST PASSED`             | success      | A scenario executed and every assertion held.                                                                       |
| 211  | `TEST FAILED`             | success      | A scenario executed correctly at the protocol level but at least one assertion did not hold.                        |
| 212  | `RULE ADDED`              | success      | A mock rule was stored in the session.                                                                              |
| 213  | `RULE UPDATED`            | success      | An existing mock rule was replaced.                                                                                 |
| 214  | `RULE DELETED`            | success      | A mock rule was removed from the session.                                                                           |
| 400  | `BAD REQUEST`             | client error | The message could not be framed or parsed, or a required header was absent or malformed.                            |
| 404  | `SESSION NOT FOUND`       | client error | The `Session-ID` is well-formed but names no session.                                                               |
| 405  | `OPERATION NOT ALLOWED`   | client error | The operation is recognised but is not permitted in the current context.                                            |
| 406  | `RULE NOT FOUND`          | client error | No rule with the requested identifier exists in the session.                                                        |
| 407  | `RESULT NOT FOUND`        | client error | No stored result with the requested identifier exists in the session.                                               |
| 408  | `TEST TIMEOUT`            | client error | A scenario received no complete response within its timeout, and did not declare a timeout as its expected outcome. |
| 409  | `RULE CONFLICT`           | client error | The rule would collide with an existing rule and make matching non-deterministic.                                   |
| 410  | `NO MATCHING RULE`        | client error | A mock endpoint received a well-formed request that no enabled rule matched.                                        |
| 413  | `MESSAGE TOO LARGE`       | client error | A declared or observed size exceeded a configured limit.                                                            |
| 422  | `INVALID SCENARIO`        | client error | The body parsed as JSON but the scenario or rule it describes is semantically invalid.                              |
| 429  | `TOO MANY REQUESTS`       | client error | The connection exceeded its request rate allowance.                                                                 |
| 500  | `INTERNAL SERVER ERROR`   | server error | An unexpected fault occurred while handling a valid request.                                                        |
| 501  | `OPERATION NOT SUPPORTED` | server error | The start line was well-formed but names an operation that is not in the registry.                                  |
| 503  | `SERVER UNAVAILABLE`      | server error | The server is shutting down, or a capacity limit is exhausted.                                                      |

---

## 3. Fatal versus recoverable faults

This is the single most important distinction on this page, and it is not a property of
the status code. It is a property of the _reason_ — the specific fault — recorded in
`FATAL_REASONS` in [`packages/protocol/src/errors.ts`](../packages/protocol/src/errors.ts).
The same code, `400 BAD REQUEST`, may or may not close the connection depending on which
fault produced it.

### Why the distinction exists

TCP delivers a reliable, ordered stream of bytes. It does not preserve the boundaries of
application messages. SLTP recovers those boundaries by reading a header block up to
`CRLF CRLF` and then reading exactly `Content-Length` further bytes. The decoder's entire
ability to find where one message ends and the next begins rests on that arithmetic.

A fault is **fatal** when it destroys that arithmetic. Consider a `Content-Length` that is
malformed (`abc`), negative (`-1`), or duplicated (two `Content-Length` headers with
different values). The header block has been read successfully, so bytes after the
delimiter belong to a body — but the server cannot know how many. It cannot skip the body
to reach the next message, and it cannot treat the next byte as the start of a new
message, because it is far more likely to be body content. Every subsequent read would be
guesswork on top of a wrong offset, and each wrong message would produce another fault.
This failure mode is what the decoder calls **poisoning**: it sets `poisoned = true`,
discards its buffer, and ignores every further byte on that connection. The server writes
the error response, sets `Connection: close`, and closes the socket.

A fault is **recoverable** when the message was framed correctly and only its _contents_
were wrong. A missing `Request-ID`, an operation token that is not in the registry, a body
that is not valid JSON, a body present on an operation that forbids one — in every one of
these cases the decoder already consumed exactly the right number of bytes and the next
byte in the buffer really is the first byte of the next message. The stream is still
synchronised, so the server answers with a status and keeps reading. The client may send
its next request on the same connection.

### The fatal reasons

Any of these closes the connection, whichever status it maps to:

| Reason                         | Status | Why the stream is unrecoverable                                                                                                                                                                                                                         |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty-start-line`             | 400    | No start line means no message shape at all.                                                                                                                                                                                                            |
| `malformed-start-line`         | 400    | Neither an operation nor a status code could be read.                                                                                                                                                                                                   |
| `unsupported-protocol-version` | 400    | The peer is not speaking SLTP/1.0; nothing after this can be interpreted.                                                                                                                                                                               |
| `invalid-operation-token`      | 400    | The start line is unparseable, so the header block boundary cannot be trusted.                                                                                                                                                                          |
| `invalid-status-code`          | 400    | As above, for a response start line.                                                                                                                                                                                                                    |
| `missing-status-phrase`        | 400    | As above.                                                                                                                                                                                                                                               |
| `invalid-status-phrase`        | 400    | As above.                                                                                                                                                                                                                                               |
| `bare-line-feed`               | 400    | A bare LF means line boundaries are ambiguous throughout the header block.                                                                                                                                                                              |
| `bare-carriage-return`         | 400    | As above, for a bare CR.                                                                                                                                                                                                                                |
| `obsolete-line-folding`        | 400    | A continuation line makes header boundaries ambiguous.                                                                                                                                                                                                  |
| `malformed-header-line`        | 400    | A line with no `:` separator cannot be assigned a name or a value.                                                                                                                                                                                      |
| `invalid-header-name`          | 400    | The header block does not parse.                                                                                                                                                                                                                        |
| `invalid-header-value`         | 400    | The header block does not parse.                                                                                                                                                                                                                        |
| `duplicate-header`             | 400    | `Content-Length`, `Content-Type`, `Request-ID`, and `Session-ID` may appear at most once. A duplicate `Content-Length` makes the body length ambiguous; the others make routing ambiguous. Rejected outright rather than resolved by a precedence rule. |
| `invalid-content-length`       | 400    | The body length is unknowable, so the end of the message is unknowable.                                                                                                                                                                                 |
| `negative-content-length`      | 400    | As above.                                                                                                                                                                                                                                               |
| `content-length-too-large`     | 413    | The declared body cannot be buffered and the bytes it claims cannot be skipped.                                                                                                                                                                         |
| `start-line-too-large`         | 413    | The oversized bytes are still in the stream and cannot be safely discarded.                                                                                                                                                                             |
| `header-block-too-large`       | 413    | As above.                                                                                                                                                                                                                                               |
| `too-many-headers`             | 413    | As above.                                                                                                                                                                                                                                               |
| `message-too-large`            | 413    | As above.                                                                                                                                                                                                                                               |
| `truncated-message`            | 400    | The peer stopped mid-message. Reported when the connection ends with bytes still buffered.                                                                                                                                                              |
| `unexpected-message-kind`      | 400    | A response arrived where a request was expected, or vice versa; the peer's role is wrong.                                                                                                                                                               |

### The recoverable reasons

None of these closes the connection:

| Reason                  | Status | Detected by                                                                 |
| ----------------------- | ------ | --------------------------------------------------------------------------- |
| `missing-request-id`    | 400    | `validateRequest` step 1                                                    |
| `invalid-request-id`    | 400    | `validateRequest` step 1                                                    |
| `unknown-operation`     | 501    | `validateRequest` step 2                                                    |
| `unexpected-body`       | 400    | `validateRequest` step 3                                                    |
| `missing-body`          | 400    | `validateRequest` step 3                                                    |
| `missing-session-id`    | 400    | `validateRequest` step 4                                                    |
| `invalid-session-id`    | 400    | `validateRequest` step 4                                                    |
| `invalid-json-body`     | 400    | `validateRequest` step 5                                                    |
| `invalid-body-shape`    | 422    | `expectJsonObject`                                                          |
| `rate-limited`          | 429    | Per-connection token bucket                                                 |
| `server-shutting-down`  | 503    | Server lifecycle (closes the connection for a different reason — see §4.23) |
| `session-limit-reached` | 503    | Session store                                                               |

The order in that first group is normative. `validateRequest` applies its checks in a
fixed sequence — `Request-ID`, operation registration, body presence, session scope, body
parseability — so a request with several faults always reports the same one, and a client
fixing faults one at a time sees them in a stable order.

### Reading it from the wire

A fatal response is identifiable without knowing this table: it carries
`Connection: close`. Any error response derived from the framing taxonomy also carries a
`Reason` header with a stable machine-readable code from `SLTP_REASON`, which is the value
a client should branch on rather than parsing the human-readable message in the body.

---

## 4. The registry in detail

### 4.1 · 200 OK

|                |               |
| -------------- | ------------- |
| **Phrase**     | `OK`          |
| **Category**   | success (2xx) |
| **Connection** | stays open    |
| **Body**       | present, JSON |

The operation succeeded and any data it was asked for is in the body.

**Emitted for** the seven read and probe operations: `PING`, `SERVER_INFO`,
`GET_SESSION`, `LIST_SESSIONS`, `LIST_RULES`, `GET_RESULT`, and `LIST_RESULTS`. No other
operation returns 200; each mutating operation has its own code.

**Body** depends on the operation:

- `PING` — `message: "pong"`, `protocol`, `serverTime`, `uptimeMs`, and `echo` reflected
  back when the request body supplied one.
- `SERVER_INFO` — `product`, `protocol`, `control` address, `uptimeMs`, the configured
  `limits`, the full `operations` registry, the full `statuses` registry as
  code/phrase/category triples, live `counts`, and the `capabilities` list.
- `GET_SESSION` — `{ session }`, including the session's mock endpoint host and port.
- `LIST_SESSIONS` — `{ count, sessions }`.
- `LIST_RULES` — `{ count, evaluationOrder, rules }`. The array is in the exact order the
  matcher evaluates, and `evaluationOrder` states the rule in words: priority descending,
  then insertion sequence ascending.
- `GET_RESULT` — `{ result }`, the full stored result.
- `LIST_RESULTS` — `{ count, passed, failed, results }`, where each entry is a summary
  rather than a full result.

**Status-specific headers.** `GET_RESULT` additionally sets `Result-ID` to the identifier
of the returned result.

---

### 4.2 · 201 SESSION CREATED

|                |                   |
| -------------- | ----------------- |
| **Phrase**     | `SESSION CREATED` |
| **Category**   | success (2xx)     |
| **Connection** | stays open        |
| **Body**       | present, JSON     |

A new testing session exists and its dedicated TCP mock endpoint is listening.

**Emitted for** `CREATE_SESSION` only, and only once the mock endpoint has successfully
bound a port. The endpoint must be listening before the session is announced, because the
response carries the port a scenario will later connect to. If the endpoint cannot be
started, the request is answered `500 INTERNAL SERVER ERROR` instead; if the active
session limit is already reached, `503 SERVER UNAVAILABLE`.

**Body** is `{ session }`, carrying the identifier, name, description, state,
`createdAt`/`updatedAt`, the `mockHost` and `mockPort` of the endpoint, and the rule and
result counts.

**Status-specific headers.** `Session-ID`, repeating the new session's identifier so a
client can read it from the header block without parsing the body.

---

### 4.3 · 202 TEST ACCEPTED

|                |                 |
| -------------- | --------------- |
| **Phrase**     | `TEST ACCEPTED` |
| **Category**   | success (2xx)   |
| **Connection** | stays open      |
| **Body**       | present, JSON   |

A test scenario was validated and queued for asynchronous execution. The `Result-ID`
header identifies the pending result, which is later retrieved with `GET_RESULT`.

**Not reachable in v0.1.** The code is registered and is listed among `RUN_TEST`'s success
statuses, but asynchronous execution is not implemented. `RUN_TEST` is always synchronous
and answers only `210`, `211`, or `408`; no code path inspects a `"mode": "async"` field.
This is recorded as a known gap in
[`docs/requirements.md`](./requirements.md) §4.3. Read the registry entry as a
reservation, not as a capability. A client should not wait for it, and a server
implementing it later must keep the meaning described here.

**Status-specific headers.** `Result-ID`, when it is emitted.

---

### 4.4 · 204 SESSION CLOSED

|                |                  |
| -------------- | ---------------- |
| **Phrase**     | `SESSION CLOSED` |
| **Category**   | success (2xx)    |
| **Connection** | stays open       |
| **Body**       | present, JSON    |

The session moved to the closed state, its mock endpoint was shut down and its open
connections destroyed, and its rules stopped matching. The session record is retained, so
stored results remain readable through `GET_RESULT` and `LIST_RESULTS` after the close.

**Emitted for** `CLOSE_SESSION` only, and only when the session exists and is still
active. Closing an already-closed session is `405 OPERATION NOT ALLOWED`; closing an
unknown one is `404 SESSION NOT FOUND`.

**Body** is present and carries `{ session }` in its final state, including `closedAt`.
An SLTP 204 response carries a body; the code does not imply an empty one, and the framing
is exactly the same as for any other status.

**Connection.** Closing a session does not close the TCP connection that requested it.
The control connection and the session are independent: one connection may create, drive,
and close many sessions.

---

### 4.5 · 210 TEST PASSED

|                |               |
| -------------- | ------------- |
| **Phrase**     | `TEST PASSED` |
| **Category**   | success (2xx) |
| **Connection** | stays open    |
| **Body**       | present, JSON |

A test scenario executed over a real TCP connection and every assertion held.

**Emitted for** `RUN_TEST` in synchronous mode, when `result.passed` is true — that is,
when `evaluateExchange` returned the outcome `passed`.

Note one case that is easy to misread: a scenario that declares `expect.timeout: true` and
then genuinely times out is answered `210 TEST PASSED`, not `408`. The scenario asserted
that no response would arrive, and no response arrived, so the assertion held. The same
applies to `expect.disconnect: true` against a peer that closes mid-message.

**Body** is `{ result }` — the full result, including the outcome, every assertion with
its expected and actual values, the duration, the raw bytes sent and received as UTF-8
text, the per-segment wire trace with timestamps and byte counts, and the sent/received
segment counts. That segment trace is the direct evidence of how the message was split on
the wire, which is the reason the tool exists.

**Status-specific headers.** `Result-ID`, always. `Matched-Rule-ID`, when the response
came back from a mock rule that identified itself.

---

### 4.6 · 211 TEST FAILED

|                |               |
| -------------- | ------------- |
| **Phrase**     | `TEST FAILED` |
| **Category**   | success (2xx) |
| **Connection** | stays open    |
| **Body**       | present, JSON |

A test scenario executed correctly at the protocol level, but at least one assertion did
not hold.

**Emitted for** `RUN_TEST` in synchronous mode, when the scenario ran to completion and
`result.passed` is false for any reason other than an unexpected timeout — a status code
that did not match, a phrase that did not match, an absent or differing header, a body
mismatch, a JSON subset that was not satisfied, or a peer that closed mid-message when
the scenario did not expect it to.

**Body** is `{ result }`, the same full structure as for 210. Every assertion is listed,
passed and failed alike, each with its `field`, `expected`, `actual`, and an explanatory
`message` on the ones that failed — so the client sees which part of the expectation was
wrong rather than only that something was.

**Status-specific headers.** `Result-ID`, always; `Matched-Rule-ID`, when present.

#### Why 210 and 211 are both 2xx

This is the point most likely to be misread, so it is stated plainly: **the status
describes the outcome of the SLTP request, not the verdict of the test.**

`RUN_TEST` asks the server to execute a scenario and report what happened. In both cases
the server did exactly that. The request was framed correctly, validated, dispatched to a
handler, executed against a real TCP endpoint, evaluated against the scenario's
expectations, and stored. Nothing about the exchange went wrong. A test whose assertions
did not hold is a **successfully executed test with a negative verdict** — the tool
working as intended and telling the user something true about the system under test. That
is a 2xx outcome, and encoding it as an error would be a category mistake: it would
conflate "your request was bad" with "your expectation was wrong."

The practical consequence for a client is that `210` and `211` are both _answers_, and
both carry a complete `result` object. A client should branch on the code to report the
verdict, but should not treat `211` as an error condition, retry it, or fall back. Test
harnesses that map SLTP statuses onto process exit codes should map the verdict from
`result.passed`, not from the success/error class of the status.

Contrast this with `422 INVALID SCENARIO`. A 422 means the scenario **could not be
executed at all**: the body parsed as JSON, but the object it described was not a runnable
scenario — a negative timeout, an empty fragment size list, a `fragmented` transmission
with neither `fragmentSizes` nor `fragmentCount`, contradictory expectations such as
`expect.timeout` together with `expect.statusCode`. Nothing ran, no TCP connection was
opened, no result was stored, and there is no verdict to report. The difference is between
a test that produced an answer the client did not want (`211`) and a test that never
became a test (`422`).

---

### 4.7 · 212 RULE ADDED

|                |               |
| -------------- | ------------- |
| **Phrase**     | `RULE ADDED`  |
| **Category**   | success (2xx) |
| **Connection** | stays open    |
| **Body**       | present, JSON |

A mock rule was stored in the session and takes effect immediately — the endpoint reads
the rule set fresh on every request, so no restart or reconnection is needed.

**Emitted for** `ADD_RULE` only, when the body passed semantic validation and no conflict
was found against the existing rules.

**Body** is `{ rule }`, the stored rule as the server holds it: the identifier (generated
when the client did not supply one), name, `enabled`, `priority`, the match specification,
the response specification, timestamps, the insertion `sequence` used as the matching
tie-breaker, and a `hitCount` starting at zero.

**Status-specific headers.** `Matched-Rule-ID`, carrying the identifier of the newly
stored rule.

---

### 4.8 · 213 RULE UPDATED

|                |                |
| -------------- | -------------- |
| **Phrase**     | `RULE UPDATED` |
| **Category**   | success (2xx)  |
| **Connection** | stays open     |
| **Body**       | present, JSON  |

An existing mock rule was replaced. `UPDATE_RULE` takes a patch: only the fields present
in the body change, and the rule's identifier, creation time, sequence, and hit count are
preserved.

**Emitted for** `UPDATE_RULE` only, when the rule exists, the patch changes at least one
field, and the result does not conflict with another rule. A patch that changes nothing is
rejected as `422 INVALID SCENARIO`, because a no-op update is more likely a mistake than
an intention.

**Body** is `{ rule }`, the rule after the update.

**Status-specific headers.** `Matched-Rule-ID`, carrying the updated rule's identifier.

---

### 4.9 · 214 RULE DELETED

|                |                |
| -------------- | -------------- |
| **Phrase**     | `RULE DELETED` |
| **Category**   | success (2xx)  |
| **Connection** | stays open     |
| **Body**       | present, JSON  |

A mock rule was removed from the session and will no longer be evaluated.

**Emitted for** `DELETE_RULE` only, when the session is active and a rule with the
requested identifier exists.

**Body** is `{ deleted, name }` — the identifier that was removed and the rule's name.
Unlike 212 and 213, the full rule object is not returned; the rule no longer exists.

**Status-specific headers.** None.

---

### 4.10 · 400 BAD REQUEST

|                |                                   |
| -------------- | --------------------------------- |
| **Phrase**     | `BAD REQUEST`                     |
| **Category**   | client error (4xx)                |
| **Connection** | **depends on the fault** — see §3 |
| **Body**       | present, JSON                     |

The message could not be framed or parsed, or a required header was absent or malformed.
400 is the default status for the framing and validation taxonomy: any reason that is not
a size limit, an unknown operation, a rate limit, a shutdown, a session limit, or a body
shape violation maps here.

**Emitted for** any request, on any connection, including at a session's mock endpoint.
The specific conditions are the union of two groups:

_Fatal — the connection is closed after the response is written:_ an empty or malformed
start line; an unsupported protocol version token; an invalid operation token; a bare LF
or bare CR in the header block; obsolete line folding; a header line with no `:`; an
invalid header name or value; a duplicated `Content-Length`, `Content-Type`, `Request-ID`,
or `Session-ID`; a `Content-Length` that is not an unsigned decimal integer; a negative
`Content-Length`; a connection that ended mid-message; and a response arriving where a
request was expected.

_Recoverable — the connection stays open:_ a missing `Request-ID`; a `Request-ID` or
`Session-ID` that does not match `[A-Za-z0-9._:-]{1,64}`; a missing `Session-ID` on a
session-scoped operation; a body on an operation that permits none; a missing body on an
operation that requires one; and a body that is not valid JSON.

A handler may also answer 400 for a body that parsed as JSON but is not an object where
one is required, or that lacks a required string field — `DELETE_RULE` and `GET_RESULT`
without an `"id"` string, for instance. These are recoverable.

**Body** is `{ error, reason }` for faults from the framing taxonomy, where `error` is the
human-readable explanation and `reason` repeats the machine-readable code. For the
handler-level checks above, the body is `{ error }` with no `reason` field.

**Status-specific headers.**

- `Reason` — the stable machine-readable code from `SLTP_REASON`, present on every 400
  raised by the decoder or by `validateRequest`. Branch on this, not on the message text.
  It is absent on the handler-level 400s described above.
- `Connection: close` — present on fatal faults only, and it is the reliable wire-level
  signal that the server is about to close.

---

### 4.11 · 404 SESSION NOT FOUND

|                |                     |
| -------------- | ------------------- |
| **Phrase**     | `SESSION NOT FOUND` |
| **Category**   | client error (4xx)  |
| **Connection** | stays open          |
| **Body**       | present, JSON       |

The `Session-ID` header is syntactically valid but no session with that identifier exists.

**Emitted for** any session-scoped operation whose lookup misses: `GET_SESSION`,
`ADD_RULE`, `UPDATE_RULE`, `DELETE_RULE`, `LIST_RULES`, `RUN_TEST`, `GET_RESULT`,
`LIST_RESULTS`, and `CLOSE_SESSION`.

Note the ordering. A `Session-ID` that is absent or does not match the identifier grammar
is a protocol-level fault and yields `400 BAD REQUEST` from `validateRequest` before any
handler runs. 404 means the header was well-formed and the server looked, so the client
knows the problem is state, not syntax. A session that exists but is closed yields
`405 OPERATION NOT ALLOWED`, not 404 — closed sessions remain readable.

**Body** is `{ error, status }`, where `error` names the identifier that was not found.

**Status-specific headers.** None.

---

### 4.12 · 405 OPERATION NOT ALLOWED

|                |                         |
| -------------- | ----------------------- |
| **Phrase**     | `OPERATION NOT ALLOWED` |
| **Category**   | client error (4xx)      |
| **Connection** | stays open              |
| **Body**       | present, JSON           |

The operation is registered and the request is well-formed, but it is not permitted in the
current context. The distinction from `501` is exact: `501` means the server does not know
the operation at all; `405` means it knows it and refuses it here and now.

**Emitted for** two conditions, both of which concern a closed session:

- `CLOSE_SESSION` on a session that is already closed.
- Any operation requiring an _active_ session, applied to a closed one — `ADD_RULE`,
  `UPDATE_RULE`, `DELETE_RULE`, and `RUN_TEST`. Closed sessions are read-only, so the
  read operations `GET_SESSION`, `LIST_RULES`, `GET_RESULT`, and `LIST_RESULTS` continue
  to succeed against them.

The registry's description of this code also anticipates a control operation sent to a
session's mock endpoint. That case does not arise in v0.1: a mock endpoint validates with
`allowUnknownOperation: true` and answers according to its rules, so an unmatched control
operation there produces `410 NO MATCHING RULE` rather than 405.

**Body** is `{ error, status }`, stating which session is closed.

**Status-specific headers.** None.

---

### 4.13 · 406 RULE NOT FOUND

|                |                    |
| -------------- | ------------------ |
| **Phrase**     | `RULE NOT FOUND`   |
| **Category**   | client error (4xx) |
| **Connection** | stays open         |
| **Body**       | present, JSON      |

No mock rule with the requested identifier exists in the session. The session itself
exists and is active; only the rule is missing.

**Emitted for** `UPDATE_RULE` and `DELETE_RULE`, after the session has been resolved and
found active. If the session does not exist the answer is `404`; if it is closed, `405`.

**Body** is `{ error, status }`, naming the session and the rule identifier.

**Status-specific headers.** None.

---

### 4.14 · 407 RESULT NOT FOUND

|                |                    |
| -------------- | ------------------ |
| **Phrase**     | `RESULT NOT FOUND` |
| **Category**   | client error (4xx) |
| **Connection** | stays open         |
| **Body**       | present, JSON      |

No stored test result with the requested identifier exists in the session.

**Emitted for** `GET_RESULT` only. Note that results are capped per session and the oldest
are evicted once the cap is reached, so a result identifier that was valid earlier in a
long-running session may later produce 407.

**Body** is `{ error, status }`, naming the session and the result identifier.

**Status-specific headers.** None.

---

### 4.15 · 408 TEST TIMEOUT

|                |                    |
| -------------- | ------------------ |
| **Phrase**     | `TEST TIMEOUT`     |
| **Category**   | client error (4xx) |
| **Connection** | stays open         |
| **Body**       | present, JSON      |

A test scenario did not receive a complete SLTP response from its target within the
scenario's timeout, and the scenario did not declare a timeout as its expected outcome.

**Emitted for** `RUN_TEST` only. It is never sent for a control request: it reports the
timing out of the _scenario's_ TCP exchange with its target, not of the control exchange
between the client and the control server. The control server does not time out its own
connections.

The precise condition is that the evaluated outcome is `timeout` — no complete response
was framed before `timeoutMs` elapsed (defaulting to 5000 ms), and `expect.timeout` was
not set to `true`. **If a timeout was expected, the answer is `210 TEST PASSED` instead.**

The categorisation as a client error is deliberate: from SLTP's point of view the client
declared an expectation about the target's behaviour, and the target did not meet it
within the window the client chose. Either the target is slow or the window was too short.

**Body** is `{ result }`, the same full result structure as `210`/`211`, with
`outcome: "timeout"` and an assertion on the `response` field recording that nothing
arrived. The result is stored and remains retrievable with `GET_RESULT`.

**Status-specific headers.** `Result-ID`.

---

### 4.16 · 409 RULE CONFLICT

|                |                    |
| -------------- | ------------------ |
| **Phrase**     | `RULE CONFLICT`    |
| **Category**   | client error (4xx) |
| **Connection** | stays open         |
| **Body**       | present, JSON      |

The rule would collide with an existing rule in a way that makes the session's behaviour
ambiguous.

**Emitted for** `ADD_RULE` and `UPDATE_RULE`, on exactly three conditions:

1. **Duplicate identifier.** The client supplied an `id` that another rule in the session
   already uses. (`ADD_RULE` only; `UPDATE_RULE` addresses an existing rule by `id`.)
2. **Duplicate name.** Another rule in the session already has that name. Rule names are
   unique within a session so that a user can refer to a rule by name unambiguously.
3. **Equivalent match at the same priority.** An existing _enabled_ rule has the same
   priority and a match specification that would fire on exactly the same requests —
   compared by canonical form, so header order and equivalent spellings do not disguise
   the collision. Only enabled rules are considered on both sides; a disabled rule never
   conflicts.

The third case is the important one. Matching resolves ties by insertion sequence, so the
server _could_ pick one silently. It refuses instead, because a mock whose response
depends on the order rules happened to be created is useless for reproducing a bug. The
message names the colliding rule and suggests the three ways out: change the priority,
narrow the match, or disable the existing rule.

**Body** is `{ error, status }`, naming the colliding rule and the priority at which the
collision occurs.

**Status-specific headers.** None.

---

### 4.17 · 410 NO MATCHING RULE

|                |                    |
| -------------- | ------------------ |
| **Phrase**     | `NO MATCHING RULE` |
| **Category**   | client error (4xx) |
| **Connection** | stays open         |
| **Body**       | present, JSON      |

**Emitted by a session's mock endpoint when a well-formed request arrives that no enabled
rule matches**, and the session defines no default response.

This code is emitted by mock endpoints only. **The control server never sends it.** If a
client sees a 410, the response came from a session's own TCP listener, not from the
control port.

The precise condition is that `matchRule` walked the session's rule set in evaluation
order — priority descending, then insertion sequence ascending — skipping disabled rules,
and reached the end without a rule whose match specification was satisfied. Rules are read
fresh on every request, so a rule added a moment earlier is already in effect.

410 reports an **unconfigured mock, not a missing session**. The session exists, it is
active, its endpoint is listening, and it received and successfully framed the request.
What it lacks is a rule that says what to answer. Distinguishing this from `404 SESSION
NOT FOUND` is the whole point of having a separate code: a client that receives 410 should
add or fix a rule, whereas a 404 means the session identifier itself is wrong.

**Body** is `{ error }`, naming the operation that went unmatched and the number of rules
that were evaluated in reaching that conclusion — which is the first thing to check when a
rule was expected to fire and did not.

**Status-specific headers.** None. In particular, no `Matched-Rule-ID`, since no rule
matched.

---

### 4.18 · 413 MESSAGE TOO LARGE

|                |                     |
| -------------- | ------------------- |
| **Phrase**     | `MESSAGE TOO LARGE` |
| **Category**   | client error (4xx)  |
| **Connection** | **always closed**   |
| **Body**       | present, JSON       |

A declared or observed size exceeded a configured limit.

**Emitted for** any request, on either the control server or a mock endpoint, on five
conditions. The defaults come from `DEFAULT_LIMITS`:

| Condition                                                                                                         | Reason code                | Default limit   |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------- |
| Total message size, header block plus delimiter plus body, would exceed the maximum                               | `message-too-large`        | 1 048 576 bytes |
| `Content-Length` alone exceeds the maximum message size, or is not a safe integer                                 | `content-length-too-large` | 1 048 576 bytes |
| The header block exceeds its limit, either as parsed or as buffered without a `CRLF CRLF` delimiter ever arriving | `header-block-too-large`   | 16 384 bytes    |
| The start line alone exceeds its limit                                                                            | `start-line-too-large`     | 1 024 bytes     |
| The message carries more header fields than permitted                                                             | `too-many-headers`         | 64              |

The header-block limit does double duty: it also bounds memory on a peer that opens a
connection and streams bytes forever without ever sending a delimiter.

**Connection.** 413 is **always fatal**. All five reasons are in `FATAL_REASONS`, so the
server writes the response and closes. The justification is the same as in §3: the
remaining bytes of the oversized message are still in the stream and there is no safe
number of them to skip, so the connection cannot be resynchronised at a message boundary.
This is the only registered status that closes the connection unconditionally.

**Body** is `{ error, reason }`, stating the limit and the observed or declared size.

**Status-specific headers.** `Reason` (one of the five codes above) and `Connection: close`.

---

### 4.19 · 422 INVALID SCENARIO

|                |                    |
| -------------- | ------------------ |
| **Phrase**     | `INVALID SCENARIO` |
| **Category**   | client error (4xx) |
| **Connection** | stays open         |
| **Body**       | present, JSON      |

The request was well-formed SLTP and the JSON body parsed, but the scenario or rule it
describes is semantically invalid. The fault is in the meaning of the content, not in its
syntax — which is exactly why it is a distinct code from `400`.

**Emitted for** `RUN_TEST`, `ADD_RULE`, and `UPDATE_RULE`. Representative conditions:

- _Scenarios:_ a missing or empty `name`; a `request` that supplies neither `operation`
  nor `raw`; an invalid operation token; a `timeoutMs` that is not a positive integer or
  exceeds 120 000 ms; a `target.port` outside 1–65535; a `transmission.mode` outside
  `single`/`fragmented`/`coalesced`; mode `fragmented` with neither `fragmentSizes` nor
  `fragmentCount`; mode `coalesced` without `coalesceWith`; an empty `fragmentSizes`
  array, or one containing a non-positive entry, or more than 256 entries; a
  `fragmentCount` below 2 or above 256; a negative delay, or one exceeding 60 000 ms.
- _Contradictory expectations:_ `expect.timeout` with `expect.statusCode` (a timeout means
  no response arrived, so there is no status to assert); `expect.timeout` with
  `expect.disconnect`; `expect.disconnect` with `expect.statusCode`; `expect.body`
  together with `expect.bodyContains`. These are refused rather than silently resolved,
  because a scenario that cannot be satisfied under any behaviour of the target is a
  mistake, not a test.
- _Rules:_ a missing or empty `name`; an `id` not matching `[A-Za-z0-9._:-]{1,64}`; a
  non-boolean `enabled` or non-integer `priority`; a `match.operation` that is neither
  `*` nor a valid operation token; a `match.body.mode` outside the four supported modes; a
  `regex` body matcher that does not compile; a `json-subset` matcher that is not valid
  JSON; a `response.statusCode` outside 100–599; an empty or non-ASCII
  `response.statusPhrase`; a header name or value outside the SLTP grammar; a
  `response.body` that is not a string.
- _Limits and no-ops:_ a session that already holds the maximum number of rules; an
  `UPDATE_RULE` patch that changes no field.
- A parsed JSON body that is not an object at the top level maps here via the
  `invalid-body-shape` reason.

**Body** is `{ error, problems }`, where `problems` is an array listing **every** semantic
problem found, not just the first. Validators accumulate rather than throwing, so a client
fixing a scenario sees all of its mistakes in one round trip.

**Status-specific headers.** None.

See §4.6 for the distinction between a 422 — a scenario that never became a test — and a
`211`, a test that ran and returned a negative verdict.

---

### 4.20 · 429 TOO MANY REQUESTS

|                |                     |
| -------------- | ------------------- |
| **Phrase**     | `TOO MANY REQUESTS` |
| **Category**   | client error (4xx)  |
| **Connection** | stays open          |
| **Body**       | present, JSON       |

The connection exceeded its request rate allowance.

**Emitted for** any request on a connection whose token bucket is empty. Each connection
owns its own bucket, independent of every other connection; there is no global limit. The
default allows a burst of 120 requests and refills at 60 per second. The limit exists to
catch a runaway loop, not to throttle a user, and it can be disabled entirely at server
start.

The check runs early — after the shutdown check and before validation — so a rate-limited
request is never dispatched to a handler and never mutates state.

**Body** is `{ error, retryAfterMs }`, stating the capacity that was exceeded and the
delay before retrying.

**Status-specific headers.**

- `Retry-After` — the delay **in milliseconds**, computed from the bucket's refill rate as
  the time until at least one token is available, with a floor of 1 ms. Note the unit:
  milliseconds, not seconds. A client should wait this long before its next request on
  this connection.
- `Reason: rate-limited`.

**Connection.** 429 is recoverable and the connection stays open. The framing was never in
question — the message was decoded successfully and only then refused — so the client may
retry on the same connection after the stated delay.

---

### 4.21 · 500 INTERNAL SERVER ERROR

|                |                         |
| -------------- | ----------------------- |
| **Phrase**     | `INTERNAL SERVER ERROR` |
| **Category**   | server error (5xx)      |
| **Connection** | stays open              |
| **Body**       | present, JSON           |

An unexpected fault occurred while handling a valid request. The request was the client's
to make and there is nothing for the client to correct; a 500 is a server bug.

**Emitted for** any request, on four paths:

- A handler threw. `dispatch` catches every exception, logs it, and answers 500. Nothing a
  client sends can take the process down.
- `CREATE_SESSION` could not start a mock endpoint for the new session — for example the
  operating system refused to bind a port.
- The server could not encode its own response. This should be impossible; if it happens,
  the failure is logged and a minimal 500 the client can still parse is sent in place of
  the intended response.
- At a mock endpoint, a matched rule produced a response that the encoder refused to
  serialise.

**Body** is `{ error }`, carrying a description of the fault. The tool is a local
development instrument, so the message is included rather than suppressed.

**Connection.** The connection stays open and the server stays available. A 500 is
contained to the one request that caused it: the byte stream is unaffected, so there is no
framing reason to close, and other in-flight requests on the same connection continue
normally.

---

### 4.22 · 501 OPERATION NOT SUPPORTED

|                |                           |
| -------------- | ------------------------- |
| **Phrase**     | `OPERATION NOT SUPPORTED` |
| **Category**   | server error (5xx)        |
| **Connection** | stays open                |
| **Body**       | present, JSON             |

**A well-formed request naming an operation that is not in the registry.**

The start line parsed cleanly and the operation token matched the grammar
`[A-Z][A-Z0-9_]{0,31}` — the message is entirely valid SLTP. The token simply is not one
of the thirteen operations SLTP/1.0 registers (`PING`, `SERVER_INFO`, `CREATE_SESSION`,
`GET_SESSION`, `LIST_SESSIONS`, `ADD_RULE`, `UPDATE_RULE`, `DELETE_RULE`, `LIST_RULES`,
`RUN_TEST`, `GET_RESULT`, `LIST_RESULTS`, `CLOSE_SESSION`), or is registered but not
implemented by this server.

Three neighbouring cases are worth separating:

- A token that does **not** match the grammar — lowercase, leading digit, punctuation,
  over 32 characters — is a framing fault, `invalid-operation-token`, and yields a **fatal
  `400`** that closes the connection. The start line could not be parsed, so the message
  boundary cannot be trusted.
- A token that matches the grammar but is unregistered is this code, `501`, and is
  **recoverable**. The message framed correctly, so the stream is still synchronised and
  the client may send its next request on the same connection.
- A registered operation that is refused in the current context is `405 OPERATION NOT
ALLOWED`, not 501.

**Emitted for** any request carrying an unregistered operation. `validateRequest` detects
it at step 2, before body-presence, session-scope, and JSON checks, so an unknown
operation is reported in preference to any other fault in the same message.

Session mock endpoints do **not** emit 501. They validate with
`allowUnknownOperation: true`, because a mock is allowed to answer operations SLTP itself
does not define — that is a large part of what makes it useful for testing. An unmatched
operation at a mock endpoint produces `410 NO MATCHING RULE`.

The categorisation as 5xx rather than 4xx is deliberate and is worth stating: the request
was legitimate SLTP, and it is the _server's_ capability set that fell short. A client
that receives 501 has not made a syntax error; it has asked for something this server does
not implement.

**Body** is `{ error, reason }` with `reason: "unknown-operation"`, naming the operation
that was not recognised.

**Status-specific headers.** `Reason: unknown-operation`.

---

### 4.23 · 503 SERVER UNAVAILABLE

|                |                              |
| -------------- | ---------------------------- |
| **Phrase**     | `SERVER UNAVAILABLE`         |
| **Category**   | server error (5xx)           |
| **Connection** | **depends on the condition** |
| **Body**       | present, JSON                |

The server cannot accept the request, though there is nothing wrong with the request
itself. Unlike a 500, this is not a fault; it is a capacity or lifecycle condition, and
retrying later may succeed.

**Emitted for** three conditions, which differ in whether the connection survives:

| Condition                                                                                                         | `Reason` header        | Connection                |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------- |
| A new TCP connection arrives while the server is shutting down                                                    | `server-shutting-down` | closed after the response |
| A new TCP connection arrives when the maximum simultaneous control connections (64 by default) is already reached | _(none)_               | closed after the response |
| A request arrives on an existing connection while the server is shutting down                                     | `server-shutting-down` | closed after the response |
| `CREATE_SESSION` when the active session limit (32 by default) is reached                                         | _(none)_               | **stays open**            |

The first three are lifecycle conditions and the server closes the socket in each: it is
about to stop serving that connection, so holding it open would mislead the client. Note
that the connection-limit refusal is answered before the connection is admitted — the
server writes the 503 and closes without ever adding it to its connection set.

The fourth is different in kind. The session limit is a resource ceiling, not a shutdown:
the connection is healthy, the framing is intact, and the client may close a session and
try again on the same connection. It therefore stays open.

**Body** is `{ error }`, describing which condition applied — shutdown, connection limit,
or session limit — and, for the session limit, how many sessions are already active.

**Status-specific headers.** `Reason: server-shutting-down` on the shutdown paths;
`Connection: close` on all three lifecycle paths.

---

## 5. Quick reference: connection outcome by code

| Code                                        | Connection after the response                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| 200, 201, 202, 204, 210, 211, 212, 213, 214 | stays open                                                                    |
| 400                                         | **closed** for framing faults; open for header, scope, and body faults        |
| 404, 405, 406, 407, 408, 409, 410, 422, 429 | stays open                                                                    |
| 413                                         | **always closed**                                                             |
| 500, 501                                    | stays open                                                                    |
| 503                                         | **closed** on shutdown and connection-limit paths; open for the session limit |

The reliable wire-level test is the `Connection: close` header, which the server sets on
exactly the responses after which it closes.

---

## 6. Related documents

| Document                                                                    | Relationship                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`docs/requirements.md`](./requirements.md)                                 | FR-14 requires this registry; §4.3 records the `202` gap.             |
| [`docs/architecture.md`](./architecture.md)                                 | Why the registries are treated as the specification.                  |
| [`packages/protocol/src/status.ts`](../packages/protocol/src/status.ts)     | The registry itself: codes, phrases, categories, meanings, contexts.  |
| [`packages/protocol/src/errors.ts`](../packages/protocol/src/errors.ts)     | The reason taxonomy, the fatal set, and the reason-to-status mapping. |
| [`packages/protocol/src/decoder.ts`](../packages/protocol/src/decoder.ts)   | Where framing faults are detected and where poisoning happens.        |
| [`packages/protocol/src/validate.ts`](../packages/protocol/src/validate.ts) | The fixed validation order that makes fault reporting deterministic.  |
