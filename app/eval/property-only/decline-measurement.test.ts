// Component 21's measurement: the decline observations are read, and the cause is not.

import { describe, expect, it } from 'vitest';

import {
  DECLINE_SCHEMA_VERSION,
  declineMeasurementOf,
  declineObservationsOf,
} from './decline-measurement.js';
import { PROPERTY_ONLY_SCHEMA_VERSION, type PropertyOnlyDesignResult } from './record.js';
import type { PropertyOnlyMeasurement } from './record.js';
import type { MeasurementLimit } from '../measurement-limit.js';

const PROOF_DEPTH: MeasurementLimit = {
  name: 'proof-depth',
  value: 20,
  unit: 'steps',
  reason: 'termination',
};

const TOOLCHAIN = {
  iverilogVersion: null,
  vvpVersion: null,
  workerPython: null,
  yosysVersion: { kind: 'not-measured', reason: 'fixture' },
  yosysBuildId: { kind: 'not-measured', reason: 'fixture' },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'fixture' },
  bitwuzlaVersion: { kind: 'not-measured', reason: 'fixture' },
  z3Version: { kind: 'not-measured', reason: 'fixture' },
} as const;

/** One design result carrying only what this measurement reads. */
function result(
  designId: string,
  authoringModel: string,
  propertyCount: number,
  unexpressedCriteria: readonly string[],
): PropertyOnlyDesignResult {
  return {
    designId,
    authoringModel,
    population: 'admitted',
    prepassRefusalCause: null,
    properties: Array.from({ length: propertyCount }, (_unused, index) => ({
      propertyId: `p${String(index)}`,
      outcome: { kind: 'not-measured', reason: 'no verdict is read here' } as const,
    })),
    unexpressedCriteria,
    promptTokens: 10,
    completionTokens: 10,
    elapsedMs: 100,
    proofSpanMs: 50,
    toolchain: TOOLCHAIN,
    formalOracleVersion: 3,
  };
}

function measurementOf(results: readonly PropertyOnlyDesignResult[]): PropertyOnlyMeasurement {
  return {
    schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
    runName: 'decline-fixture',
    measurementKind: 'property-only',
    omittedStudentPathSteps: ['Testbench_Agent', 'Instrument_Admission'],
    results,
    limits: [PROOF_DEPTH],
  };
}

const ONE_CRITERION = () => 1;

describe('declineObservationsOf', () => {
  it('given a design that expressed nothing, then it reads as declined with its criteria', () => {
    const [observation] = declineObservationsOf(
      measurementOf([result('rtllm/arithmetic/multi_booth_8bit', 'zai.glm-5', 0, ['3.2'])]),
      ONE_CRITERION,
    );

    expect(observation?.expressedAny).toBe(false);
    expect(observation?.unexpressedCriteria).toEqual(['3.2']);
    expect(observation?.criteriaHanded).toBe(1);
  });

  it('given a design that expressed a property, then it does not read as declined', () => {
    const [observation] = declineObservationsOf(
      measurementOf([result('rtllm/arithmetic/adder_8bit', 'zai.glm-5', 1, [])]),
      ONE_CRITERION,
    );

    expect(observation?.expressedAny).toBe(true);
  });

  it('given an unknown criterion count, then it is null and never a zero', () => {
    // A zero would say the author was handed nothing, which is a handoff artifact and the
    // opposite of an unknown. The two must not collapse.
    const [observation] = declineObservationsOf(
      measurementOf([result('rtllm/control/fsm', 'zai.glm-5', 0, ['4.1'])]),
      () => null,
    );

    expect(observation?.criteriaHanded).toBeNull();
  });
});

describe('declineMeasurementOf', () => {
  const MEASUREMENT = measurementOf([
    result('rtllm/arithmetic/adder_8bit', 'zai.glm-5', 1, []),
    result('rtllm/arithmetic/multi_booth_8bit', 'zai.glm-5', 0, ['3.2']),
    result('rtllm/control/fsm', 'zai.glm-5', 0, ['4.1']),
    result('rtllm/arithmetic/adder_8bit', 'moonshotai.kimi-k2.5', 1, []),
  ]);

  it('given two models, then each carries its own denominator and nothing is pooled', () => {
    const { figures } = declineMeasurementOf(MEASUREMENT, ONE_CRITERION);

    expect(figures).toEqual([
      {
        authoringModel: 'zai.glm-5',
        designCount: 3,
        declinedCount: 2,
        declinedOnSingleCriterion: 2,
      },
      {
        authoringModel: 'moonshotai.kimi-k2.5',
        designCount: 1,
        declinedCount: 0,
        declinedOnSingleCriterion: 0,
      },
    ]);
    // A pooled rate would be 2 of 4; it appears on neither model's figures.
    expect(figures.some((one) => one.designCount === 4)).toBe(false);
  });

  it('given any observations at all, then the cause stays NOT MEASURED', () => {
    // Req 5.28, and the whole point of Component 21: a count is not a cause. A record that
    // decided the cause from these observations would be the defect this guards against.
    const { cause } = declineMeasurementOf(MEASUREMENT, ONE_CRITERION);

    expect(cause.kind).toBe('not-measured');
    expect(cause.reason).toContain('not why');
    expect(DECLINE_SCHEMA_VERSION).toBe(1);
  });

  it('given declines handed one criterion each, then that is recorded and not read as a cause', () => {
    const { figures, cause } = declineMeasurementOf(MEASUREMENT, ONE_CRITERION);

    expect(figures[0]?.declinedOnSingleCriterion).toBe(figures[0]?.declinedCount);
    expect(cause.kind).toBe('not-measured');
  });
});
