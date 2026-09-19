---
type: decision
title: No agent framework (LangGraph / LangChain / ADK / CrewAI) - argued from the measured defect distribution
status: candidate
provenance: session review of the 9 hardening defects + package.json dependency audit + web check on langgraphjs availability
tags: [architecture, orchestration, agent-framework, langgraph, adr, interview]
timestamp: 2026-09-12T06:30:17Z
---
# Decision

Orchestration stays hand-rolled in TypeScript: the graph is plain async generators over
explicit state types, with every external boundary behind a port interface we own.
No LangChain, LangGraph, Google ADK, CrewAI, or AutoGen. Zero agent-framework dependencies.

Full ADR with the cost ledger: `product-ece/ECE-ARCHITECTURE-DECISIONS.md` ADR-001.
NOTE: `product-ece/` is gitignored, so this note is the tracked record of the decision.

# PROVENANCE (verified this session - do not misstate this)

This is a RETROSPECTIVE audit, not an up-front trade study. Verified facts:
- `git log --all -S"langgraph"` and `-S"langchain"` return ZERO commits across all history.
  No agent framework was ever installed or prototyped, not once.
- No planning doc in `product-ece/` ever named a framework. The question was never asked at
  design time; it was an IMPLICIT OMISSION.
- What DID exist up front: the prime directive in `ECE-VERIFICATION-METHODOLOGY.md` (LLM
  proposes, tools decide, LLM never judges) + the explicit `ECE-PHILOSOPHY.md` decision to
  "take the lesson and then adapt it to ECE" from agentic coding, whose ECE-specific driver is
  that the environment is a HIERARCHY of oracles (lint/sim/formal/synth/STA), not one test suite.
- First commit `0bd47b5` "Add M0 spine: end-to-end oracle path" built the ORACLE before the
  agent - hardcoded Verilog + testbench through a real Icarus runner, no agent involved.

The audit vindicates the outcome, NOT the process. Claiming a week-one framework bake-off is a
lie that dies to one follow-up ("what did your prototype look like?"). The honest line is
stronger: the architecture came from a written prime directive, the framework question was an
omission, and I audited it afterwards and can tell you what the audit found.

# Context / options considered (as evaluated during the audit)

The flow IS graph-shaped (Intent -> Spec -> Generation || Testbench -> Simulate -> label,
with repair cycles), so this is not a case of the shape not fitting.

- LangGraph Python: most mature, but splits a TypeScript-everywhere stack or forces a
  service boundary where the typed Spec degrades to JSON on both sides.
- LangGraph JS (`@langchain/langgraph`): the strongest alternative. DO NOT claim LangGraph
  is Python-only - it is not, the TS package exists. The accurate weakness is that the
  Python implementation ships features first with more community checkpointer backends;
  that is a maturity risk, not a blocker, and insufficient on its own.
- LangChain: rejected on boundary control - its output parsers sit exactly where our
  worst-yield defect lived (5 role parsers rejecting a valid envelope over a markdown fence).
- ADK / CrewAI / AutoGen: conceptually closest (we do have roles) but built around agents
  that share context and delegate, which is the opposite of our central invariant that the
  Testbench role must NEVER see the RTL.

# Rationale

1. DECISIVE, and the part that is not taste: of the 9 defects found and fixed in the
   hardening pass (3 severity-1), ZERO were in the orchestration layer. They were oracle
   regex/grammar (3), subprocess resource handling (3), untrusted-output boundary (1),
   measurement methodology (1), HTTP boundary (1). A graph framework prevents none.
2. Our invariants have no vocabulary in a generic graph engine: anti-circular construction
   (`verification-loop.ts#setup` builds the testbench request from the Spec before any
   candidate exists), fail-closed on incomplete evidence (`missingCheckNames` refusing a
   tool-reported PASS), and trust-as-a-label that fails closed in the display layer.
   All three would still be hand-written under a framework, plus adapter code.
3. The agentic surface is genuinely small: two narrow typed loops (compile->diagnostics->
   revise, simulate->checks->label). The weight is in the sandbox, oracle, and harness.
4. Dependency surface is a reproducibility property: the certified config is
   {model + host + prompt + context strategy}, so a framework version bump could move a
   published number without changing our code.

# What it cost (do not omit - a no-downside claim is not credible)

Hand-rolled checkpointing/resume and observability (ActionRecorder is narrower than
LangSmith-style tracing); streaming/HITL plumbing by hand; onboarding cost since nobody
arrives knowing our orchestrator; and we rediscovered patterns the production scaffolds
already encode. Estimate: a framework saves weeks of plumbing and zero of the 9 defects.

# Revisit trigger

- More than 2 additional roles needing DYNAMIC routing between each other.
- Durable multi-day resume across process restarts -> adopt LangGraph JS checkpointers or
  Temporal rather than growing ours.
- A genuine multi-agent negotiation (floorplan vs timing vs power trading constraints).
- More than 3 engineers on the orchestrator.
Explicitly NOT a trigger: "it is the industry default."

# Verified facts worth reusing

- Dependency audit: 5 third-party runtime deps total (`@trpc/server`, `@trpc/client`,
  `zod`, `ulidx`, `ajv`) + `fast-check` in test. NOT "zero dependencies" - that claim is false.
- Source: 364 .ts files, 83,893 lines.
- The Cursor-style tool loop DOES exist here: `generation-agent.ts` generateCandidate ->
  #compileCandidate -> feed `diagnostics` -> reviseFromErrors. The divergence from Cursor is
  only at the finish line, where we refuse the model's own satisfaction as a completion signal.
- Wilson 95% CI for golden pass@1 12/15 = [0.548, 0.930]. Quoting 0.800 bare is an overclaim.

# Links

- `product-ece/ECE-ARCHITECTURE-DECISIONS.md` (ADR-001 .. ADR-012)
- `product-ece/ECE-INTERVIEW-DEEPDIVE.md` (walkthrough + question bank)
- commits `4a60dee..8c2eab8` on `eval-harness-hardening` (the 9 defects, in their own words)
