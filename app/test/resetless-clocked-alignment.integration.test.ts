// A clocked interface with NO declared reset must start the Reference_Model and the design in the
// same state. Measured against real iverilog, because the defect it guards was a timing
// relationship between rendered statements, which no text-shape assertion can see.
//
// WHAT WENT WRONG BEFORE
//   The harness clocked RESET_CYCLES edges before entering the per-step loop for a resetless
//   clocked interface. There is no reset to assert on such an interface, so those edges settled
//   nothing: `ece_in_bits` was still unassigned, so each edge clocked an unknown into the
//   design's registers, and the design stayed that many edges ahead of `ece_state` for the whole
//   run. On `rtllm/memory/right_shifter` every one of the 64 design x testbench pairs mismatched
//   with `failureCause: 'none'` - all ran, all disagreed - while all 8 Reference_Models were
//   correct and all 8 designs initialised `q` exactly as the Spec asks.
//
// WHY A SHIFT REGISTER IS THE RIGHT FIXTURE
//   Its output is its whole state and every step shifts one input bit in, so a single spurious
//   pre-loop edge is visible forever rather than washing out: the design's `q` holds a different
//   window of the input history than the model's for every subsequent step.

import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import { renderConsensusHarness } from '../tools/simulator/consensus-harness.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** `right_shifter`'s real declared interface: clocked, no reset port, one data input. */
const SHIFTER_INTERFACE: ModuleInterface = {
  moduleName: 'right_shifter',
  ports: [
    { name: 'q', direction: 'output', width: 8 },
    { name: 'd', direction: 'input', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

/** A real Candidate_Design, which initialises `q` to 0 as its Spec requires of it. */
const SHIFTER_RTL: SourceFile = {
  path: 'right_shifter.v',
  contents: `module right_shifter (
    output reg [7:0] q,
    input d,
    input clk
);
    initial begin
        q = 8'b0;
    end
    always @(posedge clk) begin
        q <= {d, q[7:1]};
    end
endmodule
`,
};

/** A real Reference_Model: `q` is the whole state, so its expectation reads `s` alone. */
const SHIFTER_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "ece_reset_state = {120'd0, 8'd0};",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [0:0] in);',
    'reg [7:0] q_next;',
    'begin',
    '  q_next = {in[0], s[7:1]};',
    "  ece_next_state = {120'd0, q_next};",
    'end',
    'endfunction',
    'function automatic [7:0] ece_expect(input [127:0] s, input [0:0] in);',
    'ece_expect = s[7:0];',
    'endfunction',
    '',
  ].join('\n'),
};

/** Every `CHECK <nonce>_<port> FAIL...` line in real stdout; the harness's own verdict lines. */
function checkFailures(stdout: string, nonce: string): readonly string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(`CHECK ${nonce}_`) && line.includes('FAIL'));
}

describe.skipIf(!PROBE.available)(
  'a resetless clocked interface starts the design and the Reference_Model aligned (Req 5.8)',
  () => {
    it('a correct right_shifter passes its own correct Reference_Model with no CHECK failure', async () => {
      const nonce = 'noreset01';
      const timing = makeTimingContract(SHIFTER_INTERFACE, [
        { portName: 'q', timing: 'registered' },
      ]);
      if (!timing.ok) throw new Error(`fixture defect: ${timing.error.code}`);
      const rendered = renderConsensusHarness({
        moduleInterface: SHIFTER_INTERFACE,
        timingContract: timing.value,
        nonce,
        watchdogBudgetNs: 2_000_000,
        sampleBudget: 64,
        roles: [{ portName: 'd', role: 'data' }],
      });
      if (!rendered.ok) throw new Error(`fixture defect: ${rendered.error.code}`);

      const verdict = await realOracleAdapter().simulate(
        [SHIFTER_RTL, SHIFTER_REFERENCE_MODEL],
        rendered.value,
        LIMITS,
      );

      expect(verdict.failureCause).toBe('none');
      expect(checkFailures(verdict.stdout, nonce)).toEqual([]);
    }, 60_000);
  },
);
