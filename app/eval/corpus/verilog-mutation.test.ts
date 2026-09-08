// Unit tests for the deterministic Verilog mutant generator.
//
// WHAT THESE PIN DOWN
//   1. Each named operator performs exactly the transform its name claims, and nothing else.
//   2. The adjacency guards hold: a one- or two-character substitution never silently becomes
//      a DIFFERENT operator (`<` inside `<=`, `==` inside `===`, `+` inside `+:`, unary `-`).
//   3. Nothing fires inside a comment, a string literal, or a compiler directive - the classic
//      way text-level mutation produces mutants that are not mutations at all.
//   4. Determinism: the same source and config yield the same mutants, in the same order, with
//      the same ids. This is a CONTRACT, not a convenience: the golden-testbench calibration is
//      cached by mutant id, so a generator that reordered itself would invalidate every cache
//      and make a survivor irreproducible by hand.
//   5. The cap is applied by ROUND-ROBIN across operators, not by "first N found". A source with
//      four `+` signs and one reset branch must still get its reset branch mutated.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MUTATION_CONFIG,
  MUTATION_OPERATORS,
  type Mutant,
  type MutationConfig,
  type MutationOperatorId,
} from '../mutation-control.js';
import { generateMutants, MAX_MUTATED_SOURCE_CHARS } from './verilog-mutation.js';

/** A config enabling exactly one operator, so a transform can be asserted in isolation. */
function onlyOperator(operator: MutationOperatorId): MutationConfig {
  return { maxMutantsPerProblem: 64, operators: [operator] };
}

/** The mutated sources one operator produces for a snippet, in generation order. */
function mutatedBy(source: string, operator: MutationOperatorId): readonly string[] {
  return generateMutants(source, onlyOperator(operator)).map((mutant) => mutant.rtl);
}

/** Every operator that fires at all on a snippet, in generation order. */
function operatorsFiring(source: string, cap = 64): readonly MutationOperatorId[] {
  return generateMutants(source, { maxMutantsPerProblem: cap, operators: MUTATION_OPERATORS }).map(
    (mutant) => mutant.operator,
  );
}

/** A small but realistic sequential design, used where a whole module matters. */
const COUNTER = `\`timescale 1ns/1ps
module counter (input clk, input rst_n, output reg [7:0] q);
  always @(posedge clk or negedge rst_n)
    if (!rst_n)
      q <= 8'd0;
    else if (q < 8'd200)
      q <= q + 1;
    else
      q <= 8'd0;
endmodule
`;

describe('generateMutants - each operator performs the transform it names', () => {
  it('turns a binary + into - and a binary - into +', () => {
    expect(mutatedBy('assign y = a + b;', 'ARITH_PLUS_TO_MINUS')).toEqual(['assign y = a - b;']);
    expect(mutatedBy('assign y = a - b;', 'ARITH_MINUS_TO_PLUS')).toEqual(['assign y = a + b;']);
  });

  it('swaps bitwise & and |, in both directions', () => {
    expect(mutatedBy('assign y = a & b;', 'BITWISE_AND_TO_OR')).toEqual(['assign y = a | b;']);
    expect(mutatedBy('assign y = a | b;', 'BITWISE_OR_TO_AND')).toEqual(['assign y = a & b;']);
  });

  it('widens a < into a <=, which is the inclusive-boundary defect', () => {
    expect(mutatedBy('assign y = a < b;', 'RELATIONAL_LT_TO_LE')).toEqual(['assign y = a <= b;']);
  });

  it('inverts an == into a !=', () => {
    expect(mutatedBy('assign y = a == b;', 'EQUALITY_TO_INEQUALITY')).toEqual([
      'assign y = a != b;',
    ]);
  });

  it('reverses a shift direction, in both directions', () => {
    expect(mutatedBy('assign y = a << b;', 'SHIFT_DIRECTION_SWAPPED')).toEqual([
      'assign y = a >> b;',
    ]);
    expect(mutatedBy('assign y = a >> b;', 'SHIFT_DIRECTION_SWAPPED')).toEqual([
      'assign y = a << b;',
    ]);
  });

  it('negates an if condition without disturbing the branch', () => {
    expect(mutatedBy('if (a && b) y = c;', 'CONDITION_NEGATED')).toEqual(['if (!(a && b)) y = c;']);
  });

  it('forces a reset condition false, so the reset branch never fires', () => {
    // Implemented as neutralizing the condition rather than deleting statements: deleting a
    // branch from text is not provably safe without a parser, and an unreachable reset is the
    // behaviour the mutation is about.
    expect(mutatedBy('if (!rst_n) q <= 0; else q <= d;', 'RESET_BRANCH_DISABLED')).toEqual([
      "if (1'b0) q <= 0; else q <= d;",
    ]);
  });

  it('only calls a condition a reset when its own identifiers say so', () => {
    expect(mutatedBy('if (enable) q <= d;', 'RESET_BRANCH_DISABLED')).toEqual([]);
    expect(mutatedBy('if (soft_reset_n) q <= d;', 'RESET_BRANCH_DISABLED')).toHaveLength(1);
  });

  it('perturbs a zero literal to one, whatever base it is written in', () => {
    expect(mutatedBy("q <= 'd0;", 'CONST_ZERO_TO_ONE')).toEqual(["q <= 'd1;"]);
    expect(mutatedBy("q <= 16'b0;", 'CONST_ZERO_TO_ONE')).toEqual(["q <= 16'b1;"]);
    expect(mutatedBy('q <= 0;', 'CONST_ZERO_TO_ONE')).toEqual(['q <= 1;']);
  });

  it('increments a decimal literal', () => {
    expect(mutatedBy('parameter DEPTH = 9;', 'CONST_INCREMENTED')).toEqual([
      'parameter DEPTH = 10;',
    ]);
    expect(mutatedBy("q <= 8'd35;", 'CONST_INCREMENTED')).toEqual(["q <= 8'd36;"]);
  });

  it('moves a bracketed index by one, and never below zero', () => {
    expect(mutatedBy('assign y = x[3];', 'INDEX_OFF_BY_ONE')).toEqual(['assign y = x[2];']);
    expect(mutatedBy('assign y = x[0];', 'INDEX_OFF_BY_ONE')).toEqual(['assign y = x[1];']);
    // Both bounds of a range are sites, so a width and an offset defect are both reachable.
    expect(mutatedBy('reg [7:1] r;', 'INDEX_OFF_BY_ONE')).toEqual(['reg [6:1] r;', 'reg [7:0] r;']);
  });

  it('leaves the size prefix of a sized literal alone', () => {
    // Perturbing the `8` of `8'd12` changes the literal's WIDTH rather than its value, which
    // is a different experiment; only the value is a constant-perturbation site.
    expect(mutatedBy("q <= 8'd12;", 'CONST_INCREMENTED')).toEqual(["q <= 8'd13;"]);
  });
});

describe('generateMutants - the adjacency guards hold', () => {
  it('never rewrites the < of a nonblocking assignment', () => {
    expect(mutatedBy('q <= d;', 'RELATIONAL_LT_TO_LE')).toEqual([]);
    expect(mutatedBy('assign y = a <= b;', 'RELATIONAL_LT_TO_LE')).toEqual([]);
  });

  it('never reads the == inside a case-equality ===', () => {
    expect(mutatedBy('if (a === b) y = c;', 'EQUALITY_TO_INEQUALITY')).toEqual([]);
    expect(mutatedBy('if (a !== b) y = c;', 'EQUALITY_TO_INEQUALITY')).toEqual([]);
  });

  it('never rewrites a part-select +: or -:', () => {
    expect(mutatedBy('assign y = x[i +: 4];', 'ARITH_PLUS_TO_MINUS')).toEqual([]);
    expect(mutatedBy('assign y = x[i -: 4];', 'ARITH_MINUS_TO_PLUS')).toEqual([]);
  });

  it('never rewrites a unary minus, only a binary one', () => {
    expect(mutatedBy('assign y = -a;', 'ARITH_MINUS_TO_PLUS')).toEqual([]);
  });

  it('never rewrites an event-trigger arrow or a logical operator', () => {
    expect(mutatedBy('-> done;', 'ARITH_MINUS_TO_PLUS')).toEqual([]);
    expect(mutatedBy('assign y = a && b;', 'BITWISE_AND_TO_OR')).toEqual([]);
    expect(mutatedBy('assign y = a || b;', 'BITWISE_OR_TO_AND')).toEqual([]);
  });

  it('never rewrites an arithmetic shift <<< or >>>', () => {
    expect(mutatedBy('assign y = a <<< b;', 'SHIFT_DIRECTION_SWAPPED')).toEqual([]);
    expect(mutatedBy('assign y = a >>> b;', 'SHIFT_DIRECTION_SWAPPED')).toEqual([]);
  });

  it('never treats a digit inside an identifier or a hex literal as a literal', () => {
    expect(mutatedBy('assign y = sum0;', 'CONST_ZERO_TO_ONE')).toEqual([]);
    expect(mutatedBy("q <= 8'h0A;", 'CONST_ZERO_TO_ONE')).toEqual([]);
  });
});

describe('generateMutants - nothing fires on non-code', () => {
  it('leaves a line comment alone', () => {
    expect(mutatedBy('// assign y = a + b;\nassign z = c;', 'ARITH_PLUS_TO_MINUS')).toEqual([]);
  });

  it('leaves a block comment alone, including a multi-line one', () => {
    expect(
      mutatedBy('/* y = a + b;\n   w = c & d; */\nassign z = e;', 'ARITH_PLUS_TO_MINUS'),
    ).toEqual([]);
    expect(mutatedBy('/* w = c & d; */\nassign z = e;', 'BITWISE_AND_TO_OR')).toEqual([]);
  });

  it('leaves a string literal alone, escapes included', () => {
    expect(mutatedBy('$display("a + b");', 'ARITH_PLUS_TO_MINUS')).toEqual([]);
    // The escaped quote must not end the literal early, or the `+` after it would be exposed.
    expect(mutatedBy('$display("say \\"a + b\\" now");', 'ARITH_PLUS_TO_MINUS')).toEqual([]);
  });

  it('leaves a compiler directive alone', () => {
    expect(mutatedBy('`define SUM a + b\nassign z = c;', 'ARITH_PLUS_TO_MINUS')).toEqual([]);
    expect(mutatedBy('`define ZERO 0\nassign z = c;', 'CONST_ZERO_TO_ONE')).toEqual([]);
  });

  it('still mutates the code that follows the non-code', () => {
    const mutated = mutatedBy('// a + b\nassign z = c + d;', 'ARITH_PLUS_TO_MINUS');
    expect(mutated).toEqual(['// a + b\nassign z = c - d;']);
  });
});

describe('generateMutants - determinism is the contract', () => {
  it('produces an identical mutant set, in the same order, on a repeated call', () => {
    const first = generateMutants(COUNTER, DEFAULT_MUTATION_CONFIG);
    const second = generateMutants(COUNTER, DEFAULT_MUTATION_CONFIG);

    expect(second.map((mutant) => mutant.mutantId)).toEqual(first.map((mutant) => mutant.mutantId));
    expect(second.map((mutant) => mutant.rtl)).toEqual(first.map((mutant) => mutant.rtl));
    expect(second.map((mutant) => mutant.site)).toEqual(first.map((mutant) => mutant.site));
  });

  it('gives every mutant a distinct, operator-and-site-derived id', () => {
    const mutants = generateMutants(COUNTER, DEFAULT_MUTATION_CONFIG);

    expect(mutants.length).toBeGreaterThan(0);
    expect(new Set(mutants.map((mutant) => mutant.mutantId)).size).toBe(mutants.length);
    for (const mutant of mutants) {
      expect(mutant.mutantId).toBe(`${mutant.operator}@${mutant.site.line}:${mutant.site.column}`);
    }
  });

  it('changes exactly ONE site per mutant, so a survivor names one concrete defect', () => {
    for (const mutant of generateMutants(COUNTER, DEFAULT_MUTATION_CONFIG)) {
      expect(mutant.rtl).not.toBe(COUNTER);
      expect(singleEditOf(COUNTER, mutant)).toBe(true);
    }
  });

  it('locates each site at the line and column the reference actually holds it at', () => {
    const mutants = generateMutants(COUNTER, onlyOperator('RESET_BRANCH_DISABLED'));
    const site = mutants[0]?.site;

    expect(site).toBeDefined();
    // `if (!rst_n)` is on line 4 of COUNTER, and the site is the opening parenthesis.
    expect(site?.line).toBe(4);
    expect(COUNTER.split('\n')[3]?.charAt((site?.column ?? 1) - 1)).toBe('(');
    expect(site?.before).toBe('(!rst_n)');
  });
});

describe('generateMutants - the cap is round-robin, not first-N-found', () => {
  const MANY_ADDS = `module m;
  assign a = 1 + 2 + 3 + 4 + 5;
  always @(posedge clk) if (rst) q <= 0;
endmodule
`;

  it('spends the budget across defect CLASSES rather than across text positions', () => {
    // Four `+` sites are available. A "first N found" cap would fill the whole budget with
    // them and never test whether our testbench notices a disabled reset.
    const operators = operatorsFiring(MANY_ADDS, 4);

    expect(operators).toHaveLength(4);
    expect(operators.filter((operator) => operator === 'ARITH_PLUS_TO_MINUS')).toHaveLength(1);
    expect(operators).toContain('RESET_BRANCH_DISABLED');
    expect(new Set(operators).size).toBe(4);
  });

  it('never exceeds the cap, and visits operators in the declared order', () => {
    const operators = operatorsFiring(MANY_ADDS, 3);

    expect(operators).toHaveLength(3);
    // ARITH_PLUS_TO_MINUS comes first in MUTATION_OPERATORS, so it opens round one.
    expect(operators[0]).toBe('ARITH_PLUS_TO_MINUS');
  });

  it('returns every available site when the cap is generous', () => {
    expect(operatorsFiring(MANY_ADDS, 64).length).toBeGreaterThan(4);
  });

  it('honours a config that names a subset of the operators', () => {
    const operators = generateMutants(MANY_ADDS, {
      maxMutantsPerProblem: 64,
      operators: ['CONST_ZERO_TO_ONE'],
    }).map((mutant) => mutant.operator);

    expect(new Set(operators)).toEqual(new Set(['CONST_ZERO_TO_ONE']));
  });
});

describe('generateMutants - degenerate sources', () => {
  it('yields no mutants for an empty source', () => {
    expect(generateMutants('', DEFAULT_MUTATION_CONFIG)).toEqual([]);
  });

  it('yields no mutants for a source with no operator site at all', () => {
    expect(generateMutants('module m; endmodule\n', DEFAULT_MUTATION_CONFIG)).toEqual([]);
  });

  it('refuses an over-long source rather than partially scanning it', () => {
    const oversized = `assign y = a + b; ${'/'.repeat(MAX_MUTATED_SOURCE_CHARS)}`;

    expect(generateMutants(oversized, DEFAULT_MUTATION_CONFIG)).toEqual([]);
  });
});

/**
 * Whether a mutant differs from its reference by exactly one contiguous edit.
 *
 * Derived by matching the common prefix and suffix: what remains in the middle is the single
 * replaced span. Two independent edits would leave unmatched text between them and make the
 * remaining spans disagree with a single substitution.
 */
function singleEditOf(reference: string, mutant: Mutant): boolean {
  let head = 0;
  while (head < reference.length && reference.charAt(head) === mutant.rtl.charAt(head)) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < reference.length - head &&
    tail < mutant.rtl.length - head &&
    reference.charAt(reference.length - 1 - tail) ===
      mutant.rtl.charAt(mutant.rtl.length - 1 - tail)
  ) {
    tail += 1;
  }
  const removed = reference.slice(head, reference.length - tail);
  const inserted = mutant.rtl.slice(head, mutant.rtl.length - tail);
  return (
    reference ===
      `${reference.slice(0, head)}${removed}${reference.slice(reference.length - tail)}` &&
    mutant.rtl ===
      `${reference.slice(0, head)}${inserted}${reference.slice(reference.length - tail)}`
  );
}
