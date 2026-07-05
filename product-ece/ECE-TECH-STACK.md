# Technical Stack — Accuracy & Knowledge (v1)

## Core principle
Accuracy ≠ a magic model. Accuracy = **frontier model + simulator-in-the-loop verification + domain RAG.**
Every generated design is **proven by simulation**, never just asserted. (This is what generic ChatGPT can't do — and our trust moat.)

## 1. Models
- **Orchestrator / reasoning / teaching:** a frontier general model (Claude / GPT-5.x). Best at agentic tool-use + explanation. Frontier models now hit ~89% VerilogEval / ~96% RTLLM without fine-tuning.
- **HDL generation:** frontier model is sufficient for v1. *Later* option: a specialized/fine-tuned open Verilog model (RTLCoder/CodeV-style, 7B) for cost/local/accuracy on pure generation.
- **Key research finding:** harness/prompt/config settings swing pass-rates ~25% (bigger than model differences) → invest in the *system*, not just model selection.

## 2. The accuracy unlock — verification loop (the coding-agent trick)
Generate Verilog + testbench → run **Icarus Verilog / Verilator** → read failures → fix → repeat until pass.
- Simulator/compiler feedback → **+24% pass rate** (to ~89%).
- Self-correcting testbench frameworks (CorrectBench) → ~88%.
- The simulator = ground truth. This is the moat.

## 3. Knowledge grounding (RAG) — like coding IDEs
- **Web-search tool** in-context (current parts, datasheets, how-tos) — Cursor `@web` style.
- **Domain corpus RAG:** retrieve relevant HDL snippets, standards, datasheet facts into context.
- RAG cuts hallucination 60–80%; domain RAG factual accuracy 0.89 vs 0.68 standalone.
- Repo-level RTL retrieval specifically improves generation.

## 4. Knowledge base sources (copyright-safe first)
- **Open, fair-use Verilog datasets:** FreeSet (220k files, copyright-safe), 131k-module open set, RTLCoder-Data (80k / 7k verified), hdl2v, PyraNet, VeriThoughts (reasoning traces).
- **Open textbooks, standards, datasheets, reference designs** for grounding.
- Use copyright-safe sets to avoid infringement + benchmark contamination; cite sources (trust + pedagogy).

## 5. v1 architecture sketch
```
Student intent
   │
Frontier LLM (orchestrator: architecture, decomposition, teaching)
   │   ├── tool: web_search (datasheets/parts/how-tos)
   │   ├── tool: retrieve (domain corpus: FreeSet/standards/refs)
   │   ├── tool: write Verilog + testbench
   │   └── tool: run simulator (Icarus/Verilator)  ◄── ground truth
   │             │ pass? → show waveform + explain
   │             │ fail? → read errors → fix → loop
   ▼
Verified design → export FPGA / Tiny Tapeout
```

## Open questions to decide at build time
- Which frontier model API to start with (cost vs. HDL accuracy vs. tool-use quality).
- Browser vs. server simulation (WASM Verilator in-browser vs. backend Icarus).
- How much RAG at v1 (start: web search + a small curated snippet/standards store; grow later).


---

## Cost analysis (2026 pricing) — is it affordable?
Flagship models are expensive; cheap-but-capable ones make a free student tool viable.

| Model | $/1M in | $/1M out | Use |
|---|---|---|---|
| GPT-5.5 | 5 | 30 | flagship — avoid for bulk |
| Claude Opus 4.8 | 5 | 25 | flagship — avoid for bulk |
| Gemini 3.1 Pro | 2 | 12 | mid, occasional hard steps |
| Gemini Flash | ~0.30 | ~0.30 | ✅ cheap default |
| **DeepSeek V4** | **~0.14** | **~0.28** | ✅ cheapest, open-weight, > GPT-4o |

**Per design session (~150k in / 50k out):** DeepSeek V4 ≈ **$0.03–0.04**; GPT-5.5 ≈ **$2.25** (~60x). 

**Cost strategy for v1:**
- Default to **DeepSeek V4 / Gemini Flash**; use frontier only for rare hard orchestration (or not at all in v1).
- **Verification loop replaces model cost with compute:** cheap model + free simulator iteration ≈ expensive model one-shot. Pay in sim runs, not tokens.
- **Prompt caching** for repeated system prompt + domain context.
- At scale: **self-host an open 7B Verilog model** (RTLCoder/CodeV) → near-zero marginal cost.
- **Guardrails:** cap agentic iterations, retrieve small focused snippets, cheap-model default. (Uncontrolled loops × big RAG context = cost blowup.)

**Verdict:** pennies per student session on cheap models + simulator loop → viable for a free student product.
