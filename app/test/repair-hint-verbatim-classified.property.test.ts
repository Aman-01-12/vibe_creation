// testbench-repair-loop, Property 3: A compiler diagnostic crosses verbatim;
// a functional failure never does (task 1.4).
//
// `buildRepairHint` (`app/agent/orchestrator/repair-hint.ts`) is a five-line,
// pure, total function over `RepairTrigger`. This property states its two
// halves as a single mechanical claim, independent of task 1.3's Property 2
// (which is about the SERIALIZED text never leaking a value-shaped substring):
//
//   - For a `precheck-build-failed` or `reference-unbuildable` trigger, the
//     resulting `RepairHint.diagnostic` is BYTE-IDENTICAL to the trigger's own
//     `diagnostic` field - not merely a superstring or a lossy copy.
//   - For a `failed-reference` trigger, the resulting `ClassifiedFunctionalHint`
//     has no field named `diagnostic`, `observed`, `expected`, or `stdout` AT
//     ALL - the type has no such field to populate, so this is a structural
//     fact about the shape returned, not a value comparison.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.7

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildRepairHint, type DefectClass, type RepairTrigger } from '@app/agent';
import { propertyParameters } from './property.js';

const PROPERTY =
  'testbench-repair-loop, Property 3: A compiler diagnostic crosses verbatim; a functional failure never does';

// -- Generators ---------------------------------------------------------------

/**
 * Diagnostic text varied freely, including the edge cases a real toolchain
 * diagnostic (or its absence) could plausibly take: empty, very long, and text
 * containing JSON-special characters that a naive re-serialization could
 * mangle (quotes, backslashes, newlines, control characters, unicode).
 */
const diagnosticTextArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.string({ minLength: 1, maxLength: 2000 }),
  fc.string({ unit: 'grapheme-composite', minLength: 0, maxLength: 200 }),
  fc.constantFrom(
    '{"not": "actually json", "but": "looks like it"}',
    'line one\nline two\\backslash\t"quoted"',
    '\u0000\u0001control-chars\u001f',
    'adder_16bit_tb.v:49: syntax error',
  ),
);

const defectClassArbitrary: fc.Arbitrary<DefectClass> = fc.constantFrom(
  'state-anchoring',
  'concurrency',
  'timing',
  'input-window',
  'stimulus-adequacy',
  'unclassified',
);

/** Every `RepairTrigger` kind, so the "never fires the wrong shape" half is exercised too. */
const buildDiagnosticTriggerArbitrary: fc.Arbitrary<RepairTrigger> = fc.oneof(
  diagnosticTextArbitrary.map(
    (diagnostic) =>
      ({ kind: 'precheck-build-failed' as const, diagnostic }) satisfies RepairTrigger,
  ),
  diagnosticTextArbitrary.map(
    (diagnostic) =>
      ({ kind: 'reference-unbuildable' as const, diagnostic }) satisfies RepairTrigger,
  ),
);

const failedReferenceTriggerArbitrary: fc.Arbitrary<RepairTrigger> = fc
  .tuple(fc.string({ minLength: 0, maxLength: 200 }), defectClassArbitrary)
  .map(
    ([failingCheckName, ruleFamily]) =>
      ({ kind: 'failed-reference' as const, failingCheckName, ruleFamily }) satisfies RepairTrigger,
  );

const anyTriggerArbitrary: fc.Arbitrary<RepairTrigger> = fc.oneof(
  buildDiagnosticTriggerArbitrary,
  failedReferenceTriggerArbitrary,
);

// -- Property 3 -----------------------------------------------------------------

describe(PROPERTY, () => {
  it('carries a precheck-build-failed diagnostic byte-identically into a build-diagnostic hint', () => {
    fc.assert(
      fc.property(diagnosticTextArbitrary, (diagnostic) => {
        const trigger: RepairTrigger = { kind: 'precheck-build-failed', diagnostic };
        const hint = buildRepairHint(trigger);

        expect(hint.kind).toBe('build-diagnostic');
        if (hint.kind === 'build-diagnostic') {
          expect(hint.diagnostic === diagnostic).toBe(true);
        }
      }),
      propertyParameters(),
    );
  });

  it('carries a reference-unbuildable diagnostic byte-identically into a build-diagnostic hint', () => {
    fc.assert(
      fc.property(diagnosticTextArbitrary, (diagnostic) => {
        const trigger: RepairTrigger = { kind: 'reference-unbuildable', diagnostic };
        const hint = buildRepairHint(trigger);

        expect(hint.kind).toBe('build-diagnostic');
        if (hint.kind === 'build-diagnostic') {
          expect(hint.diagnostic === diagnostic).toBe(true);
        }
      }),
      propertyParameters(),
    );
  });

  it('never populates diagnostic, observed, expected, or stdout on a classified-functional hint', () => {
    fc.assert(
      fc.property(failedReferenceTriggerArbitrary, (trigger) => {
        const hint = buildRepairHint(trigger);

        expect(hint.kind).toBe('classified-functional');
        expect('diagnostic' in hint).toBe(false);
        expect('observed' in hint).toBe(false);
        expect('expected' in hint).toBe(false);
        expect('stdout' in hint).toBe(false);
        expect(Object.keys(hint).sort()).toEqual(['defectClass', 'failingCheckName', 'kind']);
      }),
      propertyParameters(),
    );
  });

  it('routes every trigger kind to exactly the hint shape its own kind determines, over the whole trigger space', () => {
    fc.assert(
      fc.property(anyTriggerArbitrary, (trigger) => {
        const hint = buildRepairHint(trigger);

        if (trigger.kind === 'failed-reference') {
          expect(hint.kind).toBe('classified-functional');
          expect('diagnostic' in hint).toBe(false);
        } else {
          expect(hint.kind).toBe('build-diagnostic');
          if (hint.kind === 'build-diagnostic') {
            expect(hint.diagnostic === trigger.diagnostic).toBe(true);
          }
        }
      }),
      propertyParameters(),
    );
  });
});
