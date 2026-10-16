// The shared admit-list lexer under an admit-list that is NOT the formal one, so the extraction
// is shown to be parameterized rather than formal-only (testbench-in-order-scoreboard, DQ-02).

import { describe, expect, it } from 'vitest';

import {
  balanceRefusal,
  foreignSpanRefusal,
  lexAdmitted,
  MAX_CONSTRUCT_CHARS,
  type AdmitList,
} from '@app/tools';

const STIMULUS_LIKE: AdmitList = {
  systemNames: new Set(['$random']),
  reservedWords: new Set(['module', 'task']),
  operators: ['==', '=', ';', '+', '(', ')', '[', ']'],
};

describe('lexAdmitted', () => {
  it('tokenizes admitted text and drops whitespace', () => {
    const lexed = lexAdmitted("a = $random + 8'hff;", STIMULUS_LIKE);

    expect(lexed.ok && lexed.value.map((token) => `${token.kind}:${token.text}`)).toEqual([
      'word:a',
      'operator:=',
      'system:$random',
      'operator:+',
      "number:8'hff",
      'operator:;',
    ]);
  });

  it('refuses a system name the admit-list does not name', () => {
    expect(lexAdmitted('$system', STIMULUS_LIKE)).toEqual({
      ok: false,
      error: { reason: 'unaccepted-construct', construct: '$system' },
    });
  });

  it('refuses a reserved word and an operator the list does not hold', () => {
    expect(lexAdmitted('module', STIMULUS_LIKE).ok).toBe(false);
    expect(lexAdmitted('a <= b', STIMULUS_LIKE).ok).toBe(false);
  });

  it('bounds and sanitizes the construct it names', () => {
    const lexed = lexAdmitted(`$${'x'.repeat(100)}`, STIMULUS_LIKE);
    const construct =
      !lexed.ok && lexed.error.reason === 'unaccepted-construct' ? lexed.error.construct : '';

    expect(construct.length).toBeLessThanOrEqual(MAX_CONSTRUCT_CHARS);
    expect(construct).toMatch(/^[ -~]+$/);
  });
});

describe('foreignSpanRefusal and balanceRefusal', () => {
  it('names a comment, a string literal, and a compiler directive outright', () => {
    expect(foreignSpanRefusal('a // b')).toEqual({
      reason: 'unaccepted-construct',
      construct: 'comment',
    });
    expect(foreignSpanRefusal('"x"')).toEqual({
      reason: 'unaccepted-construct',
      construct: 'string-literal',
    });
    expect(foreignSpanRefusal('`define X')).toEqual({
      reason: 'unaccepted-construct',
      construct: 'compiler-directive',
    });
    expect(foreignSpanRefusal('a + b')).toBeNull();
  });

  it('refuses mismatched and unclosed brackets', () => {
    expect(balanceRefusal('([)]')).toEqual({ reason: 'unbalanced-expression' });
    expect(balanceRefusal('(a')).toEqual({ reason: 'unbalanced-expression' });
    expect(balanceRefusal('(a[0])')).toBeNull();
  });
});
