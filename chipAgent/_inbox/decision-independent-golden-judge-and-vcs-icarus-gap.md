---
type: decision
title: pass@k is decided by an independent golden testbench, and the instrument is validated before it is trusted
status: candidate
provenance: RTLLM v2.1 corpus import + golden-testbench scorer + Stage 0 validation (app/eval/corpus)
tags: [eval, verification, oracle, benchmark, rtllm, icarus, testbench]
timestamp: 2026-09-05
---

# Decision

Two verdicts are recorded per eval sample, from two different testbenches, and only one of them may decide pass@k.

1. The Verification_Loop's own verdict comes from the real Icarus oracle run against the AGENT'S spec-derived testbench.
   That is the right oracle for the loop, because it is what makes repair possible, but it is SELF-GRADED: a weak agent testbench passes a wrong design and the score goes up.
2. The reported pass@k comes from the benchmark's own `testbench.v`, kept byte-identical to upstream, compiled with the candidate through the same sandbox seam.
   It was written by someone else, before us, against a reference design, and we do not get to touch it. That is what makes it a judge.

The agreement rate between the two is recorded as a first-class metric. The cell that matters is loop-passed / golden-failed: each one is a bug the agent's own testbench failed to catch, which is a falsifiable measure of testbench quality rather than an opinion about it.

Corollary decision: an independent judge must itself be validated before anything it says is trusted.
Stage 0 drives each design's OWN reference RTL against its OWN golden testbench through the real toolchain and requires a pass. A reference that fails its own testbench is an unusable measuring stick - a candidate failing that design is indistinguishable from the judge being broken - so the design is quarantined with its reason recorded and excluded from the scored corpus.

# Context / options considered

- Reuse the loop's oracle verdict as pass@k. Rejected: it measures self-graded success, and the number would rise when our testbenches got weaker.
- Rewrite the 50 golden testbenches into our own `CHECK <name> PASS|FAIL` convention so one parser serves both. Rejected outright: editing the independent judge destroys the independence that is the entire reason to have it. A judge we rewrote cannot falsify us. A second parser for the upstream banner grammar is the cheap price of keeping that property.
- Reuse `IcarusSimulatorAdapter` for the golden run. Rejected on evidence: it requires a `vcd` output, and the golden testbenches never call `$dumpfile`, so every golden run would classify as `error`. The waveform is a teaching artifact for a student session, not evidence a judge needs. The golden scorer requires only `stdout` + `exitCode` and reuses everything below that line (same `ToolRunner`, same validated job contract, same confinement, same caps).
- Weaken the Stage 0 assertion so all 50 designs "pass". Rejected: that leaves broken judges inside the scored set, which is strictly worse than a smaller honest corpus.

# The VCS-versus-Icarus dialect gap (the concrete gotcha)

Benchmark testbenches are typically written for Synopsys VCS. Ours runs Icarus. Measured at RTLLM commit `51ed553d0ffd32797a1a0a13e051656bf302c81f` with Icarus Verilog 13.0: 50 imported, 48 build, 46 pass. The four exclusions split into exactly two failure modes, and the distinction is worth keeping:

- Dialect (2 designs): the testbench uses syntax VCS accepts and Icarus 13 rejects, so nothing elaborates. An unpacked-array aggregate initializer (`reg [7:0] data [0:9] = {8'b1, ...}`), and a `localparam` declared inside a named generate-for block and used as a parameter override.
- Event ordering (2 designs): it builds and runs, but the reference does not pass. Both are same-timestep or handshake races whose resolution is simulator-dependent - one testbench samples a signal at exactly the timestep the DUT toggles it, the other drives the next operand while holding `ready` high and then waits on `valid`, so it can sample the previous result.

Two further traps found while importing, both worth expecting in any benchmark import:

- The benchmark's reference top module is usually prefixed (`verified_<name>`) so it does not occupy the module name a candidate must implement, and the testbench instantiates the UNPREFIXED name. For three designs the reference top is named something else entirely. So the module name a candidate must use comes from the description's labeled `Module name:` field (cross-checked for presence in the testbench text), while the ports, directions, and widths come from the reference's machine-readable declaration. Neither source alone is sufficient.
- Six golden testbenches OVERRIDE module parameters on the instantiation (`dut #(.WIDTH(8)) ...`). Our `ModuleInterface` has no parameter concept, so a candidate generated faithfully from the Spec can be rejected by the judge for a requirement the Spec never stated. Recorded per design rather than silently dropped.

# Rationale

- The prime directive is that tools decide correctness, not the model. It has a second half that is easy to miss: WHOSE tool. An oracle the agent's own artifact configures is still a tool, but it is not neutral, and a benchmark number computed from it is a claim about our testbench generator as much as about our RTL generator. Separating the two verdicts is what makes each number mean one thing.
- Quarantine-with-reason beats both alternatives. Silently dropping a design makes the corpus size a lie; "fixing" the design by weakening the assertion makes the pass rate a lie. Recording the exclusion and its reason makes the usable corpus size an honest, citable number (46 of 50 here).
- The exclusion list is committed source, and the real Stage 0 run asserts it reproduces EXACTLY in both directions. A design that starts failing fails the suite; a quarantined design that starts passing also fails it. That makes the list a ratchet that can only move by review, the same discipline the eval pass@k gate applies to its baseline.
- The corpus is fetched at a pinned commit, never vendored, and the fetch verifies the commit hash. A commit hash is content-addressed, so it is a stronger integrity guarantee than a vendored copy nothing checks - and a corpus that moves silently invalidates every historical pass@k number and the gate baseline it ratchets against.

# Revisit trigger

- Bumping the pinned corpus commit. Treat it as a deliberate re-baselining: rerun Stage 0, re-derive the exclusion list, and re-measure pass@k. The old numbers do not carry over.
- Upgrading Icarus, or gaining a second simulator. Either may move the dialect exclusions; the Stage 0 ratchet will fail loudly, which is the point.
- The first real agreement measurement. If loop-passed / golden-failed is non-trivial, the finding is about the Testbench_Agent, not about the RTL generator, and the repair belongs there.
- Teaching `ModuleInterface` about parameters, which would close the parameter-override gap and could make some currently-unwinnable designs winnable.

# Links

- app/eval/corpus/pinned-source.ts (the pinned commit constant + upstream attribution)
- app/eval/corpus/golden-banner.ts (the upstream banner grammar; note that RTLLM's `Error` banner is a DESIGN failure, not an infrastructure error)
- app/eval/corpus/golden-scorer.ts (why `IcarusSimulatorAdapter` is not reused)
- app/eval/corpus/stage0.ts, app/eval/corpus/stage0-quarantine.ts (the run and the reviewed exclusions)
- app/eval/golden-judge.ts (the harness-facing judge port and the agreement summary)
- app/test/rtllm-corpus-stage0.integration.test.ts (the real-toolchain ratchet)
- product-ece/ECE-VERIFICATION-METHODOLOGY.md
