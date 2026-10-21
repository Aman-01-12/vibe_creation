// Lint adapter: one Yosys `check -assert` invocation reduced to a closed `LintResult`
// (design "Tool_Runner and EDA adapters", Component C6; Req 5.1 to 5.7, 6.1, 6.2, 9.1, 9.2).
//
// The adapter drives the Tool_Runner sandbox (it does not isolate or run tools itself),
// assembling a `lint` `SandboxJob` and interpreting the run plus its registered report into a
// `LintResult` that is an admission fact only - never a trust tier or a `Verdict` value.

export {
  assembleLintJob,
  interpretLintResult,
  LINT_RESULT_REASONS,
  YosysCheckLintAdapter,
} from './adapter.js';
export type { LintAdapter, LintResult, LintResultKind } from './adapter.js';
