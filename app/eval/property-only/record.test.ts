// The Property_Only_Measurement codec: one round trip, and the departures that decode to
// nothing. A persisted file is external input, so every assertion here is about the refusal.

import { describe, expect, it } from 'vitest';

import {
  decodePropertyOnlyMeasurement,
  encodePropertyOnlyMeasurement,
  PROPERTY_ONLY_SCHEMA_VERSION,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
} from './record.js';

import type { ManifestToolchain } from '../sweep/manifest.js';

/** A toolchain with one unread member, so both `ProbedVersion` arms are exercised. */
const TOOLCHAIN: ManifestToolchain = {
  iverilogVersion: '13.0',
  vvpVersion: '13.0',
  workerPython: null,
  yosysVersion: { kind: 'read', value: '0.69+post' },
  yosysBuildId: { kind: 'read', value: '143eb14f9cc55d6f8927e68523b0c9d2166ed02c' },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'answers --version with usage' },
  bitwuzlaVersion: { kind: 'read', value: '0.9.1' },
  z3Version: { kind: 'read', value: '4.15.4' },
};

/** An admitted design carrying one proof and one cross-check disagreement. */
const ADMITTED: PropertyOnlyDesignResult = {
  designId: 'rtllm/arithmetic/adder_8bit',
  authoringModel: 'zai.glm-5',
  population: 'admitted',
  prepassRefusalCause: null,
  properties: [
    {
      propertyId: 'p1',
      outcome: {
        kind: 'measured',
        verdict: 'proved',
        couldNotVerifyCause: null,
        crossCheckDisagreed: false,
        conditions: {
          assertionCount: 1,
          presat: 'satisfiable',
          cover: { reached: true, step: 3 },
          base: 'passed',
          induction: 'successful',
        },
      },
    },
    {
      propertyId: 'p2',
      outcome: {
        kind: 'measured',
        verdict: 'could-not-verify',
        couldNotVerifyCause: 'induction-inconclusive',
        crossCheckDisagreed: true,
        conditions: {
          assertionCount: 2,
          presat: 'satisfiable',
          cover: { reached: false },
          base: 'passed',
          induction: 'inconclusive',
        },
      },
    },
  ],
  unexpressedCriteria: ['2.4'],
  promptTokens: 1200,
  completionTokens: 340,
  elapsedMs: 8123.5,
  proofSpanMs: 4100.5,
  toolchain: TOOLCHAIN,
  formalOracleVersion: 2,
};

/** A refused design whose one property no oracle invocation ever decided. */
const REFUSED: PropertyOnlyDesignResult = {
  designId: 'rtllm/miscellaneous/freq_divbyodd',
  authoringModel: 'moonshotai.kimi-k2.5',
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
  toolchain: TOOLCHAIN,
  formalOracleVersion: 2,
};

const MEASUREMENT: PropertyOnlyMeasurement = {
  schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
  runName: 'property-only-v1',
  measurementKind: 'property-only',
  omittedStudentPathSteps: ['Testbench_Agent', 'Instrument_Admission'],
  results: [ADMITTED, REFUSED],
  limits: [{ name: 'proof-depth', value: 20, unit: 'steps', reason: 'termination' }],
};

/** The encoded record as a mutable object tree, for a test to depart from one field at a time. */
function mutable(): Record<string, unknown> {
  return JSON.parse(encodePropertyOnlyMeasurement(MEASUREMENT)) as Record<string, unknown>;
}

/**
 * One object inside a mutable copy, by a path of keys and array indices.
 *
 * Throws on a path the encoded record does not hold, because that is a broken fixture rather
 * than a departure the decoder is being asked about.
 */
function node(raw: unknown, ...path: readonly (string | number)[]): Record<string, unknown> {
  let here: unknown = raw;
  for (const step of path) {
    here = Array.isArray(here)
      ? here[step as number]
      : (here as Record<string, unknown> | undefined)?.[step];
  }
  if (typeof here !== 'object' || here === null || Array.isArray(here)) {
    throw new Error(`no object at path ${path.join('.')}`);
  }
  return here as Record<string, unknown>;
}

/** The nth property's outcome inside the first design result. */
function outcome(raw: unknown, index: number): Record<string, unknown> {
  return node(raw, 'results', 0, 'properties', index, 'outcome');
}

describe('Property_Only_Measurement codec', () => {
  it('round-trips a measurement over both populations', () => {
    const decoded = decodePropertyOnlyMeasurement(encodePropertyOnlyMeasurement(MEASUREMENT));

    expect(decoded).toEqual(MEASUREMENT);
  });

  it('round-trips an already-parsed value, so a caller need not re-stringify', () => {
    expect(decodePropertyOnlyMeasurement(mutable())).toEqual(MEASUREMENT);
  });

  it('refuses an unknown population member rather than placing the design in neither', () => {
    const raw = mutable();
    node(raw, 'results', 0).population = 'partially-admitted';

    expect(decodePropertyOnlyMeasurement(raw)).toBeNull();
  });

  it('refuses a missing authoringModel, because its figures would be attributable to none', () => {
    const raw = mutable();
    delete node(raw, 'results', 0).authoringModel;

    expect(decodePropertyOnlyMeasurement(raw)).toBeNull();
  });

  it('refuses an older schema version rather than reading it as the current shape', () => {
    const raw = mutable();
    raw.schemaVersion = PROPERTY_ONLY_SCHEMA_VERSION - 1;

    expect(decodePropertyOnlyMeasurement(raw)).toBeNull();
  });

  it('refuses a measurementKind that is not the property-only literal', () => {
    const raw = mutable();
    raw.measurementKind = 'end-to-end';

    expect(decodePropertyOnlyMeasurement(raw)).toBeNull();
  });

  it('refuses a could-not-verify verdict with no cause, and a proved verdict carrying one', () => {
    const withoutCause = mutable();
    outcome(withoutCause, 1).couldNotVerifyCause = null;

    const withCause = mutable();
    outcome(withCause, 0).couldNotVerifyCause = 'proof-timeout';

    expect(decodePropertyOnlyMeasurement(withoutCause)).toBeNull();
    expect(decodePropertyOnlyMeasurement(withCause)).toBeNull();
  });

  it('refuses a cross-check disagreement on a verdict other than could-not-verify', () => {
    const raw = mutable();
    outcome(raw, 0).crossCheckDisagreed = true;

    expect(decodePropertyOnlyMeasurement(raw)).toBeNull();
  });

  it('refuses a missing Proof_Conditions field rather than defaulting the fifth condition', () => {
    const raw = mutable();
    delete node(outcome(raw, 0), 'conditions').induction;

    expect(decodePropertyOnlyMeasurement(raw)).toBeNull();
  });

  it('refuses a missing toolchain, so a record with no provenance is never read as one', () => {
    const raw = mutable();
    delete node(raw, 'results', 0).toolchain;

    expect(decodePropertyOnlyMeasurement(raw)).toBeNull();
  });

  it('refuses a limit whose reason is outside the Limit_Reason vocabulary', () => {
    const raw = mutable();
    node(raw, 'limits', 0).reason = 'cost';

    expect(decodePropertyOnlyMeasurement(raw)).toBeNull();
  });

  it('refuses a sparse string list, which an `Array.prototype.map` validator reads as valid', () => {
    // A hole, not an `undefined` entry: `map` skips holes and copies them through, so a
    // map-then-`includes(null)` check never sees one and decodes `[hole]` as `string[]`.
    // Unreachable through a file (JSON has no hole) but reachable through the parsed-value
    // overload, so the refusal is asserted at the boundary that can be handed one.
    const raw = mutable();
    const sparse: string[] = [];
    sparse.length = 1;
    raw.omittedStudentPathSteps = sparse;

    expect(decodePropertyOnlyMeasurement(raw)).toBeNull();
  });

  it('refuses unparseable text and a non-object value', () => {
    expect(decodePropertyOnlyMeasurement('{ not json')).toBeNull();
    expect(decodePropertyOnlyMeasurement(null)).toBeNull();
    expect(decodePropertyOnlyMeasurement([MEASUREMENT])).toBeNull();
  });
});
