---
type: verification-recipe
title: Per-check pass/fail signalling (CHECK <name> PASS|FAIL)
tags: [verification, testbench, oracle, signalling, icarus]
status: trusted
provenance: authored from app/tools/simulator/check-signalling.ts, the deterministic oracle's per-check parser, and app/tools/simulator/simulation-harness.ts, which owns the reporting task
timestamp: 2026-07-05T00:00:00Z
verifiedBy: app/tools/simulator/check-signalling.ts (parser) and app/test/icarus-oracle.integration.test.ts (real iverilog + vvp oracle-path); the reporting task by app/test/simulation-harness.integration.test.ts
---

# What this verifies

This recipe defines how a spec-derived testbench reports each check, and the exact line format that reaches standard output, so the Simulator adapter can turn a completed run into a per-check pass/fail signal.
It is the contract between the Testbench_Agent (task 13.3) and the oracle reader.

This is authority, not a hint: the ground truth is the deterministic parser in `app/tools/simulator/check-signalling.ts`, exercised end to end by the real `iverilog` + `vvp` oracle-path integration test.
A testbench that follows any other convention will not be read by the oracle, so its checks verify nothing.

# Independent oracle (never the model)

The simulation run does not decide the verdict.
The testbench reports one check at a time and the harness prints one machine-readable line for each, which the adapter parses into the core `CheckResult[]` that the verdict rules consume.
Correctness is decided by the deterministic parser plus the pass-integrity rule, never by model output.

# The signalling contract

Every completed run compiles against the product-written Simulation_Harness, which owns the reporting task, `dump.vcd`, and the Watchdog.
For every acceptance-criterion check it exercises, the generated testbench calls that task exactly once, as a statement:

```verilog
ece_simulation_harness.ece_check("<name>", <expected>, <actual>);
```

The three arguments are, in this order, the exact check name as a string literal, the value the Spec says to expect, and the value the design actually produced.
Pass both values at the moment you compare them: the expectation alone makes a failure unactionable, and the observed value is what a student reads.
The task does the comparison with `===` and prints the line, so a `$display` that prints a `FAIL` line of your own is not a substitute for the call.

The task prints exactly one line to standard output, of one of these two shapes:

```
CHECK <name> PASS
CHECK <name> FAIL: expected <expected>, got <actual>
```

That line grammar is what the oracle parses, so it is also the contract for a testbench the product writes itself (the scoreboard scaffold prints these lines directly).
A failure line may carry any human-readable diagnostic after the status word:

```
CHECK <name> FAIL at cycle 0: expected 10000000, got 11101011
CHECK <name> FAIL: reset state incorrect
```

Rules the oracle enforces (matched against the trimmed line by the pattern `^CHECK[ \t]+(\S+)[ \t]+(PASS|FAIL)(?![A-Za-z0-9_]).*$`):

- `CHECK` is a literal, uppercase keyword that anchors the line.
- `<name>` is a single whitespace-free token naming the check (for example `reset_clears_output`), traceable back to a Spec acceptance criterion.
  A whitespace-free token keeps the line unambiguously parseable.
- The status is the literal `PASS` or `FAIL`, uppercase, and must be a complete word: `PASSED` and `FAILURE` are not a status, so a status can never be read out of the prefix of a longer word.
- Anything after the status word is a diagnostic and is ignored, whether it is separated by whitespace (`FAIL at cycle 0: ...`) or attached directly (`FAIL: reset state incorrect`).
- Tokens are separated by one or more spaces or tabs.
- Leading and trailing whitespace on the line is ignored, because the line is trimmed before matching.
- A line that does not begin with `CHECK` as a complete token is not a signal at all and is ignored, so banner text, `$display` diagnostics, waveform notes, and unrelated output such as `CHECKSUM 5` can be printed alongside the machine signal without confusing the oracle.
- A line that does begin with the `CHECK` keyword but yields no `(name, status)` pair is NOT ignored: it means the testbench tried to signal something unreadable, so it is counted and forces a non-passing verdict.
  Silently discarding such a line was the root cause of a severity-1 defect in which a legible failure was dropped and the remaining passes were reported as a pass.

# Steps

1. For each acceptance criterion, compute the expected value independently from the Spec (never from the RTL under test).
2. Drive the stimulus, sample the DUT output, and compare against the independent expected value.
3. Call the harness reporting task once for that criterion, with a stable whitespace-free name and both values.
4. After every check has been reported, finish the simulation normally with `$finish`.

Minimal shape (Verilog):

```verilog
ece_simulation_harness.ece_check("reset_clears_output", expected_out, dut_out);
```

# Fail-safe and pass-integrity rules

- A run that prints no parseable `CHECK` line verified nothing and is classified `error` by the adapter, never a silent pass.
- An unreadable `CHECK`-like line, or stdout the reader had to truncate, is an evidence failure and also yields `error`: a `pass` is reachable only when the run's whole check signalling was both readable and complete.
- A spec-derived check that never appears in the output is missing evidence, not an absent problem, so the Verification_Loop refuses a pass for it. Report every criterion, including ones you believe cannot fail.
- If the harness Watchdog ends the run first, every check that had not yet been reported counts as timed out rather than as absent, and the run cannot pass. The Watchdog is a liveness bound in simulated time, so do not write a second one into the testbench.
- Duplicate check names are preserved in order, so a check reported both `PASS` and `FAIL` still fails pass integrity.
- A `pass` verdict requires every spec-derived check to pass; a merely completed or partially passing run is never `pass`.

# Anti-circularity note

The expected values in each check come from the Spec and intent only.
The testbench that reports these checks is generated without ever seeing the RTL under test (Req 7.2), so a passing `CHECK` line cannot silently agree with a bug in the implementation.

# Links

- Oracle parser: `app/tools/simulator/check-signalling.ts`
- Reporting task, dump ownership, and the Watchdog: `app/tools/simulator/simulation-harness.ts`
- Verdict and pass-integrity rules: `app/core/verdict`
- Self-checking testbench structure: [[self-checking-testbench]]
- Boundary and known-answer checks: [[boundary-and-known-answer-checks]]
