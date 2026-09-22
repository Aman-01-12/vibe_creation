---
type: verification-recipe
title: Property-testing a meaning-preserving transform that MOVES text - multiset plus statement-order, with no parser
status: candidate
provenance: testbench-dialect-normalization task group 7 and task 15.6 (app/test/dialect-*.property.test.ts, app/test/dialect-arbitraries.ts)
tags: [verification, verification-recipe, property-based, fast-check, dialect-normalizer, non-vacuity, structured-generator, app-test, tokenizer]
timestamp: 2025-06-19T12:30:00Z
verifiedBy: "npx tsc -b --force; npx eslint app --max-warnings=0; npx prettier --check .; npx vitest run (1873 passed / 6 skipped / 1 failed - the 1 failure is the Property 8 gap, see gotcha-hash-preceded-sized-literal-is-declined-silently-with-no-finding.md); npm run build"
---

# What this verifies

Eight properties over the Dialect_Normalizer: non-code spans untouched (1), lexical content preserved
with only a declaration moving (2), check-name set preserved (5), block labels that collide with
nothing (6), literal width/value preserved as CHARACTER RUNS (7), declines reported not attempted (8),
the Check_Name_Visibility_Signal's exact conjunction with non-interference (18), and the declaration
move's position/order/byte-identity claims (27).

The reason the recipe exists: the rule under test changed character. It used to only INSERT, so
preservation held by construction; it now MOVES a declaration within its block, so preservation has to
be asserted. Asserting "text moved but meaning did not" without writing a Verilog parser is the whole
problem this recipe solves.

# Independent oracle (never the model)

None of these need a simulator: they are claims about a pure text transform, graded against the
production `SourceMask` and the production predicates (`sourceEmitsCheck`, `readCheckSignals`). The
TOOLCHAIN facts they rest on (a declaration is accepted as a block's first item and rejected after a
statement; a comment is lexically whitespace) were measured earlier with `iverilog -g2012` and are
pinned by the fixture integration suite, not re-derived here. So the division is: iverilog decides what
Verilog means, these properties decide whether the transform preserved it.

# Steps

**0. Rebuild dist and READ the emitted JS before running anything.** `vitest.config.ts` declares no
`resolve.alias`, so a cross-package constant resolves through `dist/`. And `tsc -b` does NOT prune
stale outputs: a `.d.ts`/`.js` pair for a module the spec DELETED survives indefinitely and will keep
type-checking. The only reliable sequence is `rm -rf app/*/dist` (the `.tsbuildinfo` files live inside
`dist/`, so that removes them too), then `npx tsc -b --force`, then grep the emitted `.js` for each
constant you are about to assert on. Exit code 0 is not evidence.

**1. ONE tokenizer, four readers.** The dialect fixture suite already cost three red tests to two
grammars for one question graded against each other. So a single `tokensOf(source)` walk - driven by
the production `scanSource` mask - emits word tokens, single punctuation characters, and each non-code
span whole, and every reader is a filter over it: `codeWordTokens`, `commentSpans`, `stringSpans`,
`beginEndExtents`, `executableStatements`. A disagreement then surfaces as a test defect, not as a
false claim about the transform.

**2. Code token = WORD-SHAPED, over code spans only.** That makes "the sole addition is the inserted
labels" the exact claim: `tbnorm_blk_1` IS a word token and the ` : ` introducing it is not. Including
punctuation would make the `:` a second addition and the claim would no longer match what was measured.

**3. Strip the one permitted addition before comparing statement ORDER.** `begin` carries no `;`, so
the first item of a block shares a `;`-delimited fragment with the `initial` that opened it - and a
label insertion changes that fragment's text. Remove the literal ` : <label>` for each label the output
gained, then fragment. The labels are found as `tbnorm_blk_\d+` tokens present in output and absent
from the input's RAW identifier set (comments included, mirroring `takenIdentifiersOf`).

**4. Fragment on `;` AND on every block keyword, at paren depth 0. Exclude comments, KEEP strings.**
- Block keywords must separate, or step 3 is not enough.
- Paren depth 0, or a `for (integer i = 0; ...)` header splits into three and the group-15 paren-depth
  exclusion becomes invisible.
- Comments must be EXCLUDED: a same-line trailing comment TRAVELS with its declaration and a preceding
  comment line does not, so comment position is not part of a statement's identity. Including them
  produced a false failure where a travelling `// c` landed at the head of a different fragment.
- Strings must be KEPT: they are tokens the parser sees, and they are what makes each
  `$display("S7")` marker distinguishable. Without them every display statement is the identical
  fragment `$display ( )` and a reordering is invisible.
- Keep EMPTY fragments: the transform creates and destroys no `;`, so dropping them would hide a
  reordering involving only bare `;` statements.

**5. Locate positions by UNIQUE NAME, never by parsing.** Mint every declaration (`d3`) and every
statement marker (`"S7"`) uniquely in the generator, search the output with `indexOf` on the
declaration's FULL rendered text (terminator included, so `integer d1;` cannot match `integer d11;`),
and anchor each block on the offset of its own first statement marker - which never moves. Then
"inside its own block" is `innermostExtentContaining(firstStatementOffset)`, and the INNERMOST reading
is what catches a declaration hoisted one level out (it would still be inside the outer extent).

**6. Byte-identity is only checkable over a WHOLE source.** For "a block that needs no move is left
alone", generate a source where EVERY block's declarations are already first and assert the output is
`===` the input with `findings === []`. Per-block byte-identity has no well-defined subject once
another block in the same source was rewritten.

**7. Non-vacuity as COUNTED FACTS, asserted after `fc.assert`, not as a comment.** Two kinds:
- a rewritten SHARE floor (measured: 0.74-0.75 of cases actually relocate a declaration; the floor is
  pinned at 0.10 for margin), and
- a per-shape coverage tally over the list the task made mandatory (nested block, multi-declaration
  block, wordless preceding statement, `for`-header declaration, `genvar`, declarations-already-first),
  each asserted `> 0`.
For a closed case space, use `fc.constantFrom` over the list AND assert the observed-kind set equals
the full set - which turns "every shape is possible" into "every shape happened".

**8. Verify the property can actually fail.** Cheapest form, no production edit: swap the OUTPUT for
the INPUT in the assertion and confirm red. Doing that on Property 27 produced
`expected 159 to be less than 146` on the "ahead of the first statement" claim, which is the exact
discrimination the property claims. A property that passes on the un-transformed input is measuring
nothing.

**9. For the "changes nothing" half of a signal property, assert it DIFFERENTIALLY.** Run the
identical fixture twice, varying only the one input that moves the signal (the control's reported name
subset), and require the oracle verdict, golden verdict, and instrument verdict to be equal across the
two runs while the signal itself differs. Comparing against a hand-written expected value only restates
the test's own assumptions; comparing two runs that differ in exactly one input does not.

**10. Generate a newly-required field, never pin it.** `normalization: NormalizationProvenance` is
REQUIRED on the three outcome shapes, so the Property 18 arbitrary GENERATES `report.changed` and
`preNormalizationCheckNames`. An arbitrary that pinned an unnormalized baseline could never exercise
the first conjunct and the property would be a tautology.

**11. Regexes per call, never a shared module-level `/g`.** A shared `lastIndex` hung this whole suite
once.

# Anti-circularity note

The properties grade the transform against the PRODUCTION predicates that own each question, not
against a second opinion written for the test: `sourceEmitsCheck` for "does this SOURCE emit a check"
(`readCheckSignals` is the wrong owner there - it anchors `CHECK` at line start and matches nothing
inside a source, passing vacuously), and `readCheckSignals` for "what did this RUN's stdout report".
The check-name enumerator uses `sourceEmitsCheck`'s OWN grammar, `CHECK[ \t]+([A-Za-z0-9_$]+)`, and the
INPUT side is asserted too, so a disagreement between enumerator and predicate fails as a test defect
instead of masquerading as a dropped check. The awkward shapes that caused that exact confusion
(`CHECK name: PASS`, a comment quoting `CHECK <name> PASS/FAIL`, prose with a detached `PASS`) are
generated deliberately so the agreement is exercised rather than assumed.

No reference design and no toolchain observation is used as a test input; the 40 committed fixtures are
untouched by these properties.

# Links

- `app/test/dialect-arbitraries.ts` (the one tokenizer, the readers, the structured generator)
- `app/test/dialect-noncode-spans.property.test.ts` (Property 1, the planted-twin technique)
- `app/test/dialect-span-preservation.property.test.ts` (Property 2, multiset + statement order)
- `app/test/dialect-check-name-preservation.property.test.ts` (Property 5)
- `app/test/dialect-block-naming.property.test.ts` (Property 6, planted collisions)
- `app/test/dialect-sized-literal.property.test.ts` (Property 7, character-run preservation)
- `app/test/dialect-decline-and-report.property.test.ts` (Property 8 - currently RED, see the gotcha)
- `app/test/dialect-check-name-visibility.property.test.ts` (Property 18, differential non-interference)
- `app/test/dialect-declaration-move.property.test.ts` (Property 27)
- `chipAgent/_inbox/gotcha-hash-preceded-sized-literal-is-declined-silently-with-no-finding.md`
- `chipAgent/_inbox/verification-recipe-dialect-fixtures-parse-alone-through-simulatoradapter-pins-0-of-29.md`
- `chipAgent/_inbox/gotcha-a-build-constant-bump-is-invisible-to-vitest-until-tsc-b-rebuilds-dist.md`
- `chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`
- `chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`
