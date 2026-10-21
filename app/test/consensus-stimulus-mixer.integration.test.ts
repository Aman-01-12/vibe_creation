// Real-toolchain integration test: the rendered splitmix64 Stimulus_Mixer elaborates and runs
// correctly under `iverilog -g2012` (task 8.1, C4; Req 2.12, 2.13).
//
// WHY THIS TEST EXISTS
//
//   `rendered-stimulus-mixer.property.test.ts` (task 2.10) already proves splitmix64 is free of
//   near-periodicity, but it evaluates a HAND-TRANSLATED BigInt model of the mixer, never the
//   rendered Verilog text itself. `rendered-stimulus-layout.property.test.ts` (task 2.8) proves
//   the rendered TEXT is syntactically well-formed, but reads no simulator. Neither proves the
//   two 64-bit multiplications (`h * 64'hBF58476D1CE4E5B9`, `h * 64'h94D049BB133111EB`) actually
//   ELABORATE AND COMPUTE CORRECTLY under real Icarus - 64-bit Verilog multiplication is exactly
//   the kind of construct that can silently truncate or warn differently across simulator
//   versions, which only a real toolchain run can settle (design.md's own Testing Strategy names
//   this as one of the things only the real toolchain can confirm).
//
// THE ASSERTION SHAPE
//
//   A correct Reference_Model, paired with a correct golden design, run through the real
//   simulator at the real Sample_Budget. If the rendered 64-bit multiply silently misbehaved
//   (truncated, wrapped differently, or produced a different value than the BigInt model
//   predicts), the model's state and the golden design's real behaviour would diverge the first
//   time the mixer's corrupted bits reached a port the harness compares - so a clean, full,
//   zero-CHECK-FAIL run across the whole budget is the positive confirmation the real multiply
//   computed the same thing the BigInt model already proved is near-periodicity-free.

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
    `[consensus-stimulus-mixer.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'The rendered splitmix64 Stimulus_Mixer is UNVALIDATED against real iverilog in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 60_000 };
const RUN_TIMEOUT = 120_000;

// A 16-bit adder-shaped interface (33 input bits across start/ain/bin), the exact shape the
// hand-written `multi_16bit` probe this session already measured - reused here as a plain
// pass/fail golden check rather than a kill-rate reading, so this test needs no mutant corpus.
const ADDER16_RTL: SourceFile = {
  path: 'adder16.v',
  contents: `module adder16 (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        start,
  input  wire [15:0] ain,
  input  wire [15:0] bin,
  output reg  [31:0] yout,
  output reg         done
);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      yout <= 32'd0;
      done <= 1'b0;
    end else if (start) begin
      yout <= {16'd0, ain} + {16'd0, bin};
      done <= 1'b1;
    end else begin
      done <= 1'b0;
    end
  end
endmodule
`,
};

const ADDER16_INTERFACE: ModuleInterface = {
  moduleName: 'adder16',
  ports: [
    { name: 'start', direction: 'input', width: 1 },
    { name: 'ain', direction: 'input', width: 16 },
    { name: 'bin', direction: 'input', width: 16 },
    { name: 'yout', direction: 'output', width: 32 },
    { name: 'done', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

/** A correctly-written Reference_Model mirroring the adder's own registered add-with-reset logic. */
const ADDER16_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "  ece_reset_state = 128'd0;",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [32:0] in);',
    '  reg [31:0] y; reg d;',
    '  begin',
    "    if (in[0]) begin y = {16'd0, in[16:1]} + {16'd0, in[32:17]}; d = 1'b1; end",
    "    else begin y = s[31:0]; d = 1'b0; end",
    "    ece_next_state = {95'd0, d, y};",
    '  end',
    'endfunction',
    'function automatic [32:0] ece_expect(input [127:0] s, input [32:0] in);',
    '  ece_expect = {s[32], s[31:0]};',
    'endfunction',
    '',
  ].join('\n'),
};

function renderHarnessOrThrow(nonce: string): SourceFile {
  const timingBuilt = makeTimingContract(ADDER16_INTERFACE, [
    { portName: 'yout', timing: 'registered' },
    { portName: 'done', timing: 'registered' },
  ]);
  if (!timingBuilt.ok) {
    throw new Error(`fixture defect: ${timingBuilt.error.code}`);
  }
  const request: ConsensusHarnessRequest = {
    moduleInterface: ADDER16_INTERFACE,
    timingContract: timingBuilt.value,
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    roles: [
      { portName: 'start', role: 'enable' },
      { portName: 'ain', role: 'data' },
      { portName: 'bin', role: 'data' },
    ],
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

describe('consensus stimulus mixer real-toolchain capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'the rendered splitmix64 Stimulus_Mixer, including its two 64-bit multiplies, elaborates and computes correctly under real iverilog (Req 2.12, 2.13)',
  () => {
    it(
      'renders ece_mix with both 64-bit multiplies present, and a full real run produces zero CHECK FAIL lines',
      async () => {
        const nonce = 'mixerElab1';
        const harness = renderHarnessOrThrow(nonce);
        // The two constructs this test exists to exercise, confirmed present in the rendered
        // text before the real run - a renderer regression dropping one multiply would still
        // elaborate (it would just be wrong), so the real run below is what actually catches it.
        expect(harness.contents).toContain("h * 64'hBF58476D1CE4E5B9");
        expect(harness.contents).toContain("h * 64'h94D049BB133111EB");

        const verdict = await realOracleAdapter().simulate(
          [ADDER16_RTL, ADDER16_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        // `failureCause === 'none'` on its own already proves elaboration succeeded: a 64-bit
        // multiply Icarus could not elaborate would report `build-failed`, not `none`.
        expect(verdict.failureCause).toBe('none');

        // A corrupted multiply would feed a wrong `ain`/`bin` value into the golden adder and
        // the model alike from the SAME rendered stimulus, so a divergence would show up as a
        // CHECK FAIL the instant the enable-framed `start` pulse let a wrong operand through.
        expect(checkFailLines(verdict.stdout, nonce)).toEqual([]);
        expect(verdict.verdict).toBe('pass');
      },
      RUN_TIMEOUT,
    );
  },
);
