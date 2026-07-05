# Design-phase answers - hdl-creation-loop (M0 + M1)

Answers to the open design decisions in `design-questions.md`, for folding into `design.md` via the spec subagent (not hand-edited).
Every recommendation in `design-questions.md` was pressure-tested independently and all seven are accepted; the value below is the confirming reasoning plus specific caveats and revisit triggers that the design doc should record.
Conventions follow `AGENTS.md`: plain dashes, one sentence per line.

---

## OD-1: Orchestrator and agent-service runtime

### Decision
Node/TypeScript for the Orchestrator, Model_Router, and control plane, with thin Python workers only inside the Tool_Runner.

### Reasoning
- A language boundary is unavoidable in either option, so the right question is where to place it, not how to avoid it.
- With TypeScript across web, api, and agent, the only language seam coincides with the sandbox isolation boundary, which already requires a strict, narrow, validated job/result contract for security, so making it a language seam costs almost nothing.
- The Python-orchestrator option would instead put the seam at the browser-to-API boundary and lose end-to-end shared types across web and api (no tRPC), increasing client-contract drift on the chatty, streaming, trust-labeling control plane.
- This slice uses Verilog testbenches (iverilog plus vvp), not cocotb, so the "Python is closer to EDA" argument mostly applies to the Tool_Runner, which is already Python; pyverilog and cocotb remain available in the sandbox for later tracks.
- Model provider SDKs (DeepSeek, Gemini, Claude) are first-class in TypeScript, and fast-check supports the 32 property tests.

### Additions to record in design.md
- State explicitly that the TS-to-Python seam lives at the Tool_Runner boundary and is defined by a language-neutral job/result schema (see OD-7 note).
- Keep Python workers minimal (EDA glue only: invoke iverilog/vvp/Yosys, parse VCD), so the trust-boundary logic stays in one typed language.

---

## OD-2: Primary datastore

### Decision
Postgres on Neon, behind a storage adapter.

### Reasoning
- Per-object authorization, keyset pagination, and durable checkpoints all depend on relational integrity, which is exactly Postgres's strength.
- The Trace is well-structured (ordered spans with fixed fields), so a document store's "flexible shape" is not a real benefit and would weaken the relational integrity that authz and joins need.
- Neon adds scale-to-zero (cheap idle cost for a free student tier) and branch-per-PR (a natural fit for CI eval fixtures), and Neon is standard Postgres, so the adapter keeps migration to any Postgres low-friction.
- Self-managed Postgres adds backup, scaling, and patching burden to a small team with no offsetting benefit at this stage.

### Additions to record in design.md
- Data residency: choose a Neon region consistent with India DPDP and GDPR-style expectations, because the store holds student PII.
- Keep Trace-span persistence behind the storage adapter so high-volume spans can move to an append-optimized store later without touching callers.

---

## OD-3: Sandbox isolation technology

### Decision
Start on gVisor-wrapped ephemeral containers, behind the existing Tool_Runner adapter.

### Reasoning
- This is the arbitrary-code-execution surface and container escape is the top-severity risk, so plain hardened Docker (shared host kernel) is the one clear rejection for running arbitrary public-user code.
- gVisor's user-space kernel materially shrinks the host syscall attack surface at acceptable overhead while keeping the simple container-image workflow, and the EDA workloads (CPU plus file, no network) are unlikely to hit its syscall-compat edge cases.
- Firecracker gives true VM isolation but adds VMM orchestration surface that is more than a thin slice with early users needs right now.

### Additions to record in design.md
- Because the free tier is designed to grow into hostile multi-tenancy, treat VM-level isolation as a near-term roadmap item, not a distant maybe.
- Record Kata Containers (VM isolation with container ergonomics) as an upgrade path alongside raw Firecracker, both reachable via the Tool_Runner adapter.
- Emphasize that the layered controls (no default network, no secrets mounted, non-root, read-only rootfs, dropped capabilities, seccomp, CPU/memory/process/disk/wall-clock caps) provide most of the protection regardless of the isolation technology.

---

## OD-4: Authentication provider

### Decision
A managed auth provider behind an auth adapter.

### Reasoning
- Roll-your-own is correctly discouraged, because sessions, rotation, and MFA are exactly where self-built security fails (OWASP A07).
- Managed auth delivers short-lived tokens, refresh rotation, MFA, and social/edu login built by specialists, which is where a small team should not spend build or security risk.
- The adapter preserves portability, so a later move to self-hosted OSS is localized.

### Additions to record in design.md
- Prefer a provider with strong OIDC and SAML support, because the institutional GTM will later need campus SSO and possibly LMS/LTI, and self-hosting SAML is painful.
- Mind PII residency for student emails (same DPDP and GDPR consideration as OD-2).
- Set a concrete revisit trigger: if free-tier per-MAU auth cost approaches per-session compute cost, migrate to a self-hosted OSS identity server (Ory or Supabase-class) via the same adapter.

---

## OD-5: Waveform rendering library

### Decision
WaveDrom with a VCD-to-WaveJSON adapter, behind the Waveform_Viewer interface.

### Reasoning
- Student-scale single-module dumps are small, so WaveDrom's large-dump weakness is out of scope for this slice.
- WaveDrom is mature, HDL-community-standard, and emits clean SVG, which suits both the teaching goal (curated, annotated waveforms rather than raw thousand-cycle dumps) and the "this is my chip" sharing loop.
- Building a custom renderer now would spend build cost on something that is not the moat (the moat is the agentic loop plus verification plus teaching).

### Additions to record in design.md
- Keep the Waveform_Viewer behind an interface so a future swap is localized.
- For the future large-dump case (M2 and beyond), prefer an existing scalable web VCD viewer (a Surfer or WASM-class viewer) over building custom, consistent with reuse-first.

---

## OD-6: Streaming transport

### Decision
Server-Sent Events (SSE) for this slice.

### Reasoning
- The hero loop is server-to-client progress streaming (generation progress, simulation results, teach explanations), which is exactly SSE's sweet spot, and client-to-server actions (intent, approve, iterate) stay discrete POSTs.
- SSE runs over plain HTTP with auto-reconnect and simple token auth, and it pairs with resumable streams via checkpoints.
- WebSocket's full duplex is only needed for future interactive or collaborative features and adds infrastructure, its own reconnection, and its own auth handshake that this slice does not need; the in-browser Verilator-WASM live-run needs no WebSocket either.

### Additions to record in design.md
- Use HTTP/2 so concurrent SSE streams plus normal requests do not hit the HTTP/1.1 six-connection-per-domain limit.
- Support Last-Event-ID for resumable streams, tying into the action-recorder and durable checkpoints.
- Reserve WebSocket for genuinely bidirectional future features.

---

## OD-7: Client-to-API contract style

### Decision
tRPC, because OD-1 resolves to TypeScript end to end.

### Reasoning
- With TypeScript on both web and api, tRPC gives end-to-end types with no schema duplication and no client-type drift, which is a direct correctness and velocity win.
- REST plus OpenAPI's main advantage is being language-agnostic, which buys little when there is no non-TS consumer or backend, and the surface is action-oriented and streaming rather than cache-heavy.
- GraphQL is overkill for this small, action-oriented surface.

### Additions to record in design.md
- Critical: tRPC types are erased at runtime, so the API_Gateway still performs runtime schema validation (Zod) on every inbound payload; tRPC plus Zod gives both static types and runtime validation, satisfying validate-untrusted-input-at-the-boundary.
- tRPC v11 SSE subscriptions compose with the OD-6 streaming choice.
- The TS-to-Python Tool_Runner seam is a separate internal contract, not part of OD-7; define it with a language-neutral schema (JSON Schema or protobuf), since tRPC cannot span the language boundary.

---
