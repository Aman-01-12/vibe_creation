// The reproducibility configuration for an eval run (Req 15.10, Property 10).
//
// pass@k is only a useful regression signal if it is reproducible run-to-run;
// otherwise CI would flap on sampling noise. This module pins the three knobs that
// make an eval run deterministic - the base `seed`, the sampling `temperature`, and
// the `sampleCount` (the n in pass@k) - into one immutable, validated record, plus
// a pure per-sample seed derivation so every (problem, sample) pair gets a stable,
// distinct seed derived from the base seed.
//
// The harness threads `temperature` and the derived per-sample `seed` down to the
// model provider (behind the Model_Router) so two runs of the same subset with the
// same config draw the same samples and therefore compute the same pass@k. This
// module owns no clock and no randomness: given the same config and inputs it is a
// total, deterministic function.

import { domainError, err, ok, type DomainError, type Result } from '@app/core';

/**
 * The immutable knobs that make an eval run reproducible.
 *
 * `seed` is the base entropy every per-sample seed is derived from; `temperature`
 * is the fixed sampling temperature applied to every model call; `sampleCount` is
 * the number of independent samples drawn per problem (the n in pass@k). Build one
 * only through `makeReproducibilityConfig` so the invariants below always hold.
 */
export interface ReproducibilityConfig {
  /** Base seed; a non-negative 32-bit integer. */
  readonly seed: number;
  /** Fixed sampling temperature; a finite value in [0, 2]. */
  readonly temperature: number;
  /** Samples per problem (the n in pass@k); a positive integer. */
  readonly sampleCount: number;
}

/** The largest base seed accepted, keeping seed math in safe 32-bit integer range. */
const MAX_SEED = 0xffffffff;

/** The inclusive upper bound on sampling temperature. */
const MAX_TEMPERATURE = 2;

/**
 * Construct a validated `ReproducibilityConfig`.
 *
 * Rejects a non-integer or out-of-range seed, a non-finite or out-of-range
 * temperature, and a non-positive or non-integer sample count, so an eval run can
 * never be started with a config that would make pass@k ill-defined or irreproducible.
 */
export function makeReproducibilityConfig(input: {
  readonly seed: number;
  readonly temperature: number;
  readonly sampleCount: number;
}): Result<ReproducibilityConfig, DomainError> {
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > MAX_SEED) {
    return err(
      domainError('EVAL_SEED_OUT_OF_RANGE', `seed must be an integer in [0, ${MAX_SEED}]`, 'seed'),
    );
  }
  if (
    !Number.isFinite(input.temperature) ||
    input.temperature < 0 ||
    input.temperature > MAX_TEMPERATURE
  ) {
    return err(
      domainError(
        'EVAL_TEMPERATURE_OUT_OF_RANGE',
        `temperature must be a finite number in [0, ${MAX_TEMPERATURE}]`,
        'temperature',
      ),
    );
  }
  if (!Number.isInteger(input.sampleCount) || input.sampleCount < 1) {
    return err(
      domainError(
        'EVAL_SAMPLE_COUNT_NOT_POSITIVE',
        'sampleCount must be a positive integer',
        'sampleCount',
      ),
    );
  }
  return ok({ seed: input.seed, temperature: input.temperature, sampleCount: input.sampleCount });
}

/** FNV-1a offset basis and prime for a stable 32-bit string hash. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Hash a string to a stable, non-negative 32-bit integer (FNV-1a).
 *
 * This is a deterministic mixing function for seed derivation only - it is not a
 * cryptographic hash and guards nothing security-sensitive; its sole job is to turn
 * the (base seed, problem, sample) triple into a stable, well-spread seed.
 */
function hash32(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  // `>>> 0` coerces the value back to an unsigned 32-bit integer.
  return hash >>> 0;
}

/**
 * Derive the deterministic seed for one (problem, sample) pair.
 *
 * The base seed, the problem id, and the sample index all feed the mix, so distinct
 * samples of the same problem draw distinct-but-stable seeds and re-running the same
 * config reproduces every seed exactly (Req 15.10).
 */
export function sampleSeed(
  config: ReproducibilityConfig,
  problemId: string,
  sampleIndex: number,
): number {
  return hash32(`${config.seed}:${problemId}:${sampleIndex}`);
}
