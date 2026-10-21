// Authoring_Contract checker tests (task 10.3).

import { describe, expect, it } from 'vitest';

import { checkAuthoringContract, type ExcludedConstruct } from './authoring-contract.js';
import type { ReferenceModelDraft } from './types.js';

function draftWith(expectBody: string): ReferenceModelDraft {
  return {
    resetStateBody: "ece_reset_state = 128'd0;",
    nextStateBody: 'ece_next_state = s;',
    expectBody,
    roles: [],
  };
}

function rejectedConstructs(draft: ReferenceModelDraft): readonly ExcludedConstruct[] {
  const check = checkAuthoringContract(draft);
  if (check.kind !== 'rejected') {
    throw new Error('expected rejection');
  }
  return check.excluded;
}

describe('checkAuthoringContract', () => {
  it('accepts a body with none of the eight excluded constructs', () => {
    const check = checkAuthoringContract(draftWith("ece_expect = 1'b0;"));
    expect(check.kind).toBe('accepted');
  });

  it.each<[ExcludedConstruct, string]>([
    ['delay-control', "#10 ece_expect = 1'b0;"],
    ['event-control', "@(posedge clk) ece_expect = 1'b0;"],
    ['clock-generation', "forever ece_expect = 1'b0;"],
    ['width-declaration', "input x; ece_expect = 1'b0;"],
    ['waveform-dump', '$dumpfile("x"); ece_expect = 1\'b0;'],
    ['display-task', '$display("x"); ece_expect = 1\'b0;'],
    ['module-declaration', "module m; ece_expect = 1'b0;"],
    ['assignment-to-harness-signal', "ece_clk = 1'b1; ece_expect = 1'b0;"],
  ])('rejects a body containing %s', (construct, body) => {
    expect(rejectedConstructs(draftWith(body))).toContain(construct);
  });

  it('does not count a # inside a line comment', () => {
    const check = checkAuthoringContract(draftWith("// #10\nece_expect = 1'b0;"));
    expect(check.kind).toBe('accepted');
  });

  it('does not count a # inside a block comment', () => {
    const check = checkAuthoringContract(draftWith("/* #10 */ ece_expect = 1'b0;"));
    expect(check.kind).toBe('accepted');
  });

  it('does not count a # inside a string literal', () => {
    const check = checkAuthoringContract(draftWith('ece_expect = "#10";'));
    expect(check.kind).toBe('accepted');
  });

  it('does not read $displayh as $display', () => {
    const check = checkAuthoringContract(draftWith('$displayh("x"); ece_expect = 1\'b0;'));
    expect(check.kind).toBe('accepted');
  });

  it('reports every excluded construct found, not only the first', () => {
    const excluded = rejectedConstructs(draftWith("#10 @(posedge clk) ece_expect = 1'b0;"));
    expect(excluded).toContain('delay-control');
    expect(excluded).toContain('event-control');
  });

  it('rejects an excluded construct in the reset-state body too', () => {
    const check = checkAuthoringContract({
      ...draftWith("ece_expect = 1'b0;"),
      resetStateBody: '#5 ece_reset_state = 0;',
    });
    expect(check.kind === 'rejected' && check.excluded.includes('delay-control')).toBe(true);
  });

  it('does not reject an assignment to ece_reset_state itself', () => {
    const check = checkAuthoringContract({
      ...draftWith("ece_expect = 1'b0;"),
      resetStateBody: "ece_reset_state = 128'd10;",
    });
    expect(check.kind).toBe('accepted');
  });

  it('does not reject an assignment to ece_expect itself', () => {
    const check = checkAuthoringContract(draftWith("ece_expect = 1'b0;"));
    expect(check.kind).toBe('accepted');
  });
});
