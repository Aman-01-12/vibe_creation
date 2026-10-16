// What the Property_Only_Mode REFUSES, and what it is allowed to dispatch.
//
// The three facts this file exists for:
//   1. The refusals are refusals. The worker-isolation rule and every declared limit are
//      checked before a token can be spent, and each failing direction is exercised against a
//      seam rather than asserted to be unreachable (Req 1.7, 12.4).
//   2. While no Per_Design_Extrapolation is recorded, NOTHING outside the Cost_Pilot is
//      dispatched. That gate is what stands between a config typo and an unbounded paid run
//      (Req 5.6).
//   3. The output directory and the file inside it are ones no Measurement_Report of an
//      End_To_End_Formal_Rate reads, and an end-to-end run directory is refused as an output
//      directory (Req 9.9, 9.10).
//
// No model call, no toolchain, and no network: every function under test here is either pure or
// reads a file the repository already holds.

import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EVAL_CORPUS_ROOT } from '../corpus/fetch-node.js';
import { RTLLM_SCORED_DESIGN_COUNT } from '../corpus/stage0-quarantine.js';
import { DECLARED_LIMITS, type MeasurementLimit } from '../measurement-limit.js';
import { RESULTS_LOG_FILENAME } from '../sweep/results-log.js';
import { SUMMARY_FILENAME } from '../sweep/summary.js';
import {
  anomalyBreachOf,
  declaredLimitsOrRefuse,
  dispatchPlanFor,
  endToEndRunDirectoryRefusal,
  measurementPath,
  OMITTED_STUDENT_PATH_STEPS,
  parsePropertyOnlyArgs,
  perDesignExtrapolationOf,
  PROPERTY_ONLY_MEASUREMENT_FILENAME,
  PROPERTY_ONLY_REPORT_FILENAME,
  recordedLimitsFor,
  runPropertyOnly,
  supersessionNote,
  SUPERSEDED_RUN_DIR,
  workerIsolationFailure,
  type WorkerEnvironmentProjector,
} from './cli.js';
import {
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
} from './record.js';

/** The repository root, derived the way the module under test derives it. */
const REPOSITORY_ROOT = dirname(EVAL_CORPUS_ROOT);

/** A design result carrying only the figures the Cost_Pilot and the guard read. */
function resultWith(figures: {
  readonly designId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly elapsedMs: number;
  /** Absent by default: only the wall-clock arm reads it, and these cases size the token arm. */
  readonly proofSpanMs?: number | null;
}): PropertyOnlyDesignResult {
  return {
    designId: figures.designId,
    authoringModel: 'zai.glm-5',
    population: 'admitted',
    prepassRefusalCause: null,
    properties: [],
    unexpressedCriteria: [],
    promptTokens: figures.promptTokens,
    completionTokens: figures.completionTokens,
    elapsedMs: figures.elapsedMs,
    proofSpanMs: figures.proofSpanMs ?? null,
    toolchain: {
      iverilogVersion: null,
      vvpVersion: null,
      workerPython: null,
      yosysVersion: { kind: 'not-measured', reason: 'fixture' },
      yosysBuildId: { kind: 'not-measured', reason: 'fixture' },
      yosysSmtBmcVersion: { kind: 'not-measured', reason: 'fixture' },
      bitwuzlaVersion: { kind: 'not-measured', reason: 'fixture' },
      z3Version: { kind: 'not-measured', reason: 'fixture' },
    },
    formalOracleVersion: 2,
  };
}

/** A measurement over the given per-design figures. */
function measurementOf(results: readonly PropertyOnlyDesignResult[]): PropertyOnlyMeasurement {
  return {
    schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
    runName: 'property-only-cost-pilot',
    measurementKind: PROPERTY_ONLY_MEASUREMENT_KIND,
    omittedStudentPathSteps: OMITTED_STUDENT_PATH_STEPS,
    results,
    limits: [],
  };
}

/** One declared limit, read from the registry rather than restated as a number here. */
function declared(name: string): MeasurementLimit {
  const limit = DECLARED_LIMITS[name];
  if (limit === undefined) {
    throw new Error(`the limit "${name}" is not declared`);
  }
  return limit;
}

/** The declared Anomaly_Guard, which is the multiple the token arm is set at. */
function anomalyGuard(): MeasurementLimit {
  return declared('anomaly-guard');
}

/** The declared shipped Property_Time_Budget, which IS the guard's wall-clock arm (Req 5.20). */
function propertyTimeBudget(): MeasurementLimit {
  return declared('shipped-property-time-budget');
}

describe('parsePropertyOnlyArgs', () => {
  it('accepts exactly one --config invocation', () => {
    expect(parsePropertyOnlyArgs(['--config', 'a.json'])).toEqual({
      kind: 'run',
      configPath: 'a.json',
    });
  });

  it.each([
    [[]],
    [['--config']],
    [['--config', '']],
    [['--summarize', 'dir']],
    [['--full-population', 'yes']],
    [['--config', 'a.json', '--config', 'b.json']],
  ])('refuses the invocation %j', (argv) => {
    expect(parsePropertyOnlyArgs(argv).kind).toBe('usage');
  });

  it('refuses a --config value shaped like a flag rather than a path', () => {
    // Read as a filename this becomes "the config could not be read", which names the wrong
    // problem for what is an operator typing a flag where a path goes.
    const command = parsePropertyOnlyArgs(['--config', '--full-population']);

    expect(command.kind).toBe('usage');
    if (command.kind !== 'usage') return;
    expect(command.problem).toContain('looks like a flag');
  });

  it('offers no flag that could widen the population', () => {
    // The Cost_Pilot gate is decided from whether an extrapolation is recorded, so there is
    // deliberately no argv that selects the full population (Req 5.6).
    expect(parsePropertyOnlyArgs(['--population', 'full']).kind).toBe('usage');
  });
});

describe('workerIsolationFailure', () => {
  it('reports no failure on a host whose projection holds the allowlist', () => {
    expect(
      workerIsolationFailure({ PATH: '/usr/bin', AWS_BEARER_TOKEN_BEDROCK: 'secret' }),
    ).toBeNull();
  });

  it('reports a failure where a non-allowlisted value reaches the worker (Req 1.7)', () => {
    // The failing direction, driven through the seam: a projector that passes everything.
    const leaking: WorkerEnvironmentProjector = (env) => ({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      absent: [],
    });

    const failure = workerIsolationFailure({ PATH: '/usr/bin' }, leaking);

    expect(failure).not.toBeNull();
    expect(failure).toContain('Worker_Environment_Allowlist');
  });

  it('reports a failure where the projection passes nothing at all', () => {
    // The second half of the Sentinel_Isolation_Test's rule: a runtime passing no variable is
    // not the same as one passing the allowlist, and both must be distinguishable.
    const empty: WorkerEnvironmentProjector = () => ({ env: {}, absent: ['PATH'] });

    expect(workerIsolationFailure({ PATH: '/usr/bin' }, empty)).toContain('PATH');
  });

  it('emits no environment value other than its own sentinel', () => {
    const leaking: WorkerEnvironmentProjector = (env) => ({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      absent: [],
    });

    const failure = workerIsolationFailure({ PATH: '/usr/bin', TOKEN: 'super-secret' }, leaking);

    expect(failure).not.toContain('super-secret');
    expect(failure).not.toContain('/usr/bin');
  });
});

describe('declaredLimitsOrRefuse', () => {
  it('resolves every limit this mode runs under through the registry', () => {
    const limits = declaredLimitsOrRefuse();

    expect(limits.ok).toBe(true);
    if (!limits.ok) return;
    expect(limits.value.anomalyGuard.reason).toBe('anomaly-detection');
    expect(limits.value.propertyTimeBudget.reason).toBe('population-honesty');
    for (const limit of limits.value.all.values()) {
      // Req 12.1 and 12.2: exactly one reason, drawn from the closed vocabulary.
      expect(['termination', 'anomaly-detection', 'population-honesty']).toContain(limit.reason);
    }
  });
});

describe('recordedLimitsFor', () => {
  it('records the Cost_Pilot design-count bound for a pilot, so a short run reads as bounded', () => {
    const limits = declaredLimitsOrRefuse();
    expect(limits.ok).toBe(true);
    if (!limits.ok) return;

    const recorded = recordedLimitsFor('cost-pilot', limits.value.all);

    expect(recorded.map((limit) => limit.name)).toContain('cost-pilot-design-count');
    expect(recorded.some((limit) => limit.unit === 'designs')).toBe(true);
  });

  it('records no design-count bound for a full run, so a short run reads as stopped', () => {
    const limits = declaredLimitsOrRefuse();
    expect(limits.ok).toBe(true);
    if (!limits.ok) return;

    const recorded = recordedLimitsFor('full-population', limits.value.all);

    // The renderer tells a bounded run from a stopped one by whether a `designs` limit is
    // declared, so a full run must declare none of them and the guard instead.
    expect(recorded.some((limit) => limit.unit === 'designs')).toBe(false);
    expect(recorded.map((limit) => limit.name)).toContain('anomaly-guard');
  });
});

describe('perDesignExtrapolationOf', () => {
  it('is the MAXIMUM of the per-design figures and not the mean', () => {
    const measurement = measurementOf([
      resultWith({ designId: 'a', promptTokens: 80, completionTokens: 20, elapsedMs: 1_000 }),
      resultWith({ designId: 'b', promptTokens: 800, completionTokens: 200, elapsedMs: 9_000 }),
    ]);

    const extrapolation = perDesignExtrapolationOf(measurement);

    // The mean would be 550 tokens and 5000 ms; a guard set from the mean would trip on
    // plausible variation between designs, which is what the maximum exists to avoid.
    expect(extrapolation).toEqual({ tokens: 1_000, elapsedMs: 9_000 });
  });

  it('records no extrapolation for a measurement with no design result', () => {
    expect(perDesignExtrapolationOf(measurementOf([]))).toBeNull();
  });
});

describe('anomalyBreachOf', () => {
  // The second paid Cost_Pilot's own figures, so the wall-clock cases below are the real case.
  const extrapolation = { tokens: 1_245, elapsedMs: 5_274 };
  const tokenArm = extrapolation.tokens * anomalyGuard().value;
  const proofArm = propertyTimeBudget().value;

  function breachOf(figures: { readonly tokens: number; readonly proofSpanMs: number | null }) {
    return anomalyBreachOf(figures, extrapolation, anomalyGuard(), propertyTimeBudget());
  }

  it('does not trip with both figures at exactly their arms', () => {
    expect(breachOf({ tokens: tokenArm, proofSpanMs: proofArm })).toBeNull();
  });

  it('trips one token past the token arm and names the Anomaly_Guard beside it', () => {
    const breach = breachOf({ tokens: tokenArm + 1, proofSpanMs: 1_000 });

    expect(breach).not.toBeNull();
    expect(breach?.figure).toBe('tokens');
    expect(breach?.measured).toBe(tokenArm + 1);
    expect(breach?.guard).toBe(tokenArm);
    expect(breach?.limit.name).toBe('anomaly-guard');
    expect(breach?.limit.reason).toBe('anomaly-detection');
  });

  it('trips one millisecond past the budget and names the budget as the arm it came from', () => {
    const breach = breachOf({ tokens: 10, proofSpanMs: proofArm + 1 });

    expect(breach?.figure).toBe('proofSpanMs');
    expect(breach?.measured).toBe(proofArm + 1);
    expect(breach?.guard).toBe(proofArm);
    // Req 5.21: the arm is the declared budget, so the breach names that limit, not the guard.
    expect(breach?.limit.name).toBe('shipped-property-time-budget');
    expect(breach?.limit.reason).toBe('population-honesty');
  });

  it('does not trip on the 149997 ms design the pilot-derived arm would have stopped', () => {
    // The whole of FL-26: 149997 ms is 28x this pilot's elapsed extrapolation, so the old arm of
    // 52740 ms stopped a design task 4.5 measured doing nothing wrong under the same budget.
    expect(149_997).toBeGreaterThan(extrapolation.elapsedMs * anomalyGuard().value);
    expect(breachOf({ tokens: 1_245, proofSpanMs: 149_997 })).toBeNull();
  });

  it('does not trip on a proof that reached the budget with authoring time on top', () => {
    // FL-27, the measured defect: div_16bit's proof reached the budget and its Design_Total was
    // 151107 ms. The arm read that total, so a legitimate proof-timeout could not satisfy it at
    // any multiple. The arm reads the Proof_Span now, and a proof AT the budget is legitimate.
    expect(breachOf({ tokens: 1_245, proofSpanMs: proofArm })).toBeNull();
  });

  it('does not trip where no proof was attempted, because an absent span is not a zero', () => {
    expect(breachOf({ tokens: 10, proofSpanMs: null })).toBeNull();
  });

  it('does not trip on a design that costs several times another one', () => {
    // Non-vacuity in the other direction: 4x the tokens is real variation, not a defect.
    expect(breachOf({ tokens: 5_000, proofSpanMs: 50_000 })).toBeNull();
  });
});

describe('dispatchPlanFor', () => {
  const scoredDesignIds = Array.from(
    { length: RTLLM_SCORED_DESIGN_COUNT },
    (_unused, index) => `design-${index}`,
  );

  it('dispatches the Cost_Pilot and nothing else while no extrapolation is recorded', () => {
    const plan = dispatchPlanFor({
      scoredDesignIds,
      costPilotDesignIds: ['design-0', 'design-1', 'design-2'],
      extrapolation: null,
    });

    expect(plan.scope).toBe('cost-pilot');
    expect(plan.designIds).toEqual(['design-0', 'design-1', 'design-2']);
    // The gate: no design outside the pilot, whatever the corpus holds (Req 5.6).
    expect(plan.designIds.length).toBeLessThan(RTLLM_SCORED_DESIGN_COUNT);
  });

  it('names a configured pilot design the corpus does not hold rather than dropping it', () => {
    const plan = dispatchPlanFor({
      scoredDesignIds,
      costPilotDesignIds: ['design-0', 'rtllm/typo/nope'],
      extrapolation: null,
    });

    expect(plan.designIds).toEqual(['design-0']);
    expect(plan.unknownDesignIds).toEqual(['rtllm/typo/nope']);
  });

  it('dispatches the full population once an extrapolation is recorded (Req 5.15)', () => {
    const plan = dispatchPlanFor({
      scoredDesignIds,
      costPilotDesignIds: ['design-0'],
      extrapolation: { tokens: 1_000, elapsedMs: 10_000 },
    });

    expect(plan.scope).toBe('full-population');
    expect(plan.designIds).toHaveLength(RTLLM_SCORED_DESIGN_COUNT);
    expect(plan.unknownDesignIds).toEqual([]);
  });
});

describe('the measurement output', () => {
  it('is a file no End_To_End_Formal_Rate report reads (Req 9.9)', () => {
    // `summarizeSweepRun` reads the results log and writes the summary; this record is neither.
    expect(PROPERTY_ONLY_MEASUREMENT_FILENAME).not.toBe(RESULTS_LOG_FILENAME);
    expect(PROPERTY_ONLY_MEASUREMENT_FILENAME).not.toBe(SUMMARY_FILENAME);
    expect(PROPERTY_ONLY_REPORT_FILENAME).not.toBe(SUMMARY_FILENAME);
    expect(measurementPath('.eval-runs/property-only-cost-pilot')).not.toContain(
      RESULTS_LOG_FILENAME,
    );
  });

  it('refuses an output directory that is an end-to-end run directory (Req 9.10)', async () => {
    // The pilot's own directory holds a results log, so writing a property-only record into it
    // would put this figure where a reader of that run expects an end-to-end one.
    const refusal = await endToEndRunDirectoryRefusal(join(REPOSITORY_ROOT, SUPERSEDED_RUN_DIR));

    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe('output-unwritable');
    expect(refusal?.problem).toContain(RESULTS_LOG_FILENAME);
  });

  it('accepts a directory holding no end-to-end results log', async () => {
    const refusal = await endToEndRunDirectoryRefusal(
      join(REPOSITORY_ROOT, '.eval-runs', 'property-only-does-not-exist-yet'),
    );

    expect(refusal).toBeNull();
  });

  it('leaves the superseded run a note naming the measurement that superseded it (Req 9.11)', () => {
    const note = supersessionNote('property-only-cost-pilot');

    expect(note).toContain('property-only-cost-pilot');
    expect(note).toContain(PROPERTY_ONLY_MEASUREMENT_KIND);
    // The superseded run's own records stay in place as the evidence of what was measured.
    expect(note).toContain('evidence');
  });

  it('names the Student_Path steps its own path omits (Req 9.2)', () => {
    expect(OMITTED_STUDENT_PATH_STEPS).toContain('instrument-admission');
    expect(OMITTED_STUDENT_PATH_STEPS).toContain('testbench-generation');
  });
});

describe('runPropertyOnly', () => {
  it('refuses an unreadable config before anything is composed', async () => {
    const result = await runPropertyOnly(
      join(REPOSITORY_ROOT, 'app', 'eval', 'property-only', 'no-such-config.json'),
    );

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('could not be read');
  });
});

// NOT TESTED HERE, DELIBERATELY: `runPropertyOnly` against a config that PASSES preflight. On a
// host holding the credential, the corpus, and the toolchain, that call dispatches real paid
// model calls. The paid runs are their own tasks and need explicit approval; everything this
// entry point DECIDES is reachable through the exported functions above without spending a
// token, which is why they are exported.
