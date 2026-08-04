/**
 * Semantic validation tests, including the mandated precedence between faults.
 */
import { describe, expect, it } from 'vitest';
import {
  SltpDecoder,
  SLTP_REASON,
  validateRequest,
  expectJsonObject,
  parseJsonBody,
  type SltpRequest,
} from '@socketlens/protocol';
import { expectMessage, rawMessage } from '../helpers/wire.js';

function decodeRequest(wire: string): SltpRequest {
  const message = expectMessage(new SltpDecoder({ expect: 'request' }).push(wire)[0]).message;
  if (message.kind !== 'request') throw new Error('expected a request');
  return message;
}

describe('validateRequest', () => {
  it('accepts a well-formed session-scoped request', () => {
    const request = decodeRequest(
      rawMessage('SLTP/1.0 LIST_RULES', ['Request-ID: req-1', 'Session-ID: ses-1']),
    );

    const result = validateRequest(request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requestId).toBe('req-1');
      expect(result.value.sessionId).toBe('ses-1');
    }
  });

  it('rejects a request with no Request-ID', () => {
    const result = validateRequest(decodeRequest(rawMessage('SLTP/1.0 PING', [])));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe(SLTP_REASON.missingRequestId);
      expect(result.error.status).toBe(400);
      expect(result.error.fatal).toBe(false);
    }
  });

  it('rejects a malformed Request-ID', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 PING', ['Request-ID: has spaces'])),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe(SLTP_REASON.invalidRequestId);
  });

  it('rejects a session-scoped operation with no Session-ID', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 LIST_RULES', ['Request-ID: req-1'])),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe(SLTP_REASON.missingSessionId);
  });

  it('rejects a malformed Session-ID', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 LIST_RULES', ['Request-ID: r', 'Session-ID: bad id'])),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe(SLTP_REASON.invalidSessionId);
  });

  it('reports an unknown operation as 501', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 TELEPORT', ['Request-ID: req-1'])),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe(SLTP_REASON.unknownOperation);
      expect(result.error.status).toBe(501);
    }
  });

  it('rejects a body on an operation that forbids one', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 LIST_SESSIONS', ['Request-ID: r'], '{"a":1}')),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe(SLTP_REASON.unexpectedBody);
  });

  it('rejects a missing body on an operation that requires one', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: r', 'Session-ID: s'])),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe(SLTP_REASON.missingBody);
  });

  it('rejects a body that is not valid JSON', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: r', 'Session-ID: s'], '{oops')),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe(SLTP_REASON.invalidJsonBody);
  });

  it('parses a valid JSON body into the validated result', () => {
    const result = validateRequest(
      decodeRequest(
        rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: r', 'Session-ID: s'], '{"name":"rule"}'),
      ),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.json).toEqual({ name: 'rule' });
  });
});

describe('validateRequest — fault precedence', () => {
  it('reports a missing Request-ID before an unknown operation', () => {
    const result = validateRequest(decodeRequest(rawMessage('SLTP/1.0 TELEPORT', [])));

    if (result.ok) throw new Error('expected failure');
    expect(result.error.reason).toBe(SLTP_REASON.missingRequestId);
  });

  it('reports an unknown operation before a missing Session-ID', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 TELEPORT', ['Request-ID: r'])),
    );

    if (result.ok) throw new Error('expected failure');
    expect(result.error.reason).toBe(SLTP_REASON.unknownOperation);
  });

  it('reports a missing Session-ID before an invalid JSON body', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 ADD_RULE', ['Request-ID: r'], '{broken')),
    );

    if (result.ok) throw new Error('expected failure');
    expect(result.error.reason).toBe(SLTP_REASON.missingSessionId);
  });
});

describe('validateRequest — endpoint options', () => {
  it('accepts an unregistered operation when the caller allows it', () => {
    const result = validateRequest(
      decodeRequest(rawMessage('SLTP/1.0 CUSTOM_OP', ['Request-ID: r'])),
      { allowUnknownOperation: true },
    );

    expect(result.ok).toBe(true);
  });

  it('can require a session for an operation that normally does not need one', () => {
    const result = validateRequest(decodeRequest(rawMessage('SLTP/1.0 PING', ['Request-ID: r'])), {
      requireSession: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe(SLTP_REASON.missingSessionId);
  });

  it('does not require a session at a mock endpoint', () => {
    const result = validateRequest(decodeRequest(rawMessage('SLTP/1.0 PING', ['Request-ID: r'])), {
      requireSession: false,
    });

    expect(result.ok).toBe(true);
  });
});

describe('body helpers', () => {
  it('parses valid JSON', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('reports invalid JSON as a protocol error rather than throwing', () => {
    const result = parseJsonBody('{');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe(SLTP_REASON.invalidJsonBody);
  });

  it('rejects a top-level array body', () => {
    const result = expectJsonObject([1, 2, 3]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe(SLTP_REASON.invalidBodyShape);
      expect(result.error.status).toBe(422);
    }
  });

  it('rejects a null body', () => {
    expect(expectJsonObject(null).ok).toBe(false);
  });

  it('accepts a plain object body', () => {
    expect(expectJsonObject({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
  });
});
