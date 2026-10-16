// Feature: formal-gate-first-light, Property 22: Run shape maps to exactly one of three
// distinct exit statuses.
//
// WHAT IS UNDER TEST
//   `runShapeOf` partitions a finished run, and `runExitStatus` is a pure total function of
//   that partition. The claim has two halves: the partition loses no sample, and the status is
//   a CLOSED three-way decision rather than the boolean over `CLEAN_STOP_REASONS` that let the
//   pilot's all-deferred run exit 0.
//
// THE ORACLE IS THE DESIGN TABLE, NOT THE IMPLEMENTATION'S IF-ORDER
//   `matchingStatuses` restates the three rows of the Component 15 table as DISJOINT
//   conditions. The implementation reaches the same answer by ordered guards, so re-deriving
//   it this way is what proves the order is the precedence: if any guard were reordered, a
//   shape would match a row this file disagrees with, and the pair would diverge. Asserting
//   the match list has length 1 is the "exactly one" half of the property - the three rows
//   overlap on their faces (a run that measured nothing can also hold a refusal), and the
//   precedence is what makes the mapping a function.
//
// STOP REASONS ARE EXHAUSTED, NOT SAMPLED
//   `CLEAN_BY_STOP_REASON` is a total `Record` over the closed vocabulary, so a sixth stop
//   reason cannot be added without this file failing to compile - the same device
//   `app/eval/no-verdict-cause.ts` uses. The generator draws from its keys, so no reason is
//   left ungraded.
//
// Not `propertyTag(22, ...)`: that helper's `FEATURE_TAG` is another spec's slug, whose
// Property 22 is a different claim.
//
// Validates: Requirements 7.6, 7.8, 7.9
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  runExitStatus,
  runShapeOf,
  type RunShape,
  type SweepRunResult,
  type SweepStopReason,
} from '@app/eval';

import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 22: Run shape maps to exactly one of three distinct exit statuses';

/**
 * Whether each stop reason is an operator-configured ending rather than a problem.
 *
 * Total over `SweepStopReason` on purpose: a new member must be classified here before this
 * file compiles, so the vocabulary cannot grow past the property silently.
 */
const CLEAN_BY_STOP_REASON: Readonly<Record<SweepStopReason, boolean>> = Object.freeze({
  completed: true,
  'wall-clock-exhausted': true,
  'sample-limit-reached': true,
  'provider-outage': false,
  'results-log-unwritable': false,
});

const STOP_REASONS = Object.keys(CLEAN_BY_STOP_REASON) as readonly SweepStopReason[];

/** The three statuses the taxonomy is closed over. */
const STATUSES: readonly [0, 1, 2] = [0, 1, 2];

/** One finished run's counters, coherent with each other. */
function resultOf(
  stopReason: SweepStopReason,
  dispatchedSamples: number,
  failedSamples: number,
): SweepRunResult {
  return {
    stopReason,
    plannedSamples: dispatchedSamples,
    skippedSamples: 0,
    dispatchedSamples,
    recordedSamples: dispatchedSamples,
    failedSamples,
  };
}

/** A run and the Auth_Failure_Cause count the watch observed for it. */
interface GeneratedRun {
  readonly result: SweepRunResult;
  readonly authFailureSamples: number;
}

/**
 * Run shapes varying the stop reason, the completed count and the presence of a refusal.
 *
 * The counts are nested rather than independent because a sample deferred for a refusal is one
 * that did not complete: `authFailureSamples <= failedSamples <= dispatchedSamples`. Drawing
 * them independently would spend most runs on shapes the runner cannot produce.
 */
function arbRun(): fc.Arbitrary<GeneratedRun> {
  return fc
    .tuple(fc.constantFrom(...STOP_REASONS), fc.integer({ min: 0, max: 20 }))
    .chain(([stopReason, dispatched]) =>
      fc.integer({ min: 0, max: dispatched }).chain((failed) =>
        fc.integer({ min: 0, max: failed }).map((authFailureSamples) => ({
          result: resultOf(stopReason, dispatched, failed),
          authFailureSamples,
        })),
      ),
    );
}

/**
 * Which rows of the Component 15 table a shape satisfies, as disjoint conditions.
 *
 * Status 1 absorbs the unmeasured run whatever stopped it, because there is no partial result
 * to resume from - which is why a refusal on a run that measured nothing is a 1 and not a 2.
 */
function matchingStatuses(shape: RunShape): readonly (0 | 1 | 2)[] {
  const measured = shape.completedSamples >= 1;
  const refused = shape.authFailureSamples > 0;
  const clean = CLEAN_BY_STOP_REASON[shape.stopReason];

  return [
    ...(measured && !refused && clean ? ([0] as const) : []),
    ...(!measured || (!refused && !clean) ? ([1] as const) : []),
    ...(measured && refused ? ([2] as const) : []),
  ];
}

describe(PROPERTY, () => {
  it('maps every run shape to exactly one of the three statuses', () => {
    fc.assert(
      fc.property(arbRun(), ({ result, authFailureSamples }) => {
        const shape = runShapeOf(result, authFailureSamples);
        const status = runExitStatus(shape);

        expect(STATUSES).toContain(status);
        expect(matchingStatuses(shape)).toEqual([status]);
      }),
      propertyParameters(),
    );
  });

  it('partitions the dispatched samples, so the two counts sum to what was dispatched', () => {
    // The counts come from the runner's own counters, so "dispatched" and "completed plus
    // not-completed" cannot disagree. A partition that lost a sample would let an all-deferred
    // run look measured, which is exactly the pilot's misreport.
    fc.assert(
      fc.property(arbRun(), ({ result, authFailureSamples }) => {
        const shape = runShapeOf(result, authFailureSamples);

        expect(shape.completedSamples + shape.notCompletedSamples).toBe(result.dispatchedSamples);
        expect(shape.completedSamples).toBeGreaterThanOrEqual(0);
        expect(shape.notCompletedSamples).toBeGreaterThanOrEqual(0);
      }),
      propertyParameters(),
    );
  });

  it('reaches all three statuses across the exhausted stop reasons', () => {
    // Non-vacuity, and the distinctness the status exists for: a clean partial stop and a
    // credential refusal on the same stop reason must not land on the same status, or a
    // wrapper script cannot tell "resume" from "refresh the credential first".
    const reached = new Set<0 | 1 | 2>();

    for (const stopReason of STOP_REASONS) {
      const measuredPartial = runShapeOf(resultOf(stopReason, 6, 2), 0);
      const refusedPartial = runShapeOf(resultOf(stopReason, 6, 2), 2);
      const measuredNothing = runShapeOf(resultOf(stopReason, 4, 4), 0);

      reached.add(runExitStatus(measuredPartial));
      reached.add(runExitStatus(refusedPartial));

      expect(runExitStatus(refusedPartial), stopReason).toBe(2);
      expect(runExitStatus(measuredPartial), stopReason).not.toBe(2);
      // The pilot's shape under every stop reason, including the clean ones.
      expect(runExitStatus(measuredNothing), stopReason).toBe(1);
      reached.add(runExitStatus(measuredNothing));
    }

    expect([...reached].sort()).toEqual([...STATUSES]);
  });
});
