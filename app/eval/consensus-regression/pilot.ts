// Task 18.1: the reference-model pilot over the Pilot_Design_Set (Req 5.8, 16.3). PARKED and paid.
//
// Drives the C7 pieces directly against each design's own reference RTL: a failure is always the
// Reference_Model's, never a candidate's. Every reply is saved, so `--replay <runDir>` re-judges a
// run with zero model calls. Operator script, not a shipped component.

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReferenceModelInput,
  checkAuthoringContract,
  createBedrockMantleTransport,
  createFetchJsonHttpPort,
  createModelRouter,
  DEFAULT_CREDENTIAL_FILE,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  MODEL_TASKS,
  parseReferenceModelDraft,
  primarySelectionFor,
  REFERENCE_MODEL_PROMPT_VERSION,
  RefreshingSecretManager,
  singleProviderRoutingPolicy,
  TraceActionRecorder,
  type ExcludedConstruct,
  type ModelRouter,
  type ReferenceModelDraft,
} from '@app/agent';
import {
  makeSessionBudget,
  makeTimingContract,
  newUlid,
  type ModuleInterface,
  type Spec,
} from '@app/core';
import {
  ENABLE_FRAME_PERIOD,
  HOLD_FRAME_PERIOD,
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  referenceModelFunctionHeaders,
  renderConsensusHarness,
  SAMPLE_BUDGET,
  SandboxToolRunner,
  STROBE_PERIOD,
  type InputRole,
  type ResourceLimits,
  type RoleDeclaration,
  type SimulatorAdapter,
  type SourceFile,
} from '@app/tools';

import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import { findWorkerPython } from '../sweep/host-facts.js';

const PILOT_PROBLEM_IDS = [
  'rtllm/control/counter_12',
  'rtllm/miscellaneous/traffic_light',
  'rtllm/arithmetic/accu',
] as const;

/** Enough draws that a 50% share is a measurement rather than a coin flip. */
const SAMPLES_PER_DESIGN = 8;
/** The four Model_Arms every campaign since grounding-ab-v1 has run; the gate's pool spans them. */
const MODEL_IDS = ['moonshotai.kimi-k2.5', 'zai.glm-5', 'zai.glm-4.7', 'deepseek.v3.2'] as const;
const REFMODEL_PATH = 'refmodel.v';
// Takes the shared SAMPLE_BUDGET (2048) rather than its own, which raises the pilot's rendered
// budget from the 64 it used before this task 32-fold. Every figure measured from here on is a
// 2048-step figure and is not comparable with the recorded 64-step probe table (C7).
const WATCHDOG_BUDGET_NS = 2_000_000;
const MAX_DIAGNOSTIC_LINES = 5;
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** Which of the three model-written bodies a compile diagnostic or a mismatch points at. */
export type BodyName = 'ece_reset_state' | 'ece_next_state' | 'ece_expect';

const BODY_ORDER: readonly BodyName[] = ['ece_reset_state', 'ece_next_state', 'ece_expect'];

/** Where one draw stopped; `pass` is the only success. */
export type PilotOutcome =
  'router' | 'parse' | 'authoring-contract' | 'compile' | 'run-error' | 'mismatch' | 'pass';

/** The first CHECK FAIL line of a run, located by step and port. */
export interface FirstMismatch {
  readonly step: number;
  readonly port: string;
  readonly expected: string;
  readonly got: string;
}

export interface PilotSample {
  readonly modelId: string;
  readonly problemId: string;
  readonly sampleIndex: number;
  readonly outcome: PilotOutcome;
  readonly excludedConstructs: readonly ExcludedConstruct[];
  /** Bodies a compile diagnostic named; empty unless `outcome === 'compile'`. */
  readonly bodiesNamedByCompiler: readonly BodyName[];
  /** First diagnostic lines, bounded; tool output, never model text. */
  readonly diagnostics: readonly string[];
  readonly firstMismatch: FirstMismatch | null;
  /** Steps with at least one failing CHECK, out of the steps the run sampled. */
  readonly failingSteps: number;
  readonly sampledSteps: number;
  readonly tokensUsed: number;
}

/** One rendered Reference_Model file, plus the 1-based line range each body occupies. */
interface RenderedRefModel {
  readonly file: SourceFile;
  readonly bodyLines: Readonly<Record<BodyName, { readonly first: number; readonly last: number }>>;
}

/** Wrap the four bodies in the harness's own headers, recording where each body landed. */
export function renderRefModel(
  moduleInterface: ModuleInterface,
  draft: ReferenceModelDraft,
): RenderedRefModel {
  const headers = referenceModelFunctionHeaders(moduleInterface);
  const parts: readonly [BodyName, string, string][] = [
    ['ece_reset_state', headers.resetState, draft.resetStateBody],
    ['ece_next_state', headers.nextState, draft.nextStateBody],
    ['ece_expect', headers.expect, draft.expectBody],
  ];
  const lines: string[] = [];
  const bodyLines = {} as Record<BodyName, { first: number; last: number }>;
  for (const [name, header, body] of parts) {
    lines.push(header);
    const bodyText = body.split('\n');
    bodyLines[name] = { first: lines.length + 1, last: lines.length + bodyText.length };
    lines.push(...bodyText, 'endfunction');
  }
  return { file: { path: REFMODEL_PATH, contents: `${lines.join('\n')}\n` }, bodyLines };
}

/** The bodies an iverilog diagnostic names by `refmodel.v:<line>:`, in body order. */
export function bodiesNamedBy(stderr: string, rendered: RenderedRefModel): readonly BodyName[] {
  const named = new Set<BodyName>();
  for (const match of stderr.matchAll(/refmodel\.v:(\d+):/gu)) {
    const line = Number(match[1]);
    for (const [name, range] of Object.entries(rendered.bodyLines) as [
      BodyName,
      { first: number; last: number },
    ][]) {
      if (line >= range.first && line <= range.last) {
        named.add(name);
      }
    }
  }
  return BODY_ORDER.filter((n) => named.has(n));
}

/** The first failing CHECK, and how many sampled steps had any failing CHECK. */
export function locateMismatches(
  stdout: string,
  nonce: string,
): {
  readonly first: FirstMismatch | null;
  readonly failingSteps: number;
  readonly sampledSteps: number;
} {
  const failPattern = new RegExp(`^CHECK ${nonce}_(\\w+) FAIL: expected (\\S+), got (\\S+)`, 'u');
  const samplePrefix = `ECE_SAMPLE ${nonce} `;
  let step = 0;
  let stepFailed = false;
  let failingSteps = 0;
  let first: FirstMismatch | null = null;
  for (const line of stdout.split('\n')) {
    const fail = failPattern.exec(line.trim());
    if (fail !== null) {
      stepFailed = true;
      first ??= { step, port: fail[1] ?? '', expected: fail[2] ?? '', got: fail[3] ?? '' };
    } else if (line.startsWith(samplePrefix)) {
      failingSteps += stepFailed ? 1 : 0;
      stepFailed = false;
      step += 1;
    }
  }
  return { first, failingSteps, sampledSteps: step };
}

/** Bounded first non-empty lines of tool output. */
function firstLines(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_DIAGNOSTIC_LINES);
}

/** Every pilot output port is synchronous (`always @(posedge clk ...)`), so registered is the fact. */
function registeredContract(moduleInterface: ModuleInterface) {
  const built = makeTimingContract(
    moduleInterface,
    moduleInterface.ports
      .filter((port) => port.direction === 'output')
      .map((port) => ({ portName: port.name, timing: 'registered' as const })),
  );
  if (!built.ok) {
    throw new Error(`pilot defect: ${built.error.code}`);
  }
  return built.value;
}

type Judged = Omit<PilotSample, 'modelId' | 'problemId' | 'sampleIndex' | 'tokensUsed'>;

const NOT_RUN = {
  excludedConstructs: [],
  bodiesNamedByCompiler: [],
  diagnostics: [],
  firstMismatch: null,
  failingSteps: 0,
  sampledSteps: 0,
} as const;

/** Parse, contract-check, render, and simulate one saved reply. Makes no model call. */
export async function judgeReply(
  spec: Spec,
  referenceRtl: SourceFile,
  reply: string,
  simulator: SimulatorAdapter,
): Promise<Judged> {
  const parsed = parseReferenceModelDraft(reply, spec.moduleInterface);
  if (!parsed.ok) {
    return { ...NOT_RUN, outcome: 'parse', diagnostics: [parsed.error.reason] };
  }
  const checked = checkAuthoringContract(parsed.value);
  if (checked.kind === 'rejected') {
    return { ...NOT_RUN, outcome: 'authoring-contract', excludedConstructs: checked.excluded };
  }
  const rendered = renderRefModel(spec.moduleInterface, checked.bodies);
  const nonce = `p${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
  const harness = renderConsensusHarness({
    moduleInterface: spec.moduleInterface,
    timingContract: registeredContract(spec.moduleInterface),
    nonce,
    watchdogBudgetNs: WATCHDOG_BUDGET_NS,
    sampleBudget: SAMPLE_BUDGET,
    roles: parsed.value.roles,
  });
  if (!harness.ok) {
    throw new Error(`pilot defect: harness render failed: ${harness.error.code}`);
  }
  const verdict = await simulator.simulate([referenceRtl, rendered.file], harness.value, LIMITS);
  if (verdict.failureCause === 'build-failed') {
    return {
      ...NOT_RUN,
      outcome: 'compile',
      bodiesNamedByCompiler: bodiesNamedBy(verdict.stderr, rendered),
      diagnostics: firstLines(verdict.stderr),
    };
  }
  const located = locateMismatches(verdict.stdout, nonce);
  if (verdict.verdict === 'pass') {
    return { ...NOT_RUN, outcome: 'pass', sampledSteps: located.sampledSteps };
  }
  if (located.first === null) {
    return {
      ...NOT_RUN,
      outcome: 'run-error',
      diagnostics: [verdict.failureCause, ...firstLines(verdict.stderr)],
      sampledSteps: located.sampledSteps,
    };
  }
  return {
    ...NOT_RUN,
    outcome: 'mismatch',
    firstMismatch: located.first,
    failingSteps: located.failingSteps,
    sampledSteps: located.sampledSteps,
  };
}

// C16: the re-baselined mutation kill-rate comparison (Req 6.3, 6.4, 6.5, 6.7, 6.8). Free - both
// arms are measured by the same probe over the same mutant set, through `judgeReply` above,
// which takes no budget argument of its own and always renders at the shared SAMPLE_BUDGET.
// `compareKillRates` still takes a budget per arm, so the withhold branch below has something
// to be exercised against in a test, even though one constant feeding both arms means the two
// can never actually differ in production.

/**
 * The one member a declaration is measured against. Typed as `InputRole` rather than left a bare
 * string, so this single site fails to compile if `data` ever leaves the Role_Vocabulary.
 */
const DATA_ROLE: InputRole = 'data';

/**
 * Req 6.3: whether this design's Total_Role_Declaration obliges the kill-rate comparison, which
 * it does once any input port carries a role other than `data`.
 *
 * Testing for a Strobe or a Held_Input instead would drop `multi_16bit`'s all-`enable`
 * declaration - the one declaration this feature is judged on - out of the guardrail. Testing
 * "not a Legacy_Role_Set" would drop it too, since `{data, enable}` IS that set.
 */
export function comparisonIsObliged(roles: RoleDeclaration): boolean {
  return roles.some((entry) => entry.role !== DATA_ROLE);
}

/** One arm's kill rate (a 0-1 fraction) at the step budget it was measured at. */
export interface KillRateReading {
  readonly killRate: number;
  readonly sampleBudget: number;
}

/** A reading stamped with the live SAMPLE_BUDGET, rather than a budget copied in by hand. */
export function sharedBudgetReading(killRate: number): KillRateReading {
  return { killRate, sampleBudget: SAMPLE_BUDGET };
}

/** Req 6.8: the two arms were measured at different step budgets, so no comparison is drawn. */
export interface WithheldKillRateComparison {
  readonly kind: 'withheld';
  readonly probed: KillRateReading;
  readonly baseline: KillRateReading;
}

/** Req 6.3, 6.4: both arms shared one Sample_Budget, so the comparison is meaningful. */
export interface MutationKillRateComparison {
  readonly kind: 'compared';
  readonly sampleBudget: number;
  readonly probed: KillRateReading;
  readonly baseline: KillRateReading;
  /** Req 6.4: whether the probed design's kill rate met or exceeded its re-measured baseline. */
  readonly passed: boolean;
}

export type KillRateComparisonReport = WithheldKillRateComparison | MutationKillRateComparison;

/**
 * Compare a probed design's mutation kill rate against its own all-`data` kill rate,
 * re-measured by the same probe over the same mutant set. Withholds the comparison (Req 6.8)
 * when the two readings carry different budgets, rather than ever printing a comparison
 * across two regimes.
 */
export function compareKillRates(
  probed: KillRateReading,
  baseline: KillRateReading,
): KillRateComparisonReport {
  if (probed.sampleBudget !== baseline.sampleBudget) {
    return { kind: 'withheld', probed, baseline };
  }
  return {
    kind: 'compared',
    sampleBudget: probed.sampleBudget,
    probed,
    baseline,
    passed: probed.killRate >= baseline.killRate,
  };
}

/**
 * Task 12.5's free hand-crafted reading (Req 6.3, 6.4): `compareKillRates` over the four
 * `.eval-runs/handwritten-refmodels/probe-stimulus-transaction.mjs` designs, each probed with
 * one hand-picked Strobe/Held_Input role against that same design's all-`data` kill rate,
 * re-measured by the identical probe over the identical 24-mutant set, both at the shared
 * `SAMPLE_BUDGET` of 2048 this constant reads live. This is the free exploratory reading, not
 * the paid Acceptance_Measurement of task 14.4, which draws its own role declaration from a
 * real Reference_Model rather than a role picked by hand.
 *
 * Role chosen per design, from reading each reply's own `ece_next_state` body:
 * - `multi_16bit`: `start` (`in[0]`) is `strobe`, `ain`/`bin` are `hold`. `start` gates the
 *   17-cycle shift-add multiply and `ain`/`bin` are the operands it consumes across those
 *   cycles - the canonical pattern this feature was designed around.
 * - `accu`: `valid_in` is `strobe`. It gates whether a new 4-sample accumulation BEGINS,
 *   the same one-cycle-to-start role `start` plays in `multi_16bit`.
 * - `RAM`: `write_data` is `hold`, as its main data input (no multi-step operation to gate).
 * - `sequence_detector`: `data_in` is `hold`, its only port.
 *
 * Measured result (24 mutants, SAMPLE_BUDGET 2048, both arms through the same `judgeReply`):
 *
 * | design             | baseline (all-`data`) | probed | criterion 6.4 |
 * |---------------------|-----------------------|--------|---------------|
 * | `multi_16bit`       | 62.5%                 | 29.2%  | FAIL          |
 * | `accu`              | 70.8%                 | 70.8%  | PASS (tie)    |
 * | `RAM`               | 100.0%                | 100.0% | PASS, but see caveat below |
 * | `sequence_detector` | 80.0%                 | 20.0%  | FAIL          |
 *
 * `multi_16bit` and `sequence_detector` fail criterion 6.4's bar: a Strobe pulses a port for
 * one step per `STROBE_PERIOD` and zero the rest, which is vacuous for a gate that the design
 * needs held HIGH for several cycles to complete an operation, and a Hold on a serial FSM's
 * only input drives it to a fixed point in one or two cycles and keeps it there for the rest
 * of the window, so the states reachable only by an alternating input are barely visited. Both
 * are real findings about the mechanism, not a probe defect; see the two `chipAgent/_inbox`
 * gotcha notes this task filed for the full account.
 *
 * `RAM`'s golden (unmutated) run no longer passes `judgeReply` at SAMPLE_BUDGET 2048, on the
 * literal already-committed all-`data` reply, with no role change involved: its hand-written
 * `ece_reset_state` assumes memory resets to zero, and the real RTL leaves an unwritten word at
 * Verilog's X state, diverging once the longer run reads an address never written. Both arms
 * read 100% because the model already disagrees with the correct golden behavior before any
 * mutation is applied, so this pair is not a meaningful measurement of mutation sensitivity -
 * `multi_16bit` is the one design of this feature's two judged designs this reading actually
 * speaks to. `accu` is the one design where every port's chosen role left the kill rate
 * unchanged.
 *
 * Task 16.1's validating probe (Req 6.3, 6.4, 8.9, 8.10), same script, same 24-mutant set, same
 * shared `SAMPLE_BUDGET` of 2048, with each design's all-`data` arm re-measured in the same run.
 * Each row declares ONE port with ONE role and leaves every other input port `data`, so the two
 * arms differ in exactly one role declaration. The role per design is read off that design's
 * GOLDEN RTL rather than off the reply, which is what separates this reading from 12.5's:
 *
 * | design            | role tested      | baseline (all-`data`) | probed | Enable_Frame_Period |
 * |-------------------|------------------|-----------------------|--------|---------------------|
 * | `multi_16bit`     | `start`=`enable` | 62.5%                 | 83.3%  | 20                  |
 * | `serial2parallel` | `din_valid`=`enable` | NOT TAKEN         | -      | -                   |
 * | `square_wave`     | `freq`=`hold`    | NOT TAKEN             | -      | -                   |
 *
 * `multi_16bit` clears criterion 6.4's bar by 20.8 points, and its baseline arm re-measured to
 * the same 62.5% task 12.5 recorded. Its golden (unmutated) run passes on BOTH arms, so unlike
 * `RAM` above this pair does measure mutation sensitivity. `start` as `enable` is asserted on
 * every step of a 20-step frame but one, which is the sustained level `else if (!start) i <= 5'd0;`
 * needs, where 12.5's one-step-per-67 `strobe` abandoned the multiply at 29.2%. This is the
 * measurement criterion 8.9's retarget to the `enable` member rests on.
 *
 * The decision record's contingency - sweep the Enable_Frame_Period over 20, 24 and 32 should
 * this land at or below baseline - did not fire and was not run, so the constant is untouched
 * and 19 asserted steps per frame are empirically enough for the roughly 18 this design needs.
 *
 * The two witness rows could not be measured: neither `serial2parallel` nor `square_wave` has a
 * hand-written reference reply under `.eval-runs/handwritten-refmodels/replies/`, and authoring
 * one is a different task's work and a different kind of artifact. Criterion 8.10's `hold` target
 * therefore still rests on the golden-RTL reading (`count == freq - 1` against a running counter)
 * rather than on a kill-rate measurement, and the `enable` class is confirmed on one design, not
 * two. Both rows are reported as not taken rather than estimated.
 */

/** Req 6.7's four recorded figures: 64-step readings, not comparable with either arm here. */
export const HISTORICAL_KILL_RATE_FIGURES: readonly {
  readonly designId: string;
  readonly killRatePercent: number;
}[] = [
  { designId: 'multi_16bit', killRatePercent: 66.7 },
  { designId: 'accu', killRatePercent: 70.8 },
  { designId: 'RAM', killRatePercent: 47.8 },
  { designId: 'sequence_detector', killRatePercent: 80.0 },
];

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Req 6.7: the four historical figures, stated as 64-step and not comparable here. */
function renderHistoricalKillRateFigures(): string {
  const figures = HISTORICAL_KILL_RATE_FIGURES.map(
    (figure) => `${figure.killRatePercent.toFixed(1)}% for ${figure.designId}`,
  ).join(', ');
  return (
    `The previously recorded figures of ${figures} were measured at a 64-step probe budget ` +
    'and are not comparable with either arm of this comparison.'
  );
}

/** One arm's reading as `<percent> (<budget> steps)`, for the withheld report. */
function renderReading(reading: KillRateReading): string {
  return `${formatPercent(reading.killRate)} (${String(reading.sampleBudget)} steps)`;
}

/**
 * Req 6.5: below baseline, name the constant responsible rather than leaving it inferred - the
 * Strobe_Period, the Hold_Frame_Period, the Enable_Frame_Period, the Distinct_Hold_Value_Count
 * and the Sample_Budget both readings share. The Enable_Frame_Period is the constant responsible
 * for a below-baseline `enable` reading, and at one released step per frame it is the first
 * suspect for one. The count is the regime's own ceiling (30 whole Hold_Windows at the live
 * SAMPLE_BUDGET and HOLD_FRAME_PERIOD), a fact about the Session both arms ran under, not a
 * figure threaded through either arm's `KillRateReading`.
 */
function renderBelowBaselineDiagnostic(sampleBudget: number): string {
  const distinctHoldValueCount = Math.floor(SAMPLE_BUDGET / HOLD_FRAME_PERIOD);
  return (
    `Below baseline: the regime both readings share is a Strobe_Period of ` +
    `${String(STROBE_PERIOD)}, a Hold_Frame_Period of ${String(HOLD_FRAME_PERIOD)}, an ` +
    `Enable_Frame_Period of ${String(ENABLE_FRAME_PERIOD)}, a Distinct_Hold_Value_Count ` +
    `bounded by ${String(distinctHoldValueCount)}, and a Sample_Budget of ` +
    `${String(sampleBudget)} steps.`
  );
}

/**
 * Render one design's kill-rate comparison as plain text (Req 6.3, 6.4, 6.5, 6.7, 6.8): the
 * Sample_Budget statement with the pass/fail verdict, the below-baseline regime diagnostic when
 * the probed reading fails, or both withheld readings with the budget each was taken at,
 * followed by the four historical figures on every call regardless of outcome.
 */
export function renderKillRateComparison(
  designId: string,
  report: KillRateComparisonReport,
): string {
  const verdictLine =
    report.kind === 'withheld'
      ? `${designId}: comparison withheld - the two arms were measured at different step ` +
        `budgets (probed ${renderReading(report.probed)}, baseline ` +
        `${renderReading(report.baseline)}).`
      : `${designId}: ${report.passed ? 'PASS' : 'FAIL'} - probed ` +
        `${formatPercent(report.probed.killRate)} against re-measured all-\`data\` baseline ` +
        `${formatPercent(report.baseline.killRate)}, both at a Sample_Budget of ` +
        `${String(report.sampleBudget)} steps.`;
  const lines = [verdictLine];
  if (report.kind === 'compared' && !report.passed) {
    lines.push(renderBelowBaselineDiagnostic(report.sampleBudget));
  }
  lines.push(renderHistoricalKillRateFigures());
  return lines.join('\n');
}

function buildRouter(modelId: string): ModelRouter {
  const taskModel = Object.fromEntries(MODEL_TASKS.map((task) => [task, modelId])) as Record<
    (typeof MODEL_TASKS)[number],
    string
  >;
  const policy = singleProviderRoutingPolicy({ provider: 'bedrock-mantle', taskModel });
  const transport = createBedrockMantleTransport({
    http: createFetchJsonHttpPort(),
    config: {
      region: process.env.BEDROCK_REGION ?? 'us-east-1',
      defaultModelId: primarySelectionFor(policy, 'generation').modelId,
      temperature: 0,
      prices: {},
    },
  });
  return createModelRouter({
    secretManager: new RefreshingSecretManager({
      path: join(REPOSITORY_ROOT, DEFAULT_CREDENTIAL_FILE),
      readFile: async (path: string) => {
        try {
          return await readFile(path, 'utf8');
        } catch {
          return null;
        }
      },
    }),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence(), newUlid),
    transports: { 'bedrock-mantle': transport },
    policy,
  });
}

/** A one-call budget; the single-entry chain means one attempt is the whole call. */
function oneCallBudget(): InMemorySessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 1,
    maxTokens: 50_000,
    maxWallClockMs: 300_000,
    maxCostCents: 10_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) {
    throw new Error('pilot budget construction must succeed');
  }
  return new InMemorySessionBudgetHandle(built.value);
}

function replyFilename(modelId: string, problemId: string, sampleIndex: number): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]/gu, '_');
  return `${safe(modelId)}__${safe(problemId)}__${String(sampleIndex)}.txt`;
}

/** Per-design tally over the pooled arms (what Req 5.8 reads), then per arm. */
function summarize(samples: readonly PilotSample[]) {
  return {
    pooled: tally(samples),
    byModel: Object.fromEntries(
      MODEL_IDS.map((modelId) => [modelId, tally(samples.filter((s) => s.modelId === modelId))]),
    ),
  };
}

/** Per-design tally of every outcome, the compiler-named bodies, and token spend. */
function tally(samples: readonly PilotSample[]) {
  return PILOT_PROBLEM_IDS.map((problemId) => {
    const mine = samples.filter((sample) => sample.problemId === problemId);
    const outcomes: Record<string, number> = {};
    const compileBodies: Record<string, number> = {};
    for (const sample of mine) {
      outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
      for (const body of sample.bodiesNamedByCompiler) {
        compileBodies[body] = (compileBodies[body] ?? 0) + 1;
      }
    }
    const passCount = outcomes.pass ?? 0;
    return {
      problemId,
      passCount,
      sampleCount: mine.length,
      passShare: mine.length === 0 ? 0 : passCount / mine.length,
      outcomes,
      compileBodies,
      totalTokens: mine.reduce((sum, sample) => sum + sample.tokensUsed, 0),
    };
  });
}

interface PilotInputs {
  readonly spec: Spec;
  readonly referenceRtl: SourceFile;
}

async function loadPilotInputs(): Promise<ReadonlyMap<string, PilotInputs>> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const inputs = new Map<string, PilotInputs>();
  for (const problemId of PILOT_PROBLEM_IDS) {
    const problem = corpus.problems.find((candidate) => candidate.id === problemId);
    const reference = corpus.references.get(problemId);
    if (problem === undefined || reference === undefined) {
      throw new Error(`pilot defect: ${problemId} is not in the imported corpus`);
    }
    inputs.set(problemId, { spec: problem.spec, referenceRtl: reference.rtl });
  }
  return inputs;
}

function realSimulator(): SimulatorAdapter {
  const pythonBin = findWorkerPython();
  if (pythonBin === null) {
    throw new Error('pilot requires a Python interpreter that can import tool_runner_worker');
  }
  return new IcarusSimulatorAdapter(new SandboxToolRunner(new LocalWorkerRuntime(pythonBin)));
}

interface ArmRun {
  readonly modelId: string;
  readonly inputs: ReadonlyMap<string, PilotInputs>;
  readonly simulator: SimulatorAdapter;
  readonly outDir: string;
  readonly replayDir: string | null;
  readonly tokensByFile: ReadonlyMap<string, number>;
}

/** One reply: drawn from the model (paid) or read back from a saved run (free). */
async function replyFor(
  arm: ArmRun,
  router: ModelRouter | null,
  spec: Spec,
  filename: string,
): Promise<
  { readonly reply: string; readonly tokensUsed: number } | { readonly routerError: string }
> {
  if (router === null) {
    const reply = await readFile(join(arm.replayDir ?? arm.outDir, 'replies', filename), 'utf8');
    return { reply, tokensUsed: arm.tokensByFile.get(filename) ?? 0 };
  }
  const invoked = await router.invoke(
    'generation',
    buildReferenceModelInput(spec),
    oneCallBudget(),
  );
  if (!invoked.ok) {
    return { routerError: invoked.error.code };
  }
  await writeFile(join(arm.outDir, 'replies', filename), invoked.value.outputText, 'utf8');
  return { reply: invoked.value.outputText, tokensUsed: invoked.value.tokensUsed };
}

/** Every draw of one Model_Arm, in design then sample order. */
async function runArm(arm: ArmRun): Promise<readonly PilotSample[]> {
  const router = arm.replayDir === null ? buildRouter(arm.modelId) : null;
  const samples: PilotSample[] = [];
  for (const problemId of PILOT_PROBLEM_IDS) {
    const { spec, referenceRtl } = arm.inputs.get(problemId) as PilotInputs;
    for (let sampleIndex = 0; sampleIndex < SAMPLES_PER_DESIGN; sampleIndex += 1) {
      const where = { modelId: arm.modelId, problemId, sampleIndex };
      const drawn = await replyFor(
        arm,
        router,
        spec,
        replyFilename(arm.modelId, problemId, sampleIndex),
      );
      if ('routerError' in drawn) {
        samples.push({
          ...NOT_RUN,
          ...where,
          outcome: 'router',
          tokensUsed: 0,
          diagnostics: [drawn.routerError],
        });
        console.log(
          `${arm.modelId} ${problemId} #${String(sampleIndex)}: router ${drawn.routerError}`,
        );
        continue;
      }
      const judged = await judgeReply(spec, referenceRtl, drawn.reply, arm.simulator);
      samples.push({ ...judged, ...where, tokensUsed: drawn.tokensUsed });
      const detail =
        judged.firstMismatch === null
          ? judged.bodiesNamedByCompiler.join(',')
          : `step ${String(judged.firstMismatch.step)} ${judged.firstMismatch.port} exp ${judged.firstMismatch.expected} got ${judged.firstMismatch.got}`;
      console.log(
        `${arm.modelId} ${problemId} #${String(sampleIndex)}: ${judged.outcome} ${detail}`,
      );
    }
  }
  return samples;
}

/** Draw and judge every arm concurrently (paid), or re-judge saved replies from `replayDir` (free). */
async function runPilot(outDir: string, replayDir: string | null): Promise<void> {
  const inputs = await loadPilotInputs();
  const simulator = realSimulator();
  await mkdir(join(outDir, 'replies'), { recursive: true });
  const tokensByFile =
    replayDir === null ? new Map<string, number>() : await savedTokens(replayDir);
  const perArm = await Promise.all(
    MODEL_IDS.map((modelId) =>
      runArm({ modelId, inputs, simulator, outDir, replayDir, tokensByFile }),
    ),
  );
  const samples = perArm.flat();
  const summary = {
    promptVersion: REFERENCE_MODEL_PROMPT_VERSION,
    modelIds: MODEL_IDS,
    replayedFrom: replayDir,
    designs: summarize(samples),
  };
  await writeFile(join(outDir, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`, 'utf8');
  await writeFile(join(outDir, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

/** Token counts recorded by the run being replayed, keyed by reply filename. */
async function savedTokens(runDir: string): Promise<ReadonlyMap<string, number>> {
  const raw = JSON.parse(await readFile(join(runDir, 'samples.json'), 'utf8')) as readonly {
    readonly modelId: string;
    readonly problemId: string;
    readonly sampleIndex: number;
    readonly tokensUsed: number;
  }[];
  const replies = new Set(await readdir(join(runDir, 'replies')));
  const tokens = new Map<string, number>();
  for (const sample of raw) {
    const filename = replyFilename(sample.modelId, sample.problemId, sample.sampleIndex);
    if (replies.has(filename)) {
      tokens.set(filename, sample.tokensUsed);
    }
  }
  return tokens;
}

async function main(): Promise<void> {
  const replayAt = process.argv.indexOf('--replay');
  const replayDir = replayAt === -1 ? null : resolve(process.argv[replayAt + 1] ?? '');
  const mode = replayDir === null ? 'pilot' : 'replay';
  const runName = `consensus-${mode}-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const outDir = join(REPOSITORY_ROOT, '.eval-runs', runName);
  await mkdir(outDir, { recursive: true });
  console.log(`consensus ${mode} (prompt v${String(REFERENCE_MODEL_PROMPT_VERSION)}): ${outDir}`);
  await runPilot(outDir, replayDir);
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`consensus pilot failed: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  });
}
