// formal-gate-first-light, Component 18: the Warm_Up_Ceiling, read through `@app/tools`.
//
// The expected ceiling is derived from the shipped ladder's first rung and a delay this file
// states, never read from `MAX_WARM_UP_DEPTH`, so a ceiling that leaves its derivation fails here.
//
// **Validates: Requirements 13.1, 13.2, 13.3, 13.4**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CLOCKED_DEPTH_LADDER, MAX_WARM_UP_DEPTH, validateExpression } from '@app/tools';

import { propertyParameters } from './property.js';

/**
 * A clocked check reports one step after the state it samples. Stated here rather than imported,
 * so a delay edited in the product cannot carry this file's expectation with it.
 */
const CLOCKED_CHECK_DELAY = 1;

/** The shipped ladder's first rung; an empty ladder fails the load rather than defaulting. */
function firstClockedRung(): number {
  const rung = CLOCKED_DEPTH_LADDER.at(0);
  if (rung === undefined) {
    throw new Error('CLOCKED_DEPTH_LADDER is empty, so it holds no first clocked rung');
  }
  return rung;
}

/** The first rung's last Base_Check step less the delay, which is the last sample it evaluates. */
const EXPECTED_CEILING = firstClockedRung() - 1 - CLOCKED_CHECK_DELAY;

describe('formal-gate-first-light: the Warm_Up_Ceiling (criterion 13.2)', () => {
  it('is a positive integer', () => {
    expect(Number.isSafeInteger(MAX_WARM_UP_DEPTH)).toBe(true);
    expect(MAX_WARM_UP_DEPTH).toBeGreaterThan(0);
  });

  it('equals the shipped first rung minus one, less a check delay of 1', () => {
    expect(MAX_WARM_UP_DEPTH).toBe(EXPECTED_CEILING);
  });
});

/** The construct a refusal names, or a label saying it was accepted. */
function refusalOf(text: string): string {
  const result = validateExpression(text);
  if (result.ok) {
    return 'accepted';
  }
  return result.error.reason === 'unaccepted-construct'
    ? result.error.construct
    : result.error.reason;
}

const ABOVE = MAX_WARM_UP_DEPTH + 1;

describe('formal-gate-first-light: a $past depth the renderer cannot gate (criteria 13.3, 13.4)', () => {
  it('refuses a readable depth above the ceiling, naming both numbers in full', () => {
    expect(refusalOf(`$past(q, ${String(ABOVE)})`)).toBe(
      `$past(_, ${String(ABOVE)}) > ${String(MAX_WARM_UP_DEPTH)}`,
    );
  });

  it('reads a padded and an underscored decimal as the same depth', () => {
    // Both state 25, so both are refused with 25 rather than one reading as something else.
    expect(refusalOf('$past(q, 0025)')).toBe(`$past(_, 25) > ${String(MAX_WARM_UP_DEPTH)}`);
    expect(refusalOf('$past(q, 2_5)')).toBe(`$past(_, 25) > ${String(MAX_WARM_UP_DEPTH)}`);
  });

  it.each([
    ['a sized literal', "$past(q, 8'd2)"],
    ['a parenthesised depth', '$past(q, (2))'],
    ['an expression', '$past(q, 1+1)'],
    ['an identifier', '$past(q, n)'],
    ['an underscore-led identifier', '$past(q, _19)'],
    ['a based literal with no size', "$past(q, 'd5)"],
    ['an empty second argument', '$past(q, )'],
  ])('refuses %s as an unreadable depth', (_shape, text) => {
    // A depth that passed unread would be a gate of unknown length, which is the false-proof
    // direction on a property with no antecedent. See design.md, Component 18.
    expect(refusalOf(text)).toBe('$past(_, unreadable)');
  });

  it('accepts the ceiling itself, and the one-argument form', () => {
    expect(refusalOf(`$past(q, ${String(MAX_WARM_UP_DEPTH)})`)).toBe('accepted');
    expect(refusalOf('$past(q)')).toBe('accepted');
  });

  it('keeps every construct inside the bound a refusal is rendered within', () => {
    const widest = refusalOf(`$past(q, ${String(Number.MAX_SAFE_INTEGER)})`);

    expect(widest.length).toBeLessThanOrEqual(32);
  });

  it('reports a measured form ahead of a too-deep depth, because the depth guard runs last', () => {
    // `|->` is a measured rejected form, caught before the depth is ever read.
    expect(refusalOf(`$past(q, ${String(ABOVE)}) |-> q`)).toBe('|->');
  });
});

// **Feature: formal-gate-first-light, Property 36: A `$past` depth above the Warm_Up_Ceiling is
// refused by name, and every depth up to it is accepted**
//
// The expectation is `EXPECTED_CEILING`, derived above from the shipped ladder, so a ceiling that
// stops being the first rung minus one less the delay fails here as well as at criterion 13.2.
// The forms with no number to compare - the one-argument `$past` and the unreadable depths - are
// exhausted by the examples above rather than sampled, because there are few enough to name.
//
// **Validates: Requirements 13.1, 13.3, 13.4**
const PROPERTY =
  'formal-gate-first-light, Property 36: A `$past` depth above the Warm_Up_Ceiling is refused by name, and every depth up to it is accepted';

/** 100 is the floor; 300 keeps every weighted arm populated across the three spellings. */
const NUM_RUNS = 300;

/** Three spellings of one unsized decimal value, all of which state the same depth. */
const DEPTH_SPELLINGS = ['plain', 'zero-padded', 'underscored'] as const;

type DepthSpelling = (typeof DEPTH_SPELLINGS)[number];

/** One depth as an unsized decimal literal. A single-digit depth has no interior to group. */
function spellDepth(depth: number, spelling: DepthSpelling): string {
  const digits = String(depth);
  if (spelling === 'zero-padded') {
    return `00${digits}`;
  }
  if (spelling === 'underscored' && digits.length > 1) {
    return `${digits.slice(0, 1)}_${digits.slice(1)}`;
  }
  return digits;
}

/** Where the `$past` call sits; the depth rule is the same at every one of them. */
const PLACEMENTS = ['CALL', 'CALL == q', 'q || CALL'] as const;

/**
 * Depths weighted onto the two that decide the boundary, the ceiling and the step above it.
 *
 * The last arm reaches `Number.MAX_SAFE_INTEGER`, the widest depth this reader holds exactly, so
 * the construct is asserted to state a depth of any magnitude in full rather than abbreviate it.
 */
const depthArbitrary = fc.oneof(
  { arbitrary: fc.constantFrom(EXPECTED_CEILING, EXPECTED_CEILING + 1), weight: 4 },
  { arbitrary: fc.integer({ min: 1, max: EXPECTED_CEILING }), weight: 3 },
  { arbitrary: fc.integer({ min: EXPECTED_CEILING + 1, max: EXPECTED_CEILING + 8 }), weight: 2 },
  { arbitrary: fc.maxSafeNat().map((drawn) => Math.max(drawn, EXPECTED_CEILING + 1)), weight: 2 },
);

/** A depth this far past the ceiling can only come from the safe-integer arm. */
const FAR_PAST_THE_CEILING = 10_000;

describe('formal-gate-first-light: the Past_Depth boundary (Property 36)', () => {
  it(PROPERTY, () => {
    let accepted = 0;
    let refused = 0;
    let farPastTheCeiling = 0;

    fc.assert(
      fc.property(
        depthArbitrary,
        fc.constantFrom(...DEPTH_SPELLINGS),
        fc.constantFrom(...PLACEMENTS),
        (depth, spelling, placement) => {
          const call = `$past(q, ${spellDepth(depth, spelling)})`;
          const text = placement.replace('CALL', () => call);
          const tooDeep = depth > EXPECTED_CEILING;

          if (tooDeep) {
            refused += 1;
          } else {
            accepted += 1;
          }
          if (depth > FAR_PAST_THE_CEILING) {
            farPastTheCeiling += 1;
          }

          expect(refusalOf(text)).toBe(
            tooDeep ? `$past(_, ${String(depth)}) > ${String(EXPECTED_CEILING)}` : 'accepted',
          );
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // Non-vacuity: one-sided draws would pass the property while testing half of it.
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(farPastTheCeiling).toBeGreaterThan(0);
  });
});
