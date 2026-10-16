// The total form of the claim `app/eval/measurement-limit.test.ts` enumerates: every limit a
// measurement is handed carries exactly one reason from the closed vocabulary, and every other
// name is refused by name. See design.md, Component C3.
//
// The registry and the vocabulary are closed, so they are exhausted; only names are generated.
// The tag is a literal because `propertyTag` in this package hardcodes another spec's slug.
//
// **Validates: Requirements 12.1, 12.3, 12.4, 12.6**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DECLARED_LIMITS, LIMIT_REASONS, limitOrRefuse, type MeasurementLimit } from '@app/eval';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 30: Every limit carries exactly one reason from the closed vocabulary
const PROPERTY =
  'formal-gate-first-light, Property 30: Every limit carries exactly one reason from the closed vocabulary';

const DECLARED_NAMES: readonly string[] = Object.keys(DECLARED_LIMITS);

// -- The closed half: every declared limit, against every reason --------------

/** A limit's own fields; `reason` is the only one, so a second reason has nowhere to live. */
const LIMIT_FIELDS: readonly (keyof MeasurementLimit)[] = ['name', 'reason', 'unit', 'value'];

/**
 * Units that alone mark a limit derived from a measured figure (Req 12.6): a multiple is only
 * ever taken of the Per_Design_Extrapolation the Cost_Pilot measured.
 */
// ponytail: a derived bound in `ms` or `tokens` shares its unit with a declared ceiling, so it
// goes unseen here; the upgrade is a derivation field on MeasurementLimit itself.
const MEASURED_DERIVATION_UNITS: readonly MeasurementLimit['unit'][] = ['multiple'];

/** The limit `name` resolves to, failing the test if the registry refused it. */
function resolvedLimit(name: string): MeasurementLimit {
  const result = limitOrRefuse(name);
  if (!result.ok) {
    throw new Error(`expected "${name}" to resolve, but it was refused: ${result.error.code}`);
  }
  return result.value;
}

// -- The open half: names the registry does not hold --------------------------

const NAME_SHAPES = [
  'case-variant',
  'whitespace-variant',
  'separator-variant',
  'prototype-shaped',
  'empty',
  'arbitrary-graphemes',
] as const;

type NameShape = (typeof NAME_SHAPES)[number];

/** Whitespace a trimming or collapsing lookup would discard; the last two are not ASCII. */
const WHITESPACE = [' ', '\t', '\n', '\u00a0', '\u3000'] as const;

/** Every name `Object.prototype` holds, rather than the few a reader thinks of. */
const PROTOTYPE_NAMES: readonly string[] = Object.getOwnPropertyNames(Object.prototype);

function indicesWhere(text: string, test: (character: string) => boolean): number[] {
  return [...text].flatMap((character, index) => (test(character) ? [index] : []));
}

function rewriteAt(
  text: string,
  indices: readonly number[],
  rewrite: (character: string) => string,
): string {
  return [...text]
    .map((character, index) => (indices.includes(index) ? rewrite(character) : character))
    .join('');
}

function isCased(character: string): boolean {
  return character.toLowerCase() !== character.toUpperCase();
}

function swapCase(character: string): string {
  const upper = character.toUpperCase();
  return character === upper ? character.toLowerCase() : upper;
}

const declaredName = fc.constantFrom(...DECLARED_NAMES);

/** One name of every shape per run, so the shape union is exhausted rather than sampled. */
const namesOfEveryShape = fc.record({
  'case-variant': declaredName.chain((key) =>
    fc
      .subarray(indicesWhere(key, isCased), { minLength: 1 })
      .map((indices) => rewriteAt(key, indices, swapCase)),
  ),
  // Either end included, which is where a trimming lookup would discard it.
  'whitespace-variant': declaredName.chain((key) =>
    fc
      .tuple(fc.integer({ min: 0, max: key.length }), fc.constantFrom(...WHITESPACE))
      .map(([at, space]) => key.slice(0, at) + space + key.slice(at)),
  ),
  // Every declared key is kebab-case, so each holds a hyphen to rewrite.
  'separator-variant': declaredName.chain((key) =>
    fc
      .subarray(
        indicesWhere(key, (character) => character === '-'),
        { minLength: 1 },
      )
      .map((indices) => rewriteAt(key, indices, () => '_')),
  ),
  'prototype-shaped': fc.constantFrom(...PROTOTYPE_NAMES),
  empty: fc.constant(''),
  'arbitrary-graphemes': fc
    .string({ unit: 'grapheme' })
    .filter((name) => !DECLARED_NAMES.includes(name)),
} satisfies Record<NameShape, fc.Arbitrary<string>>);

/** Whether `name` is undeclared, yet one rewrite away from a declared key. */
function isNearMiss(name: string, rewrite: (raw: string) => string): boolean {
  return !DECLARED_NAMES.includes(name) && DECLARED_NAMES.includes(rewrite(name));
}

/** What each shape is, read off the name itself, so an arm that drifts counts for nothing. */
const EXHIBITS: Readonly<Record<NameShape, (name: string) => boolean>> = {
  'case-variant': (name) => isNearMiss(name, (raw) => raw.toLowerCase()),
  'whitespace-variant': (name) => isNearMiss(name, (raw) => raw.replace(/\s/gu, '')),
  'separator-variant': (name) => isNearMiss(name, (raw) => raw.replaceAll('_', '-')),
  // Undeclared, yet `in` finds it: what a bare index would resolve instead of refusing.
  'prototype-shaped': (name) => !DECLARED_NAMES.includes(name) && name in DECLARED_LIMITS,
  empty: (name) => name === '',
  'arbitrary-graphemes': (name) => /[^ -~]/u.test(name),
};

/** Asserts `name` is refused with the registry's code, and that the refusal names it. */
function assertRefusedByName(shape: NameShape, name: string): void {
  const label = `${shape} name ${JSON.stringify(name)}`;
  const result = limitOrRefuse(name);
  if (result.ok) {
    // Not read further: under a prototype leak the resolved value is not a limit at all.
    throw new Error(`expected the ${label} to be refused, but it resolved`);
  }
  expect(result.error.code, label).toBe('MEASUREMENT_LIMIT_NOT_DECLARED');
  expect(result.error.field, label).toBe('name');
  // Quoted, so the empty name cannot pass as a substring of any message.
  expect(result.error.message, label).toContain(`"${name}"`);
}

// -- Property 30 --------------------------------------------------------------

describe(PROPERTY, () => {
  it('given every declared name, when it is resolved, then its limit carries exactly one reason', () => {
    let measuredDerivations = 0;

    for (const name of DECLARED_NAMES) {
      const limit = resolvedLimit(name);
      const label = `limit "${name}" carrying ${JSON.stringify(limit.reason)}`;

      expect(Object.keys(limit).sort(), label).toEqual([...LIMIT_FIELDS].sort());
      // Every member compared, so a reason matching none, or a member listed twice, fails here.
      expect(
        LIMIT_REASONS.filter((reason) => reason === limit.reason),
        label,
      ).toHaveLength(1);
      if (MEASURED_DERIVATION_UNITS.includes(limit.unit)) {
        measuredDerivations += 1;
        expect(limit.reason, label).toBe('anomaly-detection');
      }
    }

    // With no derived limit declared, the Req 12.6 clause above would have checked nothing.
    expect(
      measuredDerivations,
      'no declared limit is derived from a measured figure',
    ).toBeGreaterThan(0);
  });

  it('given any name the registry does not hold, when it is asked for, then it is refused by name', () => {
    const exercised = new Map<NameShape, number>();

    fc.assert(
      fc.property(namesOfEveryShape, (names) => {
        for (const shape of NAME_SHAPES) {
          if (EXHIBITS[shape](names[shape])) {
            exercised.set(shape, (exercised.get(shape) ?? 0) + 1);
          }
          assertRefusedByName(shape, names[shape]);
        }
      }),
      propertyParameters(),
    );

    for (const shape of NAME_SHAPES) {
      expect(exercised.get(shape) ?? 0, `no draw exercised ${shape}`).toBeGreaterThan(0);
    }
  });
});
