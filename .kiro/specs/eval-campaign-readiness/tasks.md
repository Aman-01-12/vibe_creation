# Implementation Plan: eval-campaign-readiness

## Overview

Three independent tracks, executed concurrently by separate agents on one working tree.
Every file below is owned by exactly one track.
No task rebuilds anything that already exists and works.

## Parallel tracks and file ownership

### Track A - golden pass@k reporting

Answers: the capability number is gated on our own testbench's validity, so 74% of samples that ran are excluded.

**Owns, exclusively:**

```
app/eval/golden-judge.ts                     app/eval/golden-judge.test.ts
app/eval/corpus/rtllm-golden-judge.ts        app/eval/corpus/rtllm-golden-judge.test.ts   (new)
app/eval/sweep/results-log.ts                app/eval/sweep/results-log.test.ts
app/eval/sweep/summary.ts                    app/eval/sweep/summary.test.ts
app/eval/sweep/artifact-layout.ts            app/eval/sweep/artifact-layout.test.ts
app/eval/metrics.ts                          app/eval/metrics.test.ts        (owned; expected UNCHANGED)
app/eval/index.ts
```

`app/eval/metrics.ts` is owned while expected to need no edit, so that no second pass@k estimator can appear while three tracks run.

### Track B - transport throttling survivability

Answers: one rate-limit burst cost 31 of 46 cells; deferred-slot retry recovers them but nothing prevents the burst.

**Owns, exclusively:**

```
app/agent/model-router/retry-after.ts        app/agent/model-router/retry-after.test.ts   (new, both)
app/agent/model-router/json-http-port.ts
app/agent/model-router/fetch-json-http-port.ts  app/agent/model-router/fetch-json-http-port.test.ts
app/agent/model-router/index.ts
app/eval/sweep/throttle-governor.ts          app/eval/sweep/throttle-governor.test.ts     (new, both)
app/eval/sweep/transport-retry.ts            app/eval/sweep/transport-retry.test.ts
app/eval/sweep/runner.ts                     app/eval/sweep/runner.test.ts
app/eval/sweep/cli.ts                        app/eval/sweep/cli.test.ts
app/eval/sweep/config-parse.test.ts
app/eval/sweep/index.ts
```

### Track C - Testbench_Agent prompt, coverage gaps, and experiment identity

Answers: our testbench invents input-side timing; the six named coverage gaps are unclosed; a prompt change must make a new experiment.

**Owns, exclusively:**

```
app/agent/roles/testbench/prompt.ts
app/agent/roles/testbench/coverage.ts
app/agent/roles/testbench/standard-blocks.ts
app/agent/roles/testbench/prompt-version.ts  app/agent/roles/testbench/prompt-version.test.ts  (new, both)
app/agent/roles/testbench/index.ts
app/eval/sweep/config-identity.ts
app/eval/sweep/manifest.ts                   app/eval/sweep/manifest.test.ts
app/eval/sweep/sweep.config.tbslice.json                                                       (new)
app/test/testbench-agent.test.ts
app/test/testbench-rtl-isolation.property.test.ts
app/test/eval-negative-control.integration.test.ts
app/test/fixtures/**  (coverage-gap fixture pair only)
```

### Files two tracks would both want, and who gets them

| File | Wanted by | Assigned to | How the other track avoids it |
| --- | --- | --- | --- |
| `app/eval/sweep/runner.ts` | A (would forward a new golden field) and B (admission gating) | **B** | A's change needs none: `recordFor` already forwards `sample.goldenVerdict?.kind ?? null`, which type-checks against the widened union, and `progressLine` already interpolates the kind as text. |
| `app/eval/sweep/cli.ts` | B (wires the governor) and C (would pass a prompt version) | **B** | C's constants are read directly by `config-identity.ts` and `manifest.ts`, the pattern `manifest.ts` already uses for the pinned corpus constants, so no signature and no call site changes. |
| `app/eval/sweep/manifest.test.ts` (holds `SMOKE_RUN_CONFIG_HASH`) | B (a config knob would move the hash) and C (the prompt version moves it) | **C** | B adds NO sweep-config field, by design: a throttle knob would enter the experiment identity and orphan every paid sample, and throttle response is a safety property rather than a tunable experiment parameter. |
| `app/eval/sweep/config.ts`, `config-parse.ts` | B (would add knobs) | **nobody edits them** | Same reason. B's bounds are build constants in `throttle-governor.ts`. |
| `app/eval/sweep/index.ts` | A and B (barrel exports) | **B** | A exports through `app/eval/index.ts`, which already re-exports the sweep barrel wholesale. |
| `app/agent/index.ts` | B and C (barrel exports) | **nobody edits it** | It is `export *` over `roles/index.js` and `model-router/index.js`, so each track exports from its own barrel and the root needs no edit. |
| `app/eval/instrument-control.ts` | — | **no track** | The `countsInPassAtK` invariant is untouched. Task 2.4 pins that with a metamorphic property test. |
| `app/eval/corpus/mutation-calibration.ts` | — | **no track** | `calibrationOf` reads `GoldenScore.timedOut`, not the recorded kind, so widening the recorded vocabulary reaches it not at all. `MUTATION_CALIBRATION_CACHE_VERSION` stays at 3. |

### Cross-track sequencing (the only two)

1. **The campaign runs after all three tracks land.** Track C moves the config hash, so a campaign started earlier cannot pool with one started later.
2. **Within Track C, task 9.1 is last.** The prompt version pins a digest of the assembled prompt, so bumping it before tasks 7.1 and 8.1 would force re-pinning twice.

Tracks A and B have no dependency on each other or on C.

### The gate every task is verified against

```
npx tsc -b
npx eslint app --max-warnings=0
npx prettier --check .
npx vitest run     # >= 1531 passed, exactly 6 skipped, no new skips
```

`npx tsc -b` is the whole-repository build and is the one to trust: `tsc -b app/test` is package-wide and reports a sibling track's in-progress test file as an error. Read a failure in a file your track does not own as another track's work in progress, never as your own.

## Tasks

- [x] 1. Track A - the golden outcome vocabulary and the independent-judge boundary
  - [x] 1.1 Widen the recorded golden verdict and add the golden denominator predicate
    - In `app/eval/golden-judge.ts`, add `RecordedGoldenKind` as a closed five-member union and retype `RecordedGoldenVerdict.kind`
    - Add `countsInGoldenPassAtK` and `summarizeGoldenPassAtK` with a `GoldenPassAtKReport` whose fields partition the arm
    - Build the exclusion tally from a total `Record<RecordedGoldenKind, ...>` so a sixth kind is a compile error
    - Leave `GoldenVerdictKind` in `app/eval/corpus/golden-banner.ts` untouched at `passed | failed | error`
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 4.6_

  - [x]* 1.2 Property tests for the golden denominator
    - In `app/eval/golden-judge.test.ts`
    - **Property 1: The golden denominator excludes every sample the judge did not judge**
    - **Property 2: The golden report partitions the arm**
    - Generators must emit every combination of outcome status and golden kind including `null`, or Property 1 passes while an exclusion is unimplemented
    - Verify: `npx vitest run app/eval/golden-judge.test.ts` then the full gate
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.9_

  - [x] 1.3 Classify the no-verdict cause at the RTLLM judge boundary
    - In `app/eval/corpus/rtllm-golden-judge.ts`, map `GoldenScore` to `RecordedGoldenKind` in this order: resource bound, `failed`, `passed`, then the existing non-pass cause classifier
    - Delegate the `did-not-build` / `no-output` split to `app/eval/corpus/nonpass-cause.ts` so that rule keeps one owner across Stage 0, the positive control, and the judge
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 3.2, 3.3, 3.4, 3.5_

  - [x]* 1.4 Classification tests at the judge boundary
    - New file `app/eval/corpus/rtllm-golden-judge.test.ts`
    - Unit: a run that both exceeded a resource bound and printed no diagnostics classifies `timed-out`, not `no-output` - the ordering trap
    - Differential property: the build-failure split agrees with `classifyNonPass` on every generated diagnostics text, including whitespace-only
    - Verify: `npx vitest run app/eval/corpus/rtllm-golden-judge.test.ts` then the full gate
    - _Requirements: 3.2, 3.3, 3.4, 3.5_

  - [x] 1.5 Widen the persisted golden kinds and bump the results schema
    - In `app/eval/sweep/results-log.ts`, widen `GOLDEN_KINDS` to the five recorded kinds and retype `SweepSampleRecord.goldenVerdict`
    - Bump `RESULTS_SCHEMA_VERSION` 7 -> 8 as a refusal, and extend `STALE_SCHEMA_ADVICE` to state that the golden outcome vocabulary widened and a fresh output directory is required
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 3.6, 3.7, 3.8_

  - [x]* 1.6 Decoder and refusal tests
    - In `app/eval/sweep/results-log.test.ts`
    - **Property 6: A widened golden kind is accepted and anything else is refused**
    - Unit: a v7 line refuses the whole file and aggregates nothing; the advice text names the golden vocabulary change
    - Verify: `npx vitest run app/eval/sweep/results-log.test.ts` then the full gate
    - _Requirements: 3.1, 3.6, 3.7, 3.8_

- [x] 2. Track A - the two labelled pass@k metrics
  - [x] 2.1 Aggregate the golden denominator into the arm summary
    - In `app/eval/sweep/summary.ts`, give `armPassAtK` a numerator predicate parameter so one implementation serves both numerators
    - Build a second eligible list from `countsInGoldenPassAtK` and add `goldenPassAtK` plus the golden report to `ArmSummary`
    - Leave the instrument-gated eligible list, the efficiency population, and every existing number exactly as they are
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 1.1, 1.2, 1.7, 2.6, 4.4, 4.5_

  - [x] 2.2 Render the golden block and relabel the self-graded line
    - In `app/eval/sweep/summary.ts`, render the golden block FIRST, carrying the token `GOLDEN`, its denominator size, and the full exclusion tally inside the same block
    - Relabel the existing line as self-graded and instrument-gated, keeping its denominator wording
    - Render `NOT MEASURED` for an empty golden denominator, reusing the existing convention rather than printing a zero
    - Name only the exclusion reasons that hold at least one sample
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 2.7, 2.8_

  - [x] 2.3 Bump the artifact document schema and export the predicate
    - In `app/eval/sweep/artifact-layout.ts`, bump `ARTIFACT_DOCUMENT_SCHEMA_VERSION` 6 -> 7 with the reason recorded beside the previous bumps
    - Update the version assertion in `app/eval/sweep/artifact-layout.test.ts` in the same task, since that file has no other writer in this plan
    - Export `countsInGoldenPassAtK` and the golden report type from `app/eval/index.ts`
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 3.1_

  - [x]* 2.4 Summary property and rendering tests
    - In `app/eval/sweep/summary.test.ts`
    - **Property 3: The golden metric never moves the instrument-gated denominator** - metamorphic: vary only a sample's golden kind and assert `countsInPassAtK`, the instrument-gated pass@k, and both efficiency figures are unchanged. This is the guard that the added metric relaxes nothing
    - **Property 4: Both pass@k values come from one estimator** - model-based against `passAtK` recomputed from the same records
    - **Property 5: Each rendered pass@k value carries its own label and denominator**
    - Unit: the exact wording of both labels and of `NOT MEASURED`, pinned because their function is to stop a reader confusing two numbers
    - Verify: `npx vitest run app/eval/sweep/summary.test.ts` then the full gate
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.7, 2.8, 4.2, 4.3, 4.4, 4.5_

- [x] 3. Checkpoint - Track A
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm `npx vitest run` reports >= 1531 passed and exactly 6 skipped.

- [x] 4. Track B - the Retry-After instruction at the transport boundary
  - [x] 4.1 Add the Retry-After reader
    - New file `app/agent/model-router/retry-after.ts` with `parseRetryAfterMs(value, nowMs, maxDelayMs)`
    - Handle both header forms - an integer count of seconds, and an HTTP-date measured against the injected clock
    - Return no delay for an absent, non-integer, negative, or unparseable value; clamp a parsed delay to `maxDelayMs`, because the header is untrusted input and must not be able to park a campaign
    - Total and pure: no globals, no clock read, no throw
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.7_

  - [x]* 4.2 Retry-After parser property tests
    - New file `app/agent/model-router/retry-after.test.ts`
    - **Property 7: Retry-After round-trips from delta-seconds**
    - **Property 8: Retry-After rejects what it cannot read and clamps what it can**
    - The generator must emit both header forms plus junk, or Property 8 exercises only the happy branch
    - Verify: `npx vitest run app/agent/model-router/retry-after.test.ts` then the full gate
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.7_

  - [x] 4.3 Carry the parsed delay on the JSON reply
    - In `app/agent/model-router/json-http-port.ts`, add `retryAfterMs?: number | null` to `JsonHttpResponse` and document that it is the ONLY reply header field that travels upward, and that it travels as a bounded number rather than as text
    - In `app/agent/model-router/fetch-json-http-port.ts`, read exactly one header from the host reply through a narrow accessor - never a header map - and hand it to `parseRetryAfterMs`
    - Export the reader from `app/agent/model-router/index.ts`
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 5.6_

  - [x]* 4.4 Fetch-port header tests
    - In `app/agent/model-router/fetch-json-http-port.test.ts`
    - Unit: a reply carrying `Retry-After` surfaces the parsed delay; a reply without it surfaces no delay; the returned object exposes no other header
    - Verify: `npx vitest run app/agent/model-router/fetch-json-http-port.test.ts` then the full gate
    - _Requirements: 5.6_

- [x] 5. Track B - adaptive backoff and adaptive concurrency
  - [x] 5.1 Add the throttle governor
    - New file `app/eval/sweep/throttle-governor.ts` with `THROTTLE_GOVERNOR_LIMITS` as build constants and a `ThrottleGovernor` class shaped like the existing `TransportCircuitBreaker`
    - Sole owner of its observation list; `backoffMultiplier()` and `recommendedConcurrency()` are DERIVED from the observations still inside the window, so recovery needs no separate timer and the two can never disagree
    - Floor the recommendation at 1 and cap it at the configured concurrency, so the governor only ever moves downward from the configured ceiling
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 7.1, 7.2, 7.3, 8.2_

  - [x]* 5.2 Governor property tests
    - New file `app/eval/sweep/throttle-governor.test.ts`
    - **Property 10: The backoff multiplier is monotone in observed throttling and bounded**
    - **Property 11: The recommended concurrency is monotone, bounded, and recovers**
    - Sequence generators must span the window boundary, or the recovery clause never runs
    - Verify: `npx vitest run app/eval/sweep/throttle-governor.test.ts` then the full gate
    - _Requirements: 6.2, 6.3, 6.4, 6.6, 7.1, 7.2, 7.3_

  - [x] 5.3 Compose the floor, the multiplier, and the clamp in the retrying port
    - In `app/eval/sweep/transport-retry.ts`, apply the governor's multiplier to the computed backoff, clamp the product to `policy.maxDelayMs`, then raise the result to the reply's Retry-After delay - the floor after the clamp, so a host asking for longer than our ceiling is still obeyed
    - Record a throttle observation for a retryable outcome whose status is 429, which is the one status meaning "you are asking for too much"
    - Leave the circuit breaker's contract untouched: the governor slows the run, the breaker ends it
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 5.5, 6.1, 6.5, 6.7_

  - [x]* 5.4 Applied-delay property test
    - In `app/eval/sweep/transport-retry.test.ts`
    - **Property 9: The applied delay is never below the host's instruction**
    - Include the case where the parsed Retry-After delay is exactly 0, which is why the floor is a maximum rather than an override
    - Verify: `npx vitest run app/eval/sweep/transport-retry.test.ts` then the full gate
    - _Requirements: 5.5, 6.5, 6.7_

  - [x] 5.5 Gate worker admission on the recommended concurrency
    - In `app/eval/sweep/runner.ts`, change `#drain` from a fixed pool to an admission-gated pool: a worker asks for admission before taking a unit and waits and re-asks when the count of workers holding a unit has reached the recommendation
    - Keep the initial worker count at `min(configured, units.length)` so the configured ceiling and the existing bounded-concurrency test hold unchanged
    - Keep at least one worker admitted while units remain, so a reduction is a slowdown and never a deadlock
    - Leave a withheld worker's unit in the plan and record no sample as failed on account of a reduction
    - Report the recommendation in the sanitized progress line whenever it differs from the configured value
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [x]* 5.6 Admission and conservation property tests
    - In `app/eval/sweep/runner.test.ts`
    - **Property 12: Admission never exceeds either bound and never starves**
    - **Property 13: A reduced recommendation loses no unit of work**
    - Unit: with the recommendation pinned at 1 throughout, every unit still completes; the progress line names a reduced recommendation
    - Keep the existing bounded-concurrency and sequential-at-1 tests unchanged - they are the pinned statement of Requirement 7.6
    - Verify: `npx vitest run app/eval/sweep/runner.test.ts` then the full gate
    - _Requirements: 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [x] 5.7 Wire the governor at the composition root
    - In `app/eval/sweep/cli.ts`, construct the governor beside the existing breaker and pass it to the HTTP port builder and to the runner, following the shape the breaker already uses
    - Export the governor from `app/eval/sweep/index.ts`
    - Add no sweep-config field: a throttle knob would enter the experiment identity and orphan every paid sample, and throttle response is a safety property rather than a tunable experiment parameter
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 8.1, 8.2_

  - [x]* 5.8 Config-surface test
    - In `app/eval/sweep/config-parse.test.ts`
    - Unit: a config carrying a throttling key is rejected as `UNKNOWN_FIELD`, so a config written by someone who believes they are setting a bar that does not exist fails before the first paid model call
    - Verify: `npx vitest run app/eval/sweep/config-parse.test.ts` then the full gate
    - _Requirements: 8.1, 8.3_

- [x] 6. Checkpoint - Track B
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm the pinned `SMOKE_RUN_CONFIG_HASH` in `app/eval/sweep/manifest.test.ts` still passes at its current value, which is Requirement 8.1.

- [x] 7. Track C - input-window alignment in the Testbench_Agent prompt
  - [x] 7.1 Add the input-window rule
    - In `app/agent/roles/testbench/prompt.ts`, add `inputQualifierNames` and `describeInputWindow`, conditioned on the DECLARED interface exactly as `describeStateAnchoring` and `describeTiming` already are
    - State that the Spec is the only source of the edge on which a data input is sampled
    - Offer exactly ONE derivation where an input qualifier is declared: form the expected value from the inputs the testbench itself drove under an asserted qualifier, never from a cycle count and never from a window boundary the testbench chose
    - Where no input qualifier is declared, state that a window may be formed only where the Spec pins the sampling moment
    - State the rule generally over an input handshake, not over accumulation, and do not tune it against `accu`
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x]* 7.2 Prompt property test for the input-window rule
    - In `app/test/testbench-agent.test.ts`
    - **Property 14: The testbench prompt offers exactly one input-window derivation**
    - Assert exactly one derivation is present WITHOUT re-deriving which, so the branch stays owned by the prompt, and assert every qualifier name stated is a declared port of the generated interface
    - Verify: `npx vitest run app/test/testbench-agent.test.ts` then the full gate
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x]* 7.3 Extend the RTL-isolation property
    - In `app/test/testbench-rtl-isolation.property.test.ts`
    - **Property 15: The input-window rule is assembled without RTL**
    - Extend the existing anti-circular property rather than adding a second owner of that guarantee
    - Verify: `npx vitest run app/test/testbench-rtl-isolation.property.test.ts` then the full gate
    - _Requirements: 9.5_

- [x] 8. Track C - coverage-gap closure
  - [x] 8.1 Add the stimulus-adequacy rule
    - In `app/agent/roles/testbench/prompt.ts`, state a stimulus-adequacy rule derived from the declared interface and the Spec's acceptance criteria, requiring stimulus that distinguishes a boundary shifted by one, a negated condition, an altered constant, an inverted arithmetic sign, and a relaxed equality
    - Address the six operators in descending measured frequency: `CONDITION_NEGATED` (3), `CONST_INCREMENTED` (3), `CONST_ZERO_TO_ONE` (3), `ARITH_PLUS_TO_MINUS` (2), `INDEX_OFF_BY_ONE` (2), `EQUALITY_TO_INEQUALITY` (1)
    - State the rule at the altitude of "make the check able to distinguish" and do NOT name mutation operators in the prompt - naming them teaches the instrument the shape of the exam, which is the circularity the whole method exists to avoid
    - Where the evidence from task 8.2 shows prose is not enough, promote a boundary check to a derived `RequiredCheck` in `app/agent/roles/testbench/coverage.ts`, which the model must emit rather than may follow
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 10.1, 10.2, 10.5, 10.6_

  - [x]* 8.2 Coverage-gap fixture pair on the real toolchain
    - In `app/test/eval-negative-control.integration.test.ts`, add a committed fixture pair driven through real Icarus, needing no model call
    - Assert the discriminating fixture produces ZERO coverage-gap survivors for all six named operators
    - Assert the known-weak fixture still produces at least one, which is what makes the claim non-vacuous
    - Use the existing skip harness so a host without the toolchain skips rather than fails, and keep the total skip count at exactly 6
    - Do not lower a threshold or drop an operator to make this pass; both would tune the measurement instead of the instrument
    - Verify: `npx vitest run app/test/eval-negative-control.integration.test.ts` then the full gate
    - _Requirements: 10.3, 10.4_

- [x] 9. Track C - experiment identity for a prompt change
  - [x] 9.1 Add the prompt version and fold it into the identity and the manifest
    - New file `app/agent/roles/testbench/prompt-version.ts` exporting `TESTBENCH_PROMPT_VERSION = 2`, set to 2 because the prompt has already changed twice since the calibration run and version 1 would claim those samples were measured under the current prompt
    - Export it from `app/agent/roles/testbench/index.ts`
    - In `app/eval/sweep/config-identity.ts`, fold it into the canonical JSON under a reserved key, reading the constant directly so `sweepConfigHash`'s signature and every call site stay unchanged
    - In `app/eval/sweep/manifest.ts`, record it, read directly for the same reason the pinned corpus constants already are: a manifest must not be able to claim a prompt version the run did not use
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x]* 9.2 Pinned prompt digest test
    - New file `app/agent/roles/testbench/prompt-version.test.ts`
    - Unit: digest the prompt assembled for a canonical fixture Spec and compare against a value pinned beside the version constant, so changing a rule without bumping the version fails loudly
    - Verify: `npx vitest run app/agent/roles/testbench/prompt-version.test.ts` then the full gate
    - _Requirements: 11.6_

  - [x] 9.3 Commit the campaign-readiness slice config
    - New file `app/eval/sweep/sweep.config.tbslice.json` selecting at least 12 RTLLM problems spanning arithmetic, control, and memory, one arm, `sampleCount` 1
    - The slice is the artifact Requirement 9.6 is measured and cited against; it must not be `accu` plus two neighbours
    - Verify: `npx tsc -b && npx eslint app --max-warnings=0 && npx prettier --check . && npx vitest run`
    - _Requirements: 9.7_

  - [x]* 9.4 Identity and slice pinning tests
    - In `app/eval/sweep/manifest.test.ts`
    - **Property 16: A prompt change changes the experiment identity**
    - Unit: the manifest's recorded prompt version and the identity's embedded version agree for any config
    - Unit: move `SMOKE_RUN_CONFIG_HASH` to its new value with the reason recorded in the test, and pin the parsed shape and hash of the slice config
    - Verify: `npx vitest run app/eval/sweep/manifest.test.ts` then the full gate
    - _Requirements: 9.7, 11.2, 11.3, 11.4, 11.5_

- [x] 10. Final checkpoint - all three tracks merged
  - Ensure all tests pass, ask the user if questions arise.
  - Confirm `npx tsc -b`, `npx eslint app --max-warnings=0`, `npx prettier --check .` are clean and `npx vitest run` reports >= 1531 passed with exactly 6 skipped.
  - Only after this checkpoint may the campaign be run, because Track C moved the config hash and a campaign started earlier cannot pool with one started later.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Skipping 2.4 removes the metamorphic guard that the added golden metric relaxes nothing about the `Verified` label, and skipping 8.2 removes the only non-vacuous evidence that a coverage gap is closed; neither is a good trade for a citable number.
- Requirement 9.6 is a measurement, not a test. It is discharged by running `npm run eval:sweep` against the slice config from task 9.3, before and after task 7.1, and comparing the instrument-valid counts the two summaries report. It cannot be automated because it requires paid model calls.
- The vault notes this spec rests on are `decision-independent-golden-judge-and-vcs-icarus-gap`, `decision-instrument-invalid-samples-leave-the-pass-at-k-denominator`, `decision-instrument-validity-gate-is-zero-coverage-gaps-not-a-kill-rate`, `decision-mutant-denominator-is-valid-mutants-not-golden-detectable`, `decision-golden-timeout-is-a-kill-and-mutants-get-their-own-wall-cap`, `decision-cost-per-verified-artifact-is-denominated-in-tokens-not-dollars`, and `gotcha-three-testbench-defect-classes-that-fail-the-reference-design`. None of their decisions is re-derived here.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1", "5.1", "7.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.5", "4.2", "4.3", "5.2", "7.2", "7.3"] },
    { "id": 2, "tasks": ["1.4", "1.6", "2.1", "4.4", "5.3", "8.1"] },
    { "id": 3, "tasks": ["2.2", "5.4", "5.5", "8.2"] },
    { "id": 4, "tasks": ["2.3", "5.6", "5.7", "9.1"] },
    { "id": 5, "tasks": ["2.4", "5.8", "9.2", "9.3"] },
    { "id": 6, "tasks": ["9.4"] }
  ]
}
```
