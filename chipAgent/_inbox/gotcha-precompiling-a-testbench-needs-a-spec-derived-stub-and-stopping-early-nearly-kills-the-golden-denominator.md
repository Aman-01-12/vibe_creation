---
type: gotcha
title: Pre-compiling a generated testbench needs a Spec-derived STUB, and stopping the loop early nearly kills the golden denominator
status: candidate
provenance: measured by hand against the 12 committed tbslice-v1 testbench artifacts with real iverilog 13.0, plus a code trace of candidateRtlOf/setup-failed while writing .kiro/specs/instrument-precheck-and-attribution
tags:
  [
    eval,
    testbench,
    precompile,
    iverilog,
    instrument-validity,
    golden-judge,
    denominator,
    verification-loop,
    artifact-sink,
    results-log,
    observability,
    measured,
  ]
timestamp: 2026-09-21T00:00:00Z
verifiedBy:
---

# 1. `iverilog` on the testbench ALONE rejects a clean testbench

The obvious pre-compile gate - "run the generated testbench through `iverilog -t null` and require exit 0" -
would refuse 10 of 12 sound testbenches. Elaboration cannot resolve the DUT instance:

```
iverilog -t null .../rtllm_arithmetic_adder_16bit/sample-0/testbench.v
  error: Unknown module type: adder_16bit          <- a CLEAN testbench
  *** These modules were missing: adder_16bit referenced 1 times.

iverilog -t null .../rtllm_arithmetic_adder_8bit/sample-0/testbench.v
  testbench.v:49: syntax error                     <- the real defect
  testbench.v:49: error: Malformed statement
```

Note `iverilog` exits **0** in both cases when `-o /dev/null` is used, so the exit code is not the signal
either. Only the presence of a parse-stage diagnostic separates them, and matching on diagnostic text is
brittle.

## The fix that works, measured

Compile the testbench against a **stub module derived from the Spec's declared `moduleInterface`** -
ports and widths, no behaviour:

```
stub.v + adder_16bit testbench          -> exit 0
stub.v with port `Co` removed + same tb -> exit 1
   error: port ``Co'' is not a port of uut.
```

So the stub gate is both sound (clean testbenches pass) and strictly stronger than a syntax check: it also
catches the interface-mismatch class (`TESTBENCH_REFERENCE_UNBUILDABLE`, 3 of 11 on tbslice-v1) before any
candidate RTL exists.

`app/agent/roles/generation/candidate-compiler.ts#buildCompileHarness` is the exact MIRROR of this and
already exists - it derives a testbench stand-in from the Spec so the candidate can be compiled. Reuse its
shape, and reuse `expectedInterfacePorts` so the clocking ports the Spec declares separately are present;
a stub missing `clk` would refuse every testbench that connects one.

## Two traps in the stub gate

- The stub emits no `$dumpfile`, and `SIMULATE_REQUIRED_OUTPUTS` makes the VCD required, so a testbench
  that omits `$dumpvars` yields `verdict: error` with NO build failure. That must NOT read as a refusal.
  It needs its own cause (`output-incomplete`), distinct from a compile failure.
- Refuse only when the diagnostic names the TESTBENCH. If it names the stub, our own stub is the suspect.

# 2. Stopping the loop early nearly destroyed the golden denominator

`candidateRtlOf` (`app/eval/artifact-sink.ts`) returns `null` for `setup-failed`, and the Golden_Judge reads
the candidate through that SAME function. So making a refused sample return `setup-failed` would have
surrendered no candidate at all: on tbslice-v1 the golden denominator would have collapsed from **10 to 3**.

The saving is meant to be in the ITERATIONS, not in the evidence. A new terminal outcome that carries the
candidate and the testbench is therefore not a nicety - it is the only shape that keeps the capability
number alive. Anything that stops the loop sooner must be checked against `candidateRtlOf` first.

A second-order consequence worth stating: a refused sample's candidate is judged as a FIRST candidate with
no repair iteration, so golden pass@k after such a change is measured on a different flow and is not
comparable to a prior run's. That is a real cost, not a schema artifact.

# 3. The `unchecked` reason is not persisted, so all reasons read back as one

`instrumentVerdictOf` in `app/eval/sweep/results-log.ts`:

```ts
return { validity: 'unchecked', reason: 'control-unavailable' };
```

`SweepSampleRecord` carries `instrumentValidity` and `instrumentDefect` and no unchecked reason, so every
`unchecked` record reads back as `control-unavailable` whatever actually happened. Confirmed on the real
file: all 3 `unchecked` samples in `.eval-runs/tbslice-v1/results.jsonl` were `no-testbench` and none can
be told apart in the summary.

This is load-bearing the moment a NEW unchecked reason is added (e.g. a resource-bound kill): the new
reason would be indistinguishable from the old one in every persisted record, so the reason must be
persisted in the same change that introduces it.

# 4. Three smaller facts confirmed in the same pass

- `SandboxResult` already carries `timedOut`, `diskLimitExceeded`, and `stdoutTruncated`; `SimulationVerdict`
  drops all three. Threading them through is the upgrade path
  [[gotcha-simulation-verdict-collapses-error-causes]] itself prescribed, and the trigger it named
  ("if exact classification becomes load-bearing") has now fired.
- Workspace filenames are derived from the trusted Spec module name (`${moduleName}.v`, `${moduleName}_tb.v`
  in `verification-loop.ts#toTestbenchFile`), never from model output. That is what makes attribution by
  filename sound: the result is a FILTER of paths we submitted, not an extraction from untrusted text.
- The testbench is generated exactly once, in `VerificationLoop.#setup`, and never regenerated; the loop
  only repairs RTL. So "which testbench is under control" has one answer, and an early control check can
  never be validating a testbench that later changes.
- `VerificationOutcome` is named only in `app/agent/orchestrator`, `app/agent/roles/iteration`, and
  `app/eval`. No `app/web` module reads it, so widening that union does not reach the Display_Layer.

# Links

- `.kiro/specs/instrument-precheck-and-attribution/` (the spec this measurement produced)
- [[gotcha-tbslice-v1-testbench-generator-is-the-bottleneck-1-of-12]] (the campaign this diagnoses)
- [[gotcha-simulation-verdict-collapses-error-causes]] (the collapse this closes)
- [[gotcha-workspace-disk-cap-enforced-and-workspace-leak-closed]] (the `diskLimitExceeded` flag, and the
  arbitrary-must-generate-a-new-required-field trap that recurs here)
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]] (the denominator invariant left
  unchanged)
- `app/agent/roles/generation/candidate-compiler.ts` (`buildCompileHarness`, the mirror to reuse)
