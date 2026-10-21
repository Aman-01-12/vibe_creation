// Real-toolchain integration test: a full rendered harness compiles and runs end to end for all
// three interface shapes the renderer treats as structurally different text (task 8.5, C5, C6, C7).
//
// WHY THREE SHAPES, AND WHY EACH ONE OWNS ITS OWN RENDERED TEXT
//
//   `renderConsensusHarness` branches its rendered text on `clockName !== null` and
//   `resetName !== null`, not on a single flag, so three real combinations exist:
//     1. clocked, reset-bearing: the common corpus shape - a mid-run reset task is rendered,
//        state is primed inside the loop's `(step % ECE_RESET_FRAME) == 0` branch (Req 5.1-5.3).
//     2. clockless (purely combinational): no clock statements, no reset task, state primed on
//        `step == 0` (Req 5.8).
//     3. clocked, NO declared reset port: a corpus-shaped population is almost all reset-bearing
//        (design.md's own observation), so this shape is rare enough that nothing else in this
//        spec's test suite constructs it - it gets a pre-loop settle of RESET_CYCLES edges and
//        primes state on `step == 0`, DIFFERENT rendered text from both shapes above, not a
//        conditional default over shape 1's template.
//
// WHAT "A MATCHING COUNT" MEANS, AND WHY IT IS MEASURED FROM REAL STDOUT
//
//   `reduceSignature` (`app/agent/consensus/signature.ts`, C9) requires one `ECE_SAMPLE` line per
//   step with no gap and exactly one `ECE_SAMPLE_END <nonce> <count>` whose count matches the
//   number of ECE_SAMPLE lines actually read - a reset-induced off-by-one (an extra or a missing
//   sample at a reset boundary) would under- or over-count here, which is exactly the class of
//   defect a text-only check of the rendered loop cannot see. The rendered
//   `localparam integer ECE_SAMPLE_BUDGET` is checked against the REAL emitted line count, not
//   against the requested budget, so the width-derived sizing (`sizedSampleBudget`) is measured
//   against the stream it actually produced rather than assumed equal to the request.

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
    `[consensus-full-harness-smoke.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'All three rendered interface shapes are UNVALIDATED against real iverilog in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
const RUN_TIMEOUT = 60_000;
const SAMPLE_COUNT = 10;

function renderHarnessOrThrow(
  moduleInterface: ModuleInterface,
  timingEntries: readonly {
    readonly portName: string;
    readonly timing: 'registered' | 'combinational';
  }[],
  nonce: string,
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
    sampleBudget: SAMPLE_COUNT,
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

/** How many `ECE_SAMPLE <nonce> ...` lines real stdout carries. */
function sampleLineCount(stdout: string, nonce: string): number {
  const pattern = new RegExp(`^ECE_SAMPLE ${nonce} `);
  return stdout.split('\n').filter((line) => pattern.test(line)).length;
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

/** The rendered `ECE_SAMPLE_BUDGET` localparam's integer value, read from the harness text. */
function renderedSampleBudget(harnessText: string): number {
  const match = /localparam integer ECE_SAMPLE_BUDGET = (\d+);/.exec(harnessText);
  if (match === null) {
    throw new Error('fixture defect: ECE_SAMPLE_BUDGET localparam not found in rendered text');
  }
  return Number(match[1]);
}

function checkFailLines(stdout: string, nonce: string): readonly string[] {
  const pattern = new RegExp(`^CHECK ${nonce}_\\w+ FAIL`);
  return stdout.split('\n').filter((line) => pattern.test(line.trim()));
}

// -- Shape 1: clocked, reset-bearing (the common corpus shape) ----------------------------------

const RESET_COUNTER_RTL: SourceFile = {
  path: 'reset_counter.v',
  contents: `module reset_counter (
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

const RESET_COUNTER_INTERFACE: ModuleInterface = {
  moduleName: 'reset_counter',
  ports: [{ name: 'q', direction: 'output', width: 4 }],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
  validityOutputName: null,
};

const RESET_COUNTER_REFERENCE_MODEL: SourceFile = {
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

// -- Shape 2: clockless (purely combinational) ---------------------------------------------------

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

// -- Shape 3: clocked, with NO declared reset port -----------------------------------------------

const NO_RESET_COUNTER_RTL: SourceFile = {
  path: 'no_reset_counter.v',
  contents: `module no_reset_counter (
  input  wire       clk,
  output reg  [3:0] q
);
  initial q = 4'd0;
  always @(posedge clk) begin
    q <= q + 4'd1;
  end
endmodule
`,
};

const NO_RESET_COUNTER_INTERFACE: ModuleInterface = {
  moduleName: 'no_reset_counter',
  ports: [{ name: 'q', direction: 'output', width: 4 }],
  clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

/**
 * A correctly-written Reference_Model for the no-reset shape. `ece_reset_state` still exists
 * (C7's header is rendered regardless of whether a reset PORT is declared) but the harness never
 * calls `ece_harness_reset` for this shape - state priming for this shape happens once, on
 * `step == 0`, from `ece_reset_state` alone.
 *
 * `ece_reset_state` must therefore predict the RTL's REAL value at step 0, not its
 * `initial` value: the harness's own pre-loop settle (`repeat (RESET_CYCLES)`, unchanged prior
 * behaviour for a clocked-but-resetless interface) drives 2 clock edges before step 0 with no
 * declared input port to gate on, and this counter free-runs on every edge - so by step 0 it has
 * already counted up twice, from 0 to 2.
 */
const NO_RESET_COUNTER_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "  ece_reset_state = 128'd2;",
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

describe('consensus full harness smoke real-toolchain capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'a full rendered harness compiles and runs end to end for all three interface shapes (Req 2.4, 3.3, 3.4, 5.5)',
  () => {
    it(
      'shape 1 (clocked, reset-bearing): emits exactly ECE_SAMPLE_BUDGET sample lines, a matching end marker, and zero CHECK FAIL',
      async () => {
        const nonce = 'shapeReset1';
        const harness = renderHarnessOrThrow(
          RESET_COUNTER_INTERFACE,
          [{ portName: 'q', timing: 'registered' }],
          nonce,
        );
        expect(harness.contents).toContain('ece_harness_reset');
        expect(harness.contents).toContain('ECE_RESET_FRAME');

        const verdict = await realOracleAdapter().simulate(
          [RESET_COUNTER_RTL, RESET_COUNTER_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');
        expect(checkFailLines(verdict.stdout, nonce)).toEqual([]);
        expect(verdict.verdict).toBe('pass');

        const emitted = sampleLineCount(verdict.stdout, nonce);
        expect(emitted).toBe(renderedSampleBudget(harness.contents));
        expect(endMarkerCount(verdict.stdout, nonce)).toBe(emitted);

        const signature = reduceSignature(verdict.stdout, nonce, RESET_COUNTER_INTERFACE);
        expect(signature).not.toBeNull();
        expect(signature?.sampleCount).toBe(emitted);
      },
      RUN_TIMEOUT,
    );

    it(
      'shape 2 (clockless, purely combinational): no clock statements, no reset task, exactly ECE_SAMPLE_BUDGET sample lines and a matching end marker',
      async () => {
        const nonce = 'shapeComb1';
        const harness = renderHarnessOrThrow(
          ADDER_INTERFACE,
          [{ portName: 'sum', timing: 'combinational' }],
          nonce,
        );
        expect(harness.contents).not.toContain('ece_harness_reset');
        expect(harness.contents).not.toContain('ECE_RESET_FRAME');
        expect(harness.contents).not.toContain('ece_clk');

        const verdict = await realOracleAdapter().simulate(
          [ADDER_RTL, ADDER_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');
        expect(checkFailLines(verdict.stdout, nonce)).toEqual([]);
        expect(verdict.verdict).toBe('pass');

        const emitted = sampleLineCount(verdict.stdout, nonce);
        expect(emitted).toBe(renderedSampleBudget(harness.contents));
        expect(endMarkerCount(verdict.stdout, nonce)).toBe(emitted);

        const signature = reduceSignature(verdict.stdout, nonce, ADDER_INTERFACE);
        expect(signature).not.toBeNull();
        expect(signature?.sampleCount).toBe(emitted);
      },
      RUN_TIMEOUT,
    );

    it(
      'shape 3 (clocked, no declared reset port): different rendered text from shape 1, exactly ECE_SAMPLE_BUDGET sample lines and a matching end marker',
      async () => {
        const nonce = 'shapeNoRst1';
        const harness = renderHarnessOrThrow(
          NO_RESET_COUNTER_INTERFACE,
          [{ portName: 'q', timing: 'registered' }],
          nonce,
        );
        // Req 5.8: no reset to assert, so no reset task and no ECE_RESET_FRAME localparam at
        // all - genuinely different rendered text, not shape 1's template with a branch taken.
        expect(harness.contents).not.toContain('ece_harness_reset');
        expect(harness.contents).not.toContain('ECE_RESET_FRAME');
        expect(harness.contents).toContain('if (step == 0)');

        const verdict = await realOracleAdapter().simulate(
          [NO_RESET_COUNTER_RTL, NO_RESET_COUNTER_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');
        expect(checkFailLines(verdict.stdout, nonce)).toEqual([]);
        expect(verdict.verdict).toBe('pass');

        const emitted = sampleLineCount(verdict.stdout, nonce);
        expect(emitted).toBe(renderedSampleBudget(harness.contents));
        expect(endMarkerCount(verdict.stdout, nonce)).toBe(emitted);

        const signature = reduceSignature(verdict.stdout, nonce, NO_RESET_COUNTER_INTERFACE);
        expect(signature).not.toBeNull();
        expect(signature?.sampleCount).toBe(emitted);
      },
      RUN_TIMEOUT,
    );
  },
);
