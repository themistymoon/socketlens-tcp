/**
 * Test helpers for building SLTP byte sequences by hand.
 *
 * These deliberately bypass the encoder so that tests can construct malformed and
 * hostile input that the encoder would refuse to produce.
 */
import {
  type SltpDecoder,
  type SltpDecodeEvent,
  type SltpDecodedMessage,
} from '@socketlens/protocol';

/** Joins lines with CRLF and appends the blank-line delimiter. */
export function headerBlock(...lines: string[]): string {
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Builds a complete raw message with a correctly computed Content-Length. */
export function rawMessage(startLine: string, headers: string[], body = ''): string {
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  const all = [startLine, ...headers];
  if (bodyBytes > 0) all.push(`Content-Length: ${bodyBytes}`);
  return `${all.join('\r\n')}\r\n\r\n${body}`;
}

/** A minimal valid request with a Request-ID. */
export function pingRequest(requestId = 'req-1'): string {
  return rawMessage('SLTP/1.0 PING', [`Request-ID: ${requestId}`]);
}

/** A minimal valid response. */
export function okResponse(requestId = 'req-1', body = ''): string {
  return rawMessage('SLTP/1.0 200 OK', [`Request-ID: ${requestId}`], body);
}

/** Feeds `input` to a decoder one byte at a time, returning every event produced. */
export function pushByteByByte(decoder: SltpDecoder, input: Buffer | string): SltpDecodeEvent[] {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const events: SltpDecodeEvent[] = [];
  for (let i = 0; i < buf.length; i += 1) {
    events.push(...decoder.push(buf.subarray(i, i + 1)));
  }
  return events;
}

/** Feeds `input` in chunks split at the given byte offsets. */
export function pushInChunks(
  decoder: SltpDecoder,
  input: Buffer | string,
  offsets: number[],
): SltpDecodeEvent[] {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const bounds = [0, ...offsets, buf.length];
  const events: SltpDecodeEvent[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    if (end <= start) continue;
    events.push(...decoder.push(buf.subarray(start, end)));
  }
  return events;
}

/** Narrows an event to a decoded message, failing loudly when it is an error. */
export function expectMessage(event: SltpDecodeEvent | undefined): SltpDecodedMessage {
  if (!event) throw new Error('expected a decode event but received none');
  if (event.type !== 'message') {
    throw new Error(
      `expected a message but decoding failed: ${event.error.reason} — ${event.error.message}`,
    );
  }
  return event;
}

/** Returns only the messages from a list of events. */
export function messagesOf(events: SltpDecodeEvent[]): SltpDecodedMessage[] {
  return events.filter((event): event is SltpDecodedMessage => event.type === 'message');
}

/** Returns only the failures from a list of events. */
export function errorsOf(events: SltpDecodeEvent[]) {
  return events.filter((event) => event.type === 'error');
}
