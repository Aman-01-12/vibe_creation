---
inclusion: always
---

# Development Tooling - What's Installed & When to Use It

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
| `algorithmic-art` | Generative/algorithmic visuals (p5.js) - useful for waveform/behavioral visualizations and shareable "my chip" demos. |
| `improve-codebase-architecture` | Scan the codebase for "deepening" opportunities, present them as a visual HTML report, then grill through a chosen one. **Heavy tier**: model-invocable but requires announce + confirmation before running, and only on a strong architecture-task match. |
| `webapp-testing` | Playwright toolkit to drive/test the local web app - verify frontend behavior, debug UI, capture screenshots, read browser logs. Ships with `examples/` and `scripts/`. **Runtime: use the project venv** - run its scripts as `.venv/bin/python scripts/with_server.py ...` (Playwright is installed there, not globally). |

## MCP servers (in `.kiro/settings/mcp.json`)

| Server | Purpose | Status |
|---|---|---|
| `shadcn` | Browse/search/install shadcn/ui components into the project via natural language. | Enabled (pinned `shadcn@4.13.0`). |
| `aceternity-ui` | Search/discover/install Aceternity UI React components for the frontend. | Enabled (pinned `aceternityui-mcp@1.0.2`, no key needed). |
| `firecrawl` | Web scraping/crawling/extraction for datasheets, docs, RAG corpora, competitor research. | **Enabled** (pinned `firecrawl-mcp@3.22.2`; `FIRECRAWL_API_KEY` set). |

## CLI tools (agent-agnostic, run via shell)

| Tool | Purpose | Setup state |
|---|---|---|
| `gnhf` | Autonomous "run overnight" agent loop - each iteration is one small committed change toward an objective. Requires an underlying agent CLI + a git repo with a clean tree. Usage: `gnhf "<objective>" --max-iterations N`. | Installed globally (`npm i -g gnhf`). |
| `no-mistakes` | Git-proxy quality gate: `git push no-mistakes` runs an AI validation pipeline (review→test→docs→lint→PR→CI) in a disposable worktree, auto-fixes safe issues, opens clean PRs. | **Installed** (v1.31.2 at `~/.no-mistakes/bin`, linked in `~/.local/bin`; daemon running). Still needs `no-mistakes init` inside a git repo with a real `origin` remote before it can gate. |

### no-mistakes - remaining activation steps (run once the v1 repo + remote exist)
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

- **Python venv (`.venv/`)** - created with `uv` and pinned to CPython 3.12 (Playwright has no stable 3.14 wheels yet). Playwright 1.61 + Chromium are installed here. The system Python is externally-managed (PEP 668), so never `pip install` globally; use this venv. Recreate with: `uv venv --python 3.12 .venv && uv pip install --python .venv playwright && .venv/bin/python -m playwright install chromium`.
- **Secrets** - `FIRECRAWL_API_KEY` lives in `.kiro/settings/mcp.json`. This file holds a live credential, so it must not be committed. It is covered by `.gitignore`; if you ever move secrets, prefer an untracked local file or environment injection over hardcoding in tracked files.

## Gate economy (measured, not guessed)

Re-measured on this repo, 217 test files and 2508 tests. Use the npm scripts: they carry the cache
flags and the tier split, so an ad-hoc `npx` call is slower than the script for the same answer.

| command | cold | warm |
| --- | --- | --- |
| `npm run typecheck` (`tsc -b`, incremental) | 0s | 0s |
| `npm run format:check` (prettier, cached) | 7s | **1s** |
| `npm run lint` (eslint, cached) | 18s | **1s** |
| `npm test` (everything except integration) | **38s** | - |
| `npm run test:integration` | 73s | - |
| `npm run test:all` | 76s | - |
| `npx vitest run <one file>` | ~1s | - |

The tiers are exhaustive and verified: 201 fast files plus 16 integration files is all 217.
Four integration files are 264s of the 316s of total test time, every one of them spawning the
real toolchain, so they are the on-demand tier and not the inner loop.

Rules:

- **Inner loop is `npm test`.** 38s, covering 2236 of the 2508 tests. Run
  `npm run test:integration` before marking a task done, at every checkpoint, and whenever the
  change touches `app/tools`, the sandbox, the formal adapter, or a schema or version constant.
- **Inside a parallel wave, a subagent runs SCOPED gates only**, because a whole-repo gate
  reports the other agents' half-written files. `npx tsc -p <package>/tsconfig.json`,
  `npx eslint <its paths>`, `npx vitest run <its test files>`. Measured in wave 5 of
  formal-gate-first-light: all five agents saw TS6133 errors from files they never touched, and
  `tsc -b` stops at the first failing project, so an agent cannot even reach its own package.
  The whole-repo sweep is the orchestrator's, at the wave close.
- **A dispatch file allowlist must include the barrel the new module is exported from**, or state
  itself as "these, plus whatever your task text names". A closed list made one agent stop and
  report a required export rather than write it.
- **Do NOT re-run a gate a subagent already ran and reported.** Its report is the evidence.
  Verify independently only at a CHECKPOINT, or when a report is missing, self-contradictory, or
  the dispatch failed.
- **Use `tsc -b`, not `tsc -b --force`.** `--force` discards incremental state for the same
  answer. Reach for it only when the build graph is genuinely suspect.
- **Scope while developing, sweep once at the checkpoint:** `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm run test:all`, `npm run build`. Run them individually, because
  chaining them times out in this workspace.
- **A long shell one-liner gets mangled by this terminal and silently does nothing.** Past roughly
  200 characters, or with many backticks, write the commands to a file under `/tmp` and run that
  file. Measured repeatedly this session: the command echoes back garbled and exits -1.
- Do not re-read a file a subagent already described in its report.

## Dispatch reliability

`spec-task-execution` dispatch is intermittent in this workspace, not reliably dead. It refused
every call across four window reloads and then started working again with no change to how it was
called. Treat a refusal as transient: retry it once at the start of a session before falling back to
implementing directly. The fallback path is real and authorized, but it is serial, so it costs the
wave parallelism, and dispatch is worth one retry first.

## Context economy (the real bottleneck)

Wall clock is not what slows this repo down; context is. Measured on `formal-gate-first-light`:
`design.md` is 157 KB, about 40k tokens, with `tasks.md` and `requirements.md` adding 179 KB more.
A dispatch that reads all three spends roughly 85k tokens before writing a line of code.

The median component section of that design is 2.7 KB, so reading the whole file to get one
component is a 59x overread.

- **Point a task at its component, not at the document.** Every task already names its component,
  so pull that one section instead of the file:
  `npm run spec:section -- formal-gate-first-light C18` (add `--doc requirements.md`, or `--list` to
  see every heading). C4 comes back as 3 KB against the design's 157 KB. Line ranges are computed on
  each run, so nothing to keep in sync.
- **Ask for a short report.** Under about 150 words plus a gate table. A long report is spent out
  of the orchestrator's context, which is the scarce resource, not the subagent's.
- **Read the task text and its one component.** `requirements.md` is needed for the criteria the
  task cites, not in full.
