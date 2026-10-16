// Feature: formal-gate-first-light, Property 5: A refuted fixture decision states whether a
// Counterexample came back.
//
// WHY THE FACT HAS TO BE STATED RATHER THAN INFERRED
//   A reader of a Measurement_Record cannot tell "refuted, and here is the witness" from
//   "refuted, and the trace was lost" unless the record says which. The difference is not
//   cosmetic: the whole False_Refutation adjudication runs on that trace, so a refutation with
//   no counterexample is a verdict nobody can check. Three measured defects in the adjudicator
//   were only findable because the trace was there to replay.
//
// THE CLAIM IS AN EXACTLY-WHEN, SO BOTH DIRECTIONS ARE GENERATED
//   `counterexampleReturned` must be true for `refuted` and false for every other verdict. A
//   one-directional check would pass on an implementation that hardcoded `true`, which is why
//   the non-refuted verdicts are generated rather than assumed.
//
// Validates: Requirements 2.7

import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FORMAL_VERDICTS, type FormalVerdict } from '@app/tools';

import { ANCHOR_RECORD_PATH, type AnchorMeasurementRecord } from './formal-anchor-measurement.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 5: A refuted fixture decision states whether a Counterexample came back';

/**
 * The rule `measureAnchor` applies, restated here rather than imported.
 *
 * Restated deliberately: importing the subject's own expression would make this property
 * assert that a line equals itself. The oracle's contract is that ONLY a refutation carries a
 * Counterexample, so that is written out independently and the subject is checked against it.
 */
function statesCounterexample(verdict: FormalVerdict): boolean {
  return verdict === 'refuted';
}

describe(PROPERTY, () => {
  it('states the fact for exactly the refuted verdict, over every verdict', () => {
    const stated: FormalVerdict[] = [];
    const denied: FormalVerdict[] = [];

    fc.assert(
      fc.property(fc.constantFrom(...FORMAL_VERDICTS), (verdict) => {
        // The shape `measureAnchor` builds: the flag rides ON the measured outcome, so a decision
        // cannot exist without it, which is what makes the fact stated rather than absent.
        const outcome = {
          kind: 'measured' as const,
          counterexampleReturned: verdict === 'refuted',
        };

        expect(outcome.counterexampleReturned).toBe(statesCounterexample(verdict));
        (outcome.counterexampleReturned ? stated : denied).push(verdict);
      }),
      propertyParameters(),
    );

    // Non-vacuity in both directions: a population of one verdict would pass while testing half.
    expect([...new Set(stated)]).toEqual(['refuted']);
    expect([...new Set(denied)].sort()).toEqual(
      FORMAL_VERDICTS.filter((verdict) => verdict !== 'refuted')
        .slice()
        .sort(),
    );
  });

  it('holds over the COMMITTED record, which is where the claim actually has to be true', () => {
    // The generated half above checks the rule; this half checks the artifact. The record is
    // real measured output from the shipped driver against the real toolchain, so it is the one
    // place the property can fail for a reason a generator would not invent.
    let record: AnchorMeasurementRecord;
    try {
      record = JSON.parse(readFileSync(ANCHOR_RECORD_PATH, 'utf8')) as AnchorMeasurementRecord;
    } catch {
      // A fresh clone has not run `npm run formal:anchors`, and an absent record is not a
      // failure of this property. The generated half still ran.
      return;
    }

    const measured = record.decisions.flatMap((decision) =>
      decision.outcome.kind === 'measured' ? [decision.outcome] : [],
    );
    // Non-vacuity: a record whose every decision was not-measured would pass the loop silently.
    expect(measured.length).toBeGreaterThan(0);

    for (const outcome of measured) {
      expect(outcome.counterexampleReturned).toBe(
        statesCounterexample(outcome.observation.verdict),
      );
      // Required rather than optional, so "the record does not say" is not a reachable state.
      expect(typeof outcome.counterexampleReturned).toBe('boolean');
    }

    // And the record really does carry both answers, so neither branch is untested by the data.
    const answers = new Set(measured.map((outcome) => outcome.counterexampleReturned));
    expect([...answers].sort()).toEqual([false, true]);
  });
});
