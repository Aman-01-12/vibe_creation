// formal-gate-first-light, Component 18: the combinational shape refusal and the renderer's
// emptiness, read as ONE boundary so neither can move without the other.
//
// Every consequent here is assembled from LABELLED pieces and the expected outcome is computed
// from those labels, never read back off the rendered text, so a check that agreed with the
// renderer by re-parsing its output could not pass.
//
// **Validates: Requirements 13.16, 13.17, 13.18**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import {
  MAX_CONSTRUCT_CHARS,
  MAX_WARM_UP_DEPTH,
  propertyShapeRejection,
  renderPropertyWrapper,
  validateExpression,
  type FormalProperty,
  type ResetContract,
  type ValidatedExpression,
} from '@app/tools';

import { arbFormalProperty, arbResetContract } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-gate-first-light, Property 37: A combinational property is refused by name
// exactly when the renderer would emit nothing for it**
const PROPERTY =
  'formal-gate-first-light, Property 37: A combinational property is refused by name exactly when the renderer would emit nothing for it';

/** 100 is the floor; 300 keeps every piece kind and all three outcomes populated. */
const NUM_RUNS = 300;

/**
 * The two construct texts, spelled here rather than imported.
 *
 * They are module-private in the renderer, and a copy is the point: a rename there fails this
 * file, which is the direction that matters for a name the Property_Author reports to a student.
 */
const PAST_CONSTRUCT = '$past in combinational';
const STABLE_CONSTRUCT = '$stable in combinational';

/** The wrapper name is caller-owned and no model output reaches it; one fixed value suffices. */
const WRAPPER_NAME = 'formal_property_wrapper';

/** The design every case is rendered over: a clock, a reset, one input, one output. */
const DESIGN_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'shift_reg',
  ports: [
    { name: 'd', direction: 'input', width: 8 },
    { name: 'q', direction: 'output', width: 8 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
};

/**
 * A DERIVED contract for the exhausted forms, so every rendered wrapper carries an
 * `assume property (...)` line - the adversary for an assertion counter that matched too loosely.
 */
const DERIVED_CONTRACT: ResetContract = {
  derived: true,
  resetName: 'rst',
  resetActiveLow: false,
  resetKind: 'sync',
  initialStateFree: true,
};

/** The combinational shape's module-level assertion (Req 13.18). */
const ASSERT_PROPERTY_PREFIX = 'assert property (';

/** The clocked shape's immediate assertion, counted so a kind mix-up cannot pass unnoticed. */
const ASSERT_PREFIX = 'assert(';

/** The clocked shape's vacuity cover, which a refused property must not carry either. */
const COVER_PREFIX = 'cover(';

/** What one rendered wrapper actually emits, in the three forms that can carry a proposition. */
interface EmissionCounts {
  readonly moduleLevelAssertions: number;
  readonly clockedAssertions: number;
  readonly covers: number;
}

/** No emission at all: the whole of what a refused property may leave in the wrapper. */
const NOTHING_EMITTED: EmissionCounts = {
  moduleLevelAssertions: 0,
  clockedAssertions: 0,
  covers: 0,
};

/** Count the wrapper's emissions. `assume property (...)` is not an assertion and never counts. */
function emissionCounts(wrapper: string): EmissionCounts {
  const lines = wrapper.split('\n');
  return {
    moduleLevelAssertions: lines.filter((line) =>
      line.trimStart().startsWith(ASSERT_PROPERTY_PREFIX),
    ).length,
    clockedAssertions: lines.filter((line) => line.includes(ASSERT_PREFIX)).length,
    covers: lines.filter((line) => line.includes(COVER_PREFIX)).length,
  };
}

/** Put an assembled expression through the sole constructor of the brand, or fail loudly. */
function validatedOrThrow(text: string): ValidatedExpression {
  const result = validateExpression(text);
  if (!result.ok) {
    throw new Error(`assembled expression is outside the accepted dialect: ${text}`);
  }
  return result.value;
}

/** Which labelled piece a consequent term is. The expectation is computed from this and the depth. */
type PieceKind = 'plain' | 'past-implicit' | 'past-depth' | 'stable' | 'rose' | 'fell' | 'changed';

const PIECE_KINDS: readonly PieceKind[] = Object.freeze<PieceKind[]>([
  'plain',
  'past-implicit',
  'past-depth',
  'stable',
  'rose',
  'fell',
  'changed',
]);

/** One labelled term of a consequent: what it is, how far back it reaches, and its text. */
interface Piece {
  readonly kind: PieceKind;
  /** The Past_Depth it reaches back across, or `null` where it reaches back across none. */
  readonly depth: number | null;
  readonly text: string;
}

/** Plain boolean terms, which reach back across no boundary and are always accepted. */
const PLAIN_TERMS: readonly string[] = Object.freeze(['q == d', '!q[0] || d[1]']);

function plainPiece(term: string): Piece {
  return { kind: 'plain', depth: null, text: term };
}

/** `null` is the one-argument `$past(d)`, which reads as depth 1 - SystemVerilog's own default. */
function pastPiece(depth: number | null): Piece {
  return depth === null
    ? { kind: 'past-implicit', depth: 1, text: '$past(d)' }
    : { kind: 'past-depth', depth, text: `$past(d, ${String(depth)})` };
}

/** The `$past`-derived calls and `$stable`, each a single-argument sampled-value function. */
const DERIVED_CALLS = ['rose', 'fell', 'changed'] as const;

function callPiece(kind: 'stable' | (typeof DERIVED_CALLS)[number]): Piece {
  return { kind, depth: null, text: `$${kind}(d)` };
}

/**
 * The outcome the LABELS require: the construct a refusal must name, or `null` for an acceptance.
 *
 * `$past` is reported ahead of `$stable` where both are present, which is the order of the
 * renderer's own disjunction. Only a `$past` piece carries a depth, so `depth > 0` is exactly the
 * `$past` that would need a warm-up gate the module-level assertion has no clock to count on.
 */
function expectedConstruct(pieces: readonly Piece[]): string | null {
  if (pieces.some((piece) => piece.depth !== null && piece.depth > 0)) {
    return PAST_CONSTRUCT;
  }
  return pieces.some((piece) => piece.kind === 'stable') ? STABLE_CONSTRUCT : null;
}

/**
 * Grade one assembled consequent: the named refusal and the renderer's emission as one fact.
 *
 * BOTH directions are asserted, which is what makes the "exactly when" load-bearing. A refusal
 * must leave no assertion and no cover, and an acceptance must leave exactly one module-level
 * assertion carrying the consequent verbatim, so a disagreement either way fails here.
 *
 * Returns the construct that was expected, or `null`, so a caller can tally the outcomes.
 */
function assertShapeCase(pieces: readonly Piece[], reset: ResetContract): string | null {
  const consequent = pieces.map((piece) => piece.text).join(' && ');
  const property: FormalProperty = {
    kind: 'combinational',
    id: 'property-37',
    criterionRef: '13.16',
    consequent: validatedOrThrow(consequent),
  };
  const expected = expectedConstruct(pieces);
  const rejection = propertyShapeRejection(property);
  const counts = emissionCounts(
    renderPropertyWrapper(DESIGN_INTERFACE, property, WRAPPER_NAME, reset),
  );

  if (expected === null) {
    expect(rejection).toBeNull();
    expect(counts).toEqual({ moduleLevelAssertions: 1, clockedAssertions: 0, covers: 0 });
    return null;
  }
  expect(rejection).toEqual({ reason: 'unaccepted-construct', construct: expected });
  expect(counts).toEqual(NOTHING_EMITTED);
  return expected;
}

/**
 * Every single-piece form, EXHAUSTED rather than sampled: the depths run 0 to the Warm_Up_Ceiling
 * inclusive, read through the module so a ceiling that moves re-aims the table with it.
 */
const SINGLE_PIECE_FORMS: readonly Piece[] = [
  ...PLAIN_TERMS.map(plainPiece),
  pastPiece(null),
  ...Array.from({ length: MAX_WARM_UP_DEPTH + 1 }, (_unused, depth) => pastPiece(depth)),
  callPiece('stable'),
  ...DERIVED_CALLS.map(callPiece),
];

describe('formal-gate-first-light: the constructs a combinational refusal names (criterion 13.17)', () => {
  it.each([PAST_CONSTRUCT, STABLE_CONSTRUCT])('renders %s inside the diagnostic bound', (name) => {
    // The construct reaches a student through a bounded diagnostic, so an unprintable or
    // over-long name is a defect rather than a cosmetic issue.
    expect(name.length).toBeLessThanOrEqual(MAX_CONSTRUCT_CHARS);
    expect(name).toMatch(/^[ -~]+$/);
  });
});

describe('formal-gate-first-light: every single-piece combinational form (criteria 13.16, 13.18)', () => {
  it.each(SINGLE_PIECE_FORMS.map((piece) => [piece.text, piece] as const))(
    '%s is refused by name exactly when the wrapper carries no assertion',
    (_text, piece) => {
      assertShapeCase([piece], DERIVED_CONTRACT);
    },
  );

  it('reaches all three outcomes, so the exhausted table is two-sided by construction', () => {
    const outcomes = new Set(SINGLE_PIECE_FORMS.map((piece) => expectedConstruct([piece])));

    expect(outcomes).toEqual(new Set([PAST_CONSTRUCT, STABLE_CONSTRUCT, null]));
  });
});

/**
 * One labelled piece, with the `$past` depths weighted onto 0 and 1.
 *
 * Those two decide the boundary: 0 reaches back across nothing and renders, 1 is the shallowest
 * depth that needs a gate. The uniform arm keeps the rest of the range in the sample.
 */
const pieceArbitrary: fc.Arbitrary<Piece> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...PLAIN_TERMS).map(plainPiece) },
  { weight: 2, arbitrary: fc.constant(pastPiece(null)) },
  {
    weight: 3,
    arbitrary: fc
      .oneof(
        { weight: 3, arbitrary: fc.constantFrom(0, 1) },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: MAX_WARM_UP_DEPTH }) },
      )
      .map((depth) => pastPiece(depth)),
  },
  { weight: 3, arbitrary: fc.constant(callPiece('stable')) },
  { weight: 3, arbitrary: fc.constantFrom(...DERIVED_CALLS).map(callPiece) },
);

/** The label every accepted case is tallied under, distinct from either construct text. */
const ACCEPTED = 'accepted';

describe('formal-gate-first-light: the combinational shape boundary (Property 37)', () => {
  it(PROPERTY, () => {
    const kinds = new Set<PieceKind>();
    const depths = new Set<number>();
    const outcomes = new Set<string>();

    fc.assert(
      fc.property(
        fc.array(pieceArbitrary, { minLength: 1, maxLength: 3 }),
        arbResetContract(),
        (pieces: readonly Piece[], reset: ResetContract) => {
          for (const piece of pieces) {
            kinds.add(piece.kind);
            if (piece.depth !== null) {
              depths.add(piece.depth);
            }
          }

          outcomes.add(assertShapeCase(pieces, reset) ?? ACCEPTED);
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // Non-vacuity: a sample missing a kind, the depth-0 case, or either side of the boundary
    // would pass the property while testing part of it.
    expect([...kinds].sort()).toEqual([...PIECE_KINDS].sort());
    expect(depths.has(0)).toBe(true);
    expect([...depths].filter((depth) => depth > 0).length).toBeGreaterThan(0);
    expect([...outcomes].sort()).toEqual([ACCEPTED, PAST_CONSTRUCT, STABLE_CONSTRUCT].sort());
  });

  it(`${PROPERTY} - over arbFormalProperty()'s own draws`, () => {
    let refused = 0;
    let accepted = 0;
    let clocked = 0;

    fc.assert(
      fc.property(
        arbFormalProperty(),
        arbResetContract(),
        (property: FormalProperty, reset: ResetContract) => {
          const rejection = propertyShapeRejection(property);
          const counts = emissionCounts(
            renderPropertyWrapper(DESIGN_INTERFACE, property, WRAPPER_NAME, reset),
          );

          if (property.kind !== 'combinational') {
            // The shape refusal is the combinational kind's alone, and a clocked property emits
            // no module-level assertion for the comparison below to confuse with one.
            clocked += 1;
            expect(rejection).toBeNull();
            expect(counts.moduleLevelAssertions).toBe(0);
            return;
          }
          // CLASSIFIED by the check and compared draw by draw, never filtered: a filter would
          // leave whichever side it dropped unasserted.
          if (rejection === null) {
            accepted += 1;
            expect(counts).toEqual({ moduleLevelAssertions: 1, clockedAssertions: 0, covers: 0 });
            return;
          }
          refused += 1;
          expect(rejection.reason).toBe('unaccepted-construct');
          expect(counts).toEqual(NOTHING_EMITTED);
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // Non-vacuity: this generator's unary-function arm builds both the one-argument `$past` and
    // `$stable`, so both sides of the boundary are expected in every sample.
    expect(refused).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
    expect(clocked).toBeGreaterThan(0);
  });
});
