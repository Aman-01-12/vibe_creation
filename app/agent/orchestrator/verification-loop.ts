// The Verification_Loop (S7): the M1 agentic hero loop that layers generate ->
// simulate -> fix on top of the M0 oracle-path spine (Req 8.1-8.6, 8.9; design
// "End-to-end hero loop" and "Verification loop design").
//
// The non-negotiable invariant: the language model proposes and the deterministic
// Simulator decides. This loop NEVER judges correctness from model output. It
// compiles and simulates the candidate against an INDEPENDENTLY derived Testbench
// in the sandbox, treats the Simulator verdict as the sole authority (Req 8.2),
// records each verdict/iteration span in the Trace (Req 8.8), and repairs the RTL
// from the simulator output when the oracle does not pass - all bounded by one
// Session_Budget so the loop always terminates.
//
// Anti-circular by construction (Property 4): generation (S4) and testbench
// generation (S6) both derive from the approved Spec and run in PARALLEL. The
// testbench request is assembled from the Spec + intent BEFORE any RTL exists and
// is structurally incapable of carrying RTL (see the Testbench_Agent), so a
// passing check can never be an artifact of the implementation it is testing.
//
// A pass must be COMPLETE, not just clean (Req 7.3, 8.10). The Simulator oracle
// reads standard output, so it can only judge the checks a run actually printed; it
// cannot know which ones the Spec required. This loop is the one place that holds
// both facts, so it keeps the Testbench_Agent's required check names from setup and
// refuses to accept a `pass` whose evidence is incomplete: a required check that
// printed nothing was not verified, and the passes that did print are not a
// substitute for it. See `#incompleteEvidence`.
//
// Verified is oracle-bound (Req 8.3, 8.9, 14.2, 14.8): on a passing verdict the
// loop asks the Trust_Labeler for `Verified` bound to the recorded oracle span,
// regardless of budget status - a pass discovered on the last affordable run still
// yields `Verified`, because the label depends on the recorded verdict, not on the
// budget. On exhaustion the loop presents the last failing case labeled
// `Unverified` and exposes a Teach_Mode handoff seam (Teach_Mode itself is task
// 16.4; this loop only produces the handoff payload).
//
// Budget reconciliation (single interface): the Generation_Agent and
// Testbench_Agent consume the model-router `SessionBudgetHandle` port (the mutable
// `InMemorySessionBudgetHandle` derived from a core `SessionBudget`). This loop
// threads that SAME handle through generation, testbench, and its own per-iteration
// simulate accounting, so exactly one budget bounds the whole loop. Each model call
// (charged by the Model_Router) and each simulate (charged here via `charge`) counts
// an iteration, so within `maxIterations` the loop is guaranteed to stop.
//
// All collaborators are injected as narrow ports (no globals, no direct provider or
// store calls, no import of `app/api`). Any thrown sandbox/infra failure is caught
// and classified `error` (fail safe), never crashing the loop.

import {
  makeVerificationResult,
  missingCheckNames,
  unverified,
  type BudgetStopReason,
  type FailingCase,
  type Json,
  type ModuleInterface,
  type ModuleVersion,
  type Result,
  type Spec,
  type Testbench,
  type TraceSpan,
  type TrustLabeler,
  type Ulid,
  type UnverifiedArtifact,
  type Verdict,
  type VerificationResult,
  type VerifiedArtifact,
  newUlid,
} from '@app/core';
import {
  countValuelessFailureReports,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  refusedWithoutProof,
} from '@app/tools';
import type {
  ArtifactBlobRef,
  ClockPolarity,
  CounterexampleCapture,
  CouldNotVerifyCause,
  FormalOraclePort,
  FormalOutcome,
  FormalProperty,
  FormalProveSetRequest,
  PropertyResult,
  ResetContract,
  ResourceLimits,
  SimulationVerdict,
  SimulatorAdapter,
  SourceFile,
} from '@app/tools';

import type { ActionRecorder, SpanDraft } from '../action-recorder/index.js';
import type {
  AttemptCost,
  ModelRouterFailure,
  ModelRouterFailureCode,
  SessionBudgetHandle,
} from '../model-router/index.js';
import type {
  CandidateEval,
  CandidateFailure,
  GeneratedCandidate,
  GenerationInput,
} from '../roles/generation/index.js';
import { sourceEmitsCheck } from '../roles/testbench/index.js';
import type {
  GenerateTestbenchRequest,
  RepairTestbenchRequest,
  TestbenchGenerationFailureReason,
  TestbenchGenerationOutcome,
  TestbenchParseRefusal,
} from '../roles/testbench/index.js';

import { normalizeDialect, type NormalizerReport } from './dialect/normalizer.js';
import { FORMAL_ORACLE_VERSION } from './formal-oracle-version.js';
import type {
  ConfirmedGenerationContext,
  GenerationAdmissionRequest,
  GenerationGateRefusal,
} from './generation-gate.js';
import type { InstrumentAdmission, InstrumentAdmissionDecision } from './instrument-admission.js';
import { buildRepairHint, describePrecheckDiagnostic, type RepairHint } from './repair-hint.js';
import { TestbenchPrecheck, type PrecheckDiagnostic } from './testbench-precheck.js';

/** The Trace `stageOrTool` name recorded for every oracle verdict this loop runs. */
const VERIFICATION_STAGE = 'Verification_Loop' as const;

/**
 * The Trace `stageOrTool` name recorded for a formal gate run.
 *
 * Distinct from `VERIFICATION_STAGE`, because the span a `Verified` label binds to has to
 * name WHICH gate established it: a reader following `oracleSpanId` must be able to tell a
 * proof from a simulate run without reading the outcome that pointed at it.
 */
const FORMAL_STAGE = 'Formal_Oracle' as const;

/**
 * The generation port the loop drives: produce a first candidate and revise a
 * candidate from simulator output. `GenerationAgent` satisfies this structurally,
 * so the loop depends on the two primitives it needs, never the whole agent.
 */
export interface CandidateGenerator {
  generateCandidate(
    input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>>;
  reviseFromErrors(
    input: GenerationInput,
    previousRtl: string,
    diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>>;
}

/** The independent-testbench port the loop drives. `TestbenchAgent` satisfies it. */
export interface IndependentTestbenchGenerator {
  generateTestbench(
    request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome>;
  /** The same repair primitive `TestbenchAgent#repairTestbench` exposes (Req 8.1, 8.2). */
  repairTestbench(
    request: RepairTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome>;
}

/**
 * The generation-gate opener the loop uses ONCE per run to mint the confirmed
 * context, then reuses across repair iterations. `GenerationGate` satisfies this
 * (its `openGenerationContext`), so the loop never re-opens the gate mid-run and
 * never depends on the gate's generic runner parameter.
 */
export interface GenerationContextOpener {
  openGenerationContext(
    request: GenerationAdmissionRequest,
  ): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>>;
}

/**
 * What the Property_Set admission gate made of this run: a CLOSED FOUR-MEMBER vocabulary.
 *
 * `'admitted'`    the gate ran, its gate set was NON-EMPTY, and the Property_Set refuted
 *                 all of it.
 * `'no-gate-set'` the gate RAN and its gate set was EMPTY, so no mutant was both
 *                 judge-killed and formally scorable and nothing held the Property_Set to
 *                 account.
 * `'refused'`     the gate ran and the Property_Set PROVED a mutant the independent judge
 *                 killed (Req 10.2).
 * `'not-gated'`   NO admission gate ran at all, which is the product path, where a student
 *                 session has no reference design to score a mutant of.
 *
 * FOUR MEMBERS RATHER THAN `boolean | null`, WHICH IS WHAT THIS FIELD USED TO BE. The gate
 * in `app/eval/property-set-admission.ts` reports THREE outcomes, and all three old
 * spellings are wrong for the third one: `true` is the vacuous pass that gate explicitly
 * refuses to spell, because killing nothing proves nothing; `false` reports a refusal that
 * never happened; and `null` conflates "no gate ran" with "the gate ran and had nothing to
 * test". The claim the old wording rested on is retained in full - "not gated here" and
 * "gated and refused" are different facts - and the fourth state is that same rule applied
 * once more rather than a new tradeoff.
 *
 * NOT NULLABLE: `'not-gated'` already states the fact a `null` would carry, and two
 * spellings of one fact is the same conflation hazard inverted.
 *
 * A STRING union rather than a tagged object union, in the shape `CouldNotVerifyCause` and
 * `ClockPolarity` already take: this field carries no payload and MUST NOT grow one. The
 * surviving mutants are evidence about the Property_Set that belongs to the eval layer's own
 * refusal and to the persisted record, and a refusal crossing into the loop must carry no
 * field a reader could take for a verdict about the candidate design (Req 10.10). A string
 * member cannot grow such a field by accident.
 *
 * DELIBERATELY NOT `app/eval`'s OWN `PropertySetAdmission`, and the obvious refactor of
 * importing that type to delete the duplication is FORBIDDEN rather than merely
 * unfashionable: `app/agent` holds no import of `app/eval` (Req 11.11, 13.6), which is the
 * same boundary that keeps the admission decision out of the loop in the first place. This
 * is a PARALLEL closed vocabulary the eval layer maps onto at the point it hands the loop a
 * Property_Set - `app/eval` owns the three measured members, the Verification_Loop owns
 * `'not-gated'` alone, and the duplication is bounded to four string literals and no
 * behaviour, which is what makes it cheaper than the boundary violation.
 *
 * THE ARRAY IS THE DECLARATION AND THE TYPE DERIVES FROM IT, in the shape
 * `CLOCK_POLARITIES` already takes one layer down. A bare union would leave every
 * generator and every exhaustiveness check restating the member list by hand, which is how
 * a widened vocabulary silently stops being covered: `app/test/formal-arbitraries.ts`
 * spreads this array, so a fifth member fails to COMPILE there rather than going
 * ungenerated while the suite still reports green.
 */
export const PROPERTY_SET_ADMISSION_OUTCOMES = [
  'admitted',
  'no-gate-set',
  'refused',
  'not-gated',
] as const;

/** One member of the four-member Property_Set admission vocabulary. */
export type PropertySetAdmissionOutcome = (typeof PROPERTY_SET_ADMISSION_OUTCOMES)[number];

/**
 * WHY a sample did or did not take the Simulation_Fallback: the closed four-member
 * Fallback_Route vocabulary, recorded on EVERY sample's terminal outcome (Req 7.18).
 *
 *   - `cause` - a Could_Not_Verify_Cause decided it, and the `fallbackReason` names which
 *     one (Req 7.7, 7.19).
 *   - `property-set-refused` - the Property_Set_Admission gate refused the Property_Set, so
 *     the simulation decides and nothing was submitted to the Formal_Oracle (Req 10.3).
 *   - `no-property-expressed` - the Property_Set holds no Formal_Property (Req 7.20).
 *   - `not-applicable` - the sample did not take the Simulation_Fallback: the formal verdict
 *     decided it, or no formal gate was wired at all.
 *
 * A REFUSAL AND AN EMPTY PROPERTY_SET ARE DELIBERATELY NOT MEMBERS OF
 * `CouldNotVerifyCause`, which is why this vocabulary exists at all rather than two more
 * causes being added to that one. Every cause-keyed count - the summary's own cause
 * breakdown, the Fallback_Reason breakdown, the `frontend-rejected` tally - is built on the
 * Could_Not_Verify_Cause vocabulary, and NEITHER of those two facts is a fact about the
 * instrument's VERDICT: a refusal says the Property_Set was too blunt to hold a design to,
 * and an empty set says nothing was ever asked. Folding either into a cause would put a
 * sample the Formal_Oracle never answered about into a count of its answers.
 *
 * THE `no-property-expressed` ROUTE HAPPENS ON THE STUDENT PATH, whenever the
 * Property_Author could express no acceptance criterion of the Spec in the dialect, and that
 * is the reason it is recorded as its own member rather than left as a silent fall back:
 * "no property could be stated for this spec" is what a student should be TOLD, and
 * `unexpressedCriteria` already names which criteria, so the honest message is reachable
 * instead of silence.
 *
 * THE ARRAY IS THE DECLARATION AND THE TYPE DERIVES FROM IT, by the rule
 * `PROPERTY_SET_ADMISSION_OUTCOMES` above states: a fifth member then fails to COMPILE in
 * every generator that spreads this array, rather than going ungenerated under a green suite.
 */
export const FALLBACK_ROUTES = [
  'cause',
  'property-set-refused',
  'no-property-expressed',
  'not-applicable',
] as const;

/** One member of the four-member Fallback_Route vocabulary. */
export type FallbackRoute = (typeof FALLBACK_ROUTES)[number];

/**
 * The route a sample took, carrying its Fallback_Reason EXACTLY on the one route that has
 * one (Req 7.19).
 *
 * The iff of Req 7.19 - a Fallback_Reason beside `cause` and beside no other member - is
 * made a TYPE rule here rather than a runtime guard, so no call site can record a cause
 * without the route or a route without its cause. The two flat fields of `FormalProvenance`
 * are then both projections of this one value, decided once by `formalProvenanceOf`.
 */
type TakenRoute =
  | { readonly route: 'cause'; readonly reason: CouldNotVerifyCause }
  | { readonly route: Exclude<FallbackRoute, 'cause'> };

/** The route of a sample the Simulation_Fallback did not decide. */
const NOT_A_FALLBACK: TakenRoute = Object.freeze({ route: 'not-applicable' });

/**
 * The already-validated, already-admitted Property_Set for ONE run, plus the two
 * run-level facts `FormalProvenance` records about it.
 *
 * `properties` is in SUBMISSION ORDER, and it cannot carry a raw string: every
 * expression field of a `FormalProperty` is a `ValidatedExpression`, so model text
 * that did not pass the validator has no channel here (Req 6.13, 11.9).
 *
 * `propertySetAdmitted` arrives ALREADY DECIDED and the loop never computes it. The
 * mutation gate on the property set reads a reference design, a student session has
 * none, and `app/agent` must not import `app/eval` - so the loop receives a set that
 * has already been admitted, or `'not-gated'` where no admission gate ran (Req 10.3, 13.6).
 *
 * A set stamped `'refused'` is never submitted NO MATTER WHAT `properties` HOLDS, and that is
 * the loop's own guard rather than a contract the caller owes: `withheldSetRoute` refuses a
 * refused set before anything reaches the `FormalOraclePort`, so the Simulation_Fallback
 * decides that sample (Req 10.3). The eval layer may still hand over an emptied set, and that
 * is now belt-and-braces instead of the only thing standing between a refusal and a
 * `Verified` label - see `withheldSetRoute` for why relying on the caller failed once.
 */
export interface FormalPropertySet {
  readonly properties: readonly FormalProperty[];
  /** Acceptance criteria the Property_Author could not express in the dialect (Req 6.17). */
  readonly unexpressedCriteria: readonly string[];
  /** The admission outcome; `'not-gated'` on the product path, which has no reference design. */
  readonly propertySetAdmitted: PropertySetAdmissionOutcome;
}

/**
 * The source of one run's Property_Set.
 *
 * A narrow port the Property_Author (group 9) satisfies structurally, exactly as
 * `GenerationAgent` satisfies `CandidateGenerator`, so the loop depends on the one
 * primitive it needs rather than on the whole role.
 *
 * It takes the Spec and NO parameter a candidate design source could occupy, which is
 * the same structural RTL-blindness `generateTestbench` already has (Req 6.16). The
 * budget handle is the loop's own single handle, so a model-driven author cannot spend
 * unaccounted time either.
 */
export interface PropertySetSource {
  propertySetFor(spec: Spec, budget: SessionBudgetHandle): Promise<FormalPropertySet>;
}

/**
 * The formal gate: the oracle that decides one property, and the source of the set.
 *
 * OPTIONAL ON `VerificationLoopDeps`, AND THAT IS A DELIBERATE TRADE. Required would
 * break all ten existing construction sites, nine of which measure something else
 * entirely and would each have to carry an oracle they never call - and a fixture
 * nobody reads is how a fake starts drifting from the port it stands for. Optional buys
 * that at the cost of a THIRD state: NO GATE WAS INJECTED, which must not collapse into
 * "no property was submitted" and must not collapse into "a property could not be
 * verified". All three stay separable on the record:
 *
 *   - a property could not be verified -> `fallbackRoute` is `'cause'` and `fallbackReason`
 *     names it (Req 7.7, 7.19);
 *   - a gate ran over an EMPTY set -> `fallbackRoute` is `'no-property-expressed'`, or
 *     `'property-set-refused'` where the admission gate refused it, `results` is empty, and
 *     `unexpressedCriteria` names what the author could not express, which for an empty
 *     set is every criterion of the Spec, because the expressed and the unexpressed sets
 *     partition the Spec's criteria (Req 6.15, 6.17);
 *   - NO GATE was injected -> `fallbackRoute` is `'not-applicable'`, `results` is empty, AND
 *     `unexpressedCriteria` is empty, because nothing was ever asked.
 *
 * The last two are therefore distinguishable over every input that REACHES this gate, and
 * since Req 7.18 they are told apart by the route ALONE rather than by a joint reading. The
 * partition rule still holds underneath it: a Spec carrying no acceptance criterion never
 * gets here, because Loop_Setup refuses it first as `no-simulation-criteria`.
 *
 * Bundled as ONE dep rather than two optional ones, so "an oracle with no property
 * source" and "a property source with no oracle" have no representation.
 */
export interface FormalGate {
  readonly oracle: FormalOraclePort;
  readonly properties: PropertySetSource;
}

/** The injected collaborators and deterministic seams for the Verification_Loop. */
export interface VerificationLoopDeps {
  /** The generation gate opener; called once, its token reused across iterations. */
  readonly gate: GenerationContextOpener;
  /** The Generation_Agent primitives that generate and repair candidate RTL. */
  readonly generator: CandidateGenerator;
  /** The RTL-isolated Testbench_Agent that derives the independent Testbench. */
  readonly testbench: IndependentTestbenchGenerator;
  /** The Simulator oracle: compile+simulate candidate + Testbench in the sandbox. */
  readonly simulator: SimulatorAdapter;
  /** The Action_Recorder that appends each ordered, sanitized verdict span. */
  readonly recorder: ActionRecorder;
  /** The oracle-derived Trust_Labeler: the only path to a `Verified` label. */
  readonly trustLabeler: TrustLabeler;
  /**
   * The optional Instrument_Admission port, consulted at most once per run, after
   * a Testbench_Precheck that did not attribute a build failure to the Testbench
   * and before the first iteration (Req 4.1, 4.2).
   *
   * Absent by default: a runner that does not wire this sees behaviour identical
   * to a run with the port wired but reporting `undecided` on every call (Req 4.9;
   * design Property 7, "the only difference an admission port can make is a
   * refusal"). The Testbench_Precheck itself needs no equivalent field - the loop
   * already holds `#simulator` and builds its own `TestbenchPrecheck` from it, so
   * that gate is unconditional rather than another optional dependency.
   */
  readonly instrumentAdmission?: InstrumentAdmission;
  /**
   * The optional formal gate, run ONCE per sample after the candidate is produced and
   * before the simulation path (Req 7.6, 7.11, 8.6, 14.35).
   *
   * Absent by default: a runner that does not wire it sees exactly the behaviour this
   * loop had before the gate existed, and the record says so rather than implying a
   * formal run happened. See `FormalGate` for why it is optional and how the absent
   * case stays distinguishable from an empty Property_Set.
   */
  readonly formal?: FormalGate;
  /** ULID source for verification-result ids; defaults to `newUlid`. */
  readonly newId?: () => Ulid;
  /** Wall-clock source for recorded span timing; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Which step of the loop a progress event reports. */
export type VerificationPhase =
  | 'setup'
  | 'simulating'
  | 'repairing'
  | 'verified'
  | 'exhausted'
  | 'blocked'
  | 'setup-failed'
  | 'instrument-refused';

/**
 * A non-blocking progress event streamed while the loop runs (Req 6.7, 17.6).
 *
 * A domain event; the API_Gateway maps it to its own stream frame. The agent layer
 * never imports the gateway, so the shape stays provider-neutral.
 */
export interface VerificationProgressEvent {
  readonly kind: 'progress';
  /** The 1-based verification iteration this event belongs to (0 during setup). */
  readonly iteration: number;
  readonly phase: VerificationPhase;
  /** The oracle verdict, when the event reports one. */
  readonly verdict?: Verdict;
  /** A short, non-sensitive human-readable status line. */
  readonly message: string;
}

/**
 * The Teach_Mode handoff payload produced on exhaustion (Req 8.5).
 *
 * This is the seam only: it carries the failing case and sanitized diagnostics for
 * the Teach_Mode role (task 16.4) to coach on. This loop never invokes Teach_Mode.
 */
export interface TeachModeHandoff {
  readonly sessionId: Ulid;
  readonly specId: Ulid;
  readonly moduleVersionId: Ulid;
  /** The concrete failing case to coach on, or `null` if none was localized. */
  readonly failingCase: FailingCase | null;
  /** Student-facing, sanitized diagnostics (no hosts, paths, or stack traces). */
  readonly diagnostics: string;
  readonly stopReason: BudgetStopReason;
}

/**
 * The closed vocabulary naming the STAGE at which a Testbench_Repair attempt
 * declined (Req 3.1). Nothing wider: a decline recorded at the precheck trigger
 * point and a decline recorded at the control trigger point must be comparable
 * without translation (Req 3.10), which only holds if both draw from this one list.
 */
export type RepairDeclineReason =
  | 'no-admissible-revision'
  | 'coverage-validation-failed'
  | 'recheck-failed'
  | 'port-threw'
  | 'port-unavailable';

/**
 * Whether this sample's testbench reached a Testbench_Repair attempt, what hint
 * that attempt was built from, and either the source it replaced or the stage at
 * which it declined.
 *
 * A first-class, closed shape - never free text folded into an existing note or
 * diagnostic (Req 4.2). Required (not optional) on every outcome that can reach a
 * repairable point: an optional field defaults to absent at every existing
 * construction site, and absent would have to be read as "not repaired" - a claim
 * a future reader could not verify unless it were stated everywhere.
 *
 * A discriminated union rather than two parallel optional fields, so the illegal
 * states have no representation: `attempted` and `accepted` stay readable on
 * EVERY member (so `artifact-sink.ts`, `summary.ts`, and the record encoder keep
 * their existing two reads compiling unchanged), while `hint`, `declineReason`,
 * and `replacedSource` are reachable only after narrowing. An accepted attempt has
 * no `declineReason` field to set (Req 3.3), and a not-attempted provenance has
 * neither that nor a `hint` (Req 3.4) - both facts a type checker enforces rather
 * than a validation.
 */
export type RepairProvenance =
  | { readonly attempted: false; readonly accepted: false }
  | {
      readonly attempted: true;
      readonly accepted: false;
      readonly hint: RepairHint;
      readonly declineReason: RepairDeclineReason;
    }
  | {
      readonly attempted: true;
      readonly accepted: true;
      readonly hint: RepairHint;
      /** The pre-repair source the accepted revision replaced (Req 2.4). */
      readonly replacedSource: string;
    };

/** The unrepaired baseline every outcome starts from; unchanged in value. */
export const NO_REPAIR: RepairProvenance = Object.freeze({ attempted: false, accepted: false });

/** The only way to build a declined provenance: a reason is not optional (Req 3.2). */
export function repairDeclined(hint: RepairHint, reason: RepairDeclineReason): RepairProvenance {
  return { attempted: true, accepted: false, hint, declineReason: reason };
}

/** The only way to build an accepted one (Req 3.3). */
export function repairAccepted(hint: RepairHint, replacedSource: string): RepairProvenance {
  return { attempted: true, accepted: true, hint, replacedSource };
}

/** Total reader for the record encoder; `null` for both non-declined members (Req 3.11). */
export function repairDeclineReasonOf(provenance: RepairProvenance): RepairDeclineReason | null {
  return provenance.attempted && !provenance.accepted ? provenance.declineReason : null;
}

/**
 * What the Dialect_Normalizer did to the ONE Testbench source measured for this
 * sample, and the pre-normalization evidence needed to detect a silently emptied
 * instrument (Req 4.14, 4.18, 5.8).
 *
 * Required (not optional) on every outcome that reaches a normalized Testbench, for
 * the same reason `RepairProvenance` is required rather than optional (see that
 * type's own comment): an absent field would default to absent at every existing
 * construction site and would have to be read as "not normalized", a claim no
 * future reader could verify unless it were stated everywhere. `preNormalizationSource`
 * is present only `WHERE report.changed`, so a sample the transform left untouched
 * carries no second copy of a source that is byte-identical to `testbench.source`.
 */
export interface NormalizationProvenance {
  readonly report: NormalizerReport;
  /** The pre-normalization source; present only when `report.changed` is `true`. */
  readonly preNormalizationSource: string | null;
  /**
   * Which of the run's REQUIRED check names the PRE-normalization source actually
   * emitted (Req 5.8), computed here because Loop_Setup is the only place the
   * pre-normalization text exists at all - `#iterate` and everything downstream
   * of it read the single post-normalization source through `testbenchSourceOf`.
   */
  readonly preNormalizationCheckNames: readonly string[];
  /**
   * Valueless_Failure_Reports in the POST-normalization source this provenance describes
   * (Req 5.3, 5.4): a derived per-sample fact riding here because this is where that source
   * is established, and an accepted repair replaces this whole value.
   */
  readonly valuelessFailureReports: number;
}

/**
 * The marker recorded where a `refuted` result's Counterexample has NO USABLE LOCATOR: the
 * run handed back no capture for it, or handed one back whose `reference` fails the shape
 * every `ArtifactBlobRef` must hold (Req 12.25).
 *
 * THIS IS THE ONE SILENT CASE, AND IT IS WHY THIS MARKER EXISTS RATHER THAN A `null`. The
 * eval layer rebuilds a reference from its three fields and records `null` for one that
 * fails them, so before this marker a refutation whose locator was malformed reached the
 * store as the SAME VALUE a sample that was never refuted reaches it as - no file AND no
 * note, which beside a recorded refutation reads as "no evidence was ever produced". Every
 * other way a `refuted` sample can lack its trace already names itself: `'over-cap'`,
 * `'unresolved'`, and `'read-failed'` are the three `CounterexampleRefusal` members, and
 * this is the fourth note in that closed set.
 *
 * IT CARRIES NO `reference`, DELIBERATELY. The thing it reports is that the recorded
 * locator is not one, so passing the failing value along would invite a reader to locate
 * something with it; and a shape-failing reference can hold arbitrary text, which has no
 * business crossing into a note.
 *
 * NOT A FOURTH `CounterexampleRefusal` MEMBER, even though it joins those three at the
 * note. That vocabulary belongs to the Formal_Oracle and every member of it is a fact the
 * ORACLE established while reading bytes it had a locator for. This is a fact about the
 * locator itself, established HERE, one layer up, by the only owner that sees the capture
 * and the result it is paired with together.
 *
 * LIKE EVERY OTHER REASON A TRACE CAN BE MISSING, IT CANNOT MOVE A Formal_Verdict. The
 * refutation was decided by the Base_Check and the trace is its evidence rather than its
 * cause, so this marker is recorded BESIDE a `refuted` result and never instead of one.
 */
export interface MalformedCounterexampleReference {
  readonly kind: 'malformed-reference';
}

/**
 * A Counterexample_Capture as the RECORD carries it: the oracle's own two arms, or the
 * marker above where the refutation's locator is unusable.
 *
 * A third arm rather than a nullable capture, for the reason `FallbackRoute` is a closed
 * vocabulary rather than a nullable cause: `null` here means "this result is not `refuted`,
 * so there is no counterexample to carry", and that is a different fact from "this result
 * IS `refuted` and its evidence cannot be located". One spelling cannot hold both.
 */
export type RecordedCounterexampleCapture =
  CounterexampleCapture | MalformedCounterexampleReference;

/**
 * What the Formal_Oracle established for this sample, and the contract it was
 * established under (Req 7.7, 7.8, 10.8, 12.11, 14.27, 14.39).
 *
 * Required (not optional) on every terminal outcome that reached a candidate, for the
 * same reason `NormalizationProvenance` above is required: an optional provenance
 * defaults to absent at every construction site, and absent would have to be read as
 * "formal was not attempted" - a claim no future reader could verify unless it were
 * stated everywhere.
 *
 * NO NEW `VerificationOutcome` MEMBER AND NO NEW `SampleOutcomeStatus` CARRY THIS.
 * A `could-not-verify` sample is decided by the Simulation_Fallback, so it terminates
 * through the statuses that already exist. A sixth union member would add a branch to
 * the Eval_Harness, the sweep report, the golden judge, BOTH denominator predicates,
 * and the summary, for a state whose whole content is "the other gate decided this" -
 * and every denominator rule would then have to be restated for it. The distinction is
 * carried here, as a typed verdict on the record, which is where it is actually read.
 */
export interface FormalProvenance {
  /**
   * One result per SUBMITTED Formal_Property, in submission order.
   *
   * Empty where no property was submitted, which is the honest value rather than a
   * placeholder: the field's unit is a submitted property, so no submission is no
   * element. There is deliberately no sentinel result and no `attempted` flag beside
   * it - either would be a second, looser way to say what the empty array already says.
   */
  readonly results: readonly PropertyResult[];
  /**
   * The Property_Wrapper source the Formal_Oracle rendered for each submitted property,
   * paired BY INDEX with `results`, or `null` for a property no wrapper was rendered for
   * (Req 12.15, 12.23).
   *
   * Copied off the `FormalOutcome` rather than re-rendered, so the wrapper the
   * Artifact_Sink persists is the one the solver ran on: a render needs the design's
   * `ModuleInterface` and each `FormalProperty`, neither of which this record carries, and
   * a second render would be a second source for one fact.
   *
   * Empty where no property was submitted, by the rule `results` follows. Because the
   * pairing is by index, a reader that finds this list a different length from `results`
   * cannot tell which wrapper belongs to which property, and must read every wrapper as
   * absent rather than guess.
   */
  readonly propertyWrapperSources: readonly (string | null)[];
  /**
   * The Counterexample_Capture for each submitted property, paired BY INDEX with `results`,
   * `null` for every result that is not `refuted`, and the malformed-reference marker for a
   * `refuted` one whose evidence cannot be located (Req 12.16, 12.25).
   *
   * Copied off the `FormalOutcome` rather than resolved from the retention store, which is the
   * whole point of the adapter reading the trace at its own run: the store holds 1 MiB total,
   * evicts oldest-first by last write, and keeps filling from every other job on the shared
   * runtime, so a reader that waits for the sample to finish can lose the race. By the time the
   * bytes reach this record they are already off that FIFO.
   *
   * ONE ENTRY PER RESULT, `null` INCLUDED, and here that is GUARANTEED rather than merely
   * contracted: `recordedCapturesOf` maps the results, so this list's length always equals
   * `results`'. The pairing being by index, a reader that nonetheless finds a different length
   * cannot tell which capture belongs to which property and must read every capture as absent
   * rather than guess.
   *
   * THE BYTES RIDE HERE AND NOT ON `PropertyResult`, which still carries the reference and no
   * bytes, so a result's size stays bounded by its field count.
   */
  readonly counterexampleCaptures: readonly (RecordedCounterexampleCapture | null)[];
  /**
   * The Property_Set admission outcome, over the four-member vocabulary
   * `PropertySetAdmissionOutcome` declares; `'not-gated'` on the product path, which has
   * no reference design to mutate.
   *
   * NOT nullable: `'not-gated'` already states the fact a `null` would carry, and two
   * spellings of one fact is the same conflation hazard inverted. See that type for why
   * "not gated here", "gated with nothing to test", and "gated and refused" are three
   * facts rather than two.
   */
  readonly propertySetAdmitted: PropertySetAdmissionOutcome;
  /** Acceptance criteria the Property_Author could not express in the dialect. */
  readonly unexpressedCriteria: readonly string[];
  /**
   * The Could_Not_Verify_Cause that made this sample take the Simulation_Fallback, or
   * `null` where it did not (Req 7.7).
   *
   * A closed shape rather than free text (Req 7.8), so a fallback can never be recorded
   * as prose inside a note, a message, or a diagnostic field where no reader could
   * branch on it.
   */
  readonly fallbackReason: CouldNotVerifyCause | null;
  /**
   * WHY this sample did or did not take the Simulation_Fallback: exactly one member of the
   * closed `FallbackRoute` vocabulary, on EVERY terminal outcome (Req 7.18).
   *
   * NOT nullable and never absent, by the rule `propertySetAdmitted` follows:
   * `'not-applicable'` already states the fact an absent field would have to carry, and an
   * absent field reads as "nobody recorded a route", which no later reader could tell from
   * "this sample did not fall back".
   *
   * `fallbackReason` is non-`null` if and only if this is `'cause'` - see `TakenRoute`, which
   * makes that a type rule at the one site that decides both. So a fall back is ALWAYS
   * explicable: the three reasonless routes each say why in their own name, instead of a
   * `null` reason standing in for three different facts.
   */
  readonly fallbackRoute: FallbackRoute;
  /**
   * The derived Reset_Contract the run was taken under: its net, its polarity, its kind
   * as synchronous or asynchronous, and its free-initial-state fact (Req 14.27).
   *
   * The `ResetContract` union `app/tools/formal/prepass.ts` already owns, and NOT a
   * parallel shape declared here: that union is `renderPropertyWrapper`'s fourth
   * parameter, so a second structurally-similar type would let this record and the
   * wrapper drift apart on the one value they must agree about.
   *
   * `null` means the pre-pass was NEVER REACHED. `{ derived: false }` means it RAN and
   * REFUSED, which is a real outcome that is recorded rather than an error (Req 14.20).
   * The two must stay distinguishable by the same rule `propertySetAdmitted` follows.
   */
  readonly resetContract: ResetContract | null;
  /**
   * Whether the `if (!$initstate)` assertion gate was EMITTED into the Property_Wrapper
   * (Req 14.27).
   *
   * A separate fact from the contract rather than one derivable from it: the gate's
   * emission is the OUTPUT of the two-condition rule - a synchronous reset AND a free
   * initial state - so recording the contract alone leaves a reader re-deriving that
   * rule to know what the wrapper actually carried.
   *
   * A plain non-nullable boolean across both no-run cases, because the gate genuinely
   * was not emitted in either of them; `resetContract` is the field that distinguishes a
   * refusal from a reading that never happened.
   */
  readonly assertionGateEmitted: boolean;
  /**
   * The Clock_Contract the run was taken under, from the closed four-member vocabulary
   * the pre-pass owns (Req 14.39).
   *
   * `null` means the pre-pass was never reached. It is NOT `'none'`: `'none'` is the
   * SUPPORTED no-clocked-state finding, and collapsing an absent reading into it would
   * record a clock contract the run was never taken under.
   */
  readonly clockPolarity: ClockPolarity | null;
  readonly formalOracleVersion: number;
}

/**
 * The provenance of a sample NO formal run happened on.
 *
 * Every field carries the fact rather than a placeholder for it: no property was
 * submitted, so `results` is empty; no admission gate ran, so `propertySetAdmitted` is
 * `'not-gated'` and NOT `'no-gate-set'`, which would claim a gate ran and found nothing to
 * test; the pre-pass was never reached, so `resetContract` and `clockPolarity` are `null`
 * and NOT the refused arm or `'none'`; no Property_Wrapper was built, so none is recorded
 * and no gate was emitted; no result exists to be `refuted`, so `counterexampleCaptures` is
 * empty by the one-entry-per-result rule rather than by a decision of its own; and nothing
 * fell back, so `fallbackReason` is `null` and `fallbackRoute` is `'not-applicable'`.
 *
 * Task 8.3 wires the `FormalOraclePort` and replaces the USES of this constant at the
 * sites where a formal run now happens. It does not replace the definition: a terminal
 * outcome reached before any property could be submitted still needs this exact value.
 */
export const NO_FORMAL_RUN: FormalProvenance = Object.freeze({
  results: [],
  propertyWrapperSources: [],
  counterexampleCaptures: [],
  propertySetAdmitted: 'not-gated',
  propertySetAuthoredUpFront: false,
  unexpressedCriteria: [],
  fallbackReason: null,
  fallbackRoute: 'not-applicable',
  resetContract: null,
  assertionGateEmitted: false,
  clockPolarity: null,
  formalOracleVersion: FORMAL_ORACLE_VERSION,
});

/**
 * The three provenance records every terminal outcome built after Loop_Setup carries.
 *
 * Grouped as one value rather than threaded as three positional parameters: the outcome
 * builders below already take a run's worth of arguments, and the three must travel
 * TOGETHER, so no path can carry a fresh normalization report beside a stale formal
 * record. Internal - the outcomes themselves keep the three as separate named fields,
 * which is what every existing reader already reads.
 */
interface SampleProvenance {
  readonly normalization: NormalizationProvenance;
  readonly repairProvenance: RepairProvenance;
  readonly formal: FormalProvenance;
}

/**
 * What the formal gate decided for one sample, before the simulation path is reached.
 *
 * `not-decided` is ONE member covering the three cases the simulation gate decides - no
 * gate injected, a gate that ran over an empty set, and a fall back - and it is one
 * member rather than three because the loop does the SAME thing in all three: it runs
 * the simulation path unchanged (Req 7.12). The three stay distinguishable where it
 * matters, on the `FormalProvenance` it carries; see `FormalGate`.
 */
type FormalGateDecision =
  | { readonly kind: 'not-decided'; readonly provenance: FormalProvenance }
  | { readonly kind: 'proved'; readonly provenance: FormalProvenance; readonly span: TraceSpan }
  | {
      readonly kind: 'refuted';
      readonly provenance: FormalProvenance;
      readonly span: TraceSpan;
      readonly refuted: RefutedProperty;
    };

/** One refuted property result: the only member that carries a Counterexample (Req 1.10). */
type RefutedProperty = Extract<PropertyResult, { verdict: 'refuted' }>;

/**
 * The set to record when the Property_Set could not be obtained at all.
 *
 * Every field is the fact rather than a placeholder: nothing was submitted, nothing was
 * gated, and no criterion was reported unexpressed, because the author was never reached.
 */
const NO_PROPERTY_SET: FormalPropertySet = Object.freeze({
  properties: [],
  unexpressedCriteria: [],
  propertySetAdmitted: 'not-gated',
  propertySetAuthoredUpFront: false,
});

/**
 * The Formal_Outcome to record where the oracle was never asked, or answered nothing.
 *
 * Reached on three paths, all of them genuinely before any pre-pass: the Property_Set
 * source threw, the set was empty so no property was submitted, and the port itself threw
 * so no outcome exists to read. No reading was taken on any of them, so `resetContract` and
 * `clockPolarity` are `null` and NOT the refused arm or `'none'`, and no Property_Wrapper
 * was built for a gate to be emitted into or for a source to be recorded from.
 *
 * Distinct from `NO_FORMAL_RUN` above, which is the whole `FormalProvenance` for a sample
 * no formal GATE was wired for; this is the outcome half for a gate that was.
 */
const NO_FORMAL_OUTCOME: FormalOutcome = Object.freeze({
  results: [],
  propertyWrapperSources: [],
  counterexampleCaptures: [],
  resetContract: null,
  assertionGateEmitted: false,
  clockPolarity: null,
});

/** The module reached a passing oracle verdict and was labeled `Verified` (Req 8.3). */
export interface VerifiedModule {
  readonly status: 'verified';
  /** The `Verified` label bound to the passing oracle span (Req 14.2, 14.8). */
  readonly label: VerifiedArtifact;
  /** The recorded passing verification result (pass integrity enforced). */
  readonly result: VerificationResult;
  readonly moduleVersion: ModuleVersion;
  readonly testbench: Testbench;
  readonly simulation: SimulationVerdict;
  /** The Trace span that IS the ground truth for the `Verified` label. */
  readonly oracleSpanId: Ulid;
  readonly iterations: number;
  /** Whether a Testbench_Repair was attempted/accepted for this sample (Req 4.2, 4.3). */
  readonly repairProvenance: RepairProvenance;
  /** What the Dialect_Normalizer did to this sample's ONE measured Testbench (Req 4.14). */
  readonly normalization: NormalizationProvenance;
  /** What the Formal_Oracle established, and the contract it was taken under (Req 12.11). */
  readonly formal: FormalProvenance;
}

/** The loop exhausted its budget without a pass; the module is `Unverified` (Req 8.5). */
export interface UnverifiedModule {
  readonly status: 'unverified';
  readonly label: UnverifiedArtifact;
  /** The last recorded non-passing verification result. */
  readonly result: VerificationResult;
  readonly candidate: GeneratedCandidate;
  readonly testbench: Testbench;
  readonly simulation: SimulationVerdict;
  readonly failingCase: FailingCase | null;
  readonly stopReason: BudgetStopReason;
  readonly iterations: number;
  /** The seam handed to Teach_Mode for coaching on the failure (Req 8.5). */
  readonly teachMode: TeachModeHandoff;
  /** Whether a Testbench_Repair was attempted/accepted for this sample (Req 4.2, 4.3). */
  readonly repairProvenance: RepairProvenance;
  /** What the Dialect_Normalizer did to this sample's ONE measured Testbench (Req 4.14). */
  readonly normalization: NormalizationProvenance;
  /** What the Formal_Oracle established, and the contract it was taken under (Req 12.11). */
  readonly formal: FormalProvenance;
}

/** The generation gate refused admission (intent unconfirmed / spec unapproved). */
export interface VerificationBlocked {
  readonly status: 'blocked';
  readonly refusal: GenerationGateRefusal;
}

/**
 * WHY setup failed, as a value rather than as prose.
 *
 * `reason` above says WHICH HALF of setup failed and `detail` says it in words an operator
 * reads. Neither can be branched on safely: `detail` is a sentence, and both halves can fail
 * for causes that mean opposite things to a measurement. This union is the branchable fact,
 * and the distinction it exists to carry is INFRASTRUCTURE versus FINDING:
 *
 *   - `provider-unreachable` - no provider answered at all (the router exhausted its chain,
 *     or the transport breaker refused the call). NOTHING about the model was measured, so a
 *     consumer that treats this as a result is reporting an outage as data.
 *   - `budget-exhausted` - a configured Session_Budget cap stopped setup. The caps are the
 *     experiment, so this IS a result of running it.
 *   - `model-output-unusable` - a provider answered and the answer could not be used
 *     (unparseable output, a testbench that misses acceptance criteria). A reproducible
 *     finding about the model or our prompt.
 *   - `inputs-inadmissible` - setup was refused before any model call, because the inputs
 *     could not admit one (an unapproved Spec, no simulation criteria, an out-of-range seed).
 *     A configuration fact, reproducible by construction.
 *
 * Deliberately REQUIRED. An optional cause would default to absent at every construction
 * site, and absent would have to be read as "not infrastructure" - which is the exact claim
 * that turns a rate-limit burst into 29 measurements.
 */
export type SetupFailureCause =
  'provider-unreachable' | 'budget-exhausted' | 'model-output-unusable' | 'inputs-inadmissible';

/** Setup could not produce a candidate or an independent Testbench (fail safe). */
export interface VerificationSetupFailed {
  readonly status: 'setup-failed';
  readonly reason: 'generation-unavailable' | 'testbench-unavailable';
  /** A short, non-sensitive explanation; never a secret, host, or stack trace. */
  readonly detail: string;
  /** The branchable cause; see `SetupFailureCause` for why `detail` cannot serve. */
  readonly cause: SetupFailureCause;
  /**
   * The rejected testbench draft, present only when `cause` is a coverage gap
   * (Req 6.1, 6.2). Absent for every other setup failure, which has no draft to
   * carry - a `generation-failed` testbench outcome never reached a draft either.
   */
  readonly rejectedTestbench?: string;
  /** The required check names the draft omitted, present alongside `rejectedTestbench`. */
  readonly missingCheckNames?: readonly string[];
  /** The closed parse-refusal code, present when the testbench reply was refused (Req 7.10). */
  readonly testbenchParseRefusal?: TestbenchParseRefusal;
}

/**
 * WHY a Testbench was refused as an instrument, as a value rather than as prose.
 *
 * A closed enum with no free-text field, so the outcome it labels is structurally
 * incapable of carrying a host, a path read from a diagnostic, or a stack trace -
 * the same discipline `SetupFailureCause` already applies to setup.
 */
export type InstrumentRefusalReason =
  /** The precheck, or an iteration, attributed a build failure to the Testbench. */
  | 'testbench-build-failed'
  /** The Instrument_Admission port refused it. */
  | 'instrument-inadmissible';

/**
 * The result of `#admitInstrument`'s one admission step: the refusal to report
 * (or `null` to proceed), the `RepairProvenance` for this step, and - only when a
 * precheck-path repair was accepted - the revised testbench `#iterate` must
 * continue with instead of `setup.testbench` (Req 8.3; design.md "#admitInstrument
 * wiring").
 *
 * A repair can change WHICH testbench source `#iterate` continues with, which the
 * pre-task-6.4 `{ reason; attributedFiles } | null` return could not express; this
 * richer shape carries that fact alongside the refusal-or-null it replaces,
 * rather than introducing a second, easily-desynchronized return value.
 */
interface InstrumentAdmissionResult {
  readonly refusal: {
    readonly reason: InstrumentRefusalReason;
    readonly attributedFiles: readonly string[];
  } | null;
  readonly repairProvenance: RepairProvenance;
  /**
   * Present only when `repairProvenance.accepted` is `true`.
   *
   * `normalization` is the REVISED source's own report (Req 4.3): the first
   * draft's report is superseded once a repair is accepted, because the revised
   * testbench is the one the verdict will be decided from, and the first draft's
   * own (already-normalized) source survives separately as `repairProvenance.replacedSource`.
   */
  readonly revisedTestbench?: {
    readonly testbench: Testbench;
    readonly testbenchFile: SourceFile;
    readonly normalization: NormalizationProvenance;
  };
}

/**
 * The Testbench was refused as an instrument before, or without, an oracle verdict
 * (Req 5.1-5.4).
 *
 * Carries the candidate and the Testbench so a refusal still surrenders a candidate
 * to the independent judge (design "One finding that changes the shape of the
 * solution"): the saving from refusing early is in the iterations spent, never in
 * the evidence a refused sample yields. Carries no `VerificationResult`, no
 * `SimulationVerdict`, and no oracle span id, because no oracle verdict was reached.
 */
export interface InstrumentRefusedModule {
  readonly status: 'instrument-refused';
  readonly reason: InstrumentRefusalReason;
  /** `Unverified`, always: the artifact exists and no oracle passed it. */
  readonly label: UnverifiedArtifact;
  /** The candidate Loop_Setup produced - the field that keeps the golden denominator whole. */
  readonly candidate: GeneratedCandidate;
  /** The instrument that was refused, carried so the artifact names what was rejected. */
  readonly testbench: Testbench;
  /** Submitted files a build diagnostic named; a subset of the run's own paths. */
  readonly attributedFiles: readonly string[];
  /** Whether a Testbench_Repair was attempted/accepted for this sample (Req 4.2, 4.3). */
  readonly repairProvenance: RepairProvenance;
  /** What the Dialect_Normalizer did to this sample's ONE measured Testbench (Req 4.14). */
  readonly normalization: NormalizationProvenance;
  /** What the Formal_Oracle established, and the contract it was taken under (Req 12.11). */
  readonly formal: FormalProvenance;
}

/** The terminal result of a Verification_Loop run. */
export type VerificationOutcome =
  | VerifiedModule
  | UnverifiedModule
  | VerificationBlocked
  | VerificationSetupFailed
  | InstrumentRefusedModule;

/** The prepared, admissible inputs for the iterate phase, or a terminal setup outcome. */
type SetupResult =
  | {
      readonly ok: true;
      readonly firstCandidate: CandidateEval;
      readonly testbench: Testbench;
      /**
       * The spec-derived check names the Testbench MUST report, kept from setup.
       *
       * The oracle reads stdout and cannot know what the run was SUPPOSED to check,
       * so this is the only place that holds both facts. Without it a testbench that
       * reports two of its three checks - both passing - reads as a full pass.
       */
      readonly requiredCheckNames: readonly string[];
      /**
       * The Dialect_Normalizer's report for this sample's ONE Testbench, computed
       * once here (Req 4.1, 4.2) - the only place the pre-normalization source
       * exists before it is discarded.
       */
      readonly normalization: NormalizationProvenance;
    }
  | { readonly ok: false; readonly outcome: VerificationSetupFailed; readonly detail: string };

/**
 * The Verification_Loop (S7).
 *
 * `run` streams progress and returns the terminal `VerificationOutcome`; `verify`
 * drains `run` for callers that do not need streaming. The loop opens the
 * generation context once, runs generation and independent testbench generation in
 * parallel, then iterates simulate -> label-or-repair under one Session_Budget.
 */
export class VerificationLoop {
  readonly #gate: GenerationContextOpener;
  readonly #generator: CandidateGenerator;
  readonly #testbench: IndependentTestbenchGenerator;
  readonly #simulator: SimulatorAdapter;
  readonly #recorder: ActionRecorder;
  readonly #trustLabeler: TrustLabeler;
  readonly #instrumentAdmission: InstrumentAdmission | undefined;
  readonly #formal: FormalGate | undefined;
  readonly #precheck: TestbenchPrecheck;
  readonly #newId: () => Ulid;
  readonly #now: () => number;

  constructor(deps: VerificationLoopDeps) {
    this.#gate = deps.gate;
    this.#generator = deps.generator;
    this.#testbench = deps.testbench;
    this.#simulator = deps.simulator;
    this.#recorder = deps.recorder;
    this.#trustLabeler = deps.trustLabeler;
    this.#instrumentAdmission = deps.instrumentAdmission;
    this.#formal = deps.formal;
    // Built from the loop's own simulator, never injected: the gate is
    // unconditional, so no caller can construct a VerificationLoop without it
    // (design.md, component 5: "The precheck needs no injection").
    this.#precheck = new TestbenchPrecheck(this.#simulator);
    this.#newId = deps.newId ?? newUlid;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Run the generate-simulate-fix loop and stream progress (Req 8.1-8.6, 8.9).
   *
   * Opens the confirmed generation context once (blocking if the gate refuses),
   * runs generation and independent testbench generation in parallel from the
   * approved Spec, then iterates under the Session_Budget until the oracle passes
   * or the budget is exhausted.
   */
  async *run(
    request: GenerationAdmissionRequest,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): AsyncGenerator<VerificationProgressEvent, VerificationOutcome, void> {
    const admission = await this.#gate.openGenerationContext(request);
    if (!admission.ok) {
      yield this.#progress(0, 'blocked', 'generation gate refused admission');
      return { status: 'blocked', refusal: admission.error };
    }

    const context = admission.value;
    const genInput = toGenerationInput(context);
    yield this.#progress(
      0,
      'setup',
      'generating candidate RTL and the independent testbench in parallel',
    );
    const setup = await this.#setup(context, genInput, budget);
    if (!setup.ok) {
      yield this.#progress(0, 'setup-failed', setup.detail);
      return setup.outcome;
    }

    return yield* this.#iterate(context, genInput, setup, budget, limits);
  }

  /**
   * Drain `run`, discarding intermediate progress, and return only the terminal
   * outcome. Callers that need streaming use `run`.
   */
  async verify(
    request: GenerationAdmissionRequest,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): Promise<VerificationOutcome> {
    const iterator = this.run(request, budget, limits);
    let step = await iterator.next();
    while (!step.done) {
      step = await iterator.next();
    }
    return step.value;
  }

  /**
   * Run generation (S4) and independent testbench generation (S6) in parallel from
   * the approved Spec (Req 7.1, Property 4), returning the prepared inputs or a
   * terminal setup failure. The testbench request holds no RTL and is built before
   * any candidate exists, so the anti-circular guarantee holds by construction.
   */
  async #setup(
    context: ConfirmedGenerationContext,
    genInput: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<SetupResult> {
    const [candidate, testbench] = await Promise.all([
      this.#generator.generateCandidate(genInput, budget),
      this.#testbench.generateTestbench(toTestbenchRequest(context), budget),
    ]);

    if (testbench.status !== 'generated') {
      const detail = describeTestbenchFailure(testbench);
      const cause = testbenchFailureCause(testbench);
      const base = {
        status: 'setup-failed',
        reason: 'testbench-unavailable',
        detail,
        cause,
      } as const;
      const outcome: VerificationSetupFailed =
        testbench.status === 'coverage-incomplete'
          ? {
              ...base,
              rejectedTestbench: testbench.source,
              missingCheckNames: testbench.missingChecks.map((check) => check.name),
            }
          : withParseRefusal(
              base,
              testbench.status === 'generation-failed' ? testbench.failure.parseRefusal : undefined,
            );
      return { ok: false, detail, outcome };
    }
    if (!candidate.ok) {
      const detail = candidate.error.detail;
      const cause = candidateFailureCause(candidate.error);
      return {
        ok: false,
        detail,
        outcome: { status: 'setup-failed', reason: 'generation-unavailable', detail, cause },
      };
    }
    const requiredCheckNames = testbench.checks.map((check) => check.name);
    const normalized = normalizeDialect(testbench.testbench.source);
    return {
      ok: true,
      firstCandidate: candidate.value,
      // Spread over the generated Testbench, not `makeTestbench`: the id, `specId`,
      // `specVersion`, `coversCriteria`, and the `sourceAttribution: 'spec'` stamp all
      // came from the agent's own reply and must survive untouched (Req 4.1, 4.17).
      // This is the ONE Testbench value built for this sample - `#iterate` and every
      // terminal outcome read this single post-normalization source from here on.
      testbench: { ...testbench.testbench, source: normalized.source },
      requiredCheckNames,
      normalization: {
        report: normalized.report,
        preNormalizationSource: normalized.report.changed ? testbench.testbench.source : null,
        preNormalizationCheckNames: requiredCheckNames.filter((name) =>
          sourceEmitsCheck(testbench.testbench.source, name),
        ),
        valuelessFailureReports: countValuelessFailureReports(normalized.source),
      },
    };
  }

  /**
   * Run the Testbench_Precheck and, only after it did not attribute a build
   * failure to the Testbench, the optional Instrument_Admission port - both
   * between Loop_Setup and the first iteration (Req 1.4, 4.1, 4.2; design.md
   * "The new setup sequence").
   *
   * On a precheck build failure, attempts ONE Testbench_Repair before refusing
   * (Req 1.1, 1.3, 3.1, 3.3, 3.4, 6.1-6.3, 8.3; design.md "The precheck-path
   * sequence"): the diagnostic comes from `runWithDiagnostic`'s own captured
   * `PrecheckDiagnostic`, never a second simulate call, and a repair that
   * produces a testbench is re-checked by the identical plain `run` a first
   * draft is held to. Every failure mode on this branch - a re-check that still
   * fails, `coverage-incomplete`/`generation-failed`, or a thrown
   * `repairTestbench` call - finalizes the SAME refusal an unrepaired failure
   * would have produced, differing only in `repairProvenance`.
   *
   * Returns the refusal to report (or `null` to proceed unchanged) alongside the
   * `RepairProvenance` for this admission step, and - only when a precheck-path
   * repair was accepted - the revised testbench/file `#iterate` must continue
   * with instead of `setup.testbench`. Every non-repair path returns `NO_REPAIR`:
   * a precheck outcome other than `testbench-build-failed` never reaches a
   * repair attempt at all (Req 1.9), and the Instrument_Admission consultation
   * below is entirely unchanged, degrading to `null` on a thrown or non-refusing
   * `admit` call exactly as before this task (Req 4.5, 4.7, 4.8, 4.9).
   */
  async #admitInstrument(
    testbench: Testbench,
    testbenchFile: SourceFile,
    moduleInterface: ModuleInterface,
    limits: ResourceLimits,
    context: ConfirmedGenerationContext,
    budget: SessionBudgetHandle,
    requiredCheckNames: readonly string[],
  ): Promise<InstrumentAdmissionResult> {
    const { outcome: precheckOutcome, diagnostic } = await this.#precheck.runWithDiagnostic(
      testbenchFile,
      moduleInterface,
      limits,
    );
    if (precheckOutcome === 'testbench-build-failed') {
      return this.#repairPrecheckFailure(
        testbench,
        moduleInterface,
        limits,
        context,
        budget,
        diagnostic,
        requiredCheckNames,
      );
    }
    if (precheckOutcome !== 'undecided' || this.#instrumentAdmission === undefined) {
      return { refusal: null, repairProvenance: NO_REPAIR };
    }

    let decision: InstrumentAdmissionDecision;
    try {
      decision = await this.#instrumentAdmission.admit({ testbench: testbench.source });
    } catch {
      // An unavailable admission check leaves the loop's behaviour as it was
      // before the port existed (Req 4.8).
      return { refusal: null, repairProvenance: NO_REPAIR };
    }
    const refusal =
      decision === 'inadmissible'
        ? { reason: 'instrument-inadmissible' as const, attributedFiles: [] }
        : null;
    return { refusal, repairProvenance: NO_REPAIR };
  }

  /**
   * Attempt ONE Testbench_Repair for a precheck build failure and re-check the
   * revised source, or finalize the unrepaired refusal (Req 1.1, 1.2, 1.3, 2.1,
   * 2.2, 3.1, 3.3, 3.4, 3.5-3.9, 5.1-5.3, 5.5, 6.1-6.3, 6.5, 8.3).
   *
   * The unrepaired refusal shape (`{ reason: 'testbench-build-failed',
   * attributedFiles: [] }`) is identical on every declined path through this
   * method; only the `RepairDeclineReason` the provenance carries names WHICH
   * stage declined (Req 3.5-3.9):
   *
   *   - no `repairTestbench` exposed on the injected port at all -> `port-unavailable`,
   *     checked BEFORE any call is attempted, since this is an absent capability
   *     rather than a call outcome.
   *   - the call throws (the port is a caller-implementable interface, even
   *     though `TestbenchAgent#repairTestbench` itself never throws) -> `port-threw`.
   *   - the call returns `generation-failed` (no draft was produced at all) -> `no-admissible-revision`.
   *   - the call returns `coverage-incomplete` (a draft was produced but failed
   *     the same coverage gate a first draft is held to) -> `coverage-validation-failed`.
   *   - a `generated` revision still reports `testbench-build-failed` on re-check -> `recheck-failed`.
   *
   * Only `accepted: true` differs in outcome shape, carrying the revised
   * testbench forward for `#iterate` to continue with and the pre-repair source
   * it replaced (Req 2.4). The hint every branch was built from rides out on the
   * provenance for BOTH the refusal path and the accepted path (Req 2.1, 2.2), so
   * `InstrumentAdmissionResult` can never return an attempted provenance without
   * one. `repairTestbench` is called at most once here, whatever branch is taken
   * (`testbench-repair-loop` Req 1.5).
   */
  async #repairPrecheckFailure(
    testbench: Testbench,
    moduleInterface: ModuleInterface,
    limits: ResourceLimits,
    context: ConfirmedGenerationContext,
    budget: SessionBudgetHandle,
    diagnostic: PrecheckDiagnostic,
    requiredCheckNames: readonly string[],
  ): Promise<InstrumentAdmissionResult> {
    const unrepairedRefusal = {
      reason: 'testbench-build-failed' as const,
      attributedFiles: [] as readonly string[],
    };

    const hint = buildRepairHint({
      kind: 'precheck-build-failed',
      diagnostic: describePrecheckDiagnostic(diagnostic),
    });
    const declined = (reason: RepairDeclineReason): InstrumentAdmissionResult => ({
      refusal: unrepairedRefusal,
      repairProvenance: repairDeclined(hint, reason),
    });

    // Capability-absence, not a call failure: an injected port that structurally
    // satisfies `IndependentTestbenchGenerator` at the type level can still omit
    // `repairTestbench` at runtime, and that must be checked before attempting
    // the call rather than discovered from a throw (Req 3.9).
    if (typeof this.#testbench.repairTestbench !== 'function') {
      return declined('port-unavailable');
    }

    const request: RepairTestbenchRequest = {
      sessionId: context.sessionId,
      spec: context.approvedSpec,
      previousSource: testbench.source,
      hint,
    };

    let repaired: TestbenchGenerationOutcome;
    try {
      repaired = await this.#testbench.repairTestbench(request, budget);
    } catch {
      return declined('port-threw');
    }
    if (repaired.status === 'coverage-incomplete') {
      return declined('coverage-validation-failed');
    }
    if (repaired.status !== 'generated') {
      return declined('no-admissible-revision');
    }

    // The revised draft is desugared by the same unconditional rule Loop_Setup
    // applies to a first draft (Req 4.3): the precheck re-check and every reader
    // downstream of an accepted repair must see the identical normalized source.
    const normalizedRevision = normalizeDialect(repaired.testbench.source);
    const revisedTestbench: Testbench = {
      ...repaired.testbench,
      source: normalizedRevision.source,
    };
    const revisedTestbenchFile = toTestbenchFile(revisedTestbench, moduleInterface.moduleName);
    const recheckOutcome = await this.#precheck.run(revisedTestbenchFile, moduleInterface, limits);
    if (recheckOutcome === 'testbench-build-failed') {
      return declined('recheck-failed');
    }
    return {
      refusal: null,
      repairProvenance: repairAccepted(hint, testbench.source),
      revisedTestbench: {
        testbench: revisedTestbench,
        testbenchFile: revisedTestbenchFile,
        // The REVISED source's own report (Req 4.3): this is the testbench the
        // verdict will be decided from, so the first draft's report is superseded.
        normalization: {
          report: normalizedRevision.report,
          preNormalizationSource: normalizedRevision.report.changed
            ? repaired.testbench.source
            : null,
          preNormalizationCheckNames: requiredCheckNames.filter((name) =>
            sourceEmitsCheck(repaired.testbench.source, name),
          ),
          valuelessFailureReports: countValuelessFailureReports(normalizedRevision.source),
        },
      },
    };
  }

  /**
   * Iterate simulate -> label-or-repair under the Session_Budget.
   *
   * The candidate we already hold is ALWAYS simulated before any budget check, so a
   * pass discovered on the last affordable run still yields `Verified` (Req 8.9).
   * Only the repair step is gated on remaining budget; a non-pass with no budget
   * left ends the loop with the failing case labeled `Unverified` (Req 8.4, 8.5).
   */
  async *#iterate(
    context: ConfirmedGenerationContext,
    genInput: GenerationInput,
    setup: Extract<SetupResult, { ok: true }>,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): AsyncGenerator<VerificationProgressEvent, VerificationOutcome, void> {
    const moduleName = genInput.spec.moduleInterface.moduleName;
    let testbench = setup.testbench;
    let testbenchFile = toTestbenchFile(testbench, moduleName);
    const firstCandidate = setup.firstCandidate.candidate;

    // The normalization report in play for whichever testbench is currently
    // measured; starts as the first draft's and is superseded below if a
    // precheck-path repair is accepted (Req 4.3), so every outcome constructed
    // from this point on names the source that actually decided its verdict.
    let normalization = setup.normalization;

    const admission = await this.#admitInstrument(
      testbench,
      testbenchFile,
      genInput.spec.moduleInterface,
      limits,
      context,
      budget,
      setup.requiredCheckNames,
    );

    // The repair provenance for this run's precheck-path admission step: whether
    // no repair was ever triggered, one was attempted and declined, or one was
    // attempted and accepted. `admission.repairProvenance` already holds the
    // correct value for every case (Req 1.4, 1.5, 1.6) - an accepted repair's
    // provenance is already `repairAccepted(hint, testbench.source)` from
    // `#repairPrecheckFailure`, so it needs no reassignment on the
    // `revisedTestbench` branch below; every terminal outcome constructed for
    // the rest of this run carries this SAME value forward, never re-derived.
    const repairProvenance = admission.repairProvenance;

    if (admission.refusal !== null) {
      const { refusal } = admission;
      yield this.#progress(
        0,
        'instrument-refused',
        refusal.reason === 'testbench-build-failed'
          ? 'the independent testbench did not build against the spec-derived interface stub'
          : 'the independent testbench was refused as a measuring instrument',
      );
      return {
        status: 'instrument-refused',
        reason: refusal.reason,
        attributedFiles: refusal.attributedFiles,
        label: unverified(firstCandidate.label.artifactRef),
        candidate: firstCandidate,
        testbench,
        // A repair may have been attempted (and declined) on this precheck-path
        // refusal; report exactly what happened.
        repairProvenance,
        normalization,
        // The instrument was refused before the first iteration AND before the formal
        // gate runs below, so no Formal_Property was ever submitted for this sample.
        // This is the one terminal path that keeps the no-run value after task 8.3.
        formal: NO_FORMAL_RUN,
      };
    }
    if (admission.revisedTestbench !== undefined) {
      // Accepted precheck-path repair (Req 3.3): the rest of this run continues
      // against the REPAIRED testbench, never the original that failed its build,
      // and against THAT testbench's own normalization report (Req 4.3).
      ({ testbench, testbenchFile, normalization } = admission.revisedTestbench);
    }

    // FORMAL-FIRST (Req 7.6, 8.6, 14.35). The gate runs ONCE, on the candidate
    // Loop_Setup produced, and decides the sample only where it can: every property
    // `proved` decides `Verified` bound to the formal span, any property `refuted`
    // decides `Unverified` and surrenders the Counterexample, and anything else leaves
    // the decision to the simulation path below - UNCHANGED, which is the whole of
    // Req 7.12: the Simulation_Fallback applies its own instrument rules, its own
    // control rules, and its own denominator predicate, because it IS the same code.
    //
    // It runs after the Instrument_Admission step rather than before it, so a sample
    // whose instrument was refused never submits a property (see the return above),
    // and once rather than per revision: re-deciding a repaired candidate formally is
    // not this task's, and a fallen-back sample is the simulation gate's from here on.
    const formal = await this.#runFormalGate(genInput, firstCandidate, budget, context.sessionId);
    const provenance: SampleProvenance = {
      normalization,
      repairProvenance,
      formal: formal.provenance,
    };

    if (formal.kind === 'proved') {
      yield this.#progress(
        0,
        'verified',
        'the formal oracle proved every submitted property',
        'pass',
      );
      // The SAME pass path the simulation oracle takes, so `Verified` is still bound to a
      // recorded span by the Trust_Labeler and still fails closed if it cannot be - the
      // only difference is WHICH recorded span is the ground truth (Req 14.2, 14.8).
      return this.#onPass(
        firstCandidate,
        testbench,
        noSimulationVerdict('pass', null),
        formal.span,
        0,
        provenance,
      );
    }
    if (formal.kind === 'refuted') {
      yield this.#progress(
        0,
        'exhausted',
        'the formal oracle refuted a submitted property; presenting the counterexample',
        'fail',
      );
      return this.#unverified(
        context,
        firstCandidate,
        testbench,
        noSimulationVerdict('fail', formal.refuted.counterexample),
        formal.span,
        formalFailingCase(formal.refuted),
        0,
        budget.stopReason() ?? 'max-iterations',
        provenance,
      );
    }

    let candidateEval = setup.firstCandidate;
    let iteration = 0;

    while (true) {
      iteration += 1;
      const candidate = candidateEval.candidate;
      yield this.#progress(
        iteration,
        'simulating',
        'compiling and simulating the candidate against the independent testbench',
      );
      const simulation = await this.#simulate(
        { candidate, moduleName, testbenchFile },
        limits,
        setup.requiredCheckNames,
      );
      const span = await this.#recordVerdict(context.sessionId, candidate, simulation, iteration);
      budget.charge(simulateCost(simulation));

      if (simulation.verdict === 'pass') {
        const unreported = missingCheckNames(simulation.checks, setup.requiredCheckNames);
        if (unreported.length > 0) {
          yield this.#progress(
            iteration,
            'exhausted',
            'the oracle passed on incomplete evidence; failing closed',
            simulation.verdict,
          );
          return this.#incompleteEvidence(
            { context, candidate, testbench, simulation, span, iteration },
            unreported,
            provenance,
          );
        }
        yield this.#progress(iteration, 'verified', 'oracle reported every check passing', 'pass');
        return this.#onPass(candidate, testbench, simulation, span, iteration, provenance);
      }

      if (refusedByTestbenchBuild(simulation, testbenchFile.path, `${moduleName}.v`)) {
        yield this.#progress(
          iteration,
          'instrument-refused',
          'the independent testbench failed to build mid-run; refusing rather than repairing RTL',
          simulation.verdict,
        );
        return {
          status: 'instrument-refused',
          reason: 'testbench-build-failed',
          attributedFiles: simulation.attributedFiles,
          label: unverified(candidate.label.artifactRef),
          candidate,
          testbench,
          // A mid-run testbench-build failure never repairs; Requirement 3.4's
          // precheck-path repair only ever runs before the first iteration.
          repairProvenance: NO_REPAIR,
          normalization: provenance.normalization,
          // The formal gate DID run for this sample, before this iteration - so this
          // path reports what it established, never the no-run value.
          formal: provenance.formal,
        };
      }

      const failingCase = failingCaseOf(simulation);
      if (!budget.canAfford()) {
        yield this.#progress(
          iteration,
          'exhausted',
          'budget exhausted without an oracle pass',
          simulation.verdict,
        );
        return this.#unverified(
          context,
          candidate,
          testbench,
          simulation,
          span,
          failingCase,
          iteration,
          budget.stopReason() ?? 'max-iterations',
          provenance,
        );
      }

      yield this.#progress(
        iteration,
        'repairing',
        'oracle did not pass; repairing RTL from the simulator output',
        simulation.verdict,
      );
      const revised = await this.#generator.reviseFromErrors(
        genInput,
        candidate.rtl,
        repairDiagnostics(candidateEval, simulation),
        budget,
      );
      if (!revised.ok) {
        const stopReason =
          revised.error.budgetStopReason ?? budget.stopReason() ?? 'max-iterations';
        yield this.#progress(
          iteration,
          'exhausted',
          'repair unavailable; presenting the failing case as Unverified',
          simulation.verdict,
        );
        return this.#unverified(
          context,
          candidate,
          testbench,
          simulation,
          span,
          failingCase,
          iteration,
          stopReason,
          provenance,
        );
      }
      candidateEval = revised.value;
    }
  }

  /**
   * Request `Verified` from the Trust_Labeler bound to the passing oracle span
   * (Req 8.3, 8.9, 14.2, 14.8). Fails closed: if the passing result cannot be
   * constructed or the labeler declines to bind provenance, the module is presented
   * `Unverified` rather than `Verified` without valid evidence (Req 14.8, 14.12).
   */
  #onPass(
    candidate: GeneratedCandidate,
    testbench: Testbench,
    simulation: SimulationVerdict,
    span: TraceSpan,
    iteration: number,
    provenance: SampleProvenance,
  ): VerificationOutcome {
    const built = makeVerificationResult({
      id: this.#newId(),
      moduleVersionId: candidate.moduleVersion.id,
      testbenchId: testbench.id,
      verdict: 'pass',
      allChecksPassed: true,
      iterations: iteration,
      costCents: 0,
      oracleSpanId: span.id,
    });
    if (!built.ok) {
      return this.#failClosed(candidate, testbench, simulation, span, iteration, provenance);
    }

    const artifactRef = candidate.label.artifactRef;
    const label = this.#trustLabeler.label(artifactRef, [{ artifactRef, result: built.value }]);
    if (label.tier !== 'Verified') {
      return this.#failClosed(candidate, testbench, simulation, span, iteration, provenance);
    }
    return {
      status: 'verified',
      label,
      result: built.value,
      moduleVersion: candidate.moduleVersion,
      testbench,
      simulation,
      oracleSpanId: span.id,
      iterations: iteration,
      repairProvenance: provenance.repairProvenance,
      normalization: provenance.normalization,
      formal: provenance.formal,
    };
  }

  /**
   * Build the `Unverified` exhaustion outcome: the last failing candidate, its
   * failing case, and the Teach_Mode handoff seam (Req 8.5).
   */
  #unverified(
    context: ConfirmedGenerationContext,
    candidate: GeneratedCandidate,
    testbench: Testbench,
    simulation: SimulationVerdict,
    span: TraceSpan,
    failingCase: FailingCase | null,
    iteration: number,
    stopReason: BudgetStopReason,
    provenance: SampleProvenance,
  ): UnverifiedModule {
    const result = nonPassResult({
      id: this.#newId(),
      moduleVersionId: candidate.moduleVersion.id,
      testbenchId: testbench.id,
      verdict: simulation.verdict === 'pass' ? 'error' : simulation.verdict,
      failingCase,
      iterations: iteration,
      oracleSpanId: span.id,
      stopReason,
    });
    const teachMode: TeachModeHandoff = {
      sessionId: context.sessionId,
      specId: context.approvedSpec.id,
      moduleVersionId: candidate.moduleVersion.id,
      failingCase,
      diagnostics: studentDiagnostics(simulation, failingCase),
      stopReason,
    };
    return {
      status: 'unverified',
      label: unverified(candidate.label.artifactRef),
      result,
      candidate,
      testbench,
      simulation,
      failingCase,
      stopReason,
      iterations: iteration,
      teachMode,
      repairProvenance: provenance.repairProvenance,
      normalization: provenance.normalization,
      formal: provenance.formal,
    };
  }

  /**
   * The fail-closed outcome for the (near-impossible) case where a passing run
   * cannot be bound to valid oracle provenance: never present it as `Verified`.
   */
  #failClosed(
    candidate: GeneratedCandidate,
    testbench: Testbench,
    simulation: SimulationVerdict,
    span: TraceSpan,
    iteration: number,
    provenance: SampleProvenance,
  ): UnverifiedModule {
    return this.#refusePass({
      sessionId: candidate.moduleVersion.projectId,
      specId: testbench.specId,
      candidate,
      testbench,
      simulation,
      span,
      iteration,
      provenance,
      failingCase: {
        checkName: 'provenance',
        description: 'A passing run could not be bound to a valid oracle provenance reference.',
        expected: 'a Verified label bound to the recorded passing oracle span',
        observed: 'the passing verdict could not be labeled Verified; failing closed',
        atSimTimeNs: null,
      },
      diagnostics: 'Verification could not confirm provenance for a passing run.',
    });
  }

  /**
   * The fail-closed outcome for a run the oracle passed on INCOMPLETE evidence:
   * the testbench never reported one or more of the checks the Spec required.
   *
   * The oracle reads standard output, so it can only judge the checks the run
   * actually printed; it cannot know which ones were owed. A required check that
   * printed nothing was not verified, and accepting the remaining passes as a full
   * pass is the same class of defect as ignoring an unreadable signal. So the
   * verdict is refused here rather than repaired: the Testbench is fixed for the
   * whole run, so a check the instrument did not report is an instrument gap, and
   * revising the RTL is not its remedy.
   *
   * The unreported NAMES are safe to surface: they are spec-derived check names
   * this process computed itself, never text read back from tool output.
   */
  #incompleteEvidence(
    run: {
      readonly context: ConfirmedGenerationContext;
      readonly candidate: GeneratedCandidate;
      readonly testbench: Testbench;
      readonly simulation: SimulationVerdict;
      readonly span: TraceSpan;
      readonly iteration: number;
    },
    unreportedChecks: readonly string[],
    provenance: SampleProvenance,
  ): UnverifiedModule {
    const named = unreportedChecks.join(', ');
    return this.#refusePass({
      sessionId: run.context.sessionId,
      specId: run.context.approvedSpec.id,
      candidate: run.candidate,
      testbench: run.testbench,
      simulation: run.simulation,
      span: run.span,
      iteration: run.iteration,
      provenance,
      failingCase: {
        checkName: unreportedChecks[0] ?? 'coverage',
        description: `The testbench reported no result for required check(s): ${named}.`,
        expected: 'every spec-derived check to report PASS or FAIL',
        observed: 'the run passed the checks it reported but never reported these',
        atSimTimeNs: null,
      },
      diagnostics: `Required checks the simulation never reported: ${named}.`,
    });
  }

  /**
   * The single owner of the refuse-a-pass shape: an `Unverified` outcome for a run
   * whose oracle verdict was `pass` but whose evidence we decline to accept.
   *
   * Both refusal reasons (unbindable provenance, incomplete check coverage) build
   * the identical outcome, so the shape is defined once and the two callers differ
   * only in the failing case and diagnostics they supply.
   */
  #refusePass(refusal: RefusedPass): UnverifiedModule {
    const { candidate, testbench, simulation, span, iteration, failingCase } = refusal;
    const result = nonPassResult({
      id: this.#newId(),
      moduleVersionId: candidate.moduleVersion.id,
      testbenchId: testbench.id,
      verdict: 'error',
      failingCase,
      iterations: iteration,
      oracleSpanId: span.id,
      stopReason: 'max-iterations',
    });
    return {
      status: 'unverified',
      label: unverified(candidate.label.artifactRef),
      result,
      candidate,
      testbench,
      simulation,
      failingCase,
      stopReason: 'max-iterations',
      iterations: iteration,
      teachMode: {
        sessionId: refusal.sessionId,
        specId: refusal.specId,
        moduleVersionId: candidate.moduleVersion.id,
        failingCase,
        diagnostics: refusal.diagnostics,
        stopReason: 'max-iterations',
      },
      repairProvenance: refusal.provenance.repairProvenance,
      normalization: refusal.provenance.normalization,
      formal: refusal.provenance.formal,
    };
  }

  /**
   * Run the formal gate once over this sample's Property_Set (Req 7.6, 7.11, 8.6, 14.35).
   *
   * One `prove` call per submitted property, in submission order, each one charged to the
   * sample's own Session_Budget as it returns, so a formal run cannot spend unaccounted
   * time (Req 7.11). No property's verdict influences another's: the loop calls the port
   * once per property and records every result, and the decision below reads that record
   * (Req 1.14).
   *
   * THE DECISION ORDER IS `refuted` BEFORE `could-not-verify`, AND IT IS THE FAIL-CLOSED
   * READING. Req 7.6 sends a `could-not-verify` sample to the Simulation_Fallback and the
   * task's own wording sends a `refuted` sample to `unverified`, which leaves a set holding
   * BOTH underdetermined. Refutation wins, because the fallback could then report a pass
   * for a design a formal counterexample refuted, and labelling that `Verified` is exactly
   * the severity-1 direction this spec exists to close. Nothing is merged by that choice:
   * each property's own verdict stands unchanged on the record (Req 1.11), and only the
   * SAMPLE's decision has a precedence rule.
   *
   * AN EMPTY SET NEVER PROVES ANYTHING. Zero properties would satisfy "every property
   * proved" vacuously, which is the same silent-pass shape the five-condition gate exists
   * to refuse, so an empty set returns `not-decided` and the simulation path decides - with
   * NO `fallbackReason`, because no Could_Not_Verify_Cause produced anything, and the
   * Fallback_Route `'no-property-expressed'` saying so in its own name (Req 7.20). See
   * `withheldSetRoute` for the refused set that arrives in the same shape.
   *
   * A REFUSED SET IS NOT SUBMITTED EITHER, WHATEVER IT HOLDS (Req 10.3), and that guard lives
   * in this loop. See `withheldSetRoute`.
   *
   * WHERE THE FALL BACK IS MEASURED CORRECT RATHER THAN ASSUMED. On the
   * `clock-contract-unsupported` class the Simulation_Fallback is the DEMONSTRABLY RIGHT
   * answer and not merely the honest one, which is unusual enough to state plainly:
   * iverilog reported 0 mismatches over 40 randomised cycles on the very mixed-edge case
   * the formal gate refused, while the gate itself was measured to REFUTE a property
   * iverilog confirms is true. Everywhere else the fallback is the honest answer; here it
   * is the correct one. That cause and `reset-contract-unresolved` both arrive from the
   * pre-pass, before any solver ran and before any Property_Wrapper existed, and they are
   * recorded as the Fallback_Reason by the same one line every other cause takes - there is
   * no separate pre-pass branch here, because a cause reported ahead of the condition order
   * is still a `could-not-verify` on the `PropertyResult` the port returns.
   */
  async #runFormalGate(
    genInput: GenerationInput,
    candidate: GeneratedCandidate,
    budget: SessionBudgetHandle,
    sessionId: Ulid,
  ): Promise<FormalGateDecision> {
    const gate = this.#formal;
    if (gate === undefined) {
      return { kind: 'not-decided', provenance: NO_FORMAL_RUN };
    }
    const { spec } = genInput;

    let set: FormalPropertySet;
    try {
      set = await gate.properties.propertySetFor(spec, budget);
    } catch {
      // Our own instrument failed before any property was submitted, so the simulation
      // decides and the cause is RECORDED rather than lost: `toolchain-unavailable` is
      // already the cause for "the toolchain produced no usable verdict" (Req 1.9), and
      // reporting no cause at all would read as a sample no formal gate was wired for.
      return {
        kind: 'not-decided',
        provenance: formalProvenanceOf(NO_PROPERTY_SET, NO_FORMAL_OUTCOME, {
          route: 'cause',
          reason: 'toolchain-unavailable',
        }),
      };
    }

    // Defaulted AT THE POINT OF READ, by the rule `captureSampleArtifacts` already
    // follows: `FormalPropertySet` is a caller-implementable port shape, so a field that
    // is required at the TYPE level can still be absent at runtime for a hand-built or
    // older double, and a `TypeError` here would be swallowed by the eval harness's own
    // artifact-capture catch-all rather than surfacing as a failure.
    const properties = set.properties ?? [];
    // Nothing is submitted where this set is withheld - an empty set, or one the
    // Property_Set_Admission gate REFUSED whatever it holds (Req 7.20, 10.3). ONE branch
    // over one total function, so there is no path on which a withheld set still reaches
    // `#proveSet` below.
    const withheld = withheldSetRoute(set, properties);
    if (withheld !== null) {
      return {
        kind: 'not-decided',
        provenance: formalProvenanceOf(set, NO_FORMAL_OUTCOME, withheld),
      };
    }

    const outcome = await this.#proveSet(gate.oracle, spec, candidate, properties, budget);
    const results = outcome.results ?? [];
    const span = await this.#recordFormalRun(sessionId, candidate, results, this.#now());
    const refuted = results.find(isRefuted);
    if (refuted !== undefined) {
      // Req 7.17: the refutation decides, so this sample did NOT fall back.
      return {
        kind: 'refuted',
        provenance: formalProvenanceOf(set, outcome, NOT_A_FALLBACK),
        span,
        refuted,
      };
    }
    const unverifiable = results.find(isCouldNotVerify);
    if (unverifiable !== undefined) {
      return {
        kind: 'not-decided',
        provenance: formalProvenanceOf(set, outcome, {
          route: 'cause',
          reason: unverifiable.cause,
        }),
      };
    }
    // Every verdict is `proved`: the three-member vocabulary is exhausted by the two
    // branches above, over a set already known to be non-empty. The formal verdict decides,
    // so this sample did not fall back either.
    return { kind: 'proved', provenance: formalProvenanceOf(set, outcome, NOT_A_FALLBACK), span };
  }

  /**
   * Submit the whole Property_Set in ONE call, then charge every run it reports.
   *
   * ONE CALL RATHER THAN ONE PER PROPERTY, because the three run-level clocking facts
   * arrive on the `FormalOutcome` and a per-property call has no channel for them
   * (Req 14.27, 14.39). Submission ORDER is unchanged and so is independence: the port
   * returns one result per submitted property in that order (Req 1.11, 1.14).
   *
   * EVERY REPORTED RUN IS STILL CHARGED (Req 7.11), one charge per result, after the call
   * returns rather than between properties. The budget is charged for work already DONE
   * either way - the port's own elapsed times are what it reports - and the shared pre-pass
   * is counted once rather than once per property, which is the adapter's own accounting.
   */
  async #proveSet(
    oracle: FormalOraclePort,
    spec: Spec,
    candidate: GeneratedCandidate,
    properties: readonly FormalProperty[],
    budget: SessionBudgetHandle,
  ): Promise<FormalOutcome> {
    // The trusted Spec module name for the workspace path, never the untrusted parsed
    // one, exactly as `#simulate` does - model output can never influence a file path.
    const designSource: SourceFile = {
      path: `${spec.moduleInterface.moduleName}.v`,
      contents: candidate.rtl,
    };
    const outcome = await this.#submitSet(oracle, {
      designSource,
      designInterface: spec.moduleInterface,
      properties,
      budgetMs: DEFAULT_PROPERTY_TIME_BUDGET_MS,
    });
    for (const result of outcome.results ?? []) {
      budget.charge(formalCost(result));
    }
    return outcome;
  }

  /** Decide one Property_Set, failing safe on any throw from the injected port. */
  async #submitSet(
    oracle: FormalOraclePort,
    request: FormalProveSetRequest,
  ): Promise<FormalOutcome> {
    const startedAt = this.#now();
    try {
      return await oracle.proveSet(request);
    } catch {
      // A thrown port is OUR instrument failing and never evidence about the design, so
      // it is reported through the single owner of "a refusal ahead of the condition
      // order" rather than a `PropertyResult` assembled here (Req 1.9, 8.9). The record
      // keeps one result per SUBMITTED property so a throw does not silently shrink the set.
      // A port that threw reports nothing, so the loop measured the call itself and
      // charges it once, on the first result (Req 2.8).
      const elapsedMs = Math.max(0, this.#now() - startedAt);
      return {
        ...NO_FORMAL_OUTCOME,
        results: request.properties.map((property, index) =>
          refusedWithoutProof(
            'toolchain-unavailable',
            property,
            { depth: 0, elapsedMs: index === 0 ? elapsedMs : 0 },
            '',
          ),
        ),
        // One `null` per submitted property, so the index pairing with `results` holds: the
        // port threw, so no wrapper it rendered was ever handed back.
        propertyWrapperSources: request.properties.map(() => null),
      };
    }
  }

  /**
   * Record ONE Trace span for the formal gate run: the span a `Verified` label binds to.
   *
   * One span per GATE RUN rather than per property, because the gate run is the unit that
   * decides a sample, exactly as one simulate run is on the other path. That also makes
   * "the passing formal span" unambiguous: a per-property span would leave the label bound
   * to one property's run, when what it rests on is every property having proved. The
   * per-property facts are in the span's outputs and on `formal.results`.
   *
   * `failureClass` is set for a refutation only. A `could-not-verify` is NOT a failed
   * step - the step completed and reported the third verdict - so classifying it
   * `tool-error` would record an instrument failure that may never have happened; its
   * cause is on the record where a reader can branch on it.
   */
  #recordFormalRun(
    sessionId: Ulid,
    candidate: GeneratedCandidate,
    results: readonly PropertyResult[],
    endedAtMs: number,
  ): Promise<TraceSpan> {
    const durationMs = results.reduce((total, result) => total + finiteMs(result.elapsedMs), 0);
    const outputs: Json = {
      stage: FORMAL_STAGE,
      moduleVersionId: candidate.moduleVersion.id,
      properties: results.map((result) => ({
        criterionRef: result.criterionRef,
        verdict: result.verdict,
        cause: result.verdict === 'could-not-verify' ? result.cause : null,
        depth: result.depth,
        elapsedMs: result.elapsedMs,
      })),
      formalOracleVersion: FORMAL_ORACLE_VERSION,
    };
    const base: SpanDraft = {
      sessionId,
      stageOrTool: FORMAL_STAGE,
      inputs: {
        stage: FORMAL_STAGE,
        moduleVersionId: candidate.moduleVersion.id,
        propertyCount: results.length,
      },
      outputs,
      exitCode: null,
      startedAt: new Date(Math.max(0, endedAtMs - durationMs)).toISOString(),
      durationMs,
      retryCount: 0,
      costCents: 0,
    };
    return this.#recorder.record(
      results.some(isRefuted) ? { ...base, failureClass: 'functional-fail' } : base,
    );
  }

  /**
   * Compile and simulate one candidate against the Testbench, failing safe on any throw.
   * A Testbench_Run, so the harness's Watchdog fails any Required_Check a hang left unprinted.
   */
  async #simulate(
    run: {
      readonly candidate: GeneratedCandidate;
      readonly moduleName: string;
      readonly testbenchFile: SourceFile;
    },
    limits: ResourceLimits,
    requiredCheckNames: readonly string[],
  ): Promise<SimulationVerdict> {
    // Use the trusted Spec module name for the workspace path, never the untrusted
    // parsed name, so model output can never influence a file path.
    const rtl: readonly SourceFile[] = [
      { path: `${run.moduleName}.v`, contents: run.candidate.rtl },
    ];
    try {
      return await this.#simulator.simulate(rtl, run.testbenchFile, limits, {
        requiredCheckNames,
      });
    } catch {
      // A sandbox capture/contract failure is exceptional; classify it `error` and
      // never let it crash the loop (fail safe, Req 8.7).
      return toolFailureVerdict();
    }
  }

  /** Record one oracle verdict span (verdict, iteration, cost) in the Trace (Req 8.8). */
  #recordVerdict(
    sessionId: Ulid,
    candidate: GeneratedCandidate,
    simulation: SimulationVerdict,
    iteration: number,
  ): Promise<TraceSpan> {
    const startedAtMs = this.#now();
    const outputs: Json = {
      stage: VERIFICATION_STAGE,
      verdict: simulation.verdict,
      iteration,
      moduleVersionId: candidate.moduleVersion.id,
      checks: simulation.checks.map((check) => ({ name: check.name, passed: check.passed })),
      vcdCaptured: simulation.vcd !== null,
    };
    const base: SpanDraft = {
      sessionId,
      stageOrTool: VERIFICATION_STAGE,
      inputs: { stage: VERIFICATION_STAGE, moduleVersionId: candidate.moduleVersion.id, iteration },
      outputs,
      exitCode: simulation.exitCode,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, simulation.resourceUsage.wallMs),
      retryCount: 0,
      costCents: 0,
    };
    const failureClass = verdictFailureClass(simulation.verdict);
    return this.#recorder.record(failureClass === undefined ? base : { ...base, failureClass });
  }

  /** Build a progress event, carrying a verdict only when one is reported. */
  #progress(
    iteration: number,
    phase: VerificationPhase,
    message: string,
    verdict?: Verdict,
  ): VerificationProgressEvent {
    return verdict === undefined
      ? { kind: 'progress', iteration, phase, message }
      : { kind: 'progress', iteration, phase, verdict, message };
  }
}

/**
 * One refusal to accept an oracle `pass` as `Verified`, and the evidence for it.
 *
 * Grouped as a value so the shared refusal path takes one parameter instead of
 * seven, and so a new refusal reason has to state its failing case and its
 * student-facing diagnostics rather than inheriting another reason's wording.
 */
interface RefusedPass {
  readonly sessionId: Ulid;
  readonly specId: Ulid;
  readonly candidate: GeneratedCandidate;
  readonly testbench: Testbench;
  readonly simulation: SimulationVerdict;
  readonly span: TraceSpan;
  readonly iteration: number;
  readonly failingCase: FailingCase;
  /** Sanitized, student-facing explanation; never a path, host, or tool message. */
  readonly diagnostics: string;
  readonly provenance: SampleProvenance;
}

/** The fields for a non-passing verification result. */
interface NonPassResultInput {
  readonly id: Ulid;
  readonly moduleVersionId: Ulid;
  readonly testbenchId: Ulid;
  readonly verdict: Exclude<Verdict, 'pass'>;
  readonly failingCase: FailingCase | null;
  readonly iterations: number;
  readonly oracleSpanId: Ulid;
  readonly stopReason: BudgetStopReason;
}

/**
 * Build a non-passing `VerificationResult` directly.
 *
 * Pass integrity (Req 8.10) is vacuously satisfied for a non-`pass` verdict, so
 * `makeVerificationResult` (which validates the pass case) is intentionally not
 * used here; the discriminated union in core guarantees the fields are well-typed.
 * Cost is recorded per step on the agents' own Trace spans; the loop's rollup is
 * the tool cost it observes (zero for a simulate run).
 */
function nonPassResult(input: NonPassResultInput): VerificationResult {
  const base = {
    id: input.id,
    moduleVersionId: input.moduleVersionId,
    testbenchId: input.testbenchId,
    verdict: input.verdict,
    allChecksPassed: false,
    iterations: input.iterations,
    costCents: 0,
    oracleSpanId: input.oracleSpanId,
    stopReason: input.stopReason,
  };
  return input.failingCase === null ? base : { ...base, failingCase: input.failingCase };
}

/** The synthesized `SimulationVerdict` for a run that threw before the oracle spoke. */
function toolFailureVerdict(): SimulationVerdict {
  return {
    verdict: 'error',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: null,
    resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
    // No SandboxResult ever existed to classify: the simulator threw before the
    // oracle produced one, so there is no cause to name beyond "the tool failed".
    failureCause: 'tool-failed',
    attributedFiles: [],
    watchdog: { stopped: false },
  };
}

/** The failure classification recorded for a non-passing verdict (Req 3.4, 8.7). */
function verdictFailureClass(verdict: Verdict): SpanDraft['failureClass'] {
  if (verdict === 'fail') {
    return 'functional-fail';
  }
  if (verdict === 'error') {
    return 'tool-error';
  }
  return undefined;
}

/** The generation input derived from the confirmed context (the approved Spec). */
function toGenerationInput(context: ConfirmedGenerationContext): GenerationInput {
  return { sessionId: context.sessionId, projectId: context.projectId, spec: context.approvedSpec };
}

/** The RTL-free testbench request derived from the approved Spec + confirmed intent. */
function toTestbenchRequest(context: ConfirmedGenerationContext): GenerateTestbenchRequest {
  return {
    sessionId: context.sessionId,
    spec: context.approvedSpec,
    intentSummary: context.confirmedIntent.summary,
  };
}

/** The testbench workspace file, named from the trusted Spec module name. */
function toTestbenchFile(testbench: Testbench, moduleName: string): SourceFile {
  return { path: `${moduleName}_tb.v`, contents: testbench.source };
}

/**
 * Whether an iteration's simulation is a testbench-only build failure: the cause is
 * `build-failed`, the attributed files hold the testbench path, and hold no RTL path
 * (Req 2.7, 2.8, 2.9; design Property 4). A `build-failed` cause that also names the
 * RTL path is a genuine RTL build failure (Req 2.8) and every other cause is left
 * untouched (Req 2.9), so both fall through this predicate to `false`.
 */
function refusedByTestbenchBuild(
  simulation: SimulationVerdict,
  testbenchPath: string,
  rtlPath: string,
): boolean {
  return (
    simulation.failureCause === 'build-failed' &&
    simulation.attributedFiles.includes(testbenchPath) &&
    !simulation.attributedFiles.includes(rtlPath)
  );
}

/** Charge one simulate iteration: no model tokens/cost, the run's wall clock. */
function simulateCost(simulation: SimulationVerdict): AttemptCost {
  return { tokens: 0, costCents: 0, wallClockMs: Math.max(0, simulation.resourceUsage.wallMs) };
}

/** Charge one formal property run: no model tokens/cost, the run's own elapsed time (Req 7.11). */
function formalCost(result: PropertyResult): AttemptCost {
  return { tokens: 0, costCents: 0, wallClockMs: finiteMs(result.elapsedMs) };
}

/**
 * A duration read from an injected port, defaulted at the POINT OF READ.
 *
 * `Math.max(0, x)` alone is not enough here: `elapsedMs` crosses a caller-implementable
 * port, and an absent or non-finite value would put `NaN` into the Session_Budget, where
 * every later comparison against a cap silently becomes `false` and the loop stops
 * terminating on that cap. The simulate path reads its wall clock off a `SandboxResult`
 * this process assembled, which is why it needs no equivalent guard.
 */
function finiteMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/** Whether one property result is the refuted member (a narrowing predicate for `find`). */
function isRefuted(result: PropertyResult): result is RefutedProperty {
  return result.verdict === 'refuted';
}

/** Whether one property result is the could-not-verify member, which carries the cause. */
function isCouldNotVerify(
  result: PropertyResult,
): result is Extract<PropertyResult, { verdict: 'could-not-verify' }> {
  return result.verdict === 'could-not-verify';
}

/**
 * Whether this Property_Set is WITHHELD from the Formal_Oracle, and on which Fallback_Route -
 * or `null` where it is submitted (Req 7.20, 10.3).
 *
 * THE REFUSAL CLAUSE IS A GUARD AND NOT A REPORT, which is the one thing to read here.
 * As built, the loop branched on an EMPTY set alone and read `propertySetAdmitted` only to
 * COPY it onto the record, so a NON-EMPTY set stamped `'refused'` was submitted like any
 * other, and a refused set whose every property happened to prove was labelled `Verified` -
 * exactly the outcome Req 10.3 exists to stop. A measured probe through the real loop
 * confirmed it rather than inferring it. So the refusal is tested here, ahead of the
 * emptiness test, and it refuses a set of ANY size.
 *
 * THE GUARD SITS IN THE LOOP, NOT IN EACH RUNNER. Req 10.3 is addressed to the
 * Verification_Loop, and one guard here covers every present and future runner. The
 * alternative - every caller hands over an EMPTIED set when the gate refused - is the shape
 * that already failed once: the single runner that wires a `FormalGate`
 * (`EvalVerificationLoopRunner`) reads the admission field not at all, so the obligation was
 * live and unmet, and the next runner would inherit it just as silently. A caller may still
 * empty the set, which this function also handles; it is no longer what the label depends on.
 *
 * TWO DIFFERENT FACTS ARRIVE IN THE SAME SHAPE, and that is why the route is decided here
 * rather than at the branch. The eval layer hands the loop an EMPTY set both when the
 * admission gate REFUSED and when the Property_Author could express NO criterion, and the
 * refusal is readable only on `propertySetAdmitted` (see `FormalPropertySet`). Reading both
 * off that one field keeps them apart on the record as Req 7.19 and 7.20 require, instead of
 * reporting the far rarer refusal as "the author expressed nothing".
 *
 * NEITHER IS A `CouldNotVerifyCause` - see `FALLBACK_ROUTES` for why that boundary is held.
 * A refused sample therefore records `fallbackRoute: 'property-set-refused'` and NO
 * Fallback_Reason, which `formalProvenanceOf` makes true by construction off `TakenRoute`.
 *
 * `'no-property-expressed'` is the STUDENT-path reading of an empty set: nothing was
 * submitted, so there is no instrument verdict to report, and `unexpressedCriteria` carries
 * what the author could not state. `propertySetAdmitted` is defaulted at the point of read by
 * the rule `formalProvenanceOf` states for the same field, because the set crosses a
 * caller-implementable port; `properties` is passed in ALREADY defaulted by the one caller, so
 * the array this answers about is the same array that caller goes on to submit.
 */
function withheldSetRoute(
  set: FormalPropertySet,
  properties: readonly FormalProperty[],
): TakenRoute | null {
  if ((set.propertySetAdmitted ?? 'not-gated') === 'refused') {
    return { route: 'property-set-refused' };
  }
  return properties.length === 0 ? { route: 'no-property-expressed' } : null;
}

/**
 * The run-level formal record: the port's per-property results plus the set's own facts.
 *
 * `propertySetAdmitted` and `unexpressedCriteria` are defaulted at the point of read for
 * the reason `#runFormalGate` records for `properties`: the set arrives across a
 * caller-implementable port, so a field required at the TYPE level can still be absent at
 * runtime. `?? 'not-gated'` preserves every member the eval layer actually mapped on -
 * including `'refused'` - while an absent field becomes the honest "no gate ran". The
 * default is `'not-gated'` and NOT `'no-gate-set'`: a set that arrived without the field
 * tells us nothing about whether a gate ran, and `'no-gate-set'` would claim one ran and
 * had nothing to test.
 *
 * `resetContract`, `assertionGateEmitted`, and `clockPolarity` are READ OFF THE
 * `FormalOutcome` the port returns, which is the channel `proveSet` exists for: one
 * pre-pass derives one Reset_Contract and one Clock_Contract for the whole Property_Set,
 * and the outcome is what carries them back beside the per-property results. `null` on
 * either nullable field therefore means the pre-pass was NEVER REACHED - which includes
 * the two no-outcome branches above, where the Property_Set source threw or the set was
 * empty - rather than a run whose reading was discarded.
 *
 * They are defaulted at the point of read for the same reason the two fields above are,
 * and `results` carries that defaulting too because this function's callers BRANCH on it.
 *
 * `propertyWrapperSources` takes the same guard in the shape a LIST needs: `?? []`, the
 * value `results` defaults to, because a port that returned no list says nothing about how
 * many wrappers it rendered. Its length then differs from a non-empty `results`, which is
 * exactly what makes the Artifact_Sink read every wrapper as absent instead of pairing one
 * with the wrong property. The list is passed through unaligned rather than repaired here:
 * the reader across the `EvalLoopRunner` port must refuse a misaligned list regardless, so a
 * second guard here would only be a second owner of that rule.
 *
 * `counterexampleCaptures` IS THE ONE FIELD NOT PASSED STRAIGHT THROUGH, and the reason is that
 * its absence is not self-explaining the way a missing wrapper's is. A wrapper nobody rendered is
 * reported by the recorded cause beside it; a Counterexample nobody can locate, beside a recorded
 * REFUTATION, reads as "no evidence was ever produced" - and a `null` capture already means "this
 * result is not `refuted`", so the two states have one spelling. `recordedCapturesOf` is therefore
 * where the malformed-reference marker is minted, and it is minted here rather than one layer down
 * because this is the only owner that holds each capture AND the result it is paired with.
 */
function formalProvenanceOf(
  set: FormalPropertySet,
  outcome: FormalOutcome,
  taken: TakenRoute,
): FormalProvenance {
  const results = outcome.results ?? [];
  return {
    results,
    propertyWrapperSources: outcome.propertyWrapperSources ?? [],
    counterexampleCaptures: recordedCapturesOf(results, outcome.counterexampleCaptures ?? []),
    propertySetAdmitted: set.propertySetAdmitted ?? 'not-gated',
    unexpressedCriteria: set.unexpressedCriteria ?? [],
    // Req 7.19: the reason is projected off the route, so it is present on `'cause'` and
    // absent on every other member BY CONSTRUCTION. `TakenRoute` is what makes the two
    // fields unable to disagree; this is the one place they are both written.
    fallbackReason: taken.route === 'cause' ? taken.reason : null,
    fallbackRoute: taken.route,
    resetContract: outcome.resetContract ?? null,
    assertionGateEmitted: outcome.assertionGateEmitted ?? false,
    clockPolarity: outcome.clockPolarity ?? null,
    formalOracleVersion: FORMAL_ORACLE_VERSION,
  };
}

/**
 * Lowercase hex SHA-256: the digest shape the seam schema requires of every `ArtifactBlobRef`.
 *
 * NON-GLOBAL, so `test` reads and writes no `lastIndex` and this shared object carries no state
 * between calls.
 *
 * THE RULE'S DECLARATION IS `ArtifactBlobRef` IN `app/tools/sandbox/contract-schema.ts` - a
 * non-empty name, a non-negative integer size, this digest pattern - and this is a RESTATEMENT of
 * it, which is worth naming because it is the second one: `blobRefAt` in
 * `app/eval/artifact-sink.ts` restates it too. Neither can call the declaration: that schema is
 * compiled by Ajv over a whole `SandboxResult` and exposes no per-reference predicate, and this
 * layer could not reach the eval layer's copy in any case, because `app/agent` holds no import of
 * `app/eval` (Req 13.6). The duplication is bounded to three field rules and no behaviour, which
 * is what makes it cheaper than widening the sandbox barrel - an import pin
 * `app/tools/formal/structural-claims.test.ts` already enforces against exactly that.
 */
const SHA256_HEX_DIGEST = /^[0-9a-f]{64}$/;

/**
 * The record's Counterexample_Capture list: ONE ENTRY PER RESULT, `null` included.
 *
 * MAPPED OVER `results` RATHER THAN COPIED, which is what makes the length equality this
 * record's reader depends on hold by construction instead of by the port's good behaviour.
 *
 * A LIST OF ANOTHER LENGTH CONTRIBUTES NOTHING, and that is the conservative direction rather
 * than an accident. The pairing is by index, so a misaligned list cannot say which capture
 * belongs to which property; pairing positionally anyway would hand one property's trace to
 * another, which is strictly worse than having none - a Student would be coached from the wrong
 * waveform. Every `refuted` result then takes the malformed-reference marker, so the sample
 * still leaves a note rather than the silence this function exists to remove.
 */
function recordedCapturesOf(
  results: readonly PropertyResult[],
  captures: readonly (CounterexampleCapture | null)[],
): readonly (RecordedCounterexampleCapture | null)[] {
  const paired = captures.length === results.length;
  return results.map((result, index) =>
    recordedCaptureOf(result, paired ? (captures[index] ?? null) : null),
  );
}

/**
 * One result's recorded capture: `null` where it is not `refuted`, the oracle's own capture where
 * that capture locates something, and the marker where it does not.
 *
 * TOTAL AND NON-THROWING, by the rule the adapter's own read follows: every answer here is a fact
 * about our ability to hand the EVIDENCE over, so none of them may touch the verdict.
 *
 * `null` FOR A NON-`refuted` RESULT EVEN WHERE A CAPTURE ARRIVED, which drops a value rather than
 * recording it, and does so deliberately: Req 12.16 persists a Counterexample for a `refuted`
 * sample AND FOR NO OTHER, and a capture attached to a `proved` result would otherwise reach the
 * Artifact_Sink as a trace to write. Enforcing it here makes that criterion structural at the one
 * boundary a capture crosses, instead of a rule the sink has to re-derive from a verdict it reads
 * separately.
 */
function recordedCaptureOf(
  result: PropertyResult,
  capture: CounterexampleCapture | null,
): RecordedCounterexampleCapture | null {
  if (result.verdict !== 'refuted') {
    return null;
  }
  return capture !== null && locatesAnArtifact(capture.reference)
    ? capture
    : { kind: 'malformed-reference' };
}

/**
 * Whether a recorded reference is one a reader could locate a blob with: the three rules
 * `SHA256_HEX_DIGEST` above names the declaration of.
 *
 * CHECKED DESPITE THE DECLARED TYPE, which is why each field is read rather than trusted:
 * `FormalOraclePort` is a caller-implementable port, so a field required at the TYPE level can
 * still be absent, or hold anything at all, by the time it arrives here - the same reason
 * `propertySetAdmitted` and `results` are defaulted at the point of read in
 * `formalProvenanceOf`. Nothing here throws on any of those values, by the rule
 * `recordedCaptureOf` above states.
 *
 * NO DIGEST VERIFICATION, only a SHAPE check. Whether the bytes hash to the recorded digest is
 * the writer's question, decided where the bytes are written, and it needs those bytes; whether
 * the recorded digest is a digest at all is answerable here, and a reference failing it locates
 * nothing whatever the bytes turn out to be.
 */
function locatesAnArtifact(reference: ArtifactBlobRef): boolean {
  if (!isObjectLike(reference)) {
    return false;
  }
  const { name, sizeBytes, sha256 } = reference as Partial<ArtifactBlobRef>;
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    typeof sizeBytes === 'number' &&
    Number.isInteger(sizeBytes) &&
    sizeBytes >= 0 &&
    typeof sha256 === 'string' &&
    SHA256_HEX_DIGEST.test(sha256)
  );
}

/** Whether a value is a non-null object, so reading a property off it cannot throw. */
function isObjectLike(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * The `SimulationVerdict` recorded for a sample NO simulation ran on, because the formal
 * gate decided it.
 *
 * Synthesized rather than the field being widened to `null`, by the same reasoning
 * `toolFailureVerdict` above rests on and the same reasoning that keeps a sixth
 * `VerificationOutcome` member out: every existing reader of `simulation` - the harness,
 * the artifact sink, the summary - would gain a branch for a state whose whole content is
 * "the other gate decided this".
 *
 * Every field states what happened rather than standing in for it. No process ran, so
 * `exitCode` is `null` and both streams are empty; no check was printed, so `checks` is
 * empty; `failureCause` is `none` because this is not a failed run, which is that field's
 * own contract for a verdict of `pass` or `fail`. `verdict` is the SAMPLE's verdict, which
 * is the one the formal gate decided, and `vcd` carries the Counterexample trace on a
 * refutation - the slot a waveform already occupies, so the evidence a refutation must
 * surrender reaches every existing reader of it (Req 1.10).
 *
 * A reader asking whether a formal run decided a sample reads `formal.results`, which is
 * non-empty exactly when one did.
 */
function noSimulationVerdict(
  verdict: Verdict,
  counterexample: ArtifactBlobRef | null,
): SimulationVerdict {
  return {
    verdict,
    checks: [],
    vcd: counterexample,
    stdout: '',
    stderr: '',
    exitCode: null,
    resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
    failureCause: 'none',
    attributedFiles: [],
    watchdog: { stopped: false },
  };
}

/**
 * The failing case for a formally refuted property, in the slot the `FailingCase` already
 * occupies on the Teach_Mode handoff (Req 8.5).
 *
 * `criterionRef` rides in `checkName` and is NOT interpolated into the prose. It names an
 * acceptance criterion and reaches here from the Property_Author, so it is model-derived
 * text: keeping it in the structured field leaves it one bounded value a reader can
 * attribute, rather than an unbounded string spliced into a student-facing sentence.
 */
function formalFailingCase(refuted: RefutedProperty): FailingCase {
  return {
    checkName: refuted.criterionRef,
    description:
      'The formal oracle found a counterexample to the property derived from this acceptance criterion.',
    expected: 'the property to hold in every reachable state of the design',
    observed: `a counterexample was found at proof depth ${String(refuted.depth)}`,
    atSimTimeNs: null,
  };
}

/** The first failing check as a failing case, or an error-run case, else `null`. */
function failingCaseOf(simulation: SimulationVerdict): FailingCase | null {
  const failed = simulation.checks.find((check) => !check.passed);
  if (failed !== undefined) {
    return {
      checkName: failed.name,
      description: `Spec-derived check "${failed.name}" did not pass.`,
      expected: 'the check to report PASS',
      observed: 'the check reported FAIL',
      atSimTimeNs: null,
    };
  }
  if (simulation.verdict === 'error') {
    return {
      checkName: 'simulation',
      description: 'The simulation did not complete a passing run.',
      expected: 'a completed simulation with every spec-derived check passing',
      observed: 'the run classified as error (tool or infrastructure failure)',
      atSimTimeNs: null,
    };
  }
  return null;
}

/**
 * Sanitized, student-facing diagnostics for a non-passing run (no paths/hosts).
 *
 * The failing case is consulted where no check reported, so a sample the formal gate
 * decided does not claim a simulation that never ran did not pass. This changes nothing
 * on the simulation paths: `failingCaseOf` gives an errored run the same sentence the
 * final fallback holds, and a run with no case at all still reaches that sentence.
 */
function studentDiagnostics(
  simulation: SimulationVerdict,
  failingCase: FailingCase | null,
): string {
  const failed = simulation.checks.filter((check) => !check.passed).map((check) => check.name);
  if (failed.length > 0) {
    return `Failing spec-derived checks: ${failed.join(', ')}.`;
  }
  if (failingCase !== null) {
    return failingCase.description;
  }
  return 'The simulation did not complete a passing run.';
}

/**
 * Richer repair diagnostics for the Generation_Agent: interface deviations, failing
 * check names, and the simulator streams. This feeds the model's next revision and
 * is redacted by the Action_Recorder before any of it is persisted.
 */
function repairDiagnostics(candidateEval: CandidateEval, simulation: SimulationVerdict): string {
  const parts: string[] = [];
  if (candidateEval.interfaceDiagnostics.length > 0) {
    parts.push(candidateEval.interfaceDiagnostics);
  }
  const failed = simulation.checks.filter((check) => !check.passed).map((check) => check.name);
  if (failed.length > 0) {
    parts.push(`Failing checks: ${failed.join(', ')}`);
  }
  const stderr = simulation.stderr.trim();
  const stdout = simulation.stdout.trim();
  if (stderr.length > 0) {
    parts.push(stderr);
  } else if (stdout.length > 0) {
    parts.push(stdout);
  }
  if (parts.length === 0) {
    parts.push('The simulation did not report a passing run.');
  }
  return parts.join('\n');
}

/** A short, non-sensitive reason a testbench outcome was not a produced Testbench. */
function describeTestbenchFailure(outcome: TestbenchGenerationOutcome): string {
  if (outcome.status === 'coverage-incomplete') {
    return 'The independent testbench did not cover every acceptance criterion.';
  }
  if (outcome.status === 'generation-failed') {
    return outcome.failure.detail;
  }
  if (outcome.status === 'fragments-refused') {
    // The scoreboard twin of an unparseable reply: model output the contract refused. It gets
    // no repair, exactly as an unparseable Cycle_Timed reply gets none (Req 6.4).
    const { fragment, criterion, construct } = outcome.refusal;
    return `The independent testbench's fragment ${fragment} was refused under ${criterion}: ${construct}.`;
  }
  return 'The independent testbench could not be produced.';
}

/**
 * What a Model_Router failure means for a measurement (pure, total).
 *
 * The one place the router's terminal codes are turned into the infrastructure/finding
 * distinction, so both halves of setup classify an outage identically. `undefined` means a
 * `model-call-failed` that carried no typed failure, which only an older or hand-built
 * collaborator produces; it resolves to `provider-unreachable` because "the model call failed
 * and we cannot say the caps did it" is not evidence about the model.
 */
const ROUTER_FAILURE_CAUSE: Readonly<Record<ModelRouterFailureCode, SetupFailureCause>> = {
  ALL_PROVIDERS_FAILED: 'provider-unreachable',
  BUDGET_EXHAUSTED: 'budget-exhausted',
};

/** The setup cause a router failure implies, defaulting to the infrastructure reading. */
function routerFailureCause(failure: ModelRouterFailure | undefined): SetupFailureCause {
  return failure === undefined ? 'provider-unreachable' : ROUTER_FAILURE_CAUSE[failure.code];
}

/**
 * Classify a non-`generated` testbench outcome (pure, total).
 *
 * Keyed off the failure's own closed `reason` union through an exhaustive table, so a reason
 * added to the Testbench_Agent cannot ship without deciding whether it is infrastructure or a
 * finding. `coverage-incomplete` is a FINDING: the model answered and its answer did not cover
 * the criteria, which is reproducible and is exactly the signal the Testbench_Agent is
 * measured on.
 */
/** Carry a parse refusal onto the setup failure only when there is one, so others stay byte-equal. */
function withParseRefusal<T extends object>(
  base: T,
  refusal: TestbenchParseRefusal | undefined,
): T & { readonly testbenchParseRefusal?: TestbenchParseRefusal } {
  return refusal === undefined ? base : { ...base, testbenchParseRefusal: refusal };
}

function testbenchFailureCause(outcome: TestbenchGenerationOutcome): SetupFailureCause {
  if (outcome.status !== 'generation-failed') {
    return 'model-output-unusable';
  }
  const { reason, routerFailure } = outcome.failure;
  const table: Readonly<Record<TestbenchGenerationFailureReason, SetupFailureCause>> = {
    'spec-not-approved': 'inputs-inadmissible',
    'no-simulation-criteria': 'inputs-inadmissible',
    'model-call-failed': routerFailureCause(routerFailure),
    'unparseable-output': 'model-output-unusable',
    // The declared interface cannot carry a scoreboard: a fact about the input, not the model.
    'scaffold-unrenderable': 'inputs-inadmissible',
  };
  return table[reason];
}

/** Classify a candidate-generation failure (pure, total), by the same rule. */
function candidateFailureCause(failure: CandidateFailure): SetupFailureCause {
  return failure.reason === 'model-unavailable'
    ? routerFailureCause(failure.routerFailure)
    : 'model-output-unusable';
}
