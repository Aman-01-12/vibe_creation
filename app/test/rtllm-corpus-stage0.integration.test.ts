// Stage 0: validating the RTLLM golden testbenches as measuring sticks, against the
// REAL Icarus toolchain.
//
// WHAT THIS SUITE ESTABLISHES
//   For EVERY imported design, RTLLM's own reference RTL - the human design upstream
//   says passes - is compiled together with that design's UNMODIFIED golden testbench
//   and simulated through real `iverilog` + `vvp`, and the golden testbench is required
//   to print its pass banner.
//
//   That is the only honest way to earn the right to score candidates. If a reference
//   fails its own testbench, then a candidate failing that design tells us nothing: we
//   could not distinguish "the candidate is wrong" from "the judge is broken". Such a
//   design is QUARANTINED with its reason recorded and excluded from the scored corpus.
//   It is never silently dropped, and the assertion is never weakened to make it pass -
//   weakening it would leave a broken judge inside the scored set, which is strictly
//   worse than a smaller honest corpus.
//
// THE ASSERTION IS A RATCHET, IN BOTH DIRECTIONS
//   The reviewed exclusions live in `STAGE0_QUARANTINE`, and this suite asserts that a
//   real run reproduces that list EXACTLY. A design that starts failing fails the
//   suite. A quarantined design that starts passing ALSO fails it, so the exclusion
//   list can only change through a deliberate, reviewed edit - the same discipline the
//   eval pass@k gate applies to its baseline.
//
// GATING
//   Two capabilities are needed and each is probed, never assumed:
//     - the real toolchain, via the shared `PROBE` used by every other real-oracle
//       suite (`iverilog` + `vvp` + a worker-capable Python);
//     - the pinned corpus checkout, which is fetched (not vendored) and is therefore
//       absent on a fresh clone. `npm run corpus:fetch` materializes it.
//   When either is missing the suite SKIPS with a reason. It does not fetch anything
//   itself: a test that reaches the network is not a test.

import { describe, expect, it } from 'vitest';

import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  RTLLM_CHECKOUT_PATH,
  RTLLM_EXPECTED_DESIGN_COUNT,
  RTLLM_PINNED_COMMIT,
  RTLLM_SCORED_DESIGN_COUNT,
  SandboxGoldenTestbenchScorer,
  scoredRtllmCorpus,
  STAGE0_QUARANTINE,
  STAGE0_QUARANTINED_PROBLEM_IDS,
  validateReferenceDesigns,
  type RtllmCorpus,
  type Stage0Report,
} from '@app/eval';
import { SandboxToolRunner, type ResourceLimits } from '@app/tools';
import { LocalWorkerRuntime } from '@app/tools';

import { CORPUS_TIMING_STAND_IN, PROBE } from './real-oracle-harness.js';

// -- Corpus availability probe ----------------------------------------------

/** Whether the pinned checkout is present, and why not when it is absent. */
interface CorpusProbe {
  readonly available: boolean;
  readonly reason: string;
}

/**
 * Probe for the fetched checkout by reading one file every design folder must have.
 *
 * Uses the same read-only port the importer uses, so nothing here knows about paths
 * or `node:fs`. A missing checkout is the normal state of a fresh clone, not a
 * failure.
 */
async function probeCorpus(): Promise<CorpusProbe> {
  const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
  const categories = await checkout.listDirectories([]);
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
  // A single, explicit note that the instrument was NOT validated here, so the corpus
  // size reported elsewhere is a recorded claim rather than a reproduced measurement.
  console.warn(
    `[rtllm-corpus-stage0] Stage 0 NOT exercised: ${SKIP_REASON}. The golden testbenches ` +
      'were not validated against real iverilog in this environment, so the scored corpus ' +
      'size is taken from the reviewed STAGE0_QUARANTINE list rather than re-measured.',
  );
}

// -- Real-run configuration -------------------------------------------------

/**
 * Generous real-run caps: a local worker launch plus a real iverilog+vvp run.
 *
 * Deliberately the same SHAPE of caps a student session gets; only the wall clock is
 * widened, because several golden testbenches simulate thousands of cycles and a
 * couple never call `$finish`, relying on the event queue draining.
 */
const REAL_LIMITS: ResourceLimits = {
  cpu: 1,
  memMb: 1024,
  procs: 256,
  diskMb: 256,
  wallMs: 60_000,
};

/** Timeout for the whole Stage 0 sweep (50 real compile-and-simulate runs). */
const SWEEP_TIMEOUT_MS = 600_000;

/** Import the pinned checkout once, then validate every reference through the real toolchain. */
async function runStage0(): Promise<{
  readonly corpus: RtllmCorpus;
  readonly report: Stage0Report;
}> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    CORPUS_TIMING_STAND_IN,
  );
  const scorer = new SandboxGoldenTestbenchScorer(
    new SandboxToolRunner(new LocalWorkerRuntime(PROBE.pythonBin)),
  );
  return { corpus, report: await validateReferenceDesigns(corpus, scorer, REAL_LIMITS) };
}

/** Sorted problem ids, so list comparisons do not depend on traversal order. */
function sorted(ids: readonly string[]): readonly string[] {
  return [...ids].sort();
}

// -- Tests ------------------------------------------------------------------

describe('RTLLM corpus Stage 0 capability probe', () => {
  it('documents whether the golden testbenches were validated in this environment', () => {
    // Always runs; on skip the note above has already recorded that Stage 0 did not run.
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)('RTLLM import against the pinned checkout', () => {
  it(
    'imports every design upstream ships at the pinned commit',
    async () => {
      const corpus = await importRtllmCorpus(
        new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
        CORPUS_TIMING_STAND_IN,
      );

      expect(corpus.pinnedCommit).toBe(RTLLM_PINNED_COMMIT);
      expect(corpus.designsSeen).toBe(RTLLM_EXPECTED_DESIGN_COUNT);
      // Every design converts: no interface we could not parse, no description we
      // could not read. A regression here would show up as an import quarantine.
      expect(corpus.quarantined).toEqual([]);
      expect(corpus.problems).toHaveLength(RTLLM_EXPECTED_DESIGN_COUNT);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'gives every problem a golden testbench and a reference, and never leaks them into the Spec',
    async () => {
      const corpus = await importRtllmCorpus(
        new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
        CORPUS_TIMING_STAND_IN,
      );

      for (const problem of corpus.problems) {
        expect(corpus.golden.has(problem.id)).toBe(true);
        expect(corpus.references.has(problem.id)).toBe(true);
        // Exactly one whole-design, simulation-verifiable criterion: RTLLM ships one
        // whole-design golden testbench, so one criterion is the only honest claim.
        expect(problem.spec.acceptanceCriteria).toHaveLength(1);
        expect(problem.spec.acceptanceCriteria[0]?.measurable).toBe(true);
        expect(problem.spec.acceptanceCriteria[0]?.method).toBe('simulation');
        expect(problem.spec.approved).toBe(true);
      }
      // The judge material must not be reachable from what the loop-runner receives.
      const serializedProblems = JSON.stringify(corpus.problems);
      expect(serializedProblems).not.toContain('Your Design Passed');
      expect(serializedProblems).not.toContain('endmodule');
    },
    SWEEP_TIMEOUT_MS,
  );
});

describe.skipIf(!RUNNABLE)(
  'Stage 0: every reference against its own golden testbench under real iverilog',
  () => {
    it(
      'reproduces the reviewed quarantine list exactly, in both directions',
      async () => {
        const { report } = await runStage0();

        // Not a subset check: a design that starts failing AND a quarantined design
        // that starts passing both fail here, so the list can only change by review.
        expect(sorted(report.quarantined.map((record) => record.problemId))).toEqual(
          sorted(STAGE0_QUARANTINED_PROBLEM_IDS),
        );
        for (const record of report.quarantined) {
          const reviewed = STAGE0_QUARANTINE.find((entry) => entry.problemId === record.problemId);
          expect(reviewed?.code).toBe(record.code);
        }
      },
      SWEEP_TIMEOUT_MS,
    );

    it(
      'requires a pass from every reference that is not quarantined',
      async () => {
        const { report } = await runStage0();
        const excluded = new Set(STAGE0_QUARANTINED_PROBLEM_IDS);

        for (const outcome of report.outcomes) {
          if (excluded.has(outcome.problemId)) {
            continue;
          }
          // The unweakened assertion: the reference must drive the golden testbench to
          // print its pass banner, with zero reported failures.
          expect(outcome.score.verdict.kind).toBe('passed');
          expect(outcome.score.verdict.failureCount).toBe(0);
        }
      },
      SWEEP_TIMEOUT_MS,
    );

    it(
      'measures the usable corpus size that pass@k must be reported against',
      async () => {
        const { report } = await runStage0();

        expect(report.outcomes).toHaveLength(RTLLM_EXPECTED_DESIGN_COUNT);
        expect(report.usableProblemIds).toHaveLength(RTLLM_SCORED_DESIGN_COUNT);
        // Compiled-and-ran (i.e. produced a banner) is a strictly larger set than
        // passed: two designs build and run but do not pass their own testbench.
        expect(report.compiledCount).toBe(
          RTLLM_SCORED_DESIGN_COUNT +
            STAGE0_QUARANTINE.filter((entry) => entry.code === 'REFERENCE_FAILED_GOLDEN').length,
        );
      },
      SWEEP_TIMEOUT_MS,
    );

    it(
      'agrees with the toolchain-free scored corpus, so no oracle is needed to know it',
      async () => {
        const { corpus, report } = await runStage0();
        const scored = scoredRtllmCorpus(corpus);

        expect(sorted(scored.problems.map((problem) => problem.id))).toEqual(
          sorted(report.usableProblemIds),
        );
      },
      SWEEP_TIMEOUT_MS,
    );
  },
);
