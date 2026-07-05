"""The worker's stdout payload: the raw, pre-classification capture.

The worker reports only facts about the run - tool exit code, captured streams,
artifact references, denied out-of-workspace operations, and resource usage - and
never decides a verdict. Capture-all-or-error classification stays in the
TypeScript adapter (``app/tools/sandbox/classification.ts``).

The serialized shape here is the exact ``WorkerReport`` the TypeScript runtime
parses in ``runtime-runsc.ts``: ``exitCode``, ``stdout``, ``stderr``,
``artifacts`` (a name-keyed map of ``ArtifactBlobRef``), ``deniedOperations``,
and ``resourceUsage``. Field names are camelCase to match the seam.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

#: The category of a denied out-of-sandbox operation, mirroring the seam's
#: ``DeniedOperationKind``. The worker populates only the ``filesystem`` case
#: (path confinement); ``network`` isolation is enforced by the container itself.
DeniedOperationKind = Literal["filesystem", "network", "process"]

#: A JSON value serializable with the standard library ``json`` module.
JsonValue = str | int | float | bool | None | dict[str, "JsonValue"] | list["JsonValue"]


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    """A reference to one captured artifact blob (for example the VCD waveform)."""

    name: str
    size_bytes: int
    sha256: str

    def as_dict(self) -> dict[str, JsonValue]:
        """Serialize to the camelCase ``ArtifactBlobRef`` shape."""
        return {"name": self.name, "sizeBytes": self.size_bytes, "sha256": self.sha256}


@dataclass(frozen=True, slots=True)
class DeniedOperation:
    """A recorded attempt to act outside the sandbox workspace.

    ``path`` is the offending, rejected path when the denial is a filesystem
    confinement rejection; it is omitted from the serialized form when absent.
    """

    kind: DeniedOperationKind
    detail: str
    path: str | None = None

    def as_dict(self) -> dict[str, JsonValue]:
        """Serialize to the camelCase ``DeniedOperation`` shape (``path`` optional)."""
        payload: dict[str, JsonValue] = {"kind": self.kind, "detail": self.detail}
        if self.path is not None:
            payload["path"] = self.path
        return payload


@dataclass(frozen=True, slots=True)
class ResourceUsage:
    """Observed resource consumption of a completed or killed run."""

    wall_ms: float
    max_mem_mb: float
    cpu_ms: float

    def as_dict(self) -> dict[str, JsonValue]:
        """Serialize to the camelCase ``ResourceUsage`` shape."""
        return {"wallMs": self.wall_ms, "maxMemMb": self.max_mem_mb, "cpuMs": self.cpu_ms}


@dataclass(frozen=True, slots=True)
class WorkerReport:
    """The raw capture emitted on stdout, matching the TypeScript ``WorkerReport``."""

    exit_code: int | None
    stdout: str | None
    stderr: str | None
    artifacts: dict[str, ArtifactRef]
    denied_operations: list[DeniedOperation]
    resource_usage: ResourceUsage

    def as_dict(self) -> dict[str, JsonValue]:
        """Serialize to the exact camelCase shape ``runtime-runsc.ts`` parses."""
        return {
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "artifacts": {key: ref.as_dict() for key, ref in self.artifacts.items()},
            "deniedOperations": [denial.as_dict() for denial in self.denied_operations],
            "resourceUsage": self.resource_usage.as_dict(),
        }
