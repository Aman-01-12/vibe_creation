# CTO Tech Decisions - resolving the v1 open questions

Status: decided for v1 (with revisit triggers)
Purpose: resolve the five open decisions in `ECE-PRD-v1.md` Section 19, as cofounder/CTO, biased toward the accuracy bar of current coding agents (not bare-minimum).
Guiding rule (from `ECE-TECH-STACK.md`): accuracy comes from the verification loop + grounded knowledge + a good harness, not from any single model. The harness/config swings HDL pass-rate more than model choice, so we invest in the system and keep models swappable.

---

## Decision 1 - Default model(s): two-tier, provider-abstracted

Decision:
- Route by task behind a thin model-abstraction layer from day one (no hard-coding a single vendor).
- Generation + iteration (bulk tokens): default to DeepSeek V4 (Pro for generation, Flash for cheap repair loops) - open-weight, cheapest viable, strong on code, and self-hostable later for near-zero marginal cost.
- Orchestration + teaching (planning, tool-use, explanation): default to Gemini 3.x Flash (cheap, fast, very large context, strong tool-use), with a frontier model (Claude Opus/Sonnet class) as the fallback for hard planning and repo-scale reasoning.

Why:
- Our accuracy does not hinge on the model; the simulator loop does, so we spend on cheap compute (sim runs) rather than expensive tokens, which is what keeps a free student tier viable (pennies/session per `ECE-TECH-STACK.md`).
- 2026 pricing supports this: DeepSeek V4 Flash is the cheapest viable API and V4 Pro is the best price-to-performance for coding; Claude leads on repo reasoning but is ~10-60x costlier, so reserve it. Rephrased from [AI/ML API 2026 model guide](https://aimlapi.com/blog/top-llm-models-in-2026-the-best-ai-models-for-reasoning-coding-multimodal-tasks).
- Frontier models already hit ~89% VerilogEval / ~96% RTLLM without fine-tuning (per `ECE-TECH-STACK.md`), so a capable-cheap model plus verification closes the gap for student-scale designs.

v1 concrete start: DeepSeek V4 for HDL generation; Gemini 3.x Flash for orchestration/teaching; Claude fallback flag for hard steps. Abstraction layer makes all three swappable per task.
Revisit trigger: eval-harness pass@k or cost/session drifts; a materially better open Verilog model (RTLCoder/CodeV-class) ships; self-hosting becomes worth it at scale.

## Decision 2 - Simulation: hybrid; backend is the oracle, WASM is the live wow

Decision:
- Authoritative verification (the pass/fail oracle, synthesis, formal, timing) runs backend in sandboxed containers (Icarus/Verilator/Yosys) - reliable, bounded, reproducible, secure. This is what the trust promise depends on.
- The live interactive behavior view (edit-and-run, VGA/waveform demo) runs Verilator compiled to WASM in the browser - low latency, the "see it live" pedagogy/wow, and it offloads cheap interactive iteration from the backend.

Why:
- Both paths are proven: ChipVerify Lab runs Icarus/Verilator/Yosys in-browser, and the Verilog Playground pattern compiles Verilator output to WASM via Emscripten. Rephrased from [ChipVerify Lab](https://lab.chipverify.com/) and [Verilog Playground](https://github.com/verilog-playground).
- We must never trust a client-side result as the verdict (can't trust the client, browser resource limits), and we must not force every keystroke through the backend (latency + cost). Splitting by role gets both trust and speed.

v1 concrete start: backend containers for the verdict from M0; add WASM live-run at M1/M2 for the wow.
Revisit trigger: browser WASM proves reliable/bounded enough to also own low-stakes verification; backend sim cost dominates.

## Decision 3 - Knowledge: OKF-first curated bundle + targeted RAG for scale (the accuracy decision)

This is the decision that most affects whether we match current coding-agent accuracy, so it gets the most detail.

Background - what OKF is:
- Google Cloud's Open Knowledge Format (v0.1, June 2026) represents knowledge as a directory of markdown files with YAML frontmatter, one concept per file, cross-linked, with a required `type` field, optional `index.md` for progressive disclosure, `log.md` history, and a `# Citations` convention.
- An agent traverses it deliberately (read the index, follow links) instead of rebuilding context with embeddings on every query; it is git-versioned, human-readable, and portable. Rephrased from the [OKF v0.1 SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) and [OKF: why a folder can beat a vector DB](https://www.thinkingabout.ai/insights/uncategorized/googles-okf-why-a-folder-can-beat-a-vector-db/).

Decision: a hybrid, with OKF as the primary knowledge substrate and embeddings/RAG added only where semantic recall over large unstructured corpora genuinely helps. Both sit behind one `retrieve` tool; the agent chooses traverse-vs-search.
- OKF bundle (primary) for our curated, authoritative domain knowledge: HDL module patterns (counter, FSM, UART, ALU, CPU), interface-contract templates, verification recipes (how to write a spec-derived testbench, assertions, golden-reference diff), toolchain how-tos (Icarus/Verilator/Yosys/nextpnr/OpenLane/Tiny Tapeout), part/datasheet summaries for the embedded track, curriculum-aligned concept notes, and teaching explanations. One concept per file, cross-linked, cited, versioned in git next to the code.
- Embeddings/RAG (secondary) only for the large corpora where fuzzy semantic search wins: the copyright-safe Verilog datasets (FreeSet 220k etc.) for "retrieve a similar known-good module," and big datasheet/standards documents. Repo-level RTL retrieval for "find similar module in this project."

Why OKF-first beats RAG-first for our accuracy:
- Coding agents get their accuracy from reading structured, authoritative context deliberately (a repo, docs), not from fuzzy top-k chunks; OKF gives the agent a curated, linked, citeable knowledge graph it can navigate like a codebase, which is exactly the pattern that raises correctness.
- It is transparent and versionable (fits our doc-heavy, git-driven, no-mistakes workflow), has no per-query vector-DB cost or embedding-drift, and yields traceable citations to the student (trust + pedagogy, which raw RAG chunks do not).
- It is not bare-minimum; it is the current best-practice combination - structured agent-traversable knowledge for precision, plus semantic retrieval for scale - and it also rides a brand-new Google standard as a differentiator.

Honest limits (why we still keep RAG):
- OKF does no semantic search by itself and depends on clean, current, well-structured content; it is a format, not a retrieval engine. For 220k-file recall and large PDFs, embeddings still win, so we keep a thin RAG layer for those.

v1 concrete start: author a small OKF bundle (the HDL patterns + verification recipes + toolchain notes needed for M1), exposed via a `retrieve`/traverse tool; add web-search grounding immediately; add embeddings over the Verilog dataset when "find similar module" is needed (M2+).
Revisit trigger: the OKF bundle grows large enough that traversal alone misses relevant concepts (add embeddings over the bundle itself); retrieval precision measured by the eval harness drops.
Extension: the default-on web-search + LLM-as-brain design, and its full cost/compute/memory/latency/accuracy/security feasibility analysis, is in `ECE-KNOWLEDGE-ARCHITECTURE.md` (three-tier cascade: parametric -> OKF/CAG -> gap-only web -> promote-to-shared-cache).

## Decision 4 - First FPGA target: the open iCE40 flow, ECP5 for bigger designs

Decision:
- Lead with iCE40 via the fully open Yosys + nextpnr flow as the default "make it real on an FPGA" target; add ECP5 (also open, larger, runs soft CPUs) as the bigger-design option.
- Offer a Vivado-project export later for students who already own Xilinx course boards (Basys3/Arty), but it is not v1 core.

Why:
- It matches our whole thesis - orchestrate FOSS, browser-first, students hate heavy closed suites (Vivado/ModelSim); the open flow needs no vendor login and runs headless in our containers.
- iCE40 boards are cheap (~$40 iCEBreaker/Upduino class), the best-supported nextpnr target, and small designs match the student scope; ECP5 (e.g. ULX3S) covers larger projects on the same open toolchain. Rephrased from [open-source FPGA dev notes](https://www.mikekohn.net/micro/open_source_fpga_dev.php).

v1 concrete start: iCE40 bitstream export at M3, same Yosys/nextpnr flow already in the toolchain.
Revisit trigger: design partners overwhelmingly own Xilinx course boards, making a Vivado export path higher priority.

## Decision 5 - PCB engine: KiCad substrate + pluggable RL router (assisted mode)

Decision:
- Use KiCad as the open substrate for the parts we own and trust deterministically: schematic, ERC, DRC, and manufacturing-file export.
- Make routing/placement a pluggable external RL engine, default to the DeepPCB KiCad plugin (free tier, routes inside KiCad, RL-based), with an adapter so Quilter (physics-driven, stronger, commercial/cloud) can be a premium/advanced option; keep classic freerouting only as an offline last-resort fallback.
- Always present candidates + a DRC/physics scorecard + flagged critical nets; never a one-click "trusted" route (per PRD Section 8).

Why:
- We orchestrate, we do not build a router; KiCad gives us free, scriptable, deterministic oracles (ERC/DRC/Gerbers) that we can fully trust, while the hard spatial routing is delegated to the best available RL engines.
- The classic autorouter (freerouting) is exactly the messy-at-scale tool the friend described, so it is a fallback, not the default; modern RL routers (DeepPCB, Quilter) are the state of the art, and DeepPCB now ships a native KiCad plugin. Rephrased from [DeepPCB KiCad plugin](https://deeppcb.ai/deeppcb-kicad-plugin-ai-pcb-routing/) and [Quilter](https://www.quilter.ai/blog/pcb-autorouter-was-the-right-idea).
- Pluggability matters because this space is moving fast; we should not marry one vendor.

v1 concrete start: at M5, KiCad for schematic/ERC/DRC/Gerbers + DeepPCB plugin for assisted routing + our scorecard/critical-net UX.
Revisit trigger: a router clears student-scale boards cleanly enough to raise the PCB trust tier; licensing/cost of a cloud router becomes a blocker.

## Summary table

| # | Question | Decision (v1) |
|---|---|---|
| 1 | Default model | DeepSeek V4 (generation) + Gemini 3.x Flash (orchestration/teaching) + Claude fallback, behind a model router |
| 2 | Sim: browser vs backend | Backend containers = the oracle; Verilator-WASM = live-run wow (hybrid) |
| 3 | RAG depth vs OKF | OKF-first curated bundle + targeted embeddings/RAG for large corpora, one retrieve tool |
| 4 | First FPGA family | Open iCE40 (Yosys+nextpnr); ECP5 for bigger; Vivado export later |
| 5 | PCB engine | KiCad substrate (ERC/DRC/export) + pluggable RL router (DeepPCB default, Quilter premium) |

## Sources
- AI/ML API, Top LLM Models 2026 (pricing/positioning) - https://aimlapi.com/blog/top-llm-models-in-2026-the-best-ai-models-for-reasoning-coding-multimodal-tasks
- OKF v0.1 specification - https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- Google Cloud, How the Open Knowledge Format can improve data sharing - https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing
- OKF: why a folder can beat a vector DB - https://www.thinkingabout.ai/insights/uncategorized/googles-okf-why-a-folder-can-beat-a-vector-db/
- ChipVerify Lab (in-browser Icarus/Verilator/Yosys) - https://lab.chipverify.com/
- Verilog Playground (Verilator to WASM via Emscripten) - https://github.com/verilog-playground
- Open-source FPGA dev (iCE40/ECP5, Yosys/nextpnr) - https://www.mikekohn.net/micro/open_source_fpga_dev.php
- DeepPCB KiCad plugin - https://deeppcb.ai/deeppcb-kicad-plugin-ai-pcb-routing/
- Quilter, physics-driven PCB layout - https://www.quilter.ai/blog/pcb-autorouter-was-the-right-idea

External content was paraphrased and summarized per licensing compliance.
