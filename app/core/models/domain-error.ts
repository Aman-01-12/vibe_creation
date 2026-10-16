// Typed domain errors for invariant violations.
//
// Validation failures in this layer never throw a bare string and never return
// null; they return a `DomainError` carrying a stable machine-readable `code`, a
// human-readable `message`, and optionally the offending `field`. Callers switch
// on `code`; humans read `message`. Messages describe the violated invariant only
// and never embed secrets, hosts, paths, or stack traces.

/**
 * Stable identifiers for each invariant this layer enforces at construction time.
 *
 * These are part of the module's contract: callers may branch on them, so they
 * are treated as append-only.
 */
export type DomainErrorCode =
  | 'INVALID_ULID'
  | 'EMPTY_FIELD'
  | 'PORT_WIDTH_NOT_POSITIVE_INTEGER'
  | 'VALIDITY_OUTPUT_NOT_A_DECLARED_OUTPUT_PORT'
  | 'MISSING_PORT_TIMING'
  | 'TIMING_ENTRY_NOT_AN_OUTPUT_PORT'
  | 'DUPLICATE_PORT_TIMING_ENTRY'
  | 'PASS_VERDICT_REQUIRES_ALL_CHECKS_PASSED'
  | 'PASS_VERDICT_REQUIRES_ORACLE_SPAN'
  | 'VERIFIED_REQUIRES_ORACLE_SPAN_REF'
  | 'NEGATIVE_QUANTITY'
  | 'PROBABILITY_OUT_OF_RANGE'
  | 'EVAL_BASELINE_NOT_POSITIVE'
  | 'EVAL_FLOOR_NOT_BELOW_BASELINE'
  | 'EVAL_LOWERING_NOT_APPROVED'
  | 'EVAL_LOWERING_NOT_A_DECREASE'
  | 'EVAL_SEED_OUT_OF_RANGE'
  | 'EVAL_TEMPERATURE_OUT_OF_RANGE'
  | 'EVAL_SAMPLE_COUNT_NOT_POSITIVE'
  | 'EVAL_K_OUT_OF_RANGE'
  | 'EVAL_COST_ENVELOPE_INVALID'
  | 'MEASUREMENT_LIMIT_NOT_DECLARED'
  | 'INVALID_VERILOG_IDENTIFIER'
  | 'RESERVED_VERILOG_KEYWORD'
  | 'DUPLICATE_PORT_NAME';

/** A typed, descriptive failure produced by a validating constructor. */
export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  /** The offending field path, when the error is attributable to one field. */
  readonly field?: string;
}

/** Construct a `DomainError`, attaching a field only when one is supplied. */
export function domainError(code: DomainErrorCode, message: string, field?: string): DomainError {
  // exactOptionalPropertyTypes: only include `field` when actually provided,
  // rather than setting it to `undefined`.
  return field === undefined ? { code, message } : { code, message, field };
}
