// Unit tests for the harness's PROPERTY-SET gate path: the third sibling of the agreement
// and positive-control suites, and the only one whose check runs BEFORE the sample.
//
// WHAT THESE PIN DOWN
//   1. A REFUSED Property_Set takes the Simulation_Fallback: the harness hands the runner the
//      refusal, which `propertySetAdmissionFallsBack` makes the signal that no Property_Set
//      may decide this sample (Req 10.3), and the sample records the outcome together with
//      the surviving-mutant count (Req 10.8).
//   2. An ADMITTED one does NOT fall back. This is the positive control for the row above:
//      without it, a harness that fell back on EVERY sample would pass test 1.
//   3. `no-gate-set` does not fall back either, asserted explicitly rather than inherited
//      from a truthiness check, because that is a DECISION about a case criterion 10.3 does
//      not name and it must be visible as one.
//   4. All FOUR members reach the record distinctly, so no admission fact reads as another -
//      in particular a gate that could not run is `'not-gated'` and never `'refused'`.
//   5. The gate makes no model call OF ITS OWN: a gated and an ungated run differ by exactly
//      the up-front authoring charge, in two measured fields and in no others (Req 6.9, 6.10).
//
// Driven through fakes: no provider SDK, no real oracle, no toolchain.
import { describe, expect, it } from 'vitest';
import type {
  FormalPropertySet,
  PropertySetAdmissionOutcome,
  PropertySetSource,
  SessionBudgetHandle,
  VerificationOutcome,
} from '@app/agent';
import type { Spec } from '@app/core';
import type { ResourceLimits } from '@app/tools';
import { createEvalHarness } from './harness.js';
import type { EvalProblem } from './problem.js';
import type { EvalLoopRunner, EvalSampleRequest, StudentSessionCaps } from './loop-runner.js';
import { mutantIdOf, type MutantCalibration, type MutantIdentity } from './mutation-control.js';
import {
  propertySetAdmissionFallsBack,
  type CalibratedFormalMutant,
  type FormalMutantCalibration,
  type PropertySetGate,
  type PropertySetGateRequest,
} from './property-set-admission.js';
import { makeReproducibilityConfig, type ReproducibilityConfig } from './reproducibility.js';
import type { EvalRunReport, SampleResult } from './report.js';
import { FIXED_EVAL_SUBSET } from './subset.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const CAPS: StudentSessionCaps = {
  maxIterations: 20,
  maxTokens: 1_000_000,
  maxWallClockMs: 1_000_000,
  maxCostCents: 1_000_000,
};

/** A `verified` outcome: the loop reached a passing oracle verdict for this sample. */
function verifiedOutcome(): VerificationOutcome {
  return {
    status: 'verified',
    iterations: 2,
    moduleVersion: { rtl: 'module candidate(); endmodule\n' },
    testbench: { source: 'module candidate_tb; endmodule\n' },
  } as unknown as VerificationOutcome;
}

/** A loop runner that records every request it was handed and returns one scripted outcome. */
class RecordingRunner implements EvalLoopRunner {
  readonly requests: EvalSampleRequest[] = [];

  runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    this.requests.push(request);
    return Promise.resolve(verifiedOutcome());
  }
}

/**
 * One calibrated mutant, keyed the way a real mutant set is.
 *
 * The identity is the MEASURED `counter_12` one - `RESET_BRANCH_DISABLED` rewriting `!rst_n` to
 * `1'b0` - so these fixtures carry the operator the exclusion rule exists for rather than an
 * invented one.
 */
function mutant(
  formal: FormalMutantCalibration,
  options: { readonly line?: number; readonly golden?: MutantCalibration } = {},
): CalibratedFormalMutant {
  const site = { line: options.line ?? 7, column: 3, before: '!rst_n', after: "1'b0" };
  const identity: MutantIdentity = {
    mutantId: mutantIdOf('RESET_BRANCH_DISABLED', site),
    operator: 'RESET_BRANCH_DISABLED',
    site,
  };
  const golden: MutantCalibration = options.golden ?? 'golden-killed';
  return formal === 'formal-could-not-verify'
    ? { identity, golden, formal, cause: 'frontend-rejected' }
    : { identity, golden, formal };
}

/** A gate returning a scripted population - or `null`, the could-not-run answer. */
class ScriptedGate implements PropertySetGate {
  readonly requests: PropertySetGateRequest[] = [];

  constructor(private readonly population: readonly CalibratedFormalMutant[] | null) {}

  calibrate(request: PropertySetGateRequest): Promise<readonly CalibratedFormalMutant[] | null> {
    this.requests.push(request);
    return Promise.resolve(this.population);
  }
}

/** A gate that always throws, to exercise the fail-safe path. */
const THROWING_GATE: PropertySetGate = {
  calibrate(): Promise<readonly CalibratedFormalMutant[] | null> {
    return Promise.reject(new Error('the formal toolchain fell over at /private/var/tmp/x'));
  },
};

/** A population the Property_Set PROVED a judge-killed mutant in: two survivors. */
const REFUSING_POPULATION: readonly CalibratedFormalMutant[] = [
  mutant('formal-proved', { line: 2 }),
  mutant('formal-proved', { line: 5 }),
  mutant('formal-refuted', { line: 9 }),
];

/** A population the Property_Set refuted every judge-killed mutant in. */
const ADMITTING_POPULATION: readonly CalibratedFormalMutant[] = [
  mutant('formal-refuted', { line: 2 }),
  mutant('formal-refuted', { line: 5 }),
];

/**
 * A population whose gate set is EMPTY, so nothing held the Property_Set to account.
 *
 * The mutant the judge killed is one Yosys could not read, so it is excluded (Req 10.5), and
 * the one the oracle could score the judge PASSED, so it was never proven catchable. The
 * intersection is empty without the population being empty, which is the real shape of this
 * case rather than the degenerate `[]` one.
 */
const NO_GATE_SET_POPULATION: readonly CalibratedFormalMutant[] = [
  mutant('formal-could-not-verify', { line: 2, golden: 'golden-killed' }),
  mutant('formal-proved', { line: 5, golden: 'golden-survived' }),
];

function config(sampleCount: number): ReproducibilityConfig {
  const built = makeReproducibilityConfig({ seed: 7, temperature: 0, sampleCount });
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  return built.value;
}

/** Run one problem, one sample, through the harness with the given runner and gate. */
async function run(
  runner: EvalLoopRunner,
  propertySetGate?: PropertySetGate,
  propertySetSourceFor?: (problem: EvalProblem) => PropertySetSource,
): Promise<EvalRunReport> {
  const problem = FIXED_EVAL_SUBSET[0];
  if (problem === undefined) {
    throw new Error('subset is empty');
  }
  // A gated run REQUIRES an author, because the gate scores an authored set rather than
  // conjuring one. So wiring a gate here wires a default author too, and a case that cares
  // which set was authored passes its own.
  const author =
    propertySetSourceFor ??
    (propertySetGate === undefined
      ? undefined
      : () => ({
          propertySetFor: () =>
            Promise.resolve({
              properties: [],
              unexpressedCriteria: [],
              propertySetAdmitted: 'not-gated' as const,
            }),
        }));
  const built = createEvalHarness({
    loopRunner: runner,
    caps: CAPS,
    limits: LIMITS,
    config: config(1),
    costEnvelopeCents: 5,
    ks: [1],
    ...(propertySetGate === undefined ? {} : { propertySetGate }),
    ...(author === undefined ? {} : { propertySetSourceFor: author }),
  });
  if (!built.ok) {
    throw new Error(built.error.code);
  }
  return built.value.run([problem]);
}

/** The single sample of the single problem in a report. */
function onlySample(report: EvalRunReport): SampleResult {
  const sample = report.problems[0]?.samples[0];
  if (sample === undefined) {
    throw new Error('the run produced no sample');
  }
  return sample;
}

/** Run one population through the harness and return what the sample recorded. */
async function recordedFor(
  population: readonly CalibratedFormalMutant[] | null,
): Promise<SampleResult> {
  return onlySample(await run(new RecordingRunner(), new ScriptedGate(population)));
}

describe('a REFUSED Property_Set takes the Simulation_Fallback and the sample says so', () => {
  it('given a Property_Set that proved a judge-killed mutant, then the runner gets the refusal', async () => {
    // The signal, and the whole of criterion 10.3's wiring on this side of the seam: the
    // harness decides - it must, because the gate reads a reference design and `app/agent`
    // holds no import of `app/eval` - and hands the decision to the runner, where
    // `propertySetAdmissionFallsBack` says no Property_Set may decide this sample.
    const runner = new RecordingRunner();

    await run(runner, new ScriptedGate(REFUSING_POPULATION));

    expect(runner.requests[0]?.propertySetAdmitted).toBe('refused');
    expect(propertySetAdmissionFallsBack('refused')).toBe(true);
  });

  it('given a refusal, then the sample records the outcome AND the survivor count', async () => {
    // Req 10.8. The count is what makes the refusal readable: "inadmissible" alone says
    // nothing about how blunt the instrument was.
    const sample = await recordedFor(REFUSING_POPULATION);

    expect(sample.propertySetAdmitted).toBe('refused');
    expect(sample.propertySetSurvivorCount).toBe(2);
  });

  it('given a refusal, then the sample still carries the simulation oracle own verdict', async () => {
    // Req 10.3 and 10.10 together: the sample is DECIDED by the Simulation_Fallback, so
    // `passed` is still the oracle's. A refusal is evidence about the PROPERTY SET, and a
    // reader who took it for a verdict on the candidate would draw the wrong conclusion.
    const sample = await recordedFor(REFUSING_POPULATION);

    expect(sample.passed).toBe(true);
    expect(sample.outcomeStatus).toBe('verified');
  });

  it('given the gate, then it runs under the SAME sandbox caps as the loop own oracle', async () => {
    const gate = new ScriptedGate(REFUSING_POPULATION);

    await run(new RecordingRunner(), gate);

    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0]?.limits).toEqual(LIMITS);
  });
});

describe('an ADMITTED Property_Set does NOT fall back - the positive control for the row above', () => {
  it('given a Property_Set that refuted every judge-killed mutant, then nothing falls back', async () => {
    // WITHOUT THIS ROW the fallback test would pass on a harness that fell back on every
    // sample, which is the degenerate implementation the refusal test alone cannot falsify.
    const runner = new RecordingRunner();

    const report = await run(runner, new ScriptedGate(ADMITTING_POPULATION));

    expect(runner.requests[0]?.propertySetAdmitted).toBe('admitted');
    expect(propertySetAdmissionFallsBack('admitted')).toBe(false);
    expect(onlySample(report).propertySetSurvivorCount).toBe(0);
  });
});

describe('`no-gate-set` is recorded as itself and does NOT fall back', () => {
  it('given a population whose gate set is empty, then the sample records `no-gate-set`', async () => {
    // THE DELIBERATE DECISION, asserted rather than left to a truthiness check. Criterion
    // 10.3 names the REFUSED case alone. A gate with nothing in its gate set demonstrated no
    // weakness - every judge-killed mutant was one the oracle could not read, and every
    // scorable one the judge passed - so refusing to use the Property_Set over it would be
    // the accusation-without-measurement Req 10.5's exclusion rule exists to prevent. It is
    // also not a Property_Set the gate VOUCHED for, which is why it records as its own member
    // rather than as `'admitted'`: a reader can tell "the property killed what the judge
    // killed" from "nothing held it to account" without re-deriving the rule.
    const sample = await recordedFor(NO_GATE_SET_POPULATION);

    expect(sample.propertySetAdmitted).toBe('no-gate-set');
    expect(propertySetAdmissionFallsBack('no-gate-set')).toBe(false);
  });

  it('given `no-gate-set`, then it is NEVER recorded as a refusal', async () => {
    // Requirement 10.9's refused-sample count is over `'refused'` ALONE. A tally that read
    // this member as a refusal would report a weakness nobody demonstrated.
    const sample = await recordedFor(NO_GATE_SET_POPULATION);

    expect(sample.propertySetAdmitted).not.toBe('refused');
    expect(sample.propertySetSurvivorCount).toBe(0);
  });
});

describe('all FOUR members reach the record distinctly', () => {
  it('given each situation the harness can be in, then each records its own member', async () => {
    // The round trip from situation to recorded member, with the two that look redundant
    // separated on purpose: a gate that COULD NOT RUN is `'not-gated'`, and a gate that RAN
    // with an empty gate set is `'no-gate-set'`. Collapsing them would show a reader a
    // vacuous gate where none ran, or lose one that did.
    const recorded: readonly PropertySetAdmissionOutcome[] = [
      (await recordedFor(ADMITTING_POPULATION)).propertySetAdmitted,
      (await recordedFor(NO_GATE_SET_POPULATION)).propertySetAdmitted,
      (await recordedFor(REFUSING_POPULATION)).propertySetAdmitted,
      // `null` from the port: the gate found no reference design for this problem.
      (await recordedFor(null)).propertySetAdmitted,
    ];

    expect(recorded).toEqual(['admitted', 'no-gate-set', 'refused', 'not-gated']);
    expect(new Set(recorded).size).toBe(4);
  });

  it('given an EMPTY population, then it is `no-gate-set` and not the could-not-run answer', async () => {
    // The degenerate half of the distinction above: an empty population is a gate that RAN.
    const sample = await recordedFor([]);

    expect(sample.propertySetAdmitted).toBe('no-gate-set');
  });

  it('given NO gate wired, then the sample is `not-gated` and the request omits the signal', async () => {
    const runner = new RecordingRunner();

    const report = await run(runner);

    expect(onlySample(report).propertySetAdmitted).toBe('not-gated');
    // Omitted rather than sent: absent already means "no gate was wired", which is the exact
    // fact `'not-gated'` carries, and the loop defaults to it.
    expect(runner.requests[0]?.propertySetAdmitted).toBeUndefined();
  });

  it('given a gate that THROWS, then the sample is `not-gated` and never `refused`', async () => {
    // Fail-safe in the direction that keeps the reported numbers honest: a gate that broke
    // demonstrated nothing, so recording `'refused'` would be an accusation nobody measured
    // and would inflate Requirement 10.9's count with samples nothing refused. The run also
    // completes, because an overnight campaign must not die on a diagnostic.
    const sample = onlySample(await run(new RecordingRunner(), THROWING_GATE));

    expect(sample.propertySetAdmitted).toBe('not-gated');
    expect(sample.propertySetSurvivorCount).toBe(0);
  });
});

describe('the gate run reaches the sample as COUNTS, excluded mutants included', () => {
  it('given a population holding an unscorable mutant, then the sample carries its count', async () => {
    // Req 9.4, 9.6, 9.9, and the gap this closes: `admitPropertySet` reduces the population
    // to an outcome and a survivor list, so until the counts were taken HERE - the one place
    // the population is in hand - the mutant Yosys would not read was tallied and then
    // dropped before any record could report it.
    const sample = await recordedFor(NO_GATE_SET_POPULATION);

    // The measured `counter_12` shape: one mutant excluded, one scored and PROVED.
    expect(sample.formalMutationCounts).toEqual({
      totalCount: 2,
      denominator: 1,
      killedCount: 0,
      survivedCount: 1,
      couldNotVerifyCount: 1,
    });
    // The excluded mutant sits OUTSIDE this gate's denominator (Req 9.6) and the partition
    // still accounts for it, which is what makes the exclusion reportable rather than lost.
    expect(sample.formalMutationCounts?.denominator).toBe(1);
    expect(sample.formalMutationCounts?.totalCount).toBe(2);
  });

  it('given the gate could not run or threw, then the counts are NOT MEASURED and not zero', async () => {
    // `null` rather than an all-zero tally, by the rule `formalKillRateOf` already follows: a
    // population nobody calibrated has no counts, where every count at zero would read as a
    // gate that calibrated mutants and scored none of them. This is also what EVERY sweep
    // sample carries today, because no production `PropertySetGate` is wired yet.
    const couldNotRun = await recordedFor(null);
    const threw = onlySample(await run(new RecordingRunner(), THROWING_GATE));
    const unwired = onlySample(await run(new RecordingRunner()));

    expect(couldNotRun.formalMutationCounts).toBeNull();
    expect(threw.formalMutationCounts).toBeNull();
    expect(unwired.formalMutationCounts).toBeNull();
    // The positive control for the three rows above: a gate that DID run reports a tally, so
    // the `null`s are a statement about those paths rather than a field nothing ever fills.
    expect((await recordedFor(ADMITTING_POPULATION)).formalMutationCounts).not.toBeNull();
  });
});

describe('the gate moves no measured number OF ITS OWN (Req 6.9, 6.10)', () => {
  /** One authoring call's charge: a known token count and cost, so it is identifiable. */
  const AUTHORING_CHARGE = { tokens: 1200, costCents: 9, wallClockMs: 0 } as const;

  /**
   * An author that charges the handle it is GIVEN, which is this sample's own.
   *
   * Stateless, so one instance serves both runs. Without it the comparison below is blind to
   * the up-front call, which is how the old pin passed whatever authoring cost.
   */
  const CHARGING_AUTHOR: PropertySetSource = {
    propertySetFor(_spec: Spec, budget: SessionBudgetHandle): Promise<FormalPropertySet> {
      budget.charge({
        ...AUTHORING_CHARGE,
        tokenUsage: { kind: 'reported', promptTokens: 900, completionTokens: 300 },
      });
      return Promise.resolve({
        properties: [],
        unexpressedCriteria: [],
        propertySetAdmitted: 'not-gated',
      });
    },
  };

  /** The gated and the ungated sample of the same problem, both offered the charging author. */
  async function gatedAndUngated(): Promise<readonly [SampleResult, SampleResult]> {
    const author = (): PropertySetSource => CHARGING_AUTHOR;
    return [
      onlySample(await run(new RecordingRunner(), new ScriptedGate(REFUSING_POPULATION), author)),
      onlySample(await run(new RecordingRunner(), undefined, author)),
    ];
  }

  it('given a charging author, then the two runs differ by EXACTLY that charge', async () => {
    // The narrowed invariant: the gate itself makes no model call, so the only measured move
    // between a gated and an ungated run is the authoring the gated one pays for up front.
    const [gated, ungated] = await gatedAndUngated();

    expect(gated.costCents - ungated.costCents).toBe(AUTHORING_CHARGE.costCents);
    expect(gated.totalTokens - ungated.totalTokens).toBe(AUTHORING_CHARGE.tokens);
    // And in NO other measured field - the half the two subtractions above cannot state, since
    // they leave every remaining field unexamined rather than held equal.
    expect(measuredFields(gated)).toEqual(
      measuredFields({
        ...ungated,
        costCents: ungated.costCents + AUTHORING_CHARGE.costCents,
        totalTokens: ungated.totalTokens + AUTHORING_CHARGE.tokens,
      }),
    );
  });

  it('given the two runs, then each record says whether IT authored up front', async () => {
    // Req 6.9, and what keeps the two records apart: a reader comparing `costCents` across
    // samples would otherwise read an authoring charge as a costlier session.
    const [gated, ungated] = await gatedAndUngated();

    expect(gated.propertySetAuthoredUpFront).toBe(true);
    expect(ungated.propertySetAuthoredUpFront).toBe(false);
  });
});

/**
 * Every MEASURED field of a sample: the ones the Property_Set gate may never move.
 *
 * `propertySetAdmitted` and `propertySetSurvivorCount` are deliberately absent - they are what
 * the gate is FOR. Everything else is an oracle verdict, a student-budget measurement, or a
 * reproducibility input, and a gate that moved any of them would be charging the model for our
 * own diagnostics.
 */
function measuredFields(sample: SampleResult): unknown {
  return {
    sampleIndex: sample.sampleIndex,
    seed: sample.seed,
    passed: sample.passed,
    outcomeStatus: sample.outcomeStatus,
    iterations: sample.iterations,
    costCents: sample.costCents,
    totalTokens: sample.totalTokens,
    stopReason: sample.stopReason,
    failureNote: sample.failureNote,
    goldenVerdict: sample.goldenVerdict,
  };
}

describe('the gate scores the SAME Property_Set the loop is handed (Req 6.7)', () => {
  /** One authored set, identified by object identity rather than by its contents. */
  const AUTHORED: FormalPropertySet = {
    properties: [],
    unexpressedCriteria: ['AC-1'],
    propertySetAdmitted: 'not-gated',
  };

  /** An author that counts its calls, so a second authoring is visible rather than silent. */
  class CountingAuthor implements PropertySetSource {
    calls = 0;

    propertySetFor(): Promise<FormalPropertySet> {
      this.calls += 1;
      return Promise.resolve(AUTHORED);
    }
  }

  it('hands the gate the authored object, authored exactly once per sample', async () => {
    const gate = new ScriptedGate([]);
    const author = new CountingAuthor();

    await run(new RecordingRunner(), gate, () => author);

    // The identity is the claim: a set authored twice would be two objects, and the recorded
    // admission would then describe an artifact the loop never reasoned with.
    expect(gate.requests.length).toBeGreaterThan(0);
    for (const request of gate.requests) {
      expect(request.propertySet).toBe(AUTHORED);
    }
    // One authoring per sample, which is what the sample pays for under FL-18 option (a).
    expect(author.calls).toBe(gate.requests.length);
  });

  it('authors nothing when no gate is wired, even with an author supplied', async () => {
    // The shipping path: an ungated run must not author up front, or a gated and an ungated
    // run would differ by more than the gate, which is what task 9.12's comparison rests on.
    const author = new CountingAuthor();

    await run(new RecordingRunner(), undefined, () => author);

    expect(author.calls).toBe(0);
  });
});
