// The pilot's diagnosis rests on these three helpers, so each is pinned on a known input.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import {
  ENABLE_FRAME_PERIOD,
  HOLD_FRAME_PERIOD,
  INPUT_ROLES,
  SAMPLE_BUDGET,
  STROBE_PERIOD,
  type InputRole,
  type RoleDeclaration,
} from '@app/tools';

import {
  bodiesNamedBy,
  compareKillRates,
  comparisonIsObliged,
  locateMismatches,
  renderKillRateComparison,
  renderRefModel,
  sharedBudgetReading,
  type KillRateReading,
} from './pilot.js';

const COUNTER: ModuleInterface = {
  moduleName: 'counter_12',
  ports: [
    { name: 'valid_count', direction: 'input', width: 1 },
    { name: 'out', direction: 'output', width: 4 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

const DRAFT = {
  resetStateBody: "ece_reset_state = 128'd0;",
  nextStateBody: 'ece_next_state = s;\n// two lines',
  expectBody: "ece_expect = 4'd0;",
  roles: [{ portName: 'valid_count', role: 'data' as const }],
};

describe('renderRefModel', () => {
  it('records the 1-based line range each body occupies', () => {
    const rendered = renderRefModel(COUNTER, DRAFT);
    const lines = rendered.file.contents.split('\n');

    expect(rendered.bodyLines.ece_reset_state).toEqual({ first: 2, last: 2 });
    expect(rendered.bodyLines.ece_next_state).toEqual({ first: 5, last: 6 });
    expect(rendered.bodyLines.ece_expect).toEqual({ first: 9, last: 9 });
    expect(lines[rendered.bodyLines.ece_expect.first - 1]).toBe(DRAFT.expectBody);
  });
});

describe('bodiesNamedBy', () => {
  it('maps a refmodel.v line diagnostic to the body that holds that line', () => {
    const rendered = renderRefModel(COUNTER, DRAFT);
    const stderr = "refmodel.v:6: error: Unable to bind wire `rst_n'\ndut_reference.v:3: warning";

    expect(bodiesNamedBy(stderr, rendered)).toEqual(['ece_next_state']);
  });

  it('names nothing for a diagnostic on a header line', () => {
    expect(bodiesNamedBy('refmodel.v:1: error: x', renderRefModel(COUNTER, DRAFT))).toEqual([]);
  });
});

describe('locateMismatches', () => {
  it('reports the first failing step and port, and counts failing steps', () => {
    const stdout = [
      'CHECK n1_out PASS',
      'ECE_SAMPLE n1 0 0',
      'CHECK n1_out FAIL: expected 1, got 0',
      'ECE_SAMPLE n1 1 0',
      'CHECK n1_out FAIL: expected 2, got 1',
      'ECE_SAMPLE n1 2 1',
      'ECE_SAMPLE_END n1 3',
    ].join('\n');

    expect(locateMismatches(stdout, 'n1')).toEqual({
      first: { step: 1, port: 'out', expected: '1', got: '0' },
      failingSteps: 2,
      sampledSteps: 3,
    });
  });

  it('ignores a FAIL line forged under another nonce', () => {
    const stdout = 'CHECK evil_out FAIL: expected 1, got 0\nECE_SAMPLE n1 0 0';
    expect(locateMismatches(stdout, 'n1').first).toBeNull();
  });
});

describe('sharedBudgetReading', () => {
  it('stamps the live SAMPLE_BUDGET rather than a budget copied by hand', () => {
    expect(sharedBudgetReading(0.5)).toEqual({ killRate: 0.5, sampleBudget: SAMPLE_BUDGET });
  });
});

describe('compareKillRates', () => {
  it('passes when the probed kill rate meets or exceeds the re-measured baseline', () => {
    const probed = sharedBudgetReading(0.75);
    const baseline = sharedBudgetReading(0.667);

    expect(compareKillRates(probed, baseline)).toEqual({
      kind: 'compared',
      sampleBudget: SAMPLE_BUDGET,
      probed,
      baseline,
      passed: true,
    });
  });

  it('fails when the probed kill rate falls below the re-measured baseline', () => {
    const report = compareKillRates(sharedBudgetReading(0.5), sharedBudgetReading(0.667));

    expect(report).toMatchObject({ kind: 'compared', passed: false });
  });

  it('withholds the comparison when the two arms were measured at different step budgets', () => {
    const probed: KillRateReading = { killRate: 0.75, sampleBudget: 2048 };
    const baseline: KillRateReading = { killRate: 0.667, sampleBudget: 64 };

    expect(compareKillRates(probed, baseline)).toEqual({ kind: 'withheld', probed, baseline });
  });
});

describe('renderKillRateComparison', () => {
  it('states the shared Sample_Budget, the verdict, and the four non-comparable historical figures', () => {
    const report = compareKillRates(sharedBudgetReading(0.75), sharedBudgetReading(0.667));

    const text = renderKillRateComparison('multi_16bit', report);

    expect(text).toContain(`Sample_Budget of ${String(SAMPLE_BUDGET)} steps`);
    expect(text).toContain('multi_16bit: PASS');
    expect(text).toContain('66.7% for multi_16bit');
    expect(text).toContain('70.8% for accu');
    expect(text).toContain('47.8% for RAM');
    expect(text).toContain('80.0% for sequence_detector');
    expect(text).toContain('not comparable with either arm');
  });

  it('reports both readings with their own budget, labelled withheld, when budgets differ', () => {
    const probed: KillRateReading = { killRate: 0.75, sampleBudget: 2048 };
    const baseline: KillRateReading = { killRate: 0.667, sampleBudget: 64 };

    const text = renderKillRateComparison('multi_16bit', compareKillRates(probed, baseline));

    expect(text).toContain('comparison withheld');
    expect(text).toContain('75.0% (2048 steps)');
    expect(text).toContain('66.7% (64 steps)');
  });
});

// Feature: stimulus-transaction-structure, Property 26: A comparison is emitted only when both
// arms share a step budget (task 12.2, C16).
//
// The two arms can never actually carry different budgets in production - `judgeReply` renders
// both through the one live `SAMPLE_BUDGET` - so this supplies the budget pair directly rather
// than reading it back from a run, per C16's note that the withheld branch is a deliberate
// redundancy kept for exactly this case.
//
// Validates: Requirements 6.8
describe('compareKillRates - Property 26: a comparison is emitted only when both arms share a step budget', () => {
  /** A budget pair biased to land on equal budgets about half the time: two independently
   * drawn integers would rarely coincide on their own, leaving the "emits a comparison" half
   * of this property almost never exercised. */
  function budgetPairArbitrary(): fc.Arbitrary<{
    readonly probedBudget: number;
    readonly baselineBudget: number;
  }> {
    return fc.integer({ min: 0, max: 100_000 }).chain((probedBudget) =>
      fc.boolean().chain((sameBudget) =>
        sameBudget
          ? fc.constant({ probedBudget, baselineBudget: probedBudget })
          : fc
              .integer({ min: 0, max: 100_000 })
              .filter((candidate) => candidate !== probedBudget)
              .map((baselineBudget) => ({ probedBudget, baselineBudget })),
      ),
    );
  }

  it('withholds the comparison with both labelled readings when the budgets differ, and emits one when they match', () => {
    const seenKinds = new Set<'compared' | 'withheld'>();

    fc.assert(
      fc.property(
        budgetPairArbitrary(),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        ({ probedBudget, baselineBudget }, probedKillRate, baselineKillRate) => {
          const probed: KillRateReading = { killRate: probedKillRate, sampleBudget: probedBudget };
          const baseline: KillRateReading = {
            killRate: baselineKillRate,
            sampleBudget: baselineBudget,
          };

          const report = compareKillRates(probed, baseline);
          seenKinds.add(report.kind);

          if (probedBudget === baselineBudget) {
            expect(report).toEqual({
              kind: 'compared',
              sampleBudget: probedBudget,
              probed,
              baseline,
              passed: probedKillRate >= baselineKillRate,
            });
          } else {
            // Req 6.8: no comparison is drawn; both readings are reported instead, each still
            // labelled with the budget it was taken at.
            expect(report).toEqual({ kind: 'withheld', probed, baseline });
          }
        },
      ),
      // `@app/eval` tests hardcode numRuns rather than importing `app/test/property.ts`'s
      // helper, which is pinned to a different feature's tag; 100 matches this spec's floor.
      { numRuns: 100 },
    );

    // Non-vacuity: both the withheld and the compared branch were actually exercised.
    expect(seenKinds).toEqual(new Set(['compared', 'withheld']));
  });
});

// Task 12.3, C16: criteria 6.5 and 6.7 oblige the reporting path to carry particular content for
// a constructed input, not a measured value to come out a particular way, so this is a unit test
// rather than a property. A synthetic below-baseline reading is necessary here: the branch is
// reached only by a probed kill rate under its re-measured baseline, which a real reading over
// the landed renderer is not expected to produce (the vault's bit-identity measurement found all
// four historical figures reproduced exactly).
describe('renderKillRateComparison - the below-baseline diagnostic (Req 6.5, 6.7)', () => {
  it('names the regime constants and the comparability statement for a below-baseline reading', () => {
    // Given a synthetic reading whose kill rate sits below its re-measured all-`data` baseline.
    const report = compareKillRates(sharedBudgetReading(0.4), sharedBudgetReading(0.667));
    expect(report).toMatchObject({ kind: 'compared', passed: false });

    // When that comparison is rendered.
    const text = renderKillRateComparison('RAM', report);

    // Then Req 6.5's diagnostic names the Strobe_Period, Hold_Frame_Period and
    // Distinct_Hold_Value_Count the regime fixes, read live rather than restated as a literal.
    expect(text).toContain(`Strobe_Period of ${String(STROBE_PERIOD)}`);
    expect(text).toContain(`Hold_Frame_Period of ${String(HOLD_FRAME_PERIOD)}`);
    const distinctHoldValueCount = Math.floor(SAMPLE_BUDGET / HOLD_FRAME_PERIOD);
    expect(text).toContain(
      `Distinct_Hold_Value_Count bounded by ${String(distinctHoldValueCount)}`,
    );

    // And the Req 6.7 comparability statement still carries the shared Sample_Budget and the
    // four historical figures with their non-comparability, on this same FAIL output.
    expect(text).toContain(`Sample_Budget of ${String(SAMPLE_BUDGET)} steps`);
    expect(text).toContain('66.7% for multi_16bit');
    expect(text).toContain('70.8% for accu');
    expect(text).toContain('47.8% for RAM');
    expect(text).toContain('80.0% for sequence_detector');
    expect(text).toContain('not comparable with either arm');
  });
});

// Task 16.5, C16: the trigger task 16.4 widened (Req 6.3) and the constant it added to the
// below-baseline diagnostic (Req 6.5). No `Property N` tag on purpose - the widening amends two
// criteria already covered and adds no numbered property, and task 15 pins that count at 26.
describe('comparisonIsObliged - the widened trigger (Req 6.3)', () => {
  /** Typed, not bare literals: both sites stop compiling if either member leaves the
   * Role_Vocabulary, which is the fact the trigger's wording turns on. */
  const DATA: InputRole = 'data';
  const LEGACY_NON_DATA: InputRole = 'enable';

  const NUM_RUNS = 100;

  function declarationOf(members: readonly InputRole[]): RoleDeclaration {
    return members.map((role, index) => ({ portName: `p${String(index)}`, role }));
  }

  /** The port name plays no part in the trigger, so it is held fixed (as Property 19 does).
   * Members come from INPUT_ROLES itself, so a future fifth one is covered with no edit here. */
  function roleDeclarationArbitrary(): fc.Arbitrary<RoleDeclaration> {
    return fc.array(
      fc.record({ portName: fc.constant('p'), role: fc.constantFrom(...INPUT_ROLES) }),
      { minLength: 0, maxLength: 4 },
    );
  }

  /** `uniform-<member>` when every entry names one member, `mixed` when two or more do, `empty`
   * when the declaration names no port. */
  function shapeOf(roles: RoleDeclaration): string {
    const first = roles.at(0);
    if (first === undefined) {
      return 'empty';
    }
    return roles.every((entry) => entry.role === first.role) ? `uniform-${first.role}` : 'mixed';
  }

  function tally(counts: Map<string, number>, shape: string): void {
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }

  /** Req 6.3 in both directions, graded against a recount that dedupes and subtracts `data`
   * rather than repeating the implementation's own short-circuit scan. */
  function gradeTrigger(roles: RoleDeclaration): void {
    const nonDataMembers = new Set(roles.map((entry) => entry.role));
    nonDataMembers.delete(DATA);
    const obliged = comparisonIsObliged(roles);

    // Forward: naming at least one member other than `data` obliges the comparison.
    if (nonDataMembers.size > 0) {
      expect(obliged).toBe(true);
    }
    // Reverse: the all-`data` declaration is the only one it is not obliged for.
    if (!obliged) {
      expect(roles.every((entry) => entry.role === DATA)).toBe(true);
    }
    expect(obliged).toBe(nonDataMembers.size > 0);
  }

  it('obliges the comparison for every declaration naming a non-`data` member, and for no other', () => {
    const shapeCounts = new Map<string, number>();

    // EXHAUSTED, not sampled, per the vault's closed-union non-vacuity gotcha: one uniform
    // declaration per Role_Vocabulary member is graded on every run, so the discriminating
    // all-`enable` case cannot be lost to an unlucky draw.
    for (const member of INPUT_ROLES) {
      const uniform = declarationOf([member, member]);
      tally(shapeCounts, shapeOf(uniform));
      gradeTrigger(uniform);
    }

    fc.assert(
      fc.property(roleDeclarationArbitrary(), (roles) => {
        tally(shapeCounts, shapeOf(roles));
        gradeTrigger(roles);
      }),
      // `@app/eval` hardcodes numRuns rather than importing `app/test/property.ts`, which the
      // eslint import-boundary rule bars this package from depending on.
      { numRuns: NUM_RUNS },
    );

    // Non-vacuity: the loop above guarantees the two uniform shapes, while the mixed shape has
    // to come from the generator, so this fails if the drawn population went uniform.
    expect(shapeCounts.get(`uniform-${DATA}`) ?? 0).toBeGreaterThan(0);
    expect(shapeCounts.get(`uniform-${LEGACY_NON_DATA}`) ?? 0).toBeGreaterThan(0);
    expect(shapeCounts.get('mixed') ?? 0).toBeGreaterThan(0);
  });

  it('obliges the comparison for an all-`enable` declaration, which a Legacy_Role_Set test drops', () => {
    // `multi_16bit`'s corrected declaration, the one design Req 6's guardrail is judged on. A
    // Strobe-or-Held_Input trigger answers false here, and so does a not-a-Legacy_Role_Set
    // trigger, since a declaration naming only this member IS a Legacy_Role_Set.
    expect(comparisonIsObliged(declarationOf([LEGACY_NON_DATA, LEGACY_NON_DATA]))).toBe(true);
  });
});

// Task 16.5, C16: the Enable_Frame_Period task 16.4 added to Req 6.5's diagnostic. Driven by a
// synthetic below-baseline reading for the reason task 12.3 records - the branch is reached only
// by a probed kill rate under its re-measured baseline, which a real reading is not expected to
// produce - and reached through `renderKillRateComparison`, the diagnostic staying module-private.
describe('renderKillRateComparison - the widened below-baseline diagnostic (Req 6.5)', () => {
  it('names the Enable_Frame_Period alongside the constants the diagnostic already carried', () => {
    // Given a synthetic reading whose kill rate sits below its re-measured all-`data` baseline.
    const report = compareKillRates(sharedBudgetReading(0.4), sharedBudgetReading(0.667));
    expect(report).toMatchObject({ kind: 'compared', passed: false });

    // When that comparison is rendered, then the constant responsible for a below-baseline
    // `enable` reading is named, with its value read live rather than restated as a literal.
    expect(renderKillRateComparison('multi_16bit', report)).toContain(
      `Enable_Frame_Period of ${String(ENABLE_FRAME_PERIOD)}`,
    );
  });

  it('leaves the Enable_Frame_Period off a passing comparison, so it rides the diagnostic alone', () => {
    const passing = compareKillRates(sharedBudgetReading(0.75), sharedBudgetReading(0.667));

    // Naming it on every render would satisfy the containment check above while telling a
    // passing design nothing about which constant to suspect.
    expect(renderKillRateComparison('multi_16bit', passing)).not.toContain('Enable_Frame_Period');
  });
});
