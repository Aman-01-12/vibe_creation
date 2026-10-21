// timing-contract-inference, task 13.2: search the whole Derivation_Population for a port
// where the cone rule (`classifyPortTiming`) and the adjacency rule
// (`classifyPortTimingByAdjacency`, task 13.1) disagree.
//
// WHY A SEPARATE RAW-FINDING RECOVERY RATHER THAN REUSING `FormalPrepassTimingDerivation`
//   `FormalPrepassTimingDerivation.derive` submits the pre-pass job, parses the report, and
//   immediately folds the result through `classifyPortTiming` - it never returns the raw
//   `PrepassTimingFinding` a caller would need to run a SECOND classifier over the same facts.
//   This script re-does only the submit-and-parse half (the exact same job assembly and report
//   parse `FormalPrepassTimingDerivation` uses), then hands the recovered finding to BOTH
//   classifiers, so the comparison is over identical facts rather than two separate pre-pass
//   runs that could themselves disagree for toolchain reasons unrelated to the rule under test.
//
// Run with `node app/eval/dist/scripts/timing-adjacency-separating-search.js`, after
// `npm run build`. Requires `yosys` on PATH, a worker-capable Python, and the pinned RTLLM
// checkout (`npm run corpus:fetch`).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModuleInterface, PortTiming } from '@app/core';
import {
  assembleFormalPrepassJob,
  classifyPortTiming,
  classifyPortTimingByAdjacency,
  parseFormalPrepassReport,
  type PrepassTimingFinding,
} from '@app/tools';
import {
  BoundedArtifactRetention,
  LocalWorkerRuntime,
  SandboxToolRunner,
  type ResourceLimits,
  type SourceFile,
} from '@app/tools';

import {
  FileSystemCorpusCheckout,
  FixedTimingDerivation,
  importRtllmCorpus,
  inDerivationPopulation,
} from '../corpus/index.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { TIMING_DERIVATION_LIMITS } from '../corpus/timing-derivation-node.js';
import { findWorkerPython } from '../sweep/host-facts.js';

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, resolved the same both-layouts way the sibling scripts resolve it. */
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** The committed search artifact's fixed path (Req 6.14, 6.15), relative to the repo root. */
export const ADJACENCY_SEPARATING_ARTIFACT_PATH =
  'app/eval/timing-adjacency-separating-search.json';

/** One port where the cone rule and the adjacency rule disagree. */
export interface AdjacencySeparatingPort {
  readonly design: string;
  readonly port: string;
  readonly coneResult: PortTiming | 'refused';
  readonly adjacencyResult: PortTiming | 'refused';
  /** Whether the cone rule's result matches the committed manifest for this port, or `null`
   *  when the manifest carries no entry for this design/port pair. */
  readonly coneAgreesWithManifest: boolean | null;
}

/** The whole search's outcome: either a measured separating set, or an explicit UNWITNESSED. */
export interface AdjacencySeparatingSearchReport {
  readonly designsSearched: number;
  readonly adjacencySeparating: readonly AdjacencySeparatingPort[];
  /** `true` when `adjacencySeparating` is empty: Req 1.10 is UNWITNESSED on this corpus. */
  readonly unwitnessed: boolean;
}

/** The `<design>` segment of a `rtllm/<category>/<design>` problem id. */
function designNameOf(problemId: string): string {
  return problemId.slice(problemId.lastIndexOf('/') + 1);
}

/** Recover one design's raw `PrepassTimingFinding`, submitting the same job the production
 *  derivation submits, or `null` for every shape of missing evidence (mirrors
 *  `FormalPrepassTimingDerivation`'s own `netlist-unavailable` handling, task 3/Component 4). */
async function recoverFinding(
  runner: SandboxToolRunner,
  artifacts: BoundedArtifactRetention,
  limits: ResourceLimits,
  rtl: SourceFile,
  moduleInterface: ModuleInterface,
): Promise<PrepassTimingFinding | null> {
  const job = assembleFormalPrepassJob(rtl, moduleInterface, limits);
  let submitted;
  try {
    submitted = await runner.run(job);
  } catch {
    return null;
  }
  const artifact = submitted.artifacts[job.requiredOutputs.at(0) ?? ''];
  if (artifact === undefined) return null;
  const text = await artifacts.readText(artifact);
  if (text === null) return null;
  const parsed = parseFormalPrepassReport(text);
  if (!parsed.ok) return null;
  return parsed.value.timing;
}

/** One declared output port's cone-vs-adjacency comparison for one design. */
function compareOnePort(
  portName: string,
  coneContract: ReturnType<typeof classifyPortTiming>,
  adjacencyContract: ReturnType<typeof classifyPortTimingByAdjacency>,
): { coneResult: PortTiming | 'refused'; adjacencyResult: PortTiming | 'refused' } {
  const coneResult: PortTiming | 'refused' = coneContract.ok
    ? (coneContract.value.entries.find((entry) => entry.portName === portName)?.timing ?? 'refused')
    : 'refused';
  const adjacencyResult: PortTiming | 'refused' = adjacencyContract.ok
    ? (adjacencyContract.value.entries.find((entry) => entry.portName === portName)?.timing ??
      'refused')
    : 'refused';
  return { coneResult, adjacencyResult };
}

/**
 * Run the search over every design the pinned checkout imports that elaborates (the
 * Derivation_Population), comparing the cone rule and the adjacency rule port by port.
 */
export async function runAdjacencySeparatingSearch(): Promise<AdjacencySeparatingSearchReport> {
  const pythonBin = findWorkerPython();
  if (pythonBin === null) {
    throw new Error('no worker-capable Python; cannot run the adjacency separating search');
  }
  const artifacts = new BoundedArtifactRetention();
  const runtime = new LocalWorkerRuntime(pythonBin, undefined, artifacts);
  const runner = new SandboxToolRunner(runtime);

  const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
  // Never refuses, so every design's reference RTL and ModuleInterface are recovered
  // regardless of the production derivation's own real outcome (same device task 12.7 uses).
  const corpus = await importRtllmCorpus(checkout, new FixedTimingDerivation('registered'));

  const { TIMING_GROUND_TRUTH } = await import('../corpus/timing-ground-truth.js');
  const manifestByKey = new Map(
    TIMING_GROUND_TRUTH.map((entry) => [`${entry.design}/${entry.port}`, entry]),
  );

  const separating: AdjacencySeparatingPort[] = [];
  let designsSearched = 0;
  for (const problem of corpus.problems) {
    if (!inDerivationPopulation(problem.id)) continue;
    const reference = corpus.references.get(problem.id);
    if (reference === undefined) continue;
    const moduleInterface = problem.spec.moduleInterface;
    const finding = await recoverFinding(
      runner,
      artifacts,
      TIMING_DERIVATION_LIMITS,
      reference.rtl,
      moduleInterface,
    );
    if (finding === null) continue;
    designsSearched += 1;

    const coneContract = classifyPortTiming(moduleInterface, finding);
    const adjacencyContract = classifyPortTimingByAdjacency(moduleInterface, finding);
    const design = designNameOf(problem.id);
    const outputPortNames = [
      ...new Set(
        moduleInterface.ports.filter((port) => port.direction === 'output').map((p) => p.name),
      ),
    ];
    for (const portName of outputPortNames) {
      const { coneResult, adjacencyResult } = compareOnePort(
        portName,
        coneContract,
        adjacencyContract,
      );
      if (coneResult === adjacencyResult) continue;
      const manifestEntry = manifestByKey.get(`${design}/${portName}`);
      separating.push({
        design,
        port: portName,
        coneResult,
        adjacencyResult,
        coneAgreesWithManifest:
          manifestEntry === undefined ? null : coneResult === manifestEntry.timing,
      });
    }
  }

  return {
    designsSearched,
    adjacencySeparating: separating,
    unwitnessed: separating.length === 0,
  };
}

/** Write the report to the committed artifact path, creating the spec folder if absent. */
export async function writeAdjacencySeparatingArtifact(
  report: AdjacencySeparatingSearchReport,
): Promise<string> {
  const outPath = resolve(REPOSITORY_ROOT, ADJACENCY_SEPARATING_ARTIFACT_PATH);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

async function main(): Promise<void> {
  const report = await runAdjacencySeparatingSearch();
  const outPath = await writeAdjacencySeparatingArtifact(report);
  console.log(`Adjacency separating search artifact written to ${outPath}`);
  console.log(
    `designsSearched ${String(report.designsSearched)}, ` +
      `adjacencySeparating ${String(report.adjacencySeparating.length)}, ` +
      `unwitnessed ${String(report.unwitnessed)}`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.error(`timing-adjacency-separating-search: ${message}`);
    process.exitCode = 1;
  });
}
