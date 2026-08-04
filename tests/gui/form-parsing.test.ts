/**
 * Tests for the shared editor field parsers.
 *
 * These are deliberately not rendering tests. What matters here is the conversion from
 * free text to protocol values, and in particular the distinction the protocol cares
 * about: `undefined` (the field is absent) versus an empty or zero value (the field is
 * present and says zero). A rendering test would obscure that behind form plumbing.
 */
import { describe, it, expect } from 'vitest';
import {
  parseHeaderLines,
  formatHeaderLines,
  parseSizes,
  optionalCount,
} from '../../apps/gui/src/lib/form-parsing.js';

describe('parseHeaderLines', () => {
  it('parses Name: value lines into a record', () => {
    expect(parseHeaderLines('Content-Type: application/json\nX-Trace: abc')).toEqual({
      'Content-Type': 'application/json',
      'X-Trace': 'abc',
    });
  });

  it('trims surrounding whitespace from both name and value', () => {
    expect(parseHeaderLines('  Retry-After :  250  ')).toEqual({ 'Retry-After': '250' });
  });

  it('keeps colons that appear inside a header value', () => {
    // A timestamp value contains colons; only the first one delimits the name.
    expect(parseHeaderLines('Timestamp: 2026-08-04T10:20:30.000Z')).toEqual({
      Timestamp: '2026-08-04T10:20:30.000Z',
    });
  });

  it('returns undefined when no line parses, so the field is treated as absent', () => {
    expect(parseHeaderLines('')).toBeUndefined();
    expect(parseHeaderLines('\n  \n')).toBeUndefined();
    expect(parseHeaderLines('no colon here')).toBeUndefined();
  });

  it('skips a line whose colon is first, rather than making an empty header name', () => {
    // Half-typed input must not produce a nameless header.
    expect(parseHeaderLines(': orphan')).toBeUndefined();
  });

  it('keeps already-valid lines while a later line is still being typed', () => {
    expect(parseHeaderLines('Content-Type: text/plain\nX-Partial')).toEqual({
      'Content-Type': 'text/plain',
    });
  });

  it('lets a later duplicate line win, matching last-write-wins editing', () => {
    expect(parseHeaderLines('X-Mode: first\nX-Mode: second')).toEqual({ 'X-Mode': 'second' });
  });
});

describe('formatHeaderLines', () => {
  it('round-trips a header record through text', () => {
    const headers = { 'Content-Type': 'application/json', 'X-Trace': 'abc' };
    expect(parseHeaderLines(formatHeaderLines(headers))).toEqual(headers);
  });

  it('renders undefined as an empty field', () => {
    expect(formatHeaderLines(undefined)).toBe('');
  });
});

describe('parseSizes', () => {
  it('accepts comma separated, space separated, and mixed lists', () => {
    expect(parseSizes('10,20,30')).toEqual([10, 20, 30]);
    expect(parseSizes('10 20 30')).toEqual([10, 20, 30]);
    expect(parseSizes('10, 20  30')).toEqual([10, 20, 30]);
  });

  it('preserves order, because fragment order is what goes on the wire', () => {
    expect(parseSizes('30,5,12')).toEqual([30, 5, 12]);
  });

  it('drops zero, negative, and fractional sizes', () => {
    // None of these describe a writable fragment.
    expect(parseSizes('10,0,-5,2.5,20')).toEqual([10, 20]);
  });

  it('drops non-numeric entries instead of yielding NaN', () => {
    expect(parseSizes('10,abc,20')).toEqual([10, 20]);
  });

  it('returns undefined when nothing valid remains, meaning no explicit fragmentation', () => {
    expect(parseSizes('')).toBeUndefined();
    expect(parseSizes('   ')).toBeUndefined();
    expect(parseSizes('0,-1,abc')).toBeUndefined();
  });
});

describe('optionalCount', () => {
  it('reads a non-negative integer', () => {
    expect(optionalCount('250')).toBe(250);
  });

  it('keeps an explicit zero, which differs from an absent field', () => {
    // A response delay of 0 ms is a real instruction: reply immediately.
    expect(optionalCount('0')).toBe(0);
    expect(optionalCount('')).toBeUndefined();
  });

  it('tolerates surrounding whitespace', () => {
    expect(optionalCount('  42  ')).toBe(42);
  });

  it('rejects negative, fractional, and non-numeric input', () => {
    expect(optionalCount('-1')).toBeUndefined();
    expect(optionalCount('2.5')).toBeUndefined();
    expect(optionalCount('abc')).toBeUndefined();
  });
});
