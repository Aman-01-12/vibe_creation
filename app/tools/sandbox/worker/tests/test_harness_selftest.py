"""Hypothesis harness self-test (task 1.3).

Proves the property harness actually executes a property so ``pytest`` runs a
real Hypothesis test rather than collecting nothing. Intentionally trivial: it
exercises the shared strategies and universally true properties, and covers no
product requirement. The real numbered properties land in their own tasks.
"""

from hypothesis import given
from hypothesis import strategies as st
from property_harness import (
    non_positive_port_widths,
    property_tag,
    unsafe_path_strings,
)

# Feature: hdl-creation-loop, Property 0: harness self-test
_SELF_TEST_TAG = property_tag(0, "harness self-test")


@given(st.lists(st.integers()))
def test_double_reverse_is_identity(values: list[int]) -> None:
    """Reversing a list twice yields the original list (harness liveness check)."""
    assert list(reversed(list(reversed(values)))) == values


@given(unsafe_path_strings())
def test_unsafe_path_strings_are_non_empty(path: str) -> None:
    """The shared unsafe-path strategy always yields a non-empty string."""
    assert path


@given(non_positive_port_widths())
def test_non_positive_port_widths_are_not_positive(width: int) -> None:
    """The shared non-positive width strategy never yields a positive width."""
    assert width <= 0


def test_property_tag_format() -> None:
    """The tag helper renders the shared convention exactly."""
    assert _SELF_TEST_TAG == "Feature: hdl-creation-loop, Property 0: harness self-test"


def test_profile_executes_at_the_100_plus_example_default() -> None:
    """Prove the loaded profile actually drives >= 100 examples per property.

    ``conftest`` registers and loads the ``hdl-creation-loop`` profile at import
    time, so a bare ``@given`` inherits its ``max_examples``. A passing property
    draws exactly that many inputs (it stops early only on failure, which would
    shrink and raise), so counting the invocations of an always-passing property
    shows the >= 100 default is wired through, not merely registered.
    """
    invocations = 0

    @given(st.integers())
    def _always_true(_value: int) -> None:
        nonlocal invocations
        invocations += 1

    _always_true()

    assert invocations >= 100
