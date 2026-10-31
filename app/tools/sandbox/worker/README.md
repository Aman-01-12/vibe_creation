# tool-runner-worker

The thin Python worker that runs inside the Tool_Runner sandbox.

This is the only place Python exists in the repo (settled decision OD-1).
It is deliberately minimal EDA glue: it invokes `iverilog` and `vvp` for simulation and Yosys plus `yosys-smtbmc` for the formal oracle, writes workspace files, and returns a result over the language-neutral job/result schema defined at the TypeScript-to-Python seam.

Verdict and trust decisions stay on the TypeScript side under `app/tools/sandbox`: the worker reports raw capture and never classifies capture-all-or-error, never decides a verdict, and never labels trust.
The formal path holds to the same rule - it reports the assertion count and each check's status and leaves the five-condition gate that turns those numbers into `proved`/`refuted`/`could-not-verify` to `app/tools/formal`.
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

Three of the schema's four job kinds are dispatched here.
`simulate` (the oracle path) validates the job, materializes the confined workspace, invokes `iverilog` + `vvp`, and reports the raw capture.
`formal` lowers the sources to SMT2 through one fixed Yosys sequence, counts the assertions that reached the SMT2, runs the four `yosys-smtbmc` checks under `-s bitwuzla` with a `z3` cross-check of any `PROVED`-shaped one, and reports the numbers.
`formalPrepass` is a second, solver-free Yosys invocation over the candidate design alone, because the reset and clock contracts must be read before the property wrapper a `formal` job runs against exists.
`synthesize` (Yosys synthesis) is still a later worker slice, and an undispatched job kind is reported as an honest non-zero capture with no artifact rather than a fabricated result.
See the module docstrings in `src/tool_runner_worker/eda.py` for the per-path detail.

## Environment

Use the repo virtual environment (`.venv`, Python 3.12, managed by `uv`).
Install this package in editable mode with its test extra:

```sh
uv pip install --python ../../../../.venv -e '.[test]'
```
