// Feature: formal-gate-first-light, Property 8: A surprising refutation is recorded as a
// candidate with its evidence.
//
// THE CLAIM IS AN EXACTLY-WHEN, SO BOTH DIRECTIONS ARE GENERATED
//   Recording a candidate for a pair that is not a contradiction would manufacture findings;
//   failing to record one for the pair that IS a contradiction would lose the only signal the
//   False_Refutation probe exists to produce. So every pair of expected and actual Formal_Verdict
//   is drawn, and the single admitted pair is asserted to be `proved` expected with `refuted`
//   returned - never read off the implementation's own predicate.
//
// AND THE EVIDENCE IS PART OF THE CLAIM
//   A candidate with no Counterexample and no Reset_Contract is not actionable: adjudication
//   replays the trace, and the contract is the thing under suspicion. So a recorded candidate is
//   asserted to carry both, and to leave the author's expected verdict exactly as stated.
//
// Validates: Requirements 4.2, 4.3, 4.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import { FORMAL_VERDICTS, type FormalVerdict } from '@app/tools';

import {
  isCandidateShape,
  recordContradiction,
  unadjudicated,
  type CandidateFalseRefutation,
} from './formal-false-refutation.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 8: A surprising refutation is recorded as a candidate with its evidence';

const DESIGN_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'probe',
  ports: [{ name: 'q', direction: 'output', width: 1 }],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
};

/** The one pair that is a contradiction, stated here rather than read from the subject. */
const CONTRADICTION: readonly [FormalVerdict, FormalVerdict] = ['proved', 'refuted'];

/** Obviously-fake trace text; no assertion reads its bytes, only that it is carried. */
const TRACE = '$scope module w $end\n$var wire 1 n0 q $end\n$upscope $end\n#0\nb0 n0';

function candidateWith(
  expected: FormalVerdict,
  actual: FormalVerdict,
  counterexample: string,
  resetContract: CandidateFalseRefutation['resetContract'],
): CandidateFalseRefutation {
  return {
    propertyId: 'generated-probe',
    designId: 'rtllm/memory/LIFObuffer',
    design: { path: 'probe.v', contents: 'module probe; endmodule\n' },
    designInterface: DESIGN_INTERFACE,
    expectedVerdict: expected,
    actualVerdict: actual,
    counterexample,
    resetContract,
  };
}

const arbResetContract = fc.oneof(
  fc.constant(null),
  fc.record({
    kind: fc.constantFrom('synchronous', 'asynchronous'),
    polarity: fc.constantFrom('active-high', 'active-low'),
  }),
);

describe(PROPERTY, () => {
  it('admits exactly the proved-expected, refuted-returned pair, over every pair', () => {
    const admitted: string[] = [];
    const rejected: string[] = [];

    fc.assert(
      fc.property(
        fc.constantFrom(...FORMAL_VERDICTS),
        fc.constantFrom(...FORMAL_VERDICTS),
        (expected, actual) => {
          const isContradiction = expected === CONTRADICTION[0] && actual === CONTRADICTION[1];

          expect(isCandidateShape(expected, actual)).toBe(isContradiction);
          (isContradiction ? admitted : rejected).push(`${expected}/${actual}`);
        },
      ),
      propertyParameters(),
    );

    // Non-vacuity in both directions: a one-sided population would pass while testing half.
    expect(admitted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
    // And the admitted set is one pair, not a family.
    expect([...new Set(admitted)]).toEqual([`${CONTRADICTION[0]}/${CONTRADICTION[1]}`]);
    expect(new Set(rejected).size).toBe(FORMAL_VERDICTS.length * FORMAL_VERDICTS.length - 1);
  });

  it('carries the Counterexample and the Reset_Contract onto every recorded candidate', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 60 }), arbResetContract, (suffix, reset) => {
        const trace = `${TRACE}\n${suffix}`;
        const candidate = candidateWith(...CONTRADICTION, trace, reset);
        const record = recordContradiction(candidate, unadjudicated('probe-unavailable'));

        // The evidence an adjudication needs reaches the record unaltered.
        expect(record.candidate.counterexample).toBe(trace);
        expect(record.candidate.resetContract).toEqual(reset);
        // And the author's verdict is carried as stated, which is what keeps the record readable
        // after the fixture later moves.
        expect(record.authorExpectedVerdict).toBe(CONTRADICTION[0]);
      }),
      propertyParameters(),
    );
  });
});
