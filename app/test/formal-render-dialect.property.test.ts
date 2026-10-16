// formal-property-oracle, Property 14: Rendered output is inside the accepted dialect and holds
// no rejected form (task 3.3).
//
// THE PRECISE CLAIM, AND WHY THE OBVIOUS ONE IS FALSE BY CONSTRUCTION
//   "The rendered wrapper contains none of the measured rejected forms" is FALSE and cannot be
//   asserted. Two rows of `MEASURED_REJECTED_FORMS` are load-bearing tokens of the accepted forms
//   themselves: Req 6.1's clocked form IS `always @(posedge clk) ...`, which contains `@`, and
//   Req 6.2's combinational form IS a module-level `assert property (...)`, which contains
//   `property`. Asserting global absence would either fail on every case or have to be weakened
//   into something that no longer says anything.
//
//   So the claim is PER-FORM and PER-POSITION, in four parts:
//
//     1. SPLICING ADDS NOTHING. For every one of the measured forms, the number of occurrences in
//        the rendered wrapper equals the number in the same wrapper rendered with every expression
//        replaced by a dialect-safe sentinel. The sentinel render IS the fixed skeleton plus this
//        interface's own port names, so equality says exactly: substituting the property's real
//        validated expressions introduced ZERO occurrences of any rejected form. That covers all
//        twelve rows uniformly, including the two the skeleton legitimately contains, with no
//        exception list.
//
//     2. THE SKELETON'S OWN FORMS ARE EXACTLY THE ACCEPTED FORM'S. The set of measured forms
//        present in the sentinel render is `{@}` for a clocked property, `{property}` for a
//        combinational one, and `{@, property}` for a clocked property over a DERIVED reset
//        contract, because Req 14.1's unclocked `assume property (...)` is a third legitimate
//        carrier of the `property` keyword. Combined with (1) this is where global absence gets
//        asserted for the other ten rows - derived, not listed - and it is also the assertion a
//        thirteenth measured row would have to pass rather than silently sit outside.
//
//     3. EACH SKELETON FORM APPEARS ONLY IN ITS SKELETON POSITION. Every `@` in the rendered
//        source sits at the `@` of an `always @(posedge ` prefix, and every `property` word sits at
//        the `property` of an `assert property (` or an `assume property (` prefix. A count alone
//        would admit an `@` that had moved somewhere else while another disappeared; the offsets
//        close that.
//
// RE-PINNED, deliberately, and the re-pin is the expected work of tasks 16.5 and 16.6 rather than
// scope creep. THREE claims moved, and none is weakened:
//   - The renderer takes a `ResetContract` fourth argument, so this suite now generates one. Every
//     claim above is asserted across the gated row, the three ungated derived rows, and the refused
//     contract, where before there was a single wrapper shape to assert them over.
//   - `property` had ONE legitimate position and now has TWO, because the unclocked reset assume is
//     `assume property (...)`. Part 3 takes a LIST of prefixes rather than one, so the position claim
//     still holds offset by offset - a `property` anywhere else fails exactly as it did before.
//   - `EXPECTED_SKELETON_FORMS` was a constant keyed by property kind and is now DERIVED per case
//     from the kind and the contract, because which forms the skeleton legitimately contains now
//     depends on which emissions the contract calls for. The two literals it is built from are still
//     the only ones this suite spells out.
//
//     4. NO REJECTED FORM INSIDE AN `assert property (...)` ARGUMENT. The paren-matched argument of
//        every `assert property (` carries NONE of the twelve forms - which is Req 6.2's "carrying
//        no clocking event" stated where it actually bites, since `assert property (@(posedge clk)
//        e)` is the measured `syntax error, unexpected '@'`.
//
//   Two further dialect claims ride along on the same sample: every `$`-prefixed token in the
//   rendered source is one `validateExpression` admits (Req 6.4, read off the validator rather than
//   off a second copy of the accepted-function list), and the assert statement for each kind is the
//   exact form its requirement names (Req 6.1, 6.3 via `assert(...)` with no implication operator;
//   Req 6.2 via the module-level `assert property (...)` with no `always` and no `@` at all).
//
// NON-VACUITY
//   Every claim above is trivially true over a sample that never produces the interesting shape,
//   and this repository has already shipped a property test that silently stopped exercising a new
//   union member (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
//   So the counted shares below are asserted, and the test FAILS if any is empty: both union
//   members, both antecedent arms of the clocked member, at least one render carrying a
//   sampled-value function (or the `$`-claim is asserted over zero tokens), and at least one render
//   carrying an implication written `!a || b` (or the `|->`/`|=>` absence is asserted over a sample
//   that never wanted an implication in the first place).
//
// The tag string is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to
// a different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import {
  MEASURED_REJECTED_FORMS,
  renderPropertyWrapper,
  validateExpression,
  type FormalProperty,
  type MeasuredRejectedForm,
  type ResetContract,
  type ValidatedExpression,
} from '@app/tools';

import { arbDesignInterface, arbFormalProperty, arbResetContract } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-property-oracle, Property 14: Rendered output is inside the accepted dialect and holds no rejected form';

/** The wrapper name is caller-owned and no model output reaches it; one fixed value suffices. */
const WRAPPER_NAME = 'formal_property_wrapper';

/** The `always @(posedge <clock>)` prefix, Req 6.1's accepted clocked form. */
const EDGE_PREFIX = 'always @(posedge ';

/** The module-level `assert property (` prefix, Req 6.2's accepted combinational form. */
const ASSERT_PROPERTY_PREFIX = 'assert property (';

/** The unclocked `assume property (` prefix, Req 14.1's reset assume: `property`'s second position. */
const ASSUME_PROPERTY_PREFIX = 'assume property (';

/**
 * The measured forms the FIXED SKELETON legitimately contains, for one case.
 *
 * The two literals below are the only ones this test spells out, and they are spelled from the
 * POSITIVE requirements rather than from the rejected-forms table: Req 6.1's accepted clocked form
 * contains the clocking event, and both Req 6.2's accepted combinational form and Req 14.1's reset
 * assume contain the `property` keyword. Everything else is derived. A thirteenth measured row that
 * the skeleton happened to contain would fail the equality at the call site rather than pass
 * unnoticed, which is the direction that stays safe.
 *
 * Returned in `MEASURED_REJECTED_FORMS`'s own table order, because `formsPresentIn` reports in that
 * order and the two lists are compared with `toEqual`.
 */
function expectedSkeletonForms(property: FormalProperty, reset: ResetContract): readonly string[] {
  const clocked = property.kind === 'clocked';
  // `assume property (...)` for a derived contract, `assert property (...)` for a rendered
  // combinational property. A refused contract over an unrenderable combinational property carries
  // neither, which is the one case with no `property` keyword anywhere.
  const carriesProperty = reset.derived || (!clocked && rendersCombinationalAssert(property));
  return [...(clocked ? ['@'] : []), ...(carriesProperty ? ['property'] : [])];
}

/** The minimum share of generated cases each of the three property shapes must reach. */
const MIN_SHAPE_SHARE = 0.1;

/**
 * The offsets of every occurrence of `form` in `text`.
 *
 * The global regex is built FRESH on every call from the table's non-global `pattern.source`. The
 * table itself must never carry `/g` and this must never hoist the object to module scope: a shared
 * `/g` regex carries mutable `lastIndex` between callers and has hung this repository's whole vitest
 * suite once (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`). No pattern
 * in the table can match the empty string, so the scan always advances.
 */
function occurrenceOffsets(text: string, form: MeasuredRejectedForm): readonly number[] {
  const scanner = new RegExp(form.pattern.source, 'g');
  return [...text.matchAll(scanner)].map((match) => match.index);
}

/** The construct names of every measured form present at least once in `text`, in table order. */
function formsPresentIn(text: string): readonly string[] {
  return MEASURED_REJECTED_FORMS.filter((form) => occurrenceOffsets(text, form).length > 0).map(
    (form) => form.construct,
  );
}

/** One row of the measured table by name, failing loudly if the table no longer names it. */
function measuredForm(construct: string): MeasuredRejectedForm {
  const form = MEASURED_REJECTED_FORMS.find((candidate) => candidate.construct === construct);
  if (form === undefined) {
    throw new Error(
      `MEASURED_REJECTED_FORMS no longer names \`${construct}\`, so this test's position claim for ` +
        `it no longer checks anything; re-derive the claim against the table as it now stands`,
    );
  }
  return form;
}

/**
 * Assert every occurrence of `form` in `source` sits at `form`'s own offset inside one of `prefixes`.
 *
 * The offset is read from each prefix rather than written as a number, so the two stay in step. A
 * LIST of prefixes rather than one, because `property` now has two legitimate positions - the
 * combinational `assert property (` and the reset assume's `assume property (` - and the claim is
 * still per-offset: an occurrence at neither fails exactly as it did when there was one.
 */
function expectOnlyInsidePrefixes(
  source: string,
  form: MeasuredRejectedForm,
  prefixes: readonly string[],
  firstOccurrenceInPrefix: string,
): void {
  const anchored = prefixes.map((prefix) => {
    const offsetInPrefix = prefix.indexOf(firstOccurrenceInPrefix);
    expect(offsetInPrefix).toBeGreaterThanOrEqual(0);
    return { prefix, offsetInPrefix };
  });
  for (const offset of occurrenceOffsets(source, form)) {
    expect({
      construct: form.construct,
      offset,
      context: source.slice(Math.max(0, offset - 20), offset + 20),
      insidePrefix: anchored.some((candidate) =>
        source.startsWith(candidate.prefix, offset - candidate.offsetInPrefix),
      ),
    }).toEqual({
      construct: form.construct,
      offset,
      context: source.slice(Math.max(0, offset - 20), offset + 20),
      insidePrefix: true,
    });
  }
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

/** The paren-matched argument text of every `assert property (...)` in `source`, in source order. */
function assertPropertyArguments(source: string): readonly string[] {
  const openOffsetInPrefix = ASSERT_PROPERTY_PREFIX.length - 1;
  const arguments_: string[] = [];
  let found = source.indexOf(ASSERT_PROPERTY_PREFIX);
  while (found !== -1) {
    const open = found + openOffsetInPrefix;
    const close = matchingCloseParen(source, open);
    expect(close).toBeGreaterThan(open);
    arguments_.push(source.slice(open + 1, close));
    found = source.indexOf(ASSERT_PROPERTY_PREFIX, close);
  }
  return arguments_;
}

/** Every `$`-prefixed token in `source`; the regex is local, so there is no `lastIndex` to share. */
function systemFunctionTokens(source: string): readonly string[] {
  const scanner = /\$[A-Za-z0-9_$]*/g;
  return [...source.matchAll(scanner)].map((match) => match[0]);
}

/**
 * A dialect-safe expression standing in for every real expression, so the sentinel render is the
 * fixed skeleton plus the interface's own port names and nothing else.
 */
function validatedSentinel(text: string): ValidatedExpression {
  const result = validateExpression(text);
  if (!result.ok) {
    throw new Error(
      `the render sentinel \`${text}\` is not inside the accepted dialect: ${result.error.reason}`,
    );
  }
  return result.value;
}

const SENTINEL: ValidatedExpression = validatedSentinel('sentinel_ok');

/** A sentinel carrying `$past`, so the sentinel render keeps a Warm_Up_Gate the real one has. */
const PAST_SENTINEL: ValidatedExpression = validatedSentinel('$past(sentinel_ok)');

/** A sentinel carrying `$stable`, so the sentinel render keeps the real one's renderability. */
const STABLE_SENTINEL: ValidatedExpression = validatedSentinel('$stable(sentinel_ok)');

/**
 * Whether a combinational property's consequent is RENDERED at all (Req 6.20, 6.23).
 *
 * The module-level unclocked `assert property (...)` shape can carry neither `$stable` - a MEASURED
 * hard Yosys error outside a clocked block - nor `$past`, whose Req 6.20 Warm_Up_Gate needs clock
 * edges this shape has none of. The renderer emits NO assertion for either, which lands on the
 * zero-assertion guard, so this suite has to know which combinational cases carry an assert line.
 */
function rendersCombinationalAssert(property: FormalProperty): boolean {
  return (
    property.kind === 'combinational' &&
    !property.consequent.includes('$past') &&
    !property.consequent.includes('$stable')
  );
}

/**
 * One expression replaced by the sentinel that PRESERVES the skeleton statements it drives.
 *
 * A `$past` in any expression makes the renderer emit a Warm_Up_Gate - a `reg` declaration and a
 * second `always @(posedge ...)` - so a plain sentinel would drop an `@` the real render has and
 * part 1's equality would fail for a reason that says nothing about splicing. A `$stable` in a
 * combinational consequent decides whether an assert is emitted at all, for the same reason. So
 * both facts travel with the sentinel while the expression CONTENT is substituted, which is exactly
 * the variable the counting claim isolates.
 *
 * The `$past` DEPTH is not preserved, and does not need to be: part 1 counts FORM occurrences, and
 * the depth appears only inside the gate's own decimal literal. A depth ABOVE `MAX_WARM_UP_DEPTH`
 * would be a different matter - the real render would emit no statements while the depth-1 sentinel
 * render would - and this sample cannot contain one, because `dialectExpressionArbitrary` builds
 * `$past(<expr>)` and no two-argument form. A generator that grows one fails part 1 loudly rather
 * than passing quietly, which is the right direction for it to fail in.
 */
function sentinelFor(expression: ValidatedExpression): ValidatedExpression {
  if (expression.includes('$past')) {
    return PAST_SENTINEL;
  }
  return expression.includes('$stable') ? STABLE_SENTINEL : SENTINEL;
}

/**
 * The same property with every expression replaced by its sentinel.
 *
 * Kind and antecedent PRESENCE are preserved, because both change which skeleton statements are
 * emitted and therefore how many skeleton occurrences of `@` there are.
 */
function withSentinelExpressions(property: FormalProperty): FormalProperty {
  if (property.kind === 'combinational') {
    return { ...property, consequent: sentinelFor(property.consequent) };
  }
  const antecedent = property.antecedent;
  return {
    ...property,
    clock: sentinelFor(property.clock),
    antecedent: antecedent === null ? null : sentinelFor(antecedent),
    consequent: sentinelFor(property.consequent),
  };
}

/**
 * A gate guard sitting between the clocking event and the assertion, or nothing. Non-global.
 *
 * WHICH terms the gate carries and at what depth belong to Property 31 (task 16.9) and Property 33
 * (task 16.12); this suite's claim is about the DIALECT of the statement they sit inside, so the gate
 * is admitted here by SHAPE and pinned by POSITION. `[^()]*` rather than `.*` on purpose: the gate
 * terms the renderer emits carry no parentheses of their own, so a gate that swallowed the
 * antecedent's parens would fail here rather than be read as one long gate.
 */
const GATE_GUARD_PATTERN = /^(?:if \([^()]*\) )?$/;

/**
 * Assert the property's assert statement is the exact form its requirement names (Req 6.1, 6.2, 6.3).
 *
 * Built as HEAD + GATE + TAIL and matched against the rendered line, so the property's own
 * expressions are compared byte for byte while the gate is the only text this suite does not spell
 * out - and even that is pinned to ONE position, between the clocking event and the antecedent guard.
 * A gate spliced anywhere else leaves no line with this head and this tail, and fails.
 *
 * A REFUSED combinational shape has no assert statement at all, which is asserted as the absence it
 * is: `assert` appears nowhere in the wrapper, so a refusal cannot pass as a rendered statement.
 */
function expectAssertStatement(property: FormalProperty, rendered: string): void {
  if (property.kind === 'combinational') {
    if (!rendersCombinationalAssert(property)) {
      expect({ rendered, carriesAssert: rendered.includes('assert') }).toEqual({
        rendered,
        carriesAssert: false,
      });
      return;
    }
    expect(rendered.split('\n')).toContain(`  ${ASSERT_PROPERTY_PREFIX}${property.consequent});`);
    return;
  }
  const head = `  ${EDGE_PREFIX}${property.clock}) `;
  const antecedent = property.antecedent;
  const tail =
    antecedent === null
      ? `assert(${property.consequent});`
      : `if (${antecedent}) assert(${property.consequent});`;
  const matching = rendered
    .split('\n')
    .filter(
      (line) =>
        line.startsWith(head) && line.endsWith(tail) && line.length >= head.length + tail.length,
    );
  expect({ head, tail, matchingLines: matching.length }).toEqual({ head, tail, matchingLines: 1 });
  const gate = (matching[0] as string).slice(
    head.length,
    (matching[0] as string).length - tail.length,
  );
  expect({ gate, shaped: GATE_GUARD_PATTERN.test(gate) }).toEqual({ gate, shaped: true });
}

/** Every expression the property carries, so a claim about "the spliced text" can read them all. */
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

/** Whether any expression is a boolean implication written `!a || b`, the dialect's only form. */
function carriesImplication(property: FormalProperty): boolean {
  // Non-global and locally constructed: `test` on it reads and writes no `lastIndex`.
  const implication = /![^\n]*\|\|/;
  return expressionsOf(property).some((expression) => implication.test(expression));
}

describe(PROPERTY, () => {
  it('renders the accepted form for its kind and adds no measured rejected form', () => {
    let total = 0;
    let clockedWithAntecedent = 0;
    let clockedWithoutAntecedent = 0;
    let combinational = 0;
    let carryingSampledFunction = 0;
    let carryingImplication = 0;

    let derivedContract = 0;

    fc.assert(
      fc.property(
        arbDesignInterface(),
        arbFormalProperty(),
        arbResetContract(),
        (designInterface: ModuleInterface, property: FormalProperty, reset: ResetContract) => {
          total += 1;
          if (reset.derived) {
            derivedContract += 1;
          }

          const rendered = renderPropertyWrapper(designInterface, property, WRAPPER_NAME, reset);
          const skeleton = renderPropertyWrapper(
            designInterface,
            withSentinelExpressions(property),
            WRAPPER_NAME,
            reset,
          );

          // Part 2. The skeleton's own measured forms are exactly the accepted form's, so the ten
          // rows absent here are asserted absent from the rendered wrapper by part 1's equality.
          expect(formsPresentIn(skeleton)).toEqual(expectedSkeletonForms(property, reset));

          // Part 1. Splicing the property's real validated expressions in place of the sentinel
          // added ZERO occurrences of any measured rejected form - all twelve rows, no exceptions.
          for (const form of MEASURED_REJECTED_FORMS) {
            const observed = occurrenceOffsets(rendered, form).length;
            const expected = occurrenceOffsets(skeleton, form).length;
            expect({ construct: form.construct, occurrences: observed }).toEqual({
              construct: form.construct,
              occurrences: expected,
            });
          }

          // Part 3. Each skeleton form appears only in its skeleton position.
          expectOnlyInsidePrefixes(rendered, measuredForm('@'), [EDGE_PREFIX], '@');
          expectOnlyInsidePrefixes(
            rendered,
            measuredForm('property'),
            [ASSERT_PROPERTY_PREFIX, ASSUME_PROPERTY_PREFIX],
            'property',
          );

          // Part 4. Req 6.2: an `assert property (...)` argument carries no clocking event, and no
          // other measured form either.
          for (const argument of assertPropertyArguments(rendered)) {
            expect(formsPresentIn(argument)).toEqual([]);
          }

          // Req 6.4: every `$` token the render carries is one the validator admits, read off the
          // validator itself rather than off a second copy of the accepted-function list.
          for (const token of systemFunctionTokens(rendered)) {
            expect({ token, accepted: validateExpression(token).ok }).toEqual({
              token,
              accepted: true,
            });
          }

          // Req 6.1, 6.2, 6.3: the assert statement is the exact form its requirement names, with
          // the property's own expressions spliced in byte for byte and no implication operator.
          expectAssertStatement(property, rendered);

          if (property.kind === 'combinational') {
            // Req 6.2: a combinational property carries NO clocking event at all, so there is no
            // `always` block and no `@` anywhere in the wrapper - the Warm_Up_Gate's own
            // `always @(posedge ...)` increment reaches only the clocked shape.
            expect(rendered).not.toContain('always');
            expect(rendered).not.toContain('@');
            combinational += 1;
          } else {
            // Req 6.1: a clocked property is an IMMEDIATE assertion inside a clocked `always`
            // block, never a concurrent `assert property`.
            expect(rendered).not.toContain(ASSERT_PROPERTY_PREFIX);
            if (property.antecedent === null) {
              clockedWithoutAntecedent += 1;
            } else {
              clockedWithAntecedent += 1;
            }
          }

          if (systemFunctionTokens(rendered).length > 0) {
            carryingSampledFunction += 1;
          }
          if (carriesImplication(property)) {
            carryingImplication += 1;
          }
        },
      ),
      propertyParameters(),
    );

    // Non-vacuity. Each claim above holds trivially over a sample that lacks the shape it is about,
    // so the sample is asserted to contain every shape rather than assumed to.
    expect(total).toBeGreaterThan(0);
    // Both union members, and both antecedent arms of the clocked member.
    expect(clockedWithAntecedent / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    expect(clockedWithoutAntecedent / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    expect(combinational / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    // Without a derived contract in the sample, `property`'s SECOND position is never exercised and
    // part 3 would be asserting the single-position claim it used to.
    expect(derivedContract / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    // Without these two the Req 6.4 loop runs over an empty token list and the `|->`/`|=>` absence
    // is asserted over a sample that never expressed an implication.
    expect(carryingSampledFunction).toBeGreaterThan(0);
    expect(carryingImplication).toBeGreaterThan(0);
  });
});
