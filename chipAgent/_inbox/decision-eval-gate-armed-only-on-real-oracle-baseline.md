---
type: decision
title: The eval pass@k CI gate ships UNARMED and may be armed only against a real-oracle-measured baseline
status: candidate
provenance: hdl-creation-loop task 19.5 (arm the eval pass@k gate in CI)
tags: [eval, ci, pass-at-k, prime-directive, verification, honesty]
timestamp: 2025-06-05T00:00:00Z
---

# What happened

Task 19.5 asked to "arm" the CI eval pass@k gate against the M1 baseline. But in
this environment the real Simulator oracle (iverilog + vvp) is not installed and the
Eval_Harness real loop-runner adapter (task 19.4) is not wired, so no genuine
non-zero pass@k baseline can be measured here. Fabricating a baseline to flip the
gate to armed would violate the prime directive (tools decide correctness, never a
guessed number).

# Decision

Ship the ARMING MACHINERY, not a fake arming:
- `app/eval/eval-baseline.json` is version-controlled and defaults to `armed: false`
  (UNARMED), with an explicit `armingProcedure` and a `provenance` block.
- `app/eval/gate/` implements the runnable gate: `parseBaselineConfig` ->
  `decideGateRun` -> core `decideEvalGate`. `.github/workflows/ci.yml`'s eval-gate
  job runs `node app/eval/dist/gate/cli.js`.
- While unarmed the CLI runs the REAL ratcheting decision path but always exits 0,
  so lint/type/unit/property stay the merge authority (Req 15.7). It is ready to
  block the moment a real baseline is committed.

# Rules learned

- The config parser enforces an HONESTY invariant: an armed config is REJECTED
  unless `provenance.measuredBy` and `provenance.measuredAt` are present - you cannot
  arm without recording that the real oracle produced the number.
- ARMED + measurement unavailable => the gate BLOCKS (fail safe), never a silent
  pass. UNARMED + anything => never blocks. pass@k == baseline never blocks (the core
  `floor < baseline` invariant makes that structural).
- To arm: provision iverilog + vvp, wire the 19.4 adapter, run the harness with the
  pinned reproducibility config, record measured pass@k as baseline with a floor
  strictly below it and a noise-only tolerance, set `armed: true`, commit (Req 15.4,
  15.7, 15.8, 15.9).

# Links

- app/eval/eval-baseline.json, app/eval/gate/{baseline-config,gate-run,measure,cli}.ts
- app/core/eval-gate/index.ts (decideEvalGate, makeArmedGate, UNARMED_GATE)
- .kiro/specs/hdl-creation-loop/requirements.md Req 15.4, 15.7, 15.8, 15.9, 15.11
