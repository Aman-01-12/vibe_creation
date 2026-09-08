// Unit tests for resolving a problem selection against the scored corpus.
//
// The important refusal: a selection that matches nothing must FAIL, not produce a run that
// finishes instantly and reports pass@k over zero problems - which reads like a completed
// experiment and is the most misleading possible output.

import { describe, expect, it } from 'vitest';

import type { Spec } from '@app/core';

import type { EvalProblem } from '../problem.js';
import { selectProblems } from './problem-selection.js';

/** One scored problem with a real-shaped RTLLM id. */
function problem(id: string): EvalProblem {
  return { id, title: id, source: 'RTLLM', spec: {} as Spec, intentSummary: '' };
}

const SCORED: readonly EvalProblem[] = [
  problem('rtllm/arithmetic/adder_8bit'),
  problem('rtllm/arithmetic/multi_16bit'),
  problem('rtllm/control/counter_12'),
  problem('rtllm/memory/fifo'),
];

/** Select and assert success. */
function selectOk(selection: Parameters<typeof selectProblems>[1]): readonly EvalProblem[] {
  const result = selectProblems(SCORED, selection);
  if (!result.ok) {
    throw new Error(`expected a valid selection: ${result.error.message}`);
  }
  return result.value;
}

describe('selectProblems', () => {
  it('selects the whole scored corpus for kind "all"', () => {
    expect(selectOk({ kind: 'all' })).toEqual(SCORED);
  });

  it('selects an explicit id list', () => {
    const selected = selectOk({ kind: 'ids', ids: ['rtllm/memory/fifo'] });
    expect(selected.map((entry) => entry.id)).toEqual(['rtllm/memory/fifo']);
  });

  it('returns ids in CORPUS order, not the order the config listed them', () => {
    const selected = selectOk({
      kind: 'ids',
      ids: ['rtllm/memory/fifo', 'rtllm/arithmetic/adder_8bit'],
    });
    expect(selected.map((entry) => entry.id)).toEqual([
      'rtllm/arithmetic/adder_8bit',
      'rtllm/memory/fifo',
    ]);
  });

  it('selects by category, derived from the stable problem id', () => {
    const selected = selectOk({ kind: 'categories', categories: ['Arithmetic'] });
    expect(selected.map((entry) => entry.id)).toEqual([
      'rtllm/arithmetic/adder_8bit',
      'rtllm/arithmetic/multi_16bit',
    ]);
  });

  it('selects across several categories', () => {
    expect(selectOk({ kind: 'categories', categories: ['Control', 'Memory'] })).toHaveLength(2);
  });
});

describe('selectProblems - refusals', () => {
  it('names every id that is not in the scored corpus', () => {
    const result = selectProblems(SCORED, {
      kind: 'ids',
      ids: ['rtllm/arithmetic/adder_8bit', 'rtllm/control/ring_counter'],
    });
    if (result.ok) {
      throw new Error('expected the selection to be refused');
    }
    expect(result.error.message).toContain('rtllm/control/ring_counter');
    expect(result.error.message).not.toContain('adder_8bit');
  });

  it('refuses a category with no scored designs rather than running nothing', () => {
    const result = selectProblems(SCORED, {
      kind: 'categories',
      categories: ['Miscellaneous'],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses when the scored corpus itself is empty, and names the fetch command', () => {
    const result = selectProblems([], { kind: 'all' });
    if (result.ok) {
      throw new Error('expected the selection to be refused');
    }
    expect(result.error.message).toContain('corpus:fetch');
  });
});
