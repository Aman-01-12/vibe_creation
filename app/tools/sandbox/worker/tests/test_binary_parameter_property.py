"""Property 7: a binary cell parameter is read by value, never by spelling (task 3.4).

The universal complement to the example checks in ``test_formal_prepass.py``, which pin one
representative spelling each (``"0"``, ``"00"``, the 32-character zero, ``"x"``, ``"0b0"``).
This suite asserts the same reader over 100+ drawn strings: ``_binary_parameter`` agrees with
binary integer interpretation at EVERY width, and refuses every other string - including the
three spellings plain ``int(v, 2)`` is lenient about - without coercing it to a bit.

THE DISTINCTION BETWEEN REFUSED AND READ-AS-ZERO IS ASSERTED EXPLICITLY, by identity against
``None`` and by inequality against the ``0`` a lenient reader would have returned. ``None`` and
``0`` are both falsy in Python, so a test written with ``assert not value`` would pass on the
defect this property exists to pin: reading an unwritable spelling as zero calls a clocked
memory read asynchronous, which is the false-``combinational`` direction (Requirement 1.12).

The indexed clause is asserted through ``_async_read_bits``, the reader's only per-bit
consumer, rather than through a bit reader respelled here - the same choice
``test_yosys_script_refusal_property.py`` makes in driving the three real dispatchers. There
the refusal is OBSERVABLE: an unreadable mask must leave the memory a refused shape, while a
mask of genuine zeros exposes its address and enable.

The tag below is spelled as a literal rather than through ``property_harness.property_tag``,
whose ``FEATURE`` is the hdl-creation-loop slug - that spec has its own, different Property 7.
"""

from __future__ import annotations

from typing import Any, Final

from hypothesis import example, given
from hypothesis import strategies as st

from tool_runner_worker import eda

#: Binary strings of ANY width, which is the point: ``write_json`` emits the same real value
#: narrow or 32 characters wide depending on which passes ran, so width carries no meaning.
_BINARY_STRINGS = st.text(alphabet="01", min_size=1, max_size=40)

#: The measured pair: ``CLK_POLARITY`` 1 is written ``"1"`` after plain ``prep`` and in the
#: 32-character form after ``opt_dff -sat``, in the SAME run.
_NARROW_ONE: Final = "1"
_WIDE_ONE: Final = "1".rjust(32, "0")

#: The three leniency shapes measured on plain ``int(v, 2)``: a ``0b`` prefix, ``_`` separators,
#: and surrounding whitespace. Built FROM a binary string so each stays a value ``int`` reads
#: happily - ``int("0b0", 2)`` is 0 and ``int("1_0", 2)`` is 2 - and so each is a value Yosys
#: cannot write and this reader must therefore refuse.
_PREFIXED = _BINARY_STRINGS.map(lambda digits: f"0b{digits}")
_SEPARATED = st.builds(lambda head, tail: f"{head}_{tail}", _BINARY_STRINGS, _BINARY_STRINGS)
_PADDED = st.builds(
    lambda lead, digits, trail: f"{lead}{digits}{trail}",
    st.sampled_from((" ", "\t", "\n", "")),
    _BINARY_STRINGS,
    st.sampled_from((" ", "\t", "\n", "")),
)

#: The rest of the string space: the empty value, don't-care and high-impedance, a sign and a
#: hex spelling ``int`` also accepts, the FULL-WIDTH one ``int`` reads as 1, and free text.
_OTHER_STRINGS = st.one_of(
    st.just(""),
    st.sampled_from(("x", "z", "xxxx", "0101x", "-1", "+1", "0x1", "\uff11", "true")),
    st.text(max_size=12),
)

#: Every drawn string this reader must refuse: not purely ``0``/``1``, or empty.
_UNREADABLE_STRINGS = st.one_of(_PREFIXED, _SEPARATED, _PADDED, _OTHER_STRINGS).filter(
    lambda value: not value or bool(set(value) - {"0", "1"})
)

#: What a LENIENT reader returns for a spelling it should have refused, and the whole point of
#: asserting refusal by identity: this value is falsy, so ``assert not value`` cannot tell the
#: two apart.
_READ_AS_ZERO: Final = 0

#: One address bit, one enable bit, and one data bit per read port, which makes an ``RD_DATA``
#: bit's position its read-port index and so puts each port on its own mask bit. Disjoint bases
#: so a slice landing on the wrong pin is visible in the assertion rather than coincidental.
_ADDRESS_BIT_BASE: Final = 100
_ENABLE_BIT_BASE: Final = 200
_DATA_BIT_BASE: Final = 300

_MAX_READ_PORTS: Final = 4


def _memory_cell(clock_enable: object, read_ports: int) -> dict[str, Any]:
    """A ``$mem_v2`` with ``read_ports`` single-bit read ports and this ``RD_CLK_ENABLE``.

    ``clock_enable`` is passed through UNTOUCHED, so a drawn spelling reaches the reader as the
    netlist would carry it. ``ABITS`` and ``WIDTH`` are spelled in binary, as ``write_json``
    writes them, since they go through the same reader.
    """
    ports = range(read_ports)
    return {
        "type": "$mem_v2",
        "parameters": {
            "ABITS": "1",
            "WIDTH": "1",
            "RD_PORTS": f"{read_ports:b}",
            "RD_CLK_ENABLE": clock_enable,
        },
        "port_directions": {
            "RD_ADDR": "input",
            "RD_CLK": "input",
            "RD_EN": "input",
            "RD_DATA": "output",
        },
        "connections": {
            "RD_ADDR": [_ADDRESS_BIT_BASE + port for port in ports],
            "RD_CLK": ["x"],
            "RD_EN": [_ENABLE_BIT_BASE + port for port in ports],
            "RD_DATA": [_DATA_BIT_BASE + port for port in ports],
        },
    }


@given(spelling=_BINARY_STRINGS)
@example(spelling=_NARROW_ONE)
@example(spelling=_WIDE_ONE)
@example(spelling="0")
def test_property_7_reads_any_width_of_binary_string_as_its_integer_value(spelling: str) -> None:
    """A string of ``0`` and ``1`` reads as ``int(s, 2)``, whatever width it was written at.

    The second assertion is the measured case: padding the same value out to 32 characters,
    which is what ``opt_dff -sat`` does to a parameter ``prep`` left narrow, changes nothing.
    A reader comparing against ``"1"`` fails it, and that failure flips a polarity silently.

    Feature: timing-contract-inference, Property 7: A binary cell parameter is read by value,
    never by spelling. **Validates: Requirements 1.12**
    """
    expected = int(spelling, 2)

    assert eda._binary_parameter(spelling) == expected
    assert eda._binary_parameter(spelling.rjust(32, "0")) == expected
    assert eda._polarity_bit(spelling) == (expected if expected in (0, 1) else None)


@given(spelling=_UNREADABLE_STRINGS)
@example(spelling="0b0")
@example(spelling="1_0")
@example(spelling=" 1 ")
@example(spelling="")
@example(spelling="x")
@example(spelling="z")
def test_property_7_refuses_a_spelling_it_cannot_read_rather_than_coercing_it_to_a_bit(
    spelling: str,
) -> None:
    """A string that is not purely ``0``/``1`` reads as NO VALUE, never as zero.

    Asserted by identity against ``None`` AND by inequality against ``0``, because those are
    the two answers that differ here while both being falsy: a spelling Yosys cannot write is
    not evidence of a zero, and a caller handed zero would call a clocked memory read
    asynchronous.

    Feature: timing-contract-inference, Property 7: A binary cell parameter is read by value,
    never by spelling. **Validates: Requirements 1.12**
    """
    value = eda._binary_parameter(spelling)
    polarity = eda._polarity_bit(spelling)

    assert value is None
    assert value != _READ_AS_ZERO
    assert polarity is None
    assert polarity != _READ_AS_ZERO


@given(
    mask=st.one_of(_BINARY_STRINGS, _UNREADABLE_STRINGS),
    read_ports=st.integers(min_value=1, max_value=_MAX_READ_PORTS),
)
@example(mask="10", read_ports=2)
@example(mask="0", read_ports=2)
@example(mask="0b0", read_ports=1)
def test_property_7_reads_the_clock_enable_mask_at_the_requested_bit_index(
    mask: str, read_ports: int
) -> None:
    """Read port ``p`` is clocked exactly when bit ``p`` of the mask's VALUE is set.

    Three claims through the reader's only indexed consumer, in one biconditional each:

    - a readable mask leaves the memory's shape readable and an unreadable one refuses it, so
      an unreadable mask never reaches the asynchronous branch a zero would have taken;
    - port ``p`` exposes its own address and enable exactly when bit ``p`` is clear, which for
      ``p`` past the mask's last character means the leading zero its value carries - the mask
      is a number, so the width it was written at cannot move a port's bit;
    - a bit that is not an ``RD_DATA`` bit has NO read port, and is refused rather than read at
      bit 0, which would clock every pin of the cell by the first port's rule.

    Feature: timing-contract-inference, Property 7: A binary cell parameter is read by value,
    never by spelling. **Validates: Requirements 1.12**
    """
    cell = _memory_cell(mask, read_ports)
    readable = eda._binary_parameter(mask) is not None

    assert eda._memory_shape_unreadable(cell) is not readable
    for port in range(read_ports):
        exposed = eda._async_read_bits(cell, _DATA_BIT_BASE + port)
        asynchronous = readable and not ((int(mask, 2) >> port) & 1)

        assert (exposed is not None) == asynchronous
        if asynchronous:
            assert exposed == [_ADDRESS_BIT_BASE + port, _ENABLE_BIT_BASE + port]
    assert eda._async_read_bits(cell, _ADDRESS_BIT_BASE) is None
