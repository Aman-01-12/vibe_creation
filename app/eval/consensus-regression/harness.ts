// The Benchmark_Regression_Suite driver (C20; Req 16.1, 16.3, 16.6, 17.2).
//
// Drives the Consensus_Gate's own `runSession` over the retained RTLLM corpus with the
// golden testbench as the Independent_Judge of whatever design a Session delivers. The
// dependency direction is eval -> agent, the same direction the existing replay already
// uses and the only one that keeps Requirement 17 criterion 2: nothing in `@app/agent` or
// `@app/tools` imports this module or anything beneath it.
//
// `app/agent/consensus/session.ts` decides correctness; this file only wires a per-problem
// Session to the judge and folds this spec's five version constants into the suite's own
// configuration identity, so a bumped constant can never silently compare a new run against
// an old baseline (Req 16.3). The gate table that turns these raw samples into a pass/fail
// verdict is task 16.2's `gate.ts`.

import {
  AUTHORING_CONTRACT_VERSION,
  CONSENSUS_POOL_SIZE,
  REFERENCE_MODEL_PROMPT_VERSION,
  SIGNATURE_REDUCTION_VERSION,
  SESSION_TOKEN_BUDGET,
  makeBudgetLedger,
  runSession,
  type ConsensusSessionDeps,
  type DesignGenerator,
  type GeneratedDesign,
  type GeneratedReferenceModel,
  type ReferenceModelGenerator,
  type RunMatrix,
  type SessionOutcome,
} from '@app/agent';
import type { Spec, Ulid } from '@app/core';
import { CONSENSUS_HARNESS_VERSION } from '@app/tools';
import type { ResourceLimits, RoleDeclaration, SimulatorAdapter, SourceFile } from '@app/tools';

import type { GoldenJudge, RecordedGoldenVerdict } from '../golden-judge.js';
import type { ReferenceDesign } from '../corpus/corpus-types.js';
import { STRUCTURAL_GATE_EXCLUSION_IDS } from './structural-gate-exclusions.js';

/**
 * `adder_pipe_64bit`'s golden testbench overrides two parameters the Spec never names, and
 * `asyn_fifo` has 1 correct design in 32 for a knowledge-bundle reason specified elsewhere
 * (Req 16.6). A unit test, not a comment: `isExcludedFromConsensusRegression` is what the
 * driver actually filters on.
 */
export const CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS: readonly string[] = Object.freeze([
  'rtllm/arithmetic/adder_pipe_64bit',
  'rtllm/memory/asyn_fifo',
]);

/**
 * Whether `problemId` is excluded from the Benchmark_Regression_Suite, either for Req 16.6's
 * own two reasons or because the real Structural_Gate refuses it (Req 12.7).
 */
export function isExcludedFromConsensusRegression(problemId: string): boolean {
  return (
    CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS.includes(problemId) ||
    STRUCTURAL_GATE_EXCLUSION_IDS.includes(problemId)
  );
}

/** This spec's five version constants, folded into the suite's own configuration identity. */
export interface ConsensusRegressionConfigIdentity {
  readonly consensusHarnessVersion: number;
  readonly consensusPoolSize: number;
  readonly referenceModelPromptVersion: number;
  readonly authoringContractVersion: number;
  readonly signatureReductionVersion: number;
}

/**
 * The suite's current configuration identity, read live from the running code - never a
 * parameter - so a manifest or a resume check can never carry a stale or fabricated value
 * (Req 16.3).
 */
export function consensusRegressionConfigIdentity(): ConsensusRegressionConfigIdentity {
  return {
    consensusHarnessVersion: CONSENSUS_HARNESS_VERSION,
    consensusPoolSize: CONSENSUS_POOL_SIZE,
    referenceModelPromptVersion: REFERENCE_MODEL_PROMPT_VERSION,
    authoringContractVersion: AUTHORING_CONTRACT_VERSION,
    signatureReductionVersion: SIGNATURE_REDUCTION_VERSION,
  };
}

/** One retained corpus problem the suite drives a Session over. */
export interface ConsensusRegressionProblem {
  readonly problemId: string;
  readonly spec: Spec;
}

/** The Independent_Judge seam plus the Session dependencies the suite drives (Req 16.1). */
export interface ConsensusRegressionDeps {
  readonly sessionDeps: ConsensusSessionDeps;
  readonly goldenJudge: GoldenJudge;
  /** The sandbox caps the Independent_Judge's own run executes under (Req 15.6). */
  readonly limits: ResourceLimits;
  /** The problem's known-correct reference RTL, for scoring a generated testbench's own correctness. */
  readonly references: ReadonlyMap<string, ReferenceDesign>;
}

/**
 * One pool member's measured correctness: `null` when no run could establish it (unjudged, or
 * a run that errored for a reason unrelated to correctness).
 */
export interface GroundTruthEntry {
  readonly id: Ulid;
  readonly wrong: boolean | null;
}

/**
 * One generated Reference_Model's own source and roles, persisted beside its sample (Req 8).
 *
 * No rendered Consensus_Harness text (Req 8.4): that text is deterministic product output
 * reproducible from the Declared_Interface, the Role_Declaration and the recorded
 * configuration identity, so it is not worth the diagnostic weight of recording it again.
 * No Candidate_Design source either (Req 8.7), so reading this record cannot become a
 * design-blindness breach for a later reader.
 */
export interface ReferenceModelRecord {
  readonly testbenchId: Ulid;
  readonly family: string;
  readonly referenceModelPromptVersion: number;
  readonly resetStateBody: string;
  readonly nextStateBody: string;
  readonly expectBody: string;
  readonly roles: RoleDeclaration;
}

/** `testbench.draft`, read from memory rather than re-parsed (Req 8.5). */
function referenceModelRecordOf(testbench: GeneratedReferenceModel): ReferenceModelRecord {
  return {
    testbenchId: testbench.testbenchId,
    family: `${testbench.family.provider}/${testbench.family.lineage}`,
    referenceModelPromptVersion: REFERENCE_MODEL_PROMPT_VERSION,
    resetStateBody: testbench.draft.resetStateBody,
    nextStateBody: testbench.draft.nextStateBody,
    expectBody: testbench.draft.expectBody,
    roles: testbench.draft.roles,
  };
}

/** One problem's Session outcome, plus the Independent_Judge's verdict on whatever it delivered. */
export interface ConsensusRegressionSample {
  readonly problemId: string;
  readonly outcome: SessionOutcome;
  /** `null` when the Session delivered nothing for the judge to score. */
  readonly goldenVerdict: RecordedGoldenVerdict | null;
  /** Golden-judge verdict for every design named by a failing Run_Matrix pair, by designId. */
  readonly designGroundTruth: readonly GroundTruthEntry[];
  /** Reference-RTL verdict for every testbench named by a failing Run_Matrix pair, by testbenchId. */
  readonly testbenchGroundTruth: readonly GroundTruthEntry[];
}

/** The whole suite's raw per-problem samples; `gate.ts` reduces these to the gated figures. */
export interface ConsensusRegressionRunReport {
  readonly configIdentity: ConsensusRegressionConfigIdentity;
  readonly samples: readonly ConsensusRegressionSample[];
  readonly excludedProblemIds: readonly string[];
}

/**
 * Wraps a `DesignGenerator`, recording each generated design's RTL by its own id.
 *
 * The Session only returns design IDS in a Verified_Outcome's `deliveredDesignIds`
 * (Req 1.2); the RTL the Independent_Judge needs to score has to be captured as it is
 * generated, which is the one place in the whole flow it exists.
 */
class RecordingDesignGenerator implements DesignGenerator {
  readonly #inner: DesignGenerator;
  readonly #rtlByDesignId = new Map<Ulid, readonly SourceFile[]>();

  constructor(inner: DesignGenerator) {
    this.#inner = inner;
  }

  async generate(
    spec: Spec,
    ledger: Parameters<DesignGenerator['generate']>[1],
  ): Promise<GeneratedDesign> {
    const design = await this.#inner.generate(spec, ledger);
    this.#rtlByDesignId.set(design.designId, design.rtl);
    return design;
  }

  rtlByDesignId(): ReadonlyMap<Ulid, readonly SourceFile[]> {
    return this.#rtlByDesignId;
  }
}

/**
 * The delivered design's own RTL, or `null` when the outcome delivered nothing to judge.
 *
 * Pure: reads only `outcome`'s own `deliveredDesignIds` and the id-keyed map the recording
 * generator built, so this is independently testable with a hand-built outcome fixture and
 * no Session machinery at all.
 */
export function rtlOfDeliveredDesign(
  outcome: SessionOutcome,
  rtlByDesignId: ReadonlyMap<Ulid, readonly SourceFile[]>,
): readonly SourceFile[] | null {
  if (outcome.kind !== 'verified') {
    return null;
  }
  const deliveredDesignId = outcome.deliveredDesignIds[0];
  if (deliveredDesignId === undefined) {
    return null;
  }
  return rtlByDesignId.get(deliveredDesignId) ?? null;
}

/** Submit one delivered design's RTL to the Independent_Judge, or skip when there is none to judge. */
async function judgeDelivered(
  problemId: string,
  outcome: SessionOutcome,
  rtlByDesignId: ReadonlyMap<Ulid, readonly SourceFile[]>,
  deps: ConsensusRegressionDeps,
): Promise<RecordedGoldenVerdict | null> {
  const rtl = rtlOfDeliveredDesign(outcome, rtlByDesignId);
  if (rtl === null || rtl.length === 0) {
    return null;
  }
  return deps.goldenJudge.judge({
    problemId,
    rtl: rtl.map((file) => file.contents).join('\n'),
    limits: deps.limits,
  });
}

/** Mirrors `RecordingDesignGenerator` for the testbench pool, needed for ground-truth scoring. */
class RecordingReferenceModelGenerator implements ReferenceModelGenerator {
  readonly #inner: ReferenceModelGenerator;
  readonly #byTestbenchId = new Map<Ulid, GeneratedReferenceModel>();

  constructor(inner: ReferenceModelGenerator) {
    this.#inner = inner;
  }

  async generate(
    spec: Spec,
    ledger: Parameters<ReferenceModelGenerator['generate']>[1],
  ): Promise<GeneratedReferenceModel> {
    const testbench = await this.#inner.generate(spec, ledger);
    this.#byTestbenchId.set(testbench.testbenchId, testbench);
    return testbench;
  }

  byTestbenchId(): ReadonlyMap<Ulid, GeneratedReferenceModel> {
    return this.#byTestbenchId;
  }
}

/** The distinct ids on either side of every failing (non-passing) Run_Matrix cell. */
function failingPairIds(matrix: RunMatrix): { designIds: Set<Ulid>; testbenchIds: Set<Ulid> } {
  const designIds = new Set<Ulid>();
  const testbenchIds = new Set<Ulid>();
  for (const cell of matrix.cells) {
    if (cell.passed !== true) {
      designIds.add(cell.designId);
      testbenchIds.add(cell.testbenchId);
    }
  }
  return { designIds, testbenchIds };
}

/**
 * Golden-judge every design named by a failing pair (ground truth for Attribution_Accuracy's
 * RTL side), skipping ids the recording generator never produced RTL for (an unadmitted or
 * never-generated design has nothing to submit).
 */
async function designGroundTruthOf(
  problemId: string,
  designIds: ReadonlySet<Ulid>,
  rtlByDesignId: ReadonlyMap<Ulid, readonly SourceFile[]>,
  deps: ConsensusRegressionDeps,
): Promise<readonly GroundTruthEntry[]> {
  const entries: GroundTruthEntry[] = [];
  for (const designId of designIds) {
    const rtl = rtlByDesignId.get(designId);
    if (rtl === undefined || rtl.length === 0) {
      entries.push({ id: designId, wrong: null });
      continue;
    }
    const verdict = await deps.goldenJudge.judge({
      problemId,
      rtl: rtl.map((file) => file.contents).join('\n'),
      limits: deps.limits,
    });
    entries.push({ id: designId, wrong: verdictWrong(verdict) });
  }
  return entries;
}

/** Whether a `RecordedGoldenVerdict` establishes the candidate as wrong, right, or neither. */
function verdictWrong(verdict: RecordedGoldenVerdict | null): boolean | null {
  if (verdict === null || verdict.kind === 'did-not-build' || verdict.kind === 'no-output') {
    return null;
  }
  return verdict.kind === 'failed';
}

/**
 * Run every testbench named by a failing pair against the problem's own reference RTL (ground
 * truth for Attribution_Accuracy's TESTBENCH side): a testbench is wrong if it fails the design
 * RTLLM calls correct. Reuses `deps.sessionDeps.simulator`, the SAME oracle the Session itself
 * ran under, so a disagreement is never explained by a second simulator reading the output
 * differently.
 */
async function testbenchGroundTruthOf(
  testbenchIds: ReadonlySet<Ulid>,
  byTestbenchId: ReadonlyMap<Ulid, GeneratedReferenceModel>,
  reference: ReferenceDesign | undefined,
  simulator: SimulatorAdapter,
  limits: ResourceLimits,
): Promise<readonly GroundTruthEntry[]> {
  const entries: GroundTruthEntry[] = [];
  for (const testbenchId of testbenchIds) {
    const testbench = byTestbenchId.get(testbenchId);
    if (testbench === undefined || reference === undefined) {
      entries.push({ id: testbenchId, wrong: null });
      continue;
    }
    const verdict = await simulator.simulate(
      [reference.rtl, testbench.referenceModel],
      testbench.harness,
      limits,
    );
    entries.push({
      id: testbenchId,
      wrong: verdict.verdict === 'error' ? null : verdict.verdict !== 'pass',
    });
  }
  return entries;
}

/** One `runConsensusRegressionSample` call's two independent outputs (Req 8.1). */
export interface ConsensusRegressionSampleResult {
  readonly sample: ConsensusRegressionSample;
  /** Every Reference_Model_Testbench this Session generated, by testbenchId (Req 8.1, 8.5). */
  readonly referenceModelRecords: readonly ReferenceModelRecord[];
}

/**
 * Run one Session over one retained corpus problem and judge whatever it delivered
 * (Req 16.1).
 *
 * Zero model tokens are spent here beyond `runSession`'s own: this function wraps the
 * design generator only to record RTL, and the judge call is the model-free, deterministic
 * one `GoldenJudge` already is. `referenceModelRecords` is returned alongside the sample,
 * never nested inside it (Req 8.6's own reasoning): the caller persists the sample first and
 * the records second, in their own `try`, so a record-write failure can never cost the
 * already-paid sample.
 */
export async function runConsensusRegressionSample(
  problem: ConsensusRegressionProblem,
  deps: ConsensusRegressionDeps,
): Promise<ConsensusRegressionSampleResult> {
  const recordingDesigns = new RecordingDesignGenerator(deps.sessionDeps.generateDesign);
  const recordingTestbenches = new RecordingReferenceModelGenerator(
    deps.sessionDeps.generateReferenceModel,
  );
  const sessionDeps: ConsensusSessionDeps = {
    ...deps.sessionDeps,
    generateDesign: recordingDesigns,
    generateReferenceModel: recordingTestbenches,
  };
  const budget = makeBudgetLedger(SESSION_TOKEN_BUDGET, 'session-token-budget');
  const outcome = await runSession(problem.spec, budget, sessionDeps);
  const rtlByDesignId = recordingDesigns.rtlByDesignId();
  const goldenVerdict = await judgeDelivered(problem.problemId, outcome, rtlByDesignId, deps);

  const matrix = outcome.record.runMatrix;
  const { designIds, testbenchIds } = failingPairIds(matrix);
  const designGroundTruth = await designGroundTruthOf(
    problem.problemId,
    designIds,
    rtlByDesignId,
    deps,
  );
  const testbenchGroundTruth = await testbenchGroundTruthOf(
    testbenchIds,
    recordingTestbenches.byTestbenchId(),
    deps.references.get(problem.problemId),
    deps.sessionDeps.simulator,
    deps.limits,
  );

  const referenceModelRecords = [...recordingTestbenches.byTestbenchId().values()].map(
    referenceModelRecordOf,
  );

  return {
    sample: {
      problemId: problem.problemId,
      outcome,
      goldenVerdict,
      designGroundTruth,
      testbenchGroundTruth,
    },
    referenceModelRecords,
  };
}

/**
 * Drive the Benchmark_Regression_Suite over `problems`, excluding the two Req 16.6 designs,
 * in order (Req 16.1).
 *
 * Sequential by design, the same discipline the existing `EvalHarness` applies to its own
 * subset: a Session already runs its own Run_Matrix at bounded concurrency, and running
 * several Sessions concurrently on top of that would multiply sandbox load for no measured
 * benefit at the corpus's own size.
 */
export async function runConsensusRegressionSuite(
  problems: readonly ConsensusRegressionProblem[],
  deps: ConsensusRegressionDeps,
): Promise<ConsensusRegressionRunReport> {
  const included = problems.filter(
    (problem) => !isExcludedFromConsensusRegression(problem.problemId),
  );
  const samples: ConsensusRegressionSample[] = [];
  for (const problem of included) {
    const result = await runConsensusRegressionSample(problem, deps);
    samples.push(result.sample);
  }
  return {
    configIdentity: consensusRegressionConfigIdentity(),
    samples,
    excludedProblemIds: [
      ...CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS,
      ...STRUCTURAL_GATE_EXCLUSION_IDS,
    ],
  };
}
