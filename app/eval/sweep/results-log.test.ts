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

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import {
  CHECKING_APPROACHES,
  DESIGN_GROUPS,
  FALLBACK_ROUTES,
  NO_FORMAL_RUN,
  TESTBENCH_PARSE_REFUSALS,
  STRATEGY_ARMS,
  PROPERTY_SET_ADMISSION_OUTCOMES,
  type FormalProvenance,
  type StrategyArm,
} from '@app/agent';
import {
  admitProved,
  FORMAL_VERDICTS,
  type ArtifactBlobRef,
  type CoverCondition,
  type FormalVerdict,
  type ProofConditions,
  type PropertyResult,
} from '@app/tools';

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
  recordedFormalRun,
  RESULTS_SCHEMA_VERSION,
  sampleKey,
  STALE_SCHEMA_ADVICE,
  type RecordedFormalRun,
  type SweepSampleRecord,
} from './results-log.js';
import { renderSummary, summarizeRecords } from './summary.js';

/** A complete, valid record; each test overrides only the field it is about. */
function record(overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    strategyArm: 'control',
    checkingApproach: 'cycle-timed',
    designGroup: 'cycle-exact',
    testbenchPromptVersion: 4,
    simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
    testbenchParseRefusal: null,
    positiveControlRun: null,
    // The default testbench was measured and gave every failure report a value.
    valuelessFailureReports: 0,
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
    // The default carries a formal run the oracle PROVED, so a test which says nothing about
    // the formal fields still exercises the healthy path - the same reasoning the `mutation`
    // default above follows. A `proved` result carries no cause, and its five conditions are
    // at their admitting values.
    formal: {
      verdict: 'proved',
      cause: null,
      conditions: {
        assertionCount: 2,
        presat: 'satisfiable',
        cover: { reached: true, step: 1 },
        base: 'passed',
        induction: 'successful',
      },
      depth: 20,
      elapsedMs: 3_350,
    },
    // Nothing could-not-verify, so no cause sent this sample to the Simulation_Fallback.
    formalFallbackReason: null,
    // And the formal verdict decided this sample, so it did not fall back by any route.
    formalFallbackRoute: 'not-applicable',
    // The pre-pass RAN and derived a contract: an async active-low reset over a design whose
    // initial state is not free, which is one of the combinations the `if (!$initstate)` gate
    // is NOT emitted for. A test about the gate or about the refused arm sets both explicitly.
    formalResetContract: {
      derived: true,
      resetName: 'rst_n',
      resetActiveLow: true,
      resetKind: 'async',
      initialStateFree: false,
    },
    formalAssertionGateEmitted: false,
    formalClockPolarity: 'posedge',
    // The default sample ran on the product-shaped path, where no reference design exists for
    // the Property_Set_Admission gate to mutate. A test about admission sets this explicitly.
    propertySetAdmitted: 'not-gated',
    propertySetAuthoredUpFront: false,
    propertySetSurvivorCount: 0,
    // No gate ran for the default sample, so there is no calibrated population to tally -
    // "not measured", which is a different claim from every count at zero. A test about the
    // counts sets a real tally explicitly.
    formalMutationCounts: null,
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

/** Encode then decode, which is the only thing a persisted record is ever asked to survive. */
function roundTrip(sample: SweepSampleRecord): SweepSampleRecord | null {
  return decodeSampleRecord(JSON.parse(encodeSampleRecord(sample)));
}

/** The five conditions at their admitting values: the shape a `proved` verdict rests on. */
const PROVED_CONDITIONS: ProofConditions = {
  assertionCount: 2,
  presat: 'satisfiable',
  cover: { reached: true, step: 1 },
  base: 'passed',
  induction: 'successful',
};

/** A complete, valid formal block; each test overrides only the field it is about. */
function formalRun(overrides: Partial<RecordedFormalRun> = {}): RecordedFormalRun {
  return {
    verdict: 'proved',
    cause: null,
    conditions: PROVED_CONDITIONS,
    depth: 20,
    elapsedMs: 3_350,
    ...overrides,
  };
}

/** The counterexample a `refuted` fixture hands back; the evidence Req 1.10 demands. */
const COUNTEREXAMPLE: ArtifactBlobRef = {
  name: 'counterexample.vcd',
  sizeBytes: 24,
  sha256: 'c'.repeat(64),
};

/**
 * One `PropertyResult` of the given verdict, built through `admitProved` for the `proved`
 * member rather than with a literal.
 *
 * `ProvedEvidence`'s assertion count is BRANDED and `admitProved` is its sole constructor, so a
 * fixture cannot spell a proof the five-condition gate did not admit - which is the point of the
 * brand and the reason this helper asks the gate instead of asserting past it.
 */
function propertyResult(
  verdict: FormalVerdict,
  timing: { readonly depth?: number; readonly elapsedMs?: number } = {},
): PropertyResult {
  const depth = timing.depth ?? 20;
  const elapsedMs = timing.elapsedMs ?? 3_350;
  const criterionRef = `c-${verdict}`;
  if (verdict === 'refuted') {
    const conditions: ProofConditions = { ...PROVED_CONDITIONS, base: 'failed' };
    return { verdict, counterexample: COUNTEREXAMPLE, conditions, depth, elapsedMs, criterionRef };
  }
  if (verdict === 'could-not-verify') {
    const conditions: ProofConditions = { ...PROVED_CONDITIONS, induction: 'inconclusive' };
    return {
      verdict,
      cause: 'induction-inconclusive',
      conditions,
      depth,
      elapsedMs,
      criterionRef,
      diagnostic: null,
      crossCheckDisagreed: false,
    };
  }
  const evidence = admitProved(PROVED_CONDITIONS);
  if (typeof evidence === 'string') {
    throw new Error(`fixture conditions were refused by the gate: ${evidence}`);
  }
  return { verdict: 'proved', evidence, depth, elapsedMs, criterionRef };
}

/** A `FormalProvenance` carrying exactly these results; every other field is the no-run value. */
function provenance(results: readonly PropertyResult[]): FormalProvenance {
  return { ...NO_FORMAL_RUN, results };
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

  it('names the formal verdict, its conditions, and the fallback reason as now recorded', () => {
    // Req 12.13. The reason for the CURRENT bump, and the only thing an operator is told when
    // their file is refused. Without it the obvious next move is to hand-edit a schema version,
    // which silently reads a sample measured under no formal oracle as one measured under this
    // one - the misattribution the version number exists to make impossible.
    const advice = STALE_SCHEMA_ADVICE.join(' ');

    expect(advice).toContain('FORMAL VERDICT');
    expect(advice).toContain('Proof_Conditions');
    expect(advice).toContain('Fallback_Reason');
    expect(advice).toContain('Reset_Contract');
    // And the remedy, which has to be a FRESH directory rather than an in-place edit.
    expect(advice).toContain('FRESH outputDir');
  });

  it('pins the schema version, because the refusal rule is keyed on this number alone', () => {
    // Req 12.9. The refusal is `record.schemaVersion !== RESULTS_SCHEMA_VERSION`, so this
    // constant IS the gate: a bump reverted by a bad merge would silently re-admit v12
    // records, which carry no formal fields at all.
    expect(RESULTS_SCHEMA_VERSION).toBe(17);
  });

  it('admits the provider-refused-credential cause, which no v13 reader could name', () => {
    // The reason for the v13 -> v14 bump: an unknown cause decodes to `null`, which reads as
    // NOT deferrable, so a v13 build would make a retakeable slot final.
    // The default record is a verified sample, so the whole no-verdict shape moves with the
    // cause: a passing sample that reached no verdict is refused by a cross-field rule.
    const refused = record({
      passed: false,
      outcomeStatus: 'setup-failed',
      noVerdictCause: 'provider-refused-credential',
      formal: null,
      formalFallbackReason: null,
      formalFallbackRoute: 'not-applicable',
      formalMutationCounts: null,
      propertySetAdmitted: 'not-gated',
      propertySetAuthoredUpFront: false,
    });

    expect(parseResultsLog(`${encodeSampleRecord(refused)}\n`).records).toEqual([refused]);

    const stale = JSON.stringify({ ...refused, schemaVersion: RESULTS_SCHEMA_VERSION - 1 });
    expect(parseResultsLog(`${stale}\n`).records).toEqual([]);
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

  it('refuses the file on a FUTURE version, because a newer build wrote fields this reader cannot interpret', () => {
    // Req 12.28, the mirror of the previous-version refusal above. A well-formed record at a
    // higher version is what a NEWER BUILD writes - an operator resuming into a directory a
    // later build already wrote, or two runs' files concatenated - and it carries fields this
    // reader cannot interpret, or worse REDEFINES one it thinks it understands, which is what
    // every bump on `RESULTS_SCHEMA_VERSION` did to the version below it. So it is counted as
    // another schema version and refuses the whole file, rather than being reported as damage
    // to one line while the file is aggregated anyway.
    const future = JSON.stringify({ ...record(), schemaVersion: RESULTS_SCHEMA_VERSION + 1 });

    const parsed = parseResultsLog(`${future}\n`);

    expect(parsed.staleSchemaLines).toBe(1);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.records).toEqual([]);
  });

  it('still treats a GARBAGE version as corruption, so noise cannot trigger the refusal', () => {
    // The narrowness Req 12.28 does NOT relax: the refusal is triggered by an INTEGER version
    // that is not the current one, so a string, a float, or a container in that field stays
    // malformed and costs its own line rather than the file.
    for (const version of ['fourteen', 13.5, null, [14]]) {
      const parsed = parseResultsLog(
        `${JSON.stringify({ ...record(), schemaVersion: version })}\n`,
      );

      expect(parsed.staleSchemaLines).toBe(0);
      expect(parsed.malformedLines).toBe(1);
    }
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
      // Req 12.29: a `setup-failed` sample failed before a candidate existed, so no
      // Formal_Property was ever submitted and the default `proved` run is not a record this
      // status can carry.
      formal: null,
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
              // Req 12.29, as in the round-trip test above: no candidate, so no formal run.
              formal: null,
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
   * An outcome status paired with the `passed`/`goldenVerdict`/`formal` shape it actually
   * carries, so the generated record is never internally contradictory. `instrument-refused` is
   * included because it is the new terminal outcome an `unchecked` instrument can now be
   * recorded under (task 4.1, task 9.1), and it carries no oracle verdict.
   *
   * `formal` joined the pairing for Req 12.29: a `setup-failed` sample is returned straight out
   * of `VerificationLoop#verify`'s `#setup`, before a candidate or an independent testbench
   * exists, so no Formal_Property can have been submitted and the run is `null`. The field is
   * spelled on every member rather than only that one, so a status added here has to answer the
   * question instead of inheriting the default.
   */
  const outcomeShapeArbitrary: fc.Arbitrary<{
    outcomeStatus: SweepSampleRecord['outcomeStatus'];
    passed: boolean;
    goldenVerdict: SweepSampleRecord['goldenVerdict'];
    iterations: number;
    formal: SweepSampleRecord['formal'];
  }> = fc.constantFrom(
    {
      outcomeStatus: 'unverified' as const,
      passed: false,
      goldenVerdict: 'failed' as const,
      iterations: 3,
      formal: formalRun(),
    },
    {
      outcomeStatus: 'instrument-refused' as const,
      passed: false,
      goldenVerdict: 'passed' as const,
      iterations: 0,
      formal: formalRun(),
    },
    {
      outcomeStatus: 'setup-failed' as const,
      passed: false,
      goldenVerdict: null,
      iterations: 0,
      formal: null,
    },
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

describe('the formal fields a v13 record carries', () => {
  it('round-trips all FOUR Property_Set admission outcomes as DISTINCT values', () => {
    // Req 10.8, and the whole reason this field is not a boolean. Four facts: the gate
    // admitted the set, the gate ran with NOTHING to hold it to, the gate refused it, and no
    // gate ran at all. Collapsing `'no-gate-set'` onto `'admitted'` records a vacuous pass as
    // a demonstrated one; onto `'refused'` records a refusal that never happened; onto `null`
    // conflates "no gate ran" with "unknown".
    const decoded = PROPERTY_SET_ADMISSION_OUTCOMES.map(
      (outcome) => roundTrip(record({ propertySetAdmitted: outcome }))?.propertySetAdmitted,
    );

    expect(decoded).toEqual([...PROPERTY_SET_ADMISSION_OUTCOMES]);
    // The structural half: four inputs produce four distinct outputs, so no pair collapsed.
    expect(new Set(decoded).size).toBe(PROPERTY_SET_ADMISSION_OUTCOMES.length);
  });

  it('refuses a record with no admission outcome rather than reading it as admitted', () => {
    // Non-nullable, matching `instrumentValidity`: `'not-gated'` already states the fact an
    // absent field would have to carry, and an absent field reads as gated-and-passed.
    expect(decodeSampleRecord(recordWithout('propertySetAdmitted'))).toBeNull();
    expect(decodeSampleRecord({ ...record(), propertySetAdmitted: 'yes' })).toBeNull();
  });

  it('round-trips the formal mutant counts, EXCLUDED count included', () => {
    // Req 9.4, 9.6, 9.9: the count that previously had no data path at all. A mutant Yosys
    // would not read is neither killed nor survived, so it sits OUTSIDE the denominator and
    // must still be reported - which is only possible if the record carries it.
    const counts = {
      totalCount: 7,
      denominator: 5,
      killedCount: 4,
      survivedCount: 1,
      couldNotVerifyCount: 2,
    };

    const decoded = roundTrip(record({ formalMutationCounts: counts }))?.formalMutationCounts;

    expect(decoded).toEqual(counts);
    // The denominator is the FORMAL gate's own and is NOT the negative control's valid count
    // over the same mutants (Req 9.6), so it survives independently of `totalCount`.
    expect(decoded?.denominator).toBe(5);
  });

  it('keeps "no gate ran" DISTINCT from a gate that calibrated nothing', () => {
    // `null` reads as NOT MEASURED, which is what every record carries until a production
    // `PropertySetGate` is wired. An all-zero tally is a gate that RAN over an empty
    // population, and reading either one as the other would print a kill rate of a gate that
    // never ran, or hide one that ran and scored nothing.
    const notMeasured = roundTrip(record({ formalMutationCounts: null }));
    const ranEmpty = roundTrip(
      record({
        formalMutationCounts: {
          totalCount: 0,
          denominator: 0,
          killedCount: 0,
          survivedCount: 0,
          couldNotVerifyCount: 0,
        },
      }),
    );

    expect(notMeasured?.formalMutationCounts).toBeNull();
    expect(ranEmpty?.formalMutationCounts).not.toBeNull();
    expect(ranEmpty?.formalMutationCounts?.totalCount).toBe(0);
  });

  it('refuses a record whose counts are absent, partial, or do not partition', () => {
    // Req 12.34: the key is REQUIRED PRESENT, with an explicit `null` where no gate ran, so
    // DELETING it from a line cannot assert "no gate ran" - a fact nobody measured.
    expect(decodeSampleRecord(recordWithout('formalMutationCounts'))).toBeNull();
    // Partial is refused whole, like `decodeMutationCounts`: an excluded count beside a
    // defaulted denominator is a rate that is not a fraction of anything real.
    expect(decodeSampleRecord({ ...record(), formalMutationCounts: { totalCount: 3 } })).toBeNull();
    // And the partition the type documents: 3 !== 1 + 1 + 0, so this block never came from
    // `formalMutationCounts`.
    expect(
      decodeSampleRecord({
        ...record(),
        formalMutationCounts: {
          totalCount: 3,
          denominator: 2,
          killedCount: 1,
          survivedCount: 1,
          couldNotVerifyCount: 0,
        },
      }),
    ).toBeNull();
  });

  it('keeps a Reset_Contract of null DISTINCT from one that ran and refused', () => {
    // Req 12.21, and the second conflation this record exists to prevent. `null` means no
    // contract was derived at all - the pre-pass did not run, or its report could not be read.
    // `{ derived: false }` means the pre-pass RAN and positively refused, which is a recorded
    // outcome (Req 14.20). The assertion-gate emission is a FUNCTION of this value, so a
    // record that read either one as the other could not explain its own gate.
    const neverRead = roundTrip(record({ formalResetContract: null }));
    const refused = roundTrip(record({ formalResetContract: { derived: false } }));

    expect(neverRead?.formalResetContract).toBeNull();
    expect(refused?.formalResetContract).toEqual({ derived: false });
    expect(refused?.formalResetContract).not.toBeNull();
  });

  it('round-trips a derived Reset_Contract with all four of its facts', () => {
    const derived = record({
      formalResetContract: {
        derived: true,
        resetName: 'rst',
        resetActiveLow: false,
        resetKind: 'sync',
        initialStateFree: true,
      },
      // The one combination `emitsAssertionGate` emits the `if (!$initstate)` gate for: a
      // SYNCHRONOUS reset over a FREE initial state.
      formalAssertionGateEmitted: true,
    });

    expect(roundTrip(derived)).toEqual(derived);
  });

  it('refuses a derived Reset_Contract missing a fact, rather than reading it as refused', () => {
    // Degrading to `{ derived: false }` would record a refusal the pre-pass never made.
    const halfDerived = {
      ...record(),
      formalResetContract: { derived: true, resetName: 'rst', resetActiveLow: true },
    };

    expect(decodeSampleRecord(halfDerived)).toBeNull();
  });

  it('round-trips every Formal_Verdict and refuses a value outside the vocabulary', () => {
    // Req 12.12. A non-member is a MALFORMED record, not a null verdict: `null` asserts that
    // no property was submitted, which is a claim nobody measured.
    for (const verdict of FORMAL_VERDICTS) {
      const cause = verdict === 'could-not-verify' ? 'proof-timeout' : null;
      expect(roundTrip(record({ formal: formalRun({ verdict, cause }) }))?.formal?.verdict).toBe(
        verdict,
      );
    }

    expect(
      decodeSampleRecord({ ...record(), formal: { ...formalRun(), verdict: 'passed' } }),
    ).toBeNull();
  });

  it('holds the Could_Not_Verify_Cause to the verdict it belongs to', () => {
    // Req 1.5: a `could-not-verify` verdict carries exactly one cause, and the other two
    // verdicts have none to carry. A record claiming both is as untrustworthy as one missing
    // the cause it needs, so both are refused rather than one being quietly defaulted.
    const cnv = formalRun({ verdict: 'could-not-verify', cause: 'proof-timeout' });

    expect(roundTrip(record({ formal: cnv }))?.formal?.cause).toBe('proof-timeout');
    // Declined-but-unnamed: a `could-not-verify` with no cause to read.
    expect(decodeSampleRecord({ ...record(), formal: { ...cnv, cause: null } })).toBeNull();
    // Accepted-but-named: a `proved` verdict carrying a cause it cannot have.
    expect(
      decodeSampleRecord({ ...record(), formal: { ...formalRun(), cause: 'proof-timeout' } }),
    ).toBeNull();
    // And a cause outside the vocabulary is malformed, never defaulted (Req 12.12).
    expect(decodeSampleRecord({ ...record(), formal: { ...cnv, cause: 'slow' } })).toBeNull();
  });

  it('round-trips the five Proof_Conditions, the depth, and the elapsed time', () => {
    const measured = record({
      formal: formalRun({
        verdict: 'could-not-verify',
        cause: 'antecedent-unreached',
        conditions: {
          assertionCount: 3,
          presat: 'satisfiable',
          cover: { reached: false },
          base: 'not-run',
          induction: 'not-run',
        },
        depth: 64,
        elapsedMs: 65_600,
      }),
    });

    expect(roundTrip(measured)).toEqual(measured);
  });

  it('refuses a formal block whose conditions are only partly readable', () => {
    // Four conditions beside a defaulted fifth is a record claiming a condition was measured
    // when it was not, and `admitProved` weighs all five.
    const partial = {
      ...record(),
      formal: {
        ...formalRun(),
        conditions: { assertionCount: 1, presat: 'satisfiable', base: 'passed' },
      },
    };

    expect(decodeSampleRecord(partial)).toBeNull();
  });

  it('keeps all three Cover_Check readings distinct through the round trip', () => {
    // A reached cover carries the STEP it was reached at; `reached: false` is a cover that ran
    // and was not reached; `'not-applicable'` is the unclocked case where none ran at all.
    const covers: readonly CoverCondition[] = [
      { reached: true, step: 13 },
      { reached: false },
      { reached: 'not-applicable' },
    ];

    const decoded = covers.map(
      (cover) =>
        roundTrip(record({ formal: formalRun({ conditions: { ...PROVED_CONDITIONS, cover } }) }))
          ?.formal?.conditions.cover,
    );

    expect(decoded).toEqual(covers);
  });

  it('records no formal run as null, and a fallback reason BESIDE it', () => {
    // The oracle port threw: nothing was submitted, yet the sample DID take the
    // Simulation_Fallback. `formalFallbackReason` is flat for exactly this case - nesting it
    // would delete the fallback from the samples whose fallback is least expected (Req 7.9).
    // The route is `'cause'` beside it, because Req 7.19 makes the reason and the route an IFF
    // and Req 12.31 refuses a record that breaks it: a reason IS the statement that a
    // Could_Not_Verify_Cause drove the fall back, so the route cannot read `'not-applicable'`.
    const portFailed = record({
      formal: null,
      formalFallbackReason: 'toolchain-unavailable',
      formalFallbackRoute: 'cause',
    });

    expect(roundTrip(portFailed)).toEqual(portFailed);
  });

  it('refuses a fallback reason or clock polarity outside its vocabulary', () => {
    // Req 12.12 for the cause vocabulary, and task 12.6's rule for the polarity: malformed
    // rather than defaulted. `null` is a claim here - "this sample did not fall back", "the
    // pre-pass was never reached" - so reading a non-member as `null` asserts both falsely.
    expect(decodeSampleRecord({ ...record(), formalFallbackReason: 'gave-up' })).toBeNull();
    expect(decodeSampleRecord({ ...record(), formalClockPolarity: 'rising' })).toBeNull();
    // And `'none'` is a real reading, never the same fact as an absent one.
    expect(roundTrip(record({ formalClockPolarity: 'none' }))?.formalClockPolarity).toBe('none');
    expect(roundTrip(record({ formalClockPolarity: null }))?.formalClockPolarity).toBeNull();
  });

  it('rolls a sample up so a refutation beats a could-not-verify beats a proof', () => {
    // Req 7.17, fail-closed: a REFUTATION IS THE FINDING. Falling back instead would let a
    // passing Simulation_Fallback carry `Verified` on a design a formal counterexample
    // refuted, which is the severity-1 direction this spec exists to close.
    const proved = propertyResult('proved');
    const couldNotVerify = propertyResult('could-not-verify');
    const refuted = propertyResult('refuted');

    expect(recordedFormalRun(provenance([proved, couldNotVerify, refuted]))?.verdict).toBe(
      'refuted',
    );
    expect(recordedFormalRun(provenance([refuted, proved]))?.verdict).toBe('refuted');
    expect(recordedFormalRun(provenance([proved, couldNotVerify]))?.verdict).toBe(
      'could-not-verify',
    );
    expect(recordedFormalRun(provenance([proved, proved]))?.verdict).toBe('proved');
    // No property submitted is no record, rather than a verdict nobody reached.
    expect(recordedFormalRun(provenance([]))).toBeNull();
  });

  it('reads the depth and the cause off the SAME deciding result', () => {
    // A depth from one property beside a cause from another describes a run that never
    // happened, so every field of the block comes from the one result that decided the sample.
    const rolled = recordedFormalRun(
      provenance([
        propertyResult('proved', { depth: 20, elapsedMs: 1 }),
        propertyResult('could-not-verify', { depth: 70, elapsedMs: 150_000 }),
      ]),
    );

    expect(rolled?.verdict).toBe('could-not-verify');
    expect(rolled?.depth).toBe(70);
    expect(rolled?.elapsedMs).toBe(150_000);
  });
});

describe('the cross-field rules a v13 record is held to', () => {
  // Each rule here makes unreadable only a record NO WRITER OF THIS SCHEMA CAN PRODUCE. The
  // no-cost direction - that every record the writers DO produce still decodes - is quantified
  // by `app/test/formal-record-round-trip.property.test.ts` and
  // `app/test/formal-summary-aggregation.property.test.ts`, both of which build their records
  // through the same pairings the Verification_Loop and the harness build theirs through. These
  // tests pin the refusal direction, so a rule that silently stopped firing is a failure here
  // rather than a gate nobody notices is gone. Task 19.6 quantifies each one over classes of
  // violating value; this block states that each rule exists.

  /**
   * Every formal key a v13 record defines (Req 12.34).
   *
   * `satisfies` over `keyof SweepSampleRecord`, so a renamed field breaks here. Kept beside the
   * rule rather than shared with Property 29's `FORMAL_FIELDS`, which is the same membership for
   * a different purpose - stripping the fields a v12 writer never emitted.
   */
  const FORMAL_KEYS = [
    'formal',
    'formalFallbackReason',
    'formalFallbackRoute',
    'formalResetContract',
    'formalAssertionGateEmitted',
    'formalClockPolarity',
    'propertySetAdmitted',
    'propertySetSurvivorCount',
    'formalMutationCounts',
  ] satisfies readonly (keyof SweepSampleRecord)[];

  it('refuses a record missing ANY formal key, so a deleted key cannot assert a fact', () => {
    // Req 12.34. Four of these keys read an ABSENT value as a meaningful `null` on their own -
    // `formal` as "no Formal_Property was submitted", `formalResetContract` as "the pre-pass was
    // never reached" - and each of those is a FACT about what was measured. So an explicit
    // `null` has to be the only spelling of a formal fact that does not apply, and a
    // hand-editor deleting the key has to lose the record rather than gain a claim.
    for (const key of FORMAL_KEYS) {
      expect(decodeSampleRecord(recordWithout(key))).toBeNull();
    }
  });

  it('refuses a setup-failed record carrying a formal run', () => {
    // Req 12.29. A `setup-failed` outcome is returned straight out of `VerificationLoop#verify`'s
    // `#setup`, before a candidate or an independent testbench exists, so no Formal_Property can
    // have been submitted. Reading one would credit a Formal_Verdict to a sample whose candidate
    // was never generated.
    expect(
      decodeSampleRecord({ ...record({ outcomeStatus: 'setup-failed' }), formal: formalRun() }),
    ).toBeNull();
    // The same status WITHOUT a run is the producible record, and it still decodes.
    expect(roundTrip(record({ outcomeStatus: 'setup-failed', formal: null }))).not.toBeNull();
  });

  it('refuses both halves of the Fallback_Reason / Fallback_Route iff', () => {
    // Req 12.31, 7.19. `formalProvenanceOf` makes the iff true by construction off a
    // discriminated `TakenRoute`, so neither half is producible: a reason under another route
    // names a cause for a fall back no cause drove, and the `cause` route with no reason claims
    // a cause decided the sample while refusing to say which. Req 7.22's per-route counts read
    // the route and its per-cause counts read the reason, so a record breaking the iff would be
    // counted under a route and a cause describing two different samples.
    for (const route of FALLBACK_ROUTES.filter((member) => member !== 'cause')) {
      expect(
        decodeSampleRecord({
          ...record(),
          formalFallbackReason: 'toolchain-unavailable',
          formalFallbackRoute: route,
        }),
      ).toBeNull();
    }
    expect(
      decodeSampleRecord({
        ...record(),
        formalFallbackReason: null,
        formalFallbackRoute: 'cause',
      }),
    ).toBeNull();
  });

  it('refuses a surviving mutant counted beside anything but a refusal', () => {
    // Req 12.32, 10.8. An ADMITTED set refuted every mutant in a non-empty gate set, and
    // `'no-gate-set'` and `'not-gated'` had no gate set for a mutant to survive, so a count
    // under any of the three reports a demonstrated weakness in a Property_Set nothing refused.
    for (const outcome of PROPERTY_SET_ADMISSION_OUTCOMES.filter(
      (member) => member !== 'refused',
    )) {
      expect(
        decodeSampleRecord({
          ...record(),
          propertySetAdmitted: outcome,
          propertySetAuthoredUpFront: false,
          propertySetSurvivorCount: 1,
        }),
      ).toBeNull();
    }
    // A refusal names at least one survivor, which is the producible pairing.
    expect(
      roundTrip(record({ propertySetAdmitted: 'refused', propertySetSurvivorCount: 1 })),
    ).not.toBeNull();
  });

  it('refuses counts whose killed and survived do not sum to the denominator', () => {
    // Req 12.33. `formalMutationCounts` admits a mutant to the denominator on exactly the
    // condition `formalMutantIsScorable` names, and the only unscorable calibration is the one
    // `couldNotVerifyCount` tallies - so the denominator IS the sum of the two scored counts
    // rather than a free number beside them. A larger one understates `formalKillRateOf`'s
    // quotient over mutants nobody scored; a smaller one overstates it. Both read as measured.
    for (const denominator of [4, 6]) {
      expect(
        decodeSampleRecord({
          ...record(),
          formalMutationCounts: {
            // The partition still holds, so this is refused by the DENOMINATOR rule alone.
            totalCount: 7,
            denominator,
            killedCount: 4,
            survivedCount: 1,
            couldNotVerifyCount: 2,
          },
        }),
      ).toBeNull();
    }
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

// formal-property-oracle task 12.8, Property 29: A record from an older schema is refused.
//
// WHAT IS CLAIMED, OVER WHAT
//   For any results file holding at least one record written under a schema version below the
//   current one - whatever else it holds and in any order: current records of this experiment,
//   records of another experiment, corrupt lines, a FUTURE version, and blank lines - the whole
//   file is refused by the one rule the current version already applies to its predecessor
//   (Req 12.10). `parseResultsLog` counts every older line as stale rather than corrupt,
//   `summarizeRecords` aggregates nothing, scoped to the experiment or not, and `renderSummary`
//   prints the refusal and the advice text and no arm at all (Req 12.13).
//
// WHAT IT ADDS TO WHAT IS ALREADY PINNED
//   Task 12.3 pinned one previous-version line, alone and beside one current record, and
//   instrument-precheck-and-attribution's Property 14 above pins older lines placed FIRST beside
//   current records only, each in the CURRENT shape stamped with an older number. This property
//   adds the shape a v12 writer really emitted, with none of the seven formal fields; older lines
//   anywhere in the file; corrupt, future-version, blank, and other-experiment lines beside them;
//   both summary scopes; and the rendered refusal. The two shapes matter apart: a decoder that
//   admitted version 12 would still drop the formal-less line as unreadable, and only the
//   current-shaped one would expose it.
//
// THE CLOSED PART IS EXHAUSTED
//   Every older version, 1 to 12, in both shapes, is refused beside a current record on every run,
//   as a fact rather than a draw. The property samples the files around an older line.
//
// FALSIFIED, out of tree, with no shared file edited
//   This block was run unedited with `./results-log.js` and `./summary.js` redirected to scratch
//   copies. The unmutated copies passed, and each of 7 one-line mutants failed: only the previous
//   version read as stale, a future version read as stale, a stale line required to carry the
//   formal fields, the decoder admitting the previous version, the refusal kept to a file of
//   nothing but stale lines, the refusal kept to a summary scoped to an experiment, and the
//   refusal printed without its advice. The future-version and scoped-only mutants fail the
//   property alone, because the exhaustive case holds neither a future line nor a null scope.
//
// RUN COUNT: see `PROPERTY_29_NUM_RUNS`.
//
// **Validates: Requirements 12.10**

// **Feature: formal-property-oracle, Property 29: A record from an older schema is refused**
const PROPERTY_29 = 'formal-property-oracle, Property 29: A record from an older schema is refused';

/**
 * Sized to the rarest required row. Measured over 20,000 draws of `olderFileArbitrary` at seeds 1
 * and 42, the share of files holding each row was: every non-blank line older 19.7% / 19.2%, the
 * older line not first 46.9% / 47.3%, each other kind of line beside it 50.5% to 51.4%, several
 * older lines 51.4% / 51.6%, and each older shape 65.6% to 65.9%. So the rarest is missed in 200
 * runs with probability about 0.808^200 ~ 3e-19. Each row is asserted as `> 0`, so the arithmetic
 * is `(1 - p)^n`.
 */
const PROPERTY_29_NUM_RUNS = 200;

/** The version the current one replaced: the case Req 12.10 names. */
const PREVIOUS_SCHEMA_VERSION = RESULTS_SCHEMA_VERSION - 1;

/** The experiment the default record belongs to, and another one beside it. */
const THIS_EXPERIMENT = 'abc123';
const OTHER_EXPERIMENT = 'another-experiment';

/** The fields the v12 -> v13 bump added. A v12 writer emitted none of them. */
const FORMAL_FIELDS: ReadonlySet<string> = new Set([
  'formal',
  'formalFallbackReason',
  'formalFallbackRoute',
  'formalResetContract',
  'formalAssertionGateEmitted',
  'formalClockPolarity',
  'propertySetAdmitted',
  'propertySetSurvivorCount',
  'formalMutationCounts',
] satisfies readonly (keyof SweepSampleRecord)[]);

/** How an older line is shaped: as a v12 writer emitted it, or the current shape stamped older. */
const OLDER_SHAPES = ['without-formal-fields', 'current-fields'] as const;
type OlderShape = (typeof OLDER_SHAPES)[number];

/** What one line of a generated file is, so the property can tally what it generated. */
type FileLineKind = 'older' | 'current' | 'other-experiment' | 'corrupt' | 'blank';

interface FileLine {
  readonly kind: FileLineKind;
  /** The older line's shape; `null` on every other kind. */
  readonly olderShape: OlderShape | null;
  readonly text: string;
}

/**
 * Lines that are corruption, not history: a TRUNCATED v12 line, which never parsed, plain text,
 * and a garbage version. None may trigger the refusal, and none may stop it.
 *
 * A FUTURE version is deliberately NOT here. It used to be, on the reading that nothing writes
 * one; Req 12.28 reversed that - a well-formed record at a higher version is what a NEWER BUILD
 * writes - so it now refuses the file by the same rule an older one does, and listing it as a
 * line that may not trigger the refusal would assert the opposite. The claim quantified here
 * stays Req 12.10's, over an OLDER record; extending this property over the future-version case
 * is task 19.6's, and `results-log.test.ts`'s own future-version test above pins it meanwhile.
 */
const CORRUPT_LINES: readonly string[] = [
  `{"schemaVersion":${PREVIOUS_SCHEMA_VERSION},"configHash":"abc`,
  'not json at all',
  JSON.stringify({ ...record(), schemaVersion: 'twelve' }),
];

/** One record written under `version`, in `shape`, as the JSONL line a results file holds. */
function olderLine(version: number, shape: OlderShape, configHash: string): FileLine {
  const stamped = { ...record({ configHash }), schemaVersion: version };
  const fields =
    shape === 'current-fields'
      ? stamped
      : Object.fromEntries(Object.entries(stamped).filter(([field]) => !FORMAL_FIELDS.has(field)));
  return { kind: 'older', olderShape: shape, text: JSON.stringify(fields) };
}

/** A line that is not older, so it only ever sits beside the older line. */
function plainLine(kind: Exclude<FileLineKind, 'older'>, text: string): FileLine {
  return { kind, olderShape: null, text };
}

const olderLineArbitrary: fc.Arbitrary<FileLine> = fc
  .tuple(
    fc.integer({ min: 1, max: PREVIOUS_SCHEMA_VERSION }),
    fc.constantFrom(...OLDER_SHAPES),
    fc.constantFrom(THIS_EXPERIMENT, OTHER_EXPERIMENT),
  )
  .map(([version, shape, configHash]) => olderLine(version, shape, configHash));

/** Any line a results file can hold, older ones included, so a file may hold several. */
const fileLineArbitrary: fc.Arbitrary<FileLine> = fc.oneof(
  olderLineArbitrary,
  fc
    .nat({ max: 1_000 })
    .map((sampleIndex) => plainLine('current', encodeSampleRecord(record({ sampleIndex })))),
  fc
    .nat({ max: 1_000 })
    .map((sampleIndex) =>
      plainLine(
        'other-experiment',
        encodeSampleRecord(record({ configHash: OTHER_EXPERIMENT, sampleIndex })),
      ),
    ),
  fc.constantFrom(...CORRUPT_LINES).map((text) => plainLine('corrupt', text)),
  fc.constantFrom('', '   ').map((text) => plainLine('blank', text)),
);

/** A file holding at least one older line, at any position among up to eight other lines. */
const olderFileArbitrary: fc.Arbitrary<readonly FileLine[]> = fc
  .tuple(fc.array(fileLineArbitrary, { maxLength: 8 }), olderLineArbitrary, fc.nat())
  .map(([others, older, at]) => {
    const position = at % (others.length + 1);
    return [...others.slice(0, position), older, ...others.slice(position)];
  });

/** The whole file is refused: nothing aggregated, and the refusal rendered with its advice. */
function assertFileRefused(lines: readonly FileLine[], configHash: string | null): void {
  const olderCount = lines.filter((line) => line.kind === 'older').length;
  const parsed = parseResultsLog(lines.map((line) => line.text).join('\n'));
  const summary = summarizeRecords(parsed.records, [1], configHash, parsed);
  const rendered = renderSummary(summary);
  // Every older line is history rather than corruption, whatever its shape.
  expect(parsed.staleSchemaLines).toBe(olderCount);
  expect(summary.refusedStaleSchema).toBe(true);
  expect(summary.arms).toEqual([]);
  expect(summary.totalSamples).toBe(0);
  expect(summary.deferredSamples).toBe(0);
  // The refusal and its advice, and nothing a reader could take for a number.
  expect(rendered.slice(1)).toEqual([
    `REFUSED: ${olderCount} results line(s) use an older record schema`,
    ...STALE_SCHEMA_ADVICE.map((line) => `  ${line}`),
  ]);
  expect(rendered.join(' ')).toContain('FORMAL VERDICT');
  expect(rendered.join(' ')).toContain('FRESH outputDir');
}

/** What the run drew, so each part of the claim is shown to have met the file it is about. */
interface DrawnFiles {
  runs: number;
  readonly besideKinds: Map<FileLineKind, number>;
  readonly shapes: Map<OlderShape, number>;
  readonly scopes: Map<string | null, number>;
  olderNotFirst: number;
  severalOlder: number;
  onlyOlder: number;
}

function noFilesDrawn(): DrawnFiles {
  return {
    runs: 0,
    besideKinds: new Map(),
    shapes: new Map(),
    scopes: new Map(),
    olderNotFirst: 0,
    severalOlder: 0,
    onlyOlder: 0,
  };
}

/** Bump a counter keyed by a closed member. */
function bump<Key>(counts: Map<Key, number>, key: Key): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Record one file's shape. A NON-VACUITY COUNTER, never part of an expectation. */
function recordFile(
  drawn: DrawnFiles,
  lines: readonly FileLine[],
  configHash: string | null,
): void {
  const nonBlank = lines.filter((line) => line.kind !== 'blank');
  drawn.runs += 1;
  bump(drawn.scopes, configHash);
  for (const kind of new Set(lines.map((line) => line.kind))) {
    if (kind !== 'older') {
      bump(drawn.besideKinds, kind);
    }
  }
  for (const shape of new Set(lines.flatMap((line) => line.olderShape ?? []))) {
    bump(drawn.shapes, shape);
  }
  drawn.olderNotFirst += nonBlank[0]?.kind === 'older' ? 0 : 1;
  drawn.severalOlder += nonBlank.filter((line) => line.kind === 'older').length > 1 ? 1 : 0;
  drawn.onlyOlder += nonBlank.every((line) => line.kind === 'older') ? 1 : 0;
}

describe(PROPERTY_29, () => {
  it('refuses every older version in both shapes, placed after a current record', () => {
    const current = plainLine('current', encodeSampleRecord(record()));
    for (let version = 1; version <= PREVIOUS_SCHEMA_VERSION; version += 1) {
      for (const shape of OLDER_SHAPES) {
        assertFileRefused([current, olderLine(version, shape, THIS_EXPERIMENT)], THIS_EXPERIMENT);
      }
    }
  });

  it('refuses the whole file, whatever else it holds and wherever the older line sits', () => {
    const drawn = noFilesDrawn();
    fc.assert(
      fc.property(
        olderFileArbitrary,
        fc.constantFrom<string | null>(THIS_EXPERIMENT, null),
        (lines, configHash) => {
          recordFile(drawn, lines, configHash);
          assertFileRefused(lines, configHash);
        },
      ),
      { numRuns: PROPERTY_29_NUM_RUNS },
    );
    expect(drawn.runs).toBe(PROPERTY_29_NUM_RUNS);
    // Mixed files: every other kind of line sat beside an older one somewhere in the run.
    expect([...drawn.besideKinds.keys()].sort()).toEqual([
      'blank',
      'corrupt',
      'current',
      'other-experiment',
    ]);
    expect([...drawn.shapes.keys()].sort()).toEqual([...OLDER_SHAPES].sort());
    expect([...drawn.scopes.keys()]).toHaveLength(2);
    expect(drawn.olderNotFirst).toBeGreaterThan(0);
    expect(drawn.severalOlder).toBeGreaterThan(0);
    // The plainest file of all: nothing but older records.
    expect(drawn.onlyOlder).toBeGreaterThan(0);
  });
});

describe('propertySetAuthoredUpFront is required present (Req 6.9)', () => {
  it('decodes a version-14 record that carries the field', () => {
    const gated = roundTrip(record({ propertySetAuthoredUpFront: true }));
    const ungated = roundTrip(record({ propertySetAuthoredUpFront: false }));

    expect(gated?.propertySetAuthoredUpFront).toBe(true);
    // `false` decodes as `false` rather than being read as absent.
    expect(ungated?.propertySetAuthoredUpFront).toBe(false);
  });

  it('refuses the same record with the key DELETED, rather than reading it as false', () => {
    // The distinction this field exists for: a gate that found no reference design, or that
    // threw, records `not-gated` AFTER the set was authored and charged. So an absent key read
    // as `false` would assert this sample paid for no authoring, which is a fact nobody
    // measured, and the two samples have different `costCents`.
    expect(decodeSampleRecord(recordWithout('propertySetAuthoredUpFront'))).toBeNull();
  });
});

describe('Property 13: record round trip at schema 16', () => {
  // Feature: testbench-in-order-scoreboard, Property 13: Record round trip at schema 15.
  // Validates: Requirements 1.8, 7.4.
  //
  // Feature: testbench-spec-grounding, Property 17: Record round trip at schema 16.
  // Validates: Requirements 5.11, 7.10, 9.5, 9.10. The three v16 fields ride the same
  // property, because "it decodes to an equal record" is the same statement over more fields.

  /** The four Positive_Control booleans, or no run at all. */
  const positiveControlRun = fc.oneof(
    fc.constant(null),
    fc.record({
      passed: fc.boolean(),
      watchdogStopped: fc.boolean(),
      waveformMissing: fc.boolean(),
      knownAnswerOnlyFailure: fc.boolean(),
    }),
  );

  /** Any real (arm, approach, group, versions); only Treatment routes the scoreboard. */
  const strategyFields = fc
    .record({
      strategyArm: fc.constantFrom(...STRATEGY_ARMS),
      checkingApproach: fc.constantFrom(...CHECKING_APPROACHES),
      designGroup: fc.constantFrom(...DESIGN_GROUPS),
      testbenchPromptVersion: fc.integer({ min: 1, max: 1_000 }),
      simulationHarnessVersion: fc.integer({ min: 1, max: 1_000 }),
      testbenchParseRefusal: fc.oneof(
        fc.constant(null),
        fc.constantFrom(...TESTBENCH_PARSE_REFUSALS),
      ),
      positiveControlRun,
    })
    .filter(
      (f) => !(f.checkingApproach === 'in-order-scoreboard' && f.strategyArm !== 'treatment'),
    );

  const decodeLine = (line: string): SweepSampleRecord | null =>
    decodeSampleRecord(JSON.parse(line) as unknown);

  it('decodes its own encoding to an equal record', () => {
    fc.assert(
      fc.property(strategyFields, (fields) => {
        const written = record(fields);
        expect(decodeLine(encodeSampleRecord(written))).toEqual(written);
      }),
    );
  });

  it('refuses an unknown vocabulary value, a non-positive version, or an impossible pair', () => {
    const bad = fc.oneof(
      fc.record({
        strategyArm: fc.string().filter((v) => !(STRATEGY_ARMS as readonly string[]).includes(v)),
      }),
      fc.record({
        checkingApproach: fc
          .string()
          .filter((v) => !(CHECKING_APPROACHES as readonly string[]).includes(v)),
      }),
      fc.record({
        designGroup: fc.string().filter((v) => !(DESIGN_GROUPS as readonly string[]).includes(v)),
      }),
      fc.record({ testbenchPromptVersion: fc.integer({ min: -5, max: 0 }) }),
      fc.record({ simulationHarnessVersion: fc.integer({ min: -5, max: 0 }) }),
      fc.constant({ strategyArm: 'control', checkingApproach: 'in-order-scoreboard' }),
      // Req 9.10: `grounded` is refused with the scoreboard exactly as `control` is.
      fc.constant({ strategyArm: 'grounded', checkingApproach: 'in-order-scoreboard' }),
      // An unknown refusal code must make the record undecodable, never read as "parsed".
      fc.record({
        testbenchParseRefusal: fc
          .string()
          .filter((v) => !(TESTBENCH_PARSE_REFUSALS as readonly string[]).includes(v)),
      }),
      fc.constant({ positiveControlRun: { passed: true } }),
      fc.constant({ positiveControlRun: { passed: 'yes' } }),
      fc.record({ schemaVersion: fc.integer({ min: 1, max: RESULTS_SCHEMA_VERSION - 1 }) }),
    );
    fc.assert(
      fc.property(strategyFields, bad, (fields, override) => {
        const line = JSON.stringify({ ...record(fields), ...override });
        expect(decodeLine(line)).toBeNull();
      }),
    );
  });
});

describe('Property 14: resume never counts a mismatched record', () => {
  // Feature: testbench-in-order-scoreboard, Property 14: Resume never counts a mismatched
  // record. Validates: Requirements 7.5.
  //
  // Feature: testbench-spec-grounding, Property 18: Resume never counts a mismatched record.
  // Validates: Requirements 9.6. The same property, with `simulationHarnessVersion` in the
  // running filter: a record made under another harness measured another instrument.
  const arms = ['arm-control', 'arm-grounded'] as const;
  const running = {
    testbenchPromptVersion: 4,
    simulationHarnessVersion: 2,
    strategyOf: (armName: string): StrategyArm =>
      armName === 'arm-grounded' ? 'grounded' : 'control',
  };
  it('counts a slot only when hash, arm strategy, and both versions match the run', () => {
    const slot = fc.record({
      armName: fc.constantFrom(...arms),
      configHash: fc.constantFrom('run-hash', 'other-hash'),
      strategyArm: fc.constantFrom(...STRATEGY_ARMS),
      testbenchPromptVersion: fc.constantFrom(3, 4),
      simulationHarnessVersion: fc.constantFrom(1, 2),
      sampleIndex: fc.nat({ max: 3 }),
    });
    fc.assert(
      fc.property(fc.array(slot, { maxLength: 12 }), (slots) => {
        const records = slots.map((s) => record({ ...s, checkingApproach: 'cycle-timed' }));
        const index = CompletedSampleIndex.fromRecords(records, 'run-hash', running);
        for (const s of slots) {
          // The oracle: some record for this slot carries every running value.
          const expected = slots.some(
            (o) =>
              o.armName === s.armName &&
              o.sampleIndex === s.sampleIndex &&
              o.configHash === 'run-hash' &&
              o.testbenchPromptVersion === running.testbenchPromptVersion &&
              o.simulationHarnessVersion === running.simulationHarnessVersion &&
              o.strategyArm === running.strategyOf(o.armName),
          );
          expect(index.isComplete(s.armName, record().problemId, s.sampleIndex)).toBe(expected);
        }
      }),
    );
  });
});

describe('valuelessFailureReports at schema 17 (Req 2.8, 5.4)', () => {
  const decodeLine = (line: string): SweepSampleRecord | null =>
    decodeSampleRecord(JSON.parse(line) as unknown);

  it.each([2, null])('round-trips a count of %s unchanged', (count) => {
    const written = record({ valuelessFailureReports: count });
    expect(decodeLine(encodeSampleRecord(written))).toEqual(written);
  });

  it.each([-1, 1.5, '2'])(
    'refuses the record whose count is %j rather than reading it as 0',
    (bad) => {
      const line = JSON.stringify({ ...record(), valuelessFailureReports: bad });
      expect(decodeLine(line)).toBeNull();
    },
  );

  it('refuses the record whose count is MISSING, because 0 would claim a measurement', () => {
    expect(decodeSampleRecord(recordWithout('valuelessFailureReports'))).toBeNull();
  });

  it('refuses a v16 file wholesale, with the advice naming the missing detector', () => {
    const v16 = JSON.stringify({ ...record(), schemaVersion: 16 });
    const parsed = parseResultsLog(v16);
    expect(parsed.staleSchemaLines).toBe(1);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.records).toEqual([]);
    const advice = STALE_SCHEMA_ADVICE.join(' ');
    expect(advice).toContain('ten independent reasons');
    expect(advice).toContain('the detector did not exist when it was');
  });
});
