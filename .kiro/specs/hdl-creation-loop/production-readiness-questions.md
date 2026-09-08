# Production Readiness: Open Decisions and Setup Handoff

This file inventories everything standing between the current state (feature partly built, all external integrations behind ports with fakes/nulls) and a real, production-quality slice we can commit and run through the no-mistakes review pass.

It follows the spec-clarification workflow: each open decision has a stable ID, the area it maps to, why it matters, and candidate options with a recommendation.
Please add your answers (a sibling `production-readiness-answers.md` is fine, or annotate inline) so I can wire the real integrations to your choices.

## Current state (verified, not from memory)

- Host: macOS ARM (`aarch64-apple-darwin`). Homebrew present. Docker binary present but daemon not running. Node 20, npm, Python 3.14, uv, gh present.
- EDA toolchain: `iverilog`, `vvp`, `yosys`, `verilator` NOT installed (installing iverilog + yosys now via brew).
- Sandbox: `runtime-runsc.ts` is a real gVisor runtime wired behind the `SandboxRuntime` port, but gVisor (`runsc`) is Linux-only and not installed. On this Mac only the fake runtime runs; the real sandbox + adversarial containment (tasks 3.8, 3.9) need a Linux host.
- Model providers: real transport is an injected `ProviderTransport` seam; it is currently `null`, so every adapter fails safe with `provider-unavailable`. No vendor SDK installed, no credential provisioned.
- Secret manager: port + in-memory fake only. Deliberately does NOT read `process.env`. No real cloud secret manager wired.
- Auth (OD-4): `AuthAdapter` port only; needs a concrete managed-OIDC adapter + config (`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URI`, `AUTH_DATA_RESIDENCY_REGION`). Region (OD-2) is config, not chosen.
- Persistence: `postgres-adapter.ts` exists behind the storage port; no `DATABASE_URL`, no migrations run.
- CI: TypeScript + Python lint/type/test jobs are the real merge gates. Eval-gate job runs the real ratcheting decision but is UNARMED (`app/eval/eval-baseline.json` `armed: false`, `baseline: null`); no EDA toolchain and no secrets in CI.
- Git: `origin` = github.com/Aman-01-12/vibe_creation (already set, M0 pushed). `no-mistakes` remote set. M1 work is uncommitted.

## Two distinct axes to "done"

1. Feature completeness: 37 task-nodes remain (self-healing loop 14.3, Display_Layer + visualizations 15.x, Iteration + Teach_Mode 16.x, hero-loop integration 17, M1 checkpoint 18, Eval_Harness + CI arming 19-20). These are code I can finish autonomously; they still run behind ports/fakes.
2. Real integrations: the items below need your decisions/secrets/infra before they are truly production quality. This is where I need you.

---

## Decisions I need from you (blocking real integration)

### PR-1 Production host / OS for the gVisor sandbox (OD-1/OD-3 execution)
- Area: Tool_Runner sandbox (Req 2.x), real oracle path.
- Why it matters: gVisor `runsc` is Linux-only. The real sandbox, the adversarial containment test (3.9), and any real eval run cannot execute on your Mac.
- Options:
  - (a) GitHub Actions ubuntu runner installs iverilog/vvp/yosys + runsc, runs the real oracle + containment in CI. Recommended for CI confidence.
  - (b) A dedicated Linux cloud VM (or Fly/render/EC2) as the runtime host for real sessions. Needed for actual production serving.
  - (c) Local Linux container via Docker Desktop (start the daemon) with runsc inside, for local real-oracle dev.
  - Recommendation: (a) now for CI gating, plus (b) as the eventual serving host. Tell me which cloud you want for (b).

### PR-2 Model providers, exact model IDs, and budget (Req 12)
- Area: Model_Router transports.
- Why it matters: "DeepSeek V4 / Gemini Flash / Claude" are role targets; I need exact, current model IDs and the client per provider, plus your per-session cost ceiling.
- Needs from you: API keys for DeepSeek, Google (Gemini), Anthropic (Claude); confirmation of exact model IDs to pin; the pennies-per-session cap.
- Recommendation: pin `deepseek-chat` (V3.x current; confirm if you truly want a V4 preview), `gemini-2.x-flash`, `claude-3.5-haiku`/`sonnet` for escalation. I will pin whatever you confirm; I will not guess a model that may not exist.

### PR-3 Secret manager (Req 12.6-12.10)
- Area: credential resolution at point of use.
- Why it matters: the code resolves secrets via `SecretManagerPort`; there is no real implementation.
- Options: (a) cloud secret manager (AWS Secrets Manager / GCP Secret Manager / Doppler / Infisical); (b) a dev-only env-backed `SecretManagerPort` for local + CI secrets, cloud later.
- Recommendation: (b) an env-backed resolver now (keys in CI secrets + a local untracked `.env`), migrate to (a) for production. Tell me which cloud for (a).

### PR-4 Managed auth provider (OD-4) + data residency region (OD-2)
- Area: API_Gateway auth (Req 1.2, 17.4) and PII residency (India DPDP / GDPR).
- Why it matters: no concrete auth adapter; region is unset. The store holds student PII.
- Options: Clerk / Auth0 / WorkOS / Supabase Auth / Cognito. Region: `ap-south-1` (Mumbai) is the natural DPDP choice.
- Needs from you: provider choice + tenant/issuer/audience/JWKS values, and the region.
- Recommendation: Clerk or Auth0 for speed; region `ap-south-1`. Confirm.

### PR-5 Neon Postgres (Req 16)
- Area: Project_Store durability.
- Why it matters: `postgres-adapter.ts` needs a real `DATABASE_URL` and a migration run.
- Needs from you: a Neon project + pooled `DATABASE_URL` (and a branch URL for CI if you want DB-backed integration tests).
- Recommendation: Neon project in the same region as PR-4; give me the connection string via secret, not in source.

### PR-6 Do real provider/DB calls run in CI?
- Area: CI cost + secrecy.
- Why it matters: real model calls in CI cost money and need secrets in the runner.
- Options: (a) keep CI hermetic (fakes) and exercise real providers only in a manual/nightly workflow; (b) run a tiny real smoke on protected branches.
- Recommendation: (a) hermetic PR CI + (b) a nightly real smoke behind repo secrets.

### PR-7 Eval-gate arming (Req 15.4, 15.7)
- Area: `app/eval/eval-baseline.json`.
- Why it matters: the gate can only arm against a REAL non-zero pass@k measured by the real oracle on a Linux host (never fabricated). This is gated on PR-1 + feature task 19.
- Recommendation: finish task 19, run the harness on the Linux host (PR-1a), record the measured baseline, then arm. I will not hand-set a baseline.

---

## What I will do now without waiting on you

- Install iverilog + yosys locally (in progress) to exercise the real oracle path locally where possible.
- Finish the remaining M1 feature tasks (14.3, 15.x, 16.x, 17, 18) behind the existing ports, fully tested with fakes.
- Add an EDA-toolchain install step to CI (ubuntu) so the real oracle integration tests (3.8) run and stop skipping.
- Implement the concrete provider transports, an env-backed `SecretManagerPort`, the concrete auth adapter, and DB migrations behind the ports so they activate the moment your secrets/decisions land, without changing the wiring again.

## What I will NOT do until you confirm

- Commit or run the no-mistakes pass (per your instruction: only once everything is real + production quality).
- Hardcode any secret, model ID you have not confirmed, region, or connection string.
- Arm the eval gate.

---

## Update: M1 feature is code-complete and verified (green)

After installing iverilog + yosys locally, a full-suite verification pass was run:
- TypeScript: typecheck + lint + prettier + `npm test` all PASS - 630 tests passed, 6 skipped.
- Python worker: ruff + ruff-format + mypy + pytest all PASS - 33 passed.
- The REAL oracle path now genuinely executes locally: `icarus-oracle` (3.8), `verification-loop` (14.2), and the full `hero-loop` (17.1) run end to end through real iverilog + vvp and pass.

Tasks 1-18 and 19.1-19.4 are complete and verified. The two remaining tasks are the ones gated on real infra, correctly left OPEN:
- 19.5 Arm the eval pass@k gate - needs a real non-zero pass@k measured by the oracle on a Linux host (PR-1). Never fabricate the baseline.
- 20 Final checkpoint - depends on 19.5.

### 6 skipped tests (all environment-provisioning, not defects)
- 5 tests: `app/tools/sandbox/sandbox-containment.integration.test.ts` (task 3.9 adversarial containment) - skip because gVisor `runsc` is not registered with Docker and cannot run on macOS. Needs a Linux host with runsc (PR-1).
- 1 test: the real-render assertion in `app/test/netlistsvg-schematic.integration.test.ts` (task 15.8) - skips because `netlistsvg` is only reachable via `npx`, not as a PATH binary. The capability probe requires a PATH-resolvable binary.

### Added provisioning items (fold into PR-1 / CI)
- PR-8 Install `netlistsvg` as a PATH binary (`npm i -g netlistsvg`) on the host/CI so the real yosys -> netlistsvg schematic render (15.8) runs instead of skipping. This mirrors production, where the worker expects netlistsvg as an installed tool.
- PR-9 CI EDA toolchain: add an install step to the ubuntu CI job for iverilog + vvp + yosys + netlistsvg (+ runsc for the containment job) so the real-oracle and containment integration tests run in CI, not just locally.
