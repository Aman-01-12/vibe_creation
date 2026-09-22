// testbench-dialect-normalization, Property 5: The check-name set is preserved (task 7.4).
//
// WHAT THIS ASSERTS
//   For any generated Testbench source, the set of names for which `sourceEmitsCheck` holds is
//   IDENTICAL before and after the transform. No rewrite adds a check, removes one, or renames one.
//   That is the claim the whole instrument rests on: a desugaring pass that silently dropped a
//   `CHECK <name>` emission would hand the Positive_Control a testbench that compiles, passes, and
//   measures less than it was generated to measure - which is exactly the
//   Check_Name_Visibility_Signal's reason for existing, and this property is the reason that signal
//   should stay quiet.
//
// `sourceEmitsCheck` IS THE OWNER OF THIS QUESTION, AND `readCheckSignals` IS NOT
//   `readCheckSignals` parses a RUN's stdout and anchors `CHECK` at the start of a line, so a
//   `$display("CHECK <name> PASS");` inside a SOURCE matches nothing and every assertion built on it
//   passes vacuously. That trap cost three red tests once already
//   (`chipAgent/_inbox/verification-recipe-dialect-fixtures-parse-alone-through-simulatoradapter-pins-0-of-29.md`).
//   `sourceEmitsCheck` is the source-side predicate and is the grader here.
//
// THE ENUMERATOR USES THE PREDICATE'S OWN GRAMMAR, FOR THE SAME REASON
//   The name universe is enumerated with `CHECK[ \t]+([A-Za-z0-9_$]+)` - the grammar
//   `sourceEmitsCheck` itself matches - rather than with a second, looser pattern. A hand-rolled
//   `CHECK\s+(\S+)\s+(?:PASS|FAIL)\b` enumerator captured `ac1_produces_the:` WITH its trailing
//   colon and the literal `<name>` out of a comment quoting the convention, and then graded those
//   captures with a predicate that ends in `\b` and cannot match either - three red tests, none of
//   them a real dropped check. Two grammars for one question is the defect; one grammar is the fix.
//   The awkward shapes are generated here on purpose so the agreement is exercised rather than
//   assumed.
//
// NON-VACUITY
//   The INPUT side is asserted too: the enumerated input names must be non-empty and must equal the
//   names the generator emitted. A source that emitted nothing would make "identical before and
//   after" true of the empty set. A counted fraction of cases must also actually be rewritten.
//
// The tag string is a literal, not `propertyTag(...)`
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 5.1, 9.9

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeDialect, sourceEmitsCheck } from '@app/agent';

import { generatedVerilogArbitrary } from './dialect-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY = 'testbench-dialect-normalization, Property 5: The check-name set is preserved';

/** The minimum share of generated cases that must actually be rewritten. */
const MIN_REWRITTEN_SHARE = 0.1;

/**
 * The anchor the awkward check texts are spliced in front of.
 *
 * The generator closes every source with a NAMED `reporting` block, so splicing just before its
 * `end` puts the awkward text where a real testbench puts its check emissions, without changing any
 * block's site status. Asserted present on every case, so a generator change that moved the anchor
 * fails here rather than silently skipping the splice.
 */
const REPORTING_BLOCK_END = '\n  end\nendmodule\n';

/**
 * The three check-text shapes that broke a hand-rolled enumerator graded by `sourceEmitsCheck`.
 *
 * Kept verbatim from the recorded failures, because their value is that they are awkward in
 * DIFFERENT ways: a name followed by a colon, the literal `<name>` inside prose quoting the
 * convention, and our own prompt prose emitted with no parseable `PASS` token adjacent.
 */
const AWKWARD_CHECK_TEXTS: readonly string[] = Object.freeze([
  '    $display("CHECK ac1_produces_the: PASS");',
  '    // the prompt asks to print "CHECK <name> PASS/FAIL"',
  '    $display("CHECK ac1_produces_the: a long piece of prose PASS");',
]);

/**
 * Every check name in `source`, read with the predicate's OWN grammar.
 *
 * Built per call: a module-level `/g` regex carries mutable `lastIndex` and sharing one across
 * scans hung this suite once
 * (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`).
 */
function enumerateCheckNames(source: string): readonly string[] {
  const pattern = /CHECK[ \t]+([A-Za-z0-9_$]+)/g;
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** A sorted, duplicate-free view of a name list, so two enumerations compare as sets. */
function nameSet(names: readonly string[]): readonly string[] {
  return [...new Set(names)].sort();
}

describe(PROPERTY, () => {
  it('holds sourceEmitsCheck identical before and after for every name either side emits', () => {
    let rewritten = 0;
    let total = 0;

    fc.assert(
      fc.property(generatedVerilogArbitrary(), fc.boolean(), (generated, withAwkwardTexts) => {
        total += 1;

        expect(generated.text).toContain(REPORTING_BLOCK_END);
        const input = withAwkwardTexts
          ? generated.text.replace(
              REPORTING_BLOCK_END,
              `\n${AWKWARD_CHECK_TEXTS.join('\n')}${REPORTING_BLOCK_END}`,
            )
          : generated.text;

        const { source: output, report } = normalizeDialect(input);
        expect(report.refusedWholeSource).toBeNull();

        // The INPUT side, asserted first: the enumerator and the generator must agree, or a
        // disagreement between two graders would masquerade below as a dropped check.
        const inputNames = enumerateCheckNames(input);
        expect(inputNames.length).toBeGreaterThan(0);
        for (const name of generated.checkNames) {
          expect(inputNames).toContain(name);
          expect(sourceEmitsCheck(input, name)).toBe(true);
        }

        // The universe spans BOTH sides, so a name the transform ADDED is caught as readily as one
        // it dropped.
        const universe = nameSet([...inputNames, ...enumerateCheckNames(output)]);
        const emittedBefore = universe.filter((name) => sourceEmitsCheck(input, name));
        const emittedAfter = universe.filter((name) => sourceEmitsCheck(output, name));
        expect(emittedAfter).toEqual(emittedBefore);

        // Every enumerated name must be findable by the predicate on the side it was read from -
        // the direct statement that the two grammars agree.
        expect(nameSet(emittedBefore)).toEqual(nameSet(inputNames));

        if (report.changed) {
          rewritten += 1;
        }
      }),
      propertyParameters(),
    );

    expect(total).toBeGreaterThan(0);
    expect(rewritten / total).toBeGreaterThanOrEqual(MIN_REWRITTEN_SHARE);
  });
});
