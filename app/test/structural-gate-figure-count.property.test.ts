// structural-gate-toolchain, Property 11: The excluded count sits beside every rendered
// figure (task 7.4, C11).
//
// GENERALIZES the example test already in `app/eval/consensus-regression/cli.test.ts`
// ("every rendered figure line carries the Structural_Gate exclusion count"), which pins
// this against the single `DEFAULT_SYNTHETIC_MEASUREMENT`. This property drives the SAME
// exported `runConsensusRegressionCli` entry point over randomly varied
// `ConsensusRegressionMeasuredFigures` - every `MeasuredShare.value`/`sampleCount`
// (including a `null` sample count), and `peerCalibratedMutationGateAgreement` toggled
// between `null` and a real `MeasuredShare` - rather than against one fixed measurement.
//
// `renderShare` itself is private to `cli.ts` (not exported, confirmed by its own module and
// by `app/eval/consensus-regression/index.ts`'s re-export list), so this drives it indirectly
// through `runConsensusRegressionCli`'s `result.lines`, exactly as the existing example test
// does.
//
// A `%` character appears ONLY on a line `renderShare` produced - a failure line reports a
// raw value, never a percentage - so filtering `result.lines` on `%` isolates exactly the
// lines this property is about, per the existing example test's own documented reasoning.
//
// The expected count is read from `STRUCTURAL_GATE_EXCLUSIONS.length` rather than hardcoded,
// so this property keeps holding if the reviewed exclusion list ever grows past two entries.
//
// Validates: Requirements 12.8

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CONSENSUS_REGRESSION_DIVERSITY_RECORD,
  PILOT_DESIGN_SET,
  runConsensusRegressionCli,
  STRUCTURAL_GATE_EXCLUSIONS,
  type ConsensusRegressionMeasuredFigures,
  type ConsensusRegressionRunDirPort,
  type MeasuredShare,
  type PilotDesign,
} from '@app/eval';

import { propertyParameters } from './property.js';

const PROPERTY =
  'structural-gate-toolchain, Property 11: The excluded count sits beside every rendered figure';

/** An in-memory `ConsensusRegressionRunDirPort`, so no draw ever touches the real filesystem. */
function inMemoryFs(): ConsensusRegressionRunDirPort {
  const existing = new Set<string>();
  const written = new Map<string, string>();
  return {
    exists: (path: string): Promise<boolean> => Promise.resolve(existing.has(path)),
    mkdir: (path: string): Promise<void> => {
      existing.add(path);
      return Promise.resolve();
    },
    writeFile: (path: string, contents: string): Promise<void> => {
      written.set(path, contents);
      return Promise.resolve();
    },
  };
}

/** One `MeasuredShare`, with a value drawn from across the real range and some noise either side. */
function arbMeasuredShare(): fc.Arbitrary<MeasuredShare> {
  return fc.record({
    value: fc.float({ min: -1, max: 2, noNaN: true }),
    sampleCount: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 1_000_000 })),
  });
}

/** A full `ConsensusRegressionMeasuredFigures`, every share and the nullable peer figure varied. */
function arbMeasuredFigures(): fc.Arbitrary<ConsensusRegressionMeasuredFigures> {
  const pilotShares = fc.record(
    PILOT_DESIGN_SET.reduce<Record<PilotDesign, fc.Arbitrary<MeasuredShare>>>(
      (acc, design) => ({ ...acc, [design]: arbMeasuredShare() }),
      {} as Record<PilotDesign, fc.Arbitrary<MeasuredShare>>,
    ),
  );

  return fc
    .record({
      wrongLabelShare: arbMeasuredShare(),
      verifiedCorrectShare: arbMeasuredShare(),
      pilotPassShare: pilotShares,
      attributionAccuracyTestbench: arbMeasuredShare(),
      attributionAccuracyRtl: arbMeasuredShare(),
      misattributionShare: arbMeasuredShare(),
      deliveredLabelCorrectShare: arbMeasuredShare(),
      firstAttemptVerifiedCorrectShare: arbMeasuredShare(),
      withinThreeAttemptsVerifiedCorrectShare: arbMeasuredShare(),
      peerCalibratedMutationGateAgreement: fc.oneof(fc.constant(null), arbMeasuredShare()),
    })
    .map((figures) => ({ ...figures, diversity: CONSENSUS_REGRESSION_DIVERSITY_RECORD }));
}

describe(PROPERTY, () => {
  it('every line carrying a % also carries the exact current exclusion count', async () => {
    await fc.assert(
      fc.asyncProperty(arbMeasuredFigures(), async (measured) => {
        const result = await runConsensusRegressionCli(
          { kind: 'run', runName: 'property-run', recordPath: null },
          {
            evalRunsRoot: '/evalruns',
            fs: inMemoryFs(),
            provider: { measure: () => Promise.resolve(measured) },
            now: () => new Date('2024-01-01T00:00:00.000Z'),
          },
        );

        const figureLines = result.lines.filter((line) => line.includes('%'));
        expect(figureLines.length).toBeGreaterThan(0);
        for (const line of figureLines) {
          expect(line).toContain(
            `excluded by the Structural_Gate: ${STRUCTURAL_GATE_EXCLUSIONS.length}`,
          );
        }
      }),
      propertyParameters(),
    );
  });
});
