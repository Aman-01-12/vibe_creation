// The narrowing primitives every sweep-config parser is built from, plus the typed
// error the whole boundary reports through.
//
// The sweep config is a JSON file an operator hand-edits, so it is UNTRUSTED input
// at this boundary in exactly the way a client payload is: a missing field, a string
// where a number belongs, an array where an object belongs, or a value out of range
// must all become a typed, actionable error BEFORE anything is composed - never a
// `NaN` that surfaces three hours into a run as an unexplained provider failure.
//
// Every helper here is total: it narrows or it returns `null`. None throws, so the
// parsers above compose them with guard clauses and attribute each failure to the
// field that caused it.

import { err, ok, type Result } from '@app/core';

/** Stable, machine-readable codes for each way a sweep config can be invalid. */
export type SweepConfigErrorCode =
  | 'NOT_AN_OBJECT'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'FIELD_MISSING'
  | 'FIELD_NOT_A_STRING'
  | 'FIELD_NOT_AN_OBJECT'
  | 'FIELD_NOT_AN_ARRAY'
  | 'FIELD_NOT_A_BOOLEAN'
  | 'FIELD_OUT_OF_RANGE'
  | 'ARM_INVALID'
  | 'ARM_NAME_DUPLICATED'
  | 'ARM_MODEL_AMBIGUOUS'
  | 'ARM_ROLE_MODEL_MISSING'
  | 'PROBLEM_SELECTION_INVALID'
  | 'REPRODUCIBILITY_INVALID'
  | 'PRICE_INVALID'
  | 'K_OUT_OF_RANGE'
  | 'UNKNOWN_FIELD';

/**
 * A typed sweep-config validation failure.
 *
 * Carries a code, an operator-facing message, and the offending field path. It never
 * echoes the offending VALUE: a config is a file an operator may have pasted a
 * credential into by mistake, and this message can reach stdout and a log.
 */
export interface SweepConfigError {
  readonly code: SweepConfigErrorCode;
  readonly message: string;
  /** Dotted path of the offending field, when the failure is attributable to one. */
  readonly field: string;
}

/** The result shape every sweep-config parser returns. */
export type SweepConfigResult<T> = Result<T, SweepConfigError>;

/** Build a failed parse result carrying a typed, field-attributed error. */
export function configFailure<T>(
  code: SweepConfigErrorCode,
  field: string,
  message: string,
): SweepConfigResult<T> {
  return err({ code, message, field });
}

/** Build a successful parse result (a thin alias so parsers read symmetrically). */
export function configValue<T>(value: T): SweepConfigResult<T> {
  return ok(value);
}

/** Narrow an unknown to a plain object record, or `null` for anything else. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Narrow an unknown to an array of unknowns, or `null` for anything else. */
export function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

/** The trimmed string, or `null` when the value is not a non-blank string. */
export function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** An integer within the inclusive range, or `null` when it is neither. */
export function asIntegerInRange(value: unknown, low: number, high: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) {
    return null;
  }
  return value;
}

/** A finite number within the inclusive range, or `null` when it is neither. */
export function asFiniteInRange(value: unknown, low: number, high: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
    return null;
  }
  return value;
}

/** Read a required object field, or report a typed failure naming it. */
export function requireRecord(
  parent: Record<string, unknown>,
  field: string,
): SweepConfigResult<Record<string, unknown>> {
  const raw = parent[field];
  if (raw === undefined) {
    return configFailure('FIELD_MISSING', field, `${field} is required`);
  }
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('FIELD_NOT_AN_OBJECT', field, `${field} must be an object`);
  }
  return configValue(record);
}

/** Read a required non-blank string field, or report a typed failure naming it. */
export function requireString(
  parent: Record<string, unknown>,
  field: string,
): SweepConfigResult<string> {
  const value = asTrimmedString(parent[field]);
  if (value === null) {
    return configFailure('FIELD_NOT_A_STRING', field, `${field} must be a non-empty string`);
  }
  return configValue(value);
}

/** Read a required integer field bounded to a range, or report a typed failure. */
export function requireIntegerInRange(
  parent: Record<string, unknown>,
  field: string,
  bounds: { readonly low: number; readonly high: number },
): SweepConfigResult<number> {
  const value = asIntegerInRange(parent[field], bounds.low, bounds.high);
  if (value === null) {
    return configFailure(
      'FIELD_OUT_OF_RANGE',
      field,
      `${field} must be an integer in [${bounds.low}, ${bounds.high}]`,
    );
  }
  return configValue(value);
}

/** Read a required finite-number field bounded to a range, or report a typed failure. */
export function requireFiniteInRange(
  parent: Record<string, unknown>,
  field: string,
  bounds: { readonly low: number; readonly high: number },
): SweepConfigResult<number> {
  const value = asFiniteInRange(parent[field], bounds.low, bounds.high);
  if (value === null) {
    return configFailure(
      'FIELD_OUT_OF_RANGE',
      field,
      `${field} must be a finite number in [${bounds.low}, ${bounds.high}]`,
    );
  }
  return configValue(value);
}

/**
 * Keys beginning with this are ignored by the parser: JSON has no comment syntax, and the
 * example config documents itself inline, so `_`-prefixed keys are the comment convention.
 */
const COMMENT_KEY_PREFIX = '_';

/**
 * Reject a key the parser does not understand.
 *
 * This exists because of the OPTIONAL fields. A typo in a required field surfaces as
 * "field missing"; a typo in an optional one would silently take a default the operator
 * never chose - `killSwitch.maxWallClokMs` would quietly grant eight hours instead of the
 * two that were asked for. Refusing the unknown key turns that class of mistake into an
 * immediate, named error.
 */
export function unknownKeyError(
  record: Record<string, unknown>,
  allowed: readonly string[],
  parentField: string,
): SweepConfigError | null {
  const permitted = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (key.startsWith(COMMENT_KEY_PREFIX) || permitted.has(key)) {
      continue;
    }
    const path = parentField.length === 0 ? key : `${parentField}.${key}`;
    return {
      code: 'UNKNOWN_FIELD',
      message: `${path} is not a recognized field; prefix a key with "_" to use it as a comment`,
      field: path,
    };
  }
  return null;
}

/**
 * Read an OPTIONAL integer field bounded to a range, defaulting when absent.
 *
 * A field that is present but unusable still fails: silently substituting the
 * default would hide an operator's typo behind a number they did not choose, and a
 * sweep's cost and duration depend on exactly these knobs.
 */
export function optionalIntegerInRange(
  parent: Record<string, unknown>,
  field: string,
  bounds: { readonly low: number; readonly high: number; readonly fallback: number },
): SweepConfigResult<number> {
  if (parent[field] === undefined) {
    return configValue(bounds.fallback);
  }
  return requireIntegerInRange(parent, field, bounds);
}

/**
 * Read an OPTIONAL boolean field, defaulting when absent.
 *
 * A present but non-boolean value fails for the same reason as every other optional knob:
 * `"captureArtifacts": "false"` is a string, and quietly reading it as truthy would give an
 * operator the opposite of what they wrote.
 */
export function optionalBoolean(
  parent: Record<string, unknown>,
  field: string,
  fallback: boolean,
): SweepConfigResult<boolean> {
  const raw = parent[field];
  if (raw === undefined) {
    return configValue(fallback);
  }
  if (typeof raw !== 'boolean') {
    return configFailure('FIELD_NOT_A_BOOLEAN', field, `${field} must be true or false`);
  }
  return configValue(raw);
}
