---
type: decision
title: Model routing, model bake-off (CPVA), and provider/credit routing for eval + v1
status: candidate
provenance: founder + Kiro planning session (2026-07-15); model picks are HYPOTHESES to be validated by the CPVA bake-off, not proven
tags: [models, eval, cost, bedrock, deepseek, claude, gemini, context-engineering]
timestamp: 2026-07-15T00:00:00Z
validUntil: 2026-10-15T00:00:00Z
---

# Decision (working)

Roles and starting candidates (all behind the Model_Router; final pick decided by the bake-off, not by opinion):
- Generation/repair: DeepSeek V4 Flash as the cheap default; A/B against Qwen3-Coder and DeepSeek V3.2. Escalate hard units to a frontier model.
- Orchestration/teaching: Claude Haiku 4.5 is the Gemini-Flash replacement on Bedrock (Bedrock has no Gemini); Amazon Nova Lite for cheap high-volume orchestration.
- Escalation: Claude Sonnet class (and/or DeepSeek V4 Pro) for hard planning; keep under ~5-10% of calls.

Selection method (see `../../product-ece/ECE-CONTEXT-ENGINEERING.md` section 7 and `../../product-ece/ECE-AGENT-EVAL-RANKING.md`):
- Score by Cost per Verified Artifact (CPVA) on a difficulty-stratified public set, with gates: pass@k per tier, pass^k, honest-pass (anti-hack), teaching-quality rubric.
- Hold ONE context/prompt configuration constant across models; per-model-tune only the finalists.
- Certified config = {model + host + prompt version + context strategy}, identical in eval and prod (parity).

Provider / credit routing:
- Proprietary models (Claude/GPT/Gemini) are routed to origin, so they are parity-consistent across resellers; open models (DeepSeek/Qwen/GLM) can differ by host quantization, so re-validate an open winner on the final host.
- Production leaning: AWS Bedrock (new-account $200 credit + Activate $1,000; Bedrock API keys; enterprise data terms). Generation may move to DeepSeek direct or self-host post-credit for cost.
- Data-sensitivity routing: student designs (IP) go only to a vetted zero-retention provider; identity PII never enters a prompt.

# B.AI verdict
- OK for eval/testing only (public benchmark problems, no student data). Pick a parity model (DeepSeek V3.2, not V4 Flash which it marks up ~2x).
- Rejected for core production infra: ~2x markup on open models, 30-day-expiry bonus credits, fuzzy message-based throttling, and crypto/token (Justin Sun / HTX) association -> longevity/regulatory/reputational risk.

# Links
- [[decisions/index|Decisions]]
- Canonical: `../../product-ece/ECE-CONTEXT-ENGINEERING.md`, `../../product-ece/ECE-AGENT-EVAL-RANKING.md`, `../../product-ece/ECE-TECH-DECISIONS.md`

# Update 2026-09-04: first empirical data (supersedes the hypotheses above for the Bedrock catalog)

A real benchmark was run against the Bedrock catalog (`~/vbench`, 3 RTL tasks, independent-reference testbench + `RESULT PASS` + yosys synth rung, temperature 0).
Full results and caveats: `../../product-ece/ECE-AGENT-EVAL-RANKING.md` section 10.3.

- Generation shortlist: `moonshotai.kimi-k2.5` (3/3, the only model to pass the discriminating skid_buffer task), then `zai.glm-5` / `deepseek.v3.2` / `zai.glm-4.7` / `qwen.qwen3-coder-480b-a35b-instruct` (2/3).
- Orchestration shortlist: `zai.glm-4.7` (4/4 tool-use, fastest at 17.8s); `kimi-k2.5` is a strong all-rounder (3/3 RTL and 4/4 tool-use).
- Ruled out: `minimax.minimax-m2.5` (produced no Verilog, 100-150s per call).
- Hypothesis corrected: Qwen3-Coder underperformed on RTL despite being coding-specialised, and both Qwen coders failed tool-chaining, which supports splitting generation and orchestration across different models.
- Hypothesis corrected: compile and synth passed for nearly every model, so only independent functional simulation discriminated. Never treat compile-or-synth as evidence of correctness.

Still candidate, not certified: n=1 per model-task, no pass^k, no confidence intervals, no cost/CPVA axis, no held-out set, and Claude/Gemini were not in the tested catalog.
Do not pin a production model until the CPVA bake-off (with the section 10.1 testbench mutation-kill dimension) runs through the product's own `app/eval` harness.
