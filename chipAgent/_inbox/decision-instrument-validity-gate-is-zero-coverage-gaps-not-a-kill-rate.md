---
type: decision
title: The negative control gates on ZERO coverage-gap survivors, because a kill-rate bar failed a measurably good testbench
status: candidate
provenance: founder-directed correctness fix; implemented in app/eval/mutation-control.ts + app/eval/instrument-control.ts, motivated by the real-toolchain measurement recorded in [[decision-mutant-denominator-is-valid-mutants-not-golden-detectable]]
tags:
  [
    eval,
    negative-control,
    mutation-testing,
    equivalent-mutant,
    instrument-validity,
    gate,
    vacuity,
    honesty,
    schema-version,
  ]
timestamp: 2026-09-15
---

# Decision

Instrument validity used to require a KILL RATE of at least `DEFAULT_MIN_KILL_RATE` (0.95) over every valid mutant.
It now requires ZERO COVERAGE-GAP SURVIVORS: our testbench must kill every valid mutant RTLLM's INDEPENDENT golden testbench killed.

The gate rule has one owner, `judgeCoverageGaps` in `app/eval/mutation-control.ts`, and it returns a closed four-member union rather than a boolean, because two of its outcomes are not verdicts at all.

The kill rate did NOT go away. It is still computed, still persisted in the per-sample `mutation` block, and still printed in the sweep summary - as a QUALITY SIGNAL, explicitly labelled `does NOT gate` in the rendered output, beside the coverage-gap line labelled `THE GATE`.

## Why the rate bar was unsound

Same family as the exclusion bug the previous note fixed, pointed the other way.

The rate's denominator is every mutant that COMPILES, which is the right denominator for a signal and the wrong one for a threshold: it necessarily contains mutants that are genuinely equivalent to the original and therefore killable by NO testbench.
A bar over that set holds an instrument to killing mutants that may be unkillable in principle.

The measurement, on `rtllm/arithmetic/multi_pipe_8bit`, 6 mutants, all compiling:

| mutant                        | golden judge | our GOOD (discriminating) tb | our false-PASS tb |
| ----------------------------- | ------------ | ---------------------------- | ----------------- |
| `ARITH_PLUS_TO_MINUS@69:29`   | kills        | kills                        | passes            |
| `ARITH_PLUS_TO_MINUS@70:29`   | kills        | kills                        | passes            |
| `CONST_ZERO_TO_ONE@27:33`     | blind        | kills                        | passes            |
| `INDEX_OFF_BY_ONE@17:16`      | blind        | kills                        | passes            |
| `RESET_BRANCH_DISABLED@26:10` | blind        | passes                       | passes            |
| `RESET_BRANCH_DISABLED@39:12` | blind        | passes                       | passes            |

`RESET_BRANCH_DISABLED@39:12` is very likely a TRUE equivalent: disabling the reset on `mul_a_reg`/`mul_b_reg` is unobservable at the ports because the reference's own line 41 already fails to reset `mul_b_reg` (`mul_a_reg <= 'd0;` is written twice), so `temp[]` is X either way and the un-mutated `sum[]` reset holds the output at zero regardless.

So the good testbench scores 4/6 = 0.667 and the 0.95 bar marked it INVALID.
That is a FALSE NEGATIVE on an instrument that kills strictly MORE than the independent judge does.
And `ceil(0.95 * 24) = 23` at the default 24-mutant budget permits exactly ONE survivor, while the measured equivalent rate here is 1-2 in 6.

The coverage-gap gate cannot make that mistake, and the reason is structural rather than a tuned bound: a genuine equivalent can never ENTER the requirement, because the golden judge did not kill it either.
Every mutant in the gated set is proven catchable at the ports by a third party, so failing to kill one is unambiguously our defect.

## The two vacuity guards, and why the order is the correctness argument

`judgeCoverageGaps` checks in this order, and each guard exists because the later checks pass vacuously without it:

1. `no-valid-mutants` - nothing compiled, so there is no coverage gap by construction.
2. `no-golden-killed-mutants` - the judge killed nothing, so "kill everything the judge kills" is an EMPTY requirement that a testbench killing nothing at all would satisfy. This is the same vacuity trap as the old golden-detectable denominator, one level in. Measured precedent that it is reachable: `rtllm/memory/right_shifter`'s golden testbench drives 8+ shifts and checks only the final value, so it is structurally blind to defect classes RTLLM's own spec requires.
3. `closed` / `open` - only now does an empty coverage-gap list mean something.

Both degenerate cases map to their own `InstrumentUncheckedReason` (`no-valid-mutants`, `no-golden-killed-mutants`), never to `valid`.
`unchecked` can only move a sample OUT of the pass@k denominator, which is the fail-safe direction.

The mapping from `CoverageGapVerdict` to `RecordedInstrumentVerdict` is a total `Record` (`COVERAGE_GAP_VERDICTS`), so a fifth outcome added later is a compile error rather than a silently-defaulted `valid`.
A test enumerates all four and asserts exactly one reaches `valid`.

## `minKillRate` was REMOVED, not demoted

The founder's instruction allowed keeping it as a reporting-only threshold.
It was removed instead, from `SweepNegativeControlConfig`, from `CombinedControls`, from `RtllmInstrumentControlDeps`, and from the config identity - along with `DEFAULT_MIN_KILL_RATE`, `requiredKills`, and `killRateMeetsThreshold`, which had no remaining caller.

Reasoning: a reporting-only threshold has no consumer. The raw kill rate is already printed, so a bar on it adds no information - while a config field named `minKillRate` is a field the next reader will assume gates something, which is precisely the confusion this change exists to remove. Dead configuration surface that reads as a gate is worse than no surface.

`negativeControl.minKillRate` is now REJECTED by `parseSweepConfig` as an unrecognized key, deliberately: a config still carrying it was written by someone who believes they are setting a bar that no longer exists, and failing loudly before the first paid model call is the right outcome.

`TESTBENCH_SURVIVED_MUTANTS` was NOT renamed. It still reads true - the testbench survived mutants - and the churn (results-log closed set, summary field `survivedMutantsSamples`, every doc and test) would buy no clarity. Its doc comment now states the narrowed population.

# Schema bumps

- `RESULTS_SCHEMA_VERSION` 4 -> 5, and `ARTIFACT_DOCUMENT_SCHEMA_VERSION` 4 -> 5. `instrumentValidity: valid` changed meaning again: a v4 `valid` is a rate claim over a set containing unkillable mutants, a v5 `valid` is "no independently-proven-catchable bug was missed". Neither is a relaxation of the other, so pooling them would report a false negative and a false positive under the same word. Refusal, not migration, as at every previous bump; `STALE_SCHEMA_ADVICE` states the actual change and is now pinned by a test.
- `SMOKE_RUN_CONFIG_HASH` moved `65dbf4188d97c978` -> `f9945ed9de495525`, because removing `minKillRate` changes the canonical config JSON. Nothing was orphaned: the results schema bump had already refused every pre-existing smoke record.
- `MUTATION_CALIBRATION_CACHE_VERSION` stays at 2, deliberately. Calibration semantics did NOT change: it still generates mutants, compile-checks them, and records the golden testbench's per-mutant verdict. A cache written under v2 is still exactly right - what changed is only how the consumer READS `goldenKilled`. Bumping it would have thrown away valid, expensive calibration work for no correctness reason.

# What this did to the integration suite

`app/test/eval-negative-control.integration.test.ts` could not previously claim "the discriminating testbench is `valid`" - at 4/6 it was not - so its non-vacuity claim was the weaker bucket-split-plus-strict-improvement pair.
It can now make the strong, simple claim the fixture data always supported:

- discriminating tb: `valid`, ZERO coverage-gap survivors, kill rate measurably BELOW the retired 0.95 bar (pinned as an assertion, because that gap is the whole change);
- smoke-run tb: `invalid` / `TESTBENCH_SURVIVED_MUTANTS`, with its 2 coverage-gap survivors named (both `ARITH_PLUS_TO_MINUS`, the two `temp[] + temp[]` sign flips).

Do not "fix" that suite by dropping `RESET_BRANCH_DISABLED` from its operator set. Those two survivors are the evidence.

# Context / options considered

- Keep the 0.95 kill-rate bar. Rejected: it is the defect, measured above.
- Lower the bar instead of retiring it. Rejected: it would be tuning a number to make one problem pass, and it does not fix the shape - ANY rate over a set containing unkillable mutants has a false-negative floor set by the corpus's equivalent rate, not by our testbench's quality.
- Gate on coverage gaps AND keep a loose rate floor as a second gate. Rejected: the floor would be the binding constraint again the moment a problem's equivalent rate rose, so it would reintroduce the defect with a smaller blast radius rather than remove it.
- Keep `minKillRate` as a reporting-only threshold. Rejected: no consumer, and a config field that looks like a gate but is not is a trap. See above.
- Let `candidateEquivalentSurvivors` keep counting against validity. Rejected: that IS the rate bar's error in another spelling - it charges us for mutants nobody has shown are killable. They are still reported (`review-equiv`) and still count against the RATE.
- Treat `goldenKilledCount === 0` as `valid` because there are no gaps. Rejected: vacuous. It is the trap the whole seam exists to close, and it now has its own `unchecked` reason.
- Bump the calibration cache version too. Rejected with reasons stated above; calibration semantics are unchanged.

# Revisit trigger

- A campaign where `coverageGapOperators` is empty across the board AND `goldenSurvivedMutants` is large. That combination means the gate is nearly vacuous corpus-wide: we would be passing on the strength of the judge's blindness, and the answer is a better independent judge (or our own reviewed golden testbenches), not a looser gate.
- Any `no-golden-killed-mutants` share worth naming. Each one is a problem the negative control cannot speak for at all, so it silently shrinks the validated denominator; if it is common, the mutation operator set is a poor match for that corpus slice.
- Any temptation to re-add a rate threshold to the VALIDITY decision. Read the `multi_pipe_8bit` table above first.

# Links

- app/eval/mutation-control.ts (`judgeCoverageGaps`, `CoverageGapVerdict`, `killRateOf`)
- app/eval/instrument-control.ts (`COVERAGE_GAP_VERDICTS`, `combineInstrumentControls`, `no-golden-killed-mutants`)
- app/eval/corpus/rtllm-instrument-control.ts (the two-phase check, now threshold-free)
- app/eval/sweep/config.ts + config-parse.ts (`minKillRate` retired and rejected)
- app/eval/sweep/results-log.ts (`RESULTS_SCHEMA_VERSION` 5, `STALE_SCHEMA_ADVICE`)
- app/eval/sweep/summary.ts (`quality SIGNAL, does NOT gate` / `THE GATE`)
- app/test/eval-negative-control.integration.test.ts
- [[decision-mutant-denominator-is-valid-mutants-not-golden-detectable]]
- [[decision-independent-golden-judge-and-vcs-icarus-gap]]
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]]
- product-ece/ECE-VERIFICATION-METHODOLOGY.md
