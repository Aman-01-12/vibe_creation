"""Tests for the Synthesize_Job's Netlist_Stage and Schematic_Stage (task 2.1).

Covers the worker half of Component 3: the one Yosys script the Netlist_Stage emits, the
``netlistJson`` artifact it registers only on a non-empty file, the opportunistic
``svg`` artifact a passing Schematic_Request produces, the rule that a failing or
absent netlistsvg can never move the reported exit code off the Netlist_Stage's own,
the shared :func:`_yosys_script_refusal` three-check refusal `synthesize` now shares
with `formal_prepass`, and the dispatch from ``worker.py``'s ``_run_kind``.

THE TOOLCHAIN IS STUBBED, following ``test_formal_prepass.py``'s
``_RecordingPrepassRunner`` - same protocol, same :class:`CompletedCommand`
construction, same "the fake enforces neither bound" note - so these run with no
Yosys or netlistsvg installed.

WHY A REFUSAL IS ASSERTED AS ZERO INVOCATIONS AND NOT AS A NON-ZERO EXIT. A failed
Yosys run also exits non-zero with no artifact, so the exit code alone cannot tell
a refusal from a failure. "Refused before any command is built" is a claim about
the runner having been handed nothing, so that is what is asserted.

``tests/test_formal_prepass.py`` must keep passing unedited: this suite's own
reduction of ``_prepass_refusal`` to a call to the new shared helper is checked
there by proxy, since that file pins the exact refusal messages
``formal_prepass`` still returns.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tool_runner_worker import eda
from tool_runner_worker.commands import COMMAND_NOT_FOUND_EXIT, CommandRunner, CompletedCommand
from tool_runner_worker.contract import (
    ResourceLimits,
    SandboxJob,
    SourceFile,
    SynthesizeRequest,
)
from tool_runner_worker.eda import synthesize
from tool_runner_worker.worker import run_job

#: The wire names this suite pins, spelled as literals rather than imported, following
#: ``test_formal_prepass.py``'s own discipline.
_NETLIST_FILE = "netlist.json"
_SVG_FILE = "schematic.svg"
_DESIGN_FILE = "design.v"
_INJECTED_FILE = "INJECTED.v"
_NETLIST_KEY = "netlistJson"
_SVG_KEY = "svg"

#: A source path crafted to close the Yosys ``-p`` script's ``read_verilog`` command early and
#: start a second one. Measured against Yosys 0.66 in this workspace; see
#: ``chipAgent/_inbox/gotcha-yosys-p-script-is-an-injection-channel-for-source-filenames.md``.
_INJECTING_FILE = f"{_DESIGN_FILE}; write_verilog {_INJECTED_FILE}"

_TOP = "top"
_TIMEOUT_S = 5.0
_DISK_LIMIT_BYTES = 64 * 1024 * 1024


def _captured(exit_code: int, stdout: str = "", stderr: str = "") -> CompletedCommand:
    """Build a fake capture. Every bound flag is False: this fake enforces none."""
    return CompletedCommand(
        exit_code,
        stdout,
        stderr,
        stdout_truncated=False,
        stderr_truncated=False,
        disk_limit_exceeded=False,
    )


class _RecordingSynthRunner(CommandRunner):
    """A fake Yosys-plus-netlistsvg that records every argv and writes what each tool would.

    ``netlist_exit`` is the Netlist_Stage's exit code; a 0 writes a non-empty ``netlist.json``
    unless ``write_empty_netlist`` says otherwise. ``netlistsvg_exit`` is ``None`` to model the
    binary being ABSENT (``COMMAND_NOT_FOUND_EXIT``, matching
    :mod:`tool_runner_worker.commands`'s own sentinel for a missing tool), else the exit code a
    present-but-failing (or succeeding) binary reports; a 0 writes a non-empty SVG unless
    ``write_empty_svg`` says otherwise.
    """

    def __init__(
        self,
        *,
        netlist_exit: int = 0,
        write_empty_netlist: bool = False,
        netlistsvg_exit: int | None = 0,
        write_empty_svg: bool = False,
    ) -> None:
        self.calls: list[list[str]] = []
        self._netlist_exit = netlist_exit
        self._write_empty_netlist = write_empty_netlist
        self._netlistsvg_exit = netlistsvg_exit
        self._write_empty_svg = write_empty_svg

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        _ = (timeout_s, disk_limit_bytes)
        self.calls.append(list(argv))
        if argv[0] == "yosys":
            return self._yosys(argv, cwd)
        if argv[0] == "netlistsvg":
            return self._netlistsvg(cwd)
        return _captured(COMMAND_NOT_FOUND_EXIT, stderr=f"unknown tool: {argv[0]}")

    def _yosys(self, argv: list[str], cwd: Path) -> CompletedCommand:
        commands = [command.split() for command in argv[argv.index("-p") + 1].split(";")]
        read = next((words for words in commands if words and words[0] == "read_verilog"), [])
        named = [word for word in read[1:] if not word.startswith("-")]
        missing = [name for name in named if not (cwd / name).is_file()]
        if missing:
            return _captured(1, stderr=f"ERROR: File '{missing[0]}' not found")
        for words in commands:
            if words and words[0] == "write_verilog":
                (cwd / words[1]).write_text("injected", encoding="utf-8")
            elif words and words[0] == "write_json" and self._netlist_exit == 0:
                content = "" if self._write_empty_netlist else '{"modules": {}}'
                (cwd / words[1]).write_text(content, encoding="utf-8")
        return _captured(self._netlist_exit, stderr="" if self._netlist_exit == 0 else "ERROR")

    def _netlistsvg(self, cwd: Path) -> CompletedCommand:
        if self._netlistsvg_exit is None:
            return _captured(COMMAND_NOT_FOUND_EXIT, stderr="tool not found: netlistsvg")
        if self._netlistsvg_exit == 0:
            content = "" if self._write_empty_svg else "<svg></svg>"
            (cwd / _SVG_FILE).write_text(content, encoding="utf-8")
        return _captured(self._netlistsvg_exit, stderr="" if self._netlistsvg_exit == 0 else "E")


class _BoundsCapturingRunner(CommandRunner):
    """A fake that records only the bounds each call received, answering tool-not-found."""

    def __init__(self) -> None:
        self.seen: list[tuple[float, int]] = []

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        _ = (argv, cwd)
        self.seen.append((timeout_s, disk_limit_bytes))
        return _captured(COMMAND_NOT_FOUND_EXIT)


def _write_design(workspace_root: Path, *names: str) -> list[str]:
    """Write a trivial module under each name and return the names as relpaths."""
    for name in names:
        (workspace_root / name).write_text("module top; endmodule", encoding="utf-8")
    return list(names)


def _run_synthesize(
    workspace_root: Path,
    runner: CommandRunner,
    source_relpaths: list[str],
    *,
    schematic: bool = False,
    top_module: str = _TOP,
) -> eda.EdaCapture:
    """Drive ``eda.synthesize`` with this suite's fixed bounds."""
    return synthesize(
        workspace_root,
        source_relpaths,
        SynthesizeRequest(top_module=top_module, schematic=schematic),
        runner,
        _TIMEOUT_S,
        _DISK_LIMIT_BYTES,
    )


# ---------------------------------------------------------------------------
# The Netlist_Stage: dispatch, artifact registration, exit code
# ---------------------------------------------------------------------------


def test_a_passing_netlist_stage_registers_the_netlist_artifact(tmp_path: Path) -> None:
    """Requirement 1.1 to 1.3: dispatch reaches the routine and a non-empty netlist is kept."""
    runner = _RecordingSynthRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_synthesize(tmp_path, runner, sources)

    assert [call[0] for call in runner.calls] == ["yosys"]
    assert capture.exit_code == 0
    assert _NETLIST_KEY in capture.artifacts
    assert capture.artifacts[_NETLIST_KEY].name == _NETLIST_FILE


def test_a_failing_netlist_stage_reports_its_exit_and_registers_nothing(tmp_path: Path) -> None:
    """Requirement 1.4: a non-zero Netlist_Stage exit registers no `netlistJson`."""
    runner = _RecordingSynthRunner(netlist_exit=1)
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_synthesize(tmp_path, runner, sources)

    assert capture.exit_code == 1
    assert capture.artifacts == {}


def test_an_exit_zero_empty_netlist_file_registers_nothing(tmp_path: Path) -> None:
    """Requirement 1.3: an exit-0 run that wrote a zero-byte netlist is not a produced artifact."""
    runner = _RecordingSynthRunner(write_empty_netlist=True)
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_synthesize(tmp_path, runner, sources)

    assert capture.exit_code == 0
    assert capture.artifacts == {}


def test_no_sources_is_refused_with_no_command_issued(tmp_path: Path) -> None:
    """Requirement 1.5: an empty source list refuses before any tool runs."""
    runner = _RecordingSynthRunner()

    capture = _run_synthesize(tmp_path, runner, [])

    assert runner.calls == []
    assert capture.exit_code != 0
    assert capture.artifacts == {}
    assert capture.stderr == "no Verilog source files to elaborate"


def test_the_netlist_stage_runs_under_the_jobs_bounds(tmp_path: Path) -> None:
    """Requirement 1.6: the Netlist_Stage receives the job's own wall-clock and disk bounds."""
    sources = _write_design(tmp_path, _DESIGN_FILE)
    probe_timeout = 1.5
    probe_disk_limit = 7 * 1024 * 1024
    capturing = _BoundsCapturingRunner()

    synthesize(
        tmp_path,
        sources,
        SynthesizeRequest(top_module=_TOP, schematic=False),
        capturing,
        probe_timeout,
        probe_disk_limit,
    )

    assert capturing.seen == [(probe_timeout, probe_disk_limit)]


# ---------------------------------------------------------------------------
# The Schematic_Stage: gating, artifact registration, exit-code isolation
# ---------------------------------------------------------------------------


def test_schematic_true_runs_netlistsvg_after_a_passing_yosys(tmp_path: Path) -> None:
    """Requirement 2.1, 2.2: a set Schematic_Request runs netlistsvg and keeps the SVG."""
    runner = _RecordingSynthRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_synthesize(tmp_path, runner, sources, schematic=True)

    assert [call[0] for call in runner.calls] == ["yosys", "netlistsvg"]
    assert capture.exit_code == 0
    assert _SVG_KEY in capture.artifacts
    assert capture.artifacts[_SVG_KEY].name == _SVG_FILE


def test_schematic_false_runs_exactly_one_command(tmp_path: Path) -> None:
    """Requirement 2.4: an unset Schematic_Request never invokes netlistsvg."""
    runner = _RecordingSynthRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_synthesize(tmp_path, runner, sources, schematic=False)

    assert [call[0] for call in runner.calls] == ["yosys"]
    assert _SVG_KEY not in capture.artifacts
    assert capture.exit_code == 0


@pytest.mark.parametrize(
    "runner",
    [
        pytest.param(_RecordingSynthRunner(netlistsvg_exit=None), id="netlistsvg-absent"),
        pytest.param(_RecordingSynthRunner(netlistsvg_exit=1), id="netlistsvg-fails"),
        pytest.param(_RecordingSynthRunner(write_empty_svg=True), id="netlistsvg-writes-empty-svg"),
    ],
)
def test_a_failing_or_absent_netlistsvg_leaves_the_yosys_exit_code(
    tmp_path: Path, runner: _RecordingSynthRunner
) -> None:
    """Requirement 2.3: netlistsvg's own result never moves the reported exit code.

    THE EXIT CODE STAYS THE NETLIST_STAGE'S OWN in all three shapes a missing or broken
    netlistsvg can take: ``COMMAND_NOT_FOUND_EXIT`` (127, the binary is absent), a non-zero
    exit (the binary ran and failed), and an exit-0 run that wrote no readable SVG. None of
    the three may read as a synthesis failure, because synthesis DID pass.
    """
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_synthesize(tmp_path, runner, sources, schematic=True)

    assert capture.exit_code == 0
    assert _NETLIST_KEY in capture.artifacts
    assert _SVG_KEY not in capture.artifacts


def test_schematic_true_after_a_failing_netlist_stage_never_runs_netlistsvg(
    tmp_path: Path,
) -> None:
    """Requirement 2.1: the Schematic_Stage runs only after a Netlist_Stage that exited 0."""
    runner = _RecordingSynthRunner(netlist_exit=1)
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_synthesize(tmp_path, runner, sources, schematic=True)

    assert [call[0] for call in runner.calls] == ["yosys"]
    assert capture.exit_code == 1
    assert capture.artifacts == {}


def test_netlistsvg_argv_is_an_explicit_vector_with_no_shell(tmp_path: Path) -> None:
    """Requirement 2.5: the netlist path and the SVG output path are separate argv elements."""
    runner = _RecordingSynthRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_synthesize(tmp_path, runner, sources, schematic=True)

    assert runner.calls[1] == ["netlistsvg", _NETLIST_FILE, "-o", _SVG_FILE]


# ---------------------------------------------------------------------------
# The trust boundary: `_yosys_script_refusal`, shared with `formal_prepass`
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "top_module",
    [
        pytest.param("has space", id="whitespace"),
        pytest.param("top; write_verilog INJECTED.v", id="semicolon"),
        pytest.param("9starts_with_digit", id="leading-digit"),
        pytest.param("", id="empty"),
    ],
)
def test_a_non_identifier_top_module_is_refused_before_any_command(
    tmp_path: Path, top_module: str
) -> None:
    """Requirement 3.2: a design name that is not a plain identifier builds nothing."""
    runner = _RecordingSynthRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_synthesize(tmp_path, runner, sources, top_module=top_module)

    assert runner.calls == []
    assert capture.exit_code != 0
    assert capture.artifacts == {}
    assert capture.stderr == "synthesize topModule is not a plain Verilog identifier"


def test_a_source_path_carrying_a_semicolon_is_refused_with_no_command(tmp_path: Path) -> None:
    """Requirement 3.1, 3.4: the measured two-file injection runs no command at all.

    Driven through ``run_job`` rather than ``eda.synthesize`` directly, because the whole
    chain is the claim: path confinement ACCEPTS this name - it is relative, has no
    traversal, and resolves inside the workspace - so it is written, becomes a source
    relpath, and reaches the script assembly, exactly as ``test_formal_prepass.py`` drives
    the same injection through `formal_prepass`.

    TWO FILES, which is what the measurement required: the crafted name's leading token is
    ``design.v``, so a real ``design.v`` has to exist for ``read_verilog`` to resolve it and
    carry on into the injected command.
    """
    runner = _RecordingSynthRunner()

    report = run_job(
        SandboxJob(
            kind="synthesize",
            workspace_files=[
                SourceFile(path=_DESIGN_FILE, contents="module top; endmodule"),
                SourceFile(path=_INJECTING_FILE, contents="module top; endmodule"),
            ],
            limits=ResourceLimits(cpu=1.0, mem_mb=256, procs=32, disk_mb=64, wall_ms=5000),
            required_outputs=["stdout", "stderr", "exitCode"],
            synthesize=SynthesizeRequest(top_module=_TOP, schematic=False),
        ),
        tmp_path,
        runner,
    ).as_dict()

    assert runner.calls == []
    assert not (tmp_path / _INJECTED_FILE).exists()
    assert report["artifacts"] == {}
    assert report["exitCode"] != 0
    assert report["stderr"] == (
        "a source path holds a character the Yosys script grammar would reinterpret"
    )
    # Both files were materialized, so the refusal is the script guard's and not a
    # confinement denial in disguise.
    assert (tmp_path / _INJECTING_FILE).is_file()


# ---------------------------------------------------------------------------
# Dispatch from `worker.py`'s `_run_kind`
# ---------------------------------------------------------------------------


def test_a_synthesize_job_dispatches_through_run_job(tmp_path: Path) -> None:
    """Requirement 1.1: `_run_kind` reaches the synthesize routine rather than refusing it."""
    runner = _RecordingSynthRunner()

    report = run_job(
        SandboxJob(
            kind="synthesize",
            workspace_files=[SourceFile(path=_DESIGN_FILE, contents="module top; endmodule")],
            limits=ResourceLimits(cpu=1.0, mem_mb=256, procs=32, disk_mb=64, wall_ms=5000),
            required_outputs=["stdout", "stderr", "exitCode", _NETLIST_KEY],
            synthesize=SynthesizeRequest(top_module=_TOP, schematic=False),
        ),
        tmp_path,
        runner,
    ).as_dict()

    assert [call[0] for call in runner.calls] == ["yosys"]
    assert report["exitCode"] == 0
    artifacts = report["artifacts"]
    assert isinstance(artifacts, dict)
    assert _NETLIST_KEY in artifacts
