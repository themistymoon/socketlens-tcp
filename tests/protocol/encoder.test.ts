/**
 * Encoder tests, including the round-trip property that every encoded message
 * decodes back to an equivalent structure.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeRequest,
  encodeResponse,
  encodeJsonRequest,
  encodeJsonResponse,
  reencodeMessage,
  SltpDecoder,
  SltpEncodeError,
  SLTP_REASON,
  type SltpRequest,
  type SltpResponse,
} from '@socketlens/protocol';
import { expectMessage } from '../helpers/wire.js';

const decodeOne = (buf: Buffer, expectKind: 'request' | 'response') =>
  expectMessage(new SltpDecoder({ expect: expectKind }).push(buf)[0]).message;

describe('encodeRequest', () => {
  it('produces a CRLF-framed message ending in a blank line', () => {
    const buf = encodeRequest({ operation: 'PING', headers: { 'Request-ID': 'req-1' } });

    expect(buf.toString('utf8')).toBe('SLTP/1.0 PING\r\nRequest-ID: req-1\r\n\r\n');
  });

  it('omits Content-Length when there is no body', () => {
    const wire = encodeRequest({ operation: 'PING', headers: { 'Request-ID': 'a' } }).toString(
      'utf8',
    );

    expect(wire).not.toContain('Content-Length');
  });

  it('computes Content-Length from UTF-8 bytes, not string length', () => {
    const body = JSON.stringify({ th: 'ทดสอบ' });
    const buf = encodeRequest({ operation: 'ADD_RULE', headers: { 'Request-ID': 'a' }, body });

    const declared = /Content-Length: (\d+)/.exec(buf.toString('utf8'))?.[1];

    expect(Number(declared)).toBe(Buffer.byteLength(body, 'utf8'));
    expect(Number(declared)).toBeGreaterThan(body.length);
  });

  it('ignores a caller-supplied Content-Length and computes the true one', () => {
    const buf = encodeRequest({
      operation: 'ADD_RULE',
      headers: { 'Request-ID': 'a', 'Content-Length': '999' },
      body: 'hello',
    });

    const wire = buf.toString('utf8');
    expect(wire).toContain('Content-Length: 5');
    expect(wire).not.toContain('999');
  });

  it('canonicalises header name casing', () => {
    const wire = encodeRequest({
      operation: 'PING',
      headers: { 'request-id': 'a', 'x-custom-tag': 'v' },
    }).toString('utf8');

    expect(wire).toContain('Request-ID: a');
    expect(wire).toContain('X-Custom-Tag: v');
  });

  it('drops undefined and null headers', () => {
    const wire = encodeRequest({
      operation: 'PING',
      headers: { 'Request-ID': 'a', 'Session-ID': undefined, 'X-Skip': null },
    }).toString('utf8');

    expect(wire).not.toContain('Session-ID');
    expect(wire).not.toContain('X-Skip');
  });

  it('adds a JSON content type when asked', () => {
    const wire = encodeJsonRequest('ADD_RULE', { a: 1 }, { 'Request-ID': 'a' }).toString('utf8');

    expect(wire).toContain('Content-Type: application/json; charset=utf-8');
  });

  it('rejects a lowercase operation token', () => {
    expect(() => encodeRequest({ operation: 'ping' })).toThrow(SltpEncodeError);
  });

  it('rejects a header value containing CRLF, preventing injection', () => {
    expect(() =>
      encodeRequest({ operation: 'PING', headers: { 'X-Bad': 'a\r\nX-Injected: yes' } }),
    ).toThrow(SltpEncodeError);
  });

  it('reports the reason code on an encode failure', () => {
    try {
      encodeRequest({ operation: 'not valid' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SltpEncodeError);
      expect((error as SltpEncodeError).reason).toBe(SLTP_REASON.invalidOperationToken);
    }
  });
});

describe('encodeResponse', () => {
  it('serialises code and phrase into the start line', () => {
    const wire = encodeResponse({
      statusCode: 201,
      statusPhrase: 'SESSION CREATED',
      headers: { 'Request-ID': 'a' },
    }).toString('utf8');

    expect(wire.startsWith('SLTP/1.0 201 SESSION CREATED\r\n')).toBe(true);
  });

  it('rejects a status code outside the permitted range', () => {
    expect(() => encodeResponse({ statusCode: 99, statusPhrase: 'NOPE' })).toThrow(SltpEncodeError);
    expect(() => encodeResponse({ statusCode: 600, statusPhrase: 'NOPE' })).toThrow(
      SltpEncodeError,
    );
  });

  it('rejects an empty reason phrase', () => {
    expect(() => encodeResponse({ statusCode: 200, statusPhrase: '' })).toThrow(SltpEncodeError);
  });

  it('rejects a non-ASCII reason phrase', () => {
    expect(() => encodeResponse({ statusCode: 200, statusPhrase: 'สำเร็จ' })).toThrow(
      SltpEncodeError,
    );
  });
});

describe('round trip', () => {
  it('decodes an encoded request back to the same structure', () => {
    const body = JSON.stringify({ name: 'demo', th: 'ทดสอบ' });
    const buf = encodeJsonRequest('CREATE_SESSION', JSON.parse(body), {
      'Request-ID': 'req-99',
      'Session-ID': 'ses-1',
    });

    const decoded = decodeOne(buf, 'request') as SltpRequest;

    expect(decoded.operation).toBe('CREATE_SESSION');
    expect(decoded.headers.find((h) => h.name === 'Request-ID')?.value).toBe('req-99');
    expect(decoded.headers.find((h) => h.name === 'Session-ID')?.value).toBe('ses-1');
    expect(JSON.parse(decoded.body)).toEqual({ name: 'demo', th: 'ทดสอบ' });
    expect(decoded.bodyBytes).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('decodes an encoded response back to the same structure', () => {
    const buf = encodeJsonResponse(211, 'TEST FAILED', { passed: false }, { 'Request-ID': 'r' });

    const decoded = decodeOne(buf, 'response') as SltpResponse;

    expect(decoded.statusCode).toBe(211);
    expect(decoded.statusPhrase).toBe('TEST FAILED');
    expect(JSON.parse(decoded.body)).toEqual({ passed: false });
  });

  it('re-encodes a decoded message to equivalent bytes', () => {
    const original = encodeJsonRequest('RUN_TEST', { name: 'x' }, { 'Request-ID': 'a' });
    const decoded = decodeOne(original, 'request');

    const reencoded = reencodeMessage(decoded);

    expect(reencoded.toString('utf8')).toBe(original.toString('utf8'));
  });
});
