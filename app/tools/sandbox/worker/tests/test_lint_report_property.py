"""Property 8: the worker's lint report states exactly what the check log says (task 2.4).

The universal complement to the example checks in ``test_lint.py``. Those examples pin one
representative of each log shape (clean, findings, absent, oversized, the "last line wins"
case); this suite asserts the same reading rule holds *for any* log content, over 100+ inputs,
by exercising ``eda._lint_report`` directly against a workspace root on disk.

The guarantee (Design: Property 8; Req 1.2, 4.1, 4.3) has three testable halves, one per
property below:

  1. A problem count rendered into the one line the Lint_Engine writes on success parses back
     out exactly, for any count the engine could report.
  2. Only the LAST ``Found and reported (\\d+) problems.`` line in the log decides the count,
     whatever earlier matching lines or unrelated noise surrounds it.
  3. The size bound at :data:`eda.MAX_LINT_LOG_BYTES` is exact: a log at the bound is read
     normally, a log one byte over is refused outright, and an absent log is refused the same
     way, regardless of what either would otherwise have said.
"""

from __future__ import annotations

import contextlib
import string
import tempfile
from collections.abc import Iterator
from pathlib import Path

from hypothesis import example, given
from hypothesis import strategies as st
from property_harness import property_tag

from tool_runner_worker import eda

#: The canonical tag for this property, asserted verbatim by ``test_property_8_tag``.
PROPERTY = property_tag(8, "The worker's lint report states exactly what the check log says")

#: The log filename this suite pins, spelled as a literal rather than imported, following
#: ``test_lint.py``'s own discipline.
_LOG_FILE = "lint-check.log"

#: Problem counts the Lint_Engine could plausibly report, per the task's own draw.
_PROBLEM_COUNTS = st.integers(min_value=0, max_value=100_000)

#: Unrelated log chatter that must never be mistaken for the count line: free of newlines (so
#: it never silently grows into a second line) and filtered so no draw can coincidentally spell
#: out the phrase the regex looks for.
_NOISE_LINE = st.text(
    alphabet=string.ascii_letters + string.digits + " .:_-",
    max_size=40,
).filter(lambda line: "Found and reported" not in line)

_NOISE_LINES = st.lists(_NOISE_LINE, max_size=3)


def _match_line(count: int) -> str:
    """The exact line ``check -assert`` writes for ``count`` problems."""
    return f"Found and reported {count} problems."


def _write_log(workspace_root: Path, text: str) -> None:
    (workspace_root / _LOG_FILE).write_text(text, encoding="utf-8")


def _padded_log_text(count: int, total_bytes: int) -> str:
    """A log of exactly ``total_bytes`` bytes ending in ``count``'s match line.

    Filler is ASCII ``x`` so one character always costs one byte, keeping the written file's
    size exactly ``total_bytes`` and the byte-bound test honest about what it is measuring.
    """
    line = _match_line(count) + "\n"
    filler_len = total_bytes - len(line.encode("utf-8"))
    assert filler_len >= 0, "total_bytes too small to hold the match line"
    return ("x" * filler_len) + line


@given(count=_PROBLEM_COUNTS)
def test_property_8_a_clean_single_line_log_parses_the_count_exactly(count: int) -> None:
    """Any count the engine writes as its sole line reads back as that exact count.

    Feature: hdl-creation-loop, Property 8: The worker's lint report states exactly what the
    check log says. Validates Requirements 1.2, 4.1, 4.3.
    """
    with _tmp_workspace() as workspace_root:
        _write_log(workspace_root, _match_line(count) + "\n")

        assert eda._lint_report(workspace_root) == {"reachedCheck": True, "problemCount": count}


@given(
    prefix_noise=_NOISE_LINES,
    earlier_counts=st.lists(_PROBLEM_COUNTS, max_size=3),
    middle_noise=_NOISE_LINES,
    final_count=_PROBLEM_COUNTS,
    suffix_noise=_NOISE_LINES,
)
@example(prefix_noise=[], earlier_counts=[5], middle_noise=[], final_count=2, suffix_noise=[])
def test_property_8_only_the_last_matching_line_decides_the_count(
    prefix_noise: list[str],
    earlier_counts: list[int],
    middle_noise: list[str],
    final_count: int,
    suffix_noise: list[str],
) -> None:
    """The LAST matching line wins, whatever earlier matches or noise surrounds it.

    The pinned example is the task's own constructed draw: a 5-problem line followed by a
    2-problem line must report 2, not 5.

    Feature: hdl-creation-loop, Property 8: The worker's lint report states exactly what the
    check log says. Validates Requirements 1.2, 4.1, 4.3.
    """
    lines = [
        *prefix_noise,
        *(_match_line(count) for count in earlier_counts),
        *middle_noise,
        _match_line(final_count),
        *suffix_noise,
    ]
    with _tmp_workspace() as workspace_root:
        _write_log(workspace_root, "\n".join(lines) + "\n")

        assert eda._lint_report(workspace_root) == {
            "reachedCheck": True,
            "problemCount": final_count,
        }


@given(count=_PROBLEM_COUNTS)
def test_property_8_the_byte_bound_is_exact(count: int) -> None:
    """A log at the bound is read; one byte over, it is refused outright.

    Feature: hdl-creation-loop, Property 8: The worker's lint report states exactly what the
    check log says. Validates Requirements 1.2, 4.1, 4.3.
    """
    at_bound = _padded_log_text(count, eda.MAX_LINT_LOG_BYTES)
    over_bound = _padded_log_text(count, eda.MAX_LINT_LOG_BYTES + 1)

    with _tmp_workspace() as workspace_root:
        _write_log(workspace_root, at_bound)
        assert (workspace_root / _LOG_FILE).stat().st_size == eda.MAX_LINT_LOG_BYTES
        assert eda._lint_report(workspace_root) == {"reachedCheck": True, "problemCount": count}

    with _tmp_workspace() as workspace_root:
        _write_log(workspace_root, over_bound)
        assert (workspace_root / _LOG_FILE).stat().st_size == eda.MAX_LINT_LOG_BYTES + 1
        assert eda._lint_report(workspace_root) == {"reachedCheck": False, "problemCount": None}


def test_property_8_an_absent_log_is_refused(tmp_path: Path) -> None:
    """No log file at all reports the same refusal an oversized or unmatched log would.

    Feature: hdl-creation-loop, Property 8: The worker's lint report states exactly what the
    check log says. Validates Requirements 1.2, 4.1, 4.3.
    """
    assert not (tmp_path / _LOG_FILE).exists()

    assert eda._lint_report(tmp_path) == {"reachedCheck": False, "problemCount": None}


def test_property_8_tag() -> None:
    """The property carries the exact canonical feature tag."""
    assert PROPERTY == (
        "Feature: hdl-creation-loop, Property 8: The worker's lint report states exactly "
        "what the check log says"
    )


@contextlib.contextmanager
def _tmp_workspace() -> Iterator[Path]:
    """A fresh workspace root for one Hypothesis example.

    pytest's ``tmp_path`` fixture is resolved once per test *invocation*, not once per
    Hypothesis *example*, so reusing it across examples of the same ``@given`` test would let
    one example's log leak into the next. A fresh ``TemporaryDirectory`` per example keeps every
    draw isolated, matching the discipline ``test_path_confinement_property.py`` already uses
    for the same reason.
    """
    with tempfile.TemporaryDirectory() as workspace:
        yield Path(workspace)
