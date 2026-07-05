"""Top-level worker orchestration: write, run, capture, report.

Ties the pieces together for one invocation: measure resource usage, materialize
the untrusted job files into the confined workspace (recording any denials),
dispatch on the job kind to the EDA glue, and assemble the raw
:class:`WorkerReport`. No verdict is decided here - the TypeScript adapter owns
capture-all-or-error classification.
"""

from __future__ import annotations

from pathlib import Path

from .commands import CommandRunner
from .contract import SandboxJob
from .eda import EdaCapture, simulate
from .report import WorkerReport
from .resources import start_usage_meter
from .workspace import materialize_workspace

#: Exit code reported for a job kind this worker slice does not implement.
_UNSUPPORTED_KIND_EXIT = 1


def _run_kind(
    job: SandboxJob, workspace_root: Path, source_relpaths: list[str], runner: CommandRunner
) -> EdaCapture:
    """Dispatch to the EDA glue for the job kind, honestly failing the rest."""
    timeout_s = job.limits.wall_ms / 1000.0
    if job.kind == "simulate":
        return simulate(workspace_root, source_relpaths, runner, timeout_s)
    # Synthesis (Yosys) is a later worker slice; report an honest non-zero
    # capture with no artifact rather than fabricating a result.
    return EdaCapture(_UNSUPPORTED_KIND_EXIT, "", f"unsupported job kind: {job.kind}")


def run_job(job: SandboxJob, workspace_root: Path, runner: CommandRunner) -> WorkerReport:
    """Execute one validated job under ``workspace_root`` and return raw capture."""
    meter = start_usage_meter()
    materialized = materialize_workspace(workspace_root, job.workspace_files)
    capture = _run_kind(job, workspace_root, materialized.source_relpaths, runner)
    usage = meter.finish()
    return WorkerReport(
        exit_code=capture.exit_code,
        stdout=capture.stdout,
        stderr=capture.stderr,
        artifacts=capture.artifacts,
        denied_operations=materialized.denied,
        resource_usage=usage,
    )
