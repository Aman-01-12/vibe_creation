// Example tests for the committed Structural_Gate exclusion list (task 7.1).
//
// Pure data: no EDA tool, no simulator, no process spawn - every assertion here is readable
// on a host with no toolchain installed, which is the point of committing the list.

import { describe, expect, it } from 'vitest';

import {
  STRUCTURAL_GATE_EXCLUSIONS,
  STRUCTURAL_GATE_EXCLUSION_IDS,
  STRUCTURAL_GATE_EXCLUSION_NOTE,
} from './structural-gate-exclusions.js';

describe('STRUCTURAL_GATE_EXCLUSIONS - exactly the two measured refusals', () => {
  it('holds exactly float_multi and synchronizer, in that order', () => {
    expect(STRUCTURAL_GATE_EXCLUSIONS).toHaveLength(2);
    expect(STRUCTURAL_GATE_EXCLUSIONS[0]?.problemId).toBe('rtllm/arithmetic/float_multi');
    expect(STRUCTURAL_GATE_EXCLUSIONS[1]?.problemId).toBe('rtllm/miscellaneous/synchronizer');
  });

  it('records both failing checks for float_multi, because the Lint_Job cannot reach its own check', () => {
    expect(STRUCTURAL_GATE_EXCLUSIONS[0]?.failingChecks).toEqual(['lint', 'synthesis']);
  });

  it('records both failing checks for synchronizer, because the Lint_Job cannot reach its own check', () => {
    expect(STRUCTURAL_GATE_EXCLUSIONS[1]?.failingChecks).toEqual(['lint', 'synthesis']);
  });

  it('gives every entry a non-empty measured reason', () => {
    for (const entry of STRUCTURAL_GATE_EXCLUSIONS) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("records float_multi's measured Yosys error verbatim", () => {
    expect(STRUCTURAL_GATE_EXCLUSIONS[0]?.reason).toContain('Found non-synthesizable event list');
  });

  it("records synchronizer's measured Yosys error verbatim", () => {
    expect(STRUCTURAL_GATE_EXCLUSIONS[1]?.reason).toContain(
      'Multiple edge sensitive events found for this signal',
    );
  });
});

describe('STRUCTURAL_GATE_EXCLUSION_IDS - derived from the entries, never hand-maintained', () => {
  it('equals the two problem ids in entry order', () => {
    expect(STRUCTURAL_GATE_EXCLUSION_IDS).toEqual([
      'rtllm/arithmetic/float_multi',
      'rtllm/miscellaneous/synchronizer',
    ]);
  });
});

describe('STRUCTURAL_GATE_EXCLUSION_NOTE - refusal framing, not failure or limitation framing', () => {
  it('is non-empty', () => {
    expect(STRUCTURAL_GATE_EXCLUSION_NOTE.length).toBeGreaterThan(0);
  });

  it('states this is a correct refusal rather than a product limitation', () => {
    expect(STRUCTURAL_GATE_EXCLUSION_NOTE).toContain('refuses');
    expect(STRUCTURAL_GATE_EXCLUSION_NOTE).toContain('correct refusal');
    expect(STRUCTURAL_GATE_EXCLUSION_NOTE).not.toContain('product limitation');
  });
});
