// testbench-spec-grounding, Properties 5 to 7: the Grounded_Arm's fenced reply parser takes the
// one complete block verbatim and refuses everything else, and the JSON parser does not move.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseFencedTestbenchDraft, parseTestbenchDraft } from '@app/agent';

import { propertyParameters } from './property.js';

const PROPERTY_5 = 'Feature: testbench-spec-grounding, Property 5: Fenced extraction round trip';
const PROPERTY_6 =
  'Feature: testbench-spec-grounding, Property 6: Fenced parser refuses everything that is not exactly one complete block';
const PROPERTY_7 = 'Feature: testbench-spec-grounding, Property 7: The JSON parser is unchanged';

const MAX_SOURCE_CHARS = 200_000;

/** Body lines with no fence-shaped line; a one-backtick directive is ordinary Verilog. */
const BODY_LINES = [
  '`timescale 1ns/1ps',
  'module tb;',
  '  reg clk = 0;',
  '  always #5 clk = ~clk;',
  '  initial begin $display("CHECK count_wraps PASS"); $finish; end',
  '   ',
  '',
  'endmodule',
  '  // ``` inside a comment is not at the line start',
] as const;

const PROSE_LINES = ['Here is the testbench:', 'It uses `timescale.', '', 'Done.'] as const;

const arbEol = fc.constantFrom('\n', '\r\n');
const arbTicks = fc.integer({ min: 3, max: 6 });
const arbInfo = fc.constantFrom('', 'verilog', 'Verilog', ' systemverilog ', 'v title="tb"');
const arbIndent = fc.constantFrom('', '  ', '\t');

/** Lines joined with an end of line after each, which is how a block body is printed. */
function linesOf(lines: readonly string[], eol: string): string {
  return lines.map((line) => line + eol).join('');
}

const arbBodyLines = fc.array(fc.constantFrom(...BODY_LINES), { maxLength: 8 });
const arbProse = fc.array(fc.constantFrom(...PROSE_LINES), { maxLength: 3 });

interface PrintedBlock {
  readonly reply: string;
  readonly body: string;
}

/** One complete block with prose around it, printed with the given line ending. */
const arbBlock: fc.Arbitrary<PrintedBlock> = fc
  .record({
    eol: arbEol,
    ticks: arbTicks,
    extraCloseTicks: fc.integer({ min: 0, max: 2 }),
    info: arbInfo,
    indent: arbIndent,
    body: arbBodyLines,
    before: arbProse,
    after: arbProse,
  })
  .map(({ eol, ticks, extraCloseTicks, info, indent, body, before, after }) => {
    const printedBody = linesOf(body, eol);
    const open = `${indent}${'`'.repeat(ticks)}${info}${eol}`;
    const close = `${indent}${'`'.repeat(ticks + extraCloseTicks)}${eol}`;
    return {
      reply: linesOf(before, eol) + open + printedBody + close + linesOf(after, eol),
      body: printedBody,
    };
  });

describe(PROPERTY_5, () => {
  it('returns the body verbatim, or refuses an empty body with empty-source', () => {
    fc.assert(
      fc.property(arbBlock, ({ reply, body }) => {
        const parsed = parseFencedTestbenchDraft(reply);
        if (body.trim().length === 0) {
          expect(parsed.ok ? null : parsed.error.refusal).toBe('empty-source');
          return;
        }
        expect(parsed.ok ? parsed.value.source : parsed.error).toBe(body);
      }),
      propertyParameters(),
    );
  });

  it('refuses a body over the size bound with oversize-source, and accepts one at it', () => {
    const line = 'reg [7:0] r;\n';
    const atBound = line.repeat(Math.floor(MAX_SOURCE_CHARS / line.length));
    const overBound = atBound + 'x'.repeat(MAX_SOURCE_CHARS - atBound.length + 1);
    const accepted = parseFencedTestbenchDraft('```verilog\n' + atBound + '```\n');
    expect(accepted.ok ? accepted.value.source : accepted.error).toBe(atBound);
    const refused = parseFencedTestbenchDraft('```verilog\n' + overBound + '\n```\n');
    expect(refused.ok ? null : refused.error).toEqual({
      refusal: 'oversize-source',
      reason: 'testbench source exceeded the maximum accepted size',
    });
  });
});

const REASONS = {
  'no-fence': 'model output contained no fenced code block',
  'multiple-fences': 'model output contained more than one fenced code block',
  'unterminated-fence': 'model output contained an unterminated fenced code block',
} as const;

function expectRefusal(reply: string, refusal: keyof typeof REASONS): void {
  const parsed = parseFencedTestbenchDraft(reply);
  expect(parsed.ok ? null : parsed.error).toEqual({ refusal, reason: REASONS[refusal] });
}

describe(PROPERTY_6, () => {
  it('refuses a reply with no fence-shaped line as no-fence', () => {
    fc.assert(
      fc.property(arbBodyLines, arbProse, arbEol, (body, prose, eol) => {
        expectRefusal(linesOf([...prose, ...body], eol), 'no-fence');
      }),
      propertyParameters(),
    );
  });

  it('refuses two or more complete blocks as multiple-fences', () => {
    fc.assert(
      fc.property(fc.array(arbBlock, { minLength: 2, maxLength: 3 }), (blocks) => {
        expectRefusal(blocks.map((block) => block.reply).join(''), 'multiple-fences');
      }),
      propertyParameters(),
    );
  });

  it('refuses an opening fence that never closes as unterminated-fence', () => {
    fc.assert(
      fc.property(
        arbProse,
        arbTicks,
        arbInfo,
        arbBodyLines,
        arbEol,
        (prose, ticks, info, body, eol) => {
          const reply = linesOf(prose, eol) + '`'.repeat(ticks) + info + eol + linesOf(body, eol);
          expectRefusal(reply, 'unterminated-fence');
        },
      ),
      propertyParameters(),
    );
  });

  it('never throws on an arbitrary string', () => {
    const arbAny = fc.oneof(
      fc.string(),
      fc
        .array(fc.constantFrom('```', '`', '\n', '\r', 'x', ' ', 'verilog'), { maxLength: 30 })
        .map((parts) => parts.join('')),
    );
    fc.assert(
      fc.property(arbAny, (raw) => {
        expect(() => parseFencedTestbenchDraft(raw)).not.toThrow();
      }),
      propertyParameters(),
    );
  });
});

// --- Frozen version-5 JSON parser, copied with its envelope helper so nothing is shared ----

const V5_OPENING_FENCE_LINE = /^[ \t\r]*`{3,}[ \t\r]*(?:[A-Za-z0-9_+.-]+[ \t\r]*)?$/m;
const V5_CLOSING_FENCE_LINE = /^[ \t\r]*`{3,}[ \t\r]*$/m;

function v5TryParse(text: string): { readonly value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

function v5Unwrap(text: string): string | null {
  const opening = V5_OPENING_FENCE_LINE.exec(text);
  if (opening === null) {
    return null;
  }
  const after = text.slice(opening.index + opening[0].length).replace(/^\r?\n/, '');
  const closing = V5_CLOSING_FENCE_LINE.exec(after);
  const body = closing === null ? after : after.slice(0, closing.index);
  return body.trim().length === 0 ? null : body;
}

/** The version-5 `parseTestbenchDraft` result as `{ source }` or `{ reason }`. */
function v5Parse(raw: string): { readonly source: string } | { readonly reason: string } {
  const parsed =
    v5TryParse(raw) ?? ((body) => (body === null ? null : v5TryParse(body)))(v5Unwrap(raw));
  if (parsed === null) {
    return { reason: 'model output was not valid JSON' };
  }
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { reason: 'model output was not a JSON object' };
  }
  const { source } = value as Readonly<Record<string, unknown>>;
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { reason: 'model output was missing a non-empty testbench source' };
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return { reason: 'testbench source exceeded the maximum accepted size' };
  }
  return { source };
}

describe(PROPERTY_7, () => {
  it('returns the same outcome, source, and reason as the frozen version-5 parser', () => {
    const arbSource = fc.oneof(fc.string(), fc.constantFrom('', '  ', 'module tb; endmodule'));
    const arbJsonish = fc.oneof(
      fc.string(),
      arbSource.map((source) => JSON.stringify({ source })),
      arbSource.map((source) => '```json\n' + JSON.stringify({ source }) + '\n```'),
      fc.constantFrom('null', '[]', '42', '{"source":7}', '{"testbench":"x"}', '```\n\n```'),
      fc.jsonValue().map((value) => JSON.stringify(value)),
    );
    fc.assert(
      fc.property(arbJsonish, (raw) => {
        const actual = parseTestbenchDraft(raw);
        const shaped = actual.ok
          ? { source: actual.value.source }
          : { reason: actual.error.reason };
        expect(shaped).toEqual(v5Parse(raw));
      }),
      propertyParameters(),
    );
  });
});
