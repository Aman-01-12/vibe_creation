---
type: decision
title: A golden TIMEOUT is a KILL, and mutant runs get their own small wall cap
status: candidate
provenance: founder-directed correctness + wall-clock fix; implemented in app/eval/corpus/mutation-calibration.ts + app/eval/mutation-control.ts + app/tools/sandbox, measured on the real Icarus toolchain
tags:
  [
    eval,
    negative-control,
    mutation-testing,
    calibration,
    timeout,
    sandbox,
    wall-clock,
    gate,
    schema-version,
    honesty,
  ]
timestamp: 2026-09-20
---

# Two coupled fixes, one measurement

Timing golden calibration on `rtllm/arithmetic/multi_pipe_8bit` at `limits.wallMs = 30000` showed
both problems in one table (first 8 of 24 mutants):

```
   237ms  failed    ARITH_PLUS_TO_MINUS@69:29
   181ms  passed    ARITH_MINUS_TO_PLUS@17:15
 30005ms  error     CONDITION_NEGATED@26:10      <-- the full 30s wall cap
   178ms  passed    RESET_BRANCH_DISABLED@26:10
   137ms  passed    CONST_ZERO_TO_ONE@27:33
   189ms  passed    CONST_INCREMENTED@2:22
   138ms  passed    INDEX_OFF_BY_ONE@17:16
   138ms  failed    ARITH_PLUS_TO_MINUS@70:29
```

A real mutant run costs 137-237ms; a HANGING one costs the whole cap. The hangs are structural,
not rare: RTLLM golden testbenches commonly spin on a design signal (`while (mul_en_out == 0)`),
so any mutant that breaks that signal never reaches `$finish`.

# Fix 1 - mutant runs get their own wall cap

`negativeControl.mutantWallMs`, default `DEFAULT_MUTANT_WALL_MS = 5000` (bounds 500-60000,
validated at the config boundary). It replaces ONLY `wallMs`; cpu, memMb, procs, and diskMb stay
the student session's, because the mutant runs on the same rails as the oracle - the single owner
of that substitution is `mutantRunLimits`, called by both mutant paths.

5000ms is ~20x the observed worst real run and 6x cheaper than 30s on a hang.

The CALIBRATOR owns the knob and exposes it (`RtllmMutationCalibrator.mutantWallMs`); the negative
control READS it rather than holding a copy. A second copy could drift and leave the independent
judge and our own testbench answering "does this mutant hang?" on two different clocks.

It is IN the config identity (`SMOKE_RUN_CONFIG_HASH` `f9945ed9de495525` -> `552626a05719c93c`)
because it can change which mutants classify as hanging -> which are golden kills -> the GATE set
-> instrument validity -> the pass@k denominator.

# Fix 2 - a golden timeout is a KILL, not a non-compiling mutant

`CONDITION_NEGATED@26:10` COMPILED - it had to, to run for 30 seconds - and then hung. It used to
classify `non-compiling`, which was wrong three times over: mislabelled, out of the kill-rate
denominator, and out of the GATE set, so our testbench was never required to catch a defect that
demonstrably changes observable behaviour. It is now `golden-timeout`: a VALID mutant and a golden
KILL. The gate set GREW, which is intended and is not compensated for anywhere.

Justification: Stryker's mutant states count an infinite-loop mutant as detected, and this repo
ALREADY applies that rule to OUR testbench via `MutantKillKind: 'no-verdict'`. Calibration reading
the same evidence differently would be two rules for one fact.

## THE EXIT CODE DOES NOT SURVIVE - read this before trying to use 124

The worker's `COMMAND_TIMEOUT_EXIT = 124` never reaches the seam on either real runtime.
`LocalWorkerRuntime` and `RunscSandboxRuntime` both arm a kill timer at `spec.limits.wallMs` and
SIGKILL the child, then return `infraCapture(true)`: `exitCode: null`, `stdout: null`,
`stderr: null`, `resourceUsage` zeroed. The worker's own per-command timeout is also `wall_ms` but
starts AFTER compile, so the TS kill always wins. Every residual-field heuristic is therefore
guessing at nothing - including the `wallMs >= limits.wallMs` heuristic recorded in
[[gotcha-simulation-verdict-collapses-error-causes]], which cannot work here because
`infraCapture` zeroes usage.

So the fact was THREADED, exactly as that note prescribes for when the distinction becomes
load-bearing: `RawRunCapture.timedOut` -> `SandboxResult.timedOut` (new required field, in the
canonical cross-language schema beside `verdict`, which is also TS-classified and also not
produced by the worker) -> `GoldenScore.timedOut`. `SimulationVerdict` was deliberately NOT
widened: only the golden path needs the discriminator, and our own probe already treats `error` as
a kill.

## Five calibration states, because there are five causes

`calibrationOf` is the single owner:

| golden run                          | state             | in denominator | in gate set |
| ----------------------------------- | ----------------- | -------------- | ----------- |
| reported a failure                  | `golden-killed`   | yes            | yes         |
| did not terminate (`timedOut`)      | `golden-timeout`  | yes            | yes         |
| passed                              | `golden-survived` | yes            | no          |
| no verdict + wrote diagnostics      | `non-compiling`   | no (counted)   | no          |
| no verdict, no diagnostics, no hang | `golden-errored`  | no (counted)   | no          |

The build-failure-versus-nothing split reuses `classifyNonPass`, so that rule keeps one owner
shared with Stage 0 and the positive control. `golden-timeout` is kept apart from `golden-killed`
for the same reason `no-verdict` is kept apart from `reported-failure`: a hang is weaker evidence,
and a corpus whose judge mostly HANGS must not read as one that mostly DETECTS. `golden-errored`
is kept apart from `non-compiling` because calling a crash a build failure attributes our own
infrastructure fault to the corpus.

`mutantIsValid` and `mutantWasGoldenKilled` are total `Record` lookups, so a sixth state is a
compile error rather than a silent default in either direction.

# MEASURED, on the real toolchain, 24 mutants, `rtllm/arithmetic/multi_pipe_8bit`

| mutantWallMs | wall clock  | classification                                       |
| ------------ | ----------- | ---------------------------------------------------- |
| 5000 (new)   | **10652ms** | 8 killed, 1 timeout, 15 survived, 0 non-compiling, 0 errored |
| 30000 (old)  | 35668ms     | identical                                            |

Two facts worth keeping:

1. 3.35x faster on ONE problem, and the saving is per-hang, so it scales with the corpus.
2. The classification is IDENTICAL at both caps. The 5000ms cap does NOT manufacture timeouts
   here - the only hang hangs forever and no real run comes near 5s. That is the evidence the
   default is safe, and it is the check to repeat if the default is ever lowered.

The gate set on this problem went 8 -> 9 golden kills. `CONDITION_NEGATED@26:10` is now something
our testbench is required to catch.

# Schema / cache version decisions (each stated, each a refusal)

- `MUTATION_CALIBRATION_CACHE_VERSION` 2 -> 3. REQUIRED: the verdict vocabulary changed, and a v2
  `non-compiling` means "one of timeout / build failure / crash happened and we did not record
  which". Serving one would put every hung mutant back outside the gate set. The cap also JOINED
  the cache key (`v3/<commit>/<configHash>/w<mutantWallMs>`), because a slow-but-terminating mutant
  is `golden-killed` under a wide cap and `golden-timeout` under a narrow one - the cap can change
  a verdict, which is the only test that key applies. The existing `.eval-cache/.../v2/` tree is
  now unreachable, deliberately.
- `RESULTS_SCHEMA_VERSION` 6 -> 7. REQUIRED: `instrumentValidity: valid` demands strictly MORE than
  it did, because the gated set grew, so a v6 `valid` can belong to a testbench v7 rejects. The
  `mutation` block also gained `goldenTimeoutCount` and `goldenErroredCount` while
  `nonCompilingCount` narrowed to genuine build failures; a v6 `nonCompilingCount` is the sum of
  three causes with no way to recover the split.
- `ARTIFACT_DOCUMENT_SCHEMA_VERSION` 5 -> 6. Same reasoning, same population change.
- `SMOKE_RUN_CONFIG_HASH` `f9945ed9de495525` -> `552626a05719c93c`. Adding `mutantWallMs` changes
  the canonical config JSON, and it belongs in the identity (see Fix 1).
- The sandbox contract schema gained a required `timedOut` on `SandboxResult`. The Python worker
  test that validates `worker report + verdict` against that subschema now supplies
  `timedOut: False` too, and says why: both are TS-side classification fields.

# Watch out

- `app/test/eval-negative-control.integration.test.ts` still excludes `CONDITION_NEGATED` from its
  6-mutant config, on purpose: that config pins a specific measured six-mutant story. The hang is
  covered by its own suite in the same file at the full 24-mutant budget. Do not "simplify" by
  merging them.
- `describeCalibration` now prints the hang share (`kills 9 (1 by HANGING ...)`) and the sweep
  summary prints a `golden hangs:` line. If either goes quiet, a hang-heavy gate starts reading as
  judge coverage again.
- A campaign whose `goldenTimeoutMutants` dominates has a wall-clock finding to explain BEFORE its
  coverage-gap numbers may be cited. Same discipline as `noVerdictKills`.

# Links

- app/eval/mutation-control.ts (`MutantCalibration`, `mutantIsValid`, `mutantWasGoldenKilled`, `mutantRunLimits`, `DEFAULT_MUTANT_WALL_MS`)
- app/eval/corpus/mutation-calibration.ts (`calibrationOf`, `renderCalibrationCacheKey`, `goldenTimeoutCountOf`)
- app/eval/corpus/rtllm-negative-control.ts (reads the cap from the calibrator)
- app/eval/sweep/config.ts + config-parse.ts (`mutantWallMs`, validated at the boundary)
- app/tools/sandbox/contract.ts + contract-schema.ts + classification.ts (`SandboxResult.timedOut`)
- app/eval/corpus/golden-scorer.ts (`GoldenScore.timedOut`)
- [[gotcha-simulation-verdict-collapses-error-causes]]
- [[gotcha-sandbox-result-collapses-error-causes]]
- [[decision-mutant-denominator-is-valid-mutants-not-golden-detectable]]
- [[decision-instrument-validity-gate-is-zero-coverage-gaps-not-a-kill-rate]]
- product-ece/ECE-VERIFICATION-METHODOLOGY.md
