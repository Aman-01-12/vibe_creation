// The config IDENTITY: a stable fingerprint of the experiment.
//
// WHY A RESUMED RUN NEEDS THIS
//   Resume works by keying a completed sample on (arm, problemId, sampleIndex) and
//   skipping it. That key is only safe if the two runs are the SAME experiment. Change
//   the seed, the temperature, the sample count, the caps, the sandbox limits, or an
//   arm's model id, and a "completed" sample from the old run answers a different
//   question - reusing it would silently blend two experiments into one number, and
//   nothing in the report would show it. So every persisted record carries the config
//   hash, and a record whose hash does not match the current config is INVISIBLE to
//   the resume index.
//
// WHY CANONICALIZATION, NOT `JSON.stringify(config)`
//   `JSON.stringify` preserves insertion order, so the same experiment written with
//   its keys in a different order would hash differently and refuse to resume. The
//   canonical form below sorts every object key at every depth, so the hash depends on
//   the config's VALUE and not on how it was typed.
//
// THE HASH IS NOT A SECURITY BOUNDARY
//   It answers "is this the same experiment?", not "did an adversary tamper with the
//   results file?". Nothing is authorized on the strength of it. SHA-256 is used
//   because it is the obvious stable choice and the digest is injected, so this module
//   stays pure and testable.

import {
  INSTRUMENT_POLICY_VERSION,
  NORMALIZER_VERSION,
  TESTBENCH_PROMPT_VERSION,
  TESTBENCH_REPAIR_POLICY_VERSION,
} from '@app/agent';

import type { SweepConfig } from './config.js';

/** How many hex characters of the digest the short form keeps (still 64 bits). */
const SHORT_HASH_LENGTH = 16;

/**
 * The canonical JSON key `TESTBENCH_PROMPT_VERSION` is folded in under.
 *
 * Reserved rather than a `SweepConfig` field: the prompt version is not something a
 * campaign author sets in a config file, it is a property of the code that ran. Prefixed
 * so it cannot collide with a present or future `SweepConfig` field name, the same way
 * `identityBearingFields` already reads `config`'s own keys verbatim.
 */
const TESTBENCH_PROMPT_VERSION_KEY = '__testbenchPromptVersion';

/**
 * The canonical JSON key `INSTRUMENT_POLICY_VERSION` is folded in under.
 *
 * Reserved rather than a `SweepConfig` field, for the same reason and in the same way as
 * `TESTBENCH_PROMPT_VERSION_KEY` above; see `../../agent/orchestrator/instrument-policy-version.ts`
 * for why this is a distinct constant rather than a reuse of `TESTBENCH_PROMPT_VERSION`.
 */
const INSTRUMENT_POLICY_VERSION_KEY = '__instrumentPolicyVersion';

/**
 * The canonical JSON key `TESTBENCH_REPAIR_POLICY_VERSION` is folded in under.
 *
 * Reserved rather than a `SweepConfig` field, for the same reason and in the same way as
 * `INSTRUMENT_POLICY_VERSION_KEY` above; see
 * `../../agent/orchestrator/testbench-repair-policy-version.ts` for why this is a distinct
 * constant rather than a reuse of `INSTRUMENT_POLICY_VERSION`.
 */
const TESTBENCH_REPAIR_POLICY_VERSION_KEY = '__testbenchRepairPolicyVersion';

/**
 * The canonical JSON key `NORMALIZER_VERSION` is folded in under.
 *
 * Reserved rather than a `SweepConfig` field, for the same reason and in the same way as
 * `TESTBENCH_REPAIR_POLICY_VERSION_KEY` above; see `../../agent/orchestrator/normalizer-version.ts`
 * for why this is a distinct constant rather than a reuse of `TESTBENCH_REPAIR_POLICY_VERSION`.
 */
const NORMALIZER_VERSION_KEY = '__normalizerVersion';

/**
 * The config fields DELIBERATELY excluded from the experiment's identity.
 *
 * The rule for this list is narrow: a field belongs here only if it cannot move a measured
 * number. `captureArtifacts` decides whether diagnostic files are written BESIDE the
 * results; it changes no seed, no prompt, no cap, no model, and no verdict, so two runs
 * that differ only in it answer the same question and a sample recorded by either is
 * equally valid for the other.
 *
 * Including it would be actively harmful, not merely conservative: every sample already
 * recorded by a previous run would become invisible to the resume index the moment the
 * option was introduced, forcing an operator to re-pay for measurements that are still
 * exactly right. That is the opposite of what the hash exists to protect.
 *
 * Anything that could change what a sample measures must NOT be added here. When in doubt,
 * leave a field IN the identity: an unnecessary re-run costs money, while a wrongly reused
 * sample silently blends two experiments into one number.
 */
const IDENTITY_EXCLUDED_FIELDS: readonly (keyof SweepConfig)[] = ['captureArtifacts'];

/**
 * The config's identity-bearing fields: everything except the excluded ones, plus the
 * prompt version, the instrument-policy version, the testbench-repair-policy version,
 * and the normalizer version the running code carries.
 *
 * `TESTBENCH_PROMPT_VERSION`, `INSTRUMENT_POLICY_VERSION`,
 * `TESTBENCH_REPAIR_POLICY_VERSION`, and `NORMALIZER_VERSION` are all read directly from
 * the import rather than taken as a parameter, so `sweepConfigHash`'s signature - and
 * every call site - stays unchanged: a manifest or a resume check can never pass a stale
 * or fabricated version, only the one the code that is actually running was built with.
 */
function identityBearingFields(config: SweepConfig): Record<string, unknown> {
  const excluded = new Set<string>(IDENTITY_EXCLUDED_FIELDS);
  const fields = Object.fromEntries(
    Object.entries(config).filter(([field]) => !excluded.has(field)),
  );
  return {
    ...fields,
    [TESTBENCH_PROMPT_VERSION_KEY]: TESTBENCH_PROMPT_VERSION,
    [INSTRUMENT_POLICY_VERSION_KEY]: INSTRUMENT_POLICY_VERSION,
    [TESTBENCH_REPAIR_POLICY_VERSION_KEY]: TESTBENCH_REPAIR_POLICY_VERSION,
    [NORMALIZER_VERSION_KEY]: NORMALIZER_VERSION,
  };
}

/** Canonical JSON of an arbitrary value: object keys sorted at every depth (pure). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const sorted: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    sorted[key] = canonicalize(entry);
  }
  return sorted;
}

/**
 * The canonical JSON text of a sweep config (pure, deterministic).
 *
 * Every field participates EXCEPT those in `IDENTITY_EXCLUDED_FIELDS`, which cannot affect
 * a measured number. That includes the output directory and the retry policy: two configs
 * that differ in either are different experiments as far as resume is concerned, and being
 * conservative there can only cause an unnecessary re-run, never a silent blend of two
 * experiments.
 */
export function canonicalSweepConfigJson(config: SweepConfig): string {
  return JSON.stringify(canonicalize(identityBearingFields(config)));
}

/** Computes a lowercase hex digest of a UTF-8 string; injected so this module is pure. */
export type DigestHex = (text: string) => string;

/**
 * The config's identity: the first 16 hex characters of the digest of its canonical
 * JSON.
 *
 * Shortened because it appears on every record line and in every log message, and 64
 * bits is far beyond enough to distinguish a handful of hand-written campaigns.
 */
export function sweepConfigHash(config: SweepConfig, digest: DigestHex): string {
  return digest(canonicalSweepConfigJson(config)).slice(0, SHORT_HASH_LENGTH);
}
