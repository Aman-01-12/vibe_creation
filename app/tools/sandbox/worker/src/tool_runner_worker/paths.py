"""Path confinement: the worker's security core (Req 2.6, 2.7).

Every file name and path handed to the worker originates from the Spec, model
output, or student input and is therefore untrusted. Before any write, a path is
validated and confined to the sandbox workspace. A path that is absolute, uses a
traversal segment, is URL/percent-encoded, smuggles a Windows separator, or that
resolves (through a symlink or otherwise) to a location outside the workspace is
rejected and recorded, never written.

Confinement is layered:

1. Syntactic screening rejects the malformed and obviously hostile classes
   (empty, NUL, percent-encoded, backslash-separated, absolute, ``..`` segment)
   and categorizes the rejection so the denial detail is precise.
2. Real-path containment resolves the candidate against the real workspace root
   and asserts it stays inside, defeating symlink-style escapes that survive the
   syntactic screen.

These are pure functions with no filesystem writes, so confinement is unit
testable without any EDA tool present.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path, PurePosixPath

#: Matches a percent-encoded octet (for example ``%2e`` or ``%2F``). Legitimate
#: workspace source file names never contain one, so any occurrence is hostile.
_PERCENT_ENCODING = re.compile("%[0-9A-Fa-f]{2}")

#: A Windows drive-letter prefix (for example ``C:``) used to spot absolute paths
#: that ``PurePosixPath`` would otherwise treat as relative.
_WINDOWS_DRIVE = re.compile("^[A-Za-z]:")


class RejectionReason(StrEnum):
    """Why a candidate path was rejected, in order of the check that caught it."""

    EMPTY = "empty path"
    NUL_BYTE = "embedded NUL byte"
    PERCENT_ENCODED = "URL/percent-encoded path"
    BACKSLASH = "backslash path separator"
    ABSOLUTE = "absolute path"
    TRAVERSAL = "parent-directory traversal segment"
    ESCAPES_WORKSPACE = "resolves outside the workspace"


@dataclass(frozen=True, slots=True)
class ConfinedPath:
    """An accepted path: the absolute, workspace-confined location to write to."""

    resolved: Path


@dataclass(frozen=True, slots=True)
class RejectedPath:
    """A rejected path: the reason it was denied, for recording as a denial."""

    reason: RejectionReason


#: The result of confining one candidate path: accepted with a target, or rejected.
ConfineResult = ConfinedPath | RejectedPath


def _is_absolute(raw: str) -> bool:
    """True when the raw path is POSIX-absolute or carries a Windows drive."""
    return raw.startswith("/") or _WINDOWS_DRIVE.match(raw) is not None


def _screen_syntax(raw: str) -> RejectionReason | None:
    """Return the reason a candidate fails syntactic screening, or ``None``.

    Runs the cheap, decisive checks before any path resolution touches the disk,
    returning the first (highest-priority) attack class that matches.
    """
    checks: list[tuple[bool, RejectionReason]] = [
        (raw == "", RejectionReason.EMPTY),
        ("\x00" in raw, RejectionReason.NUL_BYTE),
        (_PERCENT_ENCODING.search(raw) is not None, RejectionReason.PERCENT_ENCODED),
        ("\\" in raw, RejectionReason.BACKSLASH),
        (_is_absolute(raw), RejectionReason.ABSOLUTE),
        (any(part == ".." for part in PurePosixPath(raw).parts), RejectionReason.TRAVERSAL),
    ]
    for matched, reason in checks:
        if matched:
            return reason
    return None


def _contains(root: Path, candidate: Path) -> bool:
    """True when ``candidate`` is the workspace root itself or lives beneath it."""
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


def confine_path(workspace_root: Path, raw_path: str) -> ConfineResult:
    """Validate ``raw_path`` and confine it to ``workspace_root``.

    Returns a :class:`ConfinedPath` with the absolute write target when the path
    is safe, or a :class:`RejectedPath` naming the attack class otherwise. The
    workspace root is real-path resolved once so a symlinked root is compared on
    equal terms with the resolved candidate.
    """
    syntactic = _screen_syntax(raw_path)
    if syntactic is not None:
        return RejectedPath(syntactic)

    root = Path(os.path.realpath(workspace_root))
    resolved = Path(os.path.realpath(root / raw_path))
    if resolved == root or not _contains(root, resolved):
        return RejectedPath(RejectionReason.ESCAPES_WORKSPACE)
    return ConfinedPath(resolved)
