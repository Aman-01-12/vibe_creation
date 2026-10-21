// Why does the Mutation_Strength_Gate fail a pool of CORRECT testbenches? A ZERO-TOKEN replay.
//
// THE QUESTION
//   Three post-timing-fix Sessions over `adder_8bit` were identical on design health - 7 of 8
//   testbenches won the Trust_Vote and some testbench passed all 8 designs, every time - and
//   differed only on the Mutation_Strength_Gate: two runs failed 7 of 8, one passed 7 of 8.
//   Never a partial split. That bimodality is what makes the hero track verify 1 time in 3, and
//   it decides what to fix: a miscalibrated gate, or testbench heterogeneity.
//
//   The gate is ZERO-COVERAGE-GAP and PEER-RELATIVE (`judgeMutationStrength`): T's requirement
//   set is every compiled mutant whose parent passes T and that at least one OTHER pool member
//   killed, and T passes only by killing all of them. So a pool of individually-strong members
//   with DIFFERENT blind spots can fail every member at once - nobody is weak, each just misses
//   something some peer caught. This replay measures whether that is what happens.
//
// WHY IT COSTS NOTHING
//   The 8 Reference_Models of the paid re-run are already on disk, and all 8 were measured
//   passing `adder_8bit` with zero CHECK-FAIL. They are replayed from those saved replies with
//   NO ModelRouter constructed. `runMutantMatrix` and `judgeMutationStrength` are the real
//   production functions and use only the simulator, so this is simulation time, not tokens.
//
// Run with `node app/eval/dist/scripts/timing-mutation-gate-replay.js`, after `npm run build`.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkAuthoringContract,
  judgeMutationStrength,
  parseReferenceModelDraft,
  runMutantMatrix,
  type GeneratedDesign,
  type GeneratedReferenceModel,
  type MutationGateOutcome,
  type RunCell,
  type RunMatrix,
} from '@app/agent';
import { newUlid, type Ulid } from '@app/core';
import {
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  renderConsensusHarness,
  SAMPLE_BUDGET,
  SandboxToolRunner,
  referenceModelFunctionHeaders,
  type ResourceLimits,
  type SimulatorAdapter,
  type SourceFile,
} from '@app/tools';

import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import { findWorkerPython } from '../sweep/host-facts.js';

const PROBLEM_ID = 'rtllm/arithmetic/adder_8bit';
const WATCHDOG_BUDGET_NS = 2_000_000;
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** The newest paid re-run directory, whose `replies/` holds the 8 saved Reference_Models. */
async function newestReplyDir(): Promise<string> {
  const runs = await readdir(join(REPOSITORY_ROOT, '.eval-runs'));
  const candidates = runs.filter((name) => name.startsWith('timing-paid-re-run-')).sort();
  const newest = candidates.at(-1);
  if (newest === undefined) {
    throw new Error('no timing-paid-re-run-* directory; the saved Reference_Models are required');
  }
  return join(REPOSITORY_ROOT, '.eval-runs', newest, 'replies');
}

function realSimulator(): SimulatorAdapter {
  const pythonBin = findWorkerPython();
  if (pythonBin === null) throw new Error('replay requires a worker-capable Python');
  return new IcarusSimulatorAdapter(new SandboxToolRunner(new LocalWorkerRuntime(pythonBin)));
}

interface PerTestbench {
  readonly source: string;
  readonly parentPassed: boolean;
  readonly requirementSize: number;
  readonly gate: MutationGateOutcome['kind'];
  readonly killed: number;
  readonly survivedInRequirement: number;
  readonly missedPeerKilled: number;
  readonly killRateOverCompiled: number | null;
}

async function main(): Promise<void> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const problem = corpus.problems.find((candidate) => candidate.id === PROBLEM_ID);
  const reference = corpus.references.get(PROBLEM_ID);
  if (problem === undefined || reference === undefined) {
    throw new Error(`${PROBLEM_ID} not in the imported corpus`);
  }
  const moduleInterface = problem.spec.moduleInterface;
  const simulator = realSimulator();

  // --- the pool: 8 saved Reference_Models, replayed, no model call -------------------------
  const replyDir = await newestReplyDir();
  const replyFiles = (await readdir(replyDir)).filter((n) => n.endsWith('.txt')).sort();
  const testbenches: GeneratedReferenceModel[] = [];
  const sourceById = new Map<Ulid, string>();
  for (const filename of replyFiles) {
    const reply = await readFile(join(replyDir, filename), 'utf8');
    const parsed = parseReferenceModelDraft(reply, moduleInterface);
    if (!parsed.ok) {
      console.log(`  SKIP ${filename}: parse (${parsed.error.reason})`);
      continue;
    }
    const checked = checkAuthoringContract(parsed.value);
    if (checked.kind === 'rejected') {
      console.log(`  SKIP ${filename}: authoring-contract`);
      continue;
    }
    const headers = referenceModelFunctionHeaders(moduleInterface);
    const refModel: SourceFile = {
      path: 'refmodel.v',
      contents:
        [
          headers.resetState,
          checked.bodies.resetStateBody,
          'endfunction',
          headers.nextState,
          checked.bodies.nextStateBody,
          'endfunction',
          headers.expect,
          checked.bodies.expectBody,
          'endfunction',
        ].join('\n') + '\n',
    };
    const nonce = `g${randomUUID().replace(/-/gu, '').slice(0, 11)}`;
    const harness = renderConsensusHarness({
      moduleInterface,
      timingContract: problem.spec.timingContract,
      nonce,
      watchdogBudgetNs: WATCHDOG_BUDGET_NS,
      sampleBudget: SAMPLE_BUDGET,
      roles: checked.bodies.roles,
    });
    if (!harness.ok) throw new Error(`harness render failed: ${harness.error.code}`);
    const testbenchId = newUlid();
    sourceById.set(testbenchId, filename);
    testbenches.push({
      testbenchId,
      referenceModel: refModel,
      harness: harness.value,
      nonce,
      family: { provider: 'bedrock-mantle', lineage: filename },
      draft: checked.bodies,
    });
  }
  console.log(`pool: ${String(testbenches.length)} replayed Reference_Models\n`);

  // --- the design: the corpus's own known-correct reference RTL ----------------------------
  const designId = newUlid();
  const designs: readonly GeneratedDesign[] = [
    {
      designId,
      rtl: [reference.rtl],
      family: { provider: 'bedrock-mantle', lineage: 'corpus-reference' },
    },
  ];

  // --- the RunMatrix: does the unmutated reference pass each testbench ---------------------
  const cells: RunCell[] = [];
  for (const testbench of testbenches) {
    const verdict = await simulator.simulate(
      [reference.rtl, testbench.referenceModel],
      testbench.harness,
      LIMITS,
    );
    cells.push({
      designId,
      testbenchId: testbench.testbenchId,
      passed: verdict.verdict === 'pass',
      signature: null,
      failureCause: verdict.failureCause,
    });
  }
  const matrix: RunMatrix = {
    designIds: [designId],
    testbenchIds: testbenches.map((t) => t.testbenchId),
    cells,
  };
  const parentPassCount = cells.filter((cell) => cell.passed === true).length;
  console.log(`unmutated reference passes ${String(parentPassCount)}/${String(cells.length)}\n`);

  // --- the real mutant matrix and the real gate -------------------------------------------
  const runsByTestbench = await runMutantMatrix(designs, testbenches, matrix, simulator, LIMITS);

  const killedSets = new Map<Ulid, Set<string>>();
  const allMutants = new Set<string>();
  for (const [testbenchId, runs] of runsByTestbench) {
    const killed = new Set<string>();
    for (const run of runs) {
      allMutants.add(run.mutant.mutantId);
      if (run.killedByJudged) killed.add(run.mutant.mutantId);
    }
    killedSets.set(testbenchId, killed);
  }
  let killedByAll = 0;
  let killedByNone = 0;
  let killedByAtLeastOne = 0;
  for (const id of allMutants) {
    const killers = [...killedSets.values()].filter((s) => s.has(id)).length;
    if (killers > 0) killedByAtLeastOne += 1;
    if (killers === 0) killedByNone += 1;
    if (killers === killedSets.size) killedByAll += 1;
  }

  const perTestbench: PerTestbench[] = [];
  for (const [testbenchId, runs] of runsByTestbench) {
    const outcome = judgeMutationStrength({ testbenchId, mutantRuns: runs });
    const requirement = runs.filter((r) => r.compiled && r.parentPassedJudged && r.killedByPeer);
    const mine = killedSets.get(testbenchId) ?? new Set<string>();
    const peerKilled = new Set<string>();
    for (const [other, set] of killedSets) {
      if (other === testbenchId) continue;
      for (const id of set) peerKilled.add(id);
    }
    const compiled = runs.filter((r) => r.compiled);
    perTestbench.push({
      source: sourceById.get(testbenchId) ?? '?',
      parentPassed: cells.find((c) => c.testbenchId === testbenchId)?.passed === true,
      requirementSize: requirement.length,
      gate: outcome.kind,
      killed: mine.size,
      survivedInRequirement: requirement.filter((r) => !r.killedByJudged).length,
      missedPeerKilled: [...peerKilled].filter((id) => !mine.has(id)).length,
      killRateOverCompiled:
        compiled.length === 0
          ? null
          : compiled.filter((r) => r.killedByJudged).length / compiled.length,
    });
  }

  const gateCounts = perTestbench.reduce<Record<string, number>>((acc, t) => {
    acc[t.gate] = (acc[t.gate] ?? 0) + 1;
    return acc;
  }, {});

  const report = {
    problemId: PROBLEM_ID,
    poolSize: testbenches.length,
    unmutatedParentPasses: parentPassCount,
    distinctMutants: allMutants.size,
    killedByAtLeastOne,
    killedByAll,
    killedByNone,
    gateCounts,
    heterogeneous: perTestbench.some((t) => t.missedPeerKilled > 0),
    perTestbench,
  };
  const outDir = join(
    REPOSITORY_ROOT,
    '.eval-runs',
    `timing-mutation-gate-replay-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nreport under ${outDir}`);
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`mutation-gate-replay: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  });
}
