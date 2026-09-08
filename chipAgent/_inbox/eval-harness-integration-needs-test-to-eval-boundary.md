---
type: gotcha
title: The Eval_Harness integration test lives in app/test and requires the test -> eval import boundary
status: candidate
provenance: hdl-creation-loop task 19.4 (Eval_Harness integration test; Req 15.1, 15.2, 15.6, 15.10)
tags: [testing, integration, layering, eslint-boundaries, tsconfig, app-eval, app-test]
timestamp: 2025-06-05T00:00:00Z
verifiedBy: npx tsc -b app/test --force + eslint --max-warnings=0 + vitest run (3 passed, 2 skipped)
---

# Gotcha

The integration test for `@app/eval` (the Eval_Harness) must live in `app/test`, not in `app/eval`.
It has to reuse the shared real-oracle harness (`PROBE`, `realOracleAdapter`, `LocalWorkerRuntime`) which lives in `app/test/real-oracle-harness.ts`, and the import-boundary gate forbids `eval` from importing `test`. So the test goes in `app/test` and imports the harness from `@app/eval`.

But out of the box `app/test` could not import `@app/eval`: `ALLOWED_INNER.test` in `eslint.config.js` listed only up to `web` (no `eval`), `app/test/tsconfig.json` had no `../eval` project reference, and `@app/eval` was not in `app/test/package.json`. `eval` and `test` are sibling top consumer layers, so nothing had wired test -> eval before task 19.4 (the first thing to integration-test the harness end to end).

# Fix (one-time, already applied)

Extend the test layer's inward reach to include eval:
- `eslint.config.js`: add `'eval'` to `ALLOWED_INNER.test`.
- `app/test/tsconfig.json`: add `{ "path": "../eval" }` to `references`.
- `app/test/package.json`: add `"@app/eval": "*"` to dependencies (workspace symlink already exists).

Only relaxes a restriction for files under `app/test/**`; eval still may not import test/web, and no inner layer changes. Same shape as the earlier test -> web gap.

# Recipe (production-style EvalLoopRunner adapter under the real loop)

- The adapter implements `EvalLoopRunner.runSample`: build a real `VerificationLoop` per sample (real `GenerationGate` + `oracleTrustLabeler` + `TraceActionRecorder`), thread the harness's metered student-caps `budget` and `limits`, and return the oracle-decided `VerificationOutcome`. Only the injected `SimulatorAdapter` (real vs fake) varies.
- Model the seed threading with a deterministic, temperature-0 candidate policy: `seed % 3` -> immediate-pass / repair-pass / never-pass. Re-derive expectations in-test from the PUBLIC `sampleSeed` so the assertions prove the seed drives generation and the oracle decides each verdict.
- Non-vacuous fake: a `FakeSandboxRuntime` whose capture is DERIVED from the candidate RTL in `job.workspaceFiles` (matches the fixture's correct RTL -> all CHECK PASS, else first CHECK FAIL). It stands in only for iverilog/vvp + gVisor, never fabricating a verdict. Include a non-null `vcd` artifact + `exitCode 0` + stdout `CHECK` lines or capture-all-or-error collapses the run to `error`.
- Gate the real-oracle suite with `describe.skipIf(!PROBE.available)` and surface `PROBE.reason`; drive the SAME assertions through the fake so the run is meaningful when the toolchain is absent.
- Reproducibility (Req 15.10): the `EvalRunReport` has no wall-clock/id fields, so `now: () => 0` is not even needed for determinism, but injecting it keeps recorded spans stable; two runs `toEqual` each other.

# Links

- app/test/eval-harness.integration.test.ts (task 19.4)
- app/eval/harness.ts, app/eval/loop-runner.ts, app/eval/reproducibility.ts (sampleSeed)
- app/test/real-oracle-harness.ts (PROBE, realOracleAdapter)
- eslint.config.js (ALLOWED_INNER), app/test/tsconfig.json, app/test/package.json
- Related: chipAgent/_inbox/web-layer-property-tests-need-test-to-web-boundary.md, chipAgent/_inbox/pattern-eval-harness-loop-runner-port-metered-budget.md, chipAgent/_inbox/real-oracle-integration-dual-trajectory-pattern.md
