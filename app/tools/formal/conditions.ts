// The five-condition gate: the `ProofConditions` every formal run records, the `ProvedEvidence`
// a `proved` verdict is built from, the closed `CouldNotVerifyCause` vocabulary, the
// `PropertyResult` union, and `admitProved` as the ONLY constructor of a `ProvedEvidence`
// (design.md "Data Models"; Req 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7).
//
// WHY THE FIELDS ARE LITERAL TYPES AND NOT A COMMENT ASKING NICELY
//   This is the gate that decides whether a `Verified` label is EARNED, and the measured
//   failure mode is a toolchain reporting a pass for something it never checked. FOUR
//   independent mechanisms in one toolchain (Yosys 0.66 + Z3 4.15.4) produced `Status: PASSED`
//   for "not checked":
//     1. Zero assertions in the generated SMT2 for a provably false property (`adder_8bit`
//        asserting `cout == 1'b0`).
//     2. An antecedent first reachable only at step 19, so the property was never evaluated
//        (`multi_booth_8bit`).
//     3. Plain bounded BMC at depths 20, 64, AND 66 on a real `JC_counter` mutant that only
//        fails at 70.
//     4. Temporal induction ALONE over a design that violates the property in its real reset
//        state: `initial out = 4'd15` against `out <= 11` reports `Temporal induction
//        successful` and `Status: PASSED` at depths 5, 20, AND 40, while plain BMC reports
//        `Status: FAILED` at all three. `yosys-smtbmc -i` checks the inductive step and never a
//        base case, so the pass that makes the proof UNBOUNDED produced a false `PASSED` of its
//        own, and the Base_Check is what separates the two
//        (`chipAgent/_inbox/gotcha-smtbmc-induction-alone-is-unsound-both-directions.md`).
//   Against four measured silent passes, a documented convention is not a control. So
//   `ProvedEvidence` carries a branded non-zero assertion count, `presat: 'satisfiable'`, a
//   cover that is reached or not-applicable, `base: 'passed'`, and `induction: 'successful'`: a
//   PARTIAL proof does not type-check, rather than being merely discouraged (Req 1.4).
//
// WHY THE BRAND, AND WHAT THE SEAL DOES AND DOES NOT COVER
//   `NonZeroAssertionCount` is a branded number whose brand key is a module-private
//   `unique symbol`, sealed exactly the way `ValidatedExpression` is sealed in
//   `../verilog/property.ts`: no other module can name that key, so no other module can build
//   the brand, the predicate that produces it is not exported, and `admitProved` is the only
//   exported function that returns a value carrying it. The honest ceiling, stated rather than
//   overclaimed: TypeScript's `as` can always be written by a caller who chooses to. The brand
//   makes that a deliberate, greppable act instead of something a `number` field lets happen by
//   accident, and no exported helper here performs one.
//
// WHY THIS EVALUATION ORDER AND NOT ANOTHER (Req 1.7)
//   The order is assertion count, then presat, then cover, then BASE CASE, then induction. It is
//   a correctness claim rather than a preference: each EARLIER condition, when it fails, makes
//   the later conditions' verdicts MEANINGLESS, so reporting a later cause would name a symptom
//   instead of the cause.
//     1. Assertion count. If zero assertions reached the solver, every subsequent `Status:`
//        describes an EMPTY problem - measured, `grep -c assert` returns 0 for the chain missing
//        `async2sync` and `chformal -lower`, and that chain reports `PASSED` for a property that
//        is provably false. A presat, cover, base-case, or induction verdict over nothing is not
//        a verdict.
//     2. Presat. Contradictory assumptions make a proof VACUOUSLY SUCCEED - everything is
//        provable under `false` - so a later base-case pass and a later induction success are
//        artifacts of the contradiction rather than facts about the design. Measured distinctly
//        as `Status: PREUNSAT` under `--presat` for `assume(rst_n)` together with
//        `assume(!rst_n)`.
//     3. Cover. An unreached antecedent means the property was NEVER EVALUATED, so the assertion
//        is never triggered: the base case passes vacuously and induction succeeds vacuously.
//        Measured that this condition can itself be vacuous, which is why nothing may sit ahead
//        of it that depends on it - `counter_12`'s `cover(out == 4'd11)` reported `Reached cover
//        statement in step 1` through an unreachable free initial state before the reset assume
//        was present, and everything ordered behind it inherited that.
//     4. BASE CASE. Plain BMC from the design's REAL reset state. It sits FOURTH and not last,
//        and the position is measured on both sides. It is BEHIND the first three because a
//        base-case failure is only a COUNTEREXAMPLE once the assumptions are consistent and the
//        antecedent was reached; ahead of them it would report a statement about a contradiction
//        or about an untriggered assertion. It is AHEAD of induction because it is what makes
//        the induction result mean anything at all: MEASURED, `initial out = 4'd15` against
//        `out <= 11` reports `Temporal induction successful` and `Status: PASSED` at depths 5,
//        20, and 40 while plain BMC reports `Status: FAILED` at all three, so an induction
//        success read without a base case is the false proof this condition exists to close.
//     5. Induction. Only once assertions exist, the assumptions are satisfiable, the antecedent
//        was reached, and the design satisfies the property where it actually STARTS is an
//        inconclusive induction the ACTUAL finding rather than a consequence of one of the four
//        above.
//   The order also makes the reported cause a deterministic function of the run rather than of
//   which check happened to finish first.
//
// THREE CAUSES THIS FUNCTION NEVER RETURNS, NAMED SO THE GAP IS NOT READ AS AN OVERSIGHT
//   `COULD_NOT_VERIFY_CAUSES` is the vocabulary for the whole oracle, not the range of
//   `admitProved`, and three members are reported by layers that see facts `ProofConditions`
//   does not carry.
//     - `reset-contract-unresolved` and `clock-contract-unsupported` come from the
//       Reset_Contract_Prepass, ahead of the WHOLE fixed order (Req 1.18): the pre-pass runs
//       over the design alone, before a Property_Wrapper exists, so there is no
//       `ProofConditions` value for them to be taken over.
//     - `induction-engine-incomplete` needs the Induction_Check's reported `FAILED` TOGETHER
//       WITH a passing Base_Check (Req 4.11), and `ProofConditions['induction']` records what
//       the check ESTABLISHED rather than the raw string it printed. The caller holds the string,
//       so the caller names it. What this function guarantees is the fail-safe half: an induction
//       condition other than `successful` never admits a proof, whichever of the two it was.
//
// Pure and total: no model call, and no file, network, clock, or random-source read. Every
// exported function returns on every input and throws on none.

import type { ArtifactBlobRef } from '../sandbox/index.js';

/**
 * Every Could_Not_Verify_Cause, and the SINGLE OWNER of that vocabulary (Req 1.6).
 *
 * The type is derived from this array rather than declared beside it. A separate union plus an
 * `as const satisfies readonly CouldNotVerifyCause[]` array - the shape `TRUST_TIERS` uses in
 * `@app/core` - permits the array to be INCOMPLETE, because `satisfies` checks that each member
 * belongs to the type and never that the type is covered. Deriving makes drift between the
 * runtime list and the type structurally impossible, which is what the vocabulary test can then
 * rest on.
 *
 * ELEVEN members, closed. It was eight, and the three additions each name a fact none of the
 * eight named AND carry a different remedy, which is the whole reason they are not folded into an
 * existing member. Closed is the load-bearing word: a twelfth fact has to arrive here as a member
 * every total map over this vocabulary then fails to compile without, rather than as prose in a
 * diagnostic string nothing reads.
 *
 * There is exactly ONE member for the unreached-antecedent case, deliberately.
 * `antecedent-unreached` covers an antecedent that is unreachable AND one whose first reachable
 * step merely exceeds the depth used, without claiming to distinguish them (Req 5.4), because
 * nothing in the toolchain does: `counter_12`'s `out == 11` is genuinely reached at step 13 and
 * reports unreached at every depth below 14. A second member would name a distinction we cannot
 * measure.
 */
export const COULD_NOT_VERIFY_CAUSES = [
  // Zero assertions reached the solver, so whatever `Status:` was reported describes nothing.
  'zero-assertions',
  // Yosys refused to read or elaborate the candidate design itself.
  'frontend-rejected',
  // The Property_Wrapper did not build, or a lowering failure named no submitted file.
  'property-build-failed',
  // `--presat` reported `PREUNSAT`: the assumptions cannot all hold, so anything is provable.
  'contradictory-assumptions',
  // The cover on the property's antecedent was not reached, so the property was never evaluated.
  'antecedent-unreached',
  // A BOUNDED PASS: `PASSED` with no temporal-induction success, so at best plain BMC found no
  // counterexample to the depth searched. The remedy is MORE DEPTH - measured on the
  // `JC_counter` mutant `!Q[0]` to `!Q[1]`, which passed at 20, 64, and 66 and failed at 70.
  'induction-inconclusive',
  // ADDED. An induction FAILURE over a PASSING base case, which is a fact about the ENGINE and
  // not about the design: `yosys-smtbmc`'s k-induction emits NO simple-path constraints, so a
  // CORRECT design can fail the inductive step at every depth - measured on a constructed
  // `bounded_ctr`, on `counter_12`'s `out != 4'd13`, and on the Yosys issue 3378 ROM case, at
  // depths 1, 5, 20, and 40. NOT `induction-inconclusive`, and the distinction is the remedy:
  // more depth is not known to help here, and the tool's own `Loop detected, increasing
  // induction depth will not help` message printed on NONE of the measured failing cases, so
  // the tool gives no signal separating "go deeper" from "no depth will ever help" (Req 4.11,
  // 4.12, 4.13). Upstream SymbiYosys treats the same situation as UNKNOWN rather than as a
  // failure, which is why it is a third label here and never a refutation (Req 4.10).
  'induction-engine-incomplete',
  // ADDED. The Reset_Contract_Prepass refused: several reset nets, several polarities, or none.
  // An enable-gated reset does NOT arrive here - the pre-pass reads that enable and the contract
  // names it (criterion 4.15 of `formal-gate-first-light`, which AMENDS Req 14.19). Reported
  // before any solver runs, and no Property_Wrapper is built. RECOVERABLE by a better
  // derivation, which is what separates it from the cause below - `opt_dff -sat` already
  // recovered the two sync-reset references plain `prep` could not read.
  'reset-contract-unresolved',
  // ADDED. The Reset_Contract_Prepass refused a NON-POSEDGE flop, so the model can carry the
  // design's clocking only unfaithfully: `async2sync` rewrites the async reset only, a
  // negedge-clocked flop reaches `write_smt2` as an ordinary `$dff`, and the transition relation
  // advances every `$dff` one step together, deleting the half-cycle offset a mixed-edge
  // design's correctness rests on. NOT recoverable by a better derivation - the loss is in the
  // model, not in the reading - and it is the ONLY cause in this vocabulary whose failing
  // direction is a FALSE REFUTATION of a CORRECT design, which is why the pre-pass refuses
  // rather than proceeding. Holds 2 of the 33 clocked corpus references (`freq_divbyfrac`,
  // `freq_divbyodd`).
  'clock-contract-unsupported',
  // The Property_Time_Budget was spent before the run produced a verdict.
  'proof-timeout',
  // The toolchain produced no usable verdict: absent binary, or no parseable `Status:`.
  'toolchain-unavailable',
] as const;

/** Why a Formal_Verdict is `could-not-verify`. Closed and enumerable (Req 1.6). */
export type CouldNotVerifyCause = (typeof COULD_NOT_VERIFY_CAUSES)[number];

/**
 * What the antecedent Cover_Check established.
 *
 * `not-applicable` is the unclocked case: a property with no antecedent cannot be vacuous
 * through an unreached one, so the condition is recorded as satisfied without a Cover_Check
 * having run (Req 5.10).
 */
export type CoverCondition =
  | { readonly reached: true; readonly step: number }
  | { readonly reached: false }
  | { readonly reached: 'not-applicable' };

/**
 * The five conditions, recorded for EVERY run whatever the verdict (Req 2.7).
 *
 * The field order is the EVALUATION order `admitProved` enforces, `base` between `cover` and
 * `induction`, so a reader meets the conditions in the order the gate weighs them.
 *
 * `assertionCount` is a plain `number` here on purpose: this value is built from a report the
 * worker produced, so it is untrusted at this boundary, and the guard - not the type - is what
 * establishes it is non-zero.
 *
 * `not-run` is a distinct value on `presat`, `base`, and `induction` rather than being folded
 * into their failing values, because a check that was never run and a check that ran and did not
 * conclude are different facts, and recording the first as the second would report a measurement
 * that never happened. On `base` the distance between those two facts is the widest in the
 * record: a `failed` Base_Check is a counterexample from the design's real reset state, and a
 * `not-run` one is a check we owed and did not deliver.
 */
export interface ProofConditions {
  /** Assertions counted in the generated SMT2. Zero is the measured silent-failure trap. */
  readonly assertionCount: number;
  readonly presat: 'satisfiable' | 'preunsat' | 'not-run';
  readonly cover: CoverCondition;
  /** Plain BMC from the design's real reset state: the fifth condition (Req 1.2, 4.9). */
  readonly base: 'passed' | 'failed' | 'not-run';
  readonly induction: 'successful' | 'inconclusive' | 'not-run';
}

/**
 * Module-private brand key. Because this symbol is neither exported nor otherwise nameable, no
 * code outside this module can construct the brand's property, which is what makes
 * `admitProved` the sole constructor of a `NonZeroAssertionCount` and therefore of a
 * `ProvedEvidence`.
 */
declare const NON_ZERO_ASSERTION_COUNT: unique symbol;

/**
 * An assertion count the Assertion_Count_Guard has seen to be a positive, safe integer.
 *
 * The brand is the point: a `ProvedEvidence` cannot be assembled from a count that did not pass
 * through `admitProved`'s guard.
 */
export type NonZeroAssertionCount = number & { readonly [NON_ZERO_ASSERTION_COUNT]: true };

/**
 * The ONLY value a `proved` verdict can be built from. Every field is a LITERAL type.
 *
 * The `cover` member is spelled out rather than derived as `Exclude<CoverCondition, ...>`, so a
 * fourth `CoverCondition` member added later is NOT silently admitted into a proof: it would
 * fail to narrow in `admitProved` and become a compile error there, which is the fail-safe
 * direction.
 */
export interface ProvedEvidence {
  readonly assertionCount: NonZeroAssertionCount;
  readonly presat: 'satisfiable';
  readonly cover:
    { readonly reached: true; readonly step: number } | { readonly reached: 'not-applicable' };
  readonly base: 'passed';
  readonly induction: 'successful';
}

/**
 * The outcome for ONE Formal_Property (Req 1.14).
 *
 * `could-not-verify` is a THIRD member, distinct from `refuted` and from `proved` at every seam
 * it crosses (Req 1.11): folding it into `refuted` would blame the student for our solver, and
 * folding it into `proved` is the severity-1 shape this spec exists to prevent.
 *
 * `depth` and `elapsedMs` are on every member, including `could-not-verify`, because a timed-out
 * run's elapsed time is the fact a reader most needs (Req 7.5). `conditions` is on every member
 * that is not `proved`; a `proved` result carries the stronger `evidence` instead, which holds
 * the same five facts in their admitting form.
 */
export type PropertyResult =
  | {
      readonly verdict: 'proved';
      readonly evidence: ProvedEvidence;
      readonly depth: number;
      readonly elapsedMs: number;
      readonly criterionRef: string;
    }
  | {
      readonly verdict: 'refuted';
      /** The counterexample the refutation was reported with (Req 1.10). */
      readonly counterexample: ArtifactBlobRef;
      readonly conditions: ProofConditions;
      readonly depth: number;
      readonly elapsedMs: number;
      readonly criterionRef: string;
    }
  | {
      readonly verdict: 'could-not-verify';
      /** Exactly one cause, the first condition to fail in the fixed order (Req 1.5, 1.7). */
      readonly cause: CouldNotVerifyCause;
      readonly conditions: ProofConditions;
      readonly depth: number;
      readonly elapsedMs: number;
      readonly criterionRef: string;
      /** Sanitized frontend or build diagnostic tail, bounded. Never a path or host. */
      readonly diagnostic: string | null;
      /**
       * Whether a Solver_Cross_Check disagreement is what produced this result.
       *
       * Carried because `toolchain-unavailable` has several sources and the cause alone cannot
       * say which, so a record of this result could not name its own cause. `false` where no
       * audit ran, since an audit that never ran disagreed with nothing.
       */
      readonly crossCheckDisagreed: boolean;
    };

/** The closed three-member Formal_Verdict vocabulary (Req 1.1), derived so it cannot drift. */
export type FormalVerdict = PropertyResult['verdict'];

/** Every Formal_Verdict, in the order a reader thinks about them. Closed and enumerable. */
export const FORMAL_VERDICTS = [
  'proved',
  'refuted',
  'could-not-verify',
] as const satisfies readonly FormalVerdict[];

/**
 * The cause to report for each NON-ADMITTING Presat_Check value.
 *
 * A total `Record` over `Exclude<..., 'satisfiable'>` rather than a comparison chain, so a
 * fourth Presat_Check value added later is a COMPILE ERROR here instead of silently defaulting
 * to some cause that was not measured.
 *
 * `preunsat` is `contradictory-assumptions` because that is what `--presat` measured (Req 5.7).
 * `not-run` is `toolchain-unavailable` and NOT `contradictory-assumptions`: Req 5.6 requires the
 * Presat_Check to have run for any property whose verdict could be `proved`, so a `not-run`
 * arriving here means our own toolchain produced no result for a check it owed, which is the
 * same fact Req 1.9 already names `toolchain-unavailable`. Reporting `contradictory-assumptions`
 * instead would assert a contradiction nobody observed.
 */
const PRESAT_FAILURE_CAUSE: Readonly<
  Record<Exclude<ProofConditions['presat'], 'satisfiable'>, CouldNotVerifyCause>
> = Object.freeze({
  preunsat: 'contradictory-assumptions',
  'not-run': 'toolchain-unavailable',
});

/**
 * The cause to report for each NON-ADMITTING Base_Check value, by the same totality rule.
 *
 * Both members map to `toolchain-unavailable` and they arrive there for DIFFERENT reasons, which
 * is why the map states both instead of one comparison collapsing them.
 *
 * `failed` is `toolchain-unavailable` because a failed Base_Check is a REFUTATION, and `refuted`
 * is not a `CouldNotVerifyCause` and therefore cannot be returned from here. That is not a gap:
 * Req 1.10 makes a `refuted` result CARRY the Counterexample the refutation was reported with,
 * the Counterexample is registered on the run rather than in any condition, and this function
 * sees `ProofConditions` alone. So the caller is the only layer that can report `refuted`, and
 * the value here is what a base-case failure means when no refutation could be built from it -
 * exactly the case Req 1.17 names: a base-case `FAILED` with NO registered Counterexample is
 * `could-not-verify` with `toolchain-unavailable` and is NEVER `refuted`, because a refutation
 * whose evidence cannot be handed back is a gap in the instrument rather than a finding about the
 * design. Note the direction this fails in: a caller that never looked for the refutation reports
 * a gap in our own instrument, and never a `proved`.
 *
 * `not-run` is `toolchain-unavailable` for the reason `PRESAT_FAILURE_CAUSE` records: Req 4.9
 * requires the Base_Check to have run for every property whose verdict could be `proved`, so its
 * absence is a fact about our instrument rather than a base-case failure we witnessed.
 */
const BASE_FAILURE_CAUSE: Readonly<
  Record<Exclude<ProofConditions['base'], 'passed'>, CouldNotVerifyCause>
> = Object.freeze({
  failed: 'toolchain-unavailable',
  'not-run': 'toolchain-unavailable',
});

/**
 * The cause to report for each NON-ADMITTING Induction_Check value, by the same totality rule.
 *
 * `inconclusive` is `induction-inconclusive`: the run reported at best a bounded pass, which is
 * not a proof (Req 4.3). `not-run` is `toolchain-unavailable` for the reason
 * `PRESAT_FAILURE_CAUSE` records - Req 4.1 requires the Induction_Check to have run, so its
 * absence is a fact about our instrument, not an inconclusive induction we witnessed.
 *
 * `induction-engine-incomplete` is deliberately NOT reachable from this map. It is the cause for
 * an induction FAILURE over a PASSING base case (Req 4.11), and `ProofConditions['induction']`
 * records what the check ESTABLISHED rather than the raw `Status:` string it printed, so this
 * map cannot tell a reported failure from a bounded pass. The caller holds the string and names
 * the two apart (Req 4.12); what this map guarantees is that neither one admits a proof.
 */
const INDUCTION_FAILURE_CAUSE: Readonly<
  Record<Exclude<ProofConditions['induction'], 'successful'>, CouldNotVerifyCause>
> = Object.freeze({
  inconclusive: 'induction-inconclusive',
  'not-run': 'toolchain-unavailable',
});

/**
 * Whether a recorded assertion count is a real, positive count.
 *
 * NOT exported, which is half of what makes `admitProved` the sole constructor: an exported
 * predicate would let a caller narrow a `number` to the brand and then assemble a
 * `ProvedEvidence` literal itself.
 *
 * `Number.isSafeInteger` rather than `count > 0` alone, because this number was parsed from a
 * worker report: `NaN`, `Infinity`, a negative, and a fractional count are all "we do not have a
 * count", and Req 2.8's rule for an unreadable file is that an absent count reads as zero rather
 * than as a satisfied precondition.
 */
function isNonZeroAssertionCount(count: number): count is NonZeroAssertionCount {
  return Number.isSafeInteger(count) && count > 0;
}

/**
 * The ONLY constructor of a `ProvedEvidence` (Req 1.4). Total: returns the evidence, or the
 * FIRST failing condition's cause in the fixed order (Req 1.7). Never throws, on any input.
 *
 * `proved` is reachable only by falling through all FIVE refusals, which is the same shape the
 * simulation oracle's verdict function uses - `pass` sits at the end of a chain of guards.
 *
 * Nothing can skip the assertion-count condition (Req 2.6). The function takes exactly one
 * parameter, reads no module-level mutable state, no configuration value, and no environment
 * variable, and the count guard is its first statement, so there is no argument a caller could
 * pass and no value anyone could set that reaches the later conditions past a zero count.
 */
export function admitProved(conditions: ProofConditions): ProvedEvidence | CouldNotVerifyCause {
  const { assertionCount, presat, cover, base, induction } = conditions;
  if (!isNonZeroAssertionCount(assertionCount)) {
    return 'zero-assertions';
  }
  if (presat !== 'satisfiable') {
    return PRESAT_FAILURE_CAUSE[presat];
  }
  if (cover.reached === false) {
    return 'antecedent-unreached';
  }
  if (base !== 'passed') {
    return BASE_FAILURE_CAUSE[base];
  }
  if (induction !== 'successful') {
    return INDUCTION_FAILURE_CAUSE[induction];
  }
  // Every field below is narrowed to its admitting literal type by the guards above, so this
  // object literal type-checks as `ProvedEvidence` with no cast anywhere in the module.
  return { assertionCount, presat, cover, base, induction };
}
