// Public surface of the core domain models (task 2.1).
//
// This barrel re-exports every domain type and its validating constructor so an
// outer layer imports them from `@app/core` (via `../index.js`) without reaching
// into individual files. Ordering mirrors the design's Data Models section:
// shared primitives first, then the domain aggregates that build on them.

// Shared primitives: results, typed errors, identifiers, and closed unions.
export * from './result.js';
export * from './domain-error.js';
export * from './identifier.js';
export * from './enums.js';

// Domain aggregates and their construction-time invariants.
export * from './project.js';
export * from './spec.js';
export * from './testbench.js';
export * from './trace.js';
export * from './verification.js';
export * from './labeled-artifact.js';
export * from './session-budget.js';
