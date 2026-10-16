// The adoption gate (grounding-adoption-confirmatory, C8): the shipped Student_Path arm cannot
// disagree with the Campaign_Verdict recorded in the committed closeout note.
//
// The note is the input rather than the run directory, because `.eval-runs/` is gitignored and
// this gate must run in the fast tier on every commit from the closeout onward. While the note
// is absent, which is every commit before the closeout, the constant must be `control`: that
// is both the pre-run state and the permanent-refusal state.
//
// Validates: Requirements 11.1, 11.2.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { STUDENT_PATH_STRATEGY_ARM } from '@app/agent';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTE = resolve(
  HERE,
  '../../chipAgent/_inbox/decision-grounding-confirmatory-v1-campaign-verdict.md',
);

const VERDICTS = ['succeeded', 'failed', 'not-decided'] as const;
const REQUIRED_ARM_PREFIX = 'Required STUDENT_PATH_STRATEGY_ARM:';

/**
 * The arm a verdict requires, restated here rather than imported.
 *
 * An error shared with the implementation could not be caught by a test that asked the
 * implementation what the right answer was.
 */
function requiredArm(verdict: (typeof VERDICTS)[number]): string {
  return verdict === 'succeeded' ? 'grounded' : 'control';
}

/** The note's verdict and its stated required arm, or null when there is no note yet. */
function recordedDecision(): { readonly verdict: string; readonly arm: string } | null {
  let text: string;
  try {
    text = readFileSync(NOTE, 'utf8');
  } catch {
    return null;
  }
  const armLine = text.split('\n').find((line) => line.startsWith(REQUIRED_ARM_PREFIX));
  const verdictLine = text.split('\n').find((line) => line.includes('GROUNDING VERDICT:'));
  const verdict =
    verdictLine
      ?.slice(verdictLine.indexOf('GROUNDING VERDICT:') + 'GROUNDING VERDICT:'.length)
      .trim()
      .split(' ')[0] ?? '';
  return {
    verdict,
    arm: armLine?.slice(REQUIRED_ARM_PREFIX.length).trim() ?? '',
  };
}

describe('STUDENT_PATH_STRATEGY_ARM agrees with the recorded Campaign_Verdict', () => {
  it('is control while no closeout note exists, and the verdict it requires once one does', () => {
    const decision = recordedDecision();
    if (decision === null) {
      expect(STUDENT_PATH_STRATEGY_ARM).toBe('control');
      return;
    }
    // Untrusted file input: a verdict token outside the closed set is refused, never defaulted.
    expect(VERDICTS).toContain(decision.verdict);
    const expected = requiredArm(decision.verdict as (typeof VERDICTS)[number]);

    expect(decision.arm).toBe(expected);
    expect(STUDENT_PATH_STRATEGY_ARM).toBe(expected);
  });

  it('maps every verdict to exactly one arm, with adoption only on succeeded', () => {
    expect(VERDICTS.map(requiredArm)).toEqual(['grounded', 'control', 'control']);
  });
});
