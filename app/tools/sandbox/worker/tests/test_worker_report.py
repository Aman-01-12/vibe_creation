"""Round-trip tests for job validation and the emitted WorkerReport shape.

Two seams are covered:

- Inbound: a sample job validates against the shared schema via ``load_job`` and
  a malformed job is rejected.
- Outbound: the raw ``WorkerReport`` the worker emits has the exact camelCase
  shape ``runtime-runsc.ts`` parses, and its artifact/denial/usage sub-objects
  satisfy the canonical ``SandboxResult`` schema (worker report plus a verdict).

The EDA tools are stubbed with a fake :class:`CommandRunner`, so these run with
neither ``iverilog`` nor ``vvp`` installed.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

from tool_runner_worker.commands import (
    COMMAND_DISK_LIMIT_EXIT,
    COMMAND_NOT_FOUND_EXIT,
    CommandRunner,
    CompletedCommand,
)
from tool_runner_worker.contract import (
    JobContractError,
    ResourceLimits,
    SandboxJob,
    SourceFile,
    load_job,
)
from tool_runner_worker.worker import run_job

_SCHEMA_PATH = Path(__file__).resolve().parents[2] / "contract.schema.json"
_HEX64 = 64


def _load_schema() -> dict[str, object]:
    with _SCHEMA_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def _result_validator() -> Draft7Validator:
    schema = _load_schema()
    return Draft7Validator({**schema, "$ref": "#/definitions/SandboxResult"})


def _sample_job_dict() -> dict[str, object]:
    return {
        "kind": "simulate",
        "workspaceFiles": [{"path": "top.v", "contents": "module top; endmodule"}],
        "limits": {"cpu": 1, "memMb": 256, "procs": 32, "diskMb": 64, "wallMs": 5000},
        "requiredOutputs": ["stdout", "stderr", "exitCode", "vcd"],
    }


class _FakeEdaRunner(CommandRunner):
    """A fake toolchain: compiles, simulates, and drops a VCD, all in-workspace."""

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        # The fake enforces neither bound: the wall clock is enforced by the runtime
        # that spawned the worker, and the workspace cap by the real runner's pump
        # loop. Both are asserted against the REAL runner in
        # ``test_command_capture_bounds.py``; here they are only carried.
        _ = (timeout_s, disk_limit_bytes)
        tool = argv[0]
        if tool == "iverilog":
            (cwd / "simulation.vvp").write_text("compiled", encoding="utf-8")
            return CompletedCommand(
                0,
                "",
                "",
                stdout_truncated=False,
                stderr_truncated=False,
                disk_limit_exceeded=False,
            )
        if tool == "vvp":
            (cwd / "dump.vcd").write_text("$dumpfile\n$enddefinitions\n", encoding="utf-8")
            return CompletedCommand(
                0,
                "CHECK ok\n",
                "",
                stdout_truncated=False,
                stderr_truncated=False,
                disk_limit_exceeded=False,
            )
        return CompletedCommand(
            COMMAND_NOT_FOUND_EXIT,
            "",
            f"unknown tool: {tool}",
            stdout_truncated=False,
            stderr_truncated=False,
            disk_limit_exceeded=False,
        )


class _TruncatingEdaRunner(_FakeEdaRunner):
    """A fake toolchain whose simulation output overran the worker's stdout cap."""

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        completed = super().run(argv, cwd, timeout_s, disk_limit_bytes)
        if argv[0] != "vvp":
            return completed
        return CompletedCommand(
            completed.exit_code,
            completed.stdout,
            completed.stderr,
            stdout_truncated=True,
            stderr_truncated=False,
            disk_limit_exceeded=False,
        )


class _DiskKilledEdaRunner(_FakeEdaRunner):
    """A fake toolchain whose simulation was KILLED for filling its workspace.

    Modelled exactly as the real runner reports it: the disk-cap sentinel exit code,
    a stderr line naming the cap, the partial stdout it had already retained, and the
    flag. The plausible residue is the point - a reader going by the exit code alone
    would call this a tool that failed on its own.
    """

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        completed = super().run(argv, cwd, timeout_s, disk_limit_bytes)
        if argv[0] != "vvp":
            return completed
        return CompletedCommand(
            COMMAND_DISK_LIMIT_EXIT,
            completed.stdout,
            f"workspace reached its {disk_limit_bytes}-byte disk cap",
            stdout_truncated=False,
            stderr_truncated=False,
            disk_limit_exceeded=True,
        )


def _sample_job() -> SandboxJob:
    return SandboxJob(
        kind="simulate",
        workspace_files=[SourceFile(path="top.v", contents="module top; endmodule")],
        limits=ResourceLimits(cpu=1.0, mem_mb=256, procs=32, disk_mb=64, wall_ms=5000),
        required_outputs=["stdout", "stderr", "exitCode", "vcd"],
    )


def test_load_job_accepts_a_schema_valid_job() -> None:
    """A well-formed job validates and narrows to the typed structure."""
    job = load_job(json.dumps(_sample_job_dict()))
    assert job.kind == "simulate"
    assert job.workspace_files[0].path == "top.v"
    assert job.limits.wall_ms == 5000
    assert job.required_outputs == ["stdout", "stderr", "exitCode", "vcd"]


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda d: d.pop("limits"), id="missing-limits"),
        pytest.param(lambda d: d.__setitem__("kind", "explode"), id="bad-kind"),
        pytest.param(lambda d: d.__setitem__("workspaceFiles", "nope"), id="files-not-array"),
        pytest.param(lambda d: d.__setitem__("extra", 1), id="additional-property"),
    ],
)
def test_load_job_rejects_contract_violations(
    mutate: Callable[[dict[str, object]], object],
) -> None:
    """Malformed jobs are rejected at the worker's trust boundary."""
    payload = _sample_job_dict()
    mutate(payload)
    with pytest.raises(JobContractError):
        load_job(json.dumps(payload))


def test_report_has_the_exact_worker_report_shape(tmp_path: Path) -> None:
    """The emitted report matches the fields ``runtime-runsc.ts`` parses."""
    report = run_job(_sample_job(), tmp_path, _FakeEdaRunner()).as_dict()

    assert set(report) == {
        "exitCode",
        "stdout",
        "stderr",
        "stdoutTruncated",
        "stderrTruncated",
        "diskLimitExceeded",
        "artifacts",
        "deniedOperations",
        "resourceUsage",
    }
    assert report["exitCode"] == 0
    assert report["stdout"] == "CHECK ok\n"
    assert report["stdoutTruncated"] is False
    assert report["stderrTruncated"] is False
    assert report["diskLimitExceeded"] is False
    assert report["deniedOperations"] == []
    assert set(report["resourceUsage"]) == {"wallMs", "maxMemMb", "cpuMs"}


def test_report_carries_truncation_across_the_seam(tmp_path: Path) -> None:
    """A bounded simulation capture reports its truncation, so a caller can tell.

    Without this the TypeScript side cannot distinguish "this is all the output"
    from "this is some of the output", and a bounded prefix whose retained checks
    all passed would read as a complete, passing run.
    """
    report = run_job(_sample_job(), tmp_path, _TruncatingEdaRunner()).as_dict()

    assert report["stdoutTruncated"] is True
    assert report["stderrTruncated"] is False
    assert report["exitCode"] == 0
    # A bounded capture is not a disk breach: the two bounds are reported apart, so
    # neither can be inferred from the other.
    assert report["diskLimitExceeded"] is False


def test_report_carries_the_disk_cap_kill_across_the_seam(tmp_path: Path) -> None:
    """A workspace disk-cap kill reports the flag, not just its plausible residue.

    The flag is the only honest signal. A disk-killed run leaves a real exit code and
    a real stderr line behind, so a TypeScript side reading the residue would classify
    it as a tool that failed on its own - which is how a run WE terminated becomes a
    verdict about the design, and how mutation calibration would move the mutant from
    a golden kill to a non-compiling one.
    """
    report = run_job(_sample_job(), tmp_path, _DiskKilledEdaRunner()).as_dict()

    assert report["diskLimitExceeded"] is True
    assert report["exitCode"] == COMMAND_DISK_LIMIT_EXIT
    assert report["stdoutTruncated"] is False


def test_report_captures_vcd_artifact(tmp_path: Path) -> None:
    """A produced waveform is captured under the ``vcd`` key with a hex digest."""
    report = run_job(_sample_job(), tmp_path, _FakeEdaRunner()).as_dict()
    artifacts = report["artifacts"]
    assert isinstance(artifacts, dict)
    vcd = artifacts["vcd"]
    assert set(vcd) == {"name", "sizeBytes", "sha256"}
    assert len(vcd["sha256"]) == _HEX64


def test_report_plus_verdict_satisfies_the_canonical_result_schema(tmp_path: Path) -> None:
    """Report sub-objects match the seam's ``SandboxResult`` shape exactly."""
    report = run_job(_sample_job(), tmp_path, _FakeEdaRunner()).as_dict()
    # The TypeScript adapter adds the two CLASSIFICATION fields; the rest is the
    # worker's capture. ``timedOut`` sits beside ``verdict`` for the same reason:
    # the wall-clock kill happens above the worker, in the runtime that spawned
    # it, so the worker cannot and does not report it. ``diskLimitExceeded`` is the
    # mirror image and is therefore NOT added here - the worker is the only side
    # that can see the workspace bytes, so it comes up from the report.
    sandbox_result = {**report, "verdict": "pass", "timedOut": False}
    _result_validator().validate(sandbox_result)
