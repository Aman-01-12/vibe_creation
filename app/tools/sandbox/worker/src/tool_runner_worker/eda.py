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
    """The raw capture of one EDA invocation (no verdict)."""

    exit_code: int | None
    stdout: str
    stderr: str
    artifacts: dict[str, ArtifactRef] = field(default_factory=dict)


def _hash_artifact(path: Path, workspace_root: Path) -> ArtifactRef:
    """Build an :class:`ArtifactRef` (name, size, SHA-256) for a produced file."""
    data = path.read_bytes()
    return ArtifactRef(
        name=str(path.relative_to(workspace_root)),
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
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
) -> EdaCapture:
    """Compile and simulate the workspace sources, capturing the run's facts."""
    if not source_relpaths:
        return EdaCapture(_NO_SOURCES_EXIT, "", "no Verilog source files to compile")

    compile_cmd = ["iverilog", "-g2012", "-o", _SIM_IMAGE, *source_relpaths]
    compiled: CompletedCommand = runner.run(compile_cmd, workspace_root, timeout_s)
    if compiled.exit_code != 0:
        # Compile failed: report the compiler's exit and diagnostics, no artifact.
        return EdaCapture(compiled.exit_code, compiled.stdout, compiled.stderr)

    run = runner.run(["vvp", _SIM_IMAGE], workspace_root, timeout_s)
    return EdaCapture(
        exit_code=run.exit_code,
        stdout=run.stdout,
        stderr=run.stderr,
        artifacts=_collect_vcd(workspace_root),
    )
