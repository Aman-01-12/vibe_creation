// The Lint_Adapter: one Yosys `check -assert` invocation reduced to a closed `LintResult`
// (design "Tool_Runner and EDA adapters", Component C6; Req 5.1 to 5.7, 6.1, 6.2, 9.1, 9.2).
//
// Like the Synth adapter, this sits ON TOP of the Tool_Runner sandbox. It assembles a `lint`
// `SandboxJob`, drives it through an injected `ToolRunner`, reads the `lintReport` artifact
// through an injected `ArtifactTextReader`, and interprets both into one `LintResult`. It never
// spawns a process and never reads a file of its own (Req 9.1, 9.2).
//
// `LintResult` IS AN ADMISSION CHECK, NEVER A VERDICT (Req 6.1, 6.2). It carries no trust tier
// and no `Verified` member, and `clean`/`findings`/`could-not-run` are not `Verdict` values: a
// clean lint says the Lint_Engine found nothing, not that the design is correct.

import type {
  ArtifactTextReader,
  RequiredOutput,
  ResourceLimits,
  SandboxJob,
  SandboxResult,
  SourceFile,
  ToolRunner,
} from '../sandbox/index.js';

/** The closed set of `LintResult` shapes (Req 5.1 to 5.5, 6.1). */
export type LintResultKind = 'clean' | 'findings' | 'could-not-run';

/**
 * One Lint_Job's outcome: admission facts only, never a verdict (Req 6.1, 6.2).
 *
 * `findings` carries the reported problem count; the other two members carry nothing but their
 * fixed reason, because there is nothing else safe to carry (Req 5.6).
 */
export type LintResult =
  | { readonly kind: 'clean'; readonly reason: string }
  | { readonly kind: 'findings'; readonly problemCount: number; readonly reason: string }
  | { readonly kind: 'could-not-run'; readonly reason: string };

/**
 * The fixed, sanitized reason for each `LintResultKind` (Req 5.6).
 *
 * One entry per KIND, not per cause: whichever way a Lint_Job could not be run - a sandbox
 * `error`, an unreadable report, a malformed one - the Student-facing reason is the same fixed
 * string, so no tool stdout, stderr, path, or host name can ever reach a reason.
 */
export const LINT_RESULT_REASONS: Readonly<Record<LintResultKind, string>> = {
  clean: 'The lint check found no problems.',
  findings: 'The lint check found one or more problems.',
  'could-not-run': 'The lint check could not be run to completion.',
};

/** The Lint_Adapter port: one Lint_Job, reduced to one `LintResult`. */
export interface LintAdapter {
  lint(rtl: readonly SourceFile[], topModule: string, limits: ResourceLimits): Promise<LintResult>;
}

/** The artifact-map key the worker registers `lint-report.json` under. */
const LINT_REPORT_ARTIFACT_KEY = 'lintReport' as const;

/**
 * The `lint` job's required outputs: the report, and the exit code that marks the run as having
 * happened at all. A Lint_Job's entire output IS the report, so an absent one is `error`, never a
 * partial result (Req 4.4 of the parent sandbox contract).
 */
const LINT_REQUIRED_OUTPUTS: readonly RequiredOutput[] = [LINT_REPORT_ARTIFACT_KEY, 'exitCode'];

/** The fixed `could-not-run` result, returned from every refusal path. */
const COULD_NOT_RUN: LintResult = {
  kind: 'could-not-run',
  reason: LINT_RESULT_REASONS['could-not-run'],
};

/**
 * Assemble the `SandboxJob` for a lint run: the RTL as workspace files, the fixed lint
 * required-output set, the caller's limits, and the `lint` payload. Pure and exported so job
 * assembly is unit-testable in isolation.
 */
export function assembleLintJob(
  rtl: readonly SourceFile[],
  topModule: string,
  limits: ResourceLimits,
): SandboxJob {
  return {
    kind: 'lint',
    workspaceFiles: [...rtl],
    limits,
    requiredOutputs: LINT_REQUIRED_OUTPUTS,
    lint: { topModule },
  };
}

/**
 * The lint report's validated shape: what `_lint_report` in `eda.py` writes, field for field.
 *
 * A discriminated union on `reachedCheck` rather than one interface with `problemCount: number |
 * null`, so a caller that has checked `reachedCheck` has `problemCount` narrowed to `number`
 * without a redundant runtime check.
 */
type LintReportDocument =
  | { readonly reachedCheck: true; readonly problemCount: number }
  | { readonly reachedCheck: false; readonly problemCount: null };

/** The report's only two field names, as a closed set a parsed object must match exactly. */
const LINT_REPORT_KEYS: ReadonlySet<string> = new Set(['reachedCheck', 'problemCount']);

/** Whether `value` is an integer lint can report as a problem count: a non-negative safe integer. */
function isReportableProblemCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse and validate one lint report's text, or `null` where it is not a well-formed document.
 *
 * CLOSED ON PURPOSE (Req 5.5): an object carrying a key outside `{reachedCheck, problemCount}`,
 * a non-boolean `reachedCheck`, a `problemCount` that disagrees with `reachedCheck` (not a
 * non-negative integer when true, not `null` when false), or anything that is not JSON at all,
 * is refused rather than partially trusted - the same discipline `report.ts`'s ajv schema applies
 * to the formal report, done by hand here because this document has only two fields.
 */
function parseLintReportDocument(text: string): LintReportDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not a silent catch: `JSON.parse` signals malformed input only by throwing, and the throw
    // IS the rejection; its message is never surfaced because it quotes the untrusted text.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed);
  if (keys.length !== LINT_REPORT_KEYS.size || !keys.every((key) => LINT_REPORT_KEYS.has(key))) {
    return null;
  }
  const { reachedCheck, problemCount } = parsed as Record<string, unknown>;
  if (typeof reachedCheck !== 'boolean') {
    return null;
  }
  if (reachedCheck) {
    return isReportableProblemCount(problemCount) ? { reachedCheck, problemCount } : null;
  }
  return problemCount === null ? { reachedCheck, problemCount: null } : null;
}

/**
 * Interpret a `SandboxResult` plus its already-resolved report text into a `LintResult`.
 *
 * Pure and exported for unit testing (Req 5.1 to 5.5). Fail-safe, most-severe first:
 *   1. A sandbox `error` verdict - the run did not complete - is `could-not-run`.
 *   2. A `null` report text - unreadable or never registered - is `could-not-run`.
 *   3. Text that is not a well-formed lint document is `could-not-run`.
 *   4. `reachedCheck: false` - the Lint_Engine's `check -assert` never ran to completion - is
 *      `could-not-run`.
 *   5. `reachedCheck: true` with `problemCount: 0` is `clean`.
 *   6. `reachedCheck: true` with `problemCount` at least 1 is `findings`, carrying the count.
 *
 * Every reason comes from `LINT_RESULT_REASONS`, so nothing read off `result` or `reportText`
 * can reach the returned value (Req 5.6).
 */
export function interpretLintResult(result: SandboxResult, reportText: string | null): LintResult {
  if (result.verdict === 'error' || reportText === null) {
    return COULD_NOT_RUN;
  }
  const document = parseLintReportDocument(reportText);
  if (document === null || !document.reachedCheck) {
    return COULD_NOT_RUN;
  }
  return document.problemCount === 0
    ? { kind: 'clean', reason: LINT_RESULT_REASONS.clean }
    : {
        kind: 'findings',
        problemCount: document.problemCount,
        reason: LINT_RESULT_REASONS.findings,
      };
}

/**
 * `LintAdapter` backed by the Tool_Runner sandbox running Yosys's `check -assert`.
 *
 * Both dependencies are injected, mirroring the Formal_Oracle's shape: a `ToolRunner` so a
 * `FakeSandboxRuntime`-backed runner can drive this adapter in tests, and an `ArtifactTextReader`
 * because the sandbox seam carries artifact REFERENCES only, never bytes (see
 * `../sandbox/artifact-retention.ts`).
 */
export class YosysCheckLintAdapter implements LintAdapter {
  readonly #toolRunner: ToolRunner;
  readonly #artifacts: ArtifactTextReader;

  constructor(toolRunner: ToolRunner, artifacts: ArtifactTextReader) {
    this.#toolRunner = toolRunner;
    this.#artifacts = artifacts;
  }

  /**
   * Run one Lint_Job and return its `LintResult`, never a thrown error (Req 5.7).
   *
   * The run and the read sit in ONE `try`: a thrown `SandboxContractError` from a malformed job,
   * a rejected `toolRunner.run`, or a rejected `artifacts.readText` are all the same fact from
   * this method's point of view - we could not get a result - and all become `could-not-run`,
   * which is the fail-safe answer rather than a silent swallow.
   */
  async lint(
    rtl: readonly SourceFile[],
    topModule: string,
    limits: ResourceLimits,
  ): Promise<LintResult> {
    try {
      const result = await this.#toolRunner.run(assembleLintJob(rtl, topModule, limits));
      const artifact = result.artifacts[LINT_REPORT_ARTIFACT_KEY];
      const reportText = artifact === undefined ? null : await this.#artifacts.readText(artifact);
      return interpretLintResult(result, reportText);
    } catch {
      return COULD_NOT_RUN;
    }
  }
}
