"""Property 7: the worker refuses before any tool runs on an unsafe source or top (task 2.3).

The universal complement to the example checks already in ``test_formal_prepass.py``,
``test_synthesize.py``, and ``test_lint.py``: each of those pins one representative refusal
per routine; this suite asserts the same gate holds *for any* source list and top module, over
100+ inputs, for ``formal_prepass``, ``synthesize``, and ``lint`` at once, since task 2.1
reduced all three to one shared call to ``eda._yosys_script_refusal``.

The guarantee (Design: Property 7; Req 1.5, 3.1, 3.2, 3.5, 4.5) is one biconditional, checked
through ONE scripted :class:`CommandRunner` that records every argv it is handed:

  a routine issues no command if and only if the source list is empty, some source path fails
  ``_SCRIPT_SAFE_RELPATH_RE``, or the top module fails ``TOP_MODULE_RE`` - and every refusal
  that follows reports a non-zero exit, registers no artifact, and states the standard refusal
  message for whichever rule fired.

THE ORACLE IS BUILT FROM THE TWO NAMED RULES, not from calling ``_yosys_script_refusal``
itself: design.md spells the property in terms of ``TOP_MODULE_RE`` and
``_SCRIPT_SAFE_RELPATH_RE`` directly, so re-deriving the refusal independently from those two
checks is what makes this an integration check on the three dispatchers - whether each one
actually gates on the shared rule before building a command - rather than a test of the shared
rule against itself.
"""

from __future__ import annotations

import contextlib
import string
import tempfile
from collections.abc import Iterator
from pathlib import Path

from hypothesis import example, given
from hypothesis import strategies as st
from property_harness import property_tag, safe_relative_paths, unsafe_path_strings

from tool_runner_worker import eda
from tool_runner_worker.commands import CommandRunner, CompletedCommand
from tool_runner_worker.contract import (
    TOP_MODULE_RE,
    FormalPrepassRequest,
    LintRequest,
    SynthesizeRequest,
)
from tool_runner_worker.eda import formal_prepass, lint, synthesize

#: The canonical tag for this property, asserted verbatim by ``test_property_7_tag``.
PROPERTY = property_tag(7, "The worker refuses before any tool runs on an unsafe source or top")

_TIMEOUT_S = 5.0
_DISK_LIMIT_BYTES = 64 * 1024 * 1024

#: The two files the measured injection needs: a real, resolvable ``design.v`` so
#: ``read_verilog`` does not abort before the second, crafted name is even reached, and the
#: crafted name itself. Matches the fixture ``test_synthesize.py`` and ``test_lint.py`` already
#: drive the same injection through, spelled independently here following this suite's own
#: literal-constant discipline.
_SAFE_FILE = "design.v"
_INJECTED_FILE = "INJECTED.v"
_INJECTING_FILE = f"{_SAFE_FILE}; write_verilog {_INJECTED_FILE}"
_MEASURED_TOP = "top"


class _RecordingRunner(CommandRunner):
    """A fake that records every argv and reports a trivial success, enforcing neither bound.

    This property is about whether a command is issued at all, never about what a real Yosys
    invocation would do with one, so one canned exit-0 capture is enough for every call this
    fake ever sees.
    """

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        _ = (cwd, timeout_s, disk_limit_bytes)
        self.calls.append(list(argv))
        return CompletedCommand(
            0, "", "", stdout_truncated=False, stderr_truncated=False, disk_limit_exceeded=False
        )


@contextlib.contextmanager
def _tmp_workspace() -> Iterator[Path]:
    """A fresh workspace root for one Hypothesis example.

    pytest's ``tmp_path`` fixture is resolved once per test *invocation*, not once per
    Hypothesis *example*, so a shared root would let one example's writes leak into the next.
    Matches ``test_lint_report_property.py``'s own ``_tmp_workspace``.
    """
    with tempfile.TemporaryDirectory() as workspace:
        yield Path(workspace)


#: Plain Verilog identifiers `TOP_MODULE_RE` accepts, built from the alphabet rather than
#: from the regex text itself, so this strategy cannot drift into testing the regex against
#: a copy of its own pattern.
_IDENTIFIER_START = string.ascii_letters + "_"
_IDENTIFIER_CONTINUE = string.ascii_letters + string.digits + "_$"

_SAFE_TOP_MODULES = st.builds(
    lambda first, rest: first + rest,
    st.sampled_from(_IDENTIFIER_START),
    st.text(alphabet=_IDENTIFIER_CONTINUE, max_size=8),
)

#: Hostile top-module strings: the shared syntactic attack classes plus the empty string,
#: which is also not a plain identifier and so belongs in this dimension too.
_HOSTILE_TOP_MODULES = st.one_of(unsafe_path_strings(), st.just(""))

_TOP_MODULES = st.one_of(_SAFE_TOP_MODULES, _HOSTILE_TOP_MODULES)

#: Source paths: legitimate workspace-relative names the script grammar accepts untouched,
#: mixed with the same hostile classes, both reused from the shared harness rather than
#: re-rolled here.
_SOURCES = st.one_of(safe_relative_paths(), unsafe_path_strings())
_SOURCE_LISTS = st.lists(_SOURCES, max_size=4)

#: One dispatcher per routine Property 7 names, each wired to this suite's fixed bounds so the
#: hypothesis test below drives all three off the same two inputs.
_ROUTINES = {
    "formalPrepass": lambda root, sources, top, runner: formal_prepass(
        root,
        sources,
        FormalPrepassRequest(top_module=top),
        runner,
        _TIMEOUT_S,
        _DISK_LIMIT_BYTES,
    ),
    "synthesize": lambda root, sources, top, runner: synthesize(
        root,
        sources,
        SynthesizeRequest(top_module=top, schematic=False),
        runner,
        _TIMEOUT_S,
        _DISK_LIMIT_BYTES,
    ),
    "lint": lambda root, sources, top, runner: lint(
        root,
        sources,
        LintRequest(top_module=top),
        runner,
        _TIMEOUT_S,
        _DISK_LIMIT_BYTES,
    ),
}


def _expected_refusal_message(
    source_relpaths: list[str], top_module: str, job_kind: str
) -> str | None:
    """The standard refusal message for ``job_kind``, or ``None`` where nothing is refused.

    Re-derives ``_yosys_script_refusal``'s three checks, in its own precedence order, from the
    two rules design.md names: ``TOP_MODULE_RE`` and ``_SCRIPT_SAFE_RELPATH_RE``. ``job_kind``
    is the one caller-identifying word the Top_Module message carries.
    """
    if not source_relpaths:
        return "no Verilog source files to elaborate"
    if TOP_MODULE_RE.fullmatch(top_module) is None:
        return f"{job_kind} topModule is not a plain Verilog identifier"
    if any(eda._SCRIPT_SAFE_RELPATH_RE.fullmatch(path) is None for path in source_relpaths):
        return "a source path holds a character the Yosys script grammar would reinterpret"
    return None


@given(source_relpaths=_SOURCE_LISTS, top_module=_TOP_MODULES)
@example(source_relpaths=[_SAFE_FILE, _INJECTING_FILE], top_module=_MEASURED_TOP)
def test_property_7_refuses_before_any_tool_runs_on_an_unsafe_source_or_top(
    source_relpaths: list[str], top_module: str
) -> None:
    """Each routine issues no command exactly when the shared refusal rule says to refuse.

    The pinned example is the task's own constructed draw: a safe ``design.v`` alongside a
    second source carrying ``; write_verilog INJECTED.v``, which path confinement accepts but
    the script grammar must not - exercised through all three routines, not just one.

    Feature: hdl-creation-loop, Property 7: The worker refuses before any tool runs on an
    unsafe source or top. Validates Requirements 1.5, 3.1, 3.2, 3.5, 4.5.
    """
    for job_kind, routine in _ROUTINES.items():
        expected_message = _expected_refusal_message(source_relpaths, top_module, job_kind)
        with _tmp_workspace() as root:
            runner = _RecordingRunner()
            capture = routine(root, source_relpaths, top_module, runner)

            assert (runner.calls == []) == (expected_message is not None), job_kind
            if expected_message is not None:
                assert capture.exit_code != 0, job_kind
                assert capture.artifacts == {}, job_kind
                assert capture.stderr == expected_message, job_kind


def test_property_7_tag() -> None:
    """The property carries the exact canonical feature tag."""
    assert PROPERTY == (
        "Feature: hdl-creation-loop, Property 7: The worker refuses before any tool runs on "
        "an unsafe source or top"
    )
