# Implementation Plan: instrument-precheck-and-attribution

## Overview

Language: TypeScript, matching the existing packages. No language choice is open - the design names concrete modules in `app/tools`, `app/agent`, and `app/eval`.

Build order follows the dependency direction, because every later layer reads the narrower seam the earlier one produces:

1. **`app/tools`** - decide the failure cause once and carry the files a build diagnostic named.
2. **`app/agent`** - the Spec-derived stub and the precheck, the admission port, the refused outcome, and the loop's repair decision.
3. **`app/eval`** - the resource-exhausted reason, the admission adapter and the reordering, then the records, artifacts, and summary.
4. **Identity and schema** - the policy-version constant, the two schema bumps, and the pinned-hash updates, taken last so the pins are re-computed once against finished behaviour.

Two facts from the vault that shape the plan:

- `npx tsc -b app/test` is package-wide and fails on unrelated in-progress sibling test files, so per-task type checks use `npx tsc -b` at the root and the suite is run at the checkpoints.
- A property arbitrary must GENERATE a newly required field, never pin it. Adding `failureCause: 'none'` to every existing fixture compiles and silently makes the pass/fail properties weaker than they were. Task 1.3 exists to prevent exactly that.

## Tasks

- [x] 1. Decide the run failure cause once, at the simulate seam
  - [x] 1.1 Add the pure failure-attribution module
    - Create `app/tools/simulator/failure-attribution.ts` with `RunFailureCause`, `RunFailureAttribution`, `classifyRunFailure`, and `MAX_ATTRIBUTION_LINES`
    - Rank resource-bound kills above every other cause, and derive them from the `SandboxResult` flags rather than from exit codes or stream text
    - Identify attributed files by MEMBERSHIP in the caller's submitted path list, never by extracting a path from the diagnostics
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x]* 1.2 Write the property test for cause precedence
    - **Property 2: A resource-bound kill outranks every other cause**
    - Generate results with a kill flag set AND plausible contradicting residue (a sentinel exit code, a `did-not-build`-looking stderr line)
    - **Validates: Requirements 2.2, 2.3, 3.3**

  - [x]* 1.3 Write the property test for attribution containment
    - **Property 3: Attribution is a filter of the caller's own paths**
    - Generate diagnostics naming absolute paths, traversal segments, and paths absent from the submitted list; assert the result is always a subset of the submitted list and is empty unless the cause is `build-failed`
    - **Validates: Requirements 2.4, 2.5, 2.6**

  - [x] 1.4 Carry the cause and the attributed files on `SimulationVerdict`
    - Add the two required fields in `app/tools/simulator/adapter.ts` and populate them in `interpretSandboxResult` from the paths `assembleSimulateJob` submitted
    - Leave `classifyVerdict` and the computed `verdict` value untouched
    - Export the new type and function from `app/tools/index.ts`
    - Update every existing fixture and arbitrary that constructs a `SimulationVerdict`; the FULL `SandboxResult` arbitraries must generate `timedOut`, `diskLimitExceeded`, and `stdoutTruncated`, while only the pass/fail SUBSPACE arbitraries pin them, with the reason stated in each doc comment
    - _Requirements: 2.1, 2.4, 2.10_

  - [x]* 1.5 Write the property test for verdict non-regression
    - **Property 1: The failure cause never moves the verdict**
    - **Validates: Requirements 2.10, 8.4**

- [~] 2. Checkpoint - the seam is narrowed and nothing downstream has changed
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm the verdict-related properties are still non-vacuous by temporarily removing one `classifyRunFailure` ranking term and observing a failure

- [x] 3. The Spec-derived stub and the testbench precheck
  - [x] 3.1 Add the interface stub and the precheck
    - Create `app/agent/orchestrator/testbench-precheck.ts` with `buildInterfaceStub`, `PrecheckOutcome`, and `TestbenchPrecheck`
    - Derive every port from `expectedInterfacePorts`, so the clocking ports the Spec declares separately are present and a testbench connecting `clk` is never refused for a port the Spec does declare
    - Map the simulate result through the design's four-row decision table; refuse only on `build-failed` attributed to the testbench path
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 1.12_

  - [x]* 3.2 Write the property test for the stub's shape
    - **Property 5: The interface stub declares exactly the Spec's interface**
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [x]* 3.3 Write the property test for the precheck decision table
    - **Property 6: Every precheck outcome other than a testbench build failure proceeds**
    - Include `output-incomplete` and a throwing simulate in the generated space
    - **Validates: Requirements 1.8, 1.9, 1.10, 1.12**

  - [x]* 3.4 Write unit tests for the measured testbench cases
    - Assert the real `adder_8bit` and `multi_booth_8bit` headers (the illegal mid-block `initial` declarations) are refused
    - Assert the real `adder_16bit` testbench builds clean against its stub AND is refused against a stub with one port removed, so the check is proven non-vacuous in both directions
    - _Requirements: 1.8, 1.9_

  - [x] 3.5 Add the instrument-admission port and the policy-version constant
    - Create `app/agent/orchestrator/instrument-admission.ts` with `InstrumentAdmissionRequest` (one field, so no budget handle and no RTL is representable), `InstrumentAdmissionDecision`, and `InstrumentAdmission`
    - Create `app/agent/orchestrator/instrument-policy-version.ts` exporting `INSTRUMENT_POLICY_VERSION = 1`, in its own file so a bump is a one-line edit
    - Export both from `app/agent/index.ts`
    - _Requirements: 4.3, 4.4, 7.4_

- [x] 4. The loop refuses instead of repairing
  - [x] 4.1 Add the `instrument-refused` terminal outcome
    - Add `InstrumentRefusalReason` and `InstrumentRefusedModule` to the `VerificationOutcome` union in `app/agent/orchestrator/verification-loop.ts`
    - Carry the candidate, the testbench, the attributed files, and an `Unverified` label; carry no verification result, no simulation, and no oracle span
    - Resolve every resulting exhaustiveness error deliberately rather than with a default branch
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 4.2 Run the precheck and the admission check between setup and the first iteration
    - Construct the `TestbenchPrecheck` from the loop's own `#simulator`, so the gate is unconditional and needs no new injection
    - Add the optional `instrumentAdmission` dependency and consult it at most once, after a precheck that did not attribute a build failure
    - Catch a throw from either and proceed, so both degrade to the behaviour that existed before this spec
    - _Requirements: 1.4, 1.8, 1.9, 1.10, 1.11, 4.1, 4.2, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [x]* 4.3 Write the property test for admission non-interference
    - **Property 7: The only difference an admission port can make is a refusal**
    - Assert against the no-port trajectory over a metered budget, with at least one refusal and one admission in the generated space so the budget claim is not vacuous
    - **Validates: Requirements 4.3, 4.5, 4.6, 4.7, 4.8, 4.9, 4.16**

  - [x] 4.4 Attribute a build failure inside the iteration loop
    - Before requesting a revision, refuse when the cause is `build-failed` and the attributed files hold the testbench path and no RTL path; take the existing branch in every other case
    - _Requirements: 2.7, 2.8, 2.9_

  - [x]* 4.5 Write the property test for the repair decision
    - **Property 4: A testbench-only build failure never asks for an RTL repair**
    - Include a unit assertion over the real `adder_8bit_tb.v:49: syntax error` stderr
    - **Validates: Requirements 2.7, 2.8, 2.9**

  - [x] 4.6 Carry the rejected testbench draft out of setup
    - Add the optional `rejectedTestbench` and `missingCheckNames` fields to `VerificationSetupFailed` and populate them on the `coverage-incomplete` path, which already returns both from the Testbench_Agent
    - _Requirements: 6.1, 6.2, 6.7, 6.8_

- [x] 5. Checkpoint - the loop stops early and nothing it used to do has changed
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm no `app/agent` module imports `app/eval`
  - _Requirements: 9.7_

- [x] 6. The eval layer classifies honestly and validates earlier
  - [x] 6.1 Add the resource-exhausted unchecked reason
    - Add `'control-resource-exhausted'` to `InstrumentUncheckedReason` in `app/eval/instrument-control.ts` and its operator wording to the existing total description record
    - Leave `countsInPassAtK` untouched, so the new reason is excluded by the invariant already written
    - _Requirements: 3.1, 8.1, 8.2_

  - [x] 6.2 Classify a killed control run as unchecked, not as a defect
    - Read `simulation.failureCause` first in `classifyControlRun` in `app/eval/corpus/rtllm-instrument-control.ts`; map `timed-out` and `disk-capped` to the new unchecked reason and `build-failed` to `TESTBENCH_REFERENCE_UNBUILDABLE`
    - Leave `classifyNonPass` and its single owner unchanged
    - _Requirements: 3.2, 3.3_

  - [x]* 6.3 Write the property test for resource-bound classification
    - **Property 11: A resource-bound kill is never charged to the instrument**
    - Include a unit assertion over the real `multi_16bit` `workspace reached its 134217728-byte disk cap` stderr, asserting `unchecked` and NOT `TESTBENCH_REFERENCE_UNBUILDABLE`
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x] 6.4 Add the memoizing admission adapter
    - Create `app/eval/instrument-admission.ts` with `MemoizingInstrumentAdmission`, running the injected `InstrumentControl` at most once and exposing the whole memoized result
    - Map `invalid` to `inadmissible`, `valid` to `admissible`, and `unchecked`, `null`, and any throw to `undecided`
    - Assert with a fake router that the adapter drives zero model invocations, so the refusal rests on a deterministic tool result alone
    - _Requirements: 4.10, 4.11, 4.12, 4.15, 8.5_

  - [x]* 6.5 Write the property test for the adapter
    - **Property 15: The control runs at most once, and refuses only on `invalid`**
    - **Validates: Requirements 4.1, 4.11, 4.12, 4.13**

  - [x] 6.6 Thread the admission through the harness and the loop runner
    - Add the optional `instrumentAdmission` field to `EvalSampleRequest` in `app/eval/loop-runner.ts` and forward it into `VerificationLoopDeps` in `app/eval/verification-loop-runner.ts`
    - In `app/eval/harness.ts#runSample`, build the per-sample adapter, pass it down, and prefer its memoized result; keep `#controlInstrument`'s body verbatim as the fall-back for a runner that ignored the port
    - _Requirements: 4.10, 4.13, 4.14, 4.16_

- [x] 7. A refused sample still surrenders its candidate
  - [x] 7.1 Read the refused outcome in the capture and the judge paths
    - Extend `candidateRtlOf` and `testbenchSourceOf` in `app/eval/artifact-sink.ts` to read an `instrument-refused` outcome
    - Capture the run failure cause, the attributed files, the rejected testbench draft, and the unmet check names, each bounded by an existing or new named cap
    - Write the draft under a filename distinct from the accepted testbench's
    - _Requirements: 2.11, 5.5, 5.6, 6.3, 6.4, 6.5, 6.6_

  - [x]* 7.2 Write the property test for candidate surrender
    - **Property 9: A refused outcome surrenders its candidate**
    - **Validates: Requirements 5.1, 5.2, 5.5, 5.6**

  - [x]* 7.3 Write the property test for bounded capture
    - **Property 12: The capture derives exactly what the outcome carries, bounded**
    - Generate source lengths spanning the cap and outcomes with the new fields absent, so an absent field is asserted to yield an absent artifact
    - **Validates: Requirements 2.11, 6.3, 6.4, 6.6**

  - [x] 7.4 Admit the refused status to the denominators and the no-verdict vocabulary
    - Add `instrument-refused` to `SampleOutcomeStatus` in `app/eval/report.ts`, leaving `reachedOracleVerdict`'s positive set unedited so the new status is excluded by the rule already there
    - Admit it to the golden denominator predicate in `app/eval/golden-judge.ts` when the golden outcome is `passed` or `failed`
    - Add its distinct cause in `app/eval/no-verdict-cause.ts`
    - _Requirements: 5.7, 5.8, 5.9, 5.10_

  - [-]* 7.5 Write the property test for the denominator truth table
    - **Property 8: The denominator truth table**
    - **Validates: Requirements 3.4, 5.7, 5.8, 5.9, 8.2, 8.3**

- [x] 8. Checkpoint - the golden denominator is provably unharmed
  - Ensure all tests pass, ask the user if questions arise.
  - Assert on a fake-runner harness run that an inadmissible instrument yields `iterations: 0`, a recorded golden verdict, and an unchanged pass@k denominator
  - Confirm the two deliberate non-changes still hold: every simulate run still requires and captures a waveform, and an eval sample's resource limits are still byte-identical to a student session's
  - _Requirements: 3.8, 3.9, 5.6, 5.7, 8.8_

- [x] 9. Records, artifacts, and the summary
  - [x] 9.1 Persist the unchecked reason and the refused status
    - Bump `RESULTS_SCHEMA_VERSION` to 10 in `app/eval/sweep/results-log.ts`, add the required `instrumentUncheckedReason` field, admit `instrument-refused` to the outcome-status set, and validate the reason against its closed set on read
    - Make `instrumentVerdictOf` read the persisted reason instead of flattening every `unchecked` record to `control-unavailable`
    - Extend `STALE_SCHEMA_ADVICE` with the v9 to v10 paragraph naming BOTH changed meanings: the iteration count and the instrument verdict
    - _Requirements: 3.5, 3.6, 7.1, 7.2, 7.3_

  - [x]* 9.2 Write the property test for the record round trip
    - **Property 10: An unchecked reason survives the round trip**
    - **Validates: Requirements 3.5, 3.6**

  - [x]* 9.3 Write the property test for the stale-schema refusal
    - **Property 14: A stale record is refused, never repaired**
    - **Validates: Requirements 7.1, 7.2**

  - [x] 9.4 Bump the artifact document schema and add the new filenames
    - Move `ARTIFACT_DOCUMENT_SCHEMA_VERSION` to 7 in `app/eval/sweep/artifact-layout.ts` and add `rejected-testbench.v` and `precheck-stderr.txt` to the filename set
    - _Requirements: 6.5, 7.10_

  - [x] 9.5 Report the new counts and the non-comparability note
    - In `app/eval/sweep/summary.ts`, render the per-arm `instrument-refused` count, the per-reason `unchecked` counts, and the statement that a refused sample's candidate was judged with no repair iteration
    - Report golden pass@k with no claim of comparability to a prior run
    - _Requirements: 3.7, 5.11, 5.12, 8.9_

  - [x]* 9.6 Write the property test for summary reconciliation
    - Assert the per-reason `unchecked` counts sum to the unchecked total and that counted plus excluded equals the arm's recorded samples
    - _Requirements: 3.7, 5.11_

- [x] 10. The experiment identity
  - [x] 10.1 Fold the policy version into the identity and the manifest
    - Read `INSTRUMENT_POLICY_VERSION` directly in `app/eval/sweep/config-identity.ts` under the reserved key `__instrumentPolicyVersion`, leaving `sweepConfigHash`'s signature and `cli.ts` unchanged
    - Record it in `app/eval/sweep/manifest.ts`, read from the same constant
    - _Requirements: 7.5, 7.6, 7.7, 7.8_

  - [x]* 10.2 Write the property test for the identity fold-in
    - **Property 13: The policy version changes the experiment identity**
    - **Validates: Requirements 7.5, 7.6, 7.7, 7.8**

  - [x] 10.3 Re-pin the config hashes
    - Update `SMOKE_RUN_CONFIG_HASH` and `TBSLICE_RUN_CONFIG_HASH` in `app/eval/sweep/manifest.test.ts` to the values the live code computes, observed by running the test rather than pre-computed
    - Append the reason to each constant's history comment, so the next reader sees why the pin moved
    - _Requirements: 7.9_

  - [x] 10.4 Export the new surface and close the boundary
    - Export the new eval modules from `app/eval/index.ts` and the new agent modules from `app/agent/index.ts`
    - _Requirements: 9.6, 9.7_

- [x] 11. Final checkpoint - the whole gate, and the honest numbers
  - Ensure all tests pass, ask the user if questions arise.
  - Run `npx tsc -b`, `npx eslint app scripts --max-warnings=0`, `npx prettier --check .`, `npx vitest run`, and `npm run build`
  - Confirm at least 1613 passing and exactly 6 skipped, and that the 6 are the same environmental skips as the previous baseline
  - Run `npm run vault:manifest` after capturing any new vault note
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [x] 12. Re-measure the campaign-readiness slice
  - [x] 12.1 Run the committed slice into a fresh output directory and compare
    - Run `app/eval/sweep/sweep.config.tbslice.json` into a NEW `outputDir`, because the v9 records are refused by design
    - Record, without adjusting any of them: instrument-valid count, total iterations, total tokens, golden denominator size, `instrument-refused` count, and the per-reason `unchecked` counts
    - Compare against `tbslice-v1`: instrument-valid at least 1, total iterations below 53, golden denominator at least 10
    - Report golden pass@k with the non-comparability statement rather than as a delta against 0.700
    - _Requirements: 8.6, 8.7, 8.8, 8.9_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster first cut. Every one of them is a test; none of the core behaviour is optional.
- Task 12.1 is the only task that costs model spend. Every other task is deterministic and runs offline.
- **Task 11 is the merge gate. Task 12.1 is a tracked follow-up and does NOT block merge.**
  The specific damage Requirement 8.8 guards against is structural - a refused outcome surrendering no candidate, which would shrink the golden denominator - and that is caught deterministically and offline by Property 9 (task 7.2) and by checkpoint 8's fake-runner assertion.
  Holding a deterministic change behind a hosted provider that has already lost 31 of 46 cells to a single rate-limit burst costs more than it buys.
  Task 12.1 still runs, still records every number it records, and a failed comparison is still grounds to revert.
- Requirements 8.6 to 8.8 are measurements, not assertions. They are checked once by task 12.1 against the recorded `tbslice-v1` numbers and are deliberately not written as tests, because pinning a number nobody has measured is the defect this spec exists to stop.
- Requirement 6.8 is a deliberate NON-change: the coverage gate's matching rule stays exactly as it is until the evidence task 4.6 and task 7.1 persist can say whether a mangled token or an omitted check caused each rejection.

## Task Dependency Graph

Waves are arranged so that no two tasks in one wave write the same file. The four tasks that edit `verification-loop.ts` (4.1, 4.2, 4.6, 4.4) are therefore strictly serial, as are the pairs that share a test file (1.2/1.3, 3.2/3.3/3.4, 9.2/9.3, 4.3/4.5, 7.2/7.3, 10.2/10.3).

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.5"] },
    { "id": 1, "tasks": ["1.2", "3.1", "6.1"] },
    { "id": 2, "tasks": ["1.3", "3.2", "6.2"] },
    { "id": 3, "tasks": ["1.4", "3.3", "6.3"] },
    { "id": 4, "tasks": ["1.5", "3.4", "4.1", "6.4", "9.1", "9.4"] },
    { "id": 5, "tasks": ["4.2", "6.5", "7.4", "9.2", "10.1"] },
    { "id": 6, "tasks": ["4.6", "7.5", "9.3", "9.5", "10.2"] },
    { "id": 7, "tasks": ["4.4", "6.6", "7.1", "9.6"] },
    { "id": 8, "tasks": ["4.3", "7.2", "10.3"] },
    { "id": 9, "tasks": ["4.5", "7.3", "10.4"] },
    { "id": 10, "tasks": ["12.1"] }
  ]
}
```
