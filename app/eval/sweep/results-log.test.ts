// Unit tests for the results log: the record round-trip, the untrusted-input decoding,
// and the RESUME/SKIP decision.
//
// Two properties matter most here and both are about money and honesty:
//   1. A sample already recorded for THIS config is skipped, so a resumed run does not
//      re-pay for it.
//   2. A record from a DIFFERENT config is invisible to the resume index, so resuming the
//      wrong experiment cannot silently reuse another run's samples.
// A corrupt line must be counted and skipped, never repaired into a plausible sample.
//
// The third subject is the GOLDEN OUTCOME VOCABULARY. A record's `goldenVerdict` is what the
// golden pass@k denominator is decided from, so the decoder must accept exactly the five
// recorded kinds and refuse everything else - including `error`, the banner-grammar value
// older records carry, whose three causes cannot be recovered from a line that collapsed them.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { RECORDED_GOLDEN_KINDS } from '../golden-judge.js';
import type { InstrumentUncheckedReason } from '../instrument-control.js';
import type { MutationSampleCounts } from '../mutation-control.js';
import {
  CompletedSampleIndex,
  decodeSampleRecord,
  encodeSampleRecord,
  instrumentVerdictOf,
  MAX_RECORDED_SURVIVORS,
  parseResultsLog,
  RESULTS_SCHEMA_VERSION,
  sampleKey,
  STALE_SCHEMA_ADVICE,
  type SweepSampleRecord,
} from './results-log.js';
import { summarizeRecords } from './summary.js';

/** A complete, valid record; each test overrides only the field it is about. */
function record(overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    configHash: 'abc123',
    armName: 'glm-5',
    modelSignature: 'zai.glm-5',
    problemId: 'rtllm/arithmetic/adder_8bit',
    sampleIndex: 0,
    seed: 12345,
    passed: true,
    outcomeStatus: 'verified',
    iterations: 1,
    costCents: 3.5,
    costKnown: true,
    // The default reports a COMPLETE usage picture: every model call metered, so the token
    // counts are measurements rather than floors. A test about missing usage says so.
    promptTokens: 1_200,
    completionTokens: 300,
    totalTokens: 1_500,
    unreportedUsageCalls: 0,
    stopReason: null,
    goldenVerdict: 'passed',
    goldenFailureCount: 0,
    instrumentValidity: 'valid',
    instrumentDefect: null,
    // The default is a CHECKED instrument, so there is no unchecked reason to carry. A test
    // about `unchecked` sets `instrumentValidity` and this field together.
    instrumentUncheckedReason: null,
    // The default carries a PROBED negative control that killed everything, so a test which
    // says nothing about mutation still exercises the normal current-standard path.
    mutation: {
      validCount: 4,
      killedCount: 4,
      noVerdictKills: 0,
      coverageGapOperators: [],
      candidateEquivalentOperators: [],
      goldenSurvivedCount: 2,
      goldenTimeoutCount: 0,
      nonCompilingCount: 1,
      goldenErroredCount: 0,
      elapsedMs: 3_200,
    },
    // The default sample's testbench passed on the first draft, so there is no repair to
    // report. A test about the repair fields sets both explicitly, because a record claiming
    // `repairAccepted` without `repairAttempted` is refused (see the round-trip tests below).
    repairAttempted: false,
    repairAccepted: false,
    // No repair was attempted, so there is no decline stage to name. A test about
    // `repairDeclineReason` sets `repairAttempted` and `repairAccepted` explicitly too,
    // because a declined-but-unnamed (or accepted-but-named) record is refused.
    repairDeclineReason: null,
    // The default sample's testbench was unchanged by normalization, so there is no
    // visibility gap to report. A test about the signal sets it explicitly.
    checkNameVisibilitySignal: false,
    durationMs: 42_000,
    completedAtMs: 1_700_000_000_000,
    failureNote: null,
    // The default sample reached an oracle verdict, so there is no cause to record. A test
    // about resume or deferral sets this explicitly, because it is the whole subject there.
    noVerdictCause: null,
    ...overrides,
  };
}

/**
 * A valid record with exactly one field absent, as a hand-edited line or a line written
 * by an older build would arrive.
 *
 * Named rather than destructured-and-discarded so the omitted field is stated once and
 * the test body says only what it is asserting.
 */
function recordWithout(omitted: keyof SweepSampleRecord): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record()).filter(([field]) => field !== omitted));
}

describe('sample record round-trip', () => {
  it('encodes and decodes without losing a field', () => {
    const original = record();
    expect(decodeSampleRecord(JSON.parse(encodeSampleRecord(original)))).toEqual(original);
  });

  it('preserves a failed sample with its sanitized note', () => {
    const failed = record({
      passed: false,
      outcomeStatus: 'runner-error',
      goldenVerdict: null,
      goldenFailureCount: null,
      failureNote: 'harness-error',
    });
    expect(decodeSampleRecord(JSON.parse(encodeSampleRecord(failed)))).toEqual(failed);
  });
});

describe('decoding is strict, because a plausible default would enter pass@k', () => {
  it('rejects a record with the wrong schema version', () => {
    expect(decodeSampleRecord({ ...record(), schemaVersion: 99 })).toBeNull();
  });

  it('rejects a record missing its arm name', () => {
    expect(decodeSampleRecord(recordWithout('armName'))).toBeNull();
  });

  it('rejects a record whose passed flag is not a boolean', () => {
    expect(decodeSampleRecord({ ...record(), passed: 'yes' })).toBeNull();
  });

  it('rejects an unknown outcome status', () => {
    expect(decodeSampleRecord({ ...record(), outcomeStatus: 'probably-fine' })).toBeNull();
  });

  it('rejects a negative cost', () => {
    expect(decodeSampleRecord({ ...record(), costCents: -1 })).toBeNull();
  });

  it('drops an unrecognized stop reason to null rather than trusting it', () => {
    expect(decodeSampleRecord({ ...record(), stopReason: 'gave-up' })?.stopReason).toBeNull();
  });

  it('treats a record with no model signature as unknown rather than discarding a paid sample', () => {
    const decoded = decodeSampleRecord(recordWithout('modelSignature'));
    expect(decoded?.modelSignature).toBe('unknown');
    // The sample is KEPT WHOLE: only the missing signature is defaulted, and every
    // measured field survives, which is what makes the record still countable in pass@k.
    expect(decoded).toEqual({ ...record(), modelSignature: 'unknown' });
  });

  it('rejects a non-object', () => {
    expect(decodeSampleRecord('a line of text')).toBeNull();
  });
});

describe('decoding the MEASURED token counts', () => {
  it('given a record with no token counts, when decoded, then it is rejected not defaulted', () => {
    // A default of 0 is not neutral here: it is the numerator of tokens per verified
    // artifact, so it would report the sample as having been produced for free.
    for (const field of [
      'promptTokens',
      'completionTokens',
      'totalTokens',
      'unreportedUsageCalls',
    ] as const) {
      expect(decodeSampleRecord(recordWithout(field))).toBeNull();
    }
  });

  it('given a fractional or negative token count, when decoded, then the record is rejected', () => {
    expect(decodeSampleRecord({ ...record(), totalTokens: -1 })).toBeNull();
    expect(decodeSampleRecord({ ...record(), promptTokens: 1.5 })).toBeNull();
  });

  it('given a session that genuinely spent nothing, when decoded, then zeros are accepted', () => {
    // Zero tokens WITH zero unreported calls is a real measurement - a sample that never
    // reached a model - and must survive the round trip rather than looking like a gap.
    const free = record({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      unreportedUsageCalls: 0,
    });

    expect(decodeSampleRecord(JSON.parse(encodeSampleRecord(free)))).toEqual(free);
  });
});

describe('decoding the NEGATIVE control block', () => {
  /** A persisted mutation block; each test states only the part it is about. */
  function mutation(overrides: Partial<MutationSampleCounts> = {}): MutationSampleCounts {
    return {
      validCount: 4,
      killedCount: 4,
      noVerdictKills: 0,
      coverageGapOperators: [],
      candidateEquivalentOperators: [],
      goldenSurvivedCount: 0,
      goldenTimeoutCount: 0,
      nonCompilingCount: 0,
      goldenErroredCount: 0,
      elapsedMs: 1,
      ...overrides,
    };
  }

  it('round-trips a probed sample, BOTH survivor buckets included', () => {
    const probed = record({
      mutation: {
        validCount: 8,
        killedCount: 6,
        noVerdictKills: 1,
        coverageGapOperators: ['ARITH_PLUS_TO_MINUS'],
        candidateEquivalentOperators: ['CONDITION_NEGATED'],
        goldenSurvivedCount: 5,
        goldenTimeoutCount: 0,
        nonCompilingCount: 3,
        goldenErroredCount: 0,
        elapsedMs: 6_000,
      },
    });

    expect(decodeSampleRecord(JSON.parse(encodeSampleRecord(probed)))).toEqual(probed);
  });

  it('keeps the two survivor buckets distinct across the round trip', () => {
    // Merging them on read would report a candidate-equivalent mutant as a definite coverage
    // gap, which is the one number in this block an operator acts on directly.
    const probed = record({
      mutation: mutation({
        killedCount: 2,
        coverageGapOperators: ['ARITH_PLUS_TO_MINUS'],
        candidateEquivalentOperators: ['RESET_BRANCH_DISABLED'],
      }),
    });

    const decoded = decodeSampleRecord(JSON.parse(encodeSampleRecord(probed)))?.mutation;

    expect(decoded?.coverageGapOperators).toEqual(['ARITH_PLUS_TO_MINUS']);
    expect(decoded?.candidateEquivalentOperators).toEqual(['RESET_BRANCH_DISABLED']);
  });

  it('reads an absent block as "not probed" rather than as zero coverage', () => {
    expect(decodeSampleRecord(recordWithout('mutation'))?.mutation).toBeNull();
  });

  it('DROPS a partially readable block whole, rather than repairing it', () => {
    // A kill count with no VALID count to be a fraction of would enter the summary as a kill
    // rate that is not a fraction of anything real.
    const partial = { ...record(), mutation: { killedCount: 6, elapsedMs: 1 } };

    expect(decodeSampleRecord(partial)?.mutation).toBeNull();
  });

  it('drops a block written under the OLD field names, so stale evidence cannot be read', () => {
    // The pre-change shape. Its `detectableCount` was a different, smaller denominator, so a
    // kill rate computed from it is not comparable and must not be aggregated.
    const legacy = {
      ...record(),
      mutation: {
        detectableCount: 4,
        killedCount: 4,
        survivedOperators: [],
        undetectableCount: 2,
        nonCompilingCount: 1,
        elapsedMs: 1,
      },
    };

    expect(decodeSampleRecord(legacy)?.mutation).toBeNull();
  });

  it('drops a block claiming more kills than there were VALID mutants', () => {
    expect(
      decodeSampleRecord({ ...record(), mutation: mutation({ validCount: 4, killedCount: 9 }) })
        ?.mutation,
    ).toBeNull();
  });

  it('drops a block claiming more no-verdict kills than kills', () => {
    // `noVerdictKills` is a SUBSET of `killedCount`, so this block did not come from a probe and
    // its reported-failure count would come out negative.
    expect(
      decodeSampleRecord({ ...record(), mutation: mutation({ killedCount: 2, noVerdictKills: 3 }) })
        ?.mutation,
    ).toBeNull();
  });

  it('drops a block claiming the judge was blind to more mutants than were valid', () => {
    expect(
      decodeSampleRecord({
        ...record(),
        mutation: mutation({ validCount: 4, goldenSurvivedCount: 5 }),
      })?.mutation,
    ).toBeNull();
  });

  it('drops a block naming an operator outside the closed set, in EITHER bucket', () => {
    for (const bucket of ['coverageGapOperators', 'candidateEquivalentOperators'] as const) {
      const tampered = {
        ...record(),
        mutation: { ...mutation({ killedCount: 3 }), [bucket]: ['SOMETHING_INVENTED'] },
      };

      expect(decodeSampleRecord(tampered)?.mutation).toBeNull();
    }
  });

  it('BOUNDS each survivor list, so a hand-edited line cannot allocate without limit', () => {
    const flooded = {
      ...record(),
      mutation: mutation({
        killedCount: 0,
        coverageGapOperators: Array.from(
          { length: MAX_RECORDED_SURVIVORS + 50 },
          () => 'ARITH_PLUS_TO_MINUS' as const,
        ),
        candidateEquivalentOperators: Array.from(
          { length: MAX_RECORDED_SURVIVORS + 50 },
          () => 'CONDITION_NEGATED' as const,
        ),
      }),
    };
    const decoded = decodeSampleRecord(flooded)?.mutation;

    expect(decoded?.coverageGapOperators).toHaveLength(MAX_RECORDED_SURVIVORS);
    expect(decoded?.candidateEquivalentOperators).toHaveLength(MAX_RECORDED_SURVIVORS);
  });

  it('accepts the survived-mutants defect code, which is what the gate now produces', () => {
    const survived = record({
      instrumentValidity: 'invalid',
      instrumentDefect: 'TESTBENCH_SURVIVED_MUTANTS',
    });

    expect(decodeSampleRecord(JSON.parse(encodeSampleRecord(survived)))?.instrumentDefect).toBe(
      'TESTBENCH_SURVIVED_MUTANTS',
    );
  });
});

describe('parsing a whole log', () => {
  it('reads every valid line and ignores blank ones', () => {
    const text = `${encodeSampleRecord(record())}\n\n${encodeSampleRecord(record({ sampleIndex: 1 }))}\n`;
    const parsed = parseResultsLog(text);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.malformedLines).toBe(0);
  });

  it('counts a truncated tail line and keeps every line before it', () => {
    const text = `${encodeSampleRecord(record())}\n{"configHash":"abc12`;
    const parsed = parseResultsLog(text);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.malformedLines).toBe(1);
  });

  it('counts a line that is valid JSON but not a valid record', () => {
    const parsed = parseResultsLog('{"hello":"world"}\n');
    expect(parsed.records).toHaveLength(0);
    expect(parsed.malformedLines).toBe(1);
  });

  it('reads an empty log as no records', () => {
    expect(parseResultsLog('')).toEqual({
      records: [],
      malformedLines: 0,
      staleSchemaLines: 0,
    });
  });
});

describe('an older record schema is counted separately from corruption', () => {
  it('tells the operator what actually changed, not just that something did', () => {
    // The advice is the ONLY thing an operator gets when a file is refused, so it has to name the
    // current meaning of `valid`. It has been wrong-by-omission before: the text still described
    // the 95% kill-rate bar after that bar stopped deciding anything, which would send a reader
    // looking for a threshold that no longer exists.
    const advice = STALE_SCHEMA_ADVICE.join(' ');

    expect(advice).toContain(`current v${RESULTS_SCHEMA_VERSION}`);
    expect(advice).toContain('instrumentValidity: valid');
    // The current gate, in the words the code uses for it.
    expect(advice).toContain('EVERY mutant the');
    expect(advice).toContain('independent golden testbench killed');
    expect(advice).toContain('zero coverage gaps');
    // And the remedy, because a refusal with no next step is an outage.
    expect(advice).toContain('FRESH outputDir');
  });

  it('names the GOLDEN OUTCOME VOCABULARY as a reason the file cannot be aggregated', () => {
    // The reason for THIS bump. An operator reading the refusal has to learn that
    // `goldenVerdict` means less in their file than it does now, and specifically which
    // three causes an older `error` collapsed - otherwise the obvious next move is to
    // hand-edit the value, which is the one repair that fabricates a measurement.
    const advice = STALE_SCHEMA_ADVICE.join(' ');

    expect(advice).toContain('GOLDEN OUTCOME VOCABULARY WIDENED');
    expect(advice).toContain('GOLDEN DENOMINATOR');
    expect(advice).toContain('did-not-build');
    expect(advice).toContain('no-output');
    expect(advice).toContain('timed-out');
  });

  it('names BOTH v9->v10 changes as reasons the file cannot be aggregated', () => {
    // The reason for the current bump. An operator has to learn that an older record's
    // iteration count describes a spent-repair-budget flow that no longer exists, AND that
    // an unchecked instrument's real reason cannot be recovered - reading either one back
    // would fabricate a measurement.
    const advice = STALE_SCHEMA_ADVICE.join(' ');

    expect(advice).toContain('adder_8bit');
    expect(advice).toContain('iterations: 0');
    expect(advice).toContain('multi_16bit');
    expect(advice).toContain('control-unavailable');
  });

  it('names the v10->v11 repair fields without claiming instrumentValidity changed meaning', () => {
    // The reason for THIS bump is different in kind from every one above it: unlike those,
    // `instrumentValidity` itself did NOT get redefined here. An operator has to learn both
    // halves - the old field's meaning held steady, and two new fields were introduced with
    // no honest default - or they might assume every bump redefines `valid` and go looking
    // for a fifth redefinition that was never made.
    const advice = STALE_SCHEMA_ADVICE.join(' ');

    expect(advice).toContain('did NOT change meaning in this bump');
    expect(advice).toContain('repairAttempted');
    expect(advice).toContain('repairAccepted');
  });

  it('given a previous-version line, when the log is parsed, then it aggregates nothing', () => {
    // The whole-file consequence, from the log's own side: a stale line contributes NO
    // record, so there is nothing for a summary to aggregate, and `staleSchemaLines` is what
    // makes the summary refuse rather than report the clean lines beside it.
    const previous = JSON.stringify({
      ...record(),
      schemaVersion: RESULTS_SCHEMA_VERSION - 1,
      // The value that used to be legal and is the reason for the bump.
      goldenVerdict: 'error',
    });

    const parsed = parseResultsLog(`${previous}\n`);

    expect(parsed.staleSchemaLines).toBe(1);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.records).toEqual([]);
  });

  it('classifies a previous-version record as stale, not malformed', () => {
    // A previous-version line: a real record whose fields mean something different, because
    // `instrumentValidity: valid` was decided against a different mutant denominator and a
    // different gate. It is history, not corruption, and the remedy differs.
    const stale = JSON.stringify({ ...record(), schemaVersion: RESULTS_SCHEMA_VERSION - 1 });

    const parsed = parseResultsLog(`${stale}\n${encodeSampleRecord(record({ sampleIndex: 1 }))}\n`);

    expect(parsed.staleSchemaLines).toBe(1);
    expect(parsed.malformedLines).toBe(0);
    // The stale line is not silently upgraded into the record set.
    expect(parsed.records).toHaveLength(1);
  });

  it('treats a FUTURE version as corruption, so noise cannot trigger the refusal', () => {
    const future = JSON.stringify({ ...record(), schemaVersion: RESULTS_SCHEMA_VERSION + 1 });

    const parsed = parseResultsLog(`${future}\n`);

    expect(parsed.staleSchemaLines).toBe(0);
    expect(parsed.malformedLines).toBe(1);
  });

  it('rejects a current-version record with no instrument validity, rather than defaulting it', () => {
    // Defaulting the field would invent a validated instrument, which is the exact
    // misattribution the control exists to prevent.
    expect(decodeSampleRecord(recordWithout('instrumentValidity'))).toBeNull();
  });

  it('drops an unrecognized instrument defect to null rather than trusting it', () => {
    const decoded = decodeSampleRecord({
      ...record({ instrumentValidity: 'invalid' }),
      instrumentDefect: 'SOMETHING_ELSE',
    });
    expect(decoded?.instrumentDefect).toBeNull();
  });

  it('round-trips an unchecked record with its persisted reason', () => {
    const unchecked = record({
      outcomeStatus: 'setup-failed',
      goldenVerdict: null,
      goldenFailureCount: null,
      instrumentValidity: 'unchecked',
      instrumentUncheckedReason: 'no-testbench',
      iterations: 0,
    });

    expect(decodeSampleRecord(JSON.parse(encodeSampleRecord(unchecked)))).toEqual(unchecked);
  });

  it('rejects an unchecked record with no persisted reason, rather than defaulting one', () => {
    // The v9->v10 defect this field exists to close: every v9 `unchecked` record has no
    // reason at all, and reading one back would either invent a specific cause nobody
    // measured, or silently fall back to `control-unavailable` for a sample whose real
    // cause may have been `no-testbench` or `control-resource-exhausted`.
    expect(
      decodeSampleRecord({
        ...record({ instrumentValidity: 'unchecked' }),
        instrumentUncheckedReason: null,
      }),
    ).toBeNull();
  });

  it('rejects an unchecked record with an unrecognized reason, rather than defaulting one', () => {
    expect(
      decodeSampleRecord({
        ...record({ instrumentValidity: 'unchecked' }),
        instrumentUncheckedReason: 'made-up-reason',
      }),
    ).toBeNull();
  });

  it('rejects a CHECKED record that carries an unchecked reason anyway', () => {
    // A `valid` or `invalid` sample has no unchecked reason to carry; a record that claims
    // both is as untrustworthy as one missing a reason it needs.
    expect(
      decodeSampleRecord({
        ...record({ instrumentValidity: 'valid' }),
        instrumentUncheckedReason: 'no-testbench',
      }),
    ).toBeNull();
  });

  it('accepts every member of InstrumentUncheckedReason on an unchecked record', () => {
    const reasons: readonly InstrumentUncheckedReason[] = [
      'control-absent',
      'no-testbench',
      'no-reference',
      'testbench-unsubmittable',
      'control-unavailable',
      'no-mutants-generated',
      'no-valid-mutants',
      'no-golden-killed-mutants',
      'mutation-probe-unavailable',
      'control-resource-exhausted',
    ];
    for (const reason of reasons) {
      const decoded = decodeSampleRecord(
        JSON.parse(
          encodeSampleRecord(
            record({
              outcomeStatus: 'setup-failed',
              goldenVerdict: null,
              goldenFailureCount: null,
              instrumentValidity: 'unchecked',
              instrumentUncheckedReason: reason,
              iterations: 0,
            }),
          ),
        ),
      );
      expect(decoded?.instrumentUncheckedReason).toBe(reason);
    }
  });
});

describe('decoding the GOLDEN OUTCOME', () => {
  it('round-trips each of the five recorded kinds', () => {
    for (const kind of RECORDED_GOLDEN_KINDS) {
      const judged = record({ goldenVerdict: kind });

      expect(decodeSampleRecord(JSON.parse(encodeSampleRecord(judged)))?.goldenVerdict).toBe(kind);
    }
  });

  it('reads an absent or explicitly null outcome as "never judged"', () => {
    // A real state: no judge was wired, or the problem has no golden testbench.
    expect(decodeSampleRecord(recordWithout('goldenVerdict'))?.goldenVerdict).toBeNull();
    expect(decodeSampleRecord({ ...record(), goldenVerdict: null })?.goldenVerdict).toBeNull();
  });

  it('REFUSES the banner-grammar `error`, rather than reading it as unjudged', () => {
    // The value an older record carries. Its three causes - the candidate did not elaborate,
    // the run produced nothing, a cap we imposed killed it - are exactly what the widened
    // vocabulary exists to tell apart, so there is no reading of it that is not invented.
    // Degrading it to `null` would file a JUDGED sample under "nobody judged it".
    expect(decodeSampleRecord({ ...record(), goldenVerdict: 'error' })).toBeNull();
  });

  it('counts a current-version line with an unreadable outcome as malformed', () => {
    // Not stale: the schema version is current, so this is a hand-edited or corrupt line and
    // the remedy is the line, not the file.
    const tampered = JSON.stringify({ ...record(), goldenVerdict: 'error' });

    const parsed = parseResultsLog(`${tampered}\n`);

    expect(parsed.malformedLines).toBe(1);
    expect(parsed.staleSchemaLines).toBe(0);
    expect(parsed.records).toHaveLength(0);
  });
});

describe('golden outcome decoding - Property 6', () => {
  // Feature: eval-campaign-readiness, Property 6: A widened golden kind is accepted and
  // anything else is refused.
  //
  // Validates: Requirements 3.1, 3.6
  it('accepts a golden outcome exactly when it is one of the five recorded kinds', () => {
    fc.assert(
      fc.property(
        // The five kinds must be drawn often enough to exercise the accept branch, so they
        // are generated explicitly beside arbitrary text rather than left to chance.
        fc.oneof(fc.constantFrom(...RECORDED_GOLDEN_KINDS), fc.string(), fc.constant('error')),
        (candidate) => {
          const decoded = decodeSampleRecord({ ...record(), goldenVerdict: candidate });
          const isRecordedKind = (RECORDED_GOLDEN_KINDS as readonly string[]).includes(candidate);

          expect(decoded !== null).toBe(isRecordedKind);
          if (decoded !== null) {
            expect(decoded.goldenVerdict).toBe(candidate);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('instrumentVerdictOf - rebuilding the union from the flat record', () => {
  it('reads a valid record back as a valid verdict', () => {
    expect(instrumentVerdictOf(record({ instrumentValidity: 'valid' }))).toEqual({
      validity: 'valid',
    });
  });

  it('reads an invalid record back with its defect code', () => {
    expect(
      instrumentVerdictOf(
        record({
          instrumentValidity: 'invalid',
          instrumentDefect: 'TESTBENCH_REFERENCE_UNBUILDABLE',
        }),
      ),
    ).toEqual({ validity: 'invalid', defect: 'TESTBENCH_REFERENCE_UNBUILDABLE' });
  });

  it('keeps an invalid record with an unreadable defect INVALID, which is the fail-safe way', () => {
    expect(
      instrumentVerdictOf(record({ instrumentValidity: 'invalid', instrumentDefect: null })),
    ).toEqual({ validity: 'invalid', defect: 'CONTROL_RUN_ERRORED' });
  });

  it('reads an unchecked record back with its PERSISTED reason', () => {
    expect(
      instrumentVerdictOf(
        record({
          instrumentValidity: 'unchecked',
          instrumentUncheckedReason: 'no-testbench',
        }),
      ),
    ).toEqual({ validity: 'unchecked', reason: 'no-testbench' });
  });

  it('falls back to control-unavailable for a directly-constructed record with no reason, as defense in depth', () => {
    // `decodeSampleRecord` refuses this shape outright (see the decoding-strictness
    // describe block below), so this only exercises a `SweepSampleRecord` built by some
    // other path, e.g. a test fixture.
    expect(
      instrumentVerdictOf(
        record({ instrumentValidity: 'unchecked', instrumentUncheckedReason: null }),
      ),
    ).toEqual({ validity: 'unchecked', reason: 'control-unavailable' });
  });
});

describe('unchecked reason round trip - Property 10', () => {
  // instrument-precheck-and-attribution, Property 10: An unchecked reason survives the
  // round trip.
  //
  // For any RecordedInstrumentVerdict, encoding it into a sample record and decoding that
  // record back yields an equal verdict, so no `unchecked` reason is flattened on the way
  // to the summary. The measured defect this closes: a v9 record carried no reason field at
  // all, so `instrumentVerdictOf` invented `control-unavailable` for every `unchecked`
  // sample regardless of the real cause (`rtllm/arithmetic/multi_16bit` was actually killed
  // by a disk cap, not an unbuildable testbench).
  //
  // Validates: Requirements 3.5, 3.6

  /** Every member of the closed InstrumentUncheckedReason set, including task 6.1's addition. */
  const uncheckedReasonArbitrary: fc.Arbitrary<InstrumentUncheckedReason> = fc.constantFrom(
    'control-absent',
    'no-testbench',
    'no-reference',
    'testbench-unsubmittable',
    'control-unavailable',
    'no-mutants-generated',
    'no-valid-mutants',
    'no-golden-killed-mutants',
    'mutation-probe-unavailable',
    'control-resource-exhausted',
  );

  /**
   * An outcome status paired with the `passed`/`goldenVerdict` shape it actually carries,
   * so the generated record is never internally contradictory. `instrument-refused` is
   * included because it is the new terminal outcome an `unchecked` instrument can now be
   * recorded under (task 4.1, task 9.1), and it carries no oracle verdict.
   */
  const outcomeShapeArbitrary: fc.Arbitrary<{
    outcomeStatus: SweepSampleRecord['outcomeStatus'];
    passed: boolean;
    goldenVerdict: SweepSampleRecord['goldenVerdict'];
    iterations: number;
  }> = fc.constantFrom(
    {
      outcomeStatus: 'unverified' as const,
      passed: false,
      goldenVerdict: 'failed' as const,
      iterations: 3,
    },
    {
      outcomeStatus: 'instrument-refused' as const,
      passed: false,
      goldenVerdict: 'passed' as const,
      iterations: 0,
    },
    { outcomeStatus: 'setup-failed' as const, passed: false, goldenVerdict: null, iterations: 0 },
  );

  /** An arbitrary, internally-consistent unchecked record: any reason, any carrying outcome. */
  const uncheckedRecordArbitrary: fc.Arbitrary<SweepSampleRecord> = fc
    .tuple(uncheckedReasonArbitrary, outcomeShapeArbitrary)
    .map(([reason, shape]) =>
      record({
        instrumentValidity: 'unchecked',
        instrumentUncheckedReason: reason,
        ...shape,
      }),
    );

  it('preserves instrumentUncheckedReason exactly through encode then decode', () => {
    fc.assert(
      fc.property(uncheckedRecordArbitrary, (original) => {
        const decoded = decodeSampleRecord(JSON.parse(encodeSampleRecord(original)));

        expect(decoded).toEqual(original);
        expect(decoded?.instrumentUncheckedReason).toBe(original.instrumentUncheckedReason);
      }),
      { numRuns: 200 },
    );
  });

  it('reconstructs the same RecordedInstrumentVerdict from the persisted reason, never the flattened default', () => {
    fc.assert(
      fc.property(uncheckedRecordArbitrary, (original) => {
        const decoded = decodeSampleRecord(JSON.parse(encodeSampleRecord(original)));
        expect(decoded).not.toBeNull();

        const verdict = instrumentVerdictOf(decoded as SweepSampleRecord);

        expect(verdict).toEqual({
          validity: 'unchecked',
          reason: original.instrumentUncheckedReason,
        });
        // The specific regression this property pins: a resource-bound kill (or any other
        // real reason) must never round-trip as the generic fallback unless that fallback
        // IS the reason actually recorded.
        if (original.instrumentUncheckedReason !== 'control-unavailable') {
          expect(verdict).not.toEqual({ validity: 'unchecked', reason: 'control-unavailable' });
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('the resume / skip decision', () => {
  it('skips a sample already recorded for this exact config', () => {
    const index = CompletedSampleIndex.fromRecords([record()], 'abc123');
    expect(index.isComplete('glm-5', 'rtllm/arithmetic/adder_8bit', 0)).toBe(true);
    expect(index.size()).toBe(1);
  });

  it('does not skip a different sample index of the same problem', () => {
    const index = CompletedSampleIndex.fromRecords([record()], 'abc123');
    expect(index.isComplete('glm-5', 'rtllm/arithmetic/adder_8bit', 1)).toBe(false);
  });

  it('does not skip the same slot of a different arm', () => {
    const index = CompletedSampleIndex.fromRecords([record()], 'abc123');
    expect(index.isComplete('deepseek', 'rtllm/arithmetic/adder_8bit', 0)).toBe(false);
  });

  it('IGNORES a record from another config, so two experiments never blend', () => {
    const index = CompletedSampleIndex.fromRecords(
      [record({ configHash: 'a-different-experiment' })],
      'abc123',
    );
    expect(index.size()).toBe(0);
    expect(index.isComplete('glm-5', 'rtllm/arithmetic/adder_8bit', 0)).toBe(false);
  });

  it('counts a duplicated record once, so a double-appended line cannot distort resume', () => {
    const index = CompletedSampleIndex.fromRecords([record(), record()], 'abc123');
    expect(index.size()).toBe(1);
  });

  it('keys a sample on all three coordinates', () => {
    expect(sampleKey('arm', 'problem', 3)).not.toBe(sampleKey('arm', 'problem', 4));
    expect(sampleKey('arm', 'problem', 3)).not.toBe(sampleKey('other', 'problem', 3));
  });
});

describe('a stale record is refused, never repaired - Property 14', () => {
  // instrument-precheck-and-attribution, Property 14: A stale record is refused, never
  // repaired.
  //
  // For any sample record encoded under a schema version below 10, the results-log reader
  // reports it as a stale-schema line and aggregates nothing from the file that holds it.
  //
  // Validates: Requirements 7.1, 7.2

  /** An integer schema version strictly below the current one, never zero or negative. */
  const olderSchemaVersionArbitrary: fc.Arbitrary<number> = fc.integer({
    min: 1,
    max: RESULTS_SCHEMA_VERSION - 1,
  });

  /**
   * A JSONL line for a valid-shaped record whose `schemaVersion` is strictly older: the
   * exact thing `readsAsOlderSchema` classifies as history rather than corruption. Its
   * `goldenVerdict` is drawn as the banner-grammar `error` at least sometimes, because that
   * value is precisely what an old file may hold and a current-schema decoder must never
   * read as a live record.
   */
  const staleLineArbitrary: fc.Arbitrary<string> = fc
    .tuple(olderSchemaVersionArbitrary, fc.oneof(fc.constant('passed'), fc.constant('error')))
    .map(([schemaVersion, goldenVerdict]) =>
      JSON.stringify({ ...record(), schemaVersion, goldenVerdict }),
    );

  /** A JSONL line for a fully valid, current-schema record; sampleIndex varies to stay distinct. */
  const validLineArbitrary: fc.Arbitrary<string> = fc
    .integer({ min: 0, max: 1_000 })
    .map((sampleIndex) => encodeSampleRecord(record({ sampleIndex })));

  /**
   * A genuinely malformed line: either not JSON at all, or JSON whose shape a decoder
   * cannot read as either a current or a stale record (no readable `schemaVersion`).
   */
  const malformedLineArbitrary: fc.Arbitrary<string> = fc.oneof(
    fc.string({ minLength: 1 }).filter((text) => {
      // A blank or whitespace-only line is ignored entirely by the parser, never counted, and
      // an embedded newline would split into extra lines and throw off the tally - both
      // excluded so this generator only ever produces exactly one malformed line.
      if (text.trim().length === 0 || text.includes('\n')) {
        return false;
      }
      try {
        JSON.parse(text);
        return false;
      } catch {
        return true;
      }
    }),
    fc
      .oneof(fc.string(), fc.boolean(), fc.constant(null), fc.array(fc.string()))
      .map((value) => JSON.stringify({ ...record(), schemaVersion: value })),
  );

  /** One of the three line kinds, tagged so the property can tally what it generated. */
  type TaggedLine = { readonly kind: 'stale' | 'valid' | 'malformed'; readonly line: string };
  const taggedLineArbitrary: fc.Arbitrary<TaggedLine> = fc.oneof(
    staleLineArbitrary.map((line): TaggedLine => ({ kind: 'stale', line })),
    validLineArbitrary.map((line): TaggedLine => ({ kind: 'valid', line })),
    malformedLineArbitrary.map((line): TaggedLine => ({ kind: 'malformed', line })),
  );

  it('counts every stale line and contributes nothing from it to the record set', () => {
    fc.assert(
      fc.property(fc.array(taggedLineArbitrary, { minLength: 1, maxLength: 12 }), (lines) => {
        const text = lines.map(({ line }) => line).join('\n');
        const parsed = parseResultsLog(text);

        const expectedStale = lines.filter(({ kind }) => kind === 'stale').length;
        const expectedValid = lines.filter(({ kind }) => kind === 'valid').length;
        const expectedMalformed = lines.filter(({ kind }) => kind === 'malformed').length;

        expect(parsed.staleSchemaLines).toBe(expectedStale);
        expect(parsed.malformedLines).toBe(expectedMalformed);
        // Every stale line vanishes from the record set rather than being filled in with
        // defaults: the record count reflects ONLY the valid current-schema lines.
        expect(parsed.records).toHaveLength(expectedValid);
      }),
      { numRuns: 200 },
    );
  });

  it('always refuses the whole file when at least one stale line is present, however many valid records sit beside it', () => {
    fc.assert(
      fc.property(
        fc.array(staleLineArbitrary, { minLength: 1, maxLength: 6 }),
        fc.array(validLineArbitrary, { minLength: 0, maxLength: 6 }),
        (staleLines, validLines) => {
          const text = [...staleLines, ...validLines].join('\n');
          const parsed = parseResultsLog(text);
          const summary = summarizeRecords(parsed.records, [1], 'abc123', parsed);

          // The whole file is refused, not partially aggregated: an empty arms array and
          // zero totals even though `parsed.records` may hold clean, current-schema samples.
          expect(summary.refusedStaleSchema).toBe(true);
          expect(summary.arms).toEqual([]);
          expect(summary.totalSamples).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
