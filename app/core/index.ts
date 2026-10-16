// @app/core - domain types and pure logic (innermost layer).
//
// This layer has no dependencies on any other app/ layer. The domain models and
// verdict logic are implemented here (tasks 2.1-2.2); the Session_Budget,
// Trust_Labeler, and eval-gate submodules land in later tasks (8.1, 8.3, 19).
// This file establishes the package entry point and re-exports the domain
// submodules that mirror the design's core/ layout.

export * from './models/index.js';
export * from './verdict/index.js';
export * from './trust/index.js';
export * from './budget/index.js';
export * from './eval-gate/index.js';
export * from './redaction/index.js';

/** Layer identifier, used to prove cross-package resolution through the scaffold. */
export const CORE_LAYER = 'core' as const;
