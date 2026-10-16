// The Approach_Router: which Checking_Approach a testbench is generated under, decided from the
// Spec's declared interface and the Strategy_Arm alone (testbench-in-order-scoreboard, C1).
//
// It reuses `timingQualifierNames` rather than a second detector, so the Streaming_Group is
// exactly the set of designs today's prompt already treats as handshake-qualified.

import type { ModuleInterface } from '@app/core';

import { timingQualifierNames } from './prompt.js';

/** The arms of the A/B Campaigns. The Student_Path never sets one, so it is `control`. */
export const STRATEGY_ARMS = ['control', 'treatment', 'grounded'] as const;
export type StrategyArm = (typeof STRATEGY_ARMS)[number];

/** How a testbench decides when to compare an output. */
export const CHECKING_APPROACHES = ['cycle-timed', 'in-order-scoreboard'] as const;
export type CheckingApproach = (typeof CHECKING_APPROACHES)[number];

/** Which half of the Campaign a design's figures are reported in. */
export const DESIGN_GROUPS = ['streaming', 'cycle-exact'] as const;
export type DesignGroup = (typeof DESIGN_GROUPS)[number];

/**
 * Streaming exactly when the interface is clocked and declares exactly one Output_Qualifier.
 *
 * The group is the same under both arms, which is what makes the Cycle_Exact_Group's cross-arm
 * difference a noise floor. A clockless interface has no clock period to sample in (DQ-03).
 */
export function designGroupOf(moduleInterface: ModuleInterface): DesignGroup {
  if (moduleInterface.clocking.clockName === null) {
    return 'cycle-exact';
  }
  return timingQualifierNames(moduleInterface).length === 1 ? 'streaming' : 'cycle-exact';
}

/** Control and Grounded always route Cycle_Timed; Treatment routes the Streaming_Group to the scoreboard. */
export function routeCheckingApproach(
  moduleInterface: ModuleInterface,
  strategyArm: StrategyArm,
): CheckingApproach {
  if (strategyArm !== 'treatment') {
    return 'cycle-timed';
  }
  return designGroupOf(moduleInterface) === 'streaming' ? 'in-order-scoreboard' : 'cycle-timed';
}
