// Replay the 32 recorded Reference_Models from disk, under both Timing_Contracts
// (timing-contract-inference task 15.5; Req 8.5, 8.9).
//
// WHAT THIS ESTABLISHES
//   The recorded Consensus_Sweep at `.eval-runs/consensus-sweep-2026-10-19T10-30-20-307Z`
//   already holds 32 generated Reference_Models on disk (4 designs x 8 replies each, in
//   `refmodels/<flattened-problem-id>.json`). This suite reads them back exactly as written -
//   no model router, no credential, no network call - and re-simulates each one against its
//   own design's reference RTL under BOTH the pre-feature all-`registered` contract and the
//   now-correctly-derived contract, holding everything else constant.
//
// WHY THIS NEEDS NO PAID_RE_RUN APPROVAL (Req 8.9)
//   `ModelRouter` is never imported, let alone constructed, in this file. The 32 replies are
//   read from the committed run directory with `node:fs`, the same device
//   `pilot.ts`'s own `--replay <runDir>` mode uses (`router === null`, `readFile` instead of
//   `router.invoke`). Zero tokens are spent, asserted explicitly below, which is what keeps
//   this replay outside the `Paid_Re_Run` hold task 15.1's gate enforces.
//
// GATING
//   Two capabilities are needed and each is probed, never assumed: the real toolchain (`PROBE`,
//   for re-simulating each replayed body) and the named run directory's presence (it is real
//   recorded data from an earlier session, not a fixture this suite creates). When either is
//   missing the suite SKIPS with a reason.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface, type TimingContract } from '@app/core';
import {
  decidePairedContractVerdict,
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  localTimingDerivation,
  RTLLM_CHECKOUT_PATH,
  type RtllmCorpus,
} from '@app/eval';
import {
  referenceModelFunctionHeaders,
  renderConsensusHarness,
  type ResourceLimits,
  type RoleDeclaration,
  type SourceFile,
} from '@app/tools';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

/** This module's directory, for the both-layouts path rule. */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '..', '..');

/** The named recorded run this task replays (Req 8.5's own glossary entry). */
const RUN_DIR = resolve(REPOSITORY_ROOT, '.eval-runs/consensus-sweep-2026-10-19T10-30-20-307Z');

/** One `refmodels/<flattened-id>.json` entry's own recorded shape. */
interface RecordedReferenceModel {
  readonly testbenchId: string;
  readonly resetStateBody: string;
  readonly nextStateBody: string;
  readonly expectBody: string;
  readonly roles: RoleDeclaration;
}

/** Whether the recorded run directory is present, and why not when it is absent. */
interface RunDirProbe {
  readonly available: boolean;
  readonly reason: string;
  readonly refmodelFiles: readonly string[];
}

async function probeRunDir(): Promise<RunDirProbe> {
  try {
    const files = await readdir(resolve(RUN_DIR, 'refmodels'));
    const jsonFiles = files.filter((name) => name.endsWith('.json'));
    if (jsonFiles.length === 0) {
      return {
        available: false,
        reason: `${RUN_DIR}/refmodels holds no .json file`,
        refmodelFiles: [],
      };
    }
    return {
      available: true,
      reason: 'the recorded run directory is present',
      refmodelFiles: jsonFiles,
    };
  } catch {
    return {
      available: false,
      reason: `no recorded run at ${RUN_DIR}; this suite replays real recorded data, not a fixture`,
      refmodelFiles: [],
    };
  }
}

const RUN_DIR_PROBE = await probeRunDir();
const SKIP_REASON = !PROBE.available ? PROBE.reason : RUN_DIR_PROBE.reason;
const RUNNABLE = PROBE.available && RUN_DIR_PROBE.available;

if (!RUNNABLE) {
  console.warn(
    `[timing-paired-contract-replay-from-disk] NOT exercised: ${SKIP_REASON}. The 32 recorded ` +
      'Reference_Models were not replayed in this environment.',
  );
}

const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
const WATCHDOG_BUDGET_NS = 2_000_000;
const SAMPLE_BUDGET = 64;

/** `rtllm_arithmetic_adder_8bit.json` -> `rtllm/arithmetic/adder_8bit`, the flattening the
 *  sweep's own writer uses (mirrors `pilot.ts`'s sibling `replyFilename` convention). */
function problemIdOf(flattenedFilename: string): string {
  const stem = flattenedFilename.replace(/\.json$/u, '');
  const [, category, ...rest] = stem.split('_');
  return `rtllm/${category}/${rest.join('_')}`;
}

/** All output ports set to `timing`, for the pre-feature fabrication's own reconstruction. */
function uniformContract(
  moduleInterface: ModuleInterface,
  timing: 'registered' | 'combinational',
): TimingContract {
  const built = makeTimingContract(
    moduleInterface,
    moduleInterface.ports
      .filter((port) => port.direction === 'output')
      .map((port) => ({ portName: port.name, timing })),
  );
  if (!built.ok) throw new Error(`fixture defect: ${built.error.code}`);
  return built.value;
}

/** Count every `CHECK <nonce>_<port> FAIL` line in the run's stdout. */
function countCheckFailLines(stdout: string): number {
  return (stdout.match(/^CHECK \S+ FAIL\b/gmu) ?? []).length;
}

/** Render one recorded reference model into a compilation-unit-scope file. */
function renderRefModelFile(
  moduleInterface: ModuleInterface,
  recorded: RecordedReferenceModel,
): SourceFile {
  const headers = referenceModelFunctionHeaders(moduleInterface);
  const lines = [
    headers.resetState,
    recorded.resetStateBody,
    'endfunction',
    headers.nextState,
    recorded.nextStateBody,
    'endfunction',
    headers.expect,
    recorded.expectBody,
    'endfunction',
  ];
  return { path: 'refmodel.v', contents: `${lines.join('\n')}\n` };
}

describe('paired-contract replay-from-disk capability probe', () => {
  it('documents whether the real replay was run in this environment', () => {
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)(
  'replaying the 32 recorded Reference_Models under both Timing_Contracts (Req 8.5, 8.9)',
  () => {
    it(
      'reads 32 reference models from disk across 4 designs, spending zero tokens, and ' +
        'constructs no ModelRouter anywhere in this suite',
      async () => {
        let total = 0;
        for (const filename of RUN_DIR_PROBE.refmodelFiles) {
          const text = await readFile(resolve(RUN_DIR, 'refmodels', filename), 'utf8');
          const recorded = JSON.parse(text) as readonly RecordedReferenceModel[];
          total += recorded.length;
        }
        expect(total).toBe(32);
        // No ModelRouter import appears anywhere in this file's own source - checked
        // structurally, not just by absence of a runtime call, so a later edit that adds
        // one back fails this assertion rather than silently reintroducing a paid call.
        const ownSource = await readFile(
          resolve(HERE, 'timing-paired-contract-replay-from-disk.integration.test.ts'),
          'utf8',
        );
        const importLines = ownSource
          .split('\n')
          .filter((line) => line.trimStart().startsWith('import'))
          .join('\n');
        expect(importLines).not.toMatch(/ModelRouter|SessionBudget/u);
      },
    );

    it('replays each recorded Reference_Model against its own design under both contracts', async () => {
      const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
      const corpus: RtllmCorpus = await importRtllmCorpus(checkout, localTimingDerivation());

      const perDesign: {
        design: string;
        registeredFailCount: number;
        derivedPassCount: number;
        sampleCount: number;
      }[] = [];

      for (const filename of RUN_DIR_PROBE.refmodelFiles) {
        const problemId = problemIdOf(filename);
        const problem = corpus.problems.find((candidate) => candidate.id === problemId);
        const reference = corpus.references.get(problemId);
        if (problem === undefined || reference === undefined) {
          throw new Error(`${problemId} (from ${filename}) is not in the imported corpus`);
        }
        const moduleInterface = problem.spec.moduleInterface;
        const derivedContract = problem.spec.timingContract;
        const registeredContract = uniformContract(moduleInterface, 'registered');

        const text = await readFile(resolve(RUN_DIR, 'refmodels', filename), 'utf8');
        const recordedModels = JSON.parse(text) as readonly RecordedReferenceModel[];

        let registeredFailCount = 0;
        let derivedPassCount = 0;
        for (const [index, recorded] of recordedModels.entries()) {
          const nonce = `preplay${String(index)}`;
          const refModel = renderRefModelFile(moduleInterface, recorded);

          const registeredHarness = renderConsensusHarness({
            moduleInterface,
            timingContract: registeredContract,
            nonce: `${nonce}a`,
            watchdogBudgetNs: WATCHDOG_BUDGET_NS,
            sampleBudget: SAMPLE_BUDGET,
            roles: recorded.roles,
          });
          if (!registeredHarness.ok) {
            throw new Error(`fixture defect: ${registeredHarness.error.code}`);
          }
          const registeredVerdict = await realOracleAdapter().simulate(
            [reference.rtl, refModel],
            registeredHarness.value,
            LIMITS,
          );
          const registeredOutcome = decidePairedContractVerdict({
            checkFailCount: countCheckFailLines(registeredVerdict.stdout),
            passed: registeredVerdict.verdict === 'pass',
          });
          if (registeredOutcome === 'unsupported') registeredFailCount += 1;

          const derivedHarness = renderConsensusHarness({
            moduleInterface,
            timingContract: derivedContract,
            nonce: `${nonce}b`,
            watchdogBudgetNs: WATCHDOG_BUDGET_NS,
            sampleBudget: SAMPLE_BUDGET,
            roles: recorded.roles,
          });
          if (!derivedHarness.ok) {
            throw new Error(`fixture defect: ${derivedHarness.error.code}`);
          }
          const derivedVerdict = await realOracleAdapter().simulate(
            [reference.rtl, refModel],
            derivedHarness.value,
            LIMITS,
          );
          const derivedOutcome = decidePairedContractVerdict({
            checkFailCount: countCheckFailLines(derivedVerdict.stdout),
            passed: derivedVerdict.verdict === 'pass',
          });
          if (derivedOutcome === 'supported') derivedPassCount += 1;
        }

        perDesign.push({
          design: moduleInterface.moduleName,
          registeredFailCount,
          derivedPassCount,
          sampleCount: recordedModels.length,
        });
      }

      // Non-vacuous: all 4 designs replayed, 8 samples each.
      expect(perDesign).toHaveLength(4);
      for (const design of perDesign) {
        expect(design.sampleCount).toBe(8);
      }
      console.log(JSON.stringify(perDesign, null, 2));
    }, 300_000);
  },
);
