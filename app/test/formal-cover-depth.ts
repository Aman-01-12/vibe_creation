// formal-property-oracle, task 20.4: the one derivation every cover double shares.
//
// WHY A CAP AND NOT A FREE DRAW
//   `yosys-smtbmc -c` reaches a cover only at a step strictly BELOW the depth it searched to, and
//   `interpretFormalReport` refuses a Cover_Check that names anything else as
//   `could-not-verify` / `toolchain-unavailable` (Req 11.19). A test double that draws a reached step
//   independently of the depth the SAME case submits therefore fabricates a report the real tool
//   cannot write, and that report is now a different claim from the one the double was written for
//   (`chipAgent/_inbox/gotcha-the-req-11-19-cover-step-guard-breaks-three-free-generator-cover-doubles.md`).
//
//   So a double derives the step from the depth: a drawn step at or past the depth is capped at the
//   LAST step the tool could have reached, `depth - 1`. Capped rather than dropped, so a reached
//   cover stays a reached cover and the population a property draws from keeps its shape - an
//   unreached cover is a different fact (`antecedent-unreached`), and turning reached ones into it
//   would starve every property whose claim needs the cover satisfied.
//
//   The impossible step is NOT lost to the suite: it is exactly what the Req 11.19 cases in
//   `formal-interpreter-single-cases.test.ts` and Property 25's cover-step clause in
//   `formal-build-failure-attribution.property.test.ts` generate on purpose.

import type { FormalReport } from '@app/tools';

/**
 * The report with its Cover_Check's reached step capped at `depth - 1`, or the report itself where
 * no step is named or the step is already reachable.
 *
 * `depth` is a Proof_Depth, so a positive integer: there is no reachable step at depth 0 to cap to.
 */
export function withCoverStepBelowDepth(report: FormalReport, depth: number): FormalReport {
  const step = report.checks.cover.reachedStep;
  if (step === undefined || step < depth) {
    return report;
  }
  return {
    ...report,
    checks: { ...report.checks, cover: { ...report.checks.cover, reachedStep: depth - 1 } },
  };
}
