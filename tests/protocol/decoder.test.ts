/**
 * Framing tests for the incremental SLTP decoder.
 *
 * These are the tests that matter most in this project: they encode the fact that TCP
 * is a byte stream with no message boundaries. Every case here corresponds to a real
 * way a TCP stream can deliver bytes.
 */
import { describe, expect, it } from 'vitest';
import {
  SltpDecoder,
  SLTP_REASON,
  type SltpRequest,
  type SltpResponse,
} from '@socketlens/protocol';
import {
  expectMessage,
  messagesOf,
  pushByteByByte,
  pushInChunks,
  rawMessage,
} from '../helpers/wire.js';

describe('SltpDecoder — complete messages', () => {
  it('decodes a complete request with no body', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire = rawMessage('SLTP/1.0 PING', ['Request-ID: req-1']);

    const events = decoder.push(wire);

    expect(events).toHaveLength(1);
    const message = expectMessage(events[0]).message as SltpRequest;
    expect(message.kind).toBe('request');
    expect(message.operation).toBe('PING');
    expect(message.version).toBe('SLTP/1.0');
    expect(message.body).toBe('');
    expect(message.bodyBytes).toBe(0);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('decodes a complete response with a reason phrase of several words', () => {
    const decoder = new SltpDecoder({ expect: 'response' });
    const wire = rawMessage('SLTP/1.0 201 SESSION CREATED', ['Request-ID: req-2']);

    const message = expectMessage(decoder.push(wire)[0]).message as SltpResponse;

    expect(message.kind).toBe('response');
    expect(message.statusCode).toBe(201);
    expect(message.statusPhrase).toBe('SESSION CREATED');
  });

  it('decodes a JSON body and reports its exact byte length', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const body = JSON.stringify({ name: 'demo', enabled: true });
    const wire = rawMessage(
      'SLTP/1.0 CREATE_SESSION',
      ['Request-ID: req-3', 'Content-Type: application/json; charset=utf-8'],
      body,
    );

    const message = expectMessage(decoder.push(wire)[0]).message;

    expect(message.body).toBe(body);
    expect(message.bodyBytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(JSON.parse(message.body)).toEqual({ name: 'demo', enabled: true });
  });

  it('frames a body by UTF-8 byte length, not JavaScript string length', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    // Thai text: every character is three UTF-8 bytes.
    const body = JSON.stringify({ name: 'การทดสอบ' });
    const byteLength = Buffer.byteLength(body, 'utf8');
    const wire = rawMessage('SLTP/1.0 CREATE_SESSION', ['Request-ID: req-4'], body);

    const message = expectMessage(decoder.push(wire)[0]).message;

    expect(byteLength).toBeGreaterThan(body.length);
    expect(message.bodyBytes).toBe(byteLength);
    expect(JSON.parse(message.body)).toEqual({ name: 'การทดสอบ' });
  });

  it('accepts an explicit Content-Length of zero', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire = 'SLTP/1.0 PING\r\nRequest-ID: req-5\r\nContent-Length: 0\r\n\r\n';

    const message = expectMessage(decoder.push(wire)[0]).message;

    expect(message.bodyBytes).toBe(0);
    expect(message.body).toBe('');
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('treats bytes after a zero-length body as the next message, not as body', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    // Content-Length: 0 frames an empty body, so everything after the delimiter belongs to
    // the following message. Absorbing it as "unexpected body data" would silently swallow
    // a legitimate second request.
    const first = 'SLTP/1.0 PING\r\nRequest-ID: req-5b\r\nContent-Length: 0\r\n\r\n';
    const second = rawMessage('SLTP/1.0 PING', ['Request-ID: req-5c']);

    const messages = messagesOf(decoder.push(first + second));

    expect(messages).toHaveLength(2);
    expect(messages[0]?.message.body).toBe('');
    expect(
      (messages[0]?.message as SltpRequest).headers.find((h) => h.name === 'Request-ID')?.value,
    ).toBe('req-5b');
    expect(
      (messages[1]?.message as SltpRequest).headers.find((h) => h.name === 'Request-ID')?.value,
    ).toBe('req-5c');
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('preserves duplicate extension headers in wire order', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire = rawMessage('SLTP/1.0 PING', [
      'Request-ID: req-6',
      'X-Trace: alpha',
      'X-Trace: beta',
    ]);

    const message = expectMessage(decoder.push(wire)[0]).message;
    const traces = message.headers.filter((h) => h.name === 'X-Trace').map((h) => h.value);

    expect(traces).toEqual(['alpha', 'beta']);
  });
});

describe('SltpDecoder — one message split across TCP segments', () => {
  it('reassembles a start line split mid-token', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire = rawMessage('SLTP/1.0 CREATE_SESSION', ['Request-ID: req-7']);

    const events = pushInChunks(decoder, wire, [6, 11]);

    expect(messagesOf(events)).toHaveLength(1);
    expect((expectMessage(events.at(-1)).message as SltpRequest).operation).toBe('CREATE_SESSION');
  });

  it('reassembles a header split across chunks', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire = rawMessage('SLTP/1.0 PING', ['Request-ID: req-8', 'X-Trace: abcdef']);
    const splitInsideHeader = wire.indexOf('X-Trace') + 4;

    const events = pushInChunks(decoder, wire, [splitInsideHeader]);

    const message = expectMessage(events.at(-1)).message;
    expect(message.headers.find((h) => h.name === 'X-Trace')?.value).toBe('abcdef');
  });

  it('reassembles a CRLFCRLF delimiter split down the middle', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire = rawMessage('SLTP/1.0 PING', ['Request-ID: req-9']);
    const delimiterAt = wire.indexOf('\r\n\r\n');

    // Split between the two CRLF pairs: the classic delimiter-straddling case.
    const first = decoder.push(wire.slice(0, delimiterAt + 2));
    expect(first).toHaveLength(0);

    const second = decoder.push(wire.slice(delimiterAt + 2));
    expect(messagesOf(second)).toHaveLength(1);
  });

  it('reassembles a line terminator split between its CR and its LF', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire = rawMessage('SLTP/1.0 PING', ['Request-ID: req-9b']);
    // Land the cut between the CR and the LF of the start line's own terminator, so the
    // first chunk ends on a lone CR. A decoder that scanned for '\n' and then assumed the
    // preceding byte was in the same chunk would mis-handle this.
    const startLineCr = wire.indexOf('\r\n');
    expect(startLineCr).toBeGreaterThan(-1);

    const first = decoder.push(wire.slice(0, startLineCr + 1));
    expect(messagesOf(first)).toHaveLength(0);

    const second = decoder.push(wire.slice(startLineCr + 1));
    const message = expectMessage(second.at(-1)).message as SltpRequest;
    expect(message.operation).toBe('PING');
  });

  it('reassembles a Content-Length line split inside its digits', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const body = JSON.stringify({ scenario: 'split-content-length' });
    const wire = rawMessage('SLTP/1.0 RUN_TEST', ['Request-ID: req-9c'], body);
    const digitsAt = wire.indexOf('Content-Length: ') + 'Content-Length: '.length;
    expect(digitsAt).toBeGreaterThan('Content-Length: '.length - 1);

    // Cut after the first digit. The framing length is unknowable until the rest arrives,
    // so the decoder must not act on the partial number it can already see.
    const events = pushInChunks(decoder, wire, [digitsAt + 1]);

    const message = expectMessage(events.at(-1)).message;
    expect(message.body).toBe(body);
    expect(message.bodyBytes).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('reassembles a header value split across chunks', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire = rawMessage('SLTP/1.0 PING', ['Request-ID: req-9d', 'X-Trace: abcdef']);
    const insideValue = wire.indexOf('abcdef') + 3;

    const events = pushInChunks(decoder, wire, [insideValue]);

    const message = expectMessage(events.at(-1)).message;
    expect(message.headers.find((h) => h.name === 'X-Trace')?.value).toBe('abcdef');
  });

  it('reassembles a body split across chunks', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const body = JSON.stringify({ scenario: 'fragmented-body', size: 12345 });
    const wire = rawMessage('SLTP/1.0 RUN_TEST', ['Request-ID: req-10'], body);
    const bodyStart = wire.indexOf('\r\n\r\n') + 4;

    const events = pushInChunks(decoder, wire, [bodyStart + 5, bodyStart + 9]);

    expect(expectMessage(events.at(-1)).message.body).toBe(body);
  });

  it('reassembles a message delivered one byte at a time', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const body = JSON.stringify({ name: 'byte-by-byte' });
    const wire = rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: req-11'], body);

    const events = pushByteByByte(decoder, wire);

    expect(messagesOf(events)).toHaveLength(1);
    expect(expectMessage(events.at(-1)).message.body).toBe(body);
  });

  it('reassembles a multi-byte UTF-8 character split between two chunks', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    // "ก" is E0 B8 81 in UTF-8. Splitting inside it must not corrupt the decoded body.
    const body = JSON.stringify({ label: 'กขค' });
    const wire = Buffer.from(rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: req-12'], body), 'utf8');
    const thaiAt = wire.indexOf(Buffer.from('ก', 'utf8'));
    expect(thaiAt).toBeGreaterThan(-1);

    // Cut one byte into the three-byte sequence.
    const first = decoder.push(wire.subarray(0, thaiAt + 1));
    expect(messagesOf(first)).toHaveLength(0);

    const second = decoder.push(wire.subarray(thaiAt + 1));
    const message = expectMessage(second.at(-1)).message;

    expect(JSON.parse(message.body)).toEqual({ label: 'กขค' });
    expect(message.body).not.toContain('�');
  });

  it('reassembles a body delivered byte by byte through a multi-byte character', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const body = JSON.stringify({ th: 'ทดสอบ', emoji: '🧪' });
    const wire = Buffer.from(rawMessage('SLTP/1.0 RUN_TEST', ['Request-ID: req-13'], body), 'utf8');

    const events = pushByteByByte(decoder, wire);

    const message = expectMessage(events.at(-1)).message;
    expect(JSON.parse(message.body)).toEqual({ th: 'ทดสอบ', emoji: '🧪' });
  });
});

describe('SltpDecoder — several messages in one TCP segment', () => {
  it('decodes two coalesced messages from a single chunk', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const first = rawMessage('SLTP/1.0 PING', ['Request-ID: req-14']);
    const second = rawMessage('SLTP/1.0 SERVER_INFO', ['Request-ID: req-15']);

    const events = decoder.push(first + second);
    const messages = messagesOf(events);

    expect(messages).toHaveLength(2);
    expect((messages[0]!.message as SltpRequest).operation).toBe('PING');
    expect((messages[1]!.message as SltpRequest).operation).toBe('SERVER_INFO');
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('decodes three coalesced messages, two of which carry bodies', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire =
      rawMessage('SLTP/1.0 PING', ['Request-ID: a']) +
      rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: b'], JSON.stringify({ n: 1 })) +
      rawMessage('SLTP/1.0 RUN_TEST', ['Request-ID: c'], JSON.stringify({ n: 2 }));

    const messages = messagesOf(decoder.push(wire));

    expect(messages.map((m) => (m.message as SltpRequest).operation)).toEqual([
      'PING',
      'ADD_RULE',
      'RUN_TEST',
    ]);
  });

  it('emits one complete message and retains the partial next one', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const complete = rawMessage('SLTP/1.0 PING', ['Request-ID: req-16']);
    const partial = 'SLTP/1.0 SERVER_INFO\r\nRequest-ID: req-';

    const events = decoder.push(complete + partial);

    expect(messagesOf(events)).toHaveLength(1);
    expect(decoder.bufferedBytes).toBe(Buffer.byteLength(partial, 'utf8'));

    // Completing the second message must produce it without re-emitting the first.
    const more = decoder.push('17\r\n\r\n');
    expect(messagesOf(more)).toHaveLength(1);
    expect((expectMessage(more[0]).message as SltpRequest).operation).toBe('SERVER_INFO');
  });

  it('reports the exact wire bytes of each coalesced message separately', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const first = rawMessage('SLTP/1.0 PING', ['Request-ID: x']);
    const second = rawMessage('SLTP/1.0 PING', ['Request-ID: y'], 'body');

    const messages = messagesOf(decoder.push(first + second));

    expect(messages[0]!.raw.toString('utf8')).toBe(first);
    expect(messages[1]!.raw.toString('utf8')).toBe(second);
    expect(messages[0]!.totalBytes).toBe(Buffer.byteLength(first, 'utf8'));
    expect(messages[1]!.totalBytes).toBe(Buffer.byteLength(second, 'utf8'));
  });

  it('handles a body that itself contains a CRLFCRLF sequence', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    // Content-Length framing means a delimiter inside the body is just data.
    const body = 'line1\r\n\r\nline2';
    const wire = rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: req-17'], body);
    const trailing = rawMessage('SLTP/1.0 PING', ['Request-ID: req-18']);

    const messages = messagesOf(decoder.push(wire + trailing));

    expect(messages).toHaveLength(2);
    expect(messages[0]!.message.body).toBe(body);
    expect((messages[1]!.message as SltpRequest).operation).toBe('PING');
  });
});

describe('SltpDecoder — invalid framing', () => {
  const failureOf = (wire: string | Buffer, expectKind: 'request' | 'response' = 'request') => {
    const decoder = new SltpDecoder({ expect: expectKind });
    const events = decoder.push(wire);
    const failure = events.find((e) => e.type === 'error');
    if (!failure || failure.type !== 'error') {
      throw new Error('expected a framing failure but decoding succeeded');
    }
    return { failure, decoder };
  };

  it('rejects a start line with no space separator', () => {
    const { failure } = failureOf('SLTP/1.0\r\nRequest-ID: a\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.malformedStartLine);
    expect(failure.error.status).toBe(400);
    expect(failure.error.fatal).toBe(true);
  });

  it('rejects an unsupported protocol version', () => {
    const { failure } = failureOf('SLTP/2.0 PING\r\nRequest-ID: a\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.unsupportedProtocolVersion);
    expect(failure.error.status).toBe(400);
  });

  it('rejects a lowercase operation token', () => {
    const { failure } = failureOf('SLTP/1.0 ping\r\nRequest-ID: a\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.invalidOperationToken);
  });

  it('rejects a request start line with trailing content', () => {
    const { failure } = failureOf('SLTP/1.0 PING EXTRA\r\nRequest-ID: a\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.malformedStartLine);
  });

  it('rejects an empty start line', () => {
    const { failure } = failureOf('\r\nRequest-ID: a\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.emptyStartLine);
  });

  it('rejects a two-digit status code', () => {
    const { failure } = failureOf('SLTP/1.0 20 OK\r\nRequest-ID: a\r\n\r\n', 'response');
    expect(failure.error.reason).toBe(SLTP_REASON.invalidStatusCode);
  });

  it('rejects a response with no reason phrase', () => {
    const { failure } = failureOf('SLTP/1.0 200\r\nRequest-ID: a\r\n\r\n', 'response');
    expect(failure.error.reason).toBe(SLTP_REASON.missingStatusPhrase);
  });

  it('rejects a status code outside 100-599', () => {
    const { failure } = failureOf('SLTP/1.0 099 NOPE\r\nRequest-ID: a\r\n\r\n', 'response');
    expect(failure.error.reason).toBe(SLTP_REASON.invalidStatusCode);
  });

  it('rejects bare LF line endings', () => {
    const { failure } = failureOf('SLTP/1.0 PING\nRequest-ID: a\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.bareLineFeed);
  });

  it('rejects a header line with no colon', () => {
    const { failure } = failureOf('SLTP/1.0 PING\r\nRequestID a\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.malformedHeaderLine);
  });

  it('rejects a header line beginning with a colon', () => {
    const { failure } = failureOf('SLTP/1.0 PING\r\n: value\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.malformedHeaderLine);
  });

  it('rejects an invalid header name', () => {
    const { failure } = failureOf('SLTP/1.0 PING\r\nBad Header: value\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.invalidHeaderName);
  });

  it('rejects obsolete line folding', () => {
    const { failure } = failureOf('SLTP/1.0 PING\r\nRequest-ID: a\r\n  continued\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.obsoleteLineFolding);
  });

  it('rejects a non-ASCII header value', () => {
    const { failure } = failureOf('SLTP/1.0 PING\r\nX-Name: ทดสอบ\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.invalidHeaderValue);
  });

  it('rejects a duplicate Content-Length', () => {
    const { failure } = failureOf(
      'SLTP/1.0 ADD_RULE\r\nRequest-ID: a\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nhi',
    );
    expect(failure.error.reason).toBe(SLTP_REASON.duplicateHeader);
    expect(failure.error.detail?.header).toBe('Content-Length');
  });

  it('rejects a duplicate Request-ID', () => {
    const { failure } = failureOf('SLTP/1.0 PING\r\nRequest-ID: a\r\nRequest-ID: b\r\n\r\n');
    expect(failure.error.reason).toBe(SLTP_REASON.duplicateHeader);
  });

  it('rejects a duplicate Session-ID', () => {
    const { failure } = failureOf(
      'SLTP/1.0 LIST_RULES\r\nRequest-ID: a\r\nSession-ID: s1\r\nSession-ID: s2\r\n\r\n',
    );
    expect(failure.error.reason).toBe(SLTP_REASON.duplicateHeader);
  });

  it('rejects a non-numeric Content-Length', () => {
    const { failure } = failureOf(
      'SLTP/1.0 ADD_RULE\r\nRequest-ID: a\r\nContent-Length: abc\r\n\r\n',
    );
    expect(failure.error.reason).toBe(SLTP_REASON.invalidContentLength);
  });

  it('rejects a negative Content-Length distinctly from a malformed one', () => {
    const { failure } = failureOf(
      'SLTP/1.0 ADD_RULE\r\nRequest-ID: a\r\nContent-Length: -5\r\n\r\n',
    );
    expect(failure.error.reason).toBe(SLTP_REASON.negativeContentLength);
    expect(failure.error.status).toBe(400);
  });

  it('rejects a hexadecimal Content-Length', () => {
    const { failure } = failureOf(
      'SLTP/1.0 ADD_RULE\r\nRequest-ID: a\r\nContent-Length: 0x10\r\n\r\n',
    );
    expect(failure.error.reason).toBe(SLTP_REASON.invalidContentLength);
  });

  it('rejects a Content-Length larger than the message limit with 413', () => {
    const { failure } = failureOf(
      'SLTP/1.0 ADD_RULE\r\nRequest-ID: a\r\nContent-Length: 99999999\r\n\r\n',
    );
    expect(failure.error.reason).toBe(SLTP_REASON.contentLengthTooLarge);
    expect(failure.error.status).toBe(413);
    expect(failure.error.fatal).toBe(true);
  });

  it('stops accepting bytes after a fatal framing error', () => {
    const { decoder } = failureOf('SLTP/2.0 PING\r\nRequest-ID: a\r\n\r\n');
    expect(decoder.isPoisoned).toBe(true);
    // A well-formed message on a desynchronised stream must not be decoded.
    expect(decoder.push(rawMessage('SLTP/1.0 PING', ['Request-ID: b']))).toHaveLength(0);
  });
});

describe('SltpDecoder — size limits', () => {
  it('rejects a header block that exceeds the configured limit', () => {
    const decoder = new SltpDecoder({ expect: 'request', limits: { maxHeaderBlockBytes: 128 } });
    const padding = 'x'.repeat(200);

    const events = decoder.push(`SLTP/1.0 PING\r\nX-Pad: ${padding}\r\n`);
    const failure = events.find((e) => e.type === 'error');

    expect(failure?.type).toBe('error');
    if (failure?.type === 'error') {
      expect(failure.error.reason).toBe(SLTP_REASON.headerBlockTooLarge);
      expect(failure.error.status).toBe(413);
    }
  });

  it('rejects a start line that exceeds the configured limit', () => {
    const decoder = new SltpDecoder({ expect: 'request', limits: { maxStartLineBytes: 20 } });

    const events = decoder.push(`SLTP/1.0 ${'A'.repeat(30)}\r\nRequest-ID: a\r\n\r\n`);
    const failure = events.find((e) => e.type === 'error');

    if (failure?.type !== 'error') throw new Error('expected failure');
    expect(failure.error.reason).toBe(SLTP_REASON.startLineTooLarge);
  });

  it('rejects a message with too many headers', () => {
    const decoder = new SltpDecoder({ expect: 'request', limits: { maxHeaderCount: 3 } });
    const headers = ['Request-ID: a', 'X-1: 1', 'X-2: 2', 'X-3: 3', 'X-4: 4'];

    const events = decoder.push(rawMessage('SLTP/1.0 PING', headers));
    const failure = events.find((e) => e.type === 'error');

    if (failure?.type !== 'error') throw new Error('expected failure');
    expect(failure.error.reason).toBe(SLTP_REASON.tooManyHeaders);
    expect(failure.error.status).toBe(413);
  });

  it('rejects a total message size above the limit', () => {
    const decoder = new SltpDecoder({ expect: 'request', limits: { maxMessageBytes: 200 } });
    const body = 'y'.repeat(300);

    const events = decoder.push(rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: a'], body));
    const failure = events.find((e) => e.type === 'error');

    if (failure?.type !== 'error') throw new Error('expected failure');
    // A declared length above the cap is caught while validating Content-Length.
    expect([SLTP_REASON.contentLengthTooLarge, SLTP_REASON.messageTooLarge]).toContain(
      failure.error.reason,
    );
    expect(failure.error.status).toBe(413);
  });

  it('accepts a message exactly at the size limit', () => {
    const body = 'z'.repeat(10);
    const wire = rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: a'], body);
    const decoder = new SltpDecoder({
      expect: 'request',
      limits: { maxMessageBytes: Buffer.byteLength(wire, 'utf8') },
    });

    expect(messagesOf(decoder.push(wire))).toHaveLength(1);
  });
});

describe('SltpDecoder — stream termination', () => {
  it('reports a truncated message when the peer disconnects mid-body', () => {
    const decoder = new SltpDecoder({ expect: 'request' });
    const wire = rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: a'], 'complete-body');
    const cut = wire.length - 5;

    decoder.push(wire.slice(0, cut));
    const events = decoder.end();

    expect(events).toHaveLength(1);
    if (events[0]?.type !== 'error') throw new Error('expected failure');
    expect(events[0].error.reason).toBe(SLTP_REASON.truncatedMessage);
    expect(events[0].error.fatal).toBe(true);
  });

  it('reports a truncated message when the peer disconnects mid-header', () => {
    const decoder = new SltpDecoder({ expect: 'request' });

    decoder.push('SLTP/1.0 PING\r\nRequest-ID: a');
    const events = decoder.end();

    if (events[0]?.type !== 'error') throw new Error('expected failure');
    expect(events[0].error.reason).toBe(SLTP_REASON.truncatedMessage);
    expect(events[0].error.detail?.bufferedBytes).toBeGreaterThan(0);
  });

  it('reports nothing when the peer disconnects on a clean message boundary', () => {
    const decoder = new SltpDecoder({ expect: 'request' });

    decoder.push(rawMessage('SLTP/1.0 PING', ['Request-ID: a']));

    expect(decoder.end()).toEqual([]);
  });
});

describe('SltpDecoder — role enforcement', () => {
  it('rejects a response when a request was expected', () => {
    const decoder = new SltpDecoder({ expect: 'request' });

    const events = decoder.push('SLTP/1.0 200 OK\r\nRequest-ID: a\r\n\r\n');

    if (events[0]?.type !== 'error') throw new Error('expected failure');
    expect(events[0].error.reason).toBe(SLTP_REASON.unexpectedMessageKind);
  });

  it('rejects a request when a response was expected', () => {
    const decoder = new SltpDecoder({ expect: 'response' });

    const events = decoder.push('SLTP/1.0 PING\r\nRequest-ID: a\r\n\r\n');

    if (events[0]?.type !== 'error') throw new Error('expected failure');
    expect(events[0].error.reason).toBe(SLTP_REASON.unexpectedMessageKind);
  });

  it('accepts either shape when configured with "any"', () => {
    const decoder = new SltpDecoder({ expect: 'any' });

    const messages = messagesOf(
      decoder.push(
        rawMessage('SLTP/1.0 PING', ['Request-ID: a']) +
          rawMessage('SLTP/1.0 200 OK', ['Request-ID: a']),
      ),
    );

    expect(messages.map((m) => m.message.kind)).toEqual(['request', 'response']);
  });
});
