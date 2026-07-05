# Obsidian Vault - Knowledge Base + Continuous-Learning Memory

Status: design + setup plan (wiring pending the vault path)
Question: we initialized an Obsidian vault; how do we use it to maximize output quality and continuous learning across development, for accuracy of generated code and of task generation/execution.
Scrutiny first: the research is clear that the win is not a bigger memory, it is continuity and curation; an uncurated archive hurts. Design accordingly.

## Why an Obsidian vault fits (and the one thing it must not become)

An Obsidian vault is plain markdown + YAML frontmatter + wikilinks + backlinks + tags + a graph. That is the same shape as the OKF knowledge format we already chose (`ECE-KNOWLEDGE-ARCHITECTURE.md`), so the vault can be the authoring surface for our knowledge and an agent-traversable store at once. Karpathy's "LLM wiki" pattern is exactly this: a structured markdown vault an agent continuously turns into an interconnected knowledge base. Rephrased from [Karpathy LLM wiki / Obsidian](https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-obsidian-codeex-second-brain).

What it must NOT become: a giant archive of everything the agent ever saw. Coding agents do not need a bigger memory so much as operational continuity - what already failed, where the last run stopped, which paths were dead ends, whether validation actually ran. A bigger note store or vector dump misses the one fact that mattered. Rephrased from [continuity over memory](https://medium.com/techtrends-digest/maybe-coding-agents-dont-need-a-bigger-memory-maybe-they-need-continuity-156cf4fc2e73).

## Three roles the vault plays (kept distinct)

Separate the three things agents need; conflating them is a known failure. Rephrased from [Agent memory vs context engineering](https://www.augmentcode.com/guides/agent-memory-vs-context-engineering).

1. Agent memory (durable learnings across sessions) - decisions, gotchas, dead-ends, verification recipes. This is the NEW role the vault fills.
2. Authoring surface for the OKF knowledge bundle (product-runtime knowledge) - HDL patterns, toolchain notes, part summaries; the same markdown doubles as the OKF bundle we ship.
3. Human second brain / engineering journal - where we think, link, and review.

These are distinct from, and must not replace:
- Context file = conventions and standards = our `.kiro/steering/*` + `AGENTS.md` (already done).
- Living spec = current feature state = `ECE-PRD-v1.md` + the spec tasks.
- Deterministic oracle = correctness = the simulator/tests/ERC/DRC. The vault never overrides this.

## The continuous-learning flywheel (execute -> capture -> curate -> gate -> retrieve -> prune)

Modeled on the execute/coach/distill/improve flywheel, hardened for our constraints. Rephrased from [Agent learning flywheel](https://www.augmentcode.com/guides/agent-learning-flywheel).

- Execute: run the task (spine S0-S9).
- Capture: at task end, write a small structured note - what was attempted, what the oracle said, what failed and why, the dead-ends, the fix. Failures come straight from the action-recorder (`ECE-RELIABILITY-SELFHEALING.md`).
- Curate: link it into the graph, tag it, timestamp it, dedupe against existing notes; a human or a curation agent reviews before it becomes durable (poisoning defense).
- Gate: a learning that would change agent behavior is promoted to "trusted" only after it passes the eval harness (VerilogEval/RTLLM + golden traces). An unproven lesson stays "candidate" and does not steer generation. This preserves reproducibility.
- Retrieve: at the start of a task, pull the few relevant notes (traverse via MOC/index links; embeddings only for scale) into context - selected and compressed, never the whole vault.
- Prune: notes carry validity/expiry; stale ones are invalidated. Multi-session memory degrades accuracy without temporal invalidation. Rephrased from [time-aware memory layers](https://medium.com/@cloud_88239/5-best-time-aware-memory-layers-for-long-term-ai-agents-2026-guide-079e218651db).

## Note taxonomy + frontmatter (OKF-conformant, so the vault doubles as the OKF bundle)

Every note is one concept, one file, with frontmatter (OKF requires a `type`; we add ours):
```yaml
---
type: decision | pattern | gotcha | verification-recipe | domain-note | glossary | moc
title: <short>
tags: [hdl, verification, ...]
status: candidate | trusted        # trusted only after the eval gate
provenance: <who/what created it; NEVER untrusted web/model auto-write>
timestamp: 2026-07-04T00:00:00Z
validUntil: <optional expiry>
verifiedBy: <eval run id / oracle>  # for trusted notes
---
```
- decision: an architecture/tech decision (ADR) - why we chose X.
- pattern: a reusable build pattern (an HDL module recipe, an API pattern).
- gotcha / dead-end: a failure and its cause, so the agent does not repeat it (continuity gold).
- verification-recipe: how to independently test a class of design (spec-derived testbench, golden reference).
- domain-note: HDL/embedded/PCB knowledge; these become the shipped OKF concepts.
- glossary / moc (map of content): index notes for progressive-disclosure traversal (OKF `index.md` role).

## How agents access the vault

- It is plain markdown, so the simplest path is the `retrieve` tool reading the vault directory (traverse MOCs, follow links) - same mechanism as the OKF cascade.
- Optionally add an Obsidian MCP server (read/search/create/update notes) so agents can both consume and write learnings; such servers exist (e.g. an Obsidian second-brain MCP that gives an assistant persistent memory through the vault). Rephrased from [CF-Second-Brain MCP](https://github.com/creativefabrica/CF-Second-Brain).
- Progressive disclosure: the agent reads the top MOC/index first, then follows only the relevant links - cheap and precise, not a full-vault load.
- Scale: add embeddings over the vault only when traversal starts missing relevant notes.

## Guardrails (non-negotiable)

- Continuity, not size: keep memory curated and small; capture the decisive facts, not everything.
- Oracle still decides: a note is a heuristic that improves the proposal; it never overrides the deterministic verdict.
- Eval-gate before trust: a behavior-changing lesson is `candidate` until the eval harness validates it; only then `trusted`. Prevents a bad lesson from compounding.
- Reproducibility: the vault is git-versioned; behavior-affecting changes are diffable and revertible; golden traces catch regressions.
- Poisoning defense: only curated/trusted sources write durable notes; never auto-persist untrusted web or raw model output as a lesson; every note carries provenance; promotion needs human/curator approval. Attackers otherwise plant memories that steer the agent later. Rephrased from [Microsoft: guarding AI memory](https://www.microsoft.com/en-us/security/blog/2026/06/22/guarding-ai-memory/).
- Temporal validity: timestamp + expiry + invalidation; distinguish "true when" from "true now."
- Secrets/PII: never stored in a shared/committed vault; keep a private, uncommitted area for anything sensitive (see security doc).
- Retrieval hygiene: select the few relevant notes per task; do not dump the vault into context (context rot).

## How it plugs into what we already have

- It is the authoring home for the OKF cache's Tier-3 "promote to shared cache" step (`ECE-KNOWLEDGE-ARCHITECTURE.md`): distilled, cited learnings land here as `domain-note`/`pattern` concepts.
- Action-recorder failures become `gotcha`/`dead-end` notes (the continuity layer).
- The eval harness is the promotion gate (`candidate -> trusted`).
- Steering/`AGENTS.md` remain the conventions layer; the vault is the learnings layer; the PRD/tasks are the current-state layer. Three planes, not one.

## Concrete setup (DONE - vault at `chipAgent/`)

Decisions made:
- Path: `chipAgent/` inside this repo.
- Git: versioned WITH the repo (single repo), so a commit pins code + knowledge together (reproducibility for the eval-gate). `chipAgent/_private/` and `chipAgent/.obsidian/workspace.json` are gitignored.
- Access: read now via Kiro's direct filesystem access (no MCP process needed); controlled write path via a `postTaskExecution` hook ("Capture learning to vault") that writes `candidate` notes into `_inbox/`. An Obsidian MCP stays a future option for richer search / the product runtime.

Structure scaffolded (OKF-conformant):
```
chipAgent/
  index.md                # root MOC (okf_version, progressive disclosure)
  _SCHEMA.md              # note schema + lifecycle + rules
  decisions/index.md
  patterns/index.md
  gotchas/index.md        # seeded with the aceternity-mcp fork-bomb incident
  verification/index.md
  domain/index.md + hdl|embedded|pcb/index.md
  glossary/index.md
  templates/              # decision, gotcha, pattern, verification-recipe, domain-note
  _inbox/index.md         # candidate capture area (post-task hook writes here)
  _private/               # gitignored; secrets/PII only
```
Steering: `.kiro/steering/engineering-standards.md` (always-on) now tells agents to read `chipAgent/index.md` at task start, pull relevant notes (esp. `gotchas/`), treat only `trusted` notes as authority, and capture learnings as `candidate` notes.

Remaining (when we start building):
- Wire the `retrieve` tool / knowledge cascade to traverse the vault (Tier-1 OKF), add embeddings only if traversal starts missing notes.
- Establish a lightweight curation cadence (triage `_inbox/`, eval-gate behavior-changing lessons to `trusted`).

## Sources
- Karpathy LLM wiki / Obsidian second brain - https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-obsidian-codeex-second-brain
- Continuity over memory for coding agents - https://medium.com/techtrends-digest/maybe-coding-agents-dont-need-a-bigger-memory-maybe-they-need-continuity-156cf4fc2e73
- Agent memory vs context engineering (three planes) - https://www.augmentcode.com/guides/agent-memory-vs-context-engineering
- Agent learning flywheel (execute/coach/distill/improve) - https://www.augmentcode.com/guides/agent-learning-flywheel
- Time-aware memory layers (temporal invalidation) - https://medium.com/@cloud_88239/5-best-time-aware-memory-layers-for-long-term-ai-agents-2026-guide-079e218651db
- Microsoft: guarding AI memory (poisoning) - https://www.microsoft.com/en-us/security/blog/2026/06/22/guarding-ai-memory/
- Obsidian second-brain MCP (persistent memory via vault) - https://github.com/creativefabrica/CF-Second-Brain

External content was paraphrased and summarized per licensing compliance.
