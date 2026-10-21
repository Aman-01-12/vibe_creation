// Mutation smoke on the `accu` scoreboard fixture (task 11.4, Req 6.2, 6.3): the same
// Negative_Control both Strategy_Arms are judged by must see the scaffold kill mutants, so a
// scaffold that silently checks nothing shows up as survivors before any money is spent.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleScoreboardTestbench,
  normalizeDialect,
  parseFragmentReply,
  renderScoreboardScaffold,
  requiredChecks,
} from '@app/agent';
import {
  DEFAULT_MUTANT_WALL_MS,
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  MUTATION_OPERATORS,
  RTLLM_CHECKOUT_PATH,
  RtllmMutationCalibrator,
  RtllmMutationNegativeControl,
  SandboxGoldenTestbenchScorer,
  scoredRtllmCorpus,
} from '@app/eval';
import {
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SandboxToolRunner,
  type ResourceLimits,
} from '@app/tools';
import { describe, expect, it } from 'vitest';

import { CORPUS_TIMING_STAND_IN, PROBE } from './real-oracle-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBLEM_ID = 'rtllm/arithmetic/accu';
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
/** A small budget: the question is "does it kill anything", not a rate. */
const MUTATION_CONFIG = { maxMutantsPerProblem: 8, operators: MUTATION_OPERATORS };

const CORPUS_PRESENT =
  (await new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH).listDirectories([])).length > 0;
const RUNNABLE = PROBE.available && CORPUS_PRESENT;
if (!RUNNABLE) {
  console.warn('[scoreboard-mutation-smoke] NOT exercised: no toolchain or no pinned corpus here.');
}

describe.skipIf(!RUNNABLE)('11.4 the accu scoreboard fixture kills mutants', () => {
  it('is measured by the Negative_Control and kills at least one valid mutant', async () => {
    const imported = await importRtllmCorpus(
      new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
      CORPUS_TIMING_STAND_IN,
    );
    const problem = scoredRtllmCorpus(imported).problems.find((p) => p.id === PROBLEM_ID);
    if (problem === undefined) {
      throw new Error(`${PROBLEM_ID} is not in the scored corpus`);
    }
    const scaffold = renderScoreboardScaffold(
      problem.spec.moduleInterface,
      requiredChecks(problem.spec).map((check) => check.name),
    );
    if (!scaffold.ok) {
      throw new Error(scaffold.error.reason);
    }
    const reply = await readFile(
      join(HERE, 'fixtures', 'scoreboard', 'accu.fragments.json'),
      'utf8',
    );
    const fragments = parseFragmentReply(reply, scaffold.value);
    if (!fragments.ok) {
      throw new Error(JSON.stringify(fragments.error));
    }
    const testbench = normalizeDialect(
      assembleScoreboardTestbench(scaffold.value, fragments.value),
    ).source;
    const runtime = new LocalWorkerRuntime(PROBE.pythonBin);
    const negative = new RtllmMutationNegativeControl({
      simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(runtime)),
      calibrator: new RtllmMutationCalibrator({
        scorer: new SandboxGoldenTestbenchScorer(new SandboxToolRunner(runtime)),
        golden: imported.golden,
        references: imported.references,
        config: MUTATION_CONFIG,
        mutantWallMs: DEFAULT_MUTANT_WALL_MS,
        cacheKey: {
          corpusCommit: imported.pinnedCommit,
          mutationConfigHash: 'scoreboard-mutation-smoke',
          mutantWallMs: DEFAULT_MUTANT_WALL_MS,
        },
      }),
    });
    const outcome = await negative.probe({
      problemId: PROBLEM_ID,
      testbench,
      limits: LIMITS,
      requiredCheckNames: [],
    });
    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    console.info(
      `[scoreboard-mutation-smoke] accu: killed ${String(outcome.report.killedCount)}/` +
        `${String(outcome.report.validCount)} valid, coverage gaps ` +
        `${String(outcome.report.coverageGapSurvivors.length)}`,
    );
    expect(outcome.report.validCount).toBeGreaterThan(0);
    expect(outcome.report.killedCount).toBeGreaterThan(0);
  }, 600_000);
});
