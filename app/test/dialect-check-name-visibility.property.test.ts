// testbench-dialect-normalization, Property 18: The Check_Name_Visibility_Signal fires on exactly
// the stated conjunction and changes nothing (task 7.8).
//
// WHAT THIS ASSERTS
//   The signal is `true` IF AND ONLY IF all three hold at once: the Dialect_Normalizer CHANGED the
//   source, the Positive_Control reported the sample VALID, and at least one PRE-normalization check
//   name is absent from the names `readCheckSignals` finds in the control's stdout. And for any
//   sample, the oracle verdict, the golden verdict, and the Recorded_Instrument_Verdict are each
//   identical to the value they would hold with the signal never computed.
//
// WHY THIS SIGNAL EXISTS AT ALL
//   It is the early warning for the one failure mode a "it compiles now" transform can produce: a
//   testbench that was desugared, then PASSED the reference design, while quietly no longer emitting
//   a check it was generated to emit. That sample would read as a clean measurement of something
//   smaller than it claims. Property 5 is the reason the signal should stay quiet; this property is
//   the reason it is trustworthy when it does not.
//
// THE ARBITRARY GENERATES A STRICT SUBSET, NOT ONLY THE FULL SET OR THE EMPTY ONE
//   Task 7.8 requires it, and the reason is that the interesting third conjunct is "at least one
//   name is absent". Generating only the full set makes the conjunction always false; generating only
//   the empty set makes it always true whenever the first two hold. The generated space is a subset
//   of the pre-normalization names with every cardinality from 0 to n, and the counted guards below
//   FAIL if a strict, non-empty subset was never produced, or if the signal was never observed both
//   `true` and `false`.
//
// HOW "CHANGES NOTHING" IS ASSERTED
//   Two ways, because neither alone is enough. First, directly: the three verdict fields are compared
//   against the values the fakes were SCRIPTED with, so each is shown to track its own source rather
//   than the signal. Second, differentially: the identical fixture is run a second time with the
//   control reporting the FULL name set - the only input that moves the signal and nothing else - and
//   the three verdict fields must be byte-identical across the two runs while the signal itself may
//   differ. A field that read the signal would move in the second run.
//
// The tag string is a literal, not `propertyTag(...)`
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 5.8, 5.11

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { VerificationOutcome } from '@app/agent';
import {
  createEvalHarness,
  FIXED_EVAL_SUBSET,
  invalidInstrument,
  makeReproducibilityConfig,
  uncheckedInstrument,
  VALID_INSTRUMENT,
  type EvalLoopRunner,
  type EvalSampleRequest,
  type GoldenJudge,
  type InstrumentControl,
  type InstrumentControlResult,
  type RecordedGoldenVerdict,
  type RecordedInstrumentVerdict,
  type SampleResult,
  type StudentSessionCaps,
} from '@app/eval';
import { readCheckSignals, type ResourceLimits } from '@app/tools';

import { checkNameArbitrary } from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'testbench-dialect-normalization, Property 18: The Check_Name_Visibility_Signal fires on ' +
  'exactly the stated conjunction and changes nothing';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const CAPS: StudentSessionCaps = {
  maxIterations: 20,
  maxTokens: 1_000_000,
  maxWallClockMs: 1_000_000,
  maxCostCents: 1_000_000,
};

/** The golden verdict every run is scripted with, so a move in it would be visible. */
const GOLDEN: RecordedGoldenVerdict = Object.freeze({ kind: 'passed', failureCount: 0 });

/** The three terminal statuses that reach a point where a Testbench was normalized. */
const NORMALIZED_STATUSES = ['verified', 'unverified', 'instrument-refused'] as const;

/** One generated scenario: what the loop returned, and what the control reported. */
interface Scenario {
  readonly status: (typeof NORMALIZED_STATUSES)[number];
  readonly normalizationChanged: boolean;
  readonly preNormalizationCheckNames: readonly string[];
  /** The indices of the pre-normalization names the control's stdout reports. */
  readonly reportedIndices: readonly number[];
  readonly validity: 'valid' | 'invalid' | 'unchecked';
}

/**
 * A terminal outcome carrying only the fields the harness reads off it.
 *
 * Cast rather than fully constructed for the same reason `app/eval/harness.test.ts` casts: the real
 * outcome also carries a Trust_Labeler label, a recorded `VerificationResult`, and an oracle span
 * id this property neither supplies nor asserts on. `normalization` is GENERATED here rather than
 * pinned to an unnormalized baseline, which is the whole point - an arbitrary that pinned
 * `changed: false` could never exercise the first conjunct.
 */
function outcomeFor(scenario: Scenario): VerificationOutcome {
  return {
    status: scenario.status,
    iterations: 1,
    moduleVersion: { rtl: 'module m; endmodule' },
    candidate: { rtl: 'module m; endmodule' },
    testbench: { source: 'module m_tb; endmodule' },
    normalization: {
      report: {
        normalizerVersion: 3,
        changed: scenario.normalizationChanged,
        findings: [],
        refusedWholeSource: null,
      },
      preNormalizationCheckNames: scenario.preNormalizationCheckNames,
      valuelessFailureReports: 0,
    },
  } as unknown as VerificationOutcome;
}

/** The `RecordedInstrumentVerdict` one generated validity stands for. */
function verdictFor(validity: Scenario['validity']): RecordedInstrumentVerdict {
  if (validity === 'valid') {
    return VALID_INSTRUMENT;
  }
  if (validity === 'invalid') {
    return invalidInstrument('TESTBENCH_FAILED_REFERENCE');
  }
  return uncheckedInstrument('no-reference');
}

/** The control's stdout, in the oracle's own line-anchored `CHECK <name> PASS` grammar. */
function stdoutReporting(names: readonly string[]): string {
  return names.map((name) => `CHECK ${name} PASS`).join('\n');
}

/** A loop runner that returns one scripted outcome and charges a token, never a model call. */
class ScriptedLoopRunner implements EvalLoopRunner {
  readonly #outcome: VerificationOutcome;
  constructor(outcome: VerificationOutcome) {
    this.#outcome = outcome;
  }
  runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    request.budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#outcome);
  }
}

/** A positive control that always reports one scripted verdict and one scripted stdout. */
class ScriptedControl implements InstrumentControl {
  readonly #result: InstrumentControlResult;
  constructor(verdict: RecordedInstrumentVerdict, stdout: string) {
    this.#result = { verdict, stdout, stderr: '', exitCode: 0, mutation: null, positiveRun: null };
  }
  check(): Promise<InstrumentControlResult> {
    return Promise.resolve(this.#result);
  }
}

/** A judge that always reports the same golden verdict, making no model call. */
class ScriptedJudge implements GoldenJudge {
  // The request parameter is omitted rather than underscore-prefixed: typescript-eslint's
  // `no-unused-vars` runs with `args: 'after-used'`, which flags a trailing interface-method
  // parameter even when it is underscore-prefixed
  // (`chipAgent/_inbox/gotcha-eslint-after-used-unused-args.md`).
  judge(): Promise<RecordedGoldenVerdict> {
    return Promise.resolve(GOLDEN);
  }
}

/** The first problem of the fixed subset, failing loudly rather than silently on an empty subset. */
function firstProblem() {
  const problem = FIXED_EVAL_SUBSET[0];
  if (problem === undefined) {
    throw new Error('the fixed eval subset is empty');
  }
  return problem;
}

/** Run one sample through a real `EvalHarness` wired to the scripted fakes. */
async function runOneSample(
  outcome: VerificationOutcome,
  verdict: RecordedInstrumentVerdict,
  stdout: string,
): Promise<SampleResult> {
  const config = makeReproducibilityConfig({ seed: 7, temperature: 0, sampleCount: 1 });
  if (!config.ok) {
    throw new Error(config.error.message);
  }
  const built = createEvalHarness({
    loopRunner: new ScriptedLoopRunner(outcome),
    instrumentControl: new ScriptedControl(verdict, stdout),
    goldenJudge: new ScriptedJudge(),
    caps: CAPS,
    limits: LIMITS,
    config: config.value,
    costEnvelopeCents: 100,
  });
  if (!built.ok) {
    throw new Error(built.error.code);
  }
  const report = await built.value.run([firstProblem()]);
  const sample = report.problems[0]?.samples[0];
  if (sample === undefined) {
    throw new Error('the harness produced no sample');
  }
  return sample;
}

/** The scenario arbitrary: every conjunct varied independently, subsets of every cardinality. */
function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return fc
    .record({
      status: fc.constantFrom(...NORMALIZED_STATUSES),
      normalizationChanged: fc.boolean(),
      preNormalizationCheckNames: fc.uniqueArray(checkNameArbitrary(), {
        minLength: 1,
        maxLength: 4,
      }),
      validity: fc.constantFrom('valid' as const, 'invalid' as const, 'unchecked' as const),
    })
    .chain((partial) =>
      fc
        .subarray([...partial.preNormalizationCheckNames.keys()])
        .map((reportedIndices) => ({ ...partial, reportedIndices })),
    );
}

describe(PROPERTY, () => {
  it('fires on exactly the conjunction, and moves no verdict field', async () => {
    let firedTrue = 0;
    let firedFalse = 0;
    let strictNonEmptySubsets = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArbitrary(), async (scenario) => {
        const names = scenario.preNormalizationCheckNames;
        const reported = scenario.reportedIndices.flatMap((index) => {
          const name = names[index];
          return name === undefined ? [] : [name];
        });
        if (reported.length > 0 && reported.length < names.length) {
          strictNonEmptySubsets += 1;
        }

        const outcome = outcomeFor(scenario);
        const verdict = verdictFor(scenario.validity);
        const sample = await runOneSample(outcome, verdict, stdoutReporting(reported));

        // The conjunction, re-derived from the SCENARIO rather than from the harness, and graded
        // through `readCheckSignals` because that is the owner of the control's stdout grammar.
        const reportedNames = new Set(
          readCheckSignals(stdoutReporting(reported)).checks.map((check) => check.name),
        );
        const expected =
          scenario.normalizationChanged &&
          scenario.validity === 'valid' &&
          names.some((name) => !reportedNames.has(name));
        expect(sample.checkNameVisibilitySignal).toBe(expected);

        // The three verdict fields track their own scripted sources, not the signal.
        expect(sample.passed).toBe(scenario.status === 'verified');
        expect(sample.outcomeStatus).toBe(scenario.status);
        expect(sample.goldenVerdict).toEqual(GOLDEN);
        expect(sample.instrumentVerdict).toEqual(verdict);

        // Differentially: the same fixture with the control reporting EVERY pre-normalization name.
        // That is the one input that moves the signal, so any verdict field that moved with it
        // would be reading the signal.
        const withFullReport = await runOneSample(outcome, verdict, stdoutReporting(names));
        expect(withFullReport.checkNameVisibilitySignal).toBe(false);
        expect(withFullReport.passed).toBe(sample.passed);
        expect(withFullReport.outcomeStatus).toBe(sample.outcomeStatus);
        expect(withFullReport.goldenVerdict).toEqual(sample.goldenVerdict);
        expect(withFullReport.instrumentVerdict).toEqual(sample.instrumentVerdict);
        expect(withFullReport.iterations).toBe(sample.iterations);
        expect(withFullReport.noVerdictCause).toBe(sample.noVerdictCause);

        if (sample.checkNameVisibilitySignal) {
          firedTrue += 1;
        } else {
          firedFalse += 1;
        }
      }),
      propertyParameters(),
    );

    // Non-vacuity: both polarities of the signal were observed, and a STRICT non-empty subset of
    // the pre-normalization names was actually generated - the case the conjunction turns on.
    expect(firedTrue).toBeGreaterThan(0);
    expect(firedFalse).toBeGreaterThan(0);
    expect(strictNonEmptySubsets).toBeGreaterThan(0);
  });
});
