// formal-gate-first-light, Component 20: the classification rule, pinned as a pure function.
//
// The three censuses task 4.25 names: one with an `$sdffce` cell, one with an `$sdffe` cell, and
// one refused. These are the three shapes the measurement can produce, and the rule between them
// decides whether we report a defect in the parent spec's reset derivation or a stale comment -
// so it is pinned here rather than inferred from a run that needs the whole toolchain.
//
// Validates: Requirements 4.9, 4.10, 4.11

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readResetClaims, RESET_CLAIM_COMMENTS } from './formal-reset-derivation-comments.js';
import {
  classifyResetDerivation,
  ENABLE_GATED_RESET_CELL,
  isEnableGatedReset,
  requiresFixDirectionQuestion,
  type ResetCellEntry,
  type ResetDerivationCensus,
} from './formal-reset-derivation-classify.js';

/** The enable-gated reset Stage A measured: `$sdffce` with a real, driven enable. */
const SDFFCE: ResetCellEntry = {
  cellType: ENABLE_GATED_RESET_CELL,
  resetNet: 'Rst',
  resetPolarity: 1,
  enableNet: 'EN',
  enablePolarity: 1,
  enableIsConstant: false,
};

/** An ordinary enabled flop whose reset is NOT enable-gated. */
const SDFFE: ResetCellEntry = {
  cellType: '$sdffe',
  resetNet: 'Rst',
  resetPolarity: 1,
  enableNet: 'EN',
  enablePolarity: 1,
  enableIsConstant: false,
};

function census(overrides: Partial<ResetDerivationCensus>): ResetDerivationCensus {
  return { resetDerived: true, resetCells: [], ...overrides };
}

describe('the Reset_Derivation classification (Req 4.9, 4.10, 4.11)', () => {
  it('reports a candidate breach of 14.19 for a derived contract over an $sdffce reset', () => {
    // The predicted finding: a contract derived from a reset that fires only while an enable is
    // asserted, which the parent's criterion 14.19 says is refused.
    const found = census({ resetCells: [SDFFCE] });

    expect(classifyResetDerivation(found)).toBe('candidate-breach-14-19');
    // And it is the one class that must not be acted on without a decision first.
    expect(requiresFixDirectionQuestion('candidate-breach-14-19')).toBe(true);
  });

  it('reports stale source text for a derived contract with no enable-gated reset cell', () => {
    // The comments calling this design's reset refused would then describe behaviour the
    // netlist does not have, which is a documentation defect rather than a derivation one.
    expect(classifyResetDerivation(census({ resetCells: [SDFFE] }))).toBe('stale-source-text');
    expect(classifyResetDerivation(census({ resetCells: [] }))).toBe('stale-source-text');
    expect(requiresFixDirectionQuestion('stale-source-text')).toBe(false);
  });

  it('reports a contradiction when nothing was derived, rather than forcing a class', () => {
    // A refusal contradicts Stage A and task 4.2, so it belongs to Requirement 11. Calling it
    // stale text would be the dangerous collapse: someone would then "correct" the comments to
    // match a derivation that had just disappeared.
    const refused = census({ resetDerived: false, resetCells: [SDFFCE] });

    expect(classifyResetDerivation(refused)).toBe('refusal-contradiction');
    // Asked FIRST, so a census full of enable-gated cells cannot override it.
    expect(classifyResetDerivation(census({ resetDerived: false }))).toBe('refusal-contradiction');
    expect(requiresFixDirectionQuestion('refusal-contradiction')).toBe(false);
  });

  it('does not count a constant enable as an enable, because such a reset fires every cycle', () => {
    // `$sdffce` with `EN` tied to a constant is an ordinary synchronous reset wearing an
    // enable's cell type, so it is not what 14.19 is about.
    const constantEnable: ResetCellEntry = { ...SDFFCE, enableIsConstant: true };

    expect(isEnableGatedReset(constantEnable)).toBe(false);
    expect(classifyResetDerivation(census({ resetCells: [constantEnable] }))).toBe(
      'stale-source-text',
    );
    // And a cell with no enable at all is likewise not enable-gated.
    expect(isEnableGatedReset({ ...SDFFCE, enableNet: null, enablePolarity: null })).toBe(false);
  });

  it('finds the breach when the enable-gated cell is one among many', () => {
    // The census is a whole netlist, so the deciding cell is rarely alone. One qualifying entry
    // is enough, because one enable-gated reset is one reset 14.19 says is refused.
    const mixed = census({ resetCells: [SDFFE, { ...SDFFE }, SDFFCE, { ...SDFFE }] });

    expect(classifyResetDerivation(mixed)).toBe('candidate-breach-14-19');
    expect(mixed.resetCells.filter(isEnableGatedReset)).toEqual([SDFFCE]);
  });
});

describe('the nine source comments criterion 4.11 names', () => {
  /** The repository root, from this module's own location in either layout. */
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  /** One file's text, or `null` where it cannot be read. */
  function readText(path: string): string | null {
    try {
      return readFileSync(resolve(ROOT, path), 'utf8');
    } catch {
      return null;
    }
  }

  it('finds every claim gone and every correction present, so no pin can read as stale', () => {
    // THE GUARD THAT KEEPS THE MEASUREMENT HONEST, now that task 4.30 corrected all nine. A
    // claim's absence alone would also be what a WRONG substring looks like, so each entry
    // pins the replacement text too: the claim must be gone AND the correction found.
    const readings = readResetClaims(readText);
    const stillClaiming = readings
      .filter((reading) => reading.present)
      .map((reading) => `${reading.path}: ${reading.site}`);
    const notCorrected = readings
      .filter((reading) => !reading.corrected)
      .map((reading) => `${reading.path}: ${reading.site}`);

    expect(stillClaiming).toEqual([]);
    expect(notCorrected).toEqual([]);
  });

  it('splits into five naming LIFObuffer and four naming the class', () => {
    // The split is load bearing: correcting them is two different edits, one restating a
    // design's behaviour and one restating a rule.
    const named = RESET_CLAIM_COMMENTS.filter((comment) => comment.namesLifoBuffer);

    expect(named).toHaveLength(5);
    expect(RESET_CLAIM_COMMENTS).toHaveLength(9);
  });

  it('reports an unreadable file as still claiming rather than silently cleared', () => {
    // Fail-safe on BOTH fields: a file this driver could not open has not been shown to be
    // corrected, so the claim reads as standing and the correction as not found.
    const readings = readResetClaims(() => null);

    expect(readings.every((reading) => reading.present)).toBe(true);
    expect(readings.every((reading) => !reading.corrected)).toBe(true);
    expect(readings).toHaveLength(RESET_CLAIM_COMMENTS.length);
  });

  it('reports a claim as gone but NOT corrected where the replacement text is absent too', () => {
    // The shape a wrong pin would produce, and the reason `corrected` exists: a file holding
    // neither the claim nor its correction is not evidence that anyone fixed anything.
    const readings = readResetClaims(() => 'nothing here claims anything about a reset');

    expect(readings.every((reading) => !reading.present)).toBe(true);
    expect(readings.every((reading) => !reading.corrected)).toBe(true);
  });
});
