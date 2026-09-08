---
type: gotcha
title: Probability generators that derive a child value by multiplication break on sub-normal doubles
status: candidate
provenance: hdl-creation-loop task 19.2 (app/test/eval-gate-ratchet.property.test.ts)
tags: [fast-check, property-testing, floating-point, generators, test-correctness]
timestamp: 2025-05-27T00:00:00Z
---

# What happened

The Property 28 eval-gate test generates a valid armed gate by drawing a `baseline` in `(0, 1]` and deriving `floor = baseline * floorFraction` (fraction in `[0, 1)`), and generates a reviewed lowering by deriving `newBaseline = current * fraction`.
At `numRuns` the search hit `baseline = 5e-324` (the smallest positive sub-normal double) and the test threw:
- `EVAL_FLOOR_NOT_BELOW_BASELINE`: `5e-324 * floorFraction` rounds back up to `5e-324`, so `floor === baseline` and `makeArmedGate` correctly rejects it.
- reviewed-lowering accept failed: `5e-324 * fraction` underflows to `0`, which is not a valid baseline (`> 0`), so `lowerBaselineWithReview` correctly returned an error.

Both were generator-correctness bugs, not defects in the pure eval-gate: the production constructors did exactly the right thing on a degenerate input the generator should never have produced.

# Root cause

`fc.double({ min: 0, ... })` (even with `minExcluded`) will produce sub-normal magnitudes like `5e-324`. Near that floor there is no representable value strictly between `0` and the drawn number, so:
- multiplying by a fraction `< 1` either underflows to `0` or rounds back to the original value, and
- "derive a strictly-smaller/strictly-larger sibling by multiplication" silently collapses to equality or zero.
pass@k / baseline / floor are fractions of a fixed, finite benchmark subset - they are ordinary probabilities, never sub-normal doubles - so the extreme values only exercise floating-point pathologies, not meaningful domain behaviour.

# Fix / rule

Constrain probability-metric generators to a non-degenerate lower bound and keep any derived sibling a representable step away:
- draw `baseline` from `[1e-3, 1]` (normal-double range), not `(0, 1]`;
- cap the child fraction (e.g. `floorFraction`/lowering `fraction` in `[0, 0.999]`, and `[1e-3, 0.999]` when the child must stay strictly positive) so `parent * fraction` is a real step below the parent and never underflows.

This tightens generator VALIDITY, not the logical property: `measured` and `floor` still span their full ranges, so every decision boundary (`measured <= floor`, `measured < baseline - tolerance`, `measured == baseline`) is still exercised. General rule: when a property builds domain values through validating constructors, generate values in the meaningful domain and derive strict-ordering siblings with a bounded gap; do not let `fc.double` roam into sub-normal territory for a quantity that is really a coarse-grained probability.

# Links

- app/test/eval-gate-ratchet.property.test.ts
- app/core/eval-gate/index.ts
- chipAgent/_inbox/shared-pbt-harness-conventions.md
- chipAgent/_inbox/eval-gate-floor-below-baseline-invariant.md
