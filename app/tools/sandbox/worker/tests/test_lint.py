"""Tests for the Lint_Job's Lint_Engine invocation and its report (task 2.2).

Covers the worker half of Component 4: the one Yosys script the Lint_Engine emits
(``synth -top`` followed by ``check -assert`` under a ``tee -q -o`` log), the
``lint-report.json`` artifact the worker ALWAYS writes for a job that reaches dispatch,
``_lint_report``'s reading of the last ``Found and reported (\\d+) problems.`` line, the
shared :func:`eda._yosys_script_refusal` three-check refusal `lint` shares with
`synthesize` and `formal_prepass`, and the dispatch from ``worker.py``'s ``_run_kind``.

THE TOOLCHAIN IS STUBBED, following ``test_synthesize.py``'s ``_RecordingSynthRunner`` -
same protocol, same :class:`CompletedCommand` construction, same "the fake enforces
neither bound" note - so these run with no Yosys installed.

WHY A REFUSAL IS ASSERTED AS ZERO INVOCATIONS AND NOT AS A NON-ZERO EXIT. A failed
Yosys run also exits non-zero with no artifact, so the exit code alone cannot tell a
refusal from a failure. "Refused before any command is built" is a claim about the
runner having been handed nothing, so that is what is asserted.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tool_runner_worker import eda
from tool_runner_worker.commands import COMMAND_NOT_FOUND_EXIT, CommandRunner, CompletedCommand
from tool_runner_worker.contract import LintRequest, ResourceLimits, SandboxJob, SourceFile
from tool_runner_worker.eda import lint
from tool_runner_worker.worker import run_job

#: The wire names this suite pins, spelled as literals rather than imported, following
#: ``test_synthesize.py``'s own discipline.
_LOG_FILE = "lint-check.log"
_REPORT_FILE = "lint-report.json"
_REPORT_KEY = "lintReport"
_DESIGN_FILE = "design.v"
_INJECTED_FILE = "INJECTED.v"

#: A source path crafted to close the Yosys ``-p`` script's ``read_verilog`` command early
#: and start a second one, following ``test_synthesize.py``'s own injection fixture.
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


class _RecordingLintRunner(CommandRunner):
    """A fake Yosys that records every argv and writes the log ``tee -q -o`` would.

    ``exit_code`` is the one Yosys invocation's own exit; a 0 writes ``log_text`` to the
    log file (modelling a completed ``check -assert``) unless ``write_log`` is False
    (modelling a ``synth`` failure that never reaches ``tee``, per D-08).
    """

    def __init__(
        self,
        *,
        exit_code: int = 0,
        log_text: str = "Found and reported 0 problems.\n",
        write_log: bool = True,
    ) -> None:
        self.calls: list[list[str]] = []
        self._exit_code = exit_code
        self._log_text = log_text
        self._write_log = write_log

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        _ = (timeout_s, disk_limit_bytes)
        self.calls.append(list(argv))
        if argv[0] != "yosys":
            return _captured(COMMAND_NOT_FOUND_EXIT, stderr=f"unknown tool: {argv[0]}")
        commands = [command.split() for command in argv[argv.index("-p") + 1].split(";")]
        read = next((words for words in commands if words and words[0] == "read_verilog"), [])
        named = [word for word in read[1:] if not word.startswith("-")]
        missing = [name for name in named if not (cwd / name).is_file()]
        if missing:
            return _captured(1, stderr=f"ERROR: File '{missing[0]}' not found")
        for words in commands:
            if words and words[0] == "write_verilog":
                (cwd / words[1]).write_text("injected", encoding="utf-8")
        if self._write_log:
            (cwd / _LOG_FILE).write_text(self._log_text, encoding="utf-8")
        return _captured(self._exit_code, stderr="" if self._exit_code == 0 else "ERROR")


class _CommandNotFoundRunner(CommandRunner):
    """A fake modelling an absent Yosys binary: every call answers ``COMMAND_NOT_FOUND_EXIT``."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        _ = (cwd, timeout_s, disk_limit_bytes)
        self.calls.append(list(argv))
        return _captured(COMMAND_NOT_FOUND_EXIT, stderr=f"tool not found: {argv[0]}")


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


def _run_lint(
    workspace_root: Path,
    runner: CommandRunner,
    source_relpaths: list[str],
    *,
    top_module: str = _TOP,
) -> eda.EdaCapture:
    """Drive ``eda.lint`` with this suite's fixed bounds."""
    return lint(
        workspace_root,
        source_relpaths,
        LintRequest(top_module=top_module),
        runner,
        _TIMEOUT_S,
        _DISK_LIMIT_BYTES,
    )


# ---------------------------------------------------------------------------
# Dispatch and the always-written report
# ---------------------------------------------------------------------------


def test_a_lint_job_dispatches_through_run_job(tmp_path: Path) -> None:
    """Requirement 4.1: `_run_kind` reaches the lint routine rather than refusing it."""
    runner = _RecordingLintRunner()

    report = run_job(
        SandboxJob(
            kind="lint",
            workspace_files=[SourceFile(path=_DESIGN_FILE, contents="module top; endmodule")],
            limits=ResourceLimits(cpu=1.0, mem_mb=256, procs=32, disk_mb=64, wall_ms=5000),
            required_outputs=["stdout", "stderr", "exitCode", _REPORT_KEY],
            lint=LintRequest(top_module=_TOP),
        ),
        tmp_path,
        runner,
    ).as_dict()

    assert [call[0] for call in runner.calls] == ["yosys"]
    assert report["exitCode"] == 0
    artifacts = report["artifacts"]
    assert isinstance(artifacts, dict)
    assert _REPORT_KEY in artifacts


def test_a_clean_log_reports_zero_problems_reached(tmp_path: Path) -> None:
    """Requirement 4.3: a log holding `Found and reported 0 problems.` parses as reached."""
    runner = _RecordingLintRunner(log_text="Found and reported 0 problems.\n")
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_lint(tmp_path, runner, sources)

    assert eda._lint_report(tmp_path) == {"reachedCheck": True, "problemCount": 0}


def test_a_findings_log_reports_the_problem_count_reached(tmp_path: Path) -> None:
    """Requirement 4.3, 5.4: a log holding `Found and reported 3 problems.` parses as reached."""
    runner = _RecordingLintRunner(log_text="Found and reported 3 problems.\n")
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_lint(tmp_path, runner, sources)

    assert eda._lint_report(tmp_path) == {"reachedCheck": True, "problemCount": 3}
    assert _REPORT_KEY in capture.artifacts


def test_an_absent_log_reports_check_not_reached(tmp_path: Path) -> None:
    """D-08: a `synth` failure that never reaches `tee` leaves no log, so the check is unreached."""
    runner = _RecordingLintRunner(exit_code=1, write_log=False)
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_lint(tmp_path, runner, sources)

    assert eda._lint_report(tmp_path) == {"reachedCheck": False, "problemCount": None}
    # Still a Lint_Job that reached dispatch, so the report is still written and registered.
    assert _REPORT_KEY in capture.artifacts
    assert capture.exit_code == 1


def test_an_oversized_log_reports_check_not_reached(tmp_path: Path) -> None:
    """The `MAX_LINT_LOG_BYTES` bound: an over-bound log is refused, not read, as unreached."""
    (tmp_path / _LOG_FILE).write_text(
        "x" * (eda.MAX_LINT_LOG_BYTES + 1) + "\nFound and reported 0 problems.\n",
        encoding="utf-8",
    )

    assert eda._lint_report(tmp_path) == {"reachedCheck": False, "problemCount": None}


def test_a_log_with_no_matching_line_reports_check_not_reached(tmp_path: Path) -> None:
    """A present log carrying no `Found and reported` line still answers unreached."""
    (tmp_path / _LOG_FILE).write_text("some unrelated Yosys chatter\n", encoding="utf-8")

    assert eda._lint_report(tmp_path) == {"reachedCheck": False, "problemCount": None}


def test_the_last_matching_line_wins_over_an_earlier_one(tmp_path: Path) -> None:
    """`_lint_report` reads the LAST matching line, not the first."""
    (tmp_path / _LOG_FILE).write_text(
        "Found and reported 5 problems.\nFound and reported 2 problems.\n",
        encoding="utf-8",
    )

    assert eda._lint_report(tmp_path) == {"reachedCheck": True, "problemCount": 2}


def test_a_missing_yosys_binary_reports_unreached_with_one_command_issued(tmp_path: Path) -> None:
    """Requirement 4.6: a missing engine issues exactly one command and reports unreached."""
    runner = _CommandNotFoundRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_lint(tmp_path, runner, sources)

    assert len(runner.calls) == 1
    assert capture.exit_code == COMMAND_NOT_FOUND_EXIT
    assert eda._lint_report(tmp_path) == {"reachedCheck": False, "problemCount": None}
    assert _REPORT_KEY in capture.artifacts


# ---------------------------------------------------------------------------
# The trust boundary: `_yosys_script_refusal`, shared with `synthesize` and `formal_prepass`
# ---------------------------------------------------------------------------


def test_no_sources_is_refused_with_no_command_and_no_report(tmp_path: Path) -> None:
    """Requirement 3.1: an empty source list refuses before any tool runs, with no artifact."""
    runner = _RecordingLintRunner()

    capture = _run_lint(tmp_path, runner, [])

    assert runner.calls == []
    assert capture.exit_code != 0
    assert capture.artifacts == {}
    assert capture.stderr == "no Verilog source files to elaborate"
    assert not (tmp_path / _REPORT_FILE).exists()


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
    """Requirement 3.5: a design name that is not a plain identifier builds nothing."""
    runner = _RecordingLintRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_lint(tmp_path, runner, sources, top_module=top_module)

    assert runner.calls == []
    assert capture.exit_code != 0
    assert capture.artifacts == {}
    assert capture.stderr == "lint topModule is not a plain Verilog identifier"


def test_a_source_path_carrying_a_semicolon_is_refused_with_no_command(tmp_path: Path) -> None:
    """Requirement 3.1, 3.5: the measured two-file injection runs no command at all.

    Driven through ``run_job`` rather than ``eda.lint`` directly, because the whole chain
    is the claim: path confinement ACCEPTS this name, so it is written, becomes a source
    relpath, and reaches the script assembly, exactly as ``test_synthesize.py`` drives the
    same injection through `synthesize`.
    """
    runner = _RecordingLintRunner()

    report = run_job(
        SandboxJob(
            kind="lint",
            workspace_files=[
                SourceFile(path=_DESIGN_FILE, contents="module top; endmodule"),
                SourceFile(path=_INJECTING_FILE, contents="module top; endmodule"),
            ],
            limits=ResourceLimits(cpu=1.0, mem_mb=256, procs=32, disk_mb=64, wall_ms=5000),
            required_outputs=["stdout", "stderr", "exitCode"],
            lint=LintRequest(top_module=_TOP),
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
    assert (tmp_path / _INJECTING_FILE).is_file()


# ---------------------------------------------------------------------------
# Resource bounds
# ---------------------------------------------------------------------------


def test_the_lint_engine_runs_under_the_jobs_bounds(tmp_path: Path) -> None:
    """Requirement 4.2: the Lint_Engine receives the job's own wall-clock and disk bounds."""
    sources = _write_design(tmp_path, _DESIGN_FILE)
    probe_timeout = 1.5
    probe_disk_limit = 7 * 1024 * 1024
    capturing = _BoundsCapturingRunner()

    lint(
        tmp_path,
        sources,
        LintRequest(top_module=_TOP),
        capturing,
        probe_timeout,
        probe_disk_limit,
    )

    assert capturing.seen == [(probe_timeout, probe_disk_limit)]
