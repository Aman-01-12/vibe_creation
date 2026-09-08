---
type: decision
title: The mutation kill-rate denominator is every VALID mutant, because a golden pass is not proof of equivalence
status: candidate
provenance: founder-directed correctness fix; implemented in app/eval/mutation-control.ts + app/eval/corpus/mutation-calibration.ts, measured on the real Icarus toolchain
tags: [eval, negative-control, mutation-testing, equivalent-mutant, denominator, instrument-validity, honesty, schema-version]
timestamp: 2026-09-14
---

# SUPERSEDED IN PART - read this first

The DENOMINATOR decision below still stands: the kill rate is computed over every VALID mutant.

The THRESHOLD part of it does not. `DEFAULT_MIN_KILL_RATE = 0.95` was the validity gate when this note was written; it is not any more, and the constant no longer exists.
Instrument validity is now ZERO COVERAGE-GAP SURVIVORS, and the kill rate is a reported quality signal that gates nothing.
The rate bar was measured to mark a demonstrably GOOD testbench invalid at 4/6 on the very table below, which is a false negative in the same family as the exclusion bug this note fixed.

See [[decision-instrument-validity-gate-is-zero-coverage-gaps-not-a-kill-rate]].
Everything below is accurate as the record of what was decided and measured at the time; treat its 0.95 claims as history.

# Decision

The negative control used to score our generated testbench ONLY over the mutants RTLLM's golden testbench kills (the "detectable" set).
A mutant the golden testbench PASSED was excluded from the denominator as likely-equivalent or spec-irrelevant.

That is unsound, and unsound in the one direction that matters: it excused our testbench for exactly the bugs the golden judge is blind to - which is the population a missed bug comes from.

The denominator is now every VALID mutant (every mutant that COMPILES).
Only a mutant that produced no verdict at all leaves it, and that exclusion is still counted.

The golden verdict did not go away. Its role narrowed: it now only CLASSIFIES the mutants OUR testbench failed to kill, into two reported buckets.

## The two survivor buckets

- `coverageGapSurvivors` - the golden testbench KILLED it, ours did not. A definite, actionable coverage gap: the independent judge has demonstrated the bug is catchable. Surfaced most prominently (`COVERAGE GAPS` in the sweep summary).
- `candidateEquivalentSurvivors` - the golden testbench did not kill it either. It MAY be equivalent to the original, so it is flagged for review (`review-equiv`) - and it STILL counts against the kill rate, because equivalence is not decidable by simulation.

A simulation that fails to distinguish a mutant from the original has established one thing: THAT STIMULUS did not distinguish them. That is a fact about the stimulus, not about the designs. So nothing may be auto-excluded.

## Timeouts are kills, counted apart

Any non-pass is a kill (unchanged). What changed is that `SimulationVerdict.verdict === 'error'` - a timeout, a crash, or an empty capture - is now counted as `noVerdictKills`, a visible SUBSET of `killedCount`.
A mutant that hangs the run produced an observable behavioural difference, which is [Stryker's own rule](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/) for an infinite-loop mutant.
But it is weaker evidence than a reported failure, so a timeout-heavy kill rate must stay visible instead of reading as coverage.

## `DEFAULT_MIN_KILL_RATE` 1 -> 0.95, and it is BORROWED

0.95 is GateTruth's published bar (it certifies a testbench killing at least 95% of injected mutants). It is not a floor we have measured on this corpus, and the code says so.

- Not 1, because the denominator now necessarily contains genuinely equivalent mutants, killable by NO testbench. Demanding 1 would be demanding the undecidable, and an unreachable gate gets turned off.
- Not lower, because every point below the bar declares a population of independently-catchable bugs acceptable to miss.
- The candidate-equivalent rate, once a campaign has run, is the measurement that says what floor is actually reachable.

Watch out at small mutant budgets: `ceil(0.95 * 6) === 6`, so a 6-mutant probe demands a perfect score. 0.95 only buys slack from ~20 mutants up.

# The measurement that forced this (real toolchain, `rtllm/arithmetic/multi_pipe_8bit`)

Six mutants, all compile. Golden testbench kills 2 and is BLIND to 4.

| mutant | golden | our discriminating tb | our smoke-run tb |
|---|---|---|---|
| `ARITH_PLUS_TO_MINUS@69:29` | failed | fail (kill) | pass |
| `ARITH_PLUS_TO_MINUS@70:29` | failed | fail (kill) | pass |
| `CONST_ZERO_TO_ONE@27:33` | **passed** | **fail (kill)** | pass |
| `INDEX_OFF_BY_ONE@17:16` | **passed** | **fail (kill)** | pass |
| `RESET_BRANCH_DISABLED@26:10` | passed | pass | pass |
| `RESET_BRANCH_DISABLED@39:12` | passed | pass | pass |

Two facts fall straight out of the table:

1. Our discriminating testbench KILLS TWO MUTANTS THE GOLDEN JUDGE MISSES. Under the old denominator it could not be given credit for them - and, far worse, a testbench that missed them could not be held responsible.
2. `RESET_BRANCH_DISABLED@39:12` is very likely a TRUE equivalent mutant. Disabling the reset on `mul_a_reg`/`mul_b_reg` is unobservable at the ports because the reference's own line 41 already fails to reset `mul_b_reg` (`mul_a_reg <= 'd0;` is written twice), so `temp[]` is X either way and the un-mutated `sum[]` reset holds the output at zero regardless.

## What that did to the integration suite (worth knowing before you touch it)

`app/test/eval-negative-control.integration.test.ts` used to claim "the DISCRIMINATING testbench is `valid`". Over the valid set it is NOT: 4/6 = 0.667, and at a 6-mutant budget the bar is 6/6, which fact (2) above makes unreachable.

So the non-vacuity claim was restated to what the measurement supports, and it is a stronger claim than the old one:
- discriminating tb: ZERO coverage-gap survivors, 2 candidate-equivalent survivors, kills strictly MORE than the golden judge does;
- smoke-run tb: 0/6 killed, 2 coverage-gap survivors + 4 candidate-equivalent, still `invalid` / `TESTBENCH_SURVIVED_MUTANTS`.

Do not "fix" that suite by lowering its `minKillRate` or by dropping `RESET_BRANCH_DISABLED` from its operator set. Both would be tuning the measurement instead of the instrument.

# Context / options considered

- Keep excluding golden-survived mutants. Rejected: it is the defect. [GateTruth (arXiv 2608.12635)](https://arxiv.org/abs/2608.12635) names an unsound equivalent-mutant exclusion mechanism as one of three causes of its own incorrect published results - mutants it excluded as unobservable turned out not to be equivalent. Content was rephrased for compliance with licensing restrictions.
- Auto-exclude a mutant that BOTH testbenches pass. Rejected for the same reason one step later: two blind stimuli are not a proof.
- Report the two survivor kinds as one number. Rejected: a demonstrated coverage gap and a maybe-equivalent mutant are different work items, and pooling them reports the second as the first.
- Keep the threshold at 1 over the new denominator. Rejected: unreachable in the presence of true equivalents, and an unreachable gate gets turned off rather than met.
- Treat a timeout as a non-kill. Rejected: the mutant demonstrably changed observable behaviour, and the loop cannot mint `Verified` from an errored run. Counted apart instead.
- Silently reuse an existing calibration cache. Rejected: a cache written when a golden pass meant "excluded" would restore the exclusion. The schema version is now part of the rendered KEY (`v2/<commit>/<configHash>`), so one constant invalidates every cached problem.

# Schema bumps (all three are refusals, not migrations)

- `MUTATION_CALIBRATION_CACHE_VERSION` 1 -> 2, and it now LEADS the rendered cache key.
- `RESULTS_SCHEMA_VERSION` 3 -> 4: `instrumentValidity: valid` means something different (>= 95% of valid mutants, not 100% of golden-detectable), and the `mutation` block changed shape.
- `ARTIFACT_DOCUMENT_SCHEMA_VERSION` 3 -> 4, same reasoning.
- `SMOKE_RUN_CONFIG_HASH` moved `4fb568609e8da0d7` -> `65dbf4188d97c978`, deliberately: `negativeControl.minKillRate` is IN the config identity because it can move a measured number, so two thresholds are two experiments and their samples must not pool.

# Revisit trigger

- The first campaign with this armed. If `candidateEquivalentOperators` is dominated by one or two operators, either those operators generate mostly-equivalent mutants (fix the operator) or 0.95 is the wrong floor for this corpus (set it from the data). Either way the number stops being borrowed.
- A timeout-heavy `noVerdictKills` share. That is a sandbox/wall-clock finding, not a coverage finding, and the kill rate must not be cited until it is explained.
- Any temptation to re-add an exclusion. Read the table above first.

# Links

- app/eval/mutation-control.ts (`MutantCalibration`, `MutantKillKind`, `MutationProbeReport`, `DEFAULT_MIN_KILL_RATE`, `recordedMutationCounts`)
- app/eval/corpus/mutation-calibration.ts (`CalibratedMutant`, `renderCalibrationCacheKey`, `goldenKilledCountOf`)
- app/eval/corpus/rtllm-negative-control.ts (the per-mutant fold into kills and the two buckets)
- app/eval/instrument-control.ts (`no-valid-mutants`, `TESTBENCH_SURVIVED_MUTANTS`)
- app/eval/sweep/summary.ts (`COVERAGE GAPS`, `review-equiv`, `kills w/o verdict`)
- app/test/eval-negative-control.integration.test.ts
- [[decision-independent-golden-judge-and-vcs-icarus-gap]]
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]]
- [[gotcha-simulation-verdict-collapses-error-causes]]
- product-ece/ECE-VERIFICATION-METHODOLOGY.md
