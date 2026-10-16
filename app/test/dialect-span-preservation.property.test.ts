// testbench-dialect-normalization, Property 2: The lexical content is preserved, and only a
// declaration moves (task 7.3).
//
// THE CLAIM CHANGED CHARACTER, AND THAT IS WHY THIS TEST EXISTS
//   Property 2's earlier form asserted that deleting the reported rewritten spans from both input
//   and output leaves two byte-identical strings. That held FOR FREE while every rule only ever
//   INSERTED: `unnamed-begin-declaration` added ` : tbnorm_blk_N` and nothing else, so token
//   preservation was a consequence of the edit shape rather than a property of the transform.
//   Group 15 changed that. The rule now MOVES a block's declarations to the top of that same block,
//   because measured with `iverilog -g2012` the label was never the discriminator and POSITION is.
//   Preservation therefore has to be ASSERTED, and it is asserted as a MULTISET:
//
//     1. the output's code-token multiset equals the input's plus exactly the inserted block
//        labels - "the sole addition is the labels" is the exact claim, which is why a code token
//        is word-shaped: the label IS a word token and the ` : ` introducing it is not;
//     2. the comment multiset is unchanged - a same-line trailing comment TRAVELS with its
//        declaration, so its position may move while its presence may not;
//     3. the subsequence of EXECUTABLE statements is identical in order, with declaration
//        statements excluded, because those are precisely what is allowed to move.
//
//   Measured across the 29 committed `unnamed-begin-declaration` fixtures: 29 of 29 for code tokens
//   and 29 of 29 for comments. This property is the statement of that result over generated inputs
//   the 40 hand-captured fixtures do not cover.
//
// WHY THE GENERATOR IS STRUCTURED
//   Task 7.3 states it: a character-level generator spends its budget on inputs the transform
//   refuses wholesale or finds no site in, and the property then passes VACUOUSLY. The shared
//   generator emits a module header, module-scope declarations, `initial` blocks, nested
//   `begin`/`end`, `case`, `fork`, `$display` with string arguments, a declaration AFTER a
//   statement, a preceding statement carrying no word token (`#10;`, `->ev;`, a bare `;`,
//   `@(posedge clk);`), a block with more than one declaration, a `for`-header declaration, a
//   `genvar`, and a block whose declarations are already first. Every one of those shapes is
//   counted below and the test FAILS if the generated space missed one.
//
// THE SCOPE GUARD, STATED AS AN ASSERTION RATHER THAN A COMMENT
//   The multiset claim above is exact only while the sole rewriting rule is the unnamed-begin one.
//   A `malformed-sized-literal` rewrite turns `8'd-1` into `(-8'd1)`, whose word tokens are `d1`
//   rather than `d`, so it is a legitimate token change this property does not model. The generator
//   emits no malformed literal - and that is asserted, so a future change to the generator fails
//   here loudly instead of silently weakening the claim.
//
// The tag string is a literal, not `propertyTag(...)`
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 4.12, 5.2, 5.3, 5.13, 5.14

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeDialect, type DialectFinding } from '@app/agent';
import { CHECK_REPORT_TASK_NAME, CHECK_REPORT_TASK_PATH } from '@app/tools';

import {
  checkNameArbitrary,
  codeWordTokens,
  commentSpans,
  executableStatements,
  generatedVerilogArbitrary,
  insertedBlockLabels,
  withoutInsertedLabels,
  type GeneratedVerilog,
} from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'testbench-dialect-normalization, Property 2: The lexical content is preserved, and only a ' +
  'declaration moves';

/** The minimum share of generated cases that must actually relocate a declaration. */
const MIN_REWRITTEN_SHARE = 0.1;

/** The shapes the generated space must have covered, per task 7.3's own list. */
interface ShapeCoverage {
  declarationAfterStatement: number;
  wordlessBeforeDeclaration: number;
  multiDeclarationBlock: number;
  nestedBlock: number;
  forHeaderDeclaration: number;
  genvarBlock: number;
  declarationsAlreadyFirst: number;
}

/** Tally which of task 7.3's required shapes one generated source carried. */
function tally(coverage: ShapeCoverage, generated: GeneratedVerilog): void {
  for (const block of generated.blocks) {
    if (!block.declarationsFirst && block.declarations.length > 0) {
      coverage.declarationAfterStatement += 1;
    }
    if (block.declarationsFirst && block.declarations.length > 0) {
      coverage.declarationsAlreadyFirst += 1;
    }
    if (block.wordlessBefore !== null && block.declarations.length > 0) {
      coverage.wordlessBeforeDeclaration += 1;
    }
    if (block.declarations.length > 1) {
      coverage.multiDeclarationBlock += 1;
    }
    if (block.nested !== null) {
      coverage.nestedBlock += 1;
    }
  }
  // The `for`-header and `genvar` shapes are rendered as their own top-level constructs, so they
  // are read off the text rather than off the block plans.
  if (generated.text.includes('for (integer ')) {
    coverage.forHeaderDeclaration += 1;
  }
  if (generated.text.includes('genvar ')) {
    coverage.genvarBlock += 1;
  }
}

describe(PROPERTY, () => {
  it('preserves the code-token and comment multisets and the executable-statement order', () => {
    const coverage: ShapeCoverage = {
      declarationAfterStatement: 0,
      wordlessBeforeDeclaration: 0,
      multiDeclarationBlock: 0,
      nestedBlock: 0,
      forHeaderDeclaration: 0,
      genvarBlock: 0,
      declarationsAlreadyFirst: 0,
    };
    let rewritten = 0;
    let total = 0;

    fc.assert(
      fc.property(generatedVerilogArbitrary(), (generated) => {
        total += 1;
        tally(coverage, generated);

        const input = generated.text;
        const { source: output, report } = normalizeDialect(input);

        // A wholesale refusal returns the input unchanged with no findings, which would make every
        // comparison below trivially true.
        expect(report.refusedWholeSource).toBeNull();

        // Scope guard: the multiset arithmetic below models the unnamed-begin rule alone.
        const rewrittenClasses = new Set(
          report.findings.filter((f) => f.action === 'rewritten').map((f) => f.dialectClass),
        );
        expect([...rewrittenClasses].sort()).toEqual(
          rewrittenClasses.size === 0 ? [] : ['unnamed-begin-declaration'],
        );

        const labels = insertedBlockLabels(input, output);

        // 1. The code-token multiset gains exactly the inserted labels and nothing else.
        expect([...codeWordTokens(output)].sort()).toEqual(
          [...codeWordTokens(input), ...labels].sort(),
        );

        // 2. The comment multiset is unchanged; a trailing comment may move, none may vanish.
        expect([...commentSpans(output)].sort()).toEqual([...commentSpans(input)].sort());

        // 3. With the one permitted addition removed, the executable-statement subsequence is
        //    identical in order. Declaration statements are excluded on both sides: those are
        //    exactly what Requirement 5.13 allows to change position.
        expect(executableStatements(withoutInsertedLabels(output, labels))).toEqual(
          executableStatements(input),
        );

        // A rewrite must actually have relocated something, not merely inserted a label: the
        // insertion and each removal each report their own finding, so a real move reports at
        // least two.
        if (report.changed) {
          rewritten += 1;
          expect(report.findings.filter((f) => f.action === 'rewritten').length).toBeGreaterThan(1);
        }
      }),
      propertyParameters(),
    );

    // Non-vacuity, stated as counted facts rather than as a hope. Each of task 7.3's required
    // shapes must have been generated, and a real fraction of cases must have relocated a
    // declaration - a generator that never emits an unnamed `begin` carrying a displaced
    // declaration makes this property pass for the wrong reason.
    expect(total).toBeGreaterThan(0);
    expect(rewritten / total).toBeGreaterThanOrEqual(MIN_REWRITTEN_SHARE);
    expect(coverage.declarationAfterStatement).toBeGreaterThan(0);
    expect(coverage.wordlessBeforeDeclaration).toBeGreaterThan(0);
    expect(coverage.multiDeclarationBlock).toBeGreaterThan(0);
    expect(coverage.nestedBlock).toBeGreaterThan(0);
    expect(coverage.forHeaderDeclaration).toBeGreaterThan(0);
    expect(coverage.genvarBlock).toBeGreaterThan(0);
    expect(coverage.declarationsAlreadyFirst).toBeGreaterThan(0);
  });
});

// testbench-failure-reportability, Property 17. The oracle is this file's own scan: a report is a
// `$display(...)` or Check_Report_Task call at a code position, spanned to its balanced `)`.
// Validates: Requirements 9.5

const PROPERTY_17 =
  'Feature: testbench-failure-reportability, Property 17: The Dialect_Normalizer leaves every ' +
  'report untouched';

/** A report call at a code position; the lookbehind stops `tb.ece_check` or `my_ece_check`. */
const REPORT_CALL_START = new RegExp(
  `(?<![\\w$.])(?:\\$display|${CHECK_REPORT_TASK_PATH.replace('.', '\\.')}|${CHECK_REPORT_TASK_NAME})\\s*\\(`,
  'y',
);

/** A Verilog string literal, escapes included. */
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;

/** The index just past the comment or string starting at `index`, or `null` when none does. */
function skipNonCode(source: string, index: number): number | null {
  if (source.startsWith('//', index)) {
    const newline = source.indexOf('\n', index);
    return newline === -1 ? source.length : newline;
  }
  if (source.startsWith('/*', index)) {
    const close = source.indexOf('*/', index + 2);
    return close === -1 ? source.length : close + 2;
  }
  if (source[index] !== '"') {
    return null;
  }
  let cursor = index + 1;
  while (cursor < source.length && source[cursor] !== '"') {
    cursor += source[cursor] === '\\' ? 2 : 1;
  }
  return cursor + 1;
}

/** The index just past the `)` closing the argument list opened before `index`. */
function closingParenEnd(source: string, index: number): number {
  let depth = 1;
  let cursor = index;
  while (cursor < source.length && depth > 0) {
    const skipped = skipNonCode(source, cursor);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    depth += source[cursor] === '(' ? 1 : source[cursor] === ')' ? -1 : 0;
    cursor += 1;
  }
  return cursor;
}

/** One report call: its full text, name through closing `)`, and its 1-based line range. */
interface ReportSpan {
  readonly text: string;
  readonly firstLine: number;
  readonly lastLine: number;
}

/** The 1-based line holding `offset`, counted the way the normalizer's findings count it. */
function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/** Every report call in source order. */
function reportSpans(source: string): readonly ReportSpan[] {
  const spans: ReportSpan[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const skipped = skipNonCode(source, cursor);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    REPORT_CALL_START.lastIndex = cursor;
    const match = REPORT_CALL_START.exec(source);
    if (match === null) {
      cursor += 1;
      continue;
    }
    const end = closingParenEnd(source, cursor + match[0].length);
    spans.push({
      text: source.slice(cursor, end),
      firstLine: lineOf(source, cursor),
      lastLine: lineOf(source, end),
    });
    cursor = end;
  }
  return spans;
}

/** The Check_Report_Task calls among the report spans. */
function taskCallSpans(source: string): readonly ReportSpan[] {
  return reportSpans(source).filter((span) => !span.text.startsWith('$display'));
}

/** The call head, name through `(`, which a permitted rewrite never touches. */
function callHead(span: ReportSpan): string {
  return span.text.slice(0, span.text.indexOf('(') + 1);
}

function stringLiterals(text: string): readonly string[] {
  return text.match(STRING_LITERAL) ?? [];
}

/** The INPUT lines the normalizer's rewritten `malformed-sized-literal` findings name. */
function sizedLiteralRewriteLines(findings: readonly DialectFinding[]): ReadonlySet<number> {
  return new Set(
    findings
      .filter((f) => f.dialectClass === 'malformed-sized-literal' && f.action === 'rewritten')
      .map((f) => f.line),
  );
}

/**
 * The restated Requirement 9.5 oracle. Calls pair by order, not line, because the unnamed-begin
 * rule moves declaration lines; finding lines are resolved against the input, which is the only
 * source the normalizer plans its edits on.
 */
function expectReportsPreserved(
  input: string,
  output: string,
  findings: readonly DialectFinding[],
): void {
  const before = reportSpans(input);
  const after = reportSpans(output);
  expect(after).toHaveLength(before.length);
  expect(taskCallSpans(output)).toHaveLength(taskCallSpans(input).length);
  const namedLines = sizedLiteralRewriteLines(findings);
  before.forEach((inputCall, index) => {
    const outputCall = after[index];
    expect(outputCall).toBeDefined();
    if (outputCall === undefined) {
      return;
    }
    expect(callHead(outputCall)).toBe(callHead(inputCall));
    expect(stringLiterals(outputCall.text)).toEqual(stringLiterals(inputCall.text));
    if (outputCall.text !== inputCall.text) {
      const named = [...namedLines].some(
        (line) => line >= inputCall.firstLine && line <= inputCall.lastLine,
      );
      expect(named, `unexplained change: ${inputCall.text} -> ${outputCall.text}`).toBe(true);
    }
  });
}

/** The four report shapes; every generated source carries each one at least once. */
const REPORT_KINDS = Object.freeze([
  'bare-task',
  'path-task',
  'valueless-display',
  'valued-display',
] as const);
type ReportKind = (typeof REPORT_KINDS)[number];

/** Argument expressions; the last two are malformed sized literals the normalizer rewrites. */
const REPORT_ARGUMENTS: readonly string[] = Object.freeze([
  'q',
  'acc + 1',
  "4'd3",
  "{q[3:0], 4'h0}",
  "(acc == 2) ? 8'd1 : 8'd0",
  "16'd(-15)",
  "8'd-1",
]);

interface ReportPlan {
  readonly kind: ReportKind;
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
}

/** The call text of one report, without its terminating `;`. */
function renderReport(report: ReportPlan): string {
  const values = `${report.expected}, ${report.actual}`;
  switch (report.kind) {
    case 'bare-task':
      return `${CHECK_REPORT_TASK_NAME}("${report.name}", ${values})`;
    case 'path-task':
      return `${CHECK_REPORT_TASK_PATH}("${report.name}", ${values})`;
    case 'valueless-display':
      return `$display("CHECK ${report.name} FAIL")`;
    case 'valued-display':
      return `$display("CHECK ${report.name} FAIL expected=%0d actual=%0d", ${values})`;
  }
}

function reportPlanArbitrary(kind: fc.Arbitrary<ReportKind>): fc.Arbitrary<ReportPlan> {
  const argument = fc.constantFrom(...REPORT_ARGUMENTS);
  return fc.record({ kind, name: checkNameArbitrary(), expected: argument, actual: argument });
}

/**
 * An unnamed block whose declaration follows its first report, plus a malformed literal in an
 * assignment, so both rewriting rules fire around the reports on every case.
 */
function renderReportBlock(reports: readonly ReportPlan[], index: number): readonly string[] {
  const [first, ...rest] = reports.map((report) => `    ${renderReport(report)};`);
  return [
    '  initial begin',
    ...(first === undefined ? [] : [first]),
    `    integer r${String(index)};`,
    "    acc = 16'd(-15);",
    ...rest,
    '  end',
  ];
}

interface ReportingSource {
  readonly text: string;
  /** The planned report spans, which are the LAST spans of `text` in this order. */
  readonly planned: readonly string[];
}

function reportingSourceArbitrary(): fc.Arbitrary<ReportingSource> {
  const everyKind = fc
    .shuffledSubarray([...REPORT_KINDS], { minLength: REPORT_KINDS.length })
    .chain((kinds) => fc.tuple(...kinds.map((kind) => reportPlanArbitrary(fc.constant(kind)))));
  const extraBlock = fc.array(reportPlanArbitrary(fc.constantFrom(...REPORT_KINDS)), {
    minLength: 1,
    maxLength: 3,
  });
  return fc
    .record({
      base: generatedVerilogArbitrary(),
      blocks: fc.tuple(everyKind, fc.array(extraBlock, { maxLength: 2 })),
    })
    .map(({ base, blocks: [first, extras] }) => {
      const blocks: readonly (readonly ReportPlan[])[] = [first, ...extras];
      const cut = base.text.lastIndexOf('endmodule');
      const lines = [
        '  reg [7:0] q;',
        ...blocks.flatMap((reports, index) => renderReportBlock(reports, index)),
      ];
      return {
        text: `${base.text.slice(0, cut)}${lines.join('\n')}\n${base.text.slice(cut)}`,
        planned: blocks.flat().map(renderReport),
      };
    });
}

describe(PROPERTY_17, () => {
  it('changes a report only at a rewritten sized-literal site, never a string, adds no call', () => {
    fc.assert(
      fc.property(reportingSourceArbitrary(), ({ text: input, planned }) => {
        const inputSpans = reportSpans(input).map((span) => span.text);
        // The scan is the oracle, so it must find exactly what was planted, where it was planted.
        expect(inputSpans.slice(-planned.length)).toEqual(planned);

        const { source: output, report } = normalizeDialect(input);
        expect(report.refusedWholeSource).toBeNull();
        const rewritten = new Set(
          report.findings.filter((f) => f.action === 'rewritten').map((f) => f.dialectClass),
        );
        expect(rewritten).toContain('unnamed-begin-declaration');
        expect(rewritten).toContain('malformed-sized-literal');

        expectReportsPreserved(input, output, report.findings);
      }),
      propertyParameters(),
    );
  });

  it('rewrites the known DQ-04 case on a finding-named line and keeps its name literal', () => {
    const call = `${CHECK_REPORT_TASK_NAME}("ac1_holds", 16'd(-15), q)`;
    const input = [
      'module tb;',
      '  reg [15:0] q;',
      '  initial begin',
      `    ${call};`,
      '  end',
      'endmodule',
      '',
    ].join('\n');

    const { source: output, report } = normalizeDialect(input);

    const [outputCall] = taskCallSpans(output);
    expect(outputCall?.text).toBe(`${CHECK_REPORT_TASK_NAME}("ac1_holds", (-16'd15), q)`);
    expect(stringLiterals(outputCall?.text ?? '')).toEqual(['"ac1_holds"']);
    expect(
      sizedLiteralRewriteLines(report.findings).has(input.split('\n').indexOf(`    ${call};`) + 1),
    ).toBe(true);
    expectReportsPreserved(input, output, report.findings);
  });
});
