// formal-property-oracle, Property 20: Every could-not-verify sample is decided by the fallback,
// with the deciding cause and the route recorded (task 8.4, amended by tasks 19.2 and 19.3).
//
// WHAT IS CLAIMED, OVER WHAT
//   Which gate DECIDED a sample, and which Fallback_Reason the loop RECORDED for it
//   (`formal.fallbackReason` on the terminal outcome), over Property_Sets of one to four properties
//   carrying every Formal_Verdict and every Could_Not_Verify_Cause, under a simulation that would
//   pass and one that would fail. The subject is the REAL `VerificationLoop`, driven the way task
//   8.6's `formal-label-fail-closed.property.test.ts` drives it: a scripted `FormalOraclePort`
//   stands in for the toolchain, and the real `IcarusSimulatorAdapter` over a scripted sandbox
//   stands in for iverilog. "Decided by" is read off what RAN, never off a label: the
//   Simulation_Fallback decided iff a simulate job ran and the outcome counts an iteration, and its
//   status is then the one that simulation's own verdict gives; the formal verdict decided iff the
//   oracle answered and neither a simulate job nor an iteration followed. The graded model:
//     - any `could-not-verify` and no `refuted` -> the Simulation_Fallback, Fallback_Route `cause`,
//       recording a cause one of those properties CARRIED (Req 7.6, 7.7), `frontend-rejected` among
//       them (Req 8.6);
//     - any `refuted` -> the refutation, Fallback_Route `not-applicable` and NO Fallback_Reason,
//       even beside a `could-not-verify` (Req 7.17);
//     - every property `proved` -> the formal verdict, Fallback_Route `not-applicable`, no
//       Fallback_Reason;
//     - a PRE-PASS refusal -> the Simulation_Fallback, Fallback_Route `cause`, recording the
//       pre-pass's own cause (Req 1.18, 14.35);
//     - a REFUSED Property_Set -> the Simulation_Fallback, Fallback_Route `property-set-refused`, NO
//       Fallback_Reason, and the oracle never asked (Req 10.3).
//   The ROUTE is asserted on EVERY case above, not only on the ones that fall back, together with
//   Req 7.19's rule that a Fallback_Reason is non-`null` if and only if the route is `cause`. That
//   rule is true BY CONSTRUCTION in the loop - `formalProvenanceOf` projects both fields off one
//   discriminated `TakenRoute` - so what these assertions add is that the one route the loop
//   DECIDED is the one the requirements name for that case (Req 7.18, 7.20, 7.21).
//
// THE PRECEDENCE IS REQ 7.17's, AND THE TASK'S OWN WORDING OMITS IT
//   "A sample with any could-not-verify property is decided by the simulation gate" is FALSE as
//   worded for a set that also holds a refutation: Req 7.17 decides that sample `unverified` from
//   the refutation, because a passing fallback would otherwise carry `Verified` on a design a formal
//   counterexample refuted. So the rule is asserted as the loop applies it under 7.17 -
//   `#runFormalGate` looks for a refutation before it looks for a `could-not-verify` - and every
//   per-property cause runs both ahead of and behind a refutation under a simulation that WOULD
//   pass, the one shape where the omitted guard mislabels
//   (`chipAgent/_inbox/gotcha-design-property-text-omits-the-guards-that-pre-empt-it.md`).
//
// WHICH CAUSE IS RECORDED WHEN SEVERAL DIFFER: SETTLED IN PART, AND THE REST IS THE LOOP'S RULE
//   Req 7.7 records "the Could_Not_Verify_Cause that caused it", one cause, and `fallbackReason`
//   holds one. But each `could-not-verify` property alone sends the sample to the fallback (Req
//   7.6), and nothing orders causes ACROSS properties: Req 1.7 orders them inside ONE property, and
//   Req 1.18 and 14.33 inside one pre-pass. So the requirements settle only that the recorded cause
//   is one a `could-not-verify` property carried, which is the first claim. The loop's tie-break,
//   the FIRST `could-not-verify` in submission order (`results.find(isCouldNotVerify)`), is the
//   second claim, asserted AS BUILT and kept apart, so a later decision to rank causes fails only
//   the claim that names the rule. Every ORDERED pair of distinct per-property causes runs, so a
//   fixed ranking that disagrees with submission order on any one pair goes red. The persisted
//   record's roll-up (`decidingResult`, `app/eval/sweep/results-log.ts`) takes the same
//   first-in-order cause, so the rule has two owners that agree today.
//
// THE TWO PRE-PASS CAUSES ARE GENERATED IN THE SHAPE THE PRE-PASS REPORTS THEM
//   `reset-contract-unresolved` and `clock-contract-unsupported` arrive before any solver ran and
//   before any Property_Wrapper existed, and the adapter reports them for the WHOLE set
//   (`#refusedSet`, `app/tools/formal/adapter.ts`): one `refusedWithoutProof` per property carrying
//   the SAME cause at depth 0, the one pre-pass time recorded once, every wrapper source `null`, the
//   reset `{ derived: false }`, no assertion gate, and the Clock_Contract the document carried -
//   `negedge` or `mixed` for a clock refusal, and `posedge` alone for a reset refusal, because
//   `deriveFormalPrepassReport` checks the clock first and admits a design holding no clocked
//   state. So both pre-pass causes run as that set-level refusal, over every set size and clock
//   reading, and the other nine causes run as per-property mixes. A pre-pass cause beside a
//   different verdict in one set is a shape the adapter cannot produce, so it is not generated.
//
// A REFUSED PROPERTY_SET: WHAT REQ 10.3 REQUIRES, AND THE TWO GAPS THAT ARE NOW CLOSED
//   Req 10.3 requires the Simulation_Fallback to decide the sample "rather than ... the refused
//   Property_Set", and says nothing of a Fallback_Reason. A refusal reaches the loop as an EMPTY set
//   stamped `refused`, which is the shape `FormalPropertySet`'s own contract names, because the eval
//   layer must not hand the loop a set it refused. So the assertions are: the simulation decides,
//   the oracle is never asked, no formal result stands, the stamp survives as `propertySetAdmitted:
//   'refused'`, `fallbackReason` is `null`, and the Fallback_Route is `property-set-refused`.
//   THE `null` REASON WAS A GAP, AND TASK 19.2 CLOSED IT. No Could_Not_Verify_Cause caused this fall
//   back, so Req 7.7 has no value to record, and a reader of `fallbackReason` alone could not tell
//   this sample from one the formal verdict decided. The closed four-member Fallback_Route now says
//   it in its own name on every terminal outcome (Req 7.18, 7.20, 7.21): `property-set-refused`
//   carries both that the sample fell back and why, with no cause invented to stand in for a
//   refusal - which is deliberately NOT a `CouldNotVerifyCause`, because every cause-keyed count is
//   built on that vocabulary and a blunt Property_Set is not a fact about the instrument's verdict.
//   So the field contract design.md states is now the ROUTE's, not the reason's, and the reason's
//   own contract is Req 7.19's iff.
//   THE NON-EMPTY REFUSED SET WAS THE SECOND GAP, AND TASK 19.3 CLOSED IT. As built the loop
//   branched on an EMPTY set alone and read `propertySetAdmitted` only to copy it onto the record,
//   so a non-empty set stamped `refused` whose every property proved was decided by the formal
//   verdict and labelled `Verified` - which the scratch run the FALSIFIED note records MEASURED.
//   `withheldSetRoute` now refuses a set stamped `refused` WHATEVER it holds, before anything
//   reaches the `FormalOraclePort`, so Req 10.3 is the loop's own guard rather than a contract the
//   caller owes, and the eval layer's emptied set is belt-and-braces. This file still drives the
//   EMPTY shape, the one `FormalPropertySet`'s contract names; the non-empty refused set is asserted
//   where that guard lives, in `app/agent/orchestrator/verification-loop.test.ts`.
//
// THE CLOSED PART IS EXHAUSTED, THE OPEN PART IS GENERATED
//   Every per-property atom alone under both simulations, every per-property cause on either side of
//   a refutation, every pre-pass refusal at every size and clock reading, the refused set, and every
//   ordered pair of distinct causes run on every test rather than usually
//   (`chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`).
//   fast-check covers the open part: per-property mixes of up to four, in every order.
//
// WHAT THIS LEANS ON AND DOES NOT RE-ASSERT
//   - task 8.6: the trust tier, its span binding, and the rendering. `status` is read here only as
//     the value the deciding gate produced, and the label is not read at all.
//   - task 8.5 (`formal-fallback-no-relaxation.property.test.ts`): that the fallback relaxes no rule
//     and is charged to the budget, and the routes where the oracle or the property source THREW.
//   - Property 18: each property's own verdict standing unchanged on the record (Req 1.11).
//   - No elapsed time is read: a formal run under-reports `elapsedMs` (Req 7.11), which a later
//     bugfix spec owns
//     (`chipAgent/_inbox/gotcha-a-formal-run-under-reports-elapsedms-so-the-session-budget-is-under-charged-and-a-scripted-oracle-double-hides-it.md`).
//   - The FOURTH Fallback_Route, `no-property-expressed` - an EMPTY set NOT stamped `refused`, the
//     student path where the Property_Author could express no criterion - is asserted in
//     `app/agent/orchestrator/verification-loop.test.ts` beside the non-empty refused set, which is
//     where task 19.2 put it. Every set this file hands the loop is either non-empty or refused, so
//     that route is unreachable here and is not generated rather than being half-covered.
//
// FALSIFIED by feeding deliberately wrong subjects into this file's own four assertion helpers, in
// a scratch block since removed, never by editing a shared module: each was a real observation of
// the loop with one field rewritten the way a defect would rewrite it, and all 16 went red. Claim 1
// caught a fallback that dropped its cause, recorded a cause no property carried, was decided by
// the formal verdict, or took a status its simulation did not give; a refutation beside a
// `could-not-verify` that fell back, or that recorded the cause anyway; a proved set the simulation
// decided, or that recorded a cause; and a pre-pass refusal recorded under the other pre-pass cause.
// Claim 2 caught the LAST cause recorded instead of the first, which claim 1 PASSED, as it must,
// because only claim 2 names the tie-break. Claim 3 caught the clock refusal recorded as
// `reset-contract-unresolved` or decided by the formal verdict. Claim 4 caught a refused set
// submitted to the oracle, recording a cause, losing its `refused` stamp, or decided formally.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 7.6, 7.7, 7.18, 7.19, 7.20, 8.6, 10.3**
//
// The three route criteria are named here because design.md's amended Property 20 names them and
// its statement now carries the route clauses. design.md's own traceability section still stops at
// 7.16 and assigns 7.17 through 7.22 to nothing at all; that omission is design.md's to close.

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
  type FallbackRoute,
  type FormalPropertySet,
  type FormalProvenance,
  type GeneratedCandidate,
  type GenerateTestbenchRequest,
  type GenerationAdmissionRequest,
  type GenerationContextOpener,
  type GenerationGateRefusal,
  type GenerationInput,
  type IndependentTestbenchGenerator,
  type PropertySetAdmissionOutcome,
  type PropertySetSource,
  type RepairTestbenchRequest,
  type SessionBudgetHandle,
  type TestbenchGenerationOutcome,
  type VerificationOutcome,
} from '@app/agent';
import {
  err,
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
  admitProved,
  COULD_NOT_VERIFY_CAUSES,
  FakeSandboxRuntime,
  FORMAL_VERDICTS,
  IcarusSimulatorAdapter,
  refusedWithoutProof,
  SandboxToolRunner,
  validateExpression,
  type ArtifactBlobRef,
  type ClockPolarity,
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

import { propertyParameters } from './property.js';
import { timingContractFor } from '@app/test';

// **Feature: formal-property-oracle, Property 20: Every could-not-verify sample is decided by the
// fallback, with the deciding cause and the route recorded**
const PROPERTY_20 =
  'formal-property-oracle, Property 20: Every could-not-verify sample is decided by the fallback, with the deciding cause and the route recorded';

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

/** The largest generated Property_Set, and every set size up to it. */
const MAX_SET_SIZE = 4;
const SET_SIZES: readonly number[] = Object.freeze(
  Array.from({ length: MAX_SET_SIZE }, (_, index) => index + 1),
);

/** The counterexample a refuted result carries (Req 1.10). Nothing reads its bytes. */
const COUNTEREXAMPLE: ArtifactBlobRef = Object.freeze({
  name: 'counterexample.vcd',
  sizeBytes: 24,
  sha256: 'c'.repeat(64),
});

/** The depth and elapsed time every scripted solver-side result reports; neither is read. */
const SCRIPTED_DEPTH = 20;
const SCRIPTED_ELAPSED_MS = 10;

/** The depth a pre-pass refusal reports: it ran no invocation at any depth. */
const PREPASS_REFUSAL_DEPTH = 0;

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
// The causes, split by WHERE the adapter reports them
// ---------------------------------------------------------------------------

/**
 * The two causes the Reset_Contract_Prepass refuses with, reported before any solver runs and
 * ahead of the whole condition order (Req 1.18). `satisfies` keeps both spelled as real members.
 */
const PREPASS_CAUSES = [
  'reset-contract-unresolved',
  'clock-contract-unsupported',
] as const satisfies readonly CouldNotVerifyCause[];

type PrepassCause = (typeof PREPASS_CAUSES)[number];

function isPrepassCause(cause: CouldNotVerifyCause): cause is PrepassCause {
  return (PREPASS_CAUSES as readonly CouldNotVerifyCause[]).includes(cause);
}

/** Every other cause: one the adapter can report on ONE property beside other verdicts. */
const PER_PROPERTY_CAUSES: readonly CouldNotVerifyCause[] = Object.freeze(
  COULD_NOT_VERIFY_CAUSES.filter((cause) => !isPrepassCause(cause)),
);

/**
 * The Clock_Contract each pre-pass refusal is reported beside. `deriveFormalPrepassReport` checks
 * the clock FIRST, so a clock refusal carries the `negedge` or `mixed` reading it is about, and a
 * reset refusal is reachable under `posedge` alone, because a design holding no clocked state is
 * admitted with no reset rather than refused (Req 14.33, 14.40).
 */
const PREPASS_CLOCK_READINGS: Readonly<Record<PrepassCause, readonly ClockPolarity[]>> =
  Object.freeze({
    'reset-contract-unresolved': ['posedge'],
    'clock-contract-unsupported': ['negedge', 'mixed'],
  });

// ---------------------------------------------------------------------------
// The per-property verdict atoms, read off the two closed vocabularies
// ---------------------------------------------------------------------------

/** One property's scripted verdict, carrying the cause where the verdict carries one. */
type ScriptedVerdict =
  | { readonly verdict: Exclude<FormalVerdict, 'could-not-verify'> }
  | { readonly verdict: 'could-not-verify'; readonly cause: CouldNotVerifyCause };

/** Every atom of one verdict: the verdict alone, or once per per-property cause. */
function atomsOf(verdict: FormalVerdict): readonly ScriptedVerdict[] {
  return verdict === 'could-not-verify'
    ? PER_PROPERTY_CAUSES.map((cause): ScriptedVerdict => ({ verdict: 'could-not-verify', cause }))
    : [{ verdict }];
}

/** Every per-property atom: each Formal_Verdict, and `could-not-verify` once per cause. */
const PER_PROPERTY_ATOMS: readonly ScriptedVerdict[] = Object.freeze(
  FORMAL_VERDICTS.flatMap(atomsOf),
);

/** The `could-not-verify` atoms: one per per-property cause. */
const COULD_NOT_VERIFY_ATOMS: readonly ScriptedVerdict[] = Object.freeze(
  atomsOf('could-not-verify'),
);

const REFUTED_ATOM: ScriptedVerdict = Object.freeze({ verdict: 'refuted' });

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

/** `size` properties, in submission order. */
function propertiesOfSize(size: number): readonly FormalProperty[] {
  return Array.from({ length: size }, (_, position) => propertyAt(position));
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
// The two shapes the oracle answers in: per property, or once for the whole set
// ---------------------------------------------------------------------------

/** The solver-side answer: one result and one rendered wrapper per property, under a contract. */
function solverOutcome(verdicts: readonly ScriptedVerdict[]): FormalOutcome {
  return {
    results: verdicts.map((scripted, position) => resultFor(scripted, propertyAt(position))),
    propertyWrapperSources: verdicts.map(
      (_, position) => `module formal_property_wrapper; // p${position + 1}\nendmodule\n`,
    ),
    // The double resolves no artifact reference, so no property carries a trace.
    counterexampleCaptures: verdicts.map(() => null),
    resetContract: {
      derived: true,
      resetName: 'rst_n',
      resetActiveLow: true,
      resetKind: 'async',
      initialStateFree: true,
    },
    assertionGateEmitted: false,
    clockPolarity: 'posedge',
  };
}

/**
 * A pre-pass refusal, in the shape `#refusedSet` reports it: the SAME cause on every property, the
 * one pre-pass time recorded once, no wrapper built, the refused reset arm, and the clock reading.
 */
function prepassRefusalOutcome(
  cause: PrepassCause,
  clockPolarity: ClockPolarity,
  size: number,
): FormalOutcome {
  return {
    results: propertiesOfSize(size).map((property, index) =>
      refusedWithoutProof(
        cause,
        property,
        { depth: PREPASS_REFUSAL_DEPTH, elapsedMs: index === 0 ? SCRIPTED_ELAPSED_MS : 0 },
        '',
      ),
    ),
    propertyWrapperSources: propertiesOfSize(size).map(() => null),
    // No invocation ran, so no property registered a trace.
    counterexampleCaptures: propertiesOfSize(size).map(() => null),
    resetContract: { derived: false },
    assertionGateEmitted: false,
    clockPolarity,
  };
}

/** The adapter's own answer to an EMPTY set. The refused route must never ask for it. */
const EMPTY_SET_OUTCOME: FormalOutcome = Object.freeze({
  results: [],
  propertyWrapperSources: [],
  counterexampleCaptures: [],
  resetContract: null,
  assertionGateEmitted: false,
  clockPolarity: null,
});

// ---------------------------------------------------------------------------
// The loop's collaborators: the real loop, labeler, and simulator adapter
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
 * A failing simulation therefore ends the run on its first iteration, so a fallback sample is
 * decided by ONE simulation verdict and by nothing else.
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

/** A formal oracle double answering every set with one scripted outcome, recording each ask. */
class ScriptedFormalOracle implements FormalOraclePort {
  readonly #outcome: FormalOutcome;
  readonly #submittedSizes: number[] = [];

  constructor(outcome: FormalOutcome) {
    this.#outcome = outcome;
  }

  /** The size of every set the loop submitted, in order: one entry per `proveSet` call. */
  get submittedSizes(): readonly number[] {
    return [...this.#submittedSizes];
  }

  proveSet(request: FormalProveSetRequest): Promise<FormalOutcome> {
    this.#submittedSizes.push(request.properties.length);
    return Promise.resolve(this.#outcome);
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

  constructor(set: FormalPropertySet) {
    this.#set = set;
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

/** The status the Simulation_Fallback's own verdict gives, where it decides the sample. */
const FALLBACK_STATUS: Readonly<Record<SimulationBehaviour, 'verified' | 'unverified'>> =
  Object.freeze({ passes: 'verified', fails: 'unverified' });

/** Per-property verdicts, as the solver-side checks report them. */
interface VerdictsCase {
  readonly route: 'verdicts';
  readonly verdicts: readonly ScriptedVerdict[];
  readonly simulation: SimulationBehaviour;
}

/** The shared pre-pass refused the design, for every property of a set of `size`. */
interface PrepassCase {
  readonly route: 'prepass';
  readonly cause: PrepassCause;
  readonly clockPolarity: ClockPolarity;
  readonly size: number;
  readonly simulation: SimulationBehaviour;
}

/** The Property_Set_Admission refused the set, so it arrives EMPTY and stamped `refused`. */
interface RefusedCase {
  readonly route: 'refused';
  readonly simulation: SimulationBehaviour;
}

type FallbackCase = VerdictsCase | PrepassCase | RefusedCase;

/** What the loop is handed for one case: the Property_Set, and the oracle's answer to it. */
interface FormalAnswer {
  readonly set: FormalPropertySet;
  readonly outcome: FormalOutcome;
}

function setOf(
  properties: readonly FormalProperty[],
  propertySetAdmitted: PropertySetAdmissionOutcome,
): FormalPropertySet {
  return { properties, unexpressedCriteria: [], propertySetAdmitted };
}

function answerFor(c: FallbackCase): FormalAnswer {
  switch (c.route) {
    case 'verdicts':
      return {
        set: setOf(propertiesOfSize(c.verdicts.length), 'not-gated'),
        outcome: solverOutcome(c.verdicts),
      };
    case 'prepass':
      return {
        set: setOf(propertiesOfSize(c.size), 'not-gated'),
        outcome: prepassRefusalOutcome(c.cause, c.clockPolarity, c.size),
      };
    case 'refused':
      return { set: setOf([], 'refused'), outcome: EMPTY_SET_OUTCOME };
    default: {
      const unreachable: never = c;
      return unreachable;
    }
  }
}

/** What ran, and what the loop recorded, for one case. Plain data, so a wrong one can be built. */
interface FallbackObservation {
  readonly status: 'verified' | 'unverified';
  readonly iterations: number;
  /** Simulate jobs the sandbox received, the Testbench_Precheck's build check excluded. */
  readonly simulateRuns: number;
  /** `proveSet` calls the oracle received. */
  readonly proveSetCalls: number;
  readonly formal: FormalProvenance;
}

/** A terminal outcome that reached a verdict. Any other outcome is a broken fixture. */
function decidedOutcome(
  outcome: VerificationOutcome,
): Extract<VerificationOutcome, { status: 'verified' | 'unverified' }> {
  if (outcome.status !== 'verified' && outcome.status !== 'unverified') {
    throw new Error(`the fixture never reached a verdict: ${outcome.status}`);
  }
  return outcome;
}

/** Run one case through the real loop, and read back what ran and what it recorded. */
async function observe(c: FallbackCase): Promise<FallbackObservation> {
  const spec = approvedSpec();
  const answer = answerFor(c);
  const iteration = checkCapture(c.simulation === 'passes' ? 'PASS' : 'FAIL');
  let simulateRuns = 0;
  const runtime = new FakeSandboxRuntime((job) => {
    if (isPrecheckJob(job)) {
      return checkCapture('PASS');
    }
    simulateRuns += 1;
    return iteration;
  });
  const oracle = new ScriptedFormalOracle(answer.outcome);
  const loop = new VerificationLoop({
    gate: new AdmittingGate(confirmedContext(spec)),
    generator: new OneCandidateGenerator(spec),
    testbench: new OneTestbench(spec),
    simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(runtime)),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    trustLabeler: oracleTrustLabeler,
    formal: { oracle, properties: new FixedPropertySet(answer.set) },
  });
  const outcome = decidedOutcome(await loop.verify(REQUEST, generousBudget(), LIMITS));
  const submitted = oracle.submittedSizes;
  if (submitted.some((size) => size !== answer.outcome.results.length)) {
    throw new Error('the scripted outcome does not answer the set the loop submitted');
  }
  return {
    status: outcome.status,
    iterations: outcome.iterations,
    simulateRuns,
    proveSetCalls: submitted.length,
    formal: outcome.formal,
  };
}

/** A short, reproducible description of a case for a failure message. */
function describeCase(c: FallbackCase): string {
  return JSON.stringify(c);
}

// ---------------------------------------------------------------------------
// The model the observations are graded against
// ---------------------------------------------------------------------------

/** Which gate decided a sample. */
type Decider = 'formal-verdict' | 'simulation-fallback';

/** What the requirements say of one case. */
interface RequiredDecision {
  readonly decider: Decider;
  /**
   * The ONE Fallback_Route the requirements name for this case (Req 7.18, 7.20, 7.21), spelled per
   * case rather than derived from `admissibleReasons`, so a route that followed the reason would
   * not be graded against its own rule.
   */
  readonly route: FallbackRoute;
  /** How often the oracle is asked: once for a submitted set, never for a refused one. */
  readonly proveSetCalls: 0 | 1;
  /**
   * Every cause a recorded Fallback_Reason may be, in SUBMISSION ORDER - EMPTY where no
   * Could_Not_Verify_Cause made the sample fall back, so none may be recorded.
   */
  readonly admissibleReasons: readonly CouldNotVerifyCause[];
}

function verdictsOf(c: VerdictsCase): readonly FormalVerdict[] {
  return c.verdicts.map((scripted) => scripted.verdict);
}

function hasVerdict(c: VerdictsCase, verdict: FormalVerdict): boolean {
  return verdictsOf(c).includes(verdict);
}

/** The causes the case's `could-not-verify` properties carried, in submission order. */
function causesOf(c: VerdictsCase): readonly CouldNotVerifyCause[] {
  return c.verdicts.flatMap((scripted) =>
    scripted.verdict === 'could-not-verify' ? [scripted.cause] : [],
  );
}

/** A per-property set: the refutation first (Req 7.17), then any `could-not-verify` (Req 7.6). */
function verdictsDecisionOf(c: VerdictsCase): RequiredDecision {
  if (hasVerdict(c, 'refuted')) {
    // Req 7.17: the refutation decides, so nothing fell back and no route but the absent one fits.
    return {
      decider: 'formal-verdict',
      route: 'not-applicable',
      proveSetCalls: 1,
      admissibleReasons: [],
    };
  }
  const causes = causesOf(c);
  return causes.length > 0
    ? {
        decider: 'simulation-fallback',
        route: 'cause',
        proveSetCalls: 1,
        admissibleReasons: causes,
      }
    : {
        decider: 'formal-verdict',
        route: 'not-applicable',
        proveSetCalls: 1,
        admissibleReasons: [],
      };
}

function requiredDecisionOf(c: FallbackCase): RequiredDecision {
  switch (c.route) {
    case 'verdicts':
      return verdictsDecisionOf(c);
    case 'prepass':
      // One cause, the pre-pass's own, on every property (Req 1.18, 7.6, 7.7, 14.35), so the route
      // is the one a cause drove even though no solver ran.
      return {
        decider: 'simulation-fallback',
        route: 'cause',
        proveSetCalls: 1,
        admissibleReasons: [c.cause],
      };
    case 'refused':
      // Req 10.3, 7.20. No Could_Not_Verify_Cause caused this fall back, so none may be recorded,
      // and the route is what says the sample fell back at all.
      return {
        decider: 'simulation-fallback',
        route: 'property-set-refused',
        proveSetCalls: 0,
        admissibleReasons: [],
      };
    default: {
      const unreachable: never = c;
      return unreachable;
    }
  }
}

/**
 * Which gate decided, read off what RAN: the fallback iff a simulate job ran AND an iteration was
 * counted, the formal verdict iff neither did. One without the other is a third answer.
 */
function deciderOf(observed: FallbackObservation): Decider | 'inconsistent' {
  const simulated = observed.simulateRuns > 0;
  if (simulated !== observed.iterations > 0) {
    return 'inconsistent';
  }
  return simulated ? 'simulation-fallback' : 'formal-verdict';
}

// ---------------------------------------------------------------------------
// The four claims, as assertion helpers over one observation
// ---------------------------------------------------------------------------

/**
 * Claim 1, the requirement-settled rule (Req 7.6, 7.7, 7.17, 8.6, 10.3, 14.35): the right gate
 * decided, a fallback's status is its own simulation's, and the recorded Fallback_Reason is a
 * cause the set CARRIED, or `null` where no cause made the sample fall back.
 */
function expectDecidedAsRequired(c: FallbackCase, observed: FallbackObservation): void {
  const required = requiredDecisionOf(c);
  const label = describeCase(c);
  expect(observed.proveSetCalls, label).toBe(required.proveSetCalls);
  expect(deciderOf(observed), label).toBe(required.decider);
  if (required.decider === 'simulation-fallback') {
    expect(observed.status, label).toBe(FALLBACK_STATUS[c.simulation]);
  }
  if (required.admissibleReasons.length === 0) {
    expect(observed.formal.fallbackReason, label).toBeNull();
  } else {
    expect(required.admissibleReasons, label).toContain(observed.formal.fallbackReason);
  }
  // Req 7.18, 7.20, 7.21: exactly one member of the closed vocabulary, and the member this case's
  // own rule names - so a refused set does not report itself as "no property was expressed".
  expect(observed.formal.fallbackRoute, label).toBe(required.route);
  // Req 7.19, the other half: the reason is present on `cause` and absent on every other member.
  expect(observed.formal.fallbackReason !== null, label).toBe(
    observed.formal.fallbackRoute === 'cause',
  );
}

/**
 * Claim 2, the loop's own tie-break, asserted AS BUILT because no requirement settles it: the
 * recorded Fallback_Reason is the FIRST admissible cause in submission order.
 */
function expectFirstCauseRecorded(c: FallbackCase, observed: FallbackObservation): void {
  const [first = null] = requiredDecisionOf(c).admissibleReasons;
  expect(observed.formal.fallbackReason, describeCase(c)).toBe(first);
}

/**
 * Claim 3, Req 14.35 by name. The Fallback_Reason is spelled here rather than read off the case,
 * so the pin cannot follow a fixture that drifted.
 */
function expectClockContractFallback(c: PrepassCase, observed: FallbackObservation): void {
  const label = describeCase(c);
  expect(observed.proveSetCalls, label).toBe(1);
  expect(deciderOf(observed), label).toBe('simulation-fallback');
  expect(observed.status, label).toBe(FALLBACK_STATUS[c.simulation]);
  expect(observed.formal.fallbackReason, label).toBe('clock-contract-unsupported');
  expect(observed.formal.fallbackRoute, label).toBe('cause');
}

/**
 * Claim 4, Req 10.3: a refused set is decided by the Simulation_Fallback and never submitted, so
 * no formal result stands; the refusal stays on the record; NO Fallback_Reason is recorded, because
 * no Could_Not_Verify_Cause caused it; and the Fallback_Route is `property-set-refused`, which is
 * what closed the gap an absent reason used to leave (Req 7.20).
 */
function expectRefusedSetFallback(c: RefusedCase, observed: FallbackObservation): void {
  const label = describeCase(c);
  expect(observed.proveSetCalls, label).toBe(0);
  expect(deciderOf(observed), label).toBe('simulation-fallback');
  expect(observed.status, label).toBe(FALLBACK_STATUS[c.simulation]);
  expect(observed.formal.results, label).toEqual([]);
  expect(observed.formal.propertySetAdmitted, label).toBe('refused');
  expect(observed.formal.fallbackReason, label).toBeNull();
  expect(observed.formal.fallbackRoute, label).toBe('property-set-refused');
}

// ---------------------------------------------------------------------------
// The cases: the closed part exhausted, the open part generated
// ---------------------------------------------------------------------------

/** Every pre-pass refusal: each cause, under each clock reading it is reported beside, every size. */
const PREPASS_CASES: readonly PrepassCase[] = Object.freeze(
  PREPASS_CAUSES.flatMap((cause) =>
    PREPASS_CLOCK_READINGS[cause].flatMap((clockPolarity) =>
      SET_SIZES.flatMap((size) =>
        SIMULATION_BEHAVIOURS.map((simulation): PrepassCase => ({
          route: 'prepass',
          cause,
          clockPolarity,
          size,
          simulation,
        })),
      ),
    ),
  ),
);

const CLOCK_CONTRACT_CASES: readonly PrepassCase[] = Object.freeze(
  PREPASS_CASES.filter((c) => c.cause === 'clock-contract-unsupported'),
);

const REFUSED_CASES: readonly RefusedCase[] = Object.freeze(
  SIMULATION_BEHAVIOURS.map((simulation): RefusedCase => ({ route: 'refused', simulation })),
);

/**
 * Claim 1's closed part: each per-property atom alone under both simulations, each per-property
 * cause AHEAD of and BEHIND a refutation under a simulation that would PASS (the shape a missing
 * 7.17 guard mislabels), every pre-pass refusal, and the refused set.
 */
const DECISION_CASES: readonly FallbackCase[] = Object.freeze([
  ...PER_PROPERTY_ATOMS.flatMap((atom) =>
    SIMULATION_BEHAVIOURS.map((simulation): VerdictsCase => ({
      route: 'verdicts',
      verdicts: [atom],
      simulation,
    })),
  ),
  ...COULD_NOT_VERIFY_ATOMS.flatMap((atom): VerdictsCase[] => [
    { route: 'verdicts', verdicts: [atom, REFUTED_ATOM], simulation: 'passes' },
    { route: 'verdicts', verdicts: [REFUTED_ATOM, atom], simulation: 'passes' },
  ]),
  ...PREPASS_CASES,
  ...REFUSED_CASES,
]);

/** Claim 2's closed part: every ORDERED pair of distinct per-property causes. */
const ORDERED_CAUSE_PAIRS: readonly VerdictsCase[] = Object.freeze(
  COULD_NOT_VERIFY_ATOMS.flatMap((first) =>
    COULD_NOT_VERIFY_ATOMS.filter((second) => second !== first).map((second): VerdictsCase => ({
      route: 'verdicts',
      verdicts: [first, second],
      simulation: 'fails',
    })),
  ),
);

/**
 * One generated verdict. `proved` is weighted up so whole sets of it, and fallbacks deciding
 * beside it, are common; every member of each vocabulary is drawn, read off its owner.
 */
function arbScriptedVerdict(): fc.Arbitrary<ScriptedVerdict> {
  return fc.oneof(
    ...FORMAL_VERDICTS.map((verdict) => ({
      weight: verdict === 'proved' ? 2 : 1,
      arbitrary: fc.constantFrom(...atomsOf(verdict)),
    })),
  );
}

function arbVerdictsCase(): fc.Arbitrary<VerdictsCase> {
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
      .map(({ size, pool, simulation }): VerdictsCase => ({
        route: 'verdicts',
        verdicts: pool.slice(0, size),
        simulation,
      }))
  );
}

/** A generated shape the property must actually meet, named for its failure message. */
type GeneratedRow = readonly [string, (c: VerdictsCase) => boolean];

const DECISION_ROWS: readonly GeneratedRow[] = Object.freeze([
  [
    'a fallback deciding beside a proof',
    (c) =>
      !hasVerdict(c, 'refuted') && hasVerdict(c, 'could-not-verify') && hasVerdict(c, 'proved'),
  ],
  [
    'a refutation beside a could-not-verify',
    (c) => hasVerdict(c, 'refuted') && hasVerdict(c, 'could-not-verify'),
  ],
  [
    'a whole multi-property set proved',
    (c) => c.verdicts.length > 1 && verdictsOf(c).every((verdict) => verdict === 'proved'),
  ],
]);

const TIE_BREAK_ROWS: readonly GeneratedRow[] = Object.freeze([
  [
    'a fallback holding two different could-not-verify causes',
    (c) => !hasVerdict(c, 'refuted') && new Set(causesOf(c)).size > 1,
  ],
]);

/**
 * FALLBACK_NUM_RUNS - sized to the rarest generated row, a fallback holding two DIFFERENT
 * could-not-verify causes and no refutation. Verdicts are drawn 2:1:1 (proved, refuted,
 * could-not-verify), the cause uniformly over nine, and the size uniformly over one to four. With
 * no refutation ((3/4)^n), a position is a could-not-verify with probability 1/3, and the row needs
 * two or more of them not all of one cause: about 0.056, 0.099, and 0.118 at sizes 2, 3, and 4,
 * so about 0.068 per run, and the other rows about 0.11 to 0.21. MEASURED over 4000 draws of
 * `arbVerdictsCase()`: 0.065 for that row, then 0.106, 0.187, and 0.210, so missing the rarest in
 * 300 runs is at most (1 - 0.065)^300 ~ 2e-9. Every closed case - each atom alone,
 * each cause beside a refutation, every pre-pass refusal, the refused set, and every ordered pair
 * of distinct causes - is exhausted above, so this count carries only the mixed sets.
 */
const FALLBACK_NUM_RUNS = 300;

/** Grade every closed case, then the generated sets, and require every generated row be met. */
async function gradeEveryCase(
  closed: readonly FallbackCase[],
  rows: readonly GeneratedRow[],
  grade: (c: FallbackCase, observed: FallbackObservation) => void,
): Promise<void> {
  for (const c of closed) {
    grade(c, await observe(c));
  }
  const seen = new Map<string, number>();
  await fc.assert(
    fc.asyncProperty(arbVerdictsCase(), async (c: VerdictsCase) => {
      grade(c, await observe(c));
      for (const [row, holds] of rows) {
        seen.set(row, (seen.get(row) ?? 0) + (holds(c) ? 1 : 0));
      }
    }),
    propertyParameters({ numRuns: FALLBACK_NUM_RUNS }),
  );
  for (const [row] of rows) {
    expect(seen.get(row) ?? 0, row).toBeGreaterThan(0);
  }
}

describe(PROPERTY_20, () => {
  it(
    'decides every could-not-verify sample by the Simulation_Fallback and records a cause it carried, under the 7.17 precedence',
    async () => {
      await gradeEveryCase(DECISION_CASES, DECISION_ROWS, expectDecidedAsRequired);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  it(
    "records the FIRST could-not-verify cause in submission order when several differ, the loop's own rule",
    async () => {
      await gradeEveryCase(ORDERED_CAUSE_PAIRS, TIE_BREAK_ROWS, expectFirstCauseRecorded);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  // REQUIREMENT 14.35 BY NAME, DEFERRED HERE FROM TASK 6.11, where it was not implementable:
  // 14.35's subject is the Verification_Loop this group builds, and `FallbackReason`,
  // `FormalProvenance`, and `fallbackReason` did not exist in `app/` at that point, so integration
  // test 11 measured the pre-pass cause alone. The field now exists as `FormalProvenance`'s
  // `fallbackReason`, typed `CouldNotVerifyCause | null`; no type NAMED `FallbackReason` was ever
  // declared, so that field is the whole of the Fallback_Reason.
  //
  // ON THIS CLASS THE SIMULATION_FALLBACK IS MEASURED CORRECT RATHER THAN ASSUMED, because iverilog
  // reported 0 mismatches over 40 randomised cycles on the very case the gate refused - the gate
  // itself was measured to REFUTE that true property - so here the fallback is the demonstrably
  // right answer rather than merely the honest one
  // (`chipAgent/_inbox/gotcha-mixed-edge-clocking-collapses-in-write-smt2-and-falsely-refutes.md`).
  // That is recorded evidence the iverilog run discharged; nothing below re-measures it.
  it('decides a clock-contract-unsupported refusal by the Simulation_Fallback and records clock-contract-unsupported', async () => {
    // Non-vacuity: both refused clock readings ran, not merely one.
    expect(new Set(CLOCK_CONTRACT_CASES.map((c) => c.clockPolarity))).toEqual(
      new Set<ClockPolarity>(['negedge', 'mixed']),
    );
    for (const c of CLOCK_CONTRACT_CASES) {
      expectClockContractFallback(c, await observe(c));
    }
  });

  it('decides a refused Property_Set by the Simulation_Fallback without submitting it, and records no Fallback_Reason', async () => {
    for (const c of REFUSED_CASES) {
      expectRefusedSetFallback(c, await observe(c));
    }
  });
});
