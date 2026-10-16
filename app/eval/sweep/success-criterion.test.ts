// Feature: testbench-in-order-scoreboard, Property 18: Success_Criterion evaluator agrees with
// an independent oracle. The oracle is written from Requirement 10's text with integer counts
// and cross-multiplied agreement, and shares no helper with `success-criterion.ts`.
// Validates: Requirements 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 10.13.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  evaluateSuccessCriterion,
  PRE_REGISTERED_SUCCESS_CRITERION,
  type ModelArmStreamingFigures,
  type StreamingFigures,
} from './success-criterion.js';

/** Small counts, so ties, all-zero cells, and undefined agreements are frequent. */
const arbFigures: fc.Arbitrary<StreamingFigures> = fc
  .record({
    records: fc.nat({ max: 4 }),
    instrumentValid: fc.nat({ max: 4 }),
    missedBug: fc.nat({ max: 2 }),
    judged: fc.nat({ max: 3 }),
    agreedRaw: fc.nat({ max: 3 }),
  })
  .map(({ agreedRaw, ...rest }) => ({ ...rest, agreed: Math.min(agreedRaw, rest.judged) }));

const arbArm = (index: number): fc.Arbitrary<ModelArmStreamingFigures> =>
  fc.record({
    modelArm: fc.constant(`model-${index}`),
    control: arbFigures,
    treatment: arbFigures,
    cycleExactInstrumentValid: fc.record({
      control: fc.nat({ max: 4 }),
      treatment: fc.nat({ max: 4 }),
    }),
  });

/** Eleven Model_Arms, most of the time; occasionally a wrong count to exercise the fail-safe. */
const arbArms = fc.oneof(
  { weight: 9, arbitrary: fc.tuple(...Array.from({ length: 11 }, (_, i) => arbArm(i))) },
  { weight: 1, arbitrary: fc.array(arbArm(0), { maxLength: 12 }) },
);

/** Requirement 10, read literally. */
function oracleVerdict(arms: readonly ModelArmStreamingFigures[], deferred: number): string {
  if (deferred > 0 || arms.length !== 11) {
    return 'not-decided';
  }
  let greater = 0;
  let missedOk = true;
  let lower = 0;
  let streamT = 0;
  let streamC = 0;
  let exactT = 0;
  let exactC = 0;
  for (const arm of arms) {
    const c = arm.control;
    const t = arm.treatment;
    if (t.instrumentValid > c.instrumentValid) greater += 1;
    if (t.missedBug > c.missedBug) missedOk = false;
    // 10.13: an undefined agreement on either arm counts as lower.
    if (c.judged === 0 || t.judged === 0 || t.agreed * c.judged < c.agreed * t.judged) lower += 1;
    streamT += t.instrumentValid;
    streamC += c.instrumentValid;
    exactT += arm.cycleExactInstrumentValid.treatment;
    exactC += arm.cycleExactInstrumentValid.control;
  }
  const noise = exactT >= exactC ? exactT - exactC : exactC - exactT;
  const all = greater >= 9 && missedOk && lower <= 2 && streamT - streamC > noise;
  return all ? 'succeeded' : 'failed';
}

describe('Property 18: Success_Criterion evaluator agrees with an independent oracle', () => {
  it('returns the oracle verdict, with null criteria exactly when not decided', () => {
    fc.assert(
      fc.property(arbArms, fc.oneof(fc.constant(0), fc.nat({ max: 3 })), (arms, deferred) => {
        const report = evaluateSuccessCriterion(PRE_REGISTERED_SUCCESS_CRITERION, arms, deferred);
        expect(report.verdict).toBe(oracleVerdict(arms, deferred));
        expect(report.perModelArm).toEqual(arms);
        const criteria = Object.values(report.criteria);
        expect(criteria.every((c) => c === null)).toBe(report.verdict === 'not-decided');
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic over the same figures', () => {
    fc.assert(
      fc.property(arbArms, (arms) => {
        expect(evaluateSuccessCriterion(PRE_REGISTERED_SUCCESS_CRITERION, arms, 0)).toEqual(
          evaluateSuccessCriterion(PRE_REGISTERED_SUCCESS_CRITERION, arms, 0),
        );
      }),
    );
  });

  it('counts a tie as not greater, so eleven ties fail', () => {
    const tie: StreamingFigures = {
      records: 4,
      instrumentValid: 2,
      missedBug: 0,
      judged: 2,
      agreed: 2,
    };
    const arms = Array.from({ length: 11 }, (_, i) => ({
      modelArm: `m${i}`,
      control: tie,
      treatment: tie,
      cycleExactInstrumentValid: { control: 0, treatment: 0 },
    }));
    const report = evaluateSuccessCriterion(PRE_REGISTERED_SUCCESS_CRITERION, arms, 0);
    expect(report.verdict).toBe('failed');
    expect(report.criteria.instrumentValidGreater?.observed).toBe(0);
  });
});
