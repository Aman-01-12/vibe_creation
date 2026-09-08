---
inclusion: always
---

# Engineering Standards - non-negotiables + where the full docs live

This is the always-on core. It is intentionally short. The full standards live in `product-ece/` and are pulled on demand (map below); `fileMatch` steering auto-loads the right one when you touch the right files.

## Non-negotiables (apply to every change, ours and agent-generated code)

- Tools decide correctness, not the model. Every generated artifact is verified by its deterministic oracle (simulator/tests/ERC/DRC) before it is called correct; unverifiable output is labeled, not trusted.
- Validate all external input at every trust boundary: client payloads, files, API responses, model output, and retrieved web content are untrusted until validated.
- Server-side authN + authZ on every endpoint, including per-object checks (IDOR/BOLA). Never use client state, UI visibility, or model output as a security control.
- Secrets never appear in source, client bundles, prompts, logs, errors, or traces. Use env/secret manager; they are gitignored.
- All agent-generated code executes only in a sandbox (isolated container, no secrets, no default network, resource-capped).
- Side-effectful actions (fab submit, order, payment, deletes) use idempotency keys + an approval gate; never blind-retry on timeout.
- Errors are sanitized to the client (no internal hosts/IPs/stack traces); every failure path is handled and fails safe.
- No: silent catch, magic numbers/strings, god objects, commented-out code, public mutable fields, `eval` of model output, `sleep()` as sync, hardcoded secrets, returning null for a collection.

## Self-check (catches fileMatch misses - do not rely on auto-load alone)

fileMatch steering is best-effort and will miss some files. So, regardless of whether a steering file auto-loaded:
- If you are writing/reviewing code in ANY language, the non-negotiables above apply, and you should read `product-ece/ECE-CODE-QUALITY-STANDARDS.md` if you have not this session.
- If the change touches anything server-side, data, auth/permissions, payments, uploads, sessions/tokens, crypto/secrets, networking, or executes generated code, read `product-ece/ECE-SECURITY-PERFORMANCE-RESILIENCE.md` and apply it - even if the security steering did not fire.

## Read-the-full-doc map (pull on demand)

| When you are... | Read |
|---|---|
| writing/reviewing any code | `product-ece/ECE-CODE-QUALITY-STANDARDS.md` (auto-loads on source files) |
| touching API/auth/DB/tool-runner/network/perf code | `product-ece/ECE-SECURITY-PERFORMANCE-RESILIENCE.md` (auto-loads on those files) |
| designing the agent/verification loop | `product-ece/ECE-VERIFICATION-METHODOLOGY.md` |
| planning knowledge/retrieval/RAG | `product-ece/ECE-KNOWLEDGE-ARCHITECTURE.md` |
| designing prompts, the agent harness, or the context/retrieval strategy | `product-ece/ECE-CONTEXT-ENGINEERING.md` (auto-loads on agent/prompt/harness files) |
| doing architecture/spec/feature scope | `product-ece/ECE-PRD-v1.md`, `product-ece/ECE-PHILOSOPHY.md`, `product-ece/ECE-TECH-DECISIONS.md` |
| reliability/self-heal/idempotency work | `product-ece/ECE-RELIABILITY-SELFHEALING.md` |

## Knowledge & memory (the chipAgent Obsidian vault)

Consult `chipAgent/MANIFEST.md` before re-deriving anything about this repo from the codebase; capture new learnings as `candidate` notes in `chipAgent/_inbox/`.
The full rules (when consulting is mandatory, how to read `candidate` vs `trusted`, capture format, and the build-time-only guardrail) live in the always-on `.kiro/steering/knowledge-memory.md`.
That file is the single source; do not restate its rules here.

## Two separate planes (do not conflate)

- Build-time guidance (this file + `coding.md` + `dev-tooling.md` + the fileMatch steering + `AGENTS.md`): governs how WE build the product; read by Kiro and, via `AGENTS.md`, by external agents (no-mistakes/gnhf).
- Product-runtime knowledge (the OKF bundle + the product's own system prompt + CI/SAST config): governs what the SHIPPED product's agent knows and enforces on generated code. Delivered through the product, not through Kiro steering.
