// Real-toolchain integration test: the Consensus_Harness's compilation-unit placement neither
// collides with nor is silently shadowed by the Reference_Model's own file (task 8.2, C4).
//
// WHY THIS TEST EXISTS
//
//   `ece_mix` and `ece_stimulus` render at compilation-unit scope, ABOVE the harness module, in
//   the SAME file as the module (`renderConsensusHarness`'s own header). `ece_reset_state`,
//   `ece_next_state`, and `ece_expect` live at compilation-unit scope too, but in the SEPARATE
//   Reference_Model file. Two already-recorded vault findings make this exact placement risky
//   enough to need a real run rather than a text check:
//     - a function declared standalone in one file IS visible, with no import, to a module in a
//       DIFFERENT file compiled in the same `iverilog` invocation (compilation-unit scope spans
//       every compiled file) -
//       `chipAgent/_inbox/pattern-reference-model-functions-compile-at-compilation-unit-scope-across-separate-workspace-files-under-iverilog.md`;
//     - a function declared INSIDE a module SHADOWS a same-named compilation-unit-scope one with
//       NO compile error at all, silently resolving every in-module call to the empty local stub -
//       `chipAgent/_inbox/gotcha-a-module-scoped-function-redeclaration-silently-shadows-the-compilation-unit-scope-one-with-no-compile-error.md`.
//   Both were measured with the two declarations in DIFFERENT files. This harness renders
//   `ece_mix`/`ece_stimulus` in the SAME file as the module, one step beyond what either note
//   measured, so this test is the real-toolchain confirmation that same-file compilation-unit
//   placement is exactly as visible, and exactly as collision-prone, as the cross-file case.
//
// THE THREE CONTROLS
//
//   1. Positive (visibility): a correct Reference_Model, in its own separate file, resolves
//      correctly from the harness module even though `ece_mix`/`ece_stimulus` sit at
//      compilation-unit scope in the HARNESS's own file - a real passing run, not a text check.
//   2. Negative (collision, must be a HARD error): a second file declaring `ece_stimulus` again
//      at compilation-unit scope must fail `iverilog -g2012` with a real duplicate-declaration
//      diagnostic. A placement check that cannot fail is not a placement check.
//   3. Structural (no module-scoped shadow): the rendered harness text declares none of the four
//      Reference_Model names, which is the vault's own fix rule - restated here as the reason the
//      hard-error direction in control 2 is the safe one, not a silent shadow.

import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface } from '@app/core';
import { SAMPLE_BUDGET } from '@app/tools';
import type { ResourceLimits, SourceFile } from '@app/tools';

import {
  renderConsensusHarness,
  type ConsensusHarnessRequest,
} from '../tools/simulator/consensus-harness.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[consensus-stimulus-mixer-shadowing.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'The compilation-unit placement claim is UNVALIDATED against real iverilog in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 60_000 };
const RUN_TIMEOUT = 120_000;

// A small clocked counter interface - the simplest shape that still exercises a registered
// output, so a shadowed `ece_expect`/`ece_next_state` (not just `ece_stimulus`) would also show
// up as a CHECK FAIL rather than being masked by an all-combinational interface.
const COUNTER_RTL: SourceFile = {
  path: 'counter.v',
  contents: `module counter (
  input  wire       clk,
  input  wire       rst,
  output reg  [3:0] q
);
  always @(posedge clk) begin
    if (rst)
      q <= 4'd0;
    else
      q <= q + 4'd1;
  end
endmodule
`,
};

const COUNTER_INTERFACE: ModuleInterface = {
  moduleName: 'counter',
  ports: [{ name: 'q', direction: 'output', width: 4 }],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
  validityOutputName: null,
};

/**
 * A correctly-written Reference_Model, in its OWN file, mirroring the counter's own
 * increment-with-reset logic. `COUNTER_INTERFACE` declares no real input port, so the harness's
 * `in` bundle carries only a phantom mixer bit the counter RTL cannot see either - the model
 * must ignore it exactly as the RTL does, incrementing unconditionally.
 */
const COUNTER_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "  ece_reset_state = 128'd0;",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [0:0] in);',
    "  ece_next_state = s + 128'd1;",
    'endfunction',
    'function automatic [3:0] ece_expect(input [127:0] s, input [0:0] in);',
    '  ece_expect = s[3:0];',
    'endfunction',
    '',
  ].join('\n'),
};

function renderHarnessOrThrow(nonce: string): SourceFile {
  const timingBuilt = makeTimingContract(COUNTER_INTERFACE, [
    { portName: 'q', timing: 'registered' },
  ]);
  if (!timingBuilt.ok) {
    throw new Error(`fixture defect: ${timingBuilt.error.code}`);
  }
  const request: ConsensusHarnessRequest = {
    moduleInterface: COUNTER_INTERFACE,
    timingContract: timingBuilt.value,
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    roles: [],
  };
  const rendered = renderConsensusHarness(request);
  if (!rendered.ok) {
    throw new Error(`fixture defect: ${rendered.error.code}`);
  }
  return rendered.value;
}

function checkFailLines(stdout: string, nonce: string): readonly string[] {
  const pattern = new RegExp(`^CHECK ${nonce}_\\w+ FAIL`);
  return stdout.split('\n').filter((line) => pattern.test(line.trim()));
}

describe('consensus stimulus mixer placement real-toolchain capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'the compilation-unit placement of ece_mix/ece_stimulus in the harness file neither collides with nor is shadowed by the Reference_Model file (Req 2.2, 2.11)',
  () => {
    it(
      'POSITIVE: a correct Reference_Model in a separate file resolves correctly, with zero CHECK FAIL lines over the full run',
      async () => {
        const nonce = 'placePos1';
        const harness = renderHarnessOrThrow(nonce);
        const verdict = await realOracleAdapter().simulate(
          [COUNTER_RTL, COUNTER_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        // Elaboration AND a full functional run both succeeded - a shadow of ece_next_state or
        // ece_expect by an (absent) module-local stub would still elaborate cleanly, so the
        // decisive evidence is the zero-FAIL run below, not this classification alone.
        expect(verdict.failureCause).toBe('none');
        expect(checkFailLines(verdict.stdout, nonce)).toEqual([]);
        expect(verdict.verdict).toBe('pass');
      },
      RUN_TIMEOUT,
    );

    it(
      'NEGATIVE: a second compilation-unit declaration of ece_stimulus is a HARD duplicate-declaration error, not a silent shadow',
      async () => {
        const nonce = 'placeNeg1';
        const harness = renderHarnessOrThrow(nonce);
        // A model reply can no longer produce ece_stimulus (it is harness-rendered, C4/C5), but
        // this control still has to prove the FAILURE DIRECTION: were a second file to declare
        // it again at compilation-unit scope (the same scope the harness's own file uses), real
        // iverilog must refuse to compile rather than silently pick one. A test that can only
        // pass, never fail, is not a placement check.
        const duplicateStimulusFile: SourceFile = {
          path: 'duplicate_stimulus.v',
          contents: [
            'function automatic [0:0] ece_stimulus(input [31:0] step);',
            "  ece_stimulus = 1'b0;",
            'endfunction',
            '',
          ].join('\n'),
        };
        const verdict = await realOracleAdapter().simulate(
          [COUNTER_RTL, COUNTER_REFERENCE_MODEL, duplicateStimulusFile],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('build-failed');
        expect(verdict.attributedFiles).toContain(duplicateStimulusFile.path);
        expect(verdict.stderr).toContain('already been declared');
      },
      RUN_TIMEOUT,
    );

    it('STRUCTURAL: the rendered harness text declares none of the four Reference_Model names, which is why control 2 is a hard error rather than a silent shadow', () => {
      const nonce = 'placeStruct1';
      const harness = renderHarnessOrThrow(nonce);
      for (const name of ['ece_reset_state', 'ece_next_state', 'ece_expect'] as const) {
        expect(harness.contents).not.toContain(`function automatic [127:0] ${name}`);
      }
      // ece_mix and ece_stimulus ARE declared here (that is the placement under test), and
      // are declared exactly once each - a renderer regression duplicating either would be
      // its own compilation-unit collision, inside this very file.
      expect(harness.contents.match(/function automatic \[63:0\] ece_mix\(/g)).toHaveLength(1);
      expect(harness.contents.match(/function automatic \[\d+:0\] ece_stimulus\(/g)).toHaveLength(
        1,
      );
    });
  },
);
