// Parsing the optional `scoreboardCampaign` block of a sweep config (C7).
//
// The block carries the hand-written Design_Groups, the Streaming_Supplement, and the
// pre-registered Success_Criterion. Each value is checked against a closed vocabulary or the
// config's own problem ids here; the runner then confirms the lists mechanically at start.

import { DESIGN_GROUPS, type DesignGroup } from '@app/agent';

import {
  SCOREBOARD_CAMPAIGN_MAX_RESUMES,
  type ScoreboardCampaignConfig,
  type SweepProblemSelection,
  PRE_REGISTERED_GROUNDING_POWER,
  type GroundingCampaignConfig,
} from './config.js';
import {
  asArray,
  asRecord,
  asTrimmedString,
  configFailure,
  configValue,
  unknownKeyError,
  type SweepConfigResult,
} from './config-values.js';
import { PRE_REGISTERED_SUCCESS_CRITERION, type SuccessCriterion } from './success-criterion.js';
import { PRE_REGISTERED_GROUNDING_CRITERION } from './grounding-criterion.js';

const FIELD = 'scoreboardCampaign';
const CAMPAIGN_FIELDS = [
  'designGroups',
  'streamingSupplement',
  'successCriterion',
  'baseline',
  'maxResumes',
];
const BASELINE_FIELDS = ['resultsPath', 'configHash'];
const CRITERION_FIELDS = Object.keys(PRE_REGISTERED_SUCCESS_CRITERION);
/** A config hash is the 16-hex-digit prefix `sweepConfigHash` produces. */
const CONFIG_HASH_PATTERN = /^[0-9a-f]{16}$/;
const MAX_PATH_LENGTH = 240;

/** Refuse an unrecognized key inside the block, naming its full path. */
function unknownKey<T>(
  record: Record<string, unknown>,
  allowed: readonly string[],
  parent: string,
): SweepConfigResult<T> | null {
  const error = unknownKeyError(record, allowed, parent);
  return error === null ? null : { ok: false, error };
}

/** Every recorded Design_Group must name a Campaign problem and a member of `DESIGN_GROUPS`. */
function parseDesignGroups(
  raw: unknown,
  ids: ReadonlySet<string>,
): SweepConfigResult<Readonly<Record<string, DesignGroup>>> {
  const field = `${FIELD}.designGroups`;
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('CAMPAIGN_INVALID', field, `${field} must map problem id -> group`);
  }
  const groups: Record<string, DesignGroup> = {};
  for (const [id, value] of Object.entries(record)) {
    if (!ids.has(id)) {
      return configFailure('CAMPAIGN_INVALID', `${field}.${id}`, `${id} is not in problems.ids`);
    }
    if (!DESIGN_GROUPS.includes(value as DesignGroup)) {
      return configFailure(
        'CAMPAIGN_INVALID',
        `${field}.${id}`,
        `each group must be one of ${DESIGN_GROUPS.join(', ')}`,
      );
    }
    groups[id] = value as DesignGroup;
  }
  const missing = [...ids].find((id) => groups[id] === undefined);
  if (missing !== undefined) {
    return configFailure('CAMPAIGN_INVALID', field, `${field} must record a group for ${missing}`);
  }
  return configValue(groups);
}

/** The supplement is a duplicate-free subset of `problems.ids`. */
function parseSupplement(
  raw: unknown,
  ids: ReadonlySet<string>,
): SweepConfigResult<readonly string[]> {
  const field = `${FIELD}.streamingSupplement`;
  const entries = asArray(raw);
  if (entries === null) {
    return configFailure('CAMPAIGN_INVALID', field, `${field} must be an array of problem ids`);
  }
  const supplement: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const id = asTrimmedString(entry);
    if (id === null || !ids.has(id) || supplement.includes(id)) {
      return configFailure(
        'CAMPAIGN_INVALID',
        `${field}[${index}]`,
        'each supplement entry must be a distinct id from problems.ids',
      );
    }
    supplement.push(id);
  }
  return configValue(supplement);
}

/** The criterion is pre-registered: every field must equal the one this build accepts. */
function parseCriterion(raw: unknown): SweepConfigResult<SuccessCriterion> {
  const field = `${FIELD}.successCriterion`;
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('CAMPAIGN_INVALID', field, `${field} must be an object`);
  }
  const unknown = unknownKey<SuccessCriterion>(record, CRITERION_FIELDS, field);
  if (unknown !== null) {
    return unknown;
  }
  for (const [key, expected] of Object.entries(PRE_REGISTERED_SUCCESS_CRITERION)) {
    if (record[key] !== expected) {
      return configFailure(
        'CAMPAIGN_INVALID',
        `${field}.${key}`,
        `${field}.${key} must be ${String(expected)}, the pre-registered value`,
      );
    }
  }
  return configValue(PRE_REGISTERED_SUCCESS_CRITERION);
}

function parseBaseline(raw: unknown): SweepConfigResult<ScoreboardCampaignConfig['baseline']> {
  const field = `${FIELD}.baseline`;
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('CAMPAIGN_INVALID', field, `${field} must be an object`);
  }
  const unknown = unknownKey<ScoreboardCampaignConfig['baseline']>(record, BASELINE_FIELDS, field);
  if (unknown !== null) {
    return unknown;
  }
  const resultsPath = asTrimmedString(record.resultsPath);
  if (resultsPath === null || resultsPath.length > MAX_PATH_LENGTH || resultsPath.includes('\0')) {
    return configFailure('CAMPAIGN_INVALID', `${field}.resultsPath`, 'resultsPath must be a path');
  }
  const configHash = asTrimmedString(record.configHash);
  if (configHash === null || !CONFIG_HASH_PATTERN.test(configHash)) {
    return configFailure(
      'CAMPAIGN_INVALID',
      `${field}.configHash`,
      'configHash must be 16 lowercase hex digits',
    );
  }
  return configValue({ resultsPath, configHash });
}

/**
 * Parse the optional Campaign block; `undefined` when the config does not declare one.
 * The block needs an explicit id selection, because its lists are keyed by problem id.
 */
export function parseScoreboardCampaign(
  raw: unknown,
  problems: SweepProblemSelection,
): SweepConfigResult<ScoreboardCampaignConfig | undefined> {
  if (raw === undefined) {
    return configValue(undefined);
  }
  const record = asRecord(raw);
  if (record === null || problems.kind !== 'ids') {
    return configFailure(
      'CAMPAIGN_INVALID',
      FIELD,
      `${FIELD} must be an object, and needs problems.kind "ids"`,
    );
  }
  const unknown = unknownKey<ScoreboardCampaignConfig>(record, CAMPAIGN_FIELDS, FIELD);
  if (unknown !== null) {
    return unknown;
  }
  const ids = new Set(problems.ids);
  const designGroups = parseDesignGroups(record.designGroups, ids);
  if (!designGroups.ok) {
    return designGroups;
  }
  const streamingSupplement = parseSupplement(record.streamingSupplement, ids);
  if (!streamingSupplement.ok) {
    return streamingSupplement;
  }
  const successCriterion = parseCriterion(record.successCriterion);
  if (!successCriterion.ok) {
    return successCriterion;
  }
  const baseline = parseBaseline(record.baseline);
  if (!baseline.ok) {
    return baseline;
  }
  if (record.maxResumes !== SCOREBOARD_CAMPAIGN_MAX_RESUMES) {
    return configFailure(
      'CAMPAIGN_INVALID',
      `${FIELD}.maxResumes`,
      `${FIELD}.maxResumes must be ${SCOREBOARD_CAMPAIGN_MAX_RESUMES}`,
    );
  }
  return configValue({
    designGroups: designGroups.value,
    streamingSupplement: streamingSupplement.value,
    successCriterion: successCriterion.value,
    baseline: baseline.value,
    maxResumes: SCOREBOARD_CAMPAIGN_MAX_RESUMES,
  });
}

// --- The Grounding Campaign block (testbench-spec-grounding, C15) ------------------------

const GROUNDING_FIELD = 'groundingCampaign';

const GROUNDING_FIELDS: readonly (keyof GroundingCampaignConfig)[] = [
  'successCriterion',
  'powerArithmetic',
  'referenceCampaign',
  'replayGateReportPath',
  'maxResumes',
];

const REFERENCE_FIELDS: readonly string[] = ['resultsPath', 'configHash', 'schemaVersion'];

/** The Reference_Campaign's recorded schema version; its records are v15 and stay v15. */
const REFERENCE_SCHEMA_VERSION = 15;

/** The only resume limit the Grounding Campaign may declare (Req 10.14, 10.15). */
export const GROUNDING_CAMPAIGN_MAX_RESUMES = 2;

/** Compare an untrusted block to a pre-registered constant, field by field. */
function parsePreRegistered<T extends object>(
  raw: unknown,
  expected: T,
  field: string,
): SweepConfigResult<T> {
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('CAMPAIGN_INVALID', field, `${field} must be an object`);
  }
  const keys = Object.keys(expected);
  const unknownName = Object.keys(record).find((key) => !keys.includes(key));
  if (unknownName !== undefined) {
    return configFailure(
      'CAMPAIGN_INVALID',
      `${field}.${unknownName}`,
      `${field} carries the unknown field ${unknownName}`,
    );
  }
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      return configFailure(
        'CAMPAIGN_INVALID',
        `${field}.${key}`,
        `${field}.${key} must be ${String(value)}, the pre-registered value`,
      );
    }
  }
  return configValue(expected);
}

/** The Reference_Campaign pointer: a path, a recorded hash, and the schema those records are. */
function parseReferenceCampaign(
  raw: unknown,
): SweepConfigResult<GroundingCampaignConfig['referenceCampaign']> {
  const field = `${GROUNDING_FIELD}.referenceCampaign`;
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('CAMPAIGN_INVALID', field, `${field} must be an object`);
  }
  const unknownName = Object.keys(record).find((key) => !REFERENCE_FIELDS.includes(key));
  if (unknownName !== undefined) {
    return configFailure(
      'CAMPAIGN_INVALID',
      `${field}.${unknownName}`,
      `${field} carries the unknown field ${unknownName}`,
    );
  }
  const resultsPath = asTrimmedString(record.resultsPath);
  const configHash = asTrimmedString(record.configHash);
  if (resultsPath === null || configHash === null) {
    return configFailure(
      'CAMPAIGN_INVALID',
      field,
      `${field}.resultsPath and ${field}.configHash must be non-empty strings`,
    );
  }
  if (record.schemaVersion !== REFERENCE_SCHEMA_VERSION) {
    return configFailure(
      'CAMPAIGN_INVALID',
      `${field}.schemaVersion`,
      `${field}.schemaVersion must be ${String(REFERENCE_SCHEMA_VERSION)}, the schema those records carry`,
    );
  }
  return configValue({ resultsPath, configHash, schemaVersion: REFERENCE_SCHEMA_VERSION });
}

/**
 * Parse the Grounding Campaign block, refusing anything the pre-registration does not allow.
 *
 * `sampleCount` and the design count are checked HERE rather than at the call site, because
 * a Campaign whose slot count disagrees with its own power arithmetic is not the experiment
 * that was registered (Req 10.3, 10.4, 12.1 to 12.3).
 */
export function parseGroundingCampaign(
  raw: unknown,
  problems: SweepProblemSelection,
  sampleCount: number,
): SweepConfigResult<GroundingCampaignConfig | undefined> {
  if (raw === undefined) {
    return configValue(undefined);
  }
  const record = asRecord(raw);
  if (record === null || problems.kind !== 'ids') {
    return configFailure(
      'CAMPAIGN_INVALID',
      GROUNDING_FIELD,
      `${GROUNDING_FIELD} must be an object, and needs problems.kind "ids"`,
    );
  }
  const unknown = unknownKey<GroundingCampaignConfig>(record, GROUNDING_FIELDS, GROUNDING_FIELD);
  if (unknown !== null) {
    return unknown;
  }
  const criterion = parsePreRegistered(
    record.successCriterion,
    PRE_REGISTERED_GROUNDING_CRITERION,
    `${GROUNDING_FIELD}.successCriterion`,
  );
  if (!criterion.ok) {
    return criterion;
  }
  const power = parsePreRegistered(
    record.powerArithmetic,
    PRE_REGISTERED_GROUNDING_POWER,
    `${GROUNDING_FIELD}.powerArithmetic`,
  );
  if (!power.ok) {
    return power;
  }
  const reference = parseReferenceCampaign(record.referenceCampaign);
  if (!reference.ok) {
    return reference;
  }
  const replayGateReportPath = asTrimmedString(record.replayGateReportPath);
  if (replayGateReportPath === null) {
    return configFailure(
      'CAMPAIGN_INVALID',
      `${GROUNDING_FIELD}.replayGateReportPath`,
      `${GROUNDING_FIELD}.replayGateReportPath must be a non-empty string`,
    );
  }
  if (record.maxResumes !== GROUNDING_CAMPAIGN_MAX_RESUMES) {
    return configFailure(
      'CAMPAIGN_INVALID',
      `${GROUNDING_FIELD}.maxResumes`,
      `${GROUNDING_FIELD}.maxResumes must be ${String(GROUNDING_CAMPAIGN_MAX_RESUMES)}`,
    );
  }
  if (sampleCount !== criterion.value.sampleCount) {
    return configFailure(
      'CAMPAIGN_INVALID',
      'reproducibility.sampleCount',
      `reproducibility.sampleCount must be ${String(criterion.value.sampleCount)}, the pre-registered Sample_Count`,
    );
  }
  if (problems.ids.length !== criterion.value.designCount) {
    return configFailure(
      'CAMPAIGN_INVALID',
      'problems.ids',
      `problems.ids must hold ${String(criterion.value.designCount)} Campaign_Designs`,
    );
  }
  return configValue({
    successCriterion: criterion.value,
    powerArithmetic: power.value,
    referenceCampaign: reference.value,
    replayGateReportPath,
    maxResumes: GROUNDING_CAMPAIGN_MAX_RESUMES,
  });
}
