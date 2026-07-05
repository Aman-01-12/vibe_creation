# Implementation References — build on proven work, don't reinvent

> Reference implementations + papers to consult per building block during development.

## Agentic HDL generation + verification loop (core of v1)
- **AutoChip** — open framework: LLM + Verilog compiler/simulator feedback, iterative generate-and-repair. (our core loop's blueprint)
- "Automating HDL Generation Using LLM Feedback" — compiler/sim context → +24% pass rate.
- **CorrectBench** — automatic testbench generation w/ functional self-validation + self-correction (~88%).
- "Architect in the Loop: Agentic Hardware Design & Verification" — decompose → HDL + cocotb tests → verify w/ human-in-loop.
- Multi-agent RTL verification frameworks (program-generation multi-agent).
- Benchmarks to test against: **VerilogEval, RTLLM, VeriThoughts, Phoenix-bench**.

## Agent architecture patterns
- **ReAct** (Yao et al., 2022) — Think→Act→Observe loop; backbone of production agents.
- **Plan-and-Execute** (plan steps → execute) for multi-step design.
- **Reflection / self-correction** (critique + retry) — pairs with the simulator oracle.
- **Multi-agent orchestration:** Supervisor-Worker, Pipeline, Parallel Fan-out, Debate (different cost/failure profiles).
- Production guides: MLflow "production-ready AI agents 2026"; augmentcode agentic design-pattern catalog.

## RAG / knowledge grounding
- Repository-level RTL RAG (retrieve relevant HDL snippets + fine-tune).
- OG-RAG (ontology-grounded) — +55% fact recall, +40% correctness.
- Standard 5-stage RAG pipeline (ingest→embed→retrieve→augment→generate).
- Datasets/corpus (copyright-safe): **FreeSet (220k), 131k-module set, RTLCoder-Data, hdl2v, VeriThoughts**.

## Caching / cost control
- **Prompt caching** (Anthropic/OpenAI) — cache repeated system prompt + domain context.
- **Semantic caching** — reuse answers for similar queries.
- Guardrail: cap agentic iterations; small focused retrieval.

## Toolchain to orchestrate (FOSS)
- **Icarus Verilog** (easy sim), **Verilator** (~500x faster), **cocotb** (Python testbenches).
- **Yosys** (synthesis), **nextpnr** (FPGA P&R iCE40/ECP5), **OpenLane/OpenROAD** (RTL→GDSII, SkyWater PDK).
- **Tiny Tapeout** templates (real-chip submission).
- ChipVerify Lab = proof the sim toolchain runs in-browser (WASM).

## PCB / embedded track (phase 2)
- NL→schematic: "Multi-Agent LLM framework for circuit schematics," "PCB Schematic from NL Requirements," "Reward-Guided LLM Code Synthesis for PCB w/ structured verification."
- Open agents: **PCBai** (Corning-AI), **assalas/pcb-designer-ai-agent** (KiCad/Altium/Eagle integration).
- Autorouting (spatial → tool, not LLM): **Quilter.ai**, **DeepPCB.ai**, KiCad router.
- Verify: ERC/DRC as the oracle (like the sim loop for HDL).

## App/security architecture
- **Never call LLM APIs from the frontend** — proxy via a backend API layer (rate limiting, cost tracking, response caching, prompt-injection filtering).
- Supervisor + sub-agents in containers with timeout/retry to prevent cascading failures.
- Stack (proposed): React/TS frontend → API layer → agent service → tool runners (sim in containers).

## Principle
Every generated artifact is checked by an **oracle**: HDL → simulator/testbench; schematic/PCB → ERC/DRC. The model proposes; the tool verifies. That's the trust moat and the reason accuracy doesn't hinge on the model alone.


---

## Handling complex ideas: planning & dependency decomposition
Never one-shot a complex design. Mirror coding agents, leveraging HDL's natural module hierarchy.

**Flow:**
1. **Spec/architecture first** — intent → block diagram + module list, each with a defined **interface (ports/protocol)**.
2. **Dependency DAG = the module hierarchy** (top → sub → leaf). Order builds by dependency.
3. **Interface-first contracts** — agree ports up front so modules build independently; **stub/mock** not-yet-built deps (solves "depends on things that come later").
4. **Bottom-up build + verify each module** with its own testbench (unit test) → then **integration testbench** for the composed design. Simulator = oracle at every level.
5. **Living plan** — emergent needs (FIFO, clock divider, arbiter) → add a module node, build+verify, resume.
6. **Context/cost control** — persistent design spec + per-step retrieval of only relevant modules (caps tokens).
7. **Human-in-the-loop checkpoint** — student approves architecture before build (= the teaching moment).

**References/patterns:** "Architect in the Loop: Agentic Hardware Design & Verification" (decompose → HDL + cocotb tests → per-component verify, engineer-in-loop); ReAct; Plan-and-Execute; Supervisor-Worker multi-agent; spec-driven dev (requirements→design→tasks).

**Software→HDL analogy:** function signatures ↔ module ports; unit tests ↔ per-module testbenches; integration tests ↔ top-level testbench; task DAG ↔ module hierarchy.
