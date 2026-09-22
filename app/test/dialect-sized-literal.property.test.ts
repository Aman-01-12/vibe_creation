// testbench-dialect-normalization, Property 7: A determinable malformed literal is rewritten,
// preserving its width and its value (task 7.6).
//
// WHAT THIS ASSERTS
//   For any malformed decimal sized literal whose intended value is determinable from its own text,
//   the output carries a form the toolchain accepts, and the output's SIZE TOKEN and MAGNITUDE
//   DIGITS are the IDENTICAL CHARACTER RUNS the input's were. Textual, not arithmetic: nothing
//   parses the literal to a number and reformats it, so width and value preservation is a fact about
//   the bytes that moved rather than a claim about this transform's arithmetic.
//
//   Leading-zero magnitudes (`8'd-007`) and leading-zero sizes (`016'd-1`) are generated on purpose,
//   because they are exactly the inputs a numeric round trip would silently normalise - `007`
//   becoming `7` preserves the VALUE and destroys the CHARACTER RUN, and the character run is what
//   the property claims. Magnitudes and widths are otherwise deliberately not round numbers, so a
//   rewrite that happened to echo a common constant cannot pass by coincidence.
//
// THE FOUR MEASURED FORMS ARE GENERATED VERBATIM
//   `16'd(-15)` and `8'd-1` are the two the calibration recorded as rewritable; `9'di` and
//   `{1'b0, 64{1'b1}}` are the two it recorded as undecidable. The generated space is a closed
//   `constantFrom` union, and the counted guards below FAIL if any of the four was never exercised.
//
// WHY THE OUTPUT IS PARENTHESIZED, WHICH THIS TEST PINS
//   The calibration table recorded the bare form `-16'd15`. A bare unary minus binds tighter than
//   every operator except `**`, so `8'd-1 ** 2` would rebind to `-(8'd1 ** 2)`. The rule emits
//   `(-16'd15)` instead, which is legal wherever a primary is legal. This test asserts the
//   parenthesized form, so a future "simplification" back to the bare form fails here.
//
// WHAT THIS PROPERTY DOES NOT CLAIM
//   The signed-base marker (`16'sd-1`) is out of scope HERE: the measured 8-sample population
//   contained none, and this task's arbitrary is specified over the `d`/`D` base alone. The dropped
//   marker this header originally recorded as an observation was a real defect and is FIXED in group
//   16 - the rule now re-emits the captured `[sS]?` run, so `16'sd-1` becomes `(-16'sd1)`. The
//   known-answer coverage for it lives in `app/agent/orchestrator/dialect/sized-literal.test.ts`,
//   alongside the `vvp` measurement that shows dropping the marker flips a comparison's verdict;
//   widening this arbitrary to generate the `s` form would be redesigning the task rather than
//   implementing it, so `rewrittenLiteralOf` below still reads the unsigned shape only.
//
// The tag string is a literal, not `propertyTag(...)`
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 4.10, 5.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeDialect } from '@app/agent';

import { wrapStatement } from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'testbench-dialect-normalization, Property 7: A determinable malformed literal is rewritten, ' +
  'preserving its width and its value';

/** Widths that are not round numbers, plus two carrying a leading zero. */
const NON_ROUND_SIZES: readonly string[] = Object.freeze([
  '3',
  '7',
  '13',
  '17',
  '23',
  '37',
  '63',
  '016',
  '007',
]);

/** Magnitudes that are not round numbers, plus two carrying a leading zero. */
const NON_ROUND_MAGNITUDES: readonly string[] = Object.freeze([
  '5',
  '11',
  '19',
  '37',
  '123',
  '999',
  '007',
  '0019',
]);

/** One generated literal case: the statement to normalize, and what must become of it. */
type LiteralCase =
  | {
      readonly kind: 'rewritable';
      readonly label: string;
      readonly literal: string;
      readonly size: string;
      readonly base: string;
      readonly magnitude: string;
    }
  | { readonly kind: 'declined'; readonly label: string; readonly literal: string };

/** The two measured rewritable forms, verbatim from the calibration table. */
const MEASURED_REWRITABLE: readonly LiteralCase[] = Object.freeze([
  {
    kind: 'rewritable',
    label: "measured 16'd(-15)",
    literal: "16'd(-15)",
    size: '16',
    base: 'd',
    magnitude: '15',
  },
  {
    kind: 'rewritable',
    label: "measured 8'd-1",
    literal: "8'd-1",
    size: '8',
    base: 'd',
    magnitude: '1',
  },
]);

/** The two measured undecidable forms, verbatim from the calibration table. */
const MEASURED_DECLINED: readonly LiteralCase[] = Object.freeze([
  { kind: 'declined', label: "measured 9'di", literal: "9'di" },
  { kind: 'declined', label: "measured {1'b0, 64{1'b1}}", literal: "{1'b0, 64{1'b1}}" },
]);

/** Every label the generated space must be observed to have produced. */
const REQUIRED_LABELS: readonly string[] = Object.freeze([
  ...MEASURED_REWRITABLE.map((measured) => measured.label),
  ...MEASURED_DECLINED.map((measured) => measured.label),
  'generated parenthesized',
  'generated bare',
]);

/** A freshly-generated rewritable literal in one of the two malformed negative forms. */
function generatedRewritableArbitrary(): fc.Arbitrary<LiteralCase> {
  return fc
    .record({
      size: fc.constantFrom(...NON_ROUND_SIZES),
      base: fc.constantFrom('d', 'D'),
      magnitude: fc.constantFrom(...NON_ROUND_MAGNITUDES),
      parenthesized: fc.boolean(),
    })
    .map(({ size, base, magnitude, parenthesized }) => ({
      kind: 'rewritable' as const,
      label: parenthesized ? 'generated parenthesized' : 'generated bare',
      literal: parenthesized ? `${size}'${base}(-${magnitude})` : `${size}'${base}-${magnitude}`,
      size,
      base,
      magnitude,
    }));
}

/** The whole generated space: the four measured forms plus freshly-generated rewritable ones. */
function literalCaseArbitrary(): fc.Arbitrary<LiteralCase> {
  return fc.oneof(
    fc.constantFrom(...MEASURED_REWRITABLE, ...MEASURED_DECLINED),
    generatedRewritableArbitrary(),
  );
}

/**
 * The rewritten literal's own size, base, and magnitude, read back out of the output.
 *
 * Read as CHARACTER RUNS rather than parsed as numbers, because "identical character runs" is the
 * claim: a reader that returned `7` for the run `007` would report the value correctly and the
 * property falsely.
 */
function rewrittenLiteralOf(
  output: string,
): { readonly size: string; readonly base: string; readonly magnitude: string } | null {
  // Built per call, non-global: a shared `/g` regex's `lastIndex` is the hazard.
  const match = /\(-(\d+)'([dD])(\d+)\)/.exec(output);
  const [, size, base, magnitude] = match ?? [];
  if (size === undefined || base === undefined || magnitude === undefined) {
    return null;
  }
  return { size, base, magnitude };
}

describe(PROPERTY, () => {
  it('rewrites a determinable literal into a parenthesized form reusing its exact runs', () => {
    const observedLabels = new Set<string>();
    let rewritten = 0;
    let declined = 0;

    fc.assert(
      fc.property(literalCaseArbitrary(), (literalCase) => {
        observedLabels.add(literalCase.label);

        const input = wrapStatement(`acc = ${literalCase.literal};`);
        const { source: output, report } = normalizeDialect(input);

        expect(report.refusedWholeSource).toBeNull();
        const literalFindings = report.findings.filter(
          (finding) => finding.dialectClass === 'malformed-sized-literal',
        );

        if (literalCase.kind === 'declined') {
          declined += 1;
          // Undecidable from its own text: reported, never guessed at, and byte-identical.
          expect(output).toBe(input);
          expect(report.changed).toBe(false);
          expect(literalFindings.length).toBeGreaterThan(0);
          for (const finding of literalFindings) {
            expect(finding.action).toBe('declined');
            expect(finding.declinedBecause).toBe('value-not-determinable');
          }
          return;
        }

        rewritten += 1;
        expect(report.changed).toBe(true);
        expect(literalFindings).toHaveLength(1);
        expect(literalFindings[0]?.action).toBe('rewritten');

        // The parenthesized form, not the bare one the calibration table recorded.
        expect(output).toContain(
          `(-${literalCase.size}'${literalCase.base}${literalCase.magnitude})`,
        );

        // The size token and the magnitude digits are the IDENTICAL character runs, read back as
        // strings so a leading zero is preserved rather than normalised away.
        const emitted = rewrittenLiteralOf(output);
        expect(emitted).not.toBeNull();
        expect(emitted?.size).toBe(literalCase.size);
        expect(emitted?.base).toBe(literalCase.base);
        expect(emitted?.magnitude).toBe(literalCase.magnitude);

        // Nothing but the literal moved: the wrapper's block is already NAMED, so no
        // unnamed-begin finding may appear alongside it.
        expect(report.findings).toHaveLength(1);
      }),
      propertyParameters(),
    );

    // Non-vacuity: both outcomes were exercised, and every one of the four measured forms plus both
    // generated forms was actually produced by the generated space.
    expect(rewritten).toBeGreaterThan(0);
    expect(declined).toBeGreaterThan(0);
    expect([...observedLabels].sort()).toEqual([...REQUIRED_LABELS].sort());
  });
});
