"""Materializing untrusted job files into the confined workspace.

Each source file's path is confined to the workspace before it is written
(:mod:`tool_runner_worker.paths`). A rejected path is never written; it is turned
into a recorded :class:`DeniedOperation` so the Trace shows the denial. Accepted
files are written under the workspace, and the Verilog sources among them are
returned as workspace-relative names for the compiler to consume.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .contract import SourceFile
from .paths import RejectedPath, confine_path
from .report import DeniedOperation

#: File suffixes treated as Verilog/SystemVerilog compiler inputs.
_VERILOG_SUFFIXES = frozenset({".v", ".sv", ".vh", ".svh"})


@dataclass(frozen=True, slots=True)
class MaterializedWorkspace:
    """The outcome of writing job files: compiler inputs plus recorded denials."""

    source_relpaths: list[str] = field(default_factory=list)
    denied: list[DeniedOperation] = field(default_factory=list)


def _write_confined(target: Path, contents: str) -> None:
    """Write ``contents`` to a confined target, creating parent dirs as needed."""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(contents, encoding="utf-8")


def materialize_workspace(workspace_root: Path, files: list[SourceFile]) -> MaterializedWorkspace:
    """Confine and write every job file into ``workspace_root``.

    Returns the workspace-relative names of the written Verilog sources and the
    denials recorded for any path that failed confinement.
    """
    root = workspace_root.resolve()
    outcome = MaterializedWorkspace()
    for source in files:
        result = confine_path(root, source.path)
        if isinstance(result, RejectedPath):
            outcome.denied.append(
                DeniedOperation(kind="filesystem", detail=result.reason.value, path=source.path)
            )
            continue
        # Narrowed to ConfinedPath by the guard above.
        _write_confined(result.resolved, source.contents)
        if result.resolved.suffix in _VERILOG_SUFFIXES:
            outcome.source_relpaths.append(str(result.resolved.relative_to(root)))
    return outcome
