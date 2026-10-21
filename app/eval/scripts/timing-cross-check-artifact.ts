// timing-contract-inference, task 12.7: write the committed Timing_Cross_Check artifact
// Requirement 6.11 requires - the published counts (task 12.1), the disagreement rows (task
// 12.3), and the witness rows (task 12.5), plus the six population figures, in one JSON object
// at `app/eval/timing-cross-check.json`.
//
// WHY NOT UNDER THE SPEC FOLDER, WHICH REQUIREMENT 6.11'S TEXT NAMES
//   6.11 asks for a COMMITTED artifact UNDER THE SPEC FOLDER, and in this repo those two
//   cannot both hold: `.kiro` is gitignored by a deliberate decision (commit 1d99809, "dev
//   process state stays local-only going forward"), so an artifact written there is never
//   committed and its pinning test passes locally while failing on a fresh clone. "Committed"
//   is the load-bearing half - the artifact exists to be a ratchet that fails when a figure is
//   edited - so it lives beside `reportability-baseline.json`, the repo's existing precedent
//   for a committed measurement artifact. Recorded as DQ-09.
//
// WHY THIS RUNS THE REAL DERIVATION ITSELF RATHER THAN READING THE PRODUCTION IMPORT'S QUARANTINE
//   `importRtllmCorpus`'s own `TIMING_UNDERIVABLE` quarantine carries only a free-text detail
//   string (`timingRefusalDetail` in `import.ts`), because Req 2.5 admits nothing richer into a
//   quarantine record. The cross-check needs the STRUCTURED refusal - which ports, under which
//   cause - to build one `DerivedPortResult` per port. So this script imports the checkout with
//   a `FixedTimingDerivation` stand-in that never refuses, purely to recover every design's
//   reference RTL and `ModuleInterface` (the same device task 11.1's
//   `timing-pass-sequence-equivalence.ts` uses), and then calls the REAL `localTimingDerivation()`
//   port directly, once per design, reading its ok/err result structurally.
//
// Run with `node app/eval/dist/scripts/timing-cross-check-artifact.js`, after `npm run build`.
// Requires `yosys` on PATH, a worker-capable Python, and the pinned RTLLM checkout
// (`npm run corpus:fetch`).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModuleInterface } from '@app/core';
import type { SourceFile } from '@app/tools';

import {
  assembleCrossCheckReport,
  compareDerivedTiming,
  FileSystemCorpusCheckout,
  FixedTimingDerivation,
  importRtllmCorpus,
  inDerivationPopulation,
  localTimingDerivation,
  summarizeTimingPopulations,
  type CrossCheckReport,
  type DerivedPortResult,
  type DesignDerivationOutcome,
  type TimingDerivationPort,
} from '../corpus/index.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repository root, resolved the same both-layouts way `reportability-baseline.ts` resolves
 * it: authored at `app/eval/scripts/`, compiled to `app/eval/dist/scripts/`, one level deeper.
 */
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** The committed artifact's fixed path (Req 6.11), relative to the repository root. */
export const TIMING_CROSS_CHECK_ARTIFACT_PATH = 'app/eval/timing-cross-check.json';

/** The `<design>` segment of a `rtllm/<category>/<design>` problem id, matching the manifest's key. */
function designNameOf(problemId: string): string {
  return problemId.slice(problemId.lastIndexOf('/') + 1);
}

/**
 * One design's real derivation: its per-port results, and its population outcome, or `null` for
 * a design outside the Derivation_Population (see `deriveDesign` for why neither is produced).
 */
interface DesignDerivation {
  readonly results: readonly DerivedPortResult[];
  readonly outcome: DesignDerivationOutcome | null;
}

/**
 * Derive one design's REAL Timing_Contract or refusal from its own reference RTL and interface,
 * flattened into per-port rows.
 *
 * A design outside the Derivation_Population (the two Yosys frontend rejections) never reaches
 * `derivation.derive`: the real pre-pass would only confirm what `YOSYS_FRONTEND_REJECTED_PROBLEM_IDS`
 * already records, at the cost of a real sandbox run, and `summarizeTimingPopulations` filters
 * any outcome outside the population out of `derivedContracts` and `derivationExclusions`
 * regardless, so a design outside the population needs no outcome entry at all (task 1.3's
 * module header: "a design outside the Derivation_Population is not a derivation failure; it
 * never entered the derivation"). It also contributes no per-port row: the committed manifest
 * carries no entry for it, so a row here would read as an unknown pair rather than as a
 * population exclusion (Req 6.2).
 */
async function deriveDesign(
  derivation: TimingDerivationPort,
  problemId: string,
  rtl: SourceFile,
  moduleInterface: ModuleInterface,
): Promise<DesignDerivation> {
  if (!inDerivationPopulation(problemId)) {
    return { results: [], outcome: null };
  }
  const design = designNameOf(problemId);
  const derived = await derivation.derive({ rtl, moduleInterface });
  const outcome: DesignDerivationOutcome = derived.ok
    ? { problemId, outcome: 'derived' }
    : { problemId, outcome: 'excluded', cause: derived.error.cause };
  // A whole-design Timing_Refusal (Req 2.1) voids every declared output port's result, not
  // only the ports the refusal names: `TimingRefusal.ports` lists the ports that CAUSED the
  // refusal, but a sibling port that classified cleanly before the refusal fired never gets a
  // contract value either (DQ-08). Reporting `refused` for the whole declared output set is
  // what makes that fact visible to the comparator instead of silently missing those rows.
  const results: readonly DerivedPortResult[] = derived.ok
    ? derived.value.entries.map((entry) => ({
        design,
        port: entry.portName,
        derived: entry.timing,
      }))
    : moduleInterface.ports
        .filter((port) => port.direction === 'output')
        .map((port) => ({ design, port: port.name, derived: 'refused' as const }));
  return { results, outcome };
}

/** The real per-port derivation over every design the checkout imports, before any aggregation. */
export interface TimingCrossCheckMeasurement {
  readonly results: readonly DerivedPortResult[];
  readonly outcomes: readonly DesignDerivationOutcome[];
}

/**
 * Run the real `localTimingDerivation()` over every design the pinned checkout imports,
 * flattened into per-port rows plus each design's population outcome.
 *
 * The one real-run loop both `runTimingCrossCheckMeasurement` (the committed artifact, task
 * 12.7) and the manifest ratchet integration test (task 12.8) need: the latter feeds `results`
 * straight into `compareDerivedTiming` itself rather than through `assembleCrossCheckReport`,
 * because `CrossCheckReport.disagreements` only ever carries `DISAGREED` rows and the ratchet's
 * other four failure outcomes (Req 6.12's second direction among them) would be invisible to a
 * test that read the assembled report instead of the comparator's own `failures`.
 */
export async function deriveTimingCrossCheckMeasurement(): Promise<TimingCrossCheckMeasurement> {
  const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
  // Never refuses, so every design's reference RTL and ModuleInterface are recovered regardless
  // of its real timing outcome - see the module header for why the real refusal is read below.
  const corpus = await importRtllmCorpus(checkout, new FixedTimingDerivation('registered'));
  const derivation = localTimingDerivation();

  const results: DerivedPortResult[] = [];
  const outcomes: DesignDerivationOutcome[] = [];
  for (const problem of corpus.problems) {
    const reference = corpus.references.get(problem.id);
    if (reference === undefined) {
      // Unreachable: `importRtllmCorpus` populates `references` for every problem it imports.
      continue;
    }
    const derivedDesign = await deriveDesign(
      derivation,
      problem.id,
      reference.rtl,
      problem.spec.moduleInterface,
    );
    results.push(...derivedDesign.results);
    if (derivedDesign.outcome !== null) {
      outcomes.push(derivedDesign.outcome);
    }
  }
  return { results, outcomes };
}

/**
 * Run the real derivation over every design the checkout imports and assemble the Timing_Cross_Check
 * report (task 12.1, 12.3, 12.5).
 */
export async function runTimingCrossCheckMeasurement(): Promise<CrossCheckReport> {
  const { results, outcomes } = await deriveTimingCrossCheckMeasurement();
  const comparison = compareDerivedTiming(results);
  const populations = summarizeTimingPopulations(outcomes);
  return assembleCrossCheckReport(comparison, populations);
}

/** Write the report to the committed artifact path, creating the spec folder if absent. */
export async function writeTimingCrossCheckArtifact(report: CrossCheckReport): Promise<string> {
  const outPath = resolve(REPOSITORY_ROOT, TIMING_CROSS_CHECK_ARTIFACT_PATH);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

async function main(): Promise<void> {
  const report = await runTimingCrossCheckMeasurement();
  const outPath = await writeTimingCrossCheckArtifact(report);
  console.log(`Timing_Cross_Check artifact written to ${outPath}`);
  console.log(
    `agreeing ${String(report.agreeing)}, disagreeing ${String(report.disagreeing)}, ` +
      `refusalCovered ${String(report.refusalCovered)}`,
  );
  if (report.disagreements.length > 0) {
    console.log(`${String(report.disagreements.length)} disagreement(s):`);
    for (const d of report.disagreements) {
      console.log(`  ${d.design}/${d.port}: derived=${d.derived} groundTruth=${d.groundTruth}`);
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.error(`timing-cross-check-artifact: ${message}`);
    process.exitCode = 1;
  });
}
