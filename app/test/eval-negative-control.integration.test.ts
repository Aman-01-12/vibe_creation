// The MUTATION-BASED NEGATIVE CONTROL against the REAL Icarus toolchain, pinning the ACTUAL
// regression that motivated it.
//
// THE REGRESSION, AS OBSERVED
//   `smoke-v4-oracle` recorded `MISSED BUGS: 1`. On `rtllm/arithmetic/multi_pipe_8bit` our
//   agent-written testbench PASSED a candidate that RTLLM's independent golden testbench fails
//   100/100. Its monitor DETECTED the disagreement - it printed roughly fourteen
//   `Time N: mul_out mismatch, expected X, got Y` lines - and then signalled:
//
//     CHECK ac1_under_simulation_multi_pipe_8bit_produce PASS
//
//   The mismatch never reached a flag the CHECK status reads, so the SIGNAL ITSELF says PASS. No
//   reader fix and no parser fix can catch that; the oracle is being told, correctly, that the
//   check passed.
//
//   The POSITIVE control read that sample `valid`, and was right to: the same testbench passes
//   the reference design too. It only checks the reset state and the final state, so it passes
//   essentially any design that starts and ends at zero. A control that proves a testbench CAN
//   pass the correct answer is structurally incapable of catching one that passes everything.
//
// WHAT THIS SUITE REQUIRES
//   That the negative control classifies that exact testbench INVALID under
//   `TESTBENCH_SURVIVED_MUTANTS`, on the real toolchain, and names the survivors it should have
//   killed - the mutants RTLLM's own golden testbench kills and ours does not.
//
// WHY THE FIXTURE IS THE REAL ARTIFACT
//   `fixtures/smoke-v4/multi-pipe-8bit-testbench.v` is the testbench that actually produced that
//   verdict, copied verbatim out of the smoke run's per-sample artifacts so this suite does not
//   depend on a run directory. A hand-written weak testbench could be made to survive on purpose
//   and would prove nothing; this one already shipped a false pass, in production.
//
// NON-VACUITY IS MANDATORY
//   A control that answered `invalid` unconditionally would satisfy the assertion above and be
//   worthless. So the SAME mutants, the SAME calibration, and the SAME toolchain are also driven
//   with a DISCRIMINATING testbench - one that checks the pipelined product on every cycle - and
//   that one is required to come back VALID. Both directions, or neither claim means anything.
//
// WHY THE NON-VACUITY CLAIM IS NOW THE SIMPLE ONE, MEASURED
//   Under the retired 0.95 kill-rate bar it could not be. This problem's 6 mutants all compile;
//   the golden testbench kills 2 (the two `temp[] + temp[]` sign flips) and is blind to 4. The
//   discriminating testbench kills 4 of the 6 - including two the golden judge misses - and
//   survives both `RESET_BRANCH_DISABLED` mutants, one of which is very likely a TRUE equivalent
//   mutant: disabling the reset on `mul_a_reg`/`mul_b_reg` is unobservable at the ports because
//   the reference's own line 41 already fails to reset `mul_b_reg`, so `temp[]` is X either way
//   and the un-mutated `sum[]` reset holds the output at zero regardless.
//
//   4/6 = 0.667, under 0.95, so the rate bar called this instrument `invalid` - a FALSE NEGATIVE
//   on a testbench that is strictly better than the independent judge. `ceil(0.95 * 6)` is 6, so
//   at this budget one genuinely equivalent mutant made `valid` unreachable no matter how good
//   the testbench was.
//
//   The gate is now ZERO COVERAGE-GAP SURVIVORS: kill every valid mutant the golden testbench
//   killed. The discriminating testbench does, so it is VALID; the smoke-run one leaves two, so
//   it is INVALID and those two are named. A genuine equivalent can never enter the requirement,
//   because the golden judge did not kill it either - which is why the honest claim and the
//   simple claim are finally the same claim.
//
// GATING
//   The real toolchain and the pinned corpus checkout are each probed, never assumed, using the
//   same seams as `./eval-instrument-control.integration.test.ts`. When either is absent the
//   suite SKIPS with a reason and fetches nothing: a test that reaches the network is not a test.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  allSurvivors,
  DEFAULT_MAX_MUTANTS_PER_PROBLEM,
  DEFAULT_MUTANT_WALL_MS,
  FileSystemCorpusCheckout,
  goldenKilled,
  goldenTimeoutCountOf,
  importRtllmCorpus,
  judgeCoverageGaps,
  killRateOf,
  MUTATION_OPERATORS,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
  RtllmInstrumentControl,
  RtllmMutationCalibrator,
  RtllmMutationNegativeControl,
  SandboxGoldenTestbenchScorer,
  type InstrumentControlResult,
  type MutationConfig,
  type MutationProbeOutcome,
} from '@app/eval';
import {
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SandboxToolRunner,
  type ResourceLimits,
} from '@app/tools';

import { CORPUS_TIMING_STAND_IN, PROBE } from './real-oracle-harness.js';

// -- The design this suite is about -----------------------------------------

/** The problem whose testbench passed a design the independent judge fails. */
const PROBLEM_ID = 'rtllm/arithmetic/multi_pipe_8bit';

/** The check name that testbench signals its whole-design verdict with. */
const CHECK_NAME = 'ac1_under_simulation_multi_pipe_8bit_produce';

/**
 * A deliberately SMALL mutant budget for the regression story below, and no HANGING operator.
 *
 * `CONDITION_NEGATED` is left out of THIS config so the six mutants it pins stay the six mutants
 * that were measured: negating `if (!rst_n)` leaves the design permanently reset, so
 * `mul_en_out` never rises and RTLLM's golden testbench spins in its own
 * `while (mul_en_out == 0)` loop until the sandbox wall clock kills it. `RESET_BRANCH_DISABLED`
 * reaches the reset-handling defect class without the hang.
 *
 * That hang is NOT swept under the rug - it is the subject of its own suite at the bottom of this
 * file, which pins that the hanging mutant is a golden KILL (it compiled and then failed to
 * terminate) and that the mutant wall cap keeps its cost bounded. It used to be discarded as
 * `non-compiling`, which took it out of the gate set entirely.
 *
 * The measurement this suite makes is qualitative - does the control catch this testbench - not
 * a rate, so a small budget is the right one.
 */
const MUTATION_CONFIG: MutationConfig = {
  maxMutantsPerProblem: 6,
  operators: [
    'ARITH_PLUS_TO_MINUS',
    'RESET_BRANCH_DISABLED',
    'CONST_ZERO_TO_ONE',
    'INDEX_OFF_BY_ONE',
  ],
};

/**
 * The wall-clock ceiling ONE MUTANT run executes under here: the shipped default.
 *
 * The default deliberately, not a test-local value, because the hang suite below measures what a
 * real campaign will pay. See `DEFAULT_MUTANT_WALL_MS` for the numbers behind it.
 */
const MUTANT_WALL_MS = DEFAULT_MUTANT_WALL_MS;

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
    `[eval-negative-control] the negative control was NOT exercised: ${SKIP_REASON}. The ` +
      'multi_pipe_8bit "testbench that passes everything" regression is therefore recorded ' +
      'rather than reproduced in this environment.',
  );
}

// -- Real-run configuration -------------------------------------------------

/**
 * Generous real-run caps: a local worker launch plus a real iverilog+vvp run per mutant.
 *
 * The SHAPE of a student session's caps with only the wall clock widened, exactly as the
 * positive-control suite does. This is the STUDENT cap and it is deliberately left at 30s: the
 * suites below assert that a MUTANT run does not inherit it, which is only a real assertion if
 * the two numbers differ.
 */
const REAL_LIMITS: ResourceLimits = {
  cpu: 1,
  memMb: 1024,
  procs: 256,
  diskMb: 256,
  wallMs: 30_000,
};

/** Timeout for a whole calibrate-plus-probe cycle over the mutant budget. */
const PROBE_TIMEOUT_MS = 900_000;

/** This suite's directory, for reading the captured fixture. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The testbench our smoke run actually produced, read verbatim from the fixture. */
function smokeRunTestbench(): Promise<string> {
  return readFile(join(HERE, 'fixtures', 'smoke-v4', 'multi-pipe-8bit-testbench.v'), 'utf8');
}

/**
 * A DISCRIMINATING testbench for the same design: it checks the product on every cycle.
 *
 * Written to the same declared interface, and structured the way the smoke-run one is not: the
 * comparison feeds an error flag, and the CHECK status reads that flag. It therefore cannot pass
 * a design whose arithmetic or reset is broken - which is exactly what the negative control is
 * asking of an instrument.
 *
 * The pipeline latency is DISCOVERED at run time rather than assumed, by waiting for the design
 * to raise `mul_en_out`, so this testbench does not smuggle in an assumption the interface does
 * not support (the mistake the `right_shifter` testbench made).
 */
const DISCRIMINATING_TESTBENCH = `\`timescale 1ns/1ns
module multi_pipe_8bit_control_tb;
  reg clk;
  reg rst_n;
  reg [7:0] mul_a;
  reg [7:0] mul_b;
  reg mul_en_in;
  wire mul_en_out;
  wire [15:0] mul_out;

  integer errors;
  integer trial;
  integer guard;
  reg [15:0] expected;

  multi_pipe_8bit dut (
    .clk(clk), .rst_n(rst_n), .mul_a(mul_a), .mul_b(mul_b),
    .mul_en_in(mul_en_in), .mul_en_out(mul_en_out), .mul_out(mul_out)
  );

  initial clk = 1'b0;
  always #10 clk = ~clk;

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, multi_pipe_8bit_control_tb);
    errors = 0;
    mul_a = 8'd0;
    mul_b = 8'd0;
    mul_en_in = 1'b0;
    rst_n = 1'b0;
    repeat (4) @(posedge clk);
    rst_n = 1'b1;
    @(posedge clk);

    // The reset state is part of the contract: after reset, the design must assert nothing.
    if (mul_en_out !== 1'b0 || mul_out !== 16'd0) begin
      errors = errors + 1;
    end

    for (trial = 0; trial < 6; trial = trial + 1) begin
      // Drain and re-reset between trials, so each product is attributable to one stimulus.
      mul_en_in = 1'b0;
      rst_n = 1'b0;
      repeat (4) @(posedge clk);
      rst_n = 1'b1;
      @(posedge clk);

      mul_a = (trial * 8'd37) + 8'd3;
      mul_b = (trial * 8'd23) + 8'd5;
      expected = mul_a * mul_b;
      mul_en_in = 1'b1;
      @(posedge clk);
      mul_en_in = 1'b0;

      // Latency is DISCOVERED, never assumed: wait for the design to say it has a result.
      guard = 0;
      while (mul_en_out !== 1'b1 && guard < 32) begin
        @(posedge clk);
        guard = guard + 1;
      end
      if (mul_en_out !== 1'b1) begin
        errors = errors + 1;
      end else if (mul_out !== expected) begin
        errors = errors + 1;
      end
    end

    // The flag is what the CHECK status reads. That is the property the smoke-run testbench
    // lacked: its monitor printed mismatches as prose and signalled PASS regardless.
    if (errors == 0)
      $display("CHECK ${CHECK_NAME} PASS");
    else
      $display("CHECK ${CHECK_NAME} FAIL: %0d mismatch(es)", errors);
    $finish;
  end
endmodule
`;

// -- The real stack ---------------------------------------------------------

/** The negative control and the positive control, both on the real toolchain. */
async function realControls(): Promise<{
  readonly instrument: RtllmInstrumentControl;
  readonly negative: RtllmMutationNegativeControl;
}> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    CORPUS_TIMING_STAND_IN,
  );
  const runtime = new LocalWorkerRuntime(PROBE.pythonBin);
  const negative = new RtllmMutationNegativeControl({
    // OUR testbench emits `CHECK` signalling and a waveform, so it runs on the oracle adapter.
    simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(runtime)),
    calibrator: new RtllmMutationCalibrator({
      // RTLLM's testbench prints VCS-style banners and writes no waveform, so it runs on the
      // golden scorer. The two grammars are read by the two readers that speak them.
      scorer: new SandboxGoldenTestbenchScorer(new SandboxToolRunner(runtime)),
      golden: corpus.golden,
      references: corpus.references,
      config: MUTATION_CONFIG,
      mutantWallMs: MUTANT_WALL_MS,
      // No cache: this suite must MEASURE the calibration, not read a previous run's answer.
      cacheKey: {
        corpusCommit: corpus.pinnedCommit,
        mutationConfigHash: 'integration-test',
        mutantWallMs: MUTANT_WALL_MS,
      },
    }),
  });
  return {
    negative,
    instrument: new RtllmInstrumentControl({
      simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(runtime)),
      references: corpus.references,
      negativeControl: negative,
    }),
  };
}

/** Probe one testbench through the negative control alone. */
async function probeMutants(testbench: string): Promise<MutationProbeOutcome> {
  const { negative } = await realControls();
  return negative.probe({
    problemId: PROBLEM_ID,
    testbench,
    limits: REAL_LIMITS,
    requiredCheckNames: [],
  });
}

/** Check one testbench through BOTH controls, as the harness does. */
async function checkInstrument(testbench: string): Promise<InstrumentControlResult> {
  const { instrument } = await realControls();
  const result = await instrument.check({
    problemId: PROBLEM_ID,
    testbench,
    limits: REAL_LIMITS,
    requiredCheckNames: [],
  });
  if (result === null) {
    throw new Error(`the control reported no reference design for ${PROBLEM_ID}`);
  }
  return result;
}

// -- Tests ------------------------------------------------------------------

describe('negative-control capability probe', () => {
  it('documents whether the negative control was exercised in this environment', () => {
    // Always runs; on skip the note above has already recorded that it did not.
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)('the denominator is every VALID mutant, on the real toolchain', () => {
  it(
    'scores our testbench over mutants the golden testbench PASSES, not only the ones it kills',
    async () => {
      const outcome = await probeMutants(DISCRIMINATING_TESTBENCH);

      expect(outcome.kind).toBe('measured');
      if (outcome.kind !== 'measured') {
        return;
      }
      const report = outcome.report;
      expect(report.generatedCount).toBe(MUTATION_CONFIG.maxMutantsPerProblem);
      // Every mutant that compiles is in the denominator, and on this problem all six do.
      expect(report.validCount + report.nonCompilingCount).toBe(report.generatedCount);
      // The measured blindness that motivated the whole change: the independent judge kills
      // only some of the valid mutants, and the ones it misses are STILL scored.
      expect(report.goldenKilledCount).toBeGreaterThan(0);
      expect(report.goldenKilledCount).toBeLessThan(report.validCount);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'every valid mutant is accounted for as a kill or as a survivor in one of the two buckets',
    async () => {
      const outcome = await probeMutants(DISCRIMINATING_TESTBENCH);

      expect(outcome.kind).toBe('measured');
      if (outcome.kind !== 'measured') {
        return;
      }
      const report = outcome.report;
      expect(report.killedCount + allSurvivors(report).length).toBe(report.validCount);
      // Nothing hides in a timeout on this fixture: the discriminating testbench bounds its own
      // wait loop, so every kill here is a reported failure.
      expect(report.noVerdictKills).toBe(0);
    },
    PROBE_TIMEOUT_MS,
  );
});

describe.skipIf(!RUNNABLE)('the multi_pipe_8bit regression, on the real toolchain', () => {
  it(
    'classifies OUR smoke-run testbench INVALID because it SURVIVES the mutants',
    async () => {
      // The whole feature in one assertion: this exact testbench judged a candidate `verified`
      // in a real sweep while the independent judge failed it 100/100, and the positive control
      // could not see it.
      const result = await checkInstrument(await smokeRunTestbench());

      expect(result.verdict).toEqual({
        validity: 'invalid',
        defect: 'TESTBENCH_SURVIVED_MUTANTS',
      });
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'names the COVERAGE GAPS, which is the actionable diagnostic',
    async () => {
      const outcome = await probeMutants(await smokeRunTestbench());

      expect(outcome.kind).toBe('measured');
      if (outcome.kind !== 'measured') {
        return;
      }
      // The coverage-gap bucket specifically: mutants the INDEPENDENT judge kills and this
      // testbench does not. That is a demonstrated gap rather than a maybe, and it is the
      // population the `MISSED BUGS` cell comes from.
      expect(outcome.report.coverageGapSurvivors.length).toBeGreaterThan(0);
      for (const survivor of allSurvivors(outcome.report)) {
        // Each survivor is one concrete injected defect, located in the reference design.
        expect(survivor.operator.length).toBeGreaterThan(0);
        expect(survivor.site.line).toBeGreaterThan(0);
        expect(survivor.site.before.length).toBeGreaterThan(0);
      }
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'still PASSES the reference design, which is why the positive control missed it',
    async () => {
      // Stated explicitly, because it is the reason the negative control had to exist: the
      // failure is not over-strictness, it is under-powered checking.
      const { instrument } = await realControls();
      const positiveOnly = await new RtllmInstrumentControl({
        simulator: new IcarusSimulatorAdapter(
          new SandboxToolRunner(new LocalWorkerRuntime(PROBE.pythonBin)),
        ),
        references: (
          await importRtllmCorpus(
            new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
            CORPUS_TIMING_STAND_IN,
          )
        ).references,
      }).check({
        problemId: PROBLEM_ID,
        testbench: await smokeRunTestbench(),
        limits: REAL_LIMITS,
        requiredCheckNames: [],
      });

      expect(instrument).toBeDefined();
      expect(positiveOnly?.verdict).toEqual({ validity: 'valid' });
    },
    PROBE_TIMEOUT_MS,
  );
});

describe.skipIf(!RUNNABLE)('the negative control is non-vacuous', () => {
  it(
    'reports a DISCRIMINATING testbench for the same design VALID',
    async () => {
      // Same design, same mutants, same calibration, same toolchain: only the instrument's
      // rigour changed. Without this, an always-invalid control would pass the suite above.
      //
      // This is the claim the RETIRED kill-rate bar could not make. At 4/6 = 0.667 it called
      // this testbench `invalid`, even though the testbench kills strictly more than the
      // independent judge does. Under the coverage-gap gate it is valid, and its two survivors
      // are still reported - as candidate-equivalent review items, not as gate failures.
      const result = await checkInstrument(DISCRIMINATING_TESTBENCH);

      expect(result.verdict).toEqual({ validity: 'valid' });
      expect(result.mutation).not.toBeNull();
      expect(result.mutation?.coverageGapSurvivors).toEqual([]);
      // The kill rate is BELOW the retired 0.95 bar and the sample is valid anyway. That is the
      // whole change, pinned on real measured numbers.
      const killRate = result.mutation === null ? null : killRateOf(result.mutation);
      expect(killRate).not.toBeNull();
      expect(killRate ?? 1).toBeLessThan(0.95);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'splits the two testbenches on the GATE: valid with zero gaps, invalid with two',
    async () => {
      const strong = await probeMutants(DISCRIMINATING_TESTBENCH);
      const weak = await probeMutants(await smokeRunTestbench());

      expect(strong.kind).toBe('measured');
      expect(weak.kind).toBe('measured');
      if (strong.kind !== 'measured' || weak.kind !== 'measured') {
        return;
      }
      // Both were asked the same question over the same valid set, so this is a direct
      // comparison of coverage rather than of luck.
      expect(strong.report.validCount).toBe(weak.report.validCount);
      expect(strong.report.killedCount).toBeGreaterThan(weak.report.killedCount);
      // The gate reads exactly the coverage-gap bucket, and the fixture data separates the two
      // instruments there: the golden judge kills the two `temp[] + temp[]` sign flips, the good
      // testbench kills both, the smoke-run one kills neither.
      expect(strong.report.coverageGapSurvivors).toEqual([]);
      expect(judgeCoverageGaps(strong.report)).toBe('closed');
      expect(weak.report.coverageGapSurvivors).toHaveLength(weak.report.goldenKilledCount);
      expect(judgeCoverageGaps(weak.report)).toBe('open');
      // NAMED, because a count alone is not a diagnostic and the gate's whole value is that each
      // entry points at one defect class a third party proved catchable.
      for (const survivor of weak.report.coverageGapSurvivors) {
        expect(survivor.operator).toBe('ARITH_PLUS_TO_MINUS');
        expect(survivor.site.line).toBeGreaterThan(0);
      }
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'kills mutants the INDEPENDENT judge is blind to, which the old rule excused',
    async () => {
      // The direct falsification of the previous denominator. Under the old rule these mutants
      // were excluded, so a testbench could not be given credit for killing them - and, worse,
      // could not be held responsible for missing them. This testbench kills strictly more than
      // the judge does, which is only expressible over the valid set.
      const outcome = await probeMutants(DISCRIMINATING_TESTBENCH);

      expect(outcome.kind).toBe('measured');
      if (outcome.kind !== 'measured') {
        return;
      }
      expect(outcome.report.killedCount).toBeGreaterThan(outcome.report.goldenKilledCount);
    },
    PROBE_TIMEOUT_MS,
  );
});

// -- The HANGING mutant, on the real toolchain -------------------------------
//
// The second half of this file's subject, and the one the small mutant cap exists for.
//
// `CONDITION_NEGATED@26:10` negates `if (!rst_n)`, which leaves `multi_pipe_8bit` permanently
// reset. `mul_en_out` never rises, RTLLM's golden testbench spins in its own
// `while (mul_en_out == 0)` loop, and the run never reaches `$finish`. That mutant used to
// classify `non-compiling`, which was wrong three times over: it COMPILED, it left the kill-rate
// denominator, and it left the GATE set - so our testbench was never required to catch a defect
// that demonstrably changes observable behaviour.
//
// It is now a golden KILL. And because a hang costs the whole wall cap, the cap it costs is the
// small MUTANT cap rather than the student session's - measured below rather than asserted.

/** The full 24-mutant default budget: the shape a real campaign runs. */
const FULL_MUTATION_CONFIG: MutationConfig = {
  maxMutantsPerProblem: DEFAULT_MAX_MUTANTS_PER_PROBLEM,
  operators: MUTATION_OPERATORS,
};

/** The hanging mutant this suite is about, by its stable id. */
const HANGING_MUTANT_ID = 'CONDITION_NEGATED@26:10';

/** A calibrator over the real toolchain at the full budget, with NO cache. */
async function realCalibrator(): Promise<RtllmMutationCalibrator> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    CORPUS_TIMING_STAND_IN,
  );
  return new RtllmMutationCalibrator({
    scorer: new SandboxGoldenTestbenchScorer(
      new SandboxToolRunner(new LocalWorkerRuntime(PROBE.pythonBin)),
    ),
    golden: corpus.golden,
    references: corpus.references,
    config: FULL_MUTATION_CONFIG,
    mutantWallMs: MUTANT_WALL_MS,
    // No cache: this suite must MEASURE the calibration, not read a previous run's answer.
    cacheKey: {
      corpusCommit: corpus.pinnedCommit,
      mutationConfigHash: 'integration-test-full',
      mutantWallMs: MUTANT_WALL_MS,
    },
  });
}

describe.skipIf(!RUNNABLE)('a golden TIMEOUT is a KILL, on the real toolchain', () => {
  it(
    'given the hanging mutant, when calibrated, then it is golden-killed and STAYS in the valid set',
    async () => {
      // GIVEN the real reference, the real unmodified golden testbench, and the real Icarus
      // toolchain, at the full 24-mutant budget a campaign uses.
      const calibrator = await realCalibrator();

      // WHEN calibration runs under the small mutant wall cap.
      const calibrated = await calibrator.calibrate(PROBLEM_ID, REAL_LIMITS);

      // THEN the hanging mutant is VALID, and its verdict names the hang rather than claiming a
      // build failure that never happened.
      expect(calibrated).not.toBeNull();
      const hanging = calibrated?.valid.find(
        (entry) => entry.mutant.mutantId === HANGING_MUTANT_ID,
      );
      expect(hanging).toBeDefined();
      expect(hanging?.calibration).toBe('golden-timeout');
      // And that makes it a golden KILL, so it is in the set our testbench must close.
      expect(hanging === undefined ? false : goldenKilled(hanging)).toBe(true);
      expect(goldenTimeoutCountOf(calibrated!)).toBeGreaterThan(0);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'given the small mutant cap, when calibration runs, then it costs FAR less than 24 x 30s',
    async () => {
      // The wall-clock half of the fix, measured rather than reasoned about. Under the student
      // session's 30s cap a hanging mutant costs 30005ms and calibration is 24 mutants long, so
      // the worst case was ~720s. The mutant cap bounds each hang at 5s instead.
      const calibrated = await (await realCalibrator()).calibrate(PROBLEM_ID, REAL_LIMITS);

      expect(calibrated).not.toBeNull();
      expect(calibrated?.generatedCount).toBe(DEFAULT_MAX_MUTANTS_PER_PROBLEM);
      expect(calibrated?.fromCache).toBe(false);
      // A generous ceiling on purpose: the claim is an ORDER of magnitude, not a stopwatch, so a
      // loaded CI host cannot make it flaky while a regression to the 30s cap still fails it.
      const underStudentCap = DEFAULT_MAX_MUTANTS_PER_PROBLEM * REAL_LIMITS.wallMs;
      expect(calibrated?.elapsedMs ?? underStudentCap).toBeLessThan(underStudentCap / 4);
      // No mutant run can have exceeded the mutant cap by more than launch overhead, which is
      // what "the loop's cap was not inherited" means in measurable terms.
      expect(REAL_LIMITS.wallMs).toBeGreaterThan(MUTANT_WALL_MS);
    },
    PROBE_TIMEOUT_MS,
  );
});
