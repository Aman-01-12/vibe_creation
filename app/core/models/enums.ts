// Closed string-literal unions shared across the domain model.
//
// Each union is the single source of truth for its set of values, so exhaustive
// `switch` statements elsewhere fail the type check (via a `never` default) when
// a value is added here without handling it.

/**
 * How strongly a deterministic oracle proved an artifact.
 *
 * - `Verified`: a passing Simulator verdict exists for the artifact's current
 *   version (only the Trust_Labeler may assign this, bound to that verdict span).
 * - `Unverified`: no passing oracle verdict exists yet.
 * - `Not_Applicable`: an input or pedagogy artifact that makes no correctness
 *   claim.
 */
export type TrustTier = 'Verified' | 'Unverified' | 'Not_Applicable';

/**
 * The outcome of a compile-and-simulate invocation.
 *
 * `error` is reserved for tool or infrastructure failure (including a wall-clock
 * timeout) and is distinct from a functional `fail`.
 */
export type Verdict = 'pass' | 'fail' | 'error';

/** The direction of a module interface port. */
export type PortDirection = 'input' | 'output' | 'inout';

/** The rigorous method by which an acceptance criterion is verified. */
export type AcceptanceMethod = 'simulation' | 'formal' | 'manual-inspection';

/**
 * Which Session_Budget cap terminated a loop run.
 *
 * Mirrors the four caps on `SessionBudget`; a stop reason is recorded whenever a
 * run halts for budget reasons.
 */
export type BudgetStopReason = 'max-iterations' | 'max-tokens' | 'max-wall-clock' | 'max-cost';

/**
 * Classification of a failed invocation, recorded on the Trace span that failed.
 *
 * Distinguishes a functional check failure from the tool/infra failures that map
 * to the `error` verdict, so recovery logic and diagnostics can branch on cause.
 */
export type FailureClass =
  'compile-error' | 'functional-fail' | 'timeout' | 'tool-error' | 'sandbox-denied';
