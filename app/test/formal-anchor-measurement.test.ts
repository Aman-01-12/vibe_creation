// The Scaling_Anchor record's own pre-write check (Component 5, task 4.5).
//
// The driver asserts `anchorRecordProblems` is empty BEFORE it writes, so this file is what fails
// if that check stops catching a record a reader could not place against a ceiling's reason or
// against a Formal_Oracle_Version. It needs no toolchain: the check is pure.

import { describe, expect, it } from 'vitest';

import { FORMAL_ORACLE_VERSION } from '@app/agent';
import { limitOrRefuse, type ManifestToolchain, type MeasurementLimit } from '@app/eval';
import type { ProofConditions } from '@app/tools';

import {
  ANCHOR_CEILING_NAMES,
  ANCHOR_CRITERION_REF,
  ANCHOR_RECORD_SCHEMA_VERSION,
  anchorRecordProblems,
  ceilingOf,
  type AnchorDecision,
  type AnchorMeasurementRecord,
} from './formal-anchor-measurement.js';
import { SCALING_ANCHOR_IDS } from './formal-fixtures.js';

/** A toolchain stub: this check reads no version, so the fields only have to be present. */
const TOOLCHAIN: ManifestToolchain = {
  iverilogVersion: 'Icarus Verilog version 12.0',
  vvpVersion: 'Icarus Verilog runtime version 12.0',
  workerPython: 'python3',
  yosysVersion: { kind: 'read', value: 'Yosys 0.69+post' },
  yosysBuildId: { kind: 'read', value: 'deadbeef' },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'yosys-smtbmc printed usage' },
  bitwuzlaVersion: { kind: 'read', value: 'bitwuzla 0.10.0' },
  z3Version: { kind: 'read', value: 'Z3 version 4.13.0' },
};

/** The five conditions at their admitting values, which this check never reads. */
const PROVED_CONDITIONS: ProofConditions = {
  assertionCount: 2,
  presat: 'satisfiable',
  cover: { reached: true, step: 18 },
  base: 'passed',
  induction: 'successful',
};

/** One declared ceiling by name, or a throw: a missing declaration is a broken fixture. */
function ceiling(name: string): MeasurementLimit {
  const limit = limitOrRefuse(name);
  if (!limit.ok) {
    throw new Error(limit.error.message);
  }
  return limit.value;
}

/** One measured attempt over one anchor under one ceiling. */
function measured(designId: string, ceilingName: string): AnchorDecision {
  return {
    designId,
    propertyId: `${designId}-exact`,
    criterionRef: ANCHOR_CRITERION_REF,
    expectedVerdict: 'proved',
    outcome: {
      kind: 'measured',
      observation: {
        designId,
        verdict: 'proved',
        proofDepth: 20,
        elapsedMs: 2_090,
        ceiling: ceiling(ceilingName),
        couldNotVerifyCause: null,
        toolchain: TOOLCHAIN,
        formalOracleVersion: FORMAL_ORACLE_VERSION,
      },
      conditions: PROVED_CONDITIONS,
      counterexampleReturned: false,
      contradiction: null,
    },
  };
}

/** A complete record: every anchor, both ceilings, nothing wrong with it. */
function completeRecord(): AnchorMeasurementRecord {
  return {
    schemaVersion: ANCHOR_RECORD_SCHEMA_VERSION,
    measurementKind: 'scaling-anchor',
    formalOracleVersion: FORMAL_ORACLE_VERSION,
    toolchain: TOOLCHAIN,
    limits: [ceiling('proof-depth'), ...ANCHOR_CEILING_NAMES.map(ceiling)],
    tokenCount: 0,
    elapsedWallClockMs: 180_000,
    decisions: ANCHOR_CEILING_NAMES.flatMap((name) =>
      [...SCALING_ANCHOR_IDS].map((designId) => measured(designId, name)),
    ),
  };
}

/** The same record with its decision list replaced. */
function withDecisions(decisions: readonly AnchorDecision[]): AnchorMeasurementRecord {
  return { ...completeRecord(), decisions };
}

describe('the Scaling_Anchor record is checked before it is written', () => {
  it('accepts two observations per anchor, each naming its ceiling and the oracle version', () => {
    const record = completeRecord();

    expect(record.decisions).toHaveLength(SCALING_ANCHOR_IDS.length * ANCHOR_CEILING_NAMES.length);
    expect(anchorRecordProblems(record)).toEqual([]);
  });

  it('refuses an anchor measured under only one ceiling', () => {
    const [anchor] = SCALING_ANCHOR_IDS;
    const short = completeRecord().decisions.filter(
      (decision) =>
        decision.designId !== anchor ||
        ceilingOf(decision.outcome).name === ANCHOR_CEILING_NAMES[0],
    );

    const problems = anchorRecordProblems(withDecisions(short));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(anchor ?? '');
    expect(problems[0]).toContain('1 attempts');
  });

  it('refuses two attempts that name the SAME ceiling, so a pair is not a count alone', () => {
    const [anchor] = SCALING_ANCHOR_IDS;
    const [shipped] = ANCHOR_CEILING_NAMES;
    const doubled = completeRecord().decisions.map((decision) =>
      decision.designId === anchor ? measured(decision.designId, shipped ?? '') : decision,
    );

    const problems = anchorRecordProblems(withDecisions(doubled));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(ANCHOR_CEILING_NAMES[1] ?? '');
  });

  it('refuses an observation decided under a different Formal_Oracle_Version', () => {
    const stale = completeRecord().decisions.map((decision, index) =>
      index === 0 && decision.outcome.kind === 'measured'
        ? {
            ...decision,
            outcome: {
              ...decision.outcome,
              observation: { ...decision.outcome.observation, formalOracleVersion: 1 },
            },
          }
        : decision,
    );

    const problems = anchorRecordProblems(withDecisions(stale));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Formal_Oracle_Version 1');
  });

  it('keeps a not-measured attempt, because a host that refused still owes both ceilings', () => {
    const [uncapped] = [ANCHOR_CEILING_NAMES[1]];
    const refused = completeRecord().decisions.map((decision) =>
      ceilingOf(decision.outcome).name === uncapped
        ? {
            ...decision,
            outcome: {
              kind: 'not-measured' as const,
              ceiling: ceiling(uncapped ?? ''),
              reason: 'the Formal_Oracle invocation threw, so no verdict is traceable to it',
            },
          }
        : decision,
    );

    expect(anchorRecordProblems(withDecisions(refused))).toEqual([]);
  });

  it('refuses a decision over a design that is not a Scaling_Anchor', () => {
    const [shipped] = ANCHOR_CEILING_NAMES;
    const stray = [
      ...completeRecord().decisions,
      measured('rtllm/memory/LIFObuffer', shipped ?? ''),
    ];

    const problems = anchorRecordProblems(withDecisions(stray));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('LIFObuffer');
  });
});
