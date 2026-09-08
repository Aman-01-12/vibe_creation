---
type: gotcha
title: Worker synthesize job kind is unimplemented - real Yosys/netlistsvg schematic path (Req 9.2) is not yet functional end to end
status: candidate
provenance: hdl-creation-loop task 15.8 (netlistsvg schematic integration test)
tags: [tool-runner, worker, synthesize, yosys, netlistsvg, schematic, req-9.2, integration-tests, latent-defect]
timestamp: 2025-07-06T00:00:00Z
verifiedBy: tsc -b app/test; eslint --max-warnings=0; vitest run (real suite skips, fail-safe passes)
---

# Gotcha

The Synth adapter (`YosysNetlistSvgAdapter`, `app/tools/synth/`) is fully wired and unit-tested, but the thin Python worker does NOT implement the `synthesize` job kind.
`worker.py._run_kind` dispatches only `simulate`; for `synthesize` it returns an honest unsupported-kind capture (`exit_code = 1`, no artifacts) with the comment "Synthesis (Yosys) is a later worker slice".

Consequence: the REAL Yosys `write_json` -> netlistsvg path cannot produce an `SvgArtifact` end to end yet.
Even in an environment with `yosys` + `netlistsvg` + the worker Python all installed, driving the adapter through `LocalWorkerRuntime` yields a missing `netlistJson` required output -> sandbox `error` verdict -> `interpretSynthResult` returns `unavailable{cause:'synthesis-error'}`, never `available`.

This is a latent defect, not a test bug: Req 9.2 ("render the schematic from the verified netlist via Yosys `write_json` -> netlistsvg") is not satisfiable on the real path until the worker slice lands.

# Why the 15.8 integration test still passes / is honest

- The real-tool suite is gated `describe.skipIf(!SYNTH_PROBE.available)` and this env has no yosys/netlistsvg, so it SKIPS cleanly (reason surfaced) - green CI, no false confidence.
- The real assertion is NOT weakened: it demands a well-formed `available` `SvgArtifact` (per Req 9.2). If someone installs yosys+netlistsvg, the suite will run and FAIL until the worker synthesize slice exists - which is the correct signal.
- The fail-safe portion (Req 9.11) runs everywhere via a `FakeSandboxRuntime`-scripted `SandboxToolRunner`, asserting the degrade-to-sanitized-`unavailable` contract, so the test is non-vacuous without the tools.

# What the worker slice needs (when someone implements it)

- In `eda.py` add a `synthesize(workspace, sources, runner, timeout)` that runs Yosys (`yosys -p "read_verilog ...; synth; write_json netlist.json"`) then `netlistsvg netlist.json -o schematic.svg`, and registers both `netlistJson` and `svg` artifacts (the adapter keys are `netlistJson` and `svg`).
- Dispatch it from `worker.py._run_kind` for `job.kind == "synthesize"`.
- `netlistJson` is a declared `RequiredOutput` (missing => sandbox `error`); `svg` is intentionally NOT required (netlistsvg may draw nothing => `no-schematic`), matching `interpretSynthResult`.
- No adapter change should be needed - the classification already anticipates all three unavailable causes.

# Harness extension made for 15.8 (reuse it)

`app/test/real-oracle-harness.ts` now owns the synth probe too (single skip mechanism):
- `SYNTH_PROBE` (yosys + netlistsvg + worker Python), `WORKER_PYTHON`, `realSynthAdapter(pythonBin)`, and the `SCHEMATIC_RTL` / `SCHEMATIC_MODULE_NAME` fixtures.
- Worker Python is discovered once (`WORKER_PYTHON_BIN`) and shared by both `probeRealOracle` and `probeRealSynth`.
- `binaryPresent` treats only a spawn error (ENOENT) as "missing", so probe flags (`yosys -V`, `netlistsvg --help`) that exit non-zero never mis-report a present tool.

# Links

- app/tools/sandbox/worker/src/tool_runner_worker/worker.py (the unimplemented dispatch)
- app/tools/sandbox/worker/src/tool_runner_worker/eda.py (where synthesize glue belongs)
- app/tools/synth/adapter.ts (interpretSynthResult - already handles all causes)
- app/test/netlistsvg-schematic.integration.test.ts
- app/test/real-oracle-harness.ts
- chipAgent/_inbox/real-oracle-integration-dual-trajectory-pattern.md
