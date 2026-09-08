"""Example tests for the bounded command capture in :mod:`tool_runner_worker.commands`.

These pin the fix for a MEASURED resource-exhaustion defect. The runner used to
call ``subprocess.run(..., capture_output=True)``, which buffers a child's entire
stdout and stderr in memory; a testbench whose wait condition never becomes true
(``forever @(posedge clk) $display(...)``, the normal consequence of buggy RTL)
buffered 55.9 MB in 5.03s on the machine this was reproduced on, projecting to
~333 MB per run at the 30s real-oracle cap. ``ResourceLimits.memMb`` caps the
sandboxed child, not the worker's own buffer of that child's output.

Every case below uses a SYNTHETIC high-volume child (this interpreter writing
bytes) rather than a real simulation, so the suite stays fast and needs no EDA
toolchain. The end-to-end assertion against a real non-terminating Icarus run
lives in the gated TypeScript integration suite.

Retained-size note: the children here write ASCII, so one character of the
returned ``stdout``/``stderr`` string is exactly one retained byte. Asserting on
``len(text.encode("utf-8"))`` therefore asserts on the bytes actually held in
memory, through the public surface rather than the accumulator's internals.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from tool_runner_worker.commands import (
    COMMAND_DISK_LIMIT_EXIT,
    COMMAND_NOT_FOUND_EXIT,
    COMMAND_TIMEOUT_EXIT,
    MAX_CAPTURED_STDERR_BYTES,
    MAX_CAPTURED_STDOUT_BYTES,
    SubprocessCommandRunner,
)

#: A wall-clock cap generous enough that a correctly drained child always finishes
#: inside it, so a timeout in these cases means the capture stopped draining.
_GENEROUS_TIMEOUT_S = 10.0

#: The cap used by the cases that deliberately let a child overrun. Kept small so
#: the suite stays fast; the timeout path is not sensitive to its exact value.
_SHORT_TIMEOUT_S = 1.0

#: A workspace cap generous enough that the OUTPUT-bound cases never trip it. Those
#: children write to pipes, not to files, so their workspace stays empty - which is
#: also why passing a real cap here does not weaken them.
_GENEROUS_DISK_LIMIT_BYTES = 64 * 1_048_576

#: The cap the DISK-bound cases run under. Small so a filler trips it in a fraction
#: of a second and this suite never writes much to the host.
_SMALL_DISK_LIMIT_BYTES = 4 * 1_048_576

#: Bytes a "floods far past the cap" child writes: roughly 40x the stdout cap and
#: hundreds of times a typical 64 KiB OS pipe buffer.
_FLOOD_BYTES = 40 * 1_048_576

#: One write from the disk-filling children.
_DISK_CHUNK_BYTES = 262_144

#: Pause between the disk-filling children's writes, so they write at a rate a real
#: waveform dump reaches rather than as fast as the host allows.
#:
#: NOT throttling to make a bound look tighter than it is - the opposite. The cap is
#: polled at a fixed interval, so the bytes a run can overshoot it by are its WRITE
#: RATE times that interval. An unthrottled Python loop measured ~590 MB/s on this
#: machine and overshot a 4 MiB cap by 59 MB, while the defect being bounded is a
#: waveform dump measured at 28-49 MB/s. Modelling the real rate keeps the assertions
#: below about the enforcement rather than about how fast this host can memcpy.
#:
#: 256 KiB every 5 ms is ~52 MB/s, the upper end of the measured range.
_DISK_WRITE_PAUSE_S = 0.005

#: One write from the flooding children. Large enough that the flood is quick.
_FLOOD_CHUNK_BYTES = 65_536

#: A marker the flooding children print FIRST, so the retained end is assertable.
_FIRST_LINE = "CHECK first_line PASS"


def _retained(text: str) -> int:
    """Bytes of ``text`` held in memory (one byte per character for ASCII)."""
    return len(text.encode("utf-8"))


def _python(script: str) -> list[str]:
    """An argv that runs ``script`` in this interpreter (no shell, explicit argv)."""
    return [sys.executable, "-c", script]


def _flood_script(stream: str, total_bytes: int, exit_code: int) -> str:
    """A child that prints a marker line, floods ``stream``, then exits."""
    return (
        "import sys\n"
        f"out = sys.{stream}.buffer\n"
        f"out.write(b{_FIRST_LINE!r} + b'\\n')\n"
        f"chunk = b'x' * {_FLOOD_CHUNK_BYTES}\n"
        f"for _ in range({total_bytes // _FLOOD_CHUNK_BYTES}):\n"
        "    out.write(chunk)\n"
        "out.flush()\n"
        f"sys.exit({exit_code})\n"
    )


#: A child that writes without end, the synthetic form of a runaway testbench.
_NEVER_ENDING_WRITER = (
    "import sys\n"
    f"chunk = b'y' * {_FLOOD_CHUNK_BYTES}\n"
    "while True:\n"
    "    sys.stdout.buffer.write(chunk)\n"
)

#: A child that writes past BOTH caps before exiting, on both streams at once.
_BOTH_STREAMS_WRITER = (
    "import sys\n"
    f"chunk = b'z' * {_FLOOD_CHUNK_BYTES}\n"
    f"for _ in range({(4 * 1_048_576) // _FLOOD_CHUNK_BYTES}):\n"
    "    sys.stdout.buffer.write(chunk)\n"
    f"for _ in range({(2 * 1_048_576) // _FLOOD_CHUNK_BYTES}):\n"
    "    sys.stderr.buffer.write(chunk)\n"
    "sys.stdout.flush()\n"
    "sys.stderr.flush()\n"
    "sys.exit(7)\n"
)


def _disk_filler_script(quiet: bool) -> str:
    """A child that writes a file without end, the synthetic form of a hung waveform dump.

    ``quiet`` additionally CLOSES both standard streams first, so the parent sees end
    of stream on both pipes while the child keeps writing files. That is the case a
    pipe-driven wait loop would sleep through, which is why the disk check has to keep
    ticking after the pipes are done.

    Each write is flushed, so the bytes reach the file (and therefore ``st_size``) as
    the run proceeds rather than at exit - the same thing a simulator dumping a
    waveform does, and the precondition for a cap that is enforced DURING the run.
    """
    close_streams = "import os\nos.close(1)\nos.close(2)\n" if quiet else ""
    return (
        "import time\n"
        f"{close_streams}"
        f"chunk = b'v' * {_DISK_CHUNK_BYTES}\n"
        "with open('dump.vcd', 'wb') as handle:\n"
        "    while True:\n"
        "        handle.write(chunk)\n"
        "        handle.flush()\n"
        f"        time.sleep({_DISK_WRITE_PAUSE_S})\n"
    )


def _bounded_disk_script(total_bytes: int) -> str:
    """A child that writes ``total_bytes`` to one file, then exits cleanly."""
    return (
        f"chunk = b'v' * {_DISK_CHUNK_BYTES}\n"
        "with open('dump.vcd', 'wb') as handle:\n"
        f"    for _ in range({total_bytes // _DISK_CHUNK_BYTES}):\n"
        "        handle.write(chunk)\n"
        "    handle.flush()\n"
    )


def _workspace_bytes(root: Path) -> int:
    """Total size of the files under ``root``, measured independently of the worker.

    Deliberately NOT ``workspace_size_bytes``: asserting the bound with the same
    function the bound is enforced through would make a defect in that measurement
    invisible.
    """
    return sum(entry.stat().st_size for entry in root.rglob("*") if entry.is_file())


def test_normal_sized_output_is_captured_whole_and_never_flagged(tmp_path: Path) -> None:
    """Given output well under the cap, when run, then it is captured byte-for-byte."""
    expected = "CHECK reset_clears_output PASS\nCHECK counts_up PASS\n"
    script = f"import sys\nsys.stdout.write({expected!r})\n"

    result = SubprocessCommandRunner().run(
        _python(script), tmp_path, _GENEROUS_TIMEOUT_S, _GENEROUS_DISK_LIMIT_BYTES
    )

    assert result.stdout == expected
    assert result.stderr == ""
    assert result.stdout_truncated is False
    assert result.stderr_truncated is False
    assert result.exit_code == 0


def test_output_beyond_the_cap_is_truncated_and_flagged(tmp_path: Path) -> None:
    """Given a child writing past the cap, when run, then the excess is dropped and flagged."""
    over_cap = MAX_CAPTURED_STDOUT_BYTES + _FLOOD_CHUNK_BYTES

    result = SubprocessCommandRunner().run(
        _python(_flood_script("stdout", over_cap, 0)),
        tmp_path,
        _GENEROUS_TIMEOUT_S,
        _GENEROUS_DISK_LIMIT_BYTES,
    )

    assert result.stdout_truncated is True
    assert _retained(result.stdout) == MAX_CAPTURED_STDOUT_BYTES


def test_retained_bytes_stay_bounded_for_a_very_large_output(tmp_path: Path) -> None:
    """Given a child writing ~40x the cap, when run, then peak retention is still the cap.

    This is the resource-exhaustion property itself: the bound must hold no matter
    how much the child writes, which is what makes truncating AFTER buffering an
    inadequate fix.
    """
    result = SubprocessCommandRunner().run(
        _python(_flood_script("stdout", _FLOOD_BYTES, 0)),
        tmp_path,
        _GENEROUS_TIMEOUT_S,
        _GENEROUS_DISK_LIMIT_BYTES,
    )

    assert _retained(result.stdout) <= MAX_CAPTURED_STDOUT_BYTES
    assert result.stdout_truncated is True


def test_the_retained_end_is_the_prefix_the_child_wrote_first(tmp_path: Path) -> None:
    """Given a marker printed before a flood, when run, then the marker survives.

    Documents WHICH end is retained. The prefix is the part causally before the
    runaway, so it holds whatever the testbench legitimately printed - including
    any check it managed to signal - while the tail of such a run is only the
    repeated flood.
    """
    result = SubprocessCommandRunner().run(
        _python(_flood_script("stdout", _FLOOD_BYTES, 0)),
        tmp_path,
        _GENEROUS_TIMEOUT_S,
        _GENEROUS_DISK_LIMIT_BYTES,
    )

    assert result.stdout.startswith(f"{_FIRST_LINE}\n")


def test_a_huge_writer_that_exits_normally_still_reports_its_exit_code(tmp_path: Path) -> None:
    """Given a child that floods then exits non-zero, when run, then the exit code survives."""
    result = SubprocessCommandRunner().run(
        _python(_flood_script("stdout", _FLOOD_BYTES, 3)),
        tmp_path,
        _GENEROUS_TIMEOUT_S,
        _GENEROUS_DISK_LIMIT_BYTES,
    )

    assert result.exit_code == 3
    assert result.exit_code != COMMAND_TIMEOUT_EXIT
    assert result.stdout_truncated is True


def test_a_child_writing_past_both_caps_terminates_and_is_captured(tmp_path: Path) -> None:
    """Given a child flooding both streams past their caps, when run, then it still exits.

    THE NO-DEADLOCK PROPERTY. Both children write far more than an OS pipe buffer
    and far more than the worker retains. If the capture stopped reading a pipe
    once its sink was full, the child would block forever on its next write, never
    reach its exit, and be reported as a timeout - converting a bounded cap into a
    real hang. A normal exit code is the observable proof that draining continued.
    """
    started = time.monotonic()
    result = SubprocessCommandRunner().run(
        _python(_BOTH_STREAMS_WRITER), tmp_path, _GENEROUS_TIMEOUT_S, _GENEROUS_DISK_LIMIT_BYTES
    )
    elapsed = time.monotonic() - started

    assert result.exit_code == 7
    assert elapsed < _GENEROUS_TIMEOUT_S
    assert result.stdout_truncated is True
    assert result.stderr_truncated is True
    assert _retained(result.stdout) <= MAX_CAPTURED_STDOUT_BYTES
    assert _retained(result.stderr) <= MAX_CAPTURED_STDERR_BYTES


def test_standard_error_is_bounded_independently_of_standard_output(tmp_path: Path) -> None:
    """Given a child flooding only stderr, when run, then only stderr is flagged."""
    result = SubprocessCommandRunner().run(
        _python(_flood_script("stderr", _FLOOD_BYTES, 0)),
        tmp_path,
        _GENEROUS_TIMEOUT_S,
        _GENEROUS_DISK_LIMIT_BYTES,
    )

    assert result.stderr_truncated is True
    assert _retained(result.stderr) <= MAX_CAPTURED_STDERR_BYTES
    assert result.stdout_truncated is False


def test_a_never_ending_writer_times_out_with_the_timeout_sentinel(tmp_path: Path) -> None:
    """Given a child that writes without end, when run, then the timeout sentinel is reported.

    The synthetic form of the measured defect. The wall-clock cap must still be
    what stops the run, the sentinel must be preserved, and the bytes retained on
    the way there must stay under the cap.
    """
    started = time.monotonic()
    result = SubprocessCommandRunner().run(
        _python(_NEVER_ENDING_WRITER), tmp_path, _SHORT_TIMEOUT_S, _GENEROUS_DISK_LIMIT_BYTES
    )
    elapsed = time.monotonic() - started

    assert result.exit_code == COMMAND_TIMEOUT_EXIT
    assert _retained(result.stdout) <= MAX_CAPTURED_STDOUT_BYTES
    assert result.stdout_truncated is True
    # Bounded: the cap plus the post-kill drain grace, not the child's lifetime.
    assert elapsed < _GENEROUS_TIMEOUT_S
    # The two bounds stay distinct. This child wrote nothing to disk, so reporting a
    # disk breach here would make the flag useless to the one caller that reads it.
    assert result.disk_limit_exceeded is False


def test_a_silent_overrun_reports_the_elapsed_cap_on_standard_error(tmp_path: Path) -> None:
    """Given a child that overruns without printing, when run, then stderr says so."""
    script = "import time\ntime.sleep(30)\n"

    result = SubprocessCommandRunner().run(
        _python(script), tmp_path, _SHORT_TIMEOUT_S, _GENEROUS_DISK_LIMIT_BYTES
    )

    assert result.exit_code == COMMAND_TIMEOUT_EXIT
    assert "timed out after" in result.stderr
    assert result.stdout == ""
    assert result.stdout_truncated is False


def test_a_missing_tool_reports_the_not_found_sentinel(tmp_path: Path) -> None:
    """Given a binary that does not exist, when run, then the not-found sentinel is reported."""
    result = SubprocessCommandRunner().run(
        ["tool-that-does-not-exist"], tmp_path, _GENEROUS_TIMEOUT_S, _GENEROUS_DISK_LIMIT_BYTES
    )

    assert result.exit_code == COMMAND_NOT_FOUND_EXIT
    assert "tool not found" in result.stderr
    assert result.stdout_truncated is False
    assert result.stderr_truncated is False


def test_a_child_that_prints_nothing_is_captured_as_empty_and_unflagged(tmp_path: Path) -> None:
    """Given a child with no output, when run, then both streams are empty and unflagged."""
    result = SubprocessCommandRunner().run(
        _python("pass\n"), tmp_path, _GENEROUS_TIMEOUT_S, _GENEROUS_DISK_LIMIT_BYTES
    )

    assert result.stdout == ""
    assert result.stderr == ""
    assert result.stdout_truncated is False
    assert result.stderr_truncated is False
    assert result.exit_code == 0


def test_a_workspace_filler_is_killed_with_the_disk_sentinel(tmp_path: Path) -> None:
    """Given a child filling its workspace, when run, then the disk sentinel is reported.

    The disk half of the measured defect, and the case that proves the cap is
    ENFORCED rather than merely computed. The wall-clock cap is generous here, so a
    run that reached it would have been stopped by time; being stopped at all means
    the workspace measurement did it.
    """
    started = time.monotonic()
    result = SubprocessCommandRunner().run(
        _python(_disk_filler_script(quiet=False)),
        tmp_path,
        _GENEROUS_TIMEOUT_S,
        _SMALL_DISK_LIMIT_BYTES,
    )
    elapsed = time.monotonic() - started

    assert result.exit_code == COMMAND_DISK_LIMIT_EXIT
    assert result.disk_limit_exceeded is True
    assert "disk cap" in result.stderr
    # Killed for DISK, not for time: the wall cap is ten times the observed duration.
    assert elapsed < _GENEROUS_TIMEOUT_S


def test_a_filler_that_closes_its_streams_is_still_killed_for_disk(tmp_path: Path) -> None:
    """Given a child that ends its streams and keeps writing, when run, then it is still killed.

    The hole a pipe-driven wait loop leaves. Once both pipes reach end of stream there
    is nothing left to wake a selector, so a loop that only woke on readable pipes
    would sleep until the wall-clock deadline while the workspace kept growing - which
    is precisely the failure the disk cap exists to prevent, one layer down.
    """
    started = time.monotonic()
    result = SubprocessCommandRunner().run(
        _python(_disk_filler_script(quiet=True)),
        tmp_path,
        _GENEROUS_TIMEOUT_S,
        _SMALL_DISK_LIMIT_BYTES,
    )
    elapsed = time.monotonic() - started

    assert result.exit_code == COMMAND_DISK_LIMIT_EXIT
    assert result.disk_limit_exceeded is True
    assert elapsed < _GENEROUS_TIMEOUT_S


def test_the_workspace_stays_bounded_when_the_wall_cap_is_DOUBLED(tmp_path: Path) -> None:
    """Given the same filler under a doubled wall cap, when run, then the workspace does not grow.

    THE RESOURCE PROPERTY ITSELF, asserted the same way the output bound is: an
    unenforced cap makes the workspace linear in run time, so doubling the time
    budget would roughly double the bytes. Comparing two run lengths avoids
    re-stating the worker's own poll interval or the host's write rate in the test,
    and it fails loudly if the enforcement is removed.
    """
    short_workspace = tmp_path / "short"
    long_workspace = tmp_path / "long"
    for workspace in (short_workspace, long_workspace):
        workspace.mkdir()

    SubprocessCommandRunner().run(
        _python(_disk_filler_script(quiet=False)),
        short_workspace,
        _SHORT_TIMEOUT_S,
        _SMALL_DISK_LIMIT_BYTES,
    )
    SubprocessCommandRunner().run(
        _python(_disk_filler_script(quiet=False)),
        long_workspace,
        _SHORT_TIMEOUT_S * 2,
        _SMALL_DISK_LIMIT_BYTES,
    )

    # Both runs end at the cap, not at their deadline. Unbounded, the doubled run would
    # have written twice as much as the short one and ~25x this allowance at the rate
    # these children write. The allowance itself covers one poll interval of overshoot.
    assert _workspace_bytes(long_workspace) < 3 * _SMALL_DISK_LIMIT_BYTES
    assert _workspace_bytes(short_workspace) < 3 * _SMALL_DISK_LIMIT_BYTES


def test_a_workspace_that_stays_under_the_cap_exits_normally_and_is_not_flagged(
    tmp_path: Path,
) -> None:
    """Given a child writing well under the cap, when run, then it finishes unflagged.

    Non-vacuity for the three cases above: the cap must stop a runaway without
    touching a legitimate simulation that writes a normal-sized waveform.
    """
    under_cap = _SMALL_DISK_LIMIT_BYTES // 4

    result = SubprocessCommandRunner().run(
        _python(_bounded_disk_script(under_cap)),
        tmp_path,
        _GENEROUS_TIMEOUT_S,
        _SMALL_DISK_LIMIT_BYTES,
    )

    assert result.exit_code == 0
    assert result.disk_limit_exceeded is False
    assert _workspace_bytes(tmp_path) == under_cap
