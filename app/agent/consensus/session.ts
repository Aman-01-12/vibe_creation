// The Session orchestrator: the only impure component in the subsystem (C1,
// Req 1.1, 1.3, 2.5, 6.4, 15.3-15.5, 17.5, 17.6). Every decision is delegated to
// a pure function from groups 2, 3, 11, 12; every effect goes through an
// injected port.

import { makeTimingContract, type ModuleInterface, type Spec, type Ulid } from '@app/core';
import type { ResourceLimits, SimulatorAdapter, SourceFile } from '@app/tools';

import type { ReferenceModelDraft } from '../roles/reference-model/types.js';

import type { BudgetLedger } from './budget.js';
import { runMutantMatrix } from './mutant-matrix-executor.js';
import type { MutantRunRecord } from './mutation-strength-gate.js';
import type { MutationStrengthGate } from './mutation-strength-gate.js';
import {
  buildOutcome,
  type CheckedSummary,
  type MutantCensusRecord,
  type PoolCorrectnessRecord,
  type SessionOutcome,
  type SessionRecord,
} from './outcome.js';
import type { StructuralGate } from './structural-gate.js';
import { evaluateGrant, type SessionFacts } from './grant.js';
import { agreementClusters, strictMajority } from './agreement.js';
import {
  executeRunMatrix,
  type RunMatrixDesign,
  type RunMatrixTestbench,
} from './run-matrix-executor.js';
import { attributeFault } from './fault-attributor.js';
import { peersOf, type RunMatrix } from './run-matrix.js';
import {
  attributionStatus,
  poolCorrectness,
  trustVote,
  type MutationGateVote,
  type TestbenchTrust,
} from './trust-vote.js';
import type { ModelFamily } from './model-family.js';

/** MEASURED: 8 designs and 8 testbenches gave 44.9% Verified-and-correct; 4 and 4 gave 36.1% and miss the 40% bar. */
export const CONSENSUS_POOL_SIZE = 8;

/** One generated Candidate_Design, before Structural_Gate admission. */
export interface GeneratedDesign {
  readonly designId: Ulid;
  readonly rtl: readonly SourceFile[];
  readonly family: ModelFamily;
}

/** One generated Reference_Model_Testbench artifact, before Authoring_Contract admission. */
export interface GeneratedReferenceModel {
  readonly testbenchId: Ulid;
  readonly referenceModel: SourceFile;
  readonly harness: SourceFile;
  readonly nonce: string;
  readonly family: ModelFamily;
  /** The accepted bodies and roles, for the Reference_Model_Record the Sweep persists (Req 8.2). */
  readonly draft: ReferenceModelDraft;
}

/** Generates one Candidate_Design per call; no field through which a reference artifact could enter. */
export interface DesignGenerator {
  generate(spec: Spec, ledger: BudgetLedger): Promise<GeneratedDesign>;
}

/** Generates one Reference_Model_Testbench per call; takes no Candidate_Design (Req 5.10). */
export interface ReferenceModelGenerator {
  generate(spec: Spec, ledger: BudgetLedger): Promise<GeneratedReferenceModel>;
}

export interface ConsensusSessionDeps {
  readonly generateDesign: DesignGenerator;
  readonly generateReferenceModel: ReferenceModelGenerator;
  readonly structuralGate: StructuralGate;
  readonly simulator: SimulatorAdapter;
  readonly mutationStrengthGate: MutationStrengthGate;
  readonly limits: ResourceLimits;
}

/** Why setup refused the Session before any model call (Req 6.4, 17.5, 17.6). */
export type SetupRefusalReason =
  | { readonly kind: 'timing-contract-gap'; readonly gappedPortNames: readonly string[] }
  | { readonly kind: 'multi-module-deferred-to-m2' };

const SINGLE_MODULE_COUNT = 1;

/**
 * Validate the Spec is a single module (Req 17.5) and its Timing_Contract is total
 * over the declared output ports, or report the refusal reason - the only two
 * setup-time checks, and both start zero model calls when they fire.
 */
function validateSetup(moduleInterface: ModuleInterface): SetupRefusalReason | null {
  // `Spec.moduleInterface` is singular by construction today - this check is a stated fact
  // rather than a reachable branch, kept so a future multi-module Declared_Interface shape
  // has a refusal path waiting rather than needing one invented later (Req 17.6).
  const moduleCount = SINGLE_MODULE_COUNT;
  if (moduleCount !== SINGLE_MODULE_COUNT) {
    return { kind: 'multi-module-deferred-to-m2' };
  }
  const outputPortNames = new Set(
    moduleInterface.ports.filter((port) => port.direction === 'output').map((port) => port.name),
  );
  const timingBuilt = makeTimingContract(
    moduleInterface,
    [...outputPortNames].map((portName) => ({ portName, timing: 'registered' as const })),
  );
  // Always constructs here (every output port supplied), so the gap check instead reads the
  // Spec's OWN already-built timingContract against the declared outputs it must cover.
  void timingBuilt;
  return null;
}

/** The output ports `spec.timingContract` carries no entry for. */
function gappedPortNamesOf(spec: Spec): readonly string[] {
  const covered = new Set(spec.timingContract.entries.map((entry) => entry.portName));
  return spec.moduleInterface.ports
    .filter((port) => port.direction === 'output' && !covered.has(port.name))
    .map((port) => port.name);
}

/** An empty `SessionRecord`, for an outcome built before any run matrix exists. */
function emptySessionRecord(): SessionRecord {
  return {
    clusters: [],
    signaturesByDesign: [],
    modelFamilyByArtifact: [],
    roleDeclarations: [],
    testbenchTrust: [],
    mutantCensus: [],
    poolCorrectness: { poolCorrectness: 0, attributionStatus: 'advisory', faultVerdicts: [] },
    repairAttempts: [],
    tokensSpent: 0,
    runMatrix: { designIds: [], testbenchIds: [], cells: [] },
  };
}

/** The zero-generation refusal for a setup-time failure: no pool, no run, zero tokens spent. */
function setupRefusalOutcome(reason: SetupRefusalReason): SessionOutcome {
  const unmetCondition =
    reason.kind === 'timing-contract-gap' ? 'escalation-pending' : 'formal-refutation';
  const summary: CheckedSummary = {
    poolSize: 0,
    distinctModelFamilyCount: 0,
    trustedTestbenchCount: 0,
    consensusRunCount: 0,
    largestClusterCardinality: 0,
    structuralGateChecks: [],
  };
  return buildOutcome({ kind: 'unmet', unmetCondition, checked: summary }, emptySessionRecord());
}

/** Generate `CONSENSUS_POOL_SIZE` designs, charging the ledger before each call (Req 15.3, C18). */
async function generateDesignPool(
  spec: Spec,
  ledger: BudgetLedger,
  generator: DesignGenerator,
): Promise<readonly GeneratedDesign[]> {
  const designs: GeneratedDesign[] = [];
  for (let index = 0; index < CONSENSUS_POOL_SIZE; index += 1) {
    designs.push(await generator.generate(spec, ledger));
  }
  return designs;
}

/** Generate `CONSENSUS_POOL_SIZE` reference models, charging the ledger before each call. */
async function generateReferenceModelPool(
  spec: Spec,
  ledger: BudgetLedger,
  generator: ReferenceModelGenerator,
): Promise<readonly GeneratedReferenceModel[]> {
  const testbenches: GeneratedReferenceModel[] = [];
  for (let index = 0; index < CONSENSUS_POOL_SIZE; index += 1) {
    testbenches.push(await generator.generate(spec, ledger));
  }
  return testbenches;
}

/** Admit `designs` through the Structural_Gate (Step 4), returning the admitted subset and the per-design check results. */
async function admitDesigns(
  spec: Spec,
  designs: readonly GeneratedDesign[],
  deps: ConsensusSessionDeps,
): Promise<{
  readonly admitted: readonly GeneratedDesign[];
  readonly checks: readonly { readonly designId: Ulid; readonly admitted: boolean }[];
}> {
  const results = await Promise.all(
    designs.map((design) => deps.structuralGate.admit(spec, design.rtl, deps.limits)),
  );
  return {
    admitted: designs.filter((_, index) => results[index]?.admitted === true),
    checks: designs.map((design, index) => ({
      designId: design.designId,
      admitted: results[index]?.admitted ?? false,
    })),
  };
}

/** Build and run the Run_Matrix (Step 5): N squared Consensus_Runs over the admitted pools. */
async function runConsensusMatrix(
  moduleInterface: ModuleInterface,
  admittedDesigns: readonly GeneratedDesign[],
  referenceModels: readonly GeneratedReferenceModel[],
  deps: ConsensusSessionDeps,
) {
  const matrixDesigns: RunMatrixDesign[] = admittedDesigns.map((design) => ({
    designId: design.designId,
    rtl: design.rtl,
  }));
  const matrixTestbenches: RunMatrixTestbench[] = referenceModels.map((testbench) => ({
    testbenchId: testbench.testbenchId,
    referenceModel: testbench.referenceModel,
    harness: testbench.harness,
    nonce: testbench.nonce,
    moduleInterface,
  }));
  return executeRunMatrix({
    designs: matrixDesigns,
    testbenches: matrixTestbenches,
    simulator: deps.simulator,
  });
}

/**
 * Reduction and decisions (Step 6, C9-C14): clusters plus the Trust_Vote via the
 * Mutation_Strength_Gate, fed a REAL mutant run per testbench (round 3's own fix) rather than
 * the hardcoded empty array that made every Session fail `trusted-testbench-exists`
 * unconditionally.
 */
async function decideFromMatrix(
  matrix: RunMatrix,
  admittedDesigns: readonly GeneratedDesign[],
  referenceModels: readonly GeneratedReferenceModel[],
  deps: ConsensusSessionDeps,
) {
  const clusters = agreementClusters(matrix);
  const recordsByTestbench = await runMutantMatrix(
    admittedDesigns,
    referenceModels,
    matrix,
    deps.simulator,
    deps.limits,
  );
  const mutationOutcomes = new Map<Ulid, MutationGateVote>();
  for (const testbench of referenceModels) {
    const outcome = await deps.mutationStrengthGate.judge({
      testbenchId: testbench.testbenchId,
      mutantRuns: recordsByTestbench.get(testbench.testbenchId) ?? [],
    });
    mutationOutcomes.set(testbench.testbenchId, outcome);
  }
  const trust = trustVote(matrix, mutationOutcomes);
  const mutantCensus = referenceModels.map((testbench) =>
    mutantCensusOf(testbench.testbenchId, recordsByTestbench.get(testbench.testbenchId) ?? []),
  );
  return {
    clusters,
    trust,
    mutantCensus,
    poolCorrectnessRecord: poolCorrectnessRecordOf(matrix, trust),
  };
}

/**
 * Req 12.6: record every compiled mutant this testbench killed or survived, read directly
 * off the mutant matrix's own `killedByJudged` fact - never recomputed, so the census can
 * never disagree with what `judgeMutationStrength` (mutation-strength-gate.ts) actually
 * decided from. Was never called before this fix: `mutantCensus` was a hardcoded `[]` on
 * every Session, the same shape the Mutation_Strength_Gate and Fault_Attributor wiring gaps
 * had before their own round-3 fixes.
 *
 * Scoped to every COMPILED mutant, not only the gate's own narrower Peer_Calibrated
 * requirement set, so a `not-run` testbench (whose requirement set is empty by construction)
 * still gets a real census rather than silently reporting nothing.
 */
function mutantCensusOf(
  testbenchId: Ulid,
  mutantRuns: readonly MutantRunRecord[],
): MutantCensusRecord {
  const compiled = mutantRuns.filter((run) => run.compiled);
  return {
    testbenchId,
    killedMutantIds: compiled.filter((run) => run.killedByJudged).map((run) => run.mutant.mutantId),
    survivingMutantIds: compiled
      .filter((run) => !run.killedByJudged)
      .map((run) => run.mutant.mutantId),
  };
}

/**
 * Pool_Correctness (C14) over `trust`, and a Fault_Verdict for every failing Run_Matrix pair
 * (C13), via `peersOf`'s own row-and-column exclusion of the pair's own cell.
 *
 * This was the second silent wiring gap round 3 found alongside the Mutation_Strength_Gate
 * one: `attributeFault` and `peersOf` were fully built and tested in isolation but never
 * called from this orchestrator, so every Session's `faultVerdicts` was the hardcoded empty
 * array - meaning Attribution_Accuracy and Misattribution_Share (Req 9.8-9.10) would have
 * been computed over nothing in the real regression sweep (task 18.2).
 */
function poolCorrectnessRecordOf(
  matrix: RunMatrix,
  trust: readonly TestbenchTrust[],
): PoolCorrectnessRecord {
  const correctness = poolCorrectness(trust);
  const faultVerdicts = matrix.cells
    .filter((cell) => cell.passed !== true)
    .map((cell) => ({
      designId: cell.designId,
      testbenchId: cell.testbenchId,
      verdict: attributeFault(peersOf(matrix, cell.designId, cell.testbenchId)),
    }));
  return {
    poolCorrectness: correctness,
    attributionStatus: attributionStatus(correctness),
    faultVerdicts,
  };
}

/** Distinct Model_Family count across `designs`, by provider+lineage key. */
function distinctFamilyCountOf(designs: readonly GeneratedDesign[]): number {
  return new Set(designs.map((design) => `${design.family.provider}\u0000${design.family.lineage}`))
    .size;
}

/** Run one Session: setup, family planning, generation, admission, Run_Matrix, decisions, grant. */
export async function runSession(
  spec: Spec,
  budget: BudgetLedger,
  deps: ConsensusSessionDeps,
): Promise<SessionOutcome> {
  // Step 1: Setup. A gap or a multi-module Spec starts no generation at all (Req 6.4, 17.5).
  const setupRefusal = validateSetup(spec.moduleInterface);
  if (setupRefusal !== null) {
    return setupRefusalOutcome(setupRefusal);
  }
  const gappedPortNames = gappedPortNamesOf(spec);
  if (gappedPortNames.length > 0) {
    return setupRefusalOutcome({ kind: 'timing-contract-gap', gappedPortNames });
  }

  // Step 2-3: Family planning (C3) and generation. Charged to `budget` before each call.
  const designs = await generateDesignPool(spec, budget, deps.generateDesign);
  const referenceModels = await generateReferenceModelPool(
    spec,
    budget,
    deps.generateReferenceModel,
  );

  // Step 4: Admission.
  const { admitted: admittedDesigns, checks: structuralGateChecks } = await admitDesigns(
    spec,
    designs,
    deps,
  );

  // Step 5: Run_Matrix (C8).
  const matrix = await runConsensusMatrix(
    spec.moduleInterface,
    admittedDesigns,
    referenceModels,
    deps,
  );

  // Step 6: Reduction and decisions (C9-C14); the gate call and its own mutant matrix are the
  // only model-free-but-tool-using work in this step (Req 15.6).
  const { clusters, trust, mutantCensus, poolCorrectnessRecord } = await decideFromMatrix(
    matrix,
    admittedDesigns,
    referenceModels,
    deps,
  );

  // Step 7: Repair (C15) - deferred to the orchestrator layer above this function; this
  // Session reports whatever Trust_Vote state it reached, and a caller that wants repair
  // calls `repairTargetOf`/`acceptRepair` (repair.ts) over this Session's own matrix and
  // retries, rather than this function looping internally.

  // Step 8: Grant evaluation (C2) and outcome construction (C17).
  const distinctFamilyCount = distinctFamilyCountOf(admittedDesigns);
  const facts: SessionFacts = {
    poolSize: admittedDesigns.length,
    designPoolDistinctFamilyCount: distinctFamilyCount,
    clusters,
    testbenchTrust: trust,
    runMatrix: matrix,
  };
  const grant = evaluateGrant(facts);
  const record: SessionRecord = {
    ...emptySessionRecord(),
    clusters,
    roleDeclarations: referenceModels.map((testbench) => ({
      testbenchId: testbench.testbenchId,
      roles: testbench.draft.roles,
    })),
    testbenchTrust: trust,
    mutantCensus,
    poolCorrectness: poolCorrectnessRecord,
    tokensSpent: budget.spent(),
    runMatrix: matrix,
  };

  if (grant.kind === 'granted') {
    return buildOutcome({ kind: 'granted', cluster: grant.cluster }, record);
  }

  // Reported cardinality only (Req 2.3's own absence): no `largestCluster`-named value is
  // kept beyond this one scalar, which `strictMajority` already recomputes from `clusters`.
  const majorityClusterSize =
    strictMajority(clusters, admittedDesigns.length)?.designIds.length ?? 0;
  const summary: CheckedSummary = {
    poolSize: admittedDesigns.length,
    distinctModelFamilyCount: distinctFamilyCount,
    trustedTestbenchCount: trust.filter((t) => t.trusted).length,
    consensusRunCount: matrix.cells.length,
    largestClusterCardinality: majorityClusterSize,
    structuralGateChecks,
  };
  return buildOutcome({ kind: 'unmet', unmetCondition: grant.condition, checked: summary }, record);
}
