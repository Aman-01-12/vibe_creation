---
type: gotcha
title: M0 real-oracle path and adversarial containment are wired but UNEXERCISED (no iverilog/gVisor here)
status: candidate
provenance: hdl-creation-loop tasks 3.8 (real Icarus integration) and 3.9 (adversarial containment)
tags: [continuity, oracle, sandbox, gvisor, iverilog, m0, integration-tests, not-validated]
timestamp: 2025-05-27T00:00:00Z
---

# What happened

The deterministic oracle and the sandbox isolation are fully wired and logic-tested, but the two tests that would validate them against reality both SKIP in this environment because the required tools are absent.

- Task 3.8 (real Icarus oracle-path integration): `iverilog`/`vvp` are not on PATH here, so it skips. It is a real test that, when the toolchain exists, compiles+simulates a passing counter (-> pass), a buggy counter (-> fail), and a syntax-error module (-> error), and asserts double-run determinism (Property 10, non-vacuous).
- Task 3.9 (adversarial containment): the gVisor `runsc` runtime and the built worker image are absent, so it skips. It is a real test of five live attacks (outbound network, fork bomb, disk-fill, wall-clock overrun, out-of-workspace write), each asserted denied/killed and recorded.

# Why it matters (continuity)

What IS validated so far: the verdict logic (Property 5/7/8/10 mock), path confinement (Property 9 + unit), isolation POLICY (3.7 config smoke), and the interpretation/adapter chain via FakeSandboxRuntime.
What is NOT yet validated in any available environment: real iverilog verdicts, real-tool determinism, and real adversarial containment under gVisor.
Do not claim the oracle path or sandbox containment is proven end to end until 3.8 and 3.9 actually RUN (not skip) on a host with iverilog+vvp and a gVisor runtime + pinned worker image.

# Design decision recorded

3.8 uses a documented "real oracle, local runtime" path (same SandboxJob/SandboxResult contract, same worker, same wall-clock kill-timer, worker spawned as a local process instead of inside gVisor) because full gVisor is impractical on a plain dev/CI box. gVisor isolation is validated separately by 3.9. The VCD artifact bytes are NOT stable across runs (iverilog embeds a $date header), so determinism is asserted on verdict + parsed checks, never on the artifact hash.

# Rule / next step

Before the M0 milestone can be called truly done, run 3.8 and 3.9 on a properly provisioned host (iverilog+vvp; docker+runsc+`ece/tool-runner-worker:pinned`) and confirm they pass rather than skip. The testbench-to-adapter signalling contract is `CHECK <name> PASS|FAIL` lines on stdout plus a `$dumpfile`/`$dumpvars` VCD.

# Links

- app/test/icarus-oracle.integration.test.ts
- app/tools/sandbox/sandbox-containment.integration.test.ts
- app/tools/simulator/check-signalling.ts (the CHECK-line convention)
