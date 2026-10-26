// The prompt's worked example must be right, or every draw copies a wrong encoding (Q-19).
// Runs the example's four bodies against a matching RTL through the real Consensus_Harness.

import { describe, expect, it } from 'vitest';

import { makeTimingContract } from '@app/core';
import type { ResourceLimits } from '@app/tools';

import {
  EXAMPLE2_DRAFT,
  EXAMPLE2_INTERFACE,
  EXAMPLE2_TIMING,
  EXAMPLE_DRAFT,
  EXAMPLE_INTERFACE,
  EXAMPLE_TIMING,
} from '../agent/roles/reference-model/canonical-example.js';
import { renderRefModel } from '../eval/consensus-regression/pilot.js';
import { renderConsensusHarness } from '../tools/simulator/consensus-harness.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
const NONCE = 'pexample01';

const EXAMPLE_RTL = `module ece_example_down(input clk, input rst_n, input en, output reg [2:0] cnt, output zero);
  assign zero = (cnt == 3'd0);
  always @(posedge clk or negedge rst_n)
    if (!rst_n) cnt <= 3'd5;
    else if (en) cnt <= (cnt == 3'd0) ? 3'd5 : cnt - 3'd1;
endmodule
`;

/** The example RTL with a reset value of 0, which the example's reset body must catch. */
const ZERO_RESET_RTL = EXAMPLE_RTL.replace("cnt <= 3'd5;\n    else", "cnt <= 3'd0;\n    else");

describe.skipIf(!PROBE.available)('the Reference_Model prompt example (Q-19)', () => {
  async function simulate(rtl: string) {
    const harness = renderConsensusHarness({
      moduleInterface: EXAMPLE_INTERFACE,
      timingContract: EXAMPLE_TIMING,
      nonce: NONCE,
      watchdogBudgetNs: 2_000_000,
      sampleBudget: 32,
      roles: EXAMPLE_DRAFT.roles,
    });
    if (!harness.ok) throw new Error(`fixture defect: ${harness.error.code}`);
    const refModel = renderRefModel(EXAMPLE_INTERFACE, EXAMPLE_DRAFT).file;
    return realOracleAdapter().simulate(
      [{ path: 'example.v', contents: rtl }, refModel],
      harness.value,
      LIMITS,
    );
  }

  it('declares a Timing_Contract the domain constructor accepts', () => {
    const built = makeTimingContract(EXAMPLE_INTERFACE, EXAMPLE_TIMING.entries);
    expect(built.ok).toBe(true);
  });

  it('passes its own RTL at every sampled step', async () => {
    const verdict = await simulate(EXAMPLE_RTL);
    expect(verdict.verdict).toBe('pass');
    expect(verdict.stdout).toContain(`ECE_SAMPLE_END ${NONCE} 32`);
  }, 60_000);

  it('fails an RTL whose reset value differs, so the example is not vacuous', async () => {
    const verdict = await simulate(ZERO_RESET_RTL);
    expect(verdict.verdict).not.toBe('pass');
    expect(verdict.stdout).toMatch(new RegExp(`CHECK ${NONCE}_cnt FAIL`, 'u'));
  }, 60_000);
});

// The second example teaches the one thing the first cannot: a registered output the input
// determines, whose value now is a register the state has to carry. It is prompt text every draw
// copies, so it is run against a matching RTL rather than asserted.
const EXAMPLE2_RTL = `module ece_example_changed(input clk, input rst_n, input [1:0] d, output reg changed);
  reg [1:0] d_prev;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) begin
      d_prev <= 2'd0;
      changed <= 1'b0;
    end else begin
      d_prev <= d;
      changed <= (d != d_prev);
    end
endmodule
`;

/** The same design one edge early: `changed` combinational, which the example must not accept. */
const EARLY_RTL = `module ece_example_changed(input clk, input rst_n, input [1:0] d, output changed);
  reg [1:0] d_prev;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) d_prev <= 2'd0;
    else d_prev <= d;
  assign changed = (d != d_prev);
endmodule
`;

describe.skipIf(!PROBE.available)('the second Reference_Model prompt example', () => {
  const nonce = 'pexample02';
  async function simulate(rtl: string) {
    const harness = renderConsensusHarness({
      moduleInterface: EXAMPLE2_INTERFACE,
      timingContract: EXAMPLE2_TIMING,
      nonce,
      watchdogBudgetNs: 2_000_000,
      sampleBudget: 32,
      roles: EXAMPLE2_DRAFT.roles,
    });
    if (!harness.ok) throw new Error(`fixture defect: ${harness.error.code}`);
    const refModel = renderRefModel(EXAMPLE2_INTERFACE, EXAMPLE2_DRAFT).file;
    return realOracleAdapter().simulate(
      [{ path: 'example2.v', contents: rtl }, refModel],
      harness.value,
      LIMITS,
    );
  }

  it('declares a Timing_Contract the domain constructor accepts', () => {
    expect(makeTimingContract(EXAMPLE2_INTERFACE, EXAMPLE2_TIMING.entries).ok).toBe(true);
  });

  it('passes its own RTL at every sampled step', async () => {
    const verdict = await simulate(EXAMPLE2_RTL);
    expect(verdict.verdict).toBe('pass');
    expect(verdict.stdout).toContain(`ECE_SAMPLE_END ${nonce} 32`);
  }, 60_000);

  it('fails the same behaviour one edge early, so the registered timing is not vacuous', async () => {
    const verdict = await simulate(EARLY_RTL);
    expect(verdict.verdict).not.toBe('pass');
    expect(verdict.stdout).toMatch(new RegExp(`CHECK ${nonce}_changed FAIL`, 'u'));
  }, 60_000);
});
