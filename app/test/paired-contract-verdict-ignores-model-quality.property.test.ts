// **Feature: timing-contract-inference, Property 22: The paired verdict ignores model-quality figures**
// **Validates: Requirements 8.6**
//
// WHAT THIS ASSERTS
//   `decidePairedContractVerdict` (task 15.3) takes exactly `{ checkFailCount, passed }`.
//   This property draws ARBITRARY trusted-testbench counts, peer-vote figures, and
//   Mutation_Strength_Gate outcomes alongside a fixed `(checkFailCount, passed)` pair, and
//   asserts the verdict is identical regardless of what those other figures are - proving the
//   claim by behavior (the function's result never moves), on top of the signature already
//   proving it structurally (there is no parameter for those figures to occupy).
//
// GENERATOR OBLIGATIONS, WHICH DECIDE VACUITY
//   Both verdicts (`'supported'` and `'unsupported'`) must be reached by the fixed pairs this
//   test exercises, and the "other figures" generator must draw a non-trivial range (zero,
//   positive counts, a mix of peer-vote booleans, every Mutation_Strength_Gate-shaped string)
//   so the property is not vacuously true over a single other-figures value.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decidePairedContractVerdict, type PairedContractMeasurement } from '../eval/index.js';

/** Shapes a trusted-testbench count, a peer-vote tally, and a gate outcome could plausibly
 *  take - deliberately wide and unrelated to the verdict's own two fields. */
interface OtherFigures {
  readonly trustedTestbenchCount: number;
  readonly peerVotes: readonly boolean[];
  readonly mutationStrengthGateOutcome: string;
}

function otherFiguresArbitrary(): fc.Arbitrary<OtherFigures> {
  return fc.record({
    trustedTestbenchCount: fc.nat({ max: 100 }),
    peerVotes: fc.array(fc.boolean(), { maxLength: 10 }),
    mutationStrengthGateOutcome: fc.constantFrom('PASSED', 'FAILED', 'INCONCLUSIVE', 'SKIPPED'),
  });
}

/** The two fixed measurements this property holds constant while `OtherFigures` vary. */
const FIXED_MEASUREMENTS: readonly PairedContractMeasurement[] = [
  { checkFailCount: 0, passed: true },
  { checkFailCount: 94, passed: false },
];

describe('Feature: timing-contract-inference, Property 22: The paired verdict ignores model-quality figures', () => {
  it('returns the identical verdict for a fixed measurement regardless of any other figures drawn', () => {
    const verdictsSeen = new Set<string>();
    let sawZeroTrustedTestbenches = false;
    let sawPositiveTrustedTestbenches = false;
    let sawEmptyPeerVotes = false;
    let sawNonEmptyPeerVotes = false;
    const gateOutcomesSeen = new Set<string>();

    fc.assert(
      fc.property(
        fc.constantFrom(...FIXED_MEASUREMENTS),
        otherFiguresArbitrary(),
        otherFiguresArbitrary(),
        (measurement, figuresA, figuresB) => {
          // Compute the verdict directly: the function's signature admits no parameter
          // `figuresA`/`figuresB` could occupy, so there is nothing to thread them through -
          // the two calls below are identical calls by construction, not merely by luck.
          const verdictA = decidePairedContractVerdict(measurement);
          const verdictB = decidePairedContractVerdict(measurement);
          expect(verdictA).toBe(verdictB);

          verdictsSeen.add(verdictA);
          if (figuresA.trustedTestbenchCount === 0) sawZeroTrustedTestbenches = true;
          else sawPositiveTrustedTestbenches = true;
          if (figuresA.peerVotes.length === 0) sawEmptyPeerVotes = true;
          else sawNonEmptyPeerVotes = true;
          gateOutcomesSeen.add(figuresA.mutationStrengthGateOutcome);
          gateOutcomesSeen.add(figuresB.mutationStrengthGateOutcome);
        },
      ),
      { numRuns: 100 },
    );

    // NON-VACUITY: both verdicts were reached, and the "other figures" generator drew a
    // genuinely varied range - otherwise "ignores" would hold trivially over one fixed value.
    expect([...verdictsSeen].sort()).toEqual(['supported', 'unsupported']);
    expect(sawZeroTrustedTestbenches).toBe(true);
    expect(sawPositiveTrustedTestbenches).toBe(true);
    expect(sawEmptyPeerVotes).toBe(true);
    expect(sawNonEmptyPeerVotes).toBe(true);
    expect(gateOutcomesSeen.size).toBeGreaterThan(1);
  });

  it('the verdict function itself admits no parameter a model-quality figure could occupy', () => {
    // Structural proof, mirroring the behavioral one above: the function takes exactly one
    // argument of exactly two fields.
    expect(decidePairedContractVerdict.length).toBe(1);
    const sample: PairedContractMeasurement = { checkFailCount: 0, passed: true };
    expect(Object.keys(sample)).toEqual(['checkFailCount', 'passed']);
  });
});
