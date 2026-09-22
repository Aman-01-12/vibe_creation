// testbench-dialect-normalization, Property 27: A relocated declaration stays in its own block,
// ahead of that block's first statement, in its original relative order (task 15.6).
//
// WHY THIS PROPERTY IS THE ONE THAT MATTERS MOST IN THIS SPEC
//   The `unnamed-begin-declaration` rule changed CHARACTER in group 15. It used to only INSERT
//   ` : tbnorm_blk_N`, so meaning preservation held by construction and needed no assertion. It was
//   then measured at 0 of 29 fixtures fixed: the label was never the discriminator, POSITION is. The
//   rule now MOVES a block's declarations, which lifted the class to a measured 25 of 29 - and moving
//   text is the one thing a transform over the MEASURING INSTRUMENT must be held to account for. The
//   only evidence before this test was 40 hand-captured fixtures. This is the statement of the claim
//   over the shapes those 40 do not contain.
//
// THE THREE CLAIMS, AND WHY EACH IS SEPARATELY LOAD-BEARING
//   1. INSIDE ITS OWN BLOCK. Hoisting a declaration OUT of its block also compiles, and is forbidden:
//      it widens the identifier's scope and can alias what the model wrote as two sibling block-local
//      counters into one shared name, while still compiling and still printing check lines. 3 of the
//      26 measured blocks carry a declaration in a NESTED block that must move to the top of THEIR
//      OWN block, so this is the discrimination the rule is actually tested on. It is asserted with
//      the INNERMOST enclosing extent, because a declaration hoisted one level out would still sit
//      inside the outer extent and only the innermost reading catches it.
//   2. AHEAD OF THE FIRST STATEMENT. That is the whole fix. Measured with `iverilog -g2012`, a
//      block-item declaration is accepted as the first item of its block and rejected after a
//      statement, labelled or not.
//   3. RELATIVE ORDER UNCHANGED. 19 of the 26 measured blocks carry more than one declaration, so
//      multi-declaration ordering is the common case rather than the exception, and a reordering could
//      break an initializer that reads an earlier declaration.
//
//   Plus the fourth, asserted separately because byte-identity is only checkable over a whole source:
//   a block whose declarations already precede its first statement is returned BYTE-IDENTICAL. Such a
//   block is not a defect site, and this transform rewrites the measuring instrument, so it must edit
//   only what it must.
//
// NON-VACUITY, WHICH TASK 15.6 NAMES AS THE THING THAT HID THIS DEFECT FOR A WHOLE TASK CYCLE
//   The arbitrary must include a nested block, a block with more than one declaration, a preceding
//   statement carrying no word token, a `for`-header declaration, and a `genvar` - "or the property
//   passes for the wrong reason". Each of those is COUNTED below and the test FAILS if the generated
//   space missed one, rather than being asserted by a comment claiming the generator emits them.
//
// The tag string is a literal, not `propertyTag(...)`
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 5.13, 5.14

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeDialect } from '@app/agent';

import {
  alreadyFirstVerilogArbitrary,
  generatedVerilogArbitrary,
  innermostExtentContaining,
  type BlockPlan,
  type GeneratedVerilog,
} from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'testbench-dialect-normalization, Property 27: A relocated declaration stays in its own block, ' +
  "ahead of that block's first statement, in its original relative order";

/**
 * Whether the rule relocates this block's declarations.
 *
 * A block is a site exactly when it carries at least one block-item declaration AND a statement
 * precedes one of them. Every block the shared generator emits is balanced, declares only `d<n>`
 * names that cannot shadow module scope, and carries no `genvar`, so none of the three decline causes
 * can apply - which is what makes this a total reading of the rule's own gate rather than a guess.
 */
function isMoveSite(block: BlockPlan): boolean {
  return !block.declarationsFirst && block.declarations.length > 0;
}

/** The shapes task 15.6 requires the generated space to have covered. */
interface ShapeCoverage {
  nestedSite: number;
  multiDeclarationSite: number;
  wordlessPrecededSite: number;
  forHeaderDeclaration: number;
  genvar: number;
}

/** Tally which required shapes one generated source carried. */
function tally(coverage: ShapeCoverage, generated: GeneratedVerilog): void {
  for (const block of generated.blocks) {
    if (!isMoveSite(block)) {
      continue;
    }
    if (block.declarations.length > 1) {
      coverage.multiDeclarationSite += 1;
    }
    if (block.wordlessBefore !== null) {
      coverage.wordlessPrecededSite += 1;
    }
    if (block.nested !== null && isMoveSite(block.nested)) {
      coverage.nestedSite += 1;
    }
  }
  if (generated.text.includes('for (integer ')) {
    coverage.forHeaderDeclaration += 1;
  }
  if (generated.text.includes('genvar ')) {
    coverage.genvar += 1;
  }
}

/** The offset of one block's first executable statement in `source`, or `null`. */
function firstStatementOffsetIn(source: string, block: BlockPlan): number | null {
  const marker = block.statements[0]?.marker;
  if (marker === undefined || marker === null) {
    return null;
  }
  const offset = source.indexOf(`"${marker}"`);
  return offset === -1 ? null : offset;
}

describe(PROPERTY, () => {
  it('relocates every declaration inside its own block, ahead of its first statement, in order', () => {
    const coverage: ShapeCoverage = {
      nestedSite: 0,
      multiDeclarationSite: 0,
      wordlessPrecededSite: 0,
      forHeaderDeclaration: 0,
      genvar: 0,
    };
    let sitesAsserted = 0;

    fc.assert(
      fc.property(generatedVerilogArbitrary(), (generated) => {
        tally(coverage, generated);

        const { source: output, report } = normalizeDialect(generated.text);
        expect(report.refusedWholeSource).toBeNull();

        for (const block of generated.blocks) {
          if (!isMoveSite(block)) {
            continue;
          }
          sitesAsserted += 1;

          // The block's own first statement never moves, so it is the anchor its extent and its
          // declarations are both read against.
          const firstStatement = firstStatementOffsetIn(output, block);
          expect(firstStatement).not.toBeNull();
          if (firstStatement === null) {
            return;
          }

          // Claim 1: the extent is the block's OWN innermost `begin ... end`, so a declaration
          // hoisted one level out would fall outside it.
          const extent = innermostExtentContaining(output, firstStatement);
          expect(extent).not.toBeNull();
          if (extent === null) {
            return;
          }

          const offsets: number[] = [];
          for (const declaration of block.declarations) {
            const offset = output.indexOf(declaration.text);
            // Every declaration survives verbatim, trailing comment included.
            expect(offset).toBeGreaterThanOrEqual(0);
            // Claim 1, continued: inside this block and no other.
            expect(offset).toBeGreaterThan(extent.beginStart);
            expect(offset).toBeLessThan(extent.endStart);
            // Claim 2: ahead of this block's first executable statement.
            expect(offset).toBeLessThan(firstStatement);
            offsets.push(offset);
          }

          // Claim 3: the relative source order of the declarations relocated within one block is
          // unchanged - strictly ascending in the order they were emitted.
          expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
        }
      }),
      propertyParameters(),
    );

    // Non-vacuity, counted rather than claimed. Each shape task 15.6 names as mandatory was really
    // generated, and real move sites were really asserted over.
    expect(sitesAsserted).toBeGreaterThan(0);
    expect(coverage.nestedSite).toBeGreaterThan(0);
    expect(coverage.multiDeclarationSite).toBeGreaterThan(0);
    expect(coverage.wordlessPrecededSite).toBeGreaterThan(0);
    expect(coverage.forHeaderDeclaration).toBeGreaterThan(0);
    expect(coverage.genvar).toBeGreaterThan(0);
  });

  it('returns a source whose declarations already precede their first statement byte-identical', () => {
    let blocksWithDeclarations = 0;
    let nestedBlocks = 0;

    fc.assert(
      fc.property(alreadyFirstVerilogArbitrary(), (generated) => {
        for (const block of generated.blocks) {
          if (block.declarations.length > 0) {
            blocksWithDeclarations += 1;
          }
          if (block.nested !== null) {
            nestedBlocks += 1;
          }
        }

        const { source: output, report } = normalizeDialect(generated.text);

        // Not a defect site: measured, a block-item declaration is ACCEPTED as the first item of its
        // block whether or not the block carries a label, so the label would buy nothing from the
        // deterministic oracle and the rule must not touch the source at all.
        expect(output).toBe(generated.text);
        expect(report.changed).toBe(false);
        expect(report.refusedWholeSource).toBeNull();
        // Nothing is reported either: no decline cause applies to these blocks, so a finding here
        // would mean the rule misread one of them.
        expect(report.findings).toEqual([]);
      }),
      propertyParameters(),
    );

    // Byte-identity over a source with no declarations at all would be trivially true.
    expect(blocksWithDeclarations).toBeGreaterThan(0);
    expect(nestedBlocks).toBeGreaterThan(0);
  });
});
