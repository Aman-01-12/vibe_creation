---
type: gotcha
title: Model-access and pricing traps (providers, credits, rate limits)
status: candidate
provenance: web-verified during the 2026-07-15 planning session; pricing/limits are volatile
tags: [models, pricing, credits, rate-limits, deepseek, gemini, bedrock, digitalocean, bai]
timestamp: 2026-07-15T00:00:00Z
validUntil: 2026-10-15T00:00:00Z
---

# Traps to avoid (re-verify before acting; all time-sensitive)

- DeepSeek: `deepseek-chat` / `deepseek-reasoner` are being deprecated (~2026-07-24); pin `deepseek-v4-flash` directly, not `deepseek-chat`.
- Gemini free tier (AI Studio): the dashboard showed roughly RPM 10 / TPM ~250K / RPD ~20 - an RPD of ~20 is unusable for eval sweeps. Enable Tier 1 (billing) to lift it, or route the role elsewhere.
- Gemini via Google Cloud: the $300 free trial does NOT apply to AI Studio Gemini, but DOES apply to Gemini via Vertex AI. India also hit a ~Rs.1000 billing-verification wall on Vertex.
- DigitalOcean: the GitHub Student Pack $200 credit does NOT cover serverless LLM inference (checked), and Student Pack promo credits were reported to expire 2026-07-31.
- DeepSeek on AWS Bedrock: pricier than direct (~$0.62/$1.85 vs $0.14/$0.28) and had a reported ~4096 max-output cap; prefer Qwen3-Coder on Bedrock for generation, or DeepSeek direct.
- AWS new-account: gives up to $200 credits ($100 instant + $100 on activities), small refundable card verification (not a big prepaid); Bedrock has simple API keys now (console -> API keys).
- B.AI: `1 USD = 1,000,000 credits`, so credits/token = USD per 1M tokens; it marks up open models ~2x (DeepSeek V4 Flash $0.28/$0.56) but prices commercial models at parity; crypto/token-linked -> eval-only, not core infra.

# Rule
Credits are runway, not a funding model; enforce Session_Budget caps and re-check prices/limits at wire-up.

# Links
- [[gotchas/index|Gotchas]]
- Decisions: [[decisions/model-and-eval-routing]]
