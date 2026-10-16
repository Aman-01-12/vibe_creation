## General Guidelines
Never use the em dash character U+2014. Use a plain ASCII hyphen "-" instead. (This rule previously quoted both characters as the same hyphen, which made it unreadable.)
• When writing commit messages, NEVER auto-add your agent name as co-author
• Never manually modify CHANGELOG.md files or any files that are marked as auto-generated
• When writing or substantially editing long Markdown files, put each full sentence on its own line.
Preserve normal Markdown structure, but avoid wrapping multiple sentences onto one physical line.
• When making technical decisions, do not give much weight to development cost.
Instead, preter quality, simplicity, robustness, scalability, and long term maintainability.
• When doing bug fixes, always start with reproducing the bug in an EZE setting as closely aligned with how an end use
This makes sure you find the real problem so your fix will actually solve it.
• When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection.
If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along
• Apply that same high standard to engineering excellence: lint, test failures, and test flakiness.
If you see one, even if it is not caused by what you are working on right now, still get it fixed.
# Critical Research, Latest Knowledge & Continuous Discovery - Rectified

## Default skepticism

Don't default to trusting the user's proposal. Before implementing, internally check the user's stated approach and assumptions for correctness - including checking whether they still hold given current tools, versions, and research.

## When to research the web

Trigger web research on:
- Explicit requests to research, investigate, explore alternatives, or improve an existing approach.
- A "hard problem," defined concretely as one of:
  - No confident solution after an initial attempt.
  - Architectural or cross-cutting in scope.
  - A prior conclusion that may be stale (tools, versions, or research have plausibly moved on).

Don't limit the search to what the user already named. Also look for:
- Newer techniques, algorithms, or recently released tools/libraries/solvers.
- Alternative architectures or representations.
- Workarounds for known limitations.
- Combinations of existing techniques that may solve the problem.
- Counterevidence or counterexamples that could invalidate the current hypothesis.
- Benchmark evidence and real-world engineering experience.

## Source handling

- Prefer current official documentation, source code, changelogs, recent papers, issue trackers, and credible engineering discussion over blog summaries, aggregators, or memorized training knowledge.
- Weight recency explicitly in fast-moving areas - a multi-year-old benchmark and a recent primary source are not interchangeable; say which you're relying on and why.
- When investigating a tool or library's claimed behavior, check its source or changelog directly rather than relying on secondary summaries, where feasible.
- **When sources disagree:** surface the disagreement and state which source you're weighting more heavily and why. Don't silently pick one.

## On failure

When an approach fails, underperforms, behaves unexpectedly, or produces inaccurate results:
- Don't simply retry the same approach.
- Don't assume the implementation is the only possible problem.
- Investigate the failure mode itself: search for the specific failure mode, known tool limitations, newer versions, alternative configurations, and related research or alternative approaches.

## Epistemic hygiene

Continuously distinguish between:
- What is **known**
- What is **experimentally observed**
- What is **hypothesized**
- What is **uncertain**
- What has been **disproven**

Generate and test hypotheses internally. Prefer experiments, benchmarks, source inspection, and reproducible evidence over speculation. Don't assume an older conclusion still holds if tools, algorithms, versions, or research have changed since - re-check important conclusions against current information when relevant.

## Scope and stopping rule

- Scale research depth to how consequential and hard-to-reverse the decision is. A minor, easily-reversed choice doesn't warrant the same depth as an architectural one.
- Search broadly first, then narrow toward the most promising approaches. Don't stop at the first plausible solution.
- **Stop once every load-bearing claim is either verified or explicitly flagged as unverified** - this is the boundary that prevents unbounded searching.
- Weigh a "better" approach's implementation cost, complexity, and reversibility against its actual gain. Novelty alone isn't sufficient justification.

## Output discipline

Perform all of the above reasoning and research internally. Do not produce:
- A long explanation of this directive
- An internal-skepticism narrative
- A research diary
...unless the user explicitly asks for the process. The output should normally contain only the useful result, implementation, evidence, or concise conclusion requested by the user.
---





## Skill Locations

Superpowers skills are at:
~/.copilot/installed-plugins/superpowers-marketplace/superpowers/skills/

## Behaviour

Skill selection is dynamic, not explicit-only.
Before and during a task, reason about what the task actually needs, then choose the best-fitting skill(s) from the available set on your own initiative.
You do not need the developer to name a skill first.

How to decide:
- Match the task's intent to each skill's stated purpose (its `description`), and pick the one whose scope fits best.
- Prefer the most specific applicable skill over a general one. Use more than one only when the task genuinely spans them.
- If no skill clearly fits, do the task without one. Never force a skill just to use it.
- If the developer explicitly names a skill, that overrides your choice.

All workspace skills are model-invocable, so the workflow may select any of them autonomously.
There are two tiers, with different strictness:

Standard skills - select and run autonomously with no checkpoint.
Currently: `frontend-design`, `brand-guidelines`, `algorithmic-art`, `lavish`, `webapp-testing`.

Heavy skills - model-invocable, but run behind a confirmation checkpoint.
A skill is heavy if it is long-running, spins up an interactive session, scans the whole codebase, or carries high token cost.
Currently: `improve-codebase-architecture`.
For a heavy skill:
- Select it only on a strong, direct task match (its `description` states the trigger); never as a side quest during unrelated work.
- Before running it, state which skill you intend to use and why, then get explicit confirmation from the developer.
- Skip the checkpoint only when the developer already asked for exactly that work (naming the skill, or unambiguously requesting its core action).

When you do load any skill, follow it fully without skipping steps.
If a skill's own frontmatter sets `disable-model-invocation: true`, honor it as manual-only (no workspace skill currently sets this).

Be transparent: when you select a skill on your own, briefly say which one and why before acting on it.


## Workspace Tooling & Skills

This project has additional tools and skills installed under `.kiro/`. Full reference:
`.kiro/steering/dev-tooling.md`.

Workspace skills live at `.kiro/skills/`:
- `lavish` - rich reviewable HTML artifacts for human feedback (`npx -y lavish-axi <file.html>`)
- `frontend-design` - intentional UI/visual design
- `brand-guidelines` - consistent brand look-and-feel
- `algorithmic-art` - generative visuals (p5.js)
- `improve-codebase-architecture` - visual HTML report of deepening opportunities, then a grill (heavy tier: announce and confirm first)
- `webapp-testing` - Playwright toolkit for driving/testing the local web app

All of these are model-invocable; select them dynamically based on the ongoing task's needs (see Behaviour above).
Standard skills run autonomously. `improve-codebase-architecture` is the one heavy skill: run it only on a strong task match and only after announcing it and getting confirmation (see the two-tier policy in Behaviour).

MCP servers are configured in `.kiro/settings/mcp.json`:
- `shadcn` - shadcn/ui component search/install (enabled)
- `aceternity-ui` - Aceternity UI component search/install (enabled)
- `firecrawl` - web scraping/extraction (enabled; `FIRECRAWL_API_KEY` is set)

CLI quality/automation tools:
- `gnhf` - autonomous overnight agent loop (installed globally)
- `no-mistakes` - git-proxy quality gate + clean-PR pipeline (installed v1.31.2; run `no-mistakes init` once the repo + remote exist)

The always-on coding doctrine lives at `.kiro/steering/coding.md`.

## Engineering Standards (all agents, including external CLIs)

These apply to Kiro and to any external agent (no-mistakes, gnhf, copilot/claude). The always-on core is `.kiro/steering/engineering-standards.md`; the full standards live in `product-ece/` and are pulled on demand.

Non-negotiables for every change (ours and agent-generated code):
- Tools decide correctness, not the model; verify with the deterministic oracle before calling anything correct.
- Validate all external input (client, files, API, model output, web content) at every trust boundary.
- Server-side authN + per-object authZ (IDOR/BOLA) on every endpoint; never trust client/UI/model output as a security control.
- Secrets never in source, bundles, prompts, logs, errors, or traces. One credential has one gitignored source, either the environment or a dedicated single-value credential file, and never a fallback chain.
- Agent-generated code runs only in a sandbox (isolated, no secrets, no default network, resource-capped).
- Side-effectful actions use idempotency keys + approval gate; never blind-retry on timeout.
- Sanitized errors to clients; every failure path handled and fails safe.

Full docs: `product-ece/ECE-CODE-QUALITY-STANDARDS.md`, `product-ece/ECE-SECURITY-PERFORMANCE-RESILIENCE.md`, `product-ece/ECE-VERIFICATION-METHODOLOGY.md`, `product-ece/ECE-PRD-v1.md`. Read the relevant one before coding in its area.

Note: this is build-time guidance. The shipped product enforces the same rules on its own generated code through its runtime system prompt + OKF knowledge + CI/SAST, not through this file.

## Knowledge memory (all agents, including external CLIs)

`chipAgent/` is the build-time knowledge vault: what past sessions already tried, learned, and ruled out.
Read `chipAgent/MANIFEST.md` before non-trivial work - it is a generated flat catalog of every note, so it is one read, not a tree walk.
Scan it for your area, open only the two or three notes that match, and never load the whole vault.
Consulting it is mandatory before debugging a lint/`tsc`/test failure, writing a fake or property test, or touching the verification loop, oracle, sandbox, model router, eval gate, or trust/display layer.

Do not navigate by the `index.md` section maps alone; they lag, and most notes still sit in `_inbox/` unlinked.

`status: trusted` means eval-gated and safe to treat as a correctness claim.
`status: candidate` is not eval-gated but is still authoritative as a record of what happened - what was attempted, what the oracle said, what failed and why.
Use candidates to avoid repeating a dead end; never use them to declare something correct.

Capture new learnings as ONE short `status: candidate` note in `chipAgent/_inbox/` using a `chipAgent/templates/` file and the frontmatter in `chipAgent/_SCHEMA.md`, then run `npm run vault:manifest`.
Never self-promote a note to `trusted` (that needs the eval harness). Secrets/PII go only in `chipAgent/_private/` (gitignored).
The vault is BUILD-time only: it is never shipped, and the product's runtime `retrieve` reads only `app/knowledge/okf-bundle/`.

Kiro's equivalent always-on rule is `.kiro/steering/knowledge-memory.md`; design rationale is `product-ece/ECE-OBSIDIAN-KNOWLEDGE-MEMORY.md`.
