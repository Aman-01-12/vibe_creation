// formal-property-oracle, Property 16: A cover is emitted for exactly the property's own
// antecedent (task 3.5).
//
// WHY THIS IS THE HIGHEST-STAKES PROPERTY IN GROUP 3
//   THE COVER IS THE VACUITY DETECTOR. If the emitted cover's expression is a PARAPHRASE of the
//   antecedent rather than the antecedent itself, the detector reports on a different proposition
//   than the one the assertion is guarded by - and then a vacuous proof passes the very detector
//   that exists to catch it. The measured case: `multi_booth_8bit`'s `rdy` is first reachable at
//   step 19, so a CORRECT product property reported `Status: PASSED` at every depth at or below 19
//   WITHOUT EVER BEING EVALUATED, and only a cover on its own antecedent flagged it
//   (`chipAgent/_inbox/verification-recipe-yosys-z3-formal-property-oracle-feasibility.md`).
//   So "token for token" (Req 5.9) is a correctness condition, not a style note, and it is asserted
//   here at its strongest available strength.
//
// THE CLAIM, IN SIX PARTS
//   1. EXACTLY ONE COVER for a clocked property carrying an antecedent - not zero, not two. Zero
//      would leave the Cover_Check with nothing to run (Req 5.1, 5.2); two would leave the
//      Formal_Oracle reading one cover's result while the other decided nothing.
//   2. THE COVER'S ARGUMENT IS THE ANTECEDENT, BYTE-IDENTICALLY. `===` on the string. Not
//      `contains`, not "equal after normalization", not "equal after trim" (Req 5.1, 5.9).
//   3. THE COVER'S ARGUMENT IS BYTE-IDENTICAL TO THE ASSERT STATEMENT'S OWN GUARD. This is the part
//      that catches a renderer which reads `property.antecedent` twice and transforms one of the
//      reads: parts 2 and 3 together say the two spliced texts cannot drift independently, which is
//      exactly Req 5.9's "the evaluated antecedent is the asserted property's own antecedent".
//   4. THE COVER IS ON THE SAME CLOCK EDGE AS THE ASSERT. The edge is paren-matched out of BOTH
//      statements and the two are compared with `===`, so a cover sampled on a different clock -
//      which would evaluate the antecedent on a schedule the assertion never runs on - fails here.
//   5. NO ANTECEDENT MEANS NO COVER AND NO ANTECEDENT GUARD. A clocked property with
//      `antecedent === null` emits no `cover(` anywhere in the wrapper (Req 5.10): such a property
//      cannot be vacuous through an unreached antecedent because it has none, and a cover on a
//      constant would be a second thing that can go wrong - an unreached cover on a property that
//      WAS in fact evaluated.
//   6. A COMBINATIONAL PROPERTY EMITS NO COVER AT ALL. It carries neither a clock nor an antecedent,
//      so there is nothing to cover and no edge to cover it on (Req 5.10).
//   7. THE COVER CARRIES THE SAME GATE TERMS AS THE ASSERTION, byte-identically, ADDED by task 16.6
//      as the clause of Property 16 task 3.5 could not carry - the gate terms did not exist then.
//      The gate exists because on a sync-reset free-initial-state design the step-0 sample is a
//      free-variable artifact of the model, and a cover reached THROUGH that artifact is precisely
//      the measured `Reached cover statement in step 1` defect the reset assume was added to close -
//      which the assume alone does NOT close for a sync reset, because `async2sync` cannot pin
//      step 0 there.
//
// RE-PINNED, deliberately, and the re-pin is the expected work of task 16.5 rather than scope creep.
//   THE OLD FORM WAS: exactly one `if (` in the whole wrapper, and its argument is the cover's
//   argument. That is FALSE by construction once a gate is emitted, because a gated clocked property
//   with an antecedent carries TWO `if (`s on its assert line - `if (<gate>) if (<antecedent>)` - and
//   one on its cover line. The old form is therefore REPLACED by a per-LINE reading: each statement
//   line is split into its leading gate guard and its trailing antecedent guard, the antecedent
//   guard is compared to the cover's argument (part 3, unchanged in strength), and the gate guards
//   are compared to each other (part 7, new). Nothing is weakened: the old single-guard assertion
//   said one text was the antecedent, and the new one says which of two guards is the antecedent AND
//   that the other is shared with the cover.
//
//   The renderer's fourth parameter is also new, so this test now generates a `ResetContract` as
//   well. That STRENGTHENS the sample rather than accommodating it: every claim above is now
//   asserted across the gated case, the three ungated derived cases, and the refused contract, where
//   before there was only one wrapper shape to assert them over.
//
// WHY THE ARGUMENT IS PAREN-MATCHED AND NOT REGEXED OUT
//   An antecedent legitimately contains parentheses - `$past(a)`, `$rose(en)`, `$countones(data)` are
//   all inside the accepted dialect - so `/cover\(([^)]*)\)/` would capture `$past(a` and then this
//   test would "pass" on a truncation. The extraction below walks the parens the way task 3.3's
//   `assertPropertyArguments` does, and the non-vacuity block asserts at least one generated
//   antecedent actually CONTAINS a paren, because paren-matching over paren-free text proves nothing
//   about the matcher.
//
// WHY A SUBSTRING SEARCH FOR `cover(` IS SOUND HERE
//   Three of the four prefixes this test searches for cannot appear inside a `ValidatedExpression` by
//   CONSTRUCTION: `if`, `assert`, and `always` are all members of the validator's `RESERVED_WORDS`,
//   and `@` is a row of `MEASURED_REJECTED_FORMS`. `cover` is a reserved word too, but only as a
//   whole token - a longer identifier such as `coverage` would tokenize fine - so that one gap is
//   closed by an asserted PRECONDITION on every generated case rather than by assumption. If the
//   generator's name pool ever grows a name containing `cover`, this test fails on the precondition
//   and says so, instead of silently miscounting.
//
// NON-VACUITY
//   Every claim above holds trivially over a sample that never produces the shape it is about, and
//   this repository has already shipped a property test that silently stopped exercising a new union
//   member (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
//   So the counted shares are asserted: clocked-with-antecedent, clocked-without-antecedent, and
//   combinational each clear `MIN_SHAPE_SHARE`, and at least one generated antecedent carries a
//   parenthesis.
//
//   RUN COUNT: 500, not the shared 100. The three shapes each land near a third of the sample, so
//   they are safe at 100. The paren-carrying antecedent is not: a depth-2 dialect expression carries
//   a paren only through one of the formal-function arms, which works out to roughly 33% of
//   antecedents, and an antecedent is present in only about a third of cases - so about 11% of runs.
//   At 100 runs the miss probability is ~1e-5, which is a flake rather than a claim; at 500 it is
//   ~1e-25. The recipe is the one the vault records for a per-shape coverage claim: compute the
//   rarest required shape's share and raise `numRuns` until `(1 - p)^numRuns` is negligible, rather
//   than weakening the claim to fit the default
//   (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//   The whole property is pure string work, so 500 runs costs a fraction of a second.
//
// The tag string is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to
// a different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 5.1, 5.2, 5.5, 5.6, 5.9, 5.10, 5.14

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import { renderPropertyWrapper, type FormalProperty, type ResetContract } from '@app/tools';

import { arbDesignInterface, arbFormalProperty, arbResetContract } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  "formal-property-oracle, Property 16: A cover is emitted for exactly the property's own antecedent";

/** The wrapper name is caller-owned and no model output reaches it; one fixed value suffices. */
const WRAPPER_NAME = 'formal_property_wrapper';

/** See the RUN COUNT note in the header: the paren-carrying antecedent is ~11% of cases. */
const NUM_RUNS = 500;

/** The minimum share of generated cases each of the three property shapes must reach. */
const MIN_SHAPE_SHARE = 0.1;

/** The Cover_Check's statement prefix. Its `(` is the last character, which `parenCalls` relies on. */
const COVER_PREFIX = 'cover(';

/** The guarded immediate assertion's prefix (Req 6.1's accepted clocked form). */
const ASSERT_PREFIX = 'assert(';

/** The guard whose expression must be the cover's expression, token for token. */
const GUARD_PREFIX = 'if (';

/** The clocking event both statements must share. */
const EDGE_PREFIX = '@(';

/** A paren-matched call found in rendered source: where its prefix started, and its argument text. */
interface ParenCall {
  readonly offset: number;
  readonly argument: string;
}

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
 * Every occurrence of `prefix` in `source`, with its paren-matched argument text.
 *
 * `prefix` must END in `(`, which is where the matching starts. Paren-matched rather than regexed,
 * because an antecedent legitimately contains parens and a `[^)]*` capture would silently truncate
 * `$past(a)` to `$past(a`.
 *
 * The scan resumes at `offset + 1` rather than past the matched close paren, so an occurrence nested
 * inside another's argument is COUNTED rather than skipped. For well-formed output the two are
 * identical; the strict version is the one that can fail, which is the direction this test wants.
 */
function parenCalls(source: string, prefix: string): readonly ParenCall[] {
  const openOffsetInPrefix = prefix.length - 1;
  const calls: ParenCall[] = [];
  let found = source.indexOf(prefix);
  while (found !== -1) {
    const open = found + openOffsetInPrefix;
    const close = matchingCloseParen(source, open);
    expect({ prefix, offset: found, closes: close > open }).toEqual({
      prefix,
      offset: found,
      closes: true,
    });
    calls.push({ offset: found, argument: source.slice(open + 1, close) });
    found = source.indexOf(prefix, found + 1);
  }
  return calls;
}

/** The single line of `source` carrying `prefix`, failing the case when it is not exactly one. */
function soleLineCarrying(source: string, prefix: string): string {
  const lines = source.split('\n').filter((line) => line.includes(prefix));
  expect({ prefix, lines }).toEqual({ prefix, lines: [lines[0] ?? '<none>'] });
  return lines[0] as string;
}

/** The clocking event of one statement line, as its own paren-matched text (`posedge clk`). */
function clockEdgeOf(line: string): string {
  const edges = parenCalls(line, EDGE_PREFIX);
  expect({ line, edgeCount: edges.length }).toEqual({ line, edgeCount: 1 });
  return (edges[0] as ParenCall).argument;
}

/** Every expression the property carries, so the search precondition can be checked over them all. */
function expressionsOf(property: FormalProperty): readonly string[] {
  if (property.kind === 'combinational') {
    return [property.consequent];
  }
  return [
    property.clock,
    property.consequent,
    ...(property.antecedent === null ? [] : [property.antecedent]),
  ];
}

/**
 * Assert no generated expression contains `cover`, which is what makes the substring search sound.
 *
 * `if`, `assert`, `always`, and `@` cannot appear in a `ValidatedExpression` at all - the first three
 * are `RESERVED_WORDS` and `@` is a measured rejected form - but `cover` is reserved only as a whole
 * TOKEN, so an identifier like `coverage` would tokenize fine. This closes that one gap by checking
 * it per case instead of assuming it.
 */
function expectNoExpressionMentionsCover(property: FormalProperty): void {
  for (const expression of expressionsOf(property)) {
    expect({ expression, mentionsCover: expression.includes('cover') }).toEqual({
      expression,
      mentionsCover: false,
    });
  }
}

/**
 * One statement line split into the guards it carries, outermost first.
 *
 * A gated clocked property renders `always @(posedge clk) if (<gate>) if (<antecedent>) assert(...)`,
 * so the ASSERT line carries two guards and the COVER line carries one. Reading them positionally
 * out of the line is what lets part 3 compare the ANTECEDENT guards and part 7 the GATE guards,
 * without either claim being able to read the other's text by accident.
 */
function guardsOf(line: string): readonly string[] {
  return parenCalls(line, GUARD_PREFIX).map((call) => call.argument);
}

/**
 * The gate terms one statement line carries, or `null` where it carries none.
 *
 * The gate is the line's guard chain minus its LAST guard when that last guard is the antecedent -
 * which is what `expectedTrailingGuards` tells this function, because only the caller knows whether
 * this property has an antecedent at all. Returning `null` rather than `''` keeps "no gate" and "a
 * gate whose text is empty" distinguishable; the renderer emits no empty gate, and a version that
 * did would fail here rather than compare equal to another empty one.
 */
function gateTermsOf(line: string, expectedTrailingGuards: number): string | null {
  const guards = guardsOf(line);
  const gates = guards.slice(0, Math.max(0, guards.length - expectedTrailingGuards));
  // At most ONE gate guard per statement: the two gate TERMS are `&&`-joined inside a single `if`,
  // never nested, so the cover can carry the identical text.
  expect({ line, gateGuards: gates.length <= 1 }).toEqual({ line, gateGuards: true });
  return gates.length === 0 ? null : (gates[0] as string);
}

/** Parts 1 to 4 and 7: the cover exists once, is the antecedent, and shares the edge and the gate. */
function expectCoverIsTheAntecedent(rendered: string, antecedent: string): void {
  // Part 1. Exactly one cover - not zero, which leaves the Cover_Check nothing to run, and not two,
  // which leaves one cover's result unread (Req 5.1, 5.2).
  const covers = parenCalls(rendered, COVER_PREFIX);
  expect({ coverCount: covers.length, rendered }).toEqual({ coverCount: 1, rendered });
  const coverArgument = (covers[0] as ParenCall).argument;

  // Part 2. BYTE-IDENTICAL to the property's own antecedent. `===` on the string, so a wrap, a trim,
  // a re-space, or any other paraphrase fails here (Req 5.1, 5.9).
  expect({ coverArgument, identicalToAntecedent: coverArgument === antecedent }).toEqual({
    coverArgument: antecedent,
    identicalToAntecedent: true,
  });

  const coverLine = soleLineCarrying(rendered, COVER_PREFIX);
  const assertLine = soleLineCarrying(rendered, ASSERT_PREFIX);

  // Part 3. BYTE-IDENTICAL to the ASSERT statement's own ANTECEDENT guard, read out of the rendered
  // source rather than off the property, so the two splices cannot drift independently (Req 5.9).
  // The antecedent guard is the LAST guard on the assert line, because a gate wraps it rather than
  // the other way round - which is also why the cover's own guard chain is exactly one long.
  const assertGuards = guardsOf(assertLine);
  expect({ assertLine, guards: assertGuards.length >= 1 }).toEqual({ assertLine, guards: true });
  const antecedentGuard = assertGuards[assertGuards.length - 1] as string;
  expect({ coverArgument, identicalToGuard: coverArgument === antecedentGuard }).toEqual({
    coverArgument: antecedentGuard,
    identicalToGuard: true,
  });

  // Part 4. Same clock edge, so the antecedent is evaluated on the schedule the assertion runs on.
  expect({ coverEdge: clockEdgeOf(coverLine), assertEdge: clockEdgeOf(assertLine) }).toEqual({
    coverEdge: clockEdgeOf(assertLine),
    assertEdge: clockEdgeOf(assertLine),
  });

  // Part 7 (task 16.6). The COVER carries the SAME gate terms as the ASSERTION, byte-identically,
  // including the case where both carry none. The assert line's trailing guard is its antecedent and
  // the cover line has no trailing guard of its own, which is what makes the two comparable.
  const assertGate = gateTermsOf(assertLine, 1);
  const coverGate = gateTermsOf(coverLine, 0);
  expect({ coverGate, identicalToAssertGate: coverGate === assertGate }).toEqual({
    coverGate: assertGate,
    identicalToAssertGate: true,
  });
}

/** The wrapper-local warm-up counter's name, spelled independently of the renderer's constant. */
const WARM_UP_COUNTER_NAME = '__formal_warmup_age';

/**
 * A Warm_Up_Gate term of any depth. NON-GLOBAL, so `test` reads and writes no `lastIndex`.
 *
 * The DEPTH is deliberately a `\d+` here and not a number this suite derives. Property 33 (task
 * 16.12) owns "the depth is the property's OWN largest `$past` depth and never a fixed constant",
 * and re-deriving it here would be a second owner of that rule inside a test whose subject is the
 * cover. What this suite needs, and what it asserts, is that the term is PRESENT exactly when the
 * property reaches backward at all, and that the cover carries the assertion's term byte for byte.
 */
const WARM_UP_TERM_PATTERN = new RegExp(`^${WARM_UP_COUNTER_NAME} >= \\d+$`);

/**
 * The gate terms this case must carry, as a list of MATCHERS, derived independently of the renderer.
 *
 * Independent rather than imported, by this suite's own rule: a pin written in terms of the thing it
 * pins asserts only that the thing equals itself. This replaces the old "exactly one `if (` and it is
 * the antecedent" claim and is strictly stronger - the old form could say nothing at all about a
 * second guard, where this names which terms must be there, in which order, and nothing else.
 */
function expectedGateTerms(
  property: FormalProperty,
  reset: ResetContract,
): readonly (string | RegExp)[] {
  const terms: (string | RegExp)[] = [];
  if (reset.derived && reset.resetKind === 'sync' && reset.initialStateFree) {
    terms.push('!$initstate');
  }
  if (property.kind === 'clocked' && expressionsOf(property).some((t) => t.includes('$past'))) {
    terms.push(WARM_UP_TERM_PATTERN);
  }
  return terms;
}

/** Assert one statement line's gate is exactly `expected`, term for term and in order. */
function expectGateTerms(
  line: string,
  trailingGuards: number,
  expected: readonly (string | RegExp)[],
): string | null {
  const gate = gateTermsOf(line, trailingGuards);
  const terms = gate === null ? [] : gate.split(' && ');
  expect({ line, termCount: terms.length }).toEqual({ line, termCount: expected.length });
  expected.forEach((matcher, index) => {
    const term = terms[index] as string;
    const matches = typeof matcher === 'string' ? term === matcher : matcher.test(term);
    expect({ line, index, term, matches }).toEqual({ line, index, term, matches: true });
  });
  return gate;
}

/**
 * Part 5: a clocked property with no antecedent carries no cover, and no guard but the gate.
 *
 * "No `if (` anywhere" is no longer true of this shape - such a property still carries the assertion
 * GATE where the contract calls for one - so the claim is re-pinned to the exact gate TERMS
 * `expectedGateTerms` derives, which also rules out an antecedent-shaped guard appearing where there
 * is no antecedent to put in one.
 */
function expectNoCoverAndOnlyTheGate(
  rendered: string,
  expected: readonly (string | RegExp)[],
): void {
  expect(parenCalls(rendered, COVER_PREFIX)).toEqual([]);
  const assertLines = rendered.split('\n').filter((line) => line.includes(ASSERT_PREFIX));
  expect({ assertLines: assertLines.length }).toEqual({ assertLines: 1 });
  expectGateTerms(assertLines[0] as string, 0, expected);
}

/**
 * Part 6: a combinational property emits no cover and no guard of any kind.
 *
 * The ORIGINAL claim, kept exactly: the combinational shape is a module-level
 * `assert property (<consequent>);` with no clocking event, so there is no statement context for an
 * `if` and the gate does not reach it. That residual - a combinational property over a sync-reset
 * free-initial-state design still evaluating the free step-0 sample - is recorded at `gateCondition`
 * in the renderer rather than silently absorbed here.
 */
function expectNoCoverAndNoGuard(rendered: string): void {
  expect(parenCalls(rendered, COVER_PREFIX)).toEqual([]);
  expect(parenCalls(rendered, GUARD_PREFIX)).toEqual([]);
}

describe(PROPERTY, () => {
  it("emits one cover, on the assert's own guard expression, and none without an antecedent", () => {
    let total = 0;
    let clockedWithAntecedent = 0;
    let clockedWithoutAntecedent = 0;
    let combinational = 0;
    let antecedentCarryingAParen = 0;

    let gated = 0;

    fc.assert(
      fc.property(
        arbDesignInterface(),
        arbFormalProperty(),
        arbResetContract(),
        (designInterface: ModuleInterface, property: FormalProperty, reset: ResetContract) => {
          total += 1;
          expectNoExpressionMentionsCover(property);

          const rendered = renderPropertyWrapper(designInterface, property, WRAPPER_NAME, reset);
          const expectedTerms = expectedGateTerms(property, reset);
          if (expectedTerms.length > 0) {
            gated += 1;
          }

          if (property.kind === 'combinational') {
            // Part 6. No clock and no antecedent, so nothing to cover and no edge to cover it on.
            expectNoCoverAndNoGuard(rendered);
            combinational += 1;
            return;
          }

          const { antecedent } = property;
          if (antecedent === null) {
            // Part 5. Req 5.10: a property with no antecedent cannot be vacuous through an
            // unreached one, so no cover is emitted - and its assert carries only the gate.
            expectNoCoverAndOnlyTheGate(rendered, expectedTerms);
            clockedWithoutAntecedent += 1;
            return;
          }

          expectCoverIsTheAntecedent(rendered, antecedent);
          // Part 7's other half: the shared gate carries the terms this suite DERIVED, not merely a
          // text both lines happen to agree on. Comparing them to each other alone would pass for a
          // renderer that emitted the same WRONG gate twice.
          expectGateTerms(soleLineCarrying(rendered, ASSERT_PREFIX), 1, expectedTerms);
          clockedWithAntecedent += 1;
          if (antecedent.includes('(')) {
            antecedentCarryingAParen += 1;
          }
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // Non-vacuity. Each claim above holds trivially over a sample that lacks the shape it is about,
    // so the sample is asserted to contain every shape rather than assumed to.
    expect(total).toBe(NUM_RUNS);
    expect(clockedWithAntecedent / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    expect(clockedWithoutAntecedent / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    expect(combinational / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    // Without this the paren-matched extraction ran only over paren-free antecedents, which proves
    // nothing about the matcher and would let a `[^)]*`-style truncation pass.
    expect(antecedentCarryingAParen).toBeGreaterThan(0);
    // Part 7 is VACUOUS over a sample in which no case is gated: `null === null` holds for a renderer
    // that emits no gate at all. `arbResetContract` puts the sync-and-free row at ~20% and a clocked
    // property at ~2/3, so the gated share is comfortably non-empty - and asserted rather than
    // assumed, which is the same hole a widened union left open in this repository once.
    expect(gated / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
  });
});
