// structural-gate-toolchain, C10: the planted-defect suite - the real `ToolchainStructuralGate`
// against one clean positive control and one single-defect design per check (Req 10.3 to 10.7,
// 11.3).
//
// WHAT THIS SUITE ESTABLISHES
//   `structural-gate-calibration.integration.test.ts` checks the gate against the RTLLM corpus,
//   where every design's failure mode (if any) is whatever the reference happens to trip. This
//   suite is the complementary, targeted half: five designs built so each ONE planted defect is
//   the only thing that can make its check fail, per design.md's own table (C10):
//
//     | Planted defect                                            | Fails       | Passes (asserted) |
//     | an output one bit narrower than the Declared_Interface    | interface   | (none required)   |
//     | a syntax error                                            | compile     | (none required)   |
//     | two `assign` statements driving one output                | lint        | interface, compile, synthesis |
//     | an `always @(posedge clk or a)` mixed edge/level list     | synthesis   | interface, compile |
//
//   The lint row is the only one that asserts the other three checks pass, because that is what
//   demonstrates the Lint_Check catches something nothing else catches (a design that compiles
//   and synthesizes cleanly despite driving one output from two always-live continuous
//   assignments). The clean positive control passes all four, proving the suite's own fixtures
//   are not vacuously defective.
//
// GATING
//   One capability is needed: the real Structural_Gate toolchain (`STRUCTURAL_PROBE`: yosys +
//   iverilog + vvp + worker Python). This suite needs no corpus checkout, unlike the calibration
//   suite, because every fixture is authored here rather than imported.

import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import type { StructuralGateCheckName } from '@app/agent';
import type { ModuleInterface, Spec } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import { realStructuralGate, STRUCTURAL_PROBE } from './real-oracle-harness.js';

if (!STRUCTURAL_PROBE.available) {
  // A single, explicit note that the planted-defect suite was NOT exercised here, so a reader of
  // the test output does not mistake a skip for an admission that every check behaves correctly.
  console.warn(
    `[structural-gate-planted-defects] Suite NOT exercised: ${STRUCTURAL_PROBE.reason}. The ` +
      'real Structural_Gate was not run against any planted-defect fixture in this environment.',
  );
}

// -- Real-run configuration ---------------------------------------------------------

/** Caps for one gate call: same shape the calibration suite uses for a single reference. */
const REAL_LIMITS: ResourceLimits = {
  cpu: 1,
  memMb: 1024,
  procs: 256,
  diskMb: 256,
  wallMs: 60_000,
};

/**
 * The Declared_Interface shared by every fixture: clocked, synchronous-reset, one output.
 *
 * `clk` and `rst` are named only through `clocking`, not repeated in `ports`: the generation
 * compiler's `expectedInterfacePorts` (`app/agent/roles/generation/spec-view.ts`) already adds
 * the clock/reset contract as width-1 input ports, so declaring them here too would double them
 * up in the compile harness it builds.
 */
const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'planted_defect_dut',
  ports: [
    { name: 'a', direction: 'input', width: 4 },
    { name: 'y', direction: 'output', width: 4 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
  validityOutputName: null,
};

/** Wrap the shared `MODULE_INTERFACE` into a minimal, approved `Spec` the gate reads. */
function specFor(moduleInterface: ModuleInterface): Spec {
  return {
    id: 'spec-planted-defects',
    projectId: 'proj-planted-defects',
    goal: 'A registered pass-through used only to plant one structural defect per fixture',
    constraints: [],
    moduleInterface,
    timingContract: { entries: [] },
    acceptanceCriteria: [],
    architecture: 'A single clocked register driving the output from the input.',
    approved: true,
    version: 1,
  };
}

/** One RTL source file under the shared module name, for a given body. */
function rtlOf(contents: string): readonly SourceFile[] {
  return [{ path: 'top.v', contents }];
}

// -- Fixtures: the clean positive control, then one single-defect design per check ----------
//
// Every fixture declares the SAME module name and the SAME `clk`/`rst`/`a` input shape as
// `MODULE_INTERFACE`; only the output's declared width or the always-block body changes, so each
// design's own single planted defect is the only structural difference from the clean control.

/** Clean: a registered pass-through matching `MODULE_INTERFACE` exactly. Passes all four checks. */
const CLEAN_RTL = `module planted_defect_dut (
  input  wire       clk,
  input  wire       rst,
  input  wire [3:0] a,
  output reg  [3:0] y
);
  always @(posedge clk) begin
    if (rst)
      y <= 4'd0;
    else
      y <= a;
  end
endmodule
`;

/** Interface defect: `y` is declared one bit narrower (3 bits) than the Declared_Interface (4). */
const NARROW_OUTPUT_RTL = `module planted_defect_dut (
  input  wire       clk,
  input  wire       rst,
  input  wire [3:0] a,
  output reg  [2:0] y
);
  always @(posedge clk) begin
    if (rst)
      y <= 3'd0;
    else
      y <= a[2:0];
  end
endmodule
`;

/** Compile defect: a syntax error (an unmatched `begin` with no closing `end`). */
const SYNTAX_ERROR_RTL = `module planted_defect_dut (
  input  wire       clk,
  input  wire       rst,
  input  wire [3:0] a,
  output reg  [3:0] y
);
  always @(posedge clk) begin
    if (rst)
      y <= 4'd0;
    else
      y <= a;
endmodule
`;

/**
 * Lint defect: `y` is driven by TWO continuous `assign` statements (a multi-driver net), while
 * still compiling and synthesizing cleanly - the shape D-01 in design.md measured Yosys's
 * `check -assert` as the only check that catches.
 */
const TWO_DRIVER_RTL = `module planted_defect_dut (
  input  wire       clk,
  input  wire       rst,
  input  wire [3:0] a,
  output wire [3:0] y
);
  assign y = rst ? 4'd0 : a;
  assign y = a;
endmodule
`;

/**
 * Synthesis defect: an `always @(posedge clk or a)` sensitivity list mixing an edge (`posedge
 * clk`) with a bare level (`a`) - a construct Yosys `synth -top` refuses, while Icarus still
 * compiles it (Icarus elaborates the block; it does not reject the mixed sensitivity list).
 */
const MIXED_SENSITIVITY_RTL = `module planted_defect_dut (
  input  wire       clk,
  input  wire       rst,
  input  wire [3:0] a,
  output reg  [3:0] y
);
  always @(posedge clk or a) begin
    if (rst)
      y <= 4'd0;
    else
      y <= a;
  end
endmodule
`;

// -- Shared gate-call helper --------------------------------------------------------

/** The checks a `StructuralGateResult` did not pass, as a `Set` for order-independent lookup. */
function notPassedChecks(
  checks: readonly { readonly name: string; readonly passed: boolean }[],
): ReadonlySet<StructuralGateCheckName> {
  return new Set(
    checks.filter((check) => !check.passed).map((check) => check.name as StructuralGateCheckName),
  );
}

/** Run one fixture through the real gate and report which checks did not pass. */
async function admitFixture(rtl: string): Promise<ReadonlySet<StructuralGateCheckName>> {
  const gate = realStructuralGate(STRUCTURAL_PROBE.pythonBin);
  const result = await gate.admit(specFor(MODULE_INTERFACE), rtlOf(rtl), REAL_LIMITS);
  return notPassedChecks(result.checks);
}

// -- Tests ----------------------------------------------------------------------------

describe('Structural_Gate planted-defect suite capability probe', () => {
  it('documents whether the suite ran against the real toolchain in this environment', () => {
    // Always runs; on skip the module-load warning above has already recorded why.
    expect(typeof STRUCTURAL_PROBE.available).toBe('boolean');
    expect(STRUCTURAL_PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!STRUCTURAL_PROBE.available)(
  'Structural_Gate planted-defect suite: one design per check under the real toolchain',
  () => {
    it('records the Yosys and Icarus Verilog versions this suite ran against (Req 10.7)', () => {
      const yosysVersion = execSync('yosys -V', { encoding: 'utf8' }).trim();
      const iverilogVersion = execSync('iverilog -V', { encoding: 'utf8' }).trim();
      console.log(`[structural-gate-planted-defects] ${yosysVersion}`);
      console.log(`[structural-gate-planted-defects] ${iverilogVersion}`);
      expect(yosysVersion.length).toBeGreaterThan(0);
      expect(iverilogVersion.length).toBeGreaterThan(0);
    });

    it('admits the clean positive control through all four checks', async () => {
      const notPassed = await admitFixture(CLEAN_RTL);
      expect([...notPassed]).toEqual([]);
    });

    it('refuses a one-bit-narrow output with the interface check not passed (Req 10.3)', async () => {
      const notPassed = await admitFixture(NARROW_OUTPUT_RTL);
      expect(notPassed.has('interface')).toBe(true);
    });

    it('refuses a syntax error with the compile check not passed (Req 10.4)', async () => {
      const notPassed = await admitFixture(SYNTAX_ERROR_RTL);
      expect(notPassed.has('compile')).toBe(true);
    });

    it(
      'refuses a two-driver output with the lint check not passed, interface/compile/synthesis ' +
        'passed (Req 10.5)',
      async () => {
        const notPassed = await admitFixture(TWO_DRIVER_RTL);
        expect(notPassed.has('lint')).toBe(true);
        expect(notPassed.has('interface')).toBe(false);
        expect(notPassed.has('compile')).toBe(false);
        expect(notPassed.has('synthesis')).toBe(false);
      },
    );

    it('refuses a mixed edge/level sensitivity list with the synthesis check not passed (Req 10.6)', async () => {
      const notPassed = await admitFixture(MIXED_SENSITIVITY_RTL);
      expect(notPassed.has('synthesis')).toBe(true);
    });
  },
);
