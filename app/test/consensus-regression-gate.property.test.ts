// reference-model-consensus-gate, Property 27: The regression gate fails exactly when a
// gated figure is past its bar (task 16.3, C20).
//
// A biconditional: the verdict is a failure if and only if some gated figure is past its
// bar, where a figure exactly equal to its bar passes. Three of the six bars are at-most
// (Wrong_Label_Share, Misattribution_Share) and three are at-least (Verified_Correct_Share,
// Pilot_Pass_Share, both Attribution_Accuracy bars), so the boundary runs in both directions
// and a single comparison helper used for both is what this test would catch if it drifted.
//
// Reported figures gate NOTHING (Q-03): moving every reported figure to its worst possible
// value must not change the verdict. `decideConsensusRegressionGate` takes no
// `ReportedFigures` parameter at all, so this is checked by construction for every case
// below rather than by a dedicated clause - there is no argument through which a reported
// figure could reach the decision.
//
// Validates: Requirements 16.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_ACCURACY_RTL_BAR,
  ATTRIBUTION_ACCURACY_TESTBENCH_BAR,
  decideConsensusRegressionGate,
  MISATTRIBUTION_SHARE_BAR,
  PILOT_DESIGN_SET,
  PILOT_PASS_SHARE_BAR,
  VERIFIED_CORRECT_SHARE_BAR,
  WRONG_LABEL_SHARE_BAR,
  type GatedFigures,
  type GateBar,
} from '../eval/consensus-regression/gate.js';

import { propertyParameters, propertyTag } from './property.js';

const PROPERTY = propertyTag(
  27,
  'The regression gate fails exactly when a gated figure is past its bar',
);

/** A figures object every bar comfortably passes, so a single override tests one bar in isolation. */
function allPassingFigures(): GatedFigures {
  return {
    wrongLabelShare: 0,
    verifiedCorrectShare: 1,
    pilotPassShare: { counter_12: 1, traffic_light: 1, accu: 1 },
    attributionAccuracyTestbench: 1,
    attributionAccuracyRtl: 1,
    misattributionShare: 0,
  };
}

/** The one representable step past `bar`, in the direction that fails it. */
function oneStepPast(bar: GateBar): number {
  const EPSILON = 1e-9;
  return bar.direction === 'at-most' ? bar.bar + EPSILON : bar.bar - EPSILON;
}

/** Every scalar gated bar, paired with the setter that applies a value to its own figure. */
const SCALAR_BARS: readonly {
  readonly bar: GateBar;
  readonly set: (figures: GatedFigures, value: number) => GatedFigures;
}[] = [
  { bar: WRONG_LABEL_SHARE_BAR, set: (figures, value) => ({ ...figures, wrongLabelShare: value }) },
  {
    bar: VERIFIED_CORRECT_SHARE_BAR,
    set: (figures, value) => ({ ...figures, verifiedCorrectShare: value }),
  },
  {
    bar: ATTRIBUTION_ACCURACY_TESTBENCH_BAR,
    set: (figures, value) => ({ ...figures, attributionAccuracyTestbench: value }),
  },
  {
    bar: ATTRIBUTION_ACCURACY_RTL_BAR,
    set: (figures, value) => ({ ...figures, attributionAccuracyRtl: value }),
  },
  {
    bar: MISATTRIBUTION_SHARE_BAR,
    set: (figures, value) => ({ ...figures, misattributionShare: value }),
  },
];

describe(PROPERTY, () => {
  it('a figure exactly equal to its bar passes, for every one of the six gated figures', () => {
    for (const { bar, set } of SCALAR_BARS) {
      const figures = set(allPassingFigures(), bar.bar);
      expect(decideConsensusRegressionGate(figures).passed).toBe(true);
    }
    for (const design of PILOT_DESIGN_SET) {
      const figures: GatedFigures = {
        ...allPassingFigures(),
        pilotPassShare: {
          ...allPassingFigures().pilotPassShare,
          [design]: PILOT_PASS_SHARE_BAR.bar,
        },
      };
      expect(decideConsensusRegressionGate(figures).passed).toBe(true);
    }
  });

  it('one representable step past a bar fails the gate, for every one of the six gated figures', () => {
    for (const { bar, set } of SCALAR_BARS) {
      const figures = set(allPassingFigures(), oneStepPast(bar));
      const verdict = decideConsensusRegressionGate(figures);
      expect(verdict.passed).toBe(false);
      expect(verdict.failures.map((failure) => failure.figure)).toContain(bar.name);
    }
    for (const design of PILOT_DESIGN_SET) {
      const figures: GatedFigures = {
        ...allPassingFigures(),
        pilotPassShare: {
          ...allPassingFigures().pilotPassShare,
          [design]: oneStepPast(PILOT_PASS_SHARE_BAR),
        },
      };
      const verdict = decideConsensusRegressionGate(figures);
      expect(verdict.passed).toBe(false);
      expect(verdict.failures.some((failure) => failure.figure.includes(design))).toBe(true);
    }
  });

  it('the biconditional holds over arbitrary figures: fails iff some gated figure is past its bar', () => {
    const sharesArbitrary = fc.record({
      wrongLabelShare: fc.float({ min: 0, max: 1, noNaN: true }),
      verifiedCorrectShare: fc.float({ min: 0, max: 1, noNaN: true }),
      counter12: fc.float({ min: 0, max: 1, noNaN: true }),
      trafficLight: fc.float({ min: 0, max: 1, noNaN: true }),
      accu: fc.float({ min: 0, max: 1, noNaN: true }),
      attributionAccuracyTestbench: fc.float({ min: 0, max: 1, noNaN: true }),
      attributionAccuracyRtl: fc.float({ min: 0, max: 1, noNaN: true }),
      misattributionShare: fc.float({ min: 0, max: 1, noNaN: true }),
    });

    fc.assert(
      fc.property(sharesArbitrary, (shares) => {
        const figures: GatedFigures = {
          wrongLabelShare: shares.wrongLabelShare,
          verifiedCorrectShare: shares.verifiedCorrectShare,
          pilotPassShare: {
            counter_12: shares.counter12,
            traffic_light: shares.trafficLight,
            accu: shares.accu,
          },
          attributionAccuracyTestbench: shares.attributionAccuracyTestbench,
          attributionAccuracyRtl: shares.attributionAccuracyRtl,
          misattributionShare: shares.misattributionShare,
        };
        const verdict = decideConsensusRegressionGate(figures);

        const anyPastBar =
          figures.wrongLabelShare > WRONG_LABEL_SHARE_BAR.bar ||
          figures.verifiedCorrectShare < VERIFIED_CORRECT_SHARE_BAR.bar ||
          figures.pilotPassShare.counter_12 < PILOT_PASS_SHARE_BAR.bar ||
          figures.pilotPassShare.traffic_light < PILOT_PASS_SHARE_BAR.bar ||
          figures.pilotPassShare.accu < PILOT_PASS_SHARE_BAR.bar ||
          figures.attributionAccuracyTestbench < ATTRIBUTION_ACCURACY_TESTBENCH_BAR.bar ||
          figures.attributionAccuracyRtl < ATTRIBUTION_ACCURACY_RTL_BAR.bar ||
          figures.misattributionShare > MISATTRIBUTION_SHARE_BAR.bar;

        expect(verdict.passed).toBe(!anyPastBar);
      }),
      propertyParameters(),
    );
  });

  it('reported figures gate nothing: there is no parameter through which one could reach the verdict', () => {
    // Structural, not behavioural: `decideConsensusRegressionGate`'s own parameter type is
    // `GatedFigures`, which has no field for any reported figure (Delivered_Label_Correct_Share,
    // the attempt-share figures, the mutation-gate agreement, or the diversity record). A test
    // that tried to pass one would fail to compile, which is the strongest form this guarantee
    // can take.
    const figures = allPassingFigures();
    expect(decideConsensusRegressionGate(figures).passed).toBe(true);
  });
});
