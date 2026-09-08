---
type: gotcha
title: ResourceLimits.diskMb was parsed and never enforced, and a SIGKILLed worker left its waveform behind - both measured, both now closed
status: candidate
provenance: measured reproduction on this machine against real iverilog/vvp 13.0 through the settled seam (numbers below), then re-measured after the repair; vitest 1526 passed / 6 skipped, worker pytest 50 passed
tags:
  [
    sandbox,
    tool-runner,
    worker,
    disk,
    resource-bounds,
    workspace-lifecycle,
    verdict,
    fail-safe,
    oracle,
    mutation-calibration,
    severity-1,
  ]
timestamp: 2026-09-14
---

# What happened

Two defects on the same runaway run, one in memory's sibling and one in cleanup.

**1. A declared cap that did not exist.** `ResourceLimits.diskMb` was parsed by the worker's job
contract and then never read. Every caller of the seam saw a declared ceiling and assumed
protection. That is worse than having no cap: the field documented a bound nobody enforced.

The run that exploits it is not exotic. Our testbenches call `$dumpfile`/`$dumpvars`, so a
testbench whose wait condition never becomes true - the normal consequence of buggy RTL - writes a
waveform continuously until the wall clock kills it. Measured here through the real seam
(`IcarusSimulatorAdapter -> SandboxToolRunner -> LocalWorkerRuntime -> tool_runner_worker ->
iverilog + vvp`) on a 32-bit counter dumping to VCD:

```
wall clock as the only bound, 3s cap
peak workspace     83.4 MiB in 3.009s
rate               27.7 MiB/s
projected @30s     832 MiB per hung run   (the real-oracle path uses a 30s cap)
verdict            error, exitCode null, no stderr   (SIGKILL leaves nothing behind)
```

An earlier session measured 28.3 MB/s on the same shape and 49 MB/s on a 32-bit adder toggling
more bits, so 27.7 MiB/s here is the low end of the range, not an outlier. An eval campaign of
such runs filled a 228 GB disk.

**2. Cleanup on a path the kill skips.** The worker built its workspace with
`tempfile.TemporaryDirectory`, whose cleanup runs in a context-manager `__exit__`. The wall-clock
bound kills the worker with SIGKILL, which cannot be caught, so `__exit__` never ran.

Reproduced directly, worker spawned with no `TOOL_RUNNER_WORKSPACE` so it chose its own directory,
then SIGKILLed at 2.5s exactly as the runtime's kill timer does:

```
workspace during the run   1 directory, 72,593,408 bytes of VCD
after the SIGKILL          1 directory SURVIVED, 72,597,504 bytes of VCD
```

The directory outlived the run, waveform included. The two defects compound: the cap that would
have bounded the file did not fire, and the file that was written was never removed.

# Root cause

`diskMb` reached `contract.py` and stopped there. Nothing downstream measured the workspace, and
nothing could have: the only per-run signal was the wall clock, which by definition fires after the
damage.

The cleanup defect is a misplaced ownership boundary. The side that OWNS the SIGKILL was
TypeScript; the side that owned the directory was Python. Cleanup cannot live on a path the kill
skips.

# Fix / rule

## 1. The cap is enforced by the WORKER, and enforced WHILE the tool runs

`_DiskBound` + the disk check woven into `_pump_pipes` in
`app/tools/sandbox/worker/src/tool_runner_worker/commands.py`. Same pump loop, same SIGKILL, same
sentinel-exit shape as the wall-clock bound, so there is ONE shape for "a resource bound killed
this run" rather than two dissimilar ones. `COMMAND_DISK_LIMIT_EXIT = 125` sits beside the timeout
sentinel 124.

Measured after the repair, same design, `diskMb: 8` with a generous 30s wall cap:

```
killed after      436 ms          (the wall clock never came near)
peak workspace    8.5 MiB         (cap 8 MiB; the overshoot is one poll interval)
exitCode          125
stderr            "workspace reached its 8388608-byte disk cap"
verdict           error
diskLimitExceeded true            read off SandboxResult at the seam
vcd artifact      present         so the error is NOT the missing-artifact route
df -h / before/after   16Gi used / 32Gi avail, unchanged
workspaces surviving   0
```

832 MiB projected down to 8.5 MiB actual: a **98x** reduction, and the peak is now independent of
how long the run lasts.

**WHY THE WORKER AND NOT THE TYPESCRIPT RUNTIME.** On the production runtime the workspace is a
tmpfs INSIDE a gVisor container, so the host has no path to measure. A TypeScript-side monitor
would work for the local runtime and be structurally impossible for the isolated one - which is how
a security control ends up existing only on the path that does not need it. The worker runs in
both.

**THE OVERSHOOT IS THE WRITE RATE TIMES THE POLL INTERVAL** (`_DISK_POLL_INTERVAL_S = 0.1`), and
this is worth knowing before writing a test against it. An unthrottled Python filler measured
~590 MB/s here and overshot a 4 MiB cap by 59 MB - a 14x overrun that looks like a broken bound and
is not. The worker's disk-bound tests therefore THROTTLE their synthetic child to ~52 MB/s, the
upper end of the measured waveform range, so the assertions are about the enforcement rather than
about how fast the host can memcpy.

## 2. Lifecycle moves to the side that owns the kill

`app/tools/sandbox/workspace-lifecycle.ts` owns create + kill-the-whole-tree + remove + reap
orphans, because a run's disk footprint ends only when BOTH the process and the directory end:
removing the directory while a descendant holds the file open reclaims nothing on POSIX, and
killing the process without removing the directory leaves the bytes under a name nobody will look
at again. The runtime creates the directory, hands it to the worker through
`TOOL_RUNNER_WORKSPACE`, and removes it in a `finally` that runs after a normal exit, a throw, or a
kill. `spawnInOwnProcessGroup` + `killTree` reaches the `vvp` grandchild, which otherwise keeps
writing after its parent dies.

Re-measured: the same 3s wall-clock SIGKILL that left 69 MiB behind now leaves **0** workspaces.
`reapStaleWorkspaceRoots({ minAgeMs: 0 })` collected the deliberately orphaned one exactly:
`{"removed":1,"keptFresh":0,"refused":0}`.

## 3. A disk-killed run can never be `pass`, and it ranks with the TIMEOUT, not with truncation

`InvocationOutcome.diskLimitExceeded` is required, and `classifyVerdict` puts it at rule **2**,
directly below the wall-clock timeout and ABOVE the functional-fail rule:

```
1. timedOut                      -> error
2. diskLimitExceeded             -> error   <== new
3. toolFailure                   -> error
4. !completed                    -> error
5. zero readable checks          -> error
6. any readable check failed     -> fail
7. any unreadable check signal   -> error
8. stdout truncated              -> error
9. otherwise                     -> pass
```

**This is where it differs from truncation, and the difference is the whole reasoning.** Both are
evidence failures, so both stay inside Property 7's reservation on `error`. What separates them is
whether the run ENDED. Truncation describes a run that finished on its own and printed more than
was kept, so a legible `CHECK ... FAIL` in the retained prefix is a real verdict on the whole
stimulus and outranks the missing evidence - which is why truncation sits at rule 8, below `fail`.
A disk-cap kill describes a run WE terminated part-way: the stimulus never finished, the checks
that printed describe a fraction of it, and calling that `fail` would attribute our own resource
decision to the design.

It is deliberately NOT folded into `timedOut` (untrue - the wall clock did not fire) and rule 2
does not lean on `completed`, so a caller that reports a disk-killed run as `completed` still
cannot reach `pass`. Enforced at both layers on purpose: `classifyCapture` sets `completed = false`
AND states the signal, and `interpretSandboxResult` states it again because that is the layer whose
verdict depends on reading stdout.

## 4. Mutation calibration reads the FLAG, never the residue

`killedByResourceBound(score) = score.timedOut || score.diskLimitExceeded` -> `golden-timeout`.
Both bounds report the same fact - the judge never reached a verdict because the run would not end -
so they are merged HERE while staying distinct on the seam.

This one is load-bearing and easy to get wrong. A wall-clock kill leaves NOTHING behind (no exit
code, no streams, zeroed usage), but a disk-cap kill leaves plausible residue: a real sentinel exit
code and a real stderr line. `classifyNonPass` reads "diagnostics with no verdict" as
`did-not-build`, so a reader going by the residue instead of the flag would silently move every
disk-killed mutant from `golden-timeout` (valid, a kill, IN the gate set) to `non-compiling` (out of
the denominator and out of the gate set) purely because a different cap fired. Since `diskMb`
became enforced the disk cap is often the FIRST bound to fire on a hung golden run - 436 ms versus
30 s here - so this is the common path, not the corner.

No sixth calibration state: splitting by WHICH cap noticed would drop those mutants out of
`goldenTimeoutCountOf`, the hang-share warning that stops a hang-heavy gate reading as demonstrated
coverage.

# Two traps this change laid for the test suite

Both were left by the interrupted change and both are recorded because the shape recurs whenever a
required field is added to a type test fixtures construct.

**A property arbitrary must GENERATE the new field, not pin it.** Adding
`diskLimitExceeded: false` everywhere compiles and silently makes the `error`-iff and `pass`-iff
properties weaker than they were before the field existed - they can no longer see the signal at
all. The rule applied here: the FULL input spaces (`outcomeArbitrary`, `captureArbitrary`, both
reproducibility arbitraries) generate it; the SUBSPACE arbitraries that isolate the pass/fail split
(`goodRunArbitrary`, `completeCaptureArbitrary`) pin it `false` alongside `timedOut` and
`toolFailure`, with the reason stated in the doc comment, because a kill outranks `fail` and a
subspace that generated one could not assert `fail` at all. The disk-killed half then gets its own
`diskKilledRunArbitrary` and two facets. Verified non-vacuous by removing verdict rule 2 (3
properties fail) and the classification term (2 fail).

**A security assertion written as an absolute ban can be broken by a legitimate change.** The
container argv now carries `--env=TOOL_RUNNER_WORKSPACE=/workspace`, and two Req 2.1 assertions
banned `--env` of any spelling. The flag is necessary: the worker must be told which directory is
its workspace or it falls back to a temp dir that on a `--read-only` rootfs is either unwritable or
sits OUTSIDE the size-capped tmpfs, so `diskMb` would bound a tree the run does not use - and it
cannot come from the job, which is untrusted input. The assertions were made PRECISE rather than
relaxed: exactly one env flag, pinned by exact identity to the two compile-time constants, so it
cannot drift into carrying anything host-derived or secret, and a second env flag still fails.
`--env-host` and `--env-file` - the flags that actually pull the ambient environment in wholesale -
stay banned outright.

# Known gaps (deliberate)

- `SimulationVerdict` does not carry `diskLimitExceeded`, so self-healing cannot tell a disk kill
  from a timeout or a tool crash - the same collapse as [[gotcha-simulation-verdict-collapses-error-causes]].
  It cannot manufacture a pass; it costs diagnosability.
- The overshoot is unbounded in principle: a fast enough writer overshoots by rate x 0.1s. The
  kernel's `size=` on the tmpfs is the backstop on the isolated runtime; the LOCAL runtime has no
  such backstop, which is one more reason it is documented as trusted-code-only.
- The reaper's liveness guard is an mtime read, so a run whose workspace is somehow idle for 6
  hours could be reaped under it. The cost is bounded in the safe direction: that run loses its
  files and classifies `error`, never `pass`.
- The gVisor path is still UNEXERCISED here (5 environmental skips), so the tmpfs half of the
  double bound is asserted only through the rendered argv, not against a running container. See
  [[real-oracle-and-containment-unexercised-m0]].

# Verification

```
npx tsc -b                 exit 0
npx eslint app scripts     exit 0   (--max-warnings=0)
npx prettier --check .     exit 0
npx vitest run             1526 passed / 6 skipped, no exclusions   (baseline 1520/6)
worker pytest              50 passed   (was 45; +5 disk-bound and seam cases)
worker ruff check/format   exit 0
worker mypy (strict)       exit 0
npm run build              exit 0
```

The 6 skips are the same environmental ones as every previous baseline: 5 gVisor containment, 1
netlistsvg. No new skips.

Every measurement artifact was deleted and the deletion confirmed: 0 `tool-runner-ws-*` directories
in the OS temp directory, the scratch harness removed, and `df -h /` identical before and after
(16Gi used / 32Gi available).

# Links

- [[gotcha-sandbox-worker-unbounded-output-capture-oom]] (the same runaway run, written to memory
  instead of disk; this note is its disk twin and reuses its pump loop, its kill path, and its
  sentinel-exit shape)
- [[gotcha-oracle-check-reader-fixed-unreadable-signals-now-force-non-pass]] (the precedent for
  incomplete evidence forcing non-pass, ranked below `fail` - which is where a disk kill
  deliberately DIFFERS, see rule 2 above)
- [[decision-golden-timeout-is-a-kill-and-mutants-get-their-own-wall-cap]] (the calibration rule
  this extends from one bound to two)
- [[gotcha-sandbox-result-collapses-error-causes]]
- [[gotcha-simulation-verdict-collapses-error-causes]]
- [[sandbox-isolation-and-capture-all-or-error-recipe]]
- app/tools/sandbox/worker/src/tool_runner_worker/{commands.py,workspace.py,worker.py,eda.py,report.py}
- app/tools/sandbox/{workspace-lifecycle.ts,classification.ts,isolation.ts,runtime-local-worker.ts,runtime-runsc.ts}
- app/core/verdict/index.ts (`classifyVerdict` rule 2)
- app/eval/corpus/mutation-calibration.ts (`killedByResourceBound`, `calibrationOf`)
- app/tools/sandbox/worker/tests/test_command_capture_bounds.py (the throttled disk fillers)
- product-ece/ECE-SECURITY-PERFORMANCE-RESILIENCE.md section 6 (resource bounds on generated-code
  execution)
