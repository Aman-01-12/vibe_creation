// Unit tests for the RTLLM banner parser: the independent judge's verdict reader.
//
// The banner strings here are the exact variants present at the pinned commit,
// including the `%d`-padded counts and the inconsistent inner spacing. Two properties
// matter most and are asserted directly:
//
//   1. Only FENCED lines are authoritative. Several golden testbenches print
//      unfenced `$display("Test failed: ...")` diagnostics on their way to passing;
//      reading one of those as a verdict would fail a correct design.
//   2. Passing requires positive evidence. No banner means `error`, never `pass` -
//      a candidate that fails to compile prints nothing at all.

import { describe, expect, it } from 'vitest';

import { extractGoldenBanners, parseGoldenVerdict } from './golden-banner.js';

/** The pass banner, in both spacing variants upstream uses. */
const PASS_TIGHT = '===========Your Design Passed===========';
const PASS_SPACED = '=========== Your Design Passed ===========';

describe('extractGoldenBanners', () => {
  it('extracts fenced banners in printed order, normalized', () => {
    const stdout = `some setup output\n${PASS_SPACED}\n`;
    expect(extractGoldenBanners(stdout)).toEqual(['your design passed']);
  });

  it('ignores unfenced diagnostics that merely mention failure', () => {
    // `comparator_4bit` prints this on every mismatching case before its banner.
    const stdout = 'Test failed: A = 0011, B = 0100, A_greater = 0\n';
    expect(extractGoldenBanners(stdout)).toEqual([]);
  });

  it('ignores a fenced line that carries no text', () => {
    expect(extractGoldenBanners('====================\n')).toEqual([]);
  });
});

describe('parseGoldenVerdict - passing', () => {
  it('reads the tight pass banner as passed with zero failures', () => {
    const verdict = parseGoldenVerdict(`${PASS_TIGHT}\n`);
    expect(verdict.kind).toBe('passed');
    expect(verdict.failureCount).toBe(0);
  });

  it('reads the spaced pass banner as passed', () => {
    expect(parseGoldenVerdict(`${PASS_SPACED}\n`).kind).toBe('passed');
  });

  it('still passes when unfenced per-case diagnostics precede the pass banner', () => {
    const stdout = `Test failed: a = 00, b = 01\n${PASS_TIGHT}\n`;
    expect(parseGoldenVerdict(stdout).kind).toBe('passed');
  });
});

describe('parseGoldenVerdict - failing', () => {
  it('reads the counted-failure banner and its count', () => {
    const verdict = parseGoldenVerdict(
      '===========Test completed with 3 /100 failures===========\n',
    );
    expect(verdict.kind).toBe('failed');
    expect(verdict.failureCount).toBe(3);
  });

  it('reads a %d-padded count, which pads with spaces', () => {
    // This is literally what `$display("... with %d failures ...", 20)` prints.
    const verdict = parseGoldenVerdict(
      '=========== Test completed with          20 failures ===========\n',
    );
    expect(verdict.kind).toBe('failed');
    expect(verdict.failureCount).toBe(20);
  });

  it('reads the slash-denominator and reworded count variants', () => {
    expect(
      parseGoldenVerdict('=========== Test completed with 3/8 failures ===========').failureCount,
    ).toBe(3);
    expect(
      parseGoldenVerdict('=========== Test completed with 5/16 NUM_DIV cases failing ===========')
        .failureCount,
    ).toBe(5);
  });

  it('reads the bare `Failed` banner as failed with no count', () => {
    const verdict = parseGoldenVerdict('===========Failed===========\n');
    expect(verdict.kind).toBe('failed');
    expect(verdict.failureCount).toBeNull();
  });

  it("reads RTLLM's `Error` banner as a DESIGN failure, not an infrastructure error", () => {
    // Upstream prints this on the else-branch of its own comparison: the design was
    // wrong. Mapping it to our `error` would hide a real functional failure.
    const verdict = parseGoldenVerdict('===========Error===========\n');
    expect(verdict.kind).toBe('failed');
  });

  it('refuses to pass a self-contradicting run that printed both banners', () => {
    const verdict = parseGoldenVerdict(`${PASS_TIGHT}\n===========Error===========\n`);
    expect(verdict.kind).toBe('failed');
  });
});

describe('parseGoldenVerdict - error (verified nothing)', () => {
  it('classifies empty stdout as error, never as a pass', () => {
    const verdict = parseGoldenVerdict('');
    expect(verdict.kind).toBe('error');
    expect(verdict.failureCount).toBeNull();
  });

  it('classifies a compile failure (diagnostics only, no banner) as error', () => {
    const stdout = '';
    expect(parseGoldenVerdict(stdout).kind).toBe('error');
  });

  it('classifies an unrecognized fenced banner as error rather than guessing a pass', () => {
    expect(parseGoldenVerdict('=========== Something New ===========\n').kind).toBe('error');
  });
});
