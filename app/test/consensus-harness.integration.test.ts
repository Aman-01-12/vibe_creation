// Real-toolchain integration test: the rendered Consensus_Harness compiles, runs, and emits a
// well-formed stream (task 8.3; Req 4.1, 4.2, 4.6, 6.3, 6.5, 6.6, 7.1).
//
// THREE REAL INTERFACE SHAPES, EACH COMPILED AND RUN END TO END
//   A clocked interface (a 4-bit counter), a clockless interface (a 4-bit adder), and an
//   interface whose Timing_Contract mixes `registered` and `combinational` across two outputs.
//
// THE STREAM SHAPE IS ASSERTED FROM REAL STDOUT, NOT FROM THE RENDERED TEXT
//   One `ECE_SAMPLE <nonce> <step> ...` line per step in increasing step order, the correct
//   number of hex values per line, and exactly one `ECE_SAMPLE_END <nonce> <count>` whose count
//   matches the number of ECE_SAMPLE lines actually present. Then the real stdout is fed to
//   `reduceSignature` and the trace it builds is checked against the fixture's own known-correct
//   behaviour - the renderer and the reducer are tied together through the simulator, neither
//   checked against its own opinion.
//
// THE FORGED $display LINE
//   A Reference_Model whose `ece_expect` body ALSO calls `$display` with a nonce that does not
//   match the harness's own run nonce. `reduceSignature` only reads ECE_SAMPLE/ECE_SAMPLE_END
//   lines matching the REAL nonce, so a forged line under a different nonce never contributes to
//   the reduced signature - measured against the real simulator, not assumed from the text.

import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import { reduceSignature } from '../agent/consensus/signature.js';
import {
  renderConsensusHarness,
  type ConsensusHarnessRequest,
} from '../tools/simulator/consensus-harness.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[consensus-harness.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'The rendered Consensus_Harness is UNVALIDATED against real iverilog in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
const RUN_TIMEOUT = 60_000;

/** Build and render a `ConsensusHarnessRequest`, throwing loudly on an unexpected refusal. */
function renderHarnessOrThrow(
  moduleInterface: ModuleInterface,
  timingEntries: readonly {
    readonly portName: string;
    readonly timing: 'registered' | 'combinational';
  }[],
  nonce: string,
  sampleBudget: number,
): SourceFile {
  const timingBuilt = makeTimingContract(moduleInterface, timingEntries);
  if (!timingBuilt.ok) {
    throw new Error(`fixture defect: ${timingBuilt.error.code}`);
  }
  const request: ConsensusHarnessRequest = {
    moduleInterface,
    timingContract: timingBuilt.value,
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget,
    roles: moduleInterface.ports
      .filter((port) => port.direction === 'input')
      .map((port) => ({ portName: port.name, role: 'data' as const })),
  };
  const rendered = renderConsensusHarness(request);
  if (!rendered.ok) {
    throw new Error(`fixture defect: ${rendered.error.code}`);
  }
  return rendered.value;
}

/** Parse every `ECE_SAMPLE <nonce> <step> <values...>` line's step and hex-value-count from real stdout. */
function sampleLineShapes(
  stdout: string,
  nonce: string,
): readonly { step: number; valueCount: number }[] {
  const pattern = new RegExp(`^ECE_SAMPLE ${nonce} (\\d+) (.+)$`);
  return stdout
    .split('\n')
    .map((line) => pattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      step: Number(match[1]),
      valueCount: (match[2] as string).trim().split(/\s+/).length,
    }));
}

/** The single `ECE_SAMPLE_END <nonce> <count>` line's count, or null if absent/duplicated. */
function endMarkerCount(stdout: string, nonce: string): number | null {
  const pattern = new RegExp(`^ECE_SAMPLE_END ${nonce} (\\d+)$`);
  const matches = stdout
    .split('\n')
    .map((line) => pattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  return matches.length === 1 ? Number((matches[0] as RegExpExecArray)[1]) : null;
}

// -- Fixture 1: a clocked interface (4-bit synchronous up-counter) ------------------------------

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

/** A correctly-written Reference_Model mirroring the counter's own increment-with-reset logic. */
function counterReferenceModel(forgedDisplay = ''): SourceFile {
  return {
    path: 'refmodel.v',
    contents: [
      'function automatic [127:0] ece_reset_state(input dummy);',
      "  ece_reset_state = 128'd0;",
      'endfunction',
      'function automatic [127:0] ece_next_state(input [127:0] s, input [0:0] in);',
      "  ece_next_state = s + {127'd0, in};",
      'endfunction',
      'function automatic [3:0] ece_expect(input [127:0] s, input [0:0] in);',
      forgedDisplay,
      "  ece_expect = s[3:0] + {3'd0, in};",
      'endfunction',
      '',
    ].join('\n'),
  };
}

// -- Fixture 2: a clockless (combinational) interface (4-bit adder) -----------------------------

const ADDER_RTL: SourceFile = {
  path: 'adder.v',
  contents: `module adder (
  input  wire [3:0] a,
  input  wire [3:0] b,
  output wire [4:0] sum
);
  assign sum = a + b;
endmodule
`,
};

const ADDER_INTERFACE: ModuleInterface = {
  moduleName: 'adder',
  ports: [
    { name: 'a', direction: 'input', width: 4 },
    { name: 'b', direction: 'input', width: 4 },
    { name: 'sum', direction: 'output', width: 5 },
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

/** A correctly-written Reference_Model mirroring the adder's own a+b logic. */
const ADDER_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "  ece_reset_state = 128'd0;",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [7:0] in);',
    '  ece_next_state = s;',
    'endfunction',
    'function automatic [4:0] ece_expect(input [127:0] s, input [7:0] in);',
    "  ece_expect = {1'b0, in[7:4]} + {1'b0, in[3:0]};",
    'endfunction',
    '',
  ].join('\n'),
};

// -- Fixture 3: a mixed Timing_Contract (registered AND combinational on one interface) ---------

const MIXED_RTL: SourceFile = {
  path: 'mixed_dut.v',
  contents: `module mixed_dut (
  input  wire       clk,
  input  wire       rst,
  input  wire [3:0] a,
  output reg  [3:0] q,
  output wire [3:0] passthrough
);
  always @(posedge clk) begin
    if (rst)
      q <= 4'd0;
    else
      q <= a;
  end
  assign passthrough = a;
endmodule
`,
};

const MIXED_INTERFACE: ModuleInterface = {
  moduleName: 'mixed_dut',
  ports: [
    { name: 'a', direction: 'input', width: 4 },
    { name: 'q', direction: 'output', width: 4 },
    { name: 'passthrough', direction: 'output', width: 4 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
  validityOutputName: null,
};

/** A correctly-written Reference_Model: `q` registers `a` with one-cycle latency; `passthrough` is combinational. */
const MIXED_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "  ece_reset_state = 128'd0;",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [3:0] in);',
    "  ece_next_state = {124'd0, in};",
    'endfunction',
    'function automatic [7:0] ece_expect(input [127:0] s, input [3:0] in);',
    // Packed output bundle: q (registered, bits [3:0]) + passthrough (combinational, bits [7:4]).
    '  ece_expect = {in, s[3:0]};',
    'endfunction',
    '',
  ].join('\n'),
};

describe('consensus harness real-toolchain capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'the rendered Consensus_Harness compiles, runs, and emits a well-formed stream (Req 4.1, 4.2, 4.6, 7.1)',
  () => {
    it(
      'for a clocked interface: real stdout has one ECE_SAMPLE per step in order, correct hex count, and a matching end marker',
      async () => {
        const nonce = 'clkNonce1';
        const harness = renderHarnessOrThrow(
          COUNTER_INTERFACE,
          [{ portName: 'q', timing: 'registered' }],
          nonce,
          6,
        );
        const verdict = await realOracleAdapter().simulate(
          [COUNTER_RTL, counterReferenceModel()],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');

        const samples = sampleLineShapes(verdict.stdout, nonce);
        expect(samples.map((sample) => sample.step)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(samples.every((sample) => sample.valueCount === 1)).toBe(true);
        expect(endMarkerCount(verdict.stdout, nonce)).toBe(samples.length);

        const signature = reduceSignature(verdict.stdout, nonce, COUNTER_INTERFACE);
        expect(signature).not.toBeNull();
        expect(signature?.trace.map((record) => record.values[0])).toEqual([
          '0',
          '1',
          '2',
          '3',
          '4',
          '5',
        ]);
      },
      RUN_TIMEOUT,
    );

    it(
      'for a clockless interface: real stdout has one ECE_SAMPLE per step, correct hex count per output, and a matching end marker',
      async () => {
        const nonce = 'combNonce1';
        const harness = renderHarnessOrThrow(
          ADDER_INTERFACE,
          [{ portName: 'sum', timing: 'combinational' }],
          nonce,
          4,
        );
        const verdict = await realOracleAdapter().simulate(
          [ADDER_RTL, ADDER_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');
        // The harness now renders the stimulus itself from the Role_Declaration (hash-mixed,
        // not a literal step), so exact input values are no longer predictable here; the
        // Reference_Model agreeing with the real adder on whatever the harness drove IS the
        // "correctly mirrors a+b" claim, carried by the harness's own CHECK PASS/FAIL.
        expect(verdict.verdict).toBe('pass');

        const samples = sampleLineShapes(verdict.stdout, nonce);
        expect(samples.map((sample) => sample.step)).toEqual([0, 1, 2, 3]);
        expect(samples.every((sample) => sample.valueCount === 1)).toBe(true);
        expect(endMarkerCount(verdict.stdout, nonce)).toBe(samples.length);

        const signature = reduceSignature(verdict.stdout, nonce, ADDER_INTERFACE);
        expect(signature).not.toBeNull();
      },
      RUN_TIMEOUT,
    );

    it(
      'for an interface whose Timing_Contract mixes registered and combinational: both ports stream correctly',
      async () => {
        const nonce = 'mixedNonce1';
        const harness = renderHarnessOrThrow(
          MIXED_INTERFACE,
          [
            { portName: 'q', timing: 'registered' },
            { portName: 'passthrough', timing: 'combinational' },
          ],
          nonce,
          4,
        );
        const verdict = await realOracleAdapter().simulate(
          [MIXED_RTL, MIXED_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');
        // The harness now renders the stimulus itself from the Role_Declaration (hash-mixed,
        // not a literal step), so the exact `a` sequence is no longer predictable here; the
        // Reference_Model agreeing with the real DUT on whatever the harness drove IS the "q
        // registers a, passthrough tracks a" claim, carried by the harness's own CHECK PASS/FAIL.
        expect(verdict.verdict).toBe('pass');

        const samples = sampleLineShapes(verdict.stdout, nonce);
        expect(samples.map((sample) => sample.step)).toEqual([0, 1, 2, 3]);
        // Two output ports: q and passthrough, one hex value each per line.
        expect(samples.every((sample) => sample.valueCount === 2)).toBe(true);
        expect(endMarkerCount(verdict.stdout, nonce)).toBe(samples.length);

        const signature = reduceSignature(verdict.stdout, nonce, MIXED_INTERFACE);
        expect(signature).not.toBeNull();
      },
      RUN_TIMEOUT,
    );

    it(
      'discards a forged $display line under a MISMATCHED nonce - the nonce guarantee, measured against the real simulator',
      async () => {
        const realNonce = 'realNonce1';
        const forgedNonce = 'forgedNonce9';
        const harness = renderHarnessOrThrow(
          COUNTER_INTERFACE,
          [{ portName: 'q', timing: 'registered' }],
          realNonce,
          4,
        );
        // The Reference_Model's own body ALSO forges a CHECK line under a DIFFERENT nonce - a
        // model-authored line that was never supposed to be there, since the Reference_Model is
        // generated with no knowledge of the harness's real nonce (design.md's own stated reason
        // the nonce closes the forgery: the model cannot carry a nonce it never saw).
        const forgingReferenceModel = counterReferenceModel(
          `  $display("CHECK ${forgedNonce}_q PASS");`,
        );
        const verdict = await realOracleAdapter().simulate(
          [COUNTER_RTL, forgingReferenceModel],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');

        // The forged line IS present in raw stdout (the model's $display really ran)...
        expect(verdict.stdout).toContain(`CHECK ${forgedNonce}_q PASS`);
        // ...but reduceSignature, keyed to the REAL nonce, reports a complete, well-formed
        // signature with the correct counting trace - the forged line contributed nothing,
        // because it was never one of the real `ECE_SAMPLE`/`ECE_SAMPLE_END` lines this reducer
        // reads, and it carries no nonce this reducer would match against anyway.
        const signature = reduceSignature(verdict.stdout, realNonce, COUNTER_INTERFACE);
        expect(signature).not.toBeNull();
        expect(signature?.trace.map((record) => record.values[0])).toEqual(['0', '1', '2', '3']);
        expect(signature?.sampleCount).toBe(4);
      },
      RUN_TIMEOUT,
    );
  },
);
