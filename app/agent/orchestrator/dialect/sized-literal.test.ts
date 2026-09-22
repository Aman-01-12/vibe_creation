// testbench-dialect-normalization, group 16: the three defects Property 8 surfaced in the
// sized-literal rule - a decline that produced no finding, a `#` guard whose comment described a
// different rule than the code, and a signed-base marker the rewrite dropped.
//
// WHY THESE ARE KNOWN-ANSWER CASES AND NOT A PROPERTY
//   Every expected byte below is a shape `iverilog -g2012` (Icarus 13.0) was measured to accept or
//   reject, one file per row, compiled alone and - where meaning rather than syntax was the
//   question - RUN under `vvp` so equivalence is measured instead of argued. The general claims
//   these sit under are the existing Property 7 (a determinable literal is rewritten preserving its
//   runs) and Property 8 (a rewrite the transform cannot establish is declined AND REPORTED).
//
// THE MEASUREMENTS, so a future reader does not have to re-run them to know why these bytes
//   | source                    | context       | verdict                                   |
//   | ------------------------- | ------------- | ----------------------------------------- |
//   | `#8'd-1 acc = 1;`         | delay         | REJECTED (`Syntax in assignment l-value`) |
//   | `#(-8'd1) acc = 1;`       | delay         | compiles; DELAYS (t 0 -> 255), not an override |
//   | `#(8'd-1) acc = 1;`       | delay         | REJECTED                                  |
//   | `dut #(8'd-1) u0();`      | override      | REJECTED (`parameter value assignment list`) |
//   | `dut #((-8'd1)) u0();`    | override      | compiles; P = -1, EQUAL to `dut #(-8'd1) u0();`'s P = -1 |
//   | `dut #8'd1 u0();`         | instantiation | REJECTED - no legal bare `#<sized literal>` instantiation form |
//   | `and #8'd1 g0(y,a,b);`    | gate delay    | REJECTED - nor a legal bare gate delay    |
//   | `16'sd-1`                 | expression    | REJECTED                                  |
//   | `(-16'sd1) < 0`           | expression    | compiles; 1, and `$signed` prints -1      |
//   | `(-16'd1) < 0`            | expression    | compiles; 0, and prints 65535             |
//
// WHAT THE `#` GUARD IS, AFTER THAT MEASUREMENT
//   Its comment claimed the parenthesized rewrite would be ambiguous with a parameter override.
//   The measurement does not support that: `#(...)` in a statement position is read as a delay
//   control, and there is no legal bare `#<sized literal>` in ANY position, so the declined input
//   never compiles today and no working meaning can be flipped. The guard's BEHAVIOUR is retained
//   here unchanged, because removing it changes the set of rewrites on a different axis than this
//   group's remit and the safe-side case is measured but the decision is not made; what changed is
//   that the decline is now REPORTED, and reported under a cause that does not claim the value was
//   undeterminable when it plainly was.
//
// EVERY ASSERTION HERE FAILED BEFORE THE FIX, and that is the point of the file.
//
// Validates: Requirements 4.10, 4.11, 5.6, 5.7, 5.12

import { scanSource } from '@app/tools';
import { describe, expect, it } from 'vitest';

import { normalizeDialect } from './normalizer.js';
import { planSizedLiteralRewrites } from './sized-literal.js';
import type { DialectFinding, SpanEdit } from './types.js';

/** Apply planned edits right to left, so no edit shifts another's offsets. */
function applyEdits(source: string, edits: readonly SpanEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

/** The rule's own plan for `source`, without the surrounding normalizer. */
function plan(source: string): readonly SpanEdit[] {
  return planSizedLiteralRewrites({ source, mask: scanSource(source) });
}

/** Every `malformed-sized-literal` finding the whole transform reported for `source`. */
function literalFindings(source: string): readonly DialectFinding[] {
  return normalizeDialect(source).report.findings.filter(
    (finding) => finding.dialectClass === 'malformed-sized-literal',
  );
}

/** A named block holding one statement, so no unnamed-begin finding rides along. */
function wrapStatement(statement: string): string {
  return `module tb;
  integer acc;
  initial begin : body
    ${statement}
  end
endmodule
`;
}

// -- Finding 1: the silent decline ------------------------------------------------------------

describe('a `#`-preceded literal is declined AND REPORTED, never silently (Req 5.12)', () => {
  const SOURCE = wrapStatement("#8'd-1 acc = 0;");

  it('plans a zero-width edit carrying the decline, rather than returning nothing at all', () => {
    // `null` is reserved for "this is not a site". A site the rule RECOGNISED and chose not to
    // rewrite must ride a zero-width `SpanEdit`, because a finding is only ever produced by one -
    // and the per-class decline counts Requirements 1 through 3 make trustworthy are aggregated
    // from findings, so a silent decline is an undercount.
    const edits = plan(SOURCE);

    expect(edits).toHaveLength(1);
    expect(edits[0]?.start).toBe(edits[0]?.end);
    expect(edits[0]?.finding.action).toBe('declined');
    expect(applyEdits(SOURCE, edits)).toBe(SOURCE);
  });

  it('reports the decline under a cause naming the CONTEXT, not an undeterminable value', () => {
    // The value IS determinable here - it is `-1`, in the plainest possible text. Filing this
    // under `value-not-determinable` would make the report say something false about why.
    const findings = literalFindings(SOURCE);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.action).toBe('declined');
    expect(findings[0]?.declinedBecause).toBe('rewrite-context-not-established');
  });

  it('leaves the source byte-identical while still reporting, which is Property 8 exactly', () => {
    const { source: output, report } = normalizeDialect(SOURCE);

    expect(output).toBe(SOURCE);
    expect(report.changed).toBe(false);
    expect(report.refusedWholeSource).toBeNull();
    expect(report.findings.filter((finding) => finding.action === 'rewritten')).toEqual([]);
  });
});

// -- Finding 2: the guard's two sides, pinned as the measurement found them --------------------

describe('the `#` guard fires on a rewrite that would CREATE `#(`, not on `#(` already present', () => {
  it('declines where the rewrite would create `#(`', () => {
    // `#8'd-1` is rejected by `-g2012` today, and so is `#(8'd-1)`; `#(-8'd1)` compiles and means a
    // DELAY of 255. The decline is retained on the conservative side of a measured-but-undecided
    // question, and is now reported rather than silent.
    const findings = literalFindings(wrapStatement("#8'd-1 acc = 0;"));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.action).toBe('declined');
  });

  it('rewrites where `#(` ALREADY exists, repairing a parameter override the toolchain rejects', () => {
    // Measured: `dut #(8'd-1) u0();` is rejected; `dut #((-8'd1)) u0();` compiles and the parameter
    // receives -1, the same value `dut #(-8'd1) u0();` delivers. The extra paren nests inside the
    // override that was already there rather than creating one.
    const source = `module tb;
  dut #(8'd-1) u0();
endmodule
`;
    const findings = literalFindings(source);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.action).toBe('rewritten');
    expect(normalizeDialect(source).source).toBe(`module tb;
  dut #((-8'd1)) u0();
endmodule
`);
  });
});

// -- Finding 3: the dropped signed marker -----------------------------------------------------

describe('the signed-base marker SURVIVES the rewrite (Req 5.6)', () => {
  it('re-emits the `s` so a signed literal stays signed', () => {
    // Dropping it is a genuine meaning change, not a cosmetic one: measured under `vvp`,
    // `(-16'sd1) < 0` is 1 and `(-16'd1) < 0` is 0, so a dropped marker flips a check's verdict.
    const source = wrapStatement("acc = 16'sd-1;");

    expect(normalizeDialect(source).source).toContain("(-16'sd1)");
    expect(normalizeDialect(source).source).not.toContain("(-16'd1)");
  });

  it('re-emits the marker VERBATIM, in the case the input wrote it', () => {
    // All four case combinations of `[sS][dD]` were measured legal and measured signed, so copying
    // the captured run is safe and is the only spelling that preserves the input's character runs.
    expect(normalizeDialect(wrapStatement("acc = 16'Sd-1;")).source).toContain("(-16'Sd1)");
    expect(normalizeDialect(wrapStatement("acc = 16'sD-1;")).source).toContain("(-16'sD1)");
    expect(normalizeDialect(wrapStatement("acc = 16'SD-1;")).source).toContain("(-16'SD1)");
  });

  it('preserves the marker in the parenthesized input form too', () => {
    expect(normalizeDialect(wrapStatement("acc = 16'sd(-15);")).source).toContain("(-16'sd15)");
  });

  it('leaves an unsigned literal unsigned, so the marker is copied rather than invented', () => {
    expect(normalizeDialect(wrapStatement("acc = 16'd-1;")).source).toContain("(-16'd1)");
    expect(normalizeDialect(wrapStatement("acc = 16'd-1;")).source).not.toContain("'sd");
  });
});
