# Knowledge Architecture - LLM-as-brain + externally-fed context (feasibility analysis)

Status: analysis + decision for v1
Question analyzed (the founder's proposal): make web search default for every project; after the agent reasons and decomposes the project, fetch all the knowledge the parts need from the web, and feed that as external context. Treat the LLM as a brain with broad default knowledge, and externally feed the precise things we bring from the web (and our OKF/RAG layer) for context.

## Verdict up front

- The paradigm is correct and is current best practice: the LLM is a reasoning engine, and accuracy is driven by the context we feed it. This is "context engineering." Keep it.
- One refinement is required: do NOT web-search everything for every project by default. Replace "fetch all knowledge every time" with a gap-driven cascade over a shared, growing cache. This keeps the exact benefit you want (precise external context per decomposed part) while making cost, latency, accuracy, security, and reproducibility all feasible.
- Net: feasible and cheap IF cached, gap-driven, and shared; not feasible (and not even more accurate) if it re-fetches the whole web for every session.

## 1. Why the paradigm is right

- The performance of an LLM is fundamentally determined by the context provided at inference; systematically engineering that context is now a formal discipline. Rephrased from [A Survey of Context Engineering for LLMs](https://arxiv.org/html/2507.13334v1).
- Retrieval is one step in a broader reasoning loop where the agent writes, compresses, isolates, and selects context across tools - not a single blind lookup. Rephrased from [Beyond RAG / Context Engineering](https://towardsdatascience.com/beyond-rag/).
- Reasoning models already blend two modes: rely on retrieved content (context-grounded) and reconcile gaps/conflicts with internal knowledge (knowledge-reconciled). Rephrased from [Rerank Reasoning for RAG](https://arxiv.org/html/2512.18329).
- This is precisely "brain + externally-fed precise context," so the instinct is sound.

## 2. The refinement - a three-tier knowledge cascade, not web-by-default

For each decomposed sub-task (from spine stage S2), the agent declares what knowledge it needs, then draws it in this order, stopping as soon as the need is met:

- Tier 0 - Parametric (free): the model's built-in knowledge for stable fundamentals (how a UART/FSM/counter works, standard Verilog idioms). No fetch.
- Tier 1 - Curated OKF cache (cheap, first external stop): our vetted OKF bundle of HDL patterns, verification recipes, toolchain notes, part summaries, curriculum concepts. Read deliberately (traverse), preloadable as a cached context (see CAG below).
- Tier 2 - Targeted web search (only for gaps): fired only when Tier 0/1 cannot cover the need - current parts, live datasheets, tool versions, or genuinely novel specifics. Scoped to the sub-task, not "everything about the project."
- Tier 3 - Promote to cache: distil each useful fetch into new OKF concept files (with citations). Stable, reusable facts go into the shared bundle; volatile/project-specific facts stay in a project-scoped cache.

The difference from the raw proposal: web search becomes on-demand-per-gap instead of on-by-default-for-everything, and every fetch makes the shared cache smarter so the next student rarely needs the same fetch.

## 3. Mechanisms - when CAG, RAG, or live web

- CAG (Cache-Augmented Generation): preload a bounded, stable knowledge set into the model context and reuse it via prompt/KV caching, sending mostly just the query afterward; it removes retrieval latency and retrieval-selection errors when the knowledge fits and is stable. Rephrased from [When CAG Is All You Need](https://arxiv.org/html/2412.15605v1). Use for our curated OKF core (it is bounded and stable) - this is the cheap, low-latency default.
- RAG (embeddings/semantic search): use only for large unstructured corpora where recall matters (the 220k-file Verilog datasets, big datasheet PDFs) - "find a similar known-good module."
- Live web: use only for Tier-2 gaps (current/volatile facts). Highest latency and risk, lowest priority.
- All three sit behind one `retrieve` tool; the agent picks traverse (OKF/CAG) vs search (RAG) vs fetch (web). Hybrid routing is the pattern most teams ship.

## 4. Feasibility across every factor

| Factor | Web-by-default (raw proposal) | Gap-driven + cached (recommended) |
|---|---|---|
| Token cost | high - large fetched context fed every session | low - stable core is prompt-cached (CAG); only small distilled deltas added |
| Search/fetch cost | high - many searches per project, every run | near-zero on cache hits; pay only for genuinely new topics |
| Computation | search + scrape + clean + embed + distil every time | one-time distil per new topic, then cached; reused across all users |
| Context-window / accuracy | dumping "all knowledge" causes context-rot and lost-in-the-middle, and external noise can hurt reasoning | select + compress to the few concepts a sub-task needs; higher accuracy |
| Storage/memory | n/a | OKF cache is markdown in git/object store - tiny, versionable, cheap |
| Latency | 3.5-9s per fetched page stacks up per sub-task | cache hits skip fetching; remaining fetches run in a parallel upfront research phase with a progress UI |
| Accuracy | grounding helps, but web staleness/conflict can degrade answers | vetted-source priority + conflict reconciliation; web is last resort |
| Determinism / replay | web changes -> non-reproducible runs | cached snapshot per project -> reproducible, and works with our action-recorder + eval golden traces |
| Security | large untrusted-web ingestion = big prompt-injection / exfiltration surface | minimized fetch surface + strict untrusted-content handling (Section 6) |

Notes on the hard limits:
- Latency: fetching and cleaning a full page averages several seconds, so stacking fetches before generation is multi-second to minutes; caching and parallelism are the only way to keep it acceptable. Rephrased from [Why calling a search API is only the beginning](https://tianpan.co/blog/2026-04-17-live-web-grounding-production-pipeline).
- Accuracy: more context is not always better - external context can help or hurt, and long dumped contexts degrade retrieval, so selection and compression matter more than volume. Rephrased from [When External Context Helps and Reasoning Hurts](https://arxiv.org/html/2602.09442v1).

## 5. The economics unlock (why caching makes it feasible)

- Without caching, knowledge cost scales with the number of sessions: O(sessions).
- With a shared, growing OKF cache, cost scales with the number of unique topics ever researched: O(unique topics).
- ECE fundamentals are highly repeated and stable (UART, SPI, FSMs, common MCUs, standard parts), so after an initial warm-up the great majority of sessions are cache hits that cost ~0 for knowledge and add ~0 latency.
- This is what keeps the pennies-per-session target intact (see `ECE-TECH-STACK.md`) even with grounding on.

## 6. Guardrails (non-negotiable)

- Web content is untrusted data, never instructions. Browsing/search agents are demonstrably vulnerable to indirect prompt injection, domain-validation bypass, and credential/data exfiltration, with high attack success rates in adversarial settings. Rephrased from [The Hidden Dangers of Browsing AI Agents](https://arxiv.org/html/2505.13076v1) and [Automated Red-Teaming for LLM Search Agents](https://arxiv.org/html/2509.23694v1).
  - Fetched content is sandboxed, stripped of active instructions, and must never be able to trigger tool calls, reveal secrets, or change the agent's goals.
  - Prefer an allowlist of trusted ECE sources (vendor datasheets, standards, official docs) over the open web.
  - Filter and label retrieved content at the API layer (full controls live in the security companion doc).
- Knowledge improves the PROPOSAL, never the VERDICT. Web/OKF/RAG make generation better, but correctness is still decided by the deterministic oracle (simulator/ERC/DRC), never by retrieved text. This preserves the prime directive in `ECE-VERIFICATION-METHODOLOGY.md`.
- Cache what you use, cite what you fetch. Every promoted concept carries citations (OKF has a citations convention) for trust, teaching, and reproducibility.

## 7. How it plugs into the spine

- S2 decompose: each unit declares its knowledge needs.
- S3 ground: run the Tier 0 -> 1 -> 2 cascade per need; fetch only gaps; run fetches in parallel with a visible research step.
- Promote: distil fetched facts into OKF concepts; stable ones to the shared bundle, volatile ones to the project cache.
- S4+ propose/verify: feed only the selected, compressed concepts into generation; the oracle still decides.

## 8. v1 decision and revisit

Decision:
- Adopt LLM-as-brain + externally-fed context via the three-tier cascade (Tier 0 parametric -> Tier 1 OKF/CAG -> Tier 2 gap-only web -> Tier 3 promote-to-cache), with CAG for the stable core, RAG for large corpora, and live web only for gaps, all behind one retrieve tool.
- Default web search is ON as a capability but gated by the decomposition's declared gaps and served from cache first - not a blind per-project crawl.

v1 concrete start:
- Ship the OKF core + CAG prompt-caching + web-search-for-gaps at M1; add embeddings/RAG over the Verilog corpus at M2+.
- Instrument cache hit-rate, cost/session, added-latency, and grounded-accuracy in the eval harness.

Revisit trigger:
- Cache hit-rate stays low (knowledge too diverse) -> widen the shared bundle or add bundle-level embeddings.
- Grounded-accuracy or injection-safety metrics regress -> tighten sourcing/allowlist.

## Sources
- A Survey of Context Engineering for LLMs - https://arxiv.org/html/2507.13334v1
- Beyond RAG: Context Engineering and Semantic Layers - https://towardsdatascience.com/beyond-rag/
- A Lightweight Rerank Reasoning Strategy for RAG (context-grounded vs knowledge-reconciled) - https://arxiv.org/html/2512.18329
- When Cache-Augmented Generation Is All You Need - https://arxiv.org/html/2412.15605v1
- When External Context Helps and Reasoning Hurts - https://arxiv.org/html/2602.09442v1
- Why Calling a Search API Is Only the Beginning (grounding latency) - https://tianpan.co/blog/2026-04-17-live-web-grounding-production-pipeline
- The Hidden Dangers of Browsing AI Agents (prompt injection, CVE) - https://arxiv.org/html/2505.13076v1
- Automated Red-Teaming for LLM Search Agents - https://arxiv.org/html/2509.23694v1

External content was paraphrased and summarized per licensing compliance.
