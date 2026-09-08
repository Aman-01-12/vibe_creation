// Unit and property tests for the independent judge's two aggregations.
//
// THE AGREEMENT SUMMARY
//   The cell that matters is `loopPassGoldenFail`: our spec-derived testbench said pass
//   and the independent judge said fail. Each one is a bug our testbench missed, so it
//   is the direct falsification of "our testbenches are good enough". The second thing
//   these tests pin down is that an UNJUDGED run reports rate 0, not 1 - an environment
//   with no judge wired must never read as perfect agreement.
//
// THE GOLDEN DENOMINATOR
//   The rest of this file is about the second pass@k denominator: the samples the
//   INDEPENDENT judge returned a verdict on the candidate's BEHAVIOUR for. Its whole job
//   is to be citable, which means every sample outside it has to be counted under the one
//   reason that put it there. Two properties hold that:
//
//     Property 1  the denominator admits exactly the samples that both reached an oracle
//                 verdict and carry `passed` or `failed`
//     Property 2  judged + the five exclusions equals the arm's recorded sample count
//
//   The generator emits EVERY combination of outcome status and golden kind including
//   `null`, deliberately: a generator that never emitted `did-not-build` would let
//   Property 1 pass while that exclusion was unimplemented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  countsInGoldenPassAtK,
  NO_AGREEMENT_MEASURED,
  NO_GOLDEN_PASS_AT_K_MEASURED,
  RECORDED_GOLDEN_KINDS,
  summarizeAgreement,
  summarizeGoldenPassAtK,
  type GoldenPassAtKEligibility,
  type RecordedGoldenKind,
  type VerdictPair,
} from './golden-judge.js';
import type { SampleOutcomeStatus } from './report.js';

/** A judged pair: the loop's verdict and the golden verdict. */
function pair(loopPassed: boolean, goldenKind: RecordedGoldenKind): VerdictPair {
  return { loopPassed, golden: { kind: goldenKind, failureCount: null } };
}

/** An unjudged pair: the loop produced no candidate, or no judge was available. */
function unjudged(loopPassed: boolean): VerdictPair {
  return { loopPassed, golden: null };
}

describe('summarizeAgreement - agreement', () => {
  it('counts a mutual pass and a mutual fail as agreement', () => {
    const report = summarizeAgreement([pair(true, 'passed'), pair(false, 'failed')]);
    expect(report.judgedSamples).toBe(2);
    expect(report.agreeingSamples).toBe(2);
    expect(report.agreementRate).toBe(1);
    expect(report.loopPassGoldenFail).toBe(0);
    expect(report.loopFailGoldenPass).toBe(0);
  });

  it('treats a golden no-verdict as not-passed, so a loop pass against it disagrees', () => {
    // A candidate that does not even build under the golden testbench has not passed.
    const report = summarizeAgreement([pair(true, 'did-not-build')]);
    expect(report.agreeingSamples).toBe(0);
    expect(report.loopPassGoldenFail).toBe(1);
  });
});

describe('summarizeAgreement - the disagreement that matters', () => {
  it('counts a loop pass that the independent judge failed', () => {
    // This is a bug the agent's own testbench did not catch.
    const report = summarizeAgreement([pair(true, 'failed')]);
    expect(report.judgedSamples).toBe(1);
    expect(report.agreeingSamples).toBe(0);
    expect(report.agreementRate).toBe(0);
    expect(report.loopPassGoldenFail).toBe(1);
    expect(report.loopFailGoldenPass).toBe(0);
  });

  it('counts a loop fail that the independent judge passed separately', () => {
    // The opposite direction: our testbench was stricter than the benchmark's.
    const report = summarizeAgreement([pair(false, 'passed')]);
    expect(report.loopFailGoldenPass).toBe(1);
    expect(report.loopPassGoldenFail).toBe(0);
  });

  it('computes the rate over judged samples only', () => {
    const report = summarizeAgreement([
      pair(true, 'passed'),
      pair(true, 'passed'),
      pair(true, 'failed'),
      pair(false, 'failed'),
    ]);
    expect(report.judgedSamples).toBe(4);
    expect(report.agreeingSamples).toBe(3);
    expect(report.agreementRate).toBeCloseTo(0.75, 12);
  });
});

describe('summarizeAgreement - unjudged samples', () => {
  it('excludes unjudged samples from the rate rather than counting them as agreement', () => {
    // A blocked or setup-failed sample produced no RTL: there is nothing to judge, and
    // folding it in as agreement would flatter the number.
    const report = summarizeAgreement([pair(true, 'passed'), unjudged(false), unjudged(true)]);
    expect(report.judgedSamples).toBe(1);
    expect(report.agreementRate).toBe(1);
  });

  it('reports rate 0 for a run where nothing was judged, never 1', () => {
    const report = summarizeAgreement([unjudged(true), unjudged(false)]);
    expect(report.judgedSamples).toBe(0);
    expect(report.agreementRate).toBe(0);
    expect(report).toEqual(NO_AGREEMENT_MEASURED);
  });

  it('reports the empty summary for an empty run', () => {
    expect(summarizeAgreement([])).toEqual(NO_AGREEMENT_MEASURED);
  });
});

/** Every outcome status, so the no-oracle-verdict exclusion is never left unexercised. */
const OUTCOME_STATUSES: readonly SampleOutcomeStatus[] = Object.freeze([
  'verified',
  'unverified',
  'blocked',
  'setup-failed',
  'runner-error',
]);

/** The statuses that carry an oracle verdict, restated from Requirement 2.3's own words. */
const VERDICT_BEARING: readonly SampleOutcomeStatus[] = Object.freeze(['verified', 'unverified']);

/** One sample's eligibility facts; each test states only what it is about. */
function eligibility(
  outcomeStatus: SampleOutcomeStatus,
  goldenKind: RecordedGoldenKind | null,
): GoldenPassAtKEligibility {
  return {
    outcomeStatus,
    golden: goldenKind === null ? null : { kind: goldenKind, failureCount: null },
  };
}

/**
 * Every combination of outcome status and golden kind, `null` included.
 *
 * Built as a cross product rather than as two independent arbitraries so the generator
 * cannot miss a combination by chance - `did-not-build` on a `verified` sample is the exact
 * case a naive implementation gets wrong, and it must be drawn from every run.
 */
const eligibilityArbitrary: fc.Arbitrary<GoldenPassAtKEligibility> = fc.constantFrom(
  ...OUTCOME_STATUSES.flatMap((status) =>
    [...RECORDED_GOLDEN_KINDS, null].map((kind) => eligibility(status, kind)),
  ),
);

describe('countsInGoldenPassAtK - the golden denominator membership rule', () => {
  it('admits a judged sample the independent judge PASSED', () => {
    expect(countsInGoldenPassAtK(eligibility('verified', 'passed'))).toBe(true);
  });

  it('admits a judged sample the independent judge FAILED', () => {
    // A failure IS a verdict on the candidate's behaviour, so it belongs in the denominator
    // even though it is not in the numerator. Excluding it would make the number a pass rate
    // over passes.
    expect(countsInGoldenPassAtK(eligibility('unverified', 'failed'))).toBe(true);
  });

  it('EXCLUDES a sample that reached no oracle verdict, whatever the judge said', () => {
    // The flow never handed the judge a candidate, so counting it would score a rate-limit
    // burst or a harness crash as a model failure.
    for (const status of ['blocked', 'setup-failed', 'runner-error'] as const) {
      expect(countsInGoldenPassAtK(eligibility(status, 'passed'))).toBe(false);
      expect(countsInGoldenPassAtK(eligibility(status, null))).toBe(false);
    }
  });

  it('EXCLUDES a sample with no golden outcome at all', () => {
    expect(countsInGoldenPassAtK(eligibility('verified', null))).toBe(false);
  });

  it('EXCLUDES each of the three no-verdict causes', () => {
    // The judge reported nothing about the candidate's behaviour in any of these, so none of
    // them is evidence about the model.
    for (const kind of ['did-not-build', 'no-output', 'timed-out'] as const) {
      expect(countsInGoldenPassAtK(eligibility('verified', kind))).toBe(false);
    }
  });
});

describe('golden denominator - Property 1', () => {
  // Feature: eval-campaign-readiness, Property 1: The golden denominator excludes every
  // sample the judge did not judge.
  //
  // Validates: Requirements 2.2, 2.3, 2.4, 2.5
  it('admits exactly the samples that reached a verdict AND carry passed or failed', () => {
    fc.assert(
      fc.property(fc.array(eligibilityArbitrary, { maxLength: 40 }), (samples) => {
        const admitted = samples.filter((sample) => countsInGoldenPassAtK(sample)).length;
        // The requirement restated in its own words, NOT by calling the predicate again.
        const expected = samples.filter(
          (sample) =>
            VERDICT_BEARING.includes(sample.outcomeStatus) &&
            (sample.golden?.kind === 'passed' || sample.golden?.kind === 'failed'),
        ).length;

        expect(admitted).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});

describe('golden denominator - Property 2', () => {
  // Feature: eval-campaign-readiness, Property 2: The golden report partitions the arm.
  //
  // Validates: Requirements 2.6, 2.9
  it('sums judged plus the five exclusion counts to the arm sample count', () => {
    fc.assert(
      fc.property(fc.array(eligibilityArbitrary, { maxLength: 40 }), (samples) => {
        const report = summarizeGoldenPassAtK(samples);

        expect(
          report.judgedSamples +
            report.noCandidateSamples +
            report.unjudgedSamples +
            report.didNotBuildSamples +
            report.noOutputSamples +
            report.timedOutSamples,
        ).toBe(samples.length);
        // The denominator the report describes is the one the predicate admits, so the
        // block cannot print a size the estimator did not use.
        expect(report.judgedSamples).toBe(
          samples.filter((sample) => countsInGoldenPassAtK(sample)).length,
        );
        // The numerator is a SUBSET of the denominator, never a sixth bucket.
        expect(report.goldenPassedSamples).toBeLessThanOrEqual(report.judgedSamples);
      }),
      { numRuns: 200 },
    );
  });
});

describe('summarizeGoldenPassAtK - counting the exclusions', () => {
  it('counts each no-verdict cause under its own reason', () => {
    const report = summarizeGoldenPassAtK([
      eligibility('verified', 'passed'),
      eligibility('unverified', 'failed'),
      eligibility('verified', 'did-not-build'),
      eligibility('verified', 'no-output'),
      eligibility('verified', 'timed-out'),
      eligibility('verified', null),
      eligibility('setup-failed', null),
    ]);

    expect(report.judgedSamples).toBe(2);
    expect(report.goldenPassedSamples).toBe(1);
    expect(report.didNotBuildSamples).toBe(1);
    expect(report.noOutputSamples).toBe(1);
    expect(report.timedOutSamples).toBe(1);
    expect(report.unjudgedSamples).toBe(1);
    expect(report.noCandidateSamples).toBe(1);
  });

  it('counts a no-oracle-verdict sample as no-candidate even when it carries a golden kind', () => {
    // The results file is untrusted input, so a golden kind can turn up on a slot the loop
    // never got a candidate out of. It is still not a judged sample, and it must land in
    // exactly one bucket.
    const report = summarizeGoldenPassAtK([eligibility('runner-error', 'passed')]);

    expect(report.noCandidateSamples).toBe(1);
    expect(report.judgedSamples).toBe(0);
    expect(report.goldenPassedSamples).toBe(0);
  });

  it('reports the empty report for an arm with no samples', () => {
    expect(summarizeGoldenPassAtK([])).toEqual(NO_GOLDEN_PASS_AT_K_MEASURED);
  });
});
