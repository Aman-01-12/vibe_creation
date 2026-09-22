// testbench-repair-loop, Property 2: A Repair_Hint never carries the
// reference's observed value, a diff, or its source (task 1.3).
//
// `buildRepairHint` (`app/agent/orchestrator/repair-hint.ts`) reads only
// `diagnostic` off the one remaining `RepairTrigger` shape
// (`precheck-build-failed`) - design.md's Component 1 states the
// anti-circularity guarantee is provable by reading that function body once,
// because `RepairTrigger` has no third field an observed value, a diff, or a
// reference's source could occupy.
//
// Testbench-dialect-normalization task 10.3 retired the two positive-control
// trigger points (`reference-unbuildable`, `failed-reference`) along with
// control-triggered repair itself (tasks 10.1, 10.2): `RepairTrigger` now has
// exactly one member, so this file narrows to the one shape left to test.
//
// This test does NOT rely on a text filter to make that claim - there is no
// filter in `buildRepairHint` to test. It proves the guarantee the way
// design.md's Testing Strategy demands: by generating a `diagnostic` string
// that is deliberately shaped to look like a value comparison
// (`"expected 8'h00, got 8'hff"`, the literal shape design.md's non-vacuity
// note names) and showing the hint still holds, precisely BECAUSE
// `BuildDiagnosticHint` has no field that string could ever land in beyond the
// one it is meant to carry. A property that only fed innocuous diagnostics
// would pass just as well with a leaky implementation, so the hostile-shaped
// input is the whole point (see design.md's Testing Strategy non-vacuity
// note, and the identical discipline
// `failure-attribution-containment.property.test.ts` already applies to
// Property 3 of the precedent spec).
//
// Per `gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`,
// `propertyTag()` is not called here: its `FEATURE_TAG` is hardcoded to
// `hdl-creation-loop`, a different spec's own property numbering. The tag is
// instead a literal string carrying THIS spec's slug, following
// `failure-attribution-containment.property.test.ts`'s precedent; only the
// feature-agnostic `propertyParameters()` iteration convention is reused.
//
// Validates: Requirements 2.4, 2.5, 2.6, 2.8, 9.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildRepairHint, type RepairTrigger } from '@app/agent';
import { propertyParameters } from '@app/test';

const PROPERTY =
  "testbench-repair-loop, Property 2: A Repair_Hint never carries the reference's observed value, a diff, or its source";

/**
 * A diagnostic string deliberately shaped to resemble a value comparison, so
 * the property proves buildRepairHint's structural shape - not a text filter -
 * is what keeps a `BuildDiagnosticHint` clean. Anchored on the literal
 * example design.md's non-vacuity note names (`"expected 8'h00, got 8'hff"`),
 * varied across width and hex value so the property does not merely replay one
 * fixed string.
 */
const observedValueShapedDiagnosticArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(1, 4, 8, 16, 32),
    fc.stringMatching(/^[0-9a-f]{1,8}$/),
    fc.stringMatching(/^[0-9a-f]{1,8}$/),
  )
  .map(
    ([width, expectedHex, gotHex]) => `expected ${width}'h${expectedHex}, got ${width}'h${gotHex}`,
  );

/** A `precheck-build-failed` `RepairTrigger` whose `diagnostic` is deliberately observed-value-shaped. */
const buildDiagnosticTriggerArbitrary: fc.Arbitrary<RepairTrigger> =
  observedValueShapedDiagnosticArbitrary.map((diagnostic) => ({
    kind: 'precheck-build-failed' as const,
    diagnostic,
  }));

describe(PROPERTY, () => {
  it('carries the build diagnostic verbatim and nothing else, however value-comparison-shaped it is', () => {
    fc.assert(
      fc.property(buildDiagnosticTriggerArbitrary, (trigger) => {
        const hint = buildRepairHint(trigger);
        const serialized = JSON.stringify(hint);

        expect(hint.kind).toBe('build-diagnostic');
        // Every character of the (hostile-shaped) diagnostic crosses, because
        // that text IS the toolchain's own build output - never the
        // reference's observed behaviour - and there is no OTHER field on
        // BuildDiagnosticHint for anything else to leak through.
        expect(serialized).toContain(JSON.stringify(trigger.diagnostic));
        expect(Object.keys(hint)).toEqual(['kind', 'diagnostic']);
      }),
      propertyParameters(),
    );
  });
});
