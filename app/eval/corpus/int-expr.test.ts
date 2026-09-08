// Unit tests for the port-range integer-expression evaluator.
//
// The evaluator resolves the bounds of a Verilog port range so a width can be
// computed. It reads THIRD-PARTY source, so the tests care as much about what it
// REFUSES as about what it resolves: an unresolvable bound must return a reason so the
// importer quarantines the design, never fall back to a default width that would put
// a wrong interface into the scored corpus.

import { describe, expect, it } from 'vitest';

import { evaluateIntExpression } from './int-expr.js';

/** The parameter scope RTLLM's parameterized references actually use. */
const SCOPE = new Map<string, number>([
  ['DATA_WIDTH', 64],
  ['STG_WIDTH', 16],
  ['size', 4],
  ['N', 32],
  ['Q', 15],
  ['DEPTH', 16],
]);

const EMPTY: ReadonlyMap<string, number> = new Map();

/** Resolve an expression, failing the test if it did not resolve. */
function value(expression: string, scope: ReadonlyMap<string, number> = SCOPE): number {
  const result = evaluateIntExpression(expression, scope);
  if (!result.ok) {
    throw new Error(`expected "${expression}" to resolve but got: ${result.reason}`);
  }
  return result.value;
}

/** The refusal reason for an expression, failing the test if it resolved. */
function reason(expression: string, scope: ReadonlyMap<string, number> = SCOPE): string {
  const result = evaluateIntExpression(expression, scope);
  if (result.ok) {
    throw new Error(`expected "${expression}" to be refused but it resolved to ${result.value}`);
  }
  return result.reason;
}

describe('evaluateIntExpression - literals and arithmetic', () => {
  it('resolves a plain decimal literal', () => {
    expect(value('7', EMPTY)).toBe(7);
  });

  it('resolves sized Verilog literals in every base', () => {
    expect(value("8'd12", EMPTY)).toBe(12);
    expect(value("8'hFF", EMPTY)).toBe(255);
    expect(value("4'b1010", EMPTY)).toBe(10);
    expect(value("6'o17", EMPTY)).toBe(15);
  });

  it('applies multiplication before addition', () => {
    expect(value('1+2*3', EMPTY)).toBe(7);
  });

  it('honours parentheses over default precedence', () => {
    expect(value('(1+2)*3', EMPTY)).toBe(9);
  });

  it('resolves unary minus and truncating division', () => {
    expect(value('-3', EMPTY)).toBe(-3);
    expect(value('7/2', EMPTY)).toBe(3);
    expect(value('7%3', EMPTY)).toBe(1);
  });

  it('ignores underscores in a literal, as Verilog does', () => {
    expect(value('1_024', EMPTY)).toBe(1024);
  });
});

describe('evaluateIntExpression - parameters and $clog2', () => {
  it('resolves the msb form RTLLM parameterized ports use', () => {
    // `output [DATA_WIDTH:0] result` is 65 bits wide, not 64.
    expect(value('DATA_WIDTH')).toBe(64);
    expect(value('DATA_WIDTH-1')).toBe(63);
    expect(value('size*2-1')).toBe(7);
    expect(value('N-1')).toBe(31);
    expect(value('STG_WIDTH-1')).toBe(15);
  });

  it('resolves $clog2 as the smallest n with 2**n >= value', () => {
    expect(value('$clog2(DEPTH)')).toBe(4);
    expect(value('$clog2(DEPTH)-1')).toBe(3);
    expect(value('$clog2(17)', EMPTY)).toBe(5);
  });

  it('treats $clog2 of 0 and 1 as 0, matching Verilog', () => {
    expect(value('$clog2(0)', EMPTY)).toBe(0);
    expect(value('$clog2(1)', EMPTY)).toBe(0);
  });
});

describe('evaluateIntExpression - refusals (never a default width)', () => {
  it('refuses an unknown identifier rather than assuming a value', () => {
    expect(reason('WIDTH_NOT_DECLARED', EMPTY)).toContain('unresolved parameter');
  });

  it('refuses an empty expression', () => {
    expect(reason('   ', EMPTY)).toContain('empty');
  });

  it('refuses division by zero', () => {
    expect(reason('8/0', EMPTY)).toContain('division by zero');
  });

  it('refuses unbalanced parentheses', () => {
    expect(reason('(1+2', EMPTY)).toContain('unbalanced');
  });

  it('refuses trailing tokens left over after a complete expression', () => {
    expect(reason('1 2', EMPTY)).toContain('trailing tokens');
  });

  it('refuses an operator this grammar does not implement', () => {
    expect(reason('1<<3', EMPTY).length).toBeGreaterThan(0);
  });

  it('refuses a value that has grown beyond a sane bit index', () => {
    expect(reason('1000000*1000', EMPTY)).toContain('out of bounds');
  });

  it('refuses an over-long expression rather than scanning it', () => {
    expect(reason('1+'.repeat(200) + '1', EMPTY)).toContain('too long');
  });

  it('does not execute host-language code embedded in the expression', () => {
    // The input is third-party text; it must be parsed, never evaluated.
    expect(reason('process.exit(1)', EMPTY).length).toBeGreaterThan(0);
    expect(reason('globalThis', EMPTY)).toContain('unresolved parameter');
  });
});
