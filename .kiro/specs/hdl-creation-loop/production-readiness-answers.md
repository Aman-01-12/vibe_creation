# Production Readiness: Answers and Decisions

Answers to `production-readiness-questions.md` (PR-1 through PR-7), decided as CTO / staff engineer for a flagship product used by real students, under a bootstrapped student-founder budget.
All model IDs, prices, and free-tier limits below were verified against primary sources on 2026-07-06, not recalled from memory.
Conventions per `AGENTS.md`: plain dashes, one sentence per line.

## Guiding principle (how these decisions were made)

- Quality, trust, and security are never traded for cost, because this is the flagship and a wrong answer to a student destroys the trust that is the whole moat.
- The architecture already makes the expensive thing cheap: accuracy comes from the simulator-verification loop running on our own compute, not from an expensive model, so we run a cheap model plus many cheap local simulator iterations.
- Therefore the money is spent only where it buys quality or safety that free tiers cannot: real sandbox isolation, real auth, and the deterministic oracle.
- Everything else runs on free tiers and startup credits now, behind the ports that already exist, so upgrading later is a config change, not a rewrite.
- Hard budget caps plus a global monthly spend ceiling protect a free student tier from ever becoming an unbounded bill.

## Two time-critical corrections (act on these first)

1. DeepSeek `deepseek-chat` and `deepseek-reasoner` are deprecated on 2026-07-24 (about three weeks out); they now just alias the non-thinking and thinking modes of `deepseek-v4-flash`.
   Pin `deepseek-v4-flash` directly, never `deepseek-chat`, so nothing breaks on the deprecation date.
2. The Gemini API free tier uses submitted content to improve Google's products; that is unacceptable for student PII and student designs.
   Production must use the Gemini paid tier (content not used for training); the free tier is acceptable only for CI and eval on public benchmark problems that contain no user data.

## Per-session cost model (grounds the budget decisions)

- Generation on `deepseek-v4-flash`: input $0.14/M (cache-miss), $0.0028/M (cache-hit), output $0.28/M.
- A typical single-module session of roughly 150k input plus 50k output tokens costs about $0.021 + $0.014 = ~$0.035 without caching, and drops toward ~$0.02 once the system prompt and OKF context are prompt-cached (cache-hit input is ~50x cheaper).
- Orchestration and teaching on `gemini-2.5-flash` ($0.30/M in, $2.50/M out) adds a few cents; using `gemini-2.5-flash-lite` ($0.10/M in, $0.40/M out) for the simpler orchestration paths keeps it near a cent.
- Realistic all-in: roughly $0.04 to $0.10 per verified session, i.e. genuinely pennies, consistent with the PRD target, and only because the simulator (not the model) does the correctness work.
- Financial guardrail: keep the Session_Budget hard cap at about $0.12 to $0.15 per session, add a per-user daily cap, and add a global monthly spend ceiling with alerting; these three are the free-tier bankruptcy guard.

---

## PR-1 Production host / OS for the gVisor sandbox

Decision:
- (a) Now: run the real oracle plus the adversarial containment tests on a GitHub Actions ubuntu runner that installs `iverilog`, `vvp`, `yosys`, and `runsc` (gVisor). This is free for our usage and gives real-oracle CI confidence immediately.
- (b) Serving host: do not stand up 24/7 serving until there are real users beyond the design-partner cohort; the M1 slice is validated by CI plus local runs.
- When serving is needed, use a small Linux ARM host: a Hetzner ARM VPS (~4 EUR/month) is my primary recommendation for reliability-per-rupee; Oracle Cloud Always Free ARM (now 2 OCPU / 12 GB after the June 2026 halving) is the zero-cost fallback, with the caveat that Oracle can reclaim idle free instances and ARM capacity can be hard to get.
- Chase startup cloud credits (see the credits section) to get a much larger serving box free for one to two years.
- Local dev on your Mac: gVisor is Linux-only, so real-sandbox local runs need Docker Desktop (start the daemon) or Colima running a Linux VM with `runsc` inside; this is optional because CI (a) already covers the real path.

Rationale: CI-first gives real-oracle confidence at zero cost; deferring the serving host avoids paying for idle infrastructure before there is traffic; keeping it behind the `SandboxRuntime` port means the host choice is swappable.

## PR-2 Model providers, exact model IDs, and budget

Decision (pin these exact IDs):
- Generation and repair: `deepseek-v4-flash` (not `deepseek-chat`, which is deprecating 2026-07-24). Escalate to `deepseek-v4-pro` ($0.435/M in, $0.87/M out) only if the eval harness shows `deepseek-v4-flash` underperforming, which is unlikely because the verification loop, not the model, carries correctness.
- Orchestration and teaching: `gemini-2.5-flash` ($0.30/M in, $2.50/M out) as the stable default, with `gemini-2.5-flash-lite` ($0.10/M in, $0.40/M out) for high-volume or simple orchestration paths. Avoid `-preview` models and the pricier `gemini-3.5-flash` ($1.50/$9.00) for bulk work.
- Escalation fallback (rare, hard planning): `claude-haiku-4-5` ($1/M in, $5/M out) for most escalations, `claude-sonnet-4-6` ($3/M in, $15/M out) only for genuinely hard cases; confirm the exact dated snapshot IDs in the Anthropic console. Keep escalation under ~5% of calls.
- Use the Gemini paid tier in production (free tier trains on submitted content); use the Gemini free tier only for CI/eval on public benchmark problems.
- Turn on prompt caching for the system prompt and OKF context from day one; on `deepseek-v4-flash` the cache-hit input rate is ~50x cheaper and is what secures the pennies-per-session target.
- Budget: Session_Budget hard cap ~$0.12 to $0.15 per session, plus a per-user daily cap and a global monthly spend ceiling with alerting.

Needs from you: API keys for DeepSeek, Google AI Studio (Gemini, paid tier enabled), and Anthropic, delivered as secrets, never in source.

## PR-3 Secret manager

Decision:
- (b) Now: an env-backed `SecretManagerPort` implementation, with keys stored in GitHub Actions encrypted secrets for CI and in an untracked local `.env` for development; zero cost and it matches the existing port.
- (a) Later, for the serving host: use a real secret store. If the serving host is on GCP (natural, since Gemini is Google), use GCP Secret Manager; if you want a provider-neutral, open-source option with a free tier, use Infisical (self-hostable) or Doppler.
- The code already resolves secrets at the point of use behind the port, so this is a swap, not a rewrite.

Rationale: never pay for a secret manager before there is a serving host; keep secrets out of source and out of `process.env` reads in the fake, exactly as the current design enforces.

## PR-4 Managed auth provider and data residency

Decision:
- Provider: Clerk. Its free tier covers up to 50,000 monthly active users, which is far more generous than Auth0's 25,000, and its developer experience and social/edu login are strong. WorkOS is better for enterprise SSO and is the one to revisit when institutional SSO/LTI arrives, not now.
- Region and residency: set `AUTH_DATA_RESIDENCY_REGION` and put the primary data store (PR-5) in Mumbai `ap-south-1` (or Singapore `ap-southeast-1` if Mumbai is unavailable) for India DPDP alignment.
- Residency caveat to record: Clerk defaults to US storage with EU residency on higher tiers, and India residency may not be available on the free tier; for the early design-partner cohort this is acceptable, but treat full in-India PII residency as a growth-stage requirement to revisit before a broad Indian launch, behind the auth adapter so the provider can change.
- Roll-your-own auth remains off the table.

Needs from you: a Clerk tenant plus its issuer, audience, and JWKS URI values, delivered as config/secrets.

## PR-5 Neon Postgres

Decision:
- Use the Neon free tier now (about 0.5 GB storage and ~100 compute-hours per month per project, with scale-to-zero), which fits development and the first cohort.
- Region: Mumbai `ap-south-1` if available, else Singapore `ap-southeast-1`, matching PR-4 for DPDP.
- Keep the Trace/span data lean and behind the storage adapter, because 0.5 GB is the binding free-tier constraint; a future move of high-volume spans to object storage should not touch callers.
- Use a Neon branch per PR for DB-backed CI integration tests; branch-per-PR is a Neon strength and stays within the free tier.

Needs from you: a Neon project plus a pooled `DATABASE_URL` (and a branch URL for CI if you want DB-backed integration tests), delivered as a secret, never in source; then run migrations.

## PR-6 Do real provider/DB calls run in CI?

Decision:
- (a) Keep PR CI hermetic: fakes for models and, where practical, an ephemeral DB; the real EDA oracle (Icarus/Yosys under gVisor) does run in CI on ubuntu because it is free and is the core trust path.
- (b) Add a nightly (or on-protected-branch) real smoke that exercises the real provider transports and a real DB against repo secrets, on a tiny fixed input set.
- Keep real model calls out of PR CI to avoid per-PR cost and secret exposure; where the nightly smoke can use public benchmark inputs, run it on the Gemini free tier to keep even the nightly near zero cost.

Rationale: PR CI stays fast, free, and secret-free; real integrations still get exercised regularly without paying per PR.

## PR-7 Eval-gate arming

Decision:
- Agree completely: finish feature task 19, run the Eval_Harness on the Linux host (PR-1a) so a real non-zero pass@k is measured by the real oracle, record that as the baseline, then arm the gate.
- Never hand-set or fabricate a baseline.
- Apply the ratcheting rule already decided: the gate blocks only when armed and pass@k is strictly below (baseline minus a noise tolerance) or at/below an absolute floor; a tie never blocks; the baseline only ratchets up except by an explicit reviewed lowering; run the eval with fixed seeds, temperature, and sample count for reproducibility.
- Keep the gate unarmed (`armed: false`, `baseline: null`) until that real measurement exists, so bootstrapping merges are not deadlocked.

---

## Free startup credits to apply for now (bootstrapped-founder leverage)

These can cover most infrastructure and model costs for one to two years and are the highest-leverage financial move for a student founder:
- GitHub Student Developer Pack (you are a student): bundles many free credits and tools.
- Google for Startups Cloud Program: Gemini and GCP credits (directly offsets PR-2 orchestration and a PR-1b GCP host).
- Microsoft for Startups Founders Hub and Azure for Students: Azure credits and OpenAI/Anthropic-adjacent tooling.
- AWS Activate: AWS credits (an alternative PR-1b serving host and secret manager).
- Provider and vendor startup programs: Neon, Clerk, and others run startup or student programs; ask each for credits once the company is registered.
- DeepSeek and Anthropic: check for current trial credits; DeepSeek is already cheap enough that this is minor.

## Endorsement of the agent's proposed autonomous work

Proceed with the "what I will do now without waiting" list, because all of it stays behind the existing ports and fakes and is fully reversible:
- Install `iverilog` plus `yosys` locally and add the EDA-toolchain install step to CI so the real oracle integration tests (3.8) stop skipping.
- Finish the remaining M1 feature tasks (14.3, 15.x, 16.x, 17, 18) behind the ports, fully tested with fakes.
- Implement the concrete provider transports, the env-backed `SecretManagerPort`, the concrete Clerk auth adapter, and DB migrations behind the ports so they activate the moment the secrets and decisions below land, without re-wiring.

Also hold the "what I will NOT do" line exactly as stated: no commit or no-mistakes pass until everything is real and production quality, no hardcoded secrets or unconfirmed model IDs or regions or connection strings, and no arming the eval gate.

## What I still need you to provision (the blocking shortlist)

1. API keys: DeepSeek, Google AI Studio (Gemini paid tier enabled), Anthropic — as secrets.
2. Clerk tenant + issuer, audience, JWKS URI — as config/secrets; set `AUTH_DATA_RESIDENCY_REGION`.
3. Neon project + pooled `DATABASE_URL` (+ branch URL for CI) in Mumbai/Singapore — as a secret.
4. Confirm the Session_Budget hard cap ($0.12 to $0.15/session suggested) and a global monthly spend ceiling.
5. Confirm serving-host choice for when it is needed (Hetzner ARM recommended; Oracle Always Free as zero-cost fallback), and start the startup-credit applications above.

---

## Update (2026-07-15): testing-phase model access via B.AI, plus PR-8/PR-9 and data routing

This supersedes PR-2 for the current TESTING/eval phase. The production target (AWS Bedrock / direct) is unchanged.

### PR-2 (revised): B.AI for the testing/eval phase; Bedrock/direct for production
- For the eval and the CPVA model bake-off now, use B.AI as a single OpenAI-compatible gateway to many models: one key and one base URL reach DeepSeek, Qwen, GLM, Claude, Gemini, MiniMax, and GPT, which is exactly what a multi-model bake-off needs.
- Scope guardrail (non-negotiable): B.AI is eval/testing only, on PUBLIC benchmark problems (VerilogEval/RTLLM), never student data. It is NOT core production infrastructure, because it marks up open models about 2x and carries crypto/token (Justin Sun / HTX) vendor and longevity risk.
- Endpoint (verified 2026-07-15): base URL `https://api.b.ai/v1`; OpenAI-compatible `POST /v1/chat/completions` and a Claude-style `POST /v1/messages`; auth via `Authorization: Bearer sk-...` or `x-api-key`. Wire it as the eval `ProviderTransport`; one transport reaches every model by changing the `model` field.
- Candidate model IDs on B.AI for the bake-off: generation `deepseek-v4-flash` (B.AI marks this ~2x, so also A/B the near-parity `deepseek-v3.2` and `minimax-m3`), orchestration/teaching `claude-haiku-4-5`, escalation/reference `claude-sonnet-4-6`, with `gemini-3-flash` and `glm-5-2` as options.
- Parity rule: proprietary models (Claude/Gemini/GPT) are routed to origin, so they transfer cleanly to the ship host; open-model winners (DeepSeek/Qwen/GLM) MUST be re-validated on the production host (Bedrock/direct) before the number is trusted, because B.AI's open-model serving may differ.
- Production target (unchanged): ship the CPVA-bake-off winner on AWS Bedrock (Claude Haiku for orchestration/teaching; Qwen3-Coder or DeepSeek for generation) or DeepSeek direct; student designs go only to that vetted zero-retention provider.
- Cost: B.AI is prepaid (1 USD = 1,000,000 credits); a small top-up covers the whole eval because it runs on public problems under the Session_Budget caps.

### PR-8 (answer: yes) - netlistsvg as a PATH binary
Install `netlistsvg` as a PATH-resolvable binary (`npm i -g netlistsvg`) on the dev host and in CI, so the real yosys -> netlistsvg render (task 15.8) runs instead of skipping.

### PR-9 (answer: yes) - CI EDA toolchain
Add an install step to the ubuntu CI job for `iverilog` + `vvp` + `yosys` + `netlistsvg` (plus `runsc`/gVisor for the containment job), so the real-oracle and adversarial-containment integration tests run in CI, not just locally.

Pinning requirement (parity, not a nicety): pin the EDA toolchain versions rather than `apt-get install` whatever is latest.
Use oss-cad-suite (a pinned bundle of yosys/iverilog/etc.) or a pinned Docker image, the same build locally and in CI.
Reason: the oracle's verdict must be reproducible across environments, otherwise the local pass@k and the CI/armed baseline (PR-7) can drift apart.
The agent should use a pinned toolchain everywhere the oracle runs (dev host, CI, and the eventual serving host).

### Data-sensitivity routing (record this)
- Identity PII (name/email) never enters a prompt; it stays in auth/DB.
- Student designs (their IP) go only to a vetted zero-retention provider (Bedrock/direct) in production, never to B.AI.
- The eval carries no student data (public benchmark problems only), which is precisely why B.AI is acceptable for testing but not for production.

---

## Update (2026-09-04): PR-2 now has empirical Bedrock data

A real benchmark was run against the Bedrock catalog (`~/vbench`): 3 RTL tasks, oracle = `iverilog` + `vvp` requiring `RESULT PASS` against an independent reference model, plus a `yosys` synthesis rung; plus a separate tool-use benchmark (`orchbench.py`).
Full results, methodology, and caveats: `product-ece/ECE-AGENT-EVAL-RANKING.md` section 10.

Empirical shortlist (candidate, not certified):
- Generation/repair: `moonshotai.kimi-k2.5` (3/3 functional, the only model to pass the discriminating skid_buffer). Fallbacks: `zai.glm-5`, `deepseek.v3.2`, `qwen.qwen3-coder-480b-a35b-instruct` (2/3 each).
- Orchestration/teaching: `zai.glm-4.7` (4/4 tool-use, fastest perfect score). `kimi-k2.5` is a viable all-rounder for both roles.
- Ruled out: `minimax.minimax-m2.5` (no Verilog produced, 100-150s latency).

This supersedes the earlier hypothesis in the 2026-07-15 update for the Bedrock catalog specifically, on two counts:
- Qwen3-Coder was expected to lead generation and did not; it also failed tool-chaining, so generation and orchestration should be split across different models.
- Claude Haiku was the proposed orchestration model but was not present in the tested Bedrock catalog, so it remains untested here; `zai.glm-4.7` is the measured best available.

Do not pin these yet. Blocking gaps before certification (all named in `ECE-AGENT-EVAL-RANKING.md` section 10.2):
- n=1 per model-task, so no pass^k and no confidence intervals (Section 4.3 statistical honesty forbids ranking on this).
- No cost axis yet, so no CPVA; tokens are captured but a per-model Bedrock price table is needed.
- One-shot only, so no iterations-to-pass; the product generates inside a repair loop.
- The Testbench role is untested; add the section 10.1 mutation-kill scoring using the existing `neg/*.v` fixtures.
- Parity: re-measure through the product's own `app/eval` Eval_Harness before certifying, per `ECE-CONTEXT-ENGINEERING.md` section 6.

Credential note: the Bedrock key is supplied as the `AWS_BEARER_TOKEN_BEDROCK` environment variable and the harness never prints it; keep it in env/secret manager per PR-3, never in source.
