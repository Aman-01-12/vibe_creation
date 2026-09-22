// testbench-repair-loop, Property 3: A compiler diagnostic crosses verbatim
// (task 1.4).
//
// `buildRepairHint` (`app/agent/orchestrator/repair-hint.ts`) is a short, pure,
// total function over `RepairTrigger`. This property states its claim,
// independent of task 1.3's Property 2 (which is about the SERIALIZED text
// never leaking a value-shaped substring): for a `precheck-build-failed`
// trigger, the resulting `RepairHint.diagnostic` is BYTE-IDENTICAL to the
// trigger's own `diagnostic` field - not merely a superstring or a lossy copy.
//
// Testbench-dialect-normalization task 10.3 retired the `reference-unbuildable`
// and `failed-reference` trigger points along with control-triggered repair
// itself (tasks 10.1, 10.2): `RepairTrigger` now has exactly one member, so
// this file narrows to the one shape left to test.
//
// Validates: Requirements 2.1, 2.2

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildRepairHint, type RepairTrigger } from '@app/agent';
import { propertyParameters } from './property.js';

const PROPERTY = 'testbench-repair-loop, Property 3: A compiler diagnostic crosses verbatim';

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
});
