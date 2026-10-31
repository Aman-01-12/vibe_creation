// formal-property-oracle, Property 21: Falling back charges the budget and relaxes no rule
// (task 8.5).
//
// WHAT IS CLAIMED, OVER WHAT
//   Two halves, one per acceptance criterion, both driven through the REAL `VerificationLoop`
//   with a scripted `FormalGate`. The oracle double and the property-source double are written
//   here, because `verification-loop.test.ts` keeps its doubles module-private, and the oracle
//   double carries `propertyWrapperSources` paired BY INDEX with `results`, as task 12.4 made
//   every `FormalOutcome` carry.
//
//   1. EVERY FORMAL RUN IS CHARGED TO THE SAMPLE'S OWN BUDGET (Req 7.11). For each of the three
//      ways the gate decides a sample - every run `proved`, some run `refuted`, some run
//      `could-not-verify` sending it to the Simulation_Fallback - and over generated sets of one
//      to four runs with generated elapsed times, the sample's `MeteredSessionBudget` (the
//      accountant `EvalHarness#freshBudget` opens per sample) ends holding EXACTLY one iteration
//      plus the reported elapsed milliseconds for EACH formal run, on top of every model call and
//      every simulate run the doubles observed. Those are the only two units `formalCost` in
//      `verification-loop.ts` charges a run in (it charges no tokens and no cents), and both are
//      asserted: the wall clock alone would miss an uncharged run that reported 0 ms, and the
//      iteration count alone would miss a run whose time went missing. The expectation is summed
//      from the GENERATED runs and the doubles' own call counts, and never read off the budget.
//      The Testbench_Precheck's build carries no term in it, because the loop charges that
//      simulate to no budget at all (`#admitInstrument` hands `TestbenchPrecheck` none) - read off
//      the code and confirmed by this sum holding.
//
//   2. FALLING BACK RELAXES NO RULE (Req 7.12). CONTROLLED PAIRS: the same sample driven twice
//      through the real `SweepRunner` -> `EvalHarness` -> `VerificationLoop` -> persisted record
//      -> `summarizeRecords` path, once with a Formal_Gate that falls back and once with NO gate,
//      every other input shared. Rule by rule, both sides must agree on what each rule was given
//      and what it decided:
//        - INSTRUMENT RULES, the loop's own gates on the Simulation_Fallback's testbench (the
//          Testbench_Precheck, the Instrument_Admission port, the incomplete-evidence refusal, the
//          mid-run testbench-build refusal, and the repair step): every sandbox job the Simulator
//          submitted, in order, and every terminal outcome with only its formal record and its
//          per-run ids removed;
//        - CONTROL RULES, the Positive_Control and the Negative_Control as the harness reaches
//          them both in-loop (`MemoizingInstrumentAdmission`) and after the loop: every request
//          the Instrument_Control received, and the verdict and mutation counts each record
//          persisted from its answers;
//        - THE DENOMINATOR PREDICATES, `countsInPassAtK` and the golden denominator's
//          `countsInGoldenPassAtK`: every request the golden judge received, every persisted
//          record with only its six formal fields removed, and the whole arm summary - both
//          denominators, both estimates, and both exclusion tallies - with only its formal block
//          removed. `countsInGoldenPassAtK` is not exported from `@app/eval`, so it is reached
//          through `summarizeRecords`, which is its production caller for the citable number.
//      And the pair must really differ by the gate: the fallback side's record carries the
//      expected Fallback_Reason and the Fallback_Route that reason implies (`cause`, Req 7.19),
//      and its summary counts one fallback sample; the other side's record carries no formal
//      run, no Fallback_Reason, and the route `not-applicable`, since no gate ran to fall back.
//      The route is one of the six formal fields removed from the record comparison above, for
//      the reason the Fallback_Reason is: it is the field the gate IS allowed to change, so it
//      is asserted on its own, derived from the reason, rather than compared across the sides.
//
// THE PAIR HOLDS THE BUDGET CONSTANT, ON PURPOSE
//   Req 7.11 makes a fallback sample's formal runs consume its budget, so under tight caps it may
//   legitimately get fewer repair iterations than the same sample with no gate. That is a charge,
//   not a relaxation, and half 1 owns it. Half 2 therefore runs under caps far above both sides,
//   and its Property_Author double makes no model call, so no budget-derived field - stop reason,
//   cost, tokens - can differ for a reason Req 7.11 already accounts for, and ANY other difference
//   between the two sides is something the fallback changed.
//
// TWO ANCHOR SAMPLES MAKE BOTH ESTIMATES SEE MEMBERSHIP
//   On a one-sample arm a pass@k over an empty denominator and over one failing sample are both
//   0, so a relaxed predicate that admitted a failing fallback sample would be invisible in the
//   estimate. Each sweep therefore runs three samples of one problem: an anchor the oracle and the
//   judge both pass, an anchor they both fail, and the subject. Both anchors sit in both
//   denominators, so pass@1 is 1/2 with the subject out, 2/3 with it in and passing, and 1/3 with
//   it in and failing - every membership decision moves a number. The controls and the judge tell
//   the anchors apart from the subject by CONTENT, a marker in the anchors' testbench and RTL.
//
// COVERAGE: THE CLOSED PART IS EXHAUSTED, THE OPEN PART IS SAMPLED
//   Per `gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`, every member
//   of every closed table - 3 formal decisions in half 1; 5 trajectories, 17 control rows, 8
//   golden rows, and 13 fallback sets (all 11 causes, a throwing oracle, a throwing property
//   source) in half 2 - is graded on EVERY run rather than usually. Half 2 zips its tables into 17
//   rows, so each member appears at least once, and asserts the conjunctions the denominators
//   need (subject in and out of each, each instrument validity, each terminal status) were seen.
//   fast-check covers what has no closed form: the run count, the verdict mix, and the elapsed
//   times in half 1, and the full cross of the closed tables with a generated set in half 2.
//
// RUN COUNT: the shared 100 per fast-check property, and the arithmetic for each sampled row
//   Counts and weights are drawn through `fc.constantFrom` and `fc.oneof`, which pick with an
//   unbiased `nextInt`, so these are exact. Half 1, per decision: a run reporting 0 ms (the case
//   only the iteration count catches) is drawn with probability >= 1/4 per case, so missing it
//   over 100 cases is <= (3/4)^100 ~ 3e-13; a set of two or more runs (the case a loop charging
//   only the first result passes) is drawn with probability 3/4, so missing it is (1/4)^100 ~
//   6e-61. Half 2's sampled property needs one set mixing a `proved` run with the deciding
//   `could-not-verify`: a `results` set (weight 4 of 6) precedes its deciding run with a proof
//   with probability 2/3, so p >= 4/9 and missing it is <= (5/9)^100 ~ 3e-26. Every other row is
//   exhausted, so it carries no miss probability.
//
// WHAT WAS NOT OBSERVABLE
//   The Instrument_Admission DECISION value and the Testbench_Precheck's outcome are not exposed;
//   both are compared through what they were given and what they caused (the jobs, the requests,
//   the outcome). A rule that keyed on the formal provenance INSIDE a control would also be out of
//   reach, but none can: `InstrumentControlRequest` and `GoldenJudgeRequest` carry no formal field.
//
// OUT OF SCOPE
//   The Property_Set-REFUSED route to the Simulation_Fallback (Property 20's other half, and no
//   `could-not-verify` causes it), the throwing oracle's synthesized zero-millisecond charges in
//   half 1 (no run reported a time to charge), and budget exhaustion caused by formal charges.
//
// FALSIFIED out of tree against one-line mutants of the BUILT dist, never by editing a shared module
// (`chipAgent/_inbox/verification-recipe-falsify-a-test-against-a-one-line-mutant-of-the-built-dist-without-touching-shared-source.md`):
// skipping the formal charge and charging only the first run turned half 1 red; skipping the
// incomplete-evidence or the mid-run testbench refusal on a fallback, admitting a fallback sample
// to either denominator, and skipping the after-the-loop control or the judge on a fallback each
// turned both half-2 tests red and left half 1 green. Every unmutated base passed.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 7.11, 7.12**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemoryTracePersistence,
  TraceActionRecorder,
  VerificationLoop,
  type AttemptCost,
  type CandidateEval,
  type CandidateFailure,
  type CandidateGenerator,
  type ConfirmedGenerationContext,
  type FallbackRoute,
  type FormalGate,
  type FormalPropertySet,
  type GeneratedCandidate,
  type GenerateTestbenchRequest,
  type GenerationAdmissionRequest,
  type GenerationContextOpener,
  type GenerationInput,
  type IndependentTestbenchGenerator,
  type PropertySetSource,
  type RepairTestbenchRequest,
  type RequiredCheck,
  type SessionBudgetHandle,
  type TestbenchGenerationOutcome,
  type VerificationLoopDeps,
  type VerificationOutcome,
} from '@app/agent';
import {
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type Result,
  type Spec,
  type Testbench,
} from '@app/core';
import {
  CompletedSampleIndex,
  MeteredSessionBudget,
  SweepKillSwitch,
  SweepRunner,
  ThrottleGovernor,
  VALID_INSTRUMENT,
  combineInstrumentControls,
  invalidInstrument,
  parseResultsLog,
  parseSweepConfig,
  summarizeRecords,
  uncheckedInstrument,
  type ArmSummary,
  type BudgetConsumption,
  type EvalLoopRunner,
  type EvalProblem,
  type EvalSampleRequest,
  type GoldenJudge,
  type GoldenJudgeRequest,
  type InstrumentControl,
  type InstrumentControlRequest,
  type InstrumentControlResult,
  type InstrumentValidity,
  type MutantIdentity,
  type MutationProbeOutcome,
  type MutationProbeReport,
  type RecordedGoldenVerdict,
  type RecordedInstrumentVerdict,
  type ResultsLogPort,
  type SweepConfig,
  type SweepSampleRecord,
} from '@app/eval';
import {
  COULD_NOT_VERIFY_CAUSES,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  admitProved,
  refusedWithoutProof,
  validateExpression,
  type ArtifactBlobRef,
  type CouldNotVerifyCause,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProperty,
  type ProofConditions,
  type PropertyResult,
  type RawRunCapture,
  type ResetContract,
  type ResourceLimits,
  type SandboxJob,
} from '@app/tools';

import { propertyParameters } from './property.js';
import { timingContractFor } from '@app/test';

// **Feature: formal-property-oracle, Property 21: Falling back charges the budget and relaxes no
// rule**
const PROPERTY =
  'formal-property-oracle, Property 21: Falling back charges the budget and relaxes no rule';

/**
 * Half 2's ceiling. Measured at about 0.1s (exhausted rows) and 0.3s (sampled) on an idle
 * machine; the margin is for a loaded full-suite run, above the suite's configured `testTimeout`
 * (`vitest.config.ts`, which owns that value).
 */
const SWEEP_TEST_TIMEOUT_MS = 30_000;

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/**
 * Caps far above anything either side of a pair, or any budget case, can consume: the sweep
 * config's own ceilings (`config-parse.ts`), against at most five 300s formal runs and about a
 * dozen charged iterations per sample.
 */
const GENEROUS_CAPS = Object.freeze({
  maxIterations: 1_000,
  maxTokens: 100_000_000,
  maxWallClockMs: 86_400_000,
  maxCostCents: 10_000_000,
});

/** The provider-reported split every scripted model call carries. */
const PROMPT_TOKENS = 5;
const COMPLETION_TOKENS = 2;

/**
 * What every model-calling double charges per call, shaped as the Model_Router charges a real
 * call: tokens, cents, wall clock, and a REPORTED usage block, so a model call is distinguishable
 * from a simulate or formal charge, which carries none.
 */
const MODEL_CALL: AttemptCost = Object.freeze({
  tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
  costCents: 2,
  wallClockMs: 11,
  tokenUsage: Object.freeze({
    kind: 'reported',
    promptTokens: PROMPT_TOKENS,
    completionTokens: COMPLETION_TOKENS,
  }),
});

// ---------------------------------------------------------------------------
// The shared sample: Spec, candidates, testbench, captures
// ---------------------------------------------------------------------------

const MODULE_NAME = 'byte_reg';
const CAPTURE_CHECK = 'q_captures_d';
const RESET_CHECK = 'q_holds_on_reset';

/** Two required checks, so a pass can omit one and meet the incomplete-evidence refusal. */
const REQUIRED_CHECKS: readonly RequiredCheck[] = Object.freeze([
  { name: CAPTURE_CHECK, kind: 'criterion', description: 'q captures d on the clock edge' },
  { name: RESET_CHECK, kind: 'criterion', description: 'q holds while reset is asserted' },
]);

/** The Testbench_Precheck's interface-stub filename: its job is recognized by CONTENT, not order. */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

/** The marks the controls and the judge tell an anchor from the subject by. */
const ANCHOR_TESTBENCH_MARK = 'anchor-testbench';
const ANCHOR_PASS_MARK = 'anchor-passes';
const ANCHOR_FAIL_MARK = 'anchor-fails';

/** An approved single-module Spec with one simulation-verifiable criterion per required check. */
function approvedSpec(): Spec {
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: MODULE_NAME,
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    }),
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A byte register that captures d on the clock edge.',
    constraints: [],
    moduleInterface: {
      validityOutputName: null,
      moduleName: MODULE_NAME,
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    },
    acceptanceCriteria: REQUIRED_CHECKS.map((check) => ({
      id: newUlid(),
      text: check.description,
      measurable: true,
      method: 'simulation' as const,
    })),
    architecture: 'Single always block latching d into q.',
    approved: true,
    version: 1,
  };
}

/** A generated candidate with its own module-version ref, built once and shared by a pair. */
function candidateFor(spec: Spec, mark: string): GeneratedCandidate {
  const id = newUlid();
  const rtl = `module ${MODULE_NAME}; // ${mark}\nendmodule\n`;
  const artifactRef: ArtifactRef = { kind: 'module-version', id, version: 1 };
  return {
    rtl,
    parsedInterface: { moduleName: MODULE_NAME, ports: [] },
    interfaceMatch: {
      matches: true,
      moduleNameMatches: true,
      expectedModuleName: MODULE_NAME,
      actualModuleName: MODULE_NAME,
      missingPorts: [],
      extraPorts: [],
      mismatchedPorts: [],
    },
    moduleVersion: {
      id,
      projectId: spec.projectId,
      specVersion: spec.version,
      rtl,
      createdAt: new Date(0).toISOString(),
    },
    label: unverified(artifactRef),
  };
}

/** A produced Testbench derived from the Spec, carrying `mark` so a control can key on it. */
function testbenchFor(spec: Spec, mark: string): Testbench {
  return {
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source: `module ${MODULE_NAME}_tb; // ${mark}\nendmodule\n`,
    sourceAttribution: 'spec',
    coversCriteria: spec.acceptanceCriteria.map((criterion) => criterion.id),
  };
}

/** A confirmed generation context standing in for a successful gate admission. */
function confirmedContext(spec: Spec): ConfirmedGenerationContext {
  return {
    sessionId: newUlid(),
    projectId: spec.projectId,
    confirmedIntent: { summary: 'A byte register.', constraints: [], assumptions: [] },
    approvedSpec: spec,
  } as unknown as ConfirmedGenerationContext;
}

/** The VCD every run that reached a verdict produced. */
const VCD = Object.freeze({ vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } });

/** One raw sandbox capture: a clean exit with nothing printed, overridden per case. */
function runCapture(overrides: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly withVcd: boolean;
  readonly wallMs: number;
}): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: overrides.withVcd ? VCD : {},
    deniedOperations: [],
    resourceUsage: { wallMs: overrides.wallMs, maxMemMb: 8, cpuMs: 1 },
  };
}

/** The precheck build: clean, so the precheck never itself refuses the instrument. */
const PRECHECK_CAPTURE = runCapture({ withVcd: true, wallMs: 1 });

/** Every required check printed, every one passing. */
const PASS_CAPTURE = runCapture({
  stdout: `CHECK ${CAPTURE_CHECK} PASS\nCHECK ${RESET_CHECK} PASS\n`,
  withVcd: true,
  wallMs: 13,
});

/** A pass on INCOMPLETE evidence: the reset check never printed, so the loop must fail closed. */
const INCOMPLETE_PASS_CAPTURE = runCapture({
  stdout: `CHECK ${CAPTURE_CHECK} PASS\n`,
  withVcd: true,
  wallMs: 17,
});

/** A failing check with a VCD: a non-pass the loop repairs from, never an instrument refusal. */
const FAIL_CAPTURE = runCapture({
  stdout: `CHECK ${CAPTURE_CHECK} FAIL\nCHECK ${RESET_CHECK} PASS\n`,
  withVcd: true,
  wallMs: 19,
});

/** A build diagnostic naming ONLY the testbench, which the loop refuses rather than repairs. */
const TESTBENCH_BUILD_FAILURE_CAPTURE = runCapture({
  exitCode: 1,
  stderr: `${MODULE_NAME}_tb.v:12: syntax error\n`,
  withVcd: false,
  wallMs: 3,
});

/** How a sample's simulation path runs once the formal gate leaves it undecided. */
const TRAJECTORIES = [
  'passes',
  'passes-on-incomplete-evidence',
  'fails-then-passes',
  'fails-then-repair-unavailable',
  'testbench-build-fails',
] as const;
type Trajectory = (typeof TRAJECTORIES)[number];

/** Each trajectory's iteration captures, in order. Total, so a sixth trajectory cannot compile. */
const TRAJECTORY_CAPTURES: Readonly<Record<Trajectory, readonly RawRunCapture[]>> = Object.freeze({
  passes: [PASS_CAPTURE],
  'passes-on-incomplete-evidence': [INCOMPLETE_PASS_CAPTURE],
  'fails-then-passes': [FAIL_CAPTURE, PASS_CAPTURE],
  'fails-then-repair-unavailable': [FAIL_CAPTURE],
  'testbench-build-fails': [TESTBENCH_BUILD_FAILURE_CAPTURE],
});

/**
 * A fake sandbox runtime scripted to one trajectory, recording every job it is handed.
 *
 * The precheck's own build is recognized by its stub path, never by call order
 * (`gotcha-unconditional-precheck-call-shifts-order-dependent-fake-sequences.md`).
 */
class RecordedSandbox {
  readonly runtime: FakeSandboxRuntime;
  readonly jobs: SandboxJob[];
  /** The wall clock each ITERATION reported, in order; the precheck's build is not one. */
  readonly simulateWallMs: number[] = [];
  readonly #iterations: readonly RawRunCapture[];

  constructor(iterations: readonly RawRunCapture[], jobs: SandboxJob[] = []) {
    this.#iterations = iterations;
    this.jobs = jobs;
    this.runtime = new FakeSandboxRuntime((job) => this.#capture(job));
  }

  #capture(job: SandboxJob): RawRunCapture {
    this.jobs.push(job);
    if (job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH)) {
      return PRECHECK_CAPTURE;
    }
    const capture = this.#iterations[this.simulateWallMs.length];
    if (capture === undefined) {
      throw new Error('the loop ran an iteration this trajectory did not script');
    }
    this.simulateWallMs.push(capture.resourceUsage.wallMs);
    return capture;
  }
}

// ---------------------------------------------------------------------------
// The loop's doubles
// ---------------------------------------------------------------------------

/** Counts every model call the doubles make, each charged to the handle the loop handed over. */
class ModelCallMeter {
  #calls = 0;

  /** Charge one model call to `budget`, as the Model_Router charges a real one. */
  charge(budget: SessionBudgetHandle): void {
    budget.charge(MODEL_CALL);
    this.#calls += 1;
  }

  get calls(): number {
    return this.#calls;
  }
}

/** A gate opener that always admits with one shared context. */
class AdmittingGate implements GenerationContextOpener {
  readonly #context: ConfirmedGenerationContext;

  constructor(context: ConfirmedGenerationContext) {
    this.#context = context;
  }

  openGenerationContext() {
    return Promise.resolve(ok(this.#context));
  }
}

/** The Generation_Agent's two primitives: one first candidate, then one revision or none. */
class ScriptedGenerator implements CandidateGenerator {
  readonly #first: GeneratedCandidate;
  readonly #revision: GeneratedCandidate | null;
  readonly #meter: ModelCallMeter;

  constructor(
    first: GeneratedCandidate,
    revision: GeneratedCandidate | null,
    meter: ModelCallMeter,
  ) {
    this.#first = first;
    this.#revision = revision;
    this.#meter = meter;
  }

  generateCandidate(
    _input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    this.#meter.charge(budget);
    return Promise.resolve(ok({ candidate: this.#first, interfaceDiagnostics: '' }));
  }

  reviseFromErrors(
    _input: GenerationInput,
    _previousRtl: string,
    _diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    this.#meter.charge(budget);
    if (this.#revision === null) {
      return Promise.resolve({
        ok: false,
        error: { reason: 'model-unavailable', detail: 'this trajectory scripts no revision' },
      });
    }
    return Promise.resolve(ok({ candidate: this.#revision, interfaceDiagnostics: '' }));
  }
}

/** The Testbench_Agent: one produced testbench requiring both checks. Never repairs. */
class FixedTestbench implements IndependentTestbenchGenerator {
  readonly #outcome: TestbenchGenerationOutcome;
  readonly #meter: ModelCallMeter;

  constructor(testbench: Testbench, meter: ModelCallMeter) {
    this.#outcome = {
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench,
      checks: REQUIRED_CHECKS,
    };
    this.#meter = meter;
  }

  generateTestbench(
    _request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    this.#meter.charge(budget);
    return Promise.resolve(this.#outcome);
  }

  repairTestbench(
    _request: RepairTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    this.#meter.charge(budget);
    return Promise.resolve({
      status: 'generation-failed',
      failure: { reason: 'model-call-failed', detail: 'FixedTestbench never repairs' },
    });
  }
}

/**
 * The Formal_Oracle: ONE scripted `FormalOutcome` for the whole set, or a throw.
 *
 * `null` stands in for an unavailable instrument: `proveSet` rejects, which the loop records as a
 * `toolchain-unavailable` fall back for every submitted property.
 */
class ScriptedFormalOracle implements FormalOraclePort {
  readonly #outcome: FormalOutcome | null;

  constructor(outcome: FormalOutcome | null) {
    this.#outcome = outcome;
  }

  proveSet(): Promise<FormalOutcome> {
    if (this.#outcome === null) {
      return Promise.reject(new Error('the formal oracle is unavailable'));
    }
    return Promise.resolve(this.#outcome);
  }

  /** The port's per-property method; the loop submits whole sets, so it only has to exist. */
  async prove(): Promise<PropertyResult> {
    const outcome = await this.proveSet();
    const first = outcome.results[0];
    if (first === undefined) {
      throw new Error('the scripted oracle holds no result');
    }
    return first;
  }
}

/**
 * The Property_Author: one scripted Property_Set, or a throw (`null`).
 *
 * It charges one model call to the handle it is handed when given a meter, because the real
 * author's model call is charged to the sample's own budget too; half 2 gives it none.
 */
class ScriptedPropertySource implements PropertySetSource {
  readonly #properties: readonly FormalProperty[] | null;
  readonly #meter: ModelCallMeter | null;

  constructor(properties: readonly FormalProperty[] | null, meter: ModelCallMeter | null) {
    this.#properties = properties;
    this.#meter = meter;
  }

  propertySetFor(_spec: Spec, budget: SessionBudgetHandle): Promise<FormalPropertySet> {
    this.#meter?.charge(budget);
    if (this.#properties === null) {
      return Promise.reject(new Error('the property author is unavailable'));
    }
    return Promise.resolve({
      properties: this.#properties,
      unexpressedCriteria: [],
      propertySetAdmitted: 'not-gated',
      propertySetAuthoredUpFront: false,
    });
  }
}

/** One sample's fixed inputs: the candidates its generator hands out and its one testbench. */
interface SampleInputs {
  readonly first: GeneratedCandidate;
  readonly revision: GeneratedCandidate;
  readonly testbench: Testbench;
}

/** The deps every loop here shares; the optional formal gate and admission port are added on. */
function loopDeps(
  context: ConfirmedGenerationContext,
  sample: SampleInputs,
  trajectory: Trajectory,
  parts: { readonly meter: ModelCallMeter; readonly sandbox: RecordedSandbox },
): VerificationLoopDeps {
  // A trajectory scripts a second iteration exactly when its one repair produced a revision.
  const revises = TRAJECTORY_CAPTURES[trajectory].length > 1;
  return {
    gate: new AdmittingGate(context),
    generator: new ScriptedGenerator(sample.first, revises ? sample.revision : null, parts.meter),
    testbench: new FixedTestbench(sample.testbench, parts.meter),
    simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(parts.sandbox.runtime)),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    trustLabeler: oracleTrustLabeler,
  };
}

// ---------------------------------------------------------------------------
// Formal runs and the outcome the oracle double reports for them
// ---------------------------------------------------------------------------

/** One formal run as scripted here: the verdict it reports and the time it reports spending. */
interface FormalRun {
  readonly verdict: 'proved' | 'refuted' | CouldNotVerifyCause;
  readonly elapsedMs: number;
}

/** The one validated consequent every scripted property states; its content decides nothing. */
const CONSEQUENT = (() => {
  const validated = validateExpression('q == d');
  if (!validated.ok) {
    throw new Error('the fixture expression was rejected by the validator');
  }
  return validated.value;
})();

/** The `ProvedEvidence` every scripted proof carries, built by the gate's sole constructor. */
const PROOF = (() => {
  const evidence = admitProved({
    assertionCount: 2,
    presat: 'satisfiable',
    cover: { reached: 'not-applicable' },
    base: 'passed',
    induction: 'successful',
  });
  if (typeof evidence === 'string') {
    throw new Error(`the fixture conditions are not a proof: ${evidence}`);
  }
  return evidence;
})();

/** The conditions a refutation is sourced from: a FAILED base case (Req 1.10). */
const REFUTING_CONDITIONS: ProofConditions = {
  assertionCount: 2,
  presat: 'satisfiable',
  cover: { reached: 'not-applicable' },
  base: 'failed',
  induction: 'not-run',
};

const COUNTEREXAMPLE: ArtifactBlobRef = Object.freeze({
  name: 'formal-trace-base-bitwuzla.vcd',
  sizeBytes: 24,
  sha256: 'c'.repeat(64),
});

/** A derived contract, as a pre-pass that ran reports one; no comparison here reads it. */
const DERIVED_RESET_CONTRACT: ResetContract = Object.freeze({
  derived: true,
  resetName: 'rst_n',
  resetActiveLow: true,
  resetKind: 'sync',
  initialStateFree: true,
});

/** The two pre-pass refusals, which arrive before any Property_Wrapper exists. */
const PREPASS_REFUSALS: ReadonlySet<string> = new Set<CouldNotVerifyCause>([
  'reset-contract-unresolved',
  'clock-contract-unsupported',
]);

/** The submitted property at `index`; the criterion it names is the index's own. */
function formalProperty(index: number): FormalProperty {
  return {
    kind: 'combinational',
    id: `p-${index}`,
    criterionRef: `ac-${index}`,
    consequent: CONSEQUENT,
  };
}

/**
 * The `PropertyResult` a run reports: a proof carries `admitProved`'s evidence (the gate's sole
 * constructor), and a `could-not-verify` comes from `refusedWithoutProof`, the adapter's own
 * builder for a verdict no Proof_Condition decided, so every one of the 11 causes is reachable.
 */
function resultOf(run: FormalRun, index: number): PropertyResult {
  const property = formalProperty(index);
  const { elapsedMs } = run;
  if (run.verdict === 'proved') {
    return {
      verdict: 'proved',
      evidence: PROOF,
      depth: 20,
      elapsedMs,
      criterionRef: property.criterionRef,
    };
  }
  if (run.verdict === 'refuted') {
    return {
      verdict: 'refuted',
      counterexample: COUNTEREXAMPLE,
      conditions: REFUTING_CONDITIONS,
      depth: 20,
      elapsedMs,
      criterionRef: property.criterionRef,
    };
  }
  return refusedWithoutProof(run.verdict, property, { depth: 0, elapsedMs }, '');
}

/**
 * The `FormalOutcome` the oracle double reports for a set of runs.
 *
 * `propertyWrapperSources` is paired BY INDEX with `results` (task 12.4), and a pre-pass refusal
 * renders no wrapper, so its entry is `null`.
 */
function outcomeOf(runs: readonly FormalRun[]): FormalOutcome {
  return {
    results: runs.map((run, index) => resultOf(run, index)),
    propertyWrapperSources: runs.map((run, index) =>
      PREPASS_REFUSALS.has(run.verdict) ? null : `module formal_property_wrapper; // ac-${index}\n`,
    ),
    // The double resolves no artifact reference, so no property carries a trace.
    counterexampleCaptures: runs.map(() => null),
    resetContract: DERIVED_RESET_CONTRACT,
    assertionGateEmitted: true,
    clockPolarity: 'posedge',
  };
}

/** The submitted properties for a set of `count` runs, one per run, in submission order. */
function propertiesFor(count: number): readonly FormalProperty[] {
  return Array.from({ length: count }, (_, index) => formalProperty(index));
}

/** Elapsed times, biased to the two edges: 0 ms and the full default Property_Time_Budget. */
const ELAPSED_MS: fc.Arbitrary<number> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(0, DEFAULT_PROPERTY_TIME_BUDGET_MS) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 2 * DEFAULT_PROPERTY_TIME_BUDGET_MS }) },
);

/** A run of one verdict family; every `could-not-verify` cause is reachable. */
function runOf<V extends FormalRun['verdict']>(
  verdict: fc.Arbitrary<V>,
): fc.Arbitrary<FormalRun & { readonly verdict: V }> {
  return fc.tuple(verdict, ELAPSED_MS).map(([runVerdict, elapsedMs]) => ({
    verdict: runVerdict,
    elapsedMs,
  }));
}

const PROVED_RUN = runOf(fc.constant('proved' as const));
const REFUTED_RUN = runOf(fc.constant('refuted' as const));
const COULD_NOT_VERIFY_RUN = runOf(fc.constantFrom(...COULD_NOT_VERIFY_CAUSES));

/**
 * `run` repeated a count drawn UNIFORMLY from `counts`.
 *
 * `fc.constantFrom` picks with `nextInt`, so the counts are exactly uniform, which is what lets
 * the header state its run-count arithmetic exactly; `fc.array`'s own length draw is biased short.
 */
function runsOf(
  run: fc.Arbitrary<FormalRun>,
  counts: readonly number[],
): fc.Arbitrary<readonly FormalRun[]> {
  return fc
    .constantFrom(...counts)
    .chain((count) => fc.array(run, { minLength: count, maxLength: count }));
}

// ---------------------------------------------------------------------------
// Half 1: every formal run is charged to the sample's own budget (Req 7.11)
// ---------------------------------------------------------------------------

/** How the Formal_Gate decides a sample; exhausted rather than sampled. */
const FORMAL_DECISIONS = ['proved', 'refuted', 'falls-back'] as const;
type FormalDecision = (typeof FORMAL_DECISIONS)[number];

/** The terminal status each decision reaches over the `passes` trajectory. */
const DECIDED_STATUS: Readonly<Record<FormalDecision, VerificationOutcome['status']>> =
  Object.freeze({ proved: 'verified', refuted: 'unverified', 'falls-back': 'verified' });

/**
 * Sets of one to four runs the gate decides as `decision`.
 *
 * `refuted` places one refutation among any verdicts, because a refutation wins over a
 * `could-not-verify` (Req 7.17). `falls-back` places one `could-not-verify` among proofs and other
 * `could-not-verify` runs and NO refutation, which is what sends a set to the fallback.
 */
function arbRunsDecidedAs(decision: FormalDecision): fc.Arbitrary<readonly FormalRun[]> {
  if (decision === 'proved') {
    return runsOf(PROVED_RUN, [1, 2, 3, 4]);
  }
  const deciding: fc.Arbitrary<FormalRun> =
    decision === 'refuted' ? REFUTED_RUN : COULD_NOT_VERIFY_RUN;
  const others: fc.Arbitrary<FormalRun> =
    decision === 'refuted'
      ? fc.oneof(PROVED_RUN, REFUTED_RUN, COULD_NOT_VERIFY_RUN)
      : fc.oneof(PROVED_RUN, COULD_NOT_VERIFY_RUN);
  return fc.tuple(runsOf(others, [0, 1, 2, 3]), deciding, fc.nat()).map(([rest, run, at]) => {
    const position = at % (rest.length + 1);
    return [...rest.slice(0, position), run, ...rest.slice(position)];
  });
}

/** Everything one budget case observed: the budget's total and what the doubles saw. */
interface BudgetCase {
  readonly consumed: BudgetConsumption;
  readonly modelCalls: number;
  readonly simulateWallMs: readonly number[];
  readonly status: VerificationOutcome['status'];
}

/** Drive one sample over `runs` through the real loop against a fresh metered budget. */
async function runBudgetCase(runs: readonly FormalRun[]): Promise<BudgetCase> {
  const spec = approvedSpec();
  const meter = new ModelCallMeter();
  const sandbox = new RecordedSandbox(TRAJECTORY_CAPTURES.passes);
  const sample = {
    first: candidateFor(spec, 'first'),
    revision: candidateFor(spec, 'revision'),
    testbench: testbenchFor(spec, 'testbench'),
  };
  const budget = new MeteredSessionBudget({
    sessionId: newUlid(),
    ...GENEROUS_CAPS,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  const loop = new VerificationLoop({
    ...loopDeps(confirmedContext(spec), sample, 'passes', { meter, sandbox }),
    formal: {
      oracle: new ScriptedFormalOracle(outcomeOf(runs)),
      properties: new ScriptedPropertySource(propertiesFor(runs.length), meter),
    },
  });
  const outcome = await loop.verify(REQUEST, budget, LIMITS);
  return {
    consumed: budget.consumed(),
    modelCalls: meter.calls,
    simulateWallMs: sandbox.simulateWallMs,
    status: outcome.status,
  };
}

/** The sum of a list of non-negative integers. */
function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

/**
 * What the budget must hold: every model call and simulate run the doubles observed, plus ONE
 * iteration and the reported elapsed time for EACH formal run - summed from the generated runs.
 */
function expectedConsumption(
  observed: Pick<BudgetCase, 'modelCalls' | 'simulateWallMs'>,
  runs: readonly FormalRun[],
): BudgetConsumption {
  const { modelCalls, simulateWallMs } = observed;
  return {
    iterations: modelCalls + simulateWallMs.length + runs.length,
    tokens: modelCalls * MODEL_CALL.tokens,
    promptTokens: modelCalls * PROMPT_TOKENS,
    completionTokens: modelCalls * COMPLETION_TOKENS,
    unreportedUsageCalls: 0,
    wallClockMs:
      modelCalls * MODEL_CALL.wallClockMs +
      total(simulateWallMs) +
      total(runs.map((run) => run.elapsedMs)),
    costCents: modelCalls * MODEL_CALL.costCents,
  };
}

/** Req 7.11 over one case: the budget holds each formal run, in both units the loop charges. */
function assertEveryFormalRunCharged(observed: BudgetCase, runs: readonly FormalRun[]): void {
  expect(observed.consumed).toEqual(expectedConsumption(observed, runs));
}

// ---------------------------------------------------------------------------
// Half 2: falling back relaxes no rule (Req 7.12)
// ---------------------------------------------------------------------------

/** How the Instrument_Control answers for the SUBJECT's testbench; an anchor's always reads valid. */
type ControlAnswer =
  | { readonly kind: 'no-reference' }
  | { readonly kind: 'throws' }
  | {
      readonly kind: 'measures';
      readonly positive: RecordedInstrumentVerdict;
      readonly negative: MutationProbeOutcome | null;
    };

/**
 * Whether an Instrument_Control is wired, and where the loop consults it.
 *
 * `in-loop` hands the harness's `MemoizingInstrumentAdmission` to the loop, which consults it
 * before the formal gate; `after-the-loop` withholds it, so the harness runs the control once the
 * loop has returned. Both are production paths through `EvalHarness#runSample`.
 */
type ControlRow =
  | { readonly wiring: 'not-wired' }
  | { readonly wiring: 'in-loop' | 'after-the-loop'; readonly answer: ControlAnswer };

/** How the golden judge answers for the SUBJECT's candidate; the anchors' answers are fixed. */
type GoldenRow =
  | { readonly kind: 'not-wired' }
  | { readonly kind: 'no-golden' }
  | { readonly kind: 'throws' }
  | { readonly kind: 'judges'; readonly verdict: RecordedGoldenVerdict };

/**
 * How the Formal_Gate sends the subject to the Simulation_Fallback, and the Fallback_Reason that
 * route must record: the deciding `could-not-verify` run's cause, or `toolchain-unavailable` for
 * an oracle or a property source that threw (Req 1.9).
 */
type FallbackSet =
  | {
      readonly mode: 'results';
      readonly runs: readonly FormalRun[];
      readonly reason: CouldNotVerifyCause;
    }
  | { readonly mode: 'oracle-throws'; readonly propertyCount: number }
  | { readonly mode: 'source-throws' };

/** One pair's closed inputs, every one shared by both sides. */
interface ScenarioRow {
  readonly trajectory: Trajectory;
  readonly control: ControlRow;
  readonly golden: GoldenRow;
}

/** A surviving mutant the independent judge killed: one proven coverage gap. */
const SURVIVOR: MutantIdentity = Object.freeze({
  mutantId: 'ARITH_PLUS_TO_MINUS@3:9',
  operator: 'ARITH_PLUS_TO_MINUS',
  site: { line: 3, column: 9, before: '+', after: '-' },
});

/** A measured probe over four valid mutants, `goldenKilledCount` of them killed by the judge. */
function probed(
  goldenKilledCount: number,
  coverageGapSurvivors: readonly MutantIdentity[],
): MutationProbeOutcome {
  const report: MutationProbeReport = {
    validCount: 4,
    killedCount: 4 - coverageGapSurvivors.length,
    noVerdictKills: 0,
    coverageGapSurvivors,
    candidateEquivalentSurvivors: [],
    goldenKilledCount,
    goldenTimeoutCount: 0,
    nonCompilingCount: 1,
    goldenErroredCount: 0,
    generatedCount: 5,
    elapsedMs: 40,
  };
  return { kind: 'measured', report };
}

/** A control that ran: the positive finding, and the negative one where it ran. */
function measures(
  positive: RecordedInstrumentVerdict,
  negative: MutationProbeOutcome | null = null,
): ControlAnswer {
  return { kind: 'measures', positive, negative };
}

/** Answers the in-loop admission lets through to the formal gate: none combines to `invalid`. */
const ADMITTING_ANSWERS: readonly ControlAnswer[] = [
  { kind: 'no-reference' },
  { kind: 'throws' },
  measures(VALID_INSTRUMENT),
  // A closed coverage gap: `valid`, with the probe's counts on the record.
  measures(VALID_INSTRUMENT, probed(3, [])),
  // A vacuous gate (the judge killed nothing): `unchecked`, never `valid`.
  measures(VALID_INSTRUMENT, probed(0, [])),
  measures(VALID_INSTRUMENT, { kind: 'unavailable', reason: 'probe-errored' }),
  measures(uncheckedInstrument('testbench-unsubmittable')),
];

/**
 * Answers that combine to `invalid`. In-loop admission refuses those BEFORE the formal gate runs,
 * so no fallback can follow; a fallback sample meets them only through the after-the-loop control.
 */
const INVALIDATING_ANSWERS: readonly ControlAnswer[] = [
  measures(VALID_INSTRUMENT, probed(3, [SURVIVOR])),
  measures(invalidInstrument('TESTBENCH_FAILED_REFERENCE')),
];

/** Every wiring with every answer it can carry on a fallback sample: 1 + 7 + 7 + 2 = 17 rows. */
const CONTROL_ROWS: readonly ControlRow[] = [
  { wiring: 'not-wired' },
  ...ADMITTING_ANSWERS.map((answer): ControlRow => ({ wiring: 'in-loop', answer })),
  ...ADMITTING_ANSWERS.map((answer): ControlRow => ({ wiring: 'after-the-loop', answer })),
  ...INVALIDATING_ANSWERS.map((answer): ControlRow => ({ wiring: 'after-the-loop', answer })),
];

/** A judge that returned a recorded verdict for the subject. */
function judges(kind: RecordedGoldenVerdict['kind'], failureCount: number | null): GoldenRow {
  return { kind: 'judges', verdict: { kind, failureCount } };
}

/** Every judge answer the harness branches on, for the subject: no judge, none, a throw, all 5 kinds. */
const GOLDEN_ROWS: readonly GoldenRow[] = [
  { kind: 'not-wired' },
  { kind: 'no-golden' },
  { kind: 'throws' },
  judges('passed', 0),
  judges('failed', 2),
  judges('did-not-build', null),
  judges('no-output', null),
  judges('timed-out', null),
];

/** One fixed set per member: each cause deciding behind a proof, then both throwing routes. */
const FALLBACK_SETS: readonly FallbackSet[] = [
  ...COULD_NOT_VERIFY_CAUSES.map((cause): FallbackSet => ({
    mode: 'results',
    runs: [
      { verdict: 'proved', elapsedMs: 900 },
      { verdict: cause, elapsedMs: 1_200 },
    ],
    reason: cause,
  })),
  { mode: 'oracle-throws', propertyCount: 2 },
  { mode: 'source-throws' },
];

/** The Fallback_Reason a set's route must record. */
function reasonOf(set: FallbackSet): CouldNotVerifyCause {
  return set.mode === 'results' ? set.reason : 'toolchain-unavailable';
}

/**
 * The Fallback_Route a recorded Fallback_Reason implies: `cause` exactly where a reason exists
 * (Req 7.19), the way `formalProvenanceOf` projects the two off one `TakenRoute`.
 *
 * Only the two routes this property can reach are spelled. Every set here is submitted to the
 * oracle or throws on the way, so the refused Property_Set (`property-set-refused`) and the empty
 * one (`no-property-expressed`) are Property 20's routes, and the pair's no-gate side never
 * reached a gate at all.
 */
function routeImpliedBy(reason: CouldNotVerifyCause | null): FallbackRoute {
  return reason === null ? 'not-applicable' : 'cause';
}

/** The table member at `index`, wrapping, so a zip of unequal tables covers every member. */
function memberAt<T>(table: readonly T[], index: number): T {
  const member = table[index % table.length];
  if (member === undefined) {
    throw new Error('a closed table is empty');
  }
  return member;
}

/** Every member of every closed table at least once: the tables zipped to the longest's length. */
const CLOSED_ROWS: readonly (ScenarioRow & { readonly fallback: FallbackSet })[] = Array.from(
  {
    length: Math.max(
      TRAJECTORIES.length,
      CONTROL_ROWS.length,
      GOLDEN_ROWS.length,
      FALLBACK_SETS.length,
    ),
  },
  (_, index) => ({
    trajectory: memberAt(TRAJECTORIES, index),
    control: memberAt(CONTROL_ROWS, index),
    golden: memberAt(GOLDEN_ROWS, index),
    fallback: memberAt(FALLBACK_SETS, index),
  }),
);

/** The three samples one sweep runs, by sample index: both anchors, then the subject. */
const SAMPLE_ROLES = ['anchor-passes', 'anchor-fails', 'subject'] as const;
type SampleRole = (typeof SAMPLE_ROLES)[number];
const ANCHOR_COUNT = SAMPLE_ROLES.length - 1;
const SUBJECT_INDEX = SAMPLE_ROLES.indexOf('subject');

/** Each anchor's fixed trajectory: one the oracle passes, one it fails with no repair. */
const ANCHOR_TRAJECTORY: Readonly<Record<Exclude<SampleRole, 'subject'>, Trajectory>> =
  Object.freeze({ 'anchor-passes': 'passes', 'anchor-fails': 'fails-then-repair-unavailable' });

/** The judge's fixed answers for the anchors. */
const GOLDEN_PASSED: RecordedGoldenVerdict = Object.freeze({ kind: 'passed', failureCount: 0 });
const GOLDEN_FAILED: RecordedGoldenVerdict = Object.freeze({ kind: 'failed', failureCount: 3 });

/** Everything both sides of one pair share: the problem, the context, and every sample's inputs. */
interface PairFixture {
  readonly problem: EvalProblem;
  readonly context: ConfirmedGenerationContext;
  readonly samples: Readonly<Record<SampleRole, SampleInputs>>;
}

function pairFixture(): PairFixture {
  const spec = approvedSpec();
  const anchorTestbench = testbenchFor(spec, ANCHOR_TESTBENCH_MARK);
  const anchor = (mark: string): SampleInputs => ({
    first: candidateFor(spec, mark),
    revision: candidateFor(spec, mark),
    testbench: anchorTestbench,
  });
  return {
    problem: {
      id: 'formal/fallback-pair',
      title: 'formal fallback pair',
      source: 'RTLLM',
      spec,
      intentSummary: 'A byte register that captures d.',
    },
    context: confirmedContext(spec),
    samples: {
      'anchor-passes': anchor(ANCHOR_PASS_MARK),
      'anchor-fails': anchor(ANCHOR_FAIL_MARK),
      subject: {
        first: candidateFor(spec, 'subject-first'),
        revision: candidateFor(spec, 'subject-revision'),
        testbench: testbenchFor(spec, 'subject-testbench'),
      },
    },
  };
}

/** The Formal_Gate that sends the subject to the Simulation_Fallback by `set`'s route. */
function fallingBackGate(set: FallbackSet): FormalGate {
  switch (set.mode) {
    case 'results':
      return {
        oracle: new ScriptedFormalOracle(outcomeOf(set.runs)),
        properties: new ScriptedPropertySource(propertiesFor(set.runs.length), null),
      };
    case 'oracle-throws':
      return {
        oracle: new ScriptedFormalOracle(null),
        properties: new ScriptedPropertySource(propertiesFor(set.propertyCount), null),
      };
    case 'source-throws':
      return {
        oracle: new ScriptedFormalOracle(null),
        properties: new ScriptedPropertySource(null, null),
      };
  }
}

/**
 * The `EvalLoopRunner` both sides of a pair use; they differ ONLY in the subject's Formal_Gate.
 *
 * A fresh `VerificationLoop` per sample over the harness's own budget and limits, the way the
 * production runner builds one, recording every outcome and every sandbox job it produced.
 */
class PairedLoopRunner implements EvalLoopRunner {
  readonly outcomes: VerificationOutcome[] = [];
  readonly sandboxJobs: SandboxJob[] = [];
  readonly #fixture: PairFixture;
  readonly #row: ScenarioRow;
  readonly #gate: FormalGate | null;

  constructor(fixture: PairFixture, row: ScenarioRow, gate: FormalGate | null) {
    this.#fixture = fixture;
    this.#row = row;
    this.#gate = gate;
  }

  async runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    const role = SAMPLE_ROLES[request.sampleIndex];
    if (role === undefined) {
      throw new Error('the sweep ran a sample index this pair did not plan');
    }
    const trajectory = role === 'subject' ? this.#row.trajectory : ANCHOR_TRAJECTORY[role];
    const sandbox = new RecordedSandbox(TRAJECTORY_CAPTURES[trajectory], this.sandboxJobs);
    const meter = new ModelCallMeter();
    const deps = loopDeps(this.#fixture.context, this.#fixture.samples[role], trajectory, {
      meter,
      sandbox,
    });
    const admission =
      this.#row.control.wiring === 'in-loop' ? request.instrumentAdmission : undefined;
    const gate = role === 'subject' ? this.#gate : null;
    const loop = new VerificationLoop({
      ...deps,
      ...(admission === undefined ? {} : { instrumentAdmission: admission }),
      ...(gate === null ? {} : { formal: gate }),
    });
    const outcome = await loop.verify(REQUEST, request.budget, request.limits);
    this.outcomes.push(outcome);
    return outcome;
  }
}

/**
 * A control's result: the two findings combined by the PRODUCTION rule.
 *
 * The negative control probes only an instrument the positive one accepted, as
 * `RtllmInstrumentControl#probeMutants` does, and `combineInstrumentControls` decides the verdict.
 */
function controlResult(
  positive: RecordedInstrumentVerdict,
  negative: MutationProbeOutcome | null,
): InstrumentControlResult {
  const ran = positive.validity === 'valid' ? negative : null;
  return {
    verdict: combineInstrumentControls({ positive, negative: ran }),
    stdout: '',
    stderr: '',
    exitCode: 0,
    mutation: ran?.kind === 'measured' ? ran.report : null,
    positiveRun: null,
  };
}

/** The Instrument_Control: an anchor's testbench reads valid, the subject's per the row. */
class ScriptedInstrumentControl implements InstrumentControl {
  readonly requests: InstrumentControlRequest[] = [];
  readonly #answer: ControlAnswer;

  constructor(answer: ControlAnswer) {
    this.#answer = answer;
  }

  check(request: InstrumentControlRequest): Promise<InstrumentControlResult | null> {
    this.requests.push(request);
    if (request.testbench.includes(ANCHOR_TESTBENCH_MARK)) {
      return Promise.resolve(controlResult(VALID_INSTRUMENT, null));
    }
    const answer = this.#answer;
    if (answer.kind === 'no-reference') {
      return Promise.resolve(null);
    }
    if (answer.kind === 'throws') {
      return Promise.reject(new Error('the control run fell over'));
    }
    return Promise.resolve(controlResult(answer.positive, answer.negative));
  }
}

/** The golden judge: the anchors pass and fail, the subject is judged per the row. */
class ScriptedGoldenJudge implements GoldenJudge {
  readonly requests: GoldenJudgeRequest[] = [];
  readonly #row: Exclude<GoldenRow, { readonly kind: 'not-wired' }>;

  constructor(row: Exclude<GoldenRow, { readonly kind: 'not-wired' }>) {
    this.#row = row;
  }

  judge(request: GoldenJudgeRequest): Promise<RecordedGoldenVerdict | null> {
    this.requests.push(request);
    if (request.rtl.includes(ANCHOR_PASS_MARK)) {
      return Promise.resolve(GOLDEN_PASSED);
    }
    if (request.rtl.includes(ANCHOR_FAIL_MARK)) {
      return Promise.resolve(GOLDEN_FAILED);
    }
    const row = this.#row;
    if (row.kind === 'no-golden') {
      return Promise.resolve(null);
    }
    if (row.kind === 'throws') {
      return Promise.reject(new Error('the judge run fell over'));
    }
    return Promise.resolve(row.verdict);
  }
}

/** An in-memory results log: the sweep appends, the summary reads the same text back. */
class MemoryResultsLog implements ResultsLogPort {
  readonly #lines: string[] = [];

  appendLine(line: string): Promise<void> {
    this.#lines.push(line);
    return Promise.resolve();
  }

  readAll(): Promise<string> {
    return Promise.resolve(this.#lines.join('\n'));
  }
}

const PAIR_CONFIG_HASH = 'formal-fallback-pair';

/** One arm, one problem, three samples (the anchors and the subject), under GENEROUS_CAPS. */
const SWEEP_CONFIG: SweepConfig = (() => {
  const parsed = parseSweepConfig({
    schemaVersion: 1,
    runName: 'formal-fallback-pair',
    arms: [{ name: 'arm', model: 'model.a' }],
    problems: { kind: 'all' },
    sampleCount: SAMPLE_ROLES.length,
    ks: [1],
    seed: 7,
    temperature: 0,
    caps: GENEROUS_CAPS,
    limits: LIMITS,
    costEnvelopeCents: 1_000_000,
    modelHost: { region: 'us-east-1' },
    outputDir: '.eval-runs/formal-fallback-pair',
    concurrency: 1,
  });
  if (!parsed.ok) {
    throw new Error(`the sweep fixture config is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
})();

/** What one side of a pair produced, end to end, rule input by rule input. */
interface PairSide {
  readonly outcomes: readonly VerificationOutcome[];
  readonly sandboxJobs: readonly SandboxJob[];
  readonly controlRequests: readonly InstrumentControlRequest[];
  readonly judgeRequests: readonly GoldenJudgeRequest[];
  readonly records: readonly SweepSampleRecord[];
  readonly arm: ArmSummary;
}

/** Run one side through the real `SweepRunner`, then read its records back and summarize them. */
async function sweepSide(
  fixture: PairFixture,
  row: ScenarioRow,
  gate: FormalGate | null,
): Promise<PairSide> {
  const loopRunner = new PairedLoopRunner(fixture, row, gate);
  const control =
    row.control.wiring === 'not-wired' ? null : new ScriptedInstrumentControl(row.control.answer);
  const judge = row.golden.kind === 'not-wired' ? null : new ScriptedGoldenJudge(row.golden);
  const log = new MemoryResultsLog();
  const clock = (): number => 0;
  const run = await new SweepRunner({
    config: SWEEP_CONFIG,
    configHash: PAIR_CONFIG_HASH,
    problems: [fixture.problem],
    loopRunnerFor: () => loopRunner,
    goldenJudge: judge,
    instrumentControl: control,
    resultsLog: log,
    completed: CompletedSampleIndex.fromRecords([], PAIR_CONFIG_HASH),
    killSwitch: new SweepKillSwitch({ maxWallClockMs: 1_000_000, maxSamples: 100 }, clock),
    outage: () => false,
    governor: new ThrottleGovernor(SWEEP_CONFIG.concurrency, clock),
    waitMs: () => Promise.resolve(),
    now: clock,
    onProgress: () => undefined,
    writeManifest: () => Promise.resolve(),
  }).run();
  const parsed = parseResultsLog(await log.readAll());
  const arm = summarizeRecords(parsed.records, SWEEP_CONFIG.ks, PAIR_CONFIG_HASH, parsed).arms[0];
  if (run.stopReason !== 'completed' || parsed.records.length !== SAMPLE_ROLES.length || !arm) {
    throw new Error('the sweep did not persist and summarize every planned sample');
  }
  return {
    outcomes: loopRunner.outcomes,
    sandboxJobs: loopRunner.sandboxJobs,
    controlRequests: control?.requests ?? [],
    judgeRequests: judge?.requests ?? [],
    records: parsed.records,
    arm,
  };
}

/** Both sides of one controlled pair. */
interface Pair {
  readonly fallback: PairSide;
  readonly noGate: PairSide;
}

/** The same sample, falling back by `set`'s route on one side and with no Formal_Gate on the other. */
async function sweepPair(row: ScenarioRow, set: FallbackSet): Promise<Pair> {
  const fixture = pairFixture();
  const fallback = await sweepSide(fixture, row, fallingBackGate(set));
  const noGate = await sweepSide(fixture, row, null);
  return { fallback, noGate };
}

/** A shallow copy of `value` without the named keys, so no destructured binding goes unused. */
function withoutKeys(value: object, keys: readonly string[]): Record<string, unknown> {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}

/** The record's formal fields: the ONLY ones the two sides of a pair may disagree on. */
const RECORD_FORMAL_FIELDS = [
  'formal',
  'formalFallbackReason',
  'formalFallbackRoute',
  'formalResetContract',
  'formalAssertionGateEmitted',
  'formalClockPolarity',
] as const satisfies readonly (keyof SweepSampleRecord)[];

/**
 * A terminal outcome without its formal record and its per-run ids.
 *
 * `result.id` and every span id are minted per run - a fresh ULID, a fresh Trace span - so two
 * behaviourally identical runs never share them, whatever the gate did.
 */
function comparableOutcome(outcome: VerificationOutcome): Record<string, unknown> {
  const view = withoutKeys(outcome, ['formal', 'oracleSpanId']);
  if ('result' in outcome) {
    view.result = withoutKeys(outcome.result, ['id', 'oracleSpanId']);
  }
  if ('label' in outcome) {
    view.label = withoutKeys(outcome.label, ['oracleSpanRef']);
  }
  return view;
}

/** Req 7.12 over one pair: every rule was given the same inputs on both sides and decided alike. */
function assertNoRuleRelaxed(fallback: PairSide, noGate: PairSide): void {
  // INSTRUMENT RULES: the precheck build and every simulate run the Simulator submitted, then
  // what the loop decided from them - including every incomplete-evidence and testbench refusal.
  expect(fallback.sandboxJobs).toEqual(noGate.sandboxJobs);
  expect(fallback.outcomes.map(comparableOutcome)).toEqual(noGate.outcomes.map(comparableOutcome));
  // CONTROL RULES: what the Positive_Control and the Negative_Control were asked, in-loop and
  // after it; what they answered is persisted on the records compared below.
  expect(fallback.controlRequests).toEqual(noGate.controlRequests);
  // DENOMINATOR PREDICATES: what the golden judge was asked, every persisted field either
  // denominator reads, then both denominators, both estimates, and both exclusion tallies.
  expect(fallback.judgeRequests).toEqual(noGate.judgeRequests);
  expect(fallback.records.map((record) => withoutKeys(record, RECORD_FORMAL_FIELDS))).toEqual(
    noGate.records.map((record) => withoutKeys(record, RECORD_FORMAL_FIELDS)),
  );
  expect(withoutKeys(fallback.arm, ['formal'])).toEqual(withoutKeys(noGate.arm, ['formal']));
}

/**
 * The pair is CONTROLLED: the subject fell back, for the route's reason, on the gated side only;
 * and both anchors sit in the pass@k denominator, and in the golden one wherever a judge is wired,
 * so every membership decision about the subject moves an estimate.
 */
function assertPairIsControlled(pair: Pair, row: ScenarioRow, set: FallbackSet): void {
  const fallen = pair.fallback.records[SUBJECT_INDEX];
  const plain = pair.noGate.records[SUBJECT_INDEX];
  expect(fallen?.formalFallbackReason).toBe(reasonOf(set));
  expect(fallen?.formalFallbackRoute).toBe(routeImpliedBy(reasonOf(set)));
  expect(pair.fallback.arm.formal.fallbackSamples).toBe(1);
  expect(plain?.formal).toBeNull();
  expect(plain?.formalFallbackReason).toBeNull();
  expect(plain?.formalFallbackRoute).toBe(routeImpliedBy(null));
  expect(pair.noGate.arm.formal.fallbackSamples).toBe(0);
  expect(pair.noGate.arm.efficiency.population.samples).toBeGreaterThanOrEqual(ANCHOR_COUNT);
  if (row.golden.kind !== 'not-wired') {
    expect(pair.noGate.arm.goldenReport.judgedSamples).toBeGreaterThanOrEqual(ANCHOR_COUNT);
  }
}

/** What the exhausted rows showed about the subject, so each denominator decision is seen both ways. */
class RowCoverage {
  readonly statuses = new Set<SweepSampleRecord['outcomeStatus']>();
  readonly validities = new Set<InstrumentValidity>();
  readonly inPassAtK = new Set<boolean>();
  readonly inGolden = new Set<boolean>();
  readonly mutationRecorded = new Set<boolean>();
  readonly passAtKValidated = new Set<boolean>();
  readonly fallbackReasons = new Set<CouldNotVerifyCause | null>();

  add(pair: Pair, row: ScenarioRow): void {
    const subject = pair.noGate.records[SUBJECT_INDEX];
    if (subject === undefined) {
      throw new Error('the pair recorded no subject');
    }
    const { arm } = pair.noGate;
    const anchorsJudged = row.golden.kind === 'not-wired' ? 0 : ANCHOR_COUNT;
    this.statuses.add(subject.outcomeStatus);
    this.validities.add(subject.instrumentValidity);
    // Read off the SUMMARY's own denominators, which hold both anchors whatever the subject did.
    this.inPassAtK.add(arm.efficiency.population.samples > ANCHOR_COUNT);
    this.inGolden.add(arm.goldenReport.judgedSamples > anchorsJudged);
    this.mutationRecorded.add(subject.mutation !== null);
    this.passAtKValidated.add(arm.passAtKValidated);
    this.fallbackReasons.add(pair.fallback.records[SUBJECT_INDEX]?.formalFallbackReason ?? null);
  }
}

/** A random cross of the closed tables, built with `map` so the row is a plain object. */
function arbScenarioRow(): fc.Arbitrary<ScenarioRow> {
  return fc
    .tuple(
      fc.constantFrom(...TRAJECTORIES),
      fc.constantFrom(...CONTROL_ROWS),
      fc.constantFrom(...GOLDEN_ROWS),
    )
    .map(([trajectory, control, golden]) => ({ trajectory, control, golden }));
}

/**
 * A generated falling-back set: proofs BEFORE the deciding `could-not-verify` run (weight 2 of 3
 * non-empty), so that run is the first one and its cause the Fallback_Reason, then any mix after.
 */
function arbFallbackSet(): fc.Arbitrary<FallbackSet> {
  const proofsBefore = fc.oneof(
    { weight: 1, arbitrary: fc.constant<readonly FormalRun[]>([]) },
    { weight: 2, arbitrary: runsOf(PROVED_RUN, [1, 2]) },
  );
  const results = fc
    .tuple(
      proofsBefore,
      COULD_NOT_VERIFY_RUN,
      runsOf(fc.oneof(PROVED_RUN, COULD_NOT_VERIFY_RUN), [0, 1, 2]),
    )
    .map(([before, deciding, after]): FallbackSet => ({
      mode: 'results',
      runs: [...before, deciding, ...after],
      reason: deciding.verdict,
    }));
  const oracleThrows = fc
    .constantFrom(1, 2, 3)
    .map((propertyCount): FallbackSet => ({ mode: 'oracle-throws', propertyCount }));
  return fc.oneof(
    { weight: 4, arbitrary: results },
    { weight: 1, arbitrary: oracleThrows },
    { weight: 1, arbitrary: fc.constant<FallbackSet>({ mode: 'source-throws' }) },
  );
}

describe(PROPERTY, () => {
  it("charges every formal run, as one iteration and its elapsed time, to the sample's own budget (Req 7.11)", async () => {
    const multiRunSets = new Set<FormalDecision>();
    const zeroMsRuns = new Set<FormalDecision>();
    for (const decision of FORMAL_DECISIONS) {
      await fc.assert(
        fc.asyncProperty(arbRunsDecidedAs(decision), async (runs) => {
          const observed = await runBudgetCase(runs);

          // The case really took the path its decision names: only a fall back simulates.
          expect(observed.status).toBe(DECIDED_STATUS[decision]);
          expect(observed.simulateWallMs).toHaveLength(decision === 'falls-back' ? 1 : 0);
          assertEveryFormalRunCharged(observed, runs);

          if (runs.length > 1) multiRunSets.add(decision);
          if (runs.some((run) => run.elapsedMs === 0)) zeroMsRuns.add(decision);
        }),
        propertyParameters(),
      );
    }
    // Non-vacuity, per decision: a set of several runs (a loop charging only the first would
    // pass a one-run set) and a run reporting 0 ms (only the iteration count can catch it).
    expect(multiRunSets).toEqual(new Set(FORMAL_DECISIONS));
    expect(zeroMsRuns).toEqual(new Set(FORMAL_DECISIONS));
  });

  it(
    'applies the same instrument rules, control rules, and denominators to a fallback sample ' +
      'as to one no gate ran on, over every closed row (Req 7.12)',
    async () => {
      const coverage = new RowCoverage();
      for (const row of CLOSED_ROWS) {
        const pair = await sweepPair(row, row.fallback);
        assertNoRuleRelaxed(pair.fallback, pair.noGate);
        assertPairIsControlled(pair, row, row.fallback);
        coverage.add(pair, row);
      }

      // Every member of every closed table was graded: the zip reaches each one.
      expect(new Set(CLOSED_ROWS.map((row) => row.trajectory)).size).toBe(TRAJECTORIES.length);
      expect(new Set(CLOSED_ROWS.map((row) => row.control)).size).toBe(CONTROL_ROWS.length);
      expect(new Set(CLOSED_ROWS.map((row) => row.golden)).size).toBe(GOLDEN_ROWS.length);
      expect(new Set(CLOSED_ROWS.map((row) => row.fallback)).size).toBe(FALLBACK_SETS.length);
      // And the conjunctions the denominators need were each seen both ways.
      expect(coverage.statuses).toEqual(new Set(['verified', 'unverified', 'instrument-refused']));
      expect(coverage.validities).toEqual(new Set(['valid', 'invalid', 'unchecked']));
      expect(coverage.inPassAtK).toEqual(new Set([true, false]));
      expect(coverage.inGolden).toEqual(new Set([true, false]));
      expect(coverage.mutationRecorded).toEqual(new Set([true, false]));
      expect(coverage.passAtKValidated).toEqual(new Set([true, false]));
      expect(coverage.fallbackReasons).toEqual(new Set(COULD_NOT_VERIFY_CAUSES));
    },
    SWEEP_TEST_TIMEOUT_MS,
  );

  it(
    'applies the same rules over the full cross of the closed tables with a generated ' +
      'falling-back set (Req 7.12)',
    async () => {
      let mixedSets = 0;
      await fc.assert(
        fc.asyncProperty(arbScenarioRow(), arbFallbackSet(), async (row, set) => {
          const pair = await sweepPair(row, set);
          assertNoRuleRelaxed(pair.fallback, pair.noGate);
          assertPairIsControlled(pair, row, set);
          if (set.mode === 'results' && set.runs.some((run) => run.verdict === 'proved')) {
            mixedSets += 1;
          }
        }),
        propertyParameters(),
      );
      // Non-vacuity: a set mixing proofs with the deciding could-not-verify was drawn.
      expect(mixedSets).toBeGreaterThan(0);
    },
    SWEEP_TEST_TIMEOUT_MS,
  );
});
