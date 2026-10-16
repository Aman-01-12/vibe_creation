// Feature: refutation-lost-to-cover-cross-check, Property 1: Bug Condition - a failed Base_Check
// whose Counterexample was registered reports `refuted`.
//
// WHAT THIS MEASURES
//   `.eval-runs/property-only-full-population-v2` decided 92 design-model pairs. Five of them had
//   their Base_Check FAIL - the solver found a counterexample - and were still reported as
//   `could-not-verify` / `toolchain-unavailable`. That is 5 of the 11 `could-not-verify` results in
//   the run, the single largest cause, and each one reaches a Student as "we could not check" for
//   a design the gate HAD found a bug in.
//
//   The trace is not missing. Measured through the real oracle on the two pairs below: the worker
//   registers the base-case trace under `COUNTEREXAMPLE_ARTIFACT_KEY`, the artifact map carries
//   `vcd` at 2.3 KB and 9.2 KB, and the verdict is still `could-not-verify`. The refutation is lost
//   AHEAD of `refutation()`, which never runs.
//
// WHY THESE TWO PAIRS
//   `Property_Only_Measurement` records a property's id and its Proof_Conditions but not its TEXT,
//   so the five lost properties are unrecoverable without paying for the run again. What is
//   recoverable is the CLASS, and these two reproduce two of the five observation-for-observation:
//
//     recorded index 39, `rtllm/miscellaneous/RAM` under `zai.glm-5`, cover reached at step 2
//     recorded index 51, `rtllm/arithmetic/adder_pipe_64bit` under `moonshotai.kimi-k2.5`, step 6
//
//   Both reproduce `presat=satisfiable`, `base=failed`, `induction=inconclusive`, `cover=reached`
//   at the recorded step, `assertionCount=3`, and the `toolchain-unavailable` cause. Four sibling
//   properties of the same shape over the same four designs come back `refuted` and are the
//   preservation baseline, not this file's subject.
//
// SCOPED RATHER THAN GENERATED, DELIBERATELY
//   The defect is deterministic per design-property pair and every sample costs a real proof, so
//   the generator draws from the two MEASURED pairs rather than from a space of properties. The
//   proofs run once in `beforeAll` and the property then quantifies over what was observed.
//
// SKIP, AND WHY A SKIP HERE IS NOT A WEAKENING
//   Gated on `FORMAL_PROBE.available` and on the pinned checkout through the harness's single skip
//   mechanism. Where the toolchain is absent or the corpus unfetched the suite skips with its
//   reason surfaced; where they are present and the evidence is dropped it FAILS.
//
// _Requirements: 1.1, 1.2, 2.1, 2.2_
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleInterface } from '@app/core';
import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
} from '@app/eval';
import {
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  type FormalProperty,
  type ProofConditions,
  type PropertyResult,
  type SourceFile,
} from '@app/tools';

import { guardedProperty } from './formal-fixtures.js';
import { propertyParameters } from './property.js';
import { FORMAL_PROBE, realFormalAdapter } from './real-oracle-harness.js';

const PROPERTY =
  'refutation-lost-to-cover-cross-check, Property 1: Bug Condition - a failed Base_Check whose Counterexample was registered reports refuted';

/** One pair from the lost set: a property false of the design, plus what the run recorded. */
interface LostPair {
  /** The corpus problem id, spelled as `Property_Only_Measurement` recorded it. */
  readonly designId: string;
  /** The Authoring_Model whose property was lost on this design, for attribution only. */
  readonly recordedUnder: string;
  /** The cover step the lost pair reached, so this entry names the observation it stands in for. */
  readonly recordedCoverStep: number;
  /** A guarded property FALSE of the design, reproducing the lost pair's conditions. */
  readonly property: FormalProperty;
}

/**
 * The two pairs that reproduce the defect, each a guarded property FALSE of its design.
 *
 * Both consequents state an EXACT value the design does not hold at the covered step, which is
 * what makes the Base_Check fail with a counterexample rather than time out.
 */
const LOST_PAIRS: readonly LostPair[] = Object.freeze([
  // A write followed by an enabled read at the same address returns the written datum one cycle
  // later, not the datum written in the SAME cycle, so the exact-readback claim is false.
  {
    designId: 'rtllm/miscellaneous/RAM',
    recordedUnder: 'zai.glm-5',
    recordedCoverStep: 2,
    property: guardedProperty(
      'ram-read-returns-written-datum',
      'clk',
      '$past(write_en, 1) && read_en && read_addr == $past(write_addr, 1)',
      'read_data == $past(write_data, 1)',
    ),
  },
  // The pipeline's latency is four stages, not three, so the sum over `$past(.., 3)` is off by one
  // stage and refutes on the first completed operand pair.
  {
    designId: 'rtllm/arithmetic/adder_pipe_64bit',
    recordedUnder: 'moonshotai.kimi-k2.5',
    recordedCoverStep: 6,
    property: guardedProperty(
      'adder-pipe-64bit-sum-at-three-stages',
      'clk',
      'o_en',
      'result == $past(adda, 3) + $past(addb, 3)',
    ),
  },
]);

/** One decided pair: what was asked, and the whole `PropertyResult` that came back. */
interface Observation {
  readonly pair: LostPair;
  readonly result: PropertyResult;
}

/** The verdict with its cause attached, so a failed expectation names WHY it failed. */
function verdictOf(result: PropertyResult): string {
  return result.verdict === 'could-not-verify'
    ? `could-not-verify: ${result.cause}`
    : result.verdict;
}

/**
 * The Proof_Conditions a result carries, or `null` for a `proved` one.
 *
 * A proof carries `ProvedEvidence` and no conditions by construction, so there is no shape where
 * a `proved` result could report a failed Base_Check and the `null` is not a missing case.
 */
function conditionsOf(result: PropertyResult): ProofConditions | null {
  return result.verdict === 'proved' ? null : result.conditions;
}

/** Whether a result's Base_Check FAILED, which is the bug condition's antecedent. */
function baseFailed(result: PropertyResult): boolean {
  return conditionsOf(result)?.base === 'failed';
}

/** The corpus is unfetched on a fresh clone, which is a skip rather than a failure. */
async function corpusPresent(): Promise<boolean> {
  const categories = await new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH).listDirectories([]);
  return categories.length > 0;
}

const CORPUS_AVAILABLE = await corpusPresent();
const RUNNABLE = FORMAL_PROBE.available && CORPUS_AVAILABLE;
const SKIP_REASON = FORMAL_PROBE.available
  ? `no RTLLM checkout at the pinned commit ${RTLLM_PINNED_COMMIT}; run \`npm run corpus:fetch\``
  : FORMAL_PROBE.reason;

describe.skipIf(!RUNNABLE)(PROPERTY, () => {
  const observations: Observation[] = [];

  beforeAll(async () => {
    const corpus = await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH));
    const real = realFormalAdapter(FORMAL_PROBE.pythonBin);
    for (const pair of LOST_PAIRS) {
      const reference = corpus.references.get(pair.designId);
      const problem = corpus.problems.find((candidate) => candidate.id === pair.designId);
      if (reference === undefined || problem === undefined) {
        // A broken fixture, not an absent toolchain: fail the group loudly rather than skip.
        throw new Error(`the pinned corpus has no reference or problem for ${pair.designId}`);
      }
      const designSource: SourceFile = reference.rtl;
      const designInterface: ModuleInterface = problem.spec.moduleInterface;
      const result = await real.oracle.prove({
        designSource,
        designInterface,
        property: pair.property,
        budgetMs: DEFAULT_PROPERTY_TIME_BUDGET_MS,
      });
      observations.push({ pair, result });
      // vitest swallows `console.log` on a passing run, so this is read with
      // `--silent=false --reporter=verbose`. It is the counterexample this task records.
      console.log(
        `[lost-refutation] ${pair.designId} (lost under ${pair.recordedUnder}, recorded cover step ` +
          `${String(pair.recordedCoverStep)}) -> ${verdictOf(result)} ` +
          `conditions=${JSON.stringify(conditionsOf(result))} counterexampleBytes=${
            result.verdict === 'refuted' ? String(result.counterexample.sizeBytes) : 'none'
          }`,
      );
    }
  }, 900_000);

  it('reproduces a failed Base_Check on at least one pair', () => {
    // Non-vacuity. A run where no Base_Check failed asserts nothing below, and a green suite would
    // then read as "the evidence is carried" when it means "the bug condition never arose".
    const failed = observations.filter((observation) => baseFailed(observation.result));
    expect(failed.length).toBeGreaterThan(0);
  });

  it('reports refuted wherever the Base_Check failed', () => {
    fc.assert(
      fc.property(fc.constantFrom(...observations), (observation) => {
        if (!baseFailed(observation.result)) {
          return;
        }
        expect(verdictOf(observation.result)).toBe('refuted');
      }),
      propertyParameters({ numRuns: LOST_PAIRS.length * 4 }),
    );
  });
});

if (!RUNNABLE) {
  console.warn(`[formal-cover-cross-check-refutation] the probe did NOT run: ${SKIP_REASON}`);
}
