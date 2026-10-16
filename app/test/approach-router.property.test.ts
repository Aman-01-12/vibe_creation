// testbench-in-order-scoreboard, Properties 1 and 2: the Approach_Router's arm rule, and that it
// reads nothing but the qualifier lists and clock presence.
//
// The interfaces are BUILT with a known number of Output_Qualifiers rather than counted after
// the fact, so the oracle below never re-derives `timingQualifierNames`. A qualifier is a 1-bit
// output whose name holds a handshake keyword; the decoys are a keyword name at width 2 and
// plain data outputs, which `timingQualifierNames` must both ignore.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { designGroupOf, routeCheckingApproach, STRATEGY_ARMS, type StrategyArm } from '@app/agent';
import type { ModuleInterface, Port } from '@app/core';

import { propertyParameters } from './property.js';

const PROPERTY_1 = 'Feature: testbench-in-order-scoreboard, Property 1: Router arm rule';
const PROPERTY_1_GROUNDED =
  'Feature: testbench-spec-grounding, Property 1: Router arm rule with `grounded`';
const PROPERTY_2 =
  'Feature: testbench-in-order-scoreboard, Property 2: Router reads only the qualifier lists';

const QUALIFIER_STEMS = ['valid', 'ready', 'done', 'ack', 'busy', 'complete'] as const;

/** Everything about an interface except which ports qualify, which the plan fixes. */
interface InterfacePlan {
  readonly qualifierCount: number;
  readonly clocked: boolean;
  readonly reset: boolean;
  readonly dataOutputWidths: readonly number[];
  readonly dataInputWidths: readonly number[];
  readonly wideKeywordDecoy: boolean;
  readonly inputQualifier: boolean;
  readonly moduleName: string;
}

function port(name: string, direction: Port['direction'], width: number): Port {
  return { name, direction, width };
}

/** Build the interface a plan describes; port names are distinct by construction. */
function interfaceOf(plan: InterfacePlan, order: (ports: Port[]) => Port[]): ModuleInterface {
  const ports: Port[] = [];
  if (plan.clocked) {
    ports.push(port('clk', 'input', 1));
  }
  if (plan.reset) {
    ports.push(port('rst_n', 'input', 1));
  }
  if (plan.inputQualifier) {
    ports.push(port('valid_in', 'input', 1));
  }
  plan.dataInputWidths.forEach((width, index) =>
    ports.push(port(`d${String(index)}`, 'input', width)),
  );
  for (let index = 0; index < plan.qualifierCount; index += 1) {
    const stem = QUALIFIER_STEMS[index % QUALIFIER_STEMS.length] ?? 'valid';
    ports.push(port(`${stem}_o${String(index)}`, 'output', 1));
  }
  if (plan.wideKeywordDecoy) {
    ports.push(port('valid_bus', 'output', 2));
  }
  plan.dataOutputWidths.forEach((width, index) =>
    ports.push(port(`q${String(index)}`, 'output', width)),
  );
  return {
    validityOutputName: null,
    moduleName: plan.moduleName,
    ports: order(ports),
    clocking: {
      clockName: plan.clocked ? 'clk' : null,
      resetName: plan.reset ? 'rst_n' : null,
      resetActiveLow: true,
    },
  };
}

const arbPlan: fc.Arbitrary<InterfacePlan> = fc.record({
  // 0, 1, and 2-or-more are all frequent, because those are the three routing cases.
  qualifierCount: fc.oneof(fc.constant(0), fc.constant(1), fc.integer({ min: 2, max: 4 })),
  clocked: fc.boolean(),
  reset: fc.boolean(),
  dataOutputWidths: fc.array(fc.integer({ min: 1, max: 16 }), { maxLength: 3 }),
  dataInputWidths: fc.array(fc.integer({ min: 1, max: 16 }), { maxLength: 3 }),
  wideKeywordDecoy: fc.boolean(),
  inputQualifier: fc.boolean(),
  moduleName: fc.constantFrom('accu', 'fifo', 'dut_x'),
});

/** The independent oracle: the rule stated over the plan, not over the ports. */
function expectedRoute(plan: InterfacePlan, arm: StrategyArm): string {
  if (arm !== 'treatment') {
    return 'cycle-timed';
  }
  return version5TreatmentRoute(plan);
}

/** A frozen copy of the version-5 Treatment rule, so `grounded` cannot move it unnoticed. */
function version5TreatmentRoute(plan: InterfacePlan): string {
  return plan.clocked && plan.qualifierCount === 1 ? 'in-order-scoreboard' : 'cycle-timed';
}

describe(PROPERTY_1, () => {
  it('routes by arm, clock presence, and exactly one Output_Qualifier', () => {
    fc.assert(
      fc.property(arbPlan, (plan) => {
        const moduleInterface = interfaceOf(plan, (ports) => ports);
        // The arm union is exhausted rather than sampled: every member is always checked.
        for (const arm of STRATEGY_ARMS) {
          expect(routeCheckingApproach(moduleInterface, arm)).toBe(expectedRoute(plan, arm));
        }
        const streaming = plan.clocked && plan.qualifierCount === 1;
        expect(designGroupOf(moduleInterface)).toBe(streaming ? 'streaming' : 'cycle-exact');
      }),
      propertyParameters(),
    );
  });
});

describe(PROPERTY_1_GROUNDED, () => {
  it('routes Cycle_Timed under control and grounded, and keeps the version-5 Treatment rule', () => {
    expect([...STRATEGY_ARMS]).toEqual(['control', 'treatment', 'grounded']);
    fc.assert(
      fc.property(arbPlan, (plan) => {
        const moduleInterface = interfaceOf(plan, (ports) => ports);
        expect(routeCheckingApproach(moduleInterface, 'control')).toBe('cycle-timed');
        expect(routeCheckingApproach(moduleInterface, 'grounded')).toBe('cycle-timed');
        expect(routeCheckingApproach(moduleInterface, 'treatment')).toBe(
          version5TreatmentRoute(plan),
        );
      }),
      propertyParameters(),
    );
  });
});

describe(PROPERTY_2, () => {
  it('ignores the module name, reset, port order, and every non-qualifier port', () => {
    fc.assert(
      fc.property(
        arbPlan,
        fc.boolean(),
        fc.array(fc.integer({ min: 1, max: 16 }), { maxLength: 3 }),
        fc.constantFrom('other', 'renamed_top'),
        (plan, reset, otherWidths, moduleName) => {
          const original = interfaceOf(plan, (ports) => ports);
          // Same qualifier set and clock presence; everything else is allowed to differ.
          const variant = interfaceOf(
            {
              ...plan,
              reset,
              dataOutputWidths: otherWidths,
              dataInputWidths: otherWidths,
              moduleName,
            },
            (ports) => [...ports].reverse(),
          );
          for (const arm of STRATEGY_ARMS) {
            expect(routeCheckingApproach(variant, arm)).toBe(routeCheckingApproach(original, arm));
          }
          expect(designGroupOf(variant)).toBe(designGroupOf(original));
        },
      ),
      propertyParameters(),
    );
  });
});
