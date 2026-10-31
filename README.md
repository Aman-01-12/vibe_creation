# ECE Creation Copilot

An agentic "vibe-engineering" creation tool for ECE/EE students.
Describe a hardware idea, and the copilot plans it, writes the Verilog and testbench, verifies them with real simulators, and renders the circuit diagram and live simulation on the path to a real chip.

## Where things live

- **`app/`** - the application monorepo (the code). Dependencies flow inward only: `web -> api -> agent -> {knowledge, tools} -> core`. See `app/README.md` for the layer map and how the boundary is enforced.
- **`product-ece/`** - the finalized product docs: philosophy, the v1 PRD (`ECE-PRD-v1.md`), v1 features, tech stack and decisions, knowledge architecture, verification methodology, security/performance/resilience, reliability/self-healing, code-quality standards, and implementation references.

Two development-process trees are deliberately local-only: both are gitignored and untracked, so a fresh clone does not contain them and an edit inside them is never pushed.

- **`chipAgent/`** - the Obsidian knowledge vault and learning memory on the developer's machine (design in `product-ece/ECE-OBSIDIAN-KNOWLEDGE-MEMORY.md`). Where it is present, start at `chipAgent/MANIFEST.md`, the generated catalog of every note; regenerate it with `npm run vault:manifest`.
- **`.kiro/`** - steering docs, the specs under `.kiro/specs/` (one folder per spec, each with `requirements.md`, `design.md`, `tasks.md`), skills, and hooks.

## Status

The M1 foundation is in place.
The `app/` monorepo is scaffolded with inward-only layer boundaries, and the single-module loop runs end to end through the deterministic oracle: Editor -> API_Gateway -> Orchestrator -> Intent/Spec -> Generation plus an RTL-isolated Testbench -> Verification_Loop -> sandboxed Tool_Runner -> Icarus (`iverilog` + `vvp`), with the Trust_Labeler and a fail-closed Display_Layer deciding what a `Verified` label is allowed to claim.
Before that oracle spends an iteration, the generated testbench is desugared by a deterministic, model-free Dialect_Normalizer and then build-checked by the Testbench_Precheck against a spec-derived interface stub, with one Testbench_Repair attempt on a build failure; a testbench that still will not build is refused as a measuring instrument rather than scored as a failure of the student's design.
Every Testbench_Run now compiles against a product-written Simulation_Harness that owns `dump.vcd` and a Watchdog, so a hung run ends on a measured simulated-time budget and is recorded as our liveness bound rather than charged to the student's design; the testbench reports each check through the harness's reporting task, with both the expected and the observed value, so a failure is actionable instead of valueless.
The sandbox bounds a runaway simulation behind that: captured output is streamed to a fixed ceiling with truncation flagged, `ResourceLimits.diskMb` is enforced while the tool runs, and the workspace lifecycle is owned by the side that issues the kill.
Truncated output, a disk-cap kill, and incomplete check coverage each force a non-passing verdict rather than a pass on partial evidence.
A second deterministic oracle is landing alongside the simulator: a formal property path where the sandboxed worker lowers the design plus a stated property to SMT2 through Yosys and runs the `yosys-smtbmc` checks, and a five-condition gate in `app/tools/formal` decides `proved`, `refuted`, or a third `could-not-verify` label rather than reading a bare `PASSED` as verified.
The Reference_Model_Consensus_Gate's decision algebra and its real-toolchain harness are in progress.
The real provider path (an OpenAI-compatible bedrock-mantle transport with an env-backed secret manager and measured token usage) and the Eval_Harness with its sweep runner are stood up for the first measured campaign.
The eval pass@k CI gate is still unarmed, because no non-zero baseline has been measured yet: lint, type, unit, and property gates remain the merge authority, and `app/eval/eval-baseline.json` records the arming procedure.
Per-task plan state lives in each spec's `tasks.md` under the local-only `.kiro/specs/` tree described above.
