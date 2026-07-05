"""Property 9: generated code stays inside its sandbox workspace (task 3.4).

The universal complement to the example checks in ``test_path_confinement.py``.
Those examples pin one representative of each attack class; this suite asserts
the same confinement guarantee holds *for any* generated path, over 100+ inputs.

The guarantee (Design: Property 9; Req 2.6, 2.7) has three testable halves, one
per property below:

  1. Every hostile path (empty, NUL, percent-encoded, backslash, absolute, or
     traversal) is rejected, the rejection is recorded as a filesystem
     ``DeniedOperation``, and nothing is written into the workspace.
  2. Every legitimate workspace-relative path is accepted and its resolved write
     target stays strictly inside the real workspace root, and materializing it
     writes only inside that root with no denial.
  3. A path routed through an in-workspace symlink that points outside the
     workspace is rejected by real-path containment, recorded, and never written
     through the link.

Containment is checked against a real filesystem root: each example runs inside a
fresh ``TemporaryDirectory`` so ``os.path.realpath`` resolution is exercised for
real and no example's writes can leak across examples or escape the sandbox tree.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from hypothesis import given
from hypothesis import strategies as st
from property_harness import property_tag, safe_relative_paths, unsafe_path_strings

from tool_runner_worker.contract import SourceFile
from tool_runner_worker.paths import (
    ConfinedPath,
    RejectedPath,
    RejectionReason,
    confine_path,
)
from tool_runner_worker.workspace import materialize_workspace

#: The canonical tag for this property, asserted verbatim by ``test_property_9_tag``.
PROPERTY = property_tag(9, "Generated code stays inside its sandbox workspace")

#: Placeholder contents for the single job file each example materializes; the
#: property is about where a write may land, never about what it contains.
_CONTENTS = "module m; endmodule"


def _files_under(root: Path) -> set[Path]:
    """Every regular file beneath ``root``, real-path resolved for comparison.

    Resolving matches the target ``confine_path`` returns, so a platform that
    symlinks the temp root (macOS routes ``/var`` through ``/private/var``) does
    not make an identical file compare unequal.
    """
    return {Path(os.path.realpath(path)) for path in root.rglob("*") if path.is_file()}


#: The full hostile input space for confinement: the shared non-empty attack
#: classes plus the empty-path class, so every syntactic rejection reason is
#: exercised universally.
_HOSTILE_PATHS = st.one_of(unsafe_path_strings(), st.just(""))


@given(_HOSTILE_PATHS)
def test_property_9_hostile_paths_are_rejected_recorded_and_never_written(raw: str) -> None:
    """Hostile paths are rejected, recorded as a denial, and never written.

    Feature: hdl-creation-loop, Property 9: Generated code stays inside its
    sandbox workspace. Validates Requirements 2.6, 2.7.
    """
    with tempfile.TemporaryDirectory() as workspace:
        root = Path(workspace)

        result = confine_path(root, raw)
        assert isinstance(result, RejectedPath)

        outcome = materialize_workspace(root, [SourceFile(path=raw, contents=_CONTENTS)])

        # The rejection is recorded as a filesystem denial that echoes the path.
        assert outcome.source_relpaths == []
        assert len(outcome.denied) == 1
        denial = outcome.denied[0]
        assert denial.kind == "filesystem"
        assert denial.path == raw
        assert denial.detail == result.reason.value

        # No write landed anywhere in the workspace tree.
        assert _files_under(root) == set()


@given(safe_relative_paths())
def test_property_9_safe_paths_are_confined_inside_the_workspace(raw: str) -> None:
    """Legitimate relative paths resolve and materialize strictly inside the root.

    Feature: hdl-creation-loop, Property 9: Generated code stays inside its
    sandbox workspace. Validates Requirements 2.6, 2.7.
    """
    with tempfile.TemporaryDirectory() as workspace:
        root = Path(workspace)
        real_root = Path(os.path.realpath(root))

        result = confine_path(root, raw)
        assert isinstance(result, ConfinedPath)
        # Strict containment: inside the root, and never the root itself.
        assert result.resolved != real_root
        assert result.resolved.is_relative_to(real_root)

        outcome = materialize_workspace(root, [SourceFile(path=raw, contents=_CONTENTS)])

        # Accepted, so no denial, and the write is confined to the workspace.
        assert outcome.denied == []
        written = _files_under(root)
        assert written == {result.resolved}
        assert all(path.is_relative_to(real_root) for path in written)


@given(st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789_", min_size=1, max_size=8))
def test_property_9_symlink_escape_is_rejected_and_never_written(leaf: str) -> None:
    """A path through an in-workspace symlink pointing outside is confined out.

    Feature: hdl-creation-loop, Property 9: Generated code stays inside its
    sandbox workspace. Validates Requirements 2.6, 2.7.
    """
    with tempfile.TemporaryDirectory() as base:
        base_path = Path(base)
        root = base_path / "workspace"
        root.mkdir()
        outside = base_path / "outside"
        outside.mkdir()
        (root / "link").symlink_to(outside, target_is_directory=True)
        raw = f"link/{leaf}.v"

        result = confine_path(root, raw)
        assert isinstance(result, RejectedPath)
        assert result.reason is RejectionReason.ESCAPES_WORKSPACE

        outcome = materialize_workspace(root, [SourceFile(path=raw, contents=_CONTENTS)])

        # Recorded as a denial, with nothing written through the link.
        assert outcome.source_relpaths == []
        assert len(outcome.denied) == 1
        assert outcome.denied[0].path == raw
        assert list(outside.iterdir()) == []


def test_property_9_tag() -> None:
    """The property carries the exact canonical feature tag."""
    assert PROPERTY == (
        "Feature: hdl-creation-loop, Property 9: Generated code stays inside its sandbox workspace"
    )
