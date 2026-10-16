# Requirements Document

## Introduction

`instrument-precheck-and-attribution` closed four mechanical harness defects and, as a side
effect of the ordering it added, measured something new: a Testbench_Precheck and an
Instrument_Admission port that refuse a broken instrument BEFORE the repair budget is spent.
Both refusals are unconditional today - a testbench that fails either check is refused once,
never regenerated. That deferral was deliberate (`instrument-precheck-and-attribution`,
"What this spec does NOT change": "Regenerating the Testbench once after a failed
Testbench_Precheck and re-running the precheck is deliberately DEFERRED, not rejected... the
decision needs a measured frequency of testbench build failure that does not exist yet").

That frequency now exists. `.eval-runs/stage1-screen-v3` (495 samples, 11 models x 15 RTLLM
designs x n=3, under `TESTBENCH_PROMPT_VERSION` 3):

| defect | count | share of 495 |
| --- | --- | --- |
| `TESTBENCH_FAILED_REFERENCE` (builds, runs, rejects the known-good reference) | 226 | 46% |
| `TESTBENCH_REFERENCE_UNBUILDABLE` (does not compile) | 64 | 13% |
| `TESTBENCH_SURVIVED_MUTANTS` | 16 | 3% |
| `CONTROL_RUN_ERRORED` | 16 | 3% |
| instrument-valid (both controls pass) | 42 | 8.5% |

Three successive `TESTBENCH_PROMPT_VERSION` rewrites aimed at the `TESTBENCH_FAILED_REFERENCE`
class have each failed to shrink it. The first two are recorded in
`gotcha-three-testbench-defect-classes-that-fail-the-reference-design`: an assumed cycle
became a predicted per-cycle qualifier became a misaligned input window, three different
disguises across two rewrites, none of which reduced the class. The third
(`gotcha-stage1-screen-v2-dialect-and-concurrency-are-the-two-instrument-defects`) added a
`CONCURRENCY_RULE` targeted at exactly this class and, on `stage1-screen-v3`'s measurement,
the class moved from its pre-v3 count to 226 with the population shifting to a different
disguise nearly 1:1 rather than shrinking - a fourth prompt-wording attempt has no evidence
behind it that a fifth attempt would fare differently.

This spec is the structural alternative: when a generated testbench fails a control in a way
that would otherwise finalize an `instrument-refused` outcome or an `invalid` classification,
the Testbench_Agent gets exactly one chance to revise its own testbench from a sanitized
description of that specific, measured failure - not from a prediction of what it might get
wrong next.

### The founder's ruling this spec is built on, and why it is a constraint here, not a question

`clarification-answers.md` in this folder already decided the one question with a real
circularity cost: what the repair prompt may see. The decision is **Option C, with Option A
folded in**, and it is restated here because every requirement group below depends on it:

- A **compiler or build diagnostic** (from the Testbench_Precheck, or from a build-failed
  positive-control run) may be passed to the model **verbatim**. It reveals nothing about any
  implementation's behaviour - a syntax error in our own file is not reference-derived - so
  there is no circularity cost to passing it through unmodified.
- A **functional failure** (`TESTBENCH_FAILED_REFERENCE`: the testbench built, ran, and
  rejected the known-good reference) may be described to the model **only as a classified
  hint**: the failing check's name, and a defect class drawn from a closed, non-exhaustive-but-
  stated vocabulary. The model must never receive the reference's observed output value, a
  diff against the reference, the reference's source, or any text from which the reference's
  behaviour could be reconstructed.

Why not the stronger signal (Option B, the functional failure verbatim): the signal fed back
for a `TESTBENCH_FAILED_REFERENCE` repair **is** the positive control's own evidence. Repairing
the testbench by that exact signal spends the positive control's independence to fix the
positive control, which is what "our testbench passes the reference" exists to measure in the
first place. Measured reason to not spend that independence casually: of 58 samples that
passed the positive control in `stage1-screen-v3`, only 16 failed the negative control
(mutation coverage) - about 28%. The negative control does real, independent work, but it is
not yet measured as sufficient to carry instrument validity alone if the positive control's
independence is spent. `clarification-answers.md` records this as a decision that can be
revisited later, explicitly and separately, once the negative control is strengthened - never
as a side effect of this spec wanting a bigger `instrument-valid` count.

Two further requirements-level decisions were delegated to this analysis and are recorded in
`clarification-answers.md`'s second section (Q1-Q3), and are likewise treated here as settled
constraints rather than open questions:

- the repair call for a positive-control-caused refusal is driven by a **new port**, symmetric
  to the existing `InstrumentAdmission` port, rather than folded into
  `MemoizingInstrumentAdmission`'s existing contract;
- the identity carrier for this change is a **new build constant** (`TESTBENCH_REPAIR_POLICY_VERSION`
  or equivalent name settled in design), distinct from `INSTRUMENT_POLICY_VERSION`;
- the classified-hint vocabulary is a **small, closed, non-conditional enum**, never the
  conditional prose the existing rule-describing functions in `prompt.ts` build for the
  generation prompt.

### What this spec does NOT change

- RTL generation and its existing repair path (`GenerationAgent.reviseFromErrors`) are
  untouched. This spec adds a repair path for the **testbench**, which today has none.
- The negative (mutation) control - its operators, its zero-coverage-gap gate, its kill-rate
  reporting - is untouched. `clarification-answers.md`'s 28% figure is cited as the reason
  Option B is deferred, not as a target this spec moves.
- Option B (verbatim functional failures fed back to the repair) is not adopted. It remains
  available as a future, separately-decided move, per the founder's ruling above.
- No change is made to `TESTBENCH_PROMPT_VERSION`, `EXPECTED_VALUE_RULE`, `CONCURRENCY_RULE`,
  `describeTiming`, `describeInputWindow`, `describeStateAnchoring`, or `describeStimulusAdequacy`.
  Those rules govern the FIRST draft; this spec governs what happens after a first draft is
  measured to have failed a specific, named control.
- No change is made to how the negative control is combined with the positive control
  (`combineInstrumentControls`), except that both controls must be able to run again, unchanged,
  against a repaired testbench (Requirement 3).

## Glossary

- **Verification_Loop**: the generate-simulate-repair orchestrator (`app/agent/orchestrator/verification-loop.ts`).
- **Testbench_Agent**: the RTL-isolated, spec-derived testbench generator (`app/agent/roles/testbench/`).
- **Testbench_Precheck**: the deterministic, model-free build check of a generated Testbench against a Spec-derived Interface_Stub (`app/agent/orchestrator/testbench-precheck.ts`).
- **Instrument_Admission**: the optional port `VerificationLoop#admitInstrument` consults, after the Testbench_Precheck and before the first iteration, to learn whether the Testbench is an admissible instrument (`app/agent/orchestrator/instrument-admission.ts`).
- **Instrument_Refused**: the terminal Verification_Loop outcome reporting that the Testbench was not admissible (`InstrumentRefusedModule`).
- **Instrument_Control**: the combined positive and negative controls that decide whether a sample's own generated Testbench is a usable measuring stick (`app/eval/instrument-control.ts`, `app/eval/mutation-control.ts`).
- **Positive_Control**: the half of the Instrument_Control that runs our Testbench against the benchmark's known-good reference design (`app/eval/corpus/rtllm-instrument-control.ts`).
- **Negative_Control**: the half of the Instrument_Control that runs our Testbench against deliberately mutated reference designs (`app/eval/mutation-control.ts`).
- **Testbench_Repair**: a new, bounded, at-most-once-per-sample step in which the Testbench_Agent revises its own generated testbench from a sanitized description of one measured control failure.
- **Repair_Trigger**: the specific measured failure that authorizes a Testbench_Repair attempt - a Testbench_Precheck build failure, or a Positive_Control functional or build failure.
- **Repair_Hint**: the sanitized description of a Repair_Trigger the Testbench_Agent is given: a compiler diagnostic verbatim, or a classified hint for a functional failure.
- **Defect_Class**: one member of the closed, non-exhaustive-but-stated vocabulary a classified Repair_Hint's defect class is drawn from.
- **Testbench_Repair_Port**: the new port, symmetric to Instrument_Admission, through which the Eval_Harness drives a Testbench_Repair for a Positive_Control-caused Repair_Trigger, consulted before that sample's Session_Budget is read for the record.
- **Recorded_Instrument_Verdict**: the closed discriminated union one sample's instrument verdict is reported, persisted, and rendered as (`app/eval/instrument-control.ts`).
- **Repair_Provenance**: the first-class, honestly-labeled fact that a sample's accepted testbench is the product of a Testbench_Repair rather than a first draft.
- **Testbench_Repair_Policy_Version**: the new build constant identifying this spec's repair behaviour, distinct from `INSTRUMENT_POLICY_VERSION` and `TESTBENCH_PROMPT_VERSION`.
- **Session_Budget**: the single per-sample budget every model call and every iteration's simulate call in the loop is charged against (`SessionBudgetHandle`).
- **Eval_Harness**: the module that runs the subset, measures each sample, and assembles the report (`app/eval/harness.ts`).
- **Results_Log**: the persisted sample-record schema, its encoder, and its decoder (`app/eval/sweep/results-log.ts`).
- **Artifact_Sink**: the per-sample evidence seam and its derivation (`app/eval/artifact-sink.ts`).
- **Config_Identity**: the canonical experiment fingerprint every persisted record is keyed by (`app/eval/sweep/config-identity.ts`).

## Requirements

### Requirement 1: A repair attempt fires on a closed set of triggers, at most once per sample

**User Story:** As the engineer paying for a campaign, I want a testbench that would otherwise be refused given exactly one chance to fix the specific defect that was measured, so that a fourth prompt-wording guess is not the only lever left to reduce `TESTBENCH_FAILED_REFERENCE`.

Evidence: `TESTBENCH_FAILED_REFERENCE` and `TESTBENCH_REFERENCE_UNBUILDABLE` together account for 290 of 495 samples (59%) in `stage1-screen-v3`, and three successive prompt rewrites have not reduced the dominant one.

#### Acceptance Criteria

1. THE Testbench_Repair SHALL fire only on one of two Repair_Triggers: a Testbench_Precheck outcome of `testbench-build-failed`, or a Positive_Control result whose `RecordedInstrumentVerdict` is `invalid` with defect `TESTBENCH_FAILED_REFERENCE` or `TESTBENCH_REFERENCE_UNBUILDABLE`.
2. THE Testbench_Repair SHALL NOT fire on a Positive_Control result of `TESTBENCH_SURVIVED_MUTANTS` or `CONTROL_RUN_ERRORED`, and SHALL NOT fire on any `unchecked` Recorded_Instrument_Verdict.
3. THE Verification_Loop SHALL attempt a Testbench_Repair at most once per sample, counted across BOTH Repair_Triggers combined, so a sample whose repaired testbench then fails a second control is not repaired again.
4. WHERE a sample's Testbench_Precheck already triggered a Testbench_Repair attempt, THE Eval_Harness SHALL NOT trigger a second Testbench_Repair attempt for that sample's subsequent Positive_Control result, whatever that result is.
5. THE Testbench_Repair SHALL make exactly one model call when it fires, so "at most once per sample" is a bound on repair ATTEMPTS and not on the model calls an attempt may internally retry beyond what the Model_Router's own existing retry policy already allows for any other role call.
6. THE Testbench_Repair SHALL read no candidate RTL, at either trigger point, so the anti-circular guarantee (Property 4 of the base HDL-creation-loop design) extends to the repair path with no new channel added.

### Requirement 2: The repair prompt carries a compiler diagnostic verbatim, and a functional failure only as a classified hint

**User Story:** As the engineer responsible for the instrument's independence, I want the repair prompt to never contain the reference design's observed behaviour, so that a repaired testbench's later pass against the positive control is still independent evidence and not a training target the founder's ruling forbade.

Evidence: `clarification-answers.md`, "Option C, with Option A folded in" - the founder's explicit ruling, restated in the Introduction above, including the measured 28% independent-catch rate of the negative control that makes spending the positive control's independence premature.

#### Acceptance Criteria

1. WHERE the Repair_Trigger is a Testbench_Precheck build failure, THE Repair_Hint SHALL carry the toolchain's own build diagnostic text verbatim.
2. WHERE the Repair_Trigger is a Positive_Control result with defect `TESTBENCH_REFERENCE_UNBUILDABLE`, THE Repair_Hint SHALL carry the toolchain's own build diagnostic text verbatim, by the same rule as a Testbench_Precheck build failure - both are build failures against files this process itself submitted, and neither reveals implementation behaviour.
3. WHERE the Repair_Trigger is a Positive_Control result with defect `TESTBENCH_FAILED_REFERENCE`, THE Repair_Hint SHALL carry only the failing check's name and one Defect_Class drawn from a closed, stated vocabulary.
4. THE Repair_Hint SHALL NOT carry the reference design's observed output value, under any Repair_Trigger.
5. THE Repair_Hint SHALL NOT carry a diff, or any text computed by comparing observed output against expected output, under any Repair_Trigger.
6. THE Repair_Hint SHALL NOT carry the reference design's source text, under any Repair_Trigger.
7. THE Defect_Class vocabulary SHALL be a closed, enumerable set, so a Repair_Hint's content is auditable against Acceptance Criteria 2.4-2.6 by inspection of a fixed list rather than by re-inspecting whatever prose a prompt-assembly function happens to build at the time.
8. THE model input assembled for a Testbench_Repair SHALL carry no candidate RTL, by the same structural guarantee `TestbenchGenerationInput` already applies to first-draft generation (Req 7.2 of the base design): no field of the repair request's type may hold RTL.
9. THE Testbench_Repair model input SHALL carry the approved Spec, the previously-generated testbench source, and the Repair_Hint, and SHALL carry no other externally-sourced content beyond what first-draft generation already assembles from the Spec and OKF retrieval.

### Requirement 3: A repaired testbench is re-checked by the same control that failed it, under the same standard

**User Story:** As the engineer citing `instrument-valid`, I want a repaired testbench held to the identical pass/fail rule a first-draft testbench is held to, so that repair cannot lower the bar for what counts as a valid instrument.

Evidence: `clarification-answers.md`'s carried-forward invariant: "a repaired testbench is re-checked by the SAME two controls before being trusted."

#### Acceptance Criteria

1. WHEN a Testbench_Precheck-triggered Testbench_Repair produces a revised testbench, THE Verification_Loop SHALL re-run the Testbench_Precheck against that revised testbench, using the same Interface_Stub derivation rule as the first run.
2. WHEN a Positive_Control-triggered Testbench_Repair produces a revised testbench, THE Eval_Harness SHALL re-run the Positive_Control, and the Negative_Control where one is wired, against that revised testbench, under `combineInstrumentControls`'s existing, unchanged combination rule.
3. THE re-check of a repaired testbench SHALL apply the identical admissibility and validity rules a first-draft testbench is held to, with no separate, more lenient threshold for a repaired testbench.
4. IF a repaired testbench fails its re-check, THEN THE Verification_Loop or Eval_Harness SHALL finalize the pre-existing terminal outcome (Instrument_Refused, or the classified `invalid` defect) that the original, unrepaired failure would have produced, and SHALL NOT attempt a second repair.
5. IF a repaired testbench passes its re-check, THEN THE sample's Recorded_Instrument_Verdict SHALL be decided from the re-check's own result, exactly as it would be for a first-draft testbench that passed on its first attempt.
6. THE Negative_Control SHALL run against a repaired testbench under the identical `MutationConfig`, wall-clock cap, and zero-coverage-gap gate a first-draft testbench's Negative_Control run uses, with no field of that configuration varied because a repair occurred.

### Requirement 4: A repaired sample's instrument validity is distinguishable from a first-draft pass, everywhere a number is reported

**User Story:** As the engineer citing `instrument-valid`, I want to be able to tell a sample whose testbench was sound on the first draft apart from one that needed a repair, so that no cited number silently conflates "written correctly" with "fixed after failing."

Evidence: `clarification-answers.md`'s carried-forward invariant: "a repaired sample is recorded as repaired, so no cited number can hide that its instrument was fixed rather than sound on the first draft."

#### Acceptance Criteria

1. THE Verification_Loop and the Eval_Harness SHALL record, for every sample whose testbench reached a Testbench_Repair attempt, whether that attempt was made and whether it produced the testbench the sample's final Recorded_Instrument_Verdict was decided from.
2. THE Repair_Provenance fact SHALL be a first-class, closed-shape field on the outcome and the record it reaches, and SHALL NOT be encoded as free text inside an existing note, message, or diagnostic field.
3. WHERE a sample's final Recorded_Instrument_Verdict is `valid` and that sample's testbench was NOT repaired, THE Results_Log, the Artifact_Sink, and the Sweep_Summary SHALL report that sample identically to how `RESULTS_SCHEMA_VERSION` 10 already reports a valid, unrepaired sample.
4. WHERE a sample's final Recorded_Instrument_Verdict is `valid` and that sample's testbench WAS repaired, THE Results_Log, the Artifact_Sink, and the Sweep_Summary SHALL report that sample's `valid` count distinctly from an unrepaired `valid` count, so a headline `instrument-valid` total is never reported without also being decomposable into "valid, no repair" and "valid, after repair."
5. THE Sweep_Summary SHALL report, per arm, the count of samples for which a Testbench_Repair was attempted, and the count of those attempts that resulted in a `valid` Recorded_Instrument_Verdict on re-check.
6. THE Artifact_Sink SHALL persist the rejected pre-repair testbench source alongside the accepted (repaired or first-draft) testbench source, under filenames distinct from each other, for any sample where a Testbench_Repair was attempted - mirroring the precedent `instrument-precheck-and-attribution` Req 6.5 already set for a rejected `coverage-incomplete` draft.
7. THE Artifact_Sink SHALL persist the Repair_Hint text that was given to the Testbench_Agent, for any sample where a Testbench_Repair was attempted, bounded by a fixed maximum length in the same manner `MAX_ATTRIBUTION_LINES` already bounds diagnostic capture.

### Requirement 5: The repair consumes the same Session_Budget as every other call, with no separate allowance

**User Story:** As the engineer whose caps define the student-session cost envelope, I want a testbench repair charged against the exact same budget generation and simulation are charged against, so that adding a repair path cannot silently widen the caps a session runs under.

Evidence: `clarification-answers.md`'s carried-forward invariant: "consumes the same Session_Budget, no widened caps," and the existing `Verification_Loop` design note that "this loop threads that SAME handle through generation, testbench, and its own per-iteration simulate accounting" (verification-loop.ts, module comment).

#### Acceptance Criteria

1. THE Testbench_Repair model call SHALL be charged against the same `SessionBudgetHandle` instance that a sample's generation and testbench-generation calls are already charged against.
2. THE Testbench_Repair's re-check simulate call(s) SHALL be charged against the same `SessionBudgetHandle` instance a sample's oracle simulate calls are already charged against, by the same accounting rule `#iterate` already applies via `simulateCost`.
3. THE Testbench_Repair SHALL count as at most one additional charge against the Session_Budget's iteration cap, distinct from the Session_Budget's own per-iteration RTL-repair accounting, so a Testbench_Repair attempt cannot by itself exhaust the budget faster than one RTL-repair iteration would.
4. WHERE the Repair_Trigger is a Positive_Control result, THE Testbench_Repair_Port SHALL be consulted, and any repair-then-recheck sequence it drives SHALL complete, BEFORE the sample's `SessionBudgetHandle` is read for the persisted record (`budget.consumed()`, `budget.stopReason()`), so a repair's cost is reflected in that sample's recorded cost rather than charged to an already-closed accounting window.
5. THE Testbench_Repair SHALL NOT be given a session budget handle wider than, or separate from, the one the sample it repairs is already bounded by.

### Requirement 6: Every repair failure path degrades to exactly today's behaviour, never to a pass

**User Story:** As the engineer trusting the harness, I want a repair call that fails for any reason to leave a sample exactly where it already is today, so that adding a repair attempt can never manufacture a `Verified` or a `valid` instrument out of a call that never actually succeeded.

Evidence: `clarification-answers.md`'s carried-forward invariant: "every failure path degrades to today's behaviour (refuse), never to a pass" - the same fail-safe discipline `instrument-precheck-and-attribution` Req 1.10, 4.7, 4.8 already apply to the Testbench_Precheck and the Instrument_Admission port.

#### Acceptance Criteria

1. IF the Testbench_Repair's model call fails (the Model_Router exhausts its chain, or the budget is already exhausted when the repair would be attempted), THEN THE Verification_Loop or Eval_Harness SHALL finalize the outcome the original, unrepaired Repair_Trigger would have produced with no repair attempted at all.
2. IF the Testbench_Repair's model call throws, THEN THE Verification_Loop or Eval_Harness SHALL catch that throw and finalize the outcome the original, unrepaired Repair_Trigger would have produced.
3. IF the Testbench_Repair produces a revised source that the coverage-validation rule already applied to first-draft testbenches rejects (a `coverage-incomplete`-shaped outcome), THEN THE Verification_Loop or Eval_Harness SHALL finalize the outcome the original, unrepaired Repair_Trigger would have produced, and SHALL NOT accept the incompletely-covering revision as the sample's testbench.
4. THE Testbench_Repair_Port SHALL report `undecided` rather than throw when it cannot drive a repair, mirroring the closed three-member decision shape `InstrumentAdmissionDecision` already uses, so a repair-port failure is structurally the same kind of fact as an admission-port failure.
5. THE only two outcomes a wired Testbench_Repair_Port or an internal precheck-path repair can produce, relative to running with no repair at all, SHALL be: the identical terminal outcome the sample would have reached with no repair attempted, or an accepted testbench that passed the SAME re-check a first-draft testbench must pass - never a third outcome, and never an accepted testbench that skipped the re-check.
6. THE Testbench_Repair SHALL NOT alter the Verification_Loop's own oracle verdict or the Golden_Judge's verdict for any sample, under any repair outcome.

### Requirement 7: The changed instrument-admission behaviour is a new, separately-identified experiment

**User Story:** As the engineer resuming or citing a campaign, I want a sample measured with the repair path available to be structurally unable to pool with one measured without it, so that a resumed run or a shared summary can never blend two different definitions of `instrument-valid`.

Evidence: `clarification-answers.md`'s carried-forward invariant: "this is a different experiment: the identity carrier and the config hashes move, and samples on either side must never pool," and the precedent `instrument-precheck-and-attribution` Req 7.4-7.8 already set for `INSTRUMENT_POLICY_VERSION`.

#### Acceptance Criteria

1. THE build SHALL expose a `TESTBENCH_REPAIR_POLICY_VERSION` constant, distinct from `INSTRUMENT_POLICY_VERSION` and from `TESTBENCH_PROMPT_VERSION`, identifying this spec's repair behaviour.
2. THE Config_Identity SHALL include the `TESTBENCH_REPAIR_POLICY_VERSION` in the canonical experiment fingerprint, under its own reserved key, by the same fold-in pattern `INSTRUMENT_POLICY_VERSION` already uses.
3. WHEN the `TESTBENCH_REPAIR_POLICY_VERSION` changes, THE Config_Identity SHALL produce a different hash for an otherwise identical config.
4. THE Config_Identity SHALL read the `TESTBENCH_REPAIR_POLICY_VERSION` directly from the build constant, so `sweepConfigHash`'s signature and its call sites stay unchanged.
5. THE Sweep_Manifest SHALL record the `TESTBENCH_REPAIR_POLICY_VERSION` and SHALL read it from the same build constant the Config_Identity reads.
6. THE pinned config-hash constants in the sweep tests SHALL be updated to the hashes the changed identity produces.
7. THE Results_Log SHALL report a record schema version greater than 10.
8. THE Results_Log SHALL refuse to aggregate a results file holding records written under a lower schema version, by the same refusal rule `RESULTS_SCHEMA_VERSION` 10 already applies to a v9 record.
9. THE Results_Log advice text SHALL state that a sample's `instrumentValidity` and Repair_Provenance fields changed meaning or were newly introduced, and that a fresh output directory is required.
10. THE artifact document schema version SHALL be greater than 7, because a captured sample now carries the rejected pre-repair testbench source and the Repair_Hint text.

### Requirement 8: The precheck-path and positive-control-path repairs share one repair primitive, wired at two trigger points

**User Story:** As the engineer maintaining this code, I want one Testbench_Agent repair method invoked from both trigger points, so that the precheck path and the positive-control path cannot drift into two different, independently-evolving repair implementations.

Evidence: `clarification-answers.md`'s Q1 answer: "one repair call, two trigger points, not two independently-evolving implementations"; the existing precedent of `GenerationAgent.reviseFromErrors` serving as the single RTL-repair primitive both `#iterate`'s repair branch and any other caller would use.

#### Acceptance Criteria

1. THE Testbench_Agent SHALL expose one repair method, structurally distinct from `generateTestbench`, that both the Testbench_Precheck-triggered repair and the Positive_Control-triggered repair invoke.
2. THE Testbench_Agent's repair method SHALL accept the previously-generated testbench source and a Repair_Hint, and SHALL accept no candidate RTL, by the same closed-request-type discipline `GenerateTestbenchRequest` already applies.
3. WHERE the Repair_Trigger is a Testbench_Precheck build failure, THE Verification_Loop SHALL invoke the Testbench_Agent's repair method directly from inside `#admitInstrument` (or its equivalent successor), before ever reaching a refusal, and re-run the Testbench_Precheck against the result (Requirement 3.1) - entirely inside `app/agent`, with no dependency on `app/eval`.
4. WHERE the Repair_Trigger is a Positive_Control result, THE Testbench_Repair_Port implementation in `app/eval` SHALL invoke the SAME Testbench_Agent repair method identified in Acceptance Criterion 8.1, and the Eval_Harness SHALL consult that port from `#runSample`, before the sample's Session_Budget is read for the record (Requirement 5.4).
5. THE `app/agent` package SHALL hold no import of the `app/eval` package as a result of adding the Testbench_Repair_Port, preserving the existing import-boundary rule `instrument-precheck-and-attribution` Req 9.7 already established.

### Requirement 9: The existing engineering gate is preserved

**User Story:** As the engineer who has to trust the harness that produces the number, I want every change in this spec held to the gate the repository already passes, so that a change made to reduce instrument-invalid samples is not the thing that breaks the build.

#### Acceptance Criteria

1. WHEN a change in this spec is complete, THE repository SHALL compile under `npx tsc -b` with no reported error.
2. WHEN a change in this spec is complete, THE repository SHALL pass `npx eslint app scripts --max-warnings=0` with no reported warning.
3. WHEN a change in this spec is complete, THE repository SHALL pass `npx prettier --check .` with no reported violation.
4. WHEN a change in this spec is complete, THE repository SHALL pass `npx vitest run` with no fewer passing tests than the count measured immediately before this spec's changes began.
5. THE `npx eslint app scripts --max-warnings=0` run SHALL report no import-boundary violation for any module added by this spec.
6. THE property test asserting Property 4 (RTL isolation for testbench generation) SHALL be extended to cover the Testbench_Agent's new repair method with the same assertion it already applies to `generateTestbench`, so the anti-circular guarantee is verified for the repair path by the same mechanism rather than by a new, separately-maintained property.
