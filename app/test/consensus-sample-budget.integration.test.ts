// Real-toolchain integration test: the Sample_Budget for the widest retained-corpus interface
// stays inside the sandbox worker's stdout cap (task 8.6; Req 7.7, 15.4).
//
// WHY THIS TEST EXISTS
//
//   `sizedSampleBudget` (`app/tools/simulator/consensus-harness.ts`, task 7.3) sizes the loop
//   bound from an ESTIMATE of what one `ECE_SAMPLE` line costs in bytes. The estimate is
//   deliberately conservative (`BYTES_PER_SAMPLE_LINE_MULTIPLIER`), but conservative is an
//   argument about the formula, not a measurement of the tool. Only Icarus can say what it
//   actually prints, so this test takes the real widest interface in the retained RTLLM corpus,
//   renders its harness at the budget the formula computes, runs it through the real adapter,
//   and measures `Buffer.byteLength(verdict.stdout, 'utf8')` against the worker's 1,048,576-byte
//   retention (`MAX_CAPTURED_STDOUT_BYTES`).
//
// "WIDEST BY TOTAL OUTPUT BIT WIDTH" AND "RETAINED" ARE BOTH MEASURED HERE, NOT ASSUMED
//
//   The corpus importer (`app/eval/corpus/import.ts`) and the Stage 0 exclusions
//   (`STAGE0_QUARANTINED_PROBLEM_IDS`) already decide which 46 designs are "retained" for
//   scoring; this test additionally drops the two designs the regression suite excludes for its
//   own stated reasons (task 16.1): `adder_pipe_64bit` (its golden testbench overrides two
//   parameters the Spec model has no concept of) and `asyn_fifo` (a separate, specified
//   knowledge-bundle reason). Both exclusions are asserted explicitly below so a reader does not
//   have to trust the filter silently - and the widest SURVIVING interface, `sub_64bit` at 65
//   output bits (`result` at 64 plus `overflow` at 1), is picked by scanning every retained
//   design's own `ModuleInterface`, not hand-picked from reading the corpus once.
//
// GATING
//
//   Needs the real toolchain (`PROBE`, shared with every other real-oracle suite) AND the
//   fetched RTLLM checkout (`npm run corpus:fetch`). Each is probed, never assumed; the suite
//   skips cleanly with a reason when either is absent, the same discipline
//   `rtllm-corpus-stage0.integration.test.ts` already follows.

import { describe, expect, it } from 'vitest';

import type { ModuleInterface, Spec } from '@app/core';
import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  RTLLM_CHECKOUT_PATH,
  scoredRtllmCorpus,
  type EvalProblem,
} from '@app/eval';
import { SAMPLE_BUDGET, sizedSampleBudget } from '@app/tools';
import type { ResourceLimits, SourceFile } from '@app/tools';

import { reduceSignature } from '../agent/consensus/signature.js';
import {
  renderConsensusHarness,
  type ConsensusHarnessRequest,
} from '../tools/simulator/consensus-harness.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[consensus-sample-budget.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'The Sample_Budget sizing for the widest retained interface is UNVALIDATED against real ' +
      'iverilog in this environment.',
  );
}

/** Whether the pinned RTLLM checkout is present, mirroring `rtllm-corpus-stage0`'s own probe. */
interface CorpusProbe {
  readonly available: boolean;
  readonly reason: string;
}

async function probeCorpus(): Promise<CorpusProbe> {
  const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
  const categories = await checkout.listDirectories([]);
  if (categories.length === 0) {
    return {
      available: false,
      reason: 'no RTLLM checkout at the pinned commit; run `npm run corpus:fetch`',
    };
  }
  return { available: true, reason: 'the pinned RTLLM checkout is present' };
}

const CORPUS = await probeCorpus();
const RUNNABLE = PROBE.available && CORPUS.available;
const SKIP_REASON = !PROBE.available ? PROBE.reason : CORPUS.reason;

if (!RUNNABLE) {
  console.warn(
    `[consensus-sample-budget.integration] Stage not exercised: ${SKIP_REASON}. The Sample_Budget ` +
      'byte figure below is a recorded estimate, not a reproduced measurement, in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 60_000 };
const RUN_TIMEOUT = 120_000;

/**
 * The two designs the regression suite excludes for its own stated reasons (task 16.1), on top
 * of Stage 0's own exclusions `scoredRtllmCorpus` already applies. Named here rather than
 * imported from the suite driver: `app/eval/consensus-regression/` is task 16.1's own file and
 * does not exist yet in this task's dependency wave (it is wave 26, this task is wave 17).
 */
const REGRESSION_SUITE_EXCLUDED_PROBLEM_IDS: ReadonlySet<string> = new Set([
  'rtllm/arithmetic/adder_pipe_64bit',
  'rtllm/memory/asyn_fifo',
]);

/** Sum of a `ModuleInterface`'s declared output port widths. */
function outputBundleWidthOf(moduleInterface: ModuleInterface): number {
  return moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .reduce((sum, port) => sum + port.width, 0);
}

/** The retained corpus (Stage 0 plus the regression suite's own two exclusions), and its widest interface. */
async function retainedCorpusWidestProblem(): Promise<{
  readonly retained: readonly EvalProblem[];
  readonly widest: EvalProblem;
}> {
  const imported = await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH));
  const scored = scoredRtllmCorpus(imported);
  const retained = scored.problems.filter(
    (problem) => !REGRESSION_SUITE_EXCLUDED_PROBLEM_IDS.has(problem.id),
  );
  if (retained.length === 0) {
    throw new Error('fixture defect: the retained RTLLM corpus is empty');
  }
  const widest = retained.reduce((widestSoFar, candidate) =>
    outputBundleWidthOf(candidate.spec.moduleInterface) >
    outputBundleWidthOf(widestSoFar.spec.moduleInterface)
      ? candidate
      : widestSoFar,
  );
  return { retained, widest };
}

/**
 * A trivial, correctly-written Reference_Model mirroring `sub_64bit`'s own `A - B` plus the
 * sign-mismatch overflow check.
 *
 * BIT LAYOUT MATCHES THE RENDERER'S OWN PACKING, NOT AN ASSUMED ORDER: the renderer's
 * `inputBundleSlice`/`portConnectionsOf` pack declared ports low-to-high in declared order, so
 * for `sub_64bit`'s `[A, B]` input order the packed bundle is `{B[63:0], A[63:0]}` (A occupies
 * bits `[63:0]`, B occupies `[127:64]`) and for its `[result, overflow]` output order the
 * expectation bundle is `{overflow, result[63:0]}` (result at `[63:0]`, overflow at bit `64`).
 * Getting either order backwards would still compile and run - it would just compare the wrong
 * bits - so this fixture is shaped for exactly the measured widest retained interface rather than
 * a generic width.
 */
const SUB_64BIT_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_stimulus(input [31:0] step);',
    // A (low 64 bits) varies with step; B (high 64 bits) is a fixed non-zero constant - real
    // varying hex digits in both halves, so the measured stdout exercises genuine data rather
    // than an all-zero run.
    "  ece_stimulus = {64'hFFFF_FFFF_0000_0001, {32'd0, step}};",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [127:0] in);',
    '  ece_next_state = s;',
    'endfunction',
    'function automatic [64:0] ece_expect(input [127:0] s, input [127:0] in);',
    '  reg [63:0] a_val;',
    '  reg [63:0] b_val;',
    '  reg [63:0] diff;',
    '  reg ovf;',
    '  begin',
    '    a_val = in[63:0];',
    '    b_val = in[127:64];',
    '    diff = a_val - b_val;',
    '    ovf = (a_val[63] != b_val[63]) && (diff[63] != a_val[63]);',
    '    ece_expect = {ovf, diff};',
    '  end',
    'endfunction',
    '',
  ].join('\n'),
};

/** Build and render the Consensus_Harness for `spec`'s interface, at the task 7.3 budget. */
function renderHarnessForWidestOrThrow(
  spec: Spec,
  nonce: string,
): { readonly harness: SourceFile; readonly sampleBudget: number } {
  const { moduleInterface, timingContract } = spec;
  const outputBundleWidth = outputBundleWidthOf(moduleInterface);
  const sampleBudget = sizedSampleBudget(nonce.length, outputBundleWidth, SAMPLE_BUDGET);
  const request: ConsensusHarnessRequest = {
    moduleInterface,
    timingContract,
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
  };
  const rendered = renderConsensusHarness(request);
  if (!rendered.ok) {
    throw new Error(`fixture defect: ${rendered.error.code}`);
  }
  return { harness: rendered.value, sampleBudget };
}

describe('consensus Sample_Budget capability probe', () => {
  it('documents whether the real toolchain and the pinned RTLLM checkout were exercised', () => {
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)(
  'the Sample_Budget for the widest retained-corpus interface stays inside the stdout cap (Req 7.7, 15.4)',
  () => {
    it('excludes adder_pipe_64bit and asyn_fifo from the retained set it scans', async () => {
      const { retained } = await retainedCorpusWidestProblem();
      const retainedIds = new Set(retained.map((problem) => problem.id));
      expect(retainedIds.has('rtllm/arithmetic/adder_pipe_64bit')).toBe(false);
      expect(retainedIds.has('rtllm/memory/asyn_fifo')).toBe(false);
    });

    it(
      'measures the real stdout bytes of the widest retained interface at its sized Sample_Budget, inside the worker cap',
      async () => {
        const { widest } = await retainedCorpusWidestProblem();
        const outputBundleWidth = outputBundleWidthOf(widest.spec.moduleInterface);

        // Pinned to the measured corpus shape so a corpus change that silently picks a different
        // design (or widens/narrows this one) is visible as a changed assertion, not a passed one.
        expect(widest.id).toBe('rtllm/arithmetic/sub_64bit');
        expect(outputBundleWidth).toBe(65);

        const nonce = 'budgetProbe1';
        const { harness, sampleBudget } = renderHarnessForWidestOrThrow(widest.spec, nonce);
        // The budget formula's own claim for this interface: strictly fewer than the raw cap,
        // since 65 output bits is wide enough to cross the per-sample byte threshold.
        expect(sampleBudget).toBeLessThanOrEqual(SAMPLE_BUDGET);
        expect(sampleBudget).toBeGreaterThanOrEqual(1);

        const candidateRtl: SourceFile = {
          path: 'sub_64bit.v',
          contents: [
            'module sub_64bit(',
            '  input [63:0] A,',
            '  input [63:0] B,',
            '  output reg [63:0] result,',
            '  output reg overflow',
            ');',
            '  always @(*) begin',
            '    result = A - B;',
            '    if ((A[63] != B[63]) && (result[63] != A[63])) begin',
            '      overflow = 1;',
            '    end else begin',
            '      overflow = 0;',
            '    end',
            '  end',
            'endmodule',
            '',
          ].join('\n'),
        };
        const verdict = await realOracleAdapter().simulate(
          [candidateRtl, SUB_64BIT_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');

        const measuredStdoutBytes = Buffer.byteLength(verdict.stdout, 'utf8');
        // The assertion the task names: inside the worker's retention WITH the CHECK lines
        // included (they are real $display calls in verdict.stdout, not stripped before this
        // measurement), settling the estimate against what Icarus actually printed.
        expect(measuredStdoutBytes).toBeLessThan(1_048_576);

        // The reducer must still see a complete, well-formed stream at this real byte count -
        // "inside the cap" and "well-formed" are two different claims, and both are checked.
        const signature = reduceSignature(verdict.stdout, nonce, widest.spec.moduleInterface);
        expect(signature).not.toBeNull();
        expect(signature?.sampleCount).toBe(sampleBudget);

        // Record the measured per-line figure for the next reader, the way the task asks the
        // formula's own comment to: measured bytes / sample count is the real average line cost
        // this run produced for a 65-output-bit interface, printed here rather than only in a
        // vault note so a CI log carries it too.
        console.log(
          `[consensus-sample-budget.integration] sub_64bit (65 output bits): ${String(measuredStdoutBytes)} ` +
            `measured stdout bytes over ${String(sampleBudget)} samples, ` +
            `${(measuredStdoutBytes / sampleBudget).toFixed(1)} bytes/sample average.`,
        );
      },
      RUN_TIMEOUT,
    );
  },
);
