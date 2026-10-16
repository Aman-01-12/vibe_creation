// Unit tests for `AdmissionStampingPropertySource` (Req 6.3, 6.4, 6.5; task 9.2).
//
// WHAT THESE PIN DOWN
//   The stamp is the whole reason the loop's refusal guard is reachable on a gated eval run:
//   the `PropertyAgent` stamps every set `'not-gated'`, so without this decorator a refused set
//   would carry `'not-gated'` into the loop and be submitted. So every case asserts the stamp
//   that comes out, not just the properties, and the fallback member is distinguished from the
//   three that are not by exhausting the vocabulary rather than by restating `'refused'`.

import { describe, expect, it } from 'vitest';

import {
  PROPERTY_SET_ADMISSION_OUTCOMES,
  type FormalPropertySet,
  type PropertySetAdmissionOutcome,
  type PropertySetSource,
  type SessionBudgetHandle,
} from '@app/agent';
import type { Spec } from '@app/core';

import { AdmissionStampingPropertySource } from './admission-stamping-property-source.js';
import { propertySetAdmissionFallsBack } from './property-set-admission.js';

/**
 * An opaque Spec token. This decorator forwards the Spec and never reads it, so identity is
 * the only property worth asserting and a full fixture would assert nothing extra.
 */
const SPEC = {} as Spec;

/** A budget handle the fake author never charges. */
const BUDGET: SessionBudgetHandle = {
  sessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  canAfford: () => true,
  charge: () => null,
  stopReason: () => null,
};

/** Opaque property tokens, for the same reason `SPEC` is opaque: only identity is read. */
const PROPERTIES = [{}, {}] as unknown as FormalPropertySet['properties'];

/** An inner source handing back the set as the `PropertyAgent` stamps it: `'not-gated'`. */
class AuthoringSource implements PropertySetSource {
  readonly calls: { spec: Spec; budget: SessionBudgetHandle }[] = [];
  readonly set: FormalPropertySet = {
    properties: PROPERTIES,
    unexpressedCriteria: ['AC-4'],
    propertySetAdmitted: 'not-gated',
  };

  propertySetFor(spec: Spec, budget: SessionBudgetHandle): Promise<FormalPropertySet> {
    this.calls.push({ spec, budget });
    return Promise.resolve(this.set);
  }
}

/** The set a sample would be handed under one admission outcome. */
async function stamped(outcome: PropertySetAdmissionOutcome): Promise<FormalPropertySet> {
  const source = new AdmissionStampingPropertySource(new AuthoringSource(), outcome);
  return source.propertySetFor(SPEC, BUDGET);
}

describe('AdmissionStampingPropertySource - a refused set carries nothing (Req 6.3, 6.4)', () => {
  it('empties the properties of a refused set', async () => {
    const set = await stamped('refused');

    expect(set.properties).toEqual([]);
    expect(set.propertySetAdmitted).toBe('refused');
  });

  it('keeps the unexpressed criteria of a refused set, which a refusal does not make untrue', async () => {
    const set = await stamped('refused');

    expect(set.unexpressedCriteria).toEqual(['AC-4']);
  });

  it('passes an admitted set through with its properties intact', async () => {
    const set = await stamped('admitted');

    expect(set.properties).toBe(PROPERTIES);
    expect(set.propertySetAdmitted).toBe('admitted');
  });

  it('empties exactly the outcomes that fall back, over the whole vocabulary', async () => {
    // Driven off `propertySetAdmissionFallsBack` rather than a restated `'refused'`, so a fifth
    // member, or a second member flipped to fall back, is covered here without an edit.
    const emptied: PropertySetAdmissionOutcome[] = [];
    for (const outcome of PROPERTY_SET_ADMISSION_OUTCOMES) {
      const set = await stamped(outcome);

      expect(set.propertySetAdmitted).toBe(outcome);
      if (set.properties.length === 0) emptied.push(outcome);
    }

    expect(emptied).toEqual(PROPERTY_SET_ADMISSION_OUTCOMES.filter(propertySetAdmissionFallsBack));
  });
});

describe('AdmissionStampingPropertySource - delegation', () => {
  it('overwrites the inner stamp, which is what makes the loop guard reachable', async () => {
    const inner = new AuthoringSource();
    const source = new AdmissionStampingPropertySource(inner, 'refused');

    const set = await source.propertySetFor(SPEC, BUDGET);

    expect(inner.set.propertySetAdmitted).toBe('not-gated');
    expect(set.propertySetAdmitted).toBe('refused');
  });

  it('forwards the callers spec and budget once, so the sample pays one authoring', async () => {
    const inner = new AuthoringSource();
    const source = new AdmissionStampingPropertySource(inner, 'admitted');

    await source.propertySetFor(SPEC, BUDGET);

    expect(inner.calls).toEqual([{ spec: SPEC, budget: BUDGET }]);
  });

  it('reports an authoring failure to its caller rather than inventing a set', async () => {
    const failing: PropertySetSource = {
      propertySetFor: () => Promise.reject(new Error('the property author is unavailable')),
    };
    const source = new AdmissionStampingPropertySource(failing, 'admitted');

    await expect(source.propertySetFor(SPEC, BUDGET)).rejects.toThrow('unavailable');
  });
});
