// Real-toolchain integration test: one pair simulated twice yields an identical digest (task 8.4;
// Req 4.9, 7.7). The simulator half of Property 16's determinism claim; the pure half (over a
// fixed stdout string) is task 2.3.
//
// WHAT THIS CHECKS, AND WHY IT MUST GO THROUGH THE REAL TOOLCHAIN
//   Determinism follows from there being no random source, no `$time`-dependent value, and no
//   process race in the rendered harness text. That is an ARGUMENT about the TEXT; this test
//   checks the OUTCOME against the real simulator, because the argument is exactly what this test
//   exists to verify rather than assume.
//
//   Two clauses: running the SAME (design, testbench) pair twice with the SAME nonce yields the
//   same digest (ordinary reproducibility); running the SAME pair twice with DIFFERENT nonces
//   STILL yields the same digest, which is the sharper claim. The digest is computed by
//   `reduceSignature` over the REDUCED value trace, never over the raw stdout text the nonce
//   changes - if the nonce reached a value the DUT sees, or leaked into the digest computation
//   itself, this second clause would fail.

import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ClockingContract, type ModuleInterface } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import { reduceSignature } from '../agent/consensus/signature.js';
import {
  renderConsensusHarness,
  type ConsensusHarnessRequest,
} from '../tools/simulator/consensus-harness.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[consensus-determinism.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'The simulator half of Property 16 is UNVALIDATED against real iverilog in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
const RUN_TIMEOUT = 60_000;

/** A simple 4-bit synchronous up-counter with sync reset, the shared fixture's own Candidate_Design. */
const COUNTER_RTL = `module counter (
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
`;

const COUNTER_CLOCKING: ClockingContract = {
  clockName: 'clk',
  resetName: 'rst',
  resetActiveLow: false,
};

const COUNTER_INTERFACE: ModuleInterface = {
  moduleName: 'counter',
  ports: [{ name: 'q', direction: 'output', width: 4 }],
  clocking: COUNTER_CLOCKING,
  validityOutputName: null,
};

/** A correctly-written Reference_Model: it mirrors the counter's own increment-with-reset logic. */
const COUNTER_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "  ece_reset_state = 128'd0;",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [0:0] in);',
    "  ece_next_state = s + {127'd0, in};",
    'endfunction',
    'function automatic [3:0] ece_expect(input [127:0] s, input [0:0] in);',
    "  ece_expect = s[3:0] + {3'd0, in};",
    'endfunction',
    '',
  ].join('\n'),
};

/** Build and render a `ConsensusHarnessRequest` for `nonce`, throwing on an unexpected refusal. */
function renderHarnessFor(nonce: string): SourceFile {
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
    sampleBudget: 8,
    roles: [],
  };
  const rendered = renderConsensusHarness(request);
  if (!rendered.ok) {
    throw new Error(`fixture defect: ${rendered.error.code}`);
  }
  return rendered.value;
}

/** Compile and run the shared counter fixture once, for the given nonce, through the real simulator. */
async function runOnce(nonce: string): Promise<string> {
  const harness = renderHarnessFor(nonce);
  const candidate: SourceFile = { path: 'counter.v', contents: COUNTER_RTL };
  const verdict = await realOracleAdapter().simulate(
    [candidate, COUNTER_REFERENCE_MODEL],
    harness,
    REAL_LIMITS,
  );
  if (verdict.failureCause !== 'none') {
    throw new Error(`fixture defect: run did not complete (${verdict.failureCause})`);
  }
  return verdict.stdout;
}

/** `reduceSignature`'s digest for `stdout` under `nonce`, throwing if the run is read as incomplete. */
function digestOf(stdout: string, nonce: string): string {
  const signature = reduceSignature(stdout, nonce, COUNTER_INTERFACE);
  if (signature === null) {
    throw new Error('fixture defect: stdout did not reduce to a complete signature');
  }
  return signature.digest;
}

describe('consensus determinism capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'one Candidate_Design x Reference_Model_Testbench pair simulated twice yields an identical digest (Req 4.9, 7.7)',
  () => {
    it(
      'with the nonce held constant, two real runs yield the same digest',
      async () => {
        const first = await runOnce('nonceAAA');
        const second = await runOnce('nonceAAA');

        expect(digestOf(second, 'nonceAAA')).toBe(digestOf(first, 'nonceAAA'));
      },
      RUN_TIMEOUT * 2,
    );

    it(
      'with the nonce VARIED between the two runs, the digest is STILL the same - the nonce ' +
        'reaches no value the DUT sees and never enters the digest computation',
      async () => {
        const first = await runOnce('nonceAAA');
        const second = await runOnce('nonceBBB');

        expect(digestOf(second, 'nonceBBB')).toBe(digestOf(first, 'nonceAAA'));
      },
      RUN_TIMEOUT * 2,
    );
  },
);
