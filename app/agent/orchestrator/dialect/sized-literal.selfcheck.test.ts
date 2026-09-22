// Minimal runnable check for `sized-literal.ts`'s rewrite/decline rules against the four cases
// named in the task and in design.md's calibration table.
//
// This is a throwaway self-check, not the property-test suite: tasks 4.6/4.7 (determinism,
// fixed point) and a future `normalizer.test.ts` are the real coverage once task 4.5 lands.
// Delete this file once that coverage subsumes it.

import { describe, expect, it } from 'vitest';
import { scanSource } from '@app/tools';
import { planSizedLiteralRewrites, type SpanEdit } from './sized-literal.js';

function applyEdits(source: string, edits: readonly SpanEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

describe('planSizedLiteralRewrites', () => {
  it('rewrites a parenthesized negative magnitude to the parenthesized-sign form', () => {
    const source = "wire [15:0] w = 16'd(-15);";
    const edits = planSizedLiteralRewrites({ source, mask: scanSource(source) });
    expect(applyEdits(source, edits)).toBe("wire [15:0] w = (-16'd15);");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.finding.action).toBe('rewritten');
  });

  it('rewrites a bare negative magnitude to the parenthesized-sign form', () => {
    const source = "wire [7:0] w = 8'd-1;";
    const edits = planSizedLiteralRewrites({ source, mask: scanSource(source) });
    expect(applyEdits(source, edits)).toBe("wire [7:0] w = (-8'd1);");
  });

  it('parenthesizes so a trailing ** cannot rebind across the sign', () => {
    const source = "x = 8'd-1 ** 2;";
    const edits = planSizedLiteralRewrites({ source, mask: scanSource(source) });
    expect(applyEdits(source, edits)).toBe("x = (-8'd1) ** 2;");
  });

  it("declines 9'di with value-not-determinable, since i is not a digit in any base", () => {
    const source = "wire [8:0] w = 9'di;";
    const edits = planSizedLiteralRewrites({ source, mask: scanSource(source) });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.finding.action).toBe('declined');
    expect(edits[0]?.finding.declinedBecause).toBe('value-not-determinable');
    expect(applyEdits(source, edits)).toBe(source);
  });

  it('does not decline x/z digit values, which are legal', () => {
    const source = "wire [8:0] w = 9'dx;";
    const edits = planSizedLiteralRewrites({ source, mask: scanSource(source) });
    expect(edits).toHaveLength(0);
  });

  it('detects and reports the missing-replication-brace shape without rewriting it', () => {
    const source = "assign y = {1'b0, 64{1'b1}};";
    const edits = planSizedLiteralRewrites({ source, mask: scanSource(source) });
    const declines = edits.filter(
      (edit) => edit.finding.declinedBecause === 'value-not-determinable',
    );
    expect(declines.length).toBeGreaterThanOrEqual(1);
    expect(applyEdits(source, edits)).toBe(source);
  });

  it('does not flag a genuine replication count', () => {
    const source = "assign y = {64{1'b1}};";
    const edits = planSizedLiteralRewrites({ source, mask: scanSource(source) });
    expect(edits).toHaveLength(0);
  });

  it('declines rather than rewrites when the literal is immediately preceded by #', () => {
    // A rewrite here would CREATE a `#(` the input did not have, so the rule stands down - and
    // REPORTS the decline through a zero-width edit, because a decline that returns nothing is
    // invisible to the report. `sized-literal.test.ts` owns the measured detail.
    const source = "#8'd-1 foo();";
    const edits = planSizedLiteralRewrites({ source, mask: scanSource(source) });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.finding.action).toBe('declined');
    expect(edits[0]?.finding.declinedBecause).toBe('rewrite-context-not-established');
    expect(applyEdits(source, edits)).toBe(source);
  });

  it('never treats a literal-shaped string inside $display as a site', () => {
    const source = '$display("got 8\'d-1");';
    const edits = planSizedLiteralRewrites({ source, mask: scanSource(source) });
    expect(edits).toHaveLength(0);
  });
});
