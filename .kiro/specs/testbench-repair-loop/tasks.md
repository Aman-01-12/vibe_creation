# Implementation Plan: testbench-repair-loop

## Overview

Language: TypeScript, matching the existing packages. No language choice is open - the design names concrete modules in `app/agent` and `app/eval`.

Build order follows the dependency direction the design's Components section lays out, because every later layer calls into the narrower primitive the earlier one produces:

1. **The pure repair-hint module** (`app/agent/orchestrator/repair-hint.ts`) - no dependencies on anything this spec adds; `buildRepairHint` and `ruleFamilyFor` are the one place Req 2.4-2.6's auditability rests on, so they exist before anything calls them.
2. **`TestbenchAgent#repairTestbench`** - the one repair primitive Requirement 8 requires both trigger points to share; it depends only on the repair-hint module's types and the existing `TESTBENCH_MODEL_TASK` routing already in place.
3. **The precheck-path wiring in `verification-loop.ts`**, entirely inside `app/agent` - depends on `repairTestbench` existing on the injected testbench collaborator, and needs `TestbenchPrecheck` widened with `runWithDiagnostic` first.
4. **The eval-layer port implementation and harness wiring** - `TestbenchRepair`'s declaration (in `app/agent/orchestrator`, no implementation) can be added alongside step 1, but `EvalTestbenchRepair` and the `#runSample`/`#repairIfTriggered` wiring depend on `repairTestbench` and on `RepairProvenance` already existing.
5. **Records, artifacts, schema, and identity bumps, last** - so the pins (`RESULTS_SCHEMA_VERSION`, `ARTIFACT_DOCUMENT_SCHEMA_VERSION`, the re-hashed config-hash constants) are computed once against finished behaviour, the same reasoning the precedent spec's identity bump deferred its own re-pinning to its final tasks.

Two facts carried forward from the precedent spec's vault notes, still true here:

- `npx tsc -b app/test` is package-wide and fails on unrelated in-progress sibling test files, so per-task type checks use `npx tsc -b` at the root and the suite is run at the checkpoints.
- A property arbitrary must GENERATE a newly required field, never pin it. `RepairProvenance` is required (not optional) on `VerifiedModule`, `UnverifiedModule`, and `InstrumentRefusedModule`; task 2.1 exists to prevent every existing fixture from silently pinning `NO_REPAIR` and weakening the properties that vary it.

Design-phase open decisions DQ1 (reuse `'testbench'` as the `ModelTask`, no new member) and DQ2 (the heuristic `ruleFamilyFor` table, as drafted) are both settled per `clarification-answers-dq.md` and are implemented as design.md states them - neither is revisited by any task below.

## Tasks

- [x] 1. The pure repair-hint module (no dependencies)
  - [x] 1.1 Add the closed vocabulary and the hint-building functions
    - Create `app/agent/orchestrator/repair-hint.ts` with `DefectClass`, `BuildDiagnosticHint`, `ClassifiedFunctionalHint`, `RepairHint`, `RepairTrigger`, and `buildRepairHint`
    - `buildRepairHint` reads only `diagnostic` (for `precheck-build-failed` and `reference-unbuildable` triggers) or `failingCheckName`/`ruleFamily` (for a `failed-reference` trigger); no other field of `RepairTrigger` may be read
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 1.2 Add `ruleFamilyFor`, the heuristic Spec-structure-only mapping
    - Add `ruleFamilyFor(check: RequiredCheck, moduleInterface: ModuleInterface): DefectClass` to `app/agent/orchestrator/repair-hint.ts`, per DQ2 (`clarification-answers-dq.md`): map a `known-answer` check to `'unclassified'`, and map a `criterion` check by the same interface facts `prompt.ts`'s rule builders already branch on (`declaresVectorDataPort`, `timingQualifierNames`, `inputQualifierNames`)
    - Mark the mapping with a `ponytail:` comment naming it a fixed heuristic table over check shape and interface, not a learned one, with the upgrade path being a vault-measured revision
    - _Requirements: 2.3, 2.7_

  - [x]* 1.3 Write the property test for anti-circularity (Property 2)
    - **Property 2: A Repair_Hint never carries the reference's observed value, a diff, or its source**
    - Generate `RepairTrigger` values whose `diagnostic` text contains characters resembling a value comparison (e.g. `"expected 8'h00, got 8'hff"`), to prove the hint's serialized text never leaks such text through a shared field
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.8, 9.6**

  - [x]* 1.4 Write the property test for verbatim-vs-classified separation (Property 3)
    - **Property 3: A compiler diagnostic crosses verbatim; a functional failure never does**
    - Generate every `RepairTrigger` kind; assert a `build-diagnostic` hint's `diagnostic` is byte-identical to the trigger's own field, and a `classified-functional` hint carries no `diagnostic`, `observed`, `expected`, or `stdout` field at all
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.7**

  - [x]* 1.5 Write the unit test for the real measured `TESTBENCH_FAILED_REFERENCE` case
    - Using the on-disk `deepseek.v3.2/rtllm_arithmetic_adder_16bit` `sample-1` case (`.eval-runs/stage1-screen-v3/artifacts/deepseek.v3.2/rtllm_arithmetic_adder_16bit/sample-1/`), construct a `RepairTrigger` from its recorded `RecordedInstrumentVerdict` and its Spec's `requiredChecks`, and assert the resulting `ClassifiedFunctionalHint`'s serialized text contains none of `"fffe"`, `"Co=1"`, `"Co=0"`, or any substring of the real `control-stdout.txt` on disk
    - _Requirements: 2.3, 2.4, 2.5, 2.6_

- [x] 2. The `RepairProvenance` shape and its threading through existing outcomes
  - [x] 2.1 Add `RepairProvenance` and widen `VerificationOutcome`
    - Add `RepairProvenance` (`attempted`, `accepted`) and the frozen `NO_REPAIR` constant to `app/agent/orchestrator/verification-loop.ts`
    - Add the required `repairProvenance: RepairProvenance` field to `VerifiedModule`, `UnverifiedModule`, and `InstrumentRefusedModule`; leave `VerificationBlocked` and `VerificationSetupFailed` unchanged, since neither can ever reach a repairable point
    - Update every existing construction site and fixture of these three outcome shapes to supply `NO_REPAIR`, and update any FULL arbitrary that builds them to GENERATE `repairProvenance` rather than pin it to `NO_REPAIR`
    - _Requirements: 4.2, 4.3_

  - [x]* 2.2 Write the property test for provenance additivity (Property 7)
    - **Property 7: Repair_Provenance is exactly `{attempted, accepted}` and nothing else moves with it**
    - Generate outcomes where `repairProvenance.attempted` is `false`; assert the oracle verdict, golden verdict, and Recorded_Instrument_Verdict are each identical to the value they would hold had the repair capability never been wired in
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 6.6**

- [~] 3. Checkpoint - the hint module and the provenance shape are correct in isolation
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm `npx tsc -b` reports no error and no existing fixture was left pinning `NO_REPAIR` where an arbitrary should vary it

- [x] 4. `TestbenchAgent#repairTestbench`, the one shared repair primitive
  - [x] 4.1 Add `RepairTestbenchRequest` and `RepairTestbenchModelInput`
    - Add `RepairTestbenchRequest` (`sessionId`, `spec`, `previousSource`, `hint`, optional `testbenchId`) to `app/agent/roles/testbench/types.ts`
    - Add `buildRepairModelInput` to `app/agent/roles/testbench/prompt.ts` as a new function; leave `describeStateAnchoring`, `describeTiming`, `describeInputWindow`, `describeStimulusAdequacy`, and every existing first-draft rule builder untouched, per "what this spec does NOT change"
    - Neither `RepairTestbenchRequest` nor `RepairTestbenchModelInput` may declare a field capable of holding candidate RTL
    - _Requirements: 2.8, 2.9, 8.2, 9.6_

  - [x] 4.2 Add `repairTestbench` to `TestbenchAgent`
    - Add `async repairTestbench(request: RepairTestbenchRequest, budget: SessionBudgetHandle): Promise<TestbenchGenerationOutcome>` to `app/agent/roles/testbench/testbench-agent.ts`, alongside the existing `generateTestbench`
    - Route the one model call through `this.#router.invoke(TESTBENCH_MODEL_TASK, ..., budget)` - the same constant `generateTestbench` already uses, per DQ1 (no new `ModelTask` member)
    - Apply the SAME `#validateCoverage` gate to the revised source that `generateTestbench` applies to a first draft, and return exactly one of the three existing `TestbenchGenerationOutcome` members (`generated`, `coverage-incomplete`, `generation-failed`) on every path, including a thrown or router-exhausted model call
    - _Requirements: 1.5, 1.6, 2.9, 6.3, 8.1, 8.2_

  - [ ]* 4.3 Extend Property 4 (RTL isolation) to cover `repairTestbench`
    - Extend the existing property test asserting Property 4 of the base HDL-creation-loop design to also assert, *for any* `RepairTestbenchRequest`, the assembled model input text contains none of the candidate RTL that produced the triggering control run
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.8, 9.6**

  - [ ]* 4.4 Write the unit test for a repaired testbench that under-covers
    - Assert a `repairTestbench` call whose revised source fails `#validateCoverage` returns `coverage-incomplete` with the same shape `generateTestbench` already returns for a first-draft under-coverage
    - _Requirements: 6.3_

- [~] 5. Checkpoint - the repair primitive is correct and isolated
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm `repairTestbench` and `generateTestbench` return the identical `TestbenchGenerationOutcome` union type, not two similar-looking types
  - Confirm no `app/agent` module added so far imports `app/eval`

- [x] 6. The precheck-path repair, entirely inside `app/agent`
  - [x] 6.1 Add `TestbenchPrecheck.runWithDiagnostic`
    - Add `runWithDiagnostic` to `app/agent/orchestrator/testbench-precheck.ts`, returning `{ outcome: PrecheckOutcome; diagnostic: string }` from the same internal `simulate` call `run` already makes; leave `run`'s existing signature and every existing caller unchanged
    - _Requirements: 2.1, 8.3_

  - [x] 6.2 Declare the `TestbenchRepair` port (no implementation)
    - Create `app/agent/orchestrator/testbench-repair.ts` with `TestbenchRepairDecision`, `TestbenchRepairRequest` (`spec`, `previousSource`, `hint` only), `TestbenchRepairResult`, `TestbenchRepairDeclined`, `TestbenchRepairOutcome`, and the `TestbenchRepair` interface
    - No implementation of `TestbenchRepair` may exist under `app/agent`
    - _Requirements: 1.6, 2.8, 2.9, 6.4, 8.4, 8.5_

  - [x] 6.3 Add `TESTBENCH_REPAIR_POLICY_VERSION`
    - Create `app/agent/orchestrator/testbench-repair-policy-version.ts` exporting `TESTBENCH_REPAIR_POLICY_VERSION = 1`, in its own file so a bump is a one-line edit, mirroring `instrument-policy-version.ts`'s precedent
    - _Requirements: 7.1_

  - [x] 6.4 Wire the precheck-path repair into `#admitInstrument`
    - Widen `IndependentTestbenchGenerator` in `app/agent/orchestrator/verification-loop.ts` with `repairTestbench`
    - On `precheckOutcome === 'testbench-build-failed'`, attempt ONE `repairTestbench` call with a `BuildDiagnosticHint` built from `runWithDiagnostic`'s diagnostic; on `generated`, re-run the plain `TestbenchPrecheck.run` against the revised source; on a re-check pass, proceed to `#iterate` with the repaired testbench and `repairProvenance: { attempted: true, accepted: true }`; on a re-check fail, or on `coverage-incomplete`/`generation-failed`/a throw from `repairTestbench`, finalize the identical `InstrumentRefusedModule` the unrepaired failure would have produced, with `repairProvenance: { attempted: true, accepted: false }`
    - On `precheckOutcome === 'undecided'`, leave the existing `InstrumentAdmission` consultation unchanged, carrying `repairProvenance: NO_REPAIR` forward
    - Widen `#admitInstrument`'s return type to thread `RepairProvenance` forward on every branch
    - _Requirements: 1.1, 1.3, 3.1, 3.3, 3.4, 5.1, 5.2, 5.3, 5.5, 6.1, 6.2, 6.3, 6.5, 8.3_

  - [ ]* 6.5 Write the property test for the closed trigger set and at-most-once bound (Property 1)
    - **Property 1: A repair fires only on the closed trigger set, and at most once per sample**
    - Generate every member of `InstrumentDefectCode` and every `InstrumentUncheckedReason`, not only the two triggering ones, so the "never fires on these" half of the claim is exercised
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

  - [ ]* 6.6 Write the property test for re-check parity on the precheck path (Property 4, precheck half)
    - **Property 4: A repaired testbench is re-checked by the identical rule a first draft is held to**
    - Assert running a revised testbench back through `TestbenchPrecheck.run` yields the identical outcome the same source would yield as a first-draft testbench, via the exact same function with no parameter distinguishing "repaired" from "generated"
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6**

  - [ ]* 6.7 Write the property test for failed-re-check finalization (Property 5, precheck half)
    - **Property 5: A failed re-check finalizes the pre-existing outcome, never a second repair**
    - **Validates: Requirements 3.4, 6.1, 6.2, 6.3**

  - [ ]* 6.8 Write the unit test for the real measured precheck build failure
    - Run the real `adder_16bit` Testbench_Precheck build failure (from the precedent spec's fixtures) through `buildRepairHint`, asserting the resulting `BuildDiagnosticHint.diagnostic` is byte-identical to the precheck's own captured stderr
    - _Requirements: 2.1_

- [~] 7. Checkpoint - the precheck-path repair is correct and the import boundary holds
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm no `app/agent` module imports `app/eval`
  - Confirm a repaired testbench that re-fails its precheck produces `InstrumentRefusedModule.reason` identical to the unrepaired failure, with `repairProvenance: { attempted: true, accepted: false }` the only visible difference
  - _Requirements: 8.5, 9.5_

- [ ] 8. The `EvalTestbenchRepair` adapter and the harness wiring
  - [x] 8.1 Add `EvalTestbenchRepair`
    - Create `app/eval/testbench-repair.ts` with `EvalTestbenchRepair implements TestbenchRepair`, constructed with the `RepairingTestbenchGenerator` (`repairTestbench`), the sample's `sessionId`, and the sample's own `SessionBudgetHandle`
    - Map a `repairTestbench` throw to `{ decision: 'undecided' }`, a `generated` outcome to `{ decision: 'repaired', revisedSource }`, and every other outcome to `{ decision: 'not-repaired' }`
    - No memoization field: this class has exactly one caller
    - _Requirements: 5.1, 5.5, 6.1, 6.2, 6.3, 6.4, 8.4_

  - [x] 8.2 Add `repairTriggerFor`
    - Add the total function reading `RecordedInstrumentVerdict` and returning a `RepairTrigger` for exactly `{ invalid, TESTBENCH_FAILED_REFERENCE }` and `{ invalid, TESTBENCH_REFERENCE_UNBUILDABLE }`, and `null` for every other validity/defect combination including `TESTBENCH_SURVIVED_MUTANTS`, `CONTROL_RUN_ERRORED`, and every `unchecked` reason, as a total `Record`-style mapping so a future defect code is a compile error rather than a silent no-fire
    - Place it in `app/eval/testbench-repair.ts` alongside `EvalTestbenchRepair`
    - _Requirements: 1.1, 1.2_

  - [x] 8.3 Add `#repairIfTriggered` and rewire `#runSample`
    - Add `#repairIfTriggered` to `app/eval/harness.ts`, gated first on the port being wired and on `precheckProvenance.attempted` being `false` (Req 1.3, 1.4); on a non-null `repairTriggerFor` result, call `port.repair` with the Spec, the previous testbench source (via `testbenchSourceOf`), and `buildRepairHint(trigger)`; on `{ decision: 'repaired' }`, re-run the existing `#controlInstrument` against a `withRevisedTestbench` copy of the outcome under the SAME `MutationConfig`
    - Add `withRevisedTestbench`, a small pure helper returning a shallow copy of `DriveOutcome` with `testbench.source` replaced
    - In `#runSample`, call `#repairIfTriggered` after the existing `admission?.recorded() ?? this.#controlInstrument(...)` step, and move the `budget.consumed()`/`budget.stopReason()` reads to after it completes
    - Add the optional `testbenchRepair?: TestbenchRepair` field to `EvalHarnessDeps`; when absent, every sample's positive-control-path repair is skipped
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.2, 3.6, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 8.4_

  - [ ]* 8.4 Write the property test for the budget-ordering guarantee (Property 8)
    - **Property 8: The repair's cost is charged to, and only to, the sample's own budget, before the record is closed**
    - Assert against a metered budget over a trajectory including at least one repair attempt, so "same handle charged" is non-vacuous
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**

  - [ ]* 8.5 Write the property test for total repair-failure degradation (Property 6)
    - **Property 6: Every repair failure path degrades to exactly the unrepaired outcome, never to a pass**
    - Generate at least one trigger through each of: the model call throwing, the Model_Router exhausting its chain, the budget already exhausted, the revised source failing coverage validation, and the port itself throwing
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**

  - [ ]* 8.6 Write the property test for re-check parity on the positive-control path (Property 4, positive-control half)
    - **Property 4: A repaired testbench is re-checked by the identical rule a first draft is held to**
    - Assert running a revised testbench back through `combineInstrumentControls` via a fresh Positive_Control and Negative_Control run yields the identical outcome the same source would yield as a first-draft testbench
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6**

  - [x] 8.7 Add `RepairTestbenchRequest`-shaped wiring for `EvalSampleArtifacts`
    - Add `repairProvenance`, `rejectedPreRepairTestbench`, and `repairHint` to `EvalSampleArtifacts` in `app/eval/artifact-sink.ts`; capture the pre-repair source and the hint text only when `repairProvenance.attempted` is `true`, each bounded by a fixed cap (`ARTIFACT_CAPS.maxRepairHintChars` for the hint, mirroring `MAX_ATTRIBUTION_LINES`'s existing bound)
    - Write the pre-repair source under a filename distinct from the accepted testbench's
    - _Requirements: 4.6, 4.7_

  - [ ]* 8.8 Write the unit test for the real end-to-end repair-and-recheck path
    - One end-to-end harness run over a fake loop runner and a fake `TestbenchRepair` port asserting a `TESTBENCH_FAILED_REFERENCE` sample followed by a successful repair-and-recheck yields `repairAttempted: true, repairAccepted: true` and a `valid` final verdict, with `budget.consumed()` reflecting the repair's own charge
    - _Requirements: 3.5, 4.1, 5.4_

  - [ ]* 8.9 Write the unit test for the real end-to-end precheck-repair path
    - One end-to-end `VerificationLoop` run over a fake simulator asserting a Testbench_Precheck build failure followed by a successful repair-and-recheck reaches the first iteration with the repaired testbench, never consulting `InstrumentAdmission` at all
    - _Requirements: 8.3_

- [~] 9. Checkpoint - the two trigger points share one primitive and degrade identically
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm `EvalTestbenchRepair.repair` and the precheck-path branch in `#admitInstrument` both call the SAME `TestbenchAgent#repairTestbench` method, not two independently-evolving implementations
  - Confirm no `app/agent` module imports `app/eval`
  - _Requirements: 8.1, 8.2, 8.5, 9.5_

- [x] 10. Records, artifacts, schema, and identity - last, so the pins are computed once against finished behaviour
  - [x] 10.1 Bump the results schema and add the provenance fields
    - Bump `RESULTS_SCHEMA_VERSION` to 11 in `app/eval/sweep/results-log.ts`, add the required `repairAttempted` and `repairAccepted` fields to `SweepSampleRecord`, and refuse to aggregate a results file holding records written under schema version 10 or lower, by the same refusal rule already applied to a v9 record
    - Extend `STALE_SCHEMA_ADVICE` with the v10 -> v11 paragraph naming both `instrumentValidity`'s meaning as unchanged and `repairAttempted`/`repairAccepted` as newly introduced
    - _Requirements: 4.3, 4.4, 7.7, 7.8, 7.9_

  - [ ]* 10.2 Write the property test for stale-record refusal (Property 10)
    - **Property 10: A stale record is refused, never repaired into meaning something it did not measure**
    - **Validates: Requirements 7.7, 7.8, 7.9**

  - [x] 10.3 Bump the artifact document schema and add the new filename
    - Move `ARTIFACT_DOCUMENT_SCHEMA_VERSION` to 8 in `app/eval/sweep/artifact-layout.ts`, add `repairAttempted`, `repairAccepted`, and `repairHint` to `ArtifactDocument`, and add the `pre-repair-testbench.v` filename, HEAD-kept under the same cap as `rejected-testbench.v`
    - _Requirements: 4.6, 4.7, 7.10_

  - [x] 10.4 Report per-arm repair counts in the sweep summary
    - In `app/eval/sweep/summary.ts`, render the per-arm count of samples for which a Testbench_Repair was attempted, and the count of those attempts that resulted in a `valid` Recorded_Instrument_Verdict on re-check, decomposing the headline `instrument-valid` total into "valid, no repair" and "valid, after repair"
    - _Requirements: 4.4, 4.5_

  - [ ]* 10.5 Write the property test for summary reconciliation
    - Assert the per-arm repair-attempted and repair-accepted counts never exceed the arm's recorded sample count, and that "valid, no repair" plus "valid, after repair" equals the arm's total `instrument-valid` count
    - _Requirements: 4.4, 4.5_

  - [x] 10.6 Fold `TESTBENCH_REPAIR_POLICY_VERSION` into the identity and the manifest
    - Read `TESTBENCH_REPAIR_POLICY_VERSION` directly in `app/eval/sweep/config-identity.ts` under the reserved key `__testbenchRepairPolicyVersion`, leaving `sweepConfigHash`'s signature and its call sites unchanged
    - Record `testbenchRepairPolicyVersion` in `app/eval/sweep/manifest.ts`, read from the same constant
    - _Requirements: 7.2, 7.3, 7.4, 7.5_

  - [ ]* 10.7 Write the property test for the identity fold-in (Property 9)
    - **Property 9: The policy version changes the experiment identity**
    - Vary `TESTBENCH_REPAIR_POLICY_VERSION` while holding `INSTRUMENT_POLICY_VERSION` and `TESTBENCH_PROMPT_VERSION` fixed, and vice versa, so a hash collision on the wrong axis would be detected
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**

  - [x] 10.8 Re-pin the config hashes
    - Update `SMOKE_RUN_CONFIG_HASH` and `TBSLICE_RUN_CONFIG_HASH` in `app/eval/sweep/manifest.test.ts` to the values the live code computes, observed by running the test rather than pre-computed, and append the reason to each constant's history comment
    - _Requirements: 7.6_

  - [x] 10.9 Write the unit test for the stale-schema advice text
    - Assert `STALE_SCHEMA_ADVICE`'s v10 -> v11 paragraph names both the unchanged `instrumentValidity` meaning and the newly introduced `repairAttempted`/`repairAccepted` fields
    - _Requirements: 7.9_

  - [x] 10.10 Export the new surface
    - Export the new eval modules from `app/eval/index.ts` and the new agent modules from `app/agent/index.ts`
    - _Requirements: 9.5, 9.6_

- [x] 11. Final checkpoint - the whole gate, and the honest numbers
  - Ensure all tests pass, ask the user if questions arise.
  - Run `npx tsc -b`, `npx eslint app scripts --max-warnings=0`, `npx prettier --check .`, `npx vitest run`, and `npm run build`
  - Confirm no fewer passing tests than the count measured immediately before this spec's changes began, and no import-boundary violation for any module added by this spec
  - Run `npm run vault:manifest` after capturing any new vault note
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [ ] 12. Re-measure against the stage1-screen slice
  - [~] 12.1 Re-run the slice into a fresh output directory and compare
    - Run the same `stage1-screen` slice (or an equivalent smaller slice) into a NEW `outputDir`, because v10-and-earlier records are refused by design
    - Record, without adjusting any of them: `TESTBENCH_FAILED_REFERENCE` count, `TESTBENCH_REFERENCE_UNBUILDABLE` count, the per-arm repair-attempted count, the per-arm repair-accepted-on-recheck count, and the instrument-valid total decomposed into "no repair" and "after repair"
    - Confirm `repairAttempted` and `repairAccepted` appear correctly in the persisted results for samples that triggered a repair
    - Compare the two triggering defect classes' counts against `stage1-screen-v3`'s recorded 226 (`TESTBENCH_FAILED_REFERENCE`) and 64 (`TESTBENCH_REFERENCE_UNBUILDABLE`) to confirm the repair loop reduces them
    - _Requirements: 1.1, 4.1, 4.4, 4.5_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster first cut. Every one of them is a test; none of the core behaviour is optional.
- Task 11 is the merge gate. Task 12.1 is a tracked follow-up and does NOT block merge, for the identical reason the precedent spec's task 12.1 did not block merge: the specific damage a repair-loop regression could cause - a repaired testbench being accepted without its re-check, or a repair silently widening the Session_Budget - is structural, and is caught deterministically and offline by Property 4, Property 6, Property 8, and by checkpoints 5, 7, and 9. Task 12.1 costs real model spend against a hosted provider; holding a deterministic change behind it costs more than it buys.
- Requirement 9.1-9.4 (the repository-wide compile/lint/format/test gate) is enforced by the existing tooling at the checkpoints, not by a new property, matching the design's own Coverage note.
- Requirement 1.5 ("exactly one model call when it fires") and Requirement 4.6 ("the rejected pre-repair testbench filename differs from the accepted testbench's") are distinctness/counting claims over a fixed call site and fixed constants respectively, so each is verified by the unit tests in tasks 8.8/8.9 and 10.3 rather than by a dedicated property test, matching the design's own Coverage note.
- Per DQ1 (`clarification-answers-dq.md`), no new `ModelTask` member is minted; `repairTestbench` and `generateTestbench` both route under the existing `'testbench'` task. This is a deliberate non-change: no task in this plan touches `app/agent/model-router/contract.ts` or `routing.ts`.
- Per DQ2, `ruleFamilyFor`'s heuristic table (task 1.2) is a deliberate, `ponytail:`-marked simplification with a stated ceiling and upgrade path (revisit once the vault measures which family actually correlates with which check shape); it is not revisited by any task in this plan.
- `describeStateAnchoring`, `describeTiming`, `describeInputWindow`, `describeStimulusAdequacy`, `EXPECTED_VALUE_RULE`, `CONCURRENCY_RULE`, and `TESTBENCH_PROMPT_VERSION` are a deliberate NON-change, per requirements.md's "What this spec does NOT change": no task in this plan edits any of them.

## Task Dependency Graph

Waves are arranged so that no two tasks in one wave write the same file. The tasks that edit `verification-loop.ts` (2.1, 6.4) are therefore strictly serial, as are the pairs that share an implementation file - `repair-hint.ts` (1.1, 1.2), `testbench-precheck.ts` (6.1, 6.4), `testbench-repair.ts` (6.2, then 8.1/8.2 sharing that same new file, then 8.3 in `harness.ts` reading the settled provenance) - and every group of sub-tasks that shares one test file, each serialized behind its own implementation task: 1.3/1.4/1.5 (`repair-hint.test.ts`), 6.5/6.6/6.7/6.8 (the widened `verification-loop.test.ts` repair-branch assertions), 8.4/8.5/8.6/8.8/8.9 (`harness.test.ts`), and 10.2/10.5/10.7/10.9 (their respective schema/summary/identity test files).

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3", "2.2"] },
    { "id": 3, "tasks": ["1.4"] },
    { "id": 4, "tasks": ["1.5", "4.1"] },
    { "id": 5, "tasks": ["4.2"] },
    { "id": 6, "tasks": ["4.3", "6.1", "6.2", "6.3"] },
    { "id": 7, "tasks": ["4.4", "6.4"] },
    { "id": 8, "tasks": ["6.5", "8.1"] },
    { "id": 9, "tasks": ["6.6", "8.2"] },
    { "id": 10, "tasks": ["6.7", "8.3"] },
    { "id": 11, "tasks": ["6.8", "8.7"] },
    { "id": 12, "tasks": ["8.4", "10.1", "10.3", "10.4"] },
    { "id": 13, "tasks": ["8.5", "10.5", "10.6"] },
    { "id": 14, "tasks": ["8.6", "10.2", "10.7"] },
    { "id": 15, "tasks": ["8.8", "10.8", "10.9"] },
    { "id": 16, "tasks": ["8.9", "10.10"] },
    { "id": 17, "tasks": ["12.1"] }
  ]
}
```
