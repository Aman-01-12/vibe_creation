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
  knowledge/   # Knowledge_Retriever, OKF traversal, web-fetch adapter
    okf-bundle/
  tools/       # Tool_Runner sandbox + EDA adapters
    sandbox/
      worker/  # thin Python worker (own pyproject.toml)
    simulator/
    synth/
  agent/       # Orchestrator + roles + Model_Router + Action_Recorder
    orchestrator/  roles/  model-router/  action-recorder/
  api/         # API_Gateway + Project_Store
    project-store/
  web/         # Editor, Display_Layer, Waveform_Viewer, Schematic_View, Live_Run
  eval/        # Eval_Harness + VerilogEval/RTLLM subset fixtures
  test/        # shared property generators + integration fixtures
```
