// What the property-only report must never say: a figure pooled across two Authoring_Models,
// a `0` for a count nobody took, or one combined figure where there are two populations.
// Every fixture here is built to make exactly one of those three visible if it regressed.

import { describe, expect, it } from 'vitest';

import { renderPropertyOnlyReport } from './report.js';
import { PROPERTY_ONLY_SCHEMA_VERSION, type PropertyOnlyDesignResult } from './record.js';
import type { PropertyOnlyMeasurement } from './record.js';

import { DECLARED_LIMITS, type MeasurementLimit } from '../measurement-limit.js';
import type { ManifestToolchain } from '../sweep/manifest.js';

const MODEL_A = 'zai.glm-5';
const MODEL_B = 'moonshotai.kimi-k2.5';

/** A toolchain that answered, so a block over it is reproducible. */
const READ_TOOLCHAIN: ManifestToolchain = {
  iverilogVersion: '13.0',
  vvpVersion: '13.0',
  workerPython: null,
  yosysVersion: { kind: 'read', value: '0.69+post' },
  yosysBuildId: { kind: 'read', value: '143eb14f' },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'answers --version with usage' },
  bitwuzlaVersion: { kind: 'read', value: '0.9.1' },
  z3Version: { kind: 'read', value: '4.15.4' },
};

/** A toolchain no member of which answered: a record carrying no Toolchain_Provenance. */
const UNREAD_TOOLCHAIN: ManifestToolchain = {
  iverilogVersion: null,
  vvpVersion: null,
  workerPython: null,
  yosysVersion: { kind: 'not-measured', reason: 'not on PATH' },
  yosysBuildId: { kind: 'not-measured', reason: 'not on PATH' },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'not on PATH' },
  bitwuzlaVersion: { kind: 'not-measured', reason: 'not on PATH' },
  z3Version: { kind: 'not-measured', reason: 'not on PATH' },
};

const CONDITIONS = {
  assertionCount: 1,
  presat: 'satisfiable',
  cover: { reached: true, step: 3 },
  base: 'passed',
  induction: 'successful',
} as const;

/** A design whose one property the oracle decided with `verdict`. */
function decided(
  designId: string,
  authoringModel: string,
  verdict: 'proved' | 'refuted',
  toolchain: ManifestToolchain = READ_TOOLCHAIN,
): PropertyOnlyDesignResult {
  return {
    designId,
    authoringModel,
    population: 'admitted',
    prepassRefusalCause: null,
    properties: [
      {
        propertyId: 'p1',
        outcome: {
          kind: 'measured',
          verdict,
          couldNotVerifyCause: null,
          crossCheckDisagreed: false,
          conditions: CONDITIONS,
        },
      },
    ],
    unexpressedCriteria: [],
    promptTokens: 1200,
    completionTokens: 340,
    elapsedMs: 8123.5,
    proofSpanMs: 4100.5,
    toolchain,
    formalOracleVersion: 2,
  };
}

/** A design the pre-pass refused before any solver ran, so nothing on it was measured. */
function refused(designId: string, authoringModel: string): PropertyOnlyDesignResult {
  return {
    designId,
    authoringModel,
    population: 'refused',
    prepassRefusalCause: 'clock-contract-unsupported',
    properties: [
      {
        propertyId: 'p1',
        outcome: { kind: 'not-measured', reason: 'the pre-pass refused before any solver ran' },
      },
    ],
    unexpressedCriteria: [],
    promptTokens: 900,
    completionTokens: 110,
    elapsedMs: 117,
    proofSpanMs: 12,
    toolchain: READ_TOOLCHAIN,
    formalOracleVersion: 2,
  };
}

const PROOF_DEPTH: MeasurementLimit = {
  name: 'proof-depth',
  value: 20,
  unit: 'steps',
  reason: 'termination',
};
const COST_PILOT: MeasurementLimit = {
  name: 'cost-pilot-design-count',
  value: 3,
  unit: 'designs',
  reason: 'anomaly-detection',
};
const ANOMALY_GUARD: MeasurementLimit = {
  name: 'anomaly-guard',
  value: 10,
  unit: 'multiple',
  reason: 'anomaly-detection',
};

/** The declared limit the guard's wall-clock arm equals, read rather than restated here. */
function declared(name: string): MeasurementLimit {
  const limit = DECLARED_LIMITS[name];
  if (limit === undefined) {
    throw new Error(`no declared limit named ${name}`);
  }
  return limit;
}

const PROPERTY_TIME_BUDGET = declared('shipped-property-time-budget');

/** What task 4.5 measured `multi_booth_8bit` at: slow, and legitimately inside the budget. */
const SLOW_MS = 149_997;
const FAST_MS = 12_000;

/** One design result with its measured elapsed wall clock replaced. */
function tookMs(design: PropertyOnlyDesignResult, elapsedMs: number): PropertyOnlyDesignResult {
  return { ...design, elapsedMs };
}

function measurement(
  results: readonly PropertyOnlyDesignResult[],
  limits: readonly MeasurementLimit[] = [PROOF_DEPTH, COST_PILOT],
): PropertyOnlyMeasurement {
  return {
    schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
    runName: 'property-only-v1',
    measurementKind: 'property-only',
    omittedStudentPathSteps: ['Testbench_Agent', 'Instrument_Admission'],
    results,
    limits,
  };
}

/**
 * Model A proves everything and model B proves nothing, so the two rates are 1.000 and 0.000
 * and the rate a pooled denominator would produce is 0.500 - a value that appears nowhere
 * else in the report, which is what makes the no-pooling assertion falsifiable.
 */
const TWO_MODELS = measurement([
  decided('rtllm/arithmetic/adder_8bit', MODEL_A, 'proved'),
  decided('rtllm/arithmetic/adder_16bit', MODEL_A, 'proved'),
  refused('rtllm/miscellaneous/freq_divbyodd', MODEL_A),
  decided('rtllm/arithmetic/adder_8bit', MODEL_B, 'refuted'),
  decided('rtllm/arithmetic/adder_16bit', MODEL_B, 'refuted'),
  refused('rtllm/miscellaneous/freq_divbyodd', MODEL_B),
]);

/**
 * A run the wall-clock arm stopped: one design over the declared budget, no design-count bound.
 *
 * Its limits hold both arms' sources, which is what the full population declares, so the report
 * must name each arm with the limit it was taken from.
 */
const BUDGET_STOPPED = measurement(
  [
    tookMs(
      decided('rtllm/arithmetic/multi_booth_8bit', MODEL_A, 'proved'),
      PROPERTY_TIME_BUDGET.value + 1,
    ),
  ],
  [PROOF_DEPTH, ANOMALY_GUARD, PROPERTY_TIME_BUDGET],
);

/** The block header lines, in render order. */
function modelBlocks(lines: readonly string[]): readonly string[] {
  return lines.filter((line) => line.startsWith('authoring model: '));
}

describe('renderPropertyOnlyReport', () => {
  it('given two Authoring_Models, when rendered, then there is one block per model', () => {
    const lines = renderPropertyOnlyReport(TWO_MODELS);

    expect(modelBlocks(lines)).toEqual([
      `authoring model: ${MODEL_A}`,
      `authoring model: ${MODEL_B}`,
    ]);
    // One blank line opens each block, so the two never read as one continuous population.
    expect(lines.filter((line) => line === '')).toHaveLength(2);
  });

  it('given any fixture, when rendered, then no line runs past the readable column', () => {
    const stopped = measurement(
      [decided('rtllm/arithmetic/adder_8bit', MODEL_A, 'proved', UNREAD_TOOLCHAIN)],
      [PROOF_DEPTH, ANOMALY_GUARD],
    );
    for (const fixture of [TWO_MODELS, stopped, BUDGET_STOPPED, measurement([])]) {
      for (const line of renderPropertyOnlyReport(fixture)) {
        expect(line.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('given two models, when rendered, then no figure equals the pooled rate', () => {
    const lines = renderPropertyOnlyReport(TWO_MODELS);
    const prose = lines.join('\n');

    // 2 of 4 admitted designs proved across both models; neither model's own rate is this.
    expect(prose).not.toContain('0.500');
    expect(prose).toContain('1.000  (2/2 decided design(s))');
    expect(prose).toContain('0.000  (0/2 decided design(s))');
  });

  it('given a rate over the Admitted_Population, then the refused design is out of it', () => {
    const lines = renderPropertyOnlyReport(TWO_MODELS);

    // 3 designs each, one refused: a denominator of 3 would be the refused one counted in.
    expect(lines.join('\n')).not.toContain('(2/3 decided design(s))');
    expect(lines.some((line) => line.includes('1/3 = 0.333 refused'))).toBe(true);
  });

  it('given an Admitted_Population nothing was decided on, then the count is NOT MEASURED', () => {
    const lines = renderPropertyOnlyReport(
      measurement([refused('rtllm/miscellaneous/freq_divbyodd', MODEL_A)]),
    );
    const prose = lines.join('\n');

    expect(prose).toContain(`properties:      NOT MEASURED`);
    expect(prose).toContain('property-only:   NOT MEASURED');
    // The untaken tally must not appear as a row of zeros instead.
    expect(prose).not.toMatch(/properties:\s+proved 0/);
  });

  it('given a count that was taken and is zero, then it renders as zero', () => {
    const prose = renderPropertyOnlyReport(TWO_MODELS).join('\n');

    // Model B submitted one refuted property per admitted design: proved 0 is a real count.
    expect(prose).toContain('properties:      proved 0  refuted 2  could-not-verify 0');
  });

  it('given a measurement, then the two figures are named separately with no combined third', () => {
    const prose = renderPropertyOnlyReport(TWO_MODELS).join('\n');

    expect(prose).toContain('MEASUREMENT KIND: property-only - this is NOT an End_To_End_Formal_');
    expect(prose).toContain('end-to-end:      NOT MEASURED');
    expect(prose).toContain('never combined into a third');
    expect(prose).toContain('Student_Path steps this path omitted: Testbench_Agent');
  });

  it('given a design carrying no Toolchain_Provenance, then its block is not reproducible', () => {
    const prose = renderPropertyOnlyReport(
      measurement([decided('rtllm/arithmetic/adder_8bit', MODEL_A, 'proved', UNREAD_TOOLCHAIN)]),
    ).join('\n');

    expect(prose).toContain('reproducible:    NOT REPRODUCIBLE - 1 of 1 design(s) carry no');
  });

  it('given a population short of the corpus with no design bound, then it reads as a defect', () => {
    const prose = renderPropertyOnlyReport(
      measurement(
        [decided('rtllm/arithmetic/adder_8bit', MODEL_A, 'proved')],
        [PROOF_DEPTH, ANOMALY_GUARD],
      ),
    ).join('\n');

    expect(prose).toContain('anomaly-guard = 10 multiple (anomaly-detection)');
    expect(prose).toContain('SUSPECTED DEFECT IN THE RUN');
    expect(prose).toContain('NOT a measurement of any Authoring_Model');
  });

  it('given two designs of differing wall clock, then each sits beside the extrapolation and stops no run', () => {
    const prose = renderPropertyOnlyReport(
      measurement([
        tookMs(decided('rtllm/arithmetic/adder_8bit', MODEL_A, 'proved'), FAST_MS),
        tookMs(decided('rtllm/arithmetic/multi_booth_8bit', MODEL_A, 'proved'), SLOW_MS),
      ]),
    ).join('\n');

    // The slower design IS the block's own maximum, so a renderer printing one figure twice or
    // printing the minimum would fail this.
    expect(prose).toContain(`Per_Design_Extrapolation ${SLOW_MS}.0 ms Design_Total, the`);
    expect(prose).toContain(`Design_Total ${FAST_MS}.0 ms,`);
    expect(prose).toContain(`Design_Total ${SLOW_MS}.0 ms,`);
    expect(prose).toContain('This comparison STOPS NO RUN and is a reported figure');

    // And it stopped nothing: the slow design finished inside the declared budget, which is the
    // arm the guard actually reads, so the block carries no stop at all.
    expect(SLOW_MS).toBeLessThan(PROPERTY_TIME_BUDGET.value);
    expect(prose).not.toContain('SUSPECTED DEFECT');
  });

  it('given a wall-clock breach that stopped the run, then the arm names the declared budget and its reason', () => {
    const prose = renderPropertyOnlyReport(BUDGET_STOPPED).join('\n');

    expect(prose).toContain(
      `wall-clock arm: shipped-property-time-budget = ${PROPERTY_TIME_BUDGET.value} ms` +
        ` (population-honesty)`,
    );
    expect(prose).toContain('token arm: anomaly-guard = 10 multiple (anomaly-detection)');
    expect(prose).toContain('An arm is derived from the limit beside it and is NOT a measured');
    expect(prose).toContain('SUSPECTED DEFECT IN THE RUN');
  });

  it('given a run that reached its declared design bound, then that is a result and not a defect', () => {
    const prose = renderPropertyOnlyReport(TWO_MODELS).join('\n');

    expect(prose).toContain('ran to cost-pilot-design-count = 3 designs (anomaly-detection)');
    expect(prose).not.toContain('SUSPECTED DEFECT');
  });

  it('given no result at all, then every figure is NOT MEASURED and there is no block', () => {
    const lines = renderPropertyOnlyReport(measurement([]));

    expect(modelBlocks(lines)).toEqual([]);
    expect(lines.at(-1)).toContain('NOT MEASURED');
  });

  it('given a declined design, then the rate, its denominator and the decline count are one statement', () => {
    // Req 5.27. One design decided and proved, one the Property_Author expressed nothing for, so
    // the rate is 1.000 over a denominator of 1 while the recorded population is 2. A renderer
    // printing the rate alone would read as 1.000 over both designs.
    const declined: PropertyOnlyDesignResult = {
      ...decided('rtllm/arithmetic/multi_booth_8bit', MODEL_A, 'proved'),
      properties: [],
      unexpressedCriteria: ['3.2'],
    };
    const prose = renderPropertyOnlyReport(
      measurement([decided('rtllm/arithmetic/adder_8bit', MODEL_A, 'proved'), declined]),
    ).join('\n');

    expect(prose).toContain('1.000  (1/1 decided design(s))');
    expect(prose).toContain('Its denominator is 1 of 2 recorded design(s)');
    expect(prose).toContain('Property_Author expressed nothing for 1 of them');
    // Req 5.28: the decline is counted, and its cause is not guessed at.
    expect(prose).toContain('WHY the Property_Author declined is NOT MEASURED');
  });

  it('given a Design_Total figure, then it is labelled as such and stated to stop no run', () => {
    // Req 5.25. The arm reads the Proof_Span, so a Design_Total must never appear as a bare
    // elapsed figure a reader could take against the budget.
    const prose = renderPropertyOnlyReport(
      measurement([tookMs(decided('rtllm/arithmetic/adder_8bit', MODEL_A, 'proved'), SLOW_MS)]),
    ).join('\n');

    expect(prose).toContain(`Design_Total ${SLOW_MS}.0 ms, Proof_Span `);
    expect(prose).toContain('This comparison STOPS NO RUN and is a reported figure');
    expect(prose).toContain("Anomaly_Guard's wall-clock arm reads the Proof_Span against the");
    expect(prose).toContain('no Design_Total above is compared against any arm');
  });

  it('given the same measurement twice, then the lines are identical', () => {
    expect(renderPropertyOnlyReport(TWO_MODELS)).toEqual(renderPropertyOnlyReport(TWO_MODELS));
  });
});
