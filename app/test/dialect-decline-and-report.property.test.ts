// testbench-dialect-normalization, Property 8: A rewrite the transform cannot establish is declined
// and reported, never attempted (task 7.7).
//
// WHAT THIS ASSERTS
//   For any source text - including one carrying each of the eight shapes design.md's Property 8
//   enumerates - the transform returns WITHOUT THROWING, the returned source is BYTE-IDENTICAL to
//   the input at every site it declined, and every declined site APPEARS IN THE REPORT under its
//   `DialectClass` with a `declinedBecause` cause.
//
//   Sources the Testbench_Precheck would have ADMITTED unchanged are generated alongside the ones it
//   would have refused, so meaning preservation is asserted over every input rather than only over
//   failing ones. The admitted case is a source whose declarations already precede their block's
//   first statement, which the group-15 measurement pinned as accepted by `iverilog -g2012` named or
//   unnamed - so "the toolchain would have admitted it" is a measured reading rather than an
//   assumption.
//
// THE TWO LEXICAL SHAPES REPORT THROUGH `refusedWholeSource`, NOT THROUGH A FINDING
//   An unterminated block comment and an unterminated string literal leave `SourceMask.endMode` in a
//   non-code mode, and task 4.5 specifies exactly what happens then: the WHOLE source is refused
//   with `refusedWholeSource: 'lexically-malformed'`, `findings` empty, the source returned
//   byte-identical. A whole-source refusal has no `DialectClass`, so reading Property 8's "under its
//   DialectClass with a declinedBecause cause" as binding on these two would contradict the task
//   that specified them. This test therefore grades those two against `refusedWholeSource` - the
//   report of the decline, in the form the design gave it - and grades the other six against a
//   finding. That is an interpretation, stated rather than assumed.
//
// NON-VACUITY
//   The case space is a closed `constantFrom` union plus the generated admissible source, so every
//   shape is reachable, and the observed-kind set is asserted to equal the full set after the run -
//   a shape the generated space never actually produced fails the test rather than passing silently.
//
// THIS TEST WAS RED, AND THE RED WAS THE FINDING - FIXED IN GROUP 16
//   `hash-preceded-literal` FAILED. Measured against the compiled transform, a decimal sized literal
//   whose nearest preceding non-whitespace code character is `#` was declined SILENTLY: the source
//   came back byte-identical, which Property 8's first two conjuncts require, and the report
//   carried NO finding at all, which its third conjunct forbids. `planSizedLiteralRewrites` returned
//   `null` on that branch, and `null` yields neither an edit nor a `DialectFinding`.
//
//   Minimal reproducing input (the whole source, 3 lines of body):
//
//       module tbnorm_expr_tb;
//         integer acc;
//         initial begin : body
//           #8'd-1 acc = 0;
//         end
//       endmodule
//
//   Observed then: `report.refusedWholeSource === null`, `report.findings === []`, source unchanged.
//
//   Why it mattered rather than being cosmetic: the per-class decline counts this spec's
//   Requirements 1 through 3 exist to make trustworthy are aggregated from these findings, so a
//   silently declined site is an undercount of exactly the kind the 211-style accounting defect was.
//   A campaign would report fewer `malformed-sized-literal` declines than the transform actually
//   made, and nothing downstream could notice.
//
//   The fix closed the gap rather than narrowing the claim: the `#` branch now returns a zero-width
//   `SpanEdit` carrying a `declined` finding, the shape every other decline in that folder already
//   used. The one edit to this file was to make its `hash-preceded-literal` row demand a STRICTER
//   answer - `rewrite-context-not-established` instead of `value-not-determinable` - because the
//   value at that site is `-1` in the plainest possible text and the rule declines on the adjacency,
//   so the original row would have graded a true decline against a false reason.
//
// The tag string is a literal, not `propertyTag(...)`
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 4.11, 4.13, 4.14, 5.4, 5.7, 5.12, 9.8, 9.11

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeDialect, type DialectClass, type DialectDeclineCause } from '@app/agent';

import { alreadyFirstVerilogArbitrary, wrapStatement } from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'testbench-dialect-normalization, Property 8: A rewrite the transform cannot establish is ' +
  'declined and reported, never attempted';

/** What the report must say about one declined case. */
type Expectation =
  /** The whole source refused, `findings` empty (task 4.5's form for a lexically malformed input). */
  | { readonly form: 'whole-source-refusal' }
  /** One reported site, under this class and this cause. */
  | {
      readonly form: 'declined-site';
      readonly dialectClass: DialectClass;
      readonly declinedBecause: DialectDeclineCause;
    }
  /** Nothing to decline and nothing to rewrite: the Precheck would have admitted it unchanged. */
  | { readonly form: 'no-finding' };

/** One generated case: a named shape, its source, and what the report must say. */
interface DeclineCase {
  readonly kind: string;
  readonly source: string;
  readonly expectation: Expectation;
}

/** An unterminated block comment: `endMode` never returns to code. */
const UNTERMINATED_BLOCK_COMMENT = `module tbnorm_decline_tb;
  /* this comment never closes
  initial begin
    acc = 0;
    integer d1;
  end
endmodule
`;

/** An unterminated string literal: `endMode` never returns to code. */
const UNTERMINATED_STRING = `module tbnorm_decline_tb;
  initial begin
    $display("this string never closes);
    integer d1;
  end
endmodule
`;

/** A `begin` whose matching `end` the source runs out before reaching. */
const UNBALANCED_BEGIN = `module tbnorm_decline_tb;
  initial begin
    acc = 0;
    integer d1;
endmodule
`;

/** A block whose declared name is already declared at module scope (Req 5.4). */
const SHADOWS_MODULE_SCOPE = `module tbnorm_decline_tb;
  reg shared_name;
  initial begin
    acc = 0;
    reg shared_name;
  end
endmodule
`;

/** A block whose only block-item declaration is a `genvar`, which no position rescues. */
const GENVAR_ONLY = `module tbnorm_decline_tb;
  initial begin
    acc = 0;
    genvar g1;
  end
endmodule
`;

/**
 * The eight shapes design.md's Property 8 enumerates, each as one case.
 *
 * `hash-preceded-literal` is the `#`-adjacency decline `planSizedLiteralRewrites` documents as "the
 * only case this rule declines by context rather than by the literal's own text". It is graded here
 * exactly as Property 8 states the claim, because weakening a property to make it pass is the one
 * thing this suite exists to prevent.
 */
const STATIC_CASES: readonly DeclineCase[] = Object.freeze([
  {
    kind: 'unterminated-block-comment',
    source: UNTERMINATED_BLOCK_COMMENT,
    expectation: { form: 'whole-source-refusal' },
  },
  {
    kind: 'unterminated-string-literal',
    source: UNTERMINATED_STRING,
    expectation: { form: 'whole-source-refusal' },
  },
  {
    kind: 'unbalanced-begin',
    source: UNBALANCED_BEGIN,
    expectation: {
      form: 'declined-site',
      dialectClass: 'unnamed-begin-declaration',
      declinedBecause: 'unbalanced-block',
    },
  },
  {
    kind: 'base-followed-by-non-digit',
    source: wrapStatement("acc = 9'di;"),
    expectation: {
      form: 'declined-site',
      dialectClass: 'malformed-sized-literal',
      declinedBecause: 'value-not-determinable',
    },
  },
  {
    kind: 'decimal-number-before-brace',
    source: wrapStatement("acc = {1'b0, 64{1'b1}};"),
    expectation: {
      form: 'declined-site',
      dialectClass: 'malformed-sized-literal',
      declinedBecause: 'value-not-determinable',
    },
  },
  {
    kind: 'shadows-module-scope',
    source: SHADOWS_MODULE_SCOPE,
    expectation: {
      form: 'declined-site',
      dialectClass: 'unnamed-begin-declaration',
      declinedBecause: 'would-shadow-module-scope',
    },
  },
  {
    kind: 'genvar-only-block',
    source: GENVAR_ONLY,
    expectation: {
      form: 'declined-site',
      dialectClass: 'unnamed-begin-declaration',
      declinedBecause: 'declaration-not-relocatable',
    },
  },
  {
    kind: 'hash-preceded-literal',
    source: wrapStatement("#8'd-1 acc = 0;"),
    expectation: {
      form: 'declined-site',
      dialectClass: 'malformed-sized-literal',
      // NOT `value-not-determinable`: the value here is `-1` in the plainest possible text, and
      // the rule declines on the ADJACENCY. Group 16 gave that its own cause, so this row asks
      // for a STRICTER answer than it did while the property was red - the class and the
      // `declined` action are unchanged, and the cause now has to be the true one.
      declinedBecause: 'rewrite-context-not-established',
    },
  },
]);

/** The kind name of the generated source the Testbench_Precheck would have admitted unchanged. */
const ADMISSIBLE_KIND = 'precheck-would-have-admitted';

/** Every case kind the generated space must be observed to produce. */
const REQUIRED_KINDS: readonly string[] = Object.freeze([
  ...STATIC_CASES.map((declineCase) => declineCase.kind),
  ADMISSIBLE_KIND,
]);

/** The whole generated space: the eight declined shapes plus an admissible source. */
function declineCaseArbitrary(): fc.Arbitrary<DeclineCase> {
  return fc.oneof(
    fc.constantFrom(...STATIC_CASES),
    alreadyFirstVerilogArbitrary().map((generated): DeclineCase => ({
      kind: ADMISSIBLE_KIND,
      source: generated.text,
      expectation: { form: 'no-finding' },
    })),
  );
}

/**
 * Grades ONE case against Property 8's three conjuncts: no throw, byte-identical, reported.
 *
 * Named rather than inlined into the `fc.property` callback so the SAME grading runs over the
 * generated space and over `STATIC_CASES` exhaustively. `fc.oneof` weights the eight static shapes
 * at 1/8 of half the draws, so at `numRuns` 100 a shape is missed roughly 1 run in 100 - the
 * non-vacuity assertion below was seed-dependent, failing on an unlucky seed with nothing wrong in
 * the transform. Exhausting the closed part of the space makes coverage a fact rather than a sample,
 * and weakens no conjunct: every static shape is now graded on EVERY run instead of usually.
 */
function assertDeclineCase(declineCase: DeclineCase): void {
  // Never throws, on any input: a shape the transform cannot classify is DECLINED and
  // reported, because the only fail-safe direction for a rewriter of the measuring instrument
  // is to hand back exactly what it was given.
  expect(() => normalizeDialect(declineCase.source)).not.toThrow();
  const { source: output, report } = normalizeDialect(declineCase.source);
  // Bound to a local so the narrowing below survives into the `filter` callback: a property
  // read off the parameter is re-widened inside a closure.
  const expectation = declineCase.expectation;

  // Byte-identical: every case here is a pure decline or a clean source, so the whole source
  // is the declined site and byte-identity of the whole is the strongest available form.
  expect(output).toBe(declineCase.source);
  expect(report.changed).toBe(false);

  if (expectation.form === 'whole-source-refusal') {
    expect(report.refusedWholeSource).toBe('lexically-malformed');
    expect(report.findings).toEqual([]);
    return;
  }

  expect(report.refusedWholeSource).toBeNull();

  if (expectation.form === 'no-finding') {
    expect(report.findings).toEqual([]);
    return;
  }

  // The declined site appears in the report under its class with its cause, and no finding
  // anywhere claims a rewrite - a declined site is never also an attempted one.
  const matching = report.findings.filter(
    (finding) =>
      finding.dialectClass === expectation.dialectClass &&
      finding.action === 'declined' &&
      finding.declinedBecause === expectation.declinedBecause,
  );
  expect(matching.length).toBeGreaterThan(0);
  expect(report.findings.filter((finding) => finding.action === 'rewritten')).toEqual([]);
}

describe(PROPERTY, () => {
  it('returns without throwing, byte-identical at every declined site, and reports each one', () => {
    const observedKinds = new Set<string>();

    fc.assert(
      fc.property(declineCaseArbitrary(), (declineCase) => {
        observedKinds.add(declineCase.kind);
        assertDeclineCase(declineCase);
      }),
      propertyParameters(),
    );

    // The closed part of the space, exhaustively: the generated draws grade these too, but only the
    // ones a seed happened to draw.
    for (const declineCase of STATIC_CASES) {
      observedKinds.add(declineCase.kind);
      assertDeclineCase(declineCase);
    }

    // Non-vacuity: every one of the eight declined shapes, plus the admissible source, was actually
    // produced. The admissible source is the one kind still carried by the generated space alone, so
    // this assertion still fails if the generator stops producing it.
    expect([...observedKinds].sort()).toEqual([...REQUIRED_KINDS].sort());
  });
});
