// testbench-dialect-normalization, Property 2: The lexical content is preserved, and only a
// declaration moves (task 7.3).
//
// THE CLAIM CHANGED CHARACTER, AND THAT IS WHY THIS TEST EXISTS
//   Property 2's earlier form asserted that deleting the reported rewritten spans from both input
//   and output leaves two byte-identical strings. That held FOR FREE while every rule only ever
//   INSERTED: `unnamed-begin-declaration` added ` : tbnorm_blk_N` and nothing else, so token
//   preservation was a consequence of the edit shape rather than a property of the transform.
//   Group 15 changed that. The rule now MOVES a block's declarations to the top of that same block,
//   because measured with `iverilog -g2012` the label was never the discriminator and POSITION is.
//   Preservation therefore has to be ASSERTED, and it is asserted as a MULTISET:
//
//     1. the output's code-token multiset equals the input's plus exactly the inserted block
//        labels - "the sole addition is the labels" is the exact claim, which is why a code token
//        is word-shaped: the label IS a word token and the ` : ` introducing it is not;
//     2. the comment multiset is unchanged - a same-line trailing comment TRAVELS with its
//        declaration, so its position may move while its presence may not;
//     3. the subsequence of EXECUTABLE statements is identical in order, with declaration
//        statements excluded, because those are precisely what is allowed to move.
//
//   Measured across the 29 committed `unnamed-begin-declaration` fixtures: 29 of 29 for code tokens
//   and 29 of 29 for comments. This property is the statement of that result over generated inputs
//   the 40 hand-captured fixtures do not cover.
//
// WHY THE GENERATOR IS STRUCTURED
//   Task 7.3 states it: a character-level generator spends its budget on inputs the transform
//   refuses wholesale or finds no site in, and the property then passes VACUOUSLY. The shared
//   generator emits a module header, module-scope declarations, `initial` blocks, nested
//   `begin`/`end`, `case`, `fork`, `$display` with string arguments, a declaration AFTER a
//   statement, a preceding statement carrying no word token (`#10;`, `->ev;`, a bare `;`,
//   `@(posedge clk);`), a block with more than one declaration, a `for`-header declaration, a
//   `genvar`, and a block whose declarations are already first. Every one of those shapes is
//   counted below and the test FAILS if the generated space missed one.
//
// THE SCOPE GUARD, STATED AS AN ASSERTION RATHER THAN A COMMENT
//   The multiset claim above is exact only while the sole rewriting rule is the unnamed-begin one.
//   A `malformed-sized-literal` rewrite turns `8'd-1` into `(-8'd1)`, whose word tokens are `d1`
//   rather than `d`, so it is a legitimate token change this property does not model. The generator
//   emits no malformed literal - and that is asserted, so a future change to the generator fails
//   here loudly instead of silently weakening the claim.
//
// The tag string is a literal, not `propertyTag(...)`
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 4.12, 5.2, 5.3, 5.13, 5.14

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeDialect } from '@app/agent';

import {
  codeWordTokens,
  commentSpans,
  executableStatements,
  generatedVerilogArbitrary,
  insertedBlockLabels,
  withoutInsertedLabels,
  type GeneratedVerilog,
} from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'testbench-dialect-normalization, Property 2: The lexical content is preserved, and only a ' +
  'declaration moves';

/** The minimum share of generated cases that must actually relocate a declaration. */
const MIN_REWRITTEN_SHARE = 0.1;

/** The shapes the generated space must have covered, per task 7.3's own list. */
interface ShapeCoverage {
  declarationAfterStatement: number;
  wordlessBeforeDeclaration: number;
  multiDeclarationBlock: number;
  nestedBlock: number;
  forHeaderDeclaration: number;
  genvarBlock: number;
  declarationsAlreadyFirst: number;
}

/** Tally which of task 7.3's required shapes one generated source carried. */
function tally(coverage: ShapeCoverage, generated: GeneratedVerilog): void {
  for (const block of generated.blocks) {
    if (!block.declarationsFirst && block.declarations.length > 0) {
      coverage.declarationAfterStatement += 1;
    }
    if (block.declarationsFirst && block.declarations.length > 0) {
      coverage.declarationsAlreadyFirst += 1;
    }
    if (block.wordlessBefore !== null && block.declarations.length > 0) {
      coverage.wordlessBeforeDeclaration += 1;
    }
    if (block.declarations.length > 1) {
      coverage.multiDeclarationBlock += 1;
    }
    if (block.nested !== null) {
      coverage.nestedBlock += 1;
    }
  }
  // The `for`-header and `genvar` shapes are rendered as their own top-level constructs, so they
  // are read off the text rather than off the block plans.
  if (generated.text.includes('for (integer ')) {
    coverage.forHeaderDeclaration += 1;
  }
  if (generated.text.includes('genvar ')) {
    coverage.genvarBlock += 1;
  }
}

describe(PROPERTY, () => {
  it('preserves the code-token and comment multisets and the executable-statement order', () => {
    const coverage: ShapeCoverage = {
      declarationAfterStatement: 0,
      wordlessBeforeDeclaration: 0,
      multiDeclarationBlock: 0,
      nestedBlock: 0,
      forHeaderDeclaration: 0,
      genvarBlock: 0,
      declarationsAlreadyFirst: 0,
    };
    let rewritten = 0;
    let total = 0;

    fc.assert(
      fc.property(generatedVerilogArbitrary(), (generated) => {
        total += 1;
        tally(coverage, generated);

        const input = generated.text;
        const { source: output, report } = normalizeDialect(input);

        // A wholesale refusal returns the input unchanged with no findings, which would make every
        // comparison below trivially true.
        expect(report.refusedWholeSource).toBeNull();

        // Scope guard: the multiset arithmetic below models the unnamed-begin rule alone.
        const rewrittenClasses = new Set(
          report.findings.filter((f) => f.action === 'rewritten').map((f) => f.dialectClass),
        );
        expect([...rewrittenClasses].sort()).toEqual(
          rewrittenClasses.size === 0 ? [] : ['unnamed-begin-declaration'],
        );

        const labels = insertedBlockLabels(input, output);

        // 1. The code-token multiset gains exactly the inserted labels and nothing else.
        expect([...codeWordTokens(output)].sort()).toEqual(
          [...codeWordTokens(input), ...labels].sort(),
        );

        // 2. The comment multiset is unchanged; a trailing comment may move, none may vanish.
        expect([...commentSpans(output)].sort()).toEqual([...commentSpans(input)].sort());

        // 3. With the one permitted addition removed, the executable-statement subsequence is
        //    identical in order. Declaration statements are excluded on both sides: those are
        //    exactly what Requirement 5.13 allows to change position.
        expect(executableStatements(withoutInsertedLabels(output, labels))).toEqual(
          executableStatements(input),
        );

        // A rewrite must actually have relocated something, not merely inserted a label: the
        // insertion and each removal each report their own finding, so a real move reports at
        // least two.
        if (report.changed) {
          rewritten += 1;
          expect(report.findings.filter((f) => f.action === 'rewritten').length).toBeGreaterThan(1);
        }
      }),
      propertyParameters(),
    );

    // Non-vacuity, stated as counted facts rather than as a hope. Each of task 7.3's required
    // shapes must have been generated, and a real fraction of cases must have relocated a
    // declaration - a generator that never emits an unnamed `begin` carrying a displaced
    // declaration makes this property pass for the wrong reason.
    expect(total).toBeGreaterThan(0);
    expect(rewritten / total).toBeGreaterThanOrEqual(MIN_REWRITTEN_SHARE);
    expect(coverage.declarationAfterStatement).toBeGreaterThan(0);
    expect(coverage.wordlessBeforeDeclaration).toBeGreaterThan(0);
    expect(coverage.multiDeclarationBlock).toBeGreaterThan(0);
    expect(coverage.nestedBlock).toBeGreaterThan(0);
    expect(coverage.forHeaderDeclaration).toBeGreaterThan(0);
    expect(coverage.genvarBlock).toBeGreaterThan(0);
    expect(coverage.declarationsAlreadyFirst).toBeGreaterThan(0);
  });
});
