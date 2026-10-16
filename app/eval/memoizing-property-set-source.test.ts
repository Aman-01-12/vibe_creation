// Unit tests for `MemoizingPropertySetSource` (Req 6.7; task 9.1).
//
// WHAT THESE PIN DOWN
//   The gate and the loop are two callers of ONE authoring call. If a second call ever got
//   through, the sample would pay for a second model call and the recorded
//   `propertySetAdmitted` would describe a set the loop never saw. So the counting inner source
//   below is the whole point: every case asserts both the call count and object identity.

import { describe, expect, it } from 'vitest';

import type { FormalPropertySet, PropertySetSource, SessionBudgetHandle } from '@app/agent';
import type { Spec } from '@app/core';

import { MemoizingPropertySetSource } from './memoizing-property-set-source.js';

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

/** One authored set, shaped as the loop receives it on an ungated path. */
function propertySet(): FormalPropertySet {
  return { properties: [], unexpressedCriteria: ['q follows d'], propertySetAdmitted: 'not-gated' };
}

/** An inner source that records every call and hands back one fixed set. */
class CountingSource implements PropertySetSource {
  readonly calls: { spec: Spec; budget: SessionBudgetHandle }[] = [];
  readonly set = propertySet();

  propertySetFor(spec: Spec, budget: SessionBudgetHandle): Promise<FormalPropertySet> {
    this.calls.push({ spec, budget });
    return Promise.resolve(this.set);
  }
}

/** An inner source whose authoring never succeeds, counted the same way. */
class FailingSource implements PropertySetSource {
  calls = 0;

  propertySetFor(): Promise<FormalPropertySet> {
    this.calls += 1;
    return Promise.reject(new Error('the property author is unavailable'));
  }
}

describe('MemoizingPropertySetSource - one authoring per sample (Req 6.7)', () => {
  it('serves two sequential callers the identical set from one authoring call', async () => {
    const inner = new CountingSource();
    const source = new MemoizingPropertySetSource(inner);

    const first = await source.propertySetFor(SPEC, BUDGET);
    const second = await source.propertySetFor(SPEC, BUDGET);

    expect(inner.calls).toHaveLength(1);
    expect(first).toBe(inner.set);
    expect(second).toBe(first);
  });

  it('authors once for callers that overlap, so an overlap cannot buy a second model call', async () => {
    const inner = new CountingSource();
    const source = new MemoizingPropertySetSource(inner);

    const [first, second] = await Promise.all([
      source.propertySetFor(SPEC, BUDGET),
      source.propertySetFor(SPEC, BUDGET),
    ]);

    expect(inner.calls).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('forwards the first callers spec and budget, which is what charges the sample', async () => {
    const inner = new CountingSource();
    const source = new MemoizingPropertySetSource(inner);
    const otherBudget: SessionBudgetHandle = { ...BUDGET, sessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' };

    await source.propertySetFor(SPEC, BUDGET);
    await source.propertySetFor({} as Spec, otherBudget);

    expect(inner.calls).toEqual([{ spec: SPEC, budget: BUDGET }]);
  });

  it('does not re-enter an author that failed, and reports the failure to both callers', async () => {
    const inner = new FailingSource();
    const source = new MemoizingPropertySetSource(inner);

    await expect(source.propertySetFor(SPEC, BUDGET)).rejects.toThrow('unavailable');
    await expect(source.propertySetFor(SPEC, BUDGET)).rejects.toThrow('unavailable');

    expect(inner.calls).toBe(1);
    expect(source.authored()).toBeNull();
  });
});

describe('MemoizingPropertySetSource.authored', () => {
  it('is null before the first call and the authored object afterwards', async () => {
    const inner = new CountingSource();
    const source = new MemoizingPropertySetSource(inner);

    expect(source.authored()).toBeNull();
    await source.propertySetFor(SPEC, BUDGET);

    expect(source.authored()).toBe(inner.set);
    expect(inner.calls).toHaveLength(1);
  });
});
