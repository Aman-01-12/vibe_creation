// The independently generated, spec-derived Testbench.
//
// Invariant encoded here: `sourceAttribution` is always the literal `"spec"`
// (Req 7.2, 7.7). This is unrepresentable-by-construction two ways: the field
// type is the literal `'spec'` (no other value type-checks), and `makeTestbench`
// takes no attribution input and always stamps `'spec'`. There is no code path
// that can attribute a Testbench to the RTL.

import type { Ulid } from './identifier.js';

/** An independently generated testbench derived solely from the Spec. */
export interface Testbench {
  readonly id: Ulid;
  readonly specId: Ulid;
  readonly specVersion: number;
  /** Verilog stimulus plus per-check pass/fail signalling. */
  readonly source: string;
  /** Always `"spec"`; never `"rtl"` (Req 7.2). */
  readonly sourceAttribution: 'spec';
  /** AcceptanceCriterion ids this testbench exercises. */
  readonly coversCriteria: readonly Ulid[];
}

/**
 * Construct a `Testbench`, stamping the source attribution as `"spec"`.
 *
 * The input intentionally has no attribution field, so a caller cannot request
 * any other attribution.
 */
export function makeTestbench(input: {
  readonly id: Ulid;
  readonly specId: Ulid;
  readonly specVersion: number;
  readonly source: string;
  readonly coversCriteria: readonly Ulid[];
}): Testbench {
  return {
    id: input.id,
    specId: input.specId,
    specVersion: input.specVersion,
    source: input.source,
    sourceAttribution: 'spec',
    coversCriteria: input.coversCriteria,
  };
}
