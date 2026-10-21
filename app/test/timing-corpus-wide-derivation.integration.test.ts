// The corpus-wide derivation integration test (timing-contract-inference task 12.9).
//
// WHAT THIS ESTABLISHES
//   One real import over the pinned RTLLM checkout, through the REAL `localTimingDerivation()`,
//   recording: each design's wall time against the Requirement 1.14 budget of 1.0 second, every
//   derived per-port value, every exclusion with its cause, and the six population figures (Req
//   3.6, 6.1). It then asserts `combinational` on every declared output port of the thirteen
//   designs Requirement 3.2 names by name - the claim this whole feature exists to make true,
//   because those 13 designs were unwinnable under the old all-`registered` fabrication.
//
// WHY A FRESH IMPORT RATHER THAN REUSING `deriveTimingCrossCheckMeasurement`
//   That helper (task 12.7/12.8's own device) imports the checkout with a NEVER-REFUSING stand-in
//   so every design's reference RTL is recovered regardless of its real timing outcome, then
//   derives separately. This task's own claim is about the PRODUCTION import path: `3.2` is an
//   acceptance criterion on `Corpus_Importer`, i.e. on `importRtllmCorpus` wired to the real
//   `TimingDerivationPort`, which is a second, independent exercise of the same derivation through
//   a different call path (`assembleDesign` in `import.ts`) than the cross-check script's. Per-port
//   values are then read off `spec.timingContract` the way production and the Live_Wiring do,
//   rather than off the cross-check's own flattened `DerivedPortResult` rows.
//
// WHY PER-DESIGN WALL TIME IS MEASURED HERE, NOT REUSED FROM TASK 12.7
//   `timing-cross-check-artifact.ts` never timed its own loop - it records COUNTS, not wall
//   clock. Requirement 1.14 is a budget "within 1.0 second per design", so this suite times each
//   design's own `derivation.derive()` call directly, bypassing the importer's accumulation for
//   that one measurement so a slow FILE READ or a slow Yosys IMPORT elsewhere in the loop cannot
//   be misattributed to the derivation.
//
// GATING
//   Two capabilities are needed and each is probed, never assumed, mirroring
//   `rtllm-corpus-stage0.integration.test.ts`: the real toolchain (`STRUCTURAL_PROBE`: yosys +
//   iverilog + vvp + worker Python - the derivation itself needs only yosys and the worker
//   Python, but the shared probe is reused rather than adding a fifth probe shape for one suite)
//   and the pinned RTLLM checkout (fetched, not vendored, so it is absent on a fresh clone). When
//   either is missing the suite SKIPS with a reason.

import { describe, expect, it } from 'vitest';

import type { PortTiming, Result, TimingContract } from '@app/core';
import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  localTimingDerivation,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
  summarizeTimingPopulations,
  type DesignDerivationOutcome,
  type RtllmCorpus,
  type TimingDerivationPort,
} from '@app/eval';
import type { TimingRefusal } from '@app/tools';

import { STRUCTURAL_PROBE } from './real-oracle-harness.js';

// -- Corpus availability probe (mirrors rtllm-corpus-stage0.integration.test.ts) --------

/** Whether the pinned checkout is present, and why not when it is absent. */
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
      reason: `no RTLLM checkout at the pinned commit ${RTLLM_PINNED_COMMIT}; run \`npm run corpus:fetch\``,
    };
  }
  return { available: true, reason: 'the pinned RTLLM checkout is present' };
}

const CORPUS = await probeCorpus();

const SKIP_REASON = !STRUCTURAL_PROBE.available ? STRUCTURAL_PROBE.reason : CORPUS.reason;
const RUNNABLE = STRUCTURAL_PROBE.available && CORPUS.available;

if (!RUNNABLE) {
  // A single, explicit note that the corpus-wide derivation was NOT exercised here, so the
  // claim that the 13 named designs derive `combinational` is a recorded claim rather than a
  // reproduced measurement in this environment.
  console.warn(
    `[timing-corpus-wide-derivation] NOT exercised: ${SKIP_REASON}. The Requirement 1.14 wall ` +
      'time budget and the Requirement 3.2 per-port values were not measured against the real ' +
      'toolchain in this environment.',
  );
}

/** Requirement 1.14's per-design budget, in milliseconds. */
const PER_DESIGN_BUDGET_MS = 1_000;

/** Timeout for the whole sweep: up to ~48 real designs, one pre-pass elaboration each. */
const SWEEP_TIMEOUT_MS = 600_000;

/** The thirteen designs Requirement 3.2 names, exactly as its acceptance criterion lists them. */
const REQUIREMENT_3_2_DESIGNS: readonly string[] = [
  'adder_8bit',
  'adder_16bit',
  'adder_32bit',
  'adder_bcd',
  'comparator_3bit',
  'comparator_4bit',
  'div_16bit',
  'multi_8bit',
  'fixed_point_adder',
  'fixed_point_substractor',
  'sub_64bit',
  'barrel_shifter',
  'ROM',
];

/** The `<design>` segment of a `rtllm/<category>/<design>` problem id. */
function designNameOf(problemId: string): string {
  return problemId.slice(problemId.lastIndexOf('/') + 1);
}

/** One design's measured derivation: its wall time and its outcome, for the recorded report. */
interface DesignTiming {
  readonly problemId: string;
  readonly wallMs: number;
}

/** The whole measurement this suite records: wall times, outcomes, and the imported corpus. */
interface CorpusWideDerivationMeasurement {
  readonly corpus: RtllmCorpus;
  readonly timings: readonly DesignTiming[];
  readonly populations: ReturnType<typeof summarizeTimingPopulations>;
}

/**
 * Import the pinned checkout through the REAL derivation, timing each design's own
 * `derive()` call directly rather than reading the timing off the importer's accumulation.
 *
 * The `localTimingDerivation()` instance is shared across every design, matching how
 * `importRtllmCorpus` itself is called in production: one derivation port, reused per design,
 * not re-composed each time.
 */
async function runCorpusWideDerivation(): Promise<CorpusWideDerivationMeasurement> {
  const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
  const derivation = localTimingDerivation();
  const timings: DesignTiming[] = [];
  const timedDerivation: TimingDerivationPort = {
    derive: async (request): Promise<Result<TimingContract, TimingRefusal>> => {
      const started = performance.now();
      const result = await derivation.derive(request);
      timings.push({
        problemId: request.moduleInterface.moduleName,
        wallMs: performance.now() - started,
      });
      return result;
    },
  };
  const corpus = await importRtllmCorpus(checkout, timedDerivation);
  const outcomes: DesignDerivationOutcome[] = [
    ...corpus.problems.map((problem): DesignDerivationOutcome => ({
      problemId: problem.id,
      outcome: 'derived',
    })),
    ...corpus.quarantined
      .filter((record) => record.code === 'TIMING_UNDERIVABLE')
      .map((record): DesignDerivationOutcome => ({
        problemId: record.problemId,
        outcome: 'excluded',
        cause: record.detail,
      })),
  ];
  return { corpus, timings, populations: summarizeTimingPopulations(outcomes) };
}

/** The timing values declared for one imported problem's output ports, keyed by port name. */
function portTimingsOf(corpus: RtllmCorpus, problemId: string): ReadonlyMap<string, PortTiming> {
  const problem = corpus.problems.find((candidate) => candidate.id === problemId);
  if (problem === undefined) {
    return new Map();
  }
  return new Map(
    problem.spec.timingContract.entries.map((entry) => [entry.portName, entry.timing]),
  );
}

describe('corpus-wide derivation capability probe', () => {
  it('documents whether the real derivation was run in this environment', () => {
    // Always runs; on skip the note above has already recorded why.
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)('the corpus-wide real derivation (Req 1.14, 3.2, 3.6, 6.1)', () => {
  it(
    'derives within the 1.0 second per-design budget, over every design that elaborates',
    async () => {
      const { timings } = await runCorpusWideDerivation();

      // Non-vacuous: the Derivation_Population is 48 designs, so a run that measured none
      // of them would satisfy an empty-array assertion for free.
      expect(timings.length).toBeGreaterThan(0);
      const overBudget = timings.filter((timing) => timing.wallMs > PER_DESIGN_BUDGET_MS);
      if (overBudget.length > 0) {
        throw new Error(
          `${String(overBudget.length)} design(s) exceeded the ${String(PER_DESIGN_BUDGET_MS)}ms ` +
            `budget:\n${overBudget
              .map((timing) => `  ${timing.problemId}: ${timing.wallMs.toFixed(1)}ms`)
              .join('\n')}`,
        );
      }
      expect(overBudget).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'records the six population figures alongside the per-design exclusions (Req 3.6, 6.1)',
    async () => {
      const { corpus, populations } = await runCorpusWideDerivation();

      expect(populations.sourceUniverse).toBeTypeOf('number');
      expect(populations.derivationPopulation).toBeTypeOf('number');
      expect(populations.derivedContracts).toBeTypeOf('number');
      expect(populations.scoringCohort).toBeTypeOf('number');
      expect(populations.timingAwareScoringCohort).toBeTypeOf('number');
      // Every exclusion is recorded with a cause (Req 3.5), readable without a toolchain.
      for (const exclusion of populations.derivationExclusions) {
        expect(exclusion.design.length).toBeGreaterThan(0);
        expect(exclusion.cause.length).toBeGreaterThan(0);
      }
      // The derived count plus the exclusion count never exceeds the population it is over.
      expect(populations.derivedContracts + populations.derivationExclusions.length).toBe(
        populations.derivationPopulation,
      );
      // Sanity: the import actually ran against the pinned commit this suite probed for.
      expect(corpus.pinnedCommit).toBe(RTLLM_PINNED_COMMIT);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'assigns `combinational` to every declared output port of the thirteen Requirement 3.2 designs',
    async () => {
      const { corpus } = await runCorpusWideDerivation();
      const byDesignName = new Map(
        corpus.problems.map((problem) => [designNameOf(problem.id), problem]),
      );

      const failures: string[] = [];
      for (const designName of REQUIREMENT_3_2_DESIGNS) {
        const problem = byDesignName.get(designName);
        if (problem === undefined) {
          failures.push(`${designName}: not present in the imported corpus`);
          continue;
        }
        const timings = portTimingsOf(corpus, problem.id);
        const outputPorts = problem.spec.moduleInterface.ports.filter(
          (port) => port.direction === 'output',
        );
        for (const port of outputPorts) {
          const timing = timings.get(port.name);
          if (timing !== 'combinational') {
            failures.push(
              `${designName}/${port.name}: derived ${String(timing)}, expected combinational`,
            );
          }
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `${String(failures.length)} Requirement 3.2 failure(s):\n${failures.join('\n')}`,
        );
      }
      expect(failures).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );
});
