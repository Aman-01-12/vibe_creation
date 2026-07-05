# Verification Methodology — "Not a Prompt Wrapper"

## Prime directive
**The LLM proposes; deterministic tools decide.** The LLM NEVER judges correctness
("is this code right?"). A real tool produces ground truth; the LLM only orchestrates,
interprets tool output, fixes, and explains.

## Task → ground-truth tool (LLM never verifies)
| Operation | Deterministic oracle | LLM role |
|---|---|---|
| Syntax / compile | Icarus / Verilator compiler | read error → fix → re-run |
| Functional correctness | simulation + testbench (pass/fail) | interpret failures, iterate |
| Lint / style | Verilator lint, Verible | apply fixes |
| Synthesis (real HW?) | Yosys (gate count, warnings) | explain |
| Timing | static timing analysis (STA) | explain slack |
| Formal / critical props | SymbiYosys (proof) | choose properties |
| Circuit diagram | Yosys → netlistsvg (rendered) | annotate |
| PCB track | ERC / DRC / SPICE | interpret violations |

## The circular-verification trap (critical)
Running a testbench is meaningless if the LLM wrote BOTH the design and the test
(it writes a test that agrees with its own bug). Mitigations = the real method:
1. **Spec-derived independent tests** — testbench generated from the *intent/spec*, in a separate step, not from the generated RTL.
2. **Golden reference model** — implement intended behavior independently (small Python/HLS model); **differential-test** RTL vs. reference over many inputs.
3. **Formal properties / assertions** — mathematically checked invariants, testbench-independent.
4. **Known-answer anchors** — standard blocks checked vs. established truth tables.
5. **Random / property-based stimulus** — many inputs, not cherry-picked.
Correctness = an *independent* oracle agreeing. Never the model grading its own work.

## Testing OUR system (during development) — no LLM self-verification
- **Unit + integration tests** for every tool-runner, parser, orchestration step.
- **Eval harness** vs. public benchmarks (VerilogEval, RTLLM) as a **regression suite** → objective pass@k, tracked over time.
- **Golden traces** of agent runs → detect regressions.
- **CI** blocks merges on test/eval failure.
- **Metrics**: pass rate, iterations-to-pass, cost/session → decisions by data, not vibes.
- (Property-based tests where we can specify invariants of our own code.)

## What the LLM is actually good for (and limited to)
- NL intent ↔ architecture/decomposition.
- Generating *candidate* RTL/testbench/BOM (proposals).
- Interpreting deterministic tool errors and deciding the next action.
- Explaining/teaching.
It is a proposer + interpreter + orchestrator — **not** a judge of correctness.
