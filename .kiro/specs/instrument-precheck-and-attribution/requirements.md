# Requirements Document

## Introduction

The `eval-campaign-readiness` spec is complete and the harness runs a real campaign end to end.
The first real campaign-readiness run then measured something the harness was built to expose: **the instrument is the bottleneck, and the loop does not notice.**

`tbslice-v1` (15 RTLLM problems, one arm `kimi-k2_5`, `sampleCount` 1, config hash `5ede5f843ac2859b`, commit `e3bb5c1`, clean tree, `RESULTS_SCHEMA_VERSION` 9):

| measured fact | value |
| --- | --- |
| recorded samples | 15 |
| GOLDEN pass@1 | 0.700 over the 10 samples the independent judge could rule on |
| instrument-valid | 1 |
| instrument-invalid | 11 (`TESTBENCH_FAILED_REFERENCE` 7, `TESTBENCH_REFERENCE_UNBUILDABLE` 3, `CONTROL_RUN_ERRORED` 1) |
| instrument-unchecked | 3 (all three `setup-failed`, `iterations` 0) |
| total iterations | 53 |
| total tokens | 223,034 (a FLOOR; one call returned no usable usage block) |
| iterations and tokens spent on instrument-invalid samples | 52 iterations, 197,901 tokens - 89% of the run |
| instrument-invalid samples the independent judge says were ALREADY CORRECT | 6 of 11 |

Every number above was re-derived from `.eval-runs/tbslice-v1/results.jsonl` and the per-sample artifacts, not quoted from a prior note.

This spec covers four mechanical, deterministic defects in the harness and the loop, and nothing else.
Each was independently reproduced against the committed artifacts before it was written down.

1. **The loop spends its whole repair budget before anything checks whether the testbench compiles.**
   `iverilog -t null` over all 12 committed testbench artifacts reports a parse failure on exactly 2: `rtllm_arithmetic_adder_8bit` (lines 49-50) and `rtllm_arithmetic_multi_booth_8bit` (lines 177-184).
   Both are the same defect - variable declarations placed after executable statements inside `initial begin ... end`, illegal in the Verilog-2001 dialect Icarus compiles.
   On `adder_8bit` the loop ran 6 full iterations against a testbench that could never compile, and the independent judge then passed the candidate.

2. **A build failure is not attributed to the file that failed, so testbench breakage triggers RTL repair.**
   `adder_8bit`'s recorded simulation is `verdict: error`, `exitCode: 4`, `checks: []` on every iteration, while its captured `simulator-stderr.txt` reads `adder_8bit_tb.v:49: syntax error`.
   The failing file is named in the tool output and discarded by a verdict that collapses compile error, timeout, and tool crash into one `error`.
   `SandboxResult` already carries `timedOut`, `diskLimitExceeded`, and `stdoutTruncated`; `SimulationVerdict` drops all three.
   The workspace filenames are derived from the trusted Spec module name (`${moduleName}.v`, `${moduleName}_tb.v`), never from model output, so attribution by filename rests on trusted data.

3. **A resource-exhaustion kill is recorded as an instrument defect.**
   `rtllm_arithmetic_multi_16bit` is recorded `TESTBENCH_REFERENCE_UNBUILDABLE`, yet its testbench parses cleanly; its captured `control-stderr.txt` reads `workspace reached its 134217728-byte disk cap`.
   `classifyNonPass` reads stderr only for emptiness, so a disk-cap kill's own diagnostic line resolves to `did-not-build`.
   `$dumpfile`/`$dumpvars` appears in 12 of 12 generated testbenches, so the unbounded waveform that caused the kill is latent in every sample.

4. **A refused testbench leaves no evidence at all.**
   3 of 15 samples are `setup-failed` with `iterations` 0, and their artifact directories hold exactly one file, `outcome.json` - no draft, no diagnostics.
   The cause is `coverage-incomplete` in the Testbench_Agent: the source did not emit a `CHECK <name>` line for every required check, decided by exact token match.
   `missingCheckNames` reaches the Trace and nothing else.
   Separately, `instrumentVerdictOf` reads every `unchecked` record back as `control-unavailable` because the unchecked reason is not persisted, so all 3 lose their real reason (`no-testbench`) on the way to the summary.

5. **The positive control runs after the money is spent.**
   `EvalHarness.#runSample` awaits the whole loop and only then awaits `#controlInstrument`.
   The testbench is generated exactly once, in `VerificationLoop.#setup`, and is never regenerated, so the testbench an early control would check is byte-identical to the one the oracle ran on every iteration.
   Zero samples in `tbslice-v1` carry a `TESTBENCH_SURVIVED_MUTANTS` defect and none carries a mutation report, so all 52 wasted iterations are attributable to positive-control failures alone.

### The consequence to state up front

Stopping a sample before its repair loop means the independent judge scores that sample's FIRST candidate rather than its last.
For the 6 of 11 instrument-invalid samples the judge already passes, nothing is forfeited.
For the rest, whatever the repair loop achieved was driven by a testbench that rejects the known-good reference design, so it was not a measurement of capability.
The honest statement is therefore that golden pass@k after these changes is measured on a different flow and is not comparable to `tbslice-v1`'s 0.700, which is why Requirement 7 bumps the record schema and Requirement 8 forbids a comparability claim rather than asserting the number will hold.
Both gates are unconditional, in eval and in the product alike, so no configuration reproduces the un-truncated flow and 0.700 has no comparable successor.
That is a cost this spec DELIBERATELY ACCEPTS rather than works around: a single certified configuration is worth more than a baseline measured under an instrument the positive control falsifies, and a selectable gate would be a second configuration to certify and a second code path the product must never take.

### What this spec does NOT change

- The sampling-moment / input-window defect (`TESTBENCH_FAILED_REFERENCE`, 7 of 11) is a separate instrument-design problem and is out of scope. `adder_pipe_64bit` and `multi_pipe_8bit` both derive their expected values correctly from inputs their own testbench drove - what the previous spec's input-alignment rule demanded - and still fail, because the failures are about when the output is sampled.
- No Testbench_Agent prompt rule about timing or expected values changes.
- The `fsm` overlapping-sequence-detection disagreement is a spec-semantics question, not a harness defect.
- `CONTROL_RUN_ERRORED` on `rtllm_miscellaneous_calendar` is undiagnosed. This spec names it as unclassified and specifies no fix for it.
- Regenerating the Testbench once after a failed Testbench_Precheck and re-running the precheck is deliberately DEFERRED, not rejected.
  Requirement 1.8 therefore ends the run, and the deferral exists because the decision needs a measured frequency of testbench build failure that does not exist yet: the only evidence today is 2 of 12 committed testbenches, on one arm, at `sampleCount` 1.
  The Testbench_Precheck this spec adds is itself the instrument that will supply that frequency, so the follow-on is specified once a real rate has been measured rather than added inside a spec about attribution.
- No measurement is relaxed. Instrument-invalid samples continue to leave the pass@k denominator. The goal is to stop spending budget on samples that measure nothing and to stop misattributing failures, not to convert invalid samples into valid ones.

## Glossary

- **Verification_Loop**: the generate-simulate-repair orchestrator (`app/agent/orchestrator/verification-loop.ts`).
- **Loop_Setup**: the Verification_Loop stage that produces the first candidate and the independent Testbench in parallel, before any iteration (`VerificationLoop.#setup`).
- **Testbench_Agent**: the RTL-isolated, spec-derived testbench generator (`app/agent/roles/testbench/`).
- **Simulator_Adapter**: the Icarus-backed oracle adapter and its `SimulationVerdict` (`app/tools/simulator/adapter.ts`).
- **Simulation_Verdict**: the interpreted outcome of one compile-and-simulate run, as returned by the Simulator_Adapter.
- **Sandbox_Result**: the raw result the Tool_Runner sandbox returns, carrying `timedOut`, `diskLimitExceeded`, and `stdoutTruncated` (`app/tools/sandbox/contract.ts`).
- **Run_Failure_Cause**: a new closed classification of why a Simulation_Verdict is `error`, replacing re-derivation from residual fields.
- **Attributed_File**: the workspace file a build diagnostic names, drawn from the closed set of files the run submitted.
- **Testbench_Precheck**: a new deterministic, model-free build check of a generated Testbench against a stub module derived from the Spec's declared interface.
- **Interface_Stub**: a Verilog module declaration derived solely from the Spec's `moduleInterface`, carrying the module name and every declared port with its direction and width, and no behaviour.
- **Instrument_Admission**: a new optional port the Verification_Loop consults once, after the Testbench exists and before the first iteration, to learn whether the Testbench is an admissible instrument.
- **Instrument_Refused**: a new terminal Verification_Loop outcome reporting that the Testbench was not admissible, carrying the candidate and the Testbench and no oracle verdict.
- **Instrument_Control**: the positive and negative controls that decide whether a sample's own generated Testbench is a usable measuring stick (`app/eval/instrument-control.ts`, `app/eval/mutation-control.ts`).
- **Positive_Control**: the half of the Instrument_Control that runs our Testbench against the benchmark's known-good reference design.
- **Negative_Control**: the half of the Instrument_Control that runs our Testbench against deliberately mutated reference designs (`app/eval/mutation-control.ts`).
- **Recorded_Instrument_Verdict**: the closed discriminated union one sample's instrument verdict is reported, persisted, and rendered as.
- **Instrument_Unchecked_Reason**: the closed set of reasons a control could not speak for a sample.
- **Eval_Harness**: the module that runs the subset, measures each sample, and assembles the report (`app/eval/harness.ts`).
- **Eval_Loop_Runner**: the port the Eval_Harness drives one sample through (`app/eval/loop-runner.ts`), implemented for real runs by `app/eval/verification-loop-runner.ts`.
- **Golden_Judge**: the independent-judge port and its RTLLM-backed implementation (`app/eval/golden-judge.ts`).
- **Golden_Denominator**: the set of samples the golden pass@k is computed over.
- **Artifact_Sink**: the per-sample evidence seam and its derivation (`app/eval/artifact-sink.ts`).
- **Results_Log**: the persisted sample-record schema, its encoder, and its decoder (`app/eval/sweep/results-log.ts`).
- **Sweep_Summary**: the module that aggregates persisted records into the reported numbers and renders them (`app/eval/sweep/summary.ts`).
- **Config_Identity**: the canonical experiment fingerprint every persisted record is keyed by (`app/eval/sweep/config-identity.ts`).
- **Sweep_Manifest**: the per-run provenance document (`app/eval/sweep/manifest.ts`).
- **Instrument_Policy_Version**: a new build constant identifying the Verification_Loop's instrument-admission behaviour.

## Requirements

### Requirement 1: The generated testbench is built before any repair iteration is spent

**User Story:** As the engineer paying for a campaign, I want a testbench that cannot compile identified before the loop starts repairing, so that 6 iterations are never spent against an instrument that could never have measured anything.

Evidence: 2 of the 12 committed testbench artifacts fail `iverilog -t null`, and one of them consumed 6 of the run's 53 iterations while the independent judge passed its candidate.

#### Acceptance Criteria

1. THE Verification_Loop SHALL derive an Interface_Stub from the Spec's declared `moduleInterface` alone.
2. THE Interface_Stub SHALL declare the Spec's module name and every port the Spec declares, with each port's declared direction and width.
3. THE Interface_Stub SHALL declare no behaviour.
4. WHEN Loop_Setup has produced a Testbench, THE Verification_Loop SHALL run a Testbench_Precheck that builds that Testbench together with the Interface_Stub, before the first iteration.
5. THE Testbench_Precheck SHALL read no candidate RTL, so a Testbench is built only against the Spec-derived Interface_Stub and never against the RTL the Testbench is required to be independent of.
6. THE Testbench_Precheck SHALL make no model call.
7. THE Testbench_Precheck SHALL run through the same Tool_Runner sandbox and the same resource limits the Verification_Loop's own oracle runs under.
8. WHERE the Testbench_Precheck run's Run_Failure_Cause is `build-failed` AND its Attributed_Files hold the testbench file, THE Verification_Loop SHALL return Instrument_Refused without running an iteration.
9. WHERE the Testbench_Precheck run's Run_Failure_Cause is other than `build-failed`, THE Verification_Loop SHALL proceed to the first iteration with the Testbench unchanged, so a precheck that could not reach a build outcome leaves the loop's behaviour as it was before the Testbench_Precheck existed.
10. IF the Testbench_Precheck throws, THEN THE Verification_Loop SHALL proceed to the first iteration with the Testbench unchanged.
11. WHEN the Verification_Loop returns Instrument_Refused after a failed Testbench_Precheck, THE recorded iteration count for that outcome SHALL be 0.
12. THE Testbench_Precheck SHALL report no refusal for a Testbench that builds and then produces no waveform, because a missing waveform is an incomplete capture and not a build defect.

### Requirement 2: A build failure is attributed to the file that failed

**User Story:** As the engineer reading a failure, I want a compile error attributed to the file the toolchain named, so that a broken testbench can never send the loop off to repair correct RTL.

Evidence: `adder_8bit`'s stderr names `adder_8bit_tb.v:49` on every one of 6 iterations, while its recorded verdict is a bare `error` with `checks: []`, and the loop responded by repairing the RTL.

#### Acceptance Criteria

1. THE Simulation_Verdict SHALL carry a Run_Failure_Cause drawn from the closed set `none`, `build-failed`, `timed-out`, `disk-capped`, `output-incomplete`, `tool-failed`.
2. THE Simulator_Adapter SHALL derive the Run_Failure_Cause from the Sandbox_Result's own `timedOut`, `diskLimitExceeded`, and `stdoutTruncated` fields rather than from residual exit codes or stream text.
3. WHERE a run's verdict is `error` AND no resource bound killed that run AND the run's diagnostics name at least one submitted workspace file at a source location, THE Simulator_Adapter SHALL report the Run_Failure_Cause `build-failed`.
4. WHERE the Run_Failure_Cause is `build-failed`, THE Simulation_Verdict SHALL carry the set of Attributed_Files the diagnostics named.
5. THE Simulator_Adapter SHALL draw every Attributed_File from the workspace file paths the run submitted, so a diagnostic can never introduce a path of its own.
6. THE Simulator_Adapter SHALL read at most a fixed maximum number of diagnostic lines when identifying Attributed_Files, so an unbounded diagnostic stream cannot cost unbounded work.
7. WHERE the Run_Failure_Cause is `build-failed` AND the Attributed_Files hold the testbench file and hold no RTL file, THE Verification_Loop SHALL return Instrument_Refused rather than requesting an RTL repair.
8. WHERE the Run_Failure_Cause is `build-failed` AND the Attributed_Files hold at least one RTL file, THE Verification_Loop SHALL request an RTL repair.
9. WHERE the Run_Failure_Cause is other than `build-failed`, THE Verification_Loop SHALL behave exactly as it behaved before the Run_Failure_Cause was added.
10. THE Simulation_Verdict SHALL report the same `verdict` value for every run as it reported before the Run_Failure_Cause was added, so pass integrity is decided by the existing core verdict rules alone.
11. THE Artifact_Sink SHALL record the Run_Failure_Cause and the Attributed_Files for every captured simulation that reports them.

### Requirement 3: A resource-exhaustion kill is never recorded as an instrument defect

**User Story:** As the engineer citing an instrument-invalid count, I want a run our own resource cap killed reported as unproven rather than as a testbench defect, so that the count of defects in our testbench generator is not inflated by our own harness limits.

Evidence: `multi_16bit` is recorded `TESTBENCH_REFERENCE_UNBUILDABLE` while its testbench parses cleanly and its control stderr reads `workspace reached its 134217728-byte disk cap`.

#### Acceptance Criteria

1. THE Instrument_Unchecked_Reason set SHALL include a member reporting that the control run was killed for exceeding a resource bound.
2. WHEN a Positive_Control run's Run_Failure_Cause is `timed-out` or `disk-capped`, THE Positive_Control SHALL report a Recorded_Instrument_Verdict of `unchecked` under that reason.
3. THE Positive_Control SHALL classify a resource-bound kill from the Run_Failure_Cause alone, so a kill is never inferred from the diagnostics text.
4. THE Recorded_Instrument_Verdict `unchecked` under a resource-bound kill SHALL leave the sample outside the pass@k denominator.
5. THE Results_Log SHALL persist the Instrument_Unchecked_Reason for every sample whose instrument validity is `unchecked`.
6. THE Results_Log SHALL accept only the members of the Instrument_Unchecked_Reason set on read and SHALL report any other value as a malformed record.
7. THE Sweep_Summary SHALL report the count of samples excluded under each Instrument_Unchecked_Reason that holds at least one sample.
8. THE Verification_Loop, the Simulator_Adapter, and the Testbench_Agent SHALL continue to write a waveform for every simulate run, because the waveform is a product artifact a student reads and the oracle already requires it as a captured output.
9. THE resource limits an eval sample runs under SHALL remain identical to the resource limits a student session runs under.

### Requirement 4: The instrument is validated before the repair budget is spent

**User Story:** As the engineer paying for a campaign, I want a sample whose testbench rejects the known-good reference design stopped before the repair loop runs, so that 52 iterations are not spent producing verdicts that are already inadmissible.

Evidence: `EvalHarness.#runSample` awaits the whole loop before awaiting `#controlInstrument`; 11 of 15 samples were instrument-invalid and together consumed 52 iterations and 197,901 tokens.

#### Acceptance Criteria

1. THE Verification_Loop SHALL expose an optional Instrument_Admission port and SHALL consult that port at most once per run.
2. WHEN Loop_Setup has produced a Testbench AND the Testbench_Precheck did not attribute a build failure to the Testbench, THE Verification_Loop SHALL consult the Instrument_Admission port before the first iteration.
3. THE Instrument_Admission request SHALL carry the Testbench source and SHALL carry no session budget handle, so an admission check is structurally incapable of consuming a student session's allowance.
4. THE Instrument_Admission request SHALL carry no candidate RTL.
5. WHEN the Instrument_Admission port reports the Testbench admissible, THE Verification_Loop SHALL proceed to the first iteration with the Testbench unchanged.
6. WHEN the Instrument_Admission port reports the Testbench inadmissible, THE Verification_Loop SHALL return Instrument_Refused without running an iteration.
7. IF the Instrument_Admission port reports that it could not decide, THEN THE Verification_Loop SHALL proceed to the first iteration.
8. IF the Instrument_Admission port throws, THEN THE Verification_Loop SHALL proceed to the first iteration, so an unavailable admission check leaves the loop's behaviour as it was before the port existed.
9. WHERE no Instrument_Admission port is wired, THE Verification_Loop SHALL proceed to the first iteration.
10. THE Eval_Harness SHALL supply the Instrument_Admission port for one sample, derived from the Instrument_Control the run was constructed with.
11. THE Instrument_Admission port SHALL report a Testbench inadmissible only where the Recorded_Instrument_Verdict's validity is `invalid`.
12. THE Instrument_Admission port SHALL run the Instrument_Control at most once per sample and SHALL report the same Recorded_Instrument_Verdict to the Eval_Harness that decided the loop's admission, so a sample's instrument is measured once and described once.
13. THE Eval_Harness SHALL record, for every sample, the Recorded_Instrument_Verdict decided for the single Testbench the Loop_Setup produced.
14. WHERE no Recorded_Instrument_Verdict reached the Eval_Harness through the Instrument_Admission port, THE Eval_Harness SHALL run the Instrument_Control after the Verification_Loop has returned, exactly as it does today.
15. THE Instrument_Control SHALL make no model call.
16. THE Recorded_Instrument_Verdict SHALL change neither the loop's own oracle verdict nor the Golden_Judge's verdict for any sample.

### Requirement 5: A refused instrument still yields its candidate to the independent judge

**User Story:** As the engineer citing golden pass@k, I want a sample stopped for a broken instrument to still hand its candidate to the independent judge, so that saving budget does not shrink the denominator of the capability number.

Evidence: `adder_8bit` carries `goldenVerdict: passed` today only because it reached `unverified`; the existing `setup-failed` outcome carries no candidate, and `candidateRtlOf` returns `null` for it.

#### Acceptance Criteria

1. THE Instrument_Refused outcome SHALL carry the candidate the Loop_Setup produced.
2. THE Instrument_Refused outcome SHALL carry the Testbench the Loop_Setup produced.
3. THE Instrument_Refused outcome SHALL carry a sanitized reason drawn from a closed set, and SHALL carry no host, path, credential, or stack trace.
4. THE Instrument_Refused outcome SHALL carry no oracle verdict and SHALL carry no trust label above `Unverified`.
5. THE Artifact_Sink SHALL derive the candidate RTL and the Testbench source from an Instrument_Refused outcome.
6. THE Golden_Judge SHALL score the candidate an Instrument_Refused outcome carries.
7. THE Golden_Denominator membership predicate SHALL admit a sample whose outcome is Instrument_Refused AND whose golden outcome is `passed` or `failed`.
8. THE predicate that decides whether the loop reached an oracle verdict SHALL report Instrument_Refused as no verdict.
9. THE pass@k denominator predicate SHALL report a sample whose outcome is Instrument_Refused as not counted.
10. THE Eval_Harness SHALL classify an Instrument_Refused sample's no-verdict cause distinctly from `blocked`, `setup-failed`, and `runner-error`.
11. THE Sweep_Summary SHALL report the count of Instrument_Refused samples for each arm.
12. WHERE an arm holds at least one Instrument_Refused sample, THE Sweep_Summary SHALL state that those samples' candidates were judged as first candidates that received no repair iteration, so a golden pass@k computed over them is never read as comparable to one computed where every sample ran the repair loop.

### Requirement 6: A refused testbench leaves its evidence on disk

**User Story:** As the engineer diagnosing a sample that produced nothing, I want the rejected testbench draft and the specific unmet requirement persisted, so that the cause is readable from the artifacts instead of being inferred.

Evidence: the 3 `setup-failed` samples' artifact directories each hold exactly one file, `outcome.json`; `missingCheckNames` reaches the Trace only.

#### Acceptance Criteria

1. THE Testbench_Agent SHALL carry the rejected source and the names of the unmet required checks on its `coverage-incomplete` outcome.
2. WHEN Loop_Setup rejects a Testbench for incomplete coverage, THE Verification_Loop SHALL carry the rejected source and the unmet required-check names on its terminal outcome.
3. THE Artifact_Sink SHALL derive the rejected testbench source from a terminal outcome that carries one, bounded by the existing source cap.
4. THE Artifact_Sink SHALL derive the unmet required-check names from a terminal outcome that carries them, bounded by the existing per-check-name cap and by a fixed maximum count.
5. THE Artifact_Sink SHALL write the rejected testbench source to a filename distinct from the accepted testbench's filename, so a reader can never mistake a refused draft for the instrument a verdict was decided by.
6. THE Artifact_Sink SHALL capture no value that a terminal outcome does not carry.
7. THE Testbench_Agent SHALL continue to produce no Testbench where the source omits a required check, so a produced Testbench covers every simulation-verifiable acceptance criterion by construction.
8. THE required check-name matching rule SHALL remain unchanged by this spec, because the persisted evidence needed to decide whether the exact-match rule or an omitted check caused each rejection does not yet exist.

### Requirement 7: The changed measurements make a new experiment

**User Story:** As the engineer resuming or citing a campaign, I want records written before these changes refused rather than pooled, so that a sample measured under the old loop can never blend into a number measured under the new one.

Evidence: the same sample changes both its iteration count (`adder_8bit`: 6 to 0) and its recorded instrument verdict (`multi_16bit`: `invalid`/`TESTBENCH_REFERENCE_UNBUILDABLE` to `unchecked`), and `tbslice-v1`'s 15 records are all `schemaVersion` 9.

#### Acceptance Criteria

1. THE Results_Log SHALL report a record schema version greater than 9.
2. THE Results_Log SHALL refuse to aggregate a results file holding records written under a lower schema version.
3. THE Results_Log advice text SHALL state that the iteration count and the instrument verdict changed meaning, and that a fresh output directory is required.
4. THE build SHALL expose an Instrument_Policy_Version constant identifying the Verification_Loop's instrument-admission behaviour.
5. THE Config_Identity SHALL include the Instrument_Policy_Version in the canonical experiment fingerprint.
6. WHEN the Instrument_Policy_Version changes, THE Config_Identity SHALL produce a different hash for an otherwise identical config.
7. THE Config_Identity SHALL read the Instrument_Policy_Version directly from the build constant, so `sweepConfigHash`'s signature and its call sites stay unchanged.
8. THE Sweep_Manifest SHALL record the Instrument_Policy_Version and SHALL read it from the same build constant the Config_Identity reads.
9. THE pinned config-hash constants in the sweep tests SHALL be updated to the hashes the changed identity produces.
10. THE artifact document schema version SHALL be greater than 6, because a captured sample now carries a Run_Failure_Cause, Attributed_Files, and a rejected testbench draft.

### Requirement 8: No measurement is relaxed

**User Story:** As the engineer responsible for the `Verified` label a student sees, I want every denominator rule left exactly as strict as it is today, so that a change made to save money cannot quietly improve a reported number.

Evidence: the founder's standing ruling that an instrument-invalid sample leaves the pass@k denominator, recorded before this spec and unchanged by it.

#### Acceptance Criteria

1. THE Instrument_Control module SHALL remain the only owner of the pass@k denominator predicate.
2. THE pass@k denominator predicate SHALL report a sample as counted only where the loop reached an oracle verdict AND that sample's instrument validity is `valid`.
3. WHERE a sample's instrument validity is other than `valid`, THE pass@k denominator predicate SHALL report that sample as not counted, whatever the Golden_Judge decided for it.
4. THE Testbench_Precheck SHALL decide admissibility from a toolchain build outcome and SHALL read no model opinion.
5. THE Instrument_Admission port SHALL report a Testbench inadmissible only on a deterministic tool result.
6. THE count of instrument-valid samples measured on the committed campaign-readiness slice SHALL be no lower after these changes than the 1 measured before them.
7. THE total iteration count measured on the committed campaign-readiness slice SHALL be lower after these changes than the 53 measured before them.
8. THE Golden_Denominator size measured on the committed campaign-readiness slice SHALL be no lower after these changes than the 10 measured before them, because every stopped sample still surrenders a candidate to the independent judge.
9. THE golden pass@k value measured after these changes SHALL be reported without a claim of comparability to the value measured before them, because an Instrument_Refused sample's candidate is judged before any repair iteration and a stopped flow is a different flow.

### Requirement 9: The existing engineering gate is preserved

**User Story:** As the engineer who has to trust the harness that produces the number, I want every change in this spec held to the gate the repository already passes, so that a change made to improve honesty is not the thing that breaks the build.

#### Acceptance Criteria

1. WHEN a change in this spec is complete, THE repository SHALL compile under `npx tsc -b` with no reported error.
2. WHEN a change in this spec is complete, THE repository SHALL pass `npx eslint app scripts --max-warnings=0` with no reported warning.
3. WHEN a change in this spec is complete, THE repository SHALL pass `npx prettier --check .` with no reported violation.
4. WHEN a change in this spec is complete, THE repository SHALL pass `npx vitest run` with at least 1613 passing tests.
5. WHEN a change in this spec is complete, THE skipped-test count reported by `npx vitest run` SHALL be exactly 6.
6. THE `npx eslint app scripts --max-warnings=0` run SHALL report no import-boundary violation for any module added by this spec.
7. THE `app/agent` package SHALL hold no import of the `app/eval` package, so the Instrument_Admission port is defined beneath the eval layer and implemented above it.
