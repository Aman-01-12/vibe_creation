// formal-property-oracle, Property 34: the derivation that never guesses (task 16.7).
//
// WHICH CLAUSES LIVE HERE, WHICH LIVE IN THE WORKER TESTS, AND WHY THE SPLIT IS FORCED
//   Property 34 is written "*for any* set of flip-flop cells", and task 16.7 asks for a test over
//   generated cell sets. THERE IS NO TYPESCRIPT CELL WALK, AND THERE MUST NOT BE ONE. Task 16.2 put
//   the flip-flop-cell walk, the top-level-input-port filter, and the `int(v, 2)` polarity parse in
//   `eda.py`, because the worker is the only side that holds the elaborated netlist. Req 14.24 and
//   14.38 make the pre-pass the ONLY decider of the derived polarity, the free-initial-state fact, and
//   the Clock_Contract, so a second walk in `prepass.ts` would be a second implementation of a
//   measured rule - two things that drift, with a silent polarity flip as the failure mode
//   (`chipAgent/_inbox/gotcha-the-prepass-report-is-two-types-not-one-and-two-self-check-probes-came-back-false-green.md`).
//
//   So the CELL-LEVEL clauses are asserted in `app/tools/sandbox/worker/tests/test_formal_prepass.py`
//   (task 16.4), where the cells actually are:
//     - one retained net with one polarity DERIVES; two nets, two polarities, or two kinds REFUSE
//       (`test_two_reset_nets_refuse_because_no_single_name_can_be_right`, and its two siblings)
//     - the top-level-input-port filter, over the `radix2_div` shape of eleven `SRST` cells with four
//       on internal nets (`test_eleven_srst_cells_with_four_on_internal_nets_still_derive`)
//     - the base-2 parse of a polarity value at BOTH emitted widths, for the reset and for the clock,
//       written so a string comparison against `"1"` fails the test
//       (`test_a_reset_polarity_reads_the_same_at_either_emitted_width`, and its clock sibling)
//     - a cell set holding no reset entry, refusing with no guess at an enabling signal
//
//   THIS FILE therefore restates Property 34 over the WIRE DOCUMENT - `parseFormalPrepassReport` and
//   `deriveFormalPrepassReport`, the two functions that own the TypeScript half - which is where the
//   iff, the refusal ORDER, the refusal VOCABULARY, and "no wrapper is rendered" actually live.
//
// THE SEVEN CLAIMS
//   1. THE PARSE ACCEPTS EVERY HONEST WIRE SHAPE. Each generated document is serialized and parsed
//      back, and the parse must return it unchanged (Req 11.10). An over-strict schema would report
//      `toolchain-unavailable` for a report the worker legitimately wrote, which is a refusal of a
//      design for an instrument reason - so "the schema is closed" and "the schema admits the worker's
//      own output" are two claims and this is the second one.
//   2. THE DERIVATION'S IFF (Req 14.17, 14.18, 14.30, 14.40). A contract is yielded if and only if the
//      document's `clockPolarity` is one of the two SUPPORTED members AND either its reset finding is
//      DERIVED and its initial-state predicate is READABLE, or the polarity is `none` and the design
//      therefore holds no clocked state for a reset net to be missing from.
//      TWO CONJUNCTS OF THAT ARE NOT IN PROPERTY 34's TEXT, and both are real.
//      The PREDICATE conjunct: Req 14.23 and 14.26 refuse an unreadable predicate with
//      `toolchain-unavailable`, so the two-conjunct iff design.md states is FALSE read literally over
//      the document. Property 36 (task 16.8) owns the predicate clause itself; this file only refuses
//      to pretend it is absent.
//      The NO-CLOCKED-STATE arm: criterion 14.18 was NARROWED to the clocked class and criterion 14.40
//      admits a `derived: false` finding as a contract REQUIRING NO RESET where the derived
//      `clockPolarity` is `none` - because a design with no flip-flop cell has no reset entry to
//      retain, and refusing it refused the whole combinational class, 15 of 50 corpus references.
//      design.md resolves the same contradiction from the other side, quantifying Property 34's first
//      and refusal clauses over NON-EMPTY cell sets so they cannot be read as asserting the refused
//      outcome on that class; this file asserts the ADMITTED outcome over it instead, which is strictly
//      stronger and contradicts neither the property text nor the criterion.
//      Both follow the same precedent: the REQUIREMENT is the authority and the property text is
//      flagged rather than silently satisfied
//      (`chipAgent/_inbox/gotcha-design-property-text-omits-the-guards-that-pre-empt-it.md`).
//   3. THE BOTH-REFUSE ORDERING (Req 14.33). Where any cell presented a non-posedge clock, the cause
//      is `clock-contract-unsupported`, INCLUDING where the reset derivation also refused - because it
//      is the refusal no better derivation recovers. `opt_dff -sat` measurably recovered the two
//      sync-reset references plain `prep` could not read; nothing recovers a clocking the model cannot
//      represent. That ORDERING is a DETERMINISM choice rather than a measured one, and the label
//      travels with the assertion.
//   4. EVERY REFUSAL IS A NAMED CAUSE, AND THE TWO-CAUSE CLAIM HOLDS WHERE IT CAN. Property 34's "for
//      any refusal the cause is one of those two" is true of exactly the refusals whose predicate is
//      READABLE, which is the form asserted: a readable-predicate refusal is
//      `clock-contract-unsupported` or `reset-contract-unresolved`, and `toolchain-unavailable` arises
//      from the predicate path alone. All three are members of the closed `CouldNotVerifyCause`
//      vocabulary, so a refusal cannot arrive as prose.
//   5. NO WRAPPER IS RENDERED FROM A REFUSAL. A refusal carries NO report - not an empty one, not a
//      defaulted one - and every yielded report carries a SUPPORTED `clockPolarity` and a reset
//      contract MIRRORING the document's own finding, with no normalization and no default. That is the
//      testable form of "no Property_Wrapper is built for that candidate design" at this layer: the
//      renderer takes a `ResetContract`, and the only contracts reachable through this function are a
//      DERIVED one and - under `none` alone - the one REQUIRING NO RESET (Req 14.40), for which the
//      renderer emits neither the reset assume nor the `if (!$initstate)` gate (Req 14.41).
//   6. AN OUT-OF-VOCABULARY `clockPolarity` IS REFUSED BY THE PARSE AND IS NEVER DEFAULTED TO
//      `posedge` (Req 14.36, 14.37). This is the single most important NEGATIVE claim in the file,
//      because that default is in the FALSE-REFUTATION direction the whole Clock_Contract rule exists
//      to close: a negedge or mixed-edge design read as posedge is lowered by a chain that advances
//      every `$dff` one step together, which MEASURABLY refutes a property true of the real hardware -
//      `Status: FAILED` at step 2 on a minimal mixed-edge reproducer iverilog reports 0 mismatches on
//      over 40 randomised cycles
//      (`chipAgent/_inbox/gotcha-mixed-edge-clocking-collapses-in-write-smt2-and-falsely-refutes.md`).
//      It is asserted with a POSITIVE CONTROL: every other field of the document under test is the
//      ADMITTING shape, so the same document with `posedge` in that slot YIELDS a contract. Without
//      that half the refusal would pass for any reason at all, including one the polarity never
//      touched.
//      Task 16.13 names FOUR plausible drifts as fixed unit cases; this claim quantifies over the
//      class, which is what reaches the shapes a fixed list cannot - a member as a SUBSTRING of a
//      longer value, and the non-string coercion traps, of which `["posedge"]` is the sharp one
//      because `String(["posedge"])` is `"posedge"` exactly.
//   7. THE PARSE IS TOTAL, AND NO REJECTION QUOTES A VALUE (Req 11.10). It never throws on any text,
//      including bytes no JSON reader accepts, and a schema rejection's issue strings name a FIELD and
//      a RULE and quote no VALUE - because a value in this document can be a netlist net name or a
//      fragment of a Yosys diagnostic. A host-shaped value is PLANTED in the rejected documents so
//      that claim can fail; the same discipline Property 25 applies to `parseFormalReport`.
//
//   Plus the seam's own half of the base-2 clause, as named single cases: `resetActiveLow` is a
//   BOOLEAN in the wire schema, so a worker that regressed to passing the RAW polarity string through
//   is REFUSED rather than coerced. That trap is not hypothetical in this direction - JavaScript reads
//   the string `"0"` as truthy, so a passed-through active-LOW value would arrive as active-HIGH, and
//   an inverted assume is measured to reach the student as a refutation of their own correct design.
//
// NON-VACUITY AND THE RUN COUNT
//   The document generator draws its reset finding from `arbPrepassResetFinding()` (REFUSED on 52% of
//   cases, every derived one still coming from `arbResetContract()`), its `clockPolarity` uniformly over
//   the four members (so SUPPORTED and REFUSING are 50/50), and its predicate from
//   `arbInitialStatePredicate()` (readable on 6 of 11, absent or unparseable on 5 of 11). The required
//   shapes and their shares:
//     yielded, reset DERIVED          0.48 * 0.5 * (6/11)  ~ 13.1%
//     clock refusal, reset DERIVED    0.48 * 0.5           ~ 24.0%
//     clock refusal, reset REFUSED    0.52 * 0.5           ~ 26.0%   <- claim 3's row
//     reset refusal, CLOCKED supported
//                                     0.52 * 0.25          ~ 13.0%   <- `asyn_fifo`'s shape, `posedge`
//     predicate refusal, rest fine    0.48 * 0.5 * (5/11)  ~ 10.9%
//     admitted with NO RESET          0.52 * 0.25          ~ 13.0%   <- the supported 15-of-50 class
//   The rarest REQUIRED shape is 10.9%, and `(1 - 0.1)^500` is ~1.3e-23 where `(1 - 0.1)^100` is
//   ~2.7e-5 - small, but a flake rather than a claim. So 500 runs, sized to the rarest shape rather
//   than the claim being weakened to fit the shared default
//   (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//
//   TWO ROWS CHANGED WHEN CRITERION 14.18 WAS NARROWED, and the reason is recorded because it is the
//   kind of thing a later session would otherwise read as drift. The old "reset refusal, clock
//   supported" row counted `posedge` AND `none` together at 10%; under criterion 14.40 only the CLOCKED
//   member refuses, so the row is now keyed to `posedge` alone. And the old "`none` among yielded
//   contracts" row counted a `none` document carrying a DERIVED reset - a pairing NO real design
//   produces, because no flip-flop cell means no reset entry - so the row covering the supported
//   15-of-50 class is now the ADMITTED-WITH-NO-RESET shape, which is what that class actually is. Both
//   halves of the refused finding then needed the share `arbPrepassResetFinding()` supplies; the note at
//   that generator has the arithmetic.
//
//   Claims 6 and 7 ride on their own generators and are sized the same way, to the rarest REQUIRED
//   shape rather than to a round number:
//     - claim 6 draws SEVEN trap classes at equal weight, so each is 1/7 ~ 14.3% and the rarest
//       required shape is any one of them; `(1 - 1/7)^200` is ~4.2e-14, where at 100 runs it would be
//       ~2e-7. So 200.
//     - claim 7 draws FIVE text kinds at weights 2/2/2/1/1, so the total is 8 and the rarest required
//       shape - an over-length document, or a fuzz text - is 1/8 = 12.5%; `(1 - 0.125)^200` is
//       ~3.7e-12, where at 100 runs it would be ~1.9e-6. So 200.
//
// The tag is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to a
// different spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// The `Validates:` line below is task 16.7's own, unedited. Claims 6 and 7 additionally exercise
// Requirements 11.10, 14.26, 14.36, and 14.37, which task 16.13's `Validates:` line names; they are
// asserted here as well because a fixed list of literal values cannot fail a mutation that deletes the
// vocabulary check while keeping the type check, and 16.13's cases are all strings.
//
// **Validates: Requirements 14.9, 14.14, 14.15, 14.16, 14.17, 14.18, 14.20, 14.28, 14.29, 14.30,
// 14.32, 14.33**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CLOCK_POLARITIES,
  COULD_NOT_VERIFY_CAUSES,
  deriveFormalPrepassReport,
  MAX_PREPASS_REPORT_CHARS,
  parseFormalPrepassReport,
  readFormalPrepassReport,
  type ClockPolarity,
  type CouldNotVerifyCause,
  type FormalPrepassDocument,
  type FormalPrepassRejection,
  type PrepassResetFinding,
  type ResetContract,
  type ResetEnable,
} from '@app/tools';

import { arbInitialStatePredicate, arbResetContract } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 34: The reset contract is derived or refused, and never
// guessed**
const PROPERTY =
  'formal-property-oracle, Property 34: The reset contract is derived or refused, and never guessed';

/** See the RUN COUNT note in the header: the rarest required shape is 10% of draws. */
const NUM_RUNS = 500;

/** Claim 6: seven trap classes at equal weight, so the rarest required shape is 1/7 ~ 14.3%. */
const POLARITY_TRAP_RUNS = 200;

/** Claim 7: five text kinds at weights 2/2/2/1/1, so the rarest required shape is 1/8 = 12.5%. */
const PREPASS_TEXT_RUNS = 200;

/**
 * The `clockPolarity` members that SATISFY the Clock_Contract, spelled independently of the module.
 *
 * `posedge` is the 31-of-50 class the whole chain was measured on; `none` is the 15-of-50
 * no-clocked-state class, which is SUPPORTED and must not collapse into a refusal (Req 14.34). Written
 * out here rather than imported from `CLOCK_CONTRACT_REFUSAL`, which is module-private for exactly this
 * reason: a test that reads the map it is checking asserts only that the map equals itself.
 */
const SUPPORTED_POLARITIES: readonly ClockPolarity[] = ['posedge', 'none'];

/** The cause a non-posedge clock must produce, whatever the reset did (Req 14.30, 14.33). */
const CLOCK_REFUSAL: CouldNotVerifyCause = 'clock-contract-unsupported';

/** The cause a refused reset derivation must produce (Req 14.18, 14.20). */
const RESET_REFUSAL: CouldNotVerifyCause = 'reset-contract-unresolved';

/**
 * The polarity of a design holding NO clocked state, spelled once because the amendment turns on it.
 *
 * It is the one supported member under which a `derived: false` reset finding is ADMITTED rather than
 * refused (Req 14.40), because a design with no flip-flop cell has no reset entry to retain.
 */
const NO_CLOCKED_STATE: ClockPolarity = 'none';

/** The cause an unreadable report or predicate must produce (Req 14.26, 14.37). */
const UNREADABLE_REFUSAL: CouldNotVerifyCause = 'toolchain-unavailable';

/** The one predicate body under which every state bit starts free (Req 14.22). */
const FREE_PREDICATE = 'true';

/** The minimum share of generated cases each required shape must reach. */
const MIN_SHAPE_SHARE = 0.05;

/**
 * Whether a predicate body is READABLE at all - present, non-empty after trimming, and balanced.
 *
 * Derived from the two shapes the worker's own reader can leave behind rather than from
 * `readFreeInitialState`: `null` is the worker saying it read no predicate, an empty body is what a
 * `define-fun` whose body was consumed to nothing leaves, and an unbalanced one is what a truncated
 * SMT2 leaves. Property 36 owns the FREE-versus-pinned reading; this file needs only the readable
 * boundary, because that is the conjunct Property 34's own iff silently omits.
 */
function predicateIsReadable(predicate: string | null): boolean {
  if (predicate === null) {
    return false;
  }
  const body = predicate.trim();
  if (body.length === 0) {
    return false;
  }
  let depth = 0;
  for (const character of body) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

/**
 * The reset finding as the WORKER writes it, projected from a generated `ResetContract`.
 *
 * `initialStateFree` is dropped rather than transported, because it does not exist on the wire: the
 * worker hands the predicate's TEXT across and this side reads it, which is what gives that one rule a
 * single owner (Req 14.24). Written field by field rather than as a rest-destructure, because
 * typescript-eslint's `no-unused-vars` defaults `ignoreRestSiblings` to false and the omit-a-key
 * destructure is an error here
 * (`chipAgent/_inbox/gotcha-eslint-ignore-rest-siblings-defaults-false.md`).
 */
function findingOf(contract: ResetContract): PrepassResetFinding {
  return contract.derived
    ? {
        derived: true,
        resetName: contract.resetName,
        resetActiveLow: contract.resetActiveLow,
        resetKind: contract.resetKind,
      }
    : { derived: false };
}

/**
 * The three shapes a derived finding's enabling signal takes (criterion 4.15 of
 * `formal-gate-first-light`, which AMENDS Req 14.19).
 *
 * `null` here is the ABSENT key and not a value on the wire: a reset carried by `$sdff` or `$adff`
 * has no enable to name, and so does one whose enable the worker could not resolve to a single
 * top-level input port. The other two are the measured `LIFObuffer` shape - `EN` asserted HIGH, read
 * off `EN_POLARITY` 1 on all 7 of its `$sdffce` cells - and its opposite, which exists in the
 * population because an absent enable and an enable asserted LOW are the two shapes a defaulted
 * field would collapse into one.
 */
const RESET_ENABLES: readonly (ResetEnable | null)[] = Object.freeze([
  null,
  Object.freeze({ name: 'EN', activeLow: false }),
  Object.freeze({ name: 'en_i', activeLow: true }),
]);

/** One derived finding with `enable` attached, or unchanged where there is no enable to attach. */
function withEnable(finding: PrepassResetFinding, enable: ResetEnable | null): PrepassResetFinding {
  return finding.derived && enable !== null ? { ...finding, resetEnable: enable } : finding;
}

/**
 * One reset's enabling signal as a PRESENCE and a value, so an ABSENT one is comparable.
 *
 * The comparison the mirroring claim needs is of the SHAPE rather than of a value: `resetEnable`
 * is optional precisely so that "no enable was named" is a different shape from "an enable asserted
 * low", and a bare `a.resetEnable === b.resetEnable` would pass a derivation that turned the first
 * into the second's level. Those two render different assumes, so they must not compare equal.
 */
function enableShape(reset: ResetContract | PrepassResetFinding): {
  readonly present: boolean;
  readonly enable: ResetEnable | null;
} {
  if (!reset.derived || reset.resetEnable === undefined) {
    return { present: false, enable: null };
  }
  return { present: true, enable: reset.resetEnable };
}

/** The share the shared generator's own 4-to-1 derived/refused split carries. */
const SHARED_FINDING_WEIGHT = 3;

/** The share drawn as a REFUSED finding on top of it. See the arithmetic below. */
const EXTRA_REFUSED_WEIGHT = 2;

/**
 * The reset finding, drawn with the REFUSED arm lifted from 20% of cases to 52%.
 *
 * WHY THIS IS NOT `arbResetContract().map(findingOf)` ANY MORE, and why the fix belongs in the
 * GENERATOR rather than in a weakened row. `arbResetContract()` refuses on 1 of 5 draws, which was
 * sized when the refused finding fed TWO required shapes. Under criteria 14.18-as-narrowed and 14.40 it
 * feeds THREE, because the outcome now depends on the polarity it is paired with: a clock refusal, the
 * CLOCKED no-net refusal, and the no-clocked-state ADMISSION. Each of the latter two is keyed to ONE of
 * the four polarity members, so at 20% each is 0.2 / 4 = 5% of the sample - exactly `MIN_SHAPE_SHARE`,
 * which is a coin flip against the floor rather than a claim. Lifting the refused share to 52% puts
 * every required shape at 10.9% or above, so `NUM_RUNS` and `MIN_SHAPE_SHARE` both stand unchanged.
 *
 * The shared generator is still the source of every DERIVED finding, so `resetActiveLow`, `resetKind`,
 * and the reset NAME keep varying exactly as they did - this arm only adds refusals, it replaces
 * nothing. `arbResetContract()` itself is untouched, because five other properties are sized against
 * its published 4-to-1 arithmetic.
 *
 * THE ENABLING SIGNAL IS DRAWN HERE AND NOT THERE, for the same reason, and it costs no row. It is
 * an independent draw over `RESET_ENABLES` on top of the derived arm, so every share above is
 * unchanged - the arm weights are what the rows are keyed to - while the generated population now
 * carries all three enable shapes, which is what keeps the new wire field out of the "a schema
 * addition without a generator addition is a silent sample thinning" class. Two of three derived
 * findings carry an enable, so no required shape falls below the rarest one already published.
 */
function arbPrepassResetFinding(): fc.Arbitrary<PrepassResetFinding> {
  return fc.oneof(
    {
      weight: SHARED_FINDING_WEIGHT,
      arbitrary: fc
        .tuple(arbResetContract().map(findingOf), fc.constantFrom(...RESET_ENABLES))
        .map(([finding, enable]) => withEnable(finding, enable)),
    },
    {
      weight: EXTRA_REFUSED_WEIGHT,
      arbitrary: fc.constant<PrepassResetFinding>({ derived: false }),
    },
  );
}

/**
 * One `formal-prepass-report.json` as the worker writes it, across every shape it can take.
 *
 * LOCAL to this file rather than added to `formal-arbitraries.ts`, because it is the only consumer: the
 * shared module owns the generators two or more properties read, and a third generator there would
 * need its own coverage self-check for a sample only this file holds over. The three fields are drawn
 * INDEPENDENTLY, which is what makes claim 3's both-refuse row a generated case rather than a
 * constructed one.
 */
function arbPrepassDocument(): fc.Arbitrary<FormalPrepassDocument> {
  return fc.record<FormalPrepassDocument>({
    reset: arbPrepassResetFinding(),
    clockPolarity: fc.constantFrom(...CLOCK_POLARITIES),
    initialStatePredicate: arbInitialStatePredicate(),
  });
}

/** The cause this document must refuse with, or `null` where it must yield a contract. */
function expectedRefusal(document: FormalPrepassDocument): CouldNotVerifyCause | null {
  // The ORDER is the claim, and it is asserted here rather than as three independent guards: the
  // clock first (Req 14.33, a determinism choice), then the reset, then the predicate - which is only
  // reachable for a derived reset, because `initialStateFree` lives on the derived member alone.
  if (!SUPPORTED_POLARITIES.includes(document.clockPolarity)) {
    return CLOCK_REFUSAL;
  }
  if (!document.reset.derived) {
    // Criterion 14.18 as NARROWED, plus criterion 14.40. "No net at all" refuses only WHERE the design
    // HOLDS CLOCKED STATE. Under `none` there was no flip-flop cell to carry a reset entry, so the
    // absence is the EXPECTED finding and the document is ADMITTED with a contract requiring no reset.
    // The predicate is NOT reached on that arm: `initialStateFree` lives on the derived member alone, so
    // reading it would report an instrument fault for a SUPPORTED design with no state to describe.
    return document.clockPolarity === NO_CLOCKED_STATE ? null : RESET_REFUSAL;
  }
  return predicateIsReadable(document.initialStatePredicate) ? null : UNREADABLE_REFUSAL;
}

// ---------------------------------------------------------------------------
// Claim 6: the out-of-vocabulary `clockPolarity`, and the default that must not exist
// ---------------------------------------------------------------------------

/**
 * Which READ one out-of-vocabulary `clockPolarity` value exists to defeat.
 *
 * Classes rather than a flat list, because the claim is about the CLASS of values the vocabulary
 * excludes and each class defeats a different plausible reader. A flat list of literals would be
 * task 16.13's assertion again, one member longer.
 */
type PolarityTrap =
  | 'case-variant'
  | 'untrimmed'
  | 'member-as-substring'
  | 'other-tools-vocabulary'
  | 'empty'
  | 'non-string'
  | 'fuzz';

/** One generated out-of-vocabulary value, tagged with its class so non-vacuity is checkable. */
interface PolarityTrapCase {
  readonly trap: PolarityTrap;
  readonly value: unknown;
}

/**
 * The fixed values of each trap class. TOTAL over every class but `fuzz`, which is generated.
 *
 * `Readonly<Record<...>>` cannot be written with a class missing, so an eighth class added to the
 * union above is a COMPILE ERROR here rather than a class that silently never appears in the sample -
 * which is the shape that left a widened union vacuously passing in
 * `chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`.
 */
const POLARITY_TRAP_VALUES: Readonly<Record<Exclude<PolarityTrap, 'fuzz'>, readonly unknown[]>> =
  Object.freeze({
    // Defeats a case-INSENSITIVE read. `write_json` emits the parameter and the worker writes the
    // finding in lower case, so a value spelled any other way is not a spelling of a member.
    'case-variant': Object.freeze(['POSEDGE', 'Posedge', 'NegEdge', 'None', 'MIXED']),
    // Defeats a TRIMMING read. No member carries whitespace, so a padded value is a DIFFERENT value
    // rather than the same one loosely written.
    untrimmed: Object.freeze([' posedge', 'posedge ', 'posedge\n', '\tnone', ' none ']),
    // Defeats `includes`, `startsWith`, and a prefix match - the shapes a hand-rolled reader takes.
    // `posedge|negedge` is what a tool reporting BOTH findings in one field would write, and it must
    // refuse rather than matching on whichever member it happens to mention first.
    'member-as-substring': Object.freeze(['pos', 'edge', 'no', 'posedge_clk', 'posedge|negedge']),
    // Another tool's words for the same fact, plus the RAW `CLK_POLARITY` values - so this arm also
    // covers a worker that regressed to passing the parameter through unread.
    'other-tools-vocabulary': Object.freeze(['rising', 'falling', 'both', 'level', '1', '0']),
    // Empty and whitespace-only, which no member is and no trim makes into one.
    empty: Object.freeze(['', ' ', '\n']),
    // THE COERCION TRAPS, and the reason this arm is the sharpest one: `String(['posedge'])` is
    // `'posedge'` EXACTLY, so a reader that coerced before comparing would read a one-element ARRAY
    // as the supported class. The numbers and booleans are what a JSON writer emits for a parameter
    // it never parsed, and `null` is what it emits for a finding it could not make.
    'non-string': Object.freeze([
      null,
      0,
      1,
      true,
      false,
      Object.freeze(['posedge']),
      Object.freeze({ clockPolarity: 'posedge' }),
    ]),
  });

/**
 * Every trap class, as an explicit key tuple so the count and the observed-set expectation read off
 * ONE list.
 *
 * A tuple rather than `Object.keys` of the record above, because `fuzz` is not in that record, and
 * because `Object.values`/`Object.keys` on a fixed-key record falls to the `any`-returning overload
 * and trips `@typescript-eslint/no-unsafe-member-access`. `satisfies` checks every entry is a real
 * class while leaving the length visible.
 */
const POLARITY_TRAPS = [
  'case-variant',
  'untrimmed',
  'member-as-substring',
  'other-tools-vocabulary',
  'empty',
  'non-string',
  'fuzz',
] as const satisfies readonly PolarityTrap[];

/** The four members, as a set, so the fuzz arm can exclude them without re-spelling them. */
const IN_VOCABULARY: ReadonlySet<string> = new Set<string>(CLOCK_POLARITIES);

/** Whether a trap class carries fixed values, so the generated `fuzz` arm can be split off. */
function isFixedTrap(trap: PolarityTrap): trap is Exclude<PolarityTrap, 'fuzz'> {
  return trap !== 'fuzz';
}

/** An out-of-vocabulary `clockPolarity` value, one class per arm at equal weight. */
function arbOutOfVocabularyPolarity(): fc.Arbitrary<PolarityTrapCase> {
  const fixedArms = POLARITY_TRAPS.filter(isFixedTrap).map((trap) => ({
    weight: 1,
    arbitrary: fc
      .constantFrom(...POLARITY_TRAP_VALUES[trap])
      .map((value): PolarityTrapCase => ({ trap, value })),
  }));
  const fuzz = fc
    .string({ maxLength: 16 })
    .filter((value) => !IN_VOCABULARY.has(value))
    .map((value): PolarityTrapCase => ({ trap: 'fuzz', value }));
  return fc.oneof(...fixedArms, { weight: 1, arbitrary: fuzz });
}

/**
 * One report text whose `clockPolarity` is `polarity` and whose every OTHER field ADMITS.
 *
 * The admitting skeleton is the whole point: a derived reset and the free predicate, so with
 * `posedge` in that slot this text yields a contract. The refusal asserted below is therefore
 * attributable to the POLARITY VALUE and to nothing else.
 */
function prepassTextWithPolarity(polarity: unknown): string {
  return JSON.stringify({
    reset: { derived: true, resetName: 'rst_n', resetActiveLow: false, resetKind: 'async' },
    clockPolarity: polarity,
    initialStatePredicate: FREE_PREDICATE,
  });
}

// ---------------------------------------------------------------------------
// Claim 7: totality, and the rejection that quotes nothing
// ---------------------------------------------------------------------------

/** What a generated report text IS, and therefore what the parse must make of it. */
type PrepassTextKind = 'honest' | 'schema-violation' | 'not-json' | 'too-large' | 'fuzz';

/** Every text kind, as an explicit key tuple, for the same reason `POLARITY_TRAPS` is one. */
const PREPASS_TEXT_KINDS = [
  'honest',
  'schema-violation',
  'not-json',
  'too-large',
  'fuzz',
] as const satisfies readonly PrepassTextKind[];

/** One generated report text with its provenance, so each kind's expectation is exact. */
interface PrepassTextCase {
  readonly kind: PrepassTextKind;
  readonly text: string;
}

/** Every rejection reason the parse declares. `satisfies`, so a renamed member fails to compile. */
const DECLARED_REJECTIONS = [
  'report-too-large',
  'not-json',
  'schema-violation',
] as const satisfies readonly FormalPrepassRejection['reason'][];

/**
 * A host-shaped value planted INSIDE every rejected document, so "no VALUE is quoted" can FAIL.
 *
 * Host-shaped on purpose. The two string-valued fields of this document are a netlist NET NAME and
 * the BODY of an SMT2 predicate, and both originate in a tool's output over untrusted input inside a
 * sandbox workspace - so a rejection that echoed either one would carry that text to a caller that
 * logs it. The claim is only falsifiable if such a value is present to be echoed.
 */
const PLANTED_DOCUMENT_VALUE = 'internal.example.test';

/** The honest wire document every text case starts from, with the planted value in both fields. */
function plantedHonestDocument(): Record<string, unknown> {
  return {
    reset: {
      derived: true,
      resetName: PLANTED_DOCUMENT_VALUE,
      resetActiveLow: true,
      resetKind: 'sync',
    },
    clockPolarity: 'posedge',
    // Balanced, non-empty, and NOT the free literal, so this document parses and derives.
    initialStatePredicate: `(= ((|m_n ${PLANTED_DOCUMENT_VALUE}| state)) #b0)`,
  };
}

/**
 * The schema violations a CLOSED schema must refuse, one per way this document can be wrong.
 *
 * Each returns a fresh object rather than mutating a parsed one, so the violation reads as the shape
 * it produces and no `any` enters the file. Every one of them keeps the planted value in place, which
 * is what makes the no-quoting assertion meet a document that has something to quote.
 */
const SCHEMA_VIOLATIONS: readonly ((honest: Record<string, unknown>) => Record<string, unknown>)[] =
  Object.freeze([
    // Closed at the ROOT: a fifth field is a document we do not recognize, not a document with an
    // extra fact.
    (honest) => ({ ...honest, solver: 'bitwuzla' }),
    // Closed INSIDE the reset finding too, which is the half a root-only `additionalProperties`
    // would miss. The enabling signal IS a derived field now (criterion 4.15 of
    // `formal-gate-first-light`), and this is the shape it must not arrive in: a bare net name
    // with no asserted level, alongside a finding missing two of its own required facts.
    (honest) => ({
      ...honest,
      reset: { derived: true, resetName: PLANTED_DOCUMENT_VALUE, resetEnable: 'en' },
    }),
    // The closed clock vocabulary, reached through this generator as well so the planted value meets
    // the enum path.
    (honest) => ({ ...honest, clockPolarity: 'rising' }),
    // The two-member reset KIND, which is a vocabulary for the same reason the polarity is.
    (honest) => ({
      ...honest,
      reset: {
        derived: true,
        resetName: PLANTED_DOCUMENT_VALUE,
        resetActiveLow: true,
        resetKind: 'level',
      },
    }),
    // REQUIRED and NULLABLE are different facts: `json.dumps` writes the key on every run, so an
    // ABSENT key is a document we do not recognize even though `null` is honest.
    (honest) => ({ reset: honest['reset'], clockPolarity: honest['clockPolarity'] }),
  ]);

/** Texts no JSON reader accepts, including the empty one an ABSENT report arrives as. */
const NON_JSON_TEXTS: readonly string[] = Object.freeze([
  '',
  '   ',
  '{',
  '{"reset":',
  '[1, 2',
  'ERROR: yosys crashed before writing a pre-pass report',
  'undefined',
]);

/** Bytes a total parse must survive: a NUL, a control character, and a lone surrogate. */
const ADVERSARIAL_TEXTS: readonly string[] = Object.freeze([
  '\u0000',
  '{"reset":\u0000}',
  'a\u0007b',
  '\ud800',
  '{"clockPolarity":"\ud800"}',
]);

/** A report text of each kind, tagged with what it is. */
function arbPrepassTextCase(): fc.Arbitrary<PrepassTextCase> {
  return fc.oneof(
    {
      weight: 2,
      arbitrary: fc.constant<PrepassTextCase>({
        kind: 'honest',
        text: JSON.stringify(plantedHonestDocument()),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.constantFrom(...SCHEMA_VIOLATIONS).map((violate): PrepassTextCase => ({
        kind: 'schema-violation',
        text: JSON.stringify(violate(plantedHonestDocument())),
      })),
    },
    {
      weight: 2,
      arbitrary: fc
        .constantFrom(...NON_JSON_TEXTS)
        .map((text): PrepassTextCase => ({ kind: 'not-json', text })),
    },
    {
      weight: 1,
      // An otherwise WELL-FORMED document pushed past the size bound, which is the case that bound
      // exists for: refuse rather than truncate, because a truncated document is not a report.
      arbitrary: fc.constant<PrepassTextCase>({
        kind: 'too-large',
        text: JSON.stringify({
          ...plantedHonestDocument(),
          initialStatePredicate: 'x'.repeat(MAX_PREPASS_REPORT_CHARS),
        }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc
        .oneof(fc.string({ maxLength: 48 }), fc.constantFrom(...ADVERSARIAL_TEXTS))
        .map((text): PrepassTextCase => ({ kind: 'fuzz', text })),
    },
  );
}

describe(PROPERTY, () => {
  it('derives or refuses by a fixed order, names every refusal, and yields no guessed contract', () => {
    let total = 0;
    let yieldedWithDerivedReset = 0;
    let clockRefusalWithDerivedReset = 0;
    let clockRefusalWithRefusedReset = 0;
    let resetRefusalUnderACLOCKEDSupportedClock = 0;
    let predicateRefusal = 0;
    let admittedWithNoReset = 0;

    fc.assert(
      fc.property(arbPrepassDocument(), (document: FormalPrepassDocument) => {
        total += 1;

        // Claim 1. The schema admits the worker's own output, byte for byte through JSON.
        const text = JSON.stringify(document);
        const parsed = parseFormalPrepassReport(text);
        expect({ parsed: parsed.ok }).toEqual({ parsed: true });
        if (!parsed.ok) {
          return;
        }
        expect(parsed.value).toEqual(document);

        const derived = deriveFormalPrepassReport(parsed.value);
        const refusal = expectedRefusal(document);

        // Claim 2 and claim 3. The iff and the order, in one comparison: the cause is the FIRST
        // refusal that applies, and a document to which none applies yields a contract.
        expect({ ok: derived.ok, cause: derived.ok ? null : derived.error }).toEqual({
          ok: refusal === null,
          cause: refusal,
        });

        // The composed reader is the SINGLE owner of "an unreadable report is
        // `toolchain-unavailable`", so it must agree with the two functions it composes on every
        // document that parses.
        expect(readFormalPrepassReport(text)).toEqual(derived);

        if (!derived.ok) {
          // Claim 4. Every refusal is a member of the closed vocabulary, and a refusal whose
          // predicate was READABLE is one of Property 34's own two causes.
          expect(COULD_NOT_VERIFY_CAUSES).toContain(derived.error);
          if (predicateIsReadable(document.initialStatePredicate)) {
            expect([CLOCK_REFUSAL, RESET_REFUSAL]).toContain(derived.error);
          }
          // Claim 5a. A refusal carries NO report - not an empty one and not a defaulted one - so
          // there is nothing for a Property_Wrapper to be rendered from.
          expect('value' in derived).toBe(false);
          if (!SUPPORTED_POLARITIES.includes(document.clockPolarity)) {
            if (document.reset.derived) {
              clockRefusalWithDerivedReset += 1;
            } else {
              clockRefusalWithRefusedReset += 1;
            }
          } else if (!document.reset.derived) {
            // Reached only under a CLOCKED supported polarity now, which is `posedge`: the other
            // supported member is `none`, and under it this document is admitted rather than refused.
            expect(document.clockPolarity).not.toBe(NO_CLOCKED_STATE);
            resetRefusalUnderACLOCKEDSupportedClock += 1;
          } else {
            predicateRefusal += 1;
          }
          return;
        }

        // Claim 5b. Every yielded report carries a SUPPORTED `clockPolarity` and a reset contract that
        // MIRRORS the document's own finding - no normalization, no cross-check, no default - so the
        // only `ResetContract` reachable through this function is one a wrapper may be built on.
        expect({
          resetDerived: derived.value.reset.derived,
          polaritySupported: SUPPORTED_POLARITIES.includes(derived.value.clockPolarity),
          polarity: derived.value.clockPolarity,
        }).toEqual({
          resetDerived: document.reset.derived,
          polaritySupported: true,
          polarity: document.clockPolarity,
        });
        // Claim 5b's other half, over the field criterion 4.15 added: the enabling signal MIRRORS
        // the document's too, and an ABSENT one stays absent. Compared as a shape rather than as a
        // value, because the whole reason the field is optional is that "no enable was named" and
        // "an enable asserted low" must not be one shape with a defaulted level - they render
        // different assumes, and the one that pins a net the design does not gate on is in the
        // false-PROOF direction.
        expect(enableShape(derived.value.reset)).toEqual(enableShape(document.reset));

        if (derived.value.reset.derived) {
          yieldedWithDerivedReset += 1;
        } else {
          // THE ONE ARM ON WHICH A NON-DERIVED CONTRACT LEAVES THIS FUNCTION (Req 14.40), and it leaves
          // under `none` and under nothing else. The renderer is already correct for it: no reset assume,
          // because a reset assume over a design with no state pins nothing, and no `if (!$initstate)`
          // gate, because step 0 is the ONLY step at a Proof_Depth of 1 and gating it yields a vacuous
          // pass (Req 14.41).
          expect(derived.value.clockPolarity).toBe(NO_CLOCKED_STATE);
          admittedWithNoReset += 1;
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY. Claim 3's row is the one that matters most and is the rarest: without a generated
    // document in which the clock AND the reset both refuse, the ordering clause is unfalsifiable and
    // the whole of Req 14.33 rests on a comment.
    expect({
      yieldedWithDerivedReset: yieldedWithDerivedReset / total >= MIN_SHAPE_SHARE,
      clockRefusalWithDerivedReset: clockRefusalWithDerivedReset / total >= MIN_SHAPE_SHARE,
      clockRefusalWithRefusedReset: clockRefusalWithRefusedReset / total >= MIN_SHAPE_SHARE,
      resetRefusalUnderACLOCKEDSupportedClock:
        resetRefusalUnderACLOCKEDSupportedClock / total >= MIN_SHAPE_SHARE,
      predicateRefusal: predicateRefusal / total >= MIN_SHAPE_SHARE,
      admittedWithNoReset: admittedWithNoReset / total >= MIN_SHAPE_SHARE,
    }).toEqual({
      yieldedWithDerivedReset: true,
      clockRefusalWithDerivedReset: true,
      clockRefusalWithRefusedReset: true,
      resetRefusalUnderACLOCKEDSupportedClock: true,
      predicateRefusal: true,
      admittedWithNoReset: true,
    });
  });

  it('refuses a RAW polarity string where a boolean belongs, at either emitted width', () => {
    // The seam's own half of Req 14.16 and 14.29. The worker parses `ARST_POLARITY` with `int(v, 2)`
    // and hands a BOOLEAN across, so a regression that passed the raw `write_json` value through must
    // be REFUSED rather than coerced - and the coercion is silently wrong in the worst direction,
    // because JavaScript reads the non-empty string `"0"` as TRUTHY, so an active-LOW reset would
    // arrive as active-HIGH. Both emitted widths are checked, because `ARST_POLARITY` 1 prints as
    // `"1"` after `prep` and as 32 characters after `opt_dff -sat`.
    const widths = ['1', '0', '0'.repeat(31) + '1', '0'.repeat(32)];
    for (const raw of widths) {
      const text = JSON.stringify({
        reset: { derived: true, resetName: 'rst_n', resetActiveLow: raw, resetKind: 'async' },
        clockPolarity: 'posedge',
        initialStatePredicate: FREE_PREDICATE,
      });
      const parsed = parseFormalPrepassReport(text);
      expect({ raw, parsed: parsed.ok }).toEqual({ raw, parsed: false });
      // And the refusal reaches the gate as an instrument fault rather than as a fact about the
      // design (Req 14.26): the whole-text reader maps every parse rejection to one cause.
      expect(readFormalPrepassReport(text)).toEqual({ ok: false, error: UNREADABLE_REFUSAL });
    }
  });

  it('refuses a reset finding carrying a polarity but no net, rather than deriving half of one', () => {
    // The closed schema's other direction: `derived: true` REQUIRES all three facts, so a worker that
    // emitted a polarity without the net it belongs to is refused. Without this, a half-populated
    // finding would reach the renderer as a contract over `undefined`, which renders an assume over a
    // net name that does not exist - a wrapper that does not build, reported against the design.
    const text = JSON.stringify({
      reset: { derived: true, resetActiveLow: true, resetKind: 'async' },
      clockPolarity: 'posedge',
      initialStatePredicate: FREE_PREDICATE,
    });
    expect(parseFormalPrepassReport(text).ok).toBe(false);
    expect(readFormalPrepassReport(text)).toEqual({ ok: false, error: UNREADABLE_REFUSAL });
  });

  it('refuses every out-of-vocabulary clockPolarity and defaults NONE of them to posedge', () => {
    // Claim 6. THE POSITIVE CONTROL FIRST, ONCE: every field but the polarity is the ADMITTING shape,
    // so this same skeleton carrying `posedge` YIELDS a contract. Without this half, each refusal
    // below would pass for any reason at all - including a skeleton malformed in some way the
    // polarity value never touched - and the whole claim would be unfalsifiable while green.
    expect(readFormalPrepassReport(prepassTextWithPolarity('posedge')).ok).toBe(true);

    const trapsObserved = new Set<PolarityTrap>();
    fc.assert(
      fc.property(arbOutOfVocabularyPolarity(), ({ trap, value }: PolarityTrapCase) => {
        trapsObserved.add(trap);
        const text = prepassTextWithPolarity(value);

        // Refused BY THE SCHEMA, which is the one place the vocabulary is closed (Req 14.36): the
        // derivation never sees an out-of-vocabulary value, so there is nowhere below this point at
        // which one could have been defaulted.
        const parsed = parseFormalPrepassReport(text);
        expect({ trap, ok: parsed.ok, reason: parsed.ok ? null : parsed.error.reason }).toEqual({
          trap,
          ok: false,
          reason: 'schema-violation',
        });

        // And it reaches the gate as an INSTRUMENT FAULT rather than as a fact about the design
        // (Req 14.26, 14.37). `ok: false` is the load-bearing half: a `posedge` default would make
        // this an `ok: true` carrying a contract, which is the false-refutation direction.
        expect(readFormalPrepassReport(text)).toEqual({ ok: false, error: UNREADABLE_REFUSAL });
      }),
      propertyParameters({ numRuns: POLARITY_TRAP_RUNS }),
    );

    // NON-VACUITY: the SET must equal every class. A `size > 1` check would pass while five of the
    // seven reads this claim exists to defeat went untried.
    expect(trapsObserved).toEqual(new Set(POLARITY_TRAPS));
  });

  it('parses any text without throwing, and quotes no document value into a rejection', () => {
    // Claim 7.
    let accepted = 0;
    let issueBearing = 0;
    const kindsObserved = new Set<PrepassTextKind>();
    const reasonsObserved = new Set<FormalPrepassRejection['reason']>();

    fc.assert(
      fc.property(arbPrepassTextCase(), (textCase: PrepassTextCase) => {
        kindsObserved.add(textCase.kind);

        // NEVER THROWS, on any text offered as a pre-pass report (Req 11.10). The caller reads a file
        // from inside a sandbox workspace and hands over whatever it found, so a throw here would
        // surface as an unhandled error on a path whose whole job is to report a named refusal.
        expect(() => parseFormalPrepassReport(textCase.text)).not.toThrow();
        const parsed = parseFormalPrepassReport(textCase.text);

        if (parsed.ok) {
          accepted += 1;
          expect(textCase.kind).toBe('honest');
          // An accepted document is one the parse accepts AGAIN, which is the round-trip half of
          // "the schema admits the worker's own output".
          expect(parseFormalPrepassReport(JSON.stringify(parsed.value)).ok).toBe(true);
          return;
        }

        reasonsObserved.add(parsed.error.reason);
        expect(DECLARED_REJECTIONS).toContain(parsed.error.reason);
        // Each kind's expectation is exact, so a parse that refused the right documents for the WRONG
        // reason - an over-length one reported as malformed JSON, say - fails here. The `fuzz` kind
        // carries no expectation beyond the vocabulary, because what a random byte string is depends
        // on the bytes.
        if (textCase.kind === 'schema-violation') {
          expect(parsed.error.reason).toBe('schema-violation');
        }
        if (textCase.kind === 'not-json') {
          expect(parsed.error.reason).toBe('not-json');
        }
        if (textCase.kind === 'too-large') {
          expect(parsed.error.reason).toBe('report-too-large');
        }

        if (parsed.error.reason === 'schema-violation') {
          issueBearing += 1;
          // THE ISSUES NAME A FIELD AND A RULE AND QUOTE NO VALUE. A value in this document is a
          // netlist net name or the body of an SMT2 predicate, both of which originate in a tool's
          // output over untrusted input.
          expect(parsed.error.issues.length).toBeGreaterThan(0);
          for (const issue of parsed.error.issues) {
            expect(issue).not.toContain(PLANTED_DOCUMENT_VALUE);
          }
        }

        // Every rejection falls to ONE cause, whichever way the text was unreadable (Req 14.26).
        expect(readFormalPrepassReport(textCase.text)).toEqual({
          ok: false,
          error: UNREADABLE_REFUSAL,
        });
      }),
      propertyParameters({ numRuns: PREPASS_TEXT_RUNS }),
    );

    // NON-VACUITY: every kind generated, every declared reason reached, and a real share of both the
    // ACCEPTED documents and the issue-bearing rejections - the second of which is the only shape the
    // no-quoting assertion can run on at all.
    expect(kindsObserved).toEqual(new Set(PREPASS_TEXT_KINDS));
    expect(reasonsObserved).toEqual(new Set(DECLARED_REJECTIONS));
    expect(accepted).toBeGreaterThan(0);
    expect(issueBearing).toBeGreaterThan(0);
  });
});
