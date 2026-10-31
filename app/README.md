# app/ monorepo

The application code for the ECE Creation Copilot.
The layout mirrors the architectural layers in `product-ece/ECE-CODE-QUALITY-STANDARDS.md` section 3, and dependencies flow inward only:

```
web -> api -> agent -> {knowledge, tools} -> core
```

`eval` and `test` are the outermost consumer layers: no inner layer imports either of them, and each drives the loop through the layers listed for it below.
`test` is the outermost of the two, so it may also drive `@app/eval` (the Eval_Harness integration tests do).

## Layers

| Package         | Path             | May import                         |
| --------------- | ---------------- | ---------------------------------- |
| `@app/core`      | `app/core`       | nothing (innermost)                |
| `@app/knowledge` | `app/knowledge`  | core                               |
| `@app/tools`     | `app/tools`      | core                               |
| `@app/agent`     | `app/agent`      | core, knowledge, tools             |
| `@app/api`       | `app/api`        | agent (and deeper)                 |
| `@app/web`       | `app/web`        | api (and deeper)                   |
| `@app/eval`      | `app/eval`       | api (and deeper)                   |
| `@app/test`      | `app/test`       | eval, web (and deeper)             |

`knowledge` and `tools` are siblings at the same depth and must not import each other.

## How the boundary is enforced (two independent mechanisms)

1. TypeScript project references. Each package's `tsconfig.json` lists only its permitted inner layers under `references`. A build (`npm run build`, i.e. `tsc -b`) cannot resolve a package that is not referenced, so an inner-to-outer import fails to type-check.
2. ESLint boundary rule. The root `eslint.config.js` scopes a `no-restricted-imports` rule per layer that rejects any import of an outer or non-inner-sibling `@app/*` package at author time, with an actionable message. Run it with `npm run lint:boundaries`.

The two mechanisms are deliberately redundant: references catch it at build time, and the lint rule catches it earlier with a clearer explanation.

## Python

The only Python in the repo is the thin Tool_Runner worker at `app/tools/sandbox/worker`, which has its own `pyproject.toml`.
It is the sole TypeScript-to-Python seam; `app/tools/sandbox/worker/README.md` owns the responsibility split across it.

## Layout

```
app/
  core/        # domain types + pure logic (trust, verdict, budget, eval-gate, models)
    redaction/ # the Secret_Pattern_Set: the one set of secret-shaped tokens we redact by
  knowledge/   # Knowledge_Retriever, OKF traversal, web-fetch adapter
    okf-bundle/
  tools/       # Tool_Runner sandbox + EDA adapters
    sandbox/
      worker/  # thin Python worker (own pyproject.toml)
    simulator/ # the Icarus oracle adapter + the product-written Simulation_Harness
    synth/
    formal/    # the formal oracle adapter: Yosys/yosys-smtbmc report parsing + the five-condition gate
    mutation/  # the pure mutation vocabulary: what a mutant is and the fixed operator order
    verilog/   # the shared source mask, the typed Formal_Property, and the token admission lexer
  agent/       # Orchestrator + roles + Model_Router + Action_Recorder
    orchestrator/  roles/  model-router/  action-recorder/
    consensus/ # the Reference_Model_Consensus_Gate's decision algebra (agreement, grant, trust vote)
  api/         # API_Gateway + Project_Store
    project-store/
  web/         # Editor, Display_Layer, Waveform_Viewer, Schematic_View, Live_Run
  eval/        # Eval_Harness + the eval corpora
    corpus/    # RTLLM import (pinned fetch) + the independent golden-testbench judge
    sweep/     # the sweep runner: campaign configs, pass@k aggregation, transport throttling
    gate/      # the ratcheting pass@k CI gate
    property-only/  # Property_Only_Mode's own entry point, off the Student_Path by construction
    scripts/   # per-campaign measurement entry points: replay gate, probes, closeouts
  test/        # shared property generators + integration fixtures
```

## Eval corpus (RTLLM)

The benchmark corpus is **fetched at a pinned commit, not vendored**.
Run `npm run corpus:fetch` to materialize it into the gitignored `.eval-corpus/rtllm/`; the step is idempotent and verifies the checkout landed on the pinned commit, failing loudly otherwise.
The pinned commit is a named constant (`RTLLM_PINNED_COMMIT` in `app/eval/corpus/pinned-source.ts`) so a run manifest can cite it: a corpus that moves silently invalidates every historical pass@k number and the eval-gate baseline.

Two verdicts are recorded per eval sample, and the distinction matters.
The Verification_Loop's own oracle runs the **agent's** spec-derived testbench, which is what makes repair possible but makes its verdict self-graded.
RTLLM's `testbench.v` is an **independent** judge we neither wrote nor modify, so it decides the reported pass@k, and the agreement rate between the two is the empirical measure of whether our generated testbenches actually catch bugs.
Before any of that is trusted, Stage 0 (`app/test/rtllm-corpus-stage0.integration.test.ts`) drives each design's own reference RTL against its own golden testbench through real `iverilog`, because a golden testbench that the reference itself fails is an unusable measuring stick.

### Attribution

The corpus is [RTLLM](https://github.com/hkust-zhiyao/RTLLM), **MIT licensed**, copyright (c) 2024 Nora Lu.
We redistribute none of it: it is downloaded at build time and only read.
Per the upstream README, cite:

- Lu, Yao; Liu, Shang; Zhang, Qijun; Xie, Zhiyao. "RTLLM: An Open-Source Benchmark for Design RTL Generation with Large Language Model." 2024 29th Asia and South Pacific Design Automation Conference (ASP-DAC), 2024, pp. 722-727, IEEE.
- Liu, Shang; Lu, Yao; Fang, Wenji; Li, Mengming; Xie, Zhiyao. "OpenLLM-RTL: Open Dataset and Benchmark for LLM-Aided Design RTL Generation (Invited)." Proceedings of 2024 IEEE/ACM International Conference on Computer-Aided Design (ICCAD), 2024, ACM.
