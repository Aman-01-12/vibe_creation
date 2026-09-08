// Unit tests for the shared JSON-envelope boundary used by every role parser.
//
// These pin the two guarantees the helper exists to provide: text that already
// parsed still parses identically (no regression for the existing suite), and a
// correct envelope wrapped in a markdown code fence is unwrapped exactly once.
// They also pin what the helper must NOT do - it never repairs malformed JSON and
// never accepts a payload that is not a JSON envelope.

import { describe, expect, it } from 'vitest';

import { parseJsonEnvelope } from './model-output-envelope.js';

/** The parsed value, or a thrown failure so a test never asserts on a stale value. */
function parsedValue(raw: string): unknown {
  const result = parseJsonEnvelope(raw);
  if (!result.ok) {
    throw new Error('expected the envelope to parse');
  }
  return result.value;
}

describe('given text that is already bare JSON', () => {
  it('when parsed then it returns the value unchanged', () => {
    expect(parsedValue('{"source":"module tb; endmodule"}')).toEqual({
      source: 'module tb; endmodule',
    });
  });

  it('when the JSON is a non-object then it still parses, leaving the shape check to the caller', () => {
    expect(parsedValue('[1,2]')).toEqual([1, 2]);
  });

  it('when the JSON is the literal null then it parses to null rather than failing', () => {
    // A failure here would reclassify `"null"` from each caller's "not a JSON
    // object" error to its "not valid JSON" error, changing existing behaviour.
    const result = parseJsonEnvelope('null');
    expect(result).toEqual({ ok: true, value: null });
  });

  it('when the JSON is surrounded by whitespace then it parses, as JSON.parse always allowed', () => {
    expect(parsedValue('  \n {"rtl":"x"} \n ')).toEqual({ rtl: 'x' });
  });
});

describe('given a JSON envelope wrapped in a markdown code fence', () => {
  it('when the fence is preceded by a leading space then the fence is stripped and the body parses', () => {
    const raw = ' ```json\n{"source":"module tb; endmodule"}\n```';
    expect(parsedValue(raw)).toEqual({ source: 'module tb; endmodule' });
  });

  it('when the fence has no language tag then the body parses', () => {
    expect(parsedValue('```\n{"rtl":"module m; endmodule"}\n```')).toEqual({
      rtl: 'module m; endmodule',
    });
  });

  it('when the language tag is upper case then the body parses', () => {
    expect(parsedValue('```JSON\n{"summary":"a counter"}\n```')).toEqual({ summary: 'a counter' });
  });

  it('when the language tag names a different language then the body still parses', () => {
    // The tag is presentation metadata; a mislabelled fence around a conforming
    // envelope is still a conforming envelope.
    expect(parsedValue('```verilog\n{"source":"module tb; endmodule"}\n```')).toEqual({
      source: 'module tb; endmodule',
    });
  });

  it('when prose precedes the fence then the fenced block is extracted', () => {
    const raw = 'Here is the testbench:\n```json\n{"source":"module tb; endmodule"}\n```';
    expect(parsedValue(raw)).toEqual({ source: 'module tb; endmodule' });
  });

  it('when prose follows the closing fence then only the fenced block is parsed', () => {
    const raw = '```json\n{"source":"tb"}\n```\nLet me know if you want more checks.';
    expect(parsedValue(raw)).toEqual({ source: 'tb' });
  });

  it('when there is no closing fence then it unwraps to the end of the text', () => {
    expect(parsedValue('```json\n{"source":"module tb; endmodule"}')).toEqual({
      source: 'module tb; endmodule',
    });
  });

  it('when trailing whitespace follows the closing fence then the body parses', () => {
    expect(parsedValue('```json\n{"rtl":"x"}\n```   \n\n')).toEqual({ rtl: 'x' });
  });

  it('when the line endings are CRLF then the body parses', () => {
    const raw = '```json\r\n{"source":"module tb;\\nendmodule"}\r\n```\r\n';
    expect(parsedValue(raw)).toEqual({ source: 'module tb;\nendmodule' });
  });

  it('when the fence uses four backticks then the body parses', () => {
    expect(parsedValue('````json\n{"rtl":"x"}\n````')).toEqual({ rtl: 'x' });
  });

  it('when the body spans many lines then every line is preserved verbatim', () => {
    const source = 'module tb;\n  initial begin\n    $finish;\n  end\nendmodule';
    const raw = `\`\`\`json\n${JSON.stringify({ source })}\n\`\`\``;
    expect(parsedValue(raw)).toEqual({ source });
  });

  it('when a second fenced block follows then the first block is parsed', () => {
    // A closing fence is backticks alone, so ```verilog cannot terminate block one.
    const raw = '```json\n{"source":"tb"}\n```\n```verilog\nmodule m; endmodule\n```';
    expect(parsedValue(raw)).toEqual({ source: 'tb' });
  });
});

describe('given text that carries no JSON value', () => {
  it('when the text is not JSON and has no fence then it fails without throwing', () => {
    expect(parseJsonEnvelope('not json at all')).toEqual({
      ok: false,
      error: { kind: 'not-json' },
    });
  });

  it('when a fence contains something that is not JSON then it fails without throwing', () => {
    expect(parseJsonEnvelope('```json\nstill not json\n```')).toEqual({
      ok: false,
      error: { kind: 'not-json' },
    });
  });

  it('when a fence wraps bare RTL with no envelope then it fails, so a non-conforming reply is not masked', () => {
    const raw = '```verilog\nmodule tb; initial $finish; endmodule\n```';
    expect(parseJsonEnvelope(raw).ok).toBe(false);
  });

  it('when the fence body is empty then it fails', () => {
    expect(parseJsonEnvelope('```json\n\n```').ok).toBe(false);
  });

  it('when the text is empty then it fails', () => {
    expect(parseJsonEnvelope('').ok).toBe(false);
  });

  it('when the JSON inside a fence is truncated mid-object then it fails rather than repairing it', () => {
    expect(parseJsonEnvelope('```json\n{"source":"module tb;').ok).toBe(false);
  });
});
