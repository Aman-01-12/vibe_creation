# ECE Creation Copilot

An agentic "vibe-engineering" creation tool for ECE/EE students.
Describe a hardware idea, and the copilot plans it, writes the Verilog and testbench, verifies them with real simulators, and renders the circuit diagram and live simulation on the path to a real chip.

## Where things live

- **`app/`** - the application monorepo (the code). Dependencies flow inward only: `web -> api -> agent -> {knowledge, tools} -> core`. See `app/README.md` for the layer map and how the boundary is enforced.
- **`product-ece/`** - the finalized product docs: philosophy, the v1 PRD (`ECE-PRD-v1.md`), v1 features, tech stack and decisions, knowledge architecture, verification methodology, security/performance/resilience, reliability/self-healing, code-quality standards, and implementation references.
- **`chipAgent/`** - the Obsidian knowledge vault and learning memory (design in `product-ece/ECE-OBSIDIAN-KNOWLEDGE-MEMORY.md`). Start at `chipAgent/index.md`.
- **`.kiro/`** - steering docs, the `hdl-creation-loop` spec (`requirements.md`, `design.md`, `tasks.md`), skills, and hooks.

## Status

The M1 foundation is in place.
The `app/` monorepo is scaffolded with inward-only layer boundaries, and the single-module loop runs end to end through the deterministic oracle: Editor -> API_Gateway -> Orchestrator -> Intent/Spec -> Generation plus an RTL-isolated Testbench -> Verification_Loop -> sandboxed Tool_Runner -> Icarus (`iverilog` + `vvp`), with the Trust_Labeler and a fail-closed Display_Layer deciding what a `Verified` label is allowed to claim.
The sandbox bounds a runaway simulation: captured output is streamed to a fixed ceiling with truncation flagged, `ResourceLimits.diskMb` is enforced while the tool runs, and the workspace lifecycle is owned by the side that issues the kill.
Truncated output, a disk-cap kill, and incomplete check coverage each force a non-passing verdict rather than a pass on partial evidence.
The real provider path (an OpenAI-compatible bedrock-mantle transport with an env-backed secret manager and measured token usage) and the Eval_Harness with its sweep runner are stood up for the first measured campaign.
The eval pass@k CI gate is still unarmed, because no non-zero baseline has been measured yet: lint, type, unit, and property gates remain the merge authority, and `app/eval/eval-baseline.json` records the arming procedure.
Per-task plan state lives in `.kiro/specs/hdl-creation-loop/tasks.md`.
