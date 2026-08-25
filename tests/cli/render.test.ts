/**
 * Terminal rendering.
 *
 * The renderer takes a writer, so every line it produces can be captured and
 * asserted without touching stdout. What is locked down here is the part a reader
 * of the output depends on: the status line, the status phrase fallback, the byte
 * counts, and the raw-byte view that makes CRLF framing visible.
 */
import { describe, expect, it } from 'vitest';
import type { Exchange, MockRule, Session } from '@socketlens/core';
import { Renderer } from '../../apps/cli/src/render.js';
import { mockRule, response, segment, testResult } from '../helpers/fixtures.js';

/** Collects written lines so the whole block can be asserted at once. */
function capture() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
    text: () => lines.join('\n'),
  };
}

/** A renderer writing into a capture buffer, with colour off unless asked for. */
function renderer(options?: { raw?: boolean; colour?: boolean }) {
  const out = capture();
  return { out, renderer: new Renderer(out.write, { colour: false, ...options }) };
}

/** An exchange built around a response, with the byte counts kept truthful. */
function exchange(
  overrides: Partial<Exchange> & { response?: Exchange['response'] } = {},
): Exchange {
  const message = overrides.response ?? response();
  const raw =
    overrides.rawResponse ??
    Buffer.from(`SLTP/1.0 ${message.statusCode} ${message.statusPhrase}\r\n\r\n`);
  return {
    requestId: overrides.requestId ?? 'req-1',
    request: overrides.request ?? Buffer.from('SLTP/1.0 PING\r\nRequest-ID: req-1\r\n\r\n'),
    response: message,
    rawResponse: raw,
    durationMs: overrides.durationMs ?? 7,
  };
}

describe('response rendering', () => {
  it('prints the version, code, and phrase on the start line', () => {
    const { out, renderer: r } = renderer();

    r.response(exchange({ response: response({ statusCode: 200, statusPhrase: 'OK' }) }));

    expect(out.lines[0]).toContain('SLTP/1.0 200 OK');
  });

  it('reports the byte count of the whole message and the elapsed time', () => {
    const { out, renderer: r } = renderer();
    const raw = Buffer.from('SLTP/1.0 200 OK\r\n\r\n');

    r.response(exchange({ rawResponse: raw, durationMs: 12 }));

    expect(out.lines[0]).toContain(`(${raw.length} bytes, 12 ms)`);
  });

  it('says "1 byte" rather than "1 bytes"', () => {
    const { out, renderer: r } = renderer();

    r.response(exchange({ rawResponse: Buffer.from('x') }));

    expect(out.lines[0]).toContain('(1 byte,');
  });

  it('falls back to the registered phrase when the server sent an empty one', () => {
    const { out, renderer: r } = renderer();

    r.response(exchange({ response: response({ statusCode: 201, statusPhrase: '' }) }));

    expect(out.lines[0]).toContain('SLTP/1.0 201 SESSION CREATED');
  });

  it('falls back to the status class for an unregistered code', () => {
    const { out, renderer: r } = renderer();

    r.response(exchange({ response: response({ statusCode: 499, statusPhrase: '' }) }));

    expect(out.lines[0]).toContain('SLTP/1.0 499 CLIENT ERROR');
  });

  it('prints the headers and the pretty-printed JSON body with its byte count', () => {
    const { out, renderer: r } = renderer();
    const body = '{"message":"pong","echo":"hello"}';

    r.response(
      exchange({
        response: response({
          body,
          headers: { 'Request-ID': 'req-1', 'Content-Type': 'application/json; charset=utf-8' },
        }),
      }),
    );

    expect(out.text()).toContain('Request-ID: req-1');
    // Pretty-printed, so the JSON is readable rather than one long line.
    expect(out.text()).toContain('"message": "pong"');
    expect(out.text()).toContain(`body: ${Buffer.byteLength(body, 'utf8')} bytes as UTF-8`);
  });

  it('counts body bytes in UTF-8 rather than in characters', () => {
    const { out, renderer: r } = renderer();
    const body = 'ทดสอบ';

    r.response(exchange({ response: response({ body }) }));

    expect(out.text()).toContain(`body: ${Buffer.byteLength(body, 'utf8')} bytes as UTF-8`);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(body.length);
  });

  it('notes the absence of a body instead of printing an empty block', () => {
    const { out, renderer: r } = renderer();

    r.response(exchange({ response: response({ body: '' }) }));

    expect(out.text()).toContain('(no body)');
    expect(out.text()).not.toContain('as UTF-8');
  });

  it('shows both directions of raw bytes with CRLF made visible when raw is on', () => {
    const { out, renderer: r } = renderer({ raw: true });

    r.response(
      exchange({
        request: Buffer.from('SLTP/1.0 PING\r\nRequest-ID: req-1\r\n\r\n'),
        rawResponse: Buffer.from('SLTP/1.0 200 OK\r\nRequest-ID: req-1\r\n\r\n'),
      }),
    );

    const text = out.text();
    expect(text).toContain('Raw request bytes');
    expect(text).toContain('Raw response bytes');
    expect(text).toContain('SLTP/1.0 PING\\r\\n');
    expect(text).toContain('Request-ID: req-1\\r\\n');
  });

  it('omits the raw byte view by default', () => {
    const { out, renderer: r } = renderer();

    r.response(exchange());

    expect(out.text()).not.toContain('Raw response bytes');
  });
});

describe('colour', () => {
  it('colours a success start line green and a failure red', () => {
    const ok = renderer({ colour: true });
    ok.renderer.response(exchange({ response: response({ statusCode: 200 }) }));

    const bad = renderer({ colour: true });
    bad.renderer.response(
      exchange({ response: response({ statusCode: 404, statusPhrase: 'SESSION NOT FOUND' }) }),
    );

    expect(ok.out.lines[0]).toContain('[32mSLTP/1.0 200 OK[0m');
    expect(bad.out.lines[0]).toContain('[31mSLTP/1.0 404 SESSION NOT FOUND[0m');
  });

  it('emits no escape sequences when colour is disabled', () => {
    const { out, renderer: r } = renderer();

    r.response(exchange());
    r.success('done');
    r.error('broken');

    // eslint-disable-next-line no-control-regex
    expect(out.text()).not.toMatch(/\[/);
  });
});

describe('line helpers', () => {
  it('aligns field labels on the colon and drops undefined values', () => {
    const { out, renderer: r } = renderer();

    r.fields([
      ['id', 'ses-1'],
      ['description', 'a longer label'],
      ['missing', undefined],
    ]);

    expect(out.lines).toEqual(['  id          : ses-1', '  description : a longer label']);
  });

  it('marks success, warning, and error lines distinctly', () => {
    const { out, renderer: r } = renderer();

    r.success('created');
    r.warn('careful');
    r.error('failed');

    expect(out.lines).toEqual(['✔ created', '! careful', '✖ failed']);
  });

  it('prints JSON with two-space indentation for --json', () => {
    const { out, renderer: r } = renderer();

    r.json({ a: 1 });

    expect(out.text()).toBe('{\n  "a": 1\n}');
  });
});

describe('session and rule listings', () => {
  const session: Session = {
    id: 'ses-1',
    name: 'demo',
    description: '',
    state: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mockHost: '127.0.0.1',
    mockPort: 54_321,
    ruleCount: 2,
    resultCount: 1,
  };

  it('shows a session with its mock endpoint address', () => {
    const { out, renderer: r } = renderer();

    r.session(session);

    expect(out.text()).toContain('127.0.0.1:54321');
    expect(out.text()).toContain('ses-1');
  });

  it('summarises each session on one line', () => {
    const { out, renderer: r } = renderer();

    r.sessionList([session]);

    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('ses-1');
    expect(out.lines[0]).toContain('mock=127.0.0.1:54321 rules=2 results=1');
  });

  it('explains the empty case instead of printing nothing', () => {
    const sessions = renderer();
    sessions.renderer.sessionList([]);
    const rules = renderer();
    rules.renderer.ruleList([]);

    expect(sessions.out.text()).toContain('No sessions');
    expect(rules.out.text()).toContain('socketlens rule add');
  });

  it('numbers rules in evaluation order and states what that order is', () => {
    const { out, renderer: r } = renderer();
    const rules: MockRule[] = [
      mockRule({ id: 'rule-a', name: 'high', priority: 9 }),
      mockRule({ id: 'rule-b', name: 'low', priority: 1, enabled: false }),
    ];

    r.ruleList(rules);

    expect(out.lines[0]).toContain(' 1. on  high');
    expect(out.lines[0]).toContain('priority=9 match=PING → 200 OK (rule-a)');
    expect(out.lines[1]).toContain(' 2. off low');
    expect(out.text()).toContain('priority descending, then insertion order ascending');
  });

  it('renders a rule matching any operation in words, not as a bare asterisk', () => {
    const { out, renderer: r } = renderer();

    r.rule(mockRule({ match: { operation: '*' } }));

    expect(out.text()).toContain('* (any operation)');
  });
});

describe('test results', () => {
  it('prints the verdict, the counts, and each write and read', () => {
    const { out, renderer: r } = renderer();

    r.result(
      testResult({
        segments: [
          segment({ direction: 'sent', atMs: 0, data: 'SLTP/1.0 PING\r\n' }),
          segment({ direction: 'received', atMs: 3, data: 'SLTP/1.0 200 OK\r\n\r\n' }),
        ],
        receivedSegmentCount: 1,
      }),
    );

    const text = out.text();
    expect(out.lines[0]).toContain('PASSED');
    expect(out.lines[0]).toContain('ping the mock endpoint');
    expect(text).toContain('Wire writes and reads');
    expect(text).toContain('→');
    expect(text).toContain('←');
    // Payloads are escaped so a CRLF cannot break the one-line layout.
    expect(text).toContain('SLTP/1.0 PING\\r\\n');
    expect(text).toContain('+3ms');
  });

  it('reports the failing outcome as the verdict', () => {
    const { out, renderer: r } = renderer();

    r.result(testResult({ passed: false, outcome: 'failed' }));

    expect(out.lines[0]).toContain('FAILED');
  });

  it('points out when several SLTP responses were framed from fewer reads', () => {
    const { out, renderer: r } = renderer();

    r.result(
      testResult({
        segments: [segment({ direction: 'received' })],
        receivedSegmentCount: 1,
        responseCount: 3,
      }),
    );

    expect(out.text()).toContain('3 SLTP responses were framed from 1 read(s)');
    expect(out.text()).toContain('message boundaries are recovered by SLTP, not by TCP');
  });

  it('prints expected versus actual only for the assertions that failed', () => {
    const { out, renderer: r } = renderer();

    r.assertions([
      { field: 'statusCode', passed: true, expected: '200', actual: '200' },
      { field: 'body', passed: false, expected: 'pong', actual: 'nope', message: 'body mismatch' },
    ]);

    const text = out.text();
    expect(text).toContain('✔ statusCode');
    expect(text).toContain('✖ body');
    expect(text).toContain('expected: pong');
    expect(text).toContain('actual  : nope');
    expect(text).toContain('body mismatch');
    expect(text).not.toContain('expected: 200');
  });

  it('marks each stored result PASS or FAIL in the list view', () => {
    const { out, renderer: r } = renderer();

    r.resultList([
      {
        id: 'res-1',
        scenarioName: 'good',
        outcome: 'passed',
        passed: true,
        durationMs: 5,
        statusCode: 200,
        statusPhrase: 'OK',
      },
      { id: 'res-2', scenarioName: 'bad', outcome: 'failed', passed: false, durationMs: 1_500 },
    ]);

    expect(out.lines[0]).toContain('PASS');
    expect(out.lines[0]).toContain('200 OK 5 ms res-1');
    expect(out.lines[1]).toContain('FAIL');
    // No status is known for the failure, so the placeholder and outcome stand in.
    expect(out.lines[1]).toContain('--- failed 1.50 s res-2');
  });

  it('explains the empty result list', () => {
    const { out, renderer: r } = renderer();

    r.resultList([]);

    expect(out.text()).toContain('socketlens run');
  });
});
