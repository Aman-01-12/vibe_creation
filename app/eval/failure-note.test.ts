// Unit tests for the sample failure note.
//
// WHAT THESE PIN DOWN
//   1. Every terminal outcome variant maps to the note - or the silence - it should.
//   2. The note is bounded: a pathological detail is truncated to the cap rather than
//      persisted whole into an append-only results file.
//   3. Newlines and control characters collapse to single spaces, so one record's note
//      can never span two lines of a JSONL file or of an operator's terminal.
//   4. The `blocked` note carries the refusal DISCRIMINANT, never the refusal's message
//      field: the outcome crosses a port, so only closed-set values are echoed.

import { describe, expect, it } from 'vitest';

import type {
  GenerationGateRefusal,
  VerificationBlocked,
  VerificationOutcome,
  VerificationSetupFailed,
} from '@app/agent';

import { failureNoteOf, MAX_FAILURE_NOTE_LENGTH } from './failure-note.js';

/**
 * A setup-failed outcome; fully typed, so a change to the model breaks compilation.
 *
 * The `cause` is fixed rather than parameterized because the note is derived from `reason`
 * and `detail` ONLY - see `./no-verdict-cause.ts` for the typed channel the cause travels
 * on instead. If a future note ever varied by cause, these expectations would still pass
 * while the cause silently became load-bearing prose, so the direction is pinned in
 * `./no-verdict-cause.test.ts` where a cause is the subject rather than a fixture.
 */
function setupFailed(
  reason: VerificationSetupFailed['reason'],
  detail: string,
): VerificationSetupFailed {
  return { status: 'setup-failed', reason, detail, cause: 'provider-unreachable' };
}

/** A blocked outcome carrying the gate's typed refusal. */
function blocked(refusal: GenerationGateRefusal): VerificationBlocked {
  return { status: 'blocked', refusal };
}

/**
 * A verified or unverified outcome, shaped only as far as the derivation reads it.
 *
 * Those two variants also carry a label, a recorded result, and a simulation verdict;
 * building all of that would assert nothing, because the derivation reads only `status`
 * for them - which is itself the behavior under test.
 */
function judged(status: 'verified' | 'unverified'): VerificationOutcome {
  return { status } as unknown as VerificationOutcome;
}

describe('failureNoteOf - outcomes the oracle judged', () => {
  it('has nothing to explain for a verified sample', () => {
    expect(failureNoteOf(judged('verified'))).toBeNull();
  });

  it('has nothing to explain for an unverified sample, whose stopReason already says it', () => {
    // Given an outcome the oracle DID judge, the record's own `stopReason` and
    // `iterations` already carry the story, so a note would duplicate two fields.
    expect(failureNoteOf(judged('unverified'))).toBeNull();
  });
});

describe('failureNoteOf - setup-failed', () => {
  it("reports the reason and the loop's own sanitized detail", () => {
    const note = failureNoteOf(
      setupFailed('generation-unavailable', 'the model host declined every attempt'),
    );
    expect(note).toBe('generation-unavailable: the model host declined every attempt');
  });

  it('distinguishes an unavailable testbench from unavailable generation', () => {
    const note = failureNoteOf(
      setupFailed(
        'testbench-unavailable',
        'The independent testbench did not cover every acceptance criterion.',
      ),
    );
    expect(note).toBe(
      'testbench-unavailable: The independent testbench did not cover every acceptance criterion.',
    );
  });

  it('still names the reason when the detail is empty or only control characters', () => {
    expect(failureNoteOf(setupFailed('generation-unavailable', ''))).toBe(
      'generation-unavailable:',
    );
    expect(failureNoteOf(setupFailed('generation-unavailable', '\n\n'))).toBe(
      'generation-unavailable:',
    );
  });
});

describe('failureNoteOf - blocked', () => {
  it('reports the refusal discriminant for every gate refusal reason', () => {
    const message = 'Generation is blocked.';
    expect(failureNoteOf(blocked({ reason: 'intent-unconfirmed', message }))).toContain(
      'intent-unconfirmed',
    );
    expect(failureNoteOf(blocked({ reason: 'spec-unapproved', message }))).toContain(
      'spec-unapproved',
    );
    expect(failureNoteOf(blocked({ reason: 'persist-failed', message }))).toContain(
      'persist-failed',
    );
  });

  it('never echoes the refusal message, which crosses the loop-runner port', () => {
    const refusal: GenerationGateRefusal = {
      reason: 'spec-unapproved',
      message: 'see https://internal.example.com/runbook token=abc123',
    };

    const note = failureNoteOf(blocked(refusal));

    expect(note).not.toContain('internal.example.com');
    expect(note).not.toContain('abc123');
    expect(note).toBe(
      'spec-unapproved: the spec was never approved, so generation was inadmissible',
    );
  });

  it('degrades to the generic note when a foreign outcome carries no refusal at all', () => {
    // A loop-runner implementation that returns `blocked` with nothing attached must cost
    // a diagnostic string, never the campaign: this must not throw.
    const headless = { status: 'blocked' } as unknown as VerificationOutcome;

    expect(failureNoteOf(headless)).toBe('blocked: the generation gate refused admission');
  });

  it('classifies an unrecognized refusal reason rather than repeating it', () => {
    // The outcome crosses a port, so a JS caller can supply a reason this build does not
    // know. It must be classified, never written into a record verbatim.
    const foreign = {
      status: 'blocked',
      refusal: { reason: 'wat-just-happened', message: 'anything at all' },
    } as unknown as VerificationOutcome;

    const note = failureNoteOf(foreign);

    expect(note).toBe('blocked: the generation gate refused admission');
    expect(note).not.toContain('wat-just-happened');
  });
});

describe('failureNoteOf - bounded and single-line', () => {
  it('truncates a pathological detail to the cap', () => {
    const note = failureNoteOf(setupFailed('generation-unavailable', 'x'.repeat(5_000)));

    expect(note?.length).toBe(MAX_FAILURE_NOTE_LENGTH);
    expect(note?.startsWith('generation-unavailable: xxx')).toBe(true);
  });

  it('keeps a note of exactly the cap length intact', () => {
    const prefix = 'generation-unavailable: ';
    const detail = 'y'.repeat(MAX_FAILURE_NOTE_LENGTH - prefix.length);

    const note = failureNoteOf(setupFailed('generation-unavailable', detail));

    expect(note).toBe(`${prefix}${detail}`);
    expect(note?.length).toBe(MAX_FAILURE_NOTE_LENGTH);
  });

  it('collapses newlines and control characters to single spaces', () => {
    const note = failureNoteOf(
      setupFailed('testbench-unavailable', 'first line\r\n\tsecond\u0000\u0007third'),
    );

    expect(note).toBe('testbench-unavailable: first line second third');
    expect(note).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it('collapses zero-width and bidi format characters that would reorder the line', () => {
    expect(failureNoteOf(setupFailed('generation-unavailable', 'a\u200bb\u202ec'))).toBe(
      'generation-unavailable: a b c',
    );
  });
});
