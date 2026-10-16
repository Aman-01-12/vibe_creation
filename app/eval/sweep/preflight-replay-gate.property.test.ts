// Feature: testbench-failure-reportability, Property 12 (C8): the start refusal.
//
// The oracle restates Requirements 3.6 and 3.7 over the report with the build constants as
// literals, never calling `replayGateRefusals`. The real-probe path stays integration-only.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { replayGateReportPathOf } from './cli.js';
import { parseSweepConfig } from './config-parse.js';
import type { SweepConfig } from './config.js';
import { replayGateRefusals } from './preflight.js';

const PROPERTY_12 =
  'Feature: testbench-failure-reportability, Property 12: The start refusal is empty only for a fully matching passing report';

/** A build's four constants, as literals so the oracle shares nothing with the module. */
const BUILD = {
  simulationHarnessVersion: 3,
  normalizerVersion: 5,
  watchdogBudgetNs: 2_000_000,
  dumpLimitBytes: 16_777_216,
} as const;

type ConstantField = keyof typeof BUILD;
const CONSTANT_FIELDS = Object.keys(BUILD) as readonly ConstantField[];
const GATE_FIELDS = ['passed', 'verdictChanges', ...CONSTANT_FIELDS] as const;
type GateField = (typeof GATE_FIELDS)[number];

/** Marks a field the drawn report omits entirely. */
const MISSING = Symbol('missing');

/** Requirement 3.6/3.7, one clause per field: does this value clear the gate? */
function fieldClears(field: GateField, value: unknown): boolean {
  switch (field) {
    case 'passed':
      return value === true;
    case 'verdictChanges':
      return Array.isArray(value) && value.length === 0;
    default:
      return value === BUILD[field];
  }
}

/** The oracle: an object report clears only when every gate field clears. */
function oracleClears(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return false;
  }
  const report = raw as Record<string, unknown>;
  return GATE_FIELDS.every((field) => fieldClears(field, report[field]));
}

/** Keys a real report may carry beside the gate fields; they must not affect the decision. */
const extraKeys = fc.dictionary(
  fc
    .string()
    .filter((key) => !(GATE_FIELDS as readonly string[]).includes(key) && key !== '__proto__'),
  fc.jsonValue(),
  { maxKeys: 4 },
);

/** A report that clears, with the clearing value for every gate field. */
function clearing(): Record<GateField, unknown> {
  return { passed: true, verdictChanges: [], ...BUILD };
}

/** A value that fails `field`'s clause: near misses, wrong types, and anything at all. */
function failingValue(field: GateField): fc.Arbitrary<unknown> {
  const near =
    field === 'passed'
      ? fc.constantFrom(false, 'true', 1, null)
      : field === 'verdictChanges'
        ? fc.oneof(
            fc.array(fc.jsonValue(), { minLength: 1, maxLength: 3 }),
            fc.constantFrom({}, 0, null),
          )
        : fc.oneof(
            fc.integer({ min: -3, max: 3 }).map((delta) => BUILD[field] + delta),
            fc.constant(String(BUILD[field])),
          );
  return fc
    .oneof(near, fc.anything(), fc.constant(MISSING))
    .filter((value) => value === MISSING || !fieldClears(field, value));
}

/** The clearing report with `field` replaced by `value`, or deleted for `MISSING`. */
function perturb(
  base: Record<string, unknown>,
  field: GateField,
  value: unknown,
): Record<string, unknown> {
  const report: Record<string, unknown> = { ...base };
  if (value === MISSING) {
    delete report[field];
  } else {
    report[field] = value;
  }
  return report;
}

describe(PROPERTY_12, () => {
  it('accepts a fully matching passing report whatever else it carries', () => {
    fc.assert(
      fc.property(extraKeys, (extras) => {
        const report = { ...extras, ...clearing() };
        expect(oracleClears(report)).toBe(true);
        expect(replayGateRefusals(report, BUILD)).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('refuses when exactly one field fails, for every field, with at least one reason', () => {
    // Every field is exhausted on every run rather than sampled, so no clause can go unvisited.
    const perField = fc.record(
      Object.fromEntries(GATE_FIELDS.map((field) => [field, failingValue(field)])) as Record<
        GateField,
        fc.Arbitrary<unknown>
      >,
    );
    fc.assert(
      fc.property(extraKeys, perField, (extras, bad) => {
        for (const field of GATE_FIELDS) {
          const report = perturb({ ...extras, ...clearing() }, field, bad[field]);
          expect(oracleClears(report)).toBe(false);
          expect(replayGateRefusals(report, BUILD).length).toBeGreaterThanOrEqual(1);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('names the field, the observed value, and the expected value when a constant fails', () => {
    const observed = fc.oneof(
      fc.integer({ min: -3, max: 3 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.boolean(),
      fc.constant(null),
      fc.stringMatching(/^[a-z0-9]{0,8}$/),
      fc.constant(MISSING),
    );
    fc.assert(
      fc.property(fc.constantFrom(...CONSTANT_FIELDS), observed, (field, seen) => {
        // A small integer is read as a near miss of the expected value, never as a match.
        const value = typeof seen === 'number' && Math.abs(seen) <= 3 ? BUILD[field] + seen : seen;
        fc.pre(value === MISSING || !fieldClears(field, value));
        const reasons = replayGateRefusals(perturb(clearing(), field, value), BUILD);
        const rendered = value === MISSING ? 'undefined' : String(value);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain(field);
        expect(reasons[0]).toContain(rendered);
        expect(reasons[0]).toContain(String(BUILD[field]));
      }),
      { numRuns: 200 },
    );
  });

  it('agrees with the oracle on arbitrary and malformed reports, and never throws', () => {
    const mixedField = (field: GateField): fc.Arbitrary<unknown> =>
      fc.oneof(
        { arbitrary: fc.constant(clearing()[field]), weight: 3 },
        { arbitrary: failingValue(field), weight: 1 },
      );
    const mixed = fc
      .record(
        Object.fromEntries(GATE_FIELDS.map((field) => [field, mixedField(field)])) as Record<
          GateField,
          fc.Arbitrary<unknown>
        >,
      )
      .map((fields) =>
        GATE_FIELDS.reduce<Record<string, unknown>>(
          (report, field) => perturb(report, field, fields[field]),
          {},
        ),
      );
    const report = fc.oneof(
      mixed,
      fc.anything(),
      fc.dictionary(fc.constantFrom(...GATE_FIELDS, 'schemaVersion'), fc.anything()),
    );
    fc.assert(
      fc.property(report, (raw) => {
        let reasons: readonly string[] = [];
        expect(() => {
          reasons = replayGateRefusals(raw, BUILD);
        }).not.toThrow();
        expect(reasons.length === 0).toBe(oracleClears(raw));
      }),
      { numRuns: 300 },
    );
  });
});

/** A minimal valid config that is not a Campaign. */
const BASE = {
  schemaVersion: 1,
  runName: 'harness-start',
  arms: [{ name: 'glm-5', model: 'zai.glm-5' }],
  problems: { kind: 'all' },
  sampleCount: 1,
  ks: [1],
  seed: 42,
  temperature: 0,
  caps: { maxIterations: 1, maxTokens: 1000, maxWallClockMs: 1000, maxCostCents: 1 },
  limits: { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 },
  costEnvelopeCents: 1,
  modelHost: { region: 'us-east-1' },
  outputDir: '.eval-runs/harness-start',
};

/** Parse a raw config that must be valid. */
function parseOk(raw: Record<string, unknown>): SweepConfig {
  const parsed = parseSweepConfig(raw);
  if (!parsed.ok) {
    throw new Error(`expected a valid config, got ${parsed.error.code} at ${parsed.error.field}`);
  }
  return parsed.value;
}

/** The committed Confirmatory config, the one source of a valid grounding block. */
async function confirmatory(): Promise<Record<string, unknown>> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, 'sweep.config.grounding-confirmatory-v1.json');
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

const DECLARATIONS = ['neither', 'top-level', 'grounding', 'both'] as const;

describe(`${PROPERTY_12} (the path the refusal reads)`, () => {
  it('resolves the declared report path from either field, and none when neither is set', async () => {
    const campaign = await confirmatory();
    /** The raw config declaring `path` the way `declaration` names. */
    const declare = (
      declaration: (typeof DECLARATIONS)[number],
      path: string,
    ): Record<string, unknown> => {
      const withBlock = {
        ...campaign,
        groundingCampaign: {
          ...(campaign.groundingCampaign as object),
          replayGateReportPath: path,
        },
      };
      switch (declaration) {
        case 'neither':
          return BASE;
        case 'top-level':
          return { ...BASE, replayGateReportPath: path };
        case 'grounding':
          return withBlock;
        case 'both':
          return { ...withBlock, replayGateReportPath: path };
      }
    };
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9][a-z0-9/._-]{0,30}$/), (path) => {
        for (const declaration of DECLARATIONS) {
          const expected = declaration === 'neither' ? undefined : path;
          expect(replayGateReportPathOf(parseOk(declare(declaration, path)))).toBe(expected);
        }
      }),
      { numRuns: 100 },
    );
  });
});
