// testbench-dialect-normalization, Property 6: An unnamed declaring block is named, with a name
// that collides with nothing in the input (task 7.5).
//
// WHAT THIS ASSERTS
//   Every `tbnorm_blk_<n>` name the transform inserts is absent from the set of ALL
//   identifier-shaped tokens in the INPUT text - code spans and non-code spans alike - and all names
//   inserted in one call are pairwise distinct. And whenever the report says a block was rewritten,
//   the output really carries `begin : <label>`, so "is named" is asserted rather than assumed.
//
// WHY THE INPUT'S NON-CODE SPANS COUNT
//   Requirement 5.5 is a claim over the RAW text, not over code. A name mentioned in a comment or
//   inside a `$display` string is still a name a reader will see and a future edit may promote to
//   code, so minting it as a fresh block label is unsafe even though the parser never sees it. The
//   production reader (`takenIdentifiersOf` in `normalizer.ts`) is deliberately unfiltered by the
//   mask for that reason, and this test reads the same way.
//
// WHY THE ARBITRARY PLANTS REAL COLLISIONS
//   Task 7.5 states it: an arbitrary that never contains `tbnorm_blk_1` never exercises "collides
//   with nothing" against a collision at all, and the property passes because the first candidate
//   was always free. The variants below are a closed `constantFrom` list, so the generated space is
//   GUARANTEED - not merely likely - to include a source already declaring `tbnorm_blk_1`, one
//   declaring both `tbnorm_blk_1` and `tbnorm_blk_2`, one mentioning `tbnorm_blk_1` only inside a
//   comment, and one carrying all three. The counted guards below fail the test if a collision
//   variant never actually met a rewrite.
//
// WHAT THIS PROPERTY NO LONGER CLAIMS, AND WHY
//   design.md's Property 6 opens with "for any source containing an unnamed `begin` block that
//   carries at least one declaration ... the corresponding block in the output carries a `: label`".
//   Group 15 narrowed that: a block whose declarations ALREADY precede its first statement is
//   accepted by the toolchain named or not, so it is not a defect site and is left byte-identical -
//   the label would buy nothing from the deterministic oracle, and this transform rewrites the
//   measuring instrument. The naming claim is therefore asserted in its post-group-15 form: every
//   block the report says it REWROTE carries a label. The fixture suite pins the population-level
//   count (25 of 29).
//
// The tag string is a literal, not `propertyTag(...)`
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 4.9, 5.5

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeDialect } from '@app/agent';

import {
  allIdentifierTokens,
  generatedVerilogArbitrary,
  insertedBlockLabels,
} from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'testbench-dialect-normalization, Property 6: An unnamed declaring block is named, with a name ' +
  'that collides with nothing in the input';

/** The module header the collision preamble is spliced after; asserted present on every case. */
const MODULE_HEADER = 'module tbnorm_generated_tb;\n';

/** One way a source can already be using the names the transform would like to mint. */
interface CollisionVariant {
  readonly name: string;
  /** Lines spliced in just after the module header. */
  readonly lines: readonly string[];
  /** The labels this variant makes unavailable. */
  readonly taken: readonly string[];
}

/**
 * The closed collision space, so every shape is guaranteed to be generated.
 *
 * `reg tbnorm_blk_1;` at module scope cannot cause a `would-shadow-module-scope` decline for any
 * generated block, because every generated block declares only `d<n>` names - so a collision variant
 * suppresses no rewrite and the non-collision claim is exercised on blocks that really are rewritten.
 */
const COLLISION_VARIANTS: readonly CollisionVariant[] = Object.freeze([
  { name: 'none', lines: [], taken: [] },
  { name: 'declares-blk-1', lines: ['  reg tbnorm_blk_1;'], taken: ['tbnorm_blk_1'] },
  {
    name: 'declares-blk-1-and-2',
    lines: ['  reg tbnorm_blk_1;', '  reg tbnorm_blk_2;'],
    taken: ['tbnorm_blk_1', 'tbnorm_blk_2'],
  },
  {
    name: 'mentions-blk-1-in-a-comment',
    lines: ['  // an earlier pass already used tbnorm_blk_1 here'],
    taken: ['tbnorm_blk_1'],
  },
  {
    name: 'all-three',
    lines: [
      '  reg tbnorm_blk_1;',
      '  reg tbnorm_blk_2;',
      '  // and tbnorm_blk_1 is named in this comment too',
    ],
    taken: ['tbnorm_blk_1', 'tbnorm_blk_2'],
  },
]);

describe(PROPERTY, () => {
  it('mints labels absent from every input token, pairwise distinct, on every rewritten block', () => {
    /** Collision variants observed actually meeting a rewrite, by variant name. */
    const collidedAndRewrote = new Set<string>();
    let rewritten = 0;
    let total = 0;

    fc.assert(
      fc.property(
        generatedVerilogArbitrary(),
        fc.constantFrom(...COLLISION_VARIANTS),
        (generated, variant) => {
          total += 1;

          expect(generated.text).toContain(MODULE_HEADER);
          const input =
            variant.lines.length === 0
              ? generated.text
              : generated.text.replace(
                  MODULE_HEADER,
                  `${MODULE_HEADER}${variant.lines.join('\n')}\n`,
                );

          // The collision is real: every name the variant claims to take is present in the input.
          const inputTokens = new Set(allIdentifierTokens(input));
          for (const taken of variant.taken) {
            expect(inputTokens.has(taken)).toBe(true);
          }

          const { source: output, report } = normalizeDialect(input);
          expect(report.refusedWholeSource).toBeNull();

          const labels = insertedBlockLabels(input, output);

          // Every inserted label is absent from the input's identifier tokens - which is what
          // `insertedBlockLabels` selects on - so the claim worth asserting is the converse: no
          // name the input already uses was minted, in particular none the variant took.
          for (const taken of variant.taken) {
            expect(labels).not.toContain(taken);
            expect(output).not.toContain(`begin : ${taken}`);
          }

          // Pairwise distinct within one call.
          expect(new Set(labels).size).toBe(labels.length);

          // Every label that was inserted really names a block.
          for (const label of labels) {
            expect(output).toContain(`begin : ${label}`);
          }

          const rewroteABlock = report.findings.some(
            (finding) =>
              finding.action === 'rewritten' &&
              finding.dialectClass === 'unnamed-begin-declaration',
          );
          // "Is named" in its post-group-15 form: a rewritten block carries a label.
          expect(labels.length > 0).toBe(rewroteABlock);

          if (rewroteABlock) {
            rewritten += 1;
            if (variant.taken.length > 0) {
              collidedAndRewrote.add(variant.name);
            }
          }
        },
      ),
      propertyParameters(),
    );

    // Non-vacuity: a real fraction of cases minted a label, and EVERY collision variant was
    // observed minting one against names the input had already taken.
    expect(total).toBeGreaterThan(0);
    expect(rewritten).toBeGreaterThan(0);
    expect([...collidedAndRewrote].sort()).toEqual(
      COLLISION_VARIANTS.filter((variant) => variant.taken.length > 0)
        .map((variant) => variant.name)
        .sort(),
    );
  });
});
