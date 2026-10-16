// Feature: formal-gate-first-light, Property 30: A refused Property_Set carries no properties
// into the loop, and the gate's outcome is what the set is stamped with.
//
// WHY THIS IS A PROPERTY AND NOT TWO EXAMPLES
//   The rule has an exactly-when shape over a closed four-member vocabulary: the set is emptied
//   for the outcomes `propertySetAdmissionFallsBack` names and for no others, and the stamp is
//   the gate's outcome in every case. Checking `refused` and `admitted` by hand would leave
//   `no-gate-set` and `not-gated` ungraded, and those two are the pair a reader most easily
//   confuses - one means a gate ran over an empty set, the other that no gate was injected.
//
// THE VOCABULARY IS EXHAUSTED, NOT RESTATED
//   The generator spreads `PROPERTY_SET_ADMISSION_OUTCOMES`, and the expectation is computed by
//   `propertySetAdmissionFallsBack` rather than by comparing against a hardcoded 'refused'. So a
//   fifth member, or an existing member flipped to fall back, is covered here with no edit to
//   this file - which is the whole reason that array is the declaration and the type derives
//   from it.
//
// WHY `unexpressedCriteria` IS ASSERTED TO SURVIVE
//   A refusal is a judgement about the properties the author DID express. It says nothing about
//   the criteria the author could not express, and dropping those would make a refused sample
//   look like one whose Spec was fully covered.
//
// Validates: Requirements 6.3, 6.4, 6.5

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PROPERTY_SET_ADMISSION_OUTCOMES,
  type FormalPropertySet,
  type PropertySetAdmissionOutcome,
  type PropertySetSource,
  type SessionBudgetHandle,
} from '@app/agent';
import { AdmissionStampingPropertySource, propertySetAdmissionFallsBack } from '@app/eval';
import { validateExpression, type FormalProperty } from '@app/tools';
import type { Spec } from '@app/core';

import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 30: A refused Property_Set carries no properties into the loop';

/** An opaque Spec token: the decorator forwards the Spec and never reads it. */
const SPEC = {} as Spec;

/** A budget handle the fake author never charges. */
const BUDGET: SessionBudgetHandle = {
  sessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  canAfford: () => true,
  charge: () => null,
  stopReason: () => null,
};

/** An inner source handing back a fixed set, stamped as the Property_Author stamps it. */
function authoringSource(set: FormalPropertySet): PropertySetSource {
  return { propertySetFor: () => Promise.resolve(set) };
}

/** One real validated property. The consequent's content is not what this property reads. */
function combinationalProperty(id: string): FormalProperty {
  const consequent = validateExpression('q');
  if (!consequent.ok) {
    throw new Error('the pinned consequent must be inside the accepted dialect');
  }
  return { kind: 'combinational', id, criterionRef: '6.3', consequent: consequent.value };
}

/**
 * An authored set of a generated size.
 *
 * The properties are REAL `FormalProperty` values rather than cast tokens: this property reads
 * only how many survive and whether the surviving array is the inner one, but a cast would have
 * let a shape the loop could never receive stand in for one it can.
 */
function arbAuthoredSet(): fc.Arbitrary<FormalPropertySet> {
  return fc
    .tuple(
      fc.integer({ min: 0, max: 6 }),
      fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 5 }),
      // The inner stamp is always the author's `'not-gated'` in production, but it is generated
      // here so the assertion that the decorator OVERWRITES it cannot pass by both being equal.
      fc.constantFrom(...PROPERTY_SET_ADMISSION_OUTCOMES),
    )
    .map(([propertyCount, unexpressedCriteria, innerStamp]) => ({
      properties: Array.from({ length: propertyCount }, (_unused, index) =>
        combinationalProperty(`p${String(index)}`),
      ),
      unexpressedCriteria,
      propertySetAdmitted: innerStamp,
      propertySetAuthoredUpFront: false,
    }));
}

describe(PROPERTY, () => {
  it('empties the properties for exactly the outcomes that fall back, over the whole vocabulary', async () => {
    const emptied = new Set<PropertySetAdmissionOutcome>();
    const passedThrough = new Set<PropertySetAdmissionOutcome>();

    await fc.assert(
      fc.asyncProperty(
        arbAuthoredSet(),
        fc.constantFrom(...PROPERTY_SET_ADMISSION_OUTCOMES),
        async (authored, outcome) => {
          const source = new AdmissionStampingPropertySource(authoringSource(authored), outcome);

          const served = await source.propertySetFor(SPEC, BUDGET);

          const fallsBack = propertySetAdmissionFallsBack(outcome);
          if (fallsBack) {
            // The rule: nothing the author expressed reaches the loop, so no refused property
            // can reach the Formal_Oracle and come back as a `Verified` label.
            expect(served.properties).toEqual([]);
            emptied.add(outcome);
          } else {
            // And an admitted set is passed through by IDENTITY, not rebuilt, so nothing can be
            // quietly dropped on the way.
            expect(served.properties).toBe(authored.properties);
            passedThrough.add(outcome);
          }

          // The stamp is the GATE's outcome in every case, overwriting the author's own. This is
          // what makes the loop's refusal guard reachable at all on a gated eval run.
          expect(served.propertySetAdmitted).toBe(outcome);

          // A refusal judges the expressed properties and says nothing about the criteria the
          // author could not express, so those survive either way.
          expect(served.unexpressedCriteria).toEqual(authored.unexpressedCriteria);
        },
      ),
      propertyParameters({ numRuns: 300 }),
    );

    // Non-vacuity, and the partition: every outcome was drawn, and each landed on exactly one
    // side. A vocabulary member that reached neither set would mean the generator missed it.
    const seen = [...emptied, ...passedThrough].sort();
    expect(seen).toEqual([...PROPERTY_SET_ADMISSION_OUTCOMES].sort());
    expect([...emptied].some((outcome) => passedThrough.has(outcome))).toBe(false);
    // And both sides were populated, so neither clause passed by never being exercised.
    expect(emptied.size).toBeGreaterThan(0);
    expect(passedThrough.size).toBeGreaterThan(0);
  });

  it('agrees with the predicate rather than with a hardcoded member name', () => {
    // The guard that keeps this file honest if the vocabulary moves: the set of falling-back
    // outcomes is read from the predicate, so this assertion documents today's answer without
    // the property above depending on it.
    const fallingBack = PROPERTY_SET_ADMISSION_OUTCOMES.filter(propertySetAdmissionFallsBack);

    expect(fallingBack).toEqual(['refused']);
  });
});
