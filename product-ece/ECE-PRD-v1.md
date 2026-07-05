# PRD - ECE Creation Copilot, v1 (build-ready)

Status: draft for build
Scope: the product (features, flows, outputs, verification, scope). Web-app UI design and the security/threat-model live in separate companion docs (see Section 15).
Read first: `ECE-PHILOSOPHY.md` (the end-to-end flow), then this PRD.
Supporting docs: `ECE-V1-FEATURES.md`, `ECE-VERIFICATION-METHODOLOGY.md`, `ECE-TECH-STACK.md`, `ECE-IMPLEMENTATION-REFERENCES.md`, `ECE-RELIABILITY-SELFHEALING.md`, `ECE-GTM-TOOLCHAIN-COMPETITORS.md`, `ECE-CURRICULUM-ROADMAP.md`, `ECE-STUDENT-PLATFORM.md`.

How to read this PRD: it is a behavioral contract, not just a feature list.
Each feature states what the user does, what the product does, the expected output, the deterministic oracle that proves the output, the trust tier, the failure modes, the fallback, and what the feature must never do.
This framing is deliberate for an AI product, where behavior is probabilistic and the guarantees live in the verification layer, not the model. Source: [Your AI PRD Is Missing Its Hardest Sections](https://open.substack.com/pub/adalineai/p/ai-prd-missing-sections). Rephrased for compliance.

---

## 1. Summary

We are building the agentic creation copilot for ECE students - "Cursor for ECE," a creation tool, not a course.
A student describes their own idea; the product understands the intent, orchestrates existing free symbolic engines (HDL = code, schematic = graph, firmware = code), verifies every result with a real tool, teaches along the way, and carries the design to a real artifact (simulation, FPGA, a fabricated chip, or a board).
The moat is agentic intent-understanding + pedagogy + community, not a new simulator or router.

v1 runs one end-to-end agentic flow (the spine) across four capability tracks, each shipped at its honest verification tier.
The hero is the fully-verified HDL / chip loop; embedded and PCB ride the same spine at lower trust tiers, clearly labeled.

## 2. Target users and personas

- Primary: undergraduate ECE/EE students (India + global) taking digital-design/HDL, microcontroller/embedded, and VLSI courses, plus their self-driven project work.
- Persona A - "the HDL-lab student": hits Verilog for the first time, fights ModelSim/Vivado, wants to build a counter/FSM/CPU and see it work.
- Persona B - "the maker": does Arduino/ESP32 projects, wants a real gadget (circuit + firmware) that runs.
- Persona C - "the chip-dreamer": wants to design a custom peripheral/CPU and hold a real fabricated chip (Tiny Tapeout).
- Secondary (buyer): departments/labs/instructors who license seats; and alumni who convert to pro later (see `ECE-GTM-TOOLCHAIN-COMPETITORS.md`).
- Distribution: the founder's ECE friends -> campus communities -> ambassadors (location-independent).

## 3. Goals and non-goals

Goals (v1):
- Let a student go from their own idea to a verified, visible, shareable artifact, with teaching at every step.
- Make correctness trustworthy: every claim is backed by a deterministic tool, never the model's opinion.
- Cover the ECE creation journey on one spine (HDL, chip, embedded, PCB) at honest trust tiers.
- Be cheap enough to offer a free student tier (pennies per session; see `ECE-TECH-STACK.md`).

Non-goals (v1):
- Not a course or a set of graded exercises (we are creation-first).
- Not a from-scratch simulator, EDA suite, or autorouter (we orchestrate FOSS engines).
- Not autonomous commercial-scale SoC or dense/high-speed/RF board design (student-scale boundary).
- Not a one-click "trusted" PCB autoroute (see Section 8).

## 4. v1 scope - tracks and trust tiers

Trust tier = how strongly a deterministic oracle can prove the output.
This, not development effort, is what gates what we present as trusted.

| Track | Core output | Oracle | Trust tier | v1 role |
|---|---|---|---|---|
| HDL / digital | synthesizable Verilog + testbench + waveform | sim (Icarus/Verilator), formal, lint | High | Hero |
| Chip | synthesis + GDS + Tiny Tapeout submission / FPGA bitstream | Yosys, OpenLane, STA, nextpnr | High (fab itself is slow/physical) | Hero |
| Embedded | circuit schematic + BOM + firmware + simulation + assembly guide | compile + sim + ERC + SPICE | High (firmware) / Medium (circuit) | Included |
| PCB layout | placement + routing candidates + DRC/physics scorecard + Gerbers | ERC/DRC deterministic; routing spatial | Low (assisted only) | Included, assisted |
| Physical build / fab | wiring/assembly guide, order links, TT submission | none (atoms, weeks, money) | Out of our hands | Guide + submission only |

## 5. Product architecture - the end-to-end spine (the single flow)

Every feature is a stage of one loop, reused per track with a different generator and oracle. Full rationale in `ECE-PHILOSOPHY.md`.

- S0 Intent capture + clarification.
- S1 Spec + architecture (student-approved; source of truth; first teaching moment).
- S2 Decompose into a dependency DAG with interface contracts.
- S3 Ground with knowledge (web search + domain RAG).
- S4 Propose per unit (LLM generates a candidate).
- S5 Decide with an independent oracle (never self-grade).
- S6 Integrate bottom-up + verify the composition.
- S7 Make it visible (waveform, diagram, live run, GDS view).
- S8 Iterate conversationally + teach.
- S9 Make it real (FPGA / Tiny Tapeout / board files).
- Cross-cutting: action recorder + self-healing + budgets + human checkpoints (always on).

High-level system (from `ECE-TECH-STACK.md`, security-hardened in the security companion doc):
```
Browser editor (React/TS)
   -> API layer (auth, rate limit, cost tracking, prompt-injection filtering; never call model APIs from the browser)
      -> Agent/orchestrator service (intent, spec, decompose, teach; ReAct + plan-and-execute + orchestrator-workers)
         -> tools: web_search | retrieve(RAG) | write(HDL/testbench/firmware/schematic) | run(sim/synth/checks in sandboxed containers)  <- deterministic oracles = ground truth
         -> action recorder (replayable trace) + self-healing loop (detect->classify->recover->verify->record, under budget)
```

## 6. Core features (v1)

Priority: P0 = required for first buyable release (hero HDL/chip loop); P1 = in v1, sequenced after hero; P2 = in v1 if time, else fast-follow.
Each feature is a behavioral contract.

### Spine features (shared by all tracks)

#### F1 - Intent capture and clarifying dialogue (P0)
- User does: describes their own idea in natural language ("I want to build a 4-bit CPU / a UART / a soil-moisture logger").
- Product does: asks focused, design-partner-style clarifying questions to remove ambiguity before generating; detects scope that exceeds student-scale and says so.
- Expected output: a short, structured restatement of intent + constraints, confirmed by the user.
- Oracle / verification: human confirmation (this stage is intent, not correctness).
- Trust tier: n/a (input stage).
- Failure modes: vague intent, over-scoped project, contradictory constraints.
- Fallback: ask up to a bounded number of questions, then propose a reasonable default scope and let the user adjust.
- Never: silently assume scope, or start generating before intent is confirmed.

#### F2 - Spec and architecture generation (P0)
- User does: reviews and approves (or edits) the proposed spec.
- Product does: turns intent into a structured spec (goal, constraints, interfaces, acceptance criteria) + a block-level architecture diagram.
- Expected output: an approved spec document + block diagram; this becomes the source of truth for generation and verification.
- Oracle / verification: human approval gate; internal consistency checks (every block has defined interfaces).
- Trust tier: Medium (defines the contract that later oracles enforce).
- Failure modes: spec too vague to test against; missing interfaces.
- Fallback: flag untestable requirements and ask for a measurable criterion.
- Never: proceed to build without an approved spec.

#### F3 - Decomposition into a unit DAG with interface contracts (P0)
- User does: optionally reviews the module/unit breakdown.
- Product does: decomposes the design into units (HDL modules, sub-circuits, firmware components) ordered by dependency, each with a fixed interface; stubs not-yet-built dependencies.
- Expected output: a dependency graph + per-unit interface contracts (ports/nets/signatures).
- Oracle / verification: interface consistency check; the graph compiles/elaborates with stubs.
- Trust tier: Medium.
- Failure modes: wrong decomposition, hidden coupling, sub-tasks that cannot be evaluated in isolation.
- Fallback: backtrack and re-decompose (Backtrack-ToT style) when a unit repeatedly fails.
- Never: one-shot a complex design without decomposition.

#### F4 - Knowledge grounding (web + domain RAG) (P0)
- User does: nothing explicit (can paste a datasheet/link).
- Product does: retrieves the facts each step needs - current parts/datasheets via web search, HDL snippets/standards via domain RAG (copyright-safe corpora; cite sources).
- Expected output: grounded context injected into generation, with citations surfaced to the student.
- Oracle / verification: retrieval relevance; citations shown for factual claims.
- Trust tier: Medium (reduces hallucination; not itself a correctness proof).
- Failure modes: irrelevant retrieval, outdated part data, hallucinated facts.
- Fallback: prefer cited sources; if uncited, mark the claim as unverified.
- Never: present an uncited external fact (part number, pinout) as certain.

#### F15 - Action recorder and self-healing (P0, cross-cutting)
- User does: nothing (optionally views "what failed and how it was fixed").
- Product does: records every step as a replayable span (tool, inputs, outputs, exit code, timing, retries, cost); on failure, classifies and applies targeted recovery under an explicit budget; escalates when stuck. See `ECE-RELIABILITY-SELFHEALING.md`.
- Expected output: a replayable trace per session + automatic recovery from transient/known failures.
- Oracle / verification: the same domain oracle re-run after each recovery attempt.
- Trust tier: n/a (reliability layer).
- Failure modes: infinite repair loops, repair-induced regressions, uncertain-state side effects.
- Fallback: hard iteration/token/time budgets; re-run prior checks after each fix; idempotency keys + approval gate for side-effectful actions.
- Never: blind-retry a side-effectful action (fab submit, order) on timeout.

#### F16 - Project workspace, persistence, export (P0)
- User does: creates/opens a project, edits files, downloads outputs.
- Product does: persists the project (spec, sources, testbenches, results, trace), versions it, and exports the artifact bundle.
- Expected output: a saved, reopenable project + downloadable bundle.
- Oracle / verification: round-trip integrity (export reimports/reopens cleanly).
- Trust tier: n/a.
- Failure modes: lost work on crash.
- Fallback: durable checkpoints so a crash mid-run does not lose progress.
- Never: lose approved user work silently.

### HDL / Chip track (hero)

#### F5 - Agentic HDL generation, module by module (P0)
- User does: watches/steers; approves modules.
- Product does: writes synthesizable Verilog one unit at a time via a read/write/run tool loop, against the F3 contracts.
- Expected output: per-module Verilog implementing the approved spec.
- Oracle / verification: compiles under Icarus/Verilator; passes F6/F7.
- Trust tier: High (only after F7 passes).
- Failure modes: syntax errors, non-synthesizable constructs, spec drift across modules.
- Fallback: read compiler errors -> fix -> re-run, under budget; re-anchor to the spec to fight drift.
- Never: mark a module "done" before its oracle passes.

#### F6 - Independent testbench / spec-derived tests (P0)
- User does: optionally reviews tests.
- Product does: generates the testbench from the spec/intent in a separate step from the RTL; adds golden-reference differential tests and formal properties/assertions where applicable.
- Expected output: an independent test suite that can fail the RTL.
- Oracle / verification: tests are derived from the spec, not the artifact; assertions checked for non-vacuity.
- Trust tier: High (this is what makes verification trustworthy).
- Failure modes: circular verification (test agrees with the bug), assertions that "pass for the wrong reason."
- Fallback: golden-reference model + random/property-based stimulus + known-answer anchors.
- Never: verify RTL with a test written from that same RTL.

#### F7 - Simulation and verification loop (P0)
- User does: sees pass/fail + waveform.
- Product does: runs the testbench in Icarus/Verilator, reads failures, iterates generate->simulate->fix until pass or budget hit.
- Expected output: a pass/fail result + waveform + a short explanation; on pass, the design is proven against the spec.
- Oracle / verification: the simulator is the ground truth.
- Trust tier: High.
- Failure modes: sim timeout, flaky stimulus, unmet spec.
- Fallback: per-tool timeout, bounded iterations; if unmet, present the failing case and coach the student.
- Never: report "working" without a passing simulation.

#### F8 - Visualization (waveforms, gate/schematic diagram, live run) (P0)
- User does: views and shares.
- Product does: renders waveforms; renders the circuit as a schematic (Yosys write_json -> netlistsvg); runs a live in-browser behavior view (Verilator -> WASM) where applicable.
- Expected output: waveform view + gate/schematic diagram + optional live run - the "this is my chip" proof.
- Oracle / verification: rendered from the actual verified netlist/sim output.
- Trust tier: High (derived from verified artifacts).
- Failure modes: huge designs render slowly.
- Fallback: collapse/scope the diagram; render top-level + drill-down.
- Never: visualize an unverified/hand-waved result as if verified.

#### F9 - Conversational iteration (P0)
- User does: asks for changes ("make it 16-bit, add reset, pipeline it").
- Product does: edits the affected units and re-verifies (re-runs F7) automatically.
- Expected output: an updated, re-verified design + a diff explanation.
- Oracle / verification: re-run the full relevant test suite after each change (catch regressions).
- Trust tier: High.
- Failure modes: a change breaks a previously passing unit.
- Fallback: regression re-run + revert to last green state on repeated failure.
- Never: apply a change without re-verifying.

#### F10 - Teach-mode (P0)
- User does: toggles explanations/coaching.
- Product does: explains why (design choices, waveform reading), and coaches the student to fix their own errors; states the limits of each guarantee (verification vs validation).
- Expected output: plain-language explanations tied to the actual design and results.
- Oracle / verification: explanations reference verified artifacts and cited sources.
- Trust tier: n/a (pedagogy), but must not overstate.
- Failure modes: confident wrong teaching.
- Fallback: ground explanations in tool output + citations; say "not verified" when it isn't.
- Never: teach something the oracle did not confirm.

#### F11 - Synthesis and reports (P1)
- User does: requests "is this real hardware?"
- Product does: runs Yosys synthesis, reports gate count/warnings; runs static timing where applicable.
- Expected output: a synthesis report + timing summary + plain-language read-out.
- Oracle / verification: Yosys / STA output.
- Trust tier: High (note FOSS synthesis covers a subset of Verilog - fine for student-scale).
- Failure modes: constructs unsupported by FOSS synthesis.
- Fallback: flag unsupported constructs and suggest synthesizable alternatives.
- Never: claim synthesizable without running synthesis.

#### F12 - Make it real: FPGA + Tiny Tapeout (P1)
- User does: chooses a target; follows the guided submission.
- Product does: exports an FPGA project (nextpnr flow) or prepares a Tiny Tapeout submission (OpenLane GDS via the TT template, passing GDS + Docs actions), and renders the GDS layout.
- Expected output: an FPGA bitstream/project, or a TT-ready repo + GDS view; the student can submit to a shuttle to get a real chip.
- Oracle / verification: nextpnr/OpenLane flow success; TT template CI (GDS + docs actions) green.
- Trust tier: High for the files; the physical chip is out of our hands (shuttle cadence, weeks, cost). Source: [Tiny Tapeout submission guide](https://tinytapeout.com/guides/workshop/wokwi-submit-design/).
- Failure modes: design exceeds a TT tile, flow errors.
- Fallback: report the flow error clearly; suggest scoping to fit a tile.
- Never: imply a fabricated chip is instant or guaranteed to work in silicon (verification != validation).

### Embedded track (P1)

#### F13 - Intent to embedded project (circuit + firmware + sim + assembly)
- User does: describes a gadget; picks a target MCU.
- Product does: proposes a circuit schematic + BOM (datasheet-cited), generates firmware, runs firmware/circuit simulation, and produces a wiring/assembly guide.
- Expected output: schematic + BOM + firmware + simulation result + step-by-step assembly guide.
- Oracle / verification: firmware compiles + simulates (high trust); schematic passes ERC and SPICE where applicable (medium trust); BOM cited.
- Trust tier: High (firmware) / Medium (circuit).
- Failure modes: hallucinated parts/pinouts, unbuildable circuit.
- Fallback: ERC + datasheet citation gate; flag any uncited/uncertain part.
- Never: present a schematic as correct without ERC; never invent a pinout.

### PCB track (P1/P2, assisted-not-trusted) - see Section 8 for the full split.

#### F14 - Assisted PCB layout
- User does: provides board constraints (size, connector positions, mechanical); reviews/routes critical nets; runs the physical build.
- Product does: from the verified schematic, assigns footprints, proposes placement, auto-routes routine nets, generates candidate layouts, runs DRC + physics checks, flags critical nets for the student, and exports Gerbers/drill/pick-and-place.
- Expected output: candidate layouts + a DRC/physics scorecard + a flagged critical-net list + fab-ready files.
- Oracle / verification: ERC/DRC deterministic (high); routing quality spatial/advisory (low).
- Trust tier: Low for routing/placement (assisted); High for ERC/DRC/file export.
- Failure modes: messy/unoptimized routing at higher component counts.
- Fallback: pre-route/lock critical nets first, auto-fill the rest; present multiple candidates + scorecard for human choice.
- Never: present an auto-routed board as verified-good; never hide which nets need human judgment.

## 7. Output artifact bundle (what the student walks away with)

Per successful session, by track:
- HDL / chip: approved spec + block diagram; per-module Verilog; independent testbench; simulation result + waveform; gate/schematic diagram; optional live in-browser run; synthesis + timing report; FPGA project or Tiny Tapeout-ready repo + GDS view; plain-language explanation; replayable trace.
- Embedded: spec; circuit schematic; datasheet-cited BOM; firmware; simulation result; wiring/assembly guide; explanation; trace.
- PCB (assisted): footprint-assigned schematic; ERC report; candidate layouts; DRC + physics scorecard; flagged critical-net list; Gerbers/drill/pick-and-place; explanation; trace.

The deliverable is never "just code" - it is demonstrable, verified, shareable artifacts plus the teaching.

## 8. PCB assisted-not-trusted - the we-do / you-do split

| Stage | Product provides | Student does | Trust |
|---|---|---|---|
| Parts / BOM | components with datasheet citations, footprints, alternates | confirm budget/availability | Medium |
| Schematic (netlist) | schematic from intent (pin-to-pin) | review connections | Medium |
| ERC | runs automatically, reports violations | approve fixes | High (deterministic) |
| Footprint assignment | assigns from BOM | spot-check unusual parts | Medium |
| Board outline / mechanical | applies stated constraints | provide size/connector/mount constraints | Manual input |
| Component placement | proposes functional-group placement | adjust connectors/mechanical | Assisted |
| Routing | auto-routes routine nets; generates candidates | route/review critical nets (power, high-speed, diff pairs, analog, RF) | Low (assisted) |
| DRC + physics | runs checks, shows scorecard | decide on flagged items | High DRC / advisory physics |
| Manufacturing files | Gerbers, drill, BOM, pick-and-place | download and order | Deterministic |
| Assembly / fab | wiring/assembly guide, order links | solder/assemble/bring-up | Out of our hands |

Rule: ERC, DRC, and file export are deterministic, so we own and trust them; placement/routing are coupled, spatial, NP-hard, so we present candidates + scorecard + critical-net flags and let the human decide. This is a verifiability boundary, not a cost one.

## 9. Verification methodology (the trust layer)

Prime directive: the LLM proposes; deterministic tools decide. The model never judges its own correctness. Full detail in `ECE-VERIFICATION-METHODOLOGY.md`.
- Oracle per claim: syntax/lint -> simulation+testbench -> formal/assertions -> synthesis -> timing (HDL); ERC -> DRC -> SPICE/physics (PCB).
- Anti-circularity: spec-derived independent tests, golden-reference differential testing, formal properties, known-answer anchors, random/property-based stimulus.
- Testing our own system: unit/integration tests per tool-runner; an eval harness against public benchmarks (VerilogEval, RTLLM) as a regression suite tracking pass@k, iterations-to-pass, and cost/session; golden traces; CI blocks merges on eval regressions.

## 10. Models and cost (behavioral requirement, not just a choice)

From `ECE-TECH-STACK.md`:
- Accuracy comes from the verification loop, not the raw model - a cheap model + simulator iteration approaches an expensive model one-shot.
- Default to a cheap-but-capable model (DeepSeek V4 / Gemini Flash); use a frontier model only for rare hard orchestration.
- Requirement: per-session cost stays in the pennies range on the default model; the system caps agentic iterations, retrieves small focused context, and uses prompt caching.
- The harness/config swings pass-rate more than model choice, so invest in the system.

## 11. Toolchain (orchestrate FOSS, build almost none of it)

From `ECE-GTM-TOOLCHAIN-COMPETITORS.md` and `ECE-IMPLEMENTATION-REFERENCES.md`:
- Simulate: Icarus Verilog (easy), Verilator (fast), cocotb (Python testbenches).
- Synthesize: Yosys. FPGA P&R: nextpnr (iCE40/ECP5). ASIC RTL->GDSII: OpenLane/OpenROAD on SkyWater 130. Real chip: Tiny Tapeout.
- Diagram: Yosys write_json -> netlistsvg. Live run: Verilator -> WASM in-browser.
- PCB: KiCad + a router + a physics/DRC check layer (assisted mode).
- v1 execution: browser editor + backend containers running the tools reliably; in-browser WASM for the live-run wow.

## 12. Knowledge grounding (OKF-first + gap-driven web + RAG)

Full architecture + feasibility analysis: `ECE-KNOWLEDGE-ARCHITECTURE.md`. Decision rationale: `ECE-TECH-DECISIONS.md` (Decision 3).
- The LLM is the reasoning brain; we feed precise external context per decomposed sub-task (context engineering).
- Three-tier cascade per knowledge need: Tier 0 parametric (free) -> Tier 1 curated OKF cache (cheap, prompt-cached via CAG) -> Tier 2 targeted web search only for gaps (current parts/datasheets/versions) -> Tier 3 distil + promote useful fetches into the shared OKF cache (cited), so repeated topics become near-free.
- RAG (embeddings) only for large corpora (copyright-safe Verilog datasets, big datasheets) and repo-level "find similar module."
- Default web search is ON but gated by the decomposition's declared gaps and served from cache first - never a blind per-project crawl.
- Guardrails: web content is untrusted data (prompt-injection defenses, trusted-source allowlist, sanitization); knowledge improves the proposal, never the verdict (oracle still decides); cite everything fetched.

## 13. Reliability, self-healing, action recorder

Per `ECE-RELIABILITY-SELFHEALING.md`: record every step as a replayable span; detect->classify->recover->verify->record under budget; per-tool timeouts, retries with backoff, circuit breakers; idempotency keys + approval gates for side-effectful actions (fab submit, order); durable checkpoints. The recorder serves runtime self-healing, our debugging, eval/regression, and teaching.

## 14. Non-functional requirements (v1)

- Verifiability: no output is presented as trusted unless a deterministic oracle passed; trust tier is always visible to the student.
- Cost: pennies per session on the default model; hard budget caps per session.
- Latency: interactive; long tool runs stream progress; never block the UI on a long job.
- Reliability: a crash mid-run must not lose approved work (durable checkpoints).
- Isolation: all tool execution runs in sandboxed containers with timeouts.
- Security/privacy: covered in depth in the security companion doc (Section 15); baseline here - never call model APIs from the browser, proxy through the API layer with rate limiting and prompt-injection filtering.
- Accessibility: generated UI and our own UI meet accessibility standards (detail in the design companion doc).

## 15. Companion docs (separate, not in this PRD)

- Web-app design doc (to be written): information architecture, editor UX, visualization panels, teach-mode UX, onboarding, component system (shadcn / Aceternity), accessibility, responsive/mobile.
- Security + code-quality docs (WRITTEN): `ECE-CODE-QUALITY-STANDARDS.md` (stack-adapted standard + AI-generated-code rules) and `ECE-SECURITY-PERFORMANCE-RESILIENCE.md` (hacker-perspective threat model: OWASP 2025 web + API/IDOR + LLM top-10, PII/data-minimization, sandboxing generated-code execution, secrets, production performance p95/p99 + query/API optimization, and network resilience from the team reference doc).

## 16. Success metrics

- Buyable-product signals: activation (share of new users who reach a first verified artifact), time-to-first-verified-artifact, week-4 retention, artifacts shared per user (the "this is my chip" viral loop), invites from friend-community, and design-partner qualitative love.
- Trust/quality signals: verified-pass rate, iterations-to-pass, share of sessions with zero unverified claims surfaced, cost/session.
- Institutional signal: classes/labs piloting; conversion to seat licenses.

## 17. Build sequence (v1, step by step)

Thin end-to-end slice first, then widen. Each milestone ends green in CI with eval passing.
- M0 - Spine skeleton: browser editor + API layer + one backend tool-runner (Icarus) + action-recorder scaffolding; run a hardcoded Verilog + testbench and show pass/fail. (proves the oracle path)
- M1 - Hero loop (HDL): F1-F10 for a single module - intent -> spec -> generate -> independent testbench -> simulate -> waveform + diagram -> iterate -> teach. Eval harness vs VerilogEval/RTLLM wired into CI.
- M2 - Decomposition + integration: F3 multi-module DAG + contracts + integration testbench (build a small CPU/peripheral end-to-end).
- M3 - Make-real (chip): F11 synthesis + F12 FPGA/Tiny Tapeout export + GDS view.
- M4 - Embedded track (F13): circuit + firmware + sim + assembly guide.
- M5 - Assisted PCB (F14 + Section 8): schematic -> ERC -> assisted placement/route candidates + DRC/physics scorecard + Gerbers.
- Throughout: self-healing (F15), persistence/export (F16), teach-mode depth, cost/eval dashboards.
- Validate each milestone with the founder's ECE friends (design partners + first users).

## 18. Risks and mitigations

- Focus risk (competing with a free incumbent per stage): stay one-spine, creation-first; lead with the fully-verified hero loop, not breadth. Source: `ECE-STUDENT-PLATFORM.md`.
- Trust risk (a wrong answer mis-teaches): verification mandatory; trust tier always visible; never present unverified as verified.
- Drift into "another Verilog course": remain creation-first (bring your own idea), not exercise-first. Source: `ECE-GTM-TOOLCHAIN-COMPETITORS.md`.
- Cost blowup (uncontrolled loops x big RAG): budget caps, small focused retrieval, cheap-model default, prompt caching.
- PCB over-promise: assisted-only, human-in-the-loop, honest scope.
- Generated-code quality/security: no-mistakes gate + CI + the security companion doc's controls.

## 19. Open decisions - RESOLVED (see `ECE-TECH-DECISIONS.md`)

All five are now decided for v1 (with revisit triggers) in `ECE-TECH-DECISIONS.md`:
- Model: DeepSeek V4 (generation) + Gemini 3.x Flash (orchestration/teaching) + Claude fallback, behind a model router.
- Simulation: backend containers are the trusted oracle; Verilator-to-WASM powers the in-browser live-run.
- Knowledge: OKF-first curated bundle + targeted embeddings/RAG for large corpora, behind one retrieve tool.
- FPGA: open iCE40 (Yosys+nextpnr) first, ECP5 for bigger designs, Vivado export later.
- PCB: KiCad substrate (ERC/DRC/export) + pluggable RL router (DeepPCB default, Quilter premium), assisted-only.

## 20. Sources
- Anthropic, Building Effective Agents - https://www.anthropic.com/research/building-effective-agents
- Your AI PRD Is Missing Its Hardest Sections (behavioral contract framing) - https://open.substack.com/pub/adalineai/p/ai-prd-missing-sections
- Spec-Driven Development vs Vibe Coding - https://www.turingpost.com/p/sdd
- Tiny Tapeout submission guide - https://tinytapeout.com/guides/workshop/wokwi-submit-design/
- Quilter, The PCB Autorouter Was the Right Idea - https://www.quilter.ai/blog/pcb-autorouter-was-the-right-idea
- Contract-Aware Multi-Agent RTL (arXiv 2601.19747) - https://arxiv.org/abs/2601.19747
- Hierarchical Multi-Agent RTL Generation (arXiv 2604.14550) - https://arxiv.org/html/2604.14550v2

Related internal docs are cited inline throughout. External content was paraphrased and summarized per licensing compliance.
