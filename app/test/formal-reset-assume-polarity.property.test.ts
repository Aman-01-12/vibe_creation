// formal-property-oracle, Property 35: the assume's reset term (task 16.10).
//
// WHY THIS FILE EXISTS, MEASURED RATHER THAN ARGUED
//   Task 16.5 mutation-tested its own work against the three re-pinned renderer property tests
//   (`formal-render-dialect`, `formal-cover-derivation`, `formal-wrapper-content`). Three of four
//   mutations were caught. INVERTING THE RESET TERM was caught by NOTHING - all three passed
//   (`chipAgent/_inbox/gotcha-an-inverted-reset-assume-is-caught-by-nothing-until-property-35-lands.md`).
//   Every one of those tests asserts that the assume is EMITTED and none reads its TERM, and a
//   token-provenance test structurally CANNOT see it: `!` is an allowed skeleton token either way and
//   the reset NAME is an allowed interface token either way, so moving the `!` changes no token's
//   membership in any allowed source. That is why design.md makes this its own property rather than a
//   clause of Property 31, and why the hole stayed open between 16.5 landing and this file.
//
//   The failure is not loud. MEASURED on a constructed active-LOW async counter, full
//   Lowering_Sequence then `yosys-smtbmc -s z3 -t 20`:
//
//     | emitted assume                                  | base       | induction |
//     |-------------------------------------------------|------------|-----------|
//     | `assume property (!$initstate || !rst_n)` (correct) | PASSED  | PASSED    |
//     | `assume property (!$initstate || rst_n)` (inverted) | FAILED  | PASSED    |
//
//   A FAILING base case over a PASSING induction check is byte-for-byte the `bad_init` false-proof
//   signature, so an inverted term does not surface as an instrument fault - it reaches the student
//   as a REFUTATION of their own correct design. That is the worst outcome the renderer can produce,
//   and until this file it was unpinned by vitest.
//
// THE INVARIANT THIS ASSERTS, AND WHY THE TWO WORDINGS AGREE
//   THE ASSUMED CONDITION IS THE RESET **ASSERTED**. So the `!` is present exactly when the reset is
//   active LOW, and the emitted term is the bare net for an active-HIGH one. Req 14.2 words the same
//   rule as "inverted where the derived polarity is active-high", which is relative to the
//   `!$initstate || !<reset>` TEMPLATE the pattern note records the measurement against
//   (`chipAgent/_inbox/pattern-formal-wrapper-reset-assume-repairs-base-case-and-vacuity.md`). Both
//   readings name the same emitted text; "asserted" is the invariant that decides which, so that is
//   what claim 2 below evaluates rather than which spelling the template started from.
//
// THE FOUR CLAIMS
//   1. SHAPE. A derived contract emits exactly ONE unclocked `assume property`, and its argument is a
//      two-disjunct implication whose guard is `!$initstate` (Req 14.1). The guard is part of the
//      claim rather than scenery: an assume without it constrains the reset in EVERY step, which
//      pins the design in reset forever and proves anything.
//   2. MEANING, by truth table, which is the clause that cannot be satisfied by a spelling. The
//      emitted term is EVALUATED at both values of the reset net, and the value that SATISFIES it
//      must be the value at which the reset is ASSERTED - low for an active-low reset, high for an
//      active-high one (Req 14.2). An inverted term admits the net at the released value, which is
//      the measured false refutation above.
//   3. IDENTITY. The term names the DERIVED reset net and nothing else, so an assume over some other
//      signal - or over a name the contract did not carry - fails here.
//   4. ABSENCE. A REFUSED contract emits no `assume property` at all (Req 14.1 scopes the emission to
//      "every candidate design whose Reset_Contract was derived"), so a refusal cannot arrive as a
//      constraint over a net the pre-pass never resolved.
//
//   Plus the two concrete cases task 16.10 asks for, one per polarity, pinned to the exact emitted
//   line the oracle was run against. Those are the only byte-exact expectations in the file: a named
//   single case is where a golden line belongs, and the generated claims above are written over the
//   term's STRUCTURE precisely so they are not a second copy of the renderer's own conditional.
//
// THE WIDENED LINE IS A THIRD NAMED CASE, NOT A FIFTH GENERATED CLAIM
//   Where the contract carries an enabling signal, the assumed term is the reset AND that enable,
//   each at its own asserted level (criterion 4.16 of `formal-gate-first-light`; see its
//   `design.md`, Component 20). The four claims above do not reach that shape and are not widened to
//   it: `arbResetContract()` derives no enable, and claims 1b and 3 read the second disjunct as a
//   possibly-inverted reference to ONE net, which is the right reading of the unenabled line this
//   file was written for. So the widened shape is pinned as a named pair of renders instead - the
//   mixed row is the one that makes it falsifiable - and the deciding evidence for the widening
//   itself is the enable-gated boundary pair in `formal-warm-up-boundary.integration.test.ts`.
//
// WHAT IS DELIBERATELY NOT ASSERTED HERE
//   Whether the assume is UNCLOCKED in the sense of sitting outside an `always` block, and whether it
//   sits among only the allowed statements, belong to Property 12's body claim (claim E of
//   `formal-wrapper-content`), which counts the wrapper's statements exactly. This file reads the
//   assume's ARGUMENT. Nothing here re-derives the gate, the cover, or the warm-up counter; Properties
//   31, 16, and 33 own those.
//
// NON-VACUITY AND THE RUN COUNT
//   Three shapes are required and each is counted: a derived ACTIVE-LOW contract, a derived
//   ACTIVE-HIGH contract, and a REFUSED one. `arbResetContract()` derives on 4 of 5 draws and then
//   flips a fair coin for the polarity, so active-low and active-high are each ~40% and refused is
//   ~20%; the rarest REQUIRED shape is therefore the refused contract at 20%. `(1 - 0.2)^100` is
//   ~2.0e-10 and `(1 - 0.2)^200` is ~4.1e-20, so 100 runs would already carry the claim and 200 is
//   taken because the whole property is pure string work and the margin costs nothing measurable. A
//   fourth counted shape guards claim 3 from being asserted over one constant name: at least two
//   DISTINCT reset names must appear among the derived cases, and each of the generator's four names
//   is 0.8 / 4 = 20% of draws.
//
// The tag is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to a
// different spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 14.2**

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

// **Feature: formal-property-oracle, Property 35: The assume's reset term is inverted exactly for a
// derived active-high polarity**
const PROPERTY =
  "formal-property-oracle, Property 35: The assume's reset term is inverted exactly for a derived active-high polarity";

/** The wrapper name is caller-owned and no model output reaches it; one fixed value suffices. */
const WRAPPER_NAME = 'formal_property_wrapper';

/** See the RUN COUNT note in the header: the rarest required shape is the refused contract at 20%. */
const NUM_RUNS = 200;

/** The unclocked assume's prefix. Its `(` is the last character, which the paren match starts from. */
const ASSUME_PREFIX = 'assume property (';

/** The guard disjunct that confines the assume to the initial state. */
const INITIAL_STATE_GUARD = '!$initstate';

/** The disjunction the implication `!a || b` is written with, because there is no other form. */
const DISJUNCTION = '||';

/** How many distinct reset names the derived sample must carry, so claim 3 is not over a constant. */
const MIN_DISTINCT_RESET_NAMES = 2;

/** The minimum share of generated cases each required shape must reach. */
const MIN_SHAPE_SHARE = 0.1;

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

/**
 * Every `assume property (...)` argument in `rendered`, paren-matched.
 *
 * Paren-matched rather than regexed for the reason the cover test records: a reset name cannot carry
 * a paren, but `$initstate` sits inside the same argument and a `[^)]*` capture would be one
 * truncation away from "passing" on text it never read to the end of.
 */
function assumeArguments(rendered: string): readonly string[] {
  const openOffsetInPrefix = ASSUME_PREFIX.length - 1;
  const arguments_: string[] = [];
  let found = rendered.indexOf(ASSUME_PREFIX);
  while (found !== -1) {
    const open = found + openOffsetInPrefix;
    const close = matchingCloseParen(rendered, open);
    expect({ offset: found, closes: close > open }).toEqual({ offset: found, closes: true });
    arguments_.push(rendered.slice(open + 1, close));
    found = rendered.indexOf(ASSUME_PREFIX, found + 1);
  }
  return arguments_;
}

/**
 * The value of a term that is a reset net under any number of leading `!`s, at a given net value.
 *
 * A GENERAL reader rather than a two-branch copy of the renderer's own conditional: it counts the
 * inversions and reads the identifier, so `!!rst` - which means the net HIGH and would be a silent
 * double negation - reads as what it actually says instead of matching a hardcoded `!rst`. `null`
 * means the term is not a (possibly inverted) reference to `net` at all, which claim 3 rejects.
 */
function evaluateResetTerm(term: string, net: string, netIsHigh: boolean): boolean | null {
  let inversions = 0;
  let rest = term.trim();
  while (rest.startsWith('!')) {
    inversions += 1;
    rest = rest.slice(1).trim();
  }
  if (rest !== net) {
    return null;
  }
  return inversions % 2 === 0 ? netIsHigh : !netIsHigh;
}

/** The disjuncts of the assume's implication, trimmed, in emitted order. */
function disjunctsOf(argument: string): readonly string[] {
  return argument.split(DISJUNCTION).map((term) => term.trim());
}

/**
 * Claims 1 to 3 over one rendered wrapper carrying a DERIVED contract.
 *
 * The three are asserted together because they are one reading of one term: the shape says where the
 * term is, the identity says which net it names, and the meaning says which value of that net the
 * assume admits. Splitting them over three renders would assert the same extraction three times.
 */
function expectAssumedConditionIsTheResetAsserted(
  rendered: string,
  reset: Extract<ResetContract, { readonly derived: true }>,
): void {
  // Claim 1a. Exactly one assume. Two would constrain the reset twice and leave which one decided
  // the base case unreadable; zero is Req 14.1's emission missing outright.
  const arguments_ = assumeArguments(rendered);
  expect({ assumes: arguments_.length }).toEqual({ assumes: 1 });

  // Claim 1b. Two disjuncts, and the guard is `!$initstate`. An assume that is NOT guarded holds in
  // every step, which pins the design in reset for the whole run - a vacuous proof, not a repair.
  const disjuncts = disjunctsOf(arguments_[0] as string);
  expect({ disjuncts }).toEqual({ disjuncts: [INITIAL_STATE_GUARD, disjuncts[1] ?? '<missing>'] });

  const term = disjuncts[1] as string;

  // Claim 3. The term names the DERIVED net, under some number of inversions, and nothing else.
  const namesTheDerivedNet = evaluateResetTerm(term, reset.resetName, true) !== null;
  expect({ term, namesTheDerivedNet }).toEqual({ term, namesTheDerivedNet: true });

  // Claim 2. THE MEANING, by truth table. The assume is satisfied at exactly the net value at which
  // the reset is ASSERTED: low for an active-low reset, high for an active-high one. This is the
  // clause the measured inversion fails - an inverted term admits the RELEASED value, so the base
  // case starts outside reset and reports FAILED over a PASSING induction check.
  expect({
    term,
    satisfiedWithNetHigh: evaluateResetTerm(term, reset.resetName, true),
    satisfiedWithNetLow: evaluateResetTerm(term, reset.resetName, false),
  }).toEqual({
    term,
    satisfiedWithNetHigh: !reset.resetActiveLow,
    satisfiedWithNetLow: reset.resetActiveLow,
  });
}

/** A concrete derived contract, so the two named cases read as the contracts they are. */
function derivedContract(
  resetName: string,
  resetActiveLow: boolean,
  resetKind: 'async' | 'sync',
): ResetContract {
  return { derived: true, resetName, resetActiveLow, resetKind, initialStateFree: false };
}

/**
 * A derived contract whose reset fires only while an enabling signal is asserted (criterion 4.16
 * of `formal-gate-first-light`; see its `design.md`, Component 20).
 */
function enableGatedContract(
  resetName: string,
  resetActiveLow: boolean,
  enableName: string,
  enableActiveLow: boolean,
): ResetContract {
  return {
    derived: true,
    resetName,
    resetActiveLow,
    resetKind: 'sync',
    initialStateFree: true,
    resetEnable: { name: enableName, activeLow: enableActiveLow },
  };
}

/**
 * The design the enable-gated cases are rendered over, with the enable as a real input port.
 *
 * The assume names the enable, so the wrapper has to declare it: an undeclared net is one Yosys
 * declares implicitly and only WARNS about, which is this file's own worst outcome one layer over.
 */
const ENABLE_GATED_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'LIFObuffer',
  ports: [
    { name: 'EN', direction: 'input', width: 1 },
    { name: 'en_n', direction: 'input', width: 1 },
    { name: 'out', direction: 'output', width: 4 },
  ],
  clocking: { clockName: 'clk', resetName: 'Rst', resetActiveLow: true },
};

/**
 * Put a fixture expression through the sole constructor of the brand, or fail loudly.
 *
 * A refusal here is a defect in this fixture rather than in the code under test, so it throws with
 * the text instead of being absorbed - the same discipline `formal-arbitraries`' own generator uses.
 */
function validatedOrThrow(text: string): ValidatedExpression {
  const result = validateExpression(text);
  if (!result.ok) {
    throw new Error(`fixture expression is outside the accepted dialect: ${text}`);
  }
  return result.value;
}

/**
 * The design one named case is rendered over: one clock, the contract's own reset, one output.
 *
 * `clocking.resetActiveLow` is set to the OPPOSITE of the derived polarity in both named cases, and
 * that is load-bearing rather than tidy. It is the SPEC's field, it originates in model-generated
 * text, and nothing in the renderer may read it (Req 14.9, 14.10) - so a renderer that read it
 * instead of the contract emits the inverted term in BOTH cases below and fails both.
 */
function namedCaseInterface(resetName: string, derivedActiveLow: boolean): ModuleInterface {
  return {
    validityOutputName: null,
    moduleName: 'counter_12',
    ports: [{ name: 'out', direction: 'output', width: 4 }],
    clocking: { clockName: 'clk', resetName, resetActiveLow: !derivedActiveLow },
  };
}

/** An unconditional clocked property, so the rendered wrapper carries one assert and no cover. */
const NAMED_CASE_PROPERTY: FormalProperty = {
  kind: 'clocked',
  id: 'p1',
  criterionRef: 'ac-1',
  clock: validatedOrThrow('clk'),
  antecedent: null,
  consequent: validatedOrThrow('out <= 11'),
};

describe(PROPERTY, () => {
  it('assumes the reset ASSERTED, so the `!` is present exactly for an active-low net', () => {
    let total = 0;
    let derivedActiveLow = 0;
    let derivedActiveHigh = 0;
    let refused = 0;
    const derivedNames = new Set<string>();

    fc.assert(
      fc.property(
        arbDesignInterface(),
        arbFormalProperty(),
        arbResetContract(),
        (designInterface: ModuleInterface, property: FormalProperty, reset: ResetContract) => {
          total += 1;
          const rendered = renderPropertyWrapper(designInterface, property, WRAPPER_NAME, reset);
          if (!reset.derived) {
            refused += 1;
            // Claim 4. No assume at all for a refused contract, so a refusal never arrives as a
            // constraint over a net the pre-pass could not resolve.
            expect(assumeArguments(rendered)).toEqual([]);
            return;
          }
          derivedNames.add(reset.resetName);
          if (reset.resetActiveLow) {
            derivedActiveLow += 1;
          } else {
            derivedActiveHigh += 1;
          }
          expectAssumedConditionIsTheResetAsserted(rendered, reset);
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY. Each claim above holds trivially over a sample that never produces the shape it is
    // about, and this repository has already shipped a property test that silently stopped exercising
    // a union member it was written for
    // (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`). The
    // two polarity shapes are what make the iff falsifiable at all: over a sample carrying one
    // polarity, an inverted renderer passes.
    expect({
      activeLowShare: derivedActiveLow / total >= MIN_SHAPE_SHARE,
      activeHighShare: derivedActiveHigh / total >= MIN_SHAPE_SHARE,
      refusedShare: refused / total >= MIN_SHAPE_SHARE,
      distinctNames: derivedNames.size >= MIN_DISTINCT_RESET_NAMES,
    }).toEqual({
      activeLowShare: true,
      activeHighShare: true,
      refusedShare: true,
      distinctNames: true,
    });
  });

  it('emits the bare net for a concrete ACTIVE-HIGH reset', () => {
    // The oracle-verified form for an active-high reset: the net HIGH is the reset ASSERTED, so no
    // `!`. Byte-exact because this is the named single case - the generated claims above read the
    // term's structure precisely so they are not a second copy of this line.
    const rendered = renderPropertyWrapper(
      namedCaseInterface('rst', false),
      NAMED_CASE_PROPERTY,
      WRAPPER_NAME,
      derivedContract('rst', false, 'sync'),
    );
    expect(rendered).toContain('  assume property (!$initstate || rst);\n');
  });

  it('emits the inverted net for a concrete ACTIVE-LOW reset', () => {
    // MEASURED: this exact line reports base PASSED and induction PASSED on the constructed
    // active-low async counter, where `assume property (!$initstate || rst_n)` reports base FAILED
    // over induction PASSED - the `bad_init` false-proof signature, reaching the student as a
    // refutation of a correct design.
    const rendered = renderPropertyWrapper(
      namedCaseInterface('rst_n', true),
      NAMED_CASE_PROPERTY,
      WRAPPER_NAME,
      derivedContract('rst_n', true, 'async'),
    );
    expect(rendered).toContain('  assume property (!$initstate || !rst_n);\n');
  });

  it('assumes an enabling signal beside the reset, each at its OWN asserted level', () => {
    // Criterion 4.16. A `$sdffce` resets only while its enable is asserted, so the reset alone pins
    // a step the solver may hold un-enabled - MEASURED on `LIFObuffer`, all 7 of whose reset cells
    // are `$sdffce` with a non-constant enable, where `Rst` and `EN` are both asserted HIGH.
    const bothHigh = renderPropertyWrapper(
      ENABLE_GATED_INTERFACE,
      NAMED_CASE_PROPERTY,
      WRAPPER_NAME,
      enableGatedContract('Rst', false, 'EN', false),
    );
    expect(bothHigh).toContain('  assume property (!$initstate || (Rst && EN));\n');

    // The MIXED case is what makes the pair falsifiable: a renderer reading one `activeLow` flag for
    // both signals passes the row above and emits `(Rst && en_n)` here, which assumes the enable
    // RELEASED - the assumed step then never fires, which is the defect 4.16 closes.
    const enableLow = renderPropertyWrapper(
      ENABLE_GATED_INTERFACE,
      NAMED_CASE_PROPERTY,
      WRAPPER_NAME,
      enableGatedContract('Rst', false, 'en_n', true),
    );
    expect(enableLow).toContain('  assume property (!$initstate || (Rst && !en_n));\n');
  });
});
