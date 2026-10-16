// Property 4 over the fixture's load path. The population is expressions the Property_Validator
// refuses, and the claim is that every expression field a Fixture_Property carries goes through
// `validateExpression`, so a refused text fails the load instead of reaching a measurement.
// See design.md, Component C4 for the fixture and Component 18 for the two `$past` refusals.
//
// **Validates: Requirements 2.8**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MAX_WARM_UP_DEPTH, validateExpression, type FormalProperty } from '@app/tools';

import { arbPropertyText } from './formal-arbitraries.js';
import { clockedProperty, combinationalProperty, guardedProperty } from './formal-fixtures.js';
import { DEFAULT_NUM_RUNS, propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 4: An out-of-dialect expression fails the fixture load by name
const PROPERTY =
  'formal-gate-first-light, Property 4: An out-of-dialect expression fails the fixture load by name';

/** In-dialect filler for the fields a case is not placing its refused text in. */
const ACCEPTED_EXPRESSION = 'q == 0';

/** The id every generated entry carries. The entry never exists, so the value is not the point. */
const ENTRY_ID = 'refused-entry';

const EXPRESSION_FIELDS = [
  'combinational-consequent',
  'clocked-consequent',
  'clock',
  'antecedent',
] as const;
type ExpressionField = (typeof EXPRESSION_FIELDS)[number];

/**
 * Every expression field a Fixture_Property carries, and the helper call that validates it.
 *
 * Total by construction: a fifth field in the list above is a compile error here rather than a
 * field this property silently stops covering.
 */
const BUILD_WITH_REFUSED: Readonly<Record<ExpressionField, (text: string) => FormalProperty>> = {
  'combinational-consequent': (text) => combinationalProperty(ENTRY_ID, text),
  'clocked-consequent': (text) => clockedProperty(ENTRY_ID, 'clk', text),
  clock: (text) => clockedProperty(ENTRY_ID, text, ACCEPTED_EXPRESSION),
  antecedent: (text) => guardedProperty(ENTRY_ID, 'clk', text, ACCEPTED_EXPRESSION),
};

/** The named refusal classes this property's population has to contain, not merely admit. */
const ARMS = [
  'hierarchical-reference',
  'past-depth-above-ceiling',
  'unreadable-past-depth',
  'other-refusal',
] as const;
type Arm = (typeof ARMS)[number];

/** One drawn case: the refused text, and which refusal class produced it. */
interface RefusedDraw {
  readonly arm: Arm;
  readonly text: string;
}

/**
 * A module-qualified signal name, which Yosys binds to a fresh net instead of refusing.
 *
 * Generated rather than assumed because `.` is the one refusal standing between the gate and a
 * measured silent false proof; a bare internal net name is in dialect, so it is the fixture's
 * port-membership check's to catch and not this property's.
 */
function arbHierarchicalReference(): fc.Arbitrary<RefusedDraw> {
  return fc
    .tuple(
      fc.constantFrom('dut', 'u_dut', 'top'),
      fc.constantFrom('cnt', 'state', 'q'),
      fc.constantFrom('', '[1]', " == 4'd8"),
    )
    .map(([instance, signal, tail]) => ({
      arm: 'hierarchical-reference' as const,
      text: `${instance}.${signal}${tail}`,
    }));
}

/** A `$past` the Warm_Up_Gate cannot be built for, at and well above the ceiling's first step. */
function arbPastDepthAboveCeiling(): fc.Arbitrary<RefusedDraw> {
  return fc
    .oneof(
      fc.integer({ min: MAX_WARM_UP_DEPTH + 1, max: MAX_WARM_UP_DEPTH + 8 }),
      fc.constant(Number.MAX_SAFE_INTEGER),
    )
    .map((depth) => ({
      arm: 'past-depth-above-ceiling' as const,
      text: `$past(q, ${String(depth)})`,
    }));
}

/**
 * Depth arguments outside the one form the reader and the tool cannot disagree on.
 *
 * Every entry is a gate of unknown length if it passes unread, which is why the validator refuses
 * rather than guesses: a sized literal ignores its width, `_19` is an identifier, and the last
 * value is one past the safe-integer range.
 */
const UNREADABLE_DEPTHS: readonly string[] = Object.freeze([
  '(17)',
  '17+0',
  '2*8',
  'n',
  'DEPTH',
  '$past(q)',
  "8'd5",
  "'h11",
  "4'dx",
  '_19',
  '9007199254740992',
  '2, en',
]);

/** A `$past` whose depth the renderer's own reader cannot read. */
function arbUnreadablePastDepth(): fc.Arbitrary<RefusedDraw> {
  return fc.constantFrom(...UNREADABLE_DEPTHS).map((depth) => ({
    arm: 'unreadable-past-depth' as const,
    text: `$past(q, ${depth})`,
  }));
}

/**
 * The validator's other refusal reasons, from the shared generator rather than a second list.
 *
 * `arbPropertyText` draws accepted dialect too, and that half is Property 3's, so it is filtered
 * out here: this property is about the refused population only.
 */
function arbOtherRefusal(): fc.Arbitrary<RefusedDraw> {
  return arbPropertyText()
    .filter((text) => !validateExpression(text).ok)
    .map((text) => ({ arm: 'other-refusal' as const, text }));
}

function arbRefusedExpression(): fc.Arbitrary<RefusedDraw> {
  return fc.oneof(
    arbHierarchicalReference(),
    arbPastDepthAboveCeiling(),
    arbUnreadablePastDepth(),
    arbOtherRefusal(),
  );
}

/** One case as the property receives it: the drawn refusal, and the field carrying its text. */
type RefusedCase = [RefusedDraw, ExpressionField];

/**
 * The empty string, in every field, pinned so the degenerate case is covered on every seed.
 *
 * `arbOtherRefusal` does reach it, at roughly one draw in a thousand, which is how it stayed
 * latent until seed 1506311229 drew it. It is refused and must still fail the load, so pinning it
 * is stronger than filtering it out of the population.
 */
const EMPTY_TEXT_EXAMPLES: RefusedCase[] = EXPRESSION_FIELDS.map((field) => [
  { arm: 'other-refusal', text: '' },
  field,
]);

describe(PROPERTY, () => {
  it('fails the load and names the refused text, in whichever field carries it', () => {
    const drawn = new Set<Arm>();
    let emptyTextDrawn = false;

    fc.assert(
      fc.property(
        arbRefusedExpression(),
        fc.constantFrom(...EXPRESSION_FIELDS),
        ({ arm, text }, field) => {
          // The pinned cases are empty and no arm but `other-refusal` can produce the empty
          // string, so they are kept out of the arm tally rather than standing in for a draw.
          if (text === '') {
            emptyTextDrawn = true;
          } else {
            drawn.add(arm);
          }

          // Non-vacuity, per draw: an arm that drifted into accepted dialect is not this
          // property's population, and it fails here rather than passing on a throw it caused.
          expect(validateExpression(text).ok, `in dialect, so outside this property: ${text}`).toBe(
            false,
          );

          const load = (): FormalProperty => BUILD_WITH_REFUSED[field](text);

          if (text === '') {
            // The empty string is out of dialect and fails the load, but it carries no text to be
            // named by. `toThrow('')` is an anchored empty-message regex in vitest rather than a
            // substring match, so naming it here would demand an empty message.
            expect(load).toThrow();
            return;
          }

          // `toThrow(text)` is substring matching, so this is the load failing AND naming it.
          expect(load).toThrow(text);
        },
      ),
      // Examples are drawn before the random sample and count against `numRuns`, so the budget is
      // raised to leave the random sample its full default.
      propertyParameters<RefusedCase>({
        examples: EMPTY_TEXT_EXAMPLES,
        numRuns: DEFAULT_NUM_RUNS + EMPTY_TEXT_EXAMPLES.length,
      }),
    );

    expect([...drawn].sort(), 'a named refusal class the sample never produced').toEqual(
      [...ARMS].sort(),
    );
    expect(emptyTextDrawn, 'the refusal with no name to carry was never drawn').toBe(true);
  });

  it('builds an in-dialect expression in every field, so the load is not refusing everything', () => {
    // The negative control the clause above needs: without it, a constructor that threw for all
    // input would satisfy every draw.
    for (const field of EXPRESSION_FIELDS) {
      expect(() => BUILD_WITH_REFUSED[field](ACCEPTED_EXPRESSION)).not.toThrow();
    }
  });
});
