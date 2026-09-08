// The pass@k estimator and its aggregation (Req 15.2).
//
// pass@k answers: given n independent samples of a problem of which c passed the
// oracle, what is the probability that at least one of a random k-subset passes?
// This is the standard unbiased estimator from Chen et al. (HumanEval), computed
// with the numerically stable product form
//
//     pass@k = 1 - prod_{i = n-c+1}^{n} (1 - k / i)
//
// so it never forms an astronomically large binomial coefficient. Because c is a
// deterministic function of the fixed seeds/temperature/sample count (Req 15.10),
// this estimator is itself deterministic: the same (n, c, k) always yields the same
// value, which is what makes the CI comparison reproducible.
//
// Everything here is pure: no clock, no randomness, no I/O.

/**
 * The unbiased pass@k estimator for one problem.
 *
 * `total` is n (the sample count), `correct` is c (samples the oracle passed), and
 * `k` is the subset size. Returns a probability in [0, 1]. Degenerate inputs are
 * clamped rather than throwing so the estimator stays total: a non-positive n or k
 * yields 0, `k` larger than n is treated as n, and `correct` is clamped into
 * [0, n]. When at least (n - c) < k the pass is certain and the result is exactly 1.
 */
export function passAtK(total: number, correct: number, k: number): number {
  if (total <= 0 || k <= 0) {
    return 0;
  }
  const n = Math.floor(total);
  const c = clamp(Math.floor(correct), 0, n);
  const kk = Math.min(Math.floor(k), n);
  if (n - c < kk) {
    return 1;
  }
  let probabilityAllFail = 1;
  for (let i = n - c + 1; i <= n; i += 1) {
    probabilityAllFail *= 1 - kk / i;
  }
  return clamp(1 - probabilityAllFail, 0, 1);
}

/**
 * The mean of a set of per-problem pass@k values (the subset-level pass@k).
 *
 * An empty set has no pass@k signal; it returns 0 rather than NaN so downstream
 * comparisons and the recorded report stay well-defined.
 */
export function meanPassAtK(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((accumulator, value) => accumulator + value, 0);
  return sum / values.length;
}

/** Clamp a value into the inclusive range [low, high]. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
