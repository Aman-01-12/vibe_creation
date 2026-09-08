// `parseSweepConfig`: untrusted JSON in, a validated `SweepConfig` or a typed error
// out.
//
// This is the trust boundary for the whole sweep. Everything downstream - the routing
// policies, the harness, the sandbox, the results log, the manifest - is composed from
// the value this function returns, so a field that is wrong here is a run that either
// measures the wrong thing or dies partway. The contract is therefore strict: every
// field is narrowed and range-checked, an unusable value is a failure rather than a
// substituted default, and the failure names the field.
//
// FAIL BEFORE THE FIRST MODEL CALL, ALWAYS
//   That is the requirement this module exists to satisfy. Nothing here touches the
//   network, the filesystem, the clock, or the environment - it is a pure function of
//   the decoded JSON - so the CLI can validate the config, and only then decide
//   whether to spend money.

import type { ResourceLimits } from '@app/tools';
import type { ModelPrice, ModelPriceTable } from '@app/agent';

import type { StudentSessionCaps } from '../loop-runner.js';
import { makeReproducibilityConfig, type ReproducibilityConfig } from '../reproducibility.js';
import {
  MAX_MUTANT_WALL_MS,
  MAX_MUTANTS_PER_PROBLEM_LIMIT,
  MIN_MUTANT_WALL_MS,
} from '../mutation-control.js';
import {
  DEFAULT_CAPTURE_ARTIFACTS,
  DEFAULT_NEGATIVE_CONTROL_CONFIG,
  SWEEP_CONFIG_BOUNDS,
  SWEEP_CONFIG_SCHEMA_VERSION,
  SWEEP_NAME_PATTERN,
  type SweepConfig,
  type SweepModelHostConfig,
  type SweepNegativeControlConfig,
} from './config.js';
import { parseArms, parseProblemSelection } from './config-arms.js';
import {
  asArray,
  asIntegerInRange,
  asRecord,
  asTrimmedString,
  configFailure,
  configValue,
  optionalBoolean,
  optionalIntegerInRange,
  requireFiniteInRange,
  requireIntegerInRange,
  requireRecord,
  requireString,
  unknownKeyError,
  type SweepConfigResult,
} from './config-values.js';

/** Every field `parseSweepConfig` understands; anything else is refused. */
const TOP_LEVEL_FIELDS: readonly string[] = [
  'schemaVersion',
  'runName',
  'arms',
  'problems',
  'sampleCount',
  'ks',
  'seed',
  'temperature',
  'caps',
  'limits',
  'costEnvelopeCents',
  'modelHost',
  'prices',
  'outputDir',
  'captureArtifacts',
  'negativeControl',
  'concurrency',
  'transportRetry',
  'killSwitch',
];

/**
 * Every field the negative-control block understands.
 *
 * `minKillRate` is deliberately ABSENT and therefore rejected as an unrecognized key. The gate
 * is zero coverage-gap survivors, not a rate, so a config still carrying the retired threshold
 * is a config whose author believes they are setting a bar that no longer exists - and failing
 * loudly here is better than accepting a field nothing reads.
 */
const NEGATIVE_CONTROL_FIELDS: readonly string[] = [
  'enabled',
  'maxMutantsPerProblem',
  'mutantWallMs',
];

/** Every field the model-host block understands. */
const MODEL_HOST_FIELDS: readonly string[] = ['region', 'maxOutputTokens', 'requestTimeoutMs'];

/** Every field the transport-retry block understands. */
const TRANSPORT_RETRY_FIELDS: readonly string[] = [
  'maxAttempts',
  'baseDelayMs',
  'maxDelayMs',
  'jitterRatio',
  'breakerFailureThreshold',
  'breakerCooldownMs',
  'breakerMaxTrips',
];

/** Every field the kill-switch block understands. */
const KILL_SWITCH_FIELDS: readonly string[] = ['maxWallClockMs', 'maxSamples'];

/** Refuse an unrecognized key, so a typo cannot silently take a default. */
function checkKeys<T>(
  record: Record<string, unknown>,
  allowed: readonly string[],
  parentField: string,
): SweepConfigResult<T> | null {
  const error = unknownKeyError(record, allowed, parentField);
  return error === null ? null : { ok: false, error };
}
import { DEFAULT_KILL_SWITCH_BOUNDS, type KillSwitchBounds } from './kill-switch.js';
import { DEFAULT_TRANSPORT_RETRY_POLICY, type TransportRetryPolicy } from './transport-retry.js';

/** One day in milliseconds: the ceiling on any single configured duration. */
const MAX_DURATION_MS = 86_400_000;

/** A generous but finite ceiling on any configured token count. */
const MAX_TOKENS = 100_000_000;

/** A generous but finite ceiling on any configured cost in cents ($100k). */
const MAX_CENTS = 10_000_000;

/** Ceilings on the sandbox limits, matching what a student session may ask for. */
const LIMIT_BOUNDS = Object.freeze({
  maxCpu: 16,
  maxMemMb: 16_384,
  maxProcs: 4_096,
  maxDiskMb: 16_384,
});

/** Parse the student-session caps; the harness re-validates them authoritatively. */
function parseCaps(raw: Record<string, unknown>): SweepConfigResult<StudentSessionCaps> {
  const maxIterations = requireIntegerInRange(raw, 'maxIterations', { low: 1, high: 1_000 });
  if (!maxIterations.ok) {
    return maxIterations;
  }
  const maxTokens = requireIntegerInRange(raw, 'maxTokens', { low: 1, high: MAX_TOKENS });
  if (!maxTokens.ok) {
    return maxTokens;
  }
  const maxWallClockMs = requireIntegerInRange(raw, 'maxWallClockMs', {
    low: 1,
    high: MAX_DURATION_MS,
  });
  if (!maxWallClockMs.ok) {
    return maxWallClockMs;
  }
  const maxCostCents = requireFiniteInRange(raw, 'maxCostCents', { low: 0, high: MAX_CENTS });
  if (!maxCostCents.ok) {
    return maxCostCents;
  }
  return configValue({
    maxIterations: maxIterations.value,
    maxTokens: maxTokens.value,
    maxWallClockMs: maxWallClockMs.value,
    maxCostCents: maxCostCents.value,
  });
}

/** Parse the sandbox resource limits every sample and every golden run uses. */
function parseLimits(raw: Record<string, unknown>): SweepConfigResult<ResourceLimits> {
  const cpu = requireFiniteInRange(raw, 'cpu', { low: 0.1, high: LIMIT_BOUNDS.maxCpu });
  if (!cpu.ok) {
    return cpu;
  }
  const memMb = requireIntegerInRange(raw, 'memMb', { low: 16, high: LIMIT_BOUNDS.maxMemMb });
  if (!memMb.ok) {
    return memMb;
  }
  const procs = requireIntegerInRange(raw, 'procs', { low: 1, high: LIMIT_BOUNDS.maxProcs });
  if (!procs.ok) {
    return procs;
  }
  const diskMb = requireIntegerInRange(raw, 'diskMb', { low: 1, high: LIMIT_BOUNDS.maxDiskMb });
  if (!diskMb.ok) {
    return diskMb;
  }
  const wallMs = requireIntegerInRange(raw, 'wallMs', { low: 1_000, high: MAX_DURATION_MS });
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

/** Parse seed/temperature/sampleCount through the reproducibility constructor. */
function parseReproducibility(
  raw: Record<string, unknown>,
): SweepConfigResult<ReproducibilityConfig> {
  const sampleCount = requireIntegerInRange(raw, 'sampleCount', {
    low: 1,
    high: SWEEP_CONFIG_BOUNDS.maxSampleCount,
  });
  if (!sampleCount.ok) {
    return sampleCount;
  }
  const seed = requireIntegerInRange(raw, 'seed', { low: 0, high: 0xffffffff });
  if (!seed.ok) {
    return seed;
  }
  const temperature = requireFiniteInRange(raw, 'temperature', { low: 0, high: 2 });
  if (!temperature.ok) {
    return temperature;
  }
  // Delegated so the eval layer has exactly ONE reproducibility validator, and so a
  // future tightening there is inherited here rather than duplicated.
  const built = makeReproducibilityConfig({
    seed: seed.value,
    temperature: temperature.value,
    sampleCount: sampleCount.value,
  });
  if (!built.ok) {
    return configFailure('REPRODUCIBILITY_INVALID', 'seed', built.error.message);
  }
  return configValue(built.value);
}

/** Parse and dedupe the reported k values, each an integer in [1, sampleCount]. */
function parseKs(raw: unknown, sampleCount: number): SweepConfigResult<readonly number[]> {
  const entries = asArray(raw);
  if (entries === null || entries.length === 0) {
    return configFailure('FIELD_NOT_AN_ARRAY', 'ks', 'ks must be a non-empty array of integers');
  }
  const ks: number[] = [];
  for (const [index, entry] of entries.entries()) {
    const k = asIntegerInRange(entry, 1, sampleCount);
    if (k === null) {
      return configFailure(
        'K_OUT_OF_RANGE',
        `ks[${index}]`,
        `each k must be an integer in [1, ${sampleCount}] (sampleCount)`,
      );
    }
    ks.push(k);
  }
  return configValue([...new Set(ks)].sort((left, right) => left - right));
}

/** Parse the non-secret model-host configuration. */
function parseModelHost(raw: Record<string, unknown>): SweepConfigResult<SweepModelHostConfig> {
  const unknown = checkKeys<SweepModelHostConfig>(raw, MODEL_HOST_FIELDS, 'modelHost');
  if (unknown !== null) {
    return unknown;
  }
  const region = requireString(raw, 'region');
  if (!region.ok) {
    return region;
  }
  const maxOutputTokens =
    raw.maxOutputTokens === undefined
      ? null
      : requireIntegerInRange(raw, 'maxOutputTokens', { low: 1, high: 200_000 });
  if (maxOutputTokens !== null && !maxOutputTokens.ok) {
    return maxOutputTokens;
  }
  const requestTimeoutMs =
    raw.requestTimeoutMs === undefined
      ? null
      : requireIntegerInRange(raw, 'requestTimeoutMs', { low: 1_000, high: MAX_DURATION_MS });
  if (requestTimeoutMs !== null && !requestTimeoutMs.ok) {
    return requestTimeoutMs;
  }
  return configValue({
    region: region.value,
    ...(maxOutputTokens === null ? {} : { maxOutputTokens: maxOutputTokens.value }),
    ...(requestTimeoutMs === null ? {} : { requestTimeoutMs: requestTimeoutMs.value }),
  });
}

/** Parse one model's price entry; both rates are required and non-negative. */
function parsePrice(raw: unknown, modelId: string): SweepConfigResult<ModelPrice> {
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('PRICE_INVALID', `prices.${modelId}`, 'each price must be an object');
  }
  const input = requireFiniteInRange(record, 'inputCentsPerMillionTokens', {
    low: 0,
    high: MAX_CENTS,
  });
  if (!input.ok) {
    return configFailure(
      'PRICE_INVALID',
      `prices.${modelId}.inputCentsPerMillionTokens`,
      'inputCentsPerMillionTokens must be a non-negative finite number',
    );
  }
  const output = requireFiniteInRange(record, 'outputCentsPerMillionTokens', {
    low: 0,
    high: MAX_CENTS,
  });
  if (!output.ok) {
    return configFailure(
      'PRICE_INVALID',
      `prices.${modelId}.outputCentsPerMillionTokens`,
      'outputCentsPerMillionTokens must be a non-negative finite number',
    );
  }
  return configValue({
    inputCentsPerMillionTokens: input.value,
    outputCentsPerMillionTokens: output.value,
  });
}

/**
 * Parse the optional price table.
 *
 * An absent table is legal and means every arm's cost is UNKNOWN - which the summary
 * states outright rather than printing zeros. A PRESENT but malformed entry fails,
 * because a price silently dropped would understate spend.
 */
function parsePrices(raw: unknown): SweepConfigResult<ModelPriceTable> {
  if (raw === undefined) {
    return configValue({});
  }
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('PRICE_INVALID', 'prices', 'prices must be an object keyed by model id');
  }
  const entries = Object.entries(record);
  if (entries.length > SWEEP_CONFIG_BOUNDS.maxPricedModels) {
    return configFailure(
      'FIELD_OUT_OF_RANGE',
      'prices',
      `prices may name at most ${SWEEP_CONFIG_BOUNDS.maxPricedModels} models`,
    );
  }
  const prices: Record<string, ModelPrice> = {};
  for (const [modelId, value] of entries) {
    const price = parsePrice(value, modelId);
    if (!price.ok) {
      return price;
    }
    prices[modelId] = price.value;
  }
  return configValue(prices);
}

/** The retry-attempt and backoff knobs. */
interface RetryBackoffFields {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

/** Parse the attempt count and the backoff shape, defaulting each field. */
function parseRetryBackoff(record: Record<string, unknown>): SweepConfigResult<RetryBackoffFields> {
  const maxAttempts = optionalIntegerInRange(record, 'maxAttempts', {
    low: 1,
    high: 10,
    fallback: DEFAULT_TRANSPORT_RETRY_POLICY.maxAttempts,
  });
  if (!maxAttempts.ok) {
    return maxAttempts;
  }
  const baseDelayMs = optionalIntegerInRange(record, 'baseDelayMs', {
    low: 1,
    high: MAX_DURATION_MS,
    fallback: DEFAULT_TRANSPORT_RETRY_POLICY.baseDelayMs,
  });
  if (!baseDelayMs.ok) {
    return baseDelayMs;
  }
  const maxDelayMs = optionalIntegerInRange(record, 'maxDelayMs', {
    low: 1,
    high: MAX_DURATION_MS,
    fallback: DEFAULT_TRANSPORT_RETRY_POLICY.maxDelayMs,
  });
  if (!maxDelayMs.ok) {
    return maxDelayMs;
  }
  const jitterRatio =
    record.jitterRatio === undefined
      ? configValue(DEFAULT_TRANSPORT_RETRY_POLICY.jitterRatio)
      : requireFiniteInRange(record, 'jitterRatio', { low: 0, high: 1 });
  if (!jitterRatio.ok) {
    return jitterRatio;
  }
  return configValue({
    maxAttempts: maxAttempts.value,
    baseDelayMs: baseDelayMs.value,
    maxDelayMs: maxDelayMs.value,
    jitterRatio: jitterRatio.value,
  });
}

/** The three breaker knobs. */
interface RetryBreakerFields {
  readonly breakerFailureThreshold: number;
  readonly breakerCooldownMs: number;
  readonly breakerMaxTrips: number;
}

/** Parse the circuit-breaker knobs, defaulting each field. */
function parseRetryBreaker(record: Record<string, unknown>): SweepConfigResult<RetryBreakerFields> {
  const breakerFailureThreshold = optionalIntegerInRange(record, 'breakerFailureThreshold', {
    low: 1,
    high: 1_000,
    fallback: DEFAULT_TRANSPORT_RETRY_POLICY.breakerFailureThreshold,
  });
  if (!breakerFailureThreshold.ok) {
    return breakerFailureThreshold;
  }
  const breakerCooldownMs = optionalIntegerInRange(record, 'breakerCooldownMs', {
    low: 0,
    high: MAX_DURATION_MS,
    fallback: DEFAULT_TRANSPORT_RETRY_POLICY.breakerCooldownMs,
  });
  if (!breakerCooldownMs.ok) {
    return breakerCooldownMs;
  }
  const breakerMaxTrips = optionalIntegerInRange(record, 'breakerMaxTrips', {
    low: 1,
    high: 1_000,
    fallback: DEFAULT_TRANSPORT_RETRY_POLICY.breakerMaxTrips,
  });
  if (!breakerMaxTrips.ok) {
    return breakerMaxTrips;
  }
  return configValue({
    breakerFailureThreshold: breakerFailureThreshold.value,
    breakerCooldownMs: breakerCooldownMs.value,
    breakerMaxTrips: breakerMaxTrips.value,
  });
}

/** Parse the optional transport retry + breaker policy, defaulting field by field. */
function parseTransportRetry(raw: unknown): SweepConfigResult<TransportRetryPolicy> {
  if (raw === undefined) {
    return configValue(DEFAULT_TRANSPORT_RETRY_POLICY);
  }
  const record = asRecord(raw);
  if (record === null) {
    return configFailure(
      'FIELD_NOT_AN_OBJECT',
      'transportRetry',
      'transportRetry must be an object',
    );
  }
  const unknown = checkKeys<TransportRetryPolicy>(record, TRANSPORT_RETRY_FIELDS, 'transportRetry');
  if (unknown !== null) {
    return unknown;
  }
  const backoff = parseRetryBackoff(record);
  if (!backoff.ok) {
    return backoff;
  }
  const breaker = parseRetryBreaker(record);
  if (!breaker.ok) {
    return breaker;
  }
  return configValue({ ...backoff.value, ...breaker.value });
}

/**
 * Parse the optional negative-control block, defaulting each field.
 *
 * `maxMutantsPerProblem` is bounded because it multiplies wall clock by simulations; an
 * unusable value is a config error rather than a finding, and failing here means it fails
 * BEFORE the first paid model call.
 *
 * `mutantWallMs` is bounded for a stronger reason than cost. Too SMALL manufactures timeouts,
 * and a timeout is now a golden KILL that enlarges the gate set, so an under-set cap does not
 * merely slow a campaign - it corrupts what the campaign measured. Too LARGE stops bounding a
 * hang and becomes one, multiplied by mutants x samples x problems. Both ends are rejected here
 * rather than discovered in a summary (see `MIN_MUTANT_WALL_MS` / `MAX_MUTANT_WALL_MS`).
 */
function parseNegativeControl(raw: unknown): SweepConfigResult<SweepNegativeControlConfig> {
  if (raw === undefined) {
    return configValue(DEFAULT_NEGATIVE_CONTROL_CONFIG);
  }
  const record = asRecord(raw);
  if (record === null) {
    return configFailure(
      'FIELD_NOT_AN_OBJECT',
      'negativeControl',
      'negativeControl must be an object',
    );
  }
  const unknown = checkKeys<SweepNegativeControlConfig>(
    record,
    NEGATIVE_CONTROL_FIELDS,
    'negativeControl',
  );
  if (unknown !== null) {
    return unknown;
  }
  const enabled = optionalBoolean(record, 'enabled', DEFAULT_NEGATIVE_CONTROL_CONFIG.enabled);
  if (!enabled.ok) {
    return enabled;
  }
  const maxMutantsPerProblem = optionalIntegerInRange(record, 'maxMutantsPerProblem', {
    low: 1,
    high: MAX_MUTANTS_PER_PROBLEM_LIMIT,
    fallback: DEFAULT_NEGATIVE_CONTROL_CONFIG.maxMutantsPerProblem,
  });
  if (!maxMutantsPerProblem.ok) {
    return maxMutantsPerProblem;
  }
  const mutantWallMs = optionalIntegerInRange(record, 'mutantWallMs', {
    low: MIN_MUTANT_WALL_MS,
    high: MAX_MUTANT_WALL_MS,
    fallback: DEFAULT_NEGATIVE_CONTROL_CONFIG.mutantWallMs,
  });
  if (!mutantWallMs.ok) {
    return mutantWallMs;
  }
  return configValue({
    enabled: enabled.value,
    maxMutantsPerProblem: maxMutantsPerProblem.value,
    mutantWallMs: mutantWallMs.value,
  });
}

/** Parse the optional kill-switch bounds, defaulting each field. */
function parseKillSwitch(raw: unknown): SweepConfigResult<KillSwitchBounds> {
  if (raw === undefined) {
    return configValue(DEFAULT_KILL_SWITCH_BOUNDS);
  }
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('FIELD_NOT_AN_OBJECT', 'killSwitch', 'killSwitch must be an object');
  }
  const unknown = checkKeys<KillSwitchBounds>(record, KILL_SWITCH_FIELDS, 'killSwitch');
  if (unknown !== null) {
    return unknown;
  }
  const maxWallClockMs = optionalIntegerInRange(record, 'maxWallClockMs', {
    low: 1_000,
    high: MAX_DURATION_MS,
    fallback: DEFAULT_KILL_SWITCH_BOUNDS.maxWallClockMs,
  });
  if (!maxWallClockMs.ok) {
    return maxWallClockMs;
  }
  const maxSamples = optionalIntegerInRange(record, 'maxSamples', {
    low: 1,
    high: 1_000_000,
    fallback: DEFAULT_KILL_SWITCH_BOUNDS.maxSamples,
  });
  if (!maxSamples.ok) {
    return maxSamples;
  }
  return configValue({ maxWallClockMs: maxWallClockMs.value, maxSamples: maxSamples.value });
}

/** Parse the output directory, refusing a value that could escape into a shell. */
function parseOutputDir(raw: Record<string, unknown>): SweepConfigResult<string> {
  const dir = asTrimmedString(raw.outputDir);
  if (dir === null || dir.length > SWEEP_CONFIG_BOUNDS.maxOutputDirLength) {
    return configFailure(
      'FIELD_NOT_A_STRING',
      'outputDir',
      `outputDir must be a non-empty path of at most ${SWEEP_CONFIG_BOUNDS.maxOutputDirLength} characters`,
    );
  }
  if (dir.includes('\0') || dir.includes('..')) {
    return configFailure(
      'FIELD_OUT_OF_RANGE',
      'outputDir',
      'outputDir must not contain ".." or a null byte',
    );
  }
  return configValue(dir);
}

/** Validate the schema version and the run name, the two identity fields. */
function parseIdentity(
  record: Record<string, unknown>,
): SweepConfigResult<{ readonly schemaVersion: number; readonly runName: string }> {
  const schemaVersion = asIntegerInRange(
    record.schemaVersion,
    SWEEP_CONFIG_SCHEMA_VERSION,
    SWEEP_CONFIG_SCHEMA_VERSION,
  );
  if (schemaVersion === null) {
    return configFailure(
      'SCHEMA_VERSION_UNSUPPORTED',
      'schemaVersion',
      `schemaVersion must be ${SWEEP_CONFIG_SCHEMA_VERSION}`,
    );
  }
  const runName = asTrimmedString(record.runName);
  if (
    runName === null ||
    runName.length > SWEEP_CONFIG_BOUNDS.maxNameLength ||
    !SWEEP_NAME_PATTERN.test(runName)
  ) {
    return configFailure(
      'FIELD_NOT_A_STRING',
      'runName',
      `runName must match ${SWEEP_NAME_PATTERN.source} and be at most ${SWEEP_CONFIG_BOUNDS.maxNameLength} characters`,
    );
  }
  return configValue({ schemaVersion, runName });
}

/** The sections parsed from nested objects, gathered so the top level stays flat. */
interface ParsedSections {
  readonly caps: StudentSessionCaps;
  readonly limits: ResourceLimits;
  readonly reproducibility: ReproducibilityConfig;
  readonly modelHost: SweepModelHostConfig;
}

/** Parse the four required nested sections, short-circuiting on the first failure. */
function parseSections(record: Record<string, unknown>): SweepConfigResult<ParsedSections> {
  const capsRecord = requireRecord(record, 'caps');
  if (!capsRecord.ok) {
    return capsRecord;
  }
  const caps = parseCaps(capsRecord.value);
  if (!caps.ok) {
    return caps;
  }
  const limitsRecord = requireRecord(record, 'limits');
  if (!limitsRecord.ok) {
    return limitsRecord;
  }
  const limits = parseLimits(limitsRecord.value);
  if (!limits.ok) {
    return limits;
  }
  const reproducibility = parseReproducibility(record);
  if (!reproducibility.ok) {
    return reproducibility;
  }
  const hostRecord = requireRecord(record, 'modelHost');
  if (!hostRecord.ok) {
    return hostRecord;
  }
  const modelHost = parseModelHost(hostRecord.value);
  if (!modelHost.ok) {
    return modelHost;
  }
  return configValue({
    caps: caps.value,
    limits: limits.value,
    reproducibility: reproducibility.value,
    modelHost: modelHost.value,
  });
}

/** The optional, defaulted sections plus the remaining scalars. */
interface ParsedOptionals {
  readonly prices: ModelPriceTable;
  readonly transportRetry: TransportRetryPolicy;
  readonly killSwitch: KillSwitchBounds;
  readonly concurrency: number;
  readonly costEnvelopeCents: number;
  readonly outputDir: string;
  readonly captureArtifacts: boolean;
  readonly negativeControl: SweepNegativeControlConfig;
}

/** Parse the optional/defaulted knobs, short-circuiting on the first failure. */
function parseOptionals(record: Record<string, unknown>): SweepConfigResult<ParsedOptionals> {
  const prices = parsePrices(record.prices);
  if (!prices.ok) {
    return prices;
  }
  const transportRetry = parseTransportRetry(record.transportRetry);
  if (!transportRetry.ok) {
    return transportRetry;
  }
  const killSwitch = parseKillSwitch(record.killSwitch);
  if (!killSwitch.ok) {
    return killSwitch;
  }
  const concurrency = optionalIntegerInRange(record, 'concurrency', {
    low: 1,
    high: SWEEP_CONFIG_BOUNDS.maxConcurrency,
    fallback: 2,
  });
  if (!concurrency.ok) {
    return concurrency;
  }
  const costEnvelopeCents = requireFiniteInRange(record, 'costEnvelopeCents', {
    low: 0,
    high: MAX_CENTS,
  });
  if (!costEnvelopeCents.ok) {
    return costEnvelopeCents;
  }
  const outputDir = parseOutputDir(record);
  if (!outputDir.ok) {
    return outputDir;
  }
  const captureArtifacts = optionalBoolean(record, 'captureArtifacts', DEFAULT_CAPTURE_ARTIFACTS);
  if (!captureArtifacts.ok) {
    return captureArtifacts;
  }
  const negativeControl = parseNegativeControl(record.negativeControl);
  if (!negativeControl.ok) {
    return negativeControl;
  }
  return configValue({
    prices: prices.value,
    transportRetry: transportRetry.value,
    killSwitch: killSwitch.value,
    concurrency: concurrency.value,
    costEnvelopeCents: costEnvelopeCents.value,
    outputDir: outputDir.value,
    captureArtifacts: captureArtifacts.value,
    negativeControl: negativeControl.value,
  });
}

/**
 * Parse and validate a raw (JSON-decoded) sweep configuration.
 *
 * Returns the validated `SweepConfig` or the FIRST typed error found, naming the
 * offending field. Pure: no I/O, no clock, no environment - so the CLI validates
 * before it spends anything.
 */
export function parseSweepConfig(raw: unknown): SweepConfigResult<SweepConfig> {
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('NOT_AN_OBJECT', '', 'the sweep config must be a JSON object');
  }
  const unknown = checkKeys<SweepConfig>(record, TOP_LEVEL_FIELDS, '');
  if (unknown !== null) {
    return unknown;
  }
  const identity = parseIdentity(record);
  if (!identity.ok) {
    return identity;
  }
  const arms = parseArms(record.arms);
  if (!arms.ok) {
    return arms;
  }
  const problems = parseProblemSelection(record.problems);
  if (!problems.ok) {
    return problems;
  }
  const sections = parseSections(record);
  if (!sections.ok) {
    return sections;
  }
  const ks = parseKs(record.ks, sections.value.reproducibility.sampleCount);
  if (!ks.ok) {
    return ks;
  }
  const optionals = parseOptionals(record);
  if (!optionals.ok) {
    return optionals;
  }
  return configValue({
    ...identity.value,
    arms: arms.value,
    problems: problems.value,
    ks: ks.value,
    ...sections.value,
    ...optionals.value,
  });
}
