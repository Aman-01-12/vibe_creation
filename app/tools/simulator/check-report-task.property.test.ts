// testbench-failure-reportability, the Check_Report_Task's properties (C1, C2).
// One top-level describe per design property; the header holds only what several of them share.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readCheckSignals } from './check-signalling.js';
import {
  CHECK_REPORT_FAIL_FORMAT,
  CHECK_REPORT_PASS_FORMAT,
  renderSimulationHarness,
} from './simulation-harness.js';

/** The design mandates at least 100 runs per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** Every budget the renderer accepts: a positive safe integer. */
const arbWatchdogBudgetNs = fc
  .bigInt({ min: 1n, max: BigInt(Number.MAX_SAFE_INTEGER) })
  .map((value) => Number(value));

/** Every dump limit the renderer accepts: a positive integer that fits a 32-bit literal. */
const arbDumpLimitBytes = fc.bigInt({ min: 1n, max: 0xffff_ffffn }).map((value) => Number(value));

function linesOf(text: string): string[] {
  return text.split('\n');
}

/** Lines whose first token is `keyword`, so a comment or string naming it does not count. */
function declarationsOf(lines: readonly string[], keyword: string): string[] {
  const declaration = new RegExp(`^\\s*${keyword}\\b`);
  return lines.filter((line) => declaration.test(line));
}

// ---------------------------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------------------------

const PROPERTY_4 =
  'Feature: testbench-failure-reportability, Property 4: The harness render preserves version 2 and adds one task';

// The version-2 harness, committed as text so the oracle is not the renderer's own output.
// Source: the C6 rendering in testbench-spec-grounding/design.md (v2 was never committed to
// git), which matches the version-3 render minus its Check_Report_Task block line for line.
function versionTwoHarnessText(watchdogBudgetNs: number, dumpLimitBytes: number): string {
  return `\`timescale 1ns/1ps
// Product-written Simulation_Harness: sole owner of dump.vcd, and the Watchdog.
module ece_simulation_harness;
  // Watchdog_Budget: a liveness bound in ns, not a latency claim about any design.
  localparam [63:0] WATCHDOG_BUDGET_NS = 64'd${String(watchdogBudgetNs)};
  localparam [31:0] DUMP_LIMIT_BYTES = 32'd${String(dumpLimitBytes)};
  initial begin
    $dumpfile("dump.vcd");
    $dumplimit(DUMP_LIMIT_BYTES);
    $dumpvars;
  end
  initial begin
    #(WATCHDOG_BUDGET_NS);
    $display("ECE_WATCHDOG_TIMEOUT");
    $finish;
  end
endmodule
`;
}

/**
 * The lines `after` adds to `before`, when `after` is `before` with one contiguous block inserted
 * at some line index, so every `before` line survives in order; null when no such index exists.
 */
function insertedBlock(before: readonly string[], after: readonly string[]): string[] | null {
  const added = after.length - before.length;
  if (added < 0) {
    return null;
  }
  for (let at = 0; at <= before.length; at += 1) {
    const prefixKept = before.slice(0, at).every((line, i) => after[i] === line);
    const suffixKept = before.slice(at).every((line, i) => after[at + added + i] === line);
    if (prefixKept && suffixKept) {
      return after.slice(at, at + added);
    }
  }
  return null;
}

describe(PROPERTY_4, () => {
  it('keeps every version-2 line in order and inserts one block declaring exactly one task', () => {
    fc.assert(
      fc.property(arbWatchdogBudgetNs, arbDumpLimitBytes, (budget, dumpLimit) => {
        const before = linesOf(versionTwoHarnessText(budget, dumpLimit));
        const after = linesOf(renderSimulationHarness(budget, dumpLimit).contents);

        const block = insertedBlock(before, after);
        expect(block).not.toBeNull();
        const added = block ?? [];
        const taskAt = added.findIndex((line) => /^\s*task\b/.test(line));
        expect(declarationsOf(added, 'task')).toHaveLength(1);
        expect(declarationsOf(added, 'endtask')).toHaveLength(1);
        expect(added.at(-1)).toMatch(/^\s*endtask\b/);
        // Anything ahead of the task is commentary, so the block adds nothing but the task.
        expect(added.slice(0, taskAt).every((line) => /^\s*\/\//.test(line))).toBe(true);

        expect(declarationsOf(after, 'module')).toHaveLength(1);
        expect(declarationsOf(after, 'endmodule')).toHaveLength(1);
        expect(declarationsOf(after, 'task')).toHaveLength(1);
        expect(after).toContain(`  localparam [63:0] WATCHDOG_BUDGET_NS = 64'd${String(budget)};`);
        expect(after).toContain(`  localparam [31:0] DUMP_LIMIT_BYTES = 32'd${String(dumpLimit)};`);
        expect(after).toContain('    $display("ECE_WATCHDOG_TIMEOUT");');
      }),
      PROPERTY_RUNS,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------------------------

const PROPERTY_1 =
  'Feature: testbench-failure-reportability, Property 1: Every line the Check_Report_Task prints is read as the check it was given';

/** The task's value formals are 128 bits wide, and the longest measured check name is 44. */
const VALUE_BITS = 128n;
const MAX_NAME_LENGTH = 44;

/** A Required_Check name: a plain Verilog identifier, matching the scoreboard scaffold's rule. */
const IDENTIFIER_HEAD = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'];
const IDENTIFIER_TAIL = [...IDENTIFIER_HEAD, ...'0123456789'];
const arbCheckName = fc
  .tuple(
    fc.constantFrom(...IDENTIFIER_HEAD),
    fc.array(fc.constantFrom(...IDENTIFIER_TAIL), { maxLength: MAX_NAME_LENGTH - 1 }),
  )
  .map(([head, tail]) => head + tail.join(''));

/** All-ones at each width the corpus exercises, so carry and digit-count boundaries are hit. */
const ALL_ONES = [1n, 4n, 8n, 16n, 64n, 65n].map((bits) => (1n << bits) - 1n);
const arbValue = fc.oneof(
  fc.constantFrom(0n, ...ALL_ONES),
  fc.bigInt({ min: 0n, max: (1n << VALUE_BITS) - 1n }),
);
const arbValuePair = fc.oneof(
  arbValue.map((value) => [value, value] as const),
  fc.tuple(arbValue, arbValue),
);

/** `%0h` as Icarus prints it: minimal-width lowercase hex, so zero is a single `0`. */
function icarusHex(value: bigint): string {
  return value.toString(16);
}

/** Substitute `%0s` and `%0h` in order, the way `$display` consumes its arguments. */
function interpretFormat(format: string, args: readonly (string | bigint)[]): string {
  let next = 0;
  const line = format.replace(/%0[sh]/g, (directive) => {
    const arg = args[next];
    next += 1;
    if (arg === undefined) {
      throw new Error(`format ${format} has more directives than arguments`);
    }
    return directive === '%0s' ? String(arg) : icarusHex(arg as bigint);
  });
  expect(next).toBe(args.length);
  return line;
}

/** The line the Check_Report_Task prints for one call, chosen by value identity. */
function printedLine(name: string, expected: bigint, actual: bigint): string {
  return expected === actual
    ? interpretFormat(CHECK_REPORT_PASS_FORMAT, [name])
    : interpretFormat(CHECK_REPORT_FAIL_FORMAT, [name, expected, actual]);
}

describe(PROPERTY_1, () => {
  it('reads every printed line as exactly one check with the given name and status', () => {
    fc.assert(
      fc.property(arbCheckName, arbValuePair, (name, [expected, actual]) => {
        const reading = readCheckSignals(`${printedLine(name, expected, actual)}\n`);

        expect(reading.unreadableSignals).toBe(0);
        expect(reading.checks).toEqual([{ name, passed: expected === actual }]);
      }),
      PROPERTY_RUNS,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------------------------

const PROPERTY_2 =
  'Feature: testbench-failure-reportability, Property 2: The status word is a complete word and the name is a single token';

const CHECK_PREFIX = 'CHECK ';
const STATUS_WORDS = ['PASS', 'FAIL'] as const;
const WORD_CHARACTER = /[A-Za-z0-9_]/;

/** Names at exactly the longest measured length, which the uniform draw rarely reaches. */
const arbLongestName = fc
  .tuple(
    fc.constantFrom(...IDENTIFIER_HEAD),
    fc.array(fc.constantFrom(...IDENTIFIER_TAIL), {
      minLength: MAX_NAME_LENGTH - 1,
      maxLength: MAX_NAME_LENGTH - 1,
    }),
  )
  .map(([head, tail]) => head + tail.join(''));

/** A name and a strictly longer name that extends it, both within the length cap. */
const arbPrefixPair = fc
  .tuple(
    arbCheckName.map((name) => name.slice(0, MAX_NAME_LENGTH - 1)),
    fc.array(fc.constantFrom(...IDENTIFIER_TAIL), { minLength: 1, maxLength: MAX_NAME_LENGTH }),
  )
  .map(
    ([short, extension]) =>
      [short, (short + extension.join('')).slice(0, MAX_NAME_LENGTH)] as const,
  );

/**
 * Asserts both clauses on one printed line by string positions, not by the reader's pattern:
 * one whitespace-free token after `CHECK `, equal to `name`, then a complete status word.
 */
function expectSingleTokenAndCompleteStatus(line: string, name: string): void {
  expect(line.startsWith(CHECK_PREFIX)).toBe(true);
  const rest = line.slice(CHECK_PREFIX.length);
  const tokenEnd = rest.search(/\s/);
  expect(tokenEnd).toBeGreaterThan(0);
  expect(rest.slice(0, tokenEnd)).toBe(name);
  expect(rest[tokenEnd]).toBe(' ');

  const afterToken = rest.slice(tokenEnd + 1);
  const status = STATUS_WORDS.find((word) => afterToken.startsWith(word));
  expect(status).toBeDefined();
  const following = afterToken.charAt(status?.length ?? 0);
  expect(following === '' || !WORD_CHARACTER.test(following)).toBe(true);
}

describe(PROPERTY_2, () => {
  it('prints the given name as one token followed by a complete status word', () => {
    fc.assert(
      fc.property(
        fc.oneof(arbCheckName, arbLongestName),
        arbValuePair,
        (name, [expected, actual]) => {
          expectSingleTokenAndCompleteStatus(printedLine(name, expected, actual), name);
        },
      ),
      PROPERTY_RUNS,
    );
  });

  it('gives each of two prefix-related names a line whose token is its own name exactly', () => {
    fc.assert(
      fc.property(
        arbPrefixPair,
        arbValuePair,
        arbValuePair,
        ([short, long], [shortExpected, shortActual], [longExpected, longActual]) => {
          expect(long.length).toBeGreaterThan(short.length);
          expectSingleTokenAndCompleteStatus(printedLine(short, shortExpected, shortActual), short);
          expectSingleTokenAndCompleteStatus(printedLine(long, longExpected, longActual), long);
        },
      ),
      PROPERTY_RUNS,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------------------------

const PROPERTY_3 =
  'Feature: testbench-failure-reportability, Property 3: The printed line carries nothing but the three arguments';

/** The only words the two formats may contribute, listed here so the oracle is not the format. */
const SKELETON_WORDS: ReadonlySet<string> = new Set(['CHECK', 'PASS', 'FAIL', 'expected', 'got']);
const SKELETON_PUNCTUATION = /^[ :,]$/;
const WORD_RUN = /[A-Za-z0-9_]+/g;
const HEX_RUN = /^[0-9a-f]+/;
const FORMAT_DIRECTIVE = /(%0[sh])/;

/** Names and values that collide with skeleton words or each other, so membership would lie. */
const arbCollidingName = fc.oneof(
  arbCheckName,
  fc.constantFrom(...SKELETON_WORDS, 'a', 'ad', 'CHECKPASS'),
);
const arbCollidingValue = fc.constantFrom(0xan, 0xadn, 0xeadn, 0xcn);
const arbCollidingPair = fc.oneof(arbValuePair, fc.tuple(arbCollidingValue, arbCollidingValue));

type Origin = 'skeleton' | 'name' | 'value';

/** A half-open character range of the printed line and the argument or skeleton it came from. */
interface TracedSpan {
  readonly start: number;
  readonly end: number;
  readonly origin: Origin;
}

/** Consumes `line` left to right against `format`, so each character is owned by position. */
function traceLine(
  line: string,
  format: string,
  name: string,
  values: readonly bigint[],
): TracedSpan[] {
  const spans: TracedSpan[] = [];
  let at = 0;
  let nextValue = 0;
  for (const piece of format.split(FORMAT_DIRECTIVE).filter((part) => part !== '')) {
    const start = at;
    if (piece === '%0s') {
      expect(line.startsWith(name, at)).toBe(true);
      at += name.length;
      spans.push({ start, end: at, origin: 'name' });
    } else if (piece === '%0h') {
      const run = HEX_RUN.exec(line.slice(at))?.[0] ?? '';
      expect(run.length).toBeGreaterThan(0);
      // Parsed back rather than re-rendered, and minimal width as `%0h` prints it.
      expect(BigInt(`0x${run}`)).toBe(values[nextValue]);
      expect(run === '0' || !run.startsWith('0')).toBe(true);
      nextValue += 1;
      at += run.length;
      spans.push({ start, end: at, origin: 'value' });
    } else {
      expect(piece).not.toContain('%');
      expect(line.startsWith(piece, at)).toBe(true);
      at += piece.length;
      spans.push({ start, end: at, origin: 'skeleton' });
    }
  }
  expect(at).toBe(line.length);
  expect(nextValue).toBe(values.length);
  return spans;
}

/** Every word run lies inside one span: a whole name or value span, or a skeleton word. */
function expectEveryRunTraced(line: string, spans: readonly TracedSpan[]): void {
  for (const run of line.matchAll(WORD_RUN)) {
    const start = run.index;
    const end = start + run[0].length;
    const owner = spans.find((span) => span.start <= start && end <= span.end);
    expect(owner).toBeDefined();
    if (owner?.origin === 'skeleton') {
      expect(SKELETON_WORDS.has(run[0])).toBe(true);
    } else {
      expect([owner?.start, owner?.end]).toEqual([start, end]);
    }
  }
}

/** Skeleton spans hold only word characters (checked as words above) and the fixed punctuation. */
function expectOnlySkeletonCharacters(line: string, spans: readonly TracedSpan[]): void {
  for (const span of spans.filter((candidate) => candidate.origin === 'skeleton')) {
    const characters = [...line.slice(span.start, span.end)];
    expect(characters.every((c) => WORD_CHARACTER.test(c) || SKELETON_PUNCTUATION.test(c))).toBe(
      true,
    );
  }
}

describe(PROPERTY_3, () => {
  it('traces every word run of the printed line by position to the skeleton, name, or a value', () => {
    fc.assert(
      fc.property(arbCollidingName, arbCollidingPair, (name, [expected, actual]) => {
        const line = printedLine(name, expected, actual);
        const passed = expected === actual;
        const format = passed ? CHECK_REPORT_PASS_FORMAT : CHECK_REPORT_FAIL_FORMAT;
        const spans = traceLine(line, format, name, passed ? [] : [expected, actual]);

        expectEveryRunTraced(line, spans);
        expectOnlySkeletonCharacters(line, spans);
      }),
      PROPERTY_RUNS,
    );
  });

  it('prints equal lines for two calls with equal arguments', () => {
    fc.assert(
      fc.property(arbCollidingName, arbCollidingPair, (name, [expected, actual]) => {
        // Rebuilt copies, so equality rests on the arguments' values and not shared references.
        const nameCopy = [...name].join('');
        const first = printedLine(name, expected, actual);
        const second = printedLine(
          nameCopy,
          BigInt(expected.toString()),
          BigInt(actual.toString()),
        );

        expect(second).toBe(first);
      }),
      PROPERTY_RUNS,
    );
  });
});
