# Implementation Plan: HDL Creation Loop (M0 + M1)

## Overview

This plan implements the M0 (spine skeleton) and M1 (single-module hero loop) slice of the ECE Creation Copilot, plus the Eval_Harness CI gate.
It sequences work so the deterministic oracle path is proven end to end before the agentic loop is layered on top, and so inner layers are built before the outer layers that depend on them.

The build order is:

1. **M0 spine skeleton** (tasks 1-7): the `app/` monorepo, tooling and CI, the core domain types and verdict logic, the sandboxed Tool_Runner with the Icarus oracle, Action_Recorder scaffolding, the API_Gateway boundary, and a minimal Orchestrator + Editor that carries hardcoded Verilog + testbench through the real oracle and back. M0 ends at an explicit integration checkpoint and is independently runnable.
2. **M1 hero loop** (tasks 8-18): Session_Budget and Trust_Labeler, Model_Router, Knowledge_Retriever, Intent and Spec stages with generation gating, Project_Store durability, agentic Generation with the RTL-isolated Testbench, the Verification_Loop bound to oracle provenance, the Display_Layer and visualizations, and conversational Iteration plus Teach_Mode.
3. **Eval_Harness + CI gate** (tasks 19-20): the ratcheting pass@k decision, the VerilogEval/RTLLM subset run through the loop in the sandbox, and the CI gate armed only after a non-zero baseline.

The stack is settled: Node/TypeScript across `web`/`api`/`agent`/`core`, thin Python workers only inside the Tool_Runner, tRPC + Zod at the boundary, SSE over HTTP/2 for streaming, Neon Postgres behind a storage adapter, managed auth behind an auth adapter, gVisor-wrapped ephemeral containers behind the Tool_Runner adapter, and WaveDrom for waveforms.
Dependencies flow inward only: `web` -> `api` -> `agent` -> {`knowledge`, `tools`} -> `core`.

Each of the design's 32 correctness properties is implemented as one property-based test (fast-check for TypeScript, Hypothesis for the Python Tool_Runner workers), placed adjacent to the code it verifies, run at 100+ iterations, and tagged `Feature: hdl-creation-loop, Property {n}: {text}`.

---

## Tasks

### M0 - Spine skeleton (oracle path proof)

- [x] 1. Stand up the `app/` monorepo, tooling, and CI wiring
  - [x] 1.1 Scaffold the `app/` monorepo layout with inward-only dependency boundaries
    - Create `app/core`, `app/knowledge`, `app/tools`, `app/agent`, `app/api`, `app/web`, `app/eval`, `app/test` per the design's monorepo layout
    - Configure the TypeScript project references and an import-boundary lint rule so no inner layer can import an outer layer (`web` -> `api` -> `agent` -> {`knowledge`, `tools`} -> `core`)
    - Add the thin Python worker package skeleton inside `app/tools/sandbox` with its own project config (only place Python exists)
    - _Design: Monorepo layout and stack choices; _Requirements: 17.7_
  - [x] 1.2 Configure lint, type-check, and format tooling plus the CI pipeline gates
    - Wire strict TypeScript, ESLint, and Prettier for the TS layers, and the equivalent lint/type tooling for the Python worker
    - Add a CI pipeline that runs lint + type-check + unit + property tests on every change and blocks merge on failure
    - Add a placeholder eval-gate CI step that is present but disarmed (no non-zero baseline yet), so bootstrapping merges are not deadlocked
    - _Design: Testing Strategy (CI gates); _Requirements: 15.7_
  - [x] 1.3 Set up the property-based testing harness and shared generators
    - Add fast-check to the TS layers and Hypothesis to the Python worker package (do not reimplement either)
    - Create `app/test` shared generators for the prework edge cases: whitespace/unicode identifiers, traversal/absolute/encoded/symlink paths, zero and negative port widths, empty and oversized payloads, injection-marker web content, secret-shaped tokens, and partial output-capture states
    - Establish the property-test tag convention `Feature: hdl-creation-loop, Property {n}: {text}` and a 100+ iteration default
    - _Design: Testing Strategy (Property-based testing)_

- [x] 2. Implement core domain types and verdict logic
  - [x] 2.1 Define the core domain types in `app/core/models`
    - Implement immutable (`readonly`) types: `Project`, `Spec`, `ModuleInterface`, `Port`, `AcceptanceCriterion`, `Testbench`, `ModuleVersion`, `VerificationResult`, `TraceSpan`, `Trace`, `LabeledArtifact`, `Citation`, `SessionBudget`, and the `TrustTier`/`Verdict`/`PortDirection` unions
    - Use ULIDs for identifiers; keep derived state (trust tier) computable, never stored as a second copy of truth
    - Encode the data-model invariants as constructors/refinements (pass requires `allChecksPassed`; `Verified` requires `oracleSpanRef`; `Testbench.sourceAttribution` is always `"spec"`; `Port.width` positive)
    - _Design: Data Models; _Requirements: 5.3, 7.2, 8.10, 14.8_
  - [x] 2.2 Implement verdict classification and pass integrity in `app/core/verdict`
    - Implement the pure function mapping an invocation outcome to exactly one of `pass` / `fail` / `error`, with `error` reserved for tool/infra failure (including timeout), distinct from functional `fail`
    - Implement the pass-integrity rule: a `pass` verdict requires every spec-derived testbench check to pass; a merely completed or partially passing run is never `pass`
    - _Design: Verification loop design; _Requirements: 1.5, 8.7, 8.10_
  - [x] 2.3 Write property test for verdict classification
    - **Property 7: Runner outcomes classify to exactly one verdict, with error reserved for tool/infra failure**
    - **Validates: Requirements 1.4, 1.5, 8.7**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 7: ...`
  - [x] 2.4 Write property test for pass integrity
    - **Property 5: A pass verdict requires all spec-derived checks to pass**
    - **Validates: Requirements 8.10**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 5: ...`

- [x] 3. Build the sandboxed Tool_Runner and the Icarus oracle
  - [x] 3.1 Implement the Tool_Runner adapter and sandbox job/result contract in `app/tools/sandbox`
    - Define the language-neutral `SandboxJob`/`SandboxResult` schema (JSON Schema) at the TS-to-Python seam, validated on both sides
    - Implement gVisor-wrapped ephemeral per-run container creation/teardown behind the adapter: non-root, dropped capabilities, read-only rootfs except workspace, no secrets mounted, no default outbound network, and CPU/memory/process/disk/wall-clock caps
    - Implement the capture-all-or-error classification: capture exit code, stdout, stderr, and required artifacts, and classify the whole invocation `error` if any required output is missing or the wall-clock cap is exceeded
    - _Design: Tool_Runner sandbox design; _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.9_
  - [x] 3.2 Implement the thin Python worker glue and path validation
    - Write the minimal Python worker that invokes `iverilog` + `vvp`, writes workspace files, and returns the job result over the schema
    - Validate every file name/path derived from Spec, model output, or student input before write; confine writes to the workspace and reject/record traversal, absolute, encoded, or symlink-style paths; deny and record out-of-workspace file-system or network operations
    - _Design: Tool_Runner sandbox design; _Requirements: 2.6, 2.7_
  - [x] 3.3 Write property test for capture-all-or-error
    - **Property 8: Capture-all-or-error**
    - **Validates: Requirements 2.4, 2.5, 2.9**
    - fast-check over the TS classification logic, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 8: ...`
  - [x] 3.4 Write property test for sandbox path confinement
    - **Property 9: Generated code stays inside its sandbox workspace**
    - **Validates: Requirements 2.6, 2.7**
    - Hypothesis over the Python path-validation worker, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 9: ...`
  - [x] 3.5 Implement the Simulator adapter (`iverilog` + `vvp`) in `app/tools/simulator`
    - Implement `SimulatorAdapter.simulate(rtl, testbench, limits)` returning a `SimulationVerdict`, driving the Python worker through the Tool_Runner
    - Produce and capture the VCD artifact and per-check pass/fail signalling from the run
    - _Design: Components and Interfaces (Tool_Runner and EDA adapters); _Requirements: 2.5, 8.1_
  - [x] 3.6 Write property test for oracle reproducibility
    - **Property 10: Oracle results are reproducible**
    - **Validates: Requirements 2.8, 15.10**
    - fast-check with a mocked Simulator: this property covers only the logic-level reproducibility assertion, while real-oracle determinism (the same design + testbench run twice through real `iverilog` + `vvp`) is covered by task 3.8 and the Eval_Harness in 19.4; 100+ iterations, tagged `Feature: hdl-creation-loop, Property 10: ...`
  - [x] 3.7 Write sandbox configuration smoke tests
    - Assert containers start with no secrets mounted, no default outbound network, and enforced CPU/memory/process/disk/wall-clock caps
    - _Design: Testing Strategy (Smoke tests); _Requirements: 2.1, 2.2, 2.3_
  - [x] 3.8 Write the real Icarus oracle-path integration test
    - Compile-and-simulate 1-3 representative Verilog + testbench pairs through the real `iverilog` + `vvp` sandbox and assert the pass/fail/error verdict
    - Assert real-oracle determinism: run the same design + testbench twice through the real `iverilog` + `vvp` sandbox and assert an identical verdict, giving Property 10 a non-vacuous real-oracle reproducibility check rather than a mock-only one
    - _Design: Testing Strategy (Integration tests), Tool_Runner sandbox design (Reproducibility); _Requirements: 1.4, 2.8_
  - [x] 3.9 Write the adversarial sandbox containment integration test
    - Run hostile generated code through the real sandbox and assert containment plus Trace recording for each of: an attempted outbound network connection, a fork bomb, a disk-fill attempt, a wall-clock overrun, and an out-of-workspace write
    - Assert each hostile action is denied or killed and that the denial or termination is recorded in the Trace, so containment is exercised against real attacks rather than only smoke-tested from configuration
    - _Design: Tool_Runner sandbox design; _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

- [x] 4. Implement Action_Recorder scaffolding
  - [x] 4.1 Implement the Action_Recorder in `app/agent/action-recorder`
    - Append ordered spans (monotonic `seq`) capturing stage/tool name, sanitized inputs, outputs, exit code, start time, duration, retry count, and cost; record failure classification and recovery attempts in the same Trace
    - Exclude secrets/credentials and redact PII before persistence; persist the Trace for post-session replay and expose an ordered, human-readable history read
    - _Design: Cross-cutting components (Action_Recorder); _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.8_
  - [x] 4.2 Write property test for the Trace
    - **Property 12: Traces are ordered, complete, and PII-redacted**
    - **Validates: Requirements 3.1, 3.3, 3.4, 3.5, 8.8**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 12: ...`

- [x] 5. Implement the API_Gateway boundary
  - [x] 5.1 Implement the API_Gateway in `app/api`
    - Implement authentication behind the managed-auth adapter, Zod payload validation (size, type, schema) on every inbound request, prompt-injection filtering, rate limiting, and a single error-mapper that returns sanitized `ClientSafeError`s (no hosts, IPs, paths, stack traces, or secrets)
    - Enforce per-user and global request rate limiting at the gateway, distinct from the per-session Session_Budget: rate limiting caps request frequency per principal and across the whole service to blunt abuse and unbounded-consumption attacks, whereas the Session_Budget caps agentic work inside a single loop run
    - Configure the managed-auth provider (OD-4) and choose the auth/datastore region (OD-2) for India DPDP and GDPR-style residency because the store holds student PII, keeping the provider and region behind their adapters
    - Expose the tRPC procedures the Editor calls and validate model output as untrusted before it is executed or presented as correct
    - Per-object authorization is stubbed here and completed with the Project_Store in task 12
    - _Design: Components and Interfaces (API_Gateway), Error Handling, Recommended stack (Authentication, Persistence); _Requirements: 1.2, 1.3, 1.6, 17.4, 17.5_
  - [x] 5.2 Write property test for boundary validation and sanitized errors
    - **Property 32: External input and model output are validated at the boundary, and errors are sanitized**
    - **Validates: Requirements 1.3, 1.6, 17.4, 17.5**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 32: ...`
  - [x] 5.3 Write the rate-limiting abuse test
    - Assert per-user and global rate limits reject over-limit request bursts, and that this cap is distinct from and independent of the per-session Session_Budget, covering the OWASP LLM unbounded-consumption class
    - _Design: Components and Interfaces (API_Gateway), Error Handling; _Requirements: 1.2_
  - [x] 5.4 Write the prompt-injection filter efficacy test
    - Drive the gateway's direct prompt-injection filter with the injection-marker generators from task 1.3 and assert injected control content is neutralized before it reaches the Orchestrator
    - _Design: Components and Interfaces (API_Gateway); _Requirements: 1.6_

- [x] 6. Wire the Orchestrator and Editor skeleton (spine)
  - [x] 6.1 Implement the minimal Orchestrator skeleton compile-and-simulate path in `app/agent/orchestrator`
    - Accept a validated Verilog module + matching testbench, run them through the Simulator adapter in the sandbox, record spans via the Action_Recorder, and return a `pass`/`fail`/`error` result bounded by the Tool_Runner sandbox wall-clock cap from task 3.1, so M0 is self-contained and does not depend on the M1 Session_Budget
    - Req 1.4's Session_Budget time limit is fully satisfied later in M1 by the Session_Budget accounting in task 8.1; the M0 skeleton relies solely on the sandbox wall-clock cap because the oracle-path proof needs no agentic budget
    - _Design: End-to-end hero loop (skeleton subset), Tool_Runner sandbox design; _Requirements: 1.4, 1.5_
  - [x] 6.2 Implement the Editor skeleton in `app/web`
    - Build the browser surface that submits a hardcoded Verilog + testbench to the API_Gateway only (never a provider directly), consumes the SSE stream, and renders the pass/fail/error result
    - Stream progress from the SSE feed without blocking the interface, establishing the non-blocking streaming surface the M1 long runs build on
    - _Design: Components and Interfaces (Editor); _Requirements: 1.1, 17.6_

- [x] 7. M0 milestone checkpoint (early integration)
  - Ensure all tests pass, ask the user if questions arise. This is the M0 exit gate: the Editor -> API_Gateway -> Orchestrator -> sandboxed Tool_Runner oracle path runs end to end on hardcoded Verilog + testbench, with run time bounded by the sandbox wall-clock cap (the Session_Budget is introduced later in M1), Action_Recorder spans recorded, and errors sanitized. The slice is independently runnable before any agentic work begins.

### M1 - Single-module hero loop

- [ ] 8. Implement Session_Budget and Trust_Labeler (core)
  - [ ] 8.1 Implement Session_Budget accounting in `app/core/budget`
    - Track consumed iterations, tokens, wall-clock, and cost against caps; expose a budget handle threaded through every model and tool call; signal stop with a recorded reason when any cap is reached, overshooting by at most one in-flight step
    - _Design: Cross-cutting components (Session_Budget), Error Handling; _Requirements: 17.1, 17.2_
  - [ ] 8.2 Write property test for budget termination
    - **Property 18: The Session_Budget always terminates the loop**
    - **Validates: Requirements 6.3, 8.4, 17.1, 17.2**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 18: ...`
  - [ ] 8.3 Implement the Trust_Labeler and tier-to-treatment mapping in `app/core/trust`
    - Assign `Verified` if and only if a passing oracle verdict span exists for the artifact's current version, binding the label to that span ref; assign `Unverified` when none exists and `Not_Applicable` for input/pedagogy artifacts
    - Ensure no writable `verified` flag exists outside this oracle-derived output; define the injective `TrustTier` -> visual treatment mapping with `Verified` treatment reserved to `Verified` artifacts
    - _Design: Verification loop design, Cross-cutting components (Trust_Labeler); _Requirements: 8.3, 14.1, 14.2, 14.3, 14.4, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12_
  - [ ] 8.4 Write property test for oracle-provenance labeling
    - **Property 1: Verified iff a recorded passing oracle verdict exists, with provenance**
    - **Validates: Requirements 4.7, 6.5, 6.6, 8.2, 8.3, 8.5, 8.6, 8.9, 13.8, 13.9, 14.1, 14.2, 14.3, 14.4, 14.7, 14.8, 14.9, 14.12**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 1: ...`
  - [ ]* 8.5 Write property test for distinct trust-tier treatments
    - **Property 3: Trust-tier visual treatments are mutually distinct and Verified is exclusive**
    - **Validates: Requirements 14.6, 14.10, 14.11**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 3: ...`

- [ ] 9. Implement the Model_Router and vendor adapters
  - [ ] 9.1 Implement the Model_Router and per-provider adapters in `app/agent/model-router`
    - Expose one provider-abstracted `invoke(task, request, budget)`; route generation/repair -> DeepSeek V4, orchestration/teaching -> Gemini Flash, escalated hard planning -> Claude; apply bounded fallback/retry under the Session_Budget and record redacted outcomes in the Trace
    - Confine each provider credential to its own adapter, resolved from the secret manager at the point of use; never store credentials in shared router/Orchestrator state, prompts, or inter-service payloads; expose routing diagnostics with redacted references only
    - _Design: Components and Interfaces (Model_Router and vendor adapters); _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10_
  - [ ] 9.2 Write property test for routing and fallback
    - **Property 19: Model routing selects the configured model per task and records fallback**
    - **Validates: Requirements 12.2, 12.3, 12.4, 12.5**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 19: ...`
  - [ ] 9.3 Write property test for credential confinement
    - **Property 11: No secret ever appears outside its vendor adapter**
    - **Validates: Requirements 3.2, 12.6, 12.7, 12.8, 12.9, 12.10, 17.7**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 11: ...`
  - [ ]* 9.4 Write the Model_Router credential smoke test
    - Assert each adapter starts resolving only its own provider's credential from the secret manager and no other
    - _Design: Testing Strategy (Smoke tests); _Requirements: 12.8_

- [ ] 10. Implement the Knowledge_Retriever
  - [ ] 10.1 Author the M1 OKF seed bundle in `app/knowledge/okf-bundle`
    - Author the curated seed concept files as markdown with frontmatter under `app/knowledge/okf-bundle` (HDL patterns, verification recipes, and toolchain notes) that the M1 hero loop needs per `product-ece/ECE-TECH-DECISIONS.md`, so the Knowledge_Retriever traverses a populated bundle rather than an empty one and retrieval is not a no-op
    - Draw the seed content from the `chipAgent/` vault (`domain/hdl`, `verification`, `patterns`), carrying only `status: trusted` material as authority while marking anything unproven as a hint, and keep every file free of secrets and PII
    - _Design: Recommended stack (Knowledge); _Requirements: 13.1, 13.2_
  - [ ] 10.2 Implement the Knowledge_Retriever `retrieve` tool in `app/knowledge`
    - Consult the curated OKF_Bundle before any web search; perform a targeted gap-only web fetch (never a blind crawl) behind the web-fetch adapter; sanitize all retrieved web content against prompt injection before it reaches the Orchestrator; return passages with citations
    - Ensure retrieved knowledge only improves proposals and never overrides the Simulator verdict or affects a Trust_Tier; present external facts as `Cited` when a citation exists and `Unverified` when not, tracked independently of usefulness
    - _Design: Components and Interfaces (Knowledge_Retriever); _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.10, 13.11, 13.12_
  - [ ]* 10.3 Write property test for OKF-first, gap-only, sanitized retrieval
    - **Property 26: Retrieval is OKF-first and gap-only for web, with sanitized untrusted content**
    - **Validates: Requirements 13.2, 13.3, 13.4**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 26: ...`
  - [ ]* 10.4 Write property test for citation labeling
    - **Property 27: Facts are Cited iff they have a citation, independent of usefulness**
    - **Validates: Requirements 13.5, 13.7, 13.10, 13.11, 13.12**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 27: ...`

- [ ] 11. Implement the Intent and Spec stages with generation gating
  - [ ] 11.1 Implement the Intent_Agent (S0) in `app/agent/roles/intent`
    - Produce a structured restatement of intent and constraints, ask bounded clarifying questions, propose a default scope after the bound, propose a single-module reduction when scope is exceeded, and require explicit confirmation; output carries Trust_Tier `Not_Applicable`
    - _Design: Orchestrator roles (Intent_Agent); _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7_
  - [ ]* 11.2 Write property test for bounded clarification
    - **Property 14: Clarification rounds are bounded**
    - **Validates: Requirements 4.3**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 14: ...`
  - [ ] 11.3 Implement the Spec_Agent (S1) and core Spec validation in `app/agent/roles/spec`
    - Produce the Spec (goal, constraints, Module_Interface, testable acceptance criteria) plus a block-level architecture; incorporate pre-approval edits and re-present for approval
    - Validate every interface signal has a name, direction, and positive bit width (reject zero/non-positive), and flag any acceptance criterion not verifiable by simulation/formal/manual inspection with a request for a measurable replacement
    - _Design: Orchestrator roles (Spec_Agent); _Requirements: 5.1, 5.2, 5.3, 5.4, 5.8, 5.9_
  - [ ]* 11.4 Write property test for positive-width port approval
    - **Property 15: Spec approval requires positive-width ports**
    - **Validates: Requirements 5.3, 5.9**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 15: ...`
  - [ ]* 11.5 Write property test for unmeasurable-criteria flagging
    - **Property 16: Unmeasurable acceptance criteria are flagged**
    - **Validates: Requirements 5.4**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 16: ...`
  - [ ] 11.6 Wire the Orchestrator generation gate
    - Enforce that the Generation_Agent is never invoked while intent is unconfirmed or the Spec is unapproved; persist the approved Spec as the source of truth via the Project_Store on approval
    - _Design: Orchestrator roles, End-to-end hero loop; _Requirements: 4.6, 5.5, 5.6, 5.7_
  - [ ]* 11.7 Write property test for generation gating
    - **Property 13: Generation is gated on intent confirmation and spec approval**
    - **Validates: Requirements 4.5, 4.6, 5.5, 5.6**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 13: ...`
  - [ ]* 11.8 Write example/unit tests for intent restatement and spec production
    - Cover restatement quality, scope-reduction prompt, and Spec + architecture production behaviors
    - _Design: Testing Strategy (Example and edge-case unit tests); _Requirements: 4.1, 4.2, 4.4, 5.1, 5.2, 5.8_

- [ ] 12. Implement Project_Store persistence and durability
  - [ ] 12.1 Implement the Project_Store in `app/api/project-store`
    - Persist Spec, sources, Testbench, latest verification result, and Trace to Neon Postgres behind the storage adapter (keyset pagination, Trace spans behind the adapter for future append-optimized store)
    - Write durable checkpoints on Spec approval and on reaching `Verified`; restore only the last integrity-checked checkpoint (never partial mid-run state), fall back to the previous valid checkpoint on integrity failure and surface what could not be recovered, preserve the crash Trace separately, and never auto-re-execute (side-effectful re-run requires explicit approval + idempotency key)
    - Enforce server-side per-object authorization on every project access and automatic restore, decided from a validated token claim (completes the API_Gateway `authorizeObject`)
    - _Design: Cross-cutting components (Project_Store), Error Handling; _Requirements: 5.7, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10_
  - [ ]* 12.2 Write property test for persistence round-trip
    - **Property 29: Project state round-trips through persistence**
    - **Validates: Requirements 5.7, 16.2, 16.3**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 29: ...`
  - [ ]* 12.3 Write property test for crash restore
    - **Property 30: Crash restore loads only the last consistent checkpoint and never auto-re-executes**
    - **Validates: Requirements 16.4, 16.6, 16.7, 16.8, 16.10**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 30: ...`
  - [ ]* 12.4 Write property test for per-object authorization
    - **Property 31: Per-object authorization on project access and restore**
    - **Validates: Requirements 16.5, 16.9**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 31: ...`
  - [ ]* 12.5 Write the IDOR regression suite
    - Integration test asserting a user cannot access or restore another user's project across every project endpoint
    - _Design: Testing Strategy (Integration tests); _Requirements: 16.5, 16.9_

- [ ] 13. Implement agentic Generation and the independent Testbench
  - [ ] 13.1 Implement the Generation_Agent (S4) in `app/agent/roles/generation`
    - Generate candidate Verilog implementing the Module_Interface exactly (no ports absent from the Spec), route through the Model_Router, read Simulator compiler errors and revise within the Session_Budget, and stream progress to the Editor without blocking the interface; present the last failing candidate + errors labeled `Unverified` on budget exhaustion
    - _Design: Orchestrator roles (Generation_Agent); _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 17.6_
  - [ ]* 13.2 Write property test for exact-interface generation
    - **Property 17: Generated module implements exactly the spec interface**
    - **Validates: Requirements 6.1, 6.4**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 17: ...`
  - [ ] 13.3 Implement the RTL-isolated Testbench_Agent (S6) in `app/agent/roles/testbench`
    - Assemble the model context from the Spec, intent, and OKF retrieval only, with no request field that can hold RTL and no shared mutable context with the Generation_Agent; generate a Testbench covering the acceptance criteria plus boundary/error stimulus and known-answer checks for standard blocks, emit unambiguous per-check pass/fail, and record the span attributed to the Spec version
    - _Design: Verification loop design (anti-circular), Orchestrator roles (Testbench_Agent); _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - [ ]* 13.4 Write property test for testbench RTL isolation
    - **Property 4: The testbench generation input never contains the RTL**
    - **Validates: Requirements 7.1, 7.2, 7.7**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 4: ...`
  - [ ]* 13.5 Write property test for acceptance-criterion coverage
    - **Property 6: The testbench covers every acceptance criterion**
    - **Validates: Requirements 7.3**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 6: ...`
  - [ ]* 13.6 Write example/unit tests for testbench signalling and known-answer checks
    - Cover the per-check pass/fail signalling format and known-answer checks for standard blocks
    - _Design: Testing Strategy (Example and edge-case unit tests); _Requirements: 7.4, 7.5, 7.6_

- [ ] 14. Implement the Verification_Loop bound to oracle provenance
  - [ ] 14.1 Implement the Verification_Loop (S7) in `app/agent/orchestrator`
    - Run generation and independent testbench generation in parallel from the approved Spec, compile+simulate the candidate with the Testbench in the sandbox, treat the Simulator verdict as sole authority, record each verdict/iteration/cost span, and iterate generate-simulate-fix under the Session_Budget
    - On a passing oracle verdict request `Verified` from the Trust_Labeler bound to that span (regardless of budget status at run start); on exhaustion present the failing case labeled `Unverified` and hand off to Teach_Mode
    - _Design: End-to-end hero loop, Verification loop design; _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.9_
  - [ ]* 14.2 Write the Verification_Loop integration test
    - Drive a fail -> repair -> pass trajectory and a budget-exhaustion trajectory through the real oracle, asserting the recorded verdicts, iteration count, and resulting Trust_Tier
    - _Design: Testing Strategy (Integration tests); _Requirements: 8.4, 8.5, 8.8_
  - [ ] 14.3 Implement the self-healing failure-recovery loop in `app/agent/orchestrator`
    - Detect a failure signal, classify it into one of syntax error / simulation timeout / tool crash / malformed model output, select a targeted recovery (fix-and-retry, backoff, fallback model, re-plan, or escalate), verify the recovery through the oracle, and record the full detect -> classify -> recover -> verify trajectory, all bounded by the Session_Budget
    - Wire the Verification_Loop, the Model_Router fallback path, and the Action_Recorder together so every failure class maps to a bounded recovery that never blind-retries and always fails safe
    - _Design: Error Handling (self-healing loop); _Requirements: 8.4, 12.5_
  - [ ]* 14.4 Write unit test for the failure-class to recovery mapping
    - Assert each failure class (syntax error, simulation timeout, tool crash, malformed model output) maps to its intended targeted recovery under the Session_Budget, including escalation when a recovery is exhausted
    - _Design: Error Handling (self-healing loop); _Requirements: 8.4, 12.5_

- [ ] 15. Implement the Display_Layer and visualizations
  - [ ] 15.1 Implement the fail-closed Display_Layer in `app/web`
    - Before applying the `Verified` treatment, confirm the label is `Verified` and its `oracleSpanRef` is present and validates against the Trace; on missing/malformed/unvalidatable provenance render `Unverified` and emit a discrepancy event to the Trace; never re-derive correctness
    - Make Trust_Tier visible wherever an artifact is displayed
    - _Design: Verification loop design (Display_Layer fail-closed check); _Requirements: 14.5, 14.13, 14.14, 14.15_
  - [ ]* 15.2 Write property test for the fail-closed Display_Layer
    - **Property 2: Display_Layer fails closed on Verified labels**
    - **Validates: Requirements 14.13, 14.14, 14.15**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 2: ...`
  - [ ] 15.3 Implement the Waveform_Viewer and Schematic_View with independent delivery
    - Render the VCD as a timing diagram via WaveDrom behind a VCD-to-WaveJSON adapter; render the gate/schematic from the verified netlist via the Yosys `write_json` -> netlistsvg synth adapter (`Verified` only) with top-level drill-down for large designs
    - Deliver waveform and schematic independently as each source artifact becomes available; on tool failure/unsupported construct/timeout surface an explicit `unavailable` status with a sanitized reason rather than silently omitting, and never block one on the other or on the verdict
    - _Design: Components and Interfaces (SynthAdapter), Error Handling; _Requirements: 9.1, 9.2, 9.3, 9.5, 9.10, 9.11_
  - [ ]* 15.4 Write property test for visualization trust inheritance
    - **Property 22: Visualizations inherit the trust tier of their source artifact**
    - **Validates: Requirements 9.3, 9.4, 9.12**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 22: ...`
  - [ ]* 15.5 Write property test for independent visualization delivery
    - **Property 23: Waveform and schematic are delivered independently, with explicit unavailable status**
    - **Validates: Requirements 9.7, 9.10, 9.11**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 23: ...`
  - [ ] 15.6 Implement the Live_Run enabled/deferred switch in `app/web`
    - Implement the single slice-scope decision so Live_Run is in exactly one of enabled or deferred; when deferred never compile to WASM and still deliver Waveform + Schematic_View from the backend oracle; when enabled compile with Verilator-to-WASM lazily on first panel use, cache it, never run on the verification path, and never treat a Live_Run result as the correctness verdict
    - _Design: Recommended stack (Live_Run); _Requirements: 9.6, 9.7, 9.8, 9.9_
  - [ ]* 15.7 Write property test for Live_Run scope and authority
    - **Property 24: Live-run is exactly enabled or deferred and never the verdict**
    - **Validates: Requirements 9.6, 9.8, 9.9**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 24: ...`
  - [ ]* 15.8 Write the netlistsvg schematic integration test
    - Generate a schematic from a real verified netlist through the Yosys `write_json` -> netlistsvg path
    - _Design: Testing Strategy (Integration tests); _Requirements: 9.2_
  - [ ] 15.9 Implement request cancellation and the AbortController lifecycle across `app/web` and `app/api`
    - Thread an `AbortController`/cancellation token from the Editor through the API_Gateway into every downstream model and tool call so an in-flight long run can be cancelled; trigger cancellation on component unmount, on navigation away, and on timeout
    - Treat an unmount-driven abort as silent (no user-facing error) and surface a sanitized toast only on a timeout-driven abort; never leak internal details on the cancellation path
    - _Design: Error Handling (streaming and cancellation); _Requirements: 17.6_
  - [ ]* 15.10 Write the cancellation lifecycle test
    - Assert an unmount or navigation abort cancels in-flight downstream calls silently, a timeout abort surfaces a sanitized toast, and no orphaned in-flight work remains after cancellation
    - _Design: Error Handling (streaming and cancellation); _Requirements: 17.6_

- [ ] 16. Implement conversational Iteration and Teach_Mode
  - [ ] 16.1 Implement the Iteration_Agent (S9) in `app/agent/roles/iteration`
    - Apply a requested change, immediately demote the edited `Verified` module to `Unverified` until a fresh passing verdict exists, re-run the full Testbench, and stream progress (optionally showing the intermediate module under `Unverified` with a transient `verifying` status)
    - On an interface-changing iteration update the Spec and regenerate the Testbench from the updated Spec before re-verification; on a regression report it with an offer to revert to the last `Verified` state; present a diff with the new verdict
    - _Design: Verification loop design (Iteration demotion), Orchestrator roles (Iteration_Agent); _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9_
  - [ ]* 16.2 Write property test for edit demotion
    - **Property 20: Editing a Verified module demotes it until re-verified**
    - **Validates: Requirements 10.7, 10.5**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 20: ...`
  - [ ]* 16.3 Write property test for spec-consistent re-verification
    - **Property 21: Iteration re-verifies with a spec-consistent testbench**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 21: ...`
  - [ ] 16.4 Implement Teach_Mode in `app/agent/roles/teach`
    - Explain design choices, waveform readings, and verification results in plain language tied to session artifacts; ground each design-specific claim in verified tool output and each general fact in a citation (both may appear together); label ungrounded claims `Unverified` or do not teach them; coach on the failing case on non-pass; state the simulation-vs-silicon limit whenever presenting a `Verified` result
    - _Design: Orchestrator roles (Teach_Mode); _Requirements: 11.2, 11.3, 11.6, 11.7, 11.8, 11.9_
  - [ ]* 16.5 Write property test for teach-mode grounding
    - **Property 25: Teach-mode grounds each claim by its type**
    - **Validates: Requirements 11.2, 11.3, 11.6, 11.7, 11.8, 11.9**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 25: ...`
  - [ ]* 16.6 Write example/unit tests for teach-mode phrasing and verifying transient
    - Cover teach-mode explanation phrasing including the simulation-vs-silicon limit statement, and the intermediate `verifying` transient treatment
    - _Design: Testing Strategy (Example and edge-case unit tests); _Requirements: 11.1, 11.4, 11.5, 10.6, 10.8_

- [ ] 17. Hero loop integration
  - [ ]* 17.1 Write the full hero-loop integration test
    - Drive intent -> spec approval -> parallel generation + independent testbench -> verification -> visualization -> iteration -> teach end to end through the real oracle, asserting oracle-bound labeling and provenance at the Display_Layer
    - _Design: End-to-end hero loop; _Requirements: 6.6, 8.3, 14.13_

- [ ] 18. M1 milestone checkpoint
  - Ensure all tests pass, ask the user if questions arise. This is the M1 exit gate: the full single-module hero loop runs end to end with oracle-decided correctness, fail-closed provenance, durable persistence, and per-object authorization.

### Eval_Harness + CI regression gate

- [ ] 19. Implement the Eval_Harness and the ratcheting CI gate
  - [ ] 19.1 Implement the ratcheting eval-gate decision in `app/core/eval-gate`
    - Implement the pure block decision: block iff the gate is armed and (measured pass@k strictly below baseline minus tolerance, or at/below the absolute floor); a pass@k equal to baseline never blocks; an unarmed gate never blocks; the baseline only ratchets up except by an explicit reviewed lowering
    - _Design: Correctness Properties (Property 28); _Requirements: 15.4, 15.7, 15.8, 15.9, 15.11_
  - [ ]* 19.2 Write property test for the eval-gate decision
    - **Property 28: The eval-gate block decision follows the ratcheting rule**
    - **Validates: Requirements 15.4, 15.7, 15.8, 15.9, 15.11**
    - fast-check, 100+ iterations, tagged `Feature: hdl-creation-loop, Property 28: ...`
  - [ ] 19.3 Implement the Eval_Harness in `app/eval`
    - Run a fixed VerilogEval/RTLLM subset through the HDL_Creation_Loop inside the Tool_Runner sandbox under the same time/resource caps as a student session, decide each problem with the Simulator oracle, and report + record pass@k, iterations-to-pass, and per-session cost (asserting the pennies-per-session envelope) with fixed seeds/temperature/sample count for reproducibility
    - _Design: Cross-cutting components (Eval_Harness); _Requirements: 15.1, 15.2, 15.3, 15.5, 15.6, 15.10, 17.3_
  - [ ]* 19.4 Write the Eval_Harness integration test
    - Run the fixed subset through the loop in the sandbox and assert reproducible pass@k, iterations-to-pass, and cost under student-session caps
    - _Design: Testing Strategy (Integration tests); _Requirements: 15.1, 15.2, 15.6, 15.10_
  - [ ] 19.5 Arm the eval pass@k gate in CI
    - Record the non-zero baseline established at M1 and arm the CI eval gate against it (using tasks 19.1 and 19.3); keep lint/type/unit/property gates as the merge authority while unarmed
    - _Design: Testing Strategy (CI gates); _Requirements: 15.4, 15.7_

- [ ] 20. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise. All property, example, integration, and smoke tests are green and the eval gate is armed against a non-zero baseline.

## Notes

- Tasks marked with `*` are optional test tasks (property, example, integration, smoke) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each of the 32 correctness properties maps to exactly one property test task, placed adjacent to the code it verifies, run at 100+ iterations, and tagged `Feature: hdl-creation-loop, Property {n}: {text}`. Beyond those property tests, several targeted non-property tests harden specific risks: the adversarial sandbox containment test (3.9), the gateway rate-limiting and prompt-injection efficacy tests (5.3, 5.4), the self-healing failure-class mapping test (14.4), and the cancellation lifecycle test (15.10).
- fast-check covers the TypeScript `web`/`api`/`agent`/`core` layers; Hypothesis covers the thin Python Tool_Runner workers (Property 9).
- Oracle-dependent property tests (5, 7, 8, 10) use a mocked Simulator for the logic-level assertion; real Icarus confidence comes from the integration tests (3.8, 3.9, 14.2, 17.1) and the Eval_Harness (19.4). Property 10's mocked check is deliberately paired with the real-oracle double-run determinism assertion folded into task 3.8 so the property is not vacuous against a mock.
- The OKF seed bundle is authored (task 10.1) before the Knowledge_Retriever is implemented (task 10.2), so the retriever traverses a populated bundle and retrieval is never a no-op.
- Session_Budget timing: the M0 skeleton (task 6.1) bounds its run purely by the Tool_Runner sandbox wall-clock cap from task 3.1, so M0 is self-contained; Req 1.4's Session_Budget time limit is fully satisfied in M1 by the Session_Budget accounting in task 8.1. The task 7 M0 checkpoint does not depend on the Session_Budget.
- Security/quality non-negotiables land as concrete tasks: per-object authz (12.1, 12.4, 12.5), boundary validation + sanitized errors (5.1, 5.2), gateway rate limiting + prompt-injection filtering (5.1, 5.3, 5.4), managed-auth + DPDP/GDPR residency config (5.1, per OD-4/OD-2), sandbox isolation and adversarial containment (3.1, 3.2, 3.3, 3.4, 3.7, 3.9), credential confinement (9.1, 9.3, 9.4), Session_Budget (8.1, 8.2), self-healing failure recovery (14.3, 14.4), request cancellation lifecycle (15.9, 15.10), durable checkpoints + no-auto-re-execute (12.1, 12.3), and the fail-closed provenance check (15.1, 15.2).
- Editor accessibility (WCAG) is intentionally deferred to the web-app design companion doc and is out of scope for this slice; the tasks here cover functional correctness, trust labeling, and security, not accessibility conformance.
- M0 (tasks 1-7) is independently runnable and gated by the task 7 checkpoint before any agentic M1 work begins; no M0 task depends on any M1 task.
- Parallelism guidance: within each dependency wave below, tasks touch distinct files/components and can run in parallel; the core modules that open M1 in wave 7 (budget, trust, router, OKF bundle, project-store) are especially parallelizable once M0 is complete.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "4.1", "5.1"] },
    { "id": 3, "tasks": ["2.3", "2.4", "3.2", "3.3", "4.2", "5.2", "5.3", "5.4"] },
    { "id": 4, "tasks": ["3.4", "3.5", "3.7"] },
    { "id": 5, "tasks": ["3.6", "3.8", "3.9", "6.1"] },
    { "id": 6, "tasks": ["6.2"] },
    { "id": 7, "tasks": ["8.1", "8.3", "9.1", "10.1", "12.1"] },
    { "id": 8, "tasks": ["8.2", "8.4", "8.5", "9.2", "9.3", "9.4", "10.2", "11.1", "11.3", "12.2", "12.3", "12.4", "12.5"] },
    { "id": 9, "tasks": ["10.3", "10.4", "11.2", "11.4", "11.5", "11.6", "13.1", "13.3"] },
    { "id": 10, "tasks": ["11.7", "11.8", "13.2", "13.4", "13.5", "13.6", "14.1"] },
    { "id": 11, "tasks": ["14.2", "14.3", "15.1", "15.3", "15.6", "15.9"] },
    { "id": 12, "tasks": ["14.4", "15.2", "15.4", "15.5", "15.7", "15.8", "15.10", "16.1"] },
    { "id": 13, "tasks": ["16.2", "16.3", "16.4"] },
    { "id": 14, "tasks": ["16.5", "16.6", "17.1"] },
    { "id": 15, "tasks": ["19.1", "19.3"] },
    { "id": 16, "tasks": ["19.2", "19.4", "19.5"] }
  ]
}
```
