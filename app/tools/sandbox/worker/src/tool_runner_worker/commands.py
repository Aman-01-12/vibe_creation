"""The thin command-invocation boundary for the EDA tools.

The worker invokes ``iverilog`` and ``vvp`` through this narrow port rather than
calling :mod:`subprocess` directly. Isolating the boundary keeps the file-writing
and path-confinement logic unit testable with a fake runner when the real tools
are absent (they are not installed on every developer machine), while the
production path uses :class:`SubprocessCommandRunner`.

Commands are always invoked with an explicit argument vector and never through a
shell, so nothing derived from untrusted job contents can be interpreted as a
shell command.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

#: Sentinel exit code for a tool that could not be launched at all (for example
#: ``iverilog`` is not installed). Mirrors the shell "command not found" code so a
#: missing tool surfaces as a non-zero exit plus a missing artifact, which the
#: TypeScript adapter classifies as ``error`` - never a fabricated success.
COMMAND_NOT_FOUND_EXIT = 127

#: Sentinel exit code for a tool killed by the worker's own defensive timeout.
COMMAND_TIMEOUT_EXIT = 124


@dataclass(frozen=True, slots=True)
class CompletedCommand:
    """The captured outcome of one command invocation."""

    exit_code: int
    stdout: str
    stderr: str


class CommandRunner(Protocol):
    """Runs one command to completion inside the workspace and captures it."""

    def run(self, argv: list[str], cwd: Path, timeout_s: float) -> CompletedCommand:
        """Execute ``argv`` in ``cwd``, bounded by ``timeout_s`` seconds."""
        ...


class SubprocessCommandRunner:
    """Production :class:`CommandRunner` backed by :mod:`subprocess`.

    A missing binary or a timeout is turned into a captured, non-zero
    :class:`CompletedCommand` rather than a raised exception, so the worker always
    reports raw facts about the run instead of crashing.
    """

    def run(self, argv: list[str], cwd: Path, timeout_s: float) -> CompletedCommand:
        """Run ``argv`` with no shell, capturing streams and the exit code."""
        try:
            # No shell, explicit argv, bounded by a timeout: nothing from the job
            # contents can be reinterpreted as a shell command.
            completed = subprocess.run(
                argv,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except FileNotFoundError:
            return CompletedCommand(COMMAND_NOT_FOUND_EXIT, "", f"tool not found: {argv[0]}")
        except subprocess.TimeoutExpired as expired:
            return CompletedCommand(
                COMMAND_TIMEOUT_EXIT,
                _decode(expired.stdout),
                _decode(expired.stderr) or f"timed out after {timeout_s:.3f}s",
            )
        return CompletedCommand(completed.returncode, completed.stdout, completed.stderr)


def _decode(stream: str | bytes | None) -> str:
    """Normalize a captured stream (str, bytes, or missing) to text."""
    if stream is None:
        return ""
    if isinstance(stream, bytes):
        return stream.decode("utf-8", errors="replace")
    return stream
