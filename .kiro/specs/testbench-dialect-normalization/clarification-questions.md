# Clarification questions: task 13.1 fixture classification

Generated while executing task 13.1 (copy the 24 + 8 + 6 classified sources into
`app/test/fixtures/dialect/` and index them).
The task's own instructions say: "If your own classification produces different counts,
investigate why and report the discrepancy rather than forcing the numbers to match."
This is that report.

## What was verified

- The population is the 45 samples (of 495 total, 11 arms) whose `control-stderr.txt` contains
  the literal string `syntax error`, matching the task's own definition of the population.
  This is 3 fewer than the vault note's stated 48; the note's 48 also includes 3 samples with no
  `control-stderr.txt` captured at all, which the task's population definition excludes by
  construction (no file to grep).
- Every sample was run through the REAL, built `normalizeDialect` (`app/agent/orchestrator/dialect/normalizer.ts`,
  compiled via `npx tsc -b`, imported from `app/agent/dist/index.js`), not eyeballed.
- Classification rule, derived from the vault note's own method ("keyed on the FIRST syntax
  error line"): when every finding in a sample's report shares one `DialectClass`, that class is
  unambiguous (the unnamed-begin rule reports ONE finding per BLOCK, so its line can sit far from
  where iverilog's parser actually stalls deep inside that same block - confirmed by hand on
  `qwen.qwen3-235b-a22b-2507/rtllm_arithmetic_multi_booth_8bit/sample-1`, finding at line 37,
  iverilog error at line 225, both inside the same unnamed `initial begin`). When a sample's
  findings span more than one class (1 sample out of 45), the finding whose line exactly matches
  the reported error line wins.
- Every one of the 7 samples the normalizer's findings left unclassified was read by hand at its
  reported error line. 5 are genuinely `other` (a bit-select on a sized literal
  `8'b00000000[7:1]`, a stray bare identifier statement `rst_n;`, a forward-referenced `disable`
  block label, a stray extra `end`, a bit-select on a parenthesized expression `(i + 1)[7:0]`) -
  none of the three classes. 2 (`qwen.qwen3-coder-30b-a3b-instruct/rtllm_arithmetic_multi_pipe_8bit/sample-2`
  line 158, and `qwen.qwen3-coder-30b-a3b-instruct/rtllm_memory_right_shifter/sample-2` line 103)
  are confirmed BY HAND to be genuine `prose-as-statement` (`CHECK <name> PASS;` as a bare
  statement) that the shipped `findProseAsStatements` currently fails to detect.
- Root cause of that miss, confirmed by reading `prose-as-statement.ts`: both sites have a line
  comment (`// Final check`) sitting between the prior statement's `;` and the `CHECK` line.
  `sitsWhereStatementExpected`'s `precedingNonWhitespaceOffset` only skips whitespace, not
  comments, so the nearest preceding non-whitespace character is inside the comment span, which
  the function's own documented behaviour treats as "no code precedes it here" and declines to
  report - not a classification ambiguity, a normalizer detection gap.
- A corpus-wide search (all 495 `testbench.v` files, not just the 45) for the bare
  `CHECK <name> PASS|FAIL;` statement shape found it in exactly 4 distinct sample directories
  total, all 4 already inside the 45-sample "syntax error" population, all 4 authored by
  `qwen.qwen3-coder-30b-a3b-instruct`. There is no 6th prose-as-statement sample anywhere in the
  captured corpus.

## Q1. The vault note's 24 / 8 / 6 does not reproduce; real counts are 29 / 7 / 2 (38 total), plus 2 confirmed-by-hand misses the current normalizer doesn't detect, plus 5 genuinely-other

**Maps to:** Requirements 9.1, 9.2, 9.3, 9.12 (which fixtures go in the index, and what
`DialectClass` each is stamped with).

**The tension:** The task was written expecting 24/8/6 (citing the vault note as `candidate`,
"not trusted", to be verified rather than trusted). Verification produced a different, but
fully explained, breakdown:

| class | task expected | verified count | note |
|---|---|---|---|
| `unnamed-begin-declaration` | 24 | **29** | all 29 confirmed real; the note's hand-count likely used a different unit (per-declaration-site vs per-block) |
| `malformed-sized-literal` | 8 | **7** | all 7 confirmed real; 1 multi-class sample keyed here by exact-line-match could instead be attributed to unnamed-begin by a different tie-break rule |
| `prose-as-statement` | 6 | **2** detected + **2** hand-confirmed-but-undetected = **4 total in the whole corpus** | the corpus itself contains only 4 bare-CHECK-statement samples; there is no 6th anywhere in the 495 samples |
| other (not one of the 3 classes) | (implicitly 0 among the 38) | **5** | bit-selects on literals/expressions, a stray identifier, a forward-referenced disable label |
| no finding, no clear other-cause found | (implicitly 0) | **0** | every one of the 45 was resolved to a class or to a confirmed `other` cause |

**Options:**

**Option A - Ship 29 / 7 / 2 = 38 fixtures, using only what the shipped normalizer actually
detects today.** The fixture set is evidence of what the shipped code does right now; the 2
comment-adjacency misses become a tracked follow-up (a chipAgent note plus, optionally, a new
task to fix `sitsWhereStatementExpected`) rather than being silently folded into the fixture
count by hand-classifying past the code's own current behavior.
*Recommended.* This keeps the fixture index strictly truthful to "what `NormalizerReport.findings`
says," which is the property task 13.2's forthcoming test suite will presumably assert against,
and it surfaces a real, fixable defect instead of hiding it inside a hand-picked bucket.

**Option B - Ship 29 / 7 / 4, hand-classifying the 2 comment-adjacent misses into
`prose-as-statement` because they are confirmed correct by hand.** This gets the
`prose-as-statement` bucket closer to a nonzero multi-sample size (4 instead of 2), but means the
fixture index would assert a `DialectClass` for 2 fixtures that the current shipped normalizer
does NOT actually detect - task 13.2's test suite (not yet written) would need those 2 fixtures
carved out or expected-to-fail, muddying what "the fixture proves the normalizer fires on this"
means for exactly those 2 files.

**Option C - Pause task 13.1, first land a fix to `sitsWhereStatementExpected` (skip past
comments, not just whitespace, when finding the preceding code character) as its own change, then
re-run classification.** This would likely bring `prose-as-statement` to 4 (still not 6; the
corpus caps out at 4) and is the only option that makes the fixture index and the live code
agree without a manual override. It is scope creep on a fixtures-and-index task and touches
production normalizer code task 13.1 was never supposed to touch.

**Option D - Investigate further for the missing 2 `prose-as-statement` and remaining count
mismatches in `unnamed-begin-declaration` (29 vs 24) and `malformed-sized-literal` (7 vs 8)
before proceeding at all**, e.g. by re-deriving the vault note's original 48-sample hand
classification from `.eval-runs/stage1-screen-repair-v1/results.jsonl` or any other artifact that
might record the original hand-classification decisions, if such a record exists.

## Q2. Given the corpus caps out at 38 total (not resolvable to 24/8/6 no matter the tie-break rule), should the fixture directories be named/sized to the VERIFIED counts, or should the task's stated counts be corrected in tasks.md first?

**Maps to:** Requirement 9.12 and the task's own directory-naming instruction ("`unnamed-begin-declaration/` with the 24 sources, `malformed-sized-literal/` with the 8, and
`prose-as-statement/` with the 6").

**The tension:** The task text hardcodes the counts into prose ("the 24 sources", "the 8", "the
6"). If the verified counts are used (Option A: 29/7/2, or Option B: 29/7/4), the task
description itself is now stale and should probably be corrected in `tasks.md` for whoever reads
it next, rather than leaving a discrepancy between the task's own words and what actually landed
in the repo.

**Options:**

**Option A - Update task 13.1's own text in `tasks.md` to state the verified counts once
they're settled (via Q1's answer), so the task document matches the fixtures it produced.**
*Recommended.*

**Option B - Leave `tasks.md` as originally written (referring to 24/8/6) and only note the
actual counts in the completion report / commit message, treating the original count as
aspirational framing rather than a spec commitment.**

## Q3. `unbalanced-block` and `would-shadow-module-scope` declines (unnamed-begin-declaration) and `value-not-determinable` declines (malformed-sized-literal, prose-as-statement) all appear in the verified 38 - should DECLINED findings be eligible for the fixture set at all, or only REWRITTEN ones?

**Maps to:** Requirement 9.2 ("its `DialectClass`... and the first `syntax error` line").

**The tension:** The task's framing ("a fixture is evidence of what a model actually produced")
doesn't distinguish rewritten from declined sites, and a declined finding is just as much
evidence the classification logic correctly identified the dialect class - it just couldn't
safely rewrite it. Of the verified 38: roughly a third are `declined` (various causes), not
`rewritten`. This matters for task 13.2 (the forthcoming fixture test suite), which will
presumably assert something about each fixture's classification, and a declined finding asserts
"this class fires and correctly declines" rather than "this class fires and rewrites."

**Options:**

**Option A - Include both rewritten and declined findings in the fixture set, since the
`DialectClass` is what's being indexed (per Requirement 9.2's literal text), not the action.**
*Recommended*, consistent with how the classification was actually performed for this task.

**Option B - Restrict fixtures to REWRITTEN findings only**, on the theory that a declined
finding doesn't demonstrate a defect the normalizer actually fixes, only one it correctly
recognizes. This would shrink all three buckets further (removing every `unbalanced-block`,
`would-shadow-module-scope`, and `value-not-determinable` sample, and ALL of prose-as-statement
since it never rewrites by design - which would zero out that bucket entirely under this rule,
an outcome that seems clearly wrong given prose-as-statement's whole contract is decline-only).
