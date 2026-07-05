# ECE Creation Copilot

An agentic "vibe-engineering" creation tool for ECE/EE students.
Describe a hardware idea, and the copilot plans it, writes the Verilog and testbench, verifies them with real simulators, and renders the circuit diagram and live simulation on the path to a real chip.

## Where things live

- **`app/`** - the application monorepo (the code). Dependencies flow inward only: `web -> api -> agent -> {knowledge, tools} -> core`. See `app/README.md` for the layer map and how the boundary is enforced.
- **`product-ece/`** - the finalized product docs: philosophy, the v1 PRD (`ECE-PRD-v1.md`), v1 features, tech stack and decisions, knowledge architecture, verification methodology, security/performance/resilience, reliability/self-healing, code-quality standards, and implementation references.
- **`chipAgent/`** - the Obsidian knowledge vault and learning memory (design in `product-ece/ECE-OBSIDIAN-KNOWLEDGE-MEMORY.md`). Start at `chipAgent/index.md`.
- **`.kiro/`** - steering docs, the `hdl-creation-loop` spec (`requirements.md`, `design.md`, `tasks.md`), skills, and hooks.

## Status

This is the M0 spine.
The `app/` monorepo is scaffolded with inward-only layer boundaries, and the deterministic oracle path runs end to end on a hardcoded Verilog module and testbench: Editor -> API_Gateway -> Orchestrator -> sandboxed Tool_Runner -> Icarus (`iverilog` + `vvp`), returning a `pass`/`fail`/`error` verdict.
The M1 single-module hero loop and the Eval_Harness CI gate are planned in `.kiro/specs/hdl-creation-loop/tasks.md`.
