# tool-runner-worker

The thin Python worker that runs inside the Tool_Runner sandbox.

This is the only place Python exists in the repo (settled decision OD-1).
It is deliberately minimal EDA glue: it invokes `iverilog` and `vvp`, writes workspace files, and returns a result over the language-neutral job/result schema defined at the TypeScript-to-Python seam.

Verdict and trust decisions stay on the TypeScript side under `app/tools/sandbox`: the worker reports raw capture and never classifies capture-all-or-error, never decides a verdict, and never labels trust.
Two resource bounds are enforced here rather than there, because the worker is the only side that can see the running tool and its workspace on the isolated runtime (the production workspace is a tmpfs inside the gVisor container, which the host cannot measure):

- The tool's stdout and stderr are streamed and only retained up to a fixed ceiling, so peak memory does not scale with how much a non-terminating simulation writes. Truncation is flagged across the seam.
- `ResourceLimits.diskMb` is measured against the workspace while the tool runs and the tool is killed on breach, reported across the seam as a distinct disk-cap sentinel exit plus `diskLimitExceeded`.

Both flags force a non-passing verdict on the TypeScript side; the worker does not get to decide what they mean.
The workspace directory itself is created by TypeScript, passed in through the `TOOL_RUNNER_WORKSPACE` environment variable, and removed by TypeScript, because the side that issues the wall-clock SIGKILL is the only side whose cleanup path still runs after it (see `../workspace-lifecycle.ts`).
No secrets, credentials, or PII are ever read, logged, or returned by this worker.

## Seam contract

The language-neutral job/result contract is the JSON Schema at `../contract.schema.json` (a byte-mirror of the canonical `sandboxContractSchema` in `../contract-schema.ts`, kept in lockstep by a drift-guard test).
The worker reads a `SandboxJob` (validated against that schema) on stdin and writes back its raw capture on stdout; the schema is the authoritative field list, so it is not restated here.
A malformed or contract-violating job produces no report and a non-zero exit, which the TypeScript runtime treats as an infrastructure failure rather than as a run that happened.

The simulate (oracle) path is fully implemented here (tasks 3.1-3.2): the worker validates the job, materializes the confined workspace, invokes `iverilog` + `vvp`, and reports the raw capture. Yosys synthesis is a later worker slice; until then an unsupported job kind is reported as an honest non-zero capture rather than a fabricated result.

## Environment

Use the repo virtual environment (`.venv`, Python 3.12, managed by `uv`).
Install this package in editable mode with its test extra:

```sh
uv pip install --python ../../../../.venv -e '.[test]'
```
