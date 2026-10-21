"""The `synthesize` and `lint` job payloads at the contract boundary (structural-gate-toolchain C2).

Mirrors `test_simulate_default_timescale.py`'s shape: `load_job` narrows a schema-valid payload
into its typed request if and only if the job's `kind` matches, and refuses otherwise. Covers the
one rule beyond that biconditional each payload carries - `topModule` against `TOP_MODULE_RE`,
and `synthesize.schematic` as a strict Python `bool`, re-checked here because the schema path is
env-overridable (see `contract.py`'s module docstring).
"""

from __future__ import annotations

import json

import pytest

from tool_runner_worker.contract import JobContractError, LintRequest, SynthesizeRequest, load_job


def _job_dict(kind: str, **payloads: object) -> dict[str, object]:
    """A schema-valid job of `kind`, carrying whichever kind-specific payloads are given."""
    job: dict[str, object] = {
        "kind": kind,
        "workspaceFiles": [{"path": "top.v", "contents": "module top; endmodule"}],
        "limits": {"cpu": 1, "memMb": 256, "procs": 32, "diskMb": 64, "wallMs": 5000},
        "requiredOutputs": ["stdout", "stderr", "exitCode"],
    }
    job.update(payloads)
    return job


def test_a_synthesize_payload_on_a_synthesize_job_parses() -> None:
    payload = _job_dict("synthesize", synthesize={"topModule": "top", "schematic": True})
    job = load_job(json.dumps(payload))
    assert job.synthesize == SynthesizeRequest(top_module="top", schematic=True)
    assert job.lint is None


def test_a_lint_payload_on_a_lint_job_parses() -> None:
    payload = _job_dict("lint", lint={"topModule": "top"})
    job = load_job(json.dumps(payload))
    assert job.lint == LintRequest(top_module="top")
    assert job.synthesize is None


def test_a_synthesize_payload_on_a_lint_job_is_refused() -> None:
    payload = _job_dict(
        "lint", lint={"topModule": "top"}, synthesize={"topModule": "top", "schematic": False}
    )
    with pytest.raises(JobContractError):
        load_job(json.dumps(payload))


def test_a_lint_payload_on_a_synthesize_job_is_refused() -> None:
    payload = _job_dict(
        "synthesize",
        synthesize={"topModule": "top", "schematic": False},
        lint={"topModule": "top"},
    )
    with pytest.raises(JobContractError):
        load_job(json.dumps(payload))


def test_a_synthesize_job_with_no_synthesize_payload_is_refused() -> None:
    with pytest.raises(JobContractError):
        load_job(json.dumps(_job_dict("synthesize")))


def test_a_lint_job_with_no_lint_payload_is_refused() -> None:
    with pytest.raises(JobContractError):
        load_job(json.dumps(_job_dict("lint")))


@pytest.mark.parametrize("kind", ["synthesize", "lint"])
@pytest.mark.parametrize("top_module", ["", "1leading_digit", "has space", "has-dash", "a" * 129])
def test_a_non_identifier_top_module_is_refused(kind: str, top_module: str) -> None:
    payload = _job_dict(kind, **{kind: {"topModule": top_module, "schematic": True}})
    # The `lint` payload carries no `schematic` key; drop it so the job stays schema-valid.
    if kind == "lint":
        del payload[kind]["schematic"]  # type: ignore[index]
    with pytest.raises(JobContractError):
        load_job(json.dumps(payload))


@pytest.mark.parametrize("kind", ["synthesize", "lint"])
def test_a_missing_top_module_is_refused(kind: str) -> None:
    inner: dict[str, object] = {"schematic": True} if kind == "synthesize" else {}
    with pytest.raises(JobContractError):
        load_job(json.dumps(_job_dict(kind, **{kind: inner})))


@pytest.mark.parametrize("schematic", ["true", 1])
def test_a_non_boolean_schematic_is_refused(schematic: object) -> None:
    payload = _job_dict("synthesize", synthesize={"topModule": "top", "schematic": schematic})
    with pytest.raises(JobContractError):
        load_job(json.dumps(payload))
