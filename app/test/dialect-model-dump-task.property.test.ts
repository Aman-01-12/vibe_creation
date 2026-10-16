// testbench-spec-grounding, Property 12: Model_Dump_Task removal is lexical, complete, and
// line-preserving. Task names in comments and strings stay; every code call goes or is declined.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MODEL_DUMP_TASKS, normalizeDialect } from '@app/agent';
import { scanSource } from '@app/tools';

import {
  commentSpans,
  insertedBlockLabels,
  stringSpans,
  withoutInsertedLabels,
} from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY_12 =
  'Feature: testbench-spec-grounding, Property 12: Model_Dump_Task removal is lexical, complete, and line-preserving';

/** One generated statement and what the rule must leave in its place. */
interface Statement {
  readonly text: string;
  readonly expected: string;
}

/** What a removed call leaves: `begin end` and every newline it spanned. */
function removed(call: string): string {
  return `begin end${call.replace(/[^\n]/gu, '')}`;
}

/** A statement the rule must leave byte-for-byte as it is. */
function kept(text: string): Statement {
  return { text, expected: text };
}

const arbTask = fc.constantFrom(...MODEL_DUMP_TASKS);

/** A complete call: bare, with arguments, with comments and newlines between its parts. */
const arbCall: fc.Arbitrary<Statement> = fc
  .record({
    task: arbTask,
    args: fc.constantFrom('', '(0, tb)', '("dump.vcd")', '(1024)', '(0, tb, "a)b")'),
    gapA: fc.constantFrom('', ' ', ' /* c */ ', '\n  ', ' // c\n '),
    gapB: fc.constantFrom('', ' ', ' /* d */ ', '\n'),
  })
  .map(({ task, args, gapA, gapB }) => {
    const text = args === '' ? `${task}${gapB};` : `${task}${gapA}${args}${gapB};`;
    return { text, expected: removed(text) };
  });

/** A call that never reaches a `;`, which the rule must decline and leave in place. */
const arbIncomplete = arbTask.map((task) => kept(`${task}(0, tb)`));

/** Task names where they are not code: a line comment, a block comment, a string. */
const arbNonCode = arbTask.chain((task) =>
  fc.constantFrom(`// ${task}(0, tb);`, `/* ${task}; */`, `$display("${task};");`).map(kept),
);

const arbOther = fc
  .constantFrom('#5;', '$display("CHECK a_ok PASS");', 'x = x + 1;', '$finish;')
  .map(kept);

const arbStatements = fc.array(fc.oneof(arbCall, arbNonCode, arbOther, arbIncomplete), {
  maxLength: 8,
});

/** A testbench module around `lines`, optionally with a block declaration. */
function moduleOf(lines: readonly string[], declares: boolean): string {
  return [
    'module tb;',
    '  reg [3:0] x;',
    '  initial begin',
    ...(declares ? ['    integer i;'] : []),
    ...lines.map((line) => `    ${line}`),
    '  end',
    'endmodule',
    '',
  ].join('\n');
}

/** The source, and the source the rule must produce, built independently of the rule. */
const arbCase = fc.tuple(arbStatements, fc.boolean()).map(([statements, declares]) => ({
  source: moduleOf(
    statements.map((statement) => statement.text),
    declares,
  ),
  expected: moduleOf(
    statements.map((statement) => statement.expected),
    declares,
  ),
  removedCount: statements.filter((statement) => statement.text !== statement.expected).length,
}));

/** How many Model_Dump_Task names begin at a code offset of `source`. */
function codeTaskSites(source: string): number {
  const mask = scanSource(source);
  const pattern = /\$dump(?:file|vars|limit|off|on|all|flush)(?![A-Za-z0-9_$])/gu;
  return [...source.matchAll(pattern)].filter((match) => mask.code[match.index] === 1).length;
}

function newlineCount(text: string): number {
  return text.split('\n').length - 1;
}

describe(PROPERTY_12, () => {
  it('removes every code call it can, keeps comments, strings, and lines, and is idempotent', () => {
    fc.assert(
      fc.property(arbCase, ({ source, expected, removedCount }) => {
        const { source: output, report } = normalizeDialect(source);
        const dumpFindings = report.findings.filter(
          (finding) => finding.dialectClass === 'model-dump-task',
        );
        const declined = dumpFindings.filter((finding) => finding.action === 'declined');
        // Strip the unnamed-begin rule's labels, which belong to a different class.
        expect(withoutInsertedLabels(output, insertedBlockLabels(source, output))).toBe(expected);
        expect(dumpFindings.length - declined.length).toBe(removedCount);
        expect(codeTaskSites(output)).toBe(declined.length);
        expect(commentSpans(output)).toEqual(commentSpans(expected));
        expect(stringSpans(output)).toEqual(stringSpans(expected));
        expect(newlineCount(output)).toBe(newlineCount(source));
        expect(normalizeDialect(output).source).toBe(output);
      }),
      propertyParameters(),
    );
  });
});
