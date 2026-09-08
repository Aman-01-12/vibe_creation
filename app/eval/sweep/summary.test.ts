// Unit tests for the per-arm summary aggregation.
//
// THE UNKNOWN-PRICE CASE IS THE POINT OF PART OF THIS FILE
//   The transport reports 0 cents for a model with no configured price. If the summary
//   summed those, an arm would report a total that looks measured, is wrong-low, and yields
//   a cost per verified artifact that looks like a bargain. So an arm with even one
//   unpriced sample must report its DOLLAR cost UNKNOWN, must carry no cost fields at all,
//   and must say so in the rendered output.
//
// AND THE MEASURED FIGURES MUST SURVIVE THAT
//   Dollars being unknown must not leave the campaign with no efficiency metric, because
//   tokens and wall clock ARE measured. So there are tests that an unpriced arm still
//   reports tokens per verified artifact, that both rates are taken over the SAME samples
//   pass@k is taken over, that nothing verified yields `n/a` rather than a division by zero,
//   and that the UNKNOWN wording scopes itself to dollars - pinned, because the previous
//   wording read as "nothing was measured" and that is how this defect was introduced.
//
// The rest pins the estimators: pass@k comes from the harness's own estimator over
// the persisted records, first-try is a pass at iteration 1, and `loopPassGoldenFail` -
// the bugs our own testbench missed - is surfaced on its own line rather than buried.

import { describe, expect, it } from 'vitest';

import type { MutationOperatorId, MutationSampleCounts } from '../mutation-control.js';
import type { NoVerdictCause } from '../no-verdict-cause.js';

import { renderSummary, summarizeRecords, type SweepSummary } from './summary.js';
import { RESULTS_SCHEMA_VERSION, type SweepSampleRecord } from './results-log.js';

/**
 * Summarize a clean results file: no corruption and no stale-schema lines.
 *
 * Almost every test here is about aggregation, not file health, so the health argument is
 * defaulted in one place. The stale-schema refusal calls `summarizeRecords` directly,
 * because for that behaviour the health IS the subject.
 */
function summarize(
  records: readonly SweepSampleRecord[],
  ks: readonly number[],
  configHash: string | null,
  malformedLines = 0,
): SweepSummary {
  return summarizeRecords(records, ks, configHash, { malformedLines, staleSchemaLines: 0 });
}

/** One record; every field defaulted so a test states only what it is about. */
function record(overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    configHash: 'cfg1',
    armName: 'glm-5',
    modelSignature: 'zai.glm-5',
    problemId: 'p1',
    sampleIndex: 0,
    seed: 1,
    passed: false,
    outcomeStatus: 'unverified',
    iterations: 3,
    costCents: 1,
    costKnown: true,
    // The default reports a COMPLETE usage picture, so a test that says nothing about
    // tokens still exercises the measured path rather than the floor path.
    promptTokens: 800,
    completionTokens: 200,
    totalTokens: 1_000,
    unreportedUsageCalls: 0,
    stopReason: 'max-iterations',
    goldenVerdict: 'failed',
    goldenFailureCount: 2,
    // The default is a CHECKED, valid instrument, so a test that says nothing about the
    // positive control still exercises the normal path: the sample is admissible and pass@k
    // is a validated number.
    instrumentValidity: 'valid',
    instrumentDefect: null,
    // The default carries a PROBED negative control that killed every VALID mutant, so a test
    // which says nothing about mutation still exercises the current, full standard: the sample
    // is admissible because BOTH controls passed.
    mutation: {
      validCount: 5,
      killedCount: 5,
      noVerdictKills: 0,
      coverageGapOperators: [],
      candidateEquivalentOperators: [],
      goldenSurvivedCount: 3,
      goldenTimeoutCount: 0,
      nonCompilingCount: 2,
      goldenErroredCount: 0,
      elapsedMs: 4_000,
    },
    durationMs: 1_000,
    completedAtMs: 1_000,
    failureNote: null,
    // The default sample has an oracle verdict, so it carries no cause. A test about the
    // deferred announcement sets this, because there the cause IS the subject.
    noVerdictCause: null,
    ...overrides,
  };
}

/** A passing record with the given iteration count. */
function pass(overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
  return record({
    passed: true,
    outcomeStatus: 'verified',
    iterations: 1,
    goldenVerdict: 'passed',
    goldenFailureCount: 0,
    stopReason: null,
    ...overrides,
  });
}

describe('summarizeRecords - pass@k', () => {
  it('computes pass@1 as the per-problem pass rate averaged over problems', () => {
    const summary = summarize(
      [
        pass({ problemId: 'p1', sampleIndex: 0 }),
        record({ problemId: 'p1', sampleIndex: 1 }),
        record({ problemId: 'p2', sampleIndex: 0 }),
        record({ problemId: 'p2', sampleIndex: 1 }),
      ],
      [1],
      'cfg1',
      0,
    );
    // p1: 1 of 2 -> 0.5, p2: 0 of 2 -> 0. Mean 0.25.
    expect(summary.arms[0]?.passAtK[1]).toBeCloseTo(0.25, 10);
  });

  it('computes pass@n as 1 for a problem with at least one pass', () => {
    const summary = summarize(
      [pass({ sampleIndex: 0 }), record({ sampleIndex: 1 })],
      [2],
      'cfg1',
      0,
    );
    expect(summary.arms[0]?.passAtK[2]).toBe(1);
  });

  it('does not let a duplicated line inflate the sample denominator', () => {
    const duplicated = [pass({ sampleIndex: 0 }), pass({ sampleIndex: 0 })];
    expect(summarize(duplicated, [1], 'cfg1', 0).arms[0]?.passAtK[1]).toBe(1);
  });
});

describe('summarizeRecords - first-try versus repaired', () => {
  it('counts a pass at iteration 1 as first-try and a later pass as repaired', () => {
    const summary = summarize(
      [
        pass({ problemId: 'p1', sampleIndex: 0, iterations: 1 }),
        pass({ problemId: 'p1', sampleIndex: 1, iterations: 4 }),
        record({ problemId: 'p1', sampleIndex: 2 }),
      ],
      [1],
      'cfg1',
      0,
    );
    const arm = summary.arms[0];
    expect(arm?.firstTrySamples).toBe(1);
    expect(arm?.repairedSamples).toBe(1);
    expect(arm?.firstTryRate).toBeCloseTo(1 / 3, 10);
    expect(arm?.meanIterationsToPass).toBeCloseTo(2.5, 10);
  });

  it('reports no mean iterations-to-pass when nothing passed', () => {
    expect(summarize([record()], [1], 'cfg1', 0).arms[0]?.meanIterationsToPass).toBeNull();
  });
});

describe('summarizeRecords - cost when prices are known', () => {
  it('totals and averages the cost and reports cost per verified artifact', () => {
    const summary = summarize(
      [pass({ sampleIndex: 0, costCents: 4 }), record({ sampleIndex: 1, costCents: 6 })],
      [1],
      'cfg1',
      0,
    );
    const cost = summary.arms[0]?.cost;
    expect(cost?.known).toBe(true);
    if (cost?.known !== true) {
      throw new Error('expected a known cost');
    }
    expect(cost.totalCents).toBe(10);
    expect(cost.meanCentsPerSample).toBe(5);
    expect(cost.costPerVerifiedCents).toBe(10);
  });

  it('reports no cost per verified artifact when the arm verified nothing', () => {
    const summary = summarize([record({ costCents: 3 })], [1], 'cfg1', 0);
    const cost = summary.arms[0]?.cost;
    if (cost?.known !== true) {
      throw new Error('expected a known cost');
    }
    expect(cost.costPerVerifiedCents).toBeNull();
  });
});

describe('summarizeRecords - UNKNOWN cost is never rendered as zero', () => {
  it('reports the whole arm UNKNOWN when a single sample had an unpriced model', () => {
    const summary = summarize(
      [pass({ sampleIndex: 0, costCents: 4 }), record({ sampleIndex: 1, costKnown: false })],
      [1],
      'cfg1',
      0,
    );
    expect(summary.arms[0]?.cost).toEqual({ known: false });
  });

  it('carries NO cost fields at all in the unknown case, so nothing reads as free', () => {
    const summary = summarize([record({ costKnown: false })], [1], 'cfg1', 0);
    const cost = summary.arms[0]?.cost;
    expect(cost === undefined ? [] : Object.keys(cost)).toEqual(['known']);
  });

  it('says UNKNOWN in the rendered output and omits cost per verified artifact', () => {
    const summary = summarize([pass({ costKnown: false, costCents: 0 })], [1], 'cfg1', 0);
    const text = renderSummary(summary).join('\n');
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('no configured price');
    expect(text).not.toContain('cost/verified');
    expect(text).not.toContain('total 0.00c');
  });
});

describe('summarizeRecords - MEASURED efficiency needs no price table', () => {
  it('given priced-free records, when summarized, then tokens per verified artifact is real', () => {
    // The whole point: no `prices` entry is involved anywhere below, yet an efficiency
    // number comes out, because tokens are reported by the endpoint and dollars are not.
    const summary = summarize(
      [
        pass({ sampleIndex: 0, costKnown: false, totalTokens: 4_000, durationMs: 1_000 }),
        record({ sampleIndex: 1, costKnown: false, totalTokens: 2_000, durationMs: 3_000 }),
      ],
      [1],
      'cfg1',
    );

    const efficiency = summary.arms[0]?.efficiency;
    expect(summary.arms[0]?.cost).toEqual({ known: false });
    expect(efficiency?.tokensPerVerified).toBe(6_000);
    expect(efficiency?.msPerVerified).toBe(4_000);
  });

  it('given several samples, when summarized, then the arm-wide totals cover all of them', () => {
    const summary = summarize(
      [
        pass({ sampleIndex: 0, promptTokens: 900, completionTokens: 100, totalTokens: 1_000 }),
        record({ sampleIndex: 1, promptTokens: 400, completionTokens: 600, totalTokens: 1_000 }),
      ],
      [1],
      'cfg1',
    );

    expect(summary.arms[0]?.efficiency.recorded).toEqual({
      samples: 2,
      promptTokens: 1_300,
      completionTokens: 700,
      totalTokens: 2_000,
      unreportedUsageCalls: 0,
      wallClockMs: 2_000,
    });
  });

  it('given a host total above prompt + completion, when summarized, then it is not re-derived', () => {
    const summary = summarize(
      [pass({ promptTokens: 100, completionTokens: 100, totalTokens: 900 })],
      [1],
      'cfg1',
    );

    // Cached/reasoning tokens land in the provider's own total; summing the split would
    // silently under-report them.
    expect(summary.arms[0]?.efficiency.recorded.totalTokens).toBe(900);
    expect(summary.arms[0]?.efficiency.tokensPerVerified).toBe(900);
  });
});

describe('summarizeRecords - the per-artifact rates use the pass@k population', () => {
  it('given an instrument-invalid sample, when summarized, then its tokens are excluded', () => {
    // THE INVARIANT. A sample excluded from pass@k contributes neither tokens to the
    // numerator nor a verified artifact to the divisor, so an arm cannot improve its
    // efficiency by producing samples pass@k refuses to count.
    const summary = summarize(
      [
        pass({ sampleIndex: 0, totalTokens: 1_000, durationMs: 500 }),
        pass({
          sampleIndex: 1,
          instrumentValidity: 'invalid',
          instrumentDefect: 'TESTBENCH_FAILED_REFERENCE',
          totalTokens: 900_000,
          durationMs: 900_000,
        }),
      ],
      [1],
      'cfg1',
    );

    const efficiency = summary.arms[0]?.efficiency;
    expect(efficiency?.population.samples).toBe(1);
    expect(efficiency?.verifiedArtifacts).toBe(1);
    expect(efficiency?.tokensPerVerified).toBe(1_000);
    expect(efficiency?.msPerVerified).toBe(500);
    // Still visible as consumption, because that sample was paid for.
    expect(efficiency?.recorded.totalTokens).toBe(901_000);
  });

  it('given a no-verdict sample, when summarized, then it is out of the population too', () => {
    const summary = summarize(
      [
        pass({ sampleIndex: 0, totalTokens: 600, durationMs: 200 }),
        record({
          sampleIndex: 1,
          outcomeStatus: 'setup-failed',
          instrumentValidity: 'unchecked',
          totalTokens: 50_000,
          durationMs: 50_000,
        }),
      ],
      [1],
      'cfg1',
    );

    expect(summary.arms[0]?.efficiency.population.totalTokens).toBe(600);
    expect(summary.arms[0]?.efficiency.tokensPerVerified).toBe(600);
  });

  it('given no control at all, when summarized, then the population is the verdict-bearing set', () => {
    // With no instrument evidence pass@k falls back to the verdict-bearing records, and the
    // rates must follow it rather than silently using a third population.
    const summary = summarize(
      [
        pass({ sampleIndex: 0, instrumentValidity: 'unchecked', totalTokens: 800 }),
        record({
          sampleIndex: 1,
          instrumentValidity: 'unchecked',
          outcomeStatus: 'blocked',
          totalTokens: 70_000,
        }),
      ],
      [1],
      'cfg1',
    );

    expect(summary.arms[0]?.passAtKValidated).toBe(false);
    expect(summary.arms[0]?.efficiency.population.samples).toBe(1);
    expect(summary.arms[0]?.efficiency.tokensPerVerified).toBe(800);
  });
});

describe('summarizeRecords - nothing verified means n/a, never a division by zero', () => {
  it('given no verified sample, when summarized, then both rates are null', () => {
    const summary = summarize([record({ totalTokens: 5_000, durationMs: 7_000 })], [1], 'cfg1');

    const efficiency = summary.arms[0]?.efficiency;
    expect(efficiency?.verifiedArtifacts).toBe(0);
    expect(efficiency?.tokensPerVerified).toBeNull();
    expect(efficiency?.msPerVerified).toBeNull();
    // The consumption itself is still reported: it happened and it cost something.
    expect(efficiency?.population.totalTokens).toBe(5_000);
  });

  it('given no verified sample, when rendered, then it says n/a rather than 0 or Infinity', () => {
    const text = renderSummary(
      summarize([record({ totalTokens: 5_000, durationMs: 7_000 })], [1], 'cfg1'),
    ).join('\n');

    expect(text).toContain('tokens/verified: n/a (no verified artifact; 5000 tok');
    expect(text).toContain('wall/verified:   n/a (no verified artifact; 7000ms');
    expect(text).not.toContain('Infinity');
    expect(text).not.toContain('NaN');
  });
});

describe('renderSummary - the measured figures are reported whether or not dollars are', () => {
  it('given no prices, when rendered, then tokens and wall clock are still reported', () => {
    const text = renderSummary(
      summarize(
        [
          pass({
            costKnown: false,
            costCents: 0,
            promptTokens: 900,
            completionTokens: 100,
            totalTokens: 1_000,
            durationMs: 2_500,
          }),
        ],
        [1],
        'cfg1',
      ),
    ).join('\n');

    expect(text).toContain('tokens:          prompt 900  completion 100  total 1000');
    expect(text).toContain('tokens/verified: 1000 tok');
    expect(text).toContain('wall/verified:   2500ms');
  });

  it('given no prices, when rendered, then UNKNOWN says only the DOLLAR figure is missing', () => {
    // PINNED WORDING. The old message said cost could not be measured without prices, which
    // an operator correctly read as "nothing was measured". It must now scope the gap to
    // dollars and point at the measured figures, or the same misreading returns.
    const text = renderSummary(
      summarize([pass({ costKnown: false, costCents: 0 })], [1], 'cfg1'),
    ).join('\n');

    expect(text).toContain('cost (dollars):  UNKNOWN');
    expect(text).toContain('no price is ever assumed');
    expect(text).toContain('This is the ONLY unmeasured figure in this');
    expect(text).toContain('tokens and wall clock per verified artifact above ARE measured');
    expect(text).toContain('are the primary efficiency numbers');
    expect(text).toContain('Set prices.<modelId> in the');
  });

  it('given prices, when rendered, then the dollar figures appear beside the measured ones', () => {
    const text = renderSummary(
      summarize(
        [
          pass({ sampleIndex: 0, costKnown: true, costCents: 4, totalTokens: 1_000 }),
          record({ sampleIndex: 1, costKnown: true, costCents: 6, totalTokens: 1_000 }),
        ],
        [1],
        'cfg1',
      ),
    ).join('\n');

    expect(text).toContain('cost (dollars):  total 10.00c, mean 5.00c/sample');
    expect(text).toContain('cost/verified:   10.00c');
    // And the measured figures do not disappear once a price exists: 2000 tokens over the
    // two pass@k samples, one of which verified.
    expect(text).toContain('tokens/verified: 2000 tok  (2000 tok / 1 verified');
  });

  it('given a silent provider, when rendered, then the token totals are labeled a FLOOR', () => {
    const text = renderSummary(
      summarize([pass({ unreportedUsageCalls: 2, totalTokens: 400 })], [1], 'cfg1'),
    ).join('\n');

    expect(text).toContain('usage unreported: 2 model call(s) returned no usable usage block');
    expect(text).toContain('token figure above is a FLOOR');
  });

  it('given complete usage, when rendered, then no FLOOR warning is printed', () => {
    const text = renderSummary(summarize([pass()], [1], 'cfg1')).join('\n');

    expect(text).not.toContain('usage unreported');
    expect(text).not.toContain('FLOOR');
  });
});

describe('summarizeRecords - the golden-judge agreement', () => {
  it('surfaces loopPassGoldenFail: the bugs our own testbench missed', () => {
    const summary = summarize(
      [
        // Our oracle passed it; the independent golden testbench failed it.
        pass({ sampleIndex: 0, goldenVerdict: 'failed', goldenFailureCount: 3 }),
        pass({ sampleIndex: 1 }),
      ],
      [1],
      'cfg1',
      0,
    );
    const agreement = summary.arms[0]?.agreement;
    expect(agreement?.loopPassGoldenFail).toBe(1);
    expect(agreement?.judgedSamples).toBe(2);
    expect(renderSummary(summary).join('\n')).toContain('MISSED BUGS:     1');
  });

  it('counts an over-strict testbench separately', () => {
    const summary = summarize([record({ passed: false, goldenVerdict: 'passed' })], [1], 'cfg1', 0);
    expect(summary.arms[0]?.agreement.loopFailGoldenPass).toBe(1);
  });

  it('reports NOT MEASURED rather than perfect agreement when nothing was judged', () => {
    const summary = summarize(
      [record({ goldenVerdict: null, goldenFailureCount: null })],
      [1],
      'cfg1',
      0,
    );
    expect(summary.arms[0]?.agreement.judgedSamples).toBe(0);
    expect(renderSummary(summary).join('\n')).toContain('NOT MEASURED');
  });
});

describe('summarizeRecords - scoping and integrity', () => {
  it('excludes records from another experiment when a config hash is supplied', () => {
    const summary = summarize(
      [record({ configHash: 'cfg1' }), record({ configHash: 'cfg2', armName: 'other' })],
      [1],
      'cfg1',
      0,
    );
    expect(summary.arms).toHaveLength(1);
    expect(summary.totalSamples).toBe(1);
  });

  it('summarizes everything present when no config hash is supplied', () => {
    const summary = summarize(
      [record({ configHash: 'cfg1' }), record({ configHash: 'cfg2', armName: 'other' })],
      [1],
      null,
      0,
    );
    expect(summary.arms).toHaveLength(2);
  });

  it('flags an arm name that carries two different model sets, and refuses to endorse it', () => {
    const summary = summarize(
      [
        record({ sampleIndex: 0, modelSignature: 'zai.glm-5' }),
        record({ sampleIndex: 1, modelSignature: 'deepseek.v3.2' }),
      ],
      [1],
      'cfg1',
      0,
    );
    expect(summary.arms[0]?.signatureConflict).toBe(true);
    expect(renderSummary(summary).join('\n')).toContain('do not cite it');
  });

  it('groups arms and reports them in a stable alphabetical order', () => {
    const summary = summarize(
      [record({ armName: 'zeta' }), record({ armName: 'alpha' })],
      [1],
      'cfg1',
      0,
    );
    expect(summary.arms.map((arm) => arm.armName)).toEqual(['alpha', 'zeta']);
  });

  it('tallies outcome statuses so an infrastructure failure is visible, not hidden', () => {
    const summary = summarize(
      [
        record({ sampleIndex: 0, outcomeStatus: 'unverified' }),
        record({ sampleIndex: 1, outcomeStatus: 'runner-error', failureNote: 'harness-error' }),
        record({ sampleIndex: 2, outcomeStatus: 'setup-failed' }),
      ],
      [1],
      'cfg1',
      0,
    );
    expect(summary.arms[0]?.statusCounts).toEqual({
      unverified: 1,
      'runner-error': 1,
      'setup-failed': 1,
    });
  });
});

describe('summarizeRecords - why the no-verdict samples produced no verdict', () => {
  /** A no-verdict record carrying the note the harness derived for it. */
  function noVerdict(note: string, overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
    return record({
      passed: false,
      outcomeStatus: 'setup-failed',
      iterations: 0,
      stopReason: null,
      goldenVerdict: null,
      goldenFailureCount: null,
      // Faithful to production: a sample with no testbench has no instrument to validate.
      instrumentValidity: 'unchecked',
      failureNote: note,
      ...overrides,
    });
  }

  it('groups the notes by reason and reports the most frequent first', () => {
    const summary = summarize(
      [
        noVerdict('generation-unavailable: the host declined', { sampleIndex: 0 }),
        noVerdict('testbench-unavailable: coverage was incomplete', { sampleIndex: 1 }),
        noVerdict('generation-unavailable: the host declined', { sampleIndex: 2 }),
      ],
      [1],
      'cfg1',
      0,
    );

    expect(summary.arms[0]?.noVerdictNotes).toEqual([
      { note: 'generation-unavailable: the host declined', count: 2 },
      { note: 'testbench-unavailable: coverage was incomplete', count: 1 },
    ]);
  });

  it('breaks ties alphabetically, so concurrent completion order cannot reorder it', () => {
    const first = summarize(
      [noVerdict('b-reason', { sampleIndex: 0 }), noVerdict('a-reason', { sampleIndex: 1 })],
      [1],
      'cfg1',
      0,
    );
    const reversed = summarize(
      [noVerdict('a-reason', { sampleIndex: 1 }), noVerdict('b-reason', { sampleIndex: 0 })],
      [1],
      'cfg1',
      0,
    );

    expect(first.arms[0]?.noVerdictNotes.map((entry) => entry.note)).toEqual([
      'a-reason',
      'b-reason',
    ]);
    expect(reversed.arms[0]?.noVerdictNotes).toEqual(first.arms[0]?.noVerdictNotes);
  });

  it('ignores a note on a sample the oracle did judge, because the file is untrusted', () => {
    const summary = summarize(
      [
        pass({ sampleIndex: 0, failureNote: 'hand-edited onto a verified line' }),
        record({ sampleIndex: 1, failureNote: 'hand-edited onto an unverified line' }),
      ],
      [1],
      'cfg1',
      0,
    );

    expect(summary.arms[0]?.noVerdictNotes).toEqual([]);
  });

  it('renders the breakdown beside the status tally, so setup-failed=3 says why', () => {
    const summary = summarize(
      [
        noVerdict('generation-unavailable: the host declined', { sampleIndex: 0 }),
        noVerdict('generation-unavailable: the host declined', { sampleIndex: 1 }),
        noVerdict('generation-unavailable: the host declined', { sampleIndex: 2 }),
      ],
      [1],
      'cfg1',
      0,
    );

    const text = renderSummary(summary).join('\n');
    expect(text).toContain('statuses:        setup-failed=3');
    expect(text).toContain('no-verdict why:  generation-unavailable: the host declined x3');
  });

  it('omits the section entirely when no no-verdict sample carried a note', () => {
    const summary = summarize(
      [
        pass({ sampleIndex: 0 }),
        record({ sampleIndex: 1, outcomeStatus: 'setup-failed', failureNote: null }),
      ],
      [1],
      'cfg1',
      0,
    );

    expect(summary.arms[0]?.noVerdictNotes).toEqual([]);
    expect(renderSummary(summary).join('\n')).not.toContain('no-verdict why');
  });

  it('warns about malformed results lines instead of pretending the file was clean', () => {
    const text = renderSummary(summarize([record()], [1], 'cfg1', 3)).join('\n');
    expect(text).toContain('3 results line(s) could not be decoded');
  });

  it('renders an honest empty report when nothing has been recorded yet', () => {
    const text = renderSummary(summarize([], [1], 'cfg1', 0)).join('\n');
    expect(text).toContain('no samples recorded');
  });
});

// A SUMMARY OF AN INCOMPLETE MATRIX MUST NOT READ AS A COMPLETE ONE
//   Measured on a real calibration pass: 24 healthy samples, then 29 consecutive
//   provider failures from one rate-limit burst, then recovery. All 29 were persisted, so a
//   resume treated them as finished and never took them again - and the run reported itself
//   `completed` with two thirds of its cells empty. pass@k was never wrong; the MATRIX was.
//
//   So these tests pin three things: the deferred count and its TYPED cause are reported, the
//   rendered output announces them before its own totals and refuses to read as complete, and
//   the count leaks into NOTHING - not pass@k, not the controls, not the efficiency population.
describe('summarizeRecords - a deferred slot is announced, never counted as a measurement', () => {
  /**
   * A no-verdict record carrying one TYPED cause.
   *
   * Faithful to production in the fields that decide the outcome: the oracle never spoke, no
   * testbench was ever built (so the instrument is `unchecked` and there is no mutation probe),
   * and the note is the real one - which is exactly the string the cause must NOT be read from.
   */
  function noVerdictCaused(
    cause: NoVerdictCause,
    overrides: Partial<SweepSampleRecord> = {},
  ): SweepSampleRecord {
    return record({
      passed: false,
      outcomeStatus: 'setup-failed',
      iterations: 0,
      stopReason: null,
      goldenVerdict: null,
      goldenFailureCount: null,
      instrumentValidity: 'unchecked',
      mutation: null,
      failureNote: 'testbench-unavailable: ALL_PROVIDERS_FAILED',
      noVerdictCause: cause,
      ...overrides,
    });
  }

  /** One measured cell and three slots that were dispatched and never measured. */
  const holed: readonly SweepSampleRecord[] = [
    pass({ problemId: 'p1', sampleIndex: 0 }),
    noVerdictCaused('provider-unreachable', { problemId: 'p2', sampleIndex: 0 }),
    noVerdictCaused('provider-unreachable', { problemId: 'p3', sampleIndex: 0 }),
    noVerdictCaused('harness-error', { problemId: 'p4', sampleIndex: 0 }),
  ];

  it('given infrastructure causes, when summarized, then the count and the causes are reported', () => {
    const summary = summarize(holed, [1], 'cfg1');

    const arm = summary.arms[0];
    expect(arm?.deferredSamples).toBe(3);
    expect(arm?.deferredCauses).toEqual([
      { cause: 'provider-unreachable', count: 2 },
      { cause: 'harness-error', count: 1 },
    ]);
    // Summed over the arms, so the banner cannot disagree with the arm blocks under it.
    expect(summary.deferredSamples).toBe(3);
  });

  it('given a FINAL cause, when summarized, then the slot is not deferred', () => {
    // A budget cap doing its job is a RESULT: the caps are the experiment, so re-running the
    // slot would only reproduce it. Only infrastructure means "attempted and not measured".
    const summary = summarize([noVerdictCaused('budget-exhausted')], [1], 'cfg1');

    expect(summary.arms[0]?.deferredSamples).toBe(0);
    expect(summary.arms[0]?.deferredCauses).toEqual([]);
    expect(summary.deferredSamples).toBe(0);
  });

  it('given deferred slots, when rendered, then the count and cause lead and it reads incomplete', () => {
    const lines = renderSummary(summarize(holed, [1], 'cfg1'));
    const text = lines.join('\n');

    expect(text).toContain('DEFERRED: 3 slot(s) were ATTEMPTED and NEVER MEASURED');
    expect(text).toContain('THIS IS NOT A COMPLETE MATRIX');
    // Announced FIRST: before the total a reader would otherwise take for the matrix size.
    expect(lines.findIndex((line) => line.startsWith('DEFERRED:'))).toBeLessThan(
      lines.findIndex((line) => line.startsWith('samples aggregated:')),
    );
    // Restated on the arm, so a reader who skipped the banner still cannot read 4 as measured.
    expect(text).toContain(
      'samples:         4 over 4 problems  (3 DEFERRED: attempted, never measured)',
    );
    expect(text).toContain('deferred:        3 of 4 recorded sample(s) were ATTEMPTED');
    expect(text).toContain('NOT A COMPLETE ARM');
    // The typed cause AND its meaning: a rate limit and our own crash need opposite responses.
    expect(text).toContain(
      'deferred why:    provider-unreachable x2 - no provider answered, so nothing about the model was observed',
    );
    expect(text).toContain(
      'harness-error x1 - our own sweep machinery failed before the oracle could speak',
    );
  });

  it('given no deferred slot, when rendered, then no deferred block is printed', () => {
    const summary = summarize([pass({ sampleIndex: 0 }), record({ sampleIndex: 1 })], [1], 'cfg1');

    expect(summary.deferredSamples).toBe(0);
    const text = renderSummary(summary).join('\n');
    expect(text).not.toContain('DEFERRED');
    expect(text).not.toContain('deferred');
  });

  it('given deferred slots beside measured ones, then the count leaks into no other number', () => {
    const measured = [
      pass({ problemId: 'p1', sampleIndex: 0 }),
      record({ problemId: 'p2', sampleIndex: 0 }),
    ];
    const clean = summarize(measured, [1], 'cfg1').arms[0];
    const withHoles = summarize(
      [
        ...measured,
        noVerdictCaused('provider-unreachable', { problemId: 'p3', sampleIndex: 0 }),
        noVerdictCaused('harness-error', { problemId: 'p4', sampleIndex: 0 }),
      ],
      [1],
      'cfg1',
    ).arms[0];

    expect(withHoles?.deferredSamples).toBe(2);
    expect(withHoles?.passAtK[1]).toBe(clean?.passAtK[1]);
    expect(withHoles?.instrument.countedSamples).toBe(clean?.instrument.countedSamples);
    expect(withHoles?.instrument.checkedSamples).toBe(clean?.instrument.checkedSamples);
    expect(withHoles?.instrument.invalidSamples).toBe(clean?.instrument.invalidSamples);
    expect(withHoles?.mutation.probedSamples).toBe(clean?.mutation.probedSamples);
    expect(withHoles?.efficiency.population.samples).toBe(clean?.efficiency.population.samples);
    expect(withHoles?.verifiedSamples).toBe(clean?.verifiedSamples);
    // Nothing is DEDUCTED to make room for them: the slots were dispatched and may have cost
    // tokens, so they stay in the recorded population.
    expect(withHoles?.sampleCount).toBe(4);
  });
});

describe('summarizeRecords - the pass@k denominator invariant', () => {
  /** A record whose instrument the control proved BROKEN. */
  function instrumentInvalid(overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
    return record({
      instrumentValidity: 'invalid',
      instrumentDefect: 'TESTBENCH_FAILED_REFERENCE',
      ...overrides,
    });
  }

  it('counts a sample only when the oracle judged it AND its instrument is valid', () => {
    const summary = summarize(
      [
        // Counted: judged, valid instrument, passed.
        pass({ problemId: 'p1', sampleIndex: 0 }),
        // Counted: judged, valid instrument, did not pass.
        record({ problemId: 'p1', sampleIndex: 1 }),
        // Excluded: no oracle verdict.
        record({
          problemId: 'p1',
          sampleIndex: 2,
          outcomeStatus: 'setup-failed',
          instrumentValidity: 'unchecked',
        }),
        // Excluded: the instrument is proven broken.
        instrumentInvalid({ problemId: 'p1', sampleIndex: 3 }),
      ],
      [1],
      'cfg1',
    );

    const arm = summary.arms[0];
    // 1 of the 2 eligible samples passed, so pass@1 is 0.5 - NOT 1/4 and NOT 1/3.
    expect(arm?.passAtK[1]).toBeCloseTo(0.5, 10);
    expect(arm?.instrument.countedSamples).toBe(2);
    expect(arm?.passAtKValidated).toBe(true);
  });

  it('EXCLUDES an instrument-invalid sample from the denominator while still reporting it', () => {
    // The measured regression: our testbench rejects the reference, so this sample says
    // nothing about the model. It must not be a model failure, and it must not vanish.
    const summary = summarize(
      [
        pass({ problemId: 'p1', sampleIndex: 0 }),
        instrumentInvalid({ problemId: 'p1', sampleIndex: 1 }),
      ],
      [1],
      'cfg1',
    );

    const arm = summary.arms[0];
    expect(arm?.passAtK[1]).toBe(1);
    expect(arm?.instrument.invalidSamples).toBe(1);
    // Still present in the arm's own sample count, so the denominator change is visible.
    expect(arm?.sampleCount).toBe(2);
  });

  it('excludes a judged-but-unchecked sample and reports it as its own population', () => {
    const summary = summarize(
      [
        pass({ problemId: 'p1', sampleIndex: 0 }),
        record({ problemId: 'p1', sampleIndex: 1, instrumentValidity: 'unchecked' }),
      ],
      [1],
      'cfg1',
    );

    const arm = summary.arms[0];
    expect(arm?.instrument.countedSamples).toBe(1);
    expect(arm?.instrument.uncheckedWithVerdict).toBe(1);
    expect(renderSummary(summary).join('\n')).toContain('instrument-unchecked: 1');
  });

  it('falls back to the verdict-bearing estimate and labels it UNVALIDATED with no control', () => {
    const summary = summarize(
      [
        pass({ problemId: 'p1', sampleIndex: 0, instrumentValidity: 'unchecked' }),
        record({ problemId: 'p1', sampleIndex: 1, instrumentValidity: 'unchecked' }),
      ],
      [1],
      'cfg1',
    );

    const arm = summary.arms[0];
    expect(arm?.passAtKValidated).toBe(false);
    // Reported, not zeroed: a flat 0 would read as a total model failure.
    expect(arm?.passAtK[1]).toBeCloseTo(0.5, 10);
    const text = renderSummary(summary).join('\n');
    expect(text).toContain('UNVALIDATED');
    expect(text).toContain('instrument:      NOT MEASURED');
  });

  it('keeps a no-verdict sample out of the denominator even in the unvalidated fallback', () => {
    const summary = summarize(
      [
        pass({ problemId: 'p1', sampleIndex: 0, instrumentValidity: 'unchecked' }),
        record({
          problemId: 'p1',
          sampleIndex: 1,
          outcomeStatus: 'setup-failed',
          instrumentValidity: 'unchecked',
        }),
      ],
      [1],
      'cfg1',
    );

    // 1 of 1 judged sample passed; the never-judged sample is not a model failure.
    expect(summary.arms[0]?.passAtK[1]).toBe(1);
  });
});

describe('summarizeRecords - instrument-invalid is a first-class reported number', () => {
  it('prints the instrument-invalid line with the compile-versus-fail split', () => {
    const summary = summarize(
      [
        record({
          sampleIndex: 0,
          instrumentValidity: 'invalid',
          instrumentDefect: 'TESTBENCH_FAILED_REFERENCE',
        }),
        record({
          sampleIndex: 1,
          instrumentValidity: 'invalid',
          instrumentDefect: 'TESTBENCH_REFERENCE_UNBUILDABLE',
        }),
        pass({ sampleIndex: 2 }),
      ],
      [1],
      'cfg1',
    );

    const text = renderSummary(summary).join('\n');
    // The same key whether or not any turned up, so a campaign's summaries are greppable.
    expect(text).toContain('instrument-invalid: 2');
    expect(text).toContain('OUR TESTBENCH IS NOT A MEASURING STICK');
    expect(text).toContain('rejected-reference 1');
    expect(text).toContain('did-not-build 1');
  });

  it('splits the survived-mutants defect out from the rejected-reference one', () => {
    // The two point at opposite repairs: a rejected reference means the testbench expects too
    // much, a survived mutant means it checks too little. Blending them would misdirect a fix.
    const summary = summarize(
      [
        record({
          sampleIndex: 0,
          instrumentValidity: 'invalid',
          instrumentDefect: 'TESTBENCH_FAILED_REFERENCE',
        }),
        record({
          sampleIndex: 1,
          instrumentValidity: 'invalid',
          instrumentDefect: 'TESTBENCH_SURVIVED_MUTANTS',
          mutation: {
            validCount: 8,
            killedCount: 2,
            noVerdictKills: 0,
            coverageGapOperators: ['ARITH_PLUS_TO_MINUS', 'CONDITION_NEGATED'],
            candidateEquivalentOperators: [],
            goldenSurvivedCount: 4,
            goldenTimeoutCount: 0,
            nonCompilingCount: 1,
            goldenErroredCount: 0,
            elapsedMs: 7_000,
          },
        }),
      ],
      [1],
      'cfg1',
    );

    expect(summary.arms[0]?.instrument.survivedMutantsSamples).toBe(1);
    expect(summary.arms[0]?.instrument.failedReferenceSamples).toBe(1);
    const text = renderSummary(summary).join('\n');
    expect(text).toContain('survived-mutants 1');
    expect(text).toContain('rejected-reference 1');
  });

  it('prints a zero instrument-invalid line for a clean, controlled arm', () => {
    const text = renderSummary(summarize([pass()], [1], 'cfg1')).join('\n');
    expect(text).toContain('instrument-invalid: 0');
  });

  it('does not blend an invalid-instrument over-strict sample into the agreement numbers', () => {
    const summary = summarize(
      [
        // Our testbench failed it, golden passed it, AND our testbench rejects the reference.
        record({
          sampleIndex: 0,
          passed: false,
          goldenVerdict: 'passed',
          goldenFailureCount: 0,
          instrumentValidity: 'invalid',
          instrumentDefect: 'TESTBENCH_FAILED_REFERENCE',
        }),
        pass({ sampleIndex: 1 }),
      ],
      [1],
      'cfg1',
    );

    const arm = summary.arms[0];
    // The disagreement is attributed to our own broken instrument, not chased as a model
    // or judge problem.
    expect(arm?.agreement.loopFailGoldenPass).toBe(0);
    expect(arm?.agreement.judgedSamples).toBe(1);
    expect(arm?.instrument.invalidOverStrict).toBe(1);
    const text = renderSummary(summary).join('\n');
    expect(text).toContain('NOT counted in the agreement numbers above');
    expect(text).toContain('over-strict 1');
  });
});

describe('summarizeRecords - the NEGATIVE control block', () => {
  /** A record whose probe killed `killedCount` of eight VALID mutants, with the given gaps. */
  function probed(
    killedCount: number,
    coverageGapOperators: readonly MutationOperatorId[],
    overrides: Partial<SweepSampleRecord> = {},
    mutationOverrides: Partial<MutationSampleCounts> = {},
  ): SweepSampleRecord {
    return record({
      mutation: {
        validCount: 8,
        killedCount,
        noVerdictKills: 0,
        coverageGapOperators,
        candidateEquivalentOperators: [],
        goldenSurvivedCount: 5,
        goldenTimeoutCount: 0,
        nonCompilingCount: 3,
        goldenErroredCount: 0,
        elapsedMs: 6_000,
        ...mutationOverrides,
      },
      ...overrides,
    });
  }

  it('reports the kill rate over VALID mutants, naming the denominator in the line', () => {
    const summary = summarize(
      [
        probed(6, ['ARITH_PLUS_TO_MINUS', 'CONST_ZERO_TO_ONE'], { sampleIndex: 0 }),
        probed(8, [], { sampleIndex: 1 }),
      ],
      [1],
      'cfg1',
    );

    expect(summary.arms[0]?.mutation.killedMutants).toBe(14);
    expect(summary.arms[0]?.mutation.validMutants).toBe(16);
    const text = renderSummary(summary).join('\n');
    // `valid` is stated in the rendered line, because the denominator used to be the much
    // smaller golden-detectable set and an operator comparing runs must see the difference.
    expect(text).toContain('killed 14/16 valid mutant(s) (kill rate 0.875)');
  });

  it('reports the judge blindness as information, NOT as an exclusion', () => {
    const text = renderSummary(summarize([probed(8, [])], [1], 'cfg1')).join('\n');

    // The wording matters as much as the number: these mutants stay IN the denominator, and the
    // old summary said `EXCLUDED ... as undetectable`, which is the claim being retracted.
    expect(text).toContain('3 mutant(s) did not build and 0 produced nothing at all');
    expect(text).toContain('both are OUT of the denominator');
    expect(text).toContain(
      'golden testbench is blind to 5 of the valid one(s), which are still IN',
    );
    expect(text).not.toContain('EXCLUDED');
  });

  it('names the HANG share of the gate set, so it cannot read as demonstrated coverage', () => {
    // GIVEN an arm whose golden kills are partly hangs.
    const text = renderSummary(
      summarize([probed(8, [], {}, { goldenTimeoutCount: 2 })], [1], 'cfg1'),
    ).join('\n');

    // THEN the summary says so, in the same discipline as `kills w/o verdict` on our own side: a
    // hang is gated but is NOT a demonstration that the defect class is detectable.
    expect(text).toContain('2 of the golden kill(s) came from the judge NOT TERMINATING');
  });

  it('stays quiet about hangs when there were none, so a clean arm gains no noise', () => {
    const text = renderSummary(summarize([probed(8, [])], [1], 'cfg1')).join('\n');

    expect(text).not.toContain('NOT TERMINATING');
  });

  it('counts the per-problem calibration facts once per PROBLEM, even across many samples', () => {
    // Two samples of one problem share one calibration; summing would report the judge as blind
    // to 10 mutants where 5 exist.
    const summary = summarize(
      [
        probed(8, [], { problemId: 'p1', sampleIndex: 0 }),
        probed(8, [], { problemId: 'p1', sampleIndex: 1 }),
      ],
      [1],
      'cfg1',
    );

    expect(summary.arms[0]?.mutation.goldenSurvivedMutants).toBe(5);
    expect(summary.arms[0]?.mutation.nonCompilingMutants).toBe(3);
  });

  it('prints the COVERAGE GAPS, most frequent first - the actionable line', () => {
    const summary = summarize(
      [
        probed(6, ['ARITH_PLUS_TO_MINUS', 'CONST_ZERO_TO_ONE'], { problemId: 'p1' }),
        probed(7, ['ARITH_PLUS_TO_MINUS'], { problemId: 'p2' }),
      ],
      [1],
      'cfg1',
    );

    const text = renderSummary(summary).join('\n');
    expect(text).toContain('COVERAGE GAPS:   ARITH_PLUS_TO_MINUS x2  CONST_ZERO_TO_ONE x1');
    expect(text).toContain('a defect class the golden');
    expect(text).toContain('testbench catches and ours does not');
    // And the output says outright that this is the line that gated, so an operator does not
    // have to infer it from a kill rate that no longer decides anything.
    expect(text).toContain('THE GATE, and it is NOT met');
  });

  it('marks the kill rate as a signal that does NOT gate, beside the line that does', () => {
    // The two numbers used to be one: a 0.95 bar over the kill rate WAS the gate, until it was
    // measured to fail good instruments. An operator comparing two summaries must not assume the
    // familiar number still decides anything, so the block says which is which.
    const text = renderSummary(summarize([probed(8, [])], [1], 'cfg1')).join('\n');

    expect(text).toContain('quality SIGNAL, does NOT gate');
    expect(text).toContain('The gate is the coverage-gap line below');
    expect(text).toContain('GATE, and it is met');
  });

  it('prints the candidate-equivalent bucket SEPARATELY, flagged for review not as a defect', () => {
    // The bucket that used to be silently excluded, then briefly counted against validity. It
    // must be visible, must be marked as undecided rather than as a gap, must say it is not a
    // gate failure, and must say it still counts against the kill rate.
    const summary = summarize(
      [
        record({
          mutation: {
            validCount: 6,
            killedCount: 4,
            noVerdictKills: 0,
            coverageGapOperators: [],
            candidateEquivalentOperators: ['RESET_BRANCH_DISABLED', 'RESET_BRANCH_DISABLED'],
            goldenSurvivedCount: 4,
            goldenTimeoutCount: 0,
            nonCompilingCount: 0,
            goldenErroredCount: 0,
            elapsedMs: 6_000,
          },
        }),
      ],
      [1],
      'cfg1',
    );

    const text = renderSummary(summary).join('\n');
    expect(text).toContain('review-equiv:    RESET_BRANCH_DISABLED x2');
    expect(text).toContain('MAY be equivalent mutants');
    expect(text).toContain('Review items, NOT gate failures');
    expect(text).toContain('still count against the kill rate above');
    // And it is NOT presented as a coverage gap, which is the stronger, actionable claim.
    expect(text).toContain('coverage gaps:   none');
  });

  it('says plainly that there are no coverage gaps, rather than printing an empty list', () => {
    const text = renderSummary(summarize([probed(8, [])], [1], 'cfg1')).join('\n');

    expect(text).toContain(
      'coverage gaps:   none - our testbench killed every mutant the golden judge kills',
    );
  });

  it('surfaces a timeout-heavy kill count, so it cannot read as coverage', () => {
    const summary = summarize(
      [
        record({
          mutation: {
            validCount: 8,
            killedCount: 8,
            noVerdictKills: 7,
            coverageGapOperators: [],
            candidateEquivalentOperators: [],
            goldenSurvivedCount: 2,
            goldenTimeoutCount: 0,
            nonCompilingCount: 0,
            goldenErroredCount: 0,
            elapsedMs: 6_000,
          },
        }),
      ],
      [1],
      'cfg1',
    );

    const text = renderSummary(summary).join('\n');
    expect(text).toContain('kills w/o verdict: 7/8 kill(s) came from a timeout or crash');
    expect(text).toContain('a timeout-heavy kill rate is suspect');
  });

  it('prints no timeout line at all when every kill was a reported failure', () => {
    const text = renderSummary(summarize([probed(8, [])], [1], 'cfg1')).join('\n');

    expect(text).not.toContain('kills w/o verdict');
  });

  it('reports the added wall clock, so the cost of the control is visible', () => {
    const text = renderSummary(summarize([probed(8, [])], [1], 'cfg1')).join('\n');

    expect(text).toContain('mutation cost:   mean 6000ms added per probed sample');
  });

  it('reports NOT MEASURED, and says what instrument-valid then means, when nothing was probed', () => {
    const summary = summarize([pass({ mutation: null })], [1], 'cfg1');

    expect(summary.arms[0]?.mutation.probedSamples).toBe(0);
    const text = renderSummary(summary).join('\n');
    expect(text).toContain('mutation:        NOT MEASURED');
    // The weaker standard is LABELLED, so a positive-control-only `valid` is never cited as the
    // full one.
    expect(text).toContain('it does NOT');
    expect(text).toContain('rule out a testbench that passes everything');
  });
});

describe('summarizeRecords - an older record schema is REFUSED, never migrated', () => {
  it('aggregates nothing and says what to do when a stale line is present', () => {
    const summary = summarizeRecords([pass()], [1], 'cfg1', {
      malformedLines: 0,
      staleSchemaLines: 6,
    });

    expect(summary.refusedStaleSchema).toBe(true);
    expect(summary.arms).toEqual([]);
    expect(summary.totalSamples).toBe(0);
    const text = renderSummary(summary).join('\n');
    expect(text).toContain('REFUSED: 6 results line(s) use an older record schema');
    expect(text).toContain('re-run the campaign into a FRESH outputDir');
    // No arm block may be rendered, so no number can be misread as a result.
    expect(text).not.toContain('pass@1');
  });

  it('aggregates normally when the file is clean', () => {
    const summary = summarizeRecords([pass()], [1], 'cfg1', {
      malformedLines: 0,
      staleSchemaLines: 0,
    });

    expect(summary.refusedStaleSchema).toBe(false);
    expect(summary.arms).toHaveLength(1);
  });
});
