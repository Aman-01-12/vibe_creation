// Calibration: the real Structural_Gate against the full retained RTLLM corpus (C10).
//
// WHAT THIS SUITE ESTABLISHES
//   `STRUCTURAL_GATE_EXCLUSIONS` (task 7.1) is a committed claim about what the real
//   toolchain does to the RTLLM references. This suite is the one place that claim is
//   checked against a real run, in BOTH directions: a design that starts failing is an
//   unlisted refusal, and a listed design that starts passing is a stale exclusion. Either
//   one fails here rather than silently drifting, the same ratchet discipline
//   `rtllm-corpus-stage0.integration.test.ts` applies to `STAGE0_QUARANTINE`.
//
//   The Retained_Reference_Set is `scoredRtllmCorpus(corpus)` (Stage 0's own usable set)
//   less `CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS` - the two designs the consensus
//   regression suite already drops for reasons unrelated to the Structural_Gate
//   (`adder_pipe_64bit`, `asyn_fifo`). Every reference in that set is run through the real
//   `ToolchainStructuralGate` against its own Spec, and the gate's verdict is compared
//   against `STRUCTURAL_GATE_EXCLUSIONS` rather than re-deriving a new baseline.
//
// GATING
//   Two capabilities are needed and each is probed, never assumed: the real Structural_Gate
//   toolchain (`STRUCTURAL_PROBE`: yosys + iverilog + vvp + worker Python) and the pinned
//   RTLLM checkout (fetched, not vendored, so it is absent on a fresh clone). When either is
//   missing the suite SKIPS with a reason - it never fetches or installs anything itself.

import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import type { StructuralGateCheckName } from '@app/agent';
import {
  CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS,
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
  scoredRtllmCorpus,
  STRUCTURAL_GATE_EXCLUSION_IDS,
  STRUCTURAL_GATE_EXCLUSIONS,
  type StructuralGateExclusion,
} from '@app/eval';
import type { ResourceLimits } from '@app/tools';

import {
  CORPUS_TIMING_STAND_IN,
  realStructuralGate,
  STRUCTURAL_PROBE,
} from './real-oracle-harness.js';

// -- Corpus availability probe (mirrors rtllm-corpus-stage0.integration.test.ts) --------

/** Whether the pinned checkout is present, and why not when it is absent. */
interface CorpusProbe {
  readonly available: boolean;
  readonly reason: string;
}

/**
 * Probe for the fetched checkout by reading one file every design folder must have.
 *
 * Duplicated from `rtllm-corpus-stage0.integration.test.ts` rather than imported: that
 * module exports no probe, and the check itself is three lines over the same read-only
 * port the importer uses, so a shared helper would cost more than it saves.
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

const SKIP_REASON = !STRUCTURAL_PROBE.available ? STRUCTURAL_PROBE.reason : CORPUS.reason;
const RUNNABLE = STRUCTURAL_PROBE.available && CORPUS.available;

if (!RUNNABLE) {
  // A single, explicit note that the calibration was NOT exercised here, so
  // `STRUCTURAL_GATE_EXCLUSIONS` is a recorded claim in this run rather than a reproduced
  // measurement.
  console.warn(
    `[structural-gate-calibration] Calibration NOT exercised: ${SKIP_REASON}. The real ` +
      'Structural_Gate was not run against the RTLLM corpus in this environment, so ' +
      'STRUCTURAL_GATE_EXCLUSIONS is taken on trust rather than re-measured.',
  );
}

// -- Real-run configuration ---------------------------------------------------------

/**
 * Generous real-run caps for the Structural_Gate's four checks over one reference.
 *
 * Same shape as `REAL_LIMITS` in `rtllm-corpus-stage0.integration.test.ts`; `wallMs` is
 * wider because synthesis and lint each spawn their own Yosys invocation on top of the
 * compile step that suite times, so one design's gate call is up to three tool spawns.
 */
const REAL_LIMITS: ResourceLimits = {
  cpu: 1,
  memMb: 1024,
  procs: 256,
  diskMb: 256,
  wallMs: 60_000,
};

/** Timeout for the whole sweep: up to ~44 real designs, each up to three tool spawns. */
const SWEEP_TIMEOUT_MS = 900_000;

/** Sorted problem ids, so list comparisons do not depend on traversal order. */
function sorted(ids: readonly string[]): readonly string[] {
  return [...ids].sort();
}

/** The checks a `StructuralGateResult` did not pass, in `STRUCTURAL_GATE_CHECK_ORDER`. */
function notPassedChecks(
  checks: readonly { readonly name: string; readonly passed: boolean }[],
): readonly StructuralGateCheckName[] {
  return checks
    .filter((check) => !check.passed)
    .map((check) => check.name as StructuralGateCheckName);
}

/** One reference run through the real gate, with the raw result retained for diagnosis. */
interface CalibrationOutcome {
  readonly problemId: string;
  readonly admitted: boolean;
  readonly notPassed: readonly StructuralGateCheckName[];
}

/**
 * Run the real `ToolchainStructuralGate` over every reference of the Retained_Reference_Set
 * (`scoredRtllmCorpus` less the consensus-regression exclusions), each against its own Spec.
 */
async function runCalibration(): Promise<readonly CalibrationOutcome[]> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    CORPUS_TIMING_STAND_IN,
  );
  const scored = scoredRtllmCorpus(corpus);
  const excluded = new Set(CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS);
  const retained = scored.problems.filter((problem) => !excluded.has(problem.id));

  const gate = realStructuralGate(STRUCTURAL_PROBE.pythonBin);
  const outcomes: CalibrationOutcome[] = [];
  for (const problem of retained) {
    const reference = corpus.references.get(problem.id);
    if (reference === undefined) {
      throw new Error(`no reference RTL for retained problem ${problem.id}`);
    }
    const result = await gate.admit(problem.spec, [reference.rtl], REAL_LIMITS);
    outcomes.push({
      problemId: problem.id,
      admitted: result.admitted,
      notPassed: notPassedChecks(result.checks),
    });
  }
  return outcomes;
}

/** Look up a reviewed exclusion entry by problem id, or null when it is not listed. */
function findExclusion(
  problemId: string,
  exclusions: readonly StructuralGateExclusion[],
): StructuralGateExclusion | null {
  return exclusions.find((entry) => entry.problemId === problemId) ?? null;
}

// -- Tests ----------------------------------------------------------------------------

describe('Structural_Gate calibration capability probe', () => {
  it('documents whether the gate was calibrated against the real toolchain in this environment', () => {
    // Always runs; on skip the note above has already recorded that calibration did not run.
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)(
  'Structural_Gate calibration: every retained reference under the real toolchain',
  () => {
    it('records the Yosys and Icarus Verilog versions this calibration ran against', () => {
      // Req 10.7: the suite records both tool versions in its own output, by spawning the
      // version probes directly - Requirement 9.2 permits this because it restricts
      // adapters, not tests.
      const yosysVersion = execSync('yosys -V', { encoding: 'utf8' }).trim();
      const iverilogVersion = execSync('iverilog -V', { encoding: 'utf8' }).trim();
      console.log(`[structural-gate-calibration] ${yosysVersion}`);
      console.log(`[structural-gate-calibration] ${iverilogVersion}`);
      expect(yosysVersion.length).toBeGreaterThan(0);
      expect(iverilogVersion.length).toBeGreaterThan(0);
    });

    it(
      'reproduces the reviewed exclusion list exactly, in both directions (Req 10.2, 12.3, 12.4)',
      async () => {
        const outcomes = await runCalibration();
        const refused = outcomes.filter((outcome) => !outcome.admitted);

        // Not a subset check: an unlisted refusal and a listed admission both fail here,
        // so the exclusion list can only change through a deliberate, reviewed edit.
        expect(
          sorted(refused.map((outcome) => outcome.problemId)),
          'the refused set must equal STRUCTURAL_GATE_EXCLUSIONS exactly',
        ).toEqual(sorted(STRUCTURAL_GATE_EXCLUSION_IDS));
      },
      SWEEP_TIMEOUT_MS,
    );

    it(
      "names each listed design's not-passed checks matching its entry's failingChecks (Req 12.5)",
      async () => {
        const outcomes = await runCalibration();

        for (const outcome of outcomes) {
          const exclusion = findExclusion(outcome.problemId, STRUCTURAL_GATE_EXCLUSIONS);
          if (exclusion === null) {
            continue;
          }
          expect(
            sorted(outcome.notPassed),
            `design ${outcome.problemId}: not-passed checks must equal its entry's failingChecks`,
          ).toEqual(sorted(exclusion.failingChecks));
        }
      },
      SWEEP_TIMEOUT_MS,
    );

    it(
      'admits every design outside the exclusion list (Req 10.1, over the Retained_Reference_Set)',
      async () => {
        const outcomes = await runCalibration();
        const excludedIds = new Set(STRUCTURAL_GATE_EXCLUSION_IDS);

        for (const outcome of outcomes) {
          if (excludedIds.has(outcome.problemId)) {
            continue;
          }
          expect(
            outcome.admitted,
            `design ${outcome.problemId}: expected admission, not-passed checks were ` +
              `[${outcome.notPassed.join(', ')}]`,
          ).toBe(true);
        }
      },
      SWEEP_TIMEOUT_MS,
    );
  },
);
