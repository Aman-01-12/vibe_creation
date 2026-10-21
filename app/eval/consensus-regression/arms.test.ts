// Example tests for the arm list and the single-family control arm's retirement (task 16.4).

import { describe, expect, it } from 'vitest';

import {
  ALL_ARMS,
  CONSENSUS_REGRESSION_DIVERSITY_RECORD,
  MAIN_ARM,
  PER_RUN_ARMS,
  SINGLE_FAMILY_CONTROL_ARM,
} from './arms.js';

describe('PER_RUN_ARMS - holds exactly the main arm', () => {
  it('contains only the mixed-Model_Family main arm', () => {
    expect(PER_RUN_ARMS).toEqual([MAIN_ARM]);
  });

  it('never includes the single-Model_Family control arm', () => {
    expect(PER_RUN_ARMS).not.toContainEqual(SINGLE_FAMILY_CONTROL_ARM);
  });
});

describe('ALL_ARMS - the control arm is present in the full list and absent from the per-run one', () => {
  it('names both arms', () => {
    expect(ALL_ARMS).toContainEqual(MAIN_ARM);
    expect(ALL_ARMS).toContainEqual(SINGLE_FAMILY_CONTROL_ARM);
  });

  it('marks the control arm as not running per regression', () => {
    expect(SINGLE_FAMILY_CONTROL_ARM.runsPerRegression).toBe(false);
  });

  it('marks the main arm as running every regression', () => {
    expect(MAIN_ARM.runsPerRegression).toBe(true);
  });
});

describe('CONSENSUS_REGRESSION_DIVERSITY_RECORD - present whether or not the control arm has run', () => {
  it('records both the replay figures and the holdout figures they confirm', () => {
    expect(CONSENSUS_REGRESSION_DIVERSITY_RECORD).toEqual({
      wrongLabelShareSingleFamilyHoldout: 0.024,
      wrongLabelShareMixedFamilyHoldout: 0.002,
      wrongLabelShareSingleFamilyReplay: 0.026,
      wrongLabelShareMultiFamilyReplay: 0.003,
    });
  });
});
