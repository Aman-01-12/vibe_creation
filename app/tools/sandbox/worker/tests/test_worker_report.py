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

from tool_runner_worker.commands import COMMAND_NOT_FOUND_EXIT, CommandRunner, CompletedCommand
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

    def run(self, argv: list[str], cwd: Path, timeout_s: float) -> CompletedCommand:
        _ = timeout_s  # the fake ignores the timeout; the container enforces it
        tool = argv[0]
        if tool == "iverilog":
            (cwd / "simulation.vvp").write_text("compiled", encoding="utf-8")
            return CompletedCommand(0, "", "")
        if tool == "vvp":
            (cwd / "dump.vcd").write_text("$dumpfile\n$enddefinitions\n", encoding="utf-8")
            return CompletedCommand(0, "CHECK ok\n", "")
        return CompletedCommand(COMMAND_NOT_FOUND_EXIT, "", f"unknown tool: {tool}")


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
        "artifacts",
        "deniedOperations",
        "resourceUsage",
    }
    assert report["exitCode"] == 0
    assert report["stdout"] == "CHECK ok\n"
    assert report["deniedOperations"] == []
    assert set(report["resourceUsage"]) == {"wallMs", "maxMemMb", "cpuMs"}


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
    # The TypeScript adapter adds the verdict; the rest is the worker's capture.
    sandbox_result = {**report, "verdict": "pass"}
    _result_validator().validate(sandbox_result)
