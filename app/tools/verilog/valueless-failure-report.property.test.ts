// Property tests for `countValuelessFailureReports` (design C3). The oracle is always built
// from the generator's own labels, never from `scanSource`, the mask, or the detector, so a
// defect shared by the detector and the mask cannot hide here.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { countValuelessFailureReports } from './valueless-failure-report.js';

const FEATURE = 'Feature: testbench-failure-reportability';
const MIN_RUNS = { numRuns: 100 };

/** One labelled piece of source: its text, and whether it plants a valueless report. */
interface Fragment {
  readonly text: string;
  readonly valueless: boolean;
}

/** Whitespace a parser skips, newline-free so it is safe inside a line comment or string. */
const inlineSpace = fc.constantFrom('', ' ', '  ', '\t');
/** Whitespace plus comments, including ones holding `)`, `,`, `"`, and `(` as traps. */
const gap = fc
  .array(fc.constantFrom(' ', '\t', '\n', '/* c */', '/* ) , " */', '// x ( ,\n'), {
    maxLength: 3,
  })
  .map((parts) => parts.join(''));

const textUnit = fc.constantFrom('a', 'C', 'K', ' ', '_', ':', '%d', '0', '\\"', '\\\\');
const plainText = fc.string({ unit: textUnit, maxLength: 4 });
/** A closed literal whose contents hold `FAIL` in capitals, escapes included. */
const failLiteral = fc.tuple(plainText, plainText).map(([pre, post]) => `"${pre}FAIL${post}"`);
const lowerText = fc.string({ unit: fc.constantFrom('a', 'k', ' ', '_'), maxLength: 4 });
const argumentExpression = fc.constantFrom('actual', 'got', "8'hff", 'a + b', '{a, b}');
const statementPrefix = fc.constantFrom('', 'if (a !== b) ', 'else ');

/** A valueless `$display("...FAIL...")` built from the given gap arbitrary. */
function valuelessCall(gapArb: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(gapArb, gapArb, failLiteral, gapArb, gapArb)
    .map(([g1, g2, lit, g3, g4]) => `$display${g1}(${g2}${lit}${g3})${g4};`);
}

/** Escape text so it sits inside a Verilog string literal without closing it. */
function asStringContents(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const planted: fc.Arbitrary<Fragment> = fc
  .tuple(statementPrefix, valuelessCall(gap))
  .map(([prefix, call]) => ({ text: `${prefix}${call}`, valueless: true }));

const decoyTexts: readonly fc.Arbitrary<string>[] = [
  valuelessCall(inlineSpace).map((call) => `// ${call}`),
  valuelessCall(inlineSpace).map((call) => `/* ${call} */`),
  valuelessCall(inlineSpace).map((call) => `msg = "${asStringContents(call)}";`),
  fc
    .tuple(fc.constantFrom('h', 'b', 'o'), gap, failLiteral, gap)
    .map(([suffix, g1, lit, g2]) => `$display${suffix}${g1}(${lit}${g2});`),
  fc
    .tuple(gap, failLiteral, gap, gap, argumentExpression)
    .map(([g1, lit, g2, g3, expr]) => `$display${g1}(${lit}${g2},${g3}${expr});`),
  fc
    .tuple(gap, fc.constantFrom('"%s"', 'x'), gap, failLiteral)
    .map(([g1, first, g2, lit]) => `$display${g1}(${first},${g2}${lit});`),
  gap.map((g1) => `$display${g1};`),
  fc.tuple(gap, failLiteral).map(([g1, lit]) => `$display${g1}({${lit}, name});`),
  fc.tuple(gap, lowerText, lowerText).map(([g1, a, b]) => `$display${g1}("${a}fail${b}");`),
  fc.tuple(gap, plainText).map(([g1, text]) => `$display${g1}("ok" /* ${text}FAIL */);`),
];
const decoy: fc.Arbitrary<Fragment> = fc
  .oneof(...decoyTexts)
  .map((text) => ({ text, valueless: false }));

/** Ordinary code between fragments; each fragment is lexically closed, so none leaks state. */
const codeLine = fc.constantFrom('', 'x = y + 1;', 'reg [7:0] r;', 'begin', 'end', '#10;');

/** A source composed of labelled fragments, with its planted count known by construction. */
const labelledSource = fc
  .array(fc.tuple(fc.oneof(planted, decoy), codeLine), { maxLength: 12 })
  .map((pieces) => ({
    source: pieces.map(([fragment, line]) => `${fragment.text}\n${line}\n`).join(''),
    plantedCount: pieces.filter(([fragment]) => fragment.valueless).length,
  }));

describe(`${FEATURE}, Property 5: The detector counts exactly the valueless failure reports`, () => {
  it('returns the planted count for any mix of valueless reports and decoys', () => {
    // **Validates: Requirements 5.2**
    fc.assert(
      fc.property(labelledSource, ({ source, plantedCount }) => {
        expect(countValuelessFailureReports(source)).toBe(plantedCount);
      }),
      MIN_RUNS,
    );
  });
});

// Bodies that never close their opener: no bare quote in a string, no star-slash in a
// comment, and no newline in a directive.
const stringTailBody = fc.string({
  unit: fc.constantFrom(
    'a',
    ' ',
    '\n',
    ')',
    ',',
    '\\"',
    '/*',
    '`',
    asStringContents('$display("FAIL");'),
  ),
  maxLength: 6,
});
const commentTailBody = fc.string({
  unit: fc.constantFrom('a', ' ', '\n', ')', ',', '"', '`', '$display("FAIL");', '// x'),
  maxLength: 6,
});
const directiveTailBody = fc.string({
  unit: fc.constantFrom('define', ' X', ')', '"', '/*', '$display("FAIL");'),
  maxLength: 6,
});

/** An unterminated construct, optionally after an incomplete `$display`, running to EOF. */
const unterminatedTail = fc
  .tuple(
    fc.constantFrom('', '$display', '$display(', '$display ("FAIL"'),
    fc.oneof(
      stringTailBody.map((body) => `"${body}`),
      commentTailBody.map((body) => `/*${body}`),
      directiveTailBody.map((body) => `\`${body}`),
    ),
  )
  .map(([incomplete, tail]) => `${incomplete}${tail}`);

/** Lexically closed sources with a malformed tail, plus a lone `$display(` or `$display` end. */
const malformedSource = fc.oneof(
  fc.tuple(labelledSource, unterminatedTail).map(([{ source }, tail]) => `${source}${tail}`),
  labelledSource.map(({ source }) => `${source}$display(`),
  labelledSource.map(({ source }) => `${source}$display`),
);

/** Token soup over the lexer's trigger characters, so openers and closers collide freely. */
const tokenSoup = fc.string({
  unit: fc.constantFrom(
    '$display',
    '(',
    ')',
    '"',
    'FAIL',
    '/*',
    '*/',
    '//',
    '`',
    '\n',
    '\\',
    ',',
    ' ',
  ),
  maxLength: 30,
});

const anyString = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.string({ unit: 'grapheme' }),
  tokenSoup,
  malformedSource,
);

describe(`${FEATURE}, Property 6: The detector is deterministic and total`, () => {
  it('returns the same non-negative safe integer on repeated and copied readings', () => {
    // **Validates: Requirements 5.8**
    fc.assert(
      fc.property(anyString, (source) => {
        const count = countValuelessFailureReports(source);
        expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
        expect(countValuelessFailureReports(source)).toBe(count);
        expect(countValuelessFailureReports([...source].join(''))).toBe(count);
      }),
      MIN_RUNS,
    );
  });

  it('never increases the count when an unterminated tail is appended', () => {
    // **Validates: Requirements 5.8**
    fc.assert(
      fc.property(labelledSource, unterminatedTail, ({ source }, tail) => {
        expect(countValuelessFailureReports(`${source}${tail}`)).toBeLessThanOrEqual(
          countValuelessFailureReports(source),
        );
      }),
      MIN_RUNS,
    );
  });
});
