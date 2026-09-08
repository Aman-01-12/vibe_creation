// The version-controlled eval-gate baseline configuration (task 19.5, Req 15.4,
// 15.7, 15.8, 15.9).
//
// `eval-baseline.json` is the single source of truth for whether the CI eval
// pass@k gate is ARMED and, if so, against what baseline/tolerance/floor. It is
// version-controlled so arming is an explicit, reviewed commit rather than a
// runtime surprise, and it defaults to UNARMED because no verified non-zero
// baseline exists yet (Req 15.7).
//
// This module parses that file into a validated `EvalGate` (the pure decision
// object owned by `@app/core`). Although the file lives in-repo, it is still
// untrusted input at this boundary - a bad edit, a merge accident, or a hand-typed
// number - so every field is validated and the parser returns a typed
// `BaselineConfigError` rather than throwing or trusting the shape.
//
// The HONESTY invariant (the prime directive) is enforced structurally here: an
// ARMED config MUST carry provenance naming who/what measured the baseline
// (`provenance.measuredBy` and `provenance.measuredAt`). You cannot flip `armed`
// to true without recording that a real oracle produced the number, so the config
// itself refuses a fabricated arming.

import { makeArmedGate, UNARMED_GATE, type EvalGate, type Result } from '@app/core';

/** Stable, machine-readable codes for each way the baseline config can be invalid. */
export type BaselineConfigErrorCode =
  | 'NOT_AN_OBJECT'
  | 'ARMED_NOT_BOOLEAN'
  | 'K_NOT_POSITIVE_INTEGER'
  | 'TOLERANCE_INVALID'
  | 'NOTES_NOT_STRING'
  | 'PROVENANCE_INVALID'
  | 'ARMED_BASELINE_NOT_NUMBER'
  | 'ARMED_FLOOR_NOT_NUMBER'
  | 'ARMED_GATE_INVALID'
  | 'ARMED_PROVENANCE_MISSING';

/** A typed baseline-config validation failure; never carries a secret or a path. */
export interface BaselineConfigError {
  readonly code: BaselineConfigErrorCode;
  readonly message: string;
  /** The offending field, when the failure is attributable to one. */
  readonly field?: string;
}

/**
 * Where a recorded baseline came from.
 *
 * When the gate is armed this is the audit trail proving the baseline was measured
 * by the real oracle, not invented: `measuredBy` names the toolchain/harness and
 * `measuredAt` the time, and the remaining fields pin the exact run (host, commit,
 * seed, sample count) so the number is reproducible.
 */
export interface BaselineProvenance {
  readonly measuredBy: string | null;
  readonly measuredAt: string | null;
  readonly host: string | null;
  readonly commit: string | null;
  readonly seed: number | null;
  readonly sampleCount: number | null;
}

/** The parsed, validated baseline configuration the gate CLI runs against. */
export interface ParsedBaselineConfig {
  /** The decision object `decideEvalGate` consumes: unarmed, or armed with thresholds. */
  readonly gate: EvalGate;
  /** Which pass@k the gate compares against the baseline. */
  readonly k: number;
  /** The agreed noise tolerance, echoed for reporting (also inside `gate` when armed). */
  readonly tolerance: number;
  /** The human-readable notes recorded in the config. */
  readonly notes: string;
  /** The measurement provenance (audit trail for an armed baseline). */
  readonly provenance: BaselineProvenance;
}

/** Build a failed parse result carrying a typed error. */
function fail(
  code: BaselineConfigErrorCode,
  message: string,
  field?: string,
): Result<ParsedBaselineConfig, BaselineConfigError> {
  const error: BaselineConfigError =
    field === undefined ? { code, message } : { code, message, field };
  return { ok: false, error };
}

/** Narrow an unknown to a plain object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite number, or null for any other value (including NaN and infinities). */
function asFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A non-empty trimmed string, or null for anything else. */
function asNonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Read one provenance field as a finite number or null (absent/invalid -> null). */
function provenanceNumber(value: unknown): number | null {
  return asFiniteNumberOrNull(value);
}

/** Read one provenance field as a non-empty string or null (absent/invalid -> null). */
function provenanceString(value: unknown): string | null {
  return asNonEmptyStringOrNull(value);
}

/**
 * Parse the optional `provenance` block.
 *
 * A missing block is allowed (it yields an all-null provenance, which is only
 * acceptable for an unarmed gate); a present block must be an object. Individual
 * fields are read leniently into `string | null` / `number | null` because their
 * presence is only *required* when arming, which is checked separately.
 */
function parseProvenance(raw: unknown): Result<BaselineProvenance, BaselineConfigError> {
  if (raw === undefined) {
    return {
      ok: true,
      value: {
        measuredBy: null,
        measuredAt: null,
        host: null,
        commit: null,
        seed: null,
        sampleCount: null,
      },
    };
  }
  const record = asRecord(raw);
  if (record === null) {
    return {
      ok: false,
      error: {
        code: 'PROVENANCE_INVALID',
        message: 'provenance must be an object',
        field: 'provenance',
      },
    };
  }
  return {
    ok: true,
    value: {
      measuredBy: provenanceString(record.measuredBy),
      measuredAt: provenanceString(record.measuredAt),
      host: provenanceString(record.host),
      commit: provenanceString(record.commit),
      seed: provenanceNumber(record.seed),
      sampleCount: provenanceNumber(record.sampleCount),
    },
  };
}

/** Common fields shared by both the armed and unarmed arms, validated once. */
interface CommonFields {
  readonly armed: boolean;
  readonly k: number;
  readonly tolerance: number;
  readonly notes: string;
  readonly provenance: BaselineProvenance;
}

/** Validate the fields present regardless of whether the gate is armed. */
function parseCommon(record: Record<string, unknown>): Result<CommonFields, BaselineConfigError> {
  if (typeof record.armed !== 'boolean') {
    return {
      ok: false,
      error: { code: 'ARMED_NOT_BOOLEAN', message: 'armed must be a boolean', field: 'armed' },
    };
  }
  const k = record.k;
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1) {
    return {
      ok: false,
      error: {
        code: 'K_NOT_POSITIVE_INTEGER',
        message: 'k must be a positive integer',
        field: 'k',
      },
    };
  }
  const tolerance = asFiniteNumberOrNull(record.tolerance);
  if (tolerance === null || tolerance < 0) {
    return {
      ok: false,
      error: {
        code: 'TOLERANCE_INVALID',
        message: 'tolerance must be a non-negative finite number',
        field: 'tolerance',
      },
    };
  }
  if (record.notes !== undefined && typeof record.notes !== 'string') {
    return {
      ok: false,
      error: { code: 'NOTES_NOT_STRING', message: 'notes must be a string', field: 'notes' },
    };
  }
  const provenance = parseProvenance(record.provenance);
  if (!provenance.ok) {
    return provenance;
  }
  return {
    ok: true,
    value: {
      armed: record.armed,
      k,
      tolerance,
      notes: typeof record.notes === 'string' ? record.notes : '',
      provenance: provenance.value,
    },
  };
}

/**
 * Build the armed arm: validate the baseline/floor numbers, enforce the honesty
 * provenance requirement, and construct the `ArmedGate` through the core
 * constructor (which enforces `floor < baseline`, tolerance >= 0, and the ranges).
 */
function parseArmed(
  record: Record<string, unknown>,
  common: CommonFields,
): Result<ParsedBaselineConfig, BaselineConfigError> {
  const baseline = asFiniteNumberOrNull(record.baseline);
  if (baseline === null) {
    return fail(
      'ARMED_BASELINE_NOT_NUMBER',
      'an armed config must record a numeric baseline',
      'baseline',
    );
  }
  const floor = asFiniteNumberOrNull(record.floor);
  if (floor === null) {
    return fail('ARMED_FLOOR_NOT_NUMBER', 'an armed config must record a numeric floor', 'floor');
  }
  // HONESTY (prime directive): arming requires an audit trail proving the baseline
  // was measured by the real oracle, not fabricated.
  if (common.provenance.measuredBy === null || common.provenance.measuredAt === null) {
    return fail(
      'ARMED_PROVENANCE_MISSING',
      'an armed config must record provenance.measuredBy and provenance.measuredAt proving the baseline was measured by the real oracle',
      'provenance',
    );
  }
  const gate = makeArmedGate({ baseline, tolerance: common.tolerance, floor });
  if (!gate.ok) {
    return fail(
      'ARMED_GATE_INVALID',
      `armed gate is invalid: ${gate.error.message}`,
      gate.error.field,
    );
  }
  return {
    ok: true,
    value: {
      gate: gate.value,
      k: common.k,
      tolerance: common.tolerance,
      notes: common.notes,
      provenance: common.provenance,
    },
  };
}

/**
 * Parse and validate a raw (JSON-decoded) baseline configuration.
 *
 * Returns the resolved `EvalGate` plus reporting metadata, or a typed error. An
 * unarmed config resolves to `UNARMED_GATE` and ignores any baseline/floor values;
 * an armed config is validated in full, including the honesty provenance
 * requirement, so the gate can never be armed on a fabricated number.
 */
export function parseBaselineConfig(
  raw: unknown,
): Result<ParsedBaselineConfig, BaselineConfigError> {
  const record = asRecord(raw);
  if (record === null) {
    return fail('NOT_AN_OBJECT', 'baseline config must be a JSON object');
  }
  const common = parseCommon(record);
  if (!common.ok) {
    return common;
  }
  if (!common.value.armed) {
    return {
      ok: true,
      value: {
        gate: UNARMED_GATE,
        k: common.value.k,
        tolerance: common.value.tolerance,
        notes: common.value.notes,
        provenance: common.value.provenance,
      },
    };
  }
  return parseArmed(record, common.value);
}
