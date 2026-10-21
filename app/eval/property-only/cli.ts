// The runnable Property_Only_Mode entry: the COMPOSITION ROOT for the property-only measurement.
//
//   npm run eval:property-only -- --config app/eval/property-only/property-only.config.example.json
//
// WHY THIS IS A SECOND ENTRY POINT AND NOT A FLAG ON `../sweep/cli.ts`
//   This mode's own path omits Instrument_Admission (Req 5.3), and a mode whose path omits it
//   must not be reachable from the CLI that runs the product path (Req 10.2, 10.4). A shared
//   entry point would make the omission a flag, and a flag that skips Instrument_Admission on
//   the Student_Path is what criterion 10.4 refuses to start under. So the two CLIs share
//   composition HELPERS - the preflight probes, the host facts, the corpus importer, the one
//   exported Property_Author construction path - and nothing else. Neither imports the other.
//
// WHAT THIS MODE MEASURES, AND WHAT IT DOES NOT TOUCH
//   Per design: the Property_Author writes a Property_Set from the Spec alone, and that set is
//   decided against the UNMODIFIED golden reference design through the same Property_Validator
//   (inside the author), Reset_Contract_Prepass and Formal_Oracle the Student_Path uses
//   (Req 5.1, 5.4). There is no Testbench_Agent call (Req 5.2) and no Instrument_Admission step
//   (Req 5.3) in this path, and no configuration value here can move a Formal_Verdict, a trust
//   label, or a Fallback_Route on the Student_Path (Req 10.6).
//
// AUTHOR FIRST, PRE-PASS SECOND
//   The pre-pass is deterministic and cheap, so running it first would be the cheaper order and
//   would skip authoring for the designs it refuses. That order is rejected: those designs are
//   exactly the ones whose refusal floor this measurement is sizing, and skipping their
//   authoring would leave the record with no property-authoring data for them. Every one of the
//   46 scored designs therefore carries what each Authoring_Model produced, and the pre-pass
//   outcome then sorts the design into the Admitted or the Refused population (design.md, C7).
//
// THE PILOT GATE IS THE SAFETY PROPERTY OF THIS FILE
//   While no Per_Design_Extrapolation is recorded, NOTHING outside the Cost_Pilot dispatches
//   (Req 5.6). The extrapolation is read from an earlier property-only measurement and is the
//   MAXIMUM of its per-design figures, never the mean: the Anomaly_Guard's job is to avoid
//   tripping on plausible variation, so a maximum makes a trip mean something is wrong.
//
// EXIT CODES
//   0  the run finished, or stopped at the Cost_Pilot bound, with at least one design measured.
//   1  a refusal before dispatch, or nothing measured.
//   2  the Anomaly_Guard stopped the run. A suspected defect IN THE RUN, so a wrapper script can
//      tell it from a refusal; the measured figure is reported beside the guard it exceeded.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  domainError,
  err,
  makeSessionBudget,
  newUlid,
  ok,
  type DomainError,
  type Result,
  type SessionBudget,
} from '@app/core';
import {
  createBedrockMantleTransport,
  createFetchJsonHttpPort,
  createModelRouter,
  DEFAULT_CREDENTIAL_FILE,
  FORMAL_ORACLE_VERSION,
  InMemoryTracePersistence,
  primarySelectionFor,
  providerCredentialRef,
  RefreshingSecretManager,
  TraceActionRecorder,
  type FormalPropertySet,
  type PropertySetSource,
  type SecretManagerPort,
} from '@app/agent';
import {
  BoundedArtifactRetention,
  LocalWorkerRuntime,
  projectWorkerEnvironment,
  SandboxToolRunner,
  WORKER_ENVIRONMENT_ALLOWLIST,
  YosysSmtBmcFormalOracle,
  type CouldNotVerifyCause,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProperty,
  type ProofConditions,
  type PropertyResult,
  type SourceFile,
} from '@app/tools';

import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  localTimingDerivation,
  NodeCheckoutProbePort,
  RTLLM_CHECKOUT_PATH,
  scoredRtllmCorpus,
} from '../corpus/index.js';
import { EVAL_CORPUS_ROOT } from '../corpus/fetch-node.js';
import { RTLLM_SCORED_DESIGN_COUNT } from '../corpus/stage0-quarantine.js';
import { limitOrRefuse, type MeasurementLimit } from '../measurement-limit.js';
import { MeteredSessionBudget } from '../metered-budget.js';
import type { EvalProblem } from '../problem.js';
import { singleModelEvalRoutingPolicy } from '../routing-policy.js';
import { propertyAuthorFor } from '../verification-loop-runner.js';
import {
  probeFormalToolchainAvailability,
  probeToolchainAvailability,
  probeToolchainVersions,
} from '../sweep/host-facts.js';
import type { ManifestToolchain } from '../sweep/manifest.js';
import {
  checkCorpus,
  checkFormalToolchain,
  preflightFailure,
  renderPreflightFailure,
  toolchainFailure,
  type PreflightFailure,
} from '../sweep/preflight.js';
import { RESULTS_LOG_FILENAME } from '../sweep/results-log.js';
import { ensureDirectory } from '../sweep/results-log-node.js';
import { parsePropertyOnlyConfig, type PropertyOnlyConfig } from './config.js';
import {
  encodePropertyOnlyMeasurement,
  decodePropertyOnlyMeasurement,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
  type PropertyOnlyOutcome,
  type PropertyOnlyPropertyResult,
} from './record.js';
import { renderPropertyOnlyReport } from './report.js';

/** Largest config file this CLI will read, in bytes. */
const MAX_CONFIG_BYTES = 65_536;

/**
 * The file one measurement is persisted in, inside its own directory (Req 9.9, 9.10).
 *
 * Deliberately NOT `RESULTS_LOG_FILENAME` and not the sweep's summary: no Measurement_Report of
 * an End_To_End_Formal_Rate reads this name, and `assertOutputDirIsNotAnEndToEndRun` refuses an
 * output directory that already holds an end-to-end results log.
 */
export const PROPERTY_ONLY_MEASUREMENT_FILENAME = 'property-only-measurement.json';

/** The rendered report, written beside the record for a reader who wants no decoder. */
export const PROPERTY_ONLY_REPORT_FILENAME = 'property-only-report.txt';

/** The Student_Path steps this measurement's own path omits (Req 9.2). */
export const OMITTED_STUDENT_PATH_STEPS: readonly string[] = Object.freeze([
  'testbench-generation',
  'instrument-admission',
]);

/** The earlier run this measurement supersedes; its 12 records stay in place as evidence. */
export const SUPERSEDED_RUN_DIR = join('.eval-runs', 'formal-gate-v1-pilot');

/** The note naming the measurement that superseded that run (Req 9.11). */
export const SUPERSESSION_NOTE_FILENAME = 'SUPERSEDED-BY.txt';

/** Every limit this mode reads, by the name the registry holds it under (Req 12.4). */
const LIMIT_NAMES: readonly string[] = Object.freeze([
  'cost-pilot-design-count',
  'anomaly-guard',
  'shipped-property-time-budget',
  'proof-depth',
]);

/** The limits a Cost_Pilot executes under: the design-count bound, the budget, the depth. */
const PILOT_LIMIT_NAMES: readonly string[] = Object.freeze([
  'cost-pilot-design-count',
  'shipped-property-time-budget',
  'proof-depth',
]);

/** The limits a full-population run executes under; the guard replaces the pilot's bound. */
const FULL_LIMIT_NAMES: readonly string[] = Object.freeze([
  'anomaly-guard',
  'shipped-property-time-budget',
  'proof-depth',
]);

/**
 * The two causes that mean the pre-pass refused before any solver ran.
 *
 * Read from the vocabulary rather than re-derived: `reset-contract-unresolved` is a reset the
 * derivation could not read, `clock-contract-unsupported` is a non-posedge flop the model cannot
 * carry faithfully, and both are reported with no Property_Wrapper built (Req 5.17).
 */
const PREPASS_REFUSAL_CAUSES: readonly CouldNotVerifyCause[] = Object.freeze([
  'reset-contract-unresolved',
  'clock-contract-unsupported',
]);

/** The provider every Authoring_Model on this corpus is routed through. */
const PROPERTY_ONLY_PROVIDER = 'bedrock-mantle';

/** The variable the isolation check places its sentinel under; absent from the allowlist. */
const SENTINEL_VARIABLE = 'ECE_PROPERTY_ONLY_ISOLATION_SENTINEL';

/** The sentinel value itself. The only environment value this check may ever emit (Req 1.8). */
const SENTINEL_VALUE = 'property-only-isolation-sentinel';

// -- Arguments --------------------------------------------------------------

/** What a CLI invocation produced: lines to print and the exit code to set. */
export interface PropertyOnlyCliResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

/** The one thing this CLI can be asked to do, or a usage error. */
export type PropertyOnlyCommand =
  | { readonly kind: 'run'; readonly configPath: string }
  | { readonly kind: 'usage'; readonly problem: string };

/** Usage text, printed for a malformed invocation. */
export const PROPERTY_ONLY_USAGE: readonly string[] = Object.freeze([
  'usage:',
  '  eval:property-only -- --config <path/to/property-only.config.json>',
]);

/**
 * Parse argv into a command.
 *
 * argv is untrusted input, and there is exactly ONE accepted invocation. In particular there is
 * no flag that selects the population: the Cost_Pilot gate is decided from whether an
 * extrapolation is recorded, so no operator can widen a run by typing a flag (Req 5.6). A
 * flag-shaped value is refused, so a mistyped flag names itself rather than an unreadable file.
 */
export function parsePropertyOnlyArgs(argv: readonly string[]): PropertyOnlyCommand {
  if (argv.length !== 2) {
    return { kind: 'usage', problem: 'expected exactly one flag and one value' };
  }
  const [flag, value] = argv;
  if (value === undefined || value.trim().length === 0) {
    return { kind: 'usage', problem: 'the flag value must not be empty' };
  }
  if (flag !== '--config') {
    return { kind: 'usage', problem: `unrecognized flag ${String(flag)}` };
  }
  return value.trim().startsWith('-')
    ? { kind: 'usage', problem: `the --config value ${value} looks like a flag rather than a path` }
    : { kind: 'run', configPath: value };
}

// -- The refusals -----------------------------------------------------------

/**
 * The projection the worker child's environment is built by.
 *
 * A seam, so the refusal below can be driven against a projector that leaks and one that drops.
 * A check whose failing direction cannot be exercised is not a control.
 */
export type WorkerEnvironmentProjector = typeof projectWorkerEnvironment;

/**
 * Why the worker-secret isolation rule does not hold here, or `null` where it does (Req 1.7).
 *
 * This re-applies the Sentinel_Isolation_Test's OWN rule over the SAME `projectWorkerEnvironment`
 * the runtime spawns the worker through: place a sentinel under a name absent from the allowlist,
 * project a host environment, and fail where the sentinel reached the projection or where an
 * allowlisted name the host held did not. The integration test asserts this against a real
 * spawned child; a CLI cannot run that test, so it checks the closure the child inherits, which
 * is the thing the test is about. The sentinel is the only environment value named here.
 */
export function workerIsolationFailure(
  hostEnv: Readonly<Record<string, string | undefined>>,
  project: WorkerEnvironmentProjector = projectWorkerEnvironment,
): string | null {
  const probe: Record<string, string | undefined> = { ...hostEnv };
  probe[SENTINEL_VARIABLE] = SENTINEL_VALUE;
  const projected = project(probe);
  const leaked = Object.entries(projected.env).find(([, value]) => value === SENTINEL_VALUE);
  if (leaked !== undefined) {
    return `a value under a name absent from the Worker_Environment_Allowlist reached the worker environment as ${leaked[0]}`;
  }
  const present = WORKER_ENVIRONMENT_ALLOWLIST.filter((name) => probe[name] !== undefined);
  const dropped = present.find((name) => projected.env[name] === undefined);
  if (dropped !== undefined) {
    return `the allowlisted variable ${dropped} did not reach the worker environment, so the projection is passing nothing rather than the allowlist`;
  }
  return null;
}

/**
 * The limits one run executes under, resolved from the registry once.
 *
 * The two the run READS are named fields rather than lookups, so a missing one is a refusal
 * before dispatch instead of an `undefined` at the moment a figure is compared against it.
 */
export interface RunLimits {
  readonly all: ReadonlyMap<string, MeasurementLimit>;
  /** The multiple the Anomaly_Guard is set at: 10 times the Per_Design_Extrapolation. */
  readonly anomalyGuard: MeasurementLimit;
  /** The shipped Property_Time_Budget every property is decided under (Req 5.4). */
  readonly propertyTimeBudget: MeasurementLimit;
}

/** Each limit this mode runs under, or the one name the registry does not hold (Req 12.4). */
export function declaredLimitsOrRefuse(): Result<RunLimits, DomainError> {
  const all = new Map<string, MeasurementLimit>();
  for (const name of LIMIT_NAMES) {
    const limit = limitOrRefuse(name);
    if (!limit.ok) {
      return limit;
    }
    all.set(name, limit.value);
  }
  const anomalyGuard = all.get('anomaly-guard');
  const propertyTimeBudget = all.get('shipped-property-time-budget');
  if (anomalyGuard === undefined || propertyTimeBudget === undefined) {
    // Unreachable while `LIMIT_NAMES` names both, and stated anyway: the alternative is a
    // non-null assertion, which would hide a rename of either name.
    return err(
      domainError(
        'MEASUREMENT_LIMIT_NOT_DECLARED',
        'the Anomaly_Guard and the shipped Property_Time_Budget must both be declared',
        'name',
      ),
    );
  }
  return ok({ all, anomalyGuard, propertyTimeBudget });
}

/** The declared limits a run of one scope executes under, in declaration order (Req 12.5). */
export function recordedLimitsFor(
  scope: DispatchScope,
  declared: ReadonlyMap<string, MeasurementLimit>,
): readonly MeasurementLimit[] {
  const names = scope === 'cost-pilot' ? PILOT_LIMIT_NAMES : FULL_LIMIT_NAMES;
  return names.flatMap((name) => {
    const limit = declared.get(name);
    return limit === undefined ? [] : [limit];
  });
}

// -- The Cost_Pilot gate and the Anomaly_Guard ------------------------------

/**
 * The per-design ceiling taken from a Cost_Pilot; both figures, never one.
 *
 * `tokens` is what the guard's token arm is a multiple of. `elapsedMs` is still recorded because
 * it is the pilot's provenance (Req 5.7) and the figure a design's wall clock is reported beside
 * (Req 5.22), but it is no longer the wall-clock stop condition (design.md, C7).
 */
export interface PerDesignExtrapolation {
  readonly tokens: number;
  readonly elapsedMs: number;
}

/** What one design actually measured, as the guard reads it. */
export interface DesignFigures {
  readonly tokens: number;
  /**
   * The Proof_Span the wall-clock arm is read against, or `null` where no proof was attempted.
   *
   * The Design_Total is deliberately absent: the arm's limit bounds the proof alone, so making
   * the total unavailable here keeps the span mismatch from being written again (Req 5.20).
   */
  readonly proofSpanMs: number | null;
}

/**
 * The Per_Design_Extrapolation an earlier measurement records, or `null` where it records none.
 *
 * The MAXIMUM of the per-design figures and never the mean (Req 5.8, design.md C7): the guard
 * exists to catch a run that has gone wrong, so it is set where no plausible variation between
 * designs can trip it and a trip is therefore information about the run.
 */
export function perDesignExtrapolationOf(
  measurement: PropertyOnlyMeasurement,
): PerDesignExtrapolation | null {
  if (measurement.results.length === 0) {
    return null;
  }
  let tokens = 0;
  let elapsedMs = 0;
  for (const result of measurement.results) {
    tokens = Math.max(tokens, result.promptTokens + result.completionTokens);
    elapsedMs = Math.max(elapsedMs, result.elapsedMs);
  }
  return { tokens, elapsedMs };
}

/** One breach of the Anomaly_Guard: the measured figure, and the arm it exceeded. */
export interface AnomalyBreach {
  readonly figure: 'tokens' | 'proofSpanMs';
  readonly measured: number;
  /** The arm's own threshold: a multiple for tokens, the declared budget for wall clock. */
  readonly guard: number;
  /**
   * The declared Measurement_Limit THIS arm was taken from, which differs per arm:
   * `anomaly-guard` for tokens, `shipped-property-time-budget` for wall clock. Carried so the
   * renderer names the limit and its Limit_Reason without re-deriving the arm (Req 5.21, 12.10).
   */
  readonly limit: MeasurementLimit;
}

/**
 * The guard breach one design's figures represent, or `null` where neither arm is exceeded.
 *
 * The two arms are sized from two different places. Tokens sit at a multiple of the pilot's
 * maximum because no per-design token ceiling is declared anywhere; wall clock sits at the
 * declared budget, since a pilot sized that arm at 52740 ms against a design legitimately
 * measured at 149997 ms under the budget (design.md, C7).
 *
 * The wall-clock arm reads a Proof_Span and never a Design_Total. The declared budget bounds the
 * proof alone, so comparing a design total against it refused any design whose proof legitimately
 * reached the budget, by however long that design's authoring took (Req 5.20, design.md C7).
 *
 * Tokens are checked first because a prompt that never terminates shows in both figures and the
 * token figure is the one that names the cause (Req 5.8).
 *
 * The reservation: an arm AT the budget cannot catch a slow run that still finishes inside it.
 * That case is a reported figure under Req 5.22, not a stop condition.
 */
export function anomalyBreachOf(
  figures: DesignFigures,
  extrapolation: PerDesignExtrapolation,
  guard: MeasurementLimit,
  propertyTimeBudget: MeasurementLimit,
): AnomalyBreach | null {
  const tokenGuard = extrapolation.tokens * guard.value;
  if (figures.tokens > tokenGuard) {
    return { figure: 'tokens', measured: figures.tokens, guard: tokenGuard, limit: guard };
  }
  const proofGuard = propertyTimeBudget.value;
  // A design with no Proof_Span never reached a proof, so this arm has nothing to compare.
  if (figures.proofSpanMs === null || figures.proofSpanMs <= proofGuard) {
    return null;
  }
  return {
    figure: 'proofSpanMs',
    measured: figures.proofSpanMs,
    guard: proofGuard,
    limit: propertyTimeBudget,
  };
}

/** Which population a run dispatches over. */
export type DispatchScope = 'cost-pilot' | 'full-population';

/** The designs one run may dispatch, and the scope that decided them. */
export interface DispatchPlan {
  readonly scope: DispatchScope;
  readonly designIds: readonly string[];
  /**
   * Configured Cost_Pilot ids the scored corpus does not hold.
   *
   * Reported rather than dropped: a pilot quietly running two of its three designs would set
   * the Per_Design_Extrapolation from a population nobody configured.
   */
  readonly unknownDesignIds: readonly string[];
}

/** What the dispatch plan is decided from; every field is already validated. */
export interface DispatchPlanInput {
  /** Every scored design, which is the full population of 46 (Req 5.15). */
  readonly scoredDesignIds: readonly string[];
  readonly costPilotDesignIds: readonly string[];
  readonly extrapolation: PerDesignExtrapolation | null;
}

/**
 * The designs this run may dispatch (Req 5.6, 5.15).
 *
 * THE GATE: with no recorded extrapolation the plan is the Cost_Pilot and nothing else, so a
 * config typo cannot start an unbounded run. The pilot's ids are intersected with the scored
 * corpus rather than trusted, because a design the corpus does not hold could not be measured
 * anyway and would read in the record as a design that failed.
 */
export function dispatchPlanFor(input: DispatchPlanInput): DispatchPlan {
  if (input.extrapolation === null) {
    const known = (id: string): boolean => input.scoredDesignIds.includes(id);
    return {
      scope: 'cost-pilot',
      designIds: input.costPilotDesignIds.filter(known),
      unknownDesignIds: input.costPilotDesignIds.filter((id) => !known(id)),
    };
  }
  return {
    scope: 'full-population',
    designIds: input.scoredDesignIds,
    unknownDesignIds: [],
  };
}

// -- Paths ------------------------------------------------------------------

/**
 * The repository root, derived from the corpus module's own anchor.
 *
 * `EVAL_CORPUS_ROOT` is `<repoRoot>/.eval-corpus` and already resolves correctly from both the
 * source tree and the build output, so taking its parent reuses that one decision.
 */
function repositoryRoot(): string {
  return dirname(EVAL_CORPUS_ROOT);
}

/** This measurement's own file, inside the directory named for the measurement (Req 9.10). */
export function measurementPath(outputDir: string): string {
  return join(outputDir, PROPERTY_ONLY_MEASUREMENT_FILENAME);
}

/** The short note the superseded run's directory carries (Req 9.11). */
export function supersessionNote(runName: string): string {
  return [
    `Superseded by the ${PROPERTY_ONLY_MEASUREMENT_KIND} measurement "${runName}".`,
    'The records in this directory are left in place as evidence of what was measured here.',
    '',
  ].join('\n');
}

/** The Credential_File this run reads its credential from, declared in exactly one place. */
function credentialFile(): string {
  return resolve(repositoryRoot(), DEFAULT_CREDENTIAL_FILE);
}

/** One UTF-8 file, or `null` where it cannot be read, which is the port's contract. */
async function readTextFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // An unreadable Credential_File is a typed absence rather than an error, and the rejection
    // is dropped because it can quote the file.
    return null;
  }
}

/**
 * The ONE credential provider every transport in this run resolves through.
 *
 * The Credential_File alone, with no environment fallback, re-read per request so a token
 * refreshed mid-run needs no restart. One source for one credential.
 */
function credentialProvider(): SecretManagerPort {
  return new RefreshingSecretManager({ path: credentialFile(), readFile: readTextFileOrNull });
}

// -- Preflight --------------------------------------------------------------

/** Read and validate the config file, returning a preflight failure on any problem. */
async function loadConfig(configPath: string): Promise<PropertyOnlyConfig | PreflightFailure> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    return preflightFailure(
      'config-invalid',
      'the property-only config file could not be read',
      'pass an existing readable file with --config',
    );
  }
  if (text.length > MAX_CONFIG_BYTES) {
    return preflightFailure(
      'config-invalid',
      `the property-only config exceeds ${MAX_CONFIG_BYTES} bytes`,
      'shrink the config; this mode needs identity, models, a pilot selection, limits and caps',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return preflightFailure(
      'config-invalid',
      'the property-only config is not valid JSON',
      'fix the JSON syntax and re-run',
    );
  }
  const parsed = parsePropertyOnlyConfig(raw);
  return parsed.ok
    ? parsed.value
    : preflightFailure(
        'config-invalid',
        `the property-only config is invalid at ${parsed.error.field || '(root)'}: ${parsed.error.message}`,
        'correct that field and re-run',
      );
}

/** Whether a value is a preflight failure rather than the parsed config. */
function isFailure(value: PropertyOnlyConfig | PreflightFailure): value is PreflightFailure {
  return 'code' in value && 'fix' in value;
}

/**
 * Refuse an output directory that an End_To_End_Formal_Rate report reads (Req 9.9, 9.10).
 *
 * A directory holding a sweep results log IS an end-to-end run directory, and writing this
 * measurement into it would put a property-only figure where a reader of that run expects an
 * end-to-end one. Checked by presence rather than by naming convention, because the convention
 * is what a mistake would get wrong.
 */
export async function endToEndRunDirectoryRefusal(
  outputDir: string,
): Promise<PreflightFailure | null> {
  const log = await readTextFileOrNull(join(outputDir, RESULTS_LOG_FILENAME));
  return log === null
    ? null
    : preflightFailure(
        'output-unwritable',
        `${outputDir} already holds a ${RESULTS_LOG_FILENAME}, so it is an end-to-end run directory a Measurement_Report reads`,
        'point outputDir at a new directory named for this measurement and re-run',
      );
}

/**
 * Whether the credential RESOLVES. No network call, and that is a bounded decision.
 *
 * A credential the provider would refuse is not caught here: the Cost_Pilot is at most three
 * designs and is the only thing a first run can dispatch, so it is the bounded canary for an
 * expired token. An ABSENT credential is caught, because it makes every call fail for free.
 */
async function checkCredentialResolves(
  secretManager: SecretManagerPort,
): Promise<PreflightFailure | null> {
  const resolved = await secretManager.resolveSecret(providerCredentialRef(PROPERTY_ONLY_PROVIDER));
  return resolved.ok
    ? null
    : preflightFailure(
        'credential-missing',
        `no ${PROPERTY_ONLY_PROVIDER} credential is available, so every Property_Author call would fail`,
        `put the token in ${credentialFile()} and re-run; the file's whole trimmed contents are the credential, and no environment variable is consulted`,
      );
}

/** The caps build a legal Session_Budget, or the refusal naming what they got wrong. */
function checkCaps(config: PropertyOnlyConfig): PreflightFailure | null {
  const probe = makeSessionBudget(zeroedBudget(config));
  return probe.ok
    ? null
    : preflightFailure(
        'config-invalid',
        `the student caps are not a legal Session_Budget: ${probe.error.message}`,
        'correct caps and re-run',
      );
}

/**
 * Every refusal, in cost order, before anything is dispatched.
 *
 * The isolation rule is FIRST and the declared limits SECOND: both are free, and both are
 * refusals rather than warnings. No task that spends a token may run while the worker could
 * inherit a credential (Req 1.7), and a figure taken under a limit nobody declared is not a
 * measurement (Req 12.4).
 */
async function preflight(
  config: PropertyOnlyConfig,
  outputDir: string,
  secretManager: SecretManagerPort,
): Promise<PreflightFailure | PreparedRun> {
  const isolation = workerIsolationFailure(process.env);
  if (isolation !== null) {
    return preflightFailure(
      'toolchain-missing',
      `the Sentinel_Isolation_Test's rule does not hold on this host: ${isolation}`,
      'fix the Worker_Environment_Allowlist projection in app/tools/sandbox/worker-environment.ts and re-run app/test/worker-secret-isolation.integration.test.ts before spending a token',
    );
  }
  const limits = declaredLimitsOrRefuse();
  if (!limits.ok) {
    return preflightFailure(
      'config-invalid',
      `this measurement reads a limit the registry does not declare: ${limits.error.message}`,
      'declare that limit with its Limit_Reason in app/eval/measurement-limit.ts and re-run',
    );
  }
  const caps = checkCaps(config);
  if (caps !== null) {
    return caps;
  }
  const output = await endToEndRunDirectoryRefusal(outputDir);
  if (output !== null) {
    return output;
  }
  const credential = await checkCredentialResolves(secretManager);
  if (credential !== null) {
    return credential;
  }
  const corpus = await checkCorpus(new NodeCheckoutProbePort(), RTLLM_CHECKOUT_PATH);
  if (corpus !== null) {
    return corpus;
  }
  const toolchain = probeToolchainAvailability();
  if (!toolchain.available) {
    return toolchainFailure(toolchain.reason);
  }
  // Always paid for here: every verdict in this measurement is a formal one, so a host that
  // cannot make the composed proof invocation must refuse the whole run rather than record a
  // wall of `toolchain-unavailable` that reads like a measurement of the designs.
  const formal = checkFormalToolchain(true, probeFormalToolchainAvailability);
  return formal ?? { pythonBin: toolchain.pythonBin, limits: limits.value };
}

// -- The stack --------------------------------------------------------------

/** One design as this mode submits it: the Spec it is authored from, and the reference RTL. */
export interface PropertyOnlyDesign {
  readonly problem: EvalProblem;
  /** The UNMODIFIED golden reference, exactly as the corpus importer read it (Req 5.1). */
  readonly source: SourceFile;
}

/**
 * Everything one run was composed with; built once, shared by every design.
 *
 * EXPORTED AS THE SEAM `measureDesign` IS DRIVEN THROUGH, and composed only here: `buildStack`
 * remains the one producer, so nothing outside this file can hand the CLI a different oracle.
 * A test that cannot replace the oracle and the author cannot check what the path submits, and
 * what it submits is the whole content of Req 5.1 to 5.4.
 */
export interface PropertyOnlyStack {
  readonly config: PropertyOnlyConfig;
  readonly designs: ReadonlyMap<string, PropertyOnlyDesign>;
  readonly oracle: FormalOraclePort;
  readonly authorFor: (model: string) => PropertySetSource;
  readonly toolchain: ManifestToolchain;
  /** The shipped Property_Time_Budget, read from the registry rather than from the config. */
  readonly budgetMs: number;
  readonly now: () => number;
  readonly report: (line: string) => void;
}

/** A `SessionBudget` input from the config's caps, with zeroed consumption. */
function zeroedBudget(config: PropertyOnlyConfig): SessionBudget {
  return {
    sessionId: newUlid(),
    maxIterations: config.caps.maxIterations,
    maxTokens: config.caps.maxTokens,
    maxWallClockMs: config.caps.maxWallClockMs,
    maxCostCents: config.caps.maxCostCents,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  };
}

/**
 * A fresh metered budget for one design, so no design's spend bounds another's.
 *
 * Preflight already built a probe budget from these caps, so the throw is unreachable defensive
 * hardening rather than a path: a mis-measured session must stop the run rather than continue
 * against caps nobody checked.
 */
function freshBudget(config: PropertyOnlyConfig): MeteredSessionBudget {
  const built = makeSessionBudget(zeroedBudget(config));
  if (!built.ok) {
    throw new Error(`property-only budget construction failed: ${built.error.message}`);
  }
  return new MeteredSessionBudget(built.value);
}

/**
 * The Property_Author for one Authoring_Model, built through the ONE exported construction path.
 *
 * `propertyAuthorFor` is the path a student session's own author is built through, so the author
 * this measurement exercises cannot differ from the shipped one (Req 5.4). A fresh recorder per
 * call matches the loop runner's own per-sample recorder: one shared across a run would hold
 * every design's spans in memory.
 *
 * No price table is wired, and that is deliberate: this record carries token counts and wall
 * clock as provenance and no cost figure at all, so a price table here would buy nothing and
 * would be a second place a spend number could be read from.
 */
function authorFactory(config: PropertyOnlyConfig): (model: string) => PropertySetSource {
  const http = createFetchJsonHttpPort();
  const secretManager = credentialProvider();
  return (model: string): PropertySetSource => {
    const policy = singleModelEvalRoutingPolicy(model);
    const transport = createBedrockMantleTransport({
      http,
      config: {
        region: config.region,
        // Derived from the policy's own primary, so the when-unrouted default cannot contradict
        // the policy; the same belt and braces `../sweep/cli.ts` applies.
        defaultModelId: primarySelectionFor(policy, 'generation').modelId,
      },
    });
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence(), newUlid);
    const router = createModelRouter({
      secretManager,
      recorder,
      transports: { 'bedrock-mantle': transport },
      policy,
    });
    return propertyAuthorFor({ router, recorder, now: Date.now });
  };
}

// -- Reading one design -----------------------------------------------------

/** The five conditions behind a verdict; a proof's `evidence` holds them in admitting form. */
function conditionsOf(result: PropertyResult): ProofConditions {
  return result.verdict === 'proved' ? { ...result.evidence } : result.conditions;
}

/** One property's outcome as the record carries it (Req 5.18, 11.2, 11.3). */
function outcomeOf(result: PropertyResult | undefined): PropertyOnlyOutcome {
  if (result === undefined) {
    return {
      kind: 'not-measured',
      reason: 'the Formal_Oracle returned no result for this submitted property',
    };
  }
  const conditions = conditionsOf(result);
  if (result.verdict === 'could-not-verify') {
    return {
      kind: 'measured',
      conditions,
      verdict: 'could-not-verify',
      couldNotVerifyCause: result.cause,
      // Read off the result rather than assumed: a Solver_Cross_Check does run in this mode,
      // and its disagreement is one of several sources of `toolchain-unavailable`.
      crossCheckDisagreed: result.crossCheckDisagreed,
    };
  }
  return {
    kind: 'measured',
    conditions,
    verdict: result.verdict,
    couldNotVerifyCause: null,
    crossCheckDisagreed: false,
  };
}

/** Every submitted property carried as Not_Measured, with the one reason that applies. */
function notMeasuredResults(
  properties: readonly FormalProperty[],
  reason: string,
): readonly PropertyOnlyPropertyResult[] {
  return properties.map((property) => ({
    propertyId: property.id,
    outcome: { kind: 'not-measured', reason },
  }));
}

/** Each submitted property paired with its own result, by submission index. */
function propertyResultsOf(
  properties: readonly FormalProperty[],
  results: readonly PropertyResult[],
): readonly PropertyOnlyPropertyResult[] {
  return properties.map((property, index) => ({
    propertyId: property.id,
    outcome: outcomeOf(results[index]),
  }));
}

/**
 * The cause the pre-pass refused with, or `null` where it did not refuse (Req 5.17).
 *
 * Read from the RESULTS rather than from `resetContract` alone, because the refusal's cause is
 * what the record carries and a derived-false contract names none. A refusal applies to the
 * whole set, so the first result carrying one is the run's answer.
 */
function prepassRefusalCauseOf(outcome: FormalOutcome): CouldNotVerifyCause | null {
  for (const result of outcome.results) {
    if (result.verdict === 'could-not-verify' && PREPASS_REFUSAL_CAUSES.includes(result.cause)) {
      return result.cause;
    }
  }
  return null;
}

/** What the Property_Author produced for one design, or the reason nothing was submitted. */
type AuthoredSet =
  | { readonly ok: true; readonly set: FormalPropertySet }
  | { readonly ok: false; readonly reason: string };

/** Author one design's Property_Set from its Spec alone, charging the design's own budget. */
async function authoredSetOf(
  author: PropertySetSource,
  design: PropertyOnlyDesign,
  budget: MeteredSessionBudget,
): Promise<AuthoredSet> {
  try {
    return { ok: true, set: await author.propertySetFor(design.problem.spec, budget) };
  } catch {
    // Dropped rather than surfaced: a provider or author rejection can quote the prompt.
    return { ok: false, reason: 'the Property_Author call threw, so no Property_Set was produced' };
  }
}

/** Decide one authored set against the unmodified reference, or say why no verdict exists. */
async function provenOutcomeOf(
  stack: PropertyOnlyStack,
  design: PropertyOnlyDesign,
  properties: readonly FormalProperty[],
): Promise<FormalOutcome | null> {
  try {
    return await stack.oracle.proveSet({
      designSource: design.source,
      designInterface: design.problem.spec.moduleInterface,
      properties,
      budgetMs: stack.budgetMs,
    });
  } catch {
    // Dropped rather than surfaced: an adapter rejection can quote the design source.
    return null;
  }
}

/**
 * The proof of one authored set, timed on its own so the guard reads the span its budget bounds.
 *
 * A set that was never authored reached no proof, so its Proof_Span is absent rather than 0.
 */
async function timedOutcomeOf(
  stack: PropertyOnlyStack,
  design: PropertyOnlyDesign,
  authored: AuthoredSet,
  properties: readonly FormalProperty[],
): Promise<{ readonly outcome: FormalOutcome | null; readonly proofSpanMs: number | null }> {
  if (!authored.ok) {
    return { outcome: null, proofSpanMs: null };
  }
  const startedAt = stack.now();
  const outcome = await provenOutcomeOf(stack, design, properties);
  return { outcome, proofSpanMs: stack.now() - startedAt };
}

/**
 * Measure one design under one Authoring_Model: author first, then decide (design.md C7).
 *
 * Every arm records the same provenance - the measured token counts, the measured wall clock,
 * the toolchain that decided the verdicts, and the Formal_Oracle_Version - so a design that
 * produced no verdict is still attributable to the model that authored it (Req 5.12, 5.14, 8.5).
 */
export async function measureDesign(
  stack: PropertyOnlyStack,
  model: string,
  design: PropertyOnlyDesign,
): Promise<PropertyOnlyDesignResult> {
  const budget = freshBudget(stack.config);
  const startedAt = stack.now();
  const authored = await authoredSetOf(stack.authorFor(model), design, budget);
  const properties = authored.ok ? authored.set.properties : [];
  const { outcome, proofSpanMs } = await timedOutcomeOf(stack, design, authored, properties);
  const refusalCause = outcome === null ? null : prepassRefusalCauseOf(outcome);
  const consumed = budget.consumed();
  return {
    designId: design.problem.id,
    authoringModel: model,
    // A design is in the Refused_Population exactly when the pre-pass refused it. A design no
    // oracle decided at all is `admitted`: nothing refused it, and the report's denominator
    // already excludes an admitted design carrying no measured property (Req 5.16).
    population: refusalCause === null ? 'admitted' : 'refused',
    prepassRefusalCause: refusalCause,
    properties:
      outcome === null
        ? notMeasuredResults(properties, noOutcomeReason(authored))
        : propertyResultsOf(properties, outcome.results),
    unexpressedCriteria: authored.ok ? authored.set.unexpressedCriteria : [],
    promptTokens: consumed.promptTokens,
    completionTokens: consumed.completionTokens,
    elapsedMs: stack.now() - startedAt,
    proofSpanMs,
    toolchain: stack.toolchain,
    formalOracleVersion: FORMAL_ORACLE_VERSION,
  };
}

/** Why a design reached no Formal_Outcome: the author produced nothing, or the oracle threw. */
function noOutcomeReason(authored: AuthoredSet): string {
  return authored.ok
    ? 'the Formal_Oracle invocation threw, so no verdict is traceable to it'
    : authored.reason;
}

// -- The run ----------------------------------------------------------------

/** One finished run: its record, and the guard breach that stopped it where there was one. */
interface PropertyOnlyRun {
  readonly measurement: PropertyOnlyMeasurement;
  readonly breach: AnomalyBreach | null;
}

/** The figures the Anomaly_Guard reads off one recorded design result. */
function figuresOf(result: PropertyOnlyDesignResult): DesignFigures {
  return {
    tokens: result.promptTokens + result.completionTokens,
    proofSpanMs: result.proofSpanMs,
  };
}

/**
 * Dispatch the plan, model by model, stopping on the first Anomaly_Guard breach.
 *
 * Model-outer so a stopped run leaves the earlier model's population complete rather than
 * leaving both partial, which is what makes the stopped record still readable per model.
 */
async function dispatch(
  stack: PropertyOnlyStack,
  plan: DispatchPlan,
  extrapolation: PerDesignExtrapolation | null,
  limits: RunLimits,
): Promise<{
  readonly results: readonly PropertyOnlyDesignResult[];
  readonly breach: AnomalyBreach | null;
}> {
  const results: PropertyOnlyDesignResult[] = [];
  for (const model of stack.config.authoringModels) {
    for (const designId of plan.designIds) {
      const design = stack.designs.get(designId);
      if (design === undefined) {
        continue;
      }
      const result = await measureDesign(stack, model, design);
      results.push(result);
      stack.report(
        `${model} ${designId}: ${result.population}, ${result.properties.length} property(ies), ${result.elapsedMs} ms`,
      );
      const breach =
        extrapolation === null
          ? null
          : anomalyBreachOf(
              figuresOf(result),
              extrapolation,
              limits.anomalyGuard,
              limits.propertyTimeBudget,
            );
      if (breach !== null) {
        return { results, breach };
      }
    }
  }
  return { results, breach: null };
}

/** The lines that report a finished run, including the Anomaly_Guard's own statement. */
function runReportLines(run: PropertyOnlyRun, plan: DispatchPlan): readonly string[] {
  const results = run.measurement.results;
  const models = new Set(results.map((result) => result.authoringModel));
  const scope =
    plan.scope === 'cost-pilot'
      ? `Cost_Pilot over ${plan.designIds.length} design(s); no design outside it was dispatched because no Per_Design_Extrapolation was recorded`
      : `full population of ${RTLLM_SCORED_DESIGN_COUNT} scored design(s)`;
  const breach = run.breach;
  return [
    '',
    `run ${run.measurement.runName}: ${scope}`,
    `recorded ${results.length} design result(s) over ${models.size} Authoring_Model(s)`,
    ...(breach === null
      ? []
      : [
          `STOPPED: a design's measured ${breach.figure} of ${breach.measured} exceeded the Anomaly_Guard of ${breach.guard}`,
          `         (${breach.limit.name} = ${breach.limit.value} ${breach.limit.unit}, reason ${breach.limit.reason})`,
          '         This is a suspected defect IN THE RUN; the figure is not a measurement of any',
          '         Authoring_Model.',
        ]),
  ];
}

/** Everything preflight established, ready to compose a run from. */
interface PreparedRun {
  readonly pythonBin: string;
  readonly limits: RunLimits;
}

/** Every scored design that has a reference, keyed by design id, read from the pinned corpus. */
async function importDesigns(): Promise<ReadonlyMap<string, PropertyOnlyDesign>> {
  const corpus = scoredRtllmCorpus(
    await importRtllmCorpus(
      new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
      localTimingDerivation(),
    ),
  );
  const designs = new Map<string, PropertyOnlyDesign>();
  for (const problem of corpus.problems) {
    const reference = corpus.references.get(problem.id);
    if (reference !== undefined) {
      designs.set(problem.id, { problem, source: reference.rtl });
    }
  }
  return designs;
}

/**
 * Compose the one stack every design is measured through.
 *
 * ONE retention store, handed to BOTH the runtime and the oracle: the runtime fills it after the
 * worker finishes and before the workspace goes, and the oracle reads its own JSON report back
 * out of it, so a reference cannot resolve to different bytes depending on who asked.
 */
function buildStack(
  config: PropertyOnlyConfig,
  prepared: PreparedRun,
  designs: ReadonlyMap<string, PropertyOnlyDesign>,
  report: (line: string) => void,
): PropertyOnlyStack {
  const artifacts = new BoundedArtifactRetention();
  const sandboxRuntime = new LocalWorkerRuntime(prepared.pythonBin, undefined, artifacts);
  const { cpu, memMb, procs, diskMb } = config.limits;
  return {
    config,
    designs,
    oracle: new YosysSmtBmcFormalOracle({
      toolRunner: new SandboxToolRunner(sandboxRuntime),
      artifacts,
      caps: { cpu, memMb, procs, diskMb },
      now: Date.now,
    }),
    authorFor: authorFactory(config),
    toolchain: probeToolchainVersions(prepared.pythonBin),
    budgetMs: prepared.limits.propertyTimeBudget.value,
    now: Date.now,
    report,
  };
}

/** Compose the stack once preflight has passed, and run the plan the pilot gate allows. */
async function execute(
  config: PropertyOnlyConfig,
  outputDir: string,
  prepared: PreparedRun,
): Promise<PropertyOnlyCliResult> {
  const report = (line: string): void => {
    console.log(line);
  };
  const designs = await importDesigns();
  const stack = buildStack(config, prepared, designs, report);
  const extrapolation = await recordedExtrapolation(config);
  const plan = dispatchPlanFor({
    scoredDesignIds: [...designs.keys()],
    costPilotDesignIds: config.costPilotDesignIds,
    extrapolation,
  });
  if (plan.unknownDesignIds.length > 0 || plan.designIds.length === 0) {
    return {
      exitCode: 1,
      lines: [
        'eval property-only: the configured population is not the one that would be dispatched,',
        `so nothing was dispatched. Unknown design id(s): ${plan.unknownDesignIds.join(', ') || 'none'};`,
        `dispatchable design(s): ${plan.designIds.length}.`,
        'correct costPilotDesignIds against the scored corpus and re-run',
      ],
    };
  }
  report(
    `dispatching the ${plan.scope} over ${plan.designIds.length} design(s) and ${config.authoringModels.length} Authoring_Model(s)`,
  );
  const dispatched = await dispatch(stack, plan, extrapolation, prepared.limits);
  const run: PropertyOnlyRun = {
    measurement: {
      schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
      runName: config.runName,
      measurementKind: PROPERTY_ONLY_MEASUREMENT_KIND,
      omittedStudentPathSteps: OMITTED_STUDENT_PATH_STEPS,
      results: dispatched.results,
      limits: recordedLimitsFor(plan.scope, prepared.limits.all),
    },
    breach: dispatched.breach,
  };
  const reportLines = renderPropertyOnlyReport(run.measurement);
  await persist(outputDir, run, reportLines);
  return {
    exitCode: exitStatusOf(run),
    lines: [...runReportLines(run, plan), '', ...reportLines],
  };
}

/** The Per_Design_Extrapolation an earlier measurement records, or `null` (Req 5.6). */
async function recordedExtrapolation(
  config: PropertyOnlyConfig,
): Promise<PerDesignExtrapolation | null> {
  if (config.extrapolationFrom === null) {
    return null;
  }
  const path = measurementPath(resolve(repositoryRoot(), config.extrapolationFrom));
  const decoded = decodePropertyOnlyMeasurement(await readTextFileOrNull(path));
  // An unreadable or undecodable earlier measurement records NO extrapolation, which confines
  // this run to the Cost_Pilot. The conservative direction: the alternative is dispatching the
  // full population against a figure nobody could read.
  return decoded === null ? null : perDesignExtrapolationOf(decoded);
}

/** The run's exit status: a guard stop is a 2 so a wrapper can tell it from a refusal. */
function exitStatusOf(run: PropertyOnlyRun): 0 | 1 | 2 {
  if (run.breach !== null) {
    return 2;
  }
  return run.measurement.results.length > 0 ? 0 : 1;
}

/**
 * Write the record, its report, and the supersession note.
 *
 * A failed supersession note never fails the run: the measurement is the evidence and the note
 * is a pointer to it, so losing the pointer must not lose the record.
 */
async function persist(
  outputDir: string,
  run: PropertyOnlyRun,
  reportLines: readonly string[],
): Promise<void> {
  await ensureDirectory(outputDir);
  await writeFile(
    measurementPath(outputDir),
    `${encodePropertyOnlyMeasurement(run.measurement)}\n`,
    'utf8',
  );
  await writeFile(
    join(outputDir, PROPERTY_ONLY_REPORT_FILENAME),
    `${reportLines.join('\n')}\n`,
    'utf8',
  );
  if (run.measurement.results.length === 0) {
    // A measurement that recorded nothing has superseded nothing, so it leaves no note.
    return;
  }
  try {
    await writeFile(
      join(resolve(repositoryRoot(), SUPERSEDED_RUN_DIR), SUPERSESSION_NOTE_FILENAME),
      supersessionNote(run.measurement.runName),
      'utf8',
    );
  } catch {
    // Dropped rather than surfaced: the path is reported by the caller's own lines, and the
    // superseded run's records are untouched either way.
  }
}

/** Injectable seams for the run entry, so a test drives it without the real host. */
export interface RunPropertyOnlyOptions {
  /** Credential source; defaults to the one Credential_File-backed provider. */
  readonly secretManager?: SecretManagerPort;
}

/**
 * Validate, preflight, and run one property-only measurement.
 *
 * Returns its lines rather than printing them, so the whole decision path is unit-testable;
 * per-design progress is printed as it happens, because a multi-hour run must not be silent.
 */
export async function runPropertyOnly(
  configPath: string,
  options: RunPropertyOnlyOptions = {},
): Promise<PropertyOnlyCliResult> {
  const secretManager = options.secretManager ?? credentialProvider();
  const config = await loadConfig(configPath);
  if (isFailure(config)) {
    return { exitCode: 1, lines: renderPreflightFailure(config) };
  }
  const outputDir = resolve(repositoryRoot(), config.outputDir);
  const checked = await preflight(config, outputDir, secretManager);
  if ('code' in checked) {
    return { exitCode: 1, lines: renderPreflightFailure(checked) };
  }
  return execute(config, outputDir, checked);
}

/** Dispatch one parsed command. */
export async function runPropertyOnlyCli(argv: readonly string[]): Promise<PropertyOnlyCliResult> {
  const command = parsePropertyOnlyArgs(argv);
  return command.kind === 'usage'
    ? { exitCode: 1, lines: [`eval property-only: ${command.problem}`, ...PROPERTY_ONLY_USAGE] }
    : runPropertyOnly(command.configPath);
}

/** Wire the real defaults, print the report, and set the exit code. */
async function main(): Promise<void> {
  const result = await runPropertyOnlyCli(process.argv.slice(2));
  for (const line of result.lines) {
    console.log(line);
  }
  process.exitCode = result.exitCode;
}

// Run only when executed directly, not when imported by a test. Any unexpected throw fails the
// run safely with a sanitized message and a non-zero exit.
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`eval property-only failed: ${message}`);
    process.exitCode = 1;
  });
}
