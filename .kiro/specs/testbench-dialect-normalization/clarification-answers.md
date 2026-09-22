# Clarification answers - decided by the `decision-council` skill

Three councils were run. Council A decided the strategy on the evidence available at the time and
made the classification of the 48 precheck failures its gating next step. That classification was
then performed, and it invalidated Council A's premise set, so Council B was run on the corrected
evidence. Council B's verdict governs where those two differ. Council C was then run mid-execution,
on the discrepancy task 13.1 surfaced, and it governs the fixture ordering, the counts, and the
correctness fix that now precedes the fixtures. See "Council C" below.

Wherever ANY part of this file - a council block, the hand-classification table below, or any other
prose in it - states a count of 24 / 8 / 6, or an effect size of 32 of 48, that figure is SUPERSEDED
by Council C's verified 29 / 7 / 4, and its effect size is superseded twice: first by Council C's
36 of 45, then by the MEASURED 28 of 45. Every such figure is left as written because this
file is the record of what each council actually reasoned from, not a statement of current fact.

Wherever ANY part of this file states an effect size of 36 of 45 - including Council C's verdict and
the Q4 and Q7 deferral rationales - that figure is SUPERSEDED and is optimistic by 8. 36 of 45 was
never MEASURED. The 45-sample denominator and the 29 / 7 / 4 class sizes were. The 36 numerator
assumed that naming the block fixed the `unnamed-begin-declaration` class, and task 14.2 measured
that rule at 0 of 29 fixtures fixed; the declaration MOVE that replaced it then measured at 25 of 29.

MEASURED, now the move has landed, against the real toolchain over the 40 committed fixtures:
`unnamed-begin-declaration` 25 of 29 fixed with 4 declined (3 `unbalanced-block`, 1
`declaration-not-relocatable`), `malformed-sized-literal` 3 of 7 with 4 declined
`value-not-determinable`, and `prose-as-statement` 0 of 4, which is correct and permanent because
that class is reported and never rewritten. That is **28 of the 40 committed fixtures**, or 28 of the
45-sample classified population. The measured 28 falls 8 short of the conditional 36 because 36
assumed ALL 29 plus ALL 7 would be fixed, and 8 fixtures across those two classes decline for
reasons no meaning-preserving rewrite can reach. 28 is the number a campaign should be predicted
against. Every 36-of-45 occurrence below is left as written, for the same reason as above: this file
is the record of what each council reasoned from, not a statement of current fact.

## The classification that changed the answer

Performed over the 48 precheck-arm samples in `.eval-runs/stage1-screen-repair-v1/artifacts`
(`repairAttempted == true` and `repairHint == null`), keyed on the FIRST `syntax error` line in
`control-stderr.txt` and the source line it names.

| count | class | example offending line |
|---|---|---|
| 24 | declaration inside an unnamed `begin` block | `integer i;`, `reg [63:0] expected_Q;` |
| 8 | malformed sized literal | `16'd(-15)`, `9'di`, `8'd-1`, `{1'b0, 64{1'b1}}` |
| 6 | our own check-description prose emitted as a bare statement | `CHECK ac1_..._produces PASS;` |
| 4 | no `syntax error` in stderr (other diagnostic) | - |
| 3 | no `control-stderr.txt` captured | - |
| 3 | other single cases | `}` for `end`, stray `rst_n;` |

`Malformed statement` (54 occurrences) is an iverilog CASCADE, not a cause: in the first sample the
real defect is at line 66 and `Malformed statement` is reported at line 72.

## Toolchain calibration (iverilog 13.0, the real oracle, `-g2012` already passed)

| construct | result |
|---|---|
| declaration inside an UNNAMED `begin` | `syntax error` |
| declaration inside a NAMED `begin : blk` | compiles |
| declaration hoisted to module scope | compiles |
| `16'd(-15)` | `syntax error` |
| `-16'd15` | compiles |

So the dominant class is mechanically fixable with no model call. `-g2012` is already passed, so this
is not a missing-standard flag.

## The decisive fact about prior attempts

`DIALECT_RULE` (prompt v3) already instructs, verbatim: "declare every `reg`, `integer`, and array at
MODULE scope before the first `initial`/`always`, never inside a procedural block and never after an
executable statement", and "`-9'sd1`, never `9'sd-1`".

`.eval-runs/stage1-screen-repair-v1/manifest.json` records `testbenchPromptVersion: 3`. The campaign
ran WITH that rule active and still produced 24 declaration-placement and 8 sized-literal failures.

A prompt rule for this class is therefore a MEASURED dead end, not an untried cheap fix. See
`chipAgent/_inbox/gotcha-stage1-screen-v2-dialect-and-concurrency-are-the-two-instrument-defects.md`,
whose own warning was "do not restate an existing rule in new words."

---

## Answers

### Q1 - Spec scope: ANSWER A (one spec, accounting requirements ordered first)
Council A, Executor item 1, unchallenged in peer review: the accounting defects have no independent
product value but gate interpretation of everything else. One spec, with the accounting requirements
first and tasks ordered to land them before any mechanism work.

### Q2 - Retire control-triggered repair: ANSWER A (retire it)
Both councils. It cannot ship (the positive control needs the benchmark's reference design) and cannot
recover a verified artifact (the loop has already returned `instrument-refused`; both accepted repairs
recorded `passed: false`). Maximum value is a relabelled eval metric. The control remains a pure
instrument gate.

### Q3 - How far may a Repair_Hint read the control's output: ANSWER - SUPERSEDED, narrowed to C
With the control arm retired, the anti-circularity question largely dissolves: the precheck involves no
reference design at all, so its diagnostic was never a reference observation. `testbench-repair-loop`
Req 2.4-2.6 stay AS WRITTEN and unamended. What changes instead is the quality of the precheck
diagnostic (Council B, Outsider + Executor item 2): report the FIRST `syntax error` with its offending
source line rather than a cascade message pointing six lines away. No new class of fact crosses to the
model.

### Q4 - Retrieval key: ANSWER - DEFERRED, not adopted
Council B defers retrieval entirely for one campaign. With 32 of 48 failures mechanically fixable
(Council C's correction: 36 of 45, then measured at 7 of 45 with the label alone per task 14.2, and
finally MEASURED at 28 of 45 once the declaration move landed; the conclusion is unchanged) and
the diagnostic itself defective, retrieval is premature: RTLFixer's own ablation shows retrieval gain
depends on diagnostic quality, and ours is measurably poor. Revisit only if the normalizer plus the
diagnostic fix leaves a residue that is not mechanical.

### Q5 - Where repair guidance lives: ANSWER - NOT APPLICABLE this spec
Follows from Q4. No guidance corpus is created. The vault -> curate -> bundle flow is untouched.

### Q6 - One repair call vs ReAct iteration: ANSWER A (keep exactly one; add no iteration)
Council B defers iteration. `testbench-repair-loop` Req 1.5's single-call guarantee is preserved, so
Session_Budget accounting and CPVA stay interpretable.

### Q7 - Blind resampling arm: ANSWER - DEFERRED
Council A recommended building it; Council B defers it, and Council B governs. The normalizer is a
cheaper hypothesis with a predicted effect size of 32/48 (Council C's correction: 36 of 45, which task
14.2 then measured at 7 of 45 with the label alone, and which MEASURES at 28 of 45 with the
declaration move landed) and no
model call at all, so it must be measured before a probabilistic alternative is added. Blind resampling remains the named fallback if
the residue after normalization is still dominated by model error.

### Q8 - Record why a repair declined: ANSWER A (closed `RepairDeclineReason`, symmetric at both points)
Council A, Executor item 1; reinforced by Contrarian's observation that the decline stage was
unmeasurable in this campaign. Without it the next campaign is equally uninterpretable.

---

## Constraints the councils imposed on the spec (carry these into acceptance criteria)

1. MEANING PRESERVATION, not merely compilation (Council B, biggest risk). Naming a block introduces a
   scope, so a declaration may now shadow a module-scope name. Acceptance must assert the transform
   preserves meaning, and the early-warning signal is a normalized testbench that compiles and passes
   the control but whose check names no longer appear in the control's stdout.
2. The normalizer version MUST be folded into the sweep config identity (Council B, Executor item 3),
   alongside `TESTBENCH_PROMPT_VERSION`, or campaigns either side are not comparable.
3. The 29 + 7 + 4 captured artifacts become COMMITTED FIXTURES that must fail before the transform and
   compile after it. Precedent: the existing
   `app/test/testbench-precheck-measured-cases.integration.test.ts` treats such artifacts as evidence.
   (Council C corrected this count from 24 + 8 + 6: the original came from one unverified hand count,
   the corrected figures from running the real compiled `normalizeDialect` over the real artifacts.
   Council C also ordered the correctness fix BEFORE the fixture copy, because a fixture encodes
   expected behaviour.)
4. The normalizer runs BEFORE the Testbench_Precheck on every generated testbench, unconditionally
   (Council B, Adviser 5 peer review). It is desugaring, not repair, so it does not belong in the
   repair path and has no trigger condition.
5. EXPLICIT NON-GOAL (Council B, Outsider peer review): this spec does not claim to address the 229
   `TESTBENCH_FAILED_REFERENCE` samples. It addresses build failures only.
6. REJECTED by three of five reviewers: extending the normalizer to candidate RTL. Rewriting the
   artifact under test would break the oracle.
7. Once the normalizer covers `DIALECT_RULE`'s mechanical clauses, consider shrinking that rule to
   reclaim context budget (the prompt already grew +41.5%). Sequenced after measurement, not before.
---

## Council C - run mid-execution, on the task 13.1 discrepancy

Council C was run while task 13.1 (copy the classified sources into `app/test/fixtures/dialect/` and
index them) was being executed. The task's own instruction was to investigate and report a count
discrepancy rather than force the numbers to match; `clarification-questions.md` is that report, and
this is the decision on it. Every premise below was VERIFIED empirically against Icarus Verilog 13.0
(`iverilog -g2012`) and against the real compiled `normalizeDialect`, not reasoned about.

### Language ground truth

In Verilog a comment is lexically equivalent to whitespace: it is stripped before the parser sees the
token stream. Confirmed directly with iverilog: `begin // c` newline `: blk` compiles clean (exit 0),
and `begin /* c */ : blk` compiles clean. So any adjacency scan asking "what is the nearest code
character on this side" must treat a comment span as TRANSPARENT, or it is asking a question the
parser does not ask.

### Three confirmed defects in `app/agent/orchestrator/dialect/`, all one root cause

The root cause is an adjacency scan that treats a comment span as an opaque barrier instead of as
whitespace.

1. `prose-as-statement.ts` `precedingNonWhitespaceOffset`, read by `sitsWhereStatementExpected`,
   walks the RAW source, lands on the comment's last character, and the
   `mask.code[precedingOffset] !== 1` guard then returns false. The Prose_As_Statement site is MISSED
   whenever a comment intervenes. Report-only, so the cost is a missed finding.
   LIVE in captured data: 4 samples in `stage1-screen-repair-v1` (9 across all of `.eval-runs`), all
   `qwen.qwen3-coder-30b-a3b-instruct`, each a `// Final check` line immediately before a bare
   `CHECK <name> PASS;`.
2. `unnamed-begin.ts` `isAlreadyNamed` uses `mask.code[index] === 1` as a LOOP CONJUNCT, so the walk
   exits at the first non-code offset and an already-named block is judged NOT named. The rule then
   inserts ` : tbnorm_blk_N` after `begin`, producing `begin : tbnorm_blk_1 // c` newline `: blk`.
   CONFIRMED FALSE REWRITE: input iverilog exit 0, normalizer output iverilog exit 2 (`syntax error`
   plus `Malformed statement`); the block-comment variant is identical. This violates the module's own
   documented "false declines only, never false rewrites" invariant and Requirement 5 meaning
   preservation. Zero occurrences in the captured corpus, so it is theoretical against THIS corpus -
   but the campaign generates NEW testbenches, which makes it a live risk rather than a historical one.
3. `declaredNamesAfter` exists in TWO near-duplicate copies, at `unnamed-begin.ts` and at
   `normalizer.ts`. Both forward-scan to the terminating `;` correctly skipping non-code, then
   `source.slice(keywordEnd, end)` the RAW body and take the declared name with an unmasked identifier
   regex, so `reg /*x*/ a;` yields declared name `x` instead of `a`. CONFIRMED to DEFEAT the
   Requirement 5.4 `would-shadow-module-scope` decline, converting a correct decline into a rewrite:
   module-scope `reg a;` plus block `reg a;` correctly declines, while the same with `reg /*x*/ a;` in
   the block returns `changed: true, action: 'rewritten'`. Zero occurrences in the captured corpus.

### REFUTED - do not change these

`sized-literal.ts` `precedingCodeCharacter` is CORRECT: it uses `continue` on non-code, which makes a
comment transparent. So are all three scans in `app/eval/corpus/verilog-mutation.ts`
(`precedingOperandCharacter`, `conditionOpenParen`, `matchingCloseParen`). The correct pattern already
exists in this codebase four times over, and only the two sites above deviate from it, so the fix is
to COPY the existing `continue`-on-non-code pattern rather than to invent a new one.

### The corrected counts

The 24 / 8 / 6 classification of 48 does not reproduce. Every one of the 45 samples whose
`control-stderr.txt` contains `syntax error` was run through the real compiled normalizer, and the
unclassified residue was read by hand at its exact error line.

| class | stated | verified | note |
|---|---|---|---|
| `unnamed-begin-declaration` | 24 | **29** | all 29 confirmed real |
| `malformed-sized-literal` | 8 | **7** | all 7 confirmed real |
| `prose-as-statement` | 6 | **4** | 2 detected today, 4 after defect 1 is fixed |
| genuinely other (none of the three classes) | - | **5** | enumerated below |

The residue of 5: a bit-select on a sized literal `8'b00000000[7:1]`, a stray bare identifier
statement `rst_n;`, a forward-referenced `disable` block label, a stray extra `end`, and a bit-select
on a parenthesized expression `(i + 1)[7:0]`.

The population is 45, not the vault note's 48: the other 3 captured no `control-stderr.txt` at all, so
no classification is derivable for them.

6 `prose-as-statement` samples is UNREACHABLE at any tie-break rule. A corpus-wide search of all 495
samples for the bare `CHECK <name> PASS|FAIL;` statement shape found exactly 4 sample directories in
total, all 4 inside the 45-sample population and all 4 authored by
`qwen.qwen3-coder-30b-a3b-instruct`.

So the post-fix fixture set is **29 / 7 / 4 = 40 fixtures**, and the predicted campaign effect size
becomes **36 of 45** (29 unnamed-begin plus 7 sized-literal), replacing "32 of 48".
(Task 14.2 later measured that 36 numerator as CONDITIONAL, not predictive: the `unnamed-begin` half
fixed 0 of 29 with the label alone, so the measured figure was 7 of 45 and 36 of 45 needed the
declaration move. The move has since landed and MEASURES at 25 of 29, which makes the final figure
**28 of 45** - 8 short of 36, because 36 assumed all 29 plus all 7 would be fixed. 36 of 45 is
superseded; predict against 28. See "Task 14.2 decisions" at the end of this file.)

### Verdict

Fix the comment-as-barrier defect at all three sites, collapse the duplicated `declaredNamesAfter` to
one code-span-respecting owner, bump `NORMALIZER_VERSION` 1 -> 2, re-pin the two config hashes, and
only THEN copy and index the fixtures, at 29 / 7 / 4. Index the campaign's observed iverilog
`syntax error` line as ground truth and the `DialectClass` as the tool's label.

The reason is one sentence: a fixture encodes expected behaviour, so committing fixtures generated by
a normalizer that demonstrably turns a compiling source into a non-compiling one converts a confirmed
bug into a passing regression test that defends it.

### Answers to `clarification-questions.md`

#### Q1 - the counts do not reproduce: ANSWER C (fix the normalizer first, then classify)
Option C, pause the fixture copy and land the comment-adjacency fix as its own change, then re-run
classification. Option A would have shipped a fixture index that is truthful to today's
`NormalizerReport` but silently truthful to a confirmed false rewrite as well, and Option B would have
hand-classified past the code's own behaviour. Option C is the only one that makes the fixture index
and the live code agree without a manual override, and the "scope creep" objection it carried in the
questions file is answered by the verified evidence: the fix is not an improvement to a working
transform, it is a repair of a confirmed violation of Requirements 4.12, 5.3, and 5.4 that the code
already had. The fix is scoped to the two deviating scans plus the duplicated reader, and it copies a
pattern that already exists four times in the tree.

#### Q2 - stale counts in the task text: ANSWER A (correct the counts in `tasks.md`)
The task document must match the fixtures it produces. Every 24 / 8 / 6, every 38, and every 32-of-48
describing this classification is corrected to 29 / 7 / 4, 40, and 36-of-45 (the last since restated as
a range with its condition attached, per "Task 14.2 decisions" below), and each corrected place
records that the original came from one unverified hand count while the corrected figure was derived
by running the real normalizer over the real artifacts - so a future reader does not "correct" them
back.

#### Q3 - are declined findings eligible for the fixture set: ANSWER A (yes, both)
Declined and rewritten findings are both eligible, because Requirement 9.2's literal text indexes the
`DialectClass`, not the action. The campaign's observed iverilog `syntax error` line is GROUND TRUTH
and the `DialectClass` is the TOOL'S LABEL, which is what makes a declined finding evidence: it
records that the class fires and correctly declines. Option B would have zeroed out
`prose-as-statement` entirely, since that class never rewrites by design.

### Deferred, and safe as documented

The per-module `moduleScopeNames` over-approximation is DEFERRED, not fixed here. It takes every
module-scope declaration in the FILE rather than only the enclosing module's, so a two-module file can
decline a block that would have been safe. Its ceiling is FALSE DECLINES ONLY, never false rewrites,
which is the correct direction for a meaning-preservation gate, and it is already marked with a
`ponytail:` comment naming that ceiling and its upgrade path. It is worth doing only if a measured
campaign shows the declined residue is dominated by cross-module false positives.
## Task 14.2 decisions - run mid-execution, on the measured 0 of 29

Task 14.2 stopped before writing the fixture suite, because one of the assertions the task required was
FALSE against the real toolchain: with the label alone, the `unnamed-begin-declaration` rule fixed 0 of
its 29 fixtures. It FIRED on 25 of 29 and the first `syntax error` landed on the identical line before
and after. That 0 of 29 is the record of the label-only state; the declaration move that replaced it
MEASURES at 25 of 29, taking the committed fixtures to 28 of 40.
`task-14.2-questions.md` in this folder is the full report, including both probes and how to re-derive
them. The decisions below are the answers to its four questions and they are treated as constraints.

The premise that failed is the calibration itself. It compared a declaration in an unnamed block
against one at the top of a NAMED block, varied the label and the POSITION together, and credited the
label. Measured with `iverilog -g2012`: a declaration placed FIRST in its block is accepted whether or
not the block is named, and a declaration AFTER a statement is rejected whether or not the block is
named. The discriminator is position, and the campaign captured the after-a-statement case. This is
the third premise in this spec to fail verification, after the 24 / 8 / 6 hand count and the
comment-as-whitespace invariant.

#### Q1 - what task 14.2's assertion becomes: ANSWER A (land the suite on measured reality now)
The suite asserts what is true today: all 40 fixtures fail before normalization, each reproducing its
committed `observed.firstSyntaxErrorLine`; the per-class fixed counts are PINNED at 0 of 29, 3 of 7,
and 0 of 4; the 29 are additionally asserted to still carry a `syntax error` at the SAME line, which
is the precise statement of the defect; and the 4 `prose-as-statement` fixtures still fail, which is
correct because that class is reported and never rewritten. The 0-of-29 pin is a DOCUMENTED
KNOWN-FAILING state against Requirement 9.5 which the rule-fix group flips. Option B (fix first, write
the suite once) was rejected because it leaves the gate with no true assertion in front of it for a
whole task cycle; option C (drop the class) abandons the dominant 29.

#### Q2 - what the fix is: KEEP the label, and ADDITIONALLY move the declaration within its own block
Verified at 25 of 29, with the 4-fixture residue fully explained: 3 whose first error is not this class
at all (two C-style `}` braces, one bare prose `CHECK` line, which are exactly the 3 already declined
as `unbalanced-block`) and 1 `genvar i;` inside a function body, which is rejected at ANY position and
is a hard ceiling. Against the fixtures this class can own it is 25 of 25. HOISTING to module scope
stays rejected on its original ground - it widens scope and can alias two sibling block-local counters
into one shared name while still compiling. The label buys NOTHING from the oracle: move-only fixes the
same 25 of 29 with zero disagreement fixture by fixture, and the label is retained for IEEE 1364
conformance alone. The shadow hazard `would-shadow-module-scope` guards does not reproduce either: a
block-local declaration in an unnamed `begin` does not leak to the enclosing scope, measured, so naming
never created it; the guard is retained because its ceiling is false declines only.

#### Q3 - restating the effect size: ANSWER YES, and it is now MEASURED rather than a range
The answer was given as a range with its condition attached, because the declaration move had not yet
landed. It has, and the figure is now MEASURED: `unnamed-begin-declaration` 25 of 29 fixed with 4
declined (3 `unbalanced-block`, 1 `declaration-not-relocatable`), `malformed-sized-literal` 3 of 7 with
4 declined `value-not-determinable`, `prose-as-statement` 0 of 4 and permanently so. That is **28 of the
40 committed fixtures**, or 28 of the 45-sample classified population. The conditional 36 of 45 assumed
ALL 29 plus ALL 7 would be fixed and is superseded, optimistic by 8. Every occurrence in
`requirements.md`, `design.md`, and `tasks.md` now carries the measured number with its residue, and
records 32 of 48 and 36 of 45 as superseded, so no future session restores either.

#### Q4 - how the suite builds its input: ANSWER A, plus one end-to-end case
Assert at the PARSE level: compile each fixture alone through the real `SimulatorAdapter` and check
whether a `syntax error` naming the fixture is present, cross-checked against the committed
`observed.firstSyntaxErrorLine`. The reason is structural: `.eval-corpus/` and `.eval-runs/` are both
gitignored, so no Spec and no reference design exists for the 11 RTLLM DUTs, and with a non-matching
stub iverilog reports `Unknown module type` at a TESTBENCH line, which `attributedFiles` correctly
attributes to the testbench, making `testbench-build-failed` the answer both before AND after and the
after-half vacuous. ONE real `TestbenchPrecheck` case over the smallest fixture with a hand-written
interface keeps the precheck path exercised end to end. Option B, deriving each interface from the
fixture's own instantiation, was REJECTED: it means a test-only Verilog parser whose failure mode is a
confusing red gate rather than a real finding. The reliable signal is the presence of a `syntax error`
line, NOT the exit code, which was observed as 1, 2, and 4 for a rejected parse.

#### The one requirement amendment, approved
Requirement 5.3 is restated as a MULTISET claim - the code-token multiset preserved with the generated
labels as the only addition, the comment multiset unchanged - because it no longer holds for free from
insert-only editing. It was measured at 29 of 29 on both counts. Two criteria were APPENDED at the end
of Requirement 5 so no existing number moved: 5.13 permits a declaration to be relocated ahead of its
own block's first statement, in its original relative order, and 5.14 confines that relocation to the
declaration's own block. Relocation is meaning-preserving for a MEASURED reason: a bare declaration has
no execution semantics, and an initialized one initializes statically before any procedural code in its
block runs (`integer c = 0;` in a `for` body initialized ONCE across three iterations; `integer i = src;`
read `x` though another `initial` had already assigned `src = 9` at t=0). Design Property 2 was restated
to match and Property 27 was added for the move.
