// Examples for `countValuelessFailureReports`: one per rejected shape in task 3.2, plus the
// positive case and the comment-after-literal case that needs `stringSpans` (design C3).

import { describe, expect, it } from 'vitest';

import { countValuelessFailureReports } from './valueless-failure-report.js';

describe('countValuelessFailureReports', () => {
  it('counts a FAIL literal passed as the only argument', () => {
    // Given a FAIL $display that prints no value, When counted, Then it is one report.
    const source = 'initial begin\n  if (a !== b) $display("CHECK ac1 FAIL");\nend\n';
    expect(countValuelessFailureReports(source)).toBe(1);
  });

  it('counts each surviving call and tolerates whitespace and comments around the literal', () => {
    const source =
      '$display ( "FAIL one" ) ;\n$display /* c */ ("FAIL two" /* c */);\n' +
      '$display(// c\n  /* c */ "FAIL three");\n';
    expect(countValuelessFailureReports(source)).toBe(3);
  });

  it.each([
    ['in a line comment', '// $display("FAIL");\n'],
    ['in a block comment', '/* $display("FAIL"); */\n'],
    ['inside another string literal', 'msg = "$display(\\"FAIL\\");";\n'],
    ['as $displayh', '$displayh("FAIL");\n'],
    ['when one argument follows', '$display("FAIL got %h", actual);\n'],
    ['when the FAIL literal is not the first argument', '$display("%s", "FAIL");\n'],
    ['when there is no argument list', '$display;\n'],
    ['when the first argument is a concatenation', '$display({"CHECK ", name, " FAIL"});\n'],
    ['when FAIL is not in capitals', '$display("check failed");\n'],
  ])('does not count a FAIL $display %s', (_shape, source) => {
    expect(countValuelessFailureReports(source)).toBe(0);
  });

  it('does not read FAIL in a comment after the literal as the literal contents', () => {
    expect(countValuelessFailureReports('$display("ok" /* FAIL */);\n')).toBe(0);
  });

  it('undercounts rather than throws on an unterminated literal', () => {
    // Given a closed report then an unterminated one, Then only the closed one counts.
    const source = '$display("FAIL a");\n$display("FAIL b);\n';
    expect(countValuelessFailureReports(source)).toBe(1);
  });
});
