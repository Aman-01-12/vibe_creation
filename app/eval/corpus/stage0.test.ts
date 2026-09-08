// Unit tests for Stage 0's classification, driven through a FAKE scorer.
//
// The real Stage 0 run needs `iverilog` and lives in
// `app/test/rtllm-corpus-stage0.integration.test.ts`. What is tested HERE is the
// logic that turns a golden verdict on a reference into a usable-or-quarantined
// decision, because that is what decides the honest size of the scored corpus.
//
// Also tested: `scoredRtllmCorpus` MOVES the reviewed exclusions into `quarantined`
// rather than deleting them, and needs no toolchain to do it - so a machine with no
// `iverilog` still gets the same problem set, with the reasons attached.

import { describe, expect, it } from 'vitest';

import type { ResourceLimits, SourceFile } from '@app/tools';

import type { EvalProblem } from '../problem.js';
import type { GoldenTestbench, RtllmCorpus } from './corpus-types.js';
import type { GoldenScore, GoldenTestbenchScorer } from './golden-scorer.js';
import type { GoldenVerdictKind } from './golden-banner.js';
import { RTLLM_PINNED_COMMIT } from './pinned-source.js';
import {
  RTLLM_SCORED_DESIGN_COUNT,
  scoredRtllmCorpus,
  STAGE0_QUARANTINE,
  STAGE0_QUARANTINED_PROBLEM_IDS,
} from './stage0-quarantine.js';
import { validateReferenceDesigns } from './stage0.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

/** One scripted golden outcome for a fake scorer. */
interface ScriptedOutcome {
  readonly kind: GoldenVerdictKind;
  readonly failureCount?: number;
  readonly banners?: readonly string[];
  readonly diagnostics?: string;
}

/** A scorer returning a scripted outcome per problem id. */
class FakeScorer implements GoldenTestbenchScorer {
  readonly #script: ReadonlyMap<string, ScriptedOutcome>;

  constructor(script: ReadonlyMap<string, ScriptedOutcome>) {
    this.#script = script;
  }

  score(_rtl: SourceFile, golden: GoldenTestbench): Promise<GoldenScore> {
    const scripted = this.#script.get(golden.problemId) ?? { kind: 'passed' as const };
    return Promise.resolve({
      problemId: golden.problemId,
      verdict: {
        kind: scripted.kind,
        failureCount: scripted.failureCount ?? null,
        banners: scripted.banners ?? (scripted.kind === 'error' ? [] : ['a banner']),
      },
      timedOut: false,
      diskLimitExceeded: false,
      exitCode: 0,
      diagnostics: scripted.diagnostics ?? '',
    });
  }
}

/** A corpus of the given problem ids, with matching golden and reference material. */
function corpusOf(problemIds: readonly string[]): RtllmCorpus {
  const problems: EvalProblem[] = problemIds.map((id) => ({ id }) as unknown as EvalProblem);
  return {
    pinnedCommit: RTLLM_PINNED_COMMIT,
    problems,
    golden: new Map(
      problemIds.map((id) => [
        id,
        {
          problemId: id,
          moduleName: 'm',
          testbench: { path: 'testbench.v', contents: 'module tb; endmodule\n' },
          dataFiles: [],
          overriddenParameters: [],
        },
      ]),
    ),
    references: new Map(
      problemIds.map((id) => [
        id,
        {
          problemId: id,
          rtl: { path: 'dut_reference.v', contents: 'module m(); endmodule\n' },
          topModuleRenamedFrom: null,
        },
      ]),
    ),
    quarantined: [],
    designsSeen: problemIds.length,
  };
}

describe('validateReferenceDesigns - usable versus quarantined', () => {
  it('marks a reference that passes its own golden testbench usable', async () => {
    const report = await validateReferenceDesigns(
      corpusOf(['rtllm/arithmetic/adder_8bit']),
      new FakeScorer(new Map()),
      LIMITS,
    );

    expect(report.usableProblemIds).toEqual(['rtllm/arithmetic/adder_8bit']);
    expect(report.quarantined).toEqual([]);
    expect(report.compiledCount).toBe(1);
  });

  it('quarantines a reference that fails its own golden testbench, recording the count', async () => {
    const report = await validateReferenceDesigns(
      corpusOf(['rtllm/arithmetic/radix2_div']),
      new FakeScorer(
        new Map([
          [
            'rtllm/arithmetic/radix2_div',
            {
              kind: 'failed' as const,
              failureCount: 3,
              banners: ['test completed with 3/8 failures'],
            },
          ],
        ]),
      ),
      LIMITS,
    );

    expect(report.usableProblemIds).toEqual([]);
    expect(report.quarantined[0]?.code).toBe('REFERENCE_FAILED_GOLDEN');
    expect(report.quarantined[0]?.detail).toContain('3 failure(s)');
    expect(report.quarantined[0]?.stage).toBe('stage0');
    // It compiled: it produced a banner. That distinction matters for the report.
    expect(report.compiledCount).toBe(1);
  });

  it('quarantines a reference that never built, on the toolchain diagnostics', async () => {
    const report = await validateReferenceDesigns(
      corpusOf(['rtllm/control/ring_counter']),
      new FakeScorer(
        new Map([
          [
            'rtllm/control/ring_counter',
            {
              kind: 'error' as const,
              diagnostics: 'testbench.v:20: internal error\nElaboration failed\n',
            },
          ],
        ]),
      ),
      LIMITS,
    );

    expect(report.quarantined[0]?.code).toBe('REFERENCE_COMPILE_FAILED');
    expect(report.quarantined[0]?.detail).toContain('internal error');
    expect(report.compiledCount).toBe(0);
  });

  it('quarantines a silent run distinctly from a build failure', async () => {
    const report = await validateReferenceDesigns(
      corpusOf(['rtllm/memory/asyn_fifo']),
      new FakeScorer(
        new Map([['rtllm/memory/asyn_fifo', { kind: 'error' as const, diagnostics: '' }]]),
      ),
      LIMITS,
    );

    expect(report.quarantined[0]?.code).toBe('REFERENCE_RUN_ERRORED');
  });

  it('reports every design, in corpus order, whether it passed or not', async () => {
    const ids = ['rtllm/arithmetic/a', 'rtllm/control/b', 'rtllm/memory/c'];
    const report = await validateReferenceDesigns(
      corpusOf(ids),
      new FakeScorer(new Map([['rtllm/control/b', { kind: 'failed' as const, failureCount: 1 }]])),
      LIMITS,
    );

    expect(report.outcomes.map((one) => one.problemId)).toEqual(ids);
    expect(report.outcomes.map((one) => one.passed)).toEqual([true, false, true]);
  });

  it('derives the category of a quarantined design from its problem id', async () => {
    const report = await validateReferenceDesigns(
      corpusOf(['rtllm/miscellaneous/clkgenerator']),
      new FakeScorer(
        new Map([
          ['rtllm/miscellaneous/clkgenerator', { kind: 'failed' as const, failureCount: 20 }],
        ]),
      ),
      LIMITS,
    );

    expect(report.quarantined[0]?.category).toBe('Miscellaneous');
    expect(report.quarantined[0]?.designName).toBe('clkgenerator');
  });
});

describe('scoredRtllmCorpus - excluding the reviewed Stage 0 quarantines', () => {
  it('moves each reviewed exclusion out of problems and into quarantined', async () => {
    const corpus = corpusOf(['rtllm/arithmetic/adder_8bit', ...STAGE0_QUARANTINED_PROBLEM_IDS]);
    const scored = scoredRtllmCorpus(corpus);

    expect(scored.problems.map((problem) => problem.id)).toEqual(['rtllm/arithmetic/adder_8bit']);
    expect(scored.quarantined.map((record) => record.problemId)).toEqual([
      ...STAGE0_QUARANTINED_PROBLEM_IDS,
    ]);
    await Promise.resolve();
  });

  it('carries the recorded reason with every exclusion, so nothing is silently dropped', () => {
    const scored = scoredRtllmCorpus(corpusOf([...STAGE0_QUARANTINED_PROBLEM_IDS]));
    for (const record of scored.quarantined) {
      expect(record.stage).toBe('stage0');
      expect(record.detail.length).toBeGreaterThan(40);
    }
  });

  it('leaves a corpus that contains none of the exclusions untouched', () => {
    const corpus = corpusOf(['rtllm/arithmetic/adder_8bit']);
    const scored = scoredRtllmCorpus(corpus);
    expect(scored.problems).toEqual(corpus.problems);
    expect(scored.quarantined).toEqual([]);
  });

  it('keeps the reviewed exclusion list and the scored count consistent', () => {
    // 50 designs upstream, minus the Stage 0 exclusions, is the usable corpus size.
    expect(STAGE0_QUARANTINE).toHaveLength(STAGE0_QUARANTINED_PROBLEM_IDS.length);
    expect(RTLLM_SCORED_DESIGN_COUNT).toBe(50 - STAGE0_QUARANTINE.length);
  });
});
