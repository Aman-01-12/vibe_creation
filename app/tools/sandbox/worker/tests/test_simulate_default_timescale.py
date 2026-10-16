"""The ``simulate`` job's optional default-timescale entry (testbench-spec-grounding, C7).

Without the payload a job compiles with exactly today's command and writes no command file,
so a Golden_Judge job is byte-identical; with it the worker writes the one entry itself.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tool_runner_worker.commands import CommandRunner, CompletedCommand
from tool_runner_worker.contract import JobContractError, SimulateRequest, load_job
from tool_runner_worker.eda import simulate

_COMMAND_FILE = "ece-default-timescale.cmd"


class _RecordingRunner(CommandRunner):
    """Records each argv and the command file's contents at compile time; always succeeds."""

    def __init__(self) -> None:
        self.argvs: list[list[str]] = []
        self.command_file_at_compile: str | None = None

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        _ = (timeout_s, disk_limit_bytes)
        self.argvs.append(argv)
        if argv[0] == "iverilog":
            command_file = cwd / _COMMAND_FILE
            if command_file.exists():
                self.command_file_at_compile = command_file.read_text(encoding="utf-8")
        return CompletedCommand(
            0, "", "", stdout_truncated=False, stderr_truncated=False, disk_limit_exceeded=False
        )


def _job_dict(kind: str = "simulate", simulate_payload: object = None) -> dict[str, object]:
    job: dict[str, object] = {
        "kind": kind,
        "workspaceFiles": [{"path": "top.v", "contents": "module top; endmodule"}],
        "limits": {"cpu": 1, "memMb": 256, "procs": 32, "diskMb": 64, "wallMs": 5000},
        "requiredOutputs": ["stdout", "stderr", "exitCode"],
    }
    if simulate_payload is not None:
        job["simulate"] = simulate_payload
    return job


def test_without_a_request_the_compile_command_is_unchanged_and_no_file_is_written(
    tmp_path: Path,
) -> None:
    runner = _RecordingRunner()
    simulate(tmp_path, ["top.v"], runner, 5.0, 1 << 20)
    assert runner.argvs[0] == ["iverilog", "-g2012", "-o", "simulation.vvp", "top.v"]
    assert not (tmp_path / _COMMAND_FILE).exists()


def test_with_a_request_the_worker_writes_the_one_entry_and_passes_it_with_c(
    tmp_path: Path,
) -> None:
    runner = _RecordingRunner()
    simulate(tmp_path, ["top.v"], runner, 5.0, 1 << 20, SimulateRequest("1ns/1ps"))
    assert runner.argvs[0] == [
        "iverilog",
        "-g2012",
        "-c",
        _COMMAND_FILE,
        "-o",
        "simulation.vvp",
        "top.v",
    ]
    assert runner.command_file_at_compile == "+timescale+1ns/1ps\n"


def test_load_job_narrows_a_simulate_payload() -> None:
    job = load_job(json.dumps(_job_dict(simulate_payload={"defaultTimescale": "1ns/1ps"})))
    assert job.simulate == SimulateRequest("1ns/1ps")
    assert load_job(json.dumps(_job_dict())).simulate is None


def test_a_simulate_payload_on_a_formal_job_is_refused() -> None:
    payload = _job_dict(kind="formal", simulate_payload={"defaultTimescale": "1ns/1ps"})
    payload["formal"] = {"topModule": "top", "depth": 4}
    with pytest.raises(JobContractError):
        load_job(json.dumps(payload))


def test_an_unknown_timescale_is_refused() -> None:
    with pytest.raises(JobContractError):
        load_job(json.dumps(_job_dict(simulate_payload={"defaultTimescale": "1ps/1ps"})))
