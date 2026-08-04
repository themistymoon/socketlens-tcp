# 04 — Expected versus actual, when the test fails

## What this demonstrates

A test that **fails on purpose**. Every other example shows the tool agreeing with
itself; this one shows what a disagreement looks like, which is the case the tool
actually exists to report.

## Run it

```
npm run examples -- --only 4
```

## What you should see

The mock is configured to answer `500 INTERNAL SERVER ERROR` while the scenario
expects `200 OK`. Two assertions fail:

```
scenario  expected-200-got-500          FAILED

  statusCode      expected "200"   actual "500"
  statusPhrase    expected "OK"    actual "INTERNAL SERVER ERROR"
```

and the control server answers the `RUN_TEST` request with:

```
SLTP/1.0 211 TEST FAILED
```

## The distinction this example exists to make

`211 TEST FAILED` is a **2xx** status. That looks wrong at first glance and is the
single most important idea in the SLTP status registry.

The status code describes **the SLTP request**, not the test. The client asked the
server to run a scenario; the server ran it, evaluated every assertion, and returned
a complete result. That request succeeded. The fact that the _scenario_ did not meet
its expectations is data inside a successful response, not a protocol error.

Compare the two failure modes:

| Situation                                | Status                 | Meaning                                        |
| ---------------------------------------- | ---------------------- | ---------------------------------------------- |
| Scenario ran, assertions did not hold    | `211 TEST FAILED`      | The exchange worked. The result says "failed". |
| Scenario was malformed and could not run | `422 INVALID SCENARIO` | The request was rejected. There is no result.  |

If `211` were a 4xx, a client could not distinguish "your scenario is broken" from
"your scenario is fine and the thing it tested is broken" without parsing the body.
Those demand completely different responses from the user, so they get completely
different status categories.

## Why the runner treats this failure as a success

`examples/run-all.ts` records a documented outcome per scenario, not a blanket
expectation that everything passes. This scenario is registered as `passes: false`
with `runTestStatus: 211`, and the runner additionally asserts that **exactly two**
assertions failed and that the observed status really was 500.

So if someone broke the assertion engine such that mismatches stopped being
reported, this example would start "passing" — and the runner would fail, because
passing is not what it is documented to do.
