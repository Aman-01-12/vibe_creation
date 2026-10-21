"""Inbound job parsing and validation against the shared seam schema.

The job arrives on stdin as untrusted input, so the worker validates it against
the canonical JSON Schema (``app/tools/sandbox/contract.schema.json``, the
byte-mirror of the TypeScript const) before acting on any field. Both sides of
the seam validate against the same schema by design: the TypeScript adapter with
ajv, the worker here with :mod:`jsonschema`. Only after validation is the job
narrowed into the typed :class:`SandboxJob` the rest of the worker consumes.

Schema validation is not the whole of it. A field whose value ends up INSIDE a
tool's own command language gets a second, in-code rule here - see
:func:`_formal_request` - because the schema document is env-overridable and
because a bound the schema does not carry at all (the proof-depth ceiling) has to
live somewhere the job cannot reach.
"""

from __future__ import annotations

import json
import os
import re
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

#: Hard ceiling on the ``-t`` proof depth a ``formal`` job may request, and the sole
#: owner of that bound for the whole worker (:mod:`tool_runner_worker.eda` imports it
#: rather than re-spelling it).
#:
#: A fixed constant rather than a job field, for the same reason the capture caps in
#: :mod:`tool_runner_worker.commands` are: the job is untrusted input and a bound a
#: caller can raise is not a bound. Generous next to anything the depth ladder
#: produces (it tops out at 80) and to the deepest run measured in the feasibility
#: probe (140 steps on ``adder_pipe_64bit``, 134s), so it never shapes a real proof;
#: it exists so an absurd depth cannot be handed to the solver.
#:
#: The seam schema bounds ``depth`` below and not above, so this is the only ceiling
#: on it anywhere - which is also why it is enforced HERE and not only by the schema:
#: ``_SCHEMA_PATH_ENV`` can point the validator at a different document, and a bound
#: on a value that ends up inside a Yosys command line must not be swappable.
MAX_PROOF_DEPTH: Final = 1024

#: A plain Verilog identifier: the rule the seam schema's ``topModule`` pattern
#: carries, enforced again in code for the reason above, and the sole owner of that
#: rule for the whole worker (:mod:`tool_runner_worker.eda` imports it too).
TOP_MODULE_RE: Final = re.compile(r"[A-Za-z_][A-Za-z0-9_$]{0,127}")

#: The default timescales a job may request, re-checked here because the value is written into
#: a compiler command file and the schema path is env-overridable.
DEFAULT_TIMESCALES: Final = frozenset({"1ns/1ps"})


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
class FormalRequest:
    """The ``formal`` job kind's parameters: which module to prove, and how deep.

    Mirrors the seam's ``FormalJobRequest``. Both fields reach a Yosys command line -
    ``top_module`` inside the one ``-p`` script, ``depth`` as ``-t`` - so both are
    validated here, at the point the untrusted job is parsed, rather than on first use.
    """

    top_module: str
    depth: int


@dataclass(frozen=True, slots=True)
class FormalPrepassRequest:
    """The ``formalPrepass`` job kind's parameter: which DESIGN to elaborate.

    Mirrors the seam's ``FormalPrepassJobRequest``. ONE field, and it is the candidate
    design's own module name rather than a Property_Wrapper's, because the pre-pass runs
    BEFORE any wrapper exists - which is the whole reason it is a job kind of its own and
    not a step inside ``formal``.

    No ``depth``: the pre-pass runs no solver. ``top_module`` reaches a Yosys command line
    inside the one ``-p`` script, so it is validated here, at the point the untrusted job is
    parsed, rather than on first use.
    """

    top_module: str


@dataclass(frozen=True, slots=True)
class SynthesizeRequest:
    """The ``synthesize`` job kind's parameters: which module to synthesize, and the schematic.

    Mirrors the seam's ``SynthesizeJobRequest``. ``top_module`` reaches a Yosys command line
    inside the one ``-p`` script, so it is validated here, at the point the untrusted job is
    parsed, rather than on first use. ``schematic`` decides whether the Schematic_Stage runs at
    all, so it is read as a strict Python ``bool`` rather than any truthy value - see
    :func:`_synthesize_request`.
    """

    top_module: str
    schematic: bool


@dataclass(frozen=True, slots=True)
class LintRequest:
    """The ``lint`` job kind's parameter: which module to lint.

    Mirrors the seam's ``LintJobRequest``. ONE field, like :class:`FormalPrepassRequest`: the
    Lint_Engine runs no solver and renders no schematic, so ``top_module`` is the whole of it.
    It reaches a Yosys command line inside the one ``-p`` script, so it is validated here rather
    than on first use.
    """

    top_module: str


@dataclass(frozen=True, slots=True)
class SimulateRequest:
    """The ``simulate`` job kind's optional compile parameter: the default timescale.

    Mirrors the seam's ``SimulateJobRequest``. The worker writes the compiler command file
    itself from this closed value, so a job can never place its own entry in that file.
    """

    default_timescale: str


@dataclass(frozen=True, slots=True)
class SandboxJob:
    """The validated, typed description of one sandbox invocation."""

    kind: str
    workspace_files: list[SourceFile]
    limits: ResourceLimits
    required_outputs: list[str]
    #: The formal payload, present if and only if ``kind`` is ``"formal"`` - the
    #: biconditional :func:`_formal_request` enforces, so neither half of a job whose
    #: kind and payload disagree can be acted on. Defaulted to the absent case because
    #: absent is a state the dispatch already has to refuse honestly; a producer that
    #: omitted it would get a refusal, never a run.
    formal: FormalRequest | None = None
    #: The pre-pass payload, present if and only if ``kind`` is ``"formalPrepass"``, by the
    #: same biconditional and defaulted for the same reason. A SECOND field rather than a
    #: widened ``formal``, because the two payloads carry different facts and a shared field
    #: would make ``depth`` either meaningless or fabricated on the pre-pass.
    formal_prepass: FormalPrepassRequest | None = None
    #: The optional simulate payload: allowed only under ``"simulate"``, absent on every
    #: Golden_Judge job, which then compiles exactly as before.
    simulate: SimulateRequest | None = None
    #: The synthesize payload, present if and only if ``kind`` is ``"synthesize"``, by the same
    #: biconditional :func:`_kind_payload` enforces for ``formal``.
    synthesize: SynthesizeRequest | None = None
    #: The lint payload, present if and only if ``kind`` is ``"lint"``, by the same biconditional.
    lint: LintRequest | None = None


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


def _kind_payload(payload: dict[str, Any], kind: str, field: str) -> dict[str, Any] | None:
    """The kind-specific payload under ``field``, or ``None`` where the job carries none.

    THE BICONDITIONAL, WITH ONE OWNER. ``field`` is present if and only if the job's kind is
    ``kind``, and both halves raise rather than returning, because a job that breaks either
    one is not a job this worker can honestly reduce to something runnable. A job of that kind
    without its payload has nothing to act on, and a job of ANOTHER kind carrying it is a job
    whose two halves disagree - running it would silently discard a field the submitter meant
    something by.

    The seam schema states the same two biconditionals as two ``allOf`` members; they are
    stated again here because the worker is its own trust boundary and :data:`_SCHEMA_PATH_ENV`
    can point that schema elsewhere.

    Field SHAPES still rest on prior schema validation, exactly as :func:`_to_job`'s reads do;
    the caller re-checks the VALUE of whichever fields become part of a command.
    """
    raw = payload.get(field)
    is_matching_kind = payload["kind"] == kind
    if raw is None:
        if is_matching_kind:
            raise JobContractError(f"sandbox job of kind {kind} carries no {field} payload")
        return None
    if not is_matching_kind:
        raise JobContractError(f"sandbox job carries a {field} payload for a non-{kind} kind")
    return cast("dict[str, Any]", raw)


def _optional_kind_payload(payload: dict[str, Any], kind: str, field: str) -> dict[str, Any] | None:
    """The payload under ``field``: may be absent under ``kind``, refused under any other kind."""
    raw = payload.get(field)
    if raw is None:
        return None
    if payload["kind"] != kind:
        raise JobContractError(f"sandbox job carries a {field} payload for a non-{kind} kind")
    return cast("dict[str, Any]", raw)


def _simulate_request(payload: dict[str, Any]) -> SimulateRequest | None:
    """Narrow the optional ``simulate`` payload, refusing a timescale outside DEFAULT_TIMESCALES."""
    fields = _optional_kind_payload(payload, "simulate", "simulate")
    if fields is None:
        return None
    request = SimulateRequest(default_timescale=str(fields["defaultTimescale"]))
    if request.default_timescale not in DEFAULT_TIMESCALES:
        raise JobContractError("simulate defaultTimescale is not a supported value")
    return request


def _formal_request(payload: dict[str, Any]) -> FormalRequest | None:
    """Narrow and re-validate the ``formal`` payload, or refuse the job.

    Beyond the biconditional :func:`_kind_payload` owns, two VALUE rules: ``top_module`` is a
    plain identifier and ``depth`` is within ``1..MAX_PROOF_DEPTH``, because both land on a
    Yosys command line and the ceiling exists nowhere in the schema.
    """
    fields = _kind_payload(payload, "formal", "formal")
    if fields is None:
        return None
    request = FormalRequest(top_module=str(fields["topModule"]), depth=int(fields["depth"]))
    if TOP_MODULE_RE.fullmatch(request.top_module) is None:
        raise JobContractError("formal topModule is not a plain Verilog identifier")
    if not 0 < request.depth <= MAX_PROOF_DEPTH:
        raise JobContractError(f"formal depth is outside 1..{MAX_PROOF_DEPTH}")
    return request


def _formal_prepass_request(payload: dict[str, Any]) -> FormalPrepassRequest | None:
    """Narrow and re-validate the ``formalPrepass`` payload, or refuse the job.

    ONE VALUE RULE rather than two, because the pre-pass runs no solver and so carries no
    depth: ``top_module`` is a plain identifier, because it lands inside the one Yosys ``-p``
    script whose ``;`` separators Yosys splits on itself.
    """
    fields = _kind_payload(payload, "formalPrepass", "formalPrepass")
    if fields is None:
        return None
    request = FormalPrepassRequest(top_module=str(fields["topModule"]))
    if TOP_MODULE_RE.fullmatch(request.top_module) is None:
        raise JobContractError("formalPrepass topModule is not a plain Verilog identifier")
    return request


def _synthesize_request(payload: dict[str, Any]) -> SynthesizeRequest | None:
    """Narrow and re-validate the ``synthesize`` payload, or refuse the job.

    Beyond the biconditional :func:`_kind_payload` owns, two VALUE rules: ``top_module`` is a
    plain identifier, for the reason :func:`_formal_prepass_request` carries, and ``schematic``
    is a Python ``bool`` and nothing else - ``bool(...)`` on the string ``"true"`` or on ``1``
    would both read as a request, which is why the raw value is checked by ``isinstance`` rather
    than coerced. The schema's ``"type": "boolean"`` carries the same rule, but the path to it
    is env-overridable, same as every other value rule in this module.
    """
    fields = _kind_payload(payload, "synthesize", "synthesize")
    if fields is None:
        return None
    schematic = fields["schematic"]
    if not isinstance(schematic, bool):
        raise JobContractError("synthesize schematic is not a boolean")
    request = SynthesizeRequest(top_module=str(fields["topModule"]), schematic=schematic)
    if TOP_MODULE_RE.fullmatch(request.top_module) is None:
        raise JobContractError("synthesize topModule is not a plain Verilog identifier")
    return request


def _lint_request(payload: dict[str, Any]) -> LintRequest | None:
    """Narrow and re-validate the ``lint`` payload, or refuse the job.

    ONE VALUE RULE, as :func:`_formal_prepass_request` carries: ``top_module`` is a plain
    identifier, because it lands inside the one Yosys ``-p`` script.
    """
    fields = _kind_payload(payload, "lint", "lint")
    if fields is None:
        return None
    request = LintRequest(top_module=str(fields["topModule"]))
    if TOP_MODULE_RE.fullmatch(request.top_module) is None:
        raise JobContractError("lint topModule is not a plain Verilog identifier")
    return request


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
        formal=_formal_request(payload),
        formal_prepass=_formal_prepass_request(payload),
        simulate=_simulate_request(payload),
        synthesize=_synthesize_request(payload),
        lint=_lint_request(payload),
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
