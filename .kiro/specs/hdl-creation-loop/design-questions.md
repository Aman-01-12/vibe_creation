# Design-phase open decisions - hdl-creation-loop (M0 + M1)

These are the genuinely open technical choices from `design.md` that are NOT already fixed by `product-ece/ECE-TECH-DECISIONS.md`.
They are surfaced here for founder annotation per `.kiro/steering/spec-workflow.md`.
Settled decisions (model router, backend-oracle-plus-WASM-live-view, OKF-first knowledge, iCE40/KiCad later) are intentionally excluded because they are not open.

To respond: add your answer and reasoning under each item (or drop an `design-answers.md` in this folder).
Decisions will be folded back into `design.md` via the spec subagent, not hand-edited.

---

## OD-1: Orchestrator and agent-service runtime

Maps to: design.md "Components and Interfaces", "Monorepo layout and stack choices".
Why it matters: it sets the language across the trust boundary, the PBT library, and the streaming and contract style (OD-6, OD-7 depend on it).

- Options:
  - Node/TypeScript: one typed language across web/api/agent, shared types, fast-check, strong SSE; weaker EDA/scientific tooling.
  - Python: closest to EDA/ML ecosystem (cocotb, pyverilog, Hypothesis, model SDKs); a second language and a type boundary with the TS frontend.
  - Split (TS orchestrator + Python tool-runner workers): best language per layer; more operational surface and a serialization contract.
- Recommended: Node/TypeScript orchestrator with thin Python workers only inside the Tool_Runner - one typed language across the trust boundary, EDA glue where Python is strongest.
- Founder answer:

## OD-2: Primary datastore

Maps to: design.md "Data Models", `project-store/`.
Why it matters: per-object authorization, keyset pagination, and durable checkpoints depend on relational integrity; the free tier needs cheap idle cost.

- Options:
  - Postgres on Neon: serverless, branchable (branch per PR for eval fixtures), scale-to-zero; managed-vendor dependency (behind an adapter).
  - Self-managed Postgres: full control; we operate backups, scaling, patching.
  - Document store: flexible trace shape; weaker relational integrity for authz and joins.
- Recommended: Postgres on Neon behind a storage adapter - relational integrity for authz plus branching and scale-to-zero for the free tier and CI eval fixtures.
- Founder answer:

## OD-3: Sandbox isolation technology

Maps to: design.md "Tool_Runner sandbox design".
Why it matters: this is the arbitrary-code-execution surface; container escape is the top-severity risk.

- Options:
  - Docker (hardened: seccomp, dropped caps, non-root, read-only rootfs, no network): simplest; shares host kernel, highest escape severity.
  - gVisor: user-space kernel, smaller syscall surface, modest overhead; some syscall-compat edge cases.
  - Firecracker microVMs: true VM isolation, strong tenancy; heavier startup and orchestration.
  - nsjail: lightweight namespace/seccomp jailing; less turnkey for full toolchain images.
- Recommended: gVisor-wrapped ephemeral containers - materially lower escape risk than plain Docker at acceptable overhead, keeping the container-image workflow; Firecracker is the revisit trigger if tenancy risk or scale grows.
- Founder answer:

## OD-4: Authentication provider

Maps to: design.md "API_Gateway", Req 1.2, 16.5.
Why it matters: short-lived tokens, refresh rotation, and MFA are security-critical and not where to spend build risk.

- Options:
  - Managed auth (Clerk/Auth0-class): fast, MFA + rotation built in, social/edu login; per-MAU cost and vendor dependency.
  - Self-hosted OSS identity server: full control, no per-user cost; we own patching and rotation.
  - Roll our own: maximum control, highest risk; discouraged.
- Recommended: managed auth behind an auth adapter - security-critical primitives handled by specialists, adapter keeps us portable.
- Founder answer:

## OD-5: Waveform rendering library

Maps to: design.md Waveform_Viewer, Req 9.1.
Why it matters: student-scale dumps are small now, but the choice affects how large a design can render responsively later.

- Options:
  - WaveDrom: mature, declarative, community-known; needs VCD-to-WaveJSON transform, less suited to very large dumps.
  - Custom canvas/WebGL renderer: scales to large VCDs and interactive zoom; significant build cost.
  - Existing VCD viewer component: fastest to integrate; fit and licensing vary.
- Recommended: WaveDrom with a VCD-to-WaveJSON adapter - proven and shareable for small single-module dumps; revisit a custom renderer only if dumps outgrow it.
- Founder answer:

## OD-6: Streaming transport

Maps to: design.md "End-to-end hero loop", Req 6.7, 17.6.
Why it matters: the hero loop streams long agent runs; transport affects resilience and future interactivity.

- Options:
  - Server-Sent Events: simplest server-to-client streaming, auto-reconnect, plain HTTP; one-directional.
  - WebSocket: full duplex for future interactive/collaborative features; more infra, own reconnection and auth.
- Recommended: SSE for this slice - the loop is server-to-client progress; reserve WebSocket for later interactive features.
- Founder answer:

## OD-7: Client-to-API contract style

Maps to: design.md "API_Gateway"; depends on OD-1.
Why it matters: it determines whether client types are shared or hand-maintained, and the validation-drift surface.

- Options:
  - tRPC: end-to-end TS types, no schema duplication; couples both ends to TS.
  - REST + OpenAPI: language-agnostic, cache-friendly, standard tooling; hand-maintained client types.
  - GraphQL: flexible querying; overkill for this small action-oriented surface.
- Recommended: tRPC if OD-1 is TypeScript end to end, otherwise REST + OpenAPI - tRPC removes type-duplication only when both ends are TS.
- Founder answer:
