---
type: gotcha
title: The testbench repair loop measured 2 of 259 - the cause is two MECHANICAL dialect classes plus two accounting defects, not weak repair feedback (counts CORRECTED to 29 / 7 / 4 of 45; three comment-adjacency defects confirmed in dialect/)
status: candidate
provenance: stage1-screen-repair-v1 (495 samples, 11 arms, n=3, testbenchPromptVersion 3); the classification VERIFIED by running the real compiled normalizeDialect over the real captured artifacts and reading every unclassified residue by hand at its iverilog error line (supersedes the original unverified hand count); iverilog 13.0 calibration on this machine; arxiv:2311.16543, arxiv:2607.17053, arxiv:2607.26117, arxiv:2607.14167
tags:
  [
    testbench,
    eval,
    repair-loop,
    instrument-validity,
    dialect,
    dialect-normalizer,
    comment-adjacency,
    verilog-2001,
    icarus,
    measurement,
    accounting,
    defect-class,
    dead-end,
    prompt,
  ]
timestamp: 2026-09-29T00:00:00Z
---

# Correction notice

This note REPLACES `gotcha-testbench-repair-loop-measured-near-zero-2-of-259-locobs-condition.md`, which was wrong twice.
It framed the 48 hint-less samples as a no-feedback placebo condition; they in fact carry a verbatim iverilog diagnostic, and the `null` was a PERSISTENCE gap.
It also reported "259 attempts / 2 accepted" as one population; the 259 is two populations with different denominators.

This note's OWN classification has since been corrected, and the correction is recorded here so a future session does not revert it.
Where an earlier revision of this note said 24 / 8 / 6 of 48 and an effect size of 32 of 48, the verified figures are 29 / 7 / 4 of 45 and 36 of 45.
The old figures came from ONE unverified hand count.
The new ones were derived by running the real compiled `normalizeDialect` over the real captured artifacts in `.eval-runs/stage1-screen-repair-v1/artifacts` and reading every unclassified residue by hand at its exact iverilog error line.
The diagnosis this note carries - two mechanical dialect classes, not a feedback problem - is UNCHANGED by the correction; only the counts moved, and they moved in favour of the transform.

# What was measured

495 samples, 11 arms, n=3, at `testbenchPromptVersion: 3`. Net verified artifacts recovered: **0**.

| arm | feedback actually sent | can recover a verified sample | ships to production | attempts | accepted |
| --- | --- | --- | --- | --- | --- |
| precheck (loop) | verbatim iverilog diagnostic | yes, the loop continues | yes, no reference needed | 48 | **0** |
| control (harness) | check name + one GUESSED `DefectClass` | **no** | **no**, needs the benchmark reference | 211 | **2** |

Both accepted repairs still recorded `passed: false`, `outcomeStatus: instrument-refused`, `instrumentValidity: valid`.
The arm that could have helped never succeeded; the arm that succeeded could never have helped.

# Two accounting defects (both violate the SHIPPED testbench-repair-loop spec)

1. **Req 4.2 violated.** `app/eval/harness.ts` `#repairIfTriggered` returns `wasRepaired: false` from all five declined branches, and `#runSample` writes `repairProvenance: wasRepaired ? {...} : precheckProvenance`.
   A control-path repair the port declined therefore persists `attempted: false` and is INVISIBLE.
   So the 211 is "admissible revisions produced", not "attempts made", and the true control-arm attempt count is unknown and greater than 211.
2. **Req 4.7 violated.** `verification-loop.ts` `#repairPrecheckFailure` builds `hint` as a LOCAL; only `repairProvenance` escapes on `InstrumentAdmissionResult`.
   All 48 precheck samples persist `repairHint: null`.
   Neither call site records the decline STAGE, although both already branch on exactly those stages (four branches and five branches) and collapse them.

# The classification that changed the answer

The classified POPULATION is **45**, not 48.
The other 3 of the 48 captured no `control-stderr.txt` at all, so no classification is derivable for them - they are unclassifiable, not "other".
Each of the 45 is keyed on the FIRST `syntax error` line in its `control-stderr.txt` and the source line that error names.

| count | class | example offending line |
| --- | --- | --- |
| **29** | declaration inside an UNNAMED `begin` block | `integer i;`, `reg [63:0] expected_Q;` |
| **7** | malformed sized literal | `16'd(-15)`, `9'di`, `8'd-1`, `{1'b0, 64{1'b1}}` |
| **4** | our own check-description PROSE emitted as a bare statement | `CHECK ac1_..._produces PASS;` |
| **5** | genuinely other (none of the three classes) | enumerated below |

Of the 4 `prose-as-statement` samples, today's shipped code detects only 2; all 4 are detected once defect 1 below is fixed.

The residue of 5, each read by hand at its exact error line:

- a bit-select on a sized literal, `8'b00000000[7:1]`
- a stray bare identifier statement, `rst_n;`
- a forward-referenced `disable` block label
- a stray extra `end`
- a bit-select on a parenthesized expression, `(i + 1)[7:0]`

**6 `prose-as-statement` is UNREACHABLE at any tie-break rule**, so do not go looking for the missing two.
A corpus-wide search of all 495 captured samples for the bare `CHECK <name> PASS|FAIL;` statement shape found exactly 4 sample directories in total, all 4 inside the 45-sample population and all 4 authored by `qwen.qwen3-coder-30b-a3b-instruct`.

`Malformed statement` (54 occurrences) is an iverilog CASCADE, not a cause: in the first sample the real defect is at line 66 and `Malformed statement` is reported at line 72.
A diagnostic that names line 72 for a defect on line 66 is itself a defect.

# Calibration, iverilog 13.0 on this machine, `-g2012` ALREADY passed

| construct | result |
| --- | --- |
| declaration inside an UNNAMED `begin` | `syntax error` |
| declaration inside a NAMED `begin : blk` | compiles |
| declaration hoisted to module scope | compiles |
| `16'd(-15)` | `syntax error` |
| `-16'd15` | compiles |

36 of 45 are therefore reachable by a deterministic source-to-source transform with NO model call: the 29 unnamed-begin plus the 7 sized-literal.
`prose-as-statement` is NOT in that 36, because it is reported and never rewritten.
This is not a missing standard flag: `-g2012` is already in the worker's iverilog invocation.

# The decisive dead end: DIALECT_RULE already says this, and was ACTIVE

`DIALECT_RULE` at prompt v3 already instructs, verbatim, "declare every `reg`, `integer`, and array at MODULE scope ... never inside a procedural block", and "`-9'sd1`, never `9'sd-1`".
`.eval-runs/stage1-screen-repair-v1/manifest.json` records `testbenchPromptVersion: 3`.

**The campaign ran WITH that rule active and produced these 36 failures anyway.**

So a prompt rule for the mechanical dialect class is now a MEASURED dead end, the same way
[[gotcha-stage1-screen-v2-dialect-and-concurrency-are-the-two-instrument-defects]] recorded the concurrency class failing twice.
That note's own warning applies to its own fix: do not restate an existing rule in new words.
Attempt count for the dialect class is now 1 failed, and the correct next move is not attempt 2.

# What the literature does and does not support here

- arxiv:2311.16543 (RTLFixer): error-keyed retrieval lifted one-shot Verilog syntax fixing 58.7 -> 89.9 percent, and iverilog is explicitly their LOW-quality-log compiler. Retrieval gain DEPENDS on diagnostic quality, and ours is measurably defective (the line-72-for-line-66 cascade), so retrieval was deferred until the diagnostic is worth retrieving against.
- arxiv:2607.17053 (MechMem-RTL), same benchmark family, same simulator, overlapping arms: standard feedback 109/288, task-text RAG 107/288, verifier-evidence-keyed records 180/288. Task-TEXT retrieval is worth nothing; DIAGNOSTIC-keyed retrieval nearly doubles. Relevant later, not now.
- arxiv:2607.26117: blind resampling matches or beats self-repair at 2.5-5.5x lower cost; anchoring lifts near-identical retries from 2-14 percent to 33-68 percent. The named fallback if a mechanical fix leaves a model-error residue.
- arxiv:2607.14167: prose vs keyed JSON is a NULL result, so rewording the hint was never the lever.

# Three CONFIRMED defects in the shipped `app/agent/orchestrator/dialect/` rules - all ONE root cause

The root cause is an adjacency scan that treats a comment span as an OPAQUE BARRIER rather than as whitespace.
That is wrong because a Verilog comment is lexically whitespace: it is stripped before the parser sees the token stream.
Confirmed directly against iverilog 13.0 - `begin // c` newline `: blk` compiles clean (exit 0), and `begin /* c */ : blk` compiles clean.
So any scan asking "what is the nearest code character on this side" must treat a comment as TRANSPARENT, or it is asking a question the parser never asks.

1. **MISSED finding.** `prose-as-statement.ts` `precedingNonWhitespaceOffset`, read by `sitsWhereStatementExpected`, walks the RAW source, lands on the comment's last character, and the `mask.code[precedingOffset] !== 1` guard then returns false. The site is missed whenever a comment intervenes. Report-only, so the cost is a missed finding, not a bad rewrite. LIVE in captured data: this is exactly why 2 of the 4 `prose-as-statement` samples go undetected today - each is a `// Final check` line immediately before a bare `CHECK <name> PASS;`.
2. **FALSE REWRITE - the serious one.** `unnamed-begin.ts` `isAlreadyNamed` uses `mask.code[index] === 1` as a LOOP CONJUNCT, so the walk exits at the first non-code offset and an ALREADY-NAMED block is judged not named. The rule then inserts ` : tbnorm_blk_N` after `begin`, producing `begin : tbnorm_blk_1 // c` newline `: blk`. Confirmed end to end: input iverilog exit 0, normalizer output iverilog exit 2 (`syntax error` plus `Malformed statement`); the block-comment variant is identical. This violates the module's own documented "false declines only, never false rewrites" invariant. Zero occurrences in the captured corpus, so it is theoretical against THIS corpus - but the campaign generates NEW testbenches, which makes it a live risk rather than a historical one.
3. **DEFEATED safety decline.** `declaredNamesAfter` exists in TWO near-duplicate copies, at `unnamed-begin.ts` and at `normalizer.ts`. Both forward-scan to the terminating `;` correctly skipping non-code, then `source.slice(keywordEnd, end)` the RAW body and take the declared name with an unmasked identifier regex, so `reg /*x*/ a;` yields declared name `x` instead of `a`. Confirmed to DEFEAT the `would-shadow-module-scope` decline, turning a correct decline into a rewrite: module-scope `reg a;` plus block `reg a;` correctly declines, while the same with `reg /*x*/ a;` in the block returns `changed: true, action: 'rewritten'`. Zero occurrences in the captured corpus.

**REFUTED - do not "fix" these.** `sized-literal.ts` `precedingCodeCharacter` is CORRECT: it uses `continue` on non-code, which makes a comment transparent.
So are all three scans in `app/eval/corpus/verilog-mutation.ts` (`precedingOperandCharacter`, `conditionOpenParen`, `matchingCloseParen`).
The correct pattern already exists in this tree four times over and only the sites above deviate from it, so the fix is to COPY that existing `continue`-on-non-code shape, not to invent a new one.

Consequence for sequencing: the fix lands BEFORE the fixtures are committed.
A fixture encodes expected behaviour, so committing fixtures generated by a normalizer that demonstrably turns a compiling source into a non-compiling one would convert a confirmed bug into a passing regression test that defends it.

# Where this landed

Spec `.kiro/specs/testbench-dialect-normalization/` (requirements + design + tasks, all validating).
A deterministic `Dialect_Normalizer` runs before the Testbench_Precheck on every generated testbench; the two accounting defects are fixed FIRST; control-triggered repair is RETIRED; retrieval, ReAct iteration, and blind resampling are all deferred for one campaign.
THREE `decision-council` runs are recorded in that folder's `clarification-answers.md`.
Council A's premise set was invalidated by the classification above, which is why Council B governs.
Council C was run mid-execution on the count discrepancy and governs the corrected counts, the fixture ordering, and the correctness fix that now precedes the fixtures - it is the authority for every figure in this note.

Design decisions worth remembering:
- NAME the block, never hoist the declaration. Naming adds a scope and moves nothing, so the transform either preserves meaning or fails to build. Hoisting widens a scope and can alias two block-local `integer i;` counters into one shared name while still compiling and still printing check lines.
- The 4 prose-as-statement cases are DETECTED and REPORTED, never rewritten. Synthesizing a `$display` from our own prompt prose would fabricate a check the model never wrote and print `PASS` from prose.
- `app/eval/corpus/verilog-mutation.ts` already holds the exact span scanner (`scanSource` / `SourceMask`) the transform needs, private. It moves to `app/tools/verilog/source-mask.ts` rather than being rewritten, so one safety claim keeps one owner.

# Measured correction, task 14.2 - the calibration table above is WRONG, and the 36 of 45 does not hold

Task 14.2 ran the real compiled `normalizeDialect` over the 40 committed fixtures and compiled each one before and after against iverilog 13.0 `-g2012`.
The "36 of 45" prediction in this note is NOT supported. The measured effect on the committed fixtures is **3**.

| class | fixtures | reproduce their recorded error line | `syntax error` GONE after normalization |
| --- | --- | --- | --- |
| `unnamed-begin-declaration` | 29 | 29 / 29 exact | **0 / 29** |
| `malformed-sized-literal` | 7 | 7 / 7 exact | 3 / 7 (4 declined `value-not-determinable`) |
| `prose-as-statement` | 4 | 4 / 4 exact | 0 / 4 - CORRECT, reported and never rewritten |

The capture is sound: all 40 reproduce their recorded `firstSyntaxErrorLine` exactly. The `malformed-sized-literal` rule works as designed. The `unnamed-begin-declaration` rule fires on 25 of 29 (`changed: true`, a rewritten finding) and the parse error does not move a single line.

**Root cause: this note's own calibration table conflated two variables.** Re-run as five minimal cases, each compiled alone with `iverilog -g2012 -t null`:

| construct | exit |
| --- | --- |
| unnamed `begin`, declaration FIRST in the block | **0** |
| NAMED `begin : blk`, declaration FIRST in the block | 0 |
| unnamed `begin`, declaration AFTER a statement | 2 |
| **NAMED `begin : blk`, declaration AFTER a statement** | **2** |
| declaration HOISTED to module scope | 0 |

iverilog already accepts a block-item declaration in an UNNAMED block, so the table's row "declaration inside an UNNAMED `begin` -> syntax error" is false as stated, and its row "declaration inside a NAMED `begin : blk` -> compiles" is false for the shape the campaign actually captured.
The discriminator is the declaration's POSITION relative to the first statement in the block. The label is irrelevant to it.
`design.md` line 351 records the same conflation ("accepts a declaration in `begin : label`").

So the rule inserts a label that was never the variable, and 29 of 45 stay broken.

**The design decision "NAME the block, never hoist the declaration" is therefore measured wrong** - hoisting is the only one of the two candidates that fixes it. But the REASON that decision gave is still true: hoisting widens a scope, and two sibling blocks each declaring `integer i;` alias into one shared counter that still compiles and still prints check lines. A third option the original decision did not consider is stronger than either: keep the declaration block-local and MOVE it to the top of its own block, which the table's second row shows compiles and which widens no scope at all. Its cost is that it is a move rather than an insert, so Requirement 5.3's token preservation stops holding "by construction".

Open decisions are written up, with options and recommendations, in `.kiro/specs/testbench-dialect-normalization/task-14.2-questions.md`. Task 14.2's suite is NOT written; it was stopped rather than softened, because a suite with that assertion relaxed would be a green gate certifying a transform that does nothing.

Reachable population, stated honestly and with the condition attached, replacing the bare 36:
- **7 of 45** as the transform ships today (the `malformed-sized-literal` class; 3 of the 7 committed fixtures actually fixed, 4 correctly declined)
- **36 of 45** only if the `unnamed-begin` rule is changed to move or hoist the declaration

# Second measured correction, spec group 17 - the effect size is 28 of 45, and 36 was optimistic by 8

The intra-block declaration MOVE landed (spec group 15) and the effect size is no longer conditional. Measured through the real toolchain over the 40 committed fixtures:

- `unnamed-begin-declaration`: **25 of 29** fixed, 4 declined - 3 `unbalanced-block` (two C-style `}` instead of `end`, one bare prose `CHECK` line, so a `begin` never finds its `end`) and 1 `declaration-not-relocatable` (`genvar i;` in a function body, rejected as a block item at ANY position).
- `malformed-sized-literal`: **3 of 7** fixed, 4 declined `value-not-determinable`.
- `prose-as-statement`: **0 of 4**, correct and permanent - that class is reported and never rewritten.
- Total: **28 of the 40 committed fixtures**, which is 28 of the 45-sample classified population.

The "36 of 45" above is SUPERSEDED and was optimistic by **8**: it assumed ALL 29 plus ALL 7 would be fixed, and 8 fixtures across those two classes decline for reasons no meaning-preserving rewrite can reach. Predict a campaign against **28**, not 36. A campaign recovering materially fewer than 28 is a real discrepancy worth investigating, because 28 is measured on committed fixtures rather than predicted.

The pin lives in `app/test/dialect-fixtures.integration.test.ts` (`PINNED_FIXED_COUNTS`, plus `UNNAMED_BEGIN_DECLINES` and `SIZED_LITERAL_DECLINES` naming each declined fixture with its cause), so a rule that silently stops firing changes a number.

# NOT yet measured

Both halves are now measured on committed fixtures: `malformed-sized-literal` at 3 of 7 fixed with 4 correctly declined, and `unnamed-begin-declaration` at 25 of 29 with 4 correctly declined (it measured 0 of 29 with the label alone, before the move).
Neither half has been re-run against a live campaign slice, so the end-to-end recovery of verified artifacts is still unproven; that is the spec's optional task 18.1, which spends real money and is gated on founder approval.
This spec explicitly does NOT address the 229 `TESTBENCH_FAILED_REFERENCE` samples.

# Links

- `.eval-runs/stage1-screen-repair-v1/{results.jsonl,manifest.json,artifacts/}`
- `app/eval/harness.ts` (`#repairIfTriggered`, `#runSample`), `app/agent/orchestrator/verification-loop.ts` (`#repairPrecheckFailure`)
- `app/agent/orchestrator/testbench-precheck.ts` (`runWithDiagnostic`, returns `verdict.stderr` whole)
- `app/agent/roles/testbench/prompt.ts` (`DIALECT_RULE`), `prompt-version.ts` (version 3)
- `.kiro/specs/testbench-dialect-normalization/` (requirements, design, tasks, clarification-questions, clarification-answers); the corrected counts and the three confirmed defects are the "Council C" section of `clarification-answers.md`
- `app/agent/orchestrator/dialect/` - `prose-as-statement.ts` (`precedingNonWhitespaceOffset`), `unnamed-begin.ts` (`isAlreadyNamed`, `declaredNamesAfter`), `normalizer.ts` (`declaredNamesAfter`), and `sized-literal.ts` (`precedingCodeCharacter`, the CORRECT pattern)
- `app/eval/corpus/verilog-mutation.ts` (`precedingOperandCharacter`, `conditionOpenParen`, `matchingCloseParen`) - three more instances of the correct pattern
- `.kiro/specs/testbench-dialect-normalization/task-14.2-questions.md` - the open decisions the measured correction above raises
- `app/test/fixtures/dialect/index.json` - the 40 committed fixtures the correction was measured over
- [[gotcha-stage1-screen-v2-dialect-and-concurrency-are-the-two-instrument-defects]]
- [[gotcha-three-testbench-defect-classes-that-fail-the-reference-design]]
- [[gotcha-classify-captured-artifacts-by-shared-class-not-by-nearest-finding-line]]
