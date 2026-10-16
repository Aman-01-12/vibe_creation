// **Feature: formal-gate-first-light, Property 28: Not_Measured and zero render as different
// tokens, and every count names its population**
//
// WHAT THIS FILE CLAIMS, AND WHAT IT LEAVES TO ITS NEIGHBOUR
//   `app/test/formal-summary-aggregation.property.test.ts` already asserts that each rendered
//   count EQUALS its arm's own tally, reproducing this row's exact text in both branches. So this
//   file does not re-assert that text. It asserts the two claims a correct tally does not reach:
//   the TOKEN DISTINCTION, that an arm no gate ran for never renders the token an arm that gated
//   and refused nothing renders, and the POPULATION NAMING, that every rendered count says which
//   population it was taken over. A renderer printing `0` in both branches tallies correctly and
//   still claims a clean gate for an arm no gate ran for, which is the failure Req 9.5 names and
//   the one `summary.ts` carried until the refused count became `number | null`.
//
// THE DISCRIMINATING FIELD IS `propertySetAdmitted`, so the arms vary over it: an arm whose every
//   record reads `not-gated`, an arm with no such record, and an arm holding both. `no-gate-set`
//   is a gate that RAN with nothing to hold the set to, so it is drawn among the gated outcomes
//   and is still not a refusal
//   (`chipAgent/_inbox/gotcha-changing-a-rendered-summary-line-to-not-measured-touches-two-test-sites-not-one-because-the-property-oracle-asserts-the-lines-text.md`).
//
// The tag is a literal, not `propertyTag(...)`, whose feature slug is hardcoded to a different
// spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 9.4, 9.5, 9.6, 9.7**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { PROPERTY_SET_ADMISSION_OUTCOMES, type PropertySetAdmissionOutcome } from '@app/agent';
import {
  renderSummary,
  RESULTS_SCHEMA_VERSION,
  summarizeRecords,
  type SweepSampleRecord,
} from '@app/eval';

import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 28: Not_Measured and zero render as different tokens, ' +
  'and every count names its population';

/** The design's floor, and enough draws to reach every arm kind many times over. */
const NUM_RUNS = 100;

const CONFIG_HASH = 'cfg-not-measured-28';

const KS: readonly number[] = [1];

/** Nothing malformed and nothing stale, so every record is aggregated rather than refused. */
const HEALTHY_LOG = { malformedLines: 0, staleSchemaLines: 0 } as const;

/** Three arms is enough for a measured and an unmeasured count to sit in one report. */
const MAX_ARMS = 3;

const MAX_SAMPLES = 4;

const NOT_GATED = 'not-gated' satisfies PropertySetAdmissionOutcome;

const REFUSED = 'refused' satisfies PropertySetAdmissionOutcome;

const NOT_MEASURED_TOKEN = 'NOT MEASURED';

const ZERO_TOKEN = '0';

/** The three outcomes that mean a gate RAN, `no-gate-set` among them. */
const GATED_OUTCOMES: readonly PropertySetAdmissionOutcome[] =
  PROPERTY_SET_ADMISSION_OUTCOMES.filter((outcome) => outcome !== NOT_GATED);

/**
 * The three populations the rendered token has to tell apart: one nothing gated, one every
 * sample of which was gated, and one holding both, where the gated sub-population the count is
 * taken over is SMALLER than the arm's recorded sample count.
 */
const ARM_KINDS = ['ungated', 'gated', 'mixed'] as const;
type ArmKind = (typeof ARM_KINDS)[number];

/** Every field no count in this file reads, at values the summary accepts. */
const BASE_RECORD: SweepSampleRecord = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  strategyArm: 'control',
  checkingApproach: 'cycle-timed',
  designGroup: 'cycle-exact',
  testbenchPromptVersion: 4,
  simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
  testbenchParseRefusal: null,
  positiveControlRun: null,
  // The base sample's testbench was measured and gave every failure report a value.
  valuelessFailureReports: 0,
  configHash: CONFIG_HASH,
  armName: 'arm-0',
  modelSignature: 'zai.glm-5',
  problemId: 'problem-0',
  sampleIndex: 0,
  seed: 1,
  passed: true,
  outcomeStatus: 'verified',
  iterations: 1,
  costCents: 1,
  costKnown: true,
  promptTokens: 800,
  completionTokens: 200,
  totalTokens: 1_000,
  unreportedUsageCalls: 0,
  stopReason: null,
  goldenVerdict: 'passed',
  goldenFailureCount: 0,
  instrumentValidity: 'valid',
  instrumentDefect: null,
  instrumentUncheckedReason: null,
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
  repairAttempted: false,
  repairAccepted: false,
  repairDeclineReason: null,
  checkNameVisibilitySignal: false,
  formal: null,
  formalFallbackReason: null,
  formalFallbackRoute: 'not-applicable',
  formalResetContract: null,
  formalAssertionGateEmitted: false,
  formalClockPolarity: null,
  // The one field every draw overrides, and the only one the refused count reads.
  propertySetAdmitted: NOT_GATED,
  propertySetAuthoredUpFront: false,
  propertySetSurvivorCount: 0,
  formalMutationCounts: null,
  durationMs: 1_000,
  completedAtMs: 1_000,
  failureNote: null,
  noVerdictCause: null,
};

function armNameAt(index: number): string {
  return `arm-${index}`;
}

function recordOf(
  armIndex: number,
  slot: number,
  admission: PropertySetAdmissionOutcome,
): SweepSampleRecord {
  return {
    ...BASE_RECORD,
    armName: armNameAt(armIndex),
    problemId: `problem-${slot}`,
    sampleIndex: slot,
    propertySetAdmitted: admission,
  };
}

/** One arm, as drawn: the kind it is, and the admission outcome of each of its samples. */
interface DrawnArm {
  readonly kind: ArmKind;
  readonly admissions: readonly PropertySetAdmissionOutcome[];
}

/**
 * One arm's admission outcomes, of the asked-for kind.
 *
 * The outcomes are not shuffled, because nothing downstream reads their order: the count filters
 * the arm's records and the renderer prints one row for the arm.
 */
function admissionsArbitrary(kind: ArmKind): fc.Arbitrary<readonly PropertySetAdmissionOutcome[]> {
  const gated = fc.constantFrom(...GATED_OUTCOMES);
  const sizing = { minLength: 1, maxLength: MAX_SAMPLES };
  if (kind === 'ungated') {
    return fc.array(fc.constant(NOT_GATED), sizing);
  }
  if (kind === 'gated') {
    return fc.array(gated, sizing);
  }
  return fc
    .tuple(
      gated,
      fc.array(fc.constantFrom(...PROPERTY_SET_ADMISSION_OUTCOMES), {
        maxLength: MAX_SAMPLES - 2,
      }),
    )
    .map(([oneGated, rest]) => [NOT_GATED, oneGated, ...rest]);
}

function armArbitrary(): fc.Arbitrary<DrawnArm> {
  return fc
    .constantFrom(...ARM_KINDS)
    .chain((kind) => admissionsArbitrary(kind).map((admissions) => ({ kind, admissions })));
}

function populationArbitrary(): fc.Arbitrary<readonly DrawnArm[]> {
  return fc.array(armArbitrary(), { minLength: 1, maxLength: MAX_ARMS });
}

/**
 * The token one arm's refused row must render, read off the drawn field alone.
 *
 * Not_Measured where NOTHING was gated, and otherwise the refusals among the samples that were,
 * which is the one count the row is allowed to be about.
 */
function expectedToken(admissions: readonly PropertySetAdmissionOutcome[]): string {
  const gated = admissions.filter((admission) => admission !== NOT_GATED);
  return gated.length === 0
    ? NOT_MEASURED_TOKEN
    : String(gated.filter((admission) => admission === REFUSED).length);
}

/** The drawn population, persisted shape aside: aggregated and rendered as the sweep renders it. */
function renderedLines(arms: readonly DrawnArm[]): readonly string[] {
  const records = arms.flatMap((arm, index) =>
    arm.admissions.map((admission, slot) => recordOf(index, slot, admission)),
  );
  return renderSummary(summarizeRecords(records, KS, CONFIG_HASH, HEALTHY_LOG));
}

/**
 * The refused row's label. The colon is load-bearing: `property-set-refused` is also a
 * Fallback_Route, and its tally row prints the bare name with no colon.
 */
const REFUSED_LABEL = '  property-set-refused:';

/** The rendered lines of one arm: its header up to the next arm's header, or the end. */
function armBlock(lines: readonly string[], armName: string): readonly string[] {
  const start = lines.findIndex((line) => line.startsWith(`arm ${armName}  [`));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('arm '));
  return lines.slice(start, end === -1 ? lines.length : end);
}

/** The ONE refused row inside one arm's block: a count belongs to exactly one population. */
function refusedRowOf(lines: readonly string[], armName: string): string {
  const rows = armBlock(lines, armName).filter((line) => line.startsWith(REFUSED_LABEL));
  expect(rows).toHaveLength(1);
  return rows[0] ?? '';
}

/** The row's token, then whatever follows it. Anything else is a count rendered with no token. */
const ROW_TOKEN = /^ {2}property-set-refused: (NOT MEASURED|\d+) /;

/** One rendered count: the token standing in for the number, and the population it is over. */
interface RenderedCount {
  readonly token: string;
  readonly population: string;
}

function countOf(row: string): RenderedCount {
  const match = ROW_TOKEN.exec(row);
  const token = match?.[1];
  if (match === null || token === undefined) {
    throw new Error(`the refused row renders neither a Not_Measured token nor a count: ${row}`);
  }
  return { token, population: row.slice(match[0].length).trim() };
}

/**
 * The population each branch has to name (Req 9.7).
 *
 * A measured count names the GATED SUB-POPULATION rather than the arm, which is what a reader of
 * a mixed arm would otherwise take it over; the unmeasured one names the absence it reports. The
 * fragments are short on purpose: the full text is the neighbour file's claim, not this one's.
 */
const POPULATION_NAMED: Readonly<Record<'measured' | 'unmeasured', RegExp>> = {
  measured: /of the samples this arm gated/,
  unmeasured: /no sample in this arm was gated/,
};

/** Both claims, for one arm's row: the token distinguishes by case, and the count is not bare. */
function assertArmRow(lines: readonly string[], arm: DrawnArm, index: number): void {
  const { token, population } = countOf(refusedRowOf(lines, armNameAt(index)));
  const measured = arm.kind !== 'ungated';
  expect(token).toBe(expectedToken(arm.admissions));
  // The unmeasured token is not a numeral at all, so it cannot be read as zero refusals however
  // the arm's numbers fall - including when a gated arm beside it genuinely refused none.
  expect(Number.isInteger(Number(token))).toBe(measured);
  expect(population).toMatch(POPULATION_NAMED[measured ? 'measured' : 'unmeasured']);
}

/** No token means both a measured and an unmeasured count in one report, which is Req 9.4. */
function assertTokensDisjoint(lines: readonly string[], arms: readonly DrawnArm[]): void {
  const tokensWhere = (gated: boolean): ReadonlySet<string> =>
    new Set(
      arms.flatMap((arm, index) =>
        (arm.kind !== 'ungated') === gated
          ? [countOf(refusedRowOf(lines, armNameAt(index))).token]
          : [],
      ),
    );
  const measured = tokensWhere(true);
  expect([...tokensWhere(false)].filter((token) => measured.has(token))).toEqual([]);
}

describe(PROPERTY, () => {
  it('renders a count that was not taken as a token no taken count renders, each naming its population', () => {
    const kinds = new Set<ArmKind>();
    fc.assert(
      fc.property(populationArbitrary(), (arms) => {
        for (const arm of arms) {
          kinds.add(arm.kind);
        }
        const lines = renderedLines(arms);
        // One row per arm. A single report-wide row would let a reader take one population's
        // count for another's, which is the other half of Req 9.7.
        expect(lines.filter((line) => line.startsWith(REFUSED_LABEL))).toHaveLength(arms.length);
        arms.forEach((arm, index) => assertArmRow(lines, arm, index));
        assertTokensDisjoint(lines, arms);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
    // The three kinds are what makes the distinction visible, so the run says it drew them.
    expect([...ARM_KINDS].filter((kind) => !kinds.has(kind))).toEqual([]);
  });

  it('renders zero for a gate that refused nothing and Not_Measured for an arm no gate ran for, in one report', () => {
    const lines = renderedLines([
      { kind: 'gated', admissions: ['admitted', 'admitted'] },
      { kind: 'ungated', admissions: [NOT_GATED, NOT_GATED] },
    ]);
    const gated = countOf(refusedRowOf(lines, armNameAt(0)));
    const ungated = countOf(refusedRowOf(lines, armNameAt(1)));
    expect(gated.token).toBe(ZERO_TOKEN);
    expect(ungated.token).toBe(NOT_MEASURED_TOKEN);
    expect(ungated.token).not.toBe(gated.token);
  });

  it('counts `no-gate-set` as a gate that ran, so its arm renders zero rather than Not_Measured', () => {
    const lines = renderedLines([{ kind: 'gated', admissions: ['no-gate-set'] }]);
    expect(countOf(refusedRowOf(lines, armNameAt(0))).token).toBe(ZERO_TOKEN);
  });
});
