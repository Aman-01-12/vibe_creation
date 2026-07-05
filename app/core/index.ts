// @app/core - domain types and pure logic (innermost layer).
//
// This layer has no dependencies on any other app/ layer. Implementations land in
// later tasks; this file establishes the package entry point and re-exports the
// domain submodules that mirror the design's core/ layout.

export * from './models/index.js';
export * from './verdict/index.js';
export * from './trust/index.js';
export * from './budget/index.js';
export * from './eval-gate/index.js';

/** Layer identifier, used to prove cross-package resolution through the scaffold. */
export const CORE_LAYER = 'core' as const;
