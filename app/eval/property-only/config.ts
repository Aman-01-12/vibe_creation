// The Property_Only_Mode's OWN configuration, and the boundary that validates it.
//
// WHY ITS OWN TYPE AND NOT `../sweep/config.ts`
//   Sharing the sweep's config OBJECT would make this mode a flag on the product path, and a
//   flag that skips Instrument_Admission on that path is exactly what criterion 10.4 refuses to
//   start under. The sweep's total narrowing HELPERS in `../sweep/config-values.ts` are shared,
//   because they are value readers rather than the config, and they already carry the one rule a
//   second copy would get wrong: a message names the offending FIELD and never echoes its VALUE,
//   since a config is a file an operator may have pasted a credential into (design.md, C7).
//
// WHAT THIS TYPE DELIBERATELY CANNOT SAY
//   No field here can move a Formal_Verdict, a trust label, or a Fallback_Route on the
//   Student_Path, and none turns a gate off (Req 10.6). A key whose NAME is shaped like one of
//   those is refused BY NAME (Req 10.4) rather than ignored, because an ignored key reads to an
//   operator as an accepted one.
//
// Pure: no clock, no I/O, no randomness.

import type { ResourceLimits } from '@app/tools';

import type { StudentSessionCaps } from '../loop-runner.js';
import { limitOrRefuse } from '../measurement-limit.js';
import {
  asArray,
  asRecord,
  asTrimmedString,
  configFailure,
  configValue,
  requireFiniteInRange,
  requireIntegerInRange,
  requireRecord,
  requireString,
  unknownKeyError,
  type SweepConfigResult,
} from '../sweep/config-values.js';

/** The result shape every parser here returns; one error type, shared with the sweep's reader. */
export type PropertyOnlyConfigResult<T> = SweepConfigResult<T>;

/**
 * The two Authoring_Models criterion 5.11 names, provider-qualified.
 *
 * Provider-qualified because that is the form the Model_Router accepts and the form
 * `.eval-runs/formal-gate-v1-pilot/manifest.json` already records, so both models have a prior
 * figure on this corpus for the first property-only numbers to be comparable against.
 */
export const REQUIRED_AUTHORING_MODELS: readonly string[] = Object.freeze([
  'zai.glm-5',
  'moonshotai.kimi-k2.5',
]);

/**
 * The default routing: exactly the two required models, in order.
 *
 * A LIST rather than a pair, so a third model from another family is a config change and not a
 * spec change (Req 5.11, FL-17).
 */
export const DEFAULT_AUTHORING_MODELS: readonly string[] = REQUIRED_AUTHORING_MODELS;

/** The limit whose value bounds `costPilotDesignIds`; read from the registry, never restated. */
const COST_PILOT_LIMIT_NAME = 'cost-pilot-design-count';

/** The keys this config may hold. Anything else is refused by name rather than ignored. */
export const PROPERTY_ONLY_CONFIG_KEYS: readonly string[] = Object.freeze([
  'runName',
  'outputDir',
  'region',
  'authoringModels',
  'costPilotDesignIds',
  'limits',
  'caps',
  'extrapolationFrom',
]);

/** The sandbox-limit keys. */
const LIMIT_KEYS: readonly string[] = Object.freeze(['cpu', 'memMb', 'procs', 'diskMb', 'wallMs']);

/** The student-cap keys. */
const CAP_KEYS: readonly string[] = Object.freeze([
  'maxIterations',
  'maxTokens',
  'maxWallClockMs',
  'maxCostCents',
]);

/**
 * Key names that would describe bypassing a Student_Path step or moving one of its outcomes.
 *
 * A PATTERN over names rather than a list of keys, because the refusal has to hold for the NEXT
 * such name as well as the ones someone thought of today (Req 10.4, 10.6). No key this config
 * reads matches it, and the test beside this module asserts that.
 */
const BYPASS_SHAPED_KEY = /instrument|admission|bypass|skip|disable|verdict|trust|fallback/i;

/** How deep the bypass-shaped-key walk descends; a hostile file must not recurse unbounded. */
const MAX_CONFIG_DEPTH = 8;

/** Accepted shape of an AWS region label; it is interpolated into the endpoint URL. */
const REGION_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Accepted shape of a run name, which is also the directory segment this run writes into. */
const RUN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Inclusive bounds on the sandbox limits, so a typo cannot ask for a machine nobody has. */
const LIMIT_BOUNDS = Object.freeze({
  cpu: { low: 0.1, high: 64 },
  memMb: { low: 64, high: 131_072 },
  procs: { low: 1, high: 4_096 },
  diskMb: { low: 16, high: 131_072 },
  wallMs: { low: 1_000, high: 3_600_000 },
});

/** Inclusive bounds on the student caps, matching the sweep's own ceilings. */
const CAP_BOUNDS = Object.freeze({
  maxIterations: { low: 1, high: 1_000 },
  maxTokens: { low: 1, high: 100_000_000 },
  maxWallClockMs: { low: 1, high: 86_400_000 },
  maxCostCents: { low: 1, high: 10_000_000 },
});

/**
 * The Property_Only_Mode's configuration, as the validated value.
 *
 * `region` and `extrapolationFrom` are the two fields beyond design.md's block, and neither can
 * reach the Student_Path: the region names the endpoint the Property_Author is called through,
 * and `extrapolationFrom` names an EARLIER property-only measurement this run reads its
 * Per_Design_Extrapolation from. `null` there is the honest "no extrapolation is recorded", which
 * is what confines the run to the Cost_Pilot (Req 5.6).
 */
export interface PropertyOnlyConfig {
  readonly runName: string;
  /** This measurement's own directory; its last segment is the measurement name (Req 9.10). */
  readonly outputDir: string;
  readonly region: string;
  /** At least two, including both of `REQUIRED_AUTHORING_MODELS` (Req 5.11). */
  readonly authoringModels: readonly string[];
  /** At most the declared `cost-pilot-design-count` (Req 5.5). */
  readonly costPilotDesignIds: readonly string[];
  /**
   * The sandbox resource caps every proof runs under.
   *
   * `wallMs` is part of the type and bounds nothing in this mode: each proof's wall clock comes
   * from the declared shipped Property_Time_Budget, which is the ceiling the Student_Path runs
   * under and therefore the only one a population-honesty figure may be taken under.
   */
  readonly limits: ResourceLimits;
  readonly caps: StudentSessionCaps;
  /** Directory of the earlier measurement the extrapolation is read from, or `null`. */
  readonly extrapolationFrom: string | null;
}

// -- The refusals that are not about shape ----------------------------------

/**
 * The first bypass-shaped key anywhere in the raw config, or `null`.
 *
 * Walks the whole document rather than its top level, so a bypass-shaped key nested inside an
 * otherwise legal block is still named. The depth cap bounds a hostile file; a document deeper
 * than that holds no key this config reads anyway.
 */
export function bypassShapedKeyIn(raw: unknown, depth = 0): string | null {
  if (depth >= MAX_CONFIG_DEPTH) {
    return null;
  }
  const entries = asArray(raw);
  if (entries !== null) {
    return firstBypassShapedKey(entries, depth);
  }
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  for (const [key, value] of Object.entries(record)) {
    if (BYPASS_SHAPED_KEY.test(key)) {
      return key;
    }
    const nested = bypassShapedKeyIn(value, depth + 1);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

/** The first bypass-shaped key among a list's entries, or `null`. */
function firstBypassShapedKey(entries: readonly unknown[], depth: number): string | null {
  for (const entry of entries) {
    const found = bypassShapedKeyIn(entry, depth + 1);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

// -- Field readers ----------------------------------------------------------

/**
 * A list of unique non-blank ids, or a typed failure naming the field.
 *
 * The duplicate message names the field and not the repeated value, by the same rule the rest of
 * this boundary follows.
 */
function requireIdList(
  parent: Record<string, unknown>,
  field: string,
): PropertyOnlyConfigResult<readonly string[]> {
  const entries = asArray(parent[field]);
  if (entries === null || entries.length === 0) {
    return configFailure('FIELD_NOT_AN_ARRAY', field, `${field} must be a non-empty array`);
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const id = asTrimmedString(entry);
    if (id === null) {
      return configFailure('FIELD_NOT_A_STRING', field, `every ${field} entry must be a string`);
    }
    if (ids.includes(id)) {
      return configFailure('FIELD_OUT_OF_RANGE', field, `${field} lists one id more than once`);
    }
    ids.push(id);
  }
  return configValue(ids);
}

/**
 * A relative path with no climbing segment, or a typed failure naming the field.
 *
 * Checked here rather than at the write, because this value becomes a directory this run creates
 * and an absolute or climbing path would write outside the repository.
 */
function requireRelativePath(
  parent: Record<string, unknown>,
  field: string,
): PropertyOnlyConfigResult<string> {
  const text = requireString(parent, field);
  if (!text.ok) {
    return text;
  }
  const segments = text.value.split('/');
  const climbs = segments.includes('..') || segments.includes('.');
  return text.value.startsWith('/') || climbs
    ? configFailure(
        'FIELD_OUT_OF_RANGE',
        field,
        `${field} must be a relative path with no "." or ".." segment`,
      )
    : text;
}

// -- Section parsers --------------------------------------------------------

/** The sandbox limits, every field required: a defaulted cap is a cap nobody declared. */
function parseLimits(record: Record<string, unknown>): PropertyOnlyConfigResult<ResourceLimits> {
  const block = requireRecord(record, 'limits');
  if (!block.ok) {
    return block;
  }
  const unknown = unknownKeyError(block.value, LIMIT_KEYS, 'limits');
  if (unknown !== null) {
    return { ok: false, error: unknown };
  }
  const cpu = requireFiniteInRange(block.value, 'cpu', LIMIT_BOUNDS.cpu);
  if (!cpu.ok) {
    return cpu;
  }
  const memMb = requireIntegerInRange(block.value, 'memMb', LIMIT_BOUNDS.memMb);
  if (!memMb.ok) {
    return memMb;
  }
  const procs = requireIntegerInRange(block.value, 'procs', LIMIT_BOUNDS.procs);
  if (!procs.ok) {
    return procs;
  }
  const diskMb = requireIntegerInRange(block.value, 'diskMb', LIMIT_BOUNDS.diskMb);
  if (!diskMb.ok) {
    return diskMb;
  }
  const wallMs = requireIntegerInRange(block.value, 'wallMs', LIMIT_BOUNDS.wallMs);
  if (!wallMs.ok) {
    return wallMs;
  }
  return configValue({
    cpu: cpu.value,
    memMb: memMb.value,
    procs: procs.value,
    diskMb: diskMb.value,
    wallMs: wallMs.value,
  });
}

/** The student-session caps, which bound one design's authoring spend. */
function parseCaps(record: Record<string, unknown>): PropertyOnlyConfigResult<StudentSessionCaps> {
  const block = requireRecord(record, 'caps');
  if (!block.ok) {
    return block;
  }
  const unknown = unknownKeyError(block.value, CAP_KEYS, 'caps');
  if (unknown !== null) {
    return { ok: false, error: unknown };
  }
  const iterations = requireIntegerInRange(block.value, 'maxIterations', CAP_BOUNDS.maxIterations);
  if (!iterations.ok) {
    return iterations;
  }
  const tokens = requireIntegerInRange(block.value, 'maxTokens', CAP_BOUNDS.maxTokens);
  if (!tokens.ok) {
    return tokens;
  }
  const wall = requireIntegerInRange(block.value, 'maxWallClockMs', CAP_BOUNDS.maxWallClockMs);
  if (!wall.ok) {
    return wall;
  }
  const cost = requireIntegerInRange(block.value, 'maxCostCents', CAP_BOUNDS.maxCostCents);
  if (!cost.ok) {
    return cost;
  }
  return configValue({
    maxIterations: iterations.value,
    maxTokens: tokens.value,
    maxWallClockMs: wall.value,
    maxCostCents: cost.value,
  });
}

/** The Authoring_Models, refusing a list that drops either model criterion 5.11 names. */
function parseAuthoringModels(
  record: Record<string, unknown>,
): PropertyOnlyConfigResult<readonly string[]> {
  if (record.authoringModels === undefined) {
    return configValue(DEFAULT_AUTHORING_MODELS);
  }
  const models = requireIdList(record, 'authoringModels');
  if (!models.ok) {
    return models;
  }
  if (models.value.length < 2) {
    return configFailure(
      'FIELD_OUT_OF_RANGE',
      'authoringModels',
      'authoringModels must name at least two Authoring_Models',
    );
  }
  const missing = REQUIRED_AUTHORING_MODELS.find((model) => !models.value.includes(model));
  return missing === undefined
    ? models
    : configFailure(
        'FIELD_OUT_OF_RANGE',
        'authoringModels',
        `authoringModels must include "${missing}"`,
      );
}

/** The Cost_Pilot's designs, bounded by the DECLARED limit and not by a number written here. */
function parseCostPilotDesignIds(
  record: Record<string, unknown>,
): PropertyOnlyConfigResult<readonly string[]> {
  const limit = limitOrRefuse(COST_PILOT_LIMIT_NAME);
  if (!limit.ok) {
    return configFailure('FIELD_OUT_OF_RANGE', 'costPilotDesignIds', limit.error.message);
  }
  const ids = requireIdList(record, 'costPilotDesignIds');
  if (!ids.ok) {
    return ids;
  }
  return ids.value.length > limit.value.value
    ? configFailure(
        'FIELD_OUT_OF_RANGE',
        'costPilotDesignIds',
        `costPilotDesignIds must name at most ${limit.value.value} designs (${COST_PILOT_LIMIT_NAME})`,
      )
    : ids;
}

/** The identity fields, with the output directory tied to the measurement's own name. */
function parseIdentity(
  record: Record<string, unknown>,
): PropertyOnlyConfigResult<Pick<PropertyOnlyConfig, 'runName' | 'outputDir' | 'region'>> {
  const runName = requireString(record, 'runName');
  if (!runName.ok) {
    return runName;
  }
  if (!RUN_NAME_PATTERN.test(runName.value)) {
    return configFailure(
      'FIELD_OUT_OF_RANGE',
      'runName',
      'runName must be lowercase alphanumeric with hyphens, 1 to 64 characters',
    );
  }
  const outputDir = requireRelativePath(record, 'outputDir');
  if (!outputDir.ok) {
    return outputDir;
  }
  if (outputDir.value.split('/').at(-1) !== runName.value) {
    return configFailure(
      'FIELD_OUT_OF_RANGE',
      'outputDir',
      'outputDir must end in a directory named for the measurement, so its last segment must equal runName (Req 9.10)',
    );
  }
  const region = requireString(record, 'region');
  if (!region.ok) {
    return region;
  }
  return REGION_PATTERN.test(region.value)
    ? configValue({ runName: runName.value, outputDir: outputDir.value, region: region.value })
    : configFailure(
        'FIELD_OUT_OF_RANGE',
        'region',
        'region must be a label such as us-east-1; it is part of the endpoint URL the credential is sent to',
      );
}

/** The four non-identity sections, parsed together so the caller stays one decision deep. */
function parseSections(
  record: Record<string, unknown>,
): PropertyOnlyConfigResult<
  Pick<PropertyOnlyConfig, 'authoringModels' | 'costPilotDesignIds' | 'limits' | 'caps'>
> {
  const authoringModels = parseAuthoringModels(record);
  if (!authoringModels.ok) {
    return authoringModels;
  }
  const costPilotDesignIds = parseCostPilotDesignIds(record);
  if (!costPilotDesignIds.ok) {
    return costPilotDesignIds;
  }
  const limits = parseLimits(record);
  if (!limits.ok) {
    return limits;
  }
  const caps = parseCaps(record);
  if (!caps.ok) {
    return caps;
  }
  return configValue({
    authoringModels: authoringModels.value,
    costPilotDesignIds: costPilotDesignIds.value,
    limits: limits.value,
    caps: caps.value,
  });
}

/** The optional pointer to the measurement this run reads its extrapolation from. */
function parseExtrapolationFrom(
  record: Record<string, unknown>,
): PropertyOnlyConfigResult<string | null> {
  const raw = record.extrapolationFrom;
  return raw === undefined || raw === null
    ? configValue(null)
    : requireRelativePath(record, 'extrapolationFrom');
}

// -- The boundary -----------------------------------------------------------

/**
 * Validate an already-parsed config document, or refuse naming the one field that failed.
 *
 * The order of the first two checks is deliberate: a bypass-shaped key is reported AS a bypass
 * (Req 10.4) rather than as a generic unknown key, because the operator-facing difference is
 * whether the refusal explains itself.
 */
export function parsePropertyOnlyConfig(
  raw: unknown,
): PropertyOnlyConfigResult<PropertyOnlyConfig> {
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('NOT_AN_OBJECT', '', 'the property-only config must be a JSON object');
  }
  const bypass = bypassShapedKeyIn(record);
  if (bypass !== null) {
    return configFailure(
      'UNKNOWN_FIELD',
      bypass,
      `"${bypass}" is shaped like a step or an outcome of the Student_Path, and this mode adds no configuration value that can move one (Req 10.4, 10.6)`,
    );
  }
  const unknown = unknownKeyError(record, PROPERTY_ONLY_CONFIG_KEYS, '');
  if (unknown !== null) {
    return { ok: false, error: unknown };
  }
  const identity = parseIdentity(record);
  if (!identity.ok) {
    return identity;
  }
  const sections = parseSections(record);
  if (!sections.ok) {
    return sections;
  }
  const extrapolationFrom = parseExtrapolationFrom(record);
  if (!extrapolationFrom.ok) {
    return extrapolationFrom;
  }
  return configValue({
    ...identity.value,
    ...sections.value,
    extrapolationFrom: extrapolationFrom.value,
  });
}
