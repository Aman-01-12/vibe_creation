"""Example tests for the worker's path-confinement security core (Req 2.6, 2.7).

These are example/unit tests: they prove confinement rejects each attack class
and confines legitimate workspace paths, and that a rejected path is recorded as
a ``DeniedOperation`` and never written. The formally numbered, 100+ iteration
Hypothesis Property 9 (with its ``Feature: hdl-creation-loop, Property 9`` tag)
lands separately in task 3.4; the small ``unsafe_path_strings`` reuse below is an
example-level confinement check, not that tagged property.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from hypothesis import given
from property_harness import unsafe_path_strings

from tool_runner_worker.contract import SourceFile
from tool_runner_worker.paths import (
    ConfinedPath,
    RejectedPath,
    RejectionReason,
    confine_path,
)
from tool_runner_worker.workspace import materialize_workspace

# One representative of every syntactic attack class the screen must reject.
_REJECTED_CASES: list[tuple[str, RejectionReason]] = [
    ("", RejectionReason.EMPTY),
    ("dut\x00.v", RejectionReason.NUL_BYTE),
    ("%2e%2e%2fsecret.v", RejectionReason.PERCENT_ENCODED),
    ("..%2fsecret.v", RejectionReason.PERCENT_ENCODED),
    ("..\\windows.v", RejectionReason.BACKSLASH),
    ("sub\\nested.v", RejectionReason.BACKSLASH),
    ("/etc/passwd", RejectionReason.ABSOLUTE),
    ("../escape.v", RejectionReason.TRAVERSAL),
    ("nested/../../escape.v", RejectionReason.TRAVERSAL),
]

# Legitimate workspace-relative paths that must be accepted and confined.
_ACCEPTED_CASES = ["top.v", "dut.sv", "rtl/adder.v", "tb/counter_tb.sv"]


@pytest.mark.parametrize(("raw", "reason"), _REJECTED_CASES)
def test_rejects_each_attack_class(tmp_path: Path, raw: str, reason: RejectionReason) -> None:
    """Every syntactic attack class is rejected with its precise reason."""
    result = confine_path(tmp_path, raw)
    assert isinstance(result, RejectedPath)
    assert result.reason is reason


@pytest.mark.parametrize("raw", _ACCEPTED_CASES)
def test_accepts_and_confines_legitimate_paths(tmp_path: Path, raw: str) -> None:
    """A legitimate relative path resolves to a target inside the workspace."""
    result = confine_path(tmp_path, raw)
    assert isinstance(result, ConfinedPath)
    assert result.resolved.relative_to(tmp_path.resolve())


def test_rejects_symlink_style_escape(tmp_path: Path) -> None:
    """A path through an in-workspace symlink that points outside is rejected."""
    outside = tmp_path.parent / "outside_target"
    outside.mkdir()
    link = tmp_path / "link"
    link.symlink_to(outside, target_is_directory=True)

    result = confine_path(tmp_path, "link/loot.v")

    assert isinstance(result, RejectedPath)
    assert result.reason is RejectionReason.ESCAPES_WORKSPACE


def test_rejected_path_is_recorded_and_never_written(tmp_path: Path) -> None:
    """A denied write is recorded as a filesystem denial and leaves no file."""
    files = [
        SourceFile(path="top.v", contents="module top; endmodule"),
        SourceFile(path="../escape.v", contents="module evil; endmodule"),
    ]

    outcome = materialize_workspace(tmp_path, files)

    assert outcome.source_relpaths == ["top.v"]
    assert (tmp_path / "top.v").read_text() == "module top; endmodule"
    assert not (tmp_path.parent / "escape.v").exists()
    assert len(outcome.denied) == 1
    denial = outcome.denied[0]
    assert denial.kind == "filesystem"
    assert denial.path == "../escape.v"
    assert denial.detail == RejectionReason.TRAVERSAL.value


@given(unsafe_path_strings())
def test_shared_unsafe_paths_are_confined_out(path: str) -> None:
    """Reuse the shared unsafe-path strategy: every such path is rejected.

    An example-level confinement check over the same strategy the tagged
    Property 9 (task 3.4) will use; it asserts none of these hostile paths is
    ever accepted for writing.
    """
    # Every unsafe string fails the syntactic screen, so this root is only a
    # resolution anchor and is never written to.
    root = Path("tool-runner-confinement-example-root")
    assert isinstance(confine_path(root, path), RejectedPath)
