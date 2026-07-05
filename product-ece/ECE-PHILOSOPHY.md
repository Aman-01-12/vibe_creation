# Product Philosophy - The End-to-End Agentic Creation Flow (Intent to a Verified, Real Artifact)

> This is the founding philosophy of the whole product, not of any one stage.
> It describes the single agentic workflow that runs end-to-end across every capability we ship (HDL now; embedded, PCB, and chip later).
> PCB layout is one station on this spine, not the spine itself.
> The method is drawn from how modern agentic coding tools build novel things, but adapted to the nuances of the ECE field rather than copied.

## 0. What the product actually is (so the flow serves the right goal)

We are building the agentic + pedagogical layer for ECE students - "Cursor for ECE," a creation copilot, not a course.
The student describes their OWN idea; the product understands the intent, orchestrates existing free symbolic tools (HDL = code, schematic = graph, firmware = code), verifies every result with a real tool, teaches along the way, and carries the design to a real artifact (simulation, FPGA, a fabricated chip, a board).
The moat is agentic intent-understanding + pedagogy + community, not a new simulator or router (see `ECE-STUDENT-PLATFORM.md`, `ECE-GTM-TOOLCHAIN-COMPETITORS.md`).
v1 wedge = the HDL/digital-design lab (intent to Verilog + testbench to simulate to explain/coach to path-to-chip); the same flow later wraps embedded and the chip track (see `ECE-CURRICULUM-ROADMAP.md`, `ECE-V1-FEATURES.md`).

The philosophy below is what makes that promise trustworthy: the reason a cheap model plus a verification loop beats a raw frontier model, and the reason a wrong answer never silently reaches a student.

## 1. The core thesis

Complex, novel artifacts are never produced in one shot.
They are built by an end-to-end loop: capture intent, turn it into a spec, decompose it into small units along a dependency graph, generate each unit, prove each unit against an independent oracle, integrate bottom-up, show the result, iterate, and make it real - recording every step so the system can heal and teach.
The language model proposes and navigates; deterministic tools decide correctness; the student approves and learns at checkpoints.

Novelty is safe under this loop because correctness is judged by a spec-derived oracle, not by whether the model has seen the design before.
That single property is what lets a student build something genuinely new and still trust that it works.

## 2. The one spine - the end-to-end flow (reused at every station)

This is the common workflow. Every capability (HDL, embedded, PCB, chip) is this same loop with a different generator and a different oracle.

- S0. Intent capture and clarification.
  - The student states what they want to build; the agent asks design-partner-style questions to remove ambiguity before anything is generated.
- S1. Spec and architecture (spec as the source of truth).
  - Turn the clarified intent into a structured spec: goal, constraints, interfaces, and acceptance criteria, plus a block-level architecture.
  - The student approves this - which is also the first teaching moment.
- S2. Decompose into a dependency graph with interface contracts.
  - Break the design into units (HDL modules, board sub-circuits, firmware components) ordered by dependency, each with a fixed interface so units build and verify independently.
- S3. Ground with knowledge.
  - Retrieve the facts the step needs (datasheets, standards, known-good snippets) via web search and domain RAG, so generation is grounded, not hallucinated.
- S4. Propose per unit (the LLM's real job).
  - Generate a candidate for one unit at a time (RTL + its testbench, a sub-circuit, firmware), using a read/write/run tool loop.
- S5. Decide with an independent oracle (never self-grade).
  - A real, deterministic tool produces ground truth: compile and simulate a testbench, run ERC/DRC/physics checks, run unit tests.
  - The test must be derived independently of the artifact (from the spec, a golden reference, or formal properties), so the model cannot grade its own bug.
- S6. Integrate bottom-up and verify the composition.
  - Compose verified units and re-verify the whole (top-level testbench, full-board checks), because units passing alone does not prove the system passes.
- S7. Make it visible.
  - Render the result the student can see and show off: waveforms, a gate/schematic diagram, a live in-browser run, a GDS/chip-layout view.
  - This is both the trust signal and a core pedagogy surface.
- S8. Iterate conversationally and teach.
  - "make it 16-bit / add reset / pipeline it" edits and re-verifies; the agent explains why, coaching the student to fix their own errors rather than hiding them.
- S9. Make it real.
  - Export to FPGA, submit to Tiny Tapeout, or produce fab-ready board outputs - the artifact leaves the browser.
- Cross-cutting spine (always on).
  - Record every step as a replayable trace; on failure, classify and self-heal or escalate; cap iterations/tokens/time; put the human at approval checkpoints (see `ECE-RELIABILITY-SELFHEALING.md`).

The point: PCB layout is S4 to S6 for the "board layout" unit.
It is not a separate philosophy; it is this loop with placement+routing as the generator and DRC/physics-checks as the oracle.

## 3. Lessons from agentic coding - learn, do not blindly copy

Coding agents are the closest proven analog, because code, like HDL and firmware, is symbolic and verifiable.
For each practice we take the lesson and then adapt it to ECE, where the differences matter.

- Spec-driven, not vibe-prompting.
  - Coding practice: the modern workflow is specification to design to task-plan to implementation to verification, with the spec as living source of truth, replacing the prompt-code-patch loop.
  - Sources: [Spec-Driven Development vs Vibe Coding](https://www.turingpost.com/p/sdd), [From Code to Contract](https://arxiv.org/html/2602.00180). Rephrased for compliance.
  - Lesson for us: intent becomes an approved spec that drives generation and verification.
  - ECE adaptation: the spec doubles as the teaching artifact and must be student-approved at S1; ambiguous specs are a known failure source for RTL generation, so clarification is not optional.
- Get ground truth from the environment, never from the model.
  - Coding practice: agents assess progress from real tool output (compile, tests, execution), and coding works well because output is objectively checkable. Source: Anthropic, [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents).
  - Lesson: tools decide, the model proposes (already our prime directive).
  - ECE adaptation: the "environment" is not one test suite but a hierarchy of oracles - lint, simulation+testbench, formal properties, synthesis, static timing for HDL; ERC, DRC, SPICE, physics/signal-integrity checks for PCB - and there is a verification-versus-validation gap (passing simulation is not the same as working silicon or a working board).
- Decompose dynamically; mirror the natural hierarchy.
  - Coding practice: orchestrator-workers breaks a task into subtasks whose shape is not known in advance; hierarchical multi-agent RTL work exists because models struggle to replicate the structured reasoning experts use on complex specs.
  - Sources: Anthropic (above), [Hierarchical RTL Multi-Agent Generation](https://arxiv.org/html/2604.14550v2).
  - Lesson: decompose along a dependency DAG with contracts.
  - ECE adaptation: hardware has an unusually clean natural hierarchy (module/block), but evaluating a decoupled sub-task in isolation is genuinely hard, so each unit needs its own oracle and a contract, or integration surfaces surprises. Source: [Backtrack-ToT for RTL](https://arxiv.org/html/2511.13139v1).
- Iterate in a generate-check-fix loop, but guard it.
  - Coding practice: the evaluator-optimizer pattern loops generation against evaluation until it passes.
  - Lesson: iterate to a passing oracle, do not one-shot.
  - ECE adaptation and pitfall: iterative RTL debugging introduces regressions and "repair hallucinations," and intent suffers "semantic drift" as it is reinterpreted across agent handoffs; mitigate with contracts, temporal tracing, re-running prior checks after each fix, and hard iteration budgets. Source: [Contract-Aware Multi-Agent RTL with Formal Verification](https://arxiv.org/abs/2601.19747).
- Prefer correct-by-construction over "let the model guess."
  - Coding/EDA practice: where a value is derivable, compute it; do not ask a model to learn it - Quilter derives differential-pair spacing from the stackup, and correct-by-construction non-textual representations improve Verilog data quality.
  - Sources: [Quilter](https://www.quilter.ai/blog/pcb-autorouter-was-the-right-idea), [Correct-by-Construction Verilog Representations](https://arxiv.org/html/2409.12993v2).
  - Lesson: use parameterized generators, templates, and known-good IP for the parts that are mechanical; reserve the LLM for the novel glue and the intent translation.
- Never let the checker agree with the bug.
  - EDA/LLM practice: LLM-generated assertions can "pass for the wrong reason" (vacuous or self-consistent proofs).
  - Source: [Quality-Aware Formal Verification of LLM RTL Assertions](https://arxiv.org/html/2606.21451).
  - Lesson: independence of the oracle is everything - spec-derived tests, golden-reference differential testing, and formal properties, not tests written from the same buggy artifact (this is our circular-verification rule in `ECE-VERIFICATION-METHODOLOGY.md`).
- Keep the human in the loop and keep budgets.
  - Coding practice: agents pause for human judgment at checkpoints and run under stopping conditions. Source: Anthropic (above).
  - Lesson and ECE adaptation: checkpoints are where the student "sees and decides" (also the pedagogy), and budgets protect our cheap-model-plus-sim economics (see `ECE-TECH-STACK.md`) from runaway loops.

## 4. ECE nuances that reshape the flow (why we cannot just be Cursor)

These are the field-specific realities the generic coding playbook does not account for, and each one changes a stage of the spine.

- Multi-level oracle hierarchy, not a single test suite.
  - Software has "the tests pass." Hardware has a ladder: syntax/lint, functional simulation, coverage, formal properties, synthesis (is it real hardware), and static timing.
  - The flow must pick the right oracle per claim, and escalate (a design that simulates may still fail timing or synthesis).
- Verification is not validation.
  - Matching the spec in simulation is not the same as working in real silicon or on a real board; we must be honest with students about which guarantee they have at each step.
- Continuous and spatial domains resist LLMs.
  - PCB layout, analog, and RF are geometric/physical, not symbolic, so the LLM is the wrong tool for the routing itself; there we orchestrate solvers and physics checks and keep the model to intent, decomposition, and explanation.
- Concurrency and timing are first-class.
  - HDL describes parallel hardware with clocks and timing closure, unlike sequential software; testbenches, resets, and clock domains are core, not edge cases.
- Toolchain friction is the incumbent pain we monetize.
  - Vivado/ModelSim are heavy and hostile to learners, and FOSS synthesis covers only a subset of Verilog; orchestrating these cleanly is itself the value (see `ECE-CURRICULUM-ROADMAP.md`).
- The stakes with a student are asymmetric.
  - A wrong answer does not just fail a build, it mis-teaches and destroys trust; verification is therefore mandatory and the teaching must state its own limits.

## 5. Different ways to achieve each goal (choose deliberately, do not default)

For the stages that matter most, there is more than one credible method.
We list the options and the tradeoff so build-time choices are explicit, not accidental. These extend the open questions in `ECE-TECH-STACK.md`.

- Generation (S4).
  - Frontier general model (best tool-use + teaching; higher cost) vs fine-tuned open RTL model such as RTLCoder/CodeV (cheap/local; narrower) vs template/parameterized generator or known-good IP (correct-by-construction; limited to known shapes) vs HLS from a higher-level description (scales, but its own failure modes).
  - Likely v1: frontier-or-cheap model for the novel glue + generators for the mechanical parts.
- Decomposition control (S2).
  - Single ReAct agent (simple; weak on large designs) vs plan-and-execute vs orchestrator-workers (dynamic subtasks) vs hierarchical multi-agent (matches module hierarchy) vs Tree-of-Thoughts with backtracking (explores alternatives when a decomposition fails).
- Deciding correctness (S5).
  - Simulation + testbench (default, cheap) vs golden-reference differential testing (strong against self-agreement) vs formal properties/model-checking (mathematical, testbench-independent) vs coverage-driven (measures completeness).
  - Layer them; do not rely on simulation alone for anything critical.
- Test authorship, to defeat circular verification.
  - Spec-derived independent testbench vs independent golden reference (small Python/HLS model) vs property-based/random stimulus vs known-answer anchors for standard blocks.
- Iteration and repair (S8).
  - Bounded evaluator-optimizer vs backtracking Tree-of-Thoughts vs re-plan-on-failure; in all cases re-run prior checks to catch repair-induced regressions and cap the budget.
- Knowledge grounding (S3).
  - In-context web search vs curated domain-corpus RAG vs repository-level RTL retrieval vs fine-tuning; start light (web + a small curated store) and grow.
- Make-real (S9).
  - FPGA via nextpnr (fast, reusable) vs ASIC via OpenLane/Tiny Tapeout (the real-chip wow) vs board fabrication for the embedded track.

## 6. PCB in its right place (one station, an instance of the principle)

The PCB layout problem is a vivid example of why the spine is built the way it is, not a separate philosophy.

- Placement and routing are one coupled, NP-hard problem, and completion rate is the wrong objective - a fully connected, DRC-passing board can still be electrically bad. Source: [Quilter](https://www.quilter.ai/blog/pcb-autorouter-was-the-right-idea).
- That is exactly the friend's observation: three or four components route cleanly, but a denser board becomes messy because the search space explodes and the old autorouter cannot reason about the resulting physics.
- So on our spine, the PCB station applies the same rules as every other: decompose the board into functional sub-circuits (S2), fix inter-block nets as contracts, solve placement+routing together per block (S4), verify with DRC + physics checks during generation and prefer correct-by-construction where derivable (S5), integrate and re-check the whole board (S6), render it and let the student see-and-decide, pre-routing the critical nets and letting automation handle the routine ones (S7), and record/self-heal throughout.
- Honest scope: even leading tools target roughly 100 to 1000 components with humans pre-routing the hard parts, so our student-scale boards sit at the tractable end, while dense/high-speed/RF stays assisted-or-manual. This is the same student-scale boundary we drew for HDL.
- Full autorouter background and citations are folded into this section rather than a separate document, so the philosophy stays about the whole flow.

## 7. The unifying statement

One loop, reused everywhere: intent, spec, decompose, ground, propose, decide, integrate, show, iterate, make-real, all recorded and self-healing, with the student approving and learning at each checkpoint.
The model proposes and navigates; independent deterministic tools decide; the human sees and decides at the moments that matter.
Software went from hand-writing assembly and distrusting compilers to specifying intent and trusting the compiler for what it handles well; HDL, embedded, and PCB creation are early on that same arc, and this product's job is to move ECE students along it - safely, because nothing a student is told is ever left unverified.

## Sources
- Anthropic, Building Effective Agents - https://www.anthropic.com/research/building-effective-agents
- Anthropic cookbook, Orchestrator-workers - https://platform.claude.com/cookbook/patterns-agents-orchestrator-workers
- Spec-Driven Development vs Vibe Coding (Turing Post) - https://www.turingpost.com/p/sdd
- From Code to Contract in the Age of AI Coding Assistants (arXiv 2602.00180) - https://arxiv.org/html/2602.00180
- Hierarchical Multi-Agent RTL Generation (arXiv 2604.14550) - https://arxiv.org/html/2604.14550v2
- Backtrack-ToT: Automated RTL Design (arXiv 2511.13139) - https://arxiv.org/html/2511.13139v1
- Contract-Aware Multi-Agent RTL with Temporal Tracing + Formal Verification (arXiv 2601.19747) - https://arxiv.org/abs/2601.19747
- Quality-Aware Formal Verification of LLM-Generated RTL Assertions (arXiv 2606.21451) - https://arxiv.org/html/2606.21451
- Correct-by-Construction Non-Textual Representations for Verilog (arXiv 2409.12993) - https://arxiv.org/html/2409.12993v2
- Quilter, The PCB Autorouter Was the Right Idea - https://www.quilter.ai/blog/pcb-autorouter-was-the-right-idea
- Altium, Autorouting or No Autorouting - https://resources.altium.com/pcb-design-blog/to-autoroute-or-not-to-autoroute-a-history-of-failed-design-automation
- DeepPCB, The 60-Year Routing Problem - https://deeppcb.ai/the-60-year-routing-problem-nobody-solved/
- Yan et al. 2022, ML for Placement and Routing in Chip Design (arXiv 2202.13564) - https://arxiv.org/abs/2202.13564

All external content above was paraphrased and summarized; no more than a short phrase is quoted from any single source, per licensing compliance.
