# tool-runner-worker

The thin Python worker that runs inside the Tool_Runner sandbox.

This is the only place Python exists in the repo (settled decision OD-1).
It is deliberately minimal EDA glue: it invokes `iverilog` and `vvp`, writes workspace files, and returns a result over the language-neutral job/result schema defined at the TypeScript-to-Python seam.

All trust-boundary logic (validation, sandbox caps, path confinement, capture-all-or-error classification) stays on the TypeScript side under `app/tools/sandbox`.
No secrets, credentials, or PII are ever read, logged, or returned by this worker.

## Seam contract

The language-neutral job/result contract is the JSON Schema at `../contract.schema.json` (a byte-mirror of the canonical `sandboxContractSchema` in `../contract-schema.ts`, kept in lockstep by a drift-guard test).
The worker reads a `SandboxJob` (validated against that schema) on stdin and writes back its raw capture (tool exit code, stdout, stderr, artifact references, denied operations, resource usage) on stdout.
The worker never decides the verdict: capture-all-or-error classification stays in the TypeScript adapter.

The simulate (oracle) path is fully implemented here (tasks 3.1-3.2): the worker validates the job, materializes the confined workspace, invokes `iverilog` + `vvp`, and reports the raw capture. Yosys synthesis is a later worker slice; until then an unsupported job kind is reported as an honest non-zero capture rather than a fabricated result.

## Environment

Use the repo virtual environment (`.venv`, Python 3.12, managed by `uv`).
Install this package in editable mode with its test extra:

```sh
uv pip install --python ../../../../.venv -e '.[test]'
```
