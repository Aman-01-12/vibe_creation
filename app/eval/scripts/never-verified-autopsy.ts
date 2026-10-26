// Why does a NEVER-VERIFIED design fail? The corpus sweep reduced each Session to counts, and the
// counts alone cannot separate the two candidate causes, so this run keeps what the sweep dropped.
//
// WHAT THE SWEEP SHOWED, AND WHY IT IS NOT YET AN EXPLANATION
//   20 of the 24 never-verified designs reached `meanTrusted = 0`, and in the ones inspected EVERY
//   pool testbench passed 0 of 8 designs - including the design it was itself written against.
//   A testbench that rejects its own parent is not a testbench that disagrees with its peers about
//   a hard design; something systematic is rejecting every pair. `edge_detect` is five lines of
//   RTL, so "the design is too hard" cannot be the explanation there.
//
// THE DISCRIMINATING MEASUREMENT
//   `RunCell.failureCause` separates the causes, and the sweep's reducer discarded it:
//     - `build-failed` on every cell  -> the pair never ran; a compile/elaboration mismatch
//       (port names, module names, a harness convention) and no statement about behaviour at all.
//     - `none` on every cell          -> the pairs RAN and the verdict was a behavioural mismatch,
//       which for a five-line design points at a convention disagreement (reset polarity, clock
//       edge, a one-cycle sampling offset) between the generation and testbench roles.
//   Only the second is about design content, and only the second could be helped by splitting a
//   design into smaller units. So this measurement decides whether decomposition is relevant.
//
// Run: `node app/eval/dist/scripts/never-verified-autopsy.js --problem <id> [--sessions N]`. Paid.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeBudgetLedger,
  runSession,
  type ConsensusSessionDeps,
  type DesignGenerator,
  type GeneratedDesign,
  type GeneratedReferenceModel,
  type BudgetLedger,
  type ReferenceModelGenerator,
} from '@app/agent';
import type { Spec, Ulid } from '@app/core';
import type { SourceFile } from '@app/tools';

import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import { liveConsensusSessionDeps, REPOSITORY_ROOT } from '../consensus-regression/live-wiring.js';
import { requirePaidReRunApproval } from './paired-contract-approval-gate.js';

const SESSION_TOKENS = 500_000;

/** Keeps every generated design's RTL so the autopsy can write it out and read it back. */
class KeepDesigns implements DesignGenerator {
  readonly #inner: DesignGenerator;
  readonly #rtl = new Map<Ulid, readonly SourceFile[]>();
  constructor(inner: DesignGenerator) {
    this.#inner = inner;
  }
  async generate(spec: Spec, ledger: BudgetLedger): Promise<GeneratedDesign> {
    const design = await this.#inner.generate(spec, ledger);
    this.#rtl.set(design.designId, design.rtl);
    return design;
  }
  rtl(): ReadonlyMap<Ulid, readonly SourceFile[]> {
    return this.#rtl;
  }
}

/** Keeps every generated testbench, including the rendered harness the pair actually compiles. */
class KeepTestbenches implements ReferenceModelGenerator {
  readonly #inner: ReferenceModelGenerator;
  readonly #byId = new Map<Ulid, GeneratedReferenceModel>();
  constructor(inner: ReferenceModelGenerator) {
    this.#inner = inner;
  }
  async generate(spec: Spec, ledger: BudgetLedger): Promise<GeneratedReferenceModel> {
    const testbench = await this.#inner.generate(spec, ledger);
    this.#byId.set(testbench.testbenchId, testbench);
    return testbench;
  }
  byId(): ReadonlyMap<Ulid, GeneratedReferenceModel> {
    return this.#byId;
  }
}

/** A Ulid is too long for a filename column; the last 6 chars identify a pool member uniquely. */
function shortId(id: string): string {
  return id.slice(-6);
}

function argOf(flag: string, fallback: string): string {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

async function autopsy(spec: Spec, index: number, outDir: string): Promise<string> {
  const { sessionDeps } = liveConsensusSessionDeps();
  const designs = new KeepDesigns(sessionDeps.generateDesign);
  const testbenches = new KeepTestbenches(sessionDeps.generateReferenceModel);
  const deps: ConsensusSessionDeps = {
    ...sessionDeps,
    generateDesign: designs,
    generateReferenceModel: testbenches,
  };
  const outcome = await runSession(
    spec,
    makeBudgetLedger(SESSION_TOKENS, 'session-token-budget'),
    deps,
  );

  const dir = join(outDir, `session-${String(index)}`);
  await mkdir(join(dir, 'designs'), { recursive: true });
  await mkdir(join(dir, 'testbenches'), { recursive: true });

  for (const [designId, rtl] of designs.rtl()) {
    for (const file of rtl) {
      await writeFile(join(dir, 'designs', `${shortId(designId)}-${file.path}`), file.contents);
    }
  }
  for (const [testbenchId, testbench] of testbenches.byId()) {
    await writeFile(
      join(dir, 'testbenches', `${shortId(testbenchId)}-model.v`),
      testbench.referenceModel.contents,
    );
    await writeFile(
      join(dir, 'testbenches', `${shortId(testbenchId)}-harness.v`),
      testbench.harness.contents,
    );
  }

  const record = outcome.record;
  const causeCounts: Record<string, number> = {};
  for (const cell of record.runMatrix.cells) {
    const key = `${cell.passed === true ? 'pass' : cell.passed === null ? 'incomplete' : 'fail'}:${cell.failureCause}`;
    causeCounts[key] = (causeCounts[key] ?? 0) + 1;
  }
  const perTestbench = record.runMatrix.testbenchIds.map((testbenchId) => {
    const own = record.runMatrix.cells.filter((cell) => cell.testbenchId === testbenchId);
    return {
      testbench: shortId(testbenchId),
      passed: own.filter((cell) => cell.passed === true).length,
      causes: [...new Set(own.map((cell) => cell.failureCause))],
    };
  });
  const perDesign = record.runMatrix.designIds.map((designId) => {
    const own = record.runMatrix.cells.filter((cell) => cell.designId === designId);
    return {
      design: shortId(designId),
      passed: own.filter((cell) => cell.passed === true).length,
      causes: [...new Set(own.map((cell) => cell.failureCause))],
    };
  });

  await writeFile(
    join(dir, 'matrix.json'),
    `${JSON.stringify(
      {
        outcomeKind: outcome.kind,
        unmetCondition: outcome.kind === 'unverified' ? outcome.unmetCondition : null,
        tokensSpent: record.tokensSpent,
        causeCounts,
        perTestbench,
        perDesign,
        cells: record.runMatrix.cells.map((cell) => ({
          design: shortId(cell.designId),
          testbench: shortId(cell.testbenchId),
          passed: cell.passed,
          failureCause: cell.failureCause,
        })),
      },
      null,
      2,
    )}\n`,
  );
  return (
    `session ${String(index)}: ${outcome.kind} | causes ${JSON.stringify(causeCounts)} | ` +
    `${String(record.tokensSpent)} tok`
  );
}

async function main(): Promise<void> {
  await requirePaidReRunApproval();
  const problemId = argOf('--problem', '');
  if (problemId === '') throw new Error('--problem <corpus id> is required');
  const sessionCount = Number(argOf('--sessions', '1'));

  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const problem = corpus.problems.find((candidate) => candidate.id === problemId);
  if (problem === undefined) throw new Error(`${problemId} not in the imported corpus`);

  const outDir = join(
    REPOSITORY_ROOT,
    '.eval-runs',
    `autopsy-${problemId.replace(/\//gu, '_')}-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, 'spec.json'),
    `${JSON.stringify({ id: problem.id, spec: problem.spec }, null, 2)}\n`,
  );

  for (let index = 0; index < sessionCount; index += 1) {
    console.log(await autopsy(problem.spec, index, outDir));
  }
  console.log(`\nartifacts under ${outDir}`);
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`autopsy: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  });
}
