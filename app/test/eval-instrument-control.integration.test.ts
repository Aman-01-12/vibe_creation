// The POSITIVE CONTROL against the REAL Icarus toolchain, pinning the ACTUAL regression
// that motivated it.
//
// THE REGRESSION, AS OBSERVED
//   The first real smoke sweep reported pass@1 = 0.333. On `rtllm/memory/right_shifter` our
//   agent-written testbench rejected the candidate - and it rejects RTLLM's OWN
//   human-verified reference design byte-identically:
//
//     CHECK ac1_under_simulation_right_shifter_produces FAIL
//     ERROR at fill-1s step 0: expected q=10000000, got q=11010101
//
//   The testbench's "fill-1s" phase expects `q == 0` at its start, but the design declares
//   no reset port, so the zero state cannot be re-established after the testbench's own
//   earlier stimulus. Our testbench invented a capability the interface does not have. That
//   sample therefore measured OUR INSTRUMENT, and the pass@1 number attributed it to the
//   model.
//
// WHY THE FIXTURE IS THE REAL ARTIFACT
//   `fixtures/smoke-v2/right-shifter-testbench.v` is the testbench that actually produced
//   that verdict, copied verbatim out of the smoke run's per-sample artifacts so this suite
//   does not depend on a run directory. A hand-invented testbench could be made to fail on
//   purpose and would prove nothing; this one already failed, in production, for a reason we
//   had to find by hand.
//
// NON-VACUOUS IN BOTH DIRECTIONS
//   A control that always says `invalid` would pass the assertion below and be worthless.
//   So the same reference design, driven by a testbench that respects the declared interface
//   (no reset, `initial q = 0` at time zero only), is required to come back `valid`; and a
//   testbench that cannot elaborate is required to come back with the DID-NOT-BUILD defect
//   rather than the rejected-reference one.
//
// GATING
//   The real toolchain and the pinned corpus checkout are each probed, never assumed, using
//   the same seams as `./rtllm-corpus-stage0.integration.test.ts`. When either is absent the
//   suite SKIPS with a reason and does not fetch anything: a test that reaches the network is
//   not a test.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTROL_TESTBENCH_WORKSPACE_FILENAME,
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
  RtllmInstrumentControl,
  type InstrumentControlResult,
  type ReferenceDesign,
} from '@app/eval';
import {
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SandboxToolRunner,
  type ResourceLimits,
} from '@app/tools';

import { PROBE } from './real-oracle-harness.js';

// -- The design this suite is about -----------------------------------------

/** The problem whose instrument the smoke sweep proved broken. */
const PROBLEM_ID = 'rtllm/memory/right_shifter';

/** The check name our generated testbench signals its whole-design verdict with. */
const CHECK_NAME = 'ac1_under_simulation_right_shifter_produces';

// -- Corpus availability probe ----------------------------------------------

/** Whether the pinned checkout is present, and why not when it is absent. */
async function probeCorpus(): Promise<{ readonly available: boolean; readonly reason: string }> {
  const categories = await new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH).listDirectories([]);
  if (categories.length === 0) {
    return {
      available: false,
      reason: `no RTLLM checkout at the pinned commit ${RTLLM_PINNED_COMMIT}; run \`npm run corpus:fetch\``,
    };
  }
  return { available: true, reason: 'the pinned RTLLM checkout is present' };
}

const CORPUS = await probeCorpus();

const SKIP_REASON = !PROBE.available ? PROBE.reason : CORPUS.reason;
const RUNNABLE = PROBE.available && CORPUS.available;

if (!RUNNABLE) {
  console.warn(
    `[eval-instrument-control] the positive control was NOT exercised: ${SKIP_REASON}. The ` +
      'right_shifter instrument regression is therefore recorded rather than reproduced in ' +
      'this environment.',
  );
}

// -- Real-run configuration -------------------------------------------------

/**
 * Generous real-run caps: a local worker launch plus a real iverilog+vvp run.
 *
 * The SHAPE of a student session's caps, with only the wall clock widened, exactly as the
 * Stage 0 suite does - the control runs on the same rails as the oracle.
 */
const REAL_LIMITS: ResourceLimits = {
  cpu: 1,
  memMb: 1024,
  procs: 256,
  diskMb: 256,
  wallMs: 60_000,
};

/** Timeout for one real compile-and-simulate run. */
const RUN_TIMEOUT_MS = 120_000;

/** This suite's directory, for reading the captured fixture. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The testbench our smoke run actually produced, read verbatim from the fixture. */
function smokeRunTestbench(): Promise<string> {
  return readFile(join(HERE, 'fixtures', 'smoke-v2', 'right-shifter-testbench.v'), 'utf8');
}

/**
 * A testbench that RESPECTS the declared interface: it never assumes a reset.
 *
 * The reference sets `q` to 0 with an `initial` block, so zero is observable at time zero and
 * never again. This testbench therefore models the shift from whatever `q` already is,
 * instead of demanding the design return to zero mid-run - which is precisely the assumption
 * the smoke-run testbench made and could not justify.
 */
const RESET_FREE_TESTBENCH = `\`timescale 1ns/1ps
module right_shifter_control_tb;
  reg clk;
  reg d;
  wire [7:0] q;
  reg [7:0] expected;
  integer step;
  reg ok;

  right_shifter dut (.clk(clk), .d(d), .q(q));

  initial clk = 1'b0;
  always #5 clk = ~clk;

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, right_shifter_control_tb);
    ok = 1'b1;
    d = 1'b0;
    // Sample the initial state on the first falling edge, before any shift is applied.
    @(negedge clk);
    expected = q;
    for (step = 0; step < 12; step = step + 1) begin
      d = step[0];
      @(posedge clk);
      expected = {d, expected[7:1]};
      @(negedge clk);
      if (q !== expected) begin
        ok = 1'b0;
      end
    end
    if (ok)
      $display("CHECK ${CHECK_NAME} PASS");
    else
      $display("CHECK ${CHECK_NAME} FAIL");
    $finish;
  end
endmodule
`;

/** A testbench that cannot elaborate, to separate did-not-build from rejected. */
const UNBUILDABLE_TESTBENCH = `\`timescale 1ns/1ps
module right_shifter_broken_tb;
  reg clk;
  // Deliberately connects a port the design does not declare, so elaboration fails.
  right_shifter dut (.clk(clk), .reset_n(clk));
  initial begin
    $dumpfile("dump.vcd");
    $display("CHECK ${CHECK_NAME} PASS");
    $finish;
  end
endmodule
`;

/** The control over the pinned corpus, on the real toolchain. */
async function realControl(): Promise<{
  readonly control: RtllmInstrumentControl;
  readonly reference: ReferenceDesign;
}> {
  const corpus = await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH));
  const reference = corpus.references.get(PROBLEM_ID);
  if (reference === undefined) {
    throw new Error(`the pinned corpus has no reference design for ${PROBLEM_ID}`);
  }
  const simulator = new IcarusSimulatorAdapter(
    new SandboxToolRunner(new LocalWorkerRuntime(PROBE.pythonBin)),
  );
  // No negative control here: this suite is about the POSITIVE one, and wiring the mutation
  // probe would spend a mutant set's worth of simulations per assertion to measure something
  // `./eval-negative-control.integration.test.ts` covers directly.
  return {
    control: new RtllmInstrumentControl({ simulator, references: corpus.references }),
    reference,
  };
}

/** Run one testbench through the control against the pinned reference design. */
async function check(testbench: string): Promise<InstrumentControlResult> {
  const { control } = await realControl();
  const result = await control.check({
    problemId: PROBLEM_ID,
    testbench,
    limits: REAL_LIMITS,
  });
  if (result === null) {
    throw new Error(`the control reported no reference design for ${PROBLEM_ID}`);
  }
  return result;
}

// -- Tests ------------------------------------------------------------------

describe('positive-control capability probe', () => {
  it('documents whether the control was exercised in this environment', () => {
    // Always runs; on skip the note above has already recorded that it did not.
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)('the right_shifter instrument regression, on the real toolchain', () => {
  it(
    'classifies OUR smoke-run testbench INVALID because the reference design fails it',
    async () => {
      const result = await check(await smokeRunTestbench());

      // The whole feature in one assertion: this exact testbench judged a candidate in a
      // real sweep, and it cannot pass the design upstream says is correct.
      expect(result.verdict).toEqual({
        validity: 'invalid',
        defect: 'TESTBENCH_FAILED_REFERENCE',
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'captures the same evidence we found by hand, so the finding is diagnosable',
    async () => {
      const result = await check(await smokeRunTestbench());

      expect(result.stdout).toContain(`CHECK ${CHECK_NAME} FAIL`);
      // The reset assumption, in the testbench's own words.
      expect(result.stdout).toContain('fill-1s');
      expect(result.stdout).toContain('expected q=10000000');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'reads the reference through the importer rename, so no second rename exists',
    async () => {
      const { reference } = await realControl();

      // Upstream declares `verified_right_shifter`; our testbench instantiates
      // `right_shifter`. The importer already reconciled that, and the control reuses it.
      expect(reference.topModuleRenamedFrom).toBe('verified_right_shifter');
      expect(reference.rtl.contents).toContain('module right_shifter');
      expect(reference.rtl.contents).not.toContain('module verified_right_shifter');
    },
    RUN_TIMEOUT_MS,
  );
});

describe.skipIf(!RUNNABLE)('the control is non-vacuous', () => {
  it(
    'classifies a testbench that respects the declared interface as VALID',
    async () => {
      // Same reference, same toolchain, same control: only the instrument's assumption about
      // a reset changed. Without this, an always-invalid control would pass the suite above.
      const result = await check(RESET_FREE_TESTBENCH);

      expect(result.verdict).toEqual({ validity: 'valid' });
      expect(result.stdout).toContain(`CHECK ${CHECK_NAME} PASS`);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'separates a testbench that does not BUILD from one that rejects the reference',
    async () => {
      const result = await check(UNBUILDABLE_TESTBENCH);

      expect(result.verdict).toEqual({
        validity: 'invalid',
        defect: 'TESTBENCH_REFERENCE_UNBUILDABLE',
      });
      // The compiler's own words go to the control artifacts, never to a persisted note.
      expect(result.stderr.length).toBeGreaterThan(0);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'submits our testbench under the control workspace filename',
    async () => {
      // Pinned because a diagnostic that names `instrument_control_tb.v` in a compiler error
      // is how an operator tells a control run apart from an oracle run.
      const result = await check(UNBUILDABLE_TESTBENCH);

      expect(result.stderr).toContain(CONTROL_TESTBENCH_WORKSPACE_FILENAME);
    },
    RUN_TIMEOUT_MS,
  );
});
