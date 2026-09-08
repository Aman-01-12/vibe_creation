// Real Icarus oracle-path integration test (task 3.8).
//
// This test exercises the deterministic oracle END TO END against the REAL
// Icarus Verilog toolchain: it compiles and simulates representative Verilog +
// testbench pairs through the actual `iverilog` + `vvp` and asserts the
// pass/fail/error verdict the Simulator adapter derives, plus real-oracle
// determinism (Design: Testing Strategy (Integration tests), Tool_Runner sandbox
// design (Reproducibility); Req 1.4, 2.8). It is the non-vacuous, real-oracle
// counterpart to the mock-only Property 10 logic check in task 3.6.
//
// The real-oracle harness (capability probe, the "real oracle, local runtime"
// `LocalWorkerRuntime`, and the adapter builder) lives in `./real-oracle-harness`
// so it is defined once and shared with the Verification_Loop integration test
// (task 14.2). See that module's header for the exercised path and the skip
// mechanism. When `iverilog`/`vvp`/the worker Python are absent the real-oracle
// suites SKIP via `describe.skipIf(!PROBE.available)`, so a toolchain-less CI
// never fails spuriously and no false confidence is created.

import { describe, expect, it } from 'vitest';

import { type ResourceLimits, type SimulationVerdict, type SourceFile } from '@app/tools';

import {
  BUGGY_COUNTER_RTL,
  COUNTER_TESTBENCH,
  PASSING_COUNTER_RTL,
  PROBE,
  realOracleAdapter,
} from './real-oracle-harness.js';

if (!PROBE.available) {
  // A clear, single note that the real oracle was NOT exercised in this
  // environment (continuity-critical for the M0 checkpoint): the deterministic
  // oracle is wired and logic-tested, but unvalidated against real iverilog here.
  console.warn(
    `[icarus-oracle.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'iverilog/vvp (and the gVisor worker image) are unavailable, so the verdict ' +
      'and determinism assertions are SKIPPED in this environment.',
  );
}

// -- Fixtures ----------------------------------------------------------------
//
// The correct counter, buggy counter, and their spec-derived testbench are shared
// with the Verification_Loop integration test through the harness module. Only the
// compile-error variant, exercised solely here for the `error` verdict, is local.

/** RTL with a deliberate syntax error: iverilog fails to compile, so no waveform
 *  is produced and the run classifies as `error` (capture-all-or-error). */
const COMPILE_ERROR_RTL = `module counter (
  input  wire       clk,
  input  wire       rst,
  output reg  [3:0] count
);
  always @(posedge clk) begin
    count <= count + // deliberate unterminated expression
  end
endmodule
`;

// -- Harness ----------------------------------------------------------------

/** Generous real-run caps: local process startup plus a real iverilog+vvp run. */
const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** Compile-and-simulate one RTL + testbench pair through the real oracle. */
function simulatePair(rtl: string, testbench: string): Promise<SimulationVerdict> {
  const rtlFile: SourceFile = { path: 'counter.v', contents: rtl };
  const testbenchFile: SourceFile = { path: 'counter_tb.v', contents: testbench };
  return realOracleAdapter().simulate([rtlFile], testbenchFile, REAL_LIMITS);
}

/** Per-run timeout for a single real compile-and-simulate (ms). */
const RUN_TIMEOUT = 60_000;
/** Per-run timeout for the two-run determinism cases (ms). */
const DETERMINISM_TIMEOUT = 120_000;

// -- Tests ------------------------------------------------------------------

describe('icarus real-oracle capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    // Always runs; it asserts the probe is well-formed and, on skip, the note
    // above has already recorded that the real oracle was not exercised.
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'Icarus real oracle path (iverilog + vvp, local runtime; Req 1.4)',
  () => {
    it(
      'returns pass for a correct counter whose spec-derived checks all pass',
      async () => {
        const verdict = await simulatePair(PASSING_COUNTER_RTL, COUNTER_TESTBENCH);
        expect(verdict.verdict).toBe('pass');
        expect(verdict.checks.length).toBeGreaterThan(0);
        expect(verdict.checks.every((check) => check.passed)).toBe(true);
        expect(verdict.vcd).not.toBeNull();
      },
      RUN_TIMEOUT,
    );

    it(
      'returns fail for a buggy counter that violates a spec-derived check',
      async () => {
        const verdict = await simulatePair(BUGGY_COUNTER_RTL, COUNTER_TESTBENCH);
        expect(verdict.verdict).toBe('fail');
        expect(verdict.checks.some((check) => !check.passed)).toBe(true);
      },
      RUN_TIMEOUT,
    );

    it(
      'returns error for RTL that fails to compile (no waveform captured)',
      async () => {
        const verdict = await simulatePair(COMPILE_ERROR_RTL, COUNTER_TESTBENCH);
        expect(verdict.verdict).toBe('error');
        expect(verdict.vcd).toBeNull();
      },
      RUN_TIMEOUT,
    );
  },
);

describe.skipIf(!PROBE.available)(
  'Icarus real-oracle determinism (Property 10, non-vacuous; Req 2.8)',
  () => {
    it(
      'yields an identical pass verdict and checks when the same design runs twice',
      async () => {
        const first = await simulatePair(PASSING_COUNTER_RTL, COUNTER_TESTBENCH);
        const second = await simulatePair(PASSING_COUNTER_RTL, COUNTER_TESTBENCH);
        expect(first.verdict).toBe('pass');
        expect(second.verdict).toBe(first.verdict);
        expect(second.checks).toEqual(first.checks);
      },
      DETERMINISM_TIMEOUT,
    );

    it(
      'reproducibly classifies a failing design as fail across repeated runs',
      async () => {
        const first = await simulatePair(BUGGY_COUNTER_RTL, COUNTER_TESTBENCH);
        const second = await simulatePair(BUGGY_COUNTER_RTL, COUNTER_TESTBENCH);
        expect(first.verdict).toBe('fail');
        expect(second.verdict).toBe(first.verdict);
        expect(second.checks).toEqual(first.checks);
      },
      DETERMINISM_TIMEOUT,
    );
  },
);
