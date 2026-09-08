// Unit and property tests for the RTLLM-backed `GoldenJudge` adapter.
//
// The behaviour that matters is the honest `null`: a problem with no golden testbench
// must NOT get an invented verdict, because a fabricated agreement would flatter the
// exact number the judge exists to keep honest.
//
// THE SECOND SUBJECT IS THE CLASSIFICATION ORDER
//   This adapter turns a `GoldenScore` into the recorded golden vocabulary, and one
//   ordering mistake is easy to make and invisible afterwards. A wall-clock kill leaves
//   no exit code, no streams, and no usage, so a timed-out run has no banner AND no
//   diagnostics. A classifier that asked "were there diagnostics?" before "was it killed?"
//   would file our own resource cap as `no-output` - our own infrastructure failing - and
//   the exclusion bucket an operator acts on would point at the wrong defect. That single
//   case is pinned below.
//
//   The `did-not-build` / `no-output` split itself is NOT re-derived here. It belongs to
//   `classifyNonPass`, which Stage 0 and the positive control already share, so the test
//   for it is DIFFERENTIAL: over generated diagnostics text, including whitespace-only,
//   this adapter must agree with that classifier rather than hold a second opinion.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ResourceLimits, SourceFile } from '@app/tools';

import type { GoldenTestbench } from './corpus-types.js';
import type { GoldenScore, GoldenTestbenchScorer } from './golden-scorer.js';
import { CANDIDATE_WORKSPACE_FILENAME } from './golden-scorer.js';
import { classifyNonPass } from './nonpass-cause.js';
import { classifyGoldenKind, RtllmGoldenJudge } from './rtllm-golden-judge.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const PROBLEM_ID = 'rtllm/arithmetic/adder_8bit';

const GOLDEN: GoldenTestbench = {
  problemId: PROBLEM_ID,
  moduleName: 'adder_8bit',
  testbench: { path: 'testbench.v', contents: 'module tb; endmodule\n' },
  dataFiles: [],
  overriddenParameters: [],
};

/** A scorer recording what it was asked to score. */
class RecordingScorer implements GoldenTestbenchScorer {
  readonly calls: { rtl: SourceFile; golden: GoldenTestbench }[] = [];
  readonly #score: GoldenScore;

  constructor(score: GoldenScore) {
    this.#score = score;
  }

  score(rtl: SourceFile, golden: GoldenTestbench): Promise<GoldenScore> {
    this.calls.push({ rtl, golden });
    return Promise.resolve(this.#score);
  }
}

/** A passing score for the fixture problem. */
const PASSING: GoldenScore = {
  problemId: PROBLEM_ID,
  verdict: { kind: 'passed', failureCount: 0, banners: ['your design passed'] },
  timedOut: false,
  diskLimitExceeded: false,
  exitCode: 0,
  diagnostics: '',
};

describe('RtllmGoldenJudge.judge', () => {
  it("scores the candidate against the problem's golden testbench", async () => {
    const scorer = new RecordingScorer(PASSING);
    const judge = new RtllmGoldenJudge(scorer, new Map([[PROBLEM_ID, GOLDEN]]));

    const verdict = await judge.judge({
      problemId: PROBLEM_ID,
      rtl: 'module adder_8bit(); endmodule\n',
      limits: LIMITS,
    });

    expect(verdict).toEqual({ kind: 'passed', failureCount: 0 });
    expect(scorer.calls[0]?.golden).toBe(GOLDEN);
    expect(scorer.calls[0]?.rtl.path).toBe(CANDIDATE_WORKSPACE_FILENAME);
  });

  it('reports null - never a verdict - for a problem with no golden testbench', async () => {
    const scorer = new RecordingScorer(PASSING);
    const judge = new RtllmGoldenJudge(scorer, new Map());

    const verdict = await judge.judge({
      problemId: 'verilogeval/adder8',
      rtl: 'module adder8(); endmodule\n',
      limits: LIMITS,
    });

    expect(verdict).toBeNull();
    expect(scorer.calls).toHaveLength(0);
  });

  it('reduces a failing score to the kind and count a report carries', async () => {
    const scorer = new RecordingScorer({
      problemId: PROBLEM_ID,
      verdict: { kind: 'failed', failureCount: 12, banners: ['test completed with 12 failures'] },
      timedOut: false,
      diskLimitExceeded: false,
      exitCode: 0,
      diagnostics: 'noisy tool output that must not reach the report',
    });
    const judge = new RtllmGoldenJudge(scorer, new Map([[PROBLEM_ID, GOLDEN]]));

    const verdict = await judge.judge({
      problemId: PROBLEM_ID,
      rtl: 'module adder_8bit(); endmodule\n',
      limits: LIMITS,
    });

    expect(verdict).toEqual({ kind: 'failed', failureCount: 12 });
  });
});

/** A score with no banner at all - the shape every no-verdict cause arrives in. */
function noBannerScore(overrides: Partial<GoldenScore> = {}): GoldenScore {
  return {
    problemId: PROBLEM_ID,
    verdict: { kind: 'error', failureCount: null, banners: [] },
    timedOut: false,
    diskLimitExceeded: false,
    exitCode: null,
    diagnostics: '',
    ...overrides,
  };
}

describe('classifyGoldenKind - the ordering trap', () => {
  it('classifies a resource-bound kill that printed nothing as timed-out, NOT no-output', () => {
    // THE TRAP. A wall-clock kill reports no exit code, no streams, and no usage, so this
    // score is byte-identical to one where our own infrastructure produced nothing - except
    // for the flag. Reading it as `no-output` would blame our harness for our own cap.
    const killed = noBannerScore({ timedOut: true, diagnostics: '' });

    expect(classifyGoldenKind(killed)).toBe('timed-out');
  });

  it('classifies a disk-cap kill as timed-out for the same reason', () => {
    // A mutant that makes a waveform-dumping testbench spin trips the disk cap before the
    // wall cap. Same cause - a bound WE imposed stopped the run - so the same kind.
    expect(classifyGoldenKind(noBannerScore({ diskLimitExceeded: true }))).toBe('timed-out');
  });

  it('lets a resource-bound kill win over a banner the truncated run managed to print', () => {
    // Documented precedence, and fail-safe in the one direction that matters: `timed-out`
    // leaves the sample OUT of the golden denominator, so a run we cut short can never be
    // read as a complete judgement of the candidate's behaviour.
    const killedAfterFailing = noBannerScore({
      timedOut: true,
      verdict: { kind: 'failed', failureCount: 3, banners: ['failed'] },
    });

    expect(classifyGoldenKind(killedAfterFailing)).toBe('timed-out');
  });
});

describe('classifyGoldenKind - the verdict-bearing kinds', () => {
  it('carries a pass banner through as passed', () => {
    expect(classifyGoldenKind(PASSING)).toBe('passed');
  });

  it('carries a failure banner through as failed, diagnostics notwithstanding', () => {
    const failed = noBannerScore({
      verdict: { kind: 'failed', failureCount: 7, banners: ['test completed with 7 failures'] },
      diagnostics: 'a warning the compiler emitted on the way past',
    });

    expect(classifyGoldenKind(failed)).toBe('failed');
  });
});

describe('classifyGoldenKind - the no-verdict split is delegated, not duplicated', () => {
  it('reads a no-banner run with build diagnostics as did-not-build', () => {
    const unbuildable = noBannerScore({
      diagnostics: 'candidate.v:3: syntax error\ncandidate.v:3: error: malformed statement\n',
    });

    expect(classifyGoldenKind(unbuildable)).toBe('did-not-build');
  });

  it('reads a no-banner run with nothing at all as no-output', () => {
    expect(classifyGoldenKind(noBannerScore({ diagnostics: '' }))).toBe('no-output');
  });

  it('agrees with classifyNonPass on every diagnostics text, whitespace-only included', () => {
    // A DIFFERENTIAL property, not an independent rule: the whitespace-only case is exactly
    // where a hand-rolled `length > 0` check diverges from the shared classifier, and a
    // second owner of "was this a build failure" is the thing this test exists to prevent.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          // Whitespace-only text, drawn deliberately: `''` alone would never reach the
          // branch where trimming decides the answer.
          fc.stringMatching(/^[ \t\r\n]{1,12}$/),
          fc.constant(''),
        ),
        (diagnostics) => {
          const kind = classifyGoldenKind(noBannerScore({ diagnostics }));
          const cause = classifyNonPass({ reportedFailure: false, diagnostics });

          expect(kind).toBe(cause === 'did-not-build' ? 'did-not-build' : 'no-output');
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('RtllmGoldenJudge.judge - the recorded kind travels with the verdict', () => {
  it('records the classified cause rather than an opaque error', async () => {
    const scorer = new RecordingScorer(
      noBannerScore({ diagnostics: 'candidate.v:1: error: unknown module type\n' }),
    );
    const judge = new RtllmGoldenJudge(scorer, new Map([[PROBLEM_ID, GOLDEN]]));

    const verdict = await judge.judge({
      problemId: PROBLEM_ID,
      rtl: 'module adder_8bit(); endmodule\n',
      limits: LIMITS,
    });

    expect(verdict).toEqual({ kind: 'did-not-build', failureCount: null });
  });
});
