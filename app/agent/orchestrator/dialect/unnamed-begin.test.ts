// testbench-dialect-normalization, group 15: the declaration MOVE, and the four defects that
// had to be fixed for the move to be correct.
//
// WHY THESE ARE KNOWN-ANSWER CASES AND NOT A PROPERTY
//   Every expected output below is the shape `iverilog -g2012` was measured to accept, one file
//   per row, in design.md's Overview subsection "The label was never the discriminator -
//   position is, and the move is the fix". The general statement - a relocated declaration stays
//   in its own block, ahead of that block's first statement, in its original relative order - is
//   the separate Property 27 (task 15.6).
//
// WHY THE ASSERTIONS ARE BYTE-LEVEL AND TOOLCHAIN-FREE
//   The parse fact these encode is already measured and pinned against the real toolchain by
//   `app/test/dialect-fixtures.integration.test.ts` over 29 real fixtures. What is NOT covered
//   there is the exact text the transform emits, and that is what a move can get wrong in ways
//   a fixture count cannot see: the declaration landing in the OUTER block, two declarations
//   swapping order, a `for` header losing its loop variable, or a block that needed nothing
//   being rewritten anyway. So these assert bytes, and they run on every machine.
//
// EVERY ASSERTION HERE FAILED BEFORE THE FIX. That is deliberate: this file is the fail-before
// half of group 15, the same discipline task 13.1 applied to the comment-as-whitespace defects.
//
// Validates: Requirements 4.9, 4.12, 4.15, 5.3, 5.4, 5.7, 5.13, 5.14

import { scanSource } from '@app/tools';
import { describe, expect, it } from 'vitest';

import { normalizeDialect } from './normalizer.js';
import { declaredNamesAfter } from './unnamed-begin.js';
import type { DialectFinding } from './types.js';

/** The names one `<keyword> ...;` declaration declares, read the way the production rule reads it. */
function namesDeclaredBy(declaration: string, keyword: string): readonly string[] {
  const source = `module tb;\n  initial begin\n    ${declaration}\n  end\nendmodule\n`;
  const mask = scanSource(source);
  const keywordEnd = source.indexOf(declaration) + keyword.length;
  return declaredNamesAfter(source, mask, keywordEnd);
}

/** Every `unnamed-begin-declaration` finding the transform reported for `source`. */
function beginFindings(source: string): readonly DialectFinding[] {
  return normalizeDialect(source).report.findings.filter(
    (finding) => finding.dialectClass === 'unnamed-begin-declaration',
  );
}

// -- 15.1 The parameterized-range bug ----------------------------------------
//
// A range BOUND is identifier-shaped, so the regex does NOT skip it, contradicting the doc
// comment the same change corrects. The consequence is a FALSE `would-shadow-module-scope`
// decline whenever the bound names a module-scope parameter - which is the normal way to write
// a parameterized testbench.

describe('declaredNamesAfter reads the declared NAME, never a parameterized range bound (Req 4.15)', () => {
  it('reads a literal range', () => {
    expect(namesDeclaredBy('reg [7:0] a;', 'reg')).toEqual(['a']);
  });

  it('reads a parameterized range bound as part of the RANGE, not as the declared name', () => {
    expect(namesDeclaredBy('reg [WIDTH-1:0] a;', 'reg')).toEqual(['a']);
  });

  it('reads both names of a comma list whose range is parameterized', () => {
    expect(namesDeclaredBy('reg [ADDR_WIDTH:0] a, b;', 'reg')).toEqual(['a', 'b']);
  });

  it('reads the declared name and not the initializer, with a parameterized range', () => {
    expect(namesDeclaredBy('reg [WIDTH-1:0] a = b;', 'reg')).toEqual(['a']);
  });

  it('does not falsely decline a block whose range bound is a module-scope parameter (Req 5.4)', () => {
    const source = `module tb;
  parameter WIDTH = 8;
  initial begin
    $display("start");
    reg [WIDTH-1:0] saved_last_data;
    saved_last_data = 0;
  end
endmodule
`;

    // A rewritten block reports one finding for itself plus one per relocated declaration, so
    // the assertion is on the ABSENCE of a decline rather than on a count.
    const findings = beginFindings(source);
    expect(findings).not.toHaveLength(0);
    expect(findings.filter((finding) => finding.action === 'declined')).toEqual([]);
    expect(normalizeDialect(source).source).toContain(
      'reg [WIDTH-1:0] saved_last_data;\n    $display',
    );
  });
});

// -- 15.2 The paren-depth exclusion ------------------------------------------

describe('a declaration inside a `for` HEADER is not a block item (Req 5.13)', () => {
  const FOR_HEADER_ONLY = `module tb;
  integer total;
  initial begin
    total = 0;
    for (integer i = 0; i < 3; i = i + 1) total = total + i;
  end
endmodule
`;

  it('is not a site at all: no finding, and the source comes back byte-identical', () => {
    const { source, report } = normalizeDialect(FOR_HEADER_ONLY);

    expect(beginFindings(FOR_HEADER_ONLY)).toEqual([]);
    expect(source).toBe(FOR_HEADER_ONLY);
    expect(report.changed).toBe(false);
  });

  it('survives the move of a real block-item declaration in the same block', () => {
    // The destructive shape this guards: lifting the `integer` out of the header produced
    // `for ( i < 86400; i = i + 1)`, which dropped measured effectiveness from 25 to 20.
    const source = `module tb;
  initial begin
    $display("go");
    integer sum;
    for (integer i = 0; i < 3; i = i + 1) sum = sum + i;
  end
endmodule
`;

    expect(normalizeDialect(source).source).toBe(`module tb;
  initial begin : tbnorm_blk_1
    integer sum;
    $display("go");
    for (integer i = 0; i < 3; i = i + 1) sum = sum + i;
  end
endmodule
`);
  });
});

// -- 15.3 "Is a statement before this declaration" over code CHARACTERS -------

describe('a statement carrying no word token still counts as a statement (Req 5.13)', () => {
  it('moves a declaration preceded only by `#10;`', () => {
    // `#10;` holds no `[A-Za-z_$][A-Za-z0-9_$]*` token at all, so a token-stream reading judged
    // this declaration "already first" and left it alone.
    const source = `module tb;
  initial begin
    #10;
    integer i;
    i = 0;
  end
endmodule
`;

    expect(normalizeDialect(source).source).toBe(`module tb;
  initial begin : tbnorm_blk_1
    integer i;
    #10;
    i = 0;
  end
endmodule
`);
  });
});

// -- 15.4 A `genvar` is not relocatable --------------------------------------

describe('a block carrying a `genvar` is DECLINED, because no position helps it (Req 5.7)', () => {
  it('reports declaration-not-relocatable and changes nothing', () => {
    const source = `module tb;
  initial begin
    $display("x");
    genvar g;
  end
endmodule
`;

    const findings = beginFindings(source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.action).toBe('declined');
    expect(findings[0]?.declinedBecause).toBe('declaration-not-relocatable');
    expect(normalizeDialect(source).source).toBe(source);
  });
});

// -- 15.5 The move itself ----------------------------------------------------

describe('the declaration move (Req 5.13, 5.14)', () => {
  it('moves EVERY declaration of a block to its top, in original relative order', () => {
    const source = `module tb;
  initial begin
    $display("start");
    integer i;
    reg [7:0] data;
    i = 0;
  end
endmodule
`;

    expect(normalizeDialect(source).source).toBe(`module tb;
  initial begin : tbnorm_blk_1
    integer i;
    reg [7:0] data;
    $display("start");
    i = 0;
  end
endmodule
`);
  });

  it('moves a NESTED declaration to the top of its OWN block, never the outer one', () => {
    const source = `module tb;
  initial begin
    $display("outer");
    begin
      #10;
      integer inner;
      inner = 1;
    end
  end
endmodule
`;

    expect(normalizeDialect(source).source).toBe(`module tb;
  initial begin
    $display("outer");
    begin : tbnorm_blk_1
      integer inner;
      #10;
      inner = 1;
    end
  end
endmodule
`);
  });

  it('leaves a block whose declarations are ALREADY first byte-identical', () => {
    // Zero changed lines. The label buys nothing from the deterministic oracle (a declaration
    // first in its block is accepted named or unnamed), so a block that needs no move is not a
    // site and is not touched at all.
    const source = `module tb;
  initial begin
    integer i;
    i = 0;
  end
endmodule
`;

    const { source: normalized, report } = normalizeDialect(source);

    expect(normalized).toBe(source);
    expect(report.changed).toBe(false);
    expect(beginFindings(source)).toEqual([]);
  });

  it('carries a same-line trailing comment with its declaration', () => {
    const source = `module tb;
  initial begin
    $display("start");
    integer i; // the loop counter
    i = 0;
  end
endmodule
`;

    expect(normalizeDialect(source).source).toBe(`module tb;
  initial begin : tbnorm_blk_1
    integer i; // the loop counter
    $display("start");
    i = 0;
  end
endmodule
`);
  });

  it('keeps the output a fixed point: a second pass changes nothing (Req 4.8)', () => {
    const source = `module tb;
  initial begin
    $display("start");
    integer i;
    i = 0;
  end
endmodule
`;

    const once = normalizeDialect(source).source;
    const twice = normalizeDialect(once);

    expect(twice.source).toBe(once);
    expect(twice.report.findings.filter((finding) => finding.action === 'rewritten')).toEqual([]);
  });
});
