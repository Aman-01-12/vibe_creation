---
inclusion: always
---

# Development Tooling — What's Installed & When to Use It

This workspace has a set of external agent tools and skills wired in. Per the root
`AGENTS.md` rule, **skill selection is dynamic** and every workspace skill is model-invocable:
reason about the ongoing task and choose the best-fitting skill(s) from the available set on your
own initiative. Two tiers apply: **standard** skills run autonomously; **heavy** skills
(long-running, interactive, whole-codebase, or high token cost - currently
`improve-codebase-architecture`) are also model-invocable but run behind a confirmation
checkpoint (announce which skill and why, then get confirmation) and only on a strong task match.
This file is a reference map of what exists and when each fits.

## Skills (in `.kiro/skills/`, all model-invocable, selected dynamically per task)

| Skill | Use for |
|---|---|
| `lavish` | Turn a plan, comparison, diagram, table, code diff, or report into a rich, reviewable HTML artifact the user can annotate. Runs via `npx -y lavish-axi <file.html>`; poll feedback with `npx -y lavish-axi poll`. |
| `frontend-design` | Distinctive, intentional UI/visual design for the product's browser editor and marketing surfaces. |
| `brand-guidelines` | Applying a consistent brand look-and-feel (colors, typography) to artifacts. |
| `algorithmic-art` | Generative/algorithmic visuals (p5.js) — useful for waveform/behavioral visualizations and shareable "my chip" demos. |
| `improve-codebase-architecture` | Scan the codebase for "deepening" opportunities, present them as a visual HTML report, then grill through a chosen one. **Heavy tier**: model-invocable but requires announce + confirmation before running, and only on a strong architecture-task match. |
| `webapp-testing` | Playwright toolkit to drive/test the local web app — verify frontend behavior, debug UI, capture screenshots, read browser logs. Ships with `examples/` and `scripts/`. **Runtime: use the project venv** — run its scripts as `.venv/bin/python scripts/with_server.py ...` (Playwright is installed there, not globally). |

## MCP servers (in `.kiro/settings/mcp.json`)

| Server | Purpose | Status |
|---|---|---|
| `shadcn` | Browse/search/install shadcn/ui components into the project via natural language. | Enabled (pinned `shadcn@4.13.0`). |
| `aceternity-ui` | Search/discover/install Aceternity UI React components for the frontend. | Enabled (pinned `aceternityui-mcp@1.0.2`, no key needed). |
| `firecrawl` | Web scraping/crawling/extraction for datasheets, docs, RAG corpora, competitor research. | **Enabled** (pinned `firecrawl-mcp@3.22.2`; `FIRECRAWL_API_KEY` set). |

## CLI tools (agent-agnostic, run via shell)

| Tool | Purpose | Setup state |
|---|---|---|
| `gnhf` | Autonomous "run overnight" agent loop — each iteration is one small committed change toward an objective. Requires an underlying agent CLI + a git repo with a clean tree. Usage: `gnhf "<objective>" --max-iterations N`. | Installed globally (`npm i -g gnhf`). |
| `no-mistakes` | Git-proxy quality gate: `git push no-mistakes` runs an AI validation pipeline (review→test→docs→lint→PR→CI) in a disposable worktree, auto-fixes safe issues, opens clean PRs. | **Installed** (v1.31.2 at `~/.no-mistakes/bin`, linked in `~/.local/bin`; daemon running). Still needs `no-mistakes init` inside a git repo with a real `origin` remote before it can gate. |

### no-mistakes — remaining activation steps (run once the v1 repo + remote exist)
```sh
# from inside the repo (must have a real 'origin' remote)
no-mistakes init
# then push through the gate instead of origin
git push no-mistakes <branch>
```

## Guiding principle alignment
These tools reinforce the product's own doctrine (`product-ece/ECE-VERIFICATION-METHODOLOGY.md`):
deterministic gates decide quality (`no-mistakes` pipeline, CI), the agent proposes and iterates,
and human review happens on real artifacts (`lavish`), never on unverified assertions.

## Local environment & secrets

- **Python venv (`.venv/`)** — created with `uv` and pinned to CPython 3.12 (Playwright has no stable 3.14 wheels yet). Playwright 1.61 + Chromium are installed here. The system Python is externally-managed (PEP 668), so never `pip install` globally; use this venv. Recreate with: `uv venv --python 3.12 .venv && uv pip install --python .venv playwright && .venv/bin/python -m playwright install chromium`.
- **Secrets** — `FIRECRAWL_API_KEY` lives in `.kiro/settings/mcp.json`. This file holds a live credential, so it must not be committed. It is covered by `.gitignore`; if you ever move secrets, prefer an untracked local file or environment injection over hardcoding in tracked files.
