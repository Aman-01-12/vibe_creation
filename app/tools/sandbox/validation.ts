// Contract validation for the Tool_Runner seam (TypeScript side).
//
// Both sides of the language-neutral seam validate against the canonical schema:
// this module compiles job and result validators from `sandboxContractSchema`
// with ajv, and the Python worker (task 3.2) validates against the byte-mirror
// `contract.schema.json`. The adapter validates every inbound job (untrusted
// input at the trust boundary) and every outbound result (its own invariant)
// before either crosses the seam.

import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';

import { err, ok, type Result } from '@app/core';

import { SANDBOX_JOB_REF, SANDBOX_RESULT_REF, sandboxContractSchema } from './contract-schema.js';
import type { SandboxJob, SandboxResult } from './contract.js';
import type { ContractViolation } from './errors.js';

// One ajv instance owns the compiled seam validators for the process. `strict`
// surfaces schema authoring mistakes; `allErrors` reports every failure so a
// rejection lists all issues rather than only the first.
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(sandboxContractSchema);

/**
 * Compile a subschema validator, failing fast if it is missing.
 *
 * A missing validator means the seam schema failed to compile: a programming
 * error, surfaced at module load rather than at first use. The seam is sync, so
 * the returned validator is a synchronous `ValidateFunction`.
 */
function compileValidator<T>(ref: string): ValidateFunction<T> {
  const validator = ajv.getSchema<T>(ref);
  if (validator === undefined) {
    throw new Error(`Tool_Runner contract schema failed to compile validator for ${ref}`);
  }
  return validator as ValidateFunction<T>;
}

const jobValidator = compileValidator<SandboxJob>(SANDBOX_JOB_REF);
const resultValidator = compileValidator<SandboxResult>(SANDBOX_RESULT_REF);

/** Reduce ajv errors to sanitized `path rule` strings that carry no data values. */
function summarizeIssues(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (errors === null || errors === undefined) {
    return [];
  }
  return errors.map((issue) => {
    const path = issue.instancePath.length > 0 ? issue.instancePath : '(root)';
    return `${path} ${issue.message ?? 'failed validation'}`;
  });
}

/**
 * Validate untrusted input as a `SandboxJob` (the trust boundary at the seam).
 *
 * Returns the narrowed job on success, or a sanitized contract violation.
 */
export function validateSandboxJob(raw: unknown): Result<SandboxJob, ContractViolation> {
  if (jobValidator(raw)) {
    return ok(raw);
  }
  return err({
    code: 'SANDBOX_JOB_INVALID',
    message: 'Sandbox job failed contract validation',
    issues: summarizeIssues(jobValidator.errors),
  });
}

/**
 * Validate an adapter-produced `SandboxResult` against the seam before returning.
 *
 * Returns the narrowed result on success, or a sanitized contract violation.
 */
export function validateSandboxResult(raw: unknown): Result<SandboxResult, ContractViolation> {
  if (resultValidator(raw)) {
    return ok(raw);
  }
  return err({
    code: 'SANDBOX_RESULT_INVALID',
    message: 'Sandbox result failed contract validation',
    issues: summarizeIssues(resultValidator.errors),
  });
}
