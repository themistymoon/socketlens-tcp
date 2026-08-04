/**
 * The SLTP/1.0 operation registry.
 *
 * An operation token appears in a request start line, e.g. `SLTP/1.0 CREATE_SESSION`.
 * Tokens are uppercase letters, digits, and underscores. A token that is syntactically
 * valid but absent from this registry is answered with 501 OPERATION NOT SUPPORTED.
 */

/** Where an operation may be sent. */
export type SltpOperationTarget = 'control' | 'mock-endpoint' | 'both';

/** One entry in the operation registry. */
export interface SltpOperationDefinition {
  /** The token as it appears on the wire. */
  readonly name: string;
  /** Whether the request MUST carry a Session-ID header. */
  readonly requiresSession: boolean;
  /** Whether the request MUST carry a body. */
  readonly requiresBody: boolean;
  /** Whether a body is permitted at all. */
  readonly allowsBody: boolean;
  /** Which endpoint accepts the operation. */
  readonly target: SltpOperationTarget;
  /** Status codes this operation may return, excluding the generic error set. */
  readonly successStatuses: readonly number[];
  /** One-line summary used by `--help`, the interface, and the specification. */
  readonly summary: string;
}

/** String constants for every registered operation. */
export const SLTP_OPERATION = {
  PING: 'PING',
  SERVER_INFO: 'SERVER_INFO',
  CREATE_SESSION: 'CREATE_SESSION',
  GET_SESSION: 'GET_SESSION',
  LIST_SESSIONS: 'LIST_SESSIONS',
  ADD_RULE: 'ADD_RULE',
  UPDATE_RULE: 'UPDATE_RULE',
  DELETE_RULE: 'DELETE_RULE',
  LIST_RULES: 'LIST_RULES',
  RUN_TEST: 'RUN_TEST',
  GET_RESULT: 'GET_RESULT',
  LIST_RESULTS: 'LIST_RESULTS',
  CLOSE_SESSION: 'CLOSE_SESSION',
} as const;

/** Union of the operation tokens defined by SLTP/1.0. */
export type SltpOperation = (typeof SLTP_OPERATION)[keyof typeof SLTP_OPERATION];

/** Grammar for an operation token. */
export const OPERATION_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

/** The registry, in the order documented by the specification. */
export const SLTP_OPERATION_REGISTRY: readonly SltpOperationDefinition[] = [
  {
    name: 'PING',
    requiresSession: false,
    requiresBody: false,
    allowsBody: true,
    target: 'both',
    successStatuses: [200],
    summary: 'Liveness probe. Returns server time, uptime, and any echo value supplied.',
  },
  {
    name: 'SERVER_INFO',
    requiresSession: false,
    requiresBody: false,
    allowsBody: false,
    target: 'control',
    successStatuses: [200],
    summary: 'Reports protocol version, configured limits, capabilities, and current counts.',
  },
  {
    name: 'CREATE_SESSION',
    requiresSession: false,
    requiresBody: false,
    allowsBody: true,
    target: 'control',
    successStatuses: [201],
    summary: 'Creates an isolated testing session and starts its dedicated TCP mock endpoint.',
  },
  {
    name: 'GET_SESSION',
    requiresSession: true,
    requiresBody: false,
    allowsBody: false,
    target: 'control',
    successStatuses: [200],
    summary: 'Returns one session, including its mock endpoint host and port.',
  },
  {
    name: 'LIST_SESSIONS',
    requiresSession: false,
    requiresBody: false,
    allowsBody: false,
    target: 'control',
    successStatuses: [200],
    summary: 'Returns every session known to the server, newest first.',
  },
  {
    name: 'ADD_RULE',
    requiresSession: true,
    requiresBody: true,
    allowsBody: true,
    target: 'control',
    successStatuses: [212],
    summary: 'Stores a mock response rule in the session.',
  },
  {
    name: 'UPDATE_RULE',
    requiresSession: true,
    requiresBody: true,
    allowsBody: true,
    target: 'control',
    successStatuses: [213],
    summary: 'Replaces the mutable fields of an existing mock rule.',
  },
  {
    name: 'DELETE_RULE',
    requiresSession: true,
    requiresBody: true,
    allowsBody: true,
    target: 'control',
    successStatuses: [214],
    summary: 'Removes a mock rule from the session.',
  },
  {
    name: 'LIST_RULES',
    requiresSession: true,
    requiresBody: false,
    allowsBody: false,
    target: 'control',
    successStatuses: [200],
    summary: 'Returns the session rules in the exact order the matcher evaluates them.',
  },
  {
    name: 'RUN_TEST',
    requiresSession: true,
    requiresBody: true,
    allowsBody: true,
    target: 'control',
    successStatuses: [210, 211, 202],
    summary:
      'Executes a test scenario over a real TCP connection and compares expected with actual.',
  },
  {
    name: 'GET_RESULT',
    requiresSession: true,
    requiresBody: true,
    allowsBody: true,
    target: 'control',
    successStatuses: [200],
    summary: 'Returns one stored test result in full.',
  },
  {
    name: 'LIST_RESULTS',
    requiresSession: true,
    requiresBody: false,
    allowsBody: false,
    target: 'control',
    successStatuses: [200],
    summary: 'Returns a summary of every stored test result in the session.',
  },
  {
    name: 'CLOSE_SESSION',
    requiresSession: true,
    requiresBody: false,
    allowsBody: false,
    target: 'control',
    successStatuses: [204],
    summary: 'Closes the session and shuts down its mock endpoint. Results stay readable.',
  },
];

const REGISTRY_BY_NAME = new Map<string, SltpOperationDefinition>(
  SLTP_OPERATION_REGISTRY.map((entry) => [entry.name, entry]),
);

/** Returns the registry entry for `name`, or `undefined` when unregistered. */
export function findOperation(name: string): SltpOperationDefinition | undefined {
  return REGISTRY_BY_NAME.get(name);
}

/** True when `name` is a registered SLTP/1.0 operation. */
export function isKnownOperation(name: string): name is SltpOperation {
  return REGISTRY_BY_NAME.has(name);
}

/** True when `name` matches the operation-token grammar, whether registered or not. */
export function isValidOperationToken(name: string): boolean {
  return OPERATION_PATTERN.test(name);
}

/** Every registered operation token. */
export function allOperationNames(): string[] {
  return SLTP_OPERATION_REGISTRY.map((entry) => entry.name);
}

/** Operations accepted by the control server. */
export function controlOperationNames(): string[] {
  return SLTP_OPERATION_REGISTRY.filter(
    (entry) => entry.target === 'control' || entry.target === 'both',
  ).map((entry) => entry.name);
}
