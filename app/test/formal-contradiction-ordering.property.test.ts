// Feature: formal-gate-first-light, Property 35: A contradiction is recorded before the fixture
// moves.
//
// WHAT GOES WRONG WITHOUT THIS
//   The tempting repair for a surprising refutation is to edit the Fixture_Property until the
//   oracle agrees. Done before the contradiction is recorded, that erases the only evidence that
//   the instrument and its author ever disagreed, and the fixture then reads as though it was
//   always right. So the order is the claim: the contradiction is recorded first, the author's
//   expected verdict is left as stated while the contradiction is unadjudicated, and any later
//   change is carried BESIDE the adjudication rather than in place of it.
//
// HOW THE SEQUENCE IS GENERATED
//   Three positions for the change relative to the contradiction - before, after, and absent -
//   so the clause is falsifiable in each. The adjudication is drawn over all three arms, because
//   the unadjudicated one is the case that must hold the fixture still.
//
// Validates: Requirements 11.4, 11.5, 11.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import type { FormalVerdict } from '@app/tools';

import {
  notRealizable,
  realizable,
  recordContradiction,
  unadjudicated,
  type Adjudication,
  type CandidateFalseRefutation,
} from './formal-false-refutation.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 35: A contradiction is recorded before the fixture moves';

const DESIGN_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'probe',
  ports: [{ name: 'q', direction: 'output', width: 1 }],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
};

/** Evidence shape for the two attributions; its contents are not what this property reads. */
const EVIDENCE = { verdict: 'pass', failedChecks: [], exitCode: 0, vcd: null } as const;

/** Every adjudication arm, so the unadjudicated case is always in the population. */
const arbAdjudication: fc.Arbitrary<Adjudication> = fc.oneof(
  fc.constant(realizable(EVIDENCE)),
  fc.constant(notRealizable({ ...EVIDENCE, verdict: 'fail', failedChecks: ['c'] })),
  fc
    .constantFrom('probe-unavailable', 'referee-run-errored', 'name-unresolvable-in-scope' as const)
    .map((reason) => unadjudicated(reason)),
);

/** Where the Fixture_Property change sits relative to the contradiction record. */
const CHANGE_POSITIONS = ['before', 'after', 'absent'] as const;
type ChangePosition = (typeof CHANGE_POSITIONS)[number];

/** One entry in the modelled history, in the order it happened. */
type HistoryEntry =
  | { readonly kind: 'contradiction-recorded'; readonly authorExpectedVerdict: FormalVerdict }
  | { readonly kind: 'fixture-changed'; readonly toExpectedVerdict: FormalVerdict };

function candidate(expected: FormalVerdict): CandidateFalseRefutation {
  return {
    propertyId: 'generated-probe',
    designId: 'rtllm/memory/LIFObuffer',
    design: { path: 'probe.v', contents: 'module probe; endmodule\n' },
    designInterface: DESIGN_INTERFACE,
    expectedVerdict: expected,
    actualVerdict: 'refuted',
    counterexample: '$scope module w $end\n$var wire 1 n0 q $end\n$upscope $end\n#0\nb0 n0',
    resetContract: { kind: 'synchronous', polarity: 'active-high' },
  };
}

/**
 * Replay one history and report whether the contradiction was on the record before the change.
 *
 * Derived from the entry order alone, so it is an independent reading of the sequence rather
 * than a restatement of `recordContradiction`'s own result.
 */
function contradictionPrecededChange(history: readonly HistoryEntry[]): boolean {
  const recordedAt = history.findIndex((entry) => entry.kind === 'contradiction-recorded');
  const changedAt = history.findIndex((entry) => entry.kind === 'fixture-changed');
  if (changedAt === -1) {
    return true;
  }
  return recordedAt !== -1 && recordedAt < changedAt;
}

describe(PROPERTY, () => {
  it('holds the fixture still while the contradiction is unadjudicated, over every arm', () => {
    const seenArms = new Set<string>();

    fc.assert(
      fc.property(arbAdjudication, (adjudication) => {
        const record = recordContradiction(candidate('proved'), adjudication);
        seenArms.add(adjudication.kind);

        // The whole ordering rule, in one place: the fixture may move only once something has
        // established which side was wrong.
        expect(record.fixtureMayMove).toBe(adjudication.kind !== 'unadjudicated');
        // And the author's verdict survives either way, which is what makes the record readable
        // after a later change.
        expect(record.authorExpectedVerdict).toBe('proved');
        expect(record.candidate.expectedVerdict).toBe('proved');
        // The adjudication is carried BESIDE the candidate, not folded into it.
        expect(record.adjudication).toEqual(adjudication);
      }),
      propertyParameters(),
    );

    expect([...seenArms].sort()).toEqual(['not-realizable', 'realizable', 'unadjudicated']);
  });

  it('accepts a history only when the contradiction precedes the change, in all three positions', () => {
    const seen = new Set<ChangePosition>();

    fc.assert(
      fc.property(
        fc.constantFrom(...CHANGE_POSITIONS),
        arbAdjudication,
        fc.constantFrom<FormalVerdict>('proved', 'refuted', 'could-not-verify'),
        (position, adjudication, movedTo) => {
          seen.add(position);
          const recorded: HistoryEntry = {
            kind: 'contradiction-recorded',
            authorExpectedVerdict: 'proved',
          };
          const changed: HistoryEntry = { kind: 'fixture-changed', toExpectedVerdict: movedTo };
          const history: readonly HistoryEntry[] =
            position === 'before'
              ? [changed, recorded]
              : position === 'after'
                ? [recorded, changed]
                : [recorded];

          // `absent` and `after` are the orders the requirement admits; `before` is the one it
          // forbids, and it is generated so the clause cannot pass by never seeing a violation.
          expect(contradictionPrecededChange(history)).toBe(position !== 'before');

          // A change is only legitimate at all once the contradiction is adjudicated, so an
          // unadjudicated record plus a change is a violation whichever order they are in.
          const record = recordContradiction(candidate('proved'), adjudication);
          const changeIsLegitimate =
            position === 'absent' ||
            (record.fixtureMayMove && contradictionPrecededChange(history));
          expect(changeIsLegitimate).toBe(
            position === 'absent' ||
              (adjudication.kind !== 'unadjudicated' && position === 'after'),
          );
        },
      ),
      propertyParameters({ numRuns: 300 }),
    );

    expect([...seen].sort()).toEqual([...CHANGE_POSITIONS].sort());
  });
});
