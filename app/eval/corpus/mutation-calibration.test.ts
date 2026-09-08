// Unit tests for CALIBRATION: asking the independent golden testbench about every mutant,
// excluding none of them for it, and caching that decision correctly.
//
// THE CLAIM UNDER TEST
//   The VALID set is every mutant that compiles, whatever the golden testbench made of it. A
//   mutant the golden testbench passes STAYS in the set - it is candidate-equivalent, not
//   proven equivalent, and simulation cannot decide the difference. Only a mutant that produced
//   no verdict leaves, because it is not a valid mutant, and that exclusion is COUNTED: a run
//   where most mutants never compiled proves far less than one where all of them did, and only
//   the count can say which happened.
//
// WHY THIS SUITE EXISTS IN THIS SHAPE
//   The previous rule kept only the mutants the golden testbench killed. That excused our
//   testbench for exactly the bugs the golden judge is blind to - a measured blindness, and the
//   population a missed bug comes from. So the tests below assert the OPPOSITE of what they
//   used to: a golden pass must not shrink the denominator.
//
// THE CACHE IS UNTRUSTED INPUT
//   It sits on disk between runs, so it can be moved, copied, truncated, or hand-edited. Every
//   mismatch must be a MISS rather than a partial trust: a cache that half-answered would
//   silently mis-bucket our survivors and flatter our testbench, which is the one direction
//   this whole feature exists to prevent. The schema version is part of the KEY for the same
//   reason, so a cache written under the old exclusion rule cannot be served under this one.
//
// Driven through a fake scorer: no toolchain, no disk.

import { describe, expect, it } from 'vitest';

import type { ResourceLimits, SourceFile } from '@app/tools';

import { DEFAULT_MUTATION_CONFIG, type MutationConfig } from '../mutation-control.js';
import type { GoldenTestbench, ReferenceDesign } from './corpus-types.js';
import type { GoldenScore, GoldenTestbenchScorer } from './golden-scorer.js';
import type { GoldenVerdictKind } from './golden-banner.js';
import {
  decodeCalibrationCache,
  describeCalibration,
  encodeCalibrationCache,
  goldenKilled,
  goldenKilledCountOf,
  goldenSurvivedCountOf,
  goldenTimeoutCountOf,
  MUTATION_CALIBRATION_CACHE_VERSION,
  mutationConfigHash,
  renderCalibrationCacheKey,
  RtllmMutationCalibrator,
  type MutationCalibrationCacheKey,
  type MutationCalibrationCachePort,
} from './mutation-calibration.js';
import { generateMutants } from './verilog-mutation.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 };

const PROBLEM_ID = 'rtllm/control/counter';

/** A reference with several distinct mutation sites, so the exclusions are observable. */
const REFERENCE_RTL = `module counter (input clk, input rst_n, output reg [7:0] q);
  always @(posedge clk or negedge rst_n)
    if (!rst_n)
      q <= 8'd0;
    else
      q <= q + 1;
endmodule
`;

/** A narrow config, so a test can name every mutant it expects. */
const NARROW: MutationConfig = {
  maxMutantsPerProblem: 4,
  operators: DEFAULT_MUTATION_CONFIG.operators,
};

/** The mutant wall cap these tests calibrate under; small, like the real default. */
const MUTANT_WALL_MS = 5_000;

const CACHE_KEY: MutationCalibrationCacheKey = {
  corpusCommit: 'abc123def456',
  mutationConfigHash: 'cafef00dcafef00d',
  mutantWallMs: MUTANT_WALL_MS,
};

/** A trivial, deterministic digest, so the key computation is testable without crypto. */
function fakeDigest(text: string): string {
  let hash = 0;
  for (const character of text) {
    hash = (hash * 31 + character.codePointAt(0)!) % 0xffffffff;
  }
  return hash.toString(16).padStart(20, '0');
}

function reference(): ReferenceDesign {
  return {
    problemId: PROBLEM_ID,
    rtl: { path: 'dut_reference.v', contents: REFERENCE_RTL },
    topModuleRenamedFrom: 'verified_counter',
  };
}

function golden(): GoldenTestbench {
  return {
    problemId: PROBLEM_ID,
    moduleName: 'counter',
    testbench: { path: 'testbench.v', contents: 'module tb; endmodule\n' },
    dataFiles: [],
    overriddenParameters: [],
  };
}

/** A scorer answering per the RTL it is handed, and recording what it saw. */
class ScriptedScorer implements GoldenTestbenchScorer {
  readonly seen: string[] = [];

  constructor(private readonly answer: (rtl: string, callIndex: number) => GoldenScore) {}

  // Only the RTL is declared: the trailing interface parameters are unused here, and
  // `no-unused-vars` with `args: after-used` flags them even underscore-prefixed.
  score(rtl: SourceFile): Promise<GoldenScore> {
    const callIndex = this.seen.length;
    this.seen.push(rtl.contents);
    return Promise.resolve(this.answer(rtl.contents, callIndex));
  }
}

/** A golden score with the given verdict kind and diagnostics. */
function score(kind: GoldenVerdictKind, diagnostics = ''): GoldenScore {
  return {
    problemId: PROBLEM_ID,
    verdict: { kind, failureCount: kind === 'failed' ? 3 : null, banners: [] },
    timedOut: false,
    diskLimitExceeded: false,
    exitCode: kind === 'error' ? null : 0,
    diagnostics,
  };
}

/**
 * A golden score for a run the sandbox KILLED on the wall clock.
 *
 * Modelled exactly as the real path produces it: verdict `error` because no banner reached
 * stdout, `timedOut` true, and NOTHING else - no exit code and no diagnostics, because a
 * wall-clock kill discards every stream. That emptiness is why the flag has to be threaded
 * rather than inferred.
 */
function timedOutScore(): GoldenScore {
  return {
    problemId: PROBLEM_ID,
    verdict: { kind: 'error', failureCount: null, banners: [] },
    timedOut: true,
    diskLimitExceeded: false,
    exitCode: null,
    diagnostics: '',
  };
}

/**
 * A golden score for a run the WORKER killed for exceeding its workspace disk cap.
 *
 * The other way a non-terminating golden run ends, and since `diskMb` became enforced it is
 * often the FIRST way: a hung testbench that dumps a waveform trips the disk cap seconds before
 * the wall clock. Unlike the wall-clock kill this one leaves plausible-looking residue - a real
 * sentinel exit code and a real stderr line - which is exactly why reading the residue instead of
 * the flag would classify it as a mutant that failed to build.
 */
function diskKilledScore(): GoldenScore {
  return {
    problemId: PROBLEM_ID,
    verdict: { kind: 'error', failureCount: null, banners: [] },
    timedOut: false,
    diskLimitExceeded: true,
    exitCode: 125,
    diagnostics: 'workspace reached its 67108864-byte disk cap',
  };
}

/** An in-memory cache, so the port contract is exercised without a filesystem. */
class MemoryCache implements MutationCalibrationCachePort {
  readonly stored = new Map<string, string>();
  reads = 0;
  writes = 0;

  read(problemId: string): Promise<string | null> {
    this.reads += 1;
    return Promise.resolve(this.stored.get(problemId) ?? null);
  }

  write(problemId: string, text: string): Promise<void> {
    this.writes += 1;
    this.stored.set(problemId, text);
    return Promise.resolve();
  }
}

/** A calibrator over the fake scorer, with an optional cache and a fixed clock. */
function calibrator(
  scorer: GoldenTestbenchScorer,
  parts: { readonly cache?: MutationCalibrationCachePort; readonly config?: MutationConfig } = {},
): { readonly subject: RtllmMutationCalibrator; readonly notes: string[] } {
  const notes: string[] = [];
  let tick = 0;
  const subject = new RtllmMutationCalibrator({
    scorer,
    golden: new Map([[PROBLEM_ID, golden()]]),
    references: new Map([[PROBLEM_ID, reference()]]),
    config: parts.config ?? NARROW,
    mutantWallMs: MUTANT_WALL_MS,
    cacheKey: CACHE_KEY,
    ...(parts.cache === undefined ? {} : { cache: parts.cache }),
    onNote: (note) => notes.push(note),
    now: () => {
      tick += 100;
      return tick;
    },
  });
  return { subject, notes };
}

describe('RtllmMutationCalibrator - the golden verdict classifies, it does not exclude', () => {
  it('keeps EVERY compiling mutant valid, whatever the golden testbench made of it', async () => {
    // Every other call fails, so the judge kills half of them - and all four stay valid.
    const scorer = new ScriptedScorer((_rtl, index) =>
      index % 2 === 0 ? score('failed') : score('passed'),
    );
    const { subject } = calibrator(scorer);

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.generatedCount).toBe(4);
    expect(calibrated?.valid).toHaveLength(4);
    expect(goldenKilledCountOf(calibrated!)).toBe(2);
    expect(goldenSurvivedCountOf(calibrated!)).toBe(2);
    expect(calibrated?.nonCompilingCount).toBe(0);
  });

  it('KEEPS a golden-survived mutant in the denominator, flagged rather than excluded', async () => {
    // The unsound exclusion this suite was rewritten to forbid. The judge passing a mutant is
    // evidence about the JUDGE's stimulus, not proof the mutant is equivalent - and the mutants
    // it is blind to are exactly the population a missed bug comes from.
    const { subject } = calibrator(new ScriptedScorer(() => score('passed')));

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.valid).toHaveLength(4);
    expect(calibrated?.valid.every((entry) => !goldenKilled(entry))).toBe(true);
    expect(goldenSurvivedCountOf(calibrated!)).toBe(4);
    expect(calibrated?.nonCompilingCount).toBe(0);
  });

  it('pairs each valid mutant with the judge verdict on THAT mutant', async () => {
    // The pairing is what the survivor buckets are computed from, so it must survive the trip
    // through the calibrator rather than being recoverable only by re-running the judge.
    const { subject } = calibrator(
      new ScriptedScorer((_rtl, index) => (index === 1 ? score('failed') : score('passed'))),
    );

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.valid.map(goldenKilled)).toEqual([false, true, false, false]);
  });

  it('DISCARDS a mutant that did not BUILD and COUNTS it separately', async () => {
    // A mutant that does not build is not a valid mutant at all, so it leaves the denominator -
    // and it is counted, because a run where nothing compiled proves nothing and only the count
    // can say that happened.
    const { subject } = calibrator(
      new ScriptedScorer(() => score('error', 'dut_mutant.v:6: syntax error')),
    );

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.valid).toEqual([]);
    expect(calibrated?.nonCompilingCount).toBe(4);
    expect(calibrated?.goldenErroredCount).toBe(0);
    expect(calibrated?.generatedCount).toBe(4);
  });

  it('runs each mutant under the MUTANT wall cap, leaving every other limit untouched', async () => {
    // GIVEN a student session whose wall clock is 30s and a mutant cap of 5s.
    const seenLimits: ResourceLimits[] = [];
    const scorer: GoldenTestbenchScorer = {
      score: (_rtl, _golden, limits) => {
        seenLimits.push(limits);
        return Promise.resolve(score('failed'));
      },
    };
    const studentLimits: ResourceLimits = { ...LIMITS, wallMs: 30_000 };

    // WHEN the calibrator judges the mutants.
    await calibrator(scorer).subject.calibrate(PROBLEM_ID, studentLimits);

    // THEN only the wall clock was substituted: a hang costs 5s, not 30s, and every OTHER cap is
    // the student session's, because the mutant must run on the same rails as the oracle.
    expect(seenLimits).toHaveLength(4);
    for (const limits of seenLimits) {
      expect(limits.wallMs).toBe(MUTANT_WALL_MS);
      expect(limits.cpu).toBe(studentLimits.cpu);
      expect(limits.memMb).toBe(studentLimits.memMb);
      expect(limits.procs).toBe(studentLimits.procs);
      expect(limits.diskMb).toBe(studentLimits.diskMb);
    }
    // And the caller's own limits object was not mutated, so the loop's cap is unchanged.
    expect(studentLimits.wallMs).toBe(30_000);
  });

  it('runs the golden testbench once per mutant, over the MUTATED rtl', async () => {
    const scorer = new ScriptedScorer(() => score('failed'));
    const { subject } = calibrator(scorer);

    await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(scorer.seen).toHaveLength(4);
    expect(scorer.seen).not.toContain(REFERENCE_RTL);
    expect(new Set(scorer.seen).size).toBe(4);
  });

  it('reports null for a problem with no reference or no golden testbench', async () => {
    const { subject } = calibrator(new ScriptedScorer(() => score('failed')));

    // Honest absence, not an empty valid set: the caller reports `no-reference`, which is a
    // different statement from "not one mutant compiled".
    expect(await subject.calibrate('rtllm/unknown/design', LIMITS)).toBeNull();
  });

  it('records the wall clock it spent, so the one-off cost is visible', async () => {
    const { subject } = calibrator(new ScriptedScorer(() => score('failed')));

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.elapsedMs).toBeGreaterThan(0);
  });

  it('notes what it established, leading with the DENOMINATOR', async () => {
    const { subject, notes } = calibrator(
      new ScriptedScorer((_rtl, index) => (index === 0 ? score('failed') : score('passed'))),
    );

    await subject.calibrate(PROBLEM_ID, LIMITS);

    // The valid count comes first because it is the denominator; the judge's own reach is
    // reported beside it as information about the judge, not as a discount on our score.
    const note = notes.join('\n');
    expect(note).toContain('4/4 mutants are VALID');
    expect(note).toContain('golden testbench kills 1');
    expect(note).toContain('golden-blind to 3');
  });

  it('never describes a golden-survived mutant as excluded', async () => {
    const { subject } = calibrator(new ScriptedScorer(() => score('passed')));

    const described = describeCalibration((await subject.calibrate(PROBLEM_ID, LIMITS))!);

    expect(described).not.toContain('EXCLUDED');
    expect(described).not.toContain('undetectable');
  });
});

describe('RtllmMutationCalibrator - a RESOURCE-BOUND KILL is a KILL, not a non-compiling mutant', () => {
  it('given a golden run killed on the wall clock, when calibrated, then it is golden-killed', async () => {
    // GIVEN a mutant the golden testbench never terminates on. It COMPILED - it had to, to run
    // until the wall clock killed it - so classifying it non-compiling was three wrongs at once:
    // mislabelled, out of the kill-rate denominator, and out of the GATE set.
    const { subject } = calibrator(new ScriptedScorer(() => timedOutScore()));

    // WHEN the calibrator classifies it.
    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    // THEN it is a VALID mutant and a golden KILL, so it is in the denominator and in the gate
    // set our testbench is required to close.
    expect(calibrated?.valid).toHaveLength(4);
    expect(goldenKilledCountOf(calibrated!)).toBe(4);
    expect(calibrated?.nonCompilingCount).toBe(0);
    expect(calibrated?.goldenErroredCount).toBe(0);
  });

  it('given a timeout, when calibrated, then the kill is recorded as a HANG, counted apart', async () => {
    // Same rule the harness already applies to OUR testbench through `no-verdict`: a hang is a
    // kill, on weaker evidence, so it must not read as demonstrated coverage.
    const { subject } = calibrator(
      new ScriptedScorer((_rtl, index) => (index === 0 ? score('failed') : timedOutScore())),
    );

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(goldenKilledCountOf(calibrated!)).toBe(4);
    expect(goldenTimeoutCountOf(calibrated!)).toBe(3);
    expect(calibrated?.valid.map((entry) => entry.calibration)).toEqual([
      'golden-killed',
      'golden-timeout',
      'golden-timeout',
      'golden-timeout',
    ]);
  });

  it('given a golden run killed for DISK, when calibrated, then it is the same kill as a hang', async () => {
    // GIVEN a mutant whose golden run the WORKER killed for filling its workspace. Since
    // `diskMb` became enforced this is often the FIRST way a non-terminating golden run ends: a
    // hung testbench that dumps a waveform writes tens of megabytes per second, so the disk cap
    // trips seconds before the wall clock would.
    const { subject } = calibrator(new ScriptedScorer(() => diskKilledScore()));

    // WHEN the calibrator classifies it.
    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    // THEN it lands in `golden-timeout` exactly as a wall-clock kill does - valid, a kill, in the
    // denominator and in the gate set. The assertion that carries the weight is
    // `nonCompilingCount` being 0: this score carries a REAL sentinel exit code and a REAL stderr
    // line, so a reader that went by the residue instead of the flag would call it a mutant that
    // failed to build and drop it out of everything.
    expect(calibrated?.valid).toHaveLength(4);
    expect(goldenKilledCountOf(calibrated!)).toBe(4);
    expect(goldenTimeoutCountOf(calibrated!)).toBe(4);
    expect(calibrated?.nonCompilingCount).toBe(0);
    expect(calibrated?.goldenErroredCount).toBe(0);
  });

  it('given a disk kill beside a wall-clock kill and a real build failure, then all three keep their state', async () => {
    // The two bounds report the same fact - the judge never reached a verdict because the run
    // would not end - so they must not be distinguished; a genuine build failure must still be,
    // or "read the flag, not the residue" would have been fixed by making everything a kill.
    const answers = [diskKilledScore(), timedOutScore(), score('error', 'syntax error')];
    const { subject } = calibrator(
      new ScriptedScorer((_rtl, index) => answers[index] ?? score('passed')),
    );

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.valid.map((entry) => entry.calibration)).toEqual([
      'golden-timeout',
      'golden-timeout',
      'golden-survived',
    ]);
    expect(calibrated?.nonCompilingCount).toBe(1);
    expect(calibrated?.goldenErroredCount).toBe(0);
  });

  it('given a build failure, when calibrated, then it stays non-compiling and OUT of the set', async () => {
    // The distinction that matters: diagnostics with no verdict and no timeout is a broken
    // mutant, and a broken mutant must NOT enter the gate set on the strength of a hang rule.
    const { subject } = calibrator(
      new ScriptedScorer(() => score('error', 'dut_mutant.v:4: error: unknown module type')),
    );

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.valid).toEqual([]);
    expect(calibrated?.nonCompilingCount).toBe(4);
    expect(calibrated?.goldenErroredCount).toBe(0);
  });

  it('given a CRASH - no verdict, no diagnostics, no timeout - then it stays distinguishable', async () => {
    // The third cause. It did not fail to build and it did not hang, so folding it into either
    // would assert something nobody observed: a crash or an empty capture is an infrastructure
    // fact about the run, not a fact about the mutant.
    const { subject } = calibrator(new ScriptedScorer(() => score('error')));

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.valid).toEqual([]);
    expect(calibrated?.goldenErroredCount).toBe(4);
    expect(calibrated?.nonCompilingCount).toBe(0);
  });

  it('separates all three error causes in ONE calibration, so none is folded into another', async () => {
    // Timeout, build failure, and crash, side by side. Three causes, three states: one valid
    // mutant in the gate set, two excluded for two different and separately counted reasons.
    const answers = [timedOutScore(), score('error', 'syntax error'), score('error')];
    const { subject } = calibrator(
      new ScriptedScorer((_rtl, index) => answers[index] ?? score('passed')),
    );

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.valid.map((entry) => entry.calibration)).toEqual([
      'golden-timeout',
      'golden-survived',
    ]);
    expect(calibrated?.nonCompilingCount).toBe(1);
    expect(calibrated?.goldenErroredCount).toBe(1);
    expect(calibrated?.generatedCount).toBe(4);
  });

  it('names the HANG share in its operator note, so a hang-heavy gate cannot read as coverage', async () => {
    const { subject, notes } = calibrator(
      new ScriptedScorer((_rtl, index) => (index === 0 ? score('failed') : timedOutScore())),
    );

    await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(notes.join('\n')).toContain('golden testbench kills 4 (3 by HANGING');
  });
});

describe('RtllmMutationCalibrator - calibration is computed once per problem', () => {
  it('does not re-run the golden testbench for a second sample of the same problem', async () => {
    const scorer = new ScriptedScorer(() => score('failed'));
    const { subject } = calibrator(scorer);

    await subject.calibrate(PROBLEM_ID, LIMITS);
    await subject.calibrate(PROBLEM_ID, LIMITS);

    // Four mutants, four golden runs - not eight. Calibration depends on the reference, the
    // golden testbench and the config, none of which changed between the two calls.
    expect(scorer.seen).toHaveLength(4);
  });

  it('memoizes the IN-FLIGHT calibration, so concurrent samples do not duplicate it', async () => {
    const scorer = new ScriptedScorer(() => score('failed'));
    const { subject } = calibrator(scorer);

    // The sweep runs samples concurrently; two samples of one problem must not both calibrate.
    await Promise.all([
      subject.calibrate(PROBLEM_ID, LIMITS),
      subject.calibrate(PROBLEM_ID, LIMITS),
      subject.calibrate(PROBLEM_ID, LIMITS),
    ]);

    expect(scorer.seen).toHaveLength(4);
  });
});

describe('RtllmMutationCalibrator - the cache', () => {
  it('writes a hit that a later calibrator reads instead of re-running the judge', async () => {
    const cache = new MemoryCache();
    const first = calibrator(new ScriptedScorer(() => score('failed')), { cache });
    await first.subject.calibrate(PROBLEM_ID, LIMITS);
    expect(cache.writes).toBe(1);

    const secondScorer = new ScriptedScorer(() => score('passed'));
    const second = calibrator(secondScorer, { cache });
    const calibrated = await second.subject.calibrate(PROBLEM_ID, LIMITS);

    // The scorer was never called, and the CACHED verdicts won - not this scorer's answer.
    expect(secondScorer.seen).toEqual([]);
    expect(calibrated?.valid).toHaveLength(4);
    expect(calibrated?.fromCache).toBe(true);
  });

  it('recalibrates when the mutation CONFIG changed, because the mutants changed', async () => {
    const cache = new MemoryCache();
    const first = calibrator(new ScriptedScorer(() => score('failed')), { cache });
    await first.subject.calibrate(PROBLEM_ID, LIMITS);

    const widerScorer = new ScriptedScorer(() => score('failed'));
    const wider = calibrator(widerScorer, {
      cache,
      config: { ...NARROW, maxMutantsPerProblem: 6 },
    });
    const calibrated = await wider.subject.calibrate(PROBLEM_ID, LIMITS);

    // A different cap means a different mutant set, so the cached verdicts do not cover it.
    expect(widerScorer.seen.length).toBeGreaterThan(0);
    expect(calibrated?.fromCache).toBe(false);
  });

  it('treats a corrupt cache document as a miss rather than as an error', async () => {
    const cache = new MemoryCache();
    await cache.write(PROBLEM_ID, '{ not json');
    const scorer = new ScriptedScorer(() => score('failed'));

    const calibrated = await calibrator(scorer, { cache }).subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.valid).toHaveLength(4);
    expect(scorer.seen).toHaveLength(4);
  });

  it('survives a cache that cannot be read or written, reporting a note', async () => {
    const broken: MutationCalibrationCachePort = {
      read: () => Promise.reject(new Error('EACCES /private/var/cache/x')),
      write: () => Promise.reject(new Error('ENOSPC /private/var/cache/x')),
    };
    const { subject, notes } = calibrator(new ScriptedScorer(() => score('failed')), {
      cache: broken,
    });

    const calibrated = await subject.calibrate(PROBLEM_ID, LIMITS);

    expect(calibrated?.valid).toHaveLength(4);
    // Sanitized: losing the cache costs wall clock, and the errno detail never reaches a note.
    expect(notes.join('\n')).not.toContain('/private/var/cache');
  });
});

describe('decodeCalibrationCache - every mismatch is a miss', () => {
  const mutants = generateMutants(REFERENCE_RTL, NARROW);

  /** A cache document holding one verdict per mutant. */
  function document(overrides: Record<string, unknown> = {}): string {
    return encodeCalibrationCache({
      schemaVersion: MUTATION_CALIBRATION_CACHE_VERSION,
      cacheKey: renderCalibrationCacheKey(CACHE_KEY),
      problemId: PROBLEM_ID,
      generatedCount: mutants.length,
      verdicts: Object.fromEntries(mutants.map((mutant) => [mutant.mutantId, 'golden-killed'])),
      ...overrides,
    } as never);
  }

  it('accepts a document whose key, count and mutant ids all match', () => {
    const verdicts = decodeCalibrationCache(document(), CACHE_KEY, mutants);

    expect(verdicts).not.toBeNull();
    expect(Object.keys(verdicts ?? {})).toHaveLength(mutants.length);
  });

  it('refuses a document written under a DIFFERENT cache key', () => {
    const foreign = { ...CACHE_KEY, mutationConfigHash: 'deadbeefdeadbeef' };

    expect(decodeCalibrationCache(document(), foreign, mutants)).toBeNull();
  });

  it('refuses a document at an older schema version', () => {
    expect(decodeCalibrationCache(document({ schemaVersion: 0 }), CACHE_KEY, mutants)).toBeNull();
  });

  it('refuses a document whose generated count disagrees with the mutant set', () => {
    expect(decodeCalibrationCache(document({ generatedCount: 99 }), CACHE_KEY, mutants)).toBeNull();
  });

  it('refuses a document MISSING a verdict for any mutant', () => {
    // A partial cache is the dangerous case: a mutant with no verdict would be assembled as
    // non-compiling and quietly leave the denominator, making our testbench look better than
    // the evidence supports.
    const partial = encodeCalibrationCache({
      schemaVersion: MUTATION_CALIBRATION_CACHE_VERSION,
      cacheKey: renderCalibrationCacheKey(CACHE_KEY),
      problemId: PROBLEM_ID,
      generatedCount: mutants.length,
      verdicts: Object.fromEntries(
        mutants.slice(1).map((mutant) => [mutant.mutantId, 'golden-killed' as const]),
      ),
    });

    expect(decodeCalibrationCache(partial, CACHE_KEY, mutants)).toBeNull();
  });

  it('refuses a document carrying a verdict from the OLD exclusion vocabulary', () => {
    // `undetectable` used to mean "excluded from the denominator". Accepting it now would be
    // accepting the exclusion this module was fixed to remove, so it is outside the closed set.
    const legacy = document({
      verdicts: Object.fromEntries(mutants.map((mutant) => [mutant.mutantId, 'undetectable'])),
    });

    expect(decodeCalibrationCache(legacy, CACHE_KEY, mutants)).toBeNull();
  });

  it('refuses a document carrying a verdict outside the closed set', () => {
    const tampered = document({
      verdicts: Object.fromEntries(mutants.map((mutant) => [mutant.mutantId, 'probably-fine'])),
    });

    expect(decodeCalibrationCache(tampered, CACHE_KEY, mutants)).toBeNull();
  });
});

describe('mutationConfigHash - the key changes with the config', () => {
  it('gives two different configs two different hashes', () => {
    const narrow = mutationConfigHash(NARROW, fakeDigest);
    const wide = mutationConfigHash({ ...NARROW, maxMutantsPerProblem: 24 }, fakeDigest);

    expect(narrow).not.toBe(wide);
  });

  it('gives the same config the same hash', () => {
    expect(mutationConfigHash(NARROW, fakeDigest)).toBe(
      mutationConfigHash({ ...NARROW }, fakeDigest),
    );
  });

  it('renders a key as version, corpus commit, config hash, mutant cap - stating all four', () => {
    expect(renderCalibrationCacheKey(CACHE_KEY)).toBe('v3/abc123def456/cafef00dcafef00d/w5000');
  });
});

describe('the mutant WALL CAP is part of the cache key, because it can change a verdict', () => {
  const mutants = generateMutants(REFERENCE_RTL, NARROW);

  it('given two caps, when a key is rendered, then the two keys differ', () => {
    // A mutant that runs for eight seconds and then reports a failure is `golden-killed` under a
    // 30s cap and `golden-timeout` under a 5s one. Different verdict, different member of the
    // gate set - so a verdict measured under one cap says nothing under the other.
    const wide = renderCalibrationCacheKey({ ...CACHE_KEY, mutantWallMs: 30_000 });

    expect(renderCalibrationCacheKey(CACHE_KEY)).not.toBe(wide);
  });

  it('given a document written under a different cap, when decoded, then it MISSES', () => {
    const underWideCap = encodeCalibrationCache({
      schemaVersion: MUTATION_CALIBRATION_CACHE_VERSION,
      cacheKey: renderCalibrationCacheKey({ ...CACHE_KEY, mutantWallMs: 30_000 }),
      problemId: PROBLEM_ID,
      generatedCount: mutants.length,
      verdicts: Object.fromEntries(mutants.map((mutant) => [mutant.mutantId, 'golden-killed'])),
    } as never);

    expect(decodeCalibrationCache(underWideCap, CACHE_KEY, mutants)).toBeNull();
  });

  it('given a changed cap, when a second calibrator runs, then it RE-measures', async () => {
    const cache = new MemoryCache();
    await calibrator(new ScriptedScorer(() => score('failed')), { cache }).subject.calibrate(
      PROBLEM_ID,
      LIMITS,
    );

    // A calibrator at a different cap renders a different key, so the cached answer is invisible.
    const rescorer = new ScriptedScorer(() => score('failed'));
    const widened = new RtllmMutationCalibrator({
      scorer: rescorer,
      golden: new Map([[PROBLEM_ID, golden()]]),
      references: new Map([[PROBLEM_ID, reference()]]),
      config: NARROW,
      mutantWallMs: 30_000,
      cacheKey: { ...CACHE_KEY, mutantWallMs: 30_000 },
      cache,
    });
    const calibrated = await widened.calibrate(PROBLEM_ID, LIMITS);

    expect(rescorer.seen).toHaveLength(4);
    expect(calibrated?.fromCache).toBe(false);
  });
});

describe('the calibration cache version bump refuses every v2 document', () => {
  const mutants = generateMutants(REFERENCE_RTL, NARROW);

  it('given a perfectly readable v2 document, when decoded, then it MISSES', () => {
    // The whole point of the bump. A v2 `non-compiling` means "one of timeout, build failure, or
    // crash happened and we did not record which". Serving it under the current rule would put
    // every hung mutant back outside the gate set - exactly the defect this change removes.
    const v2 = encodeCalibrationCache({
      schemaVersion: 2,
      cacheKey: `v2/${CACHE_KEY.corpusCommit}/${CACHE_KEY.mutationConfigHash}`,
      problemId: PROBLEM_ID,
      generatedCount: mutants.length,
      verdicts: Object.fromEntries(mutants.map((mutant) => [mutant.mutantId, 'non-compiling'])),
    } as never);

    expect(decodeCalibrationCache(v2, CACHE_KEY, mutants)).toBeNull();
  });

  it('given the current version, when a key is rendered, then it leads with v3', () => {
    expect(MUTATION_CALIBRATION_CACHE_VERSION).toBe(3);
    expect(renderCalibrationCacheKey(CACHE_KEY)).toMatch(/^v3\//);
  });

  it('accepts the two NEW verdict spellings, so a v3 document round-trips', () => {
    const spellings = ['golden-timeout', 'golden-errored'] as const;
    const document = encodeCalibrationCache({
      schemaVersion: MUTATION_CALIBRATION_CACHE_VERSION,
      cacheKey: renderCalibrationCacheKey(CACHE_KEY),
      problemId: PROBLEM_ID,
      generatedCount: mutants.length,
      verdicts: Object.fromEntries(
        mutants.map((mutant, index) => [mutant.mutantId, spellings[index % spellings.length]]),
      ),
    } as never);

    const decoded = decodeCalibrationCache(document, CACHE_KEY, mutants);

    expect(decoded).not.toBeNull();
    expect(Object.values(decoded ?? {})).toContain('golden-timeout');
    expect(Object.values(decoded ?? {})).toContain('golden-errored');
  });
});

describe('the cache key changed with the semantics, so no stale cache can be served', () => {
  const mutants = generateMutants(REFERENCE_RTL, NARROW);

  it('no longer renders the pre-change key, which was commit over config hash alone', () => {
    // The exact string a pre-change run wrote its cache files under. If the key were still that,
    // a cache computed when a golden pass meant "excluded from the denominator" would be read
    // back as if it had been computed under the current rule.
    expect(renderCalibrationCacheKey(CACHE_KEY)).not.toBe(
      `${CACHE_KEY.corpusCommit}/${CACHE_KEY.mutationConfigHash}`,
    );
  });

  it('leads the key with the schema version, so one bump invalidates every cached problem', () => {
    expect(renderCalibrationCacheKey(CACHE_KEY)).toMatch(
      new RegExp(`^v${MUTATION_CALIBRATION_CACHE_VERSION}/`),
    );
  });

  it('MISSES on a document written under the pre-change key and version', () => {
    // The full stale-cache scenario, end to end: an old document, otherwise perfectly readable,
    // must be a miss so the calibration is recomputed under the current semantics.
    const stale = encodeCalibrationCache({
      schemaVersion: 1,
      cacheKey: `${CACHE_KEY.corpusCommit}/${CACHE_KEY.mutationConfigHash}`,
      problemId: PROBLEM_ID,
      generatedCount: mutants.length,
      verdicts: Object.fromEntries(mutants.map((mutant) => [mutant.mutantId, 'detectable'])),
    } as never);

    expect(decodeCalibrationCache(stale, CACHE_KEY, mutants)).toBeNull();
  });
});
