// Unit tests guarding the fixed eval subset fixtures (task 19.3, Req 15.1).
//
// The subset is the version-controlled benchmark the gate ratchets against, so its
// fixtures must be well-formed: pre-approved specs, exact interfaces with
// positive-width ports, simulation-verifiable criteria, and stable unique ids.

import { describe, expect, it } from 'vitest';

import { RTLLM_CATEGORY_DIRECTORIES } from './corpus/pinned-source.js';
import { FIXED_EVAL_SUBSET } from './subset.js';

describe('FIXED_EVAL_SUBSET', () => {
  it('is a non-empty, frozen, representative set', () => {
    expect(FIXED_EVAL_SUBSET.length).toBeGreaterThan(0);
    expect(Object.isFrozen(FIXED_EVAL_SUBSET)).toBe(true);
    expect(new Set(FIXED_EVAL_SUBSET.map((p) => p.source))).toContain('VerilogEval');
    expect(new Set(FIXED_EVAL_SUBSET.map((p) => p.source))).toContain('RTLLM');
  });

  it('uses stable, unique problem ids', () => {
    const ids = FIXED_EVAL_SUBSET.map((problem) => problem.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.trim().length > 0)).toBe(true);
  });

  it('never collides with an imported RTLLM corpus id', () => {
    // The corpus imports ids shaped `rtllm/<category>/<design>`. A smoke-subset id
    // landing in that shape would let a hand-written fixture masquerade as a benchmark
    // problem in a report, and would collide in the per-sample seed derivation.
    const corpusShape = new RegExp(
      `^rtllm/(?:${RTLLM_CATEGORY_DIRECTORIES.map((name) => name.toLowerCase()).join('|')})/`,
    );
    for (const problem of FIXED_EVAL_SUBSET) {
      expect(corpusShape.test(problem.id)).toBe(false);
    }
  });

  it('carries only approved specs with exact, positive-width interfaces', () => {
    for (const problem of FIXED_EVAL_SUBSET) {
      expect(problem.spec.approved).toBe(true);
      expect(problem.spec.moduleInterface.ports.length).toBeGreaterThan(0);
      for (const port of problem.spec.moduleInterface.ports) {
        expect(Number.isInteger(port.width)).toBe(true);
        expect(port.width).toBeGreaterThan(0);
        expect(port.name.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('carries measurable, simulation-verifiable acceptance criteria', () => {
    for (const problem of FIXED_EVAL_SUBSET) {
      expect(problem.spec.acceptanceCriteria.length).toBeGreaterThan(0);
      for (const criterion of problem.spec.acceptanceCriteria) {
        expect(criterion.measurable).toBe(true);
        expect(criterion.method).toBe('simulation');
      }
    }
  });
});
