---
type: verification-recipe
title: Per-check pass/fail signalling (CHECK <name> PASS|FAIL)
tags: [verification, testbench, oracle, signalling, icarus]
status: trusted
provenance: authored from app/tools/simulator/check-signalling.ts, the deterministic oracle's per-check parser
timestamp: 2026-07-05T00:00:00Z
verifiedBy: app/tools/simulator/check-signalling.ts (parser) and app/test/icarus-oracle.integration.test.ts (real iverilog + vvp oracle-path)
---

# What this verifies

This recipe defines the exact line format a spec-derived testbench must print so the Simulator adapter can turn a completed run into a per-check pass/fail signal.
It is the contract between the Testbench_Agent (task 13.3) and the oracle reader.

This is authority, not a hint: the ground truth is the deterministic parser in `app/tools/simulator/check-signalling.ts`, exercised end to end by the real `iverilog` + `vvp` oracle-path integration test.
A testbench that follows any other convention will not be read by the oracle, so its checks verify nothing.

# Independent oracle (never the model)

The simulation run does not decide the verdict.
The testbench emits one machine-readable line per spec-derived check, and the adapter parses those lines into the core `CheckResult[]` that the verdict rules consume.
Correctness is decided by the deterministic parser plus the pass-integrity rule, never by model output.

# The signalling contract

For every acceptance-criterion check it exercises, the generated testbench prints exactly one line to standard output of one of these two shapes:

```
CHECK <name> PASS
CHECK <name> FAIL
```

Rules the oracle enforces (matched against the trimmed line by the pattern `^CHECK[ \t]+(\S+)[ \t]+(PASS|FAIL)$`):

- `CHECK` is a literal, uppercase keyword that anchors the line.
- `<name>` is a single whitespace-free token naming the check (for example `reset_clears_output`), traceable back to a Spec acceptance criterion.
  A whitespace-free token keeps the line unambiguously parseable.
- The status is the literal `PASS` or `FAIL`, uppercase.
- Tokens are separated by one or more spaces or tabs.
- Leading and trailing whitespace on the line is ignored, because the line is trimmed before matching.
- Any line that does not match this exact shape is ignored, so banner text, `$display` diagnostics, and waveform notes can be printed alongside the machine signal without confusing the oracle.

# Steps

1. For each acceptance criterion, compute the expected value independently from the Spec (never from the RTL under test).
2. Drive the stimulus, sample the DUT output, and compare against the independent expected value.
3. Print exactly one `CHECK <name> PASS` or `CHECK <name> FAIL` line for that criterion, using a stable whitespace-free name.
4. After every check line has been emitted, finish the simulation normally with `$finish`.

Minimal shape (Verilog):

```verilog
if (dut_out === expected_out)
  $display("CHECK reset_clears_output PASS");
else
  $display("CHECK reset_clears_output FAIL");
```

# Fail-safe and pass-integrity rules

- A run that prints no parseable `CHECK` line verified nothing and is classified `error` by the adapter, never a silent pass.
- Duplicate check names are preserved in order, so a check reported both `PASS` and `FAIL` still fails pass integrity.
- A `pass` verdict requires every spec-derived check to pass; a merely completed or partially passing run is never `pass`.

# Anti-circularity note

The expected values in each check come from the Spec and intent only.
The testbench that emits these lines is generated without ever seeing the RTL under test (Req 7.2), so a passing `CHECK` line cannot silently agree with a bug in the implementation.

# Links

- Oracle parser: `app/tools/simulator/check-signalling.ts`
- Verdict and pass-integrity rules: `app/core/verdict`
- Self-checking testbench structure: [[self-checking-testbench]]
- Boundary and known-answer checks: [[boundary-and-known-answer-checks]]
