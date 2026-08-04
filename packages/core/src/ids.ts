/**
 * Identifier generation.
 *
 * Identifiers are short, readable, and prefixed by kind so that a captured protocol
 * trace tells you what an identifier refers to without a lookup. They are unique
 * within one server process, which is all SocketLens TCP 0.1 requires: nothing is
 * persisted between runs.
 */
import { randomUUID } from 'node:crypto';

const counters = new Map<string, number>();

/**
 * Returns the next identifier for `prefix`, e.g. `ses-1`, `ses-2`.
 * Monotonic within the process, which keeps demo output predictable.
 */
export function nextId(prefix: string): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}-${next}`;
}

/** A session identifier, e.g. `ses-1`. */
export function newSessionId(): string {
  return nextId('ses');
}

/** A mock rule identifier, e.g. `rule-1`. */
export function newRuleId(): string {
  return nextId('rule');
}

/** A test result identifier, e.g. `res-1`. */
export function newResultId(): string {
  return nextId('res');
}

/** A TCP connection identifier, e.g. `conn-1`. */
export function newConnectionId(): string {
  return nextId('conn');
}

/** A client-side correlation identifier, e.g. `req-1`. */
export function newRequestId(): string {
  return nextId('req');
}

/**
 * A globally unique identifier, for the rare case where cross-process uniqueness
 * matters. Not used for protocol identifiers, which stay short for readability.
 */
export function newUuid(): string {
  return randomUUID();
}

/** Resets every counter. Used by tests to keep identifiers deterministic. */
export function resetIdCounters(): void {
  counters.clear();
}
