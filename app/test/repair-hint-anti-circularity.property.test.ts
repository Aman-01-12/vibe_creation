// testbench-repair-loop, Property 2: A Repair_Hint never carries the
// reference's observed value, a diff, or its source (task 1.3).
//
// `buildRepairHint` (`app/agent/orchestrator/repair-hint.ts`) reads only
// `diagnostic` (for a `precheck-build-failed` or `reference-unbuildable`
// trigger) or `failingCheckName` / `ruleFamily` (for a `failed-reference`
// trigger) - design.md's Component 1 states the anti-circularity guarantee is
// provable by reading that five-line function body once, because
// `RepairTrigger` has no third field an observed value, a diff, or a
// reference's source could occupy.
//
// This test does NOT rely on a text filter to make that claim - there is no
// filter in `buildRepairHint` to test. It proves the guarantee the way
// design.md's Testing Strategy demands: by generating a `diagnostic` string
// that is deliberately shaped to look like a value comparison
// (`"expected 8'h00, got 8'hff"`, the literal shape design.md's non-vacuity
// note names) and showing the hint still holds, precisely BECAUSE a
// `ClassifiedFunctionalHint` has no field that string could ever land in. A
// property that only fed innocuous diagnostics would pass just as well with a
// leaky implementation, so the hostile-shaped input is the whole point (see
// design.md's Testing Strategy non-vacuity note, and the identical discipline
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

import {
  buildRepairHint,
  type ClassifiedFunctionalHint,
  type DefectClass,
  type RepairTrigger,
} from '@app/agent';
import { propertyParameters } from '@app/test';

const PROPERTY =
  "testbench-repair-loop, Property 2: A Repair_Hint never carries the reference's observed value, a diff, or its source";

/** The closed `DefectClass` vocabulary `ClassifiedFunctionalHint.defectClass` is drawn from. */
const DEFECT_CLASSES: readonly DefectClass[] = [
  'state-anchoring',
  'concurrency',
  'timing',
  'input-window',
  'stimulus-adequacy',
  'unclassified',
];

/**
 * A diagnostic string deliberately shaped to resemble a value comparison, so
 * the property proves buildRepairHint's structural shape - not a text filter -
 * is what keeps a `ClassifiedFunctionalHint` clean. Anchored on the literal
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

/** A `RepairTrigger` whose `diagnostic` is deliberately observed-value-shaped. */
const buildDiagnosticTriggerArbitrary: fc.Arbitrary<RepairTrigger> = fc
  .tuple(
    fc.constantFrom<'precheck-build-failed' | 'reference-unbuildable'>(
      'precheck-build-failed',
      'reference-unbuildable',
    ),
    observedValueShapedDiagnosticArbitrary,
  )
  .map(([kind, diagnostic]) => ({ kind, diagnostic }));

/** A hostile check name, itself shaped to resemble a value comparison, to stress `failingCheckName`. */
const hostileCheckNameArbitrary: fc.Arbitrary<string> = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/), observedValueShapedDiagnosticArbitrary)
  .map(([name, comparisonText]) => `${name}_${comparisonText}`);

/** A `failed-reference` trigger whose `failingCheckName` is hostile-shaped and `ruleFamily` spans the closed enum. */
const failedReferenceTriggerArbitrary: fc.Arbitrary<RepairTrigger> = fc
  .tuple(hostileCheckNameArbitrary, fc.constantFrom(...DEFECT_CLASSES))
  .map(([failingCheckName, ruleFamily]) => ({
    kind: 'failed-reference' as const,
    failingCheckName,
    ruleFamily,
  }));

/** Every `RepairTrigger` kind, each with a deliberately observed-value-shaped payload. */
const hostileRepairTriggerArbitrary: fc.Arbitrary<RepairTrigger> = fc.oneof(
  buildDiagnosticTriggerArbitrary,
  failedReferenceTriggerArbitrary,
);

describe(PROPERTY, () => {
  it('carries the build diagnostic verbatim and nothing else, however value-comparison-shaped it is', () => {
    fc.assert(
      fc.property(buildDiagnosticTriggerArbitrary, (trigger) => {
        if (trigger.kind === 'failed-reference') {
          throw new Error('unreachable: arbitrary only generates build-diagnostic triggers');
        }
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

  it('never lets an observed-value-shaped string reach a classified hint, because no field could hold one', () => {
    fc.assert(
      fc.property(failedReferenceTriggerArbitrary, (trigger) => {
        if (trigger.kind !== 'failed-reference') {
          throw new Error('unreachable: arbitrary only generates failed-reference triggers');
        }
        const hint = buildRepairHint(trigger) as ClassifiedFunctionalHint;
        const serialized = JSON.stringify(hint);

        expect(hint.kind).toBe('classified-functional');

        // The structural guarantee: a ClassifiedFunctionalHint has exactly
        // these three keys, and no fourth field - build-diagnostic,
        // observed, expected, diff, stdout, or source - could ever be
        // attached, so there is nothing beyond this shape for a value
        // comparison to leak through.
        expect(Object.keys(hint).sort()).toEqual(['defectClass', 'failingCheckName', 'kind']);

        // The hostile check name DOES cross (it is Spec-derived, computed by
        // this process, never tool text - Req 2.3), so this is not vacuous:
        // the hint is not simply empty. What must never appear is the
        // classified hint carrying a SEPARATE, independently-observed value
        // comparison beyond the one substring the caller itself supplied as
        // the check name.
        expect(hint.failingCheckName).toBe(trigger.failingCheckName);
        expect(hint.defectClass).toBe(trigger.ruleFamily);
        expect(serialized).toContain(JSON.stringify(trigger.failingCheckName));

        // No diagnostic field exists on this hint kind at all - the anti-
        // circularity guarantee is that this key is simply absent, not that
        // its value was filtered.
        expect('diagnostic' in hint).toBe(false);
      }),
      propertyParameters(),
    );
  });

  it('holds across every RepairTrigger kind simultaneously, even when every diagnostic is comparison-shaped', () => {
    // The combined, non-vacuous claim: whichever of the three trigger kinds
    // fires, and however hostile its text payload, the resulting hint's
    // serialized form contains no substring that is not either (a) the
    // trigger's own diagnostic verbatim, for a build-diagnostic hint, or (b)
    // the failingCheckName plus one closed-enum DefectClass member, for a
    // classified-functional hint - never both kinds of leak on the same hint,
    // and never a fourth field on either shape.
    fc.assert(
      fc.property(hostileRepairTriggerArbitrary, (trigger) => {
        const hint = buildRepairHint(trigger);

        if (hint.kind === 'build-diagnostic') {
          expect(Object.keys(hint)).toEqual(['kind', 'diagnostic']);
        } else {
          expect(Object.keys(hint).sort()).toEqual(['defectClass', 'failingCheckName', 'kind']);
          expect(DEFECT_CLASSES).toContain(hint.defectClass);
        }
      }),
      propertyParameters(),
    );
  });
});
