// testbench-dialect-normalization, Property 1: Non-code spans are never rewritten (task 7.2).
//
// WHAT THIS ASSERTS
//   Every generated case produces TWO sources that differ only in planted NON-CODE content: the
//   same `begin`, `end`, `integer i;`, and full `CHECK <name> PASS;` payload placed inside a line
//   comment, inside a block comment, AND inside a `$display` string argument, all in the same
//   source. Each of those is a site-triggering shape when it appears in code. None of them may be
//   one here, so the property is:
//
//     - every planted text survives the transform VERBATIM;
//     - the multiset of comment spans and the multiset of string-literal spans are unchanged;
//     - the transform reports the IDENTICAL findings for the planted source and the unplanted one,
//       class for class and cause for cause - the plants create no finding and suppress none;
//     - no `prose-as-statement` finding exists in either source, even though a complete
//       `CHECK <name> PASS;` is present three times over.
//
// WHY A TWIN SOURCE RATHER THAN A PER-OFFSET COMPARISON
//   design.md states Property 1 as "the character at that offset in the output is identical to the
//   character at that offset in the input". That reading only holds when the transform changed
//   nothing: a single inserted label shifts every later offset, so an offset-for-offset comparison
//   would fail on the very rewrite the transform exists to perform. The claim it is standing in for
//   is "no edit any rule proposes starts or ends inside a non-code span", and `SpanEdit` is
//   internal to the rules. Comparing a planted source against its unplanted twin asserts exactly
//   that on the public surface: if any rule read the plants as code, either the planted source
//   gains a finding the plain one lacks, or a plant comes back altered.
//
// NON-VACUITY
//   The plants are asserted to actually BE non-code (the comment and string multisets grow), and a
//   counted fraction of cases must actually trigger a rewrite in the unplanted source, so the
//   finding-for-finding comparison is over sources the transform really edits rather than over
//   sources it left alone. The test FAILS if no case rewrites anything.
//
// The tag string is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to
// a different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 4.12, 5.3

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeDialect, type DialectFinding } from '@app/agent';
import { scanSource } from '@app/tools';

import { commentSpans, plantedNonCodeArbitrary, stringSpans } from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY = 'testbench-dialect-normalization, Property 1: Non-code spans are never rewritten';

/** The minimum share of generated cases that must actually trigger a rewrite. */
const MIN_REWRITTEN_SHARE = 0.1;

/** A finding reduced to its claim, dropping `line` (the plants shift every later line). */
function findingClaim(finding: DialectFinding): string {
  return `${finding.dialectClass}/${finding.action}/${finding.declinedBecause ?? 'none'}`;
}

/** Every finding's claim, sorted, so two reports are comparable as multisets. */
function findingClaims(findings: readonly DialectFinding[]): readonly string[] {
  return findings.map(findingClaim).sort();
}

describe(PROPERTY, () => {
  it('leaves a planted comment, block comment, and string literal untouched and unreported', () => {
    let rewritten = 0;
    let total = 0;

    fc.assert(
      fc.property(plantedNonCodeArbitrary(), (pair) => {
        total += 1;

        const plain = normalizeDialect(pair.plain.text);
        const planted = normalizeDialect(pair.planted.text);

        // Neither source may be refused wholesale: a refusal returns the input unchanged with no
        // findings, which would make every comparison below trivially true.
        expect(plain.report.refusedWholeSource).toBeNull();
        expect(planted.report.refusedWholeSource).toBeNull();

        // The plants really ARE non-code, so the assertions below are about non-code spans rather
        // than about text that happened to be ignored for some other reason.
        expect(commentSpans(pair.planted.text).length).toBe(
          commentSpans(pair.plain.text).length + 2,
        );
        expect(stringSpans(pair.planted.text).length).toBe(stringSpans(pair.plain.text).length + 1);

        // 1. Every planted text survives verbatim.
        for (const plant of pair.plants) {
          expect(planted.source).toContain(plant);
        }

        // 2. The non-code multisets are unchanged by the transform.
        expect([...commentSpans(planted.source)].sort()).toEqual(
          [...commentSpans(pair.planted.text)].sort(),
        );
        expect([...stringSpans(planted.source)].sort()).toEqual(
          [...stringSpans(pair.planted.text)].sort(),
        );

        // 3. The plants create no finding and suppress none.
        expect(findingClaims(planted.report.findings)).toEqual(
          findingClaims(plain.report.findings),
        );

        // 4. A complete `CHECK <name> PASS;` appears three times over, and none of them is read
        //    as a statement - a Prose_As_Statement is only ever a CODE-span shape.
        const prose = planted.report.findings.filter(
          (finding) => finding.dialectClass === 'prose-as-statement',
        );
        expect(prose).toEqual([]);

        if (plain.report.changed) {
          rewritten += 1;
        }
      }),
      propertyParameters(),
    );

    // The property must be asserted over sources the transform actually edits. A generated space
    // that never plants a real site would make every comparison above hold for the wrong reason.
    expect(total).toBeGreaterThan(0);
    expect(rewritten / total).toBeGreaterThanOrEqual(MIN_REWRITTEN_SHARE);
  });
});

// testbench-failure-reportability task 3.1: the mask's own record of where each literal is.
// Validates: Requirements 5.2
describe('SourceMask.stringSpans', () => {
  it('records one span per literal, quotes included', () => {
    const source = '$display("ok" /* FAIL */); $display("b");';
    const spans = scanSource(source).stringSpans;
    expect(spans.map((span) => source.slice(span.start, span.end + 1))).toEqual(['"ok"', '"b"']);
  });

  it('does not close a literal on an escaped quote', () => {
    const source = '$display("a\\"b");';
    const mask = scanSource(source);
    expect(mask.stringSpans).toEqual([{ start: 9, end: 14 }]);
    expect(mask.endMode).toBe('code');
  });

  it('leaves the span list readable when a literal is unterminated', () => {
    const source = '$display("done"); $display("FAIL';
    const mask = scanSource(source);
    expect(mask.endMode).not.toBe('code');
    expect(mask.stringSpans).toEqual([{ start: 9, end: 14 }]);
  });
});
