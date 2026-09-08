---
inclusion: fileMatch
fileMatchPattern: '**/*{agent,orchestrator,prompt,prompts,harness,model-router,router,retriev,knowledge,okf,intent,generation,testbench,teach,context,compaction}*'
---

# Context engineering (auto-loaded on agent/prompt/harness surfaces)

You are editing the product agent's prompt, retrieval, harness, or context surface. Apply `product-ece/ECE-CONTEXT-ENGINEERING.md` in full; read it now if you have not this session.

Enforced highlights:
- Smallest set of high-signal tokens; context rot is real, so never dump.
- Repair loops MUST compact: keep {approved Spec, current RTL, latest error, a short prior-attempts summary}; clear stale tool outputs.
- Just-in-time OKF retrieval (gap-driven); CAG/prompt-cache the stable core; re-anchor to the Spec each iteration.
- Ground claims in tool output; cite-or-label-`Unverified`; never put PII/secrets in prompts; sanitize untrusted web content.
- Terse generation output (no prose in the generation call); prefer known-good OKF IP over from-scratch generation.
- Sub-agents keep isolated context and return condensed summaries; the Testbench agent never sees the RTL (anti-circular, Property 4).
- Prompts at the right altitude, sectioned, with a few canonical examples and RTL gotchas as heuristics.
- Model bake-off: hold ONE context configuration constant across models; the certified config is {model + host + prompt + context strategy}, identical in eval and prod. Select by Cost per Verified Artifact (CPVA); see `ECE-CONTEXT-ENGINEERING.md` section 7.
