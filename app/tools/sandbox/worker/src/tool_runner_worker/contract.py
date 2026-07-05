"""Inbound job parsing and validation against the shared seam schema.

The job arrives on stdin as untrusted input, so the worker validates it against
the canonical JSON Schema (``app/tools/sandbox/contract.schema.json``, the
byte-mirror of the TypeScript const) before acting on any field. Both sides of
the seam validate against the same schema by design: the TypeScript adapter with
ajv, the worker here with :mod:`jsonschema`. Only after validation is the job
narrowed into the typed :class:`SandboxJob` the rest of the worker consumes.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, cast

from jsonschema import Draft7Validator
from jsonschema.exceptions import ValidationError

#: Environment override for the schema location. Defaults to the repo-relative
#: byte-mirror; the sandbox image sets this to the schema's packaged path.
_SCHEMA_PATH_ENV: Final = "TOOL_RUNNER_CONTRACT_SCHEMA"

#: JSON pointer to the job subschema within the seam document.
_JOB_REF: Final = "#/definitions/SandboxJob"


class JobContractError(Exception):
    """Raised when stdin does not parse or fails contract validation."""


@dataclass(frozen=True, slots=True)
class SourceFile:
    """One file to write into the workspace before the run (path is untrusted)."""

    path: str
    contents: str


@dataclass(frozen=True, slots=True)
class ResourceLimits:
    """Per-invocation resource and time caps carried across the seam."""

    cpu: float
    mem_mb: int
    procs: int
    disk_mb: int
    wall_ms: int


@dataclass(frozen=True, slots=True)
class SandboxJob:
    """The validated, typed description of one sandbox invocation."""

    kind: str
    workspace_files: list[SourceFile]
    limits: ResourceLimits
    required_outputs: list[str]


def _schema_path() -> Path:
    """Resolve the seam schema path (env override, else repo-relative mirror)."""
    override = os.environ.get(_SCHEMA_PATH_ENV)
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "contract.schema.json"


def _load_job_validator() -> Draft7Validator:
    """Compile a validator for the ``SandboxJob`` subschema of the seam document."""
    with _schema_path().open(encoding="utf-8") as handle:
        schema = json.load(handle)
    # A ref-to-self schema validates the job while keeping sibling definitions
    # resolvable within the same document.
    return Draft7Validator({**schema, "$ref": _JOB_REF})


_JOB_VALIDATOR: Final = _load_job_validator()


def _sanitized_issues(errors: list[ValidationError]) -> str:
    """Render validation failures as location+rule strings, echoing no values."""
    return "; ".join(f"{error.json_path} failed {error.validator} constraint" for error in errors)


def _to_job(payload: dict[str, Any]) -> SandboxJob:
    """Narrow a schema-valid payload into the typed :class:`SandboxJob`.

    Prior schema validation guarantees the shape, so the field reads here are
    total; the casts document that guarantee for the type checker.
    """
    raw_files = cast("list[dict[str, Any]]", payload["workspaceFiles"])
    raw_limits = cast("dict[str, Any]", payload["limits"])
    files = [
        SourceFile(path=str(item["path"]), contents=str(item["contents"])) for item in raw_files
    ]
    limits = ResourceLimits(
        cpu=float(raw_limits["cpu"]),
        mem_mb=int(raw_limits["memMb"]),
        procs=int(raw_limits["procs"]),
        disk_mb=int(raw_limits["diskMb"]),
        wall_ms=int(raw_limits["wallMs"]),
    )
    required = [str(output) for output in cast("list[object]", payload["requiredOutputs"])]
    return SandboxJob(
        kind=str(payload["kind"]),
        workspace_files=files,
        limits=limits,
        required_outputs=required,
    )


def load_job(raw: str) -> SandboxJob:
    """Parse and validate raw stdin into a typed :class:`SandboxJob`.

    Raises :class:`JobContractError` when the input is not JSON or violates the
    seam contract, with a message that names locations and rules but no values.
    """
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as decode_error:
        raise JobContractError(f"stdin is not valid JSON: {decode_error.msg}") from decode_error
    if not isinstance(payload, dict):
        raise JobContractError("sandbox job must be a JSON object")
    errors = sorted(_JOB_VALIDATOR.iter_errors(payload), key=str)
    if errors:
        raise JobContractError(
            f"sandbox job failed contract validation: {_sanitized_issues(errors)}"
        )
    return _to_job(payload)
