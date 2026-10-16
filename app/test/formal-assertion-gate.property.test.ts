// formal-property-oracle, Property 31: the assertion gate's if-and-only-if (task 16.9).
//
// WHY THE IFF IS ASSERTED IN BOTH DIRECTIONS, AND WHY THE TWO FAILURES ARE OPPOSITE
//   A gate MISSING where it is needed fails a correct sync-reset design's base case: `async2sync`
//   cannot pin step 0 for a synchronous reset, so the step-0 sample is a free-variable artifact of
//   the model rather than a fact about the design - the FALSE-REFUTATION direction.
//   A gate PRESENT where it is not needed masks a wrong `initial` value: MEASURED with the gate
//   applied UNIVERSALLY, `bad_init` (carrying `initial out = 4'd15` against the property `out <= 11`)
//   reports base `FAILED` WITHOUT the gate and reports base and induction both `PASSED` with it,
//   while rIC3 reports `UNSAT`. The gate turns a DETECTED BUG into a PROOF on every engine measured,
//   because the gate suppresses the step-0 sample and this defect IS the step-0 sample - the
//   FALSE-PROOF direction. One-directional coverage would leave one of those two unpinned, so both
//   rows of the iff are asserted over generated cases rather than one being inferred from the other.
//
// THE FOUR CLAIMS
//   1. THE GATE'S IFF (Req 14.3, 14.4, 14.5). The rendered wrapper carries the `!$initstate` term in
//      its assertion's statement guard if and only if the Reset_Contract was DERIVED, its kind is
//      SYNCHRONOUS, and its initial state is FREE - and the property's shape admits a statement guard
//      at all, which is the decision recorded below.
//   2. THE ASSUME IS INDEPENDENT OF THE GATE (Req 14.1, 14.6). The unclocked `assume property` is
//      emitted for every DERIVED contract, in all four rows of the reset/initial-state cross, so the
//      three ungated rows still carry it. That is what makes the two emissions two decisions rather
//      than one: the assume alone still fails at step 1 and the gate alone still fails at step 2, so
//      neither may stand in for the other.
//   3. A CONTRACT WHOSE INITIAL STATE IS NOT FREE RENDERS NO GATE (Req 14.5), so the step-0 sample IS
//      evaluated and a wrong `initial` value is caught. Asserted as its own counted row rather than
//      left to the iff, because it is the row the `bad_init` control occupies.
//   4. A REFUSED CONTRACT RENDERS NEITHER EMISSION. `renderPropertyWrapper` accepts a refused
//      contract so the refusal is REPRESENTABLE at that seam rather than thrown, and the shape it
//      renders carries no assume and no gate.
//
// TASK 16.9's OPEN DECISION, DECIDED: PROPERTY 31 CANNOT COVER THE COMBINATIONAL SHAPE
//   design.md Property 31 reads "*for any* derived `ResetContract` and *for any* Formal_Property", and
//   Req 14.3 is worded just as universally. Read literally, both are FALSE of correct code, and this
//   file asserts the version that is true, flagging the text rather than weakening the test - the rule
//   `chipAgent/_inbox/gotcha-design-property-text-omits-the-guards-that-pre-empt-it.md` records.
//
//   WHY IT CANNOT. The gate is a STATEMENT guard - `if (<terms>) assert(...);` - and Req 6.2 mandates
//   the combinational shape as a module-level `assert property (<consequent>);` carrying NO clocking
//   event. There is no `if` at module scope to put the terms in, and the clocked form is not an
//   available substitute: `assert property (@(posedge clk) e)` is a measured hard Yosys syntax error.
//   So Req 6.2 is a guard EVALUATED AHEAD of Req 14.3 for that shape, and the testable form of 14.3
//   is "where the property's shape admits a statement guard".
//
//   THE RESIDUAL, NAMED RATHER THAN ABSORBED. A combinational property over a SYNC-reset
//   free-initial-state design therefore still evaluates the free step-0 sample, which is the
//   false-refutation direction. Task 16.5 recorded it at `gateCondition` in the renderer, and closing
//   it needs a SECOND gate FORM - the implication `!$initstate || <consequent>` inside the assert -
//   which is a spec decision about Req 14.3's emitted shape and not a renderer or test one.
//
//   THE BOUND ON THE EXPOSURE IS NARROWER THAN THE VAULT NOTE STATES, and that is worth writing down
//   here because it is the reason this decision is a decision and not a formality. The recorded bound
//   is "a design with no clocked state has no reset flop, so the pre-pass refuses it and no wrapper is
//   built" - which is true, and covers a design that is ENTIRELY combinational. It does NOT cover a
//   CLOCKED design carrying a combinational property: there the pre-pass derives a contract that can
//   be sync-and-free, a wrapper IS built, and the module-level assert reads the free step-0 sample.
//   Claim 5 below asserts that behaviour rather than asserting it away, and counts the shape so the
//   claim is known to have been exercised.
//
//   5. A COMBINATIONAL PROPERTY RENDERS NO GATE, even where the contract would gate a clocked one.
//
// WHY THE GATE IS READ POSITIONALLY AND NOT BY SUBSTRING
//   `$initstate` is a member of the accepted dialect's nullary functions and `!` is an accepted unary
//   operator, so a generated ANTECEDENT can legitimately spell `!$initstate` itself. A detector
//   searching the line for that text would then read a gate where the renderer emitted none, and the
//   iff would pass for the wrong reason. So the guards are paren-matched out of the assert line and
//   split POSITIONALLY - a gate wraps the antecedent, never the other way round, so the gate is the
//   guard chain minus its trailing antecedent guard, exactly as `formal-cover-derivation` reads it.
//   The adversarial shape is ~9e-5 of generated cases, far too rare to require, so it is pinned as a
//   DETERMINISTIC named case instead: an antecedent spelling `!$initstate` over an ASYNC contract
//   renders no gate.
//
// NON-VACUITY AND THE RUN COUNT
//   `arbResetContract()` derives on 4 of 5 draws and then draws the kind, the polarity, and the
//   initial-state shape as three independent fair coins, so each of Property 31's FOUR rows is ~20% of
//   derived draws and ~16% of all draws; `arbFormalProperty()` is clocked on 2 of 3. The required
//   shapes and their shares:
//     gating row, clocked          0.8 * 0.5 * 0.5 * (2/3) ~ 13.3%
//     async row, clocked           0.8 * 0.5 * (2/3)       ~ 26.7%
//     sync-not-free row, clocked   0.8 * 0.5 * 0.5 * (2/3) ~ 13.3%
//     refused contract, clocked    0.2 * (2/3)             ~ 13.3%
//     combinational under a gating contract   0.8*0.25*(1/3) ~ 6.7%
//     ... of which the ones that RENDER an assert are fewer still, because a combinational consequent
//     carrying `$past` or `$stable` renders nothing at all (Req 6.20, 6.23) - measured empirically at
//     roughly two thirds of them, so ~4%.
//   The rarest REQUIRED shape is therefore ~4%, and `(1 - 0.04)^500` is ~1.3e-9 while `(1 - 0.04)^100`
//   is ~1.7e-2 - a coin flip in disguise. So 500 runs, not the shared 100, sized to the rarest shape
//   rather than the claim being weakened to fit the default
//   (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//   The whole property is pure string work.
//
// The tag is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to a
// different spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 6.1, 6.2, 14.1, 14.3, 14.4, 14.5, 14.6**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import {
  renderPropertyWrapper,
  validateExpression,
  type FormalProperty,
  type ResetContract,
  type ValidatedExpression,
} from '@app/tools';

import { arbDesignInterface, arbFormalProperty, arbResetContract } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 31: The assertion gate is emitted for exactly the
// sync-reset-and-free-initial-state case**
const PROPERTY =
  'formal-property-oracle, Property 31: The assertion gate is emitted for exactly the sync-reset-and-free-initial-state case';

/** The wrapper name is caller-owned and no model output reaches it; one fixed value suffices. */
const WRAPPER_NAME = 'formal_property_wrapper';

/** See the RUN COUNT note in the header: the rarest required shape is ~4% of draws. */
const NUM_RUNS = 500;

/** The gate term whose presence is the whole claim. */
const INITIAL_STATE_TERM = '!$initstate';

/** The statement guard's prefix. Its `(` is the last character, which the paren match starts from. */
const GUARD_PREFIX = 'if (';

/** The clocked shape's immediate assertion (Req 6.1). */
const ASSERT_PREFIX = 'assert(';

/** The combinational shape's module-level assertion (Req 6.2). */
const ASSERT_PROPERTY_PREFIX = 'assert property (';

/** The unclocked reset assume (Req 14.1). */
const ASSUME_PREFIX = 'assume property (';

/** The join between two independently decided gate terms. */
const TERM_JOIN = ' && ';

/** The minimum share each of the four reset rows must reach among generated cases. */
const MIN_ROW_SHARE = 0.05;

/**
 * The minimum share of cases that must be a COMBINATIONAL property under a GATING contract, rendering
 * a real assert. Lower than `MIN_ROW_SHARE` because the shape is the product of three independent
 * draws and a renderability condition; see the arithmetic in the header.
 */
const MIN_COMBINATIONAL_SHARE = 0.02;

/** The offset of the `)` closing the `(` at `openOffset`, or `-1` when it never closes. */
function matchingCloseParen(source: string, openOffset: number): number {
  let depth = 0;
  for (let index = openOffset; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Every paren-matched argument of `prefix` in `source`, in emitted order. */
function parenArguments(source: string, prefix: string): readonly string[] {
  const openOffsetInPrefix = prefix.length - 1;
  const found: string[] = [];
  let at = source.indexOf(prefix);
  while (at !== -1) {
    const open = at + openOffsetInPrefix;
    const close = matchingCloseParen(source, open);
    expect({ prefix, offset: at, closes: close > open }).toEqual({
      prefix,
      offset: at,
      closes: true,
    });
    found.push(source.slice(open + 1, close));
    at = source.indexOf(prefix, at + 1);
  }
  return found;
}

/** The lines of `rendered` carrying `prefix`. */
function linesCarrying(rendered: string, prefix: string): readonly string[] {
  return rendered.split('\n').filter((line) => line.includes(prefix));
}

/**
 * The gate terms the assertion carries, or `null` where it carries no gate.
 *
 * POSITIONAL, not a substring search: the gate is the assert line's guard chain minus its TRAILING
 * antecedent guard, because a gate wraps the antecedent and never the reverse. `trailingGuards` is 1
 * for a property carrying an antecedent and 0 otherwise, which only the caller knows - which is
 * exactly why an antecedent that spells `!$initstate` cannot be mistaken for a gate here.
 */
function gateTermsOf(rendered: string, trailingGuards: number): readonly string[] | null {
  const assertLines = linesCarrying(rendered, ASSERT_PREFIX);
  expect({ assertLines: assertLines.length }).toEqual({ assertLines: 1 });
  const guards = parenArguments(assertLines[0] as string, GUARD_PREFIX);
  const gates = guards.slice(0, Math.max(0, guards.length - trailingGuards));
  // At most ONE gate guard: the two gate terms are `&&`-joined inside a single `if` rather than
  // nested, which is what lets the cover carry the identical text (Property 16's clause 7).
  expect({ gateGuards: gates.length <= 1 }).toEqual({ gateGuards: true });
  return gates.length === 0 ? null : (gates[0] as string).split(TERM_JOIN);
}

/** Whether the emitted assertion is gated on the initial state, read positionally. */
function carriesInitialStateGate(rendered: string, property: FormalProperty): boolean {
  if (property.kind !== 'clocked') {
    // The combinational shape has no statement context at all, so there is no guard to read and no
    // `if (` may appear anywhere in the wrapper. Claim 5, asserted here rather than assumed.
    expect(parenArguments(rendered, GUARD_PREFIX)).toEqual([]);
    return false;
  }
  const terms = gateTermsOf(rendered, property.antecedent === null ? 0 : 1);
  return terms !== null && terms.includes(INITIAL_STATE_TERM);
}

/**
 * Whether this contract and this property's shape call for the gate, derived from the RULE.
 *
 * Both conditions, not either (Req 14.3, 14.4, 14.5), plus the shape condition the decision in the
 * header records. Written from the requirement rather than imported from the renderer: a pin spelled
 * in terms of the thing it pins asserts only that the thing equals itself.
 */
function gateIsCalledFor(reset: ResetContract, property: FormalProperty): boolean {
  return (
    property.kind === 'clocked' &&
    reset.derived &&
    reset.resetKind === 'sync' &&
    reset.initialStateFree
  );
}

/** Put a fixture expression through the sole constructor of the brand, or fail loudly. */
function validatedOrThrow(text: string): ValidatedExpression {
  const result = validateExpression(text);
  if (!result.ok) {
    throw new Error(`fixture expression is outside the accepted dialect: ${text}`);
  }
  return result.value;
}

/** The design the named cases are rendered over. */
const NAMED_CASE_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'counter_12',
  ports: [{ name: 'out', direction: 'output', width: 4 }],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
};

/** A clocked property whose ANTECEDENT spells the gate term, which no substring reader survives. */
const ANTECEDENT_SPELLING_THE_GATE_TERM: FormalProperty = {
  kind: 'clocked',
  id: 'p1',
  criterionRef: 'ac-1',
  clock: validatedOrThrow('clk'),
  antecedent: validatedOrThrow(INITIAL_STATE_TERM),
  consequent: validatedOrThrow('out <= 11'),
};

/** A concrete derived contract. */
function derivedContract(
  resetKind: 'async' | 'sync',
  initialStateFree: boolean,
): Extract<ResetContract, { readonly derived: true }> {
  return { derived: true, resetName: 'rst', resetActiveLow: false, resetKind, initialStateFree };
}

describe(PROPERTY, () => {
  it('gates the assertion on exactly the sync-and-free row, and assumes the reset on all four', () => {
    let total = 0;
    let gatingRow = 0;
    let asyncRow = 0;
    let syncNotFreeRow = 0;
    let refusedRow = 0;
    let combinationalUnderAGatingContract = 0;

    fc.assert(
      fc.property(
        arbDesignInterface(),
        arbFormalProperty(),
        arbResetContract(),
        (designInterface: ModuleInterface, property: FormalProperty, reset: ResetContract) => {
          total += 1;
          const rendered = renderPropertyWrapper(designInterface, property, WRAPPER_NAME, reset);

          // PRECONDITION, so a generator drift is reported rather than silently thinning the sample:
          // every clocked property in this sample renders exactly one immediate assertion. A clocked
          // property whose largest `$past` depth exceeds `MAX_WARM_UP_DEPTH` renders none at all, and
          // this generator emits only the one-argument `$past(x)` form, whose depth is 1.
          const assertLines = linesCarrying(rendered, ASSERT_PREFIX).length;
          if (property.kind === 'clocked') {
            expect({ assertLines }).toEqual({ assertLines: 1 });
          }

          // Claim 1. The iff, in both directions at once.
          const gated = carriesInitialStateGate(rendered, property);
          expect({ gated }).toEqual({ gated: gateIsCalledFor(reset, property) });

          // Claim 2 and claim 4. The assume is emitted for every DERIVED contract and for no refused
          // one - which is Req 14.1's scope. design.md's "carries the unclocked `assume property` in
          // EVERY case" is FALSE read literally over a generator that also produces refusals, so the
          // requirement's version is what is asserted and the property text is flagged in the header.
          expect({ assumes: parenArguments(rendered, ASSUME_PREFIX).length }).toEqual({
            assumes: reset.derived ? 1 : 0,
          });

          if (!reset.derived) {
            if (property.kind === 'clocked') {
              refusedRow += 1;
            }
            return;
          }
          if (reset.resetKind === 'async') {
            if (property.kind === 'clocked') {
              asyncRow += 1;
            }
          } else if (!reset.initialStateFree) {
            // Claim 3. The `bad_init` row: step 0 is pinned by the design's own `initial` value, so
            // the sample is meaningful and gating it is exactly what would mask a wrong one.
            if (property.kind === 'clocked') {
              syncNotFreeRow += 1;
              expect({ gated }).toEqual({ gated: false });
            }
          } else if (property.kind === 'clocked') {
            gatingRow += 1;
          } else if (linesCarrying(rendered, ASSERT_PROPERTY_PREFIX).length === 1) {
            // Claim 5. A combinational property under a contract that WOULD gate a clocked one: the
            // module-level assert is emitted and carries no gate, which is the named residual.
            combinationalUnderAGatingContract += 1;
          }
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY. Every row of the case table must have been generated, or the iff is asserted over a
    // sample missing the row it is about - the failure mode
    // `chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md` records.
    expect({
      gatingRow: gatingRow / total >= MIN_ROW_SHARE,
      asyncRow: asyncRow / total >= MIN_ROW_SHARE,
      syncNotFreeRow: syncNotFreeRow / total >= MIN_ROW_SHARE,
      refusedRow: refusedRow / total >= MIN_ROW_SHARE,
      combinational: combinationalUnderAGatingContract / total >= MIN_COMBINATIONAL_SHARE,
    }).toEqual({
      gatingRow: true,
      asyncRow: true,
      syncNotFreeRow: true,
      refusedRow: true,
      combinational: true,
    });
  });

  it('reads the gate positionally, so an antecedent spelling `!$initstate` is not one', () => {
    // ASYNC contract, so no gate is called for (Req 14.4) - while the antecedent's own text is the
    // gate term. A substring reader passes the iff here for entirely the wrong reason; the positional
    // reader sees one guard, the antecedent's, and no gate.
    const rendered = renderPropertyWrapper(
      NAMED_CASE_INTERFACE,
      ANTECEDENT_SPELLING_THE_GATE_TERM,
      WRAPPER_NAME,
      derivedContract('async', true),
    );
    expect(rendered).toContain(`if (${INITIAL_STATE_TERM}) assert(`);
    expect(gateTermsOf(rendered, 1)).toBeNull();
  });

  it('gates the same property once its contract becomes sync-and-free', () => {
    // The same property and the same design, one field changed: the gate appears, and the
    // antecedent's identical text is still its own guard. This is the pair that shows the iff turns
    // on the CONTRACT and not on the property's text.
    const rendered = renderPropertyWrapper(
      NAMED_CASE_INTERFACE,
      ANTECEDENT_SPELLING_THE_GATE_TERM,
      WRAPPER_NAME,
      derivedContract('sync', true),
    );
    expect(rendered).toContain(
      `if (${INITIAL_STATE_TERM}) if (${INITIAL_STATE_TERM}) assert(out <= 11);`,
    );
    expect(gateTermsOf(rendered, 1)).toEqual([INITIAL_STATE_TERM]);
  });

  it('keeps gating once the contract carries an enabling signal', () => {
    // Criterion 4.16 of `formal-gate-first-light` widens the reset assume with the signal an
    // enable-gated reset fires under (`design.md`, Component 20). The gate answers a different
    // question - the reset's KIND and the initial state - and a synchronous reset still takes effect
    // at step 1 however it is enabled, so the row stays the gating one and the term still goes out.
    const rendered = renderPropertyWrapper(
      NAMED_CASE_INTERFACE,
      ANTECEDENT_SPELLING_THE_GATE_TERM,
      WRAPPER_NAME,
      { ...derivedContract('sync', true), resetEnable: { name: 'en', activeLow: false } },
    );
    expect(gateTermsOf(rendered, 1)).toEqual([INITIAL_STATE_TERM]);
  });
});
