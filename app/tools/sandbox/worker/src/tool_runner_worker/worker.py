"""Top-level worker orchestration: write, run, capture, report.

Ties the pieces together for one invocation: measure resource usage, materialize
the untrusted job files into the confined workspace (recording any denials),
dispatch on the job kind to the EDA glue, and assemble the raw
:class:`WorkerReport`. No verdict is decided here - the TypeScript adapter owns
capture-all-or-error classification.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .commands import CommandRunner
from .contract import SandboxJob
from .eda import EdaCapture, formal, formal_prepass, lint, simulate, synthesize
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


@dataclass(frozen=True, slots=True)
class _DispatchArgs:
    """The job and run parameters every kind-specific dispatcher below needs.

    Bundled into one value so each dispatcher takes a single parameter rather than
    the five `_run_kind` otherwise has to repeat per kind.
    """

    job: SandboxJob
    workspace_root: Path
    source_relpaths: list[str]
    runner: CommandRunner
    timeout_s: float
    disk_limit_bytes: int


def _dispatch_formal(args: _DispatchArgs) -> EdaCapture:
    """Run the ``formal`` kind, or an honest refusal when its payload is absent.

    `load_job` refuses a payload-less ``formal`` job at the parse boundary, so the
    remaining way here is a caller assembling a SandboxJob directly. Refused rather
    than run: there is no default top module or depth to fall back to.
    """
    if args.job.formal is None:
        return _refused("formal job carries no formal payload")
    return formal(
        args.workspace_root,
        args.source_relpaths,
        args.job.formal,
        args.runner,
        args.timeout_s,
        args.disk_limit_bytes,
    )


def _dispatch_formal_prepass(args: _DispatchArgs) -> EdaCapture:
    """Run the ``formalPrepass`` kind, or an honest refusal when its payload is absent.

    Same reasoning as :func:`_dispatch_formal`: there is no default design name to
    fall back to for a caller-assembled job that skipped `load_job`.
    """
    if args.job.formal_prepass is None:
        return _refused("formalPrepass job carries no formalPrepass payload")
    return formal_prepass(
        args.workspace_root,
        args.source_relpaths,
        args.job.formal_prepass,
        args.runner,
        args.timeout_s,
        args.disk_limit_bytes,
    )


def _dispatch_synthesize(args: _DispatchArgs) -> EdaCapture:
    """Run the ``synthesize`` kind, or an honest refusal when its payload is absent.

    Same reasoning as :func:`_dispatch_formal`: there is no default top module to
    fall back to for a caller-assembled job that skipped `load_job`.
    """
    if args.job.synthesize is None:
        return _refused("synthesize job carries no synthesize payload")
    return synthesize(
        args.workspace_root,
        args.source_relpaths,
        args.job.synthesize,
        args.runner,
        args.timeout_s,
        args.disk_limit_bytes,
    )


def _dispatch_lint(args: _DispatchArgs) -> EdaCapture:
    """Run the ``lint`` kind, or an honest refusal when its payload is absent.

    Same reasoning as :func:`_dispatch_formal`: there is no default top module to
    fall back to for a caller-assembled job that skipped `load_job`.
    """
    if args.job.lint is None:
        return _refused("lint job carries no lint payload")
    return lint(
        args.workspace_root,
        args.source_relpaths,
        args.job.lint,
        args.runner,
        args.timeout_s,
        args.disk_limit_bytes,
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
    args = _DispatchArgs(job, workspace_root, source_relpaths, runner, timeout_s, disk_limit_bytes)
    if job.kind == "formal":
        return _dispatch_formal(args)
    if job.kind == "formalPrepass":
        return _dispatch_formal_prepass(args)
    if job.kind == "synthesize":
        return _dispatch_synthesize(args)
    if job.kind == "lint":
        return _dispatch_lint(args)
    # Every kind the Seam_Schema admits is dispatched above. Report an honest non-zero
    # capture with no artifact rather than fabricating a result for anything else.
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
