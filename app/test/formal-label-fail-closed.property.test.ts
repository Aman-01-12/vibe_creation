// formal-property-oracle, Property 19: Could-not-verify never becomes Verified and never renders as
// verified (task 8.6).
//
// WHERE A FORMAL_VERDICT BECOMES A TRUST TIER
//   Not inside the Trust_Labeler. `oracleTrustLabeler` (`labelArtifact`, `app/core/trust`) takes
//   recorded oracle EVIDENCE - an `OracleVerdictSpan` or a `VerificationResult` - and has no
//   Formal_Verdict input at all. The translation is the Verification_Loop's formal-first gate,
//   `#runFormalGate` in `app/agent/orchestrator/verification-loop.ts`: only an all-`proved` set
//   reaches `#onPass`, which builds a passing `VerificationResult` bound to the recorded
//   `Formal_Oracle` span and asks the labeler for the label; a set holding a `refuted` is labelled
//   `Unverified` without asking it; any other set decides nothing, and the Simulation_Fallback
//   labels the sample from its OWN span. So the subject here is the REAL `VerificationLoop` wired to
//   the REAL `oracleTrustLabeler`, with a scripted `FormalOraclePort` standing in for the toolchain
//   and the real `IcarusSimulatorAdapter`, over a scripted sandbox, standing in for iverilog.
//
// WHERE A VERDICT OR A TIER RENDERS, AND WHAT "RENDERS" COVERS HERE
//   NO RENDERING OF A FORMAL_VERDICT EXISTS: `app/web` and `app/api` hold no reference to one, and
//   the loop's progress events are not wired to the gateway. Two rendering surfaces exist that a
//   formal verdict reaches, and each is asserted for the half of criterion 1.13 it can carry:
//   - THE DISPLAY_LAYER'S TRUST TREATMENT (`createDisplayLayer` over `decideTrustTreatment` in
//     `app/web/display`), which maps a label's TIER through the core's injective
//     `TRUST_TIER_TREATMENTS` behind a provenance check. Asserted: rendered on the formal run's OWN
//     evidence - its recorded span handed over as a PASSING span, the most any projection of that run
//     could contribute - the `Verified` treatment appears iff every property proved, so a
//     `could-not-verify` never puts it on screen.
//   - THE SESSION HISTORY (`getHistory` over `renderHistory` in `app/agent/action-recorder`), the
//     ordered, human-readable step list its own header says the Editor can show a Student, and the
//     one surface that names a Formal_Verdict and its cause (Req 1.19). The `Formal_Oracle` step is
//     a function of the WHOLE set - the count under each verdict plus every `could-not-verify`
//     cause in words - so NO SINGLE REFERENCE STRING can stand for "a refuted step":
//     `[could-not-verify, refuted]` holds a refutation and renders differently from `[refuted]`.
//     It is therefore asserted PIECE BY PIECE. Over the whole set: the count the step reports
//     before each verdict's words is the count the set holds, and those words are absent where it
//     holds none; each cause's phrase is present iff the set holds that cause, and reads after the
//     `could not verify` words it belongs to. And where the set holds any `could-not-verify`, the
//     step is not `completed` and does not read as verified. The expected words and phrases are
//     spelled in THIS file (`EXPECTED_VERDICT_WORDS`, `EXPECTED_CAUSE_PHRASES`), each total over its
//     closed vocabulary, so the test is an oracle for the wording and not a copy of the table it
//     checks: rewording a Student-facing phrase is a deliberate change to both files.
//   REQ 1.20 (an unreadable formal span renders as unreadable, never `completed`) IS NOT REACHED
//   HERE. This property drives the real loop, which only ever records a readable span, so no
//   generated case can be unreadable. The four ways the read fails - no property list, a verdict
//   outside the vocabulary, a cause outside it, and a `could-not-verify` with no cause - are pinned
//   by the second example test in `app/test/action-recorder.test.ts` ("formal gate step rendering").
//   NOT COVERED, because nothing renders it: the Display_Layer's own rendering of a Formal_Verdict
//   (Req 1.13's Display_Layer scope is deferred to the first UI spec that renders one). At the
//   treatment layer `refuted` and `could-not-verify` both land on `unverified-treatment` whenever
//   the fallback does not pass - design.md forbids the fourth `TrustTier` that could separate them -
//   so the distinction between them is carried by the history step above, beside the tier. The one
//   other place a verdict IS printed by name is the eval sweep summary's operator-facing
//   `formal verdict:` line (`app/eval/sweep/summary.ts`, pinned by `summary.test.ts`), which is a
//   measurement report rather than the student-facing surface, so it is not re-asserted here.
//
// THE VOCABULARIES ARE EXHAUSTED, NOT SAMPLED
//   Every Formal_Verdict and every Could_Not_Verify_Cause runs as a one-property set under BOTH
//   simulator behaviours, and every cause runs both AHEAD of and BEHIND a refutation under a
//   simulator that would pass - the shape a passing fallback would mislabel `Verified` (Req 7.17).
//   Every ordered PAIR of causes runs too, so a cause the history drops or misattributes beside
//   another is met on every combination rather than on whichever ones a sample reached.
//   The atoms are read off `FORMAL_VERDICTS` and `COULD_NOT_VERIFY_CAUSES`, so a new member arrives
//   here on its own, and a new verdict fails to compile in `resultFor`
//   (`chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`).
//   fast-check covers the open part: mixed sets of up to four, in every order.
//
// WHAT THIS LEANS ON AND DOES NOT RE-ASSERT
//   - `app/agent/orchestrator/verification-loop.test.ts`: one fixed example of each route.
//   - `display-layer-fail-closed.property.test.ts` (hdl-creation-loop Property 2): the provenance
//     check over arbitrary untrusted labels. Here it is only ever handed the real loop's label.
//   - `trust-labeler.test.ts`: `TRUST_TIER_TREATMENTS` is injective and reserves the `Verified`
//     treatment, which is why `isVerifiedTreatment` is the right question to ask of a treatment.
//
// FALSIFIED, out of tree, against one-line mutants of the BUILT loop and Display_Layer
// (`chipAgent/_inbox/verification-recipe-falsify-a-test-against-a-one-line-mutant-of-the-built-dist-without-touching-shared-source.md`):
// ignoring the refutation, or the `could-not-verify`, in `#runFormalGate` failed both claims on a
// one-property exhaustive case; deciding by the FIRST non-`proved` verdict failed the tier claim on
// the exhaustive `[could-not-verify, refuted]` pair alone; recording any non-`proved` run as a
// functional failure failed the history half; and dropping the span-id match from the
// Display_Layer's evidence check failed the treatment half. The unmutated copies passed.
//
// THE PIECE-WISE HISTORY CLAUSE (task 23.2) was falsified the same way, against one-line mutants of
// the BUILT `action-recorder/history.js` redirected in through a vite `resolveId` plugin scoped to
// the recorder that imports it: rendering a `could-not-verify` set as `completed` failed the count
// piece on the one-property `[could-not-verify]` case; dropping every cause phrase failed the cause
// piece on that same case; and printing a count of 1 under every verdict failed the count piece on
// the exhaustive `[could-not-verify, could-not-verify]` pair. In all three the other three tests
// stayed green, so this clause is the only thing that catches them. The unmutated copy
// passed. The last describe block below keeps the first two as a standing check that
// `expectStepCarriesTheSet` can fail, over a stand-in renderer and with no mutated file.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 1.12, 1.13, 1.19**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TraceActionRecorder,
  VerificationLoop,
  type CandidateEval,
  type CandidateFailure,
  type CandidateGenerator,
  type ConfirmedGenerationContext,
  type FormalPropertySet,
  type GeneratedCandidate,
  type GenerateTestbenchRequest,
  type GenerationAdmissionRequest,
  type GenerationContextOpener,
  type GenerationGateRefusal,
  type GenerationInput,
  type HistoryEntry,
  type IndependentTestbenchGenerator,
  type PropertySetSource,
  type RepairTestbenchRequest,
  type SessionBudgetHandle,
  type TestbenchGenerationOutcome,
  type VerificationOutcome,
} from '@app/agent';
import {
  err,
  isVerifiedTreatment,
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type LabeledArtifact,
  type OracleVerdictSpan,
  type Result,
  type Spec,
  type Testbench,
  type TraceSpan,
  type TrustTreatment,
} from '@app/core';
import {
  admitProved,
  COULD_NOT_VERIFY_CAUSES,
  FakeSandboxRuntime,
  FORMAL_VERDICTS,
  IcarusSimulatorAdapter,
  refusedWithoutProof,
  SandboxToolRunner,
  validateExpression,
  type ArtifactBlobRef,
  type CouldNotVerifyCause,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProperty,
  type FormalProveRequest,
  type FormalProveSetRequest,
  type FormalVerdict,
  type ProofConditions,
  type PropertyResult,
  type ProvedEvidence,
  type RawRunCapture,
  type ResourceLimits,
  type SandboxJob,
} from '@app/tools';
import { createDisplayLayer } from '@app/web';

import { propertyParameters } from './property.js';
import { timingContractFor } from '@app/test';

// **Feature: formal-property-oracle, Property 19: Could-not-verify never becomes Verified and never
// renders as verified**
const PROPERTY_19 =
  'formal-property-oracle, Property 19: Could-not-verify never becomes Verified and never renders as verified';

/** Headroom for a few-hundred-run async property driving the whole loop; nothing depends on it. */
const SLOW_PROPERTY_TIMEOUT_MS = 60_000;

const LIMITS: ResourceLimits = Object.freeze({
  cpu: 1,
  memMb: 256,
  procs: 64,
  diskMb: 64,
  wallMs: 5_000,
});

/** The admission request. The gate double below ignores it, so its shape is never read. */
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/** The Testbench_Precheck's own stub filename, so its build check is told apart from a run. */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

/** The Trace stage the loop records one formal gate run under. */
const FORMAL_STAGE = 'Formal_Oracle';

/** The largest generated Property_Set. */
const MAX_SET_SIZE = 4;

/** The counterexample a refuted result carries (Req 1.10). Nothing reads its bytes. */
const COUNTEREXAMPLE: ArtifactBlobRef = Object.freeze({
  name: 'counterexample.vcd',
  sizeBytes: 24,
  sha256: 'c'.repeat(64),
});

/** The depth and elapsed time every scripted result reports; neither decides a label. */
const SCRIPTED_DEPTH = 20;
const SCRIPTED_ELAPSED_MS = 10;

/** The conditions a refutation was reported over: the base case FAILED beside a passing presat. */
const REFUTED_CONDITIONS: ProofConditions = Object.freeze<ProofConditions>({
  assertionCount: 2,
  presat: 'satisfiable',
  cover: { reached: 'not-applicable' },
  base: 'failed',
  induction: 'not-run',
});

/** The one value a `proved` result can be built from, through its sole constructor. */
function provedEvidence(): ProvedEvidence {
  const admitted = admitProved({
    assertionCount: 2,
    presat: 'satisfiable',
    cover: { reached: 'not-applicable' },
    base: 'passed',
    induction: 'successful',
  });
  if (typeof admitted === 'string') {
    throw new Error(`the proving fixture was refused as ${admitted}`);
  }
  return admitted;
}

const PROVED_EVIDENCE = provedEvidence();

// ---------------------------------------------------------------------------
// The verdict atoms, read off the two closed vocabularies
// ---------------------------------------------------------------------------

/** One property's scripted verdict, carrying the cause where the verdict carries one. */
type ScriptedVerdict =
  | { readonly verdict: Exclude<FormalVerdict, 'could-not-verify'> }
  | { readonly verdict: 'could-not-verify'; readonly cause: CouldNotVerifyCause };

/** Every atom of one verdict: the verdict alone, or once per cause for `could-not-verify`. */
function atomsOf(verdict: FormalVerdict): readonly ScriptedVerdict[] {
  return verdict === 'could-not-verify'
    ? COULD_NOT_VERIFY_CAUSES.map((cause): ScriptedVerdict => ({
        verdict: 'could-not-verify',
        cause,
      }))
    : [{ verdict }];
}

/** Every verdict atom: each Formal_Verdict, and `could-not-verify` once per cause. */
const VERDICT_ATOMS: readonly ScriptedVerdict[] = Object.freeze(FORMAL_VERDICTS.flatMap(atomsOf));

/** A validated combinational property naming the criterion at `position`. Its text decides nothing. */
function propertyAt(position: number): FormalProperty {
  const consequent = validateExpression('q == d');
  if (!consequent.ok) {
    throw new Error('the fixture expression was refused by the validator');
  }
  return {
    kind: 'combinational',
    id: `p${position + 1}`,
    criterionRef: `AC-${position + 1}`,
    consequent: consequent.value,
  };
}

/**
 * The `PropertyResult` the scripted oracle reports for one property.
 *
 * `proved` is built from `admitProved`'s evidence and `could-not-verify` through
 * `refusedWithoutProof`, the owners of those two shapes; `refuted` carries its counterexample. A
 * fourth Formal_Verdict is a compile error at the `never` below rather than an ungenerated case.
 */
function resultFor(scripted: ScriptedVerdict, property: FormalProperty): PropertyResult {
  const run = { depth: SCRIPTED_DEPTH, elapsedMs: SCRIPTED_ELAPSED_MS };
  switch (scripted.verdict) {
    case 'proved':
      return {
        verdict: 'proved',
        evidence: PROVED_EVIDENCE,
        ...run,
        criterionRef: property.criterionRef,
      };
    case 'refuted':
      return {
        verdict: 'refuted',
        counterexample: COUNTEREXAMPLE,
        conditions: REFUTED_CONDITIONS,
        ...run,
        criterionRef: property.criterionRef,
      };
    case 'could-not-verify':
      return refusedWithoutProof(scripted.cause, property, run, '');
    default: {
      const unreachable: never = scripted;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// The loop's collaborators: the real loop, labeler, simulator adapter, and recorder
// ---------------------------------------------------------------------------

/** An approved single-module Spec with one simulation-verifiable acceptance criterion. */
function approvedSpec(): Spec {
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: 'byte_reg',
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
      moduleName: 'byte_reg',
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    },
    acceptanceCriteria: [
      { id: newUlid(), text: 'q captures d', measurable: true, method: 'simulation' },
    ],
    architecture: 'Single always block latching d into q.',
    approved: true,
    version: 1,
  };
}

/** A generated candidate whose label carries a fresh module-version ref. */
function candidateFor(spec: Spec): GeneratedCandidate {
  const id = newUlid();
  const rtl = 'module byte_reg; endmodule';
  const artifactRef: ArtifactRef = { kind: 'module-version', id, version: 1 };
  return {
    rtl,
    parsedInterface: { moduleName: 'byte_reg', ports: [] },
    interfaceMatch: {
      matches: true,
      moduleNameMatches: true,
      expectedModuleName: 'byte_reg',
      actualModuleName: 'byte_reg',
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

/** A Testbench derived from the Spec, attributed to the Spec version. */
function testbenchFor(spec: Spec): Testbench {
  return {
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source: 'module byte_reg_tb; endmodule',
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

/** A gate opener that always admits with the given context. */
class AdmittingGate implements GenerationContextOpener {
  readonly #context: ConfirmedGenerationContext;

  constructor(context: ConfirmedGenerationContext) {
    this.#context = context;
  }

  openGenerationContext(): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>> {
    return Promise.resolve(ok(this.#context));
  }
}

/**
 * One candidate, and no revision ever.
 *
 * A failing simulation therefore ends the run on its first iteration, so the label a case gets is
 * decided by the formal gate or by ONE simulation verdict and by nothing else.
 */
class OneCandidateGenerator implements CandidateGenerator {
  readonly #candidate: GeneratedCandidate;

  constructor(spec: Spec) {
    this.#candidate = candidateFor(spec);
  }

  generateCandidate(
    _input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(ok({ candidate: this.#candidate, interfaceDiagnostics: '' }));
  }

  reviseFromErrors(
    _input: GenerationInput,
    _previousRtl: string,
    _diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(
      err({ reason: 'model-unavailable', detail: 'this double never revises' }),
    );
  }
}

/** A Testbench_Agent double that produces one Testbench and never repairs it. */
class OneTestbench implements IndependentTestbenchGenerator {
  readonly #spec: Spec;

  constructor(spec: Spec) {
    this.#spec = spec;
  }

  generateTestbench(
    _request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench: testbenchFor(this.#spec),
      checks: [],
    });
  }

  repairTestbench(
    _request: RepairTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generation-failed',
      failure: { reason: 'model-call-failed', detail: 'this double never repairs' },
    });
  }
}

/** A formal oracle double reporting one scripted result per submitted property, in order. */
class ScriptedFormalOracle implements FormalOraclePort {
  readonly #results: readonly PropertyResult[];

  constructor(results: readonly PropertyResult[]) {
    this.#results = results;
  }

  proveSet(request: FormalProveSetRequest): Promise<FormalOutcome> {
    return Promise.resolve({
      results: this.#results,
      propertyWrapperSources: request.properties.map(
        (property) => `module formal_property_wrapper; // ${property.id}\nendmodule\n`,
      ),
      // The double resolves no artifact reference, so no property carries a trace.
      counterexampleCaptures: this.#results.map(() => null),
      resetContract: {
        derived: true,
        resetName: 'rst_n',
        resetActiveLow: true,
        resetKind: 'async',
        initialStateFree: true,
      },
      assertionGateEmitted: false,
      clockPolarity: 'posedge',
    });
  }

  /** The one-element-set delegation the port obliges every implementation to. */
  async prove(request: FormalProveRequest): Promise<PropertyResult> {
    const outcome = await this.proveSet({
      designSource: request.designSource,
      designInterface: request.designInterface,
      properties: [request.property],
      budgetMs: request.budgetMs,
    });
    const [result] = outcome.results;
    if (result === undefined) {
      throw new Error('the scripted oracle holds no result for this property');
    }
    return result;
  }
}

/** A Property_Set source returning one fixed set, already past any admission gate. */
class FixedPropertySet implements PropertySetSource {
  readonly #set: FormalPropertySet;

  constructor(properties: readonly FormalProperty[]) {
    this.#set = { properties, unexpressedCriteria: [], propertySetAdmitted: 'not-gated' };
  }

  propertySetFor(): Promise<FormalPropertySet> {
    return Promise.resolve(this.#set);
  }
}

/** A raw capture whose testbench reported its check with the given result, beside a VCD. */
function checkCapture(result: 'PASS' | 'FAIL'): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: `CHECK q_captures_d ${result}\n`,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: { wallMs: 12, maxMemMb: 8, cpuMs: 10 },
  };
}

/** Whether a sandbox job is the Testbench_Precheck's own build check, not an iteration. */
function isPrecheckJob(job: SandboxJob): boolean {
  return job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH);
}

/** A budget generous enough that no cap ends a run before its first simulate verdict. */
function generousBudget(): InMemorySessionBudgetHandle {
  return new InMemorySessionBudgetHandle({
    sessionId: newUlid(),
    maxIterations: 20,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
}

// ---------------------------------------------------------------------------
// One case, run through the real loop
// ---------------------------------------------------------------------------

/** What the simulation would say, if the loop ever asks it. */
type SimulationBehaviour = 'passes' | 'fails';

const SIMULATION_BEHAVIOURS: readonly SimulationBehaviour[] = Object.freeze(['passes', 'fails']);

/** One case: the verdict each submitted property gets, and what the simulation would say. */
interface LabelCase {
  readonly verdicts: readonly ScriptedVerdict[];
  readonly simulation: SimulationBehaviour;
}

/** What the product made of one case: its label, the formal run's span, and its history. */
interface LabelObservation {
  readonly label: LabeledArtifact;
  readonly formalSpan: TraceSpan;
  readonly history: readonly HistoryEntry[];
}

/** The label of an outcome that reached the formal gate. Any other outcome is a broken fixture. */
function labelOf(outcome: VerificationOutcome): LabeledArtifact {
  if (outcome.status === 'blocked' || outcome.status === 'setup-failed') {
    throw new Error(`the fixture never reached the formal gate: ${outcome.status}`);
  }
  return outcome.label;
}

/** The ONE span the loop records for a formal gate run. */
function onlyFormalSpan(spans: readonly TraceSpan[]): TraceSpan {
  const [formalSpan, ...others] = spans.filter((span) => span.stageOrTool === FORMAL_STAGE);
  if (formalSpan === undefined || others.length > 0) {
    throw new Error('a gate run over a non-empty Property_Set records exactly one formal span');
  }
  return formalSpan;
}

/** Run one case through the real loop and read back what it labelled and what it recorded. */
async function observe(c: LabelCase): Promise<LabelObservation> {
  const spec = approvedSpec();
  const context = confirmedContext(spec);
  const properties = c.verdicts.map((_, position) => propertyAt(position));
  const results = c.verdicts.map((scripted, position) => resultFor(scripted, propertyAt(position)));
  const iteration = checkCapture(c.simulation === 'passes' ? 'PASS' : 'FAIL');
  const runtime = new FakeSandboxRuntime((job) =>
    isPrecheckJob(job) ? checkCapture('PASS') : iteration,
  );
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const loop = new VerificationLoop({
    gate: new AdmittingGate(context),
    generator: new OneCandidateGenerator(spec),
    testbench: new OneTestbench(spec),
    simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(runtime)),
    recorder,
    trustLabeler: oracleTrustLabeler,
    formal: {
      oracle: new ScriptedFormalOracle(results),
      properties: new FixedPropertySet(properties),
    },
  });
  const outcome = await loop.verify(REQUEST, generousBudget(), LIMITS);
  const trace = await recorder.getTrace(context.sessionId);
  return {
    label: labelOf(outcome),
    formalSpan: onlyFormalSpan(trace.spans),
    history: await recorder.getHistory(context.sessionId),
  };
}

/** The verdicts of one case, without their causes. */
function verdictsOf(c: LabelCase): readonly FormalVerdict[] {
  return c.verdicts.map((scripted) => scripted.verdict);
}

/** Whether every submitted property was proved, which is the one set the formal run may label. */
function everyProved(c: LabelCase): boolean {
  return verdictsOf(c).every((verdict) => verdict === 'proved');
}

/** The cause of every `could-not-verify` property of one case, in submission order. */
function causesOf(c: LabelCase): readonly CouldNotVerifyCause[] {
  return c.verdicts.flatMap((scripted) =>
    scripted.verdict === 'could-not-verify' ? [scripted.cause] : [],
  );
}

/** A short, reproducible description of a case for a failure message. */
function describeCase(c: LabelCase): string {
  return JSON.stringify(c);
}

// ---------------------------------------------------------------------------
// The two claims
// ---------------------------------------------------------------------------

/**
 * Clause 1, the tier (Req 1.12).
 *
 * The formal run backs a `Verified` label iff every property proved - both directions, so a loop
 * that never labels anything `Verified` fails as surely as one that labels too much. A set holding
 * a refutation is never `Verified`, even beside a simulator that would pass (Req 7.17 names that
 * direction). And where the simulation cannot pass, `Verified` occurs iff every property proved.
 */
function expectTierFailsClosed(c: LabelCase, observed: LabelObservation): void {
  const { label } = observed;
  const boundToFormalRun =
    label.tier === 'Verified' && label.oracleSpanRef === observed.formalSpan.id;
  expect(boundToFormalRun, describeCase(c)).toBe(everyProved(c));
  if (verdictsOf(c).includes('refuted')) {
    expect(label.tier, describeCase(c)).not.toBe('Verified');
  }
  if (c.simulation === 'fails') {
    expect(label.tier === 'Verified', describeCase(c)).toBe(everyProved(c));
  }
}

/**
 * The treatment the Display_Layer renders for the label on the formal run's OWN evidence.
 *
 * The recorded formal span is handed over as a PASSING span for the candidate, whatever the run
 * decided - the most any projection of that run could ever contribute - so the only thing standing
 * between a non-proved verdict and the `Verified` treatment is the label the loop derived.
 * Discrepancies are another property's subject, so the port discards them.
 */
function treatmentOnFormalEvidence(observed: LabelObservation): TrustTreatment {
  const evidence: readonly OracleVerdictSpan[] = [
    { spanId: observed.formalSpan.id, artifactRef: observed.label.artifactRef, verdict: 'pass' },
  ];
  const display = createDisplayLayer({ emit: () => undefined });
  return display.resolveTreatment(observed.label, evidence).treatment;
}

/** The rendered history result of the formal step, or `null` where the history holds none. */
function formalStepResult(observed: LabelObservation): string | null {
  return observed.history.find((entry) => entry.step === FORMAL_STAGE)?.result ?? null;
}

/**
 * Each Formal_Verdict in the words Requirement 1.19 has the Session_History render, total over the
 * closed vocabulary: a fourth verdict is a compile error here rather than an unchecked count.
 */
const EXPECTED_VERDICT_WORDS = Object.freeze({
  proved: 'proved',
  refuted: 'refuted',
  'could-not-verify': 'could not verify',
} satisfies Record<FormalVerdict, string>);

/**
 * Each Could_Not_Verify_Cause in the words a Student reads, total over the closed vocabulary: a
 * twelfth cause is a compile error here, exactly as it is in the renderer, rather than a cause
 * whose absence from the step goes unchecked.
 */
const EXPECTED_CAUSE_PHRASES = Object.freeze({
  'zero-assertions': 'no assertion reached the solver',
  'frontend-rejected': 'the design could not be read',
  'property-build-failed': 'the property did not build',
  'contradictory-assumptions': 'the assumptions cannot all hold at once',
  'antecedent-unreached': 'the property was never triggered',
  'induction-inconclusive': 'the proof needs more depth',
  'induction-engine-incomplete': 'the proof did not settle',
  'reset-contract-unresolved': 'the reset behaviour could not be established',
  'clock-contract-unsupported': 'this clocking cannot be checked faithfully',
  'proof-timeout': 'proof timed out',
  'toolchain-unavailable': 'the proof tool gave no usable answer',
} satisfies Record<CouldNotVerifyCause, string>);

/**
 * Every count the step reports directly before `words`, in reading order.
 *
 * `words` is one of the fixed `EXPECTED_VERDICT_WORDS`, never recorded text, so building the
 * pattern from it is not a route for untrusted input.
 */
function countsReportedBefore(step: string, words: string): readonly number[] {
  return Array.from(step.matchAll(new RegExp(`(\\d+) ${words}`, 'g')), (match) => Number(match[1]));
}

/** The count under each verdict is the count the set holds, and the words are absent at zero. */
function expectCountsMatchTheSet(c: LabelCase, step: string, because: string): void {
  for (const verdict of FORMAL_VERDICTS) {
    const held = verdictsOf(c).filter((member) => member === verdict).length;
    expect(countsReportedBefore(step, EXPECTED_VERDICT_WORDS[verdict]), because).toEqual(
      held === 0 ? [] : [held],
    );
  }
}

/**
 * A cause's phrase is in the step iff the set holds that cause, and it reads after the
 * `could not verify` words it belongs to, so a cause is never attributed to another verdict.
 */
function expectCausesMatchTheSet(c: LabelCase, step: string, because: string): void {
  const held = causesOf(c);
  const verdictAt = step.indexOf(EXPECTED_VERDICT_WORDS['could-not-verify']);
  for (const cause of COULD_NOT_VERIFY_CAUSES) {
    const phrase = EXPECTED_CAUSE_PHRASES[cause];
    expect(step.includes(phrase), because).toBe(held.includes(cause));
    if (held.includes(cause)) {
      expect(step.indexOf(phrase), because).toBeGreaterThan(verdictAt);
    }
  }
}

/** A step whose set holds a `could-not-verify` is neither `completed` nor read as verified. */
function expectNotCompletedNorVerified(c: LabelCase, step: string, because: string): void {
  if (!verdictsOf(c).includes('could-not-verify')) {
    return;
  }
  expect(step, because).not.toBe('completed');
  expect(step, because).not.toMatch(/\bverified\b/i);
}

/**
 * Clause 2b, the Session_History's step for a formal run, read PIECE BY PIECE (Req 1.19).
 *
 * Taking the rendered step as a string, so it can be fed a stand-in renderer as readily as the
 * product's, and never comparing it against a reference string: the step is a function of the
 * whole set, so two sets that both hold a refutation legitimately render differently.
 */
function expectStepCarriesTheSet(c: LabelCase, step: string): void {
  const because = `${describeCase(c)} rendered as ${JSON.stringify(step)}`;
  expectCountsMatchTheSet(c, step, because);
  expectCausesMatchTheSet(c, step, because);
  expectNotCompletedNorVerified(c, step, because);
}

/**
 * Clause 2, the rendering (Req 1.13, 1.19), at the two layers that render anything a verdict
 * reaches.
 *
 * The Display_Layer's `Verified` treatment appears on the formal run's own evidence iff every
 * property proved, so a `could-not-verify` never renders with it. And the history's formal step
 * carries the count under each verdict and every cause in words, so a `could-not-verify` step
 * neither reads as `completed` nor as verified, and still names what it could not verify.
 */
function expectRenderingFailsClosed(c: LabelCase, observed: LabelObservation): void {
  expect(isVerifiedTreatment(treatmentOnFormalEvidence(observed)), describeCase(c)).toBe(
    everyProved(c),
  );
  const step = formalStepResult(observed);
  if (step === null) {
    throw new Error(`the history holds no formal step for ${describeCase(c)}`);
  }
  expectStepCarriesTheSet(c, step);
}

// ---------------------------------------------------------------------------
// The cases: the closed part exhausted, the open part generated
// ---------------------------------------------------------------------------

/** The `could-not-verify` atoms: one per cause. */
const COULD_NOT_VERIFY_ATOMS: readonly ScriptedVerdict[] = Object.freeze(
  atomsOf('could-not-verify'),
);

const REFUTED_ATOM: ScriptedVerdict = Object.freeze({ verdict: 'refuted' });

/**
 * Every case the closed vocabularies define, run on every test rather than sampled.
 *
 * Each atom alone under both simulator behaviours (every verdict, every cause), each cause both
 * AHEAD of and BEHIND a refutation under a simulator that would PASS - the shape where a gate
 * that took the first non-`proved` verdict would fall back and mislabel a refuted design - and
 * every ordered pair of causes, where a history that names only one cause of several is met.
 */
const EXHAUSTIVE_CASES: readonly LabelCase[] = Object.freeze([
  ...VERDICT_ATOMS.flatMap((atom) =>
    SIMULATION_BEHAVIOURS.map((simulation): LabelCase => ({ verdicts: [atom], simulation })),
  ),
  ...COULD_NOT_VERIFY_ATOMS.flatMap((atom): LabelCase[] => [
    { verdicts: [atom, REFUTED_ATOM], simulation: 'passes' },
    { verdicts: [REFUTED_ATOM, atom], simulation: 'passes' },
  ]),
  ...COULD_NOT_VERIFY_ATOMS.flatMap((first) =>
    COULD_NOT_VERIFY_ATOMS.map((second): LabelCase => ({
      verdicts: [first, second],
      simulation: 'passes',
    })),
  ),
]);

/**
 * One generated verdict. `proved` is weighted up so whole sets of it, and sets ONE short of it, are
 * common; every member of each vocabulary is drawn, read off its owner.
 */
function arbScriptedVerdict(): fc.Arbitrary<ScriptedVerdict> {
  return fc.oneof(
    ...FORMAL_VERDICTS.map((verdict) => ({
      weight: verdict === 'proved' ? 2 : 1,
      arbitrary: fc.constantFrom(...atomsOf(verdict)),
    })),
  );
}

function arbLabelCase(): fc.Arbitrary<LabelCase> {
  return (
    fc
      .record({
        size: fc.integer({ min: 1, max: MAX_SET_SIZE }),
        // A full-size pool cut to `size`, so the set size is uniform.
        pool: fc.array(arbScriptedVerdict(), { minLength: MAX_SET_SIZE, maxLength: MAX_SET_SIZE }),
        simulation: fc.constantFrom(...SIMULATION_BEHAVIOURS),
      })
      // Rebuilt as a plain object: `fc.record` builds NULL-PROTOTYPE objects
      // (`chipAgent/_inbox/gotcha-fc-record-builds-null-prototype-objects-so-tostrictequal-fails-with-no-visual-difference.md`).
      .map(({ size, pool, simulation }): LabelCase => ({
        verdicts: pool.slice(0, size),
        simulation,
      }))
  );
}

/** The generated shapes the property must actually meet, each named for its failure message. */
const GENERATED_ROWS: readonly (readonly [string, (c: LabelCase) => boolean])[] = Object.freeze([
  ['a whole multi-property set proved', (c) => c.verdicts.length > 1 && everyProved(c)],
  [
    'a multi-property set one short of proved, with no simulation pass to fall back on',
    (c) =>
      c.simulation === 'fails' &&
      c.verdicts.length > 1 &&
      verdictsOf(c).filter((verdict) => verdict !== 'proved').length === 1,
  ],
  [
    'a multi-property fallback that may pass: could-not-verify and no refutation',
    (c) =>
      c.simulation === 'passes' &&
      c.verdicts.length > 1 &&
      verdictsOf(c).includes('could-not-verify') &&
      !verdictsOf(c).includes('refuted'),
  ],
  [
    'a refutation beside a could-not-verify, under a simulation that would pass',
    (c) =>
      c.simulation === 'passes' &&
      verdictsOf(c).includes('could-not-verify') &&
      verdictsOf(c).includes('refuted'),
  ],
]);

/**
 * NUM_RUNS - sized to the rarest generated row: a refutation beside a `could-not-verify` under a
 * passing simulation. With verdict weights 2:1:1 and a uniform size it needs a set of two or more
 * holding both (0.125, 0.281, 0.430 at sizes 2, 3, 4, so 0.209 overall) and a passing simulation
 * (1/2), so 0.104 per run; the other rows are 0.108 to 0.14 by the same arithmetic. MEASURED over
 * eight 200-run samples, every row landed between 13 and 33 of 200, so the rarest is at least 6.5%,
 * and the chance of meeting none in 300 runs is at most `(1 - 0.065)^300` ~ 2e-9. The closed part -
 * every verdict, every cause, and each cause on either side of a refutation - is exhausted above
 * rather than sampled, so this count carries only the mixed sets. 200 runs of both claims took
 * about 0.25s.
 */
const LABEL_NUM_RUNS = 300;

/** Run `grade` over every exhaustive case and every generated one; return the generated tally. */
async function gradeEveryCase(
  grade: (c: LabelCase, observed: LabelObservation) => void,
): Promise<ReadonlyMap<string, number>> {
  for (const c of EXHAUSTIVE_CASES) {
    grade(c, await observe(c));
  }
  const seen = new Map<string, number>();
  await fc.assert(
    fc.asyncProperty(arbLabelCase(), async (c: LabelCase) => {
      grade(c, await observe(c));
      for (const [row, holds] of GENERATED_ROWS) {
        seen.set(row, (seen.get(row) ?? 0) + (holds(c) ? 1 : 0));
      }
    }),
    propertyParameters({ numRuns: LABEL_NUM_RUNS }),
  );
  return seen;
}

/** Non-vacuity: every generated row was met at least once. */
function expectEveryRowMet(seen: ReadonlyMap<string, number>): void {
  for (const [row] of GENERATED_ROWS) {
    expect(seen.get(row) ?? 0, row).toBeGreaterThan(0);
  }
}

describe(PROPERTY_19, () => {
  it(
    'never derives the Verified tier from a non-proved verdict, and always from a fully proved set',
    async () => {
      expectEveryRowMet(await gradeEveryCase(expectTierFailsClosed));
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  it(
    'never renders a could-not-verify with the Verified treatment, as completed, or without its cause',
    async () => {
      expectEveryRowMet(await gradeEveryCase(expectRenderingFailsClosed));
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The rendering clause can fail
// ---------------------------------------------------------------------------

/** How a stand-in renderer can be wrong about a formal step. */
type RenderingFault = 'none' | 'completed' | 'drops-the-cause' | 'names-every-cause' | 'miscounts';

const RENDERING_FAULTS: readonly RenderingFault[] = Object.freeze([
  'completed',
  'drops-the-cause',
  'names-every-cause',
  'miscounts',
]);

/** The cause phrases a stand-in renderer prints for a case, under the fault it is given. */
function stubbedCausePhrases(c: LabelCase, fault: RenderingFault): readonly string[] {
  return fault === 'names-every-cause'
    ? COULD_NOT_VERIFY_CAUSES.map((cause) => EXPECTED_CAUSE_PHRASES[cause])
    : causesOf(c).map((cause) => EXPECTED_CAUSE_PHRASES[cause]);
}

/** A stand-in for the history's rendering of a case, carrying exactly the fault it is told to. */
function stubbedStep(c: LabelCase, fault: RenderingFault): string {
  if (fault === 'completed') {
    return 'completed';
  }
  const counts = FORMAL_VERDICTS.flatMap((verdict) => {
    const held = verdictsOf(c).filter((member) => member === verdict).length;
    if (held === 0) {
      return [];
    }
    const count = fault === 'miscounts' ? held + 1 : held;
    const printsCauses = verdict === 'could-not-verify' && fault !== 'drops-the-cause';
    const causes = printsCauses ? ` (${stubbedCausePhrases(c, fault).join(', ')})` : '';
    return [`${count} ${EXPECTED_VERDICT_WORDS[verdict]}${causes}`];
  });
  return `formal: ${counts.join(', ')}`;
}

const TIMED_OUT_ATOM: ScriptedVerdict = Object.freeze({
  verdict: 'could-not-verify',
  cause: 'proof-timeout',
});

const PROVED_ATOM: ScriptedVerdict = Object.freeze({ verdict: 'proved' });

/** Sets that each hold a `could-not-verify`, so every fault above has something to get wrong. */
const FAULTABLE_CASES: readonly LabelCase[] = Object.freeze([
  { verdicts: [TIMED_OUT_ATOM], simulation: 'passes' },
  { verdicts: [PROVED_ATOM, PROVED_ATOM, TIMED_OUT_ATOM], simulation: 'passes' },
  { verdicts: [REFUTED_ATOM, TIMED_OUT_ATOM], simulation: 'passes' },
]);

describe(`${PROPERTY_19} - the rendering clause`, () => {
  it('spells one phrase per word that none of the others can be found inside', () => {
    const spelled = [
      ...Object.values(EXPECTED_VERDICT_WORDS),
      ...Object.values(EXPECTED_CAUSE_PHRASES),
    ];
    for (const [needleAt, needle] of spelled.entries()) {
      for (const [haystackAt, haystack] of spelled.entries()) {
        expect(
          needleAt === haystackAt || !haystack.includes(needle),
          `${JSON.stringify(needle)} is found inside ${JSON.stringify(haystack)}`,
        ).toBe(true);
      }
    }
  });

  it('accepts a faithful rendering and rejects each way a renderer can get the step wrong', () => {
    for (const c of FAULTABLE_CASES) {
      expect(
        () => expectStepCarriesTheSet(c, stubbedStep(c, 'none')),
        describeCase(c),
      ).not.toThrow();
      for (const fault of RENDERING_FAULTS) {
        expect(
          () => expectStepCarriesTheSet(c, stubbedStep(c, fault)),
          `${fault}: ${describeCase(c)}`,
        ).toThrow();
      }
    }
  });
});
