// structural-gate-toolchain, Property 5: Every assembled job carries its caller's Top_Module,
// limits, and Schematic_Request (task 5.3; Req 2.6, 7.1, 8.8, 8.9, 9.1).
//
// THREE CALL SHAPES, ONE UNDERLYING FUNCTION FOR TWO OF THEM
//   `assembleSynthesizeJob` and `assembleLintJob` (`app/tools/synth/adapter.ts`,
//   `app/tools/lint/adapter.ts`) are exercised directly. The Structural_Gate_Adapter builds no
//   separate exported function for its Synthesis_Check job; it calls
//   `assembleSynthesizeJob(rtl, topModule, limits, false)` inline
//   (`app/agent/consensus/structural-gate-adapter.ts`), so the third block below reproduces that
//   exact call shape rather than inventing a function that does not exist.
//
// WHAT EACH BLOCK CHECKS, PER THE TASK'S OWN ASSERTION LIST
//   - `job.workspaceFiles` equals the RTL sources passed in.
//   - `job.limits` is the SAME object reference passed in: both assembler functions thread
//     `limits` straight through with no spread, so reference equality is the real claim, and it
//     implies deep equality too.
//   - the `synthesize`/`lint` payload's `topModule` equals the generated Top_Module.
//   - for a synthesize job, `schematic` equals the generated boolean (first block) or is pinned
//     to `false` (third block, the gate's own call shape).
//
// Validates: Requirements 2.6, 7.1, 8.8, 8.9, 9.1

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assembleLintJob,
  assembleSynthesizeJob,
  type ResourceLimits,
  type SourceFile,
} from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY =
  "structural-gate-toolchain, Property 5: Every assembled job carries its caller's Top_Module, " +
  'limits, and Schematic_Request';

/** A plain Verilog identifier within the Seam_Schema's 128-character ceiling (`contract-schema.ts`). */
const IDENT_START: readonly string[] =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('');
const IDENT_REST: readonly string[] = [...IDENT_START, ...'0123456789$'.split('')];

function arbTopModule(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(...IDENT_START),
      fc.array(fc.constantFrom(...IDENT_REST), { maxLength: 15 }),
    )
    .map(([head, tail]) => `${head}${tail.join('')}`);
}

/** Positive `ResourceLimits`, mirroring the sandbox schema's constraints (`contract-schema.ts`). */
function arbLimits(): fc.Arbitrary<ResourceLimits> {
  return fc.record({
    cpu: fc.double({ min: 0.1, max: 8, noNaN: true }),
    memMb: fc.integer({ min: 1, max: 4096 }),
    procs: fc.integer({ min: 1, max: 256 }),
    diskMb: fc.integer({ min: 1, max: 1024 }),
    wallMs: fc.integer({ min: 1, max: 60_000 }),
  });
}

function arbSourceFile(): fc.Arbitrary<SourceFile> {
  return fc.record({
    path: fc.string({ minLength: 1, maxLength: 24 }),
    contents: fc.string({ maxLength: 64 }),
  });
}

function arbRtl(): fc.Arbitrary<readonly SourceFile[]> {
  return fc.array(arbSourceFile(), { maxLength: 3 });
}

describe(PROPERTY, () => {
  it('assembleSynthesizeJob carries the RTL, limits, Top_Module, and Schematic_Request given to it', () => {
    fc.assert(
      fc.property(
        arbRtl(),
        arbTopModule(),
        arbLimits(),
        fc.boolean(),
        (rtl, topModule, limits, schematic) => {
          const job = assembleSynthesizeJob(rtl, topModule, limits, schematic);
          expect(job.workspaceFiles).toEqual(rtl);
          expect(job.limits).toBe(limits);
          expect(job.synthesize?.topModule).toBe(topModule);
          expect(job.synthesize?.schematic).toBe(schematic);
        },
      ),
      propertyParameters(),
    );
  });

  it('assembleLintJob carries the RTL, limits, and Top_Module given to it', () => {
    fc.assert(
      fc.property(arbRtl(), arbTopModule(), arbLimits(), (rtl, topModule, limits) => {
        const job = assembleLintJob(rtl, topModule, limits);
        expect(job.workspaceFiles).toEqual(rtl);
        expect(job.limits).toBe(limits);
        expect(job.lint?.topModule).toBe(topModule);
      }),
      propertyParameters(),
    );
  });

  it("the Structural_Gate_Adapter's inline Synthesis_Check job call shape always sets schematic false", () => {
    fc.assert(
      fc.property(arbRtl(), arbTopModule(), arbLimits(), (rtl, topModule, limits) => {
        // The exact call `structural-gate-adapter.ts`'s `admit` makes for the Synthesis_Check:
        // no separately exported function exists for it, so the call shape is reproduced here.
        const job = assembleSynthesizeJob(rtl, topModule, limits, false);
        expect(job.workspaceFiles).toEqual(rtl);
        expect(job.limits).toBe(limits);
        expect(job.synthesize?.topModule).toBe(topModule);
        expect(job.synthesize?.schematic).toBe(false);
      }),
      propertyParameters(),
    );
  });
});
