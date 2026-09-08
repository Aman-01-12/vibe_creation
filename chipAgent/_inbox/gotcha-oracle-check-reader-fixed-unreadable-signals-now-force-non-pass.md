---
type: gotcha
title: Oracle check reader FIXED - trailing diagnostics are read, unreadable CHECK lines force non-pass, and the loop now refuses a pass on incomplete evidence
status: candidate
provenance: severity-1 repair of the defect recorded in gotcha-a-check-fail-line-with-trailing-diagnostics-is-silently-discarded; re-measured with smoke-v4-oracle (kimi-k2_5, the three RTLLM smoke problems, real paid calls) plus a deterministic replay of the persisted smoke-v3 artifact through the rebuilt reader
tags:
  [
    oracle,
    testbench,
    signalling,
    verdict,
    fail-safe,
    false-positive,
    instrument-validity,
    eval,
    honesty,
    severity-1,
  ]
timestamp: 2026-09-06
---

# What happened

The defect in [[gotcha-a-check-fail-line-with-trailing-diagnostics-is-silently-discarded]] is repaired.
Three separate holes were closed, and the third was not in the original diagnosis.

Reproduction and fix, deterministic, against the artifact that actually caused it
(`.eval-runs/smoke-v3-tbfix/.../control-stdout.txt`, now pinned as a test fixture):

```
raw FAIL lines present in stdout : 1
OLD reader parsed               : 10 | failing: 0   -> verdict pass
NEW reader parsed               : 11 | failing: 1   -> verdict fail
```

# Root cause

Three defects, in the order they matter.

1. **Anchored grammar.** `/^CHECK[ \t]+(\S+)[ \t]+(PASS|FAIL)$/` matched nothing when the testbench appended its reason to the status line, which is the natural thing to write.
2. **Silent discard.** A line that began with the `CHECK` keyword but yielded no `(name, status)` pair was dropped as banner text. That is what turned defect 1 into a FALSE PASS: remove the unreadable FAIL and the surviving lines are all passes, so `classifyVerdict` saw a clean run.
3. **The oracle never knew what it was owed.** `interpretSandboxResult` / `classifyVerdict` had no notion of a required check set. Coverage was enforced only STATICALLY at generation time, by `sourceEmitsCheck` over the testbench source. So a testbench whose `CHECK` line existed in the source but never executed at run time reported nothing for that check, and the run read as a full pass. A name outside the required set was likewise never validated.

Duplicate names were already safe and were only undocumented: `allSpecChecksPassed` quantifies over every OCCURRENCE (`checks.every`), never over distinct names, and no code anywhere reduces checks by name. So one `FAIL` for a name defeats any number of `PASS`es for it. There is no last-wins, majority, or de-duplication step that a later `FAIL` could be voted down by. This is now stated at the rule and pinned by the real 10-PASS-then-1-FAIL sequence.

# Fix / rule

Grammar, `app/tools/simulator/check-signalling.ts`:

```
before  /^CHECK[ \t]+(\S+)[ \t]+(PASS|FAIL)$/
after   /^CHECK[ \t]+(\S+)[ \t]+(PASS|FAIL)(?![A-Za-z0-9_]).*$/
```

The status must be a complete WORD, not merely whitespace-delimited.
`PASSED`, `FAILURE`, `PASSes`, `FAIL_LATER` are rejected; `FAIL at cycle 0: ...` and `FAIL: Reset state incorrect` are read.
A first attempt required whitespace or end-of-line after the status, which is stricter - and wrong: the smoke-v4-oracle run contains a real generated testbench writing `CHECK <name> FAIL: Reset state incorrect`, and refusing that would downgrade a legible functional failure to an unreadable signal (`fail` says strictly more than `error`, and the instrument control would read `CONTROL_RUN_ERRORED` instead of `TESTBENCH_FAILED_REFERENCE`). Draw the boundary at the word, not at whitespace.

Linearity matters here because this parses model-authored output: `[ \t]+` and `\S+` are disjoint, the boundary is a one-character lookahead, and the trailing `.*` runs to end-of-line with nothing after it. A 40k-line adversarial input is pinned to read in under a second.

Verdict rule, `app/core/verdict/index.ts`. `InvocationOutcome` gained a required `unreadableCheckSignals: number` (a COUNT, never the offending text, so it cannot carry a path into a verdict). Precedence:

```
before  timeout | toolFailure | !completed | 0 checks -> error ; all passed -> pass ; else fail
after   timeout | toolFailure | !completed | 0 readable checks -> error
        any readable check failed                             -> fail
        any UNREADABLE check signal                           -> error
        else                                                  -> pass
```

`fail` deliberately outranks the unreadable rule: both are non-pass, and a definite failing check is the stronger, more actionable fact. `pass` is now reachable only when the run's ENTIRE check signalling was readable.

Required-set rule, `app/agent/orchestrator/verification-loop.ts`. The reader CANNOT be the enforcement boundary for this one - it reads stdout and has no way to know what the run was owed. The loop is the nearest boundary that holds both facts, and it is also the only place that mints `Verified`. It now keeps `TestbenchGenerated.checks` from setup and, before accepting a `pass`, requires `missingCheckNames(simulation.checks, requiredNames)` to be empty; otherwise it fails closed to `Unverified` through the same shape as the existing unbindable-provenance refusal (`#refusePass`). It does not rewrite the oracle verdict - `simulation.verdict` still reports what the oracle saw. An unknown name cannot create a pass once this holds, because a pass requires every required name present and passing; an unknown name that FAILs still fails the run.

Known remaining gap, deliberately not plumbed: `RtllmInstrumentControl` produces `valid` from a `pass` without a required set, because `InstrumentControlRequest` does not carry one and neither does `VerificationOutcome`. So a testbench that reports only SOME of its checks against the reference still reads `valid`. That under-reports instrument-invalid; it cannot manufacture a `Verified`.

The prompt (`app/agent/roles/testbench/prompt.ts`) was updated to restate what the reader guarantees, so the two cannot disagree. It is belt and braces only - the reader is the guarantee.

# Re-measured, honestly

`npx tsc -b`, `npx eslint app --max-warnings=0`, `npx prettier --check .` all clean. `npx vitest run`: 1239 passed / 6 skipped, up from the 1206 / 6 baseline (33 new tests, the same 6 environmental skips: 5 gVisor, 1 netlistsvg).

smoke-v4-oracle, verbatim:

```
eval sweep summary  (config ba4e2281777a6352)
samples aggregated: 3
arm kimi-k2_5  [moonshotai.kimi-k2.5]
  samples:         3 over 3 problems
  pass@1=1.000  (over 2 instrument-valid sample(s))
  verified:        2  first-try 1 (0.333)  repaired 1 (0.333)
  mean iters/pass: 2.00
  cost:            UNKNOWN (at least one model in this arm has no configured price;
                   set prices.<modelId> in the config to measure spend and CPVA)
  golden judge:    1/2 agree (rate 0.500)
  MISSED BUGS:     1 (our testbench passed, golden failed)
  over-strict:     0 (our testbench failed, golden passed)
  instrument:      2/3 testbenches pass their reference design
  instrument-invalid: 1  <== OUR TESTBENCH REJECTS THE REFERENCE; excluded from pass@k
                   of these: rejected-reference 1  did-not-build 0  no-verdict 0
  statuses:        unverified=1 verified=2
```

The tree was DIRTY, so the sweep's own warning applies: these numbers are diagnostic, not citable.

What this run does and does not establish:

- **It does not exercise the fixed path.** No testbench in smoke-v4 emitted a trailing-diagnostic status line and no run produced an unreadable signal (0 and 0 across all six captured stdouts). The models happened to put diagnostics on their own lines this time. The evidence the fix works is the deterministic replay of the smoke-v3 artifact and the pinned tests, NOT this sweep.
- `right_shifter` came back `INSTRUMENT-INVALID(TESTBENCH_FAILED_REFERENCE)` - the exact class the old reader masked as `instrument=valid` + `verified` - but via a WELL-FORMED `CHECK ... FAIL` line, so the old reader would have caught this one too. `instrument-invalid` did not rise because of the fix in this run.
- The delimiter refinement landed AFTER the sweep binary was built. Replaying all six persisted stdouts through the rebuilt reader gives byte-identical readings and the same verdicts, so the refinement is provably inert on these three samples and the summary still describes the current code. It was not re-paid for.
- **A NEW defect class showed up, unrelated to this fix**: `multi_pipe_8bit` is `verified` while the golden judge FAILS it (the 1 missed bug). Its own testbench printed ~14 `Time N: ... mismatch, expected X, got Y` lines and then signalled `CHECK <name> PASS`. The monitor at `testbench.v:344/348` prints mismatches as prose and never feeds an error flag into the CHECK status. No reader fix can catch that - the signal itself says PASS. See the follow-up below.
- pass@1 = 1.000 over 2 samples is not a result. One of the two is a missed bug, so the honest reading is "1 of 3 samples had a usable instrument that also agreed with the independent judge".

Nothing was tuned against these three problems.

# Follow-up

- New class to write up and repair: a testbench that DETECTS a mismatch, prints it as prose, and still signals `PASS`. The generation-side rule wants to be "any mismatch your monitor detects must set a flag that the CHECK status reads", and the deterministic side of it may be checkable from the source (a `$display` of a mismatch with no corresponding error flag).
- Plumb a required-check set into `InstrumentControlRequest` so the positive control gets the same completeness rule the loop now has.

# Links

- [[gotcha-a-check-fail-line-with-trailing-diagnostics-is-silently-discarded]] (the defect this repairs)
- [[gotcha-check-signal-stdout-not-source]]
- [[gotcha-generated-testbench-assumes-a-reset-that-does-not-exist]]
- [[gotcha-simulation-verdict-collapses-error-causes]]
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]]
- app/tools/simulator/check-signalling.ts (`CHECK_LINE_PATTERN`, `CHECK_KEYWORD_PATTERN`, `readCheckSignals`)
- app/core/verdict/index.ts (`classifyVerdict` precedence, `allSpecChecksPassed`, `missingCheckNames`)
- app/agent/orchestrator/verification-loop.ts (`#incompleteEvidence`, `#refusePass`)
- app/test/oracle-check-signalling.test.ts + app/test/fixtures/smoke-v3-tbfix/right-shifter-control-stdout.txt (the real artifact)
- .eval-runs/smoke-v4-oracle/ (summary.txt, results.jsonl, per-sample artifacts)
