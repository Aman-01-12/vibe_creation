"""The thin command-invocation boundary for the EDA tools.

The worker invokes ``iverilog`` and ``vvp`` through this narrow port rather than
calling :mod:`subprocess` directly. Isolating the boundary keeps the file-writing
and path-confinement logic unit testable with a fake runner when the real tools
are absent (they are not installed on every developer machine), while the
production path uses :class:`SubprocessCommandRunner`.

Commands are always invoked with an explicit argument vector and never through a
shell, so nothing derived from untrusted job contents can be interpreted as a
shell command.

WHY THE CAPTURE IS BOUNDED (a measured resource-exhaustion defect)

    This module used to call ``subprocess.run(..., capture_output=True)``, which
    buffers the child's ENTIRE stdout and stderr in memory with no bound. A
    testbench whose wait condition never becomes true - the normal consequence of
    buggy RTL, for example ``forever @(posedge clk) $display(...)`` - writes
    without end, so the only thing that stopped the run was the wall-clock cap,
    and by then the buffer was as large as the child could make it.

    Measured on a developer machine, replicating that exact call against a
    non-terminating Icarus simulation with a 5s cap: 55.9 MB of stdout buffered
    in 5.03s (11.1 MB/s), which projects to ~333 MB per run at the 30s cap the
    real-oracle path uses; a faster host measured 114 MB in 5.07s (21.5 MB/s),
    ~654 MB at 30s. Concurrent sessions multiply it. ``ResourceLimits.memMb``
    does not help: it caps the SANDBOXED child, not the worker's own buffer of
    that child's output.

    The fix is to stream both pipes and stop RETAINING past a named cap, so peak
    memory is a fixed constant regardless of how much the child writes.
    Truncation is reported across the seam (:mod:`tool_runner_worker.report`) and
    forces a non-passing verdict on the TypeScript side, because output we
    discarded may have contained the ``CHECK <name> FAIL`` line that mattered.

WHY THE WORKSPACE IS BOUNDED TOO (the same defect, written to disk)

    The same non-terminating run writes a WAVEFORM for as long as it lasts, because
    our testbenches call ``$dumpfile``/``$dumpvars``. Measured with real
    ``iverilog``/``vvp`` on this machine, a hung 32-bit counter dump reached 141 MB
    in the 5s before the wall-clock kill (28.3 MB/s), and an earlier 32-bit adder
    toggling more bits measured 249 MB in 5s (49 MB/s) - roughly 1.5 GB per hung run
    at the 30s cap the real-oracle path uses.

    ``ResourceLimits.diskMb`` was PARSED and never enforced, which is worse than
    having no cap at all: every caller of the seam reads a declared ceiling and
    assumes protection. It is enforced HERE, in the worker, and enforced WHILE the
    tool runs rather than after it: a run that has already written 30 GB has already
    done the damage. The bound therefore mirrors the wall-clock bound already in
    this module - same pump loop, same SIGKILL, same sentinel-exit-code shape - so
    there is ONE shape for "a resource bound killed this run", not two dissimilar
    ones.

    WHY THE WORKER AND NOT THE TYPESCRIPT RUNTIME. The worker is the only side that
    can see the bytes. On the production runtime the workspace is a tmpfs INSIDE a
    gVisor container, so the host has no path to measure; a TypeScript-side monitor
    would work for the local runtime and be structurally impossible for the isolated
    one, which is how a security control ends up existing on the path that does not
    need it. The worker runs in both, so one implementation covers both. The kill is
    reported across the seam as ``diskLimitExceeded`` and the TypeScript side
    refuses a passing verdict for it, so the owning side cannot silently decide not
    to enforce it.
"""

from __future__ import annotations

import contextlib
import os
import selectors
import subprocess
import time
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import IO, Protocol

from .workspace import workspace_size_bytes

#: Sentinel exit code for a tool that could not be launched at all (for example
#: ``iverilog`` is not installed). Mirrors the shell "command not found" code so a
#: missing tool surfaces as a non-zero exit plus a missing artifact, which the
#: TypeScript adapter classifies as ``error`` - never a fabricated success.
COMMAND_NOT_FOUND_EXIT = 127

#: Sentinel exit code for a tool killed by the worker's own defensive timeout.
COMMAND_TIMEOUT_EXIT = 124

#: Sentinel exit code for a tool killed for exceeding its workspace disk cap.
#:
#: Adjacent to the timeout sentinel because it is the same kind of event - a
#: resource bound killed the run - and distinct from it because collapsing the two
#: would leave a reader of the raw report unable to tell which bound fired. It sits
#: below 126/127, whose shell meanings ("found but not executable", "not found") are
#: already spoken for.
COMMAND_DISK_LIMIT_EXIT = 125

#: Hard ceiling on the bytes of a child's standard output the worker RETAINS.
#:
#: Generous next to any legitimate simulation - a per-cycle monitor printing a
#: 60-byte line every cycle fits ~17,000 cycles - so normal runs are captured
#: whole and are byte-identical to the unbounded behaviour. It is deliberately a
#: fixed constant rather than a job field: the job is untrusted input, and a cap a
#: caller can raise is not a bound.
MAX_CAPTURED_STDOUT_BYTES = 1_048_576

#: Hard ceiling on the bytes of a child's standard error the worker RETAINS.
#:
#: Smaller than the stdout cap because stderr carries tool diagnostics rather than
#: the per-check signalling, and a compiler that has produced 256 KiB of
#: diagnostics has already said everything actionable.
MAX_CAPTURED_STDERR_BYTES = 262_144

#: Bytes requested per pipe read. Bounds the transient allocation on top of the
#: retention caps, so peak memory per invocation is
#: ``MAX_CAPTURED_STDOUT_BYTES + MAX_CAPTURED_STDERR_BYTES + _READ_CHUNK_BYTES``.
_READ_CHUNK_BYTES = 65_536

#: How long the worker keeps draining the pipes after SIGKILLing a timed-out
#: child, before abandoning them.
#:
#: A killed child is reaped promptly, but a grandchild it spawned can still hold
#: the write end of the pipe open, so waiting for EOF unconditionally would turn a
#: bounded timeout into an unbounded hang. The grace window keeps
#: :meth:`SubprocessCommandRunner.run` total.
_POST_KILL_DRAIN_GRACE_S = 0.5

#: How often the workspace is measured while a child runs.
#:
#: The overshoot a cap can be exceeded by is the child's write RATE times this
#: interval, so 0.1s is ~5 MB at the 49 MB/s measured for a hung waveform dump -
#: small enough that even the smallest cap configured in this repo (8 MiB in the
#: eval fixtures) stays a meaningful ceiling. The cost per poll is one directory
#: walk over a workspace holding a handful of files, so measuring ten times a second
#: is far cheaper than the writes it is watching.
_DISK_POLL_INTERVAL_S = 0.1


class _Stop(StrEnum):
    """Why the worker stopped waiting on a child."""

    #: The child exited and both pipes reached end of stream.
    EXITED = "exited"
    #: The wall-clock deadline arrived first.
    DEADLINE = "deadline"
    #: The workspace reached its disk cap.
    DISK_BREACH = "disk breach"


@dataclass(frozen=True, slots=True)
class _DiskBound:
    """The workspace disk cap, checked repeatedly while a child runs."""

    root: Path
    limit_bytes: int

    def breached(self) -> bool:
        """True once the workspace has consumed its whole declared allowance.

        The test is ``>=``, not ``>``, deliberately. On the isolated runtime the
        workspace is a tmpfs sized at the SAME number, and a tmpfs fills to exactly
        its size before refusing a write, so a strict ``>`` could never be satisfied
        there and the cause would go unreported on the one runtime that matters
        most. A run that has consumed its entire allowance has exhausted it by any
        reading.
        """
        return workspace_size_bytes(self.root) >= self.limit_bytes


@dataclass(frozen=True, slots=True)
class _Ended:
    """How a bounded child ended.

    ``exit_code`` is ``None`` exactly when a resource bound killed the child, and
    ``disk_limit_exceeded`` says WHICH bound that was. Carrying the cause instead of
    overloading the exit code keeps the caller total: it never has to infer from a
    sentinel which bound fired.
    """

    exit_code: int | None
    disk_limit_exceeded: bool


@dataclass(frozen=True, slots=True)
class CompletedCommand:
    """The captured outcome of one command invocation.

    The truncation and disk-cap flags are REQUIRED rather than defaulted: a producer
    that silently omitted them would report a partial stream as if it were complete,
    or a killed run as if it had finished, which is the failure this type exists to
    make unrepresentable.
    """

    exit_code: int
    stdout: str
    stderr: str
    #: True when the child wrote more standard output than the worker retained.
    stdout_truncated: bool
    #: True when the child wrote more standard error than the worker retained.
    stderr_truncated: bool
    #: True when the child was KILLED for exceeding its workspace disk cap.
    disk_limit_exceeded: bool


class CommandRunner(Protocol):
    """Runs one command to completion inside the workspace and captures it."""

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        """Execute ``argv`` in ``cwd``, bounded by time and by workspace bytes.

        ``cwd`` is the workspace root, so it is also the tree the disk cap is
        measured over: the run's whole disk footprint is what the cap bounds, not
        one file within it.
        """
        ...


class _BoundedCapture:
    """A stream accumulator that retains at most ``max_bytes`` and flags overflow.

    Retention is PREFIX-first: bytes are appended until the cap is reached and
    every byte after it is dropped as it arrives. Peak memory is therefore
    ``max_bytes`` plus one read chunk, whatever the child writes. Truncating only
    at the point of arrival is the whole point - buffering everything and slicing
    afterwards leaves the resource-exhaustion vector fully intact.

    WHY THE PREFIX AND NOT THE TAIL. Either end can lose a ``CHECK ... FAIL``
    line, which is exactly why truncation forces a non-passing verdict rather than
    being treated as a diagnostics-only concern; the choice is therefore about
    which retained bytes are more useful, not about correctness. The prefix wins
    on both counts. It is the part causally BEFORE the runaway: a flooding
    ``$display`` loop IS the tail, so retaining the tail of such a run yields a
    megabyte of the same repeated line and nothing else, while the prefix holds
    whatever the testbench legitimately printed - including any check it managed
    to signal - before it wedged. Compiler diagnostics are head-weighted for the
    same reason: the first error is the root cause and the rest is cascade. The
    prefix also needs no sliding window, so the bound is obvious by construction.
    """

    __slots__ = ("_max_bytes", "_retained", "_truncated")

    def __init__(self, max_bytes: int) -> None:
        if max_bytes < 0:
            raise ValueError("capture cap must be non-negative")
        self._max_bytes = max_bytes
        self._retained = bytearray()
        self._truncated = False

    def feed(self, chunk: bytes) -> None:
        """Retain what still fits under the cap and drop (but flag) the rest."""
        headroom = self._max_bytes - len(self._retained)
        if len(chunk) > headroom:
            self._truncated = True
            chunk = chunk[:headroom]
        self._retained.extend(chunk)

    @property
    def truncated(self) -> bool:
        """True when at least one byte was dropped because the cap was reached."""
        return self._truncated

    def text(self) -> str:
        """Decode the retained bytes, replacing anything undecodable.

        ``errors="replace"`` is required, not merely lenient: the retained bytes
        are cut at an arbitrary byte offset, so the tail can be half a multi-byte
        character, and the tools' output is untrusted anyway.
        """
        return self._retained.decode("utf-8", errors="replace")


def _register_pipe(
    selector: selectors.BaseSelector, pipe: IO[bytes] | None, sink: _BoundedCapture
) -> None:
    """Register one child pipe for reading, carrying its sink as the key data."""
    if pipe is not None:
        selector.register(pipe, selectors.EVENT_READ, sink)


def _read_available(fd: int) -> bytes:
    """Read one chunk from a pipe reported readable; empty means end of stream.

    An :class:`OSError` here means the pipe can no longer be read, so it is mapped
    to end-of-stream: draining stops for that pipe instead of the whole worker
    failing on a tool that closed its output oddly.
    """
    try:
        return os.read(fd, _READ_CHUNK_BYTES)
    except OSError:
        return b""


def _drain_ready(selector: selectors.BaseSelector, timeout_s: float) -> None:
    """Read one round of whatever is readable, unregistering pipes that end."""
    for key, _ in selector.select(timeout=max(timeout_s, 0.0)):
        sink: _BoundedCapture = key.data
        chunk = _read_available(key.fd)
        if chunk:
            sink.feed(chunk)
        else:
            selector.unregister(key.fileobj)


def _pump_pipes(
    process: subprocess.Popen[bytes],
    stdout_sink: _BoundedCapture,
    stderr_sink: _BoundedCapture,
    deadline: float,
    disk_bound: _DiskBound | None,
) -> _Stop:
    """Drain both pipes and wait for the child, honouring both resource bounds.

    Returns :attr:`_Stop.EXITED` when the child exited and every pipe reached end
    of stream, :attr:`_Stop.DEADLINE` when the wall-clock deadline arrived first, or
    :attr:`_Stop.DISK_BREACH` when the workspace reached its disk cap.

    NO DEADLOCK. Reading never stops early. A sink that has hit its cap still
    consumes its chunk and discards it, so the OS pipe buffer is always drained
    and the child can never block on a full pipe. That matters because a child
    blocked on a write we refused to read would never reach ``$finish``, which
    would convert a bounded timeout into a real hang - the exact failure a naive
    "stop reading once you have enough" implementation introduces.

    THE DISK CHECK IS WOVEN INTO THE SAME LOOP, not bolted alongside it, for two
    reasons. A hung waveform dump produces NO output, so a loop that only woke on
    readable pipes would sleep until the wall-clock deadline while gigabytes
    accumulated; capping each wait at the poll interval is what makes the bound
    effective. And the loop keeps checking after both pipes reach end of stream,
    because a child that closes its streams and keeps writing files is otherwise
    bounded only by the wall clock - which is precisely the hole this fix exists to
    close, one layer down.

    ``disk_bound`` is ``None`` for the post-kill drain: the child is already being
    killed, so there is nothing left to bound.
    """
    with selectors.DefaultSelector() as selector:
        _register_pipe(selector, process.stdout, stdout_sink)
        _register_pipe(selector, process.stderr, stderr_sink)
        next_disk_check = time.monotonic()
        while True:
            now = time.monotonic()
            if now >= deadline:
                return _Stop.DEADLINE
            if now >= next_disk_check:
                if disk_bound is not None and disk_bound.breached():
                    return _Stop.DISK_BREACH
                next_disk_check = now + _DISK_POLL_INTERVAL_S
            wait_until = min(deadline, next_disk_check)
            if selector.get_map():
                _drain_ready(selector, wait_until - now)
            elif process.poll() is not None:
                return _Stop.EXITED
            else:
                # Streams are done but the child is not; keep the bounds ticking.
                time.sleep(max(wait_until - now, 0.0))


def _kill_and_drain(
    process: subprocess.Popen[bytes], stdout_sink: _BoundedCapture, stderr_sink: _BoundedCapture
) -> None:
    """SIGKILL a child that breached a resource bound, then drain briefly and reap it.

    The post-kill drain is bounded by ``_POST_KILL_DRAIN_GRACE_S`` so a grandchild
    holding the pipe open cannot keep this function from returning. Both bounds -
    wall clock and workspace disk - end here, so the kill path is shared rather than
    duplicated per bound.
    """
    process.kill()
    _pump_pipes(
        process, stdout_sink, stderr_sink, time.monotonic() + _POST_KILL_DRAIN_GRACE_S, None
    )
    # A SIGKILLed child is reaped promptly, so this wait is expected to return at
    # once. The overrun case is suppressed rather than raised because the caller
    # already reports the run as killed, and hanging here would be worse than an
    # unreaped process the OS will collect.
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=_POST_KILL_DRAIN_GRACE_S)


def _await_bounded(
    process: subprocess.Popen[bytes],
    stdout_sink: _BoundedCapture,
    stderr_sink: _BoundedCapture,
    timeout_s: float,
    disk_bound: _DiskBound,
) -> _Ended:
    """Run the child under both resource bounds, draining both pipes as it goes.

    Returns the child's exit code, or - when a bound killed it - no exit code plus
    which bound fired. Reporting the cause directly keeps the caller total: there is
    no state in which it has to guess whether ``Popen.returncode`` has been set yet,
    or which bound a missing code stands for.
    """
    stop = _pump_pipes(process, stdout_sink, stderr_sink, time.monotonic() + timeout_s, disk_bound)
    if stop is _Stop.EXITED:
        # `poll` inside the loop already reaped the child and set the code.
        return _Ended(process.returncode, disk_limit_exceeded=False)
    _kill_and_drain(process, stdout_sink, stderr_sink)
    return _Ended(None, disk_limit_exceeded=stop is _Stop.DISK_BREACH)


class SubprocessCommandRunner:
    """Production :class:`CommandRunner` backed by :mod:`subprocess`.

    A missing binary or a resource-bound kill is turned into a captured, non-zero
    :class:`CompletedCommand` rather than a raised exception, so the worker always
    reports raw facts about the run instead of crashing. Captured output is
    bounded by the caps at the top of this module and the workspace is bounded by
    the job's own ``diskMb``; see the module docstring for the measured defects
    those bounds exist to close.
    """

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        """Run ``argv`` with no shell, capturing bounded streams and the exit code."""
        try:
            # No shell, explicit argv, bounded by a timeout, by the retention caps,
            # and by the workspace disk cap: nothing from the job contents can be
            # reinterpreted as a shell command, and nothing it writes - to a pipe or
            # to a file - can exhaust the host.
            process = subprocess.Popen(
                argv,
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            return CompletedCommand(
                COMMAND_NOT_FOUND_EXIT,
                "",
                f"tool not found: {argv[0]}",
                stdout_truncated=False,
                stderr_truncated=False,
                disk_limit_exceeded=False,
            )

        stdout_sink = _BoundedCapture(MAX_CAPTURED_STDOUT_BYTES)
        stderr_sink = _BoundedCapture(MAX_CAPTURED_STDERR_BYTES)
        disk_bound = _DiskBound(root=cwd, limit_bytes=disk_limit_bytes)
        with process:
            ended = _await_bounded(process, stdout_sink, stderr_sink, timeout_s, disk_bound)
        return _completed(ended, stdout_sink, stderr_sink, timeout_s, disk_limit_bytes)


def _completed(
    ended: _Ended,
    stdout_sink: _BoundedCapture,
    stderr_sink: _BoundedCapture,
    timeout_s: float,
    disk_limit_bytes: int,
) -> CompletedCommand:
    """Assemble the captured outcome, preserving each kill's sentinel and message.

    A missing exit code means a resource bound killed the child, so the sentinel and
    the fallback message for each bound live here in one place. Neither message
    carries a path, a host, or an errno - only the cap the caller itself declared.
    """
    stdout_text = stdout_sink.text()
    stderr_text = stderr_sink.text()
    if ended.exit_code is None and ended.disk_limit_exceeded:
        return CompletedCommand(
            COMMAND_DISK_LIMIT_EXIT,
            stdout_text,
            stderr_text or f"workspace reached its {disk_limit_bytes}-byte disk cap",
            stdout_truncated=stdout_sink.truncated,
            stderr_truncated=stderr_sink.truncated,
            disk_limit_exceeded=True,
        )
    if ended.exit_code is None:
        return CompletedCommand(
            COMMAND_TIMEOUT_EXIT,
            stdout_text,
            stderr_text or f"timed out after {timeout_s:.3f}s",
            stdout_truncated=stdout_sink.truncated,
            stderr_truncated=stderr_sink.truncated,
            disk_limit_exceeded=False,
        )
    return CompletedCommand(
        ended.exit_code,
        stdout_text,
        stderr_text,
        stdout_truncated=stdout_sink.truncated,
        stderr_truncated=stderr_sink.truncated,
        disk_limit_exceeded=False,
    )
