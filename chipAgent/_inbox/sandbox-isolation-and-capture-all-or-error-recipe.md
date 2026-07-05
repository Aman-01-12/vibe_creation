---
type: verification-recipe
title: Tool_Runner sandbox - fixed isolation constant + capture-all-or-error delegating to core verdict
status: candidate
provenance: hdl-creation-loop task 3.1 (Tool_Runner adapter + seam contract)
tags: [sandbox, gvisor, security, tool-runner, verdict, seam, ajv]
timestamp: 2025-05-27T00:00:00Z
---

# The recipe

The arbitrary-code-execution boundary is built from a few reusable moves:

- One frozen `SANDBOX_ISOLATION` security constant is the single place isolation is declared: gVisor `runsc`, non-root `65534:65534`, `--read-only` rootfs, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--network=none`, no secret mount, single size-capped tmpfs `/workspace`, `--pids-limit` (defeats fork bombs), `--memory` == `--memory-swap` (disables swap), `--init` (reaps zombies). No code path relaxes it.
- Wall-clock is NOT a container flag; the runtime enforces it with a SIGKILL timer. Documented so nobody looks for a `--timeout` flag.
- `buildRunscArgs` is a PURE function, so every isolation flag is unit-asserted without launching a container.
- Capture-all-or-error does not redefine `error`: it builds a core `InvocationOutcome` and delegates to `@app/core`'s `classifyVerdict`, so the sandbox and the verification loop share one definition of `error` (timeout / infra failure / any missing required output -> whole invocation is `error`).
- The runtime is a port (`SandboxRuntime`): `RunscSandboxRuntime` (real) and `FakeSandboxRuntime` (test double) are interchangeable by injection. `spawn` uses array args + no shell, so job contents cannot inject a command.

# Cross-language seam

`sandboxContractSchema` (draft-07 JSON Schema in TS) is canonical; `contract.schema.json` is a committed byte-mirror the Python worker (3.2) validates against; a drift-guard test deep-equals the two so they cannot diverge. TS side validates with ajv 8.17.1 at module load (fails fast on a bad schema).

# Continuity / not-yet-validated

No gVisor/runsc or worker image exists in this dev environment, so `RunscSandboxRuntime` is wired-but-unexercised here; when the binary/image is absent it reports an infra failure that classifies as `error` (never fabricates a run). Real-runtime confidence comes only from the integration tests in tasks 3.8 (real oracle) and 3.9 (adversarial containment), which are not yet run. A completed run currently contributes a coarse process-exit check; true per-spec-check pass/fail arrives with the Simulator adapter (3.5).

# Links

- app/tools/sandbox/isolation.ts, classification.ts, adapter.ts, runtime-runsc.ts
- app/tools/sandbox/contract-schema.ts + contract.schema.json (the seam)
