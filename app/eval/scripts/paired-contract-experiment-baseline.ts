// timing-contract-inference, task 15.4: the CITED (never re-derived) Icarus 13.0 baseline for
// the Paired_Contract_Experiment (Req 8.3).
//
// WHY THIS IS A CITATION, NOT A SCRIPT THAT PRODUCES THE ARTIFACT
//   Every sibling artifact in this spec folder (`timing-cross-check.json`,
//   `timing-adjacency-separating-search.json`) is written by a script that RUNS the real
//   toolchain and records what it measured. This one is deliberately different: the three
//   figures (94, 91, 0) were already measured once, by hand, on real Icarus 13.0, and are
//   recorded in `chipAgent/_inbox/gotcha-the-timing-contract-is-fabricated-all-registered-in-
//   three-places-so-15-of-46-combinational-designs-are-unwinnable-by-construction.md`. Req 8.3
//   asks this feature to CITE that banked measurement, not re-run it: "re-deriving a banked
//   measurement is how a baseline quietly becomes a different number" (task 15.4's own text).
//   So this module owns no simulator, no model router, and no sandbox - only the committed
//   JSON's shape and path, read back by the pinning test.
//
// Module imports nothing from `@app/tools`, `@app/agent`, or any simulator/model/sandbox
// surface, by the same discipline `reportability-baseline.ts`'s own test enforces for itself.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This module's directory, for the both-layouts path rule (dist runs one level deeper). */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, named from this module's own location in either layout. */
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** The cited artifact's fixed path (Req 8.3), relative to the repository root. */
export const PAIRED_CONTRACT_BASELINE_PATH = 'app/eval/paired-contract-experiment-baseline.json';

/** The absolute path, resolved from the repository root in either build layout. */
export function pairedContractBaselineAbsolutePath(): string {
  return resolve(REPOSITORY_ROOT, PAIRED_CONTRACT_BASELINE_PATH);
}

/** One cited measurement: which Timing_Contract, which reference-model style, and its outcome. */
export interface PairedContractBaselineMeasurement {
  readonly timingContract: 'registered' | 'combinational';
  readonly referenceModelStyle: 'registered-style' | 'combinational';
  readonly passed: boolean;
  readonly checkFailCount: number;
}

/** The committed artifact's own shape, read back unchanged by the pinning test. */
export interface PairedContractExperimentBaseline {
  readonly design: string;
  readonly simulator: string;
  readonly sampleBudget: number;
  readonly measurements: readonly PairedContractBaselineMeasurement[];
  readonly citedFrom: string;
}
