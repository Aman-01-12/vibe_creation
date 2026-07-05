"""Resource-usage measurement for a run (raw capture only).

The worker measures wall-clock, child CPU time, and peak child memory around the
tool invocations and reports them as facts. These figures are informational raw
capture; the enforced caps live in the container spec on the TypeScript side, and
the verdict decision never depends on these numbers.
"""

from __future__ import annotations

import resource
import sys
import time
from dataclasses import dataclass

from .report import ResourceUsage

#: ``ru_maxrss`` is reported in bytes on macOS but in kibibytes on Linux (the
#: real sandbox platform); normalize both to mebibytes.
_MAXRSS_DIVISOR_MB = 1024.0 * 1024.0 if sys.platform == "darwin" else 1024.0


@dataclass(frozen=True, slots=True)
class UsageMeter:
    """A started measurement window over child-process resource consumption."""

    started_monotonic: float
    start_cpu_s: float

    def finish(self) -> ResourceUsage:
        """Close the window and return the observed usage."""
        wall_ms = max(0.0, (time.monotonic() - self.started_monotonic) * 1000.0)
        children = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu_ms = max(0.0, (children.ru_utime + children.ru_stime - self.start_cpu_s) * 1000.0)
        max_mem_mb = max(0.0, children.ru_maxrss / _MAXRSS_DIVISOR_MB)
        return ResourceUsage(wall_ms=wall_ms, max_mem_mb=max_mem_mb, cpu_ms=cpu_ms)


def start_usage_meter() -> UsageMeter:
    """Begin measuring child-process resource usage from now."""
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return UsageMeter(
        started_monotonic=time.monotonic(),
        start_cpu_s=children.ru_utime + children.ru_stime,
    )
