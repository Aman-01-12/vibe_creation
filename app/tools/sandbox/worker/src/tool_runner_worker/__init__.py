"""Thin Python worker for the Tool_Runner sandbox.

The sole TS-to-Python seam in the repo. Deliberately minimal EDA glue: it
validates a ``SandboxJob`` against the shared seam schema, writes the job's files
into a path-confined workspace, invokes ``iverilog`` and ``vvp``, and returns the
raw capture as a ``WorkerReport``. All verdict classification stays on the
TypeScript side; the worker's only trust-boundary responsibility is confining
untrusted paths to the workspace. No secrets, credentials, or PII are read,
logged, or returned here.
"""

from .worker import run_job

__version__ = "0.0.0"

__all__ = ["__version__", "run_job"]
