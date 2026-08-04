/**
 * `@socketlens/core` — the shared application logic behind every SocketLens TCP client.
 *
 * The control server, the CLI, and the browser bridge all build on this package, so
 * session semantics, rule matching, assertion evaluation, and scenario execution
 * behave identically no matter which interface the user drives them from.
 *
 * SLTP itself lives in `@socketlens/protocol`; nothing here re-implements it.
 */

// Plain-data domain models shared across every process boundary.
export * from './models.js';

// Readable, process-unique identifiers.
export * from './ids.js';

// Protocol traffic logging.
export * from './logger.js';

// Semantic validation of client-supplied rules and scenarios.
export * from './validation.js';

// Deterministic mock rule ordering and matching.
export * from './matching.js';

// Expected-versus-actual comparison.
export * from './assertions.js';

// Per-session TCP mock endpoint.
export * from './mock-endpoint.js';

// Session, rule, and result storage.
export * from './session-store.js';

// Scenario execution over a real TCP connection.
export * from './test-runner.js';

// The shared SLTP client.
export * from './client.js';

// Scenario and result serialisation.
export * from './scenarios.js';
