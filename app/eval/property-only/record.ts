// The Property_Only_Measurement record and its codec.
//
// WHY ITS OWN TYPE IN ITS OWN DIRECTORY
//   No existing summary reads this record (Req 9.9, 9.10). A shared file would make every
//   future summary a place the Admitted_Population and the Refused_Population can be
//   re-merged by accident, so the separation is structural rather than disciplinary.
//
// WHY `measurementKind` IS A LITERAL AND `population` A UNION ON EVERY DESIGN
//   Criteria 9.1 and 5.16 then hold by construction, not by a renderer remembering to say so.
//
// WHY `authoringModel` SITS ON THE DESIGN RESULT
//   Criterion 5.14 forbids a figure pooled across Authoring_Models. Keyed per design result,
//   there is no run-level field a pooled figure could live on.
//
// DECODING IS VALIDATION AT A TRUST BOUNDARY
//   A persisted file is external input even when we wrote it: it may have been hand-edited,
//   truncated by a full disk, or written by an older build. Every field is narrowed and any
//   departure returns `null` - the precedent `decodeSampleRecord` sets by refusing an absent
//   `propertySetAdmitted` rather than defaulting it.
//
// NO SECRETS AND NO PATHS
//   A record carries verdicts, counters, and sanitized classifications only, so it is safe to
//   attach to a report. `ManifestToolchain` versions are recorded path-free (Req 8.4).

import {
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type CouldNotVerifyCause,
  type CoverCondition,
  type FormalVerdict,
  type ProofConditions,
} from '@app/tools';

import { LIMIT_REASONS, type LimitReason, type MeasurementLimit } from '../measurement-limit.js';
import type { ManifestToolchain, ProbedVersion } from '../sweep/manifest.js';

// -- The record shape -------------------------------------------------------

/** The two populations every scored design falls into, and nothing else (Req 5.16). */
export type DesignPopulation = 'admitted' | 'refused';

/**
 * One property's verdict as the record carries it, paired with its cause.
 *
 * A union rather than a verdict beside a nullable cause, so three rules hold by construction:
 * a Could_Not_Verify_Cause exists exactly when the verdict is `could-not-verify` (Req 5.18), a
 * Solver_Cross_Check disagreement can only sit on a `could-not-verify` (Req 11.7), and no
 * field names either solver's own verdict, so neither can be preferred over the other.
 */
export type PropertyOnlyVerdict =
  | {
      readonly verdict: Exclude<FormalVerdict, 'could-not-verify'>;
      readonly couldNotVerifyCause: null;
      readonly crossCheckDisagreed: false;
    }
  | {
      readonly verdict: 'could-not-verify';
      readonly couldNotVerifyCause: CouldNotVerifyCause;
      readonly crossCheckDisagreed: boolean;
    };

/**
 * What one submitted Formal_Property produced: a verdict with its evidence, or the reason
 * no Deterministic_Oracle invocation produced one.
 *
 * The `not-measured` arm is Req 11.2: a verdict not traceable to an oracle invocation is
 * carried as Not_Measured rather than as a verdict. A union keeps "measured with no verdict"
 * and "not measured with a verdict" unrepresentable, the discipline `AnchorOutcome` and
 * `ProbedVersion` both follow.
 */
export type PropertyOnlyOutcome =
  | ({
      readonly kind: 'measured';
      /** The five conditions behind the verdict, whatever the verdict (Req 11.3). */
      readonly conditions: ProofConditions;
    } & PropertyOnlyVerdict)
  | {
      readonly kind: 'not-measured';
      readonly reason: string;
    };

/** One submitted Formal_Property and what the oracle made of it. */
export interface PropertyOnlyPropertyResult {
  readonly propertyId: string;
  readonly outcome: PropertyOnlyOutcome;
}

/** One design authored by one Authoring_Model, in exactly one population. */
export interface PropertyOnlyDesignResult {
  readonly designId: string;
  /** The model this design's Property_Set was routed to; one entry per model (Req 5.12). */
  readonly authoringModel: string;
  readonly population: DesignPopulation;
  /** The cause the Reset_Contract_Prepass refused with, before any solver ran (Req 5.17). */
  readonly prepassRefusalCause: CouldNotVerifyCause | null;
  readonly properties: readonly PropertyOnlyPropertyResult[];
  /** The acceptance criteria the Property_Author reported as unexpressed (Req 5.19). */
  readonly unexpressedCriteria: readonly string[];
  /** Measured token counts and wall clock, as provenance only (Req 5.7, 12.7). */
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** The Design_Total: authoring and proof together. It stops no run (Req 5.24). */
  readonly elapsedMs: number;
  /**
   * The Proof_Span: the proof alone, which is the span the Property_Time_Budget bounds (Req 5.23).
   *
   * `null` where no proof was attempted, and on a record written before this field existed. Never
   * 0 for an absent span, because a 0 would read as an instant proof.
   */
  readonly proofSpanMs: number | null;
  /** The toolchain that decided the verdicts below (Req 8.5). */
  readonly toolchain: ManifestToolchain;
  /**
   * The Formal_Oracle_Version these verdicts were decided under (Req 8.9).
   *
   * Never pinned to the current version on read: task 4.16 moves that version within this
   * spec, and refusing an older one would delete the records the move is measured across.
   */
  readonly formalOracleVersion: number;
}

/** The whole property-only measurement, as the persisted file holds it. */
export interface PropertyOnlyMeasurement {
  readonly schemaVersion: number;
  readonly runName: string;
  /** A literal, so no reader can mistake this for an End_To_End_Formal_Rate (Req 9.1). */
  readonly measurementKind: 'property-only';
  /** The Student_Path steps this measurement's own path omitted (Req 9.2). */
  readonly omittedStudentPathSteps: readonly string[];
  readonly results: readonly PropertyOnlyDesignResult[];
  /** Every limit the run executed under, each naming its Limit_Reason (Req 12.5). */
  readonly limits: readonly MeasurementLimit[];
}

/** This record's own shape version, bumped when a reader of an older file would misread it. */
export const PROPERTY_ONLY_SCHEMA_VERSION = 1;

/** The literal every record carries, read from one place by both the codec and its callers. */
export const PROPERTY_ONLY_MEASUREMENT_KIND = 'property-only';

// -- Encoding ---------------------------------------------------------------

/** Serialize one measurement as the text its file holds. */
export function encodePropertyOnlyMeasurement(measurement: PropertyOnlyMeasurement): string {
  return JSON.stringify(measurement);
}

// -- Narrowing helpers ------------------------------------------------------

/** Narrow an unknown to a plain object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A non-negative finite number, or null. */
function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A non-negative integer, or null. */
function nonNegativeInt(value: unknown): number | null {
  const numeric = nonNegative(value);
  return numeric !== null && Number.isInteger(numeric) ? numeric : null;
}

/** A member of a closed string set, or null (absent and invalid are the same departure). */
function member<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : null;
}

/**
 * A list of non-empty strings with its order kept, or null if any entry is not one.
 *
 * Routed through `list` rather than validated with `map` + `includes`: `map` SKIPS array holes,
 * so a sparse array decoded as `[hole]` while the declared `readonly string[]` said otherwise.
 */
function strList(value: unknown): readonly string[] | null {
  return list(value, str);
}

/** Decode each entry of a list through one decoder, or null if any entry departs. */
function list<T>(value: unknown, decode: (entry: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const decoded: T[] = [];
  for (const entry of value) {
    const one = decode(entry);
    if (one === null) {
      return null;
    }
    decoded.push(one);
  }
  return decoded;
}

// -- The vocabularies read on the way in ------------------------------------

const VERDICTS: readonly FormalVerdict[] = FORMAL_VERDICTS;
const CAUSES: readonly CouldNotVerifyCause[] = COULD_NOT_VERIFY_CAUSES;
const REASONS: readonly LimitReason[] = LIMIT_REASONS;
const UNITS: readonly MeasurementLimit['unit'][] = ['ms', 'tokens', 'designs', 'steps', 'multiple'];
const POPULATIONS: readonly DesignPopulation[] = ['admitted', 'refused'];

// ponytail: these three restate inline unions `ProofConditions` declares with no exported
// array owner, exactly as `../sweep/results-log.ts` already does. Upgrade path is to export
// the vocabularies from `@app/tools` beside `FORMAL_VERDICTS` and read them from there.
const PRESATS: readonly ProofConditions['presat'][] = ['satisfiable', 'preunsat', 'not-run'];
const BASES: readonly ProofConditions['base'][] = ['passed', 'failed', 'not-run'];
const INDUCTIONS: readonly ProofConditions['induction'][] = [
  'successful',
  'inconclusive',
  'not-run',
];

// -- Field decoders ---------------------------------------------------------

/** One declared limit as the file holds it, values and all. */
function decodeLimit(raw: unknown): MeasurementLimit | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const name = str(record.name);
  const value = nonNegative(record.value);
  const unit = member(record.unit, UNITS);
  const reason = member(record.reason, REASONS);
  if (name === null || value === null || unit === null || reason === null) {
    return null;
  }
  return { name, value, unit, reason };
}

/**
 * One probed tool version, keeping a read value and an unread one distinct.
 *
 * `not-measured` carries the reason it could not be read (Req 8.3), so an unanswered probe
 * cannot be told apart from a default only by coincidence.
 */
function decodeProbedVersion(raw: unknown): ProbedVersion | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  if (record.kind === 'read') {
    const value = str(record.value);
    return value === null ? null : { kind: 'read', value };
  }
  if (record.kind !== 'not-measured') {
    return null;
  }
  const reason = str(record.reason);
  return reason === null ? null : { kind: 'not-measured', reason };
}

/** A tool version that is a string or an explicit null, or `INVALID` for anything else. */
const INVALID = Symbol('invalid');

/** The three legacy `string | null` members, where absent and null are the same unknown. */
function decodeLegacyVersion(value: unknown): string | null | typeof INVALID {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : INVALID;
}

/** The Toolchain_Provenance of the run that produced the record (Req 8.5). */
function decodeToolchain(raw: unknown): ManifestToolchain | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const iverilogVersion = decodeLegacyVersion(record.iverilogVersion);
  const vvpVersion = decodeLegacyVersion(record.vvpVersion);
  const workerPython = decodeLegacyVersion(record.workerPython);
  const probed = decodeProbedVersions(record);
  if (
    iverilogVersion === INVALID ||
    vvpVersion === INVALID ||
    workerPython === INVALID ||
    probed === null
  ) {
    return null;
  }
  return { iverilogVersion, vvpVersion, workerPython, ...probed };
}

/** The five `ProbedVersion` members of the toolchain, all required. */
function decodeProbedVersions(
  record: Record<string, unknown>,
): Pick<
  ManifestToolchain,
  'yosysVersion' | 'yosysBuildId' | 'yosysSmtBmcVersion' | 'bitwuzlaVersion' | 'z3Version'
> | null {
  const yosysVersion = decodeProbedVersion(record.yosysVersion);
  const yosysBuildId = decodeProbedVersion(record.yosysBuildId);
  const yosysSmtBmcVersion = decodeProbedVersion(record.yosysSmtBmcVersion);
  const bitwuzlaVersion = decodeProbedVersion(record.bitwuzlaVersion);
  const z3Version = decodeProbedVersion(record.z3Version);
  if (
    yosysVersion === null ||
    yosysBuildId === null ||
    yosysSmtBmcVersion === null ||
    bitwuzlaVersion === null ||
    z3Version === null
  ) {
    return null;
  }
  return { yosysVersion, yosysBuildId, yosysSmtBmcVersion, bitwuzlaVersion, z3Version };
}

/**
 * The Cover_Check condition, keeping its three states distinct.
 *
 * A `reached: true` with no readable step is refused rather than read as `reached: false`,
 * which would turn a satisfied condition into a failed one.
 */
function decodeCover(raw: unknown): CoverCondition | null {
  const cover = asRecord(raw);
  if (cover === null) {
    return null;
  }
  if (cover.reached === true) {
    const step = nonNegativeInt(cover.step);
    return step === null ? null : { reached: true, step };
  }
  if (cover.reached === false) {
    return { reached: false };
  }
  return cover.reached === 'not-applicable' ? { reached: 'not-applicable' } : null;
}

/**
 * The five Proof_Conditions, or null when any one of them is unreadable.
 *
 * Strict and whole: four conditions beside a defaulted fifth is a record claiming a condition
 * was measured when it was not, and `admitProved` weighs all five.
 */
function decodeConditions(raw: unknown): ProofConditions | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const assertionCount = nonNegativeInt(record.assertionCount);
  const presat = member(record.presat, PRESATS);
  const cover = decodeCover(record.cover);
  const base = member(record.base, BASES);
  const induction = member(record.induction, INDUCTIONS);
  if (
    assertionCount === null ||
    presat === null ||
    cover === null ||
    base === null ||
    induction === null
  ) {
    return null;
  }
  return { assertionCount, presat, cover, base, induction };
}

/**
 * The verdict and its cause as one decision, refusing either half without the other.
 *
 * A `proved` record carrying a cause is exactly as untrustworthy as a `could-not-verify`
 * record missing one, and a cross-check disagreement on anything but a `could-not-verify`
 * would be a record that preferred a solver (Req 11.7).
 */
function decodeVerdict(record: Record<string, unknown>): PropertyOnlyVerdict | null {
  const verdict = member(record.verdict, VERDICTS);
  if (verdict === null) {
    return null;
  }
  if (verdict !== 'could-not-verify') {
    const absent = record.couldNotVerifyCause === null && record.crossCheckDisagreed === false;
    return absent ? { verdict, couldNotVerifyCause: null, crossCheckDisagreed: false } : null;
  }
  const couldNotVerifyCause = member(record.couldNotVerifyCause, CAUSES);
  if (couldNotVerifyCause === null || typeof record.crossCheckDisagreed !== 'boolean') {
    return null;
  }
  return { verdict, couldNotVerifyCause, crossCheckDisagreed: record.crossCheckDisagreed };
}

/** One property's outcome: the measured arm with its evidence, or Not_Measured with a reason. */
function decodeOutcome(raw: unknown): PropertyOnlyOutcome | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  if (record.kind === 'not-measured') {
    const reason = str(record.reason);
    return reason === null ? null : { kind: 'not-measured', reason };
  }
  if (record.kind !== 'measured') {
    return null;
  }
  const conditions = decodeConditions(record.conditions);
  const verdict = decodeVerdict(record);
  return conditions === null || verdict === null
    ? null
    : { kind: 'measured', conditions, ...verdict };
}

/** One submitted property and its outcome. */
function decodeProperty(raw: unknown): PropertyOnlyPropertyResult | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const propertyId = str(record.propertyId);
  const outcome = decodeOutcome(record.outcome);
  return propertyId === null || outcome === null ? null : { propertyId, outcome };
}

/**
 * One design result, refusing an unknown `population` and an absent `authoringModel`.
 *
 * Neither has an honest default: a missing population would put a design in no population at
 * all, and a missing model would leave every figure on the result attributable to none, which
 * is the pooling criterion 5.14 refuses.
 */
function decodeDesignResult(raw: unknown): PropertyOnlyDesignResult | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const designId = str(record.designId);
  const authoringModel = str(record.authoringModel);
  const population = member(record.population, POPULATIONS);
  const prepassRefusalCause = decodeLegacyCause(record.prepassRefusalCause);
  const properties = list(record.properties, decodeProperty);
  const unexpressedCriteria = strList(record.unexpressedCriteria);
  const cost = decodeCost(record);
  if (
    designId === null ||
    authoringModel === null ||
    population === null ||
    prepassRefusalCause === INVALID ||
    properties === null ||
    unexpressedCriteria === null ||
    cost === null
  ) {
    return null;
  }
  return {
    designId,
    authoringModel,
    population,
    prepassRefusalCause,
    properties,
    unexpressedCriteria,
    ...cost,
  };
}

/** The pre-pass cause, where absent and explicit null both mean the pre-pass did not refuse. */
function decodeLegacyCause(value: unknown): CouldNotVerifyCause | null | typeof INVALID {
  if (value === null || value === undefined) {
    return null;
  }
  return member(value, CAUSES) ?? INVALID;
}

/** The provenance figures and the version, all required: a defaulted 0 would read as measured. */
function decodeCost(
  record: Record<string, unknown>,
): Pick<
  PropertyOnlyDesignResult,
  | 'promptTokens'
  | 'completionTokens'
  | 'elapsedMs'
  | 'proofSpanMs'
  | 'toolchain'
  | 'formalOracleVersion'
> | null {
  const promptTokens = nonNegativeInt(record.promptTokens);
  const completionTokens = nonNegativeInt(record.completionTokens);
  const elapsedMs = nonNegative(record.elapsedMs);
  // An absent Proof_Span is a missing key and decodes to null; a present but unreadable one is
  // still a decode failure, so a bad figure cannot pass itself off as an absent one.
  const proofSpanGiven = record.proofSpanMs !== undefined && record.proofSpanMs !== null;
  const proofSpanMs = proofSpanGiven ? nonNegative(record.proofSpanMs) : null;
  const toolchain = decodeToolchain(record.toolchain);
  const formalOracleVersion = nonNegativeInt(record.formalOracleVersion);
  if (
    promptTokens === null ||
    completionTokens === null ||
    elapsedMs === null ||
    (proofSpanGiven && proofSpanMs === null) ||
    toolchain === null ||
    formalOracleVersion === null
  ) {
    return null;
  }
  return {
    promptTokens,
    completionTokens,
    elapsedMs,
    proofSpanMs,
    toolchain,
    formalOracleVersion,
  };
}

// -- Decoding ---------------------------------------------------------------

/** Parse the file's text, or hand back an already-parsed value for narrowing. */
function parsed(text: unknown): unknown {
  if (typeof text !== 'string') {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The measurement a persisted file holds, or `null` on any departure from the shape.
 *
 * Accepts the file's text or an already-parsed value, so a caller holding either need not
 * re-stringify. Every departure is the same answer: `null`, never a partially trusted record.
 */
export function decodePropertyOnlyMeasurement(text: unknown): PropertyOnlyMeasurement | null {
  const record = asRecord(parsed(text));
  if (record === null || record.schemaVersion !== PROPERTY_ONLY_SCHEMA_VERSION) {
    return null;
  }
  const runName = str(record.runName);
  const omittedStudentPathSteps = strList(record.omittedStudentPathSteps);
  const results = list(record.results, decodeDesignResult);
  const limits = list(record.limits, decodeLimit);
  if (
    runName === null ||
    record.measurementKind !== PROPERTY_ONLY_MEASUREMENT_KIND ||
    omittedStudentPathSteps === null ||
    results === null ||
    limits === null
  ) {
    return null;
  }
  return {
    schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
    runName,
    measurementKind: PROPERTY_ONLY_MEASUREMENT_KIND,
    omittedStudentPathSteps,
    results,
    limits,
  };
}
