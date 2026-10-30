// Feature: stimulus-transaction-structure, Property 25: Every reported figure states the Session
// count it was measured over (task 14.2).
//
// WHY THIS IS NOT A RE-IMPLEMENTATION OF THE RENDERER
//   Criterion 10.10 states the defect in words: "a mean over 2 completed Sessions is never printed
//   as a mean over 3". So every figure is computed BOTH ways here - over the measured Sessions
//   (correct) and over every Session that ran (the forbidden reading) - and the assertion is that
//   the rendered text carries the measured reading and does not contain the run-count reading
//   anywhere. Each forbidden check is anchored to the renderer's own fixed words, so a digit that
//   coincidentally appears in a per-Session detail line can neither satisfy nor break it.
//
// WHY EVERY INCOMPLETE SESSION CARRIES A REAL CONTRIBUTION
//   `renderWitnessDesignReport` filters to `incompleteReason === null` and then sums
//   `passingCells`, sums `totalCells`, counts `verified` outcomes, and means
//   `trustedTestbenchCount`. An incomplete Session drawn empty would make that filter the
//   identity on every input and leave the property blind to a missing filter, so the incomplete
//   draws carry real cell and trust counts and span both outcome kinds. Five Session kinds are
//   drawn independently of those counts, covering both reasons `incompleteSessionReason` can give
//   (a matrix that stopped mid-way, and a full-length matrix holding an unfinished run) against
//   both outcome kinds.
//
// Validates: Requirements 10.10

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CONSENSUS_POOL_SIZE,
  REFERENCE_MODEL_PROMPT_VERSION,
  type RunCell,
  type RunMatrix,
  type SessionOutcome,
  type SessionRecord,
} from '@app/agent';

import {
  incompleteSessionReason,
  renderWitnessDesignReport,
} from '../eval/scripts/stimulus-transaction-acceptance.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 25: Every reported figure states the Session count it was measured over';

/** The two report shapes, read off the exported signature so no extra type needs exporting. */
type WitnessDesignReport = Parameters<typeof renderWitnessDesignReport>[0];
type WitnessSessionReport = WitnessDesignReport['sessions'][number];

const FULL_MATRIX_SIZE = CONSENSUS_POOL_SIZE * CONSENSUS_POOL_SIZE;
const PROBLEM_ID = 'rtllm/miscellaneous/square_wave';

/** The reason the driver gives for a matrix left unfinished by a Session that still granted. */
const INCOMPLETE_VERIFIED_REASON = 'incomplete-despite-verified-outcome';

const SESSION_KINDS = [
  'complete-verified',
  'complete-unverified',
  'stopped-mid-matrix',
  'unfinished-run',
  'unfinished-run-verified',
] as const;

type SessionKind = (typeof SESSION_KINDS)[number];

const UNMET_CONDITIONS = [
  'strict-majority',
  'trusted-testbench-exists',
  'mutation-strength',
  'session-token-budget',
] as const;

interface DrawnSession {
  readonly kind: SessionKind;
  /** Consensus_Run rows completed; only a `stopped-mid-matrix` draw stops below the full pool. */
  readonly completedRows: number;
  /** Cells left with no verdict; only an `unfinished-run` draw carries any. */
  readonly unfinishedCells: number;
  readonly passing: number;
  readonly trustedTestbenchCount: number;
  readonly unmetCondition: (typeof UNMET_CONDITIONS)[number];
}

function isVerifiedKind(kind: SessionKind): boolean {
  return kind === 'complete-verified' || kind === 'unfinished-run-verified';
}

function cellCountOf(drawn: DrawnSession): number {
  return drawn.kind === 'stopped-mid-matrix'
    ? drawn.completedRows * CONSENSUS_POOL_SIZE
    : FULL_MATRIX_SIZE;
}

function unfinishedCellCountOf(drawn: DrawnSession): number {
  return drawn.kind === 'unfinished-run' || drawn.kind === 'unfinished-run-verified'
    ? drawn.unfinishedCells
    : 0;
}

/** The reason `incompleteSessionReason` owes this draw, derived from the draw itself rather than
 * from the function under test. */
function expectedReasonOf(drawn: DrawnSession): string | null {
  if (drawn.kind === 'complete-verified' || drawn.kind === 'complete-unverified') {
    return null;
  }
  return isVerifiedKind(drawn.kind) ? INCOMPLETE_VERIFIED_REASON : drawn.unmetCondition;
}

function verdictOf(index: number, passing: number, unfinished: number): boolean | null {
  if (index < passing) {
    return true;
  }
  return index < passing + unfinished ? null : false;
}

function poolId(index: number): string {
  return `id${String(index)}`;
}

function runMatrixOf(drawn: DrawnSession): RunMatrix {
  const cellCount = cellCountOf(drawn);
  const unfinished = unfinishedCellCountOf(drawn);
  const passing = Math.min(drawn.passing, Math.max(0, cellCount - unfinished));
  const cells: RunCell[] = Array.from({ length: cellCount }, (_unused, index) => {
    const passed = verdictOf(index, passing, unfinished);
    return {
      designId: poolId(Math.floor(index / CONSENSUS_POOL_SIZE)),
      testbenchId: poolId(index % CONSENSUS_POOL_SIZE),
      passed,
      signature: null,
      failureCause: passed === true ? 'none' : 'tool-failed',
    };
  });
  const ids = Array.from({ length: CONSENSUS_POOL_SIZE }, (_unused, index) => poolId(index));
  return { designIds: ids, testbenchIds: ids, cells };
}

/** Every `SessionRecord` field the two functions under test never read, at its empty value. */
function recordWith(runMatrix: RunMatrix): SessionRecord {
  return {
    clusters: [],
    signaturesByDesign: [],
    modelFamilyByArtifact: [],
    roleDeclarations: [],
    testbenchTrust: [],
    mutantCensus: [],
    poolCorrectness: { poolCorrectness: 0, attributionStatus: 'advisory', faultVerdicts: [] },
    repairAttempts: [],
    tokensSpent: 0,
    runMatrix,
  };
}

function outcomeOf(drawn: DrawnSession): SessionOutcome {
  const record = recordWith(runMatrixOf(drawn));
  if (isVerifiedKind(drawn.kind)) {
    return {
      kind: 'verified',
      deliveredDesignIds: [poolId(0)],
      cluster: { designIds: [poolId(0)], digestsByTestbench: [] },
      record,
    };
  }
  return {
    kind: 'unverified',
    unmetCondition: drawn.unmetCondition,
    checked: {
      poolSize: CONSENSUS_POOL_SIZE,
      distinctModelFamilyCount: 1,
      trustedTestbenchCount: drawn.trustedTestbenchCount,
      consensusRunCount: record.runMatrix.cells.length,
      largestClusterCardinality: 0,
      structuralGateChecks: [],
    },
    nextActions: ['accept-unverified'],
    record,
  };
}

/** One Session's report row, assembled exactly as `runWitnessDesignSessions` assembles it. */
function sessionReportOf(index: number, drawn: DrawnSession): WitnessSessionReport {
  const outcome = outcomeOf(drawn);
  const { cells } = outcome.record.runMatrix;
  return {
    index,
    outcomeKind: outcome.kind,
    unmetCondition: outcome.kind === 'unverified' ? outcome.unmetCondition : null,
    incompleteReason: incompleteSessionReason(outcome),
    passingCells: cells.filter((cell) => cell.passed === true).length,
    totalCells: cells.length,
    trustedTestbenchCount: drawn.trustedTestbenchCount,
    roleAdoptionShare: {
      problemId: PROBLEM_ID,
      role: 'hold',
      numerator: 0,
      denominator: CONSENSUS_POOL_SIZE,
      refusedReplyCount: 0,
      referenceModelPromptVersion: REFERENCE_MODEL_PROMPT_VERSION,
      floorMeasurable: true,
    },
    nonVacuity: [],
    cliquePartition:
      outcome.kind === 'unverified' ? { designCliques: [], testbenchPartition: [] } : null,
  };
}

interface Figures {
  readonly sessionCount: number;
  readonly verified: number;
  readonly passing: number;
  readonly totalCells: number;
  readonly mean: number | null;
  readonly atLeastOneTrusted: number;
}

/** Every figure the report prints, reduced over whichever Sessions are passed in. Called twice per
 * draw: once over the measured Sessions, once over every Session that ran. */
function figuresOver(sessions: readonly WitnessSessionReport[]): Figures {
  const trusted = sessions.map((session) => session.trustedTestbenchCount);
  const total = trusted.reduce((sum, count) => sum + count, 0);
  return {
    sessionCount: sessions.length,
    verified: sessions.filter((session) => session.outcomeKind === 'verified').length,
    passing: sessions.reduce((sum, session) => sum + session.passingCells, 0),
    totalCells: sessions.reduce((sum, session) => sum + session.totalCells, 0),
    mean: trusted.length === 0 ? null : total / trusted.length,
    atLeastOneTrusted: sessions.filter((session) => session.trustedTestbenchCount > 0).length,
  };
}

/** The summary lines that ARE figures: two-space indented, excluding the per-Session detail rows
 * (`  session N: ...`) and the four-space Non_Vacuity_Check and Clique_Partition rows. */
function figureLines(rendered: string): readonly string[] {
  return rendered
    .split('\n')
    .filter((line) => /^ {2}[^ ]/u.test(line) && !line.startsWith('  session '));
}

function meanText(mean: number | null): string {
  return mean === null ? 'unmeasured' : mean.toFixed(2);
}

/** Every figure line names `measuredCount` as the population behind it, and names nothing else. */
function expectEveryFigureStatesItsSessionCount(rendered: string, measuredCount: number): void {
  const figures = figureLines(rendered);
  expect(figures.length).toBeGreaterThanOrEqual(2);
  for (const line of figures) {
    expect(line).toContain('measured Session(s)');
    for (const match of line.matchAll(/(\d+) measured Session\(s\)/gu)) {
      expect(match[1]).toBe(String(measuredCount));
    }
  }
}

/** The shared figure (Req 10.3), plus the run count stated beside the measured count. */
function expectVerifiedCountFigure(rendered: string, measured: Figures, all: Figures): void {
  expect(rendered).toContain(
    `Verified_Outcome count: ${String(measured.verified)} of ${String(measured.sessionCount)} ` +
      `measured Session(s) (${String(all.sessionCount)} run)`,
  );
  if (all.sessionCount !== measured.sessionCount) {
    expect(rendered).not.toContain(`of ${String(all.sessionCount)} measured Session(s)`);
  }
}

function expectSquareWaveFigure(rendered: string, measured: Figures, all: Figures): void {
  expect(rendered).toContain(
    `passing matrix cells over ${String(measured.sessionCount)} measured Session(s): ` +
      `${String(measured.passing)} of ${String(measured.totalCells)},`,
  );
  if (all.passing !== measured.passing || all.totalCells !== measured.totalCells) {
    expect(rendered).not.toContain(
      `measured Session(s): ${String(all.passing)} of ${String(all.totalCells)},`,
    );
  }
}

function expectMultiBitFigure(rendered: string, measured: Figures, all: Figures): void {
  expect(rendered).toContain(
    `mean Trusted_Testbench count: ${meanText(measured.mean)} over ` +
      `${String(measured.sessionCount)} measured Session(s); ` +
      `${String(measured.atLeastOneTrusted)} of ${String(measured.sessionCount)} reached at ` +
      'least one Trusted_Testbench',
  );
  if (all.mean !== measured.mean) {
    expect(rendered).not.toContain(`mean Trusted_Testbench count: ${meanText(all.mean)} over`);
  }
}

/** Req 10.10's first half: an unfinished matrix is reported as not measured, with its reason. */
function expectIncompletenessReported(
  rendered: string,
  drawn: DrawnSession,
  session: WitnessSessionReport,
): void {
  expect(session.incompleteReason).toBe(expectedReasonOf(drawn));
  if (session.incompleteReason === null) {
    expect(rendered).toContain(`session ${String(session.index)}: ${session.outcomeKind} |`);
    return;
  }
  expect(rendered).toContain(
    `session ${String(session.index)}: NOT MEASURED (${session.incompleteReason}) |`,
  );
}

const arbDrawnSession: fc.Arbitrary<DrawnSession> = fc.record({
  kind: fc.constantFrom(...SESSION_KINDS),
  completedRows: fc.integer({ min: 1, max: CONSENSUS_POOL_SIZE - 1 }),
  unfinishedCells: fc.integer({ min: 1, max: 4 }),
  passing: fc.nat({ max: FULL_MATRIX_SIZE }),
  trustedTestbenchCount: fc.nat({ max: CONSENSUS_POOL_SIZE }),
  unmetCondition: fc.constantFrom(...UNMET_CONDITIONS),
});

describe(PROPERTY, () => {
  it('states the measured Session count behind every figure and counts no incomplete Session', () => {
    const kindsDrawn = new Map<SessionKind, number>();
    const seen = {
      bothKindsPresent: 0,
      everySessionMeasured: 0,
      noSessionMeasured: 0,
      verifiedCountDiffered: 0,
      passingDiffered: 0,
      meanDiffered: 0,
      incompleteWouldHaveCounted: 0,
    };

    fc.assert(
      fc.property(
        fc.array(arbDrawnSession, { minLength: 1, maxLength: 5 }),
        (draws: readonly DrawnSession[]) => {
          const built = draws.map((drawn, index) => ({
            drawn,
            session: sessionReportOf(index, drawn),
          }));
          const sessions = built.map((entry) => entry.session);
          const report: WitnessDesignReport = { problemId: PROBLEM_ID, sessions };
          const incomplete = sessions.filter((session) => session.incompleteReason !== null);
          const measured = figuresOver(sessions.filter((s) => s.incompleteReason === null));
          const all = figuresOver(sessions);

          for (const drawn of draws) {
            kindsDrawn.set(drawn.kind, (kindsDrawn.get(drawn.kind) ?? 0) + 1);
          }
          if (incomplete.length > 0 && measured.sessionCount > 0) {
            seen.bothKindsPresent += 1;
          }
          if (incomplete.length === 0) {
            seen.everySessionMeasured += 1;
          }
          if (measured.sessionCount === 0) {
            seen.noSessionMeasured += 1;
          }
          if (all.verified !== measured.verified) {
            seen.verifiedCountDiffered += 1;
          }
          if (all.passing !== measured.passing) {
            seen.passingDiffered += 1;
          }
          if (all.mean !== measured.mean) {
            seen.meanDiffered += 1;
          }
          if (
            incomplete.some(
              (session) => session.passingCells > 0 || session.trustedTestbenchCount > 0,
            )
          ) {
            seen.incompleteWouldHaveCounted += 1;
          }

          const squareWave = renderWitnessDesignReport(report, true);
          const multiBit = renderWitnessDesignReport(report, false);
          for (const rendered of [squareWave, multiBit]) {
            expectEveryFigureStatesItsSessionCount(rendered, measured.sessionCount);
            expectVerifiedCountFigure(rendered, measured, all);
            for (const { drawn, session } of built) {
              expectIncompletenessReported(rendered, drawn, session);
            }
          }
          expectSquareWaveFigure(squareWave, measured, all);
          expectMultiBitFigure(multiBit, measured, all);
        },
      ),
      propertyParameters({ numRuns: 300 }),
    );

    for (const kind of SESSION_KINDS) {
      expect(kindsDrawn.get(kind) ?? 0).toBeGreaterThan(0);
    }
    expect(seen.bothKindsPresent).toBeGreaterThan(0);
    expect(seen.everySessionMeasured).toBeGreaterThan(0);
    expect(seen.noSessionMeasured).toBeGreaterThan(0);
    expect(seen.verifiedCountDiffered).toBeGreaterThan(0);
    expect(seen.passingDiffered).toBeGreaterThan(0);
    expect(seen.meanDiffered).toBeGreaterThan(0);
    expect(seen.incompleteWouldHaveCounted).toBeGreaterThan(0);
  });

  // Criterion 10.10's own example, pinned rather than sampled: the run count (3) and the measured
  // count (2) differ, and the one incomplete Session carries the largest trust and cell counts of
  // the three, so counting it would move every figure in the same direction.
  it('never prints a mean over 2 completed Sessions as a mean over 3', () => {
    const complete = (trusted: number, passing: number): DrawnSession => ({
      kind: 'complete-unverified',
      completedRows: CONSENSUS_POOL_SIZE - 1,
      unfinishedCells: 1,
      passing,
      trustedTestbenchCount: trusted,
      unmetCondition: 'strict-majority',
    });
    const draws: readonly DrawnSession[] = [
      complete(1, 10),
      complete(2, 12),
      { ...complete(7, 30), kind: 'unfinished-run', unfinishedCells: 2 },
    ];
    const sessions = draws.map((drawn, index) => sessionReportOf(index, drawn));
    const report: WitnessDesignReport = { problemId: PROBLEM_ID, sessions };

    const multiBit = renderWitnessDesignReport(report, false);
    expect(multiBit).toContain('mean Trusted_Testbench count: 1.50 over 2 measured Session(s)');
    expect(multiBit).toContain('Verified_Outcome count: 0 of 2 measured Session(s) (3 run)');
    expect(multiBit).toContain('session 2: NOT MEASURED (strict-majority) |');
    // 10 / 3 = 3.33, the mean over 3 Sessions criterion 10.10 forbids printing.
    expect(multiBit).not.toContain('3.33');

    const squareWave = renderWitnessDesignReport(report, true);
    expect(squareWave).toContain(
      `passing matrix cells over 2 measured Session(s): 22 of ${String(FULL_MATRIX_SIZE * 2)},`,
    );
    expect(squareWave).not.toContain(`52 of ${String(FULL_MATRIX_SIZE * 3)}`);
  });
});
