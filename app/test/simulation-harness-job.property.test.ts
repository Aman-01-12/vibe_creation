// testbench-spec-grounding, Properties 9 and 10: the Simulation_Harness is a fixed template over
// two numbers, and a simulate job carries it only when a Testbench_Run asks for it.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  SIMULATION_HARNESS,
  assembleSimulateJob,
  renderSimulationHarness,
  validateSandboxJob,
  type ResourceLimits,
  type SourceFile,
} from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY_9 =
  'Feature: testbench-spec-grounding, Property 9: Simulate job assembly attaches the harness only on request';
const PROPERTY_10 =
  'Feature: testbench-spec-grounding, Property 10: The harness is a fixed template over two numbers';

const MAX_DUMP_LIMIT = 0xffff_ffff;

/** The rendered text with its two numerals replaced by placeholders. */
function templateOf(budget: number, limit: number): string {
  return renderSimulationHarness(budget, limit)
    .contents.replace(`64'd${String(budget)};`, "64'd<BUDGET>;")
    .replace(`32'd${String(limit)};`, "32'd<LIMIT>;");
}

const arbBudget = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const arbLimit = fc.integer({ min: 1, max: MAX_DUMP_LIMIT });

describe(PROPERTY_10, () => {
  it('renders one fixed template, deterministically, for any two positive integers', () => {
    const reference = templateOf(1, 1);
    fc.assert(
      fc.property(arbBudget, arbLimit, (budget, limit) => {
        expect(renderSimulationHarness(budget, limit)).toEqual(
          renderSimulationHarness(budget, limit),
        );
        expect(templateOf(budget, limit)).toBe(reference);
      }),
      propertyParameters(),
    );
  });

  it('throws RangeError for a non-positive or non-integer argument', () => {
    const arbBad = fc.oneof(
      fc.integer({ max: 0 }),
      fc.double({ noInteger: true }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2),
    );
    fc.assert(
      fc.property(arbBad, arbBudget, (bad, good) => {
        expect(() => renderSimulationHarness(bad, 1)).toThrow(RangeError);
        expect(() => renderSimulationHarness(Math.min(good, MAX_DUMP_LIMIT), bad)).toThrow(
          RangeError,
        );
      }),
      propertyParameters(),
    );
  });
});

const arbFile: fc.Arbitrary<SourceFile> = fc.record({
  path: fc.constantFrom('dut.v', 'adder.v', 'sub/core.v'),
  contents: fc.constantFrom('module dut; endmodule', '', '`timescale 1ns/1ps\nmodule a; endmodule'),
});

const arbLimits: fc.Arbitrary<ResourceLimits> = fc.record({
  cpu: fc.constantFrom(0.5, 1, 2),
  memMb: fc.integer({ min: 1, max: 1024 }),
  procs: fc.integer({ min: 1, max: 64 }),
  diskMb: fc.integer({ min: 1, max: 256 }),
  wallMs: fc.integer({ min: 1, max: 60_000 }),
});

const arbRequiredNames = fc.array(fc.constantFrom('a_ok', 'b_ok', 'known_answer_x'), {
  maxLength: 3,
});

describe(PROPERTY_9, () => {
  it('adds the harness and the timescale request only for a TestbenchRun, and both validate', () => {
    fc.assert(
      fc.property(
        fc.array(arbFile, { maxLength: 3 }),
        arbFile.map((file) => ({ ...file, path: 'tb.v' })),
        arbLimits,
        arbRequiredNames,
        (rtl, testbench, limits, requiredCheckNames) => {
          const plain = assembleSimulateJob(rtl, testbench, limits);
          const expected = {
            kind: 'simulate',
            workspaceFiles: [...rtl, testbench],
            limits,
            requiredOutputs: ['stdout', 'exitCode', 'vcd'],
          };
          expect(plain).toStrictEqual(expected);
          expect('simulate' in plain).toBe(false);
          const harnessed = assembleSimulateJob(rtl, testbench, limits, { requiredCheckNames });
          expect(harnessed).toStrictEqual({
            ...expected,
            workspaceFiles: [...rtl, testbench, SIMULATION_HARNESS],
            simulate: { defaultTimescale: '1ns/1ps' },
          });
          expect(validateSandboxJob(plain).ok).toBe(true);
          expect(validateSandboxJob(harnessed).ok).toBe(true);
        },
      ),
      propertyParameters(),
    );
  });

  it('refuses a simulate payload on any other job kind', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('synthesize', 'formal', 'formalPrepass'),
        arbLimits,
        (kind, limits) => {
          const payloads: Record<string, object> = {
            formal: { formal: { topModule: 'w', depth: 4 } },
            formalPrepass: { formalPrepass: { topModule: 'dut' } },
          };
          const job = {
            kind,
            workspaceFiles: [{ path: 'dut.v', contents: '' }],
            limits,
            requiredOutputs: ['stdout'],
            ...(payloads[kind] ?? {}),
          };
          expect(validateSandboxJob(job).ok).toBe(true);
          expect(validateSandboxJob({ ...job, simulate: { defaultTimescale: '1ns/1ps' } }).ok).toBe(
            false,
          );
        },
      ),
      propertyParameters(),
    );
  });
});
