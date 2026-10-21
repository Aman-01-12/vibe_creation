// **Feature: timing-contract-inference, Req 4.12: the displayed timing question
// is a real sentence, not just an admissible token list** (task 8.10).
//
// WHY THE DISPLAYED TEXT, NOT JUST THE TOKENS
//   `consensus-behaviour-question.property.test.ts` already covers the GRAMMAR
//   (Property 22 and friends): a token list is well-formed and jargon-free once
//   rendered by `renderQuestion`. But `renderQuestion` joins tokens with spaces,
//   so a grammatically-admissible token list can still render as ungrammatical
//   prose with no question mark - the defect this task fixes (DQ-02). These tests
//   assert on `renderTimingQuestion`'s OUTPUT STRING, the thing a student actually
//   reads, not on the token sequence underneath it.
//
// Validates: Requirements 4.12

import { buildBehaviourQuestion, containsJargon, renderTimingQuestion } from '@app/agent';
import { type ModuleInterface } from '@app/core';
import { describe, expect, it } from 'vitest';

/** A minimal interface declaring one output port, enough for the grammar to admit it. */
function moduleInterfaceWithOutput(portName: string): ModuleInterface {
  return {
    validityOutputName: null,
    moduleName: 'm',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: portName, direction: 'output', width: 1 },
    ],
    clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
  };
}

describe('renderTimingQuestion composes the displayed sentence a student reads (Req 4.12)', () => {
  it('given the exact token shape task 8.7 builds, renders one grammatical question naming the port', () => {
    const moduleInterface = moduleInterfaceWithOutput('carry');
    const built = buildBehaviourQuestion(
      [
        { kind: 'signal', name: 'carry' },
        { kind: 'frame', id: 'output-settles-at-cycle' },
      ],
      moduleInterface,
      [],
    );
    expect(built.ok).toBe(true);
    if (!built.ok) {
      throw new Error('expected the question to build');
    }

    const rendered = renderTimingQuestion(built.value);

    expect(rendered).toBe(
      'At what point does the carry output settle relative to changes in its inputs?',
    );
    // Clause 1: names the unstated port.
    expect(rendered).toContain('carry');
    // Clause 2: ends in a question mark - renderQuestion's bare token join never produces one.
    expect(rendered.endsWith('?')).toBe(true);
    // Clause 3: no jargon leaks into the question that asks about it.
    expect(containsJargon(rendered)).toEqual([]);
  });

  it('renders a different port name without carrying over the previous one', () => {
    const moduleInterface = moduleInterfaceWithOutput('q');
    const built = buildBehaviourQuestion(
      [
        { kind: 'signal', name: 'q' },
        { kind: 'frame', id: 'output-settles-at-cycle' },
      ],
      moduleInterface,
      [],
    );
    expect(built.ok).toBe(true);
    if (!built.ok) {
      throw new Error('expected the question to build');
    }

    const rendered = renderTimingQuestion(built.value);

    expect(rendered).toBe(
      'At what point does the q output settle relative to changes in its inputs?',
    );
    expect(rendered).not.toContain('carry');
  });
});
