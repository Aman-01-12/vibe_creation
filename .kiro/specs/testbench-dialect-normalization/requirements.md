# Requirements Document

## Introduction

`testbench-repair-loop` shipped, and `.eval-runs/stage1-screen-repair-v1` measured it.
495 samples, 11 arms, n=3, at `testbenchPromptVersion: 3`.
The result is a near-zero: 259 recorded repair attempts, 2 accepted, and **0 net verified artifacts recovered**.

| arm | recorded attempts | accepted | verified artifacts recovered |
| --- | --- | --- | --- |
| precheck-triggered (can recover a sample, ships without a reference design) | 48 | 0 | 0 |
| positive-control-triggered (cannot ship, cannot recover a sample) | 211 | 2 | 0 |

Both accepted repairs still recorded `passed: false` and `outcomeStatus: instrument-refused`.
The one arm that could have recovered a sample recovered none of 48.

Two things were then verified before any option was written down, and both invalidate the reading that "repair does not work."

**First, the 259 is not a count of attempts.**
In `app/eval/harness.ts` `#repairIfTriggered`, every declined path returns `wasRepaired: false`, and `#runSample` writes `repairProvenance: wasRepaired ? {...} : precheckProvenance`.
A positive-control-path repair where the port declined therefore persists `attempted: false` and is invisible.
The 211 control-arm records are "admissible revisions produced", not "attempts", and `testbench-repair-loop` Req 4.2 ("SHALL record ... whether that attempt was made") is violated as written.

**Second, the 48 precheck failures carry no recorded hint.**
In `app/agent/orchestrator/verification-loop.ts` `#repairPrecheckFailure`, `hint` is built as a local and only `repairProvenance` escapes on `InstrumentAdmissionResult`.
All 48 precheck samples persist `repairHint: null`, so `testbench-repair-loop` Req 4.7 is violated as written.
Nothing in that campaign can attribute a decline to a stage.

Because the hint was not persisted, the 48 had to be classified out of each sample's captured `control-stderr.txt`, keyed on the FIRST `syntax error` line and the source line it names:

| count | class | example offending line |
| --- | --- | --- |
| 29 | declaration inside an unnamed `begin` block | `integer i;`, `reg [63:0] expected_Q;` |
| 7 | malformed sized literal | `16'd(-15)`, `9'di`, `8'd-1`, `{1'b0, 64{1'b1}}` |
| 4 | our own check-description prose emitted as a bare statement | `CHECK ac1_..._produces PASS;` |
| 5 | genuinely other, none of the three classes | enumerated below |
| 45 | classified population | - |

The 5 genuinely-other samples are a bit-select on a sized literal (`8'b00000000[7:1]`), a stray bare identifier statement (`rst_n;`), a forward-referenced `disable` block label, a stray extra `end`, and a bit-select on a parenthesized expression (`(i + 1)[7:0]`).
The classified population is the 45 samples whose captured `control-stderr.txt` holds a `syntax error` line.
The other 3 of the original 48 captured no `control-stderr.txt` at all, so no classification is derivable for them and they are unclassifiable rather than other.
The earlier 24 + 8 + 6 of 48 came from one unverified hand count, while the figures in this table and the three class sizes in the glossary were derived by running the real compiled `normalizeDialect` over the real captured artifacts.

`Malformed statement` (54 occurrences) is an iverilog CASCADE and not a cause: in the first sample the real defect is at line 66 while `Malformed statement` is reported at line 72.
A diagnostic that names line 72 for a defect on line 66 is a defective diagnostic, which is the second finding this spec acts on.

Calibration against the real oracle (iverilog 13.0, `-g2012` already passed) then established that the dominant class is mechanically fixable with no model call at all:

| construct | result |
| --- | --- |
| unnamed `begin`, declaration FIRST in the block | accepted |
| named `begin : blk`, declaration FIRST in the block | accepted |
| unnamed `begin`, declaration AFTER a statement | `syntax error` |
| named `begin : blk`, declaration AFTER a statement | `syntax error` |
| declaration hoisted to module scope | accepted |
| `16'd(-15)` | `syntax error` |
| `-16'd15` | accepted |

The first five rows REPLACE an earlier three-row table that read "declaration inside an UNNAMED `begin` -> `syntax error`, declaration inside a NAMED `begin : blk` -> compiles, declaration hoisted to module scope -> compiles".
That earlier table was a CONFOUNDED experiment: it compared a declaration in an unnamed block against one at the top of a NAMED block, varied the label and the position together, and credited the label.
The discriminator is the declaration's POSITION relative to the first statement of its block; the label is irrelevant to acceptance, and the campaign captured the after-a-statement case.
Do not restore the three-row form.

The effect size this classification supports is now MEASURED, against the real toolchain over the 40 committed fixtures, and is stated as the measured number plus its residue:

| figure | status |
| --- | --- |
| `unnamed-begin-declaration`: 25 of 29 fixed, 4 declined | MEASURED, once the declaration MOVE landed. The 4 are 3 `unbalanced-block` and 1 `declaration-not-relocatable` |
| `malformed-sized-literal`: 3 of 7 fixed, 4 declined | MEASURED. The 4 are declined `value-not-determinable` |
| `prose-as-statement`: 0 of 4 | MEASURED, and CORRECT and permanent: that class is detected and reported and is never rewritten |
| **28 of the 40 committed fixtures** | MEASURED fixed, which is 28 of the 45-sample classified population |

Two superseded figures are recorded here so a future reader does not restore them.
An earlier **32 of 48** rested on the unverified 24 / 8 / 6 hand count and is superseded by the verified 29 / 7 / 4 of 45.
A later **36 of 45** assumed ALL 29 unnamed-begin plus ALL 7 sized-literal samples would be fixed; the measured result is 28, not 36, because 4 unnamed-begin fixtures decline for reasons no meaning-preserving rewrite can reach and 4 sized-literal fixtures decline `value-not-determinable`.
36 was optimistic by 8, and 28 is the number a campaign should be predicted against.
This is the third premise in this spec to fail verification (after the 24 / 8 / 6 hand count and the comment-as-whitespace invariant), so the measured figure is stated with its residue at every occurrence rather than once.
See the Dialect_Fixture glossary entry for how the class counts were derived.

### Why this is not another prompt rule

`DIALECT_RULE` at prompt v3 already instructs, verbatim, that every `reg`, `integer`, and array be declared at MODULE scope before the first `initial`/`always`, and that `-9'sd1` be written rather than `9'sd-1`.
`.eval-runs/stage1-screen-repair-v1/manifest.json` records `testbenchPromptVersion: 3`, so the campaign ran WITH that rule active and still produced 29 declaration-placement and 7 sized-literal failures.
A prompt rule for this class is a MEASURED dead end, not an untried cheap fix.
That is the whole reason this spec buys a deterministic transform instead of a fifth wording attempt.

### The rulings this spec is built on, and why they are constraints here rather than questions

`clarification-answers.md` in this folder records two `decision-council` verdicts.
Council A decided on the evidence available at the time and made the classification of the 48 its gating next step; the classification then invalidated Council A's premise set, so Council B was run on the corrected evidence.
Council B governs where the two differ.
Every decision below is settled and is treated as a constraint:

- The accounting defects are ordered FIRST (Q1, Answer A).
  They have no independent product value, but nothing else in this spec is measurable until they land.
- Control-triggered repair is RETIRED (Q2, Answer A, both councils).
  It cannot ship, because the Positive_Control needs the benchmark's reference design, and it cannot recover a verified artifact, because the loop has already returned `instrument-refused`.
  The Positive_Control becomes a pure instrument gate.
- `testbench-repair-loop` Req 2.4-2.6 stay AS WRITTEN and unamended (Q3, narrowed to C).
  With the control arm retired, the anti-circularity surface shrinks rather than opens: the Testbench_Precheck involves no reference design at all, so its diagnostic was never a reference observation.
  What changes is the QUALITY of that diagnostic, not the class of fact it carries.
- Retrieval, ReAct iteration, and blind resampling are all DEFERRED for one campaign (Q4-Q7).
  RTLFixer's own ablation makes retrieval gain depend on diagnostic quality, and ours is measurably poor; a mechanical transform with zero model calls is the cheaper hypothesis and had to be measured first, and it now MEASURES at 28 of 45 over the committed fixtures - not the 36 of 45 an earlier pass predicted.
- A closed `Repair_Decline_Reason` is added, recorded SYMMETRICALLY at both trigger points (Q8, Answer A).
  Without it the next campaign is as uninterpretable as this one.

Council B's largest named risk is carried into Requirement 5 as its own requirement group rather than a footnote: **naming a block introduces a scope**, so a declaration that was illegal at block scope may, once legal, shadow a module-scope name.
Acceptance must assert meaning preservation, not merely that the output compiles.

### The third mechanical class, and why it is reported rather than rewritten

The 4 prose-as-statement failures are our own check-description text emitted as bare Verilog statements (`CHECK ac1_..._produces PASS;`).
They are mechanically DETECTABLE, so the Precheck_Diagnostic reports them by name.
2 of those 4 were undetected until the group 13 comment-adjacency fix.
They are deliberately NOT rewritten.
Emitting our own prompt prose as code is a model output-format failure, and synthesizing a `$display` from that prose would fabricate a check the model never wrote, which is exactly the kind of manufactured evidence the instrument exists to prevent.
The distinction is: the normalizer may DESUGAR what the model meant, and may never INVENT what the model failed to write.

### What this spec does NOT change

- It does NOT address the 229 `TESTBENCH_FAILED_REFERENCE` samples.
  It addresses build failures only.
  That scope limit is Council B's explicit condition on the spec (Outsider peer review) and is stated so no reported improvement in build failures is later read as progress on the functional class.
- It does NOT normalize the candidate RTL.
  Rewriting the artifact under test would break the oracle, and three of five council reviewers rejected the extension.
- It does NOT add retrieval or RAG, does NOT add ReAct-style iteration, and does NOT add a blind-resampling arm.
  All three are deferred for one campaign with reasons recorded in `clarification-answers.md`.
- It does NOT amend `testbench-repair-loop` Req 2.4-2.6.
  The anti-circularity constraint stands exactly as written.
- It does NOT reword `DIALECT_RULE`, and adds no new prompt rule for this class.
  Shrinking `DIALECT_RULE` to reclaim context budget is sequenced AFTER measurement, not inside this spec.
- It does NOT change the Verification_Loop's own oracle verdict or the Golden_Judge's verdict for any sample.
- It PRESERVES `testbench-repair-loop` Req 1.5's single-repair-call guarantee, so Session_Budget accounting and CPVA stay interpretable.
- It PRESERVES the existing import boundary: `app/agent` holds no import of `app/eval`.
- It does NOT relax any denominator rule.
  An instrument-invalid sample continues to leave the pass@k denominator.

## Glossary

- **Verification_Loop**: the generate-simulate-repair orchestrator (`app/agent/orchestrator/verification-loop.ts`).
- **Testbench_Agent**: the RTL-isolated, spec-derived testbench generator (`app/agent/roles/testbench/`).
- **Loop_Setup**: the Verification_Loop stage that produces the first candidate and the independent Testbench before any iteration (`VerificationLoop.#setup`).
- **Testbench_Precheck**: the deterministic, model-free build check of a generated Testbench against a Spec-derived Interface_Stub (`app/agent/orchestrator/testbench-precheck.ts`).
- **Interface_Stub**: the behaviour-free Verilog module declaration derived solely from the Spec's declared `moduleInterface`.
- **Dialect_Normalizer**: the new deterministic, pure, model-free source-to-source transform applied to every generated Testbench source before the Testbench_Precheck builds it.
- **Normalizer_Version**: the new build constant identifying the Dialect_Normalizer's transform behaviour, distinct from `TESTBENCH_PROMPT_VERSION`, `INSTRUMENT_POLICY_VERSION`, and `TESTBENCH_REPAIR_POLICY_VERSION`.
- **Normalizer_Report**: the closed-shape record of what the Dialect_Normalizer changed, what it detected and declined to change, and under which Normalizer_Version.
- **Dialect_Class**: one member of the closed vocabulary of mechanical defect classes the Dialect_Normalizer and the Precheck_Diagnostic name: `unnamed-begin-declaration`, `malformed-sized-literal`, `prose-as-statement`.
- **Unnamed_Begin_Block**: a `begin ... end` block carrying at least one declaration and no `: name` label, the 29-sample class iverilog rejects with `syntax error`.
  The measured discriminator for that rejection is the declaration's POSITION relative to the first statement of the block, not the absence of the label; see the Introduction's calibration table.
- **Block_Item_Declaration**: a `reg`, `integer`, `real`, `time`, `realtime`, `wire`, `localparam`, `parameter`, or `event` declaration written inside a `begin ... end` block.
  It is NOT an executable statement for the purpose of Acceptance Criterion 5.2: a bare declaration has no execution semantics, and an initialized one initializes statically before any procedural code in its block runs, both measured against iverilog 13.0.
  `genvar` is excluded, because iverilog rejects it as a block-item declaration at ANY position, and a declaration inside a `for` header is excluded, because `for (integer i = 0; ...)` is legal under `-g2012` and is not a block item.
- **Malformed_Sized_Literal**: a sized Verilog literal whose text iverilog rejects, the 7-sample class exemplified by `16'd(-15)`, `9'di`, `8'd-1`, and `{1'b0, 64{1'b1}}`.
- **Prose_As_Statement**: the 4-sample class in which our own check-description prose was emitted as a bare Verilog statement, detected and reported but never rewritten.
  2 of those 4 were undetected until the group 13 comment-adjacency fix, so an older report shows 2 for this class.
- **Meaning_Preservation**: the property that a Dialect_Normalizer output denotes the same simulation behaviour as its input, asserted independently of whether the output compiles.
- **Check_Name_Visibility_Signal**: the named early-warning signal that a normalized Testbench compiled and passed the Positive_Control while at least one of its pre-normalization check names no longer appears in the Positive_Control's captured stdout.
- **Precheck_Diagnostic**: the build diagnostic text the Testbench_Precheck surfaces for a `testbench-build-failed` outcome (`TestbenchPrecheck.runWithDiagnostic`'s `diagnostic`).
- **Testbench_Repair**: the bounded, at-most-once-per-sample step in which the Testbench_Agent revises its own Testbench from a Repair_Hint (`testbench-repair-loop`).
- **Repair_Trigger**: the measured failure that authorizes a Testbench_Repair attempt.
- **Repair_Hint**: the sanitized description of a Repair_Trigger the Testbench_Agent is given.
- **Repair_Provenance**: the first-class, closed-shape fact recording whether a Testbench_Repair was attempted and whether its product decided the sample's verdict (`app/eval/report.ts`).
- **Repair_Decline_Reason**: the new closed vocabulary naming the STAGE at which a Testbench_Repair attempt declined.
- **Testbench_Repair_Port**: the port through which the Eval_Harness drove a Positive_Control-triggered Testbench_Repair (`app/eval/testbench-repair.ts`).
- **Positive_Control**: the half of the Instrument_Control that runs our Testbench against the benchmark's known-good reference design (`app/eval/corpus/rtllm-instrument-control.ts`).
- **Negative_Control**: the half of the Instrument_Control that runs our Testbench against deliberately mutated reference designs (`app/eval/mutation-control.ts`).
- **Instrument_Refused**: the terminal Verification_Loop outcome reporting that the Testbench was not admissible.
- **Recorded_Instrument_Verdict**: the closed discriminated union one sample's instrument verdict is reported, persisted, and rendered as (`app/eval/instrument-control.ts`).
- **Session_Budget**: the single per-sample budget every model call and every simulate call in the loop is charged against (`SessionBudgetHandle`).
- **Eval_Harness**: the module that runs the subset, measures each sample, and assembles the report (`app/eval/harness.ts`).
- **Results_Log**: the persisted sample-record schema, its encoder, and its decoder (`app/eval/sweep/results-log.ts`).
- **Artifact_Sink**: the per-sample evidence seam and its derivation (`app/eval/artifact-sink.ts`).
- **Sweep_Summary**: the module that aggregates persisted records into the reported numbers and renders them (`app/eval/sweep/summary.ts`).
- **Sweep_Manifest**: the per-run provenance document (`app/eval/sweep/manifest.ts`).
- **Config_Identity**: the canonical experiment fingerprint every persisted record is keyed by (`app/eval/sweep/config-identity.ts`).
- **Dialect_Fixture**: one captured testbench source from the 29 + 7 + 4 classified `stage1-screen-repair-v1` artifacts, committed as evidence.
  The earlier 24 + 8 + 6 of 48 came from one unverified hand count.
  The verified 29 + 7 + 4 of 45 was derived by running the real compiled `normalizeDialect` over the real captured artifacts and reading every unclassified residue by hand at its exact iverilog error line, so a future reader does not restore the old figures.
  The classified population is the 45 samples whose `control-stderr.txt` contains `syntax error`; the other 3 captured no `control-stderr.txt` at all, so no classification is derivable for them.

## Requirements

### Requirement 1: A declined repair attempt is recorded as an attempt

**User Story:** As the engineer reading a campaign, I want a repair attempt that the port declined recorded as an attempt, so that a reported attempt count is a count of attempts rather than a count of the subset that succeeded.

Evidence: `app/eval/harness.ts` `#repairIfTriggered` returns `wasRepaired: false` on every declined path, and `#runSample` writes `repairProvenance: wasRepaired ? {...} : precheckProvenance`, so a declined control-path repair persists `attempted: false`.
This violates `testbench-repair-loop` Req 4.2 as written, and it means the campaign's 211 control-arm records describe admissible revisions produced rather than attempts made.

#### Acceptance Criteria

1. WHEN the Eval_Harness consults the Testbench_Repair_Port for a sample, THE Eval_Harness SHALL record Repair_Provenance with `attempted` true for that sample, whatever the port then decides.
2. WHERE a Testbench_Repair attempt produced no revised Testbench, THE Eval_Harness SHALL record Repair_Provenance with `attempted` true and `accepted` false, and SHALL NOT record `attempted` false.
3. WHERE a Testbench_Repair attempt produced a revised Testbench that then failed its re-check, THE Eval_Harness SHALL record Repair_Provenance with `attempted` true and `accepted` false.
4. WHERE no trigger fired for a sample and no Testbench_Repair attempt was made at either trigger point, THE Eval_Harness SHALL record Repair_Provenance with `attempted` false.
5. THE Eval_Harness SHALL derive a sample's recorded Repair_Provenance from the union of what both trigger points reported for that sample, so a precheck-path attempt and a control-path attempt are each independently able to set `attempted` true.
6. THE Eval_Harness SHALL decide a sample's recorded Repair_Provenance from a value the repair step itself returned, and SHALL NOT decide it from whether a revised Testbench was accepted.
7. THE Sweep_Summary SHALL report, per arm, the count of samples for which a Testbench_Repair was attempted, counting every declined attempt in that total.

### Requirement 2: The Repair_Hint a precheck-path repair was built from is persisted

**User Story:** As the engineer diagnosing why 48 of 48 precheck-path repairs failed, I want the hint each attempt was actually given persisted with the sample, so that the next campaign's failures are classifiable from the artifacts instead of by hand.

Evidence: `app/agent/orchestrator/verification-loop.ts` `#repairPrecheckFailure` builds `hint` as a local and returns only `repairProvenance` on `InstrumentAdmissionResult`, so all 48 precheck-arm samples persist `repairHint: null`.
This violates `testbench-repair-loop` Req 4.7 as written, and it is why the 48 had to be classified by reading `control-stderr.txt` by hand.

#### Acceptance Criteria

1. WHERE a precheck-path Testbench_Repair attempt was made, THE Verification_Loop SHALL carry the Repair_Hint that attempt was built from on the result it returns to its caller.
2. THE Verification_Loop SHALL carry the Repair_Hint on both the refusal path and the accepted-repair path, so a hint is recorded for a declined attempt as well as an accepted one.
3. WHERE a precheck-path Testbench_Repair attempt was made, THE Artifact_Sink SHALL persist the Repair_Hint text for that sample, bounded by a fixed maximum length in the same manner `MAX_ATTRIBUTION_LINES` already bounds diagnostic capture.
4. WHERE a precheck-path Testbench_Repair attempt was made, THE Artifact_Sink SHALL persist the pre-repair Testbench source under a filename distinct from the accepted Testbench's filename.
5. THE Repair_Hint SHALL reach the Artifact_Sink as a closed-shape field on a terminal outcome, and SHALL NOT reach it encoded as free text inside an existing note, message, or diagnostic field.
6. THE Artifact_Sink SHALL persist no Repair_Hint for a sample whose terminal outcome carries none.

### Requirement 3: A declined repair records the stage at which it declined, symmetrically at both trigger points

**User Story:** As the engineer choosing what to build next, I want a declined repair to name the stage it declined at, so that "the model produced nothing admissible" is distinguishable from "the revision failed its re-check" without re-reading artifacts.

Evidence: `clarification-answers.md` Q8, Answer A, reinforced by Council A's Contrarian: the decline stage was unmeasurable in `stage1-screen-repair-v1`, and without it the next campaign is equally uninterpretable.
Both call sites already branch on exactly these stages and discard the distinction: `#repairPrecheckFailure` returns one `attemptedButDeclined` value from four different branches, and `#repairIfTriggered` returns one `declined` value from five.

#### Acceptance Criteria

1. THE Repair_Decline_Reason SHALL be a closed, enumerable vocabulary whose members are `no-admissible-revision`, `coverage-validation-failed`, `recheck-failed`, `port-threw`, and `port-unavailable`.
2. WHERE a Testbench_Repair attempt declined, THE Repair_Provenance SHALL carry exactly one Repair_Decline_Reason.
3. WHERE a Testbench_Repair attempt was accepted, THE Repair_Provenance SHALL carry no Repair_Decline_Reason.
4. WHERE no Testbench_Repair attempt was made, THE Repair_Provenance SHALL carry no Repair_Decline_Reason.
5. IF the repair call returned a status other than a generated Testbench, THEN THE Repair_Provenance SHALL carry the Repair_Decline_Reason `no-admissible-revision`.
6. IF the repair call returned a revised source that the coverage-validation rule applied to first-draft Testbenches rejects, THEN THE Repair_Provenance SHALL carry the Repair_Decline_Reason `coverage-validation-failed`.
7. IF a revised Testbench failed the re-check a first-draft Testbench is held to, THEN THE Repair_Provenance SHALL carry the Repair_Decline_Reason `recheck-failed`.
8. IF the repair call threw, THEN THE Repair_Provenance SHALL carry the Repair_Decline_Reason `port-threw`.
9. IF no Testbench_Repair_Port was wired for a fired Repair_Trigger, THEN THE Repair_Provenance SHALL carry the Repair_Decline_Reason `port-unavailable`.
10. THE Verification_Loop and the Eval_Harness SHALL each record Repair_Decline_Reason values drawn from the single vocabulary named in Acceptance Criterion 3.1, so a decline recorded at the precheck trigger point and a decline recorded at the control trigger point are comparable without translation.
11. THE Results_Log SHALL persist the Repair_Decline_Reason for every sample whose Repair_Provenance carries one.
12. THE Results_Log SHALL accept only the members of the Repair_Decline_Reason vocabulary on read, and SHALL report any other value as a malformed record.
13. THE Sweep_Summary SHALL report, per arm, the count of declined Testbench_Repair attempts under each Repair_Decline_Reason that holds at least one sample.

### Requirement 4: Every generated testbench is desugared by a deterministic transform before it is built

**User Story:** As the engineer paying for a campaign, I want the two mechanical dialect defects fixed by a transform that costs no model call, so that the mechanically-reachable build failures stop consuming a repair budget that recovered nothing.

The MEASURED effect over the 40 committed fixtures is 28 fixed: 25 of 29 `unnamed-begin-declaration` (4 declined, 3 `unbalanced-block` and 1 `declaration-not-relocatable`), 3 of 7 `malformed-sized-literal` (4 declined `value-not-determinable`), and 0 of 4 `prose-as-statement`, which is correct and permanent because that class is reported and never rewritten.
That is 28 of the 45-sample classified population, and it supersedes an earlier 36 of 45 that assumed all 29 plus all 7 would be fixed; see the Introduction's effect-size table for the superseded figures and why they are not restored.

Evidence: 29 of the 45 precheck failures are a declaration inside an Unnamed_Begin_Block and 7 are a Malformed_Sized_Literal.
iverilog 13.0 calibration with `-g2012` already passed confirms that a declaration placed FIRST in its block is accepted whether or not the block is named, that a declaration after a statement is rejected whether or not the block is named, that hoisting the declaration to module scope is accepted, and that `-16'd15` compiles where `16'd(-15)` does not.
`DIALECT_RULE` at prompt v3 already instructs both, and the campaign ran with it active and produced these 36 mechanically-reachable failures anyway, so a prompt rule for this class is a measured dead end.

#### Acceptance Criteria

1. WHEN the Testbench_Agent has produced a Testbench source, THE Verification_Loop SHALL apply the Dialect_Normalizer to that source before the Testbench_Precheck builds it.
2. THE Verification_Loop SHALL apply the Dialect_Normalizer to every generated Testbench source unconditionally, with no trigger condition and no dependence on any prior build outcome.
3. THE Verification_Loop SHALL apply the Dialect_Normalizer to a revised Testbench source produced by a Testbench_Repair, by the same unconditional rule it applies to a first-draft source.
4. THE Dialect_Normalizer SHALL make no model call.
5. THE Dialect_Normalizer SHALL read no candidate RTL, so the anti-circular guarantee that `testbench-repair-loop` Req 1.6 extends to the repair path extends to the transform with no new channel added.
6. THE Dialect_Normalizer SHALL perform no file, network, clock, or random-source read, so its output is a pure function of its input source text and the Normalizer_Version.
7. WHEN the Dialect_Normalizer is applied twice to the same input source, THE Dialect_Normalizer SHALL produce the identical output both times.
8. WHEN the Dialect_Normalizer is applied to its own output, THE Dialect_Normalizer SHALL produce that output unchanged.
9. WHERE a Testbench source holds an Unnamed_Begin_Block carrying at least one declaration, THE Dialect_Normalizer SHALL name that block.
10. WHERE a Testbench source holds a Malformed_Sized_Literal whose intended value is determinable from its own text under the toolchain's numeric semantics, THE Dialect_Normalizer SHALL rewrite that literal into a form the toolchain accepts.
11. WHERE a Malformed_Sized_Literal's intended value is not determinable from its own text, THE Dialect_Normalizer SHALL leave that literal unchanged and SHALL report it under the Dialect_Class `malformed-sized-literal`.
12. THE Dialect_Normalizer SHALL rewrite no construct outside the Dialect_Classes `unnamed-begin-declaration` and `malformed-sized-literal`.
13. THE Dialect_Normalizer SHALL leave a Prose_As_Statement unchanged.
14. THE Dialect_Normalizer SHALL produce a Normalizer_Report naming, per Dialect_Class, what it changed and what it detected and declined to change.
15. THE Dialect_Normalizer SHALL live in `app/agent` and SHALL hold no import of `app/eval`, preserving the import boundary `instrument-precheck-and-attribution` Req 9.7 established.
16. THE Dialect_Normalizer SHALL NOT be invoked from the Testbench_Repair path as a repair step, because it is desugaring rather than repair and has no Repair_Trigger.
17. THE Testbench_Precheck, the Verification_Loop's oracle, the Positive_Control, the Negative_Control, and the Artifact_Sink SHALL all read the same single post-normalization Testbench source for a given sample, so one Testbench is measured per sample rather than two.
18. WHERE the Dialect_Normalizer changed a Testbench source, THE Artifact_Sink SHALL persist the pre-normalization source under a filename distinct from the post-normalization source's filename, and SHALL persist the Normalizer_Report.
19. THE Dialect_Normalizer SHALL apply to the Testbench source alone, and SHALL NOT be applied to any candidate RTL source.

### Requirement 5: The transform preserves meaning, and a silently-emptied instrument is flagged

**User Story:** As the engineer trusting the instrument, I want the transform proven to preserve what the testbench means rather than merely proven to compile, so that a testbench which now builds and checks nothing can never be counted as a normalizer success.

Evidence: `clarification-answers.md` records this as Council B's largest named risk.
Naming a `begin` block introduces a scope, so a declaration that was illegal at block scope becomes legal and may shadow a module-scope name of the same identifier.
Council B's named early-warning signal is a normalized testbench that compiles and passes the Positive_Control while its check names no longer appear in that control's stdout.

Acceptance Criterion 5.3 was AMENDED after task 14.2 measured the `unnamed-begin-declaration` rule at 0 of 29.
The amendment is scoped to exactly one thing: it permits a declaration to be relocated to the top of the block it is already declared in, which is the transform the measured defect needs, and it keeps every other preservation claim intact.
Four facts were measured against iverilog 13.0 with `-g2012`, and they are what the amendment rests on rather than an argument from first principles:

- A block-item declaration is accepted as the FIRST item of its block and rejected after a statement, whether or not the block carries a label, so the move is the fix and the label is not.
- A bare declaration has no execution semantics, and an INITIALIZED declaration initializes statically before any procedural code in its block runs: `integer c = 0;` inside a `for` body initialized ONCE across three iterations, and `integer i = src;` read `x` even though another `initial` had already assigned `src = 9` at t=0.
  So moving an initialized declaration WITHIN its own block cannot change when initialization happens, and no decline is needed for the 19 such declarations across 8 of the 29 fixtures.
  The accompanying iverilog warning is `Static variable initialization requires explicit lifetime in this context`.
- The code-token multiset of output equals input for 29 of 29 fixtures with the move applied, the sole addition being the inserted labels, and the comment multiset is unchanged for 29 of 29.
  That is why 5.3 is now an ASSERTED and measured property rather than a free consequence of insert-only editing.
- A block-local declaration inside an unnamed `begin` does not leak to the enclosing scope: an outside reference fails with `Unable to bind wire/reg/memory` identically whether the block is named or unnamed, and with `integer i;` at both module and block scope the module-scope `i` reads `x` after simulation in both variants.
  So naming never created the shadow hazard Acceptance Criterion 5.4 guards, and the move keeps the declaration block-local, which leaves scope unchanged either way.
  5.4 is retained unamended as a conservative guard whose ceiling is false declines only.

Naming the block is retained for IEEE 1364 conformance, which requires a named block for block-item declarations, and for that reason ALONE.
It buys nothing from the deterministic oracle: iverilog is lenient here, and a move-only transform fixes the same 25 of 29 fixtures with zero disagreement fixture by fixture.

#### Acceptance Criteria

1. THE Dialect_Normalizer SHALL preserve the set of check names present in its input source, so no rewrite adds, removes, or renames a check.
2. THE Dialect_Normalizer SHALL preserve the order of executable statements present in its input source.
3. THE Dialect_Normalizer SHALL preserve the multiset of code tokens and the multiset of comments present in its input source, adding only the block labels it generates under the Dialect_Class `unnamed-begin-declaration`.
4. WHERE naming an Unnamed_Begin_Block would place a declaration into a new scope in which an identifier of the same name is already declared at module scope, THE Dialect_Normalizer SHALL leave that block unchanged and SHALL report it under the Dialect_Class `unnamed-begin-declaration`.
5. THE Dialect_Normalizer SHALL choose a block name that collides with no identifier present in its input source.
6. WHERE the Dialect_Normalizer rewrites a Malformed_Sized_Literal, THE rewritten literal SHALL denote the same value and the same bit width as the input literal denotes under the toolchain's numeric semantics.
7. THE Dialect_Normalizer SHALL decline a rewrite it cannot perform without changing meaning, and SHALL report the declined Dialect_Class, rather than emit a rewrite whose meaning it cannot establish.
8. WHERE a Testbench source was changed by the Dialect_Normalizer AND that Testbench passed the Positive_Control AND at least one check name present in the pre-normalization source does not appear in the Positive_Control's captured stdout, THE Eval_Harness SHALL record that sample under the Check_Name_Visibility_Signal.
9. WHERE a sample carries the Check_Name_Visibility_Signal, THE Sweep_Summary SHALL report that sample distinctly from a normalized sample that passed the Positive_Control with every pre-normalization check name present in the control's stdout.
10. THE Results_Log SHALL persist the Check_Name_Visibility_Signal for every sample that carries it.
11. THE Check_Name_Visibility_Signal SHALL change neither the Verification_Loop's own oracle verdict nor the Golden_Judge's verdict for any sample.
12. THE Dialect_Normalizer SHALL preserve meaning under Acceptance Criteria 5.1 through 5.7 for every input source, including a source the Testbench_Precheck would have refused and a source the Testbench_Precheck would have admitted unchanged.
13. WHERE the Dialect_Normalizer relocates a declaration, THE Dialect_Normalizer SHALL place that declaration ahead of the first executable statement of the block the declaration is declared in, preserving the relative source order of every declaration it relocates within that block.
14. WHERE the Dialect_Normalizer relocates a declaration, THE relocated declaration SHALL remain inside the block it was declared in, so the set of scopes in which its identifier is visible is unchanged.

### Requirement 6: The precheck diagnostic names the first real error and the line it is on

**User Story:** As the engineer classifying a build failure, I want the diagnostic to report the first `syntax error` with the source line it names, so that a repair attempt and a human reader are both pointed at the defect rather than at a cascade six lines away.

Evidence: `Malformed statement` appears 54 times across the 48 precheck failures and is an iverilog cascade, not a cause.
In the first sample the real defect is at line 66 while `Malformed statement` is reported at line 72.
`TestbenchPrecheck.runWithDiagnostic` currently returns `verdict.stderr` whole, so whatever ordering and cascade the toolchain emitted is what a reader and a Repair_Hint both receive.

#### Acceptance Criteria

1. WHERE a Testbench_Precheck outcome is `testbench-build-failed` AND the captured diagnostics hold at least one `syntax error` line naming the Testbench file, THE Precheck_Diagnostic SHALL report the FIRST such line.
2. WHERE the Precheck_Diagnostic reports a diagnostic line naming a source location in the Testbench file, THE Precheck_Diagnostic SHALL also report the text of the Testbench source line that location names.
3. THE Precheck_Diagnostic SHALL NOT report a cascade diagnostic line as the first error where an earlier `syntax error` line naming the Testbench file is present in the captured diagnostics.
4. WHERE a Testbench_Precheck outcome is `testbench-build-failed` AND the captured diagnostics hold no `syntax error` line, THE Precheck_Diagnostic SHALL report the first diagnostic line naming the Testbench file.
5. WHERE a Testbench_Precheck outcome is `testbench-build-failed` AND no diagnostics were captured, THE Precheck_Diagnostic SHALL report that no diagnostic was captured, and SHALL NOT report an empty diagnostic indistinguishable from an unrun precheck.
6. THE Precheck_Diagnostic SHALL be bounded by a fixed maximum length, in the same manner `MAX_ATTRIBUTION_LINES` already bounds diagnostic capture.
7. THE Precheck_Diagnostic SHALL read at most a fixed maximum number of captured diagnostic lines when identifying the first error, so an unbounded diagnostic stream cannot cost unbounded work.
8. THE Precheck_Diagnostic SHALL derive the source line it reports from the Testbench source this process itself submitted, and SHALL NOT derive it from any path named in the diagnostic text.
9. WHERE the Testbench source holds a Prose_As_Statement, THE Precheck_Diagnostic SHALL report that source under the Dialect_Class `prose-as-statement`.
10. THE Precheck_Diagnostic SHALL report a detected Prose_As_Statement without rewriting it, because emitting our own prompt prose as code is a model output-format failure and synthesizing a check from that prose would fabricate a check the model did not write.
11. THE Precheck_Diagnostic SHALL carry no content beyond the toolchain's own diagnostic text, the named Testbench source line, and a Dialect_Class, so it introduces no class of fact that `testbench-repair-loop` Req 2.4 through 2.6 forbid.
12. THE Artifact_Sink SHALL persist the Precheck_Diagnostic for every sample whose Testbench_Precheck reported `testbench-build-failed`.

### Requirement 7: Control-triggered repair is retired and the positive control becomes a pure instrument gate

**User Story:** As the engineer paying per model call, I want the repair arm that cannot ship and cannot recover an artifact removed, so that a campaign stops spending a call per refused sample to produce a relabelled eval metric.

Evidence: the control arm produced 2 accepted repairs of 211, and both still recorded `passed: false` and `outcomeStatus: instrument-refused`, so its net recovered artifacts are 0.
It cannot ship at all, because the Positive_Control requires the benchmark's reference design, which a student session does not have.
`clarification-answers.md` Q2, Answer A, is the verdict of both councils.

#### Acceptance Criteria

1. THE Eval_Harness SHALL NOT consult a Testbench_Repair_Port for a Positive_Control result, under any Recorded_Instrument_Verdict.
2. THE Eval_Harness SHALL make no model call on behalf of a Positive_Control result.
3. WHERE a Positive_Control reports a Recorded_Instrument_Verdict of `invalid`, THE Eval_Harness SHALL finalize that verdict, by the identical rule it applied before the Testbench_Repair_Port existed.
4. THE Testbench_Repair SHALL fire only on a Testbench_Precheck outcome of `testbench-build-failed`, so exactly one Repair_Trigger remains.
5. THE Verification_Loop SHALL attempt a Testbench_Repair at most once per sample, preserving `testbench-repair-loop` Req 1.5's guarantee of exactly one repair model call when a repair fires.
6. THE Positive_Control SHALL continue to decide a sample's Recorded_Instrument_Verdict under the identical pass and fail rules it applies today, so retiring the repair arm relaxes no measurement.
7. THE Negative_Control SHALL run under the identical `MutationConfig`, wall-clock cap, and zero-coverage-gap gate it runs under today.
8. THE pass@k denominator predicate SHALL continue to report a sample whose instrument validity is other than `valid` as not counted.
9. THE Sweep_Summary SHALL report no count of Positive_Control-triggered Testbench_Repair attempts, because no such attempt can occur.
10. THE Eval_Harness SHALL read a sample's `SessionBudgetHandle` for the persisted record after the Verification_Loop has returned, and SHALL NOT hold that read open for a repair-and-recheck sequence that can no longer occur.

### Requirement 8: The normalizer version is part of the experiment's identity

**User Story:** As the engineer comparing two campaigns, I want a sample measured under one transform structurally unable to pool with a sample measured under another, so that a change in build-failure count is attributable to the change that caused it.

Evidence: `clarification-answers.md`, Council B, Executor item 3: the normalizer version MUST be folded into the sweep config identity alongside `TESTBENCH_PROMPT_VERSION`, or campaigns either side are not comparable.
`app/eval/sweep/config-identity.ts` already folds in `TESTBENCH_PROMPT_VERSION`, `INSTRUMENT_POLICY_VERSION`, and `TESTBENCH_REPAIR_POLICY_VERSION` under reserved keys read directly from the build constants, and this is the fourth such identity.

#### Acceptance Criteria

1. THE build SHALL expose a Normalizer_Version constant, distinct from `TESTBENCH_PROMPT_VERSION`, `INSTRUMENT_POLICY_VERSION`, and `TESTBENCH_REPAIR_POLICY_VERSION`.
2. THE Config_Identity SHALL include the Normalizer_Version in the canonical experiment fingerprint, under its own reserved key, by the same fold-in pattern `TESTBENCH_REPAIR_POLICY_VERSION` already uses.
3. WHEN the Normalizer_Version changes, THE Config_Identity SHALL produce a different hash for an otherwise identical config.
4. THE Config_Identity SHALL read the Normalizer_Version directly from the build constant, so `sweepConfigHash`'s signature and its call sites stay unchanged.
5. THE Sweep_Manifest SHALL record the Normalizer_Version and SHALL read it from the same build constant the Config_Identity reads.
6. THE pinned config-hash constants in the sweep tests SHALL be updated to the hashes the changed identity produces.
7. THE Normalizer_Version SHALL change whenever the set of rewrites the Dialect_Normalizer performs changes, so two runs reporting the same Normalizer_Version applied the same transform.
8. THE Results_Log SHALL report a record schema version greater than 11.
9. THE Results_Log SHALL refuse to aggregate a results file holding records written under a lower schema version, by the same refusal rule `RESULTS_SCHEMA_VERSION` 11 already applies to a version 10 record.
10. THE Results_Log advice text SHALL state that Repair_Provenance gained a Repair_Decline_Reason, that a recorded repair attempt changed meaning, and that a fresh output directory is required.
11. THE artifact document schema version SHALL be greater than 8, because a captured sample now carries a pre-normalization Testbench source, a Normalizer_Report, and a Precheck_Diagnostic.
12. THE Normalizer_Version SHALL identify the transform alone, and SHALL NOT be bumped to carry a `TESTBENCH_PROMPT_VERSION` change, because `prompt-version.test.ts` pins a digest of the assembled prompt against that separate constant.

### Requirement 9: The measured failures become committed fixtures that fail before the transform and build after it

**User Story:** As the engineer who has to believe the transform works, I want the exact artifacts that failed the campaign committed as fixtures, so that every claimed effect size is asserted against measured evidence rather than against sources written to pass.

The fixtures are what turned the effect-size claim from an assertion into a measurement, and the measurement disagreed with the claim twice over.
First it read 3 of the 40 fixed and 0 of the 29 `unnamed-begin-declaration` fixtures, because the label was never the discriminator.
Then, with the declaration move landed, it reads 28 of the 40 fixed - 25 of 29, 3 of 7, and 0 of 4 - which is 8 short of the 36 of 45 the earlier pass predicted, because 4 unnamed-begin fixtures and 4 sized-literal fixtures decline for reasons no meaning-preserving rewrite can reach.
See the Introduction's effect-size table.

Evidence: `app/test/testbench-precheck-measured-cases.integration.test.ts` already sets the precedent of treating captured campaign artifacts as evidence rather than as broken fixtures to be repaired.
The 29 Unnamed_Begin_Block, 7 Malformed_Sized_Literal, and 4 Prose_As_Statement sources are all present in `.eval-runs/stage1-screen-repair-v1/artifacts`.
The 29 + 7 + 4 of 45 counts are the verified figures and they replace an earlier 24 + 8 + 6 of 48; see the Dialect_Fixture glossary entry for how they were derived.

#### Acceptance Criteria

1. THE repository SHALL commit, as Dialect_Fixtures, the captured Testbench sources for the 29 classified `unnamed-begin-declaration` samples, the 7 classified `malformed-sized-literal` samples, and the 4 classified `prose-as-statement` samples.
2. THE Dialect_Fixtures SHALL be committed as the captured source text, unedited, so a fixture is evidence of what a model actually produced.
3. THE Dialect_Fixture set SHALL record, per fixture, the Dialect_Class it was classified under and the first `syntax error` line the campaign captured for it.
4. WHEN a `unnamed-begin-declaration` Dialect_Fixture is built by the Testbench_Precheck without the Dialect_Normalizer applied, THE Testbench_Precheck SHALL report `testbench-build-failed`.
5. WHEN a `unnamed-begin-declaration` Dialect_Fixture is built by the Testbench_Precheck with the Dialect_Normalizer applied, THE Testbench_Precheck SHALL report an outcome other than `testbench-build-failed`.
6. WHEN a `malformed-sized-literal` Dialect_Fixture whose intended value is determinable from its own text is built by the Testbench_Precheck with the Dialect_Normalizer applied, THE Testbench_Precheck SHALL report an outcome other than `testbench-build-failed`.
7. WHEN a `prose-as-statement` Dialect_Fixture is built by the Testbench_Precheck with the Dialect_Normalizer applied, THE Testbench_Precheck SHALL report `testbench-build-failed`, because a Prose_As_Statement is reported rather than rewritten.
8. WHEN the Dialect_Normalizer is applied to a `prose-as-statement` Dialect_Fixture, THE Precheck_Diagnostic SHALL report that fixture under the Dialect_Class `prose-as-statement`.
9. WHEN the Dialect_Normalizer is applied to any Dialect_Fixture, THE check names present in that fixture SHALL all be present in the output source.
10. THE Dialect_Fixture tests SHALL run against the same Testbench_Precheck and the same toolchain the campaign runs against, so a fixture's build outcome is decided by the real oracle.
11. THE Dialect_Fixture tests SHALL report a fixture the Dialect_Normalizer declined to change as a declined fixture, and SHALL NOT report it as a failure of the test suite, because a declined rewrite is the meaning-preserving outcome Requirement 5.7 demands.
12. THE Dialect_Fixtures SHALL hold no reference design source, so committing them adds no reference observation to the repository's test inputs.

### Requirement 10: The existing engineering gate is preserved

**User Story:** As the engineer who has to trust the harness that produces the number, I want every change in this spec held to the gate the repository already passes, so that a change made to reduce build failures is not the thing that breaks the build.

#### Acceptance Criteria

1. WHEN a change in this spec is complete, THE repository SHALL compile under `npx tsc -b` with no reported error.
2. WHEN a change in this spec is complete, THE repository SHALL pass `npx eslint app scripts --max-warnings=0` with no reported warning.
3. WHEN a change in this spec is complete, THE repository SHALL pass `npx prettier --check .` with no reported violation.
4. WHEN a change in this spec is complete, THE repository SHALL pass `npx vitest run` with no fewer passing tests than the count measured immediately before this spec's changes began.
5. THE `npx eslint app scripts --max-warnings=0` run SHALL report no import-boundary violation for any module added by this spec.
6. THE `app/agent` package SHALL hold no import of the `app/eval` package as a result of any module added by this spec.
7. THE property test asserting Property 4 (RTL isolation for testbench generation) SHALL be extended to cover the Dialect_Normalizer with the same assertion it already applies to `generateTestbench` and to the Testbench_Agent's repair method.
