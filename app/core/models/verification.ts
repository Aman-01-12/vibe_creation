// The module-under-construction and the recorded outcome of verifying it.
//
// Invariant encoded here: a `pass` verdict requires `allChecksPassed === true`
// and a real oracle span id (Req 8.10). A `fail`/`error` verdict must not claim
// all checks passed. TypeScript cannot tie a boolean to a union member's value,
// so this is enforced by the validating `makeVerificationResult` constructor.

import { passIntegrityHolds } from '../verdict/index.js';
import { domainError, type DomainError } from './domain-error.js';
import type { BudgetStopReason, Verdict } from './enums.js';
import { isUlid, type Ulid } from './identifier.js';
import { err, ok, type Result } from './result.js';

/** One generated candidate implementation of the approved Spec. */
export interface ModuleVersion {
  readonly id: Ulid;
  readonly projectId: Ulid;
  readonly specVersion: number;
  readonly rtl: string;
  /** ISO-8601 timestamp. */
  readonly createdAt: string;
}

/**
 * The concrete case that made a run fail, surfaced to the Student and Teach_Mode.
 *
 * Note: the design references `FailingCase` without fixing its fields; this
 * minimal, self-describing shape is the decision for this slice.
 */
export interface FailingCase {
  /** The spec-derived check that failed. */
  readonly checkName: string;
  /** Human-readable description of the failing scenario. */
  readonly description: string;
  /** Expected value or behavior, as reported by the testbench. */
  readonly expected: string;
  /** Observed value or behavior from the simulation. */
  readonly observed: string;
  /** Simulation time of the failure in nanoseconds, or `null` if not localized. */
  readonly atSimTimeNs: number | null;
}

/** The recorded outcome of a Verification_Loop run for one module version. */
export interface VerificationResult {
  readonly id: Ulid;
  readonly moduleVersionId: Ulid;
  readonly testbenchId: Ulid;
  readonly verdict: Verdict;
  /** A `pass` verdict requires this to be `true` (Req 8.10). */
  readonly allChecksPassed: boolean;
  /** Present only on a non-passing run. */
  readonly failingCase?: FailingCase;
  readonly iterations: number;
  readonly costCents: number;
  /** The Trace span that IS the ground truth for this verdict. */
  readonly oracleSpanId: Ulid;
  /** Present only when a Session_Budget cap stopped the run. */
  readonly stopReason?: BudgetStopReason;
}

/** Fields a caller supplies to build a `VerificationResult`. */
interface VerificationResultInput {
  readonly id: Ulid;
  readonly moduleVersionId: Ulid;
  readonly testbenchId: Ulid;
  readonly verdict: Verdict;
  readonly allChecksPassed: boolean;
  readonly failingCase?: FailingCase;
  readonly iterations: number;
  readonly costCents: number;
  readonly oracleSpanId: Ulid;
  readonly stopReason?: BudgetStopReason;
}

/**
 * Validate the pass-integrity invariant for the supplied fields.
 *
 * The pass-integrity rule itself lives in `@app/core/verdict` (`passIntegrityHolds`)
 * so there is one owner shared with the runner-outcome classifier; this function
 * adds the `VerificationResult`-only provenance requirement (a real oracle span).
 */
function checkPassIntegrity(input: VerificationResultInput): DomainError | null {
  if (input.verdict !== 'pass') {
    return null;
  }
  if (!passIntegrityHolds(input.verdict, input.allChecksPassed)) {
    return domainError(
      'PASS_VERDICT_REQUIRES_ALL_CHECKS_PASSED',
      'A pass verdict requires every spec-derived check to pass',
      'allChecksPassed',
    );
  }
  if (!isUlid(input.oracleSpanId)) {
    return domainError(
      'PASS_VERDICT_REQUIRES_ORACLE_SPAN',
      'A pass verdict requires a real oracle span id',
      'oracleSpanId',
    );
  }
  return null;
}

/** Reconstruct the result object, including optional fields only when present. */
function buildVerificationResult(input: VerificationResultInput): VerificationResult {
  const base = {
    id: input.id,
    moduleVersionId: input.moduleVersionId,
    testbenchId: input.testbenchId,
    verdict: input.verdict,
    allChecksPassed: input.allChecksPassed,
    iterations: input.iterations,
    costCents: input.costCents,
    oracleSpanId: input.oracleSpanId,
  };
  const withFailing =
    input.failingCase === undefined ? base : { ...base, failingCase: input.failingCase };
  return input.stopReason === undefined
    ? withFailing
    : { ...withFailing, stopReason: input.stopReason };
}

/**
 * Construct a `VerificationResult`, enforcing pass integrity (Req 8.10).
 *
 * Rejects a `pass` verdict that does not have all checks passed or lacks a valid
 * oracle span id, and rejects negative iteration or cost counts.
 */
export function makeVerificationResult(
  input: VerificationResultInput,
): Result<VerificationResult, DomainError> {
  if (input.iterations < 0 || !Number.isInteger(input.iterations)) {
    return err(
      domainError('NEGATIVE_QUANTITY', 'iterations must be a non-negative integer', 'iterations'),
    );
  }
  if (input.costCents < 0) {
    return err(domainError('NEGATIVE_QUANTITY', 'costCents must not be negative', 'costCents'));
  }
  const integrityError = checkPassIntegrity(input);
  if (integrityError !== null) {
    return err(integrityError);
  }
  return ok(buildVerificationResult(input));
}
