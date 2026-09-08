"""Materializing untrusted job files into the confined workspace, and measuring it.

Each source file's path is confined to the workspace before it is written
(:mod:`tool_runner_worker.paths`). A rejected path is never written; it is turned
into a recorded :class:`DeniedOperation` so the Trace shows the denial. Accepted
files are written under the workspace, and the Verilog sources among them are
returned as workspace-relative names for the compiler to consume.

This module also owns :func:`workspace_size_bytes`, the measurement the disk cap
in :mod:`tool_runner_worker.commands` is enforced against. Sizing the workspace is
a fact about the workspace, so it lives beside the code that populates it.
"""

from __future__ import annotations

import os
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


def workspace_size_bytes(workspace_root: Path) -> int:
    """Total apparent size of the regular files under ``workspace_root``.

    This is the quantity ``ResourceLimits.diskMb`` caps. It is measured WHILE a
    tool runs (see :mod:`tool_runner_worker.commands`), because a run that has
    already written its way through the cap has already done the damage: a
    testbench that calls ``$dumpfile``/``$dumpvars`` and never reaches ``$finish``
    writes a waveform continuously, measured here at tens of megabytes per second.

    SYMLINKS ARE NEVER FOLLOWED. The simulation is arbitrary generated code and can
    create a link inside its own workspace pointing anywhere, so following one would
    measure something the run does not own - and could make a huge, unrelated tree
    look like a cap breach. Only real directories are descended into and only real
    files are counted; a link is neither, so it contributes nothing.

    NEVER RAISES. The tree is being written to concurrently by the very child this
    measurement exists to bound, so entries appear and vanish mid-walk. Every
    per-entry and per-directory failure is skipped, because a measurement that
    could throw would turn a resource guard into a way to crash the worker - and
    the run's own verdict must never depend on how well its workspace could be
    sized.

    "Apparent size" means the sum of ``st_size``: block rounding, sparse holes, and
    filesystem overhead are deliberately not modelled. The cap is a ceiling on what
    the run WROTE, not a filesystem accounting instrument.
    """
    total = 0
    pending = [workspace_root]
    while pending:
        current = pending.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    total += _entry_bytes(entry, pending)
        except OSError:
            # Unreadable or vanished directory: skip it rather than fail the run.
            continue
    return total


def _entry_bytes(entry: os.DirEntry[str], pending: list[Path]) -> int:
    """Size one walked entry, queueing real subdirectories onto ``pending``.

    Returns the bytes the entry contributes: its own size when it is a real file,
    and zero for a directory (queued instead), a symlink, or an entry that vanished
    between being listed and being stat-ed.
    """
    try:
        if entry.is_dir(follow_symlinks=False):
            pending.append(Path(entry.path))
            return 0
        if entry.is_file(follow_symlinks=False):
            return entry.stat(follow_symlinks=False).st_size
    except OSError:
        return 0
    return 0
