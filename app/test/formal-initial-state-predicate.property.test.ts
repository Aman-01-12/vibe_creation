// formal-property-oracle, Property 36: the free-initial-state read and its refusal (task 16.8).
//
// WHY THE REFUSAL IS FORCED RATHER THAN CHOSEN - BOTH DEFAULTS ARE UNSAFE, IN OPPOSITE DIRECTIONS
//   This is the reason the read has THREE outcomes instead of two, and it is the whole content of
//   Req 14.23:
//     - DEFAULTING TO FREE emits the `if (!$initstate)` assertion gate on a design whose step 0 is
//       PINNED by its own `initial` value, which masks a WRONG `initial` value. MEASURED: `bad_init`,
//       carrying `initial out = 4'd15` against the property `out <= 11`, reports base `FAILED` without
//       the gate and reports base and induction both `PASSED` with it, while rIC3 reports `UNSAT`. That
//       is the FALSE-PROOF direction, and the `bad_init` control exists to catch exactly it.
//     - DEFAULTING TO NOT FREE suppresses the gate on a design whose step 0 is a free-variable
//       artifact of the model, failing a CORRECT sync-reset design's base case, because `async2sync`
//       cannot pin step 0 for a synchronous reset. That is the FALSE-REFUTATION direction.
//   There is nothing to choose between a false proof and a false refutation, so the only honest answer
//   is to refuse: `could-not-verify` / `toolchain-unavailable`, deriving no fact at all.
//
// THE FOUR CLAIMS
//   1. THE FACT'S IFF (Req 14.21, 14.22). The derived free-initial-state fact is `true` if and only if
//      the predicate body is literally `true` after trimming. CASE-SENSITIVELY: SMT-LIB's literal is
//      lower case and `write_smt2` emits it that way, so `TRUE` is a predicate that is NOT the free one
//      rather than a spelling of it. A case-insensitive read would gate a design whose step 0 is
//      pinned, which is the false-proof direction above.
//   2. THE THIRD OUTCOME IS NOT A DEFAULT. An ABSENT or UNPARSEABLE predicate yields `null` - neither
//      `true` nor `false` - and the two unparseable shapes are checked apart: empty-after-trimming is
//      what a `define-fun` whose body was consumed to nothing leaves, and parenthesis-unbalanced is
//      what a truncated SMT2 leaves, which is precisely the shape the worker's own balanced scan
//      produces when it runs off the end of a cut-short file.
//   3. END TO END, THROUGH THE REAL SEAM (Req 14.23, 14.26). The same predicate carried in a whole
//      `formal-prepass-report.json` over a DERIVED reset and a SUPPORTED clock: a readable predicate
//      yields a report whose `initialStateFree` is the fact from claim 1, and an unreadable one refuses
//      with `could-not-verify` / `toolchain-unavailable` and carries NO report.
//   4. NEITHER DEFAULT IS TAKEN, asserted as a three-way distinction rather than as an absence. The one
//      carrier document is derived three times over three predicates - the free literal, a pinned one,
//      and an unreadable one - and the three outcomes must be distinguishable from one another: `true`,
//      `false`, and a refusal. An absence is only meaningful when both of the values it is not are
//      observable, which is what this claim establishes.
//
// WHY THE CARRIER DOCUMENT IS PINNED
//   The reset finding and the `clockPolarity` are held FIXED at derived-and-posedge, so the predicate
//   is the only free dimension and the iff is therefore ABOUT the predicate. The refusal ORDER - clock
//   first, then reset, then the predicate, which is reachable only for a derived reset - is Property
//   34's clause and is asserted in `formal-reset-contract-derivation.property.test.ts`. Re-deriving it
//   here would make two files owners of one ordering.
//
// NON-VACUITY AND THE RUN COUNT
//   `arbInitialStatePredicate()` weights its four arms 2 (absent) / 3 (the free literal) / 3 (pinned) /
//   3 (unparseable), for a total of 11. The required shapes and their shares:
//     absent                                   2/11             ~ 18.2%
//     the free literal, exactly `true`         3/11 * 1/4       ~  6.8%
//     the free literal wrapped in whitespace   3/11 * 3/4       ~ 20.5%
//     a pinned predicate                       3/11             ~ 27.3%
//     the CASE VARIANT `TRUE`                  3/11 * 1/5       ~  5.5%   <- the rarest required shape
//     unparseable, empty after trimming        3/11 * 3/7       ~ 11.7%
//     unparseable, parenthesis-unbalanced      3/11 * 4/7       ~ 15.6%
//   `(1 - 0.055)^2000` is ~1e-49, where `(1 - 0.055)^100` is ~3.5e-3 - a one-in-285 flake, not a claim
//   (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//
//   THE RUN COUNT IS SIZED AGAINST THE SHARE FLOOR, NOT AGAINST "THE SHAPE NEVER APPEARED", and the two
//   are different questions. Only the CASE VARIANT is checked with `> 0`, so `(1 - p)^numRuns` is the
//   right arithmetic for it alone; the other six rows are checked against `MIN_SHAPE_SHARE`, which asks
//   for the probability that an OBSERVED share falls under the floor. At the 300 runs this file first
//   carried, the exact-`true` row - true share 6.8% against a 4% floor - fails whenever fewer than 12 of
//   300 draws land on it, which is `P(X <= 11)` for `X ~ Bin(300, 0.068)`: about 2%, MEASURED as one
//   failure in six consecutive runs of this file. At 2000 runs the same row fails below 80 of 2000,
//   which is ~5 standard deviations out, ~2e-7. The whole property is pure string work, so the runs are
//   nearly free: the file is measured at well under a second either way.
//
//   THE WHITESPACE-WRAPPED SHAPE IS NAMED BY ITS OWN VALUE, not by a property a sibling arm shares.
//   `p !== p.trim()` was MEASURED to be a false-green assertion for this generator - the unparseable
//   arm contains `'   '`, which satisfies it - so the shape is counted as
//   `p !== 'true' && p.trim() === 'true'`
//   (`chipAgent/_inbox/gotcha-the-prepass-report-is-two-types-not-one-and-two-self-check-probes-came-back-false-green.md`).
//
// The tag is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to a
// different spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 14.21, 14.22, 14.23**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FREE_INITIAL_STATE_PREDICATE,
  readFormalPrepassReport,
  readFreeInitialState,
  type CouldNotVerifyCause,
  type FormalPrepassDocument,
} from '@app/tools';

import { arbInitialStatePredicate } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 36: The free-initial-state fact is read from the
// initial-state predicate, and an unreadable predicate is refused rather than defaulted**
const PROPERTY =
  'formal-property-oracle, Property 36: The free-initial-state fact is read from the initial-state predicate, and an unreadable predicate is refused rather than defaulted';

/**
 * See the RUN COUNT note in the header.
 *
 * Sized against the SHARE FLOOR rather than against the rarest shape's absence: the rarest
 * share-checked row is the exact-`true` literal at ~6.8% against a 4% floor, and at 300 runs that row
 * fell under the floor about 2% of the time.
 */
const NUM_RUNS = 2000;

/** The cause an unreadable predicate must produce (Req 14.23, 14.26). */
const UNREADABLE_REFUSAL: CouldNotVerifyCause = 'toolchain-unavailable';

/** A pinned predicate, shaped like what `write_smt2` emits for a design carrying an `initial` value. */
const PINNED_PREDICATE = '(= ((|counter_12_n out| state)) #b1111)';

/** An unreadable predicate: a body a truncated SMT2 leaves, whose parentheses never close. */
const UNBALANCED_PREDICATE = '(and (= ((|m_n q| state)) #b0)';

/** The minimum share of generated cases each required shape must reach. */
const MIN_SHAPE_SHARE = 0.04;

/**
 * The carrier document: a DERIVED reset under a SUPPORTED clock, with the predicate left to the caller.
 *
 * Pinned so the predicate is the only free dimension; see the header. A spreadable field rather than a
 * mutated object because `exactOptionalPropertyTypes` is on and every field here is required anyway -
 * the shape is built whole, never patched.
 */
function documentCarrying(predicate: string | null): FormalPrepassDocument {
  return {
    reset: { derived: true, resetName: 'rst', resetActiveLow: false, resetKind: 'sync' },
    clockPolarity: 'posedge',
    initialStatePredicate: predicate,
    // Pinned with the rest of the skeleton, so the predicate stays the only free dimension.
    timing: { derived: true, ports: [] },
  };
}

/** The free-initial-state fact that one whole report carries, or `null` where it refused. */
function factFromTheSeam(predicate: string | null): boolean | CouldNotVerifyCause {
  const read = readFormalPrepassReport(JSON.stringify(documentCarrying(predicate)));
  if (!read.ok) {
    return read.error;
  }
  // The refused arm of `ResetContract` carries no `initialStateFree`, and a report reached through
  // `readFormalPrepassReport` always carries the derived one - Property 34's claim 5. Narrowing here
  // rather than asserting it keeps that claim in one file.
  return read.value.reset.derived ? read.value.reset.initialStateFree : UNREADABLE_REFUSAL;
}

describe(PROPERTY, () => {
  it('reads the fact from the predicate, and refuses an unreadable one rather than defaulting', () => {
    let total = 0;
    let absent = 0;
    let freeExactly = 0;
    let freeWithSurroundingWhitespace = 0;
    let pinned = 0;
    let caseVariantOfTheFreeLiteral = 0;
    let unparseableEmpty = 0;
    let unparseableUnbalanced = 0;

    fc.assert(
      fc.property(arbInitialStatePredicate(), (predicate: string | null) => {
        total += 1;
        const body = predicate === null ? null : predicate.trim();
        const isFree = body === FREE_INITIAL_STATE_PREDICATE;

        // Claim 1 and claim 2 in one comparison over the THREE-valued read: `true` and `false` are
        // both readings of a predicate that arrived, and `null` is the refusal. The expectation is
        // computed from the rule (Req 14.22) rather than from a tag the generator attached, which is
        // why the generator carries none.
        const fact = readFreeInitialState(predicate);
        if (predicate === null) {
          absent += 1;
          expect({ predicate, fact }).toEqual({ predicate, fact: null });
        } else if (isFree) {
          if (predicate === FREE_INITIAL_STATE_PREDICATE) {
            freeExactly += 1;
          } else {
            freeWithSurroundingWhitespace += 1;
          }
          expect({ predicate, fact }).toEqual({ predicate, fact: true });
        } else if (fact === null) {
          if ((body as string).length === 0) {
            unparseableEmpty += 1;
          } else {
            unparseableUnbalanced += 1;
          }
        } else {
          pinned += 1;
          if ((body as string).toLowerCase() === FREE_INITIAL_STATE_PREDICATE) {
            // The case variant. A case-INSENSITIVE read would report this as FREE and gate a design
            // whose step 0 is pinned - the false-proof direction.
            caseVariantOfTheFreeLiteral += 1;
          }
          expect({ predicate, fact }).toEqual({ predicate, fact: false });
        }

        // Claim 3. The same predicate through the whole seam: the fact the report carries is the fact
        // the read produced, and a `null` read arrives as the named refusal with no report at all.
        expect({ predicate, seam: factFromTheSeam(predicate) }).toEqual({
          predicate,
          seam: fact === null ? UNREADABLE_REFUSAL : fact,
        });
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY. Every arm of the generator and both unparseable sub-shapes must have been drawn:
    // the iff is trivially true over a sample carrying only readable predicates, and the refusal clause
    // is trivially true over one carrying only readable ones.
    expect({
      absent: absent / total >= MIN_SHAPE_SHARE,
      freeExactly: freeExactly / total >= MIN_SHAPE_SHARE,
      freeWithSurroundingWhitespace: freeWithSurroundingWhitespace / total >= MIN_SHAPE_SHARE,
      pinned: pinned / total >= MIN_SHAPE_SHARE,
      caseVariant: caseVariantOfTheFreeLiteral > 0,
      unparseableEmpty: unparseableEmpty / total >= MIN_SHAPE_SHARE,
      unparseableUnbalanced: unparseableUnbalanced / total >= MIN_SHAPE_SHARE,
    }).toEqual({
      absent: true,
      freeExactly: true,
      freeWithSurroundingWhitespace: true,
      pinned: true,
      caseVariant: true,
      unparseableEmpty: true,
      unparseableUnbalanced: true,
    });
  });

  it('keeps the three outcomes distinguishable, so neither default is reachable', () => {
    // Claim 4. One carrier document, three predicates, three distinct outcomes. This is what makes the
    // refusal meaningful: both of the values it is NOT are observable through the same path, so the
    // refusal is a third answer rather than an unreached branch. Defaulting to free would collapse the
    // third row into the first, and defaulting to not free into the second.
    expect({
      free: factFromTheSeam(FREE_INITIAL_STATE_PREDICATE),
      pinned: factFromTheSeam(PINNED_PREDICATE),
      absent: factFromTheSeam(null),
      unbalanced: factFromTheSeam(UNBALANCED_PREDICATE),
    }).toEqual({
      free: true,
      pinned: false,
      absent: UNREADABLE_REFUSAL,
      unbalanced: UNREADABLE_REFUSAL,
    });
  });
});
