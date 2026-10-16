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
from .eda import EdaCapture, formal, formal_prepass, simulate
from .report import WorkerReport
from .resources import start_usage_meter
from .workspace import materialize_workspace

#: Exit code reported for a job this worker REFUSED to turn into a tool invocation -
#: a kind this worker slice does not implement, or a job whose kind and payload
#: disagree. Matches :data:`tool_runner_worker.eda._REFUSED_EXIT`: a non-zero signal
#: with no artifact, which the TypeScript adapter classifies as ``error``.
_REFUSED_EXIT = 1

#: Bytes per mebibyte. ``ResourceLimits.diskMb`` is declared in mebibytes, matching
#: ``memMb`` and the container runtime's own ``size=<n>m`` tmpfs suffix, so the two
#: bounds on the same workspace are expressed in the same unit.
_BYTES_PER_MIB = 1024 * 1024


def _refused(reason: str) -> EdaCapture:
    """An honest non-zero capture for a job no tool was invoked for.

    No artifact and no fabricated stream, so the TypeScript side classifies the run
    ``error`` rather than reading a refusal as a result.
    """
    return EdaCapture(
        _REFUSED_EXIT,
        "",
        reason,
        stdout_truncated=False,
        stderr_truncated=False,
        disk_limit_exceeded=False,
    )


def _run_kind(
    job: SandboxJob, workspace_root: Path, source_relpaths: list[str], runner: CommandRunner
) -> EdaCapture:
    """Dispatch to the EDA glue for the job kind, honestly failing the rest."""
    timeout_s = job.limits.wall_ms / 1000.0
    disk_limit_bytes = job.limits.disk_mb * _BYTES_PER_MIB
    if job.kind == "simulate":
        return simulate(
            workspace_root, source_relpaths, runner, timeout_s, disk_limit_bytes, job.simulate
        )
    if job.kind == "formal":
        if job.formal is None:
            # `load_job` refuses this at the parse boundary, so the remaining way here
            # is a caller assembling a SandboxJob directly. Refused rather than run:
            # there is no default top module or depth to fall back to, and falling
            # through would report a supported kind as unsupported.
            return _refused("formal job carries no formal payload")
        return formal(
            workspace_root, source_relpaths, job.formal, runner, timeout_s, disk_limit_bytes
        )
    if job.kind == "formalPrepass":
        if job.formal_prepass is None:
            # `load_job` refuses this at the parse boundary, so the remaining way here is a
            # caller assembling a SandboxJob directly. Refused rather than run, for the same
            # reason as the `formal` branch: there is no default design name to fall back to,
            # and falling through would report a supported kind as unsupported.
            return _refused("formalPrepass job carries no formalPrepass payload")
        return formal_prepass(
            workspace_root,
            source_relpaths,
            job.formal_prepass,
            runner,
            timeout_s,
            disk_limit_bytes,
        )
    # Synthesis (Yosys) is a later worker slice and is STILL unimplemented; this dispatch
    # gained a THIRD and a FOURTH kind and fixed nothing about the second
    # (`chipAgent/_inbox/gotcha-worker-synthesize-kind-unimplemented.md`). Report an honest
    # non-zero capture with no artifact rather than fabricating a result.
    return _refused(f"unsupported job kind: {job.kind}")


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
        stdout_truncated=capture.stdout_truncated,
        stderr_truncated=capture.stderr_truncated,
        disk_limit_exceeded=capture.disk_limit_exceeded,
        artifacts=capture.artifacts,
        denied_operations=materialized.denied,
        resource_usage=usage,
    )
