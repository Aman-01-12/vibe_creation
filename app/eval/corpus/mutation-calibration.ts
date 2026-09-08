// CALIBRATION: asking the INDEPENDENT judge about every mutant, and excluding none of them.
//
// WHAT THIS USED TO DO, AND WHY IT WAS WRONG
//   This module used to run RTLLM's golden testbench against every mutant and keep only the
//   ones it KILLED as the "detectable" set - the set our testbench was scored over. A mutant
//   the golden testbench passed was excluded as likely-equivalent or spec-irrelevant.
//
//   That was unsound, and unsound in the one direction that matters: it excused our testbench
//   for exactly the bugs the golden judge is blind to. Its blindness is measured, not
//   hypothetical - `rtllm/memory/right_shifter`'s golden testbench drives 8+ shifts and then
//   checks only the final value, so it structurally cannot detect the missing `initial q = 0`
//   that RTLLM's own spec requires. And that population, bugs the golden judge misses, is the
//   one that produces the `MISSED BUGS` cell this whole seam exists to close. GateTruth
//   (arXiv 2608.12635) names an unsound equivalent-mutant exclusion mechanism as one of three
//   causes of its own incorrect published results: mutants it excluded as unobservable turned
//   out not to be equivalent.
//
// EQUIVALENCE IS NOT DECIDABLE BY SIMULATION, SO NOTHING IS AUTO-EXCLUDED
//   A simulation that fails to distinguish a mutant from the original has established one
//   thing: THAT STIMULUS did not distinguish them. That is a fact about the stimulus, not
//   about the designs. So no mutant is ever dropped from the denominator on the strength of a
//   golden pass.
//
// WHAT THE JUDGE STILL DECIDES
//   The golden testbench still runs against every mutant, and its verdict is still
//   third-party - we did not write it and do not modify it. What the verdict now decides is
//   narrower: it CLASSIFIES the mutants our own testbench fails to kill (see
//   `../mutation-control.ts`). A survivor the golden testbench killed is a definite coverage
//   gap in ours. A survivor it also passed is candidate-equivalent: reported, flagged for
//   review, and still counted against us.
//
// A TIMEOUT IS A KILL, NOT A BROKEN MUTANT
//   A mutant the golden testbench never terminates on COMPILED - it has to have, to run until
//   the wall clock killed it. It used to classify `non-compiling`, which removed it from the
//   VALID set: mislabelled, it wrongly shrank the kill-rate denominator, and worst of all it
//   left the GATE set, so our testbench was never required to catch a defect that demonstrably
//   changes observable behaviour. It is now `golden-timeout` - a VALID mutant and a golden KILL -
//   and the gate set is correspondingly LARGER, which is the intended consequence rather than
//   something to compensate for elsewhere.
//
//   This is established practice (Stryker counts an infinite-loop mutant as detected) and it is
//   the rule this harness ALREADY applies to OUR testbench via `MutantKillKind: 'no-verdict'`.
//   Calibration reading the same evidence differently would be two rules for one fact.
//
//   It is counted APART from a reported failure, for the same reason `no-verdict` is: a hang is
//   weaker evidence, and a corpus whose judge mostly HANGS must not read as one that mostly
//   DETECTS. RTLLM's golden testbenches commonly spin on a design signal
//   (`while (mul_en_out == 0)`), so this is a structural property of the corpus, not a rarity.
//
// THE TWO EXCLUSIONS THAT REMAIN, AND BOTH ARE COUNTED
//   `non-compiling` is now a GENUINE BUILD FAILURE only: no verdict, and the toolchain wrote
//   diagnostics instead of simulating. `golden-errored` is the third case - no verdict, no
//   diagnostics, and no timeout - which is a crash or an empty capture, an infrastructure fact
//   about the run rather than a fact about the mutant. Both leave the denominator and both are
//   counted, because a run where two thirds of the mutants never built proves much less than one
//   where all of them did, and only the counts can say which happened. They are kept apart
//   because calling a crash a build failure would attribute our fault to the corpus.
//
// THIS IS A CORPUS-LEVEL PROPERTY, NOT A PER-SAMPLE ONE
//   Calibration depends on exactly three things: the reference RTL, the golden testbench, and
//   the mutation config. It does NOT depend on the model, the arm, the sample, or our
//   testbench. So it is computed ONCE PER PROBLEM and cached; per sample, only OUR testbench
//   runs against the already-calibrated valid set. Getting this wrong would multiply the
//   golden simulations by the sample count for no information.
//
// THE CACHE KEY, AND WHY IT IS EXACTLY THIS
//   `v<schema version>/<corpus commit>/<hash of the mutation config>`:
//     - the SCHEMA VERSION pins the calibration SEMANTICS. It is in the key, not merely in the
//       document, so a cache written when a golden pass meant "excluded" cannot be served
//       under the current rule where it means "candidate-equivalent, still in the
//       denominator". A stale cache that decoded cleanly would silently restore the exclusion
//       this module was fixed to remove;
//     - the CORPUS COMMIT pins the reference RTL and the golden testbench, which are the two
//       third-party inputs. A different commit is a different reference and a different judge;
//     - the MUTATION CONFIG HASH pins which mutants exist at all - the operator set and the
//       cap both change the mutant set (see `./verilog-mutation.ts`), so a verdict cached
//       under one config says nothing under another;
//     - the MUTANT WALL CAP pins how each mutant was JUDGED. A mutant that runs for eight
//       seconds and then reports a failure is `golden-killed` under a 30s cap and
//       `golden-timeout` under a 5s one, so the cap can change a verdict - which is the only
//       test this key applies.
//   Nothing about the model, the arm, the prompt, or the sweep enters the key, because none of
//   them can change a golden testbench's verdict on a mutant.
//
//   The cache is UNTRUSTED input like any other file on disk. It is validated before use: the
//   schema version, the key, the generated-mutant count, and the presence of a verdict for
//   EVERY freshly generated mutant id must all match. Any mismatch is a MISS - recalibrate -
//   never a partial trust, because a cache that half-answers would silently mis-bucket our
//   survivors and make our testbench look better than it is.

import type { ResourceLimits } from '@app/tools';

import {
  canonicalMutationConfig,
  mutantIsValid,
  mutantRunLimits,
  mutantWasGoldenKilled,
  type Mutant,
  type MutantCalibration,
  type MutationConfig,
} from '../mutation-control.js';
import type { GoldenTestbench, ReferenceDesign } from './corpus-types.js';
import { REFERENCE_WORKSPACE_FILENAME } from './import.js';
import type { GoldenScore, GoldenTestbenchScorer } from './golden-scorer.js';
import { classifyNonPass } from './nonpass-cause.js';
import { generateMutants } from './verilog-mutation.js';

/**
 * The cache document schema version; bumped when a field's meaning changes.
 *
 * v1 -> v2: a verdict of `undetectable` used to EXCLUDE its mutant from the kill-rate
 * denominator. There is no exclusion any more - the same mutant is now `golden-survived`, sits
 * in the denominator, and only changes which survivor bucket it lands in. A v1 verdict map
 * therefore encodes a different rule, not merely different spellings, so it is refused rather
 * than translated. This constant is also part of the rendered cache KEY, so the refusal holds
 * even for a document whose body a future reader could otherwise parse.
 *
 * v2 -> v3: the VERDICT VOCABULARY changed, in the direction that moves mutants between sets.
 * A v2 document spells three verdicts; v3 spells five, and the two new ones were both v2's
 * `non-compiling`:
 *   - a mutant the golden testbench HUNG on is now `golden-timeout`, which is a VALID mutant and
 *     a golden KILL, so it entered both the denominator and the GATE set;
 *   - a mutant whose golden run crashed with nothing to show is now `golden-errored`, still out
 *     of the denominator but no longer misdescribed as a build failure.
 * So a v2 `non-compiling` cannot be translated: it means "one of three things happened and we
 * did not record which". Serving one under the current rule would silently shrink the gate set
 * by exactly the population this fix exists to restore. Refusal, not migration, as at every
 * previous bump.
 */
export const MUTATION_CALIBRATION_CACHE_VERSION = 3;

/** What a cached calibration is keyed by; see the header for why it is exactly this. */
export interface MutationCalibrationCacheKey {
  /** The verified upstream commit the reference RTL and golden testbench came from. */
  readonly corpusCommit: string;
  /** A digest of the canonical mutation config, so a config change invalidates the cache. */
  readonly mutationConfigHash: string;
  /**
   * The wall-clock cap ONE MUTANT's golden run executed under, in milliseconds.
   *
   * In the key because it can CHANGE A VERDICT, which is the only test this key applies. A
   * mutant that runs for eight seconds and then reports a failure is `golden-killed` under a
   * 30s cap and `golden-timeout` under a 5s one - a different member of the denominator and a
   * different weight of evidence in the gate set. A verdict measured under one cap therefore
   * says nothing under another, exactly as a verdict measured against a different reference
   * says nothing about this one.
   *
   * It is a separate key component rather than folded into `mutationConfigHash`, because the
   * mutation config decides WHICH MUTANTS EXIST and this decides HOW THEY WERE JUDGED. Two
   * different questions, kept legible in the rendered key so an operator inspecting the cache
   * directory can see which cap a cached answer belongs to.
   */
  readonly mutantWallMs: number;
}

/** Computes a lowercase hex digest of a UTF-8 string; injected so this module stays pure. */
export type DigestHex = (text: string) => string;

/** How many hex characters of the config digest the key keeps (still 64 bits). */
const CONFIG_HASH_LENGTH = 16;

/** The mutation config's contribution to the cache key (pure, deterministic). */
export function mutationConfigHash(config: MutationConfig, digest: DigestHex): string {
  return digest(canonicalMutationConfig(config)).slice(0, CONFIG_HASH_LENGTH);
}

/**
 * The rendered cache key, for a filename and for the equality check on read.
 *
 * The schema version leads, so bumping `MUTATION_CALIBRATION_CACHE_VERSION` changes every key
 * in one place. That is what makes a semantics change unable to reuse a cache written under
 * the previous semantics, and there is exactly one constant to bump to get it.
 */
export function renderCalibrationCacheKey(key: MutationCalibrationCacheKey): string {
  return (
    `v${MUTATION_CALIBRATION_CACHE_VERSION}/${key.corpusCommit}/${key.mutationConfigHash}/` +
    `w${key.mutantWallMs}`
  );
}

/** One problem's cached calibration, as it sits on disk. */
export interface CalibrationCacheDocument {
  readonly schemaVersion: number;
  readonly cacheKey: string;
  readonly problemId: string;
  /** How many mutants the generator produced under this config; validated on read. */
  readonly generatedCount: number;
  /** The golden testbench's verdict per mutant id. */
  readonly verdicts: Readonly<Record<string, MutantCalibration>>;
}

/**
 * The cache the calibration is persisted through.
 *
 * Text in, text out - the same split as `ResultsLogPort` - so the decoding and validation
 * live here and exactly one module in the tree touches the filesystem for this.
 */
export interface MutationCalibrationCachePort {
  /** The cached document text for one problem, or `null` when there is none. */
  read(problemId: string): Promise<string | null>;
  /** Persist one problem's calibration. A failure must be reported, never thrown away. */
  write(problemId: string, text: string): Promise<void>;
}

/** The calibration verdicts a cache document may carry; a closed set, validated on read. */
const CALIBRATIONS: readonly MutantCalibration[] = [
  'golden-killed',
  'golden-timeout',
  'golden-survived',
  'non-compiling',
  'golden-errored',
];

/** Serialize one problem's calibration for the cache. */
export function encodeCalibrationCache(document: CalibrationCacheDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Narrow an unknown to a plain object record, or `null`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The verdict map from an untrusted document, or `null` when any entry is unreadable. */
function decodeVerdicts(raw: unknown): Readonly<Record<string, MutantCalibration>> | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const verdicts: Record<string, MutantCalibration> = {};
  for (const [mutantId, value] of Object.entries(record)) {
    const verdict = CALIBRATIONS.find((candidate) => candidate === value);
    if (verdict === undefined) {
      return null;
    }
    verdicts[mutantId] = verdict;
  }
  return verdicts;
}

/**
 * Decode and VALIDATE a cached calibration against the current key and mutant set.
 *
 * Returns `null` - a miss, not an error - for anything that does not match exactly: bad JSON,
 * a stale schema version, a different cache key, a different generated count, or a missing
 * verdict for any mutant. A miss costs a recalibration; a wrongly accepted cache would
 * silently change how survivors are bucketed, so the asymmetry is deliberate.
 */
export function decodeCalibrationCache(
  text: string,
  key: MutationCalibrationCacheKey,
  mutants: readonly Mutant[],
): Readonly<Record<string, MutantCalibration>> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // A corrupt cache file is a miss: it is a derived artifact, so recomputing is always safe.
    return null;
  }
  const record = asRecord(raw);
  if (record === null || record.schemaVersion !== MUTATION_CALIBRATION_CACHE_VERSION) {
    return null;
  }
  if (record.cacheKey !== renderCalibrationCacheKey(key)) {
    return null;
  }
  if (record.generatedCount !== mutants.length) {
    return null;
  }
  const verdicts = decodeVerdicts(record.verdicts);
  if (verdicts === null) {
    return null;
  }
  return mutants.every((mutant) => verdicts[mutant.mutantId] !== undefined) ? verdicts : null;
}

/**
 * One VALID mutant paired with the independent judge's verdict on it.
 *
 * Paired rather than carried in two parallel collections, because the pairing is what the
 * survivor buckets are computed from: a mutant separated from its golden verdict cannot be
 * classified, and two lists that must stay index-aligned is an invariant nothing enforces.
 */
export interface CalibratedMutant {
  readonly mutant: Mutant;
  /**
   * The INDEPENDENT golden testbench's verdict on it, as a named state.
   *
   * The state rather than a `goldenKilled` boolean, because the boolean threw away the one
   * distinction the gate's honesty rests on: a judge that REPORTED a failure and a judge that
   * merely HUNG both count as kills, but only the first is a demonstration that the defect
   * class is detectable. Consumers read it through `mutantWasGoldenKilled`, so the kill rule has
   * one owner and a new state cannot silently default.
   *
   * Only a VALID calibration ever appears here - `assemble` filters the rest out - but it is
   * carried as the full union rather than a narrowed one, so the same value can be persisted in
   * the cache and read back without a second vocabulary.
   */
  readonly calibration: MutantCalibration;
}

/** Whether the INDEPENDENT judge killed this calibrated mutant, by either kill kind (pure). */
export function goldenKilled(entry: CalibratedMutant): boolean {
  return mutantWasGoldenKilled(entry.calibration);
}

/** One problem's calibrated mutant set. */
export interface CalibratedMutants {
  readonly problemId: string;
  /**
   * The VALID set: every mutant that compiled, in generation order, with its golden verdict.
   *
   * This is the denominator. It deliberately includes the mutants the golden testbench passed:
   * excluding those would score our testbench only on what the independent judge can already
   * see, which is precisely the population that cannot contain a missed bug.
   */
  readonly valid: readonly CalibratedMutant[];
  /** Mutants that did not BUILD: not valid mutants, and counted. */
  readonly nonCompilingCount: number;
  /**
   * Mutants whose golden run produced no verdict, no diagnostics, and no timeout.
   *
   * Also out of the denominator, and counted APART from `nonCompilingCount` because it is a
   * different fact: a crash or an empty capture is an infrastructure failure of the run, not a
   * broken mutant, and calling it "did not compile" would attribute our fault to the corpus.
   */
  readonly goldenErroredCount: number;
  /** Mutants generated from the reference, before calibration. */
  readonly generatedCount: number;
  /** Whether every verdict came from the cache, so no golden simulation ran. */
  readonly fromCache: boolean;
  /** Wall clock spent calibrating this problem, in milliseconds. */
  readonly elapsedMs: number;
}

/** Valid mutants the INDEPENDENT judge killed; the scope of the coverage-gap bucket (pure). */
export function goldenKilledCountOf(calibrated: CalibratedMutants): number {
  return calibrated.valid.filter(goldenKilled).length;
}

/** Valid mutants the independent judge PASSED: the measure of its own blindness (pure). */
export function goldenSurvivedCountOf(calibrated: CalibratedMutants): number {
  return calibrated.valid.length - goldenKilledCountOf(calibrated);
}

/** Golden kills that were HANGS rather than reported failures; weaker evidence (pure). */
export function goldenTimeoutCountOf(calibrated: CalibratedMutants): number {
  return calibrated.valid.filter((entry) => entry.calibration === 'golden-timeout').length;
}

/**
 * Whether a resource bound KILLED the golden run rather than the run ending on its own (pure).
 *
 * One predicate over both bounds, because calibration cares about the fact they share - the judge
 * was stopped before it could reach a verdict - and not about which cap noticed. Keeping them
 * merged HERE while they stay distinct on the seam is deliberate: the seam must be able to say
 * which bound fired, and this reader must not have to care.
 */
function killedByResourceBound(score: GoldenScore): boolean {
  return score.timedOut || score.diskLimitExceeded;
}

/**
 * Classify one mutant from the golden testbench's verdict on it (pure, total).
 *
 * THE SINGLE OWNER of what a golden run on a mutant means. Five outcomes, because the evidence
 * genuinely comes in five kinds and folding any two of them loses a decision:
 *
 *   `failed`   -> `golden-killed`.   The judge ran and reported a failure.
 *   `passed`   -> `golden-survived`. Candidate-equivalent, never assumed equivalent.
 *   `error` + a RESOURCE BOUND KILLED IT -> `golden-timeout`. A KILL, see below.
 *   `error` + it wrote DIAGNOSTICS -> `non-compiling`. A genuine build failure. Out.
 *   `error` + neither            -> `golden-errored`. A crash or empty capture. Out.
 *
 * WHY A TIMEOUT IS A KILL AND NOT A BROKEN MUTANT
 *   It COMPILED - it has to have, to run until the wall clock killed it - so calling it
 *   non-compiling is factually wrong, and the consequence is not cosmetic: it removed the mutant
 *   from the VALID set, which both shrank the kill-rate denominator and took the mutant out of
 *   the GATE set, so our testbench was never required to catch a defect that demonstrably
 *   changes observable behaviour.
 *
 * WHY A DISK-CAP KILL COUNTS AS THE SAME EVIDENCE
 *   `wallMs` is not the only bound that can stop a non-terminating run, and since `diskMb` became
 *   enforced it is often not the first: a testbench that dumps a waveform and spins writes tens of
 *   megabytes per second, so the workspace cap trips seconds before the wall clock would. That is
 *   the same fact about the mutant - the judge never reached a verdict because the run would not
 *   end - reported by whichever bound noticed first, so reading only `timedOut` would have
 *   silently moved those mutants from `golden-timeout` (valid, a kill, IN the gate set) to
 *   `non-compiling` (out of everything) purely because a different cap fired. The calibration
 *   states, the valid-mutant denominator, and the gate set are all unchanged by this fix, which is
 *   exactly the intent.
 *
 *   The mutant DID produce an observable behavioural difference: the reference design plus this
 *   same golden testbench completes in a couple of hundred milliseconds, and the mutant does not
 *   terminate at all. Counting that as detected is established practice - Stryker's mutant
 *   states count a mutant causing an infinite loop as detected
 *   (https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/) - and
 *   it is the rule this repo ALREADY applies to OUR testbench through
 *   `MutantKillKind: 'no-verdict'`. Calibration reading the same evidence differently would be
 *   two rules for one fact.
 *
 * WHY THE TIMEOUT IS READ FROM `GoldenScore.timedOut` AND NOT FROM THE VERDICT
 *   `GoldenVerdict.kind === 'error'` collapses timeout, crash, and compile failure into one
 *   value (the documented gotcha). The worker's own timeout sentinel exit code does NOT survive
 *   the path to here: on both real runtimes the wall-clock kill timer fires at `limits.wallMs`
 *   and SIGKILLs the container, which reports no exit code, no streams, and zeroed usage - so
 *   the sentinel is never written and every residual field is empty. The sandbox's own
 *   `timedOut` observation is therefore threaded through `SandboxResult` into `GoldenScore`
 *   rather than re-derived, which is what the gotcha note prescribes for the moment this
 *   distinction becomes load-bearing.
 *
 * The build-failure-versus-nothing split reuses `classifyNonPass`, the rule Stage 0 and the
 * positive control already share, so there is one definition of "the toolchain wrote
 * diagnostics, so it never simulated" in the tree.
 */
function calibrationOf(score: GoldenScore): MutantCalibration {
  if (score.verdict.kind === 'failed') {
    return 'golden-killed';
  }
  if (score.verdict.kind === 'passed') {
    return 'golden-survived';
  }
  if (killedByResourceBound(score)) {
    return 'golden-timeout';
  }
  const cause = classifyNonPass({ reportedFailure: false, diagnostics: score.diagnostics });
  return cause === 'did-not-build' ? 'non-compiling' : 'golden-errored';
}

/** The injected collaborators the calibrator needs; no globals. */
export interface MutationCalibratorDeps {
  /** The SAME scorer the independent golden judge uses; reads the VCS-style banners. */
  readonly scorer: GoldenTestbenchScorer;
  /** The corpus's golden testbenches, keyed by problem id. */
  readonly golden: ReadonlyMap<string, GoldenTestbench>;
  /** The corpus's reference designs, keyed by problem id, already top-module-renamed. */
  readonly references: ReadonlyMap<string, ReferenceDesign>;
  readonly config: MutationConfig;
  /**
   * The wall-clock ceiling ONE MUTANT's golden run executes under, in milliseconds.
   *
   * Required rather than defaulted here, because it is part of the cache key and a default at
   * this layer could silently disagree with the key the composition root rendered - serving a
   * verdict measured under one cap as if it had been measured under another. The default value
   * itself lives at `DEFAULT_MUTANT_WALL_MS`, and the config boundary applies it.
   */
  readonly mutantWallMs: number;
  readonly cacheKey: MutationCalibrationCacheKey;
  /** Optional persistent cache; absent means every run recalibrates. */
  readonly cache?: MutationCalibrationCachePort;
  /** Sanitized progress sink, so a multi-minute calibration is visible while it happens. */
  readonly onNote?: (note: string) => void;
  /** Wall clock, injected so the elapsed measurement is testable. */
  readonly now?: () => number;
}

/**
 * Calibrates each problem's mutant set against RTLLM's own golden testbench, once.
 *
 * Memoized per problem id INCLUDING the in-flight promise, because the sweep runs samples
 * concurrently and two samples of one problem would otherwise calibrate it twice - paying for
 * the same golden simulations in parallel and racing to write the same cache file.
 */
export class RtllmMutationCalibrator {
  readonly #deps: MutationCalibratorDeps;
  readonly #inFlight = new Map<string, Promise<CalibratedMutants | null>>();

  constructor(deps: MutationCalibratorDeps) {
    this.#deps = deps;
  }

  /**
   * The wall-clock ceiling ONE MUTANT run executes under, in milliseconds.
   *
   * Exposed because the calibrator is the SINGLE OWNER of this knob: its cache key records the
   * cap its verdicts were measured under, so the negative control reads the cap from here rather
   * than carrying a second copy that could drift. A drifted copy would have the independent judge
   * and our own testbench answering "does this mutant hang?" on two different clocks.
   */
  get mutantWallMs(): number {
    return this.#deps.mutantWallMs;
  }

  /**
   * The calibrated mutant set for one problem, or `null` when it cannot be calibrated.
   *
   * `null` means the corpus holds no reference design or no golden testbench for the problem -
   * an honest absence, reported by the caller as `no-reference` rather than as an empty valid
   * set (which would read as "not one mutant compiled").
   */
  calibrate(problemId: string, limits: ResourceLimits): Promise<CalibratedMutants | null> {
    const existing = this.#inFlight.get(problemId);
    if (existing !== undefined) {
      return existing;
    }
    const started = this.#calibrateOnce(problemId, limits);
    this.#inFlight.set(problemId, started);
    return started;
  }

  /** Generate, then calibrate from the cache when it is valid and from the judge otherwise. */
  async #calibrateOnce(
    problemId: string,
    limits: ResourceLimits,
  ): Promise<CalibratedMutants | null> {
    const reference = this.#deps.references.get(problemId);
    const golden = this.#deps.golden.get(problemId);
    if (reference === undefined || golden === undefined) {
      return null;
    }
    const startedAtMs = this.#clock()();
    const mutants = generateMutants(reference.rtl.contents, this.#deps.config);
    const cached = await this.#readCache(problemId, mutants);
    const verdicts = cached ?? (await this.#runGolden(mutants, golden, limits));
    if (cached === null) {
      await this.#writeCache(problemId, mutants, verdicts);
    }
    const calibrated = assemble({
      problemId,
      mutants,
      verdicts,
      fromCache: cached !== null,
      elapsedMs: Math.max(0, this.#clock()() - startedAtMs),
    });
    this.#note(describeCalibration(calibrated));
    return calibrated;
  }

  /**
   * Run the golden testbench against every mutant, sequentially and in generation order.
   *
   * Under the MUTANT wall cap, not the caller's. Every other resource cap is the caller's own
   * (see `mutantRunLimits`); only the wall clock is substituted, because a hanging mutant would
   * otherwise cost a full student-session timeout each and calibration is `mutants` runs long.
   */
  async #runGolden(
    mutants: readonly Mutant[],
    golden: GoldenTestbench,
    limits: ResourceLimits,
  ): Promise<Readonly<Record<string, MutantCalibration>>> {
    const perMutant = mutantRunLimits(limits, this.#deps.mutantWallMs);
    const verdicts: Record<string, MutantCalibration> = {};
    for (const mutant of mutants) {
      const score = await this.#deps.scorer.score(
        { path: REFERENCE_WORKSPACE_FILENAME, contents: mutant.rtl },
        golden,
        perMutant,
      );
      verdicts[mutant.mutantId] = calibrationOf(score);
    }
    return verdicts;
  }

  /** The validated cached verdicts for one problem, or `null` on any mismatch. */
  async #readCache(
    problemId: string,
    mutants: readonly Mutant[],
  ): Promise<Readonly<Record<string, MutantCalibration>> | null> {
    const cache = this.#deps.cache;
    if (cache === undefined || mutants.length === 0) {
      return null;
    }
    try {
      const text = await cache.read(problemId);
      return text === null ? null : decodeCalibrationCache(text, this.#deps.cacheKey, mutants);
    } catch {
      // A cache we cannot read is a miss. The detail names a path, so it is not surfaced.
      this.#note(`calibration cache unreadable for ${problemId}; recalibrating`);
      return null;
    }
  }

  /** Persist one problem's calibration, treating a write failure as a note, not a failure. */
  async #writeCache(
    problemId: string,
    mutants: readonly Mutant[],
    verdicts: Readonly<Record<string, MutantCalibration>>,
  ): Promise<void> {
    const cache = this.#deps.cache;
    if (cache === undefined || mutants.length === 0) {
      return;
    }
    try {
      await cache.write(
        problemId,
        encodeCalibrationCache({
          schemaVersion: MUTATION_CALIBRATION_CACHE_VERSION,
          cacheKey: renderCalibrationCacheKey(this.#deps.cacheKey),
          problemId,
          generatedCount: mutants.length,
          verdicts,
        }),
      );
    } catch {
      // Losing the cache costs wall clock on the next run and nothing else, so it is a note.
      this.#note(`calibration cache could not be written for ${problemId}`);
    }
  }

  /** The injected clock, or the wall clock. */
  #clock(): () => number {
    return this.#deps.now ?? Date.now;
  }

  /** Emit one sanitized progress note, when a sink is wired. */
  #note(note: string): void {
    this.#deps.onNote?.(note);
  }
}

/**
 * Assemble the calibrated set from the mutants and their verdicts (pure).
 *
 * An unknown mutant id resolves to `golden-errored`, which is the fail-safe direction: it
 * removes the mutant from the denominator rather than admitting one whose golden verdict was
 * never measured, and it does so under the state that says "no measurement" rather than under
 * `non-compiling`, which would assert a build failure nobody observed. Unreachable in practice -
 * `decodeCalibrationCache` already requires a verdict for every mutant - and stated as a total
 * function anyway, because the alternative is a lookup that can return `undefined`.
 *
 * The two excluded counts are tallied from the verdicts rather than derived by subtraction, so
 * `generatedCount - valid.length` and `nonCompilingCount + goldenErroredCount` are the same
 * number by construction instead of by a comment.
 */
function assemble(input: {
  readonly problemId: string;
  readonly mutants: readonly Mutant[];
  readonly verdicts: Readonly<Record<string, MutantCalibration>>;
  readonly fromCache: boolean;
  readonly elapsedMs: number;
}): CalibratedMutants {
  const { mutants, verdicts } = input;
  const calibrated = mutants.map((mutant) => ({
    mutant,
    calibration: verdicts[mutant.mutantId] ?? 'golden-errored',
  }));
  return {
    problemId: input.problemId,
    valid: calibrated.filter((entry) => mutantIsValid(entry.calibration)),
    nonCompilingCount: calibrated.filter((entry) => entry.calibration === 'non-compiling').length,
    goldenErroredCount: calibrated.filter((entry) => entry.calibration === 'golden-errored').length,
    generatedCount: mutants.length,
    fromCache: input.fromCache,
    elapsedMs: input.elapsedMs,
  };
}

/**
 * One sanitized operator-facing line describing a calibration (pure).
 *
 * Says VALID first, because that is the denominator, and reports the golden judge's own reach
 * beside it rather than as an exclusion: `golden-blind` is how many valid mutants the
 * independent judge cannot speak for, which is information about the judge, not a discount on
 * our score.
 */
export function describeCalibration(calibrated: CalibratedMutants): string {
  const source = calibrated.fromCache ? 'cached' : 'measured';
  const timeouts = goldenTimeoutCountOf(calibrated);
  return (
    `mutation calibration (${source}) ${calibrated.problemId}: ` +
    `${calibrated.valid.length}/${calibrated.generatedCount} mutants are VALID (the kill-rate ` +
    `denominator); of those the golden testbench kills ${goldenKilledCountOf(calibrated)} ` +
    `(${timeouts} by HANGING, which is weaker evidence than a reported failure) and is ` +
    `golden-blind to ${goldenSurvivedCountOf(calibrated)}; ` +
    `discarded-non-compiling ${calibrated.nonCompilingCount}, ` +
    `discarded-golden-errored ${calibrated.goldenErroredCount} (${calibrated.elapsedMs}ms)`
  );
}
