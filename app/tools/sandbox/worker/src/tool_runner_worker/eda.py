"""Thin EDA glue: compile with ``iverilog`` then simulate with ``vvp``.

This is deliberately minimal. It compiles the workspace's Verilog sources, runs
the resulting simulation, and captures the run's exit code, streams, and any VCD
waveform the testbench produced. It makes no verdict decision - it only reports
what happened. When a tool is absent the invocation surfaces as a non-zero exit
with no artifact, which the TypeScript adapter classifies as ``error``; a
successful simulation is never fabricated.

Tool invocation goes through the injected :class:`CommandRunner`, so this glue is
exercised in unit tests with a fake runner even where ``iverilog``/``vvp`` are
not installed.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

from .commands import CommandRunner, CompletedCommand
from .report import ArtifactRef

#: Artifact map key for the waveform, matching the seam's ``RequiredOutput`` name
#: so the TypeScript adapter finds it when ``vcd`` is a required output.
_VCD_ARTIFACT_KEY = "vcd"

#: Name of the compiled simulation image written into the workspace.
_SIM_IMAGE = "simulation.vvp"

#: Exit code reported when there is nothing to compile (all sources were denied
#: or none were provided): a non-zero signal with no fabricated artifact.
_NO_SOURCES_EXIT = 1


@dataclass(frozen=True, slots=True)
class EdaCapture:
    """The raw capture of one EDA invocation (no verdict).

    The truncation flags describe the streams THIS capture reports, which is the
    only honest reading: a compile that overflowed its cap but still exited zero
    has its streams discarded in favour of the simulation's, so its truncation
    says nothing about the output the caller receives.

    ``disk_limit_exceeded`` is different in kind: the disk cap is measured over the
    whole workspace, which both invocations share, so a breach by EITHER of them is
    a fact about the run the caller receives and is carried forward accordingly.
    """

    exit_code: int | None
    stdout: str
    stderr: str
    #: True when the reported standard output is a bounded prefix, not the whole
    #: stream, so a discarded ``CHECK ... FAIL`` line cannot be ruled out.
    stdout_truncated: bool
    #: True when the reported standard error is a bounded prefix, not the whole stream.
    stderr_truncated: bool
    #: True when an invocation was KILLED for exceeding the workspace disk cap, so
    #: the run stopped mid-flight and its evidence is incomplete. Required rather
    #: than defaulted, for the same reason as the truncation flags: a producer that
    #: could omit it would report a killed run as one that finished.
    disk_limit_exceeded: bool
    artifacts: dict[str, ArtifactRef] = field(default_factory=dict)


#: Bytes read per chunk while hashing a produced artifact.
_HASH_CHUNK_BYTES = 65_536


def _hash_artifact(path: Path, workspace_root: Path) -> ArtifactRef:
    """Build an :class:`ArtifactRef` (name, size, SHA-256) for a produced file.

    Read in fixed-size chunks rather than whole. A waveform is as large as the run
    was allowed to make it - now the workspace disk cap, previously nothing at all -
    so slurping it would spend that entire budget in memory just to hash it, which
    is the same resource-exhaustion shape one layer over.
    """
    digest = hashlib.sha256()
    size_bytes = 0
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK_BYTES):
            digest.update(chunk)
            size_bytes += len(chunk)
    return ArtifactRef(
        name=str(path.relative_to(workspace_root)),
        size_bytes=size_bytes,
        sha256=digest.hexdigest(),
    )


def _collect_vcd(workspace_root: Path) -> dict[str, ArtifactRef]:
    """Register the first VCD waveform found in the workspace, if any."""
    vcd_files = sorted(workspace_root.rglob("*.vcd"))
    if not vcd_files:
        return {}
    return {_VCD_ARTIFACT_KEY: _hash_artifact(vcd_files[0], workspace_root)}


def simulate(
    workspace_root: Path,
    source_relpaths: list[str],
    runner: CommandRunner,
    timeout_s: float,
    disk_limit_bytes: int,
) -> EdaCapture:
    """Compile and simulate the workspace sources, capturing the run's facts.

    Both invocations run under the same wall-clock and workspace-disk bounds. The
    disk cap is a ceiling on the whole workspace rather than on either step, because
    that is the resource the host actually has: the compiled image and the waveform
    accumulate in the same directory.
    """
    if not source_relpaths:
        return EdaCapture(
            _NO_SOURCES_EXIT,
            "",
            "no Verilog source files to compile",
            stdout_truncated=False,
            stderr_truncated=False,
            disk_limit_exceeded=False,
        )

    compile_cmd = ["iverilog", "-g2012", "-o", _SIM_IMAGE, *source_relpaths]
    compiled: CompletedCommand = runner.run(
        compile_cmd, workspace_root, timeout_s, disk_limit_bytes
    )
    if compiled.exit_code != 0:
        # Compile failed: report the compiler's exit and diagnostics, no artifact.
        return EdaCapture(
            compiled.exit_code,
            compiled.stdout,
            compiled.stderr,
            stdout_truncated=compiled.stdout_truncated,
            stderr_truncated=compiled.stderr_truncated,
            disk_limit_exceeded=compiled.disk_limit_exceeded,
        )

    run = runner.run(["vvp", _SIM_IMAGE], workspace_root, timeout_s, disk_limit_bytes)
    return EdaCapture(
        exit_code=run.exit_code,
        stdout=run.stdout,
        stderr=run.stderr,
        stdout_truncated=run.stdout_truncated,
        stderr_truncated=run.stderr_truncated,
        # Either step can breach a cap they share, and a breach during compile is
        # still a breach by the time the simulation is reported.
        disk_limit_exceeded=compiled.disk_limit_exceeded or run.disk_limit_exceeded,
        artifacts=_collect_vcd(workspace_root),
    )
