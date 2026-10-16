// Feature: formal-gate-first-light, Property 6: Each anchor has exactly two observations, each
// naming its own reason.
//
// WHY THE PAIRING IS THE CLAIM
//   The whole point of the Scaling_Anchor measurement is that each anchor is decided TWICE, once
//   under the shipped 150 s budget the Student_Path actually runs under and once under a wide
//   ceiling, so the shipped default is sized against observed cost rather than inherited belief.
//   An anchor with one observation cannot answer that question, and an anchor whose two
//   observations ran under the SAME ceiling silently answers it twice over for one bound.
//   `multi_booth_8bit` is why it matters: it times out at 150 s and proves at 195 s, so the pair
//   is the finding.
//
// EACH OBSERVATION NAMES ITS OWN REASON BY TYPE
//   `ceiling` is a `MeasurementLimit`, which carries exactly one `LimitReason` by construction,
//   so a figure can never be recorded without the reason it was bounded. What this property
//   checks is that the two ceilings are the two DECLARED ones and that neither is missing.
//
// THE REJECTION CASES ARE GENERATED, NOT ASSUMED
//   `anchorRecordProblems` is the pre-write check the driver runs before it commits anything, so
//   a record it accepts is one a reader can place. Three malformed shapes are generated against
//   it - a dropped ceiling, a duplicated ceiling, and a stray non-anchor design - because a
//   checker that accepted everything would pass a test that only fed it good records.
//
// Validates: Requirements 3.4, 3.6, 3.7

import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FORMAL_ORACLE_VERSION } from '@app/agent';
import type { MeasurementLimit } from '@app/eval';

import {
  ANCHOR_CEILING_NAMES,
  ANCHOR_RECORD_PATH,
  anchorRecordProblems,
  ceilingOf,
  type AnchorDecision,
  type AnchorMeasurementRecord,
} from './formal-anchor-measurement.js';
import { SCALING_ANCHOR_IDS } from './formal-fixtures.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 6: Each anchor has exactly two observations, each naming its own reason';

/**
 * The Formal_Oracle_Version the generated record and its observations must agree on.
 *
 * Read from the constant rather than pinned to a number: these records are generated here as if
 * freshly measured, and the pre-write check holds a fresh record to the CURRENT version, so a
 * literal would turn every bump of that version into a failure of this property.
 */
const VERSION = FORMAL_ORACLE_VERSION;

/**
 * The version the COMMITTED record was taken under, which is not the current one.
 *
 * Task 4.5's six Budget_Observations were decided under version 2 and are never rewritten: the
 * field exists to say which gate decided them, so re-stamping them would destroy the one fact
 * that keeps them from pooling with a version-3 re-run (task 4.29 of formal-gate-first-light).
 */
const COMMITTED_RECORD_VERSION = 2;

/**
 * One declared ceiling by name, carrying the Limit_Reason that bound belongs to.
 *
 * The shipped budget's reason is `population-honesty` because a figure taken under it describes
 * what the Student_Path actually gets; the wide ceiling's is `termination`, because its only job
 * is to stop.
 */
function ceiling(name: string): MeasurementLimit {
  const shipped = name === ANCHOR_CEILING_NAMES[0];
  return {
    name,
    value: shipped ? 150_000 : 1_800_000,
    unit: 'ms',
    reason: shipped ? 'population-honesty' : 'termination',
  };
}

/** One decision, measured or not, under a named ceiling. */
function decisionOf(designId: string, ceilingName: string, measured: boolean): AnchorDecision {
  const limit = ceiling(ceilingName);
  return {
    designId,
    propertyId: `${designId}-exact`,
    criterionRef: '3.2',
    expectedVerdict: 'proved',
    outcome: measured
      ? {
          kind: 'measured',
          observation: {
            designId,
            verdict: 'proved',
            proofDepth: 20,
            elapsedMs: 7_000,
            ceiling: limit,
            couldNotVerifyCause: null,
            toolchain: {} as never,
            formalOracleVersion: VERSION,
          },
          conditions: {} as never,
          counterexampleReturned: false,
          contradiction: null,
        }
      : {
          kind: 'not-measured',
          ceiling: limit,
          reason: 'the host refused the invocation, so no verdict is traceable to it',
        },
  };
}

/** A well-formed record: every anchor under both ceilings. */
function wellFormed(measuredFlags: readonly boolean[]): AnchorMeasurementRecord {
  const decisions = SCALING_ANCHOR_IDS.flatMap((id, index) =>
    ANCHOR_CEILING_NAMES.map((name, phase) =>
      decisionOf(id, name, measuredFlags[(index + phase) % measuredFlags.length] ?? true),
    ),
  );
  return {
    schemaVersion: 1,
    measurementKind: 'scaling-anchor',
    formalOracleVersion: VERSION,
    toolchain: {} as never,
    limits: [],
    tokenCount: 0,
    elapsedWallClockMs: 360_000,
    decisions,
  };
}

describe(PROPERTY, () => {
  it('accepts a record pairing every anchor across both ceilings, whichever arms the outcomes take', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), (measuredFlags) => {
        const record = wellFormed(measuredFlags);

        // Both arms of the outcome union satisfy the pairing: a host that refused an invocation
        // still owes a reader both ceilings, which is why the not-measured arm carries one.
        expect(anchorRecordProblems(record)).toEqual([]);
        expect(record.decisions).toHaveLength(
          SCALING_ANCHOR_IDS.length * ANCHOR_CEILING_NAMES.length,
        );
        for (const id of SCALING_ANCHOR_IDS) {
          const names = record.decisions
            .filter((decision) => decision.designId === id)
            .map((decision) => ceilingOf(decision.outcome).name);
          expect([...names].sort()).toEqual([...ANCHOR_CEILING_NAMES].sort());
        }
      }),
      propertyParameters(),
    );
  });

  it('rejects a dropped ceiling, a duplicated ceiling, and a stray design', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SCALING_ANCHOR_IDS),
        fc.constantFrom(...ANCHOR_CEILING_NAMES),
        (anchorId, ceilingName) => {
          const base = wellFormed([true]);

          // A dropped ceiling: that anchor can no longer answer the sizing question.
          const dropped = {
            ...base,
            decisions: base.decisions.filter(
              (decision) =>
                !(
                  decision.designId === anchorId && ceilingOf(decision.outcome).name === ceilingName
                ),
            ),
          };
          expect(anchorRecordProblems(dropped).length).toBeGreaterThan(0);

          // A duplicated ceiling: two figures under one bound, and none under the other.
          const duplicated = {
            ...base,
            decisions: base.decisions.map((decision) =>
              decision.designId === anchorId ? decisionOf(anchorId, ceilingName, true) : decision,
            ),
          };
          expect(anchorRecordProblems(duplicated).length).toBeGreaterThan(0);

          // A stray design has no place in a record about the three anchors.
          const stray = {
            ...base,
            decisions: [
              ...base.decisions,
              decisionOf('rtllm/memory/LIFObuffer', ceilingName, true),
            ],
          };
          expect(anchorRecordProblems(stray).length).toBeGreaterThan(0);
        },
      ),
      propertyParameters(),
    );
  });

  it('holds over the COMMITTED record, which is where the pairing has to be true', () => {
    let record: AnchorMeasurementRecord;
    try {
      record = JSON.parse(readFileSync(ANCHOR_RECORD_PATH, 'utf8')) as AnchorMeasurementRecord;
    } catch {
      // A fresh clone has not run `npm run formal:anchors`; the generated halves still ran.
      return;
    }

    expect(anchorRecordProblems(record, COMMITTED_RECORD_VERSION)).toEqual([]);
    expect(record.decisions).toHaveLength(SCALING_ANCHOR_IDS.length * ANCHOR_CEILING_NAMES.length);
    // And every ceiling in it names a Limit_Reason, so no figure sits without its bound's reason.
    for (const decision of record.decisions) {
      expect(ceilingOf(decision.outcome).reason.trim().length).toBeGreaterThan(0);
    }
  });
});
