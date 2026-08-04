/**
 * `@socketlens/protocol` — the complete SLTP/1.0 reference implementation.
 *
 * This package is the single source of truth for the protocol. The server, the CLI
 * client, and the bridge that backs the graphical interface all encode and decode
 * SLTP through the exact same code, so a protocol change can never drift between
 * the three applications.
 *
 * The package has no runtime dependencies beyond the Node.js standard library.
 */

// Wire constants and configurable limits.
export * from './constants.js';

// Status registry: codes, canonical phrases, meanings, and permitted contexts.
export * from './status.js';

// Operation registry: tokens, session scope, body rules, and target endpoint.
export * from './operations.js';

// Header names, grammar, and order-preserving accessors.
export * from './headers.js';

// Message shapes, including the JSON-safe view used by the graphical client.
export * from './types.js';

// Framing/validation failure taxonomy and reason codes.
export * from './errors.js';

// Serialisation to wire bytes.
export * from './encoder.js';

// Incremental decoding of a TCP byte stream.
export * from './decoder.js';

// Semantic request validation in the specified order.
export * from './validate.js';

// Presentation helpers. `display.ts` is browser-safe; `format.ts` handles Buffers.
export * from './display.js';
export * from './format.js';
