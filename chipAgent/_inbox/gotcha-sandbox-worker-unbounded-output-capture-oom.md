---
type: gotcha
title: The sandbox worker buffered a child's ENTIRE stdout in memory - a runaway $display loop cost 654 MB per run, and truncating it now forces a non-pass
status: candidate
provenance: measured reproduction on this machine against real iverilog/vvp (see numbers below), then repaired and re-measured; worker pytest 45 passed, vitest 1398 passed / 6 skipped
tags:
  [
    sandbox,
    tool-runner,
    worker,
    security,
    dos,
    resource-bounds,
    verdict,
    fail-safe,
    truncation,
    oracle,
    severity-1,
  ]
timestamp: 2026-09-07
---

# What happened

`SubprocessCommandRunner.run` called `subprocess.run(..., capture_output=True, timeout=timeout_s)`.
That buffers the child's entire stdout and stderr in memory with no bound.
The wall-clock cap was the ONLY thing that stopped the run, and by the time it fired the buffer was as large as the child could make it.

A testbench whose wait condition never becomes true - `forever @(posedge clk) $display(...)`, the normal consequence of buggy RTL - is a perfectly ordinary way for a student's (or a mutation-testing mutant's) testbench to behave.

Reproduced twice, replicating the worker's exact call against a real non-terminating Icarus simulation:

```
this machine, 5s cap        faster machine, 5s cap
TimeoutExpired after 5.03s  TimeoutExpired after 5.07s
stdout bytes   55,918,592   stdout bytes   114,311,168
rate           11.1 MB/s    rate           21.5 MB/s
at a 30s cap   333 MB       at a 30s cap   654 MB
```

`ResourceLimits.memMb` (512) does not help: it caps the SANDBOXED child, not the worker's own buffer of that child's output.
Concurrent sessions multiply it, so this is an OOM / denial-of-service vector in the shipped product.
It is also why the eval suite went from 35 seconds to hanging past 15 minutes.

# Root cause

Two separate defects, and fixing only the first would have been worse than useless.

1. **Unbounded retention.** `capture_output=True` means "hold all of it". There is no cap, and no cap can be expressed through that API.
2. **A bounded capture reads as a complete one.** Once output is capped, the retained bytes are a PREFIX, and the oracle reads `CHECK <name> PASS|FAIL` lines out of stdout. Those lines can appear anywhere. So a run whose retained prefix contains only `PASS` lines is indistinguishable from a run that genuinely passed - and the discarded bytes may have held the `FAIL`. Bounding the memory without reporting the truncation would have converted a crash into a FALSE PASS, which is strictly worse.

# Fix / rule

## 1. Stream, retain a bounded prefix, keep draining

`app/tools/sandbox/worker/src/tool_runner_worker/commands.py` now uses `Popen` + `selectors` and a `_BoundedCapture` per stream.

```
MAX_CAPTURED_STDOUT_BYTES = 1_048_576   # 1 MiB
MAX_CAPTURED_STDERR_BYTES =   262_144   # 256 KiB
_READ_CHUNK_BYTES         =    65_536
_POST_KILL_DRAIN_GRACE_S  =   0.5
```

Peak per invocation is `1 MiB + 256 KiB + 64 KiB` ~= 1.32 MiB, a ~500x reduction from the projected 654 MB, and it is now INDEPENDENT of how much the child writes.
The caps are fixed constants, deliberately not job fields: the job is untrusted input, and a cap a caller can raise is not a bound.
1 MiB is generous next to any legitimate simulation (a 60-byte monitor line every cycle fits ~17,000 cycles), so normal runs are captured whole and byte-identical to before.

**Truncating AFTER buffering is not a fix.** It keeps the vector fully intact. Retention must stop at the point of arrival.

**Which end is retained: the PREFIX.** Either end can lose a `CHECK ... FAIL`, which is why truncation forces a non-pass (below) rather than being a diagnostics-only choice - so the decision is about which bytes are more USEFUL. The prefix wins twice over. It is the part causally BEFORE the runaway: a flooding `$display` loop IS the tail, so retaining the tail of such a run yields a megabyte of the same repeated line and nothing else, while the prefix holds whatever the testbench legitimately printed - including any check it managed to signal - before it wedged. Compiler diagnostics are head-weighted for the same reason (first error is root cause, the rest is cascade). The prefix also needs no sliding window, so the bound is obvious by construction.

**NO DEADLOCK, and this is the trap in the naive version.** Reading never stops early. A sink at its cap still consumes its chunk and DISCARDS it, so the OS pipe buffer is always drained. A child blocked writing to a full pipe we had stopped reading would never reach `$finish`, which converts a bounded timeout into a real hang. After the timeout SIGKILL the drain continues for `_POST_KILL_DRAIN_GRACE_S` and is then abandoned, because a grandchild can hold the write end open and waiting for EOF unconditionally would hang too.

Preserved unchanged: `COMMAND_TIMEOUT_EXIT` (124), `COMMAND_NOT_FOUND_EXIT` (127), the `timed out after {n}s` stderr fallback, no shell, explicit argv.
Incidental hardening: decoding is now explicitly `errors="replace"`, where `text=True` used the locale encoding with `errors="strict"` and could raise on a stray byte.

## 2. Truncation is reported across the seam

`CompletedCommand`, `EdaCapture`, and `WorkerReport` gained `stdout_truncated` / `stderr_truncated`; the report serializes them as `stdoutTruncated` / `stderrTruncated`.
Both are REQUIRED, never defaulted, so a producer cannot silently report a bounded prefix as a complete stream.
The seam schema (`contract-schema.ts` + the `contract.schema.json` byte-mirror) requires them on `SandboxResult`, and `RawRunCapture` / `SandboxResult` carry them in TypeScript.
The `EdaCapture` flags describe the streams THAT capture reports: a compile that overflowed but exited zero has its streams discarded in favour of the simulation's, so its truncation says nothing about what the caller receives.

`contract.py` was deliberately NOT touched: it owns the inbound job, and truncation is an outbound fact. Putting the caps in the job would have let a caller raise them.

Both runtime parsers (`runtime-runsc.ts`, `runtime-local-worker.ts`) narrow the flag with `typeof value === 'boolean' ? value : true` - an unknown truncation status is not a known-complete one, and the worst case is a `pass` downgraded to `error`.

## 3. A truncated run can never be `pass`

`InvocationOutcome` gained a required `stdoutTruncated: boolean` (a BOOLEAN, so it cannot carry discarded tool output into a verdict). `classifyVerdict` precedence:

```
before  timeout | toolFailure | !completed | 0 readable checks -> error
        any readable check failed                             -> fail
        any UNREADABLE check signal                           -> error
        else                                                  -> pass

after   ... same first four ...
        any readable check failed                             -> fail
        any UNREADABLE check signal                           -> error
        stdout was TRUNCATED                                  -> error   <== new
        else                                                  -> pass
```

Truncation sits BELOW the functional-fail rule, following the precedent set for unreadable signals in [[gotcha-oracle-check-reader-fixed-unreadable-signals-now-force-non-pass]]: a legible `CHECK ... FAIL` in the retained prefix is a real, actionable failure, and blurring it into `error` throws away the stronger fact and leaves self-healing nothing to repair.
It is deliberately NOT folded into `completed` (rule 3), which would rank it above `fail`: `completed` is owned by capture-all-or-error and answers "was every REQUIRED OUTPUT captured", and stdout WAS captured - just not all of it - so conflating them would make `missingRequiredOutputs` untrue.
`error` stays within its Property 7 reservation: truncation is an EVIDENCE failure, never a functional check failure.

**Enforced at two layers, deliberately.** `classifyCapture` (sandbox) feeds the real flag into its outcome, so every `ToolRunner` consumer inherits the refusal; `interpretSandboxResult` (Simulator) states it too, because that is the layer whose verdict actually depends on reading stdout and the sandbox's coarse `sandbox-process-exit` check is documented as a placeholder for exactly this classification.
Consequence to know about: on the real path the sandbox refuses first, so a truncated run arrives at the Simulator already `error` and `SimulationVerdict.checks` is `[]` - the parsed checks are NOT surfaced for a truncated run, same as for any other sandbox `error`. The retained `stdout` is still carried for diagnostics.
`app/tools/synth` is unaffected in practice: it reads artifacts and the exit code, and a synthesize job does not require `stdout`.

# Known gaps (deliberate)

- `SimulationVerdict` does NOT carry the truncation flag, so self-healing cannot distinguish "output truncated" from a timeout or a tool crash - the same collapse recorded in [[gotcha-simulation-verdict-collapses-error-causes]]. It cannot manufacture a pass; it costs diagnosability.
- `LocalWorkerRuntime` / `RunscSandboxRuntime` still accumulate the worker's stdout unbounded. That is bounded TRANSITIVELY now (the report they read contains at most the capped streams), not by a check of their own.
- The caps are not tuned against evidence about real testbench output volumes; 1 MiB was chosen with headroom, not measured.

# Verification

Real toolchain, real defect shape. The bound is asserted by DOUBLING the wall cap (1.5s then 3s) on an actual non-terminating simulation and requiring the retained output not to grow - unbounded buffering is linear in run time, so that comparison fails loudly if the bound is removed, without duplicating the worker's internal cap in TypeScript.
The correctness half is asserted with a testbench that signals its checks, floods 40,000 monitor lines, and then `$finish`es normally: every CHECK line in the retained prefix passes, the VCD IS captured (which rules out the timeout / infra / missing-artifact routes to `error`), and the verdict is still `error`. The same design with 10 lines instead of 40,000 returns `pass`, so the contrast is not vacuous.

```
worker pytest             45 passed  (was 33; +12, incl. no-deadlock and bounded-retention)
npx tsc -b                exit 0
npx eslint app            exit 0
npx prettier --check .    exit 0
ruff check / format       exit 0
mypy (strict)             exit 0
npx vitest run --exclude "**/eval-negative-control.integration.test.ts"
                          1398 passed / 6 skipped
npm run build             exit 0
```

The 6 skips are the same environmental ones as the previous baseline: 5 gVisor containment, 1 netlistsvg. No new skips.

# Links

- [[gotcha-oracle-check-reader-fixed-unreadable-signals-now-force-non-pass]] (the precedent this follows: incomplete evidence forces non-pass, ranked below `fail`)
- [[pattern-bounded-untrusted-http-reply-reject-not-truncate]] (same bound-the-stream discipline; that boundary REJECTS instead of truncating, because a clipped JSON prefix can parse as a plausible reply - here a truncated prefix is still useful diagnostics, so it is retained and FLAGGED)
- [[gotcha-sandbox-result-collapses-error-causes]]
- [[gotcha-simulation-verdict-collapses-error-causes]]
- [[sandbox-isolation-and-capture-all-or-error-recipe]]
- app/tools/sandbox/worker/src/tool_runner_worker/commands.py (`_BoundedCapture`, `_pump_pipes`, `_kill_and_drain`)
- app/tools/sandbox/worker/tests/test_command_capture_bounds.py
- app/tools/sandbox/{contract.ts,contract-schema.ts,contract.schema.json,classification.ts,runtime-runsc.ts,runtime-local-worker.ts}
- app/core/verdict/index.ts (`classifyVerdict` precedence rule 7)
- app/tools/simulator/adapter.ts (`interpretSandboxResult`)
- app/test/sandbox-output-bound.integration.test.ts (real toolchain, gated on `PROBE.available`)
- product-ece/ECE-SECURITY-PERFORMANCE-RESILIENCE.md section 6 (resource bounds on generated-code execution)
