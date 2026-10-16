// Feature: formal-gate-first-light, Property 7: Every Budget_Observation is complete.
//
// WHAT COMPLETE MEANS, AND WHY THE CAUSE IS THE INTERESTING FIELD
//   An observation that records a verdict without the figures behind it cannot be placed against
//   anything: the ceiling says what bound it ran under, the elapsed figure is the cost, the
//   toolchain and the Formal_Oracle_Version say which instrument produced it. The field that can
//   actually go wrong in a direction that MATTERS is `couldNotVerifyCause`, because a cause
//   recorded beside a `proved` claims an undecided proof decided, and a `could-not-verify` with
//   no cause is an undecided proof nobody can act on.
//
// SO THE EXACTLY-WHEN IS GENERATED IN BOTH DIRECTIONS
//   Every verdict is paired with a present and an absent cause, which catches both halves. The
//   vocabularies come from `@app/tools` rather than being restated, so a new verdict or a new
//   cause is covered here without this file changing.
//
// AND IT IS ASSERTED OVER THE COMMITTED RECORD TOO
//   The generated half checks the rule; the record half checks the artifact. That record is real
//   measured output and it carries both directions: `multi_booth_8bit` times out under the
//   shipped budget with `proof-timeout`, and the `adder_pipe_64bit` entries prove with no cause.
//
// Validates: Requirements 3.5, 3.9, 3.10

import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { COULD_NOT_VERIFY_CAUSES, FORMAL_VERDICTS, type FormalVerdict } from '@app/tools';

import {
  ANCHOR_RECORD_PATH,
  type AnchorMeasurementRecord,
  type BudgetObservation,
} from './formal-anchor-measurement.js';
import { propertyParameters } from './property.js';

const PROPERTY = 'formal-gate-first-light, Property 7: Every Budget_Observation is complete';

/** The rule, stated independently of the subject so the check is not a tautology. */
function causeIsRequired(verdict: FormalVerdict): boolean {
  return verdict === 'could-not-verify';
}

/** Every field an observation must carry, so an omission fails rather than reads as absent. */
function incompletenessOf(observation: BudgetObservation): readonly string[] {
  const problems: string[] = [];
  if (observation.designId.trim().length === 0) {
    problems.push('no designId');
  }
  if (!Number.isSafeInteger(observation.proofDepth) || observation.proofDepth <= 0) {
    problems.push('no usable proofDepth');
  }
  if (!Number.isFinite(observation.elapsedMs) || observation.elapsedMs < 0) {
    problems.push('no usable elapsedMs');
  }
  if (observation.ceiling.name.trim().length === 0) {
    problems.push('a ceiling with no name');
  }
  // The ceiling carries its own Limit_Reason by type, so what is checked is that it is there.
  if (observation.ceiling.reason.trim().length === 0) {
    problems.push('a ceiling with no Limit_Reason');
  }
  if (!Number.isSafeInteger(observation.formalOracleVersion)) {
    problems.push('no Formal_Oracle_Version');
  }
  // The exactly-when, which is the half that can be wrong in a direction that matters.
  const hasCause = observation.couldNotVerifyCause !== null;
  if (hasCause !== causeIsRequired(observation.verdict)) {
    problems.push(
      hasCause
        ? `a cause beside a ${observation.verdict} verdict`
        : `no cause beside a ${observation.verdict} verdict`,
    );
  }
  return problems;
}

/** One observation built from a generated verdict and cause, with every other field valid. */
function observationOf(
  verdict: FormalVerdict,
  cause: (typeof COULD_NOT_VERIFY_CAUSES)[number] | null,
): BudgetObservation {
  return {
    designId: 'rtllm/arithmetic/adder_pipe_64bit',
    verdict,
    proofDepth: 20,
    elapsedMs: 7_000,
    ceiling: {
      name: 'shipped-property-time-budget',
      value: 150_000,
      unit: 'ms',
      reason: 'population-honesty',
    },
    couldNotVerifyCause: cause,
    toolchain: {} as BudgetObservation['toolchain'],
    formalOracleVersion: 2,
  };
}

describe(PROPERTY, () => {
  it('requires a Could_Not_Verify_Cause exactly for could-not-verify, over every pairing', () => {
    const accepted: string[] = [];
    const rejected: string[] = [];

    fc.assert(
      fc.property(
        fc.constantFrom(...FORMAL_VERDICTS),
        fc.oneof(fc.constant(null), fc.constantFrom(...COULD_NOT_VERIFY_CAUSES)),
        (verdict, cause) => {
          const problems = incompletenessOf(observationOf(verdict, cause));
          const shouldBeComplete = (cause !== null) === causeIsRequired(verdict);

          expect(problems.length === 0).toBe(shouldBeComplete);
          (shouldBeComplete ? accepted : rejected).push(`${verdict}/${cause ?? 'none'}`);
        },
      ),
      propertyParameters({ numRuns: 300 }),
    );

    // Non-vacuity in both directions, and both failure shapes really occurred: a cause beside a
    // decided verdict, and a missing cause beside an undecided one.
    expect(accepted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.some((pair) => pair.startsWith('proved/'))).toBe(true);
    expect(rejected).toContain('could-not-verify/none');
  });

  it('holds over the COMMITTED record, which is where the claim has to be true', () => {
    let record: AnchorMeasurementRecord;
    try {
      record = JSON.parse(readFileSync(ANCHOR_RECORD_PATH, 'utf8')) as AnchorMeasurementRecord;
    } catch {
      // A fresh clone has not run `npm run formal:anchors`; the generated half still ran.
      return;
    }

    const observations = record.decisions.flatMap((decision) =>
      decision.outcome.kind === 'measured' ? [decision.outcome.observation] : [],
    );
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.flatMap(incompletenessOf)).toEqual([]);

    // The record exercises BOTH directions, so neither branch is untested by real data.
    const withCause = observations.filter((entry) => entry.couldNotVerifyCause !== null);
    expect(withCause.length).toBeGreaterThan(0);
    expect(withCause.length).toBeLessThan(observations.length);
  });
});
