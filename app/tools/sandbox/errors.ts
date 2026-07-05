// Typed errors for the Tool_Runner contract boundary.
//
// A contract violation at this seam is exceptional, not an expected recoverable
// outcome: it means an invalid job reached the adapter (a caller bug or a boundary
// breach) or the adapter produced a result that does not satisfy the seam (an
// internal invariant break). Callers of `ToolRunner.run` therefore receive a
// thrown, typed error rather than a `Result` arm, matching the design interface.
//
// Issue messages are sanitized: they carry only the schema path and rule that
// failed, never the offending data values, so nothing sensitive leaks into logs
// or the Trace.

/** Which side of the seam failed validation. */
export type ContractViolationCode = 'SANDBOX_JOB_INVALID' | 'SANDBOX_RESULT_INVALID';

/** A sanitized description of one or more contract validation failures. */
export interface ContractViolation {
  readonly code: ContractViolationCode;
  readonly message: string;
  /** Sanitized `schema-path rule` descriptions; never the offending values. */
  readonly issues: readonly string[];
}

/** Thrown when a sandbox job or result fails contract validation. */
export class SandboxContractError extends Error {
  readonly violation: ContractViolation;

  constructor(violation: ContractViolation) {
    super(violation.message);
    this.name = 'SandboxContractError';
    this.violation = violation;
  }
}
