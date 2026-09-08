# Requirements Document

## Introduction

The eval harness is built and working.
`npx vitest run` reports 1531 passed / 6 skipped, and `tsc -b`, `eslint app --max-warnings=0`, `prettier --check .`, and the build are clean.
Nine defects were found by running the harness against the real RTLLM corpus and the real Icarus toolchain; all nine are fixed and pinned by regression tests.

This spec is not about rebuilding any of that.
It covers the remaining gap between a working harness and a **citable pass@k number**, and nothing else.

The gap has four parts, each measured on `.eval-runs/instrument-calibration` (1 arm, all 46 scored RTLLM problems, n=1):

| measured fact | value |
| --- | --- |
| distinct samples | 46 |
| reached an oracle verdict | 13 (33 produced no candidate; 31 of those were one rate-limit burst) |
| carried a golden verdict | 13 of 13 that produced a candidate |
| golden passed | 9 |
| instrument-valid (our own testbench proven a measuring stick) | 6 |
| coverage gaps not met | CONDITION_NEGATED x3, CONST_INCREMENTED x3, CONST_ZERO_TO_ONE x3, ARITH_PLUS_TO_MINUS x2, INDEX_OFF_BY_ONE x2, EQUALITY_TO_INEQUALITY x1 |

1. **pass@k is gated on the wrong judge for the capability claim.**
   Today a sample counts in pass@k only if OUR generated testbench was proven a valid instrument, so 74% of samples that ran are excluded and the denominator is 6.
   RTLLM's independent golden testbench produced a verdict on every sample that produced a candidate.
   Our instrument's validity protects the `Verified` LABEL a student sees, which is a product-safety claim; whether the flow produced a correct design is a different question the independent judge already answers.
   Both numbers must be reported, each labelled for what it is, and neither may be presented as the other.

2. **A rate-limit burst destroys a campaign.**
   31 of 46 cells were lost to one burst.
   Deferred-slot retry has landed, so those cells are retried rather than poisoned, but nothing prevents the burst.

3. **Our testbench invents input-side timing the Spec never states.**
   Two prompt iterations closed the output-side halves of this defect class.
   The residual is input-window alignment, evidenced by `expected data_out=0a0, got 040` on `rtllm_arithmetic_accu` sample-0, where `0xa0` is the sum of four inputs and `0x40` is the last input alone.

4. **The named coverage gaps are unclosed.**
   Each listed operator is a defect class the independent judge catches and ours does not, so each is provably our own gap and each can mint a false `Verified`.

## Glossary

- **Golden_Judge**: the independent-judge port (`app/eval/golden-judge.ts`) and its RTLLM-backed implementation, which scores a candidate against a benchmark testbench this project did not write and does not modify.
- **Golden_Outcome**: the outcome the Golden_Judge records for one sample, drawn from a closed set.
- **Golden_Denominator**: the set of samples the Golden_Pass_At_K is computed over.
- **Golden_Pass_At_K**: the pass@k value computed over the Golden_Denominator, whose numerator is samples whose Golden_Outcome is `passed`.
- **Instrument_Control**: the positive and negative controls (`app/eval/instrument-control.ts`, `app/eval/mutation-control.ts`) that decide whether a sample's own generated testbench is a usable measuring stick.
- **Instrument_Gated_Pass_At_K**: the existing pass@k value, computed over the samples `countsInPassAtK` selects.
- **Sweep_Summary**: the module that aggregates persisted sample records into the reported numbers and renders them (`app/eval/sweep/summary.ts`).
- **Results_Log**: the persisted sample-record schema, its encoder, and its decoder (`app/eval/sweep/results-log.ts`).
- **Sweep_Runner**: the sample dispatch pool that drives the bake-off matrix (`app/eval/sweep/runner.ts`).
- **Transport_Retry**: the retrying HTTP port and its run-wide circuit breaker (`app/eval/sweep/transport-retry.ts`).
- **Throttle_Governor**: a new run-wide observer of provider throttling that reports a backoff multiplier and a recommended concurrency.
- **Retry_After_Reader**: a new boundary parser that converts a `Retry-After` header value into a bounded delay.
- **Json_Http_Port**: the JSON-over-HTTPS seam vendor transports program to (`app/agent/model-router/json-http-port.ts`).
- **Testbench_Agent**: the RTL-isolated, spec-derived testbench generator (`app/agent/roles/testbench/`).
- **Testbench_Prompt_Version**: an identifier for the assembled Testbench_Agent prompt.
- **Config_Identity**: the canonical experiment fingerprint every persisted record is keyed by (`app/eval/sweep/config-identity.ts`).
- **Sweep_Manifest**: the per-run provenance document (`app/eval/sweep/manifest.ts`).
- **Coverage_Gap_Survivor**: a mutant the independent golden testbench killed and our generated testbench did not.
- **Input_Qualifier**: a declared single-bit input port that tells a design when its data inputs are to be accepted.

## Requirements

### Requirement 1: Golden pass@k as its own labelled capability metric

**User Story:** As the engineer citing this harness's numbers, I want the independent judge's pass@k reported alongside the self-graded one, so that I can cite a capability number whose denominator is not shrunk by our own testbench's defects.

#### Acceptance Criteria

1. THE Sweep_Summary SHALL report a Golden_Pass_At_K value for every requested k.
2. THE Sweep_Summary SHALL derive every Golden_Pass_At_K value from the `passAtK` estimator exported by the metrics module.
3. THE Sweep_Summary SHALL render each Golden_Pass_At_K value on a line that contains the token `GOLDEN` and names the independent judge as the deciding authority.
4. THE Sweep_Summary SHALL render each Instrument_Gated_Pass_At_K value on a line that names the value self-graded and instrument-gated.
5. WHEN the Sweep_Summary renders an arm block, THE Sweep_Summary SHALL print each pass@k value beside the size of its own denominator.
6. WHERE the Golden_Denominator for an arm holds zero samples, THE Sweep_Summary SHALL render Golden_Pass_At_K as `NOT MEASURED`.
7. THE Sweep_Summary SHALL compute Golden_Pass_At_K per problem and report the mean across problems, matching the aggregation the Instrument_Gated_Pass_At_K already uses.

### Requirement 2: The Golden_Denominator's membership rule and its exclusions

**User Story:** As a reviewer challenging a cited number, I want every sample excluded from the golden denominator counted under the reason that excluded it, so that a small denominator cannot be presented as a corpus-wide result.

#### Acceptance Criteria

1. THE Golden_Judge module SHALL expose exactly one predicate that decides Golden_Denominator membership for one sample.
2. WHERE a sample reached an oracle verdict AND carries a Golden_Outcome of `passed` or `failed`, THE Golden_Denominator predicate SHALL report that sample as a member.
3. IF a sample reached no oracle verdict, THEN THE Golden_Denominator predicate SHALL report that sample as excluded, because a sample that produced no candidate was never judged and is not a model failure.
4. IF a sample carries no Golden_Outcome, THEN THE Golden_Denominator predicate SHALL report that sample as excluded.
5. IF a sample carries a Golden_Outcome of `did-not-build`, `no-output`, or `timed-out`, THEN THE Golden_Denominator predicate SHALL report that sample as excluded, because the judge reported no verdict on the candidate's behaviour.
6. THE Sweep_Summary SHALL count each excluded sample under exactly one exclusion reason.
7. WHEN the Sweep_Summary renders a Golden_Pass_At_K value, THE Sweep_Summary SHALL render the total count of samples excluded from that arm's Golden_Denominator in the same arm block.
8. WHERE an exclusion reason holds at least one sample, THE Sweep_Summary SHALL name that reason and its count.
9. THE Sweep_Summary SHALL report the count of excluded samples and the size of the Golden_Denominator such that their sum equals the count of that arm's recorded samples.

### Requirement 3: The Golden_Outcome vocabulary distinguishes the three no-verdict causes

**User Story:** As the engineer who has to explain an exclusion, I want a golden run that reported no verdict classified by cause, so that the excluded bucket points at the defect that produced it instead of being a black box.

#### Acceptance Criteria

1. THE Golden_Judge SHALL record a Golden_Outcome drawn from the closed set `passed`, `failed`, `did-not-build`, `no-output`, `timed-out`.
2. WHEN the golden run was killed for exceeding a resource bound it was given, THE Golden_Judge SHALL record the Golden_Outcome `timed-out`.
3. WHEN the golden run reported no banner AND emitted build diagnostics, THE Golden_Judge SHALL record the Golden_Outcome `did-not-build`.
4. WHEN the golden run reported no banner AND emitted no diagnostics, THE Golden_Judge SHALL record the Golden_Outcome `no-output`.
5. THE Golden_Judge SHALL decide between `did-not-build` and `no-output` by calling the existing non-pass cause classifier, so that one rule has one owner.
6. THE Results_Log SHALL accept only the five Golden_Outcome values on read and SHALL report any other value as a malformed record.
7. THE Results_Log SHALL refuse to aggregate a results file written before the Golden_Outcome vocabulary widened.
8. THE Results_Log advice text SHALL state that the golden outcome vocabulary widened and that a fresh output directory is required.

### Requirement 4: The instrument-gated denominator invariant is preserved unchanged

**User Story:** As the engineer responsible for the `Verified` label a student sees, I want the instrument-gated denominator left exactly as strict as it is today, so that adding a capability metric cannot relax a product-safety claim.

#### Acceptance Criteria

1. THE Instrument_Control module SHALL remain the only owner of the `countsInPassAtK` predicate.
2. THE `countsInPassAtK` predicate SHALL report a sample as counted only where the loop reached an oracle verdict AND that sample's instrument validity is `valid`.
3. WHERE a sample's instrument validity is other than `valid` AND that sample's Golden_Outcome is `passed`, THE `countsInPassAtK` predicate SHALL report that sample as not counted.
4. THE Instrument_Gated_Pass_At_K value SHALL be computed over exactly the set the `countsInPassAtK` predicate selects.
5. THE tokens-per-verified-artifact and wall-clock-per-verified-artifact populations SHALL remain the set the Instrument_Gated_Pass_At_K is computed over.
6. THE Instrument_Control module SHALL hold no reference to the Golden_Outcome vocabulary.

### Requirement 5: A host-supplied Retry-After delay is honoured as a floor

**User Story:** As the operator of an overnight campaign, I want the harness to wait as long as a throttling host asks, so that a burst is answered with the host's own instruction rather than a schedule we invented.

#### Acceptance Criteria

1. WHEN a `Retry-After` value expressed in delta-seconds is read, THE Retry_After_Reader SHALL report that value converted to milliseconds.
2. WHEN a `Retry-After` value expressed as an HTTP-date is read, THE Retry_After_Reader SHALL report the milliseconds remaining between the injected clock and that instant.
3. IF a `Retry-After` value is absent, unparseable, or resolves to a negative duration, THEN THE Retry_After_Reader SHALL report no delay.
4. THE Retry_After_Reader SHALL report a delay no greater than the retry policy's maximum delay.
5. WHEN an attempt is classified retryable AND the reply carried a Retry-After delay, THE Transport_Retry SHALL wait at least the greater of that delay and its own jittered backoff, because a Retry-After value can legitimately resolve to zero while the host is still refusing.
6. THE Json_Http_Port reply SHALL carry the parsed Retry-After delay and SHALL carry no other reply header field.
7. THE Retry_After_Reader SHALL derive every reported value from the header text and an injected clock.

### Requirement 6: Backoff adapts to observed throttling rather than following a fixed schedule

**User Story:** As the operator of an overnight campaign, I want the wait between attempts to grow with how hard the host is currently throttling, so that a sustained burst is not met with the same delay as a single transient failure.

#### Acceptance Criteria

1. WHEN a retryable throttle reply is observed, THE Throttle_Governor SHALL record that observation with the instant it was observed.
2. THE Throttle_Governor SHALL report a backoff multiplier that is non-decreasing in the count of throttle observations inside its window.
3. THE Throttle_Governor SHALL report a backoff multiplier no greater than a fixed maximum defined in build constants.
4. WHILE the Throttle_Governor's window holds no throttle observation, THE Throttle_Governor SHALL report the backoff multiplier 1.
5. THE Transport_Retry SHALL multiply its computed backoff by the reported multiplier and SHALL clamp the product to the retry policy's maximum delay.
6. THE Throttle_Governor SHALL derive every reported value from its recorded observations and an injected clock.
7. THE Transport_Retry SHALL apply the Retry-After floor of Requirement 5 to the clamped product, so one delay is decided by one rule.

### Requirement 7: Concurrency is reduced under sustained throttling and restored after quiet

**User Story:** As the operator of an overnight campaign, I want in-flight sample count treated as something to reduce when the host is throttling, so that a burst is answered by asking for less rather than by retrying the same load.

#### Acceptance Criteria

1. THE Throttle_Governor SHALL report a recommended concurrency of at least 1 and at most the configured concurrency.
2. THE Throttle_Governor SHALL report a recommended concurrency that is non-increasing in the count of throttle observations inside its window.
3. WHILE the Throttle_Governor's window holds no throttle observation, THE Throttle_Governor SHALL report the configured concurrency as the recommendation.
4. WHEN a pool worker is about to take a unit of work, THE Sweep_Runner SHALL admit that worker only while the count of workers holding a unit is below the reported recommended concurrency.
5. WHILE units of work remain and the run is not stopping, THE Sweep_Runner SHALL keep at least one worker admitted.
6. THE Sweep_Runner SHALL hold at most the configured concurrency workers admitted at any instant.
7. WHERE a worker is withheld by a reduced recommendation, THE Sweep_Runner SHALL leave that worker's unit of work in the plan for a later worker to take.
8. THE Sweep_Runner SHALL record no sample as failed on account of a reduced recommendation.
9. THE Sweep_Runner SHALL report the recommended concurrency in its sanitized progress lines whenever that recommendation differs from the configured concurrency.

### Requirement 8: The throttling work leaves the experiment identity unchanged

**User Story:** As the operator resuming a campaign, I want survivability behaviour kept out of the experiment fingerprint, so that hardening the transport does not orphan samples that have already been paid for.

#### Acceptance Criteria

1. THE Config_Identity SHALL produce the same hash for the committed smoke config after the throttling change as it produced before it.
2. THE Throttle_Governor SHALL take its window length, its multiplier bound, and its concurrency reduction step from build constants.
3. THE sweep config parser SHALL report an unrecognized throttling field as an `UNKNOWN_FIELD` error.

### Requirement 9: The generated testbench aligns input windows only where the Spec pins them

**User Story:** As the engineer who needs the instrument to be a measuring stick, I want the testbench to stop choosing which inputs form one accumulation window, so that a correct design is not rejected for timing the Spec never stated.

#### Acceptance Criteria

1. THE Testbench_Agent prompt SHALL state that the Spec is the only source of the edge on which a data input is sampled.
2. WHERE the declared module interface carries an Input_Qualifier, THE Testbench_Agent prompt SHALL offer exactly one derivation for which driven inputs belong to one window.
3. WHERE the declared module interface carries no Input_Qualifier, THE Testbench_Agent prompt SHALL state that an input window may be formed only where the Spec pins the sampling moment.
4. THE Testbench_Agent prompt SHALL derive every Input_Qualifier name it states from the declared module interface.
5. THE Testbench_Agent SHALL assemble the input-alignment rule from the Spec, the intent summary, and OKF passages only.
6. WHEN the campaign-readiness slice of at least 12 RTLLM problems is measured, THE count of instrument-valid samples SHALL be at least the count measured on that same slice before the input-alignment rule was added.
7. THE campaign-readiness slice SHALL be a committed sweep config file whose parsed shape and Config_Identity hash are pinned by a test.

### Requirement 10: The named coverage gaps are closed, most frequent first

**User Story:** As the engineer whose testbench can mint a false `Verified`, I want the defect classes the independent judge catches and ours misses to be closed, so that instrument validity is earned rather than assumed.

#### Acceptance Criteria

1. THE Testbench_Agent prompt SHALL state a stimulus-adequacy rule requiring stimulus that distinguishes a boundary shifted by one, a negated condition, an altered constant, an inverted arithmetic sign, and a relaxed equality.
2. THE Testbench_Agent prompt SHALL derive the stimulus-adequacy rule from the declared module interface and the Spec's acceptance criteria.
3. WHEN the negative control is run on a committed fixture testbench that follows the stimulus-adequacy rule, THE negative control SHALL report zero Coverage_Gap_Survivors for each of `CONDITION_NEGATED`, `CONST_INCREMENTED`, `CONST_ZERO_TO_ONE`, `ARITH_PLUS_TO_MINUS`, `INDEX_OFF_BY_ONE`, and `EQUALITY_TO_INEQUALITY`.
4. WHEN the negative control is run on the committed known-weak fixture testbench, THE negative control SHALL report at least one Coverage_Gap_Survivor, so the fixture pair proves the check is not vacuous.
5. THE Sweep_Summary SHALL continue to render Coverage_Gap_Survivor operators in descending frequency order.
6. THE mutation kill rate SHALL remain a reported quality signal that decides no gate.

### Requirement 11: A prompt change makes a new experiment

**User Story:** As the engineer citing a campaign, I want a Testbench_Agent prompt change to produce a different experiment identity, so that samples measured under two different prompts can never pool into one number.

#### Acceptance Criteria

1. THE Testbench_Agent SHALL expose a Testbench_Prompt_Version identifier.
2. THE Config_Identity SHALL include the Testbench_Prompt_Version in the canonical experiment fingerprint.
3. WHEN the Testbench_Prompt_Version changes, THE Config_Identity SHALL produce a different hash for an otherwise identical config.
4. THE Sweep_Manifest SHALL record the Testbench_Prompt_Version.
5. THE Sweep_Manifest SHALL read the Testbench_Prompt_Version from the same build constant the Config_Identity reads, so a manifest cannot claim a prompt version the run did not use.
6. WHEN the assembled Testbench_Agent prompt for the canonical fixture Spec changes, THE prompt-version test SHALL report a failure until the Testbench_Prompt_Version is changed.

### Requirement 12: The existing engineering gate is preserved

**User Story:** As the engineer who has to trust the harness that produces the number, I want every change in this spec held to the gate the repository already passes, so that a campaign-readiness change cannot be the thing that breaks it.

#### Acceptance Criteria

1. WHEN a change in this spec is complete, THE repository SHALL compile under `npx tsc -b` with no reported error.
2. WHEN a change in this spec is complete, THE repository SHALL pass `npx eslint app --max-warnings=0` with no reported warning.
3. WHEN a change in this spec is complete, THE repository SHALL pass `npx prettier --check .` with no reported violation.
4. WHEN a change in this spec is complete, THE repository SHALL pass `npx vitest run` with at least 1531 passing tests.
5. WHEN a change in this spec is complete, THE skipped-test count reported by `npx vitest run` SHALL be exactly 6.
6. THE `npx eslint app --max-warnings=0` run SHALL report no import-boundary violation for any module added by this spec.
