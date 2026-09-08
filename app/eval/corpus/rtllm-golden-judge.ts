// The RTLLM-backed `GoldenJudge`: the harness's second, independent verdict.
//
// This is the thin adapter between the harness's benchmark-agnostic
// `GoldenJudge` port and the RTLLM scorer. Its only decisions are:
//   - look up the golden testbench for a problem id, reporting `null` (not a
//     verdict) when the corpus has none, so an unjudged problem is visible instead
//     of silently counted as agreement;
//   - materialize the candidate RTL under a fixed workspace filename;
//   - reduce the scorer's full result to the two fields a persisted report carries,
//     CLASSIFYING the no-verdict cause on the way past.
//
// THE CLASSIFICATION HAPPENS HERE BECAUSE THIS IS WHERE THE EVIDENCE STILL EXISTS
//   `GoldenScore` carries `timedOut`, `diskLimitExceeded`, and sanitized diagnostics
//   beside the banner verdict, and this adapter used to throw all but the banner away.
//   Everything downstream sees only the recorded kind, so a run that reported no
//   verdict had to be reported as an opaque `error` - and `error` is the sum of three
//   causes that point at three different defects: a candidate that did not elaborate,
//   a judge run that produced nothing, and a resource bound we imposed doing its job.
//   Recovering that split later is impossible, so it is decided at the boundary.
//
// ORDER MATTERS, AND THE TRAP IS SPECIFIC
//   A wall-clock kill leaves NOTHING behind to infer from: no exit code, no streams, no
//   usage. So a timed-out run also has no banner and no diagnostics, and a classifier that
//   asked "were there diagnostics?" first would call it `no-output` - reporting our own
//   resource cap as our own infrastructure failing. The resource bounds are therefore
//   checked FIRST, and the ordering is pinned by a unit test.

import type {
  GoldenJudge,
  GoldenJudgeRequest,
  RecordedGoldenKind,
  RecordedGoldenVerdict,
} from '../golden-judge.js';
import type { GoldenTestbench } from './corpus-types.js';
import {
  CANDIDATE_WORKSPACE_FILENAME,
  type GoldenScore,
  type GoldenTestbenchScorer,
} from './golden-scorer.js';
import { classifyNonPass, type NonPassCause } from './nonpass-cause.js';

/**
 * How a non-pass cause lands as a recorded golden kind.
 *
 * A TOTAL `Record` rather than a `switch`, so adding a `NonPassCause` is a compile error
 * here instead of a silently-defaulted golden kind. `reported-failure` maps to `failed` for
 * completeness; `classifyGoldenKind` has already handled a reported failure by the time it
 * delegates, so this entry is never reached in practice and must still be right if it were.
 */
const NON_PASS_GOLDEN_KINDS: Readonly<Record<NonPassCause, RecordedGoldenKind>> = Object.freeze({
  'reported-failure': 'failed',
  'did-not-build': 'did-not-build',
  'produced-nothing': 'no-output',
});

/**
 * Classify one golden run into the recorded vocabulary (pure, total).
 *
 * The order is the whole content of this function:
 *   1. a resource bound WE imposed killed the run -> `timed-out`, before anything is
 *      inferred from the absence of output, because a kill leaves no output to read;
 *   2. the judge reported wrong results -> `failed`;
 *   3. the judge printed its pass banner -> `passed`;
 *   4. otherwise the run reported no verdict, and WHY is decided by `classifyNonPass` -
 *      the classifier Stage 0 and the positive control already share - so "was this a
 *      build failure" keeps exactly one owner across all three consumers.
 *
 * Exported so the ordering is testable without a toolchain or a scorer.
 */
export function classifyGoldenKind(score: GoldenScore): RecordedGoldenKind {
  if (score.timedOut || score.diskLimitExceeded) {
    return 'timed-out';
  }
  if (score.verdict.kind === 'failed') {
    return 'failed';
  }
  if (score.verdict.kind === 'passed') {
    return 'passed';
  }
  return NON_PASS_GOLDEN_KINDS[
    classifyNonPass({ reportedFailure: false, diagnostics: score.diagnostics })
  ];
}

/** A `GoldenJudge` backed by RTLLM's unmodified golden testbenches. */
export class RtllmGoldenJudge implements GoldenJudge {
  readonly #scorer: GoldenTestbenchScorer;
  readonly #golden: ReadonlyMap<string, GoldenTestbench>;

  /**
   * @param scorer Compiles and runs the candidate against the golden testbench.
   * @param golden The corpus's golden testbenches, keyed by problem id.
   */
  constructor(scorer: GoldenTestbenchScorer, golden: ReadonlyMap<string, GoldenTestbench>) {
    this.#scorer = scorer;
    this.#golden = golden;
  }

  async judge(request: GoldenJudgeRequest): Promise<RecordedGoldenVerdict | null> {
    const golden = this.#golden.get(request.problemId);
    if (golden === undefined) {
      return null;
    }
    const score = await this.#scorer.score(
      { path: CANDIDATE_WORKSPACE_FILENAME, contents: request.rtl },
      golden,
      request.limits,
    );
    return { kind: classifyGoldenKind(score), failureCount: score.verdict.failureCount };
  }
}
