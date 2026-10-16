// The mutation gate on the PROPERTY SET, and its own kill-rate denominator.
//
// WHAT THIS LAYER IS
//   `./mutation-control.ts` gates the TESTBENCH: a testbench that cannot kill what an
//   independent judge kills is an instrument with a named coverage gap. This module applies
//   the same rule to a Property_Set, which is the artifact the Formal_Oracle actually reasons
//   with, and it is the only module in this package that reads a reference design. That is
//   why it lives in `app/eval` and is unreachable from the product path: a student session has
//   no reference design (Req 10.7).
//
// WHY A SECOND, PARALLEL CALIBRATION VOCABULARY
//   The simulation gate's `MutantCalibration` is settled and is NOT touched here. The two
//   vocabularies record different evidence from different judges: `MutantCalibration` records
//   what an independent golden TESTBENCH did with a mutant, and `FormalMutantCalibration`
//   records what the Formal_Oracle made of the Property_Set ON that same mutant. Folding the
//   two into one union would put a build failure, a hang, a refutation, and a proof under one
//   set of denominator rules, and they do not share one (Req 9.1).
//
// THE MEASURED REASON `formal-could-not-verify` LEAVES THE DENOMINATOR
//   `counter_12` with `if (!rst_n)` changed to `if (1'b0)` is ACCEPTED by iverilog and
//   REJECTED by Yosys. That is exactly what the `RESET_BRANCH_DISABLED` operator produces, and
//   22 of the 50 references have async-reset sensitivity lists, so the gap is structural rather
//   than incidental. Both ways of folding such a mutant into the rate are wrong, and the
//   symmetry is the argument:
//
//     - counting it as a KILL inflates the gate with mutants it never reasoned about, which is
//       the mutation-testing form of the zero-assertion trap;
//     - counting it as a SURVIVAL deflates the gate with mutants it could never see, and would
//       refuse a Property_Set for a weakness nobody demonstrated.
//
//   Neither is a measurement. So the mutant is COUNTED and EXCLUDED (Req 9.2, 9.3), which is
//   the discipline `MutantCalibration` already encodes with `non-compiling` and
//   `golden-errored`.
//
// ONE MUTANT SET, TWO DENOMINATORS
//   The mutants are the ones `./corpus/verilog-mutation.ts` already generates, identified by
//   the `MutantIdentity` that module produces, so the formal gate and the simulation gate are
//   scored against ONE mutant set (Req 9.8). Nothing here re-spells an operator: a second
//   mutant set would make the two gates' kill rates look comparable while being computed over
//   different populations, which is worse than either number alone.
//
//   The RATES, however, are reported with SEPARATE denominators (Req 9.6), because the two
//   gates exclude different mutants: a mutant Yosys cannot read is excluded here and is a
//   perfectly valid mutant there, and a mutant that did not build for iverilog is excluded
//   there. One denominator cannot serve both without silently claiming a mutant was measured
//   by a gate that never saw it. `FormalMutationCounts` is therefore its own type, and
//   `formalKillRateOf` cannot be handed a `MutationProbeReport`.
//
// THE HAND-OFF TO THE VERIFICATION_LOOP
//   The bottom of this file maps the three outcomes this gate can MEASURE onto the loop's
//   own four-member `PropertySetAdmissionOutcome`, and owns the rule for which of them takes
//   the Simulation_Fallback (Req 10.3). The loop declares a PARALLEL vocabulary rather than
//   importing `PropertySetAdmission`, because `app/agent` holds no import of `app/eval` (Req
//   11.11, 13.6) - the same boundary that keeps this module off the product path. So the
//   decision is made HERE, and the loop receives a Property_Set already stamped with it.
//
// Pure: no clock, no I/O, no randomness. Every function here is total. The one port declared
// at the bottom supplies a MEASUREMENT; the rule applied to it stays in this module.

import type { FormalPropertySet, PropertySetAdmissionOutcome } from '@app/agent';
import type { CouldNotVerifyCause, FormalVerdict, ResourceLimits } from '@app/tools';

import {
  identityOf,
  mutantWasGoldenKilled,
  type MutantCalibration,
  type MutantIdentity,
} from './mutation-control.js';

/**
 * What the Formal_Oracle made of the Property_Set on one mutant; a closed three-member
 * vocabulary (Req 9.1).
 *
 * One member per Formal_Verdict, and none folded into another. `CALIBRATION_OF_VERDICT` below
 * is the tie: a fourth Formal_Verdict is a compile error there rather than a value that quietly
 * has no calibration.
 */
export type FormalMutantCalibration =
  /** The oracle REFUTED the property on this mutant, so the Property_Set kills it. */
  | 'formal-refuted'
  /**
   * The oracle PROVED the property on this mutant, so the Property_Set misses it.
   *
   * Its own member rather than "not killed", because this is the one calibration that can
   * refuse a Property_Set: a proof on a mutant an independent judge killed is a demonstrated
   * weakness in the property, which is what task 10.2's gate reads.
   */
  | 'formal-proved'
  /**
   * The oracle could not reason about it at all: counted, and OUT of the denominator.
   *
   * Its own member rather than folded into either verdict, for the measured reason this file's
   * header states. The CAUSE that distinguishes a frontend rejection from a timeout is carried
   * on the mutant RECORD (`CalibratedFormalMutant`), never on this value - see that type.
   */
  | 'formal-could-not-verify';

/**
 * The ONE calibration that leaves the denominator, named once so the arms below cannot drift
 * from it. `satisfies` rather than a bare literal, so a rename of the member breaks here.
 */
const FORMAL_UNSCORABLE = 'formal-could-not-verify' satisfies FormalMutantCalibration;

/**
 * Whether a calibration admits its mutant to the FORMAL kill-rate denominator (Req 9.3, 9.7).
 *
 * A total `Record` rather than a comparison chain, copied in shape from
 * `CALIBRATION_ADMITS_TO_DENOMINATOR`, so a fourth member is a COMPILE ERROR here instead of
 * silently defaulting into or out of the denominator. Both default directions are wrong:
 * admitting an unmeasured mutant corrupts the rate, and excluding a measured one shrinks the
 * gate set. Exported because the structural claim - an entry for every member - is asserted
 * directly; frozen and `Readonly`, so a reader cannot edit the rule in place.
 */
export const FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR: Readonly<
  Record<FormalMutantCalibration, boolean>
> = Object.freeze({
  'formal-refuted': true,
  'formal-proved': true,
  'formal-could-not-verify': false,
});

/**
 * The calibration each Formal_Verdict records for a mutant (Req 9.1, 9.2).
 *
 * A total `Record` over `FormalVerdict`, which is the vocabulary `@app/tools` owns, so this
 * module never re-spells it and a fourth verdict fails to compile HERE rather than arriving as
 * a mutant with no calibration. `could-not-verify` maps to the excluded member, which is Req
 * 9.2 in one line: the mutant is recorded as could-not-verify and as neither killed nor
 * survived.
 */
const CALIBRATION_OF_VERDICT: Readonly<Record<FormalVerdict, FormalMutantCalibration>> =
  Object.freeze({
    refuted: 'formal-refuted',
    proved: 'formal-proved',
    'could-not-verify': FORMAL_UNSCORABLE,
  });

/** The calibration one Formal_Verdict records for a mutant (pure, total). */
export function formalCalibrationOf(verdict: FormalVerdict): FormalMutantCalibration {
  return CALIBRATION_OF_VERDICT[verdict];
}

/** Whether a calibrated mutant sits in the FORMAL kill-rate denominator (pure, total). */
export function formalMutantIsScorable(calibration: FormalMutantCalibration): boolean {
  return FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR[calibration];
}

/** A calibration the oracle actually reasoned to, so its mutant is in the denominator. */
type ScorableFormalCalibration = Exclude<FormalMutantCalibration, typeof FORMAL_UNSCORABLE>;

/** The facts every calibrated mutant carries, whatever the oracle made of it. */
interface CalibratedFormalMutantFacts {
  /** The identity `./corpus/verilog-mutation.ts` produced: one mutant set, two gates (Req 9.8). */
  readonly identity: MutantIdentity;
  /**
   * The INDEPENDENT judge's own verdict on the SAME mutant, in the simulation vocabulary.
   *
   * Carried here rather than derived, because it is drawn independently: it is what task 10.2's
   * gate reads (a Property_Set that PROVED a mutant the judge KILLED is refused), and it is
   * what makes the two-denominator claim concrete rather than asserted - a `golden-killed`
   * mutant that the oracle could not read is in the simulation denominator and out of this one.
   */
  readonly golden: MutantCalibration;
}

/**
 * One mutant, calibrated by the Formal_Oracle and by the independent golden judge.
 *
 * A TWO-ARM UNION rather than one record with an optional `cause`, and that shape is the point.
 * Req 9.5 requires the Could_Not_Verify_Cause on EVERY `formal-could-not-verify` mutant, so a
 * frontend rejection is distinguishable from a timeout - and the cause cannot live on the
 * `FormalMutantCalibration` value itself without turning a closed three-member vocabulary into
 * one member per cause, which is exactly what the total `Record` above depends on not happening.
 * So the cause belongs on the RECORD that carries the calibration, on the one arm that has one:
 * an unscorable mutant with no cause is UNREPRESENTABLE, where an optional field would have made
 * it merely discouraged.
 */
export type CalibratedFormalMutant =
  | (CalibratedFormalMutantFacts & { readonly formal: ScorableFormalCalibration })
  | (CalibratedFormalMutantFacts & {
      readonly formal: typeof FORMAL_UNSCORABLE;
      /** Which refusal it was: `frontend-rejected`, `proof-timeout`, and nine others. */
      readonly cause: CouldNotVerifyCause;
    });

/**
 * What a calibrated mutant population measures about one Property_Set.
 *
 * The counts PARTITION the population - `totalCount === killedCount + survivedCount +
 * couldNotVerifyCount` - so an excluded mutant is counted rather than silently dropped, and
 * `denominator` is the admitting subset and nothing else.
 *
 * Its own type, deliberately, and NOT a field added to `MutationSampleCounts`: `denominator`
 * and that type's `validCount` are different numbers over the same mutants, and a shape that
 * held both would invite one to be read for the other.
 */
export interface FormalMutationCounts {
  /** Every calibrated mutant, including the ones no rate may be computed over. */
  readonly totalCount: number;
  /** Mutants the oracle REASONED about: this gate's kill-rate denominator (Req 9.3, 9.6). */
  readonly denominator: number;
  /** Mutants the Property_Set REFUTED, so it kills them. The numerator. */
  readonly killedCount: number;
  /** Mutants the Property_Set PROVED, so it misses them. Task 10.2's gate reads these. */
  readonly survivedCount: number;
  /** Mutants counted and EXCLUDED, reported as neither killed nor survived (Req 9.2, 9.4). */
  readonly couldNotVerifyCount: number;
}

/**
 * Tally one calibrated mutant population (pure, total).
 *
 * The denominator is decided by `formalMutantIsScorable` rather than by re-stating which
 * members admit, so the total `Record` is the single owner of that rule: the arithmetic cannot
 * disagree with the mapping, which is the drift a second list of admitting members would allow.
 * An EMPTY population is in range and yields every count at zero.
 */
export function formalMutationCounts(
  population: readonly CalibratedFormalMutant[],
): FormalMutationCounts {
  const tally: Record<FormalMutantCalibration, number> = {
    'formal-refuted': 0,
    'formal-proved': 0,
    'formal-could-not-verify': 0,
  };
  let denominator = 0;
  for (const mutant of population) {
    tally[mutant.formal] += 1;
    if (formalMutantIsScorable(mutant.formal)) {
      denominator += 1;
    }
  }
  return {
    totalCount: population.length,
    denominator,
    killedCount: tally['formal-refuted'],
    survivedCount: tally['formal-proved'],
    couldNotVerifyCount: tally[FORMAL_UNSCORABLE],
  };
}

/**
 * The FORMAL kill rate over its own denominator, or `null` where nothing was scorable (pure).
 *
 * Takes `FormalMutationCounts` and nothing else, so the Negative_Control's `validCount` cannot
 * be handed to it: the two gates exclude different mutants, so one denominator cannot serve
 * both, and a shared signature would make that mistake available (Req 9.6). `null` rather than
 * zero for an empty denominator, by the same rule `killRateOf` applies - a gate that scored
 * nothing has no rate, and `0` would read as a gate that killed nothing.
 */
export function formalKillRateOf(counts: FormalMutationCounts): number | null {
  return counts.denominator === 0 ? null : counts.killedCount / counts.denominator;
}

/**
 * Whether one calibrated mutant is a mutant this Property_Set is HELD TO (pure, total).
 *
 * The gate set is an INTERSECTION of two conditions, and neither is re-spelled here:
 *
 *   - `formalMutantIsScorable` owns the exclusion rule (Req 10.5). A mutant the Formal_Oracle
 *     could not reason about is counted and EXCLUDED, so a Property_Set is never refused for a
 *     weakness nobody demonstrated. The `counter_12` row in this file's header is exactly that
 *     mutant: Yosys would not read it, so NO property could have killed it, and refusing a
 *     Property_Set over it would be an accusation with no measurement behind it.
 *   - `mutantWasGoldenKilled` owns which golden calibrations are a KILL (Req 10.2, 10.4). It is
 *     the SIMULATION gate's own predicate, imported rather than restated, because "a gate that
 *     cannot kill what an independent judge kills is a gate with a named coverage gap" has to be
 *     ONE rule applied to two instruments rather than two rules that happen to agree today. A
 *     golden TIMEOUT is a kill there, so it is a kill here, which ENLARGES this gate set on
 *     purpose - the same intended consequence that predicate's own comment states.
 *
 * Exported so the two gates' predicates can be asserted to agree on the same inputs rather than
 * inspected by eye.
 */
export function mutantIsInPropertySetGateSet(mutant: CalibratedFormalMutant): boolean {
  return formalMutantIsScorable(mutant.formal) && mutantWasGoldenKilled(mutant.golden);
}

/**
 * What the gate made of one Property_Set. Evidence about the PROPERTY SET, and nothing else.
 *
 * EVERY MEMBER IS A STATEMENT ABOUT THE PROPERTY, AND THAT IS A CORRECTNESS CONSTRAINT RATHER
 * THAN A NAMING PREFERENCE (Req 10.10, 10.12). This type carries no candidate design, no
 * Simulation_Verdict, no Formal_Verdict for a candidate, and no pass/fail field of any kind,
 * because a reader who took a refusal for a statement about the candidate would draw exactly
 * the WRONG conclusion: a Property_Set weak enough to be refused says nothing whatsoever about
 * whether the design under test is correct. The refusal says the INSTRUMENT is blunt. Deciding
 * the sample is then the Simulation_Fallback's job (Req 10.3), which is task 10.3's wiring and
 * is deliberately not reachable from this module.
 *
 * A THREE-MEMBER union rather than a boolean, for the reason `CoverageGapVerdict` already
 * states one layer down: one of these outcomes is not a verdict at all. An empty gate set would
 * have to be spelled `true` (a vacuous pass) or `false` (an accusation), and both are a lie.
 */
export type PropertySetAdmission =
  /**
   * The Property_Set met a NON-EMPTY gate set and refuted every mutant in it.
   *
   * The only member that is a measurement in the Property_Set's favour, and it is bounded: it
   * says the property killed what an independent judge killed, over the mutants the oracle
   * could reason about. It does not say the property is strong, and it does not say the design
   * is right.
   */
  | { readonly kind: 'admitted' }
  /**
   * No mutant was both judge-killed AND formally scored, so the gate had nothing to say.
   *
   * Its own member rather than folded into `admitted`, because killing nothing proves nothing -
   * the same vacuity `judgeCoverageGaps` refuses to report as `closed` through its
   * `no-golden-killed-mutants` member. All three ways the intersection empties land here: no
   * scorable mutant, no judge-killed mutant, and no mutant that is both.
   */
  | { readonly kind: 'no-gate-set' }
  /**
   * The Property_Set PROVED at least one mutant the independent judge killed (Req 10.2).
   *
   * `survivors` names them (Req 10.6), so the refusal is attributable to a specific demonstrated
   * weakness rather than to a bare verdict: a reader gets the operator and the site, which is
   * what turns "this property set is inadmissible" into "this property set does not see a
   * disabled reset branch at line 7".
   */
  | { readonly kind: 'refused'; readonly survivors: readonly MutantIdentity[] };

/**
 * Apply the property-set mutation gate to one calibrated mutant population (pure, total).
 *
 * THE MEASURED CASE THIS GATE EXISTS FOR
 *   Two `JC_counter` mutants survived a TRUE, non-trivial invariant - the Johnson-counter "at
 *   most one transition across `Q[63]..Q[0]`" property - and survived it under UNBOUNDED
 *   temporal induction rather than merely bounded BMC. They survived because they genuinely
 *   SATISFY that invariant while being functionally wrong, and only a property pinning the
 *   exact next state, `Q == {~$past(Q[0]), $past(Q[63:1])}`, killed them.
 *
 *   So a property can be true, non-trivial, and provable, and still miss a real bug. That is
 *   the whole reason a Property_Set needs its OWN mutation control rather than inheriting the
 *   testbench's: the testbench gate measures a different instrument, and a Property_Set that
 *   passed no gate of its own could mint a sound proof of a wrong design unchallenged. It is
 *   also a property-STRENGTH limit rather than an engine limit, which is why no amount of depth
 *   and no switch to induction substitutes for this gate.
 *
 * WHAT THIS GATE DOES NOT CLOSE, STATED PLAINLY (Req 10.11, 10.12)
 *   It does NOT close the CORRELATED-FAILURE risk of one model writing both the RTL and the
 *   property. The `JC_counter` row is the argument: the property strong enough to be decisive
 *   was close to a restatement of the design's own next-state function, so a property strong
 *   enough to kill a mutant trends toward restating the RTL - and if one model writes both from
 *   the same misunderstanding, they agree and both are wrong, and this gate passes. Closing
 *   that is the work of the separate later differential-consensus spec named as layer 3 of
 *   ADR-018, and nothing here may be read as having done it. An `admitted` Property_Set is
 *   therefore not a correctness claim about the design, and a proof it goes on to produce does
 *   not establish correctness on its own.
 *
 * EVERY SURVIVOR IS PROJECTED, NOT PASSED THROUGH (Req 10.10, 10.13). `identityOf` rebuilds
 * each named survivor from `{ mutantId, operator, site }`, because `Mutant extends
 * MutantIdentity`: a `PropertySetGate` that sets `identity` straight from `generateMutants`
 * TYPE-CHECKS, and a survivor list that handed its elements back by reference would carry the
 * whole mutated reference RTL onto a record this type promises describes the Property_Set
 * alone. Structural typing cannot keep that promise, so this one call does - and it is the
 * SAME projection the Negative_Control uses for its own survivor record, so the two gates
 * cannot drift on what a survivor is.
 *
 * An EMPTY population is in range and yields `no-gate-set`. Survivors are reported in
 * POPULATION order, so a refusal is reproducible rather than set-ordered.
 */
export function admitPropertySet(
  population: readonly CalibratedFormalMutant[],
): PropertySetAdmission {
  const gateSet = population.filter(mutantIsInPropertySetGateSet);
  if (gateSet.length === 0) {
    return { kind: 'no-gate-set' };
  }
  const survivors = gateSet
    .filter((mutant) => mutant.formal === 'formal-proved')
    .map((mutant) => identityOf(mutant.identity));
  return survivors.length === 0 ? { kind: 'admitted' } : { kind: 'refused', survivors };
}
// ---------------------------------------------------------------------------------------
// THE HAND-OFF: mapping this gate's three measured outcomes onto the loop's four-member
// vocabulary, and deciding which of them takes the Simulation_Fallback (Req 10.3, 10.8).
// ---------------------------------------------------------------------------------------

/**
 * The loop-side member each measured outcome maps onto (Req 10.3, 10.8).
 *
 * A total `Record` keyed by this module's own `kind`, in the same shape
 * `FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR` above takes, so a FOURTH measured outcome is a
 * COMPILE ERROR here rather than a value that quietly maps onto nothing. Every entry is the
 * member of the SAME NAME, which is the whole of the mapping: the vocabularies were designed
 * to line up, and the identity is written out rather than assumed so a future divergence has
 * to be a deliberate edit to this table.
 *
 * `'not-gated'` is DELIBERATELY ABSENT from the range. It is the one member the
 * Verification_Loop owns alone, and it means no admission gate ran at all - which is a fact
 * about the WIRING and not an outcome this gate can measure. The only values that reach it
 * are the ones `admitPropertySet` returned, so this table cannot produce it.
 *
 * WHY THIS MAPS AT ALL RATHER THAN THE LOOP IMPORTING `PropertySetAdmission`: `app/agent`
 * holds no import of `app/eval` (Req 11.11, 13.6), which is the same boundary that keeps
 * this reference-design-reading gate off the product path (Req 10.7). So the loop declares a
 * PARALLEL closed vocabulary and this table is the single point the two meet.
 */
const PROPERTY_SET_ADMISSION_OUTCOME: Readonly<
  Record<PropertySetAdmission['kind'], PropertySetAdmissionOutcome>
> = Object.freeze({
  admitted: 'admitted',
  'no-gate-set': 'no-gate-set',
  refused: 'refused',
});

/** The loop-side admission outcome one measured admission maps onto (pure, total). */
export function propertySetAdmissionOutcomeOf(
  admission: PropertySetAdmission,
): PropertySetAdmissionOutcome {
  return PROPERTY_SET_ADMISSION_OUTCOME[admission.kind];
}

/**
 * How many mutants survived this Property_Set (Req 10.8).
 *
 * DERIVED from the refusal's own `survivors` rather than carried beside it, so the count and
 * the named survivors can never disagree. `admitted` means the Property_Set refuted every
 * mutant in a non-empty gate set, and `no-gate-set` means there was no gate set to survive,
 * so both are genuinely zero rather than defaulted to it.
 */
export function propertySetSurvivorCountOf(admission: PropertySetAdmission): number {
  return admission.kind === 'refused' ? admission.survivors.length : 0;
}

/**
 * Whether this admission outcome sends the sample to the Simulation_Fallback (Req 10.3).
 *
 * THE SINGLE OWNER OF THAT RULE, as a total `Record` over the loop's own four-member
 * vocabulary rather than an `=== 'refused'` at each call site: a fifth member is a compile
 * error here, and the rule is stated once where its reasoning can be read.
 *
 * `refused` FALLS BACK, which is Requirement 10.3 directly: the gate demonstrated that this
 * Property_Set PROVES a mutant an independent judge killed, so a proof it goes on to produce
 * would rest on an instrument measured blunt, and the simulation gate decides instead.
 *
 * `no-gate-set` DOES NOT, and that is the deliberate reading of a case Requirement 10.3 does
 * not name. Criterion 10.3 names the REFUSED case alone, and an empty gate set demonstrated
 * NO weakness: no mutant was both judge-killed and formally scorable, so refusing to use the
 * Property_Set over it would be exactly the accusation-without-measurement that Requirement
 * 10.5's exclusion rule exists to prevent one layer down - a Property_Set is never refused
 * for a mutant the Formal_Oracle could not reason about, and it must not be refused for a
 * mutant that never existed either. It is ALSO not a Property_Set the gate vouched for, and
 * that is why the two are different RECORDED members rather than one: `'admitted'` says the
 * property killed what the judge killed, `'no-gate-set'` says nothing held it to account,
 * and a reader can tell them apart on the sample without re-deriving this rule. Requirement
 * 10.9's refused-sample count is over `'refused'` ALONE, so folding `'no-gate-set'` in here
 * would also make the wrong tally the easy one.
 *
 * `not-gated` DOES NOT, for the same reason as `no-gate-set` and one step further out: no
 * gate ran, so nothing was measured in either direction. This is the product path's value
 * and the value a gate that could not run degrades to, by the rule `InstrumentControl`
 * already follows - a control that cannot run degrades to `unchecked`, never to a verdict.
 *
 * `admitted` DOES NOT, which is the only member whose answer needs no argument.
 */
const PROPERTY_SET_ADMISSION_FALLS_BACK: Readonly<Record<PropertySetAdmissionOutcome, boolean>> =
  Object.freeze({
    admitted: false,
    'no-gate-set': false,
    refused: true,
    'not-gated': false,
  });

/** Whether a sample carrying this admission outcome is decided by the Simulation_Fallback. */
export function propertySetAdmissionFallsBack(outcome: PropertySetAdmissionOutcome): boolean {
  return PROPERTY_SET_ADMISSION_FALLS_BACK[outcome];
}

/** What the gate needs to score one problem's Property_Set against its reference design. */
export interface PropertySetGateRequest {
  readonly problemId: string;
  /** The same sandbox caps the loop's own oracle and the golden judge run under (Req 11.3). */
  readonly limits: ResourceLimits;
  /**
   * The authored Property_Set to score, which is the SAME object the loop is handed.
   *
   * Passed in rather than authored here, and that is the whole point of Component 11a. The gate
   * scores a set against reference mutants and the loop reasons with it, so if the two authored
   * separately the recorded `propertySetAdmitted` would describe an artifact the loop never
   * saw, and the sample would pay for two model calls to produce the disagreement.
   */
  readonly propertySet: FormalPropertySet;
}

/**
 * The optional per-problem port that MEASURES a Property_Set against reference mutants.
 *
 * IT SUPPLIES THE MEASUREMENT AND NOT THE DECISION. The port hands back a calibrated mutant
 * population and `admitPropertySet` above applies the rule, so the gate's own rule - exclude
 * every unscorable mutant, refuse only on a judge-killed mutant the Property_Set PROVED -
 * cannot be weakened or widened by a port implementation. This is the same division the
 * Negative_Control follows, where `./mutation-control.ts` owns the predicates and the probe
 * only reports what it ran.
 *
 * `null` means THE GATE COULD NOT RUN for this problem - typically no reference design - and
 * it is a different fact from an EMPTY population, which means the gate ran and its gate set
 * came back empty. The first records as `'not-gated'` and the second as `'no-gate-set'`, and
 * keeping them apart is the same anti-conflation rule the four-member vocabulary rests on.
 */
export interface PropertySetGate {
  calibrate(request: PropertySetGateRequest): Promise<readonly CalibratedFormalMutant[] | null>;
}
