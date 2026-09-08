---
type: gotcha
title: A CHECK FAIL line with trailing diagnostics is silently discarded, so a failing testbench reads as PASS
status: candidate
provenance: smoke-v3-tbfix sweep (kimi-k2_5, all three RTLLM smoke problems) after the Testbench_Agent state-anchoring prompt fix; masking reproduced deterministically against the persisted control-stdout.txt with the built parseCheckResults
tags:
  [
    testbench,
    signalling,
    oracle,
    instrument-validity,
    eval,
    pass-at-k,
    false-positive,
    honesty,
    prompt,
    defect-class,
  ]
timestamp: 2026-09-06
---

# What happened

The Testbench_Agent prompt gained a state-anchoring rule (`app/agent/roles/testbench/prompt.ts`), conditioned on whether `spec.moduleInterface.clocking` declares a reset, to kill the class in [[gotcha-generated-testbench-assumes-a-reset-that-does-not-exist]].
The positive control was then re-run end to end into a fresh output dir (`.eval-runs/smoke-v3-tbfix/`).

The summary looked like the class was gone for the design that exposed it:

```
[3/3] arm=kimi-k2_5 rtllm/memory/right_shifter #0 -> verified iters=1 golden=passed instrument=valid
  pass@1=1.000  (over 1 instrument-valid sample(s))
  instrument:      1/3 testbenches pass their reference design
  instrument-invalid: 2   of these: rejected-reference 1  did-not-build 1  no-verdict 0
```

It is not gone. `instrument=valid` for `right_shifter` is a FALSE POSITIVE, and the `verified` beside it is too.

The control's own persisted stdout for that sample contains a FAIL against RTLLM's human-verified reference:

```
CHECK ac1_under_simulation_right_shifter_produces PASS      (x10)
CHECK ac1_under_simulation_right_shifter_produces FAIL at cycle           0: expected 10000000, got 11101011
instrument_control_tb.v:146: $finish called at 116 (1s)
```

Fed back through the built oracle reader, deterministically:

```
raw FAIL lines present in stdout : 1
checks the oracle reader parsed  : 10
of those, failing                : 0
```

# Root cause

Two separate defects, and the second hides the first.

1. The state-anchoring rule did NOT prevent the re-anchor in this sample. The new testbench still writes `expected_q = 8'b0;` mid-simulation, under the comment `// Reset expected and run a full pattern`, on a module (`clk`, `d`, `q`) with no reset port - the exact prohibited move. `q` holds `11101011` at that boundary, so the reference fails at cycle 0. The earlier phases were rewritten to carry `expected_q` forward continuously, which is the rule being followed; the final summary phase re-anchored anyway.

2. `CHECK_LINE_PATTERN` in `app/tools/simulator/check-signalling.ts` is `/^CHECK[ \t]+(\S+)[ \t]+(PASS|FAIL)$/` - anchored at both ends. A testbench that appends its diagnostic to the same line (`... FAIL at cycle 0: expected ...`) produces a line that matches nothing and is dropped as banner text. The run then shows only the 10 PASS lines, `classifyVerdict` sees no failing check, and the verdict is `pass`.

The prompt does tell the model that diagnostics may be printed freely and that only CHECK lines are read - it does not say the status must be the END of the line. Appending the reason to the failure line is the natural thing to write, and it silently disarms the oracle.

Blast radius: this masks failures in the loop's oracle AND in the positive control, because both read stdout through the same parser. It can manufacture a false `Verified`, which is a prime-directive violation, not just a metrics wobble. It also means `instrument-invalid` under-reports: a broken instrument whose FAIL line carries a reason is recorded `valid` and stays IN the pass@k denominator.

# The other two samples (what the fix did not reach)

- `rtllm/arithmetic/multi_pipe_8bit` -> `TESTBENCH_REFERENCE_UNBUILDABLE`. Plain Verilog syntax error, not a state defect: `apply_input(i[7:0], (i+1)[7:0], 1'b1);` - a bit-select on an expression is illegal. `instrument_control_tb.v:237: Syntax error in task arguments.` The same error appears in `simulator-stderr.txt`, so the testbench never compiled against the candidate either, and the loop still spent all 6 iterations repairing RTL for a compile error whose cause was the testbench. Cause attribution for a compile failure is worth its own look.
- `rtllm/control/fsm` -> `TESTBENCH_FAILED_REFERENCE` at line 177, Test Case 9. This IS a phase-boundary expectation defect, but the mis-carried variant, not the assumed-zero variant: after Test Case 8 ends with `1,0,0,1,1`, Test Case 9 drives `0,0,1` and asserts `MATCH == 1` claiming "First 10011 ends here", when the actual 5-bit window is `11001`. This module HAS a reset (`RST`) it could have re-anchored to and did not. The candidate fails the same testbench earlier (line 125, Test Case 5), so the two verdicts are not even the same disagreement.

# Fix / rule

Nothing was tuned against these three problems on purpose - three problems is a data point, not a rate, and tuning here would corrupt the measurement. Recorded, not repaired:

- The signalling grammar is the higher-priority repair, and it is NOT a prompt problem. Either relax the reader to `^CHECK\s+(\S+)\s+(PASS|FAIL)\b` (status must be a whole token, trailing text allowed) or state in the prompt that the CHECK line must contain nothing after the status and diagnostics go on their own line. Prefer the reader: it fails safe against every model that has not read the rule, whereas a prompt sentence is advice a model may ignore. Whichever is chosen, pin it with the real artifact - `.eval-runs/smoke-v3-tbfix/artifacts/kimi-k2_5/rtllm_memory_right_shifter/sample-0/control-stdout.txt` is the stdout that actually fooled the parser.
- Until that lands, `instrument: N/3` is an UPPER bound on instrument soundness, and any `verified` whose stdout carries an unparseable FAIL line is unproven. Do not cite smoke-v3 numbers.
- The state-anchoring rule is not falsified by one sample, but it is not confirmed either. Its real test needs a run where the FAIL lines are actually parsed.

Also note: the sweep printed `WARNING: the harness working tree was DIRTY, so the recorded commit does not describe the code that produced these numbers`, which is correct and expected for an uncommitted prompt change - the numbers above are diagnostic, not citable.

# Links

- app/agent/roles/testbench/prompt.ts (`describeStateAnchoring`, `describeReset`, the reset-conditional rule)
- app/tools/simulator/check-signalling.ts (`CHECK_LINE_PATTERN`, the anchored grammar that drops the FAIL)
- app/tools/simulator/adapter.ts (`interpretSandboxResult` - no parseable failing check means `pass`)
- app/test/testbench-agent.test.ts (reset-free / reset-port / active-low anchoring cases)
- app/test/testbench-rtl-isolation.property.test.ts (Property 4 plus the anchoring-matches-interface non-vacuity check)
- .eval-runs/smoke-v3-tbfix/artifacts/kimi-k2_5/ (control-stdout.txt, control-stderr.txt, testbench.v per sample)
- [[gotcha-generated-testbench-assumes-a-reset-that-does-not-exist]]
- [[gotcha-check-signal-stdout-not-source]]
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]]
