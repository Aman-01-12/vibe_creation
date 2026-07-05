"""Console entry point for the Tool_Runner worker.

Reads a ``SandboxJob`` as JSON on stdin, validates it against the shared seam
schema, runs it inside the confined workspace, and writes the raw
``WorkerReport`` as JSON on stdout - the exact shape ``runtime-runsc.ts`` parses.
A malformed or contract-violating job produces no stdout report and a non-zero
exit, which the TypeScript runtime treats as an infrastructure failure (and so
classifies as ``error``); it is never reported as a run that happened.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from .commands import SubprocessCommandRunner
from .contract import JobContractError, load_job
from .worker import run_job

#: Environment override for the writable workspace mount. In the sandbox this is
#: the size-capped tmpfs at ``/workspace``; locally it falls back to a temp dir.
_WORKSPACE_ENV = "TOOL_RUNNER_WORKSPACE"

_EX_DATAERR = 65  # Input data was incorrect (malformed or contract-violating job).


def _emit_report(raw_stdin: str, workspace_root: Path) -> int:
    """Run the job from ``raw_stdin`` under ``workspace_root`` and print the report."""
    job = load_job(raw_stdin)
    report = run_job(job, workspace_root, SubprocessCommandRunner())
    json.dump(report.as_dict(), sys.stdout)
    sys.stdout.flush()
    return 0


def main() -> int:
    """Entry point. Returns a process exit code."""
    raw_stdin = sys.stdin.read()
    try:
        configured = os.environ.get(_WORKSPACE_ENV)
        if configured:
            workspace_root = Path(configured)
            workspace_root.mkdir(parents=True, exist_ok=True)
            return _emit_report(raw_stdin, workspace_root)
        with tempfile.TemporaryDirectory(prefix="tool-runner-ws-") as tmp:
            return _emit_report(raw_stdin, Path(tmp))
    except JobContractError as contract_error:
        sys.stderr.write(f"tool-runner-worker: {contract_error}\n")
        return _EX_DATAERR


if __name__ == "__main__":
    raise SystemExit(main())
