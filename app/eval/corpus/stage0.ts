// Stage 0: validating the INSTRUMENT before trusting anything it measures.
//
// The golden testbenches are our independent judge, but they were written for
// Synopsys VCS, not Icarus. Before a single pass@k number means anything we have to
// establish that each judge actually works on our toolchain, and the only honest way
// to establish that is to run RTLLM's OWN reference design - the human RTL upstream
// says passes - against its OWN golden testbench under real `iverilog` + `vvp` and
// require a pass.
//
// A reference that fails its own testbench is an unusable measuring stick. It tells
// us nothing about a candidate: a candidate failing that design would be
// indistinguishable from the judge being broken. So the design is QUARANTINED, with
// the reason recorded, and excluded from the scored corpus. It is never silently
// dropped, and the assertion is never weakened to make it "pass" - weakening it
// would leave a broken judge in the scored set, which is strictly worse than a
// smaller honest corpus.
//
// The one adaptation applied to the reference is the top-module rename the importer
// already performed (upstream prefixes most reference tops with `verified_` so the
// reference does not occupy the module name a candidate must implement). The golden
// testbench itself stays byte-identical.

import type { ResourceLimits } from '@app/tools';

import type {
  GoldenTestbench,
  QuarantinedDesign,
  QuarantineReasonCode,
  ReferenceDesign,
  RtllmCorpus,
} from './corpus-types.js';
import type { GoldenScore, GoldenTestbenchScorer } from './golden-scorer.js';
import { classifyNonPass, firstDiagnosticLine } from './nonpass-cause.js';
import { asRtllmCategory, type RtllmCategory } from './pinned-source.js';

/** What Stage 0 observed for one design. */
export interface Stage0DesignOutcome {
  readonly problemId: string;
  /** Whether the reference passed its own golden testbench under the real toolchain. */
  readonly passed: boolean;
  /** The judge's verdict on the reference, for reporting. */
  readonly score: GoldenScore;
  /** The quarantine record when the reference did not pass, else `null`. */
  readonly quarantine: QuarantinedDesign | null;
}

/** The whole Stage 0 result: the usable corpus, the exclusions, and the counts. */
export interface Stage0Report {
  /** Every design Stage 0 ran, in corpus order. */
  readonly outcomes: readonly Stage0DesignOutcome[];
  /** Problem ids whose reference passed its own golden testbench. */
  readonly usableProblemIds: readonly string[];
  /** Designs excluded by Stage 0, with recorded reasons. */
  readonly quarantined: readonly QuarantinedDesign[];
  /** References that compiled at all (i.e. produced a banner). */
  readonly compiledCount: number;
}

/** Split a `rtllm/<category>/<design>` id back into its parts for a quarantine record. */
function describeProblemId(problemId: string): {
  readonly category: RtllmCategory;
  readonly designName: string;
} {
  const [, categoryPart = '', designName = ''] = problemId.split('/');
  const capitalized = categoryPart.charAt(0).toUpperCase() + categoryPart.slice(1);
  return { category: asRtllmCategory(capitalized) ?? 'Miscellaneous', designName };
}

/**
 * Classify a non-passing reference run into a quarantine reason.
 *
 * The three cases are distinguished on evidence, not assumption, by the SHARED rule in
 * `./nonpass-cause.ts` - the same one the positive control uses when it drives a reference
 * against our own generated testbench. Only the vocabulary is local: a fenced failure
 * banner is what "reported a failure" means for a golden testbench, and the quarantine
 * codes are what the corpus records.
 */
function quarantineReason(score: GoldenScore): {
  readonly code: QuarantineReasonCode;
  readonly detail: string;
} {
  const cause = classifyNonPass({
    reportedFailure: score.verdict.kind === 'failed',
    diagnostics: score.diagnostics,
  });
  if (cause === 'reported-failure') {
    const count = score.verdict.failureCount;
    const failures = count === null ? 'failures' : `${count} failure(s)`;
    return {
      code: 'REFERENCE_FAILED_GOLDEN',
      detail: `the reference compiles but its own golden testbench reports ${failures}: ${score.verdict.banners.join(' | ')}`,
    };
  }
  if (cause === 'did-not-build') {
    return {
      code: 'REFERENCE_COMPILE_FAILED',
      detail: `the reference plus its golden testbench does not build under iverilog: ${firstDiagnosticLine(score.diagnostics)}`,
    };
  }
  return {
    code: 'REFERENCE_RUN_ERRORED',
    detail: 'the run produced no outcome banner and no diagnostics',
  };
}

/** Build the quarantine record for a design whose reference did not pass. */
function quarantineFor(problemId: string, score: GoldenScore): QuarantinedDesign {
  const { category, designName } = describeProblemId(problemId);
  const reason = quarantineReason(score);
  return {
    problemId,
    designName,
    category,
    stage: 'stage0',
    code: reason.code,
    detail: reason.detail,
  };
}

/** Run one reference against its own golden testbench and classify the outcome. */
async function validateOne(
  reference: ReferenceDesign,
  golden: GoldenTestbench,
  scorer: GoldenTestbenchScorer,
  limits: ResourceLimits,
): Promise<Stage0DesignOutcome> {
  const score = await scorer.score(reference.rtl, golden, limits);
  const passed = score.verdict.kind === 'passed';
  return {
    problemId: reference.problemId,
    passed,
    score,
    quarantine: passed ? null : quarantineFor(reference.problemId, score),
  };
}

/**
 * Drive every imported reference against its own golden testbench (Stage 0).
 *
 * Runs sequentially and in corpus order so the toolchain is never flooded and the
 * report is deterministic. Returns the per-design outcome for EVERY design - a
 * failure is reported, never dropped - plus the usable problem ids that make up the
 * real, honest size of the scored corpus.
 */
export async function validateReferenceDesigns(
  corpus: RtllmCorpus,
  scorer: GoldenTestbenchScorer,
  limits: ResourceLimits,
): Promise<Stage0Report> {
  const outcomes: Stage0DesignOutcome[] = [];
  for (const problem of corpus.problems) {
    const reference = corpus.references.get(problem.id);
    const golden = corpus.golden.get(problem.id);
    if (reference === undefined || golden === undefined) {
      // Unreachable for an importer-produced corpus, which populates both maps for
      // every problem it emits. Skipping silently would hide a real inconsistency, so
      // it is surfaced as an explicit run error rather than ignored.
      throw new Error(`RTLLM corpus is missing Stage 0 material for ${problem.id}`);
    }
    outcomes.push(await validateOne(reference, golden, scorer, limits));
  }
  return {
    outcomes,
    usableProblemIds: outcomes.filter((one) => one.passed).map((one) => one.problemId),
    quarantined: outcomes
      .map((one) => one.quarantine)
      .filter((record): record is QuarantinedDesign => record !== null),
    compiledCount: outcomes.filter((one) => one.score.verdict.banners.length > 0).length,
  };
}
