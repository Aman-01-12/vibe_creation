// testbench-in-order-scoreboard, Property 5: the In_Order_Scoreboard prompts carry the Cycle_Timed
// rules verbatim and exactly one carve-out beside `CONCURRENCY_RULE`.
//
// "Verbatim" is asserted as exact substrings of the exported rule constants, so a reworded copy
// of a rule cannot pass for the measured one.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildScoreboardModelInput,
  buildRepairHint,
  buildScoreboardRepairModelInput,
  CONCURRENCY_RULE,
  describeInputWindow,
  describeStateAnchoring,
  DIALECT_RULE,
  EXPECTED_VALUE_RULE,
  renderScoreboardScaffold,
  requiredChecks,
  SCOREBOARD_CARVE_OUT,
} from '@app/agent';
import type { ModuleInterface, Port, Spec } from '@app/core';

import { timingContractFor } from './generators/timing-contract.js';
import { propertyParameters } from './property.js';

const PROPERTY_5 =
  'Feature: testbench-in-order-scoreboard, Property 5: Scoreboard prompts carry the rules verbatim and one carve-out';

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const WORDS = [
  'sum',
  'four',
  'inputs',
  'output',
  'valid',
  'when',
  'reset',
  'word',
  'serial',
] as const;
const phrase = fc
  .array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 5 })
  .map((w) => w.join(' '));

/** An approved Spec whose interface routes In_Order_Scoreboard under the Treatment_Arm. */
export const arbStreamingSpec: fc.Arbitrary<Spec> = fc
  .record({
    goal: phrase,
    constraints: fc.array(phrase, { maxLength: 2 }),
    criteria: fc.array(phrase, { minLength: 1, maxLength: 3 }),
    inputQualifier: fc.boolean(),
    activeLow: fc.boolean(),
    dataWidth: fc.integer({ min: 1, max: 16 }),
  })
  .map(({ goal, constraints, criteria, inputQualifier, activeLow, dataWidth }) => {
    const ports: Port[] = [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'rst_n', direction: 'input', width: 1 },
      { name: 'data_in', direction: 'input', width: dataWidth },
      ...(inputQualifier ? [{ name: 'valid_in', direction: 'input' as const, width: 1 }] : []),
      { name: 'valid_out', direction: 'output', width: 1 },
      { name: 'data_out', direction: 'output', width: dataWidth + 2 },
    ];
    const moduleInterface: ModuleInterface = {
      moduleName: 'accu',
      ports,
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: activeLow },
      validityOutputName: null,
    };
    return {
      id: ULID,
      projectId: ULID,
      goal,
      constraints,
      moduleInterface,
      acceptanceCriteria: criteria.map((text) => ({
        id: ULID,
        text,
        measurable: true,
        method: 'simulation' as const,
      })),
      architecture: 'pipelined accumulator',
      version: 1,
      approved: true as const,
      timingContract: timingContractFor(moduleInterface),
    };
  });

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe(PROPERTY_5, () => {
  it('reuses each rule byte for byte and states the carve-out once, right after CONCURRENCY_RULE', () => {
    fc.assert(
      fc.property(arbStreamingSpec, (spec) => {
        const checks = requiredChecks(spec);
        const rendered = renderScoreboardScaffold(
          spec.moduleInterface,
          checks.map((check) => check.name),
        );
        expect(rendered.ok).toBe(true);
        if (!rendered.ok) {
          return;
        }
        const generation = buildScoreboardModelInput(
          { spec, intentSummary: 'an accumulator', okfPassages: [] },
          checks,
          rendered.value,
        ).prompt;
        const repair = buildScoreboardRepairModelInput(
          {
            spec,
            previousSource: '{"runLength": 1}',
            hint: buildRepairHint({ kind: 'precheck-build-failed', diagnostic: 'syntax error' }),
          },
          rendered.value,
        ).prompt;

        for (const rule of [
          EXPECTED_VALUE_RULE,
          DIALECT_RULE,
          describeStateAnchoring(spec.moduleInterface.clocking),
          describeInputWindow(spec.moduleInterface),
        ]) {
          expect(generation).toContain(rule);
        }
        for (const prompt of [generation, repair]) {
          expect(occurrences(prompt, CONCURRENCY_RULE)).toBe(1);
          expect(occurrences(prompt, SCOREBOARD_CARVE_OUT)).toBe(1);
          expect(prompt).toContain(`${CONCURRENCY_RULE}\n${SCOREBOARD_CARVE_OUT}`);
        }
      }),
      propertyParameters(),
    );
  });
});
