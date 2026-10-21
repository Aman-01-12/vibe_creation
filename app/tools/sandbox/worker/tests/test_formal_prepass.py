"""Tests for the Reset_Contract_Prepass script, its cell walk, and its report (task 16.4).

Covers the worker half of Component 14: the ONE Yosys script the pre-pass emits, the
passes it must carry and the ones it must not, the flip-flop cell walk that reads
``ARST_POLARITY``, ``SRST_POLARITY``, and ``CLK_POLARITY`` off the elaborated netlist, the
top-level-input-port filter the RESET entries pass through and the CLOCK vote does NOT, the
``int(v, 2)`` parse that makes an emitted width irrelevant, the payload values it refuses to
put on a command line, and the report it registers as a REQUIRED output.

WHY THE CELL-LEVEL CLAUSES OF PROPERTY 34 LIVE HERE AND NOWHERE ELSE
    Task 16.3 established that three of Property 34's clauses - the cell walk, the reset port
    filter, and the ``int(v, 2)`` parse - CANNOT be property-tested in TypeScript, because
    there is no TypeScript cell walk and there must not be one: a second walk would make
    ``app/tools/formal/prepass.ts`` a SECOND DECIDER of the derived polarity, which is
    precisely what Requirements 14.24 and 14.38 forbid. So the netlist is held on this side
    only, and this file is the only place those clauses can be covered at all. They are
    covered here in full rather than sampled:

      - the WALK: every flop cell votes, and a cell carrying a polarity parameter that is not
        a RESET one (``$aldff``'s ``ALOAD_POLARITY``, ``$dlatch``'s ``EN_POLARITY``) votes on
        nothing;
      - the RESET PORT FILTER: over a fixture shaped like ``radix2_div``'s ELEVEN ``SRST``
        cells with FOUR on internal nets, where the unfiltered rule refuses and the filtered
        one derives;
      - the ``int(v, 2)`` PARSE: asserted so that a string comparison against ``"1"`` FAILS,
        by feeding the 32-character form and the one-character form of the SAME value and
        requiring the SAME answer;
      - the CLOCK vote's ASYMMETRY: it is NOT port-filtered, so a design clocked from an
        internal net still answers the Clock_Contract question rather than reading as
        ``none``;
      - the DERIVATION RULE itself: one net plus one polarity derives, and several nets,
        several polarities, none at all, and an unreadable polarity each refuse.

WHAT IS PINNED AS A LITERAL AND WHAT IS READ FROM THE MODULE
    Every wire value - the script's passes, the artifact key, the three filenames, the report's
    field names - is spelled out here as an independent copy, following
    ``test_formal_lowering.py``: a pin written in terms of the constant it is pinning asserts
    only that the constant equals itself. The two exceptions are the two Yosys SCRIPT constants
    themselves, which are read from ``eda`` in the ONE test that asserts the
    ``opt_dff -sat`` pin from BOTH sides at once - there the claim is about the relationship
    between two constants, so both have to be named.

THE TOOLCHAIN IS STUBBED
    A fake :class:`CommandRunner` following ``test_formal_lowering.py``'s
    ``_RecordingYosysRunner`` - same protocol, same :class:`CompletedCommand` construction,
    same "the fake enforces neither bound" note - so these run with no Yosys installed. It is
    a separate fake because it has to WRITE the two files the pre-pass reads back, and because
    the netlist it writes is the fixture each test varies.

    Two MEASURED Yosys behaviours are modelled deliberately, and the fake's own fidelity check
    below pins both, because without them the injection test would pass for the wrong reason:
    the ``-p`` argument is a semicolon-separated command list Yosys splits ITSELF, so a
    ``write_verilog <file>`` anywhere inside it writes that file; and ``read_verilog`` aborts
    the whole script when a file it names does not resolve, which is why the injection needs a
    SECOND, legitimately-named file.

WHY A REFUSAL IS ASSERTED AS ZERO INVOCATIONS AND NOT AS A NON-ZERO EXIT
    A failed Yosys run also exits non-zero with no artifact, so the exit code alone cannot tell
    a refusal from a failure. "Refused before any command is built" is a claim about the runner
    having been handed nothing, so that is what is asserted.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final

import pytest

from tool_runner_worker import eda
from tool_runner_worker.commands import (
    COMMAND_NOT_FOUND_EXIT,
    CommandRunner,
    CompletedCommand,
)
from tool_runner_worker.contract import (
    FormalPrepassRequest,
    ResourceLimits,
    SandboxJob,
    SourceFile,
)
from tool_runner_worker.eda import formal_prepass
from tool_runner_worker.worker import run_job

#: The wire names this suite pins, spelled as literals rather than imported.
_REPORT_FILE = "formal-prepass-report.json"
_NETLIST_FILE = "prepass-netlist.json"
_PREPASS_SMT2_FILE = "prepass-design.smt2"
_DESIGN_FILE = "design.v"
_INJECTED_FILE = "INJECTED.v"

#: The artifact key the seam's ``RequiredOutput`` names. A CHANNEL rather than a label: the
#: TypeScript adapter reads the pre-pass report through exactly this key.
_REPORT_KEY = "formalPrepassReport"

#: The ``formal`` job's own SMT2 filename, which the pre-pass's ``write_smt2`` must NEVER
#: target. Named here because the separation is the pin, not a coincidence of spelling: a
#: pre-pass and a formal job sharing a workspace must not be able to overwrite each other's
#: file and have a proof taken over the wrong one.
_FORMAL_SMT2_FILE = "out.smt2"

#: A source path crafted to close the Yosys ``-p`` script's ``read_verilog`` command early and
#: start a second one. Measured against Yosys 0.66 in this workspace; see
#: ``chipAgent/_inbox/gotcha-yosys-p-script-is-an-injection-channel-for-source-filenames.md``.
_INJECTING_FILE = f"{_DESIGN_FILE}; write_verilog {_INJECTED_FILE}"

#: THE COMPLETE PRE-PASS SEQUENCE Requirement 14.12 pins, in the order it must run.
#:
#: ``opt_dff -sat`` sits between the elaboration and the ``write_json`` because that ORDER is
#: the whole point: it is what recovers a synchronous reset as a readable flop cell, and it has
#: to have run before the netlist the cell walk reads is written out.
#:
#: The frontend call is ``read_verilog -sv`` and NOT ``-sv -formal``, which is the one
#: difference from the Lowering_Sequence's and is deliberate: admitting the candidate design's
#: own SVA would add ``$check`` cells ``write_smt2`` cannot translate, aborting the write and
#: losing the initial-state predicate.
_PREPASS_SEQUENCE = (
    "read_verilog -sv",
    "prep -top",
    "opt_dff -sat",
    f"write_json {_NETLIST_FILE}",
    f"write_smt2 {_PREPASS_SMT2_FILE}",
)

#: The pass Requirement 14.13 places HERE and forbids the Lowering_Sequence from holding.
_REQUIRED_PREPASS_PASS = "opt_dff -sat"

#: Passes that belong to the Lowering_Sequence and would change WHAT THE PROOF IS TAKEN OVER.
#:
#: ``async2sync`` and ``dffunmap`` are deliberately NOT in this list, and that absence is the
#: interesting part. They ARE in the pre-pass script, on a measurement rather than a
#: preference: without them the ``write_smt2`` aborts outright - ``ERROR: Unsupported cell type
#: $adff ... please run `async2sync; dffunmap` ...`` - so the initial-state predicate would be
#: unreadable for every reset-bearing design, which is 33 of the 33 clocked references. They
#: change nothing this pre-pass derives, because they run AFTER the ``write_json`` and this
#: SMT2 is never proved over.
_FORBIDDEN_PREPASS_PASSES = ("chformal -lower", "memory_map -rom-only -keepdc", "-formal")

#: The bounds every invocation in this suite is given. Carried, not enforced, by the fake.
_TIMEOUT_S = 5.0
_DISK_LIMIT_BYTES = 64 * 1024 * 1024

_TOP = "counter_12"

#: The two spellings of the SAME polarity value ``1`` that ``write_json`` has been MEASURED to
#: emit, in the same pass sequence, on two designs whose real polarity is identical.
#:
#: THIS PAIR IS THE WHOLE POINT OF THE PARSE TEST. ``ARST_POLARITY`` 1 prints as ``"1"`` after
#: plain ``prep`` and as the 32-character form after ``opt_dff -sat``, and ``CLK_POLARITY`` 1
#: printed as ``"1"`` on an ``$adff`` design and as 32 characters on an ``$sdffe`` one IN THE
#: SAME RUN. A test using only ``"1"`` cannot catch a string comparison against ``"1"``; a test
#: using BOTH and requiring the same answer cannot miss it.
_ONE_NARROW = "1"
_ONE_WIDE = "00000000000000000000000000000001"
_ZERO_NARROW = "0"
_ZERO_WIDE = "00000000000000000000000000000000"

#: A free initial-state predicate, as ``write_smt2`` emits it for a design with no ``initial``.
_FREE_PREDICATE_SMT2 = f"(define-fun |{_TOP}_i| ((state |{_TOP}_s|)) Bool true) ; out\n"


def _captured(exit_code: int, stdout: str = "", stderr: str = "") -> CompletedCommand:
    """Build a fake capture. Every bound flag is False: this fake enforces none.

    The wall clock is enforced by the runtime that spawned the worker and the workspace cap by
    the real runner's pump loop; both are asserted against the REAL runner in
    ``test_command_capture_bounds.py``.
    """
    return CompletedCommand(
        exit_code,
        stdout,
        stderr,
        stdout_truncated=False,
        stderr_truncated=False,
        disk_limit_exceeded=False,
    )


# ---------------------------------------------------------------------------
# Netlist fixtures: the elaborated design as `write_json` writes it
# ---------------------------------------------------------------------------
#
# Net BITS are integers in `write_json`, and a port owns a list of them. The fixtures below
# keep the numbering explicit rather than generated, because which bit belongs to which port is
# exactly what the reset port filter turns on: an entry whose net bit belongs to no INPUT port
# is dropped, and the whole `radix2_div` case is that drop happening eleven times over.

_CLK_BIT = 2
_RST_BIT = 3
_SECOND_RST_BIT = 4
_OUTPUT_BIT = 5
_EN_BIT = 6
_SECOND_EN_BIT = 7
#: Bits belonging to no port at all - the internal nets `opt_dff -sat` invents, measured on
#: `radix2_div` as `$auto$opt_dff.cc:275:combine_resets$116` and `$and$radix2_div.v:58$21_Y`.
_INTERNAL_BITS = (90, 91, 92, 93)


def _ports(**directions: str) -> dict[str, Any]:
    """Top-level ports, one bit each, keyed by name. ``directions`` maps name to direction."""
    bits = {
        "clk": _CLK_BIT,
        "rst": _RST_BIT,
        "rst2": _SECOND_RST_BIT,
        "out": _OUTPUT_BIT,
        "en": _EN_BIT,
        "en2": _SECOND_EN_BIT,
    }
    return {
        name: {"direction": direction, "bits": [bits[name]]}
        for name, direction in directions.items()
    }


def _ff_cell(  # noqa: PLR0913 - nine knobs, one per netlist fact a test needs to vary
    cell_type: str,
    *,
    clk_polarity: str | None = _ONE_WIDE,
    clk_bit: int = _CLK_BIT,
    reset_parameter: str | None = None,
    reset_polarity: str = _ONE_WIDE,
    reset_bit: int = _RST_BIT,
    enable_polarity: str | None = None,
    enable_bit: int = _EN_BIT,
    extra_parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One flip-flop cell as ``write_json`` writes it: a type, parameters, and connections.

    ``clk_polarity=None`` makes the cell CLOCKLESS, which is how a design with no clocked state
    is modelled - such a cell casts no clock vote, so the finding is ``none`` rather than a
    refusal (Requirement 14.34, 15 of 50 references).

    ``reset_parameter`` is the parameter NAME, so a test can attach ``ALOAD_POLARITY`` or
    ``EN_POLARITY`` and assert it votes on nothing: the rule is driven by the parameter name and
    not by a cell-type whitelist.

    ``enable_polarity=None`` leaves the cell with NO enable at all, which is the ``$dff``,
    ``$adff``, and ``$sdff`` shape. Setting it attaches both ``EN_POLARITY`` and the ``EN``
    connection, because a flop variant carrying one carries the other.
    """
    parameters: dict[str, Any] = dict(extra_parameters or {})
    connections: dict[str, Any] = {}
    if clk_polarity is not None:
        parameters["CLK_POLARITY"] = clk_polarity
        connections["CLK"] = [clk_bit]
    if reset_parameter is not None:
        parameters[reset_parameter] = reset_polarity
        connections[reset_parameter.removesuffix("_POLARITY")] = [reset_bit]
    if enable_polarity is not None:
        parameters["EN_POLARITY"] = enable_polarity
        connections["EN"] = [enable_bit]
    return {"type": cell_type, "parameters": parameters, "connections": connections}


def _netlist(cells: dict[str, Any], ports: dict[str, Any] | None = None) -> dict[str, Any]:
    """A ``write_json`` document carrying one elaborated module named :data:`_TOP`."""
    if ports is None:
        ports = _ports(clk="input", rst="input", out="output")
    return {"modules": {_TOP: {"ports": ports, "cells": cells}}}


def _async_reset_netlist(polarity: str) -> dict[str, Any]:
    """One ``$adff`` on the top-level input ``rst``: the derivable async shape."""
    return _netlist(
        {"ff": _ff_cell("$adff", reset_parameter="ARST_POLARITY", reset_polarity=polarity)}
    )


def _radix2_div_netlist() -> dict[str, Any]:
    """ELEVEN ``SRST`` cells, FOUR of them on internal nets: ``radix2_div``'s measured shape.

    The four internal-net cells are what the port filter drops. WITHOUT the filter the retained
    set names FIVE distinct nets, ``len(nets) != 1`` holds, and the design is REFUSED outright -
    so this fixture separates the filtered implementation from the unfiltered one rather than
    merely exercising the filtered one.
    """
    cells = {
        f"srst_port_{index}": _ff_cell(
            "$sdffe", reset_parameter="SRST_POLARITY", reset_polarity=_ONE_WIDE
        )
        for index in range(7)
    }
    for index, bit in enumerate(_INTERNAL_BITS):
        cells[f"srst_internal_{index}"] = _ff_cell(
            "$sdffe",
            reset_parameter="SRST_POLARITY",
            reset_polarity=_ONE_WIDE,
            reset_bit=bit,
        )
    return _netlist(cells)


#: The ports an enable-gated design presents: the reset AND the enable are both top-level inputs.
_ENABLE_GATED_PORTS = _ports(clk="input", rst="input", en="input", out="output")


def _lifobuffer_netlist(enable_polarity: str = _ONE_WIDE) -> dict[str, Any]:
    """SEVEN ``$sdffce`` cells on ``rst``, FIVE of whose enables are INTERNAL nets.

    ``LIFObuffer``'s measured shape, read off the real netlist by task 4.25 of
    ``formal-gate-first-light``: all 7 reset-carrying cells are ``$sdffce`` with a non-constant
    enable, five resolving to ``$auto$simple.cc:210:make_patterns_logic$...`` nets and two
    directly to the top-level input. The real design spells those two ports ``Rst`` and ``EN``;
    this fixture uses the suite's own ``rst`` and ``en``, because the shape is what derives and
    the names are not read by any rule.

    The five internal ones are what the enable's port filter drops, so this fixture separates a
    filtered enable vote from an unfiltered one: WITHOUT the filter the retained set names six
    distinct enables and no single one could be reported.
    """
    cells = {
        f"ff_internal_{index}": _ff_cell(
            "$sdffce",
            reset_parameter="SRST_POLARITY",
            enable_polarity=enable_polarity,
            enable_bit=bit,
        )
        for index, bit in enumerate((*_INTERNAL_BITS, _INTERNAL_BITS[0]))
    }
    for index in range(2):
        cells[f"ff_en_{index}"] = _ff_cell(
            "$sdffce", reset_parameter="SRST_POLARITY", enable_polarity=enable_polarity
        )
    return _netlist(cells, _ENABLE_GATED_PORTS)


# ---------------------------------------------------------------------------
# Hand-written `$mem_v2` fixtures: the shapes the corpus does NOT contain
# ---------------------------------------------------------------------------
#
# MEASURED, by elaborating every `verified_*.v` in `.eval-corpus/rtllm` and reading each
# `$mem_v2`'s parameters: the corpus holds exactly TWO memory cells, `ROM`'s `\mem` and
# `asyn_fifo`'s `\dual_port_RAM.RAM_MEM`, and BOTH are `RD_PORTS=1` with `RD_CLK_ENABLE='0'`.
# So the corpus witnesses the asynchronous single-port direction only - the committed `ROM`
# fixture is that witness - and there is NO corpus netlist for a clocked read port or for a
# second read port.
#
# These fixtures cover those two shapes, and they are HAND-WRITTEN rather than measured: they
# pin the rule's two remaining branches and they are NOT evidence about any real design. The
# parameter spellings below are copied from the real `ROM` cell so the shape stays faithful.

#: One address bit per read port, one enable bit per read port, and `_MEM_WIDTH` data bits per
#: read port - the per-port concatenation layout a `$mem_v2` pin actually carries. Kept clear of
#: the flop fixtures' bits 2..7 so a netlist carrying both is unambiguous.
_MEM_WIDTH = 2
_MEM_ADDR_BITS = (20, 21)
_MEM_EN_BITS = (22, 23)
_MEM_DATA_BITS = ((30, 31), (32, 33))

#: ``ABITS`` and ``WIDTH`` as ``write_json`` spells them: one address bit per port, two data
#: bits per port. Narrow spellings on purpose, since the reader must not care about width.
_MEM_PARAMETERS: Final[dict[str, Any]] = {"ABITS": "1", "WIDTH": "10"}


def _memory_netlist(clock_enable: Any, read_ports: int = 1) -> dict[str, Any]:
    """A ``$mem_v2`` driving ONE declared output port per read port.

    ``clock_enable`` is the raw ``RD_CLK_ENABLE`` value, passed through UNTOUCHED so a test can
    hand it any spelling or an unreadable value. Read port ``p`` reads top-level input
    ``addr{p}``, is qualified by ``en{p}``, and drives declared output ``dout{p}``, so a rule
    that indexed the wrong port's clock-enable bit, or traversed another port's address, shows
    up as the wrong port name in the wrong ``sources`` list.
    """
    ports: dict[str, Any] = {}
    connections: dict[str, Any] = {"RD_ADDR": [], "RD_EN": [], "RD_DATA": [], "RD_CLK": ["x"]}
    for port in range(read_ports):
        ports[f"addr{port}"] = {"direction": "input", "bits": [_MEM_ADDR_BITS[port]]}
        ports[f"en{port}"] = {"direction": "input", "bits": [_MEM_EN_BITS[port]]}
        ports[f"dout{port}"] = {"direction": "output", "bits": list(_MEM_DATA_BITS[port])}
        connections["RD_ADDR"].append(_MEM_ADDR_BITS[port])
        connections["RD_EN"].append(_MEM_EN_BITS[port])
        connections["RD_DATA"].extend(_MEM_DATA_BITS[port])
    cell = {
        "type": "$mem_v2",
        "parameters": {
            **_MEM_PARAMETERS,
            "RD_PORTS": f"{read_ports:b}",
            "RD_CLK_ENABLE": clock_enable,
        },
        "port_directions": {
            "RD_ADDR": "input",
            "RD_CLK": "input",
            "RD_EN": "input",
            "RD_DATA": "output",
        },
        "connections": connections,
    }
    return {"modules": {_TOP: {"ports": ports, "cells": {"mem": cell}}}}


def _memory_timing_ports(tmp_path: Path, netlist: dict[str, Any]) -> list[dict[str, Any]]:
    """The ``timing.ports`` list derived over one hand-written memory netlist."""
    report = _derive(tmp_path, netlist, top_module=_TOP)
    timing: dict[str, Any] = report["timing"]
    assert timing["derived"] is True
    ports: list[dict[str, Any]] = timing["ports"]
    return ports


#: Where the COMMITTED reference netlists live.
_FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"

#: The two measured cone anchors. ``adder_8bit`` is purely combinational and hierarchical, so
#: it also exercises ``prep -flatten``'s eight ``$scopeinfo`` cells; ``traffic_light`` is the
#: registered anchor, and its ``clock`` port is the one that reaches a flop through a BARE
#: ALIAS (``assign clock = cnt``) rather than through a cell.
_ADDER_8BIT = "adder_8bit"
_TRAFFIC_LIGHT = "traffic_light"

#: The measured ASYNCHRONOUS-READ MEMORY anchor: ``always @(*) dout = mem[addr]``, which Yosys
#: models as a ``$mem_v2`` whose ``RD_CLK_ENABLE`` is ``'0'``. Its module is named ``ROM``
#: rather than ``verified_ROM`` - the ``verified_`` prefix is on the FILENAME only - which is
#: why :func:`_timing_ports` takes the top module rather than deriving it from the design name.
_ROM = "ROM"


def _reference_netlist(design: str) -> dict[str, Any]:
    """The committed ``write_json`` document for one reference design.

    REAL YOSYS OUTPUT, produced by running the pre-pass's own script over the reference RTL in
    ``.eval-corpus/rtllm`` and committed verbatim, so the cone claims below are made against
    the shape Yosys actually writes while the suite still runs with no Yosys installed.

    Committed UNEDITED and never hand-trimmed: a fixture narrowed by hand stops reproducing
    the measured shape, and a claim made over it is a claim about the fixture - see
    ``chipAgent/_inbox/gotcha-a-mutation-probe-over-an-unfaithful-fixture-over-reports-its-own-catch-count.md``.
    """
    with (_FIXTURE_DIR / f"prepass-netlist-{design}.json").open(encoding="utf-8") as handle:
        loaded: dict[str, Any] = json.load(handle)
    return loaded


def _timing_ports(
    tmp_path: Path, design: str, top_module: str | None = None
) -> list[dict[str, Any]]:
    """The ``timing.ports`` list the pre-pass derives over one committed reference netlist.

    ``top_module`` defaults to the ``verified_`` prefix most rtllm references carry in both the
    filename and the module name, and is passed explicitly where a reference carries it on the
    filename only.
    """
    report = _derive(
        tmp_path, _reference_netlist(design), top_module=top_module or f"verified_{design}"
    )
    timing: dict[str, Any] = report["timing"]
    assert timing["derived"] is True
    ports: list[dict[str, Any]] = timing["ports"]
    return ports


def _timing_finding(
    tmp_path: Path, netlist: dict[str, Any], top_module: str = _TOP
) -> dict[str, Any]:
    """The WHOLE ``timing`` object the pre-pass derives, both arms included.

    Distinct from :func:`_timing_ports` and :func:`_memory_timing_ports`, which assert
    ``derived`` is true and hand back the ports: a refusal has no ports list to hand back, and
    a test about a refusal must see the object itself to assert what it does NOT carry.
    """
    finding: dict[str, Any] = _derive(tmp_path, netlist, top_module=top_module)["timing"]
    return finding


class _RecordingPrepassRunner(CommandRunner):
    """A fake Yosys that records every argv and writes the two files the pre-pass reads back.

    ``netlist`` is the ``write_json`` document this run produces, or ``None`` to write no
    netlist at all - the measured shape of a design that did not elaborate, and the one that
    must produce NO report rather than an empty derivation.

    ``smt2`` is the text the ``write_smt2`` produces, defaulting to the free predicate. It is
    written only where the script actually carries a ``write_smt2``, so a script that dropped
    the pass leaves no predicate behind and the report says so - which is what makes the
    "``write_smt2`` must be present" pin bite rather than being satisfied by a fake that writes
    the file unconditionally.
    """

    def __init__(
        self,
        *,
        netlist: dict[str, Any] | None = None,
        smt2: str | None = _FREE_PREDICATE_SMT2,
    ) -> None:
        self.calls: list[list[str]] = []
        self._netlist = netlist if netlist is not None else _async_reset_netlist(_ZERO_WIDE)
        self._smt2 = smt2

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        _ = (timeout_s, disk_limit_bytes)
        self.calls.append(list(argv))
        if argv[0] != "yosys":
            return _captured(COMMAND_NOT_FOUND_EXIT, stderr=f"unknown tool: {argv[0]}")
        return self._yosys(argv, cwd)

    def _yosys(self, argv: list[str], cwd: Path) -> CompletedCommand:
        commands = [command.split() for command in argv[argv.index("-p") + 1].split(";")]
        read = next((words for words in commands if words and words[0] == "read_verilog"), [])
        named = [word for word in read[1:] if not word.startswith("-")]
        missing = [name for name in named if not (cwd / name).is_file()]
        if missing:
            return _captured(1, stderr=f"ERROR: File '{missing[0]}' not found")
        for words in commands:
            if words and words[0] == "write_verilog":
                (cwd / words[1]).write_text("injected", encoding="utf-8")
            elif words and words[0] == "write_json" and self._netlist is not None:
                (cwd / words[1]).write_text(json.dumps(self._netlist), encoding="utf-8")
            elif words and words[0] == "write_smt2" and self._smt2 is not None:
                (cwd / words[1]).write_text(self._smt2, encoding="utf-8")
        return _captured(0)


class _AbsentNetlistRunner(_RecordingPrepassRunner):
    """A Yosys run that exits 0 and writes no netlist: the design did not elaborate."""

    def __init__(self) -> None:
        super().__init__()
        self._netlist = None


def _write_design(workspace_root: Path, *names: str) -> list[str]:
    """Write a trivial module under each name and return the names as relpaths."""
    for name in names:
        (workspace_root / name).write_text("module top; endmodule", encoding="utf-8")
    return list(names)


def _run_prepass(
    workspace_root: Path,
    runner: CommandRunner,
    source_relpaths: list[str],
    top_module: str = _TOP,
) -> eda.EdaCapture:
    """Drive ``eda.formal_prepass`` with this suite's fixed bounds."""
    return formal_prepass(
        workspace_root,
        source_relpaths,
        FormalPrepassRequest(top_module=top_module),
        runner,
        _TIMEOUT_S,
        _DISK_LIMIT_BYTES,
    )


def _report(workspace_root: Path) -> dict[str, Any]:
    """The written pre-pass report, parsed."""
    with (workspace_root / _REPORT_FILE).open(encoding="utf-8") as handle:
        loaded: dict[str, Any] = json.load(handle)
    return loaded


def _derive(
    tmp_path: Path,
    netlist: dict[str, Any] | None,
    *,
    top_module: str = _TOP,
    **kwargs: Any,
) -> dict[str, Any]:
    """Run the pre-pass over ``netlist`` and return the report it wrote.

    The whole path is exercised each time - script assembly, the fake Yosys, the netlist read,
    the cell walk, the derivation, and the report write - rather than the derivation being
    called directly, because the claim in every cell-level test is about what the PRE-PASS
    derives and the walk is only reachable through it.

    ``top_module`` is the ``-top`` the job names, which the module lookup goes through. The
    hand-written fixtures above all name :data:`_TOP`; a COMMITTED reference netlist carries
    the real design's own module name, so it has to be passed through rather than renamed in
    the fixture.
    """
    tmp_path.mkdir(parents=True, exist_ok=True)
    runner = _RecordingPrepassRunner(netlist=netlist, **kwargs)
    sources = _write_design(tmp_path, _DESIGN_FILE)
    _run_prepass(tmp_path, runner, sources, top_module=top_module)
    return _report(tmp_path)


def _script_of(runner: _RecordingPrepassRunner) -> str:
    """The one ``-p`` script the pre-pass emitted, asserting it emitted exactly one command."""
    assert [call[0] for call in runner.calls] == ["yosys"]
    lowering = runner.calls[0]
    assert lowering[:2] == ["yosys", "-p"]
    return lowering[2]


# ---------------------------------------------------------------------------
# The script: its passes, their order, and what must NOT be in it
# ---------------------------------------------------------------------------


def test_the_prepass_emits_its_whole_sequence_in_order(tmp_path: Path) -> None:
    """Requirement 14.12: the emitted script carries the complete sequence, in order.

    ORDER IS THE CLAIM, not presence. ``opt_dff -sat`` after the ``write_json`` would be a
    script that still contains every pass and derives nothing: the cell walk reads the netlist
    that was already written, so the pass that recovers a synchronous reset would have run too
    late to put one in it. That failure is invisible to a presence check and is exactly the 29
    of 31 the measurement records for plain ``prep``.
    """
    runner = _RecordingPrepassRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_prepass(tmp_path, runner, sources)

    script = _script_of(runner)
    missing = [pass_name for pass_name in _PREPASS_SEQUENCE if pass_name not in script]
    assert missing == [], f"the pre-pass script omits: {missing}"
    positions = [script.index(pass_name) for pass_name in _PREPASS_SEQUENCE]
    assert positions == sorted(positions)
    # The substituted `-top` and `-flatten`, pinned against the emitted script because only it
    # carries the substitution at all.
    assert f"prep -top {_TOP} -flatten" in script


def test_the_prepass_script_carries_opt_dff_sat_and_the_lowering_does_not() -> None:
    """Requirement 14.13: the pin, from BOTH sides, in ONE place.

    The two constants are READ here rather than re-spelled, because the claim is about the
    RELATIONSHIP between them: the pass that recovers a synchronous reset is PRESENT in the
    pre-pass, where under plain ``prep`` the derivation is 29 of 31 and the two failures are
    exactly the sync-reset designs, and ABSENT from the lowering, so it cannot affect the SMT2
    the proof is taken over. ``test_formal_lowering.py`` asserts the same pair; a reader who
    finds either finds both, and the pair cannot drift apart while both assertions stand.
    """
    assert _REQUIRED_PREPASS_PASS in eda.YOSYS_PREPASS_SCRIPT
    assert _REQUIRED_PREPASS_PASS not in eda.YOSYS_FORMAL_SCRIPT
    assert "opt_dff" not in eda.YOSYS_FORMAL_SCRIPT


@pytest.mark.parametrize("forbidden", _FORBIDDEN_PREPASS_PASSES)
def test_the_prepass_carries_no_pass_that_changes_what_the_proof_covers(
    tmp_path: Path, forbidden: str
) -> None:
    """Requirement 14.13, the other direction: the pre-pass is not a second lowering.

    ``chformal -lower`` and ``memory_map -rom-only -keepdc`` belong to the Lowering_Sequence and
    would make this invocation a second, divergent preparation of the same design.

    ``-formal`` is on the same list for a different reason, and it is the one difference between
    the two frontend calls: admitting the candidate design's own SVA adds ``$check`` cells
    ``write_smt2`` cannot translate, which aborts the write and loses the initial-state
    predicate the whole assertion-gate decision rests on.
    """
    runner = _RecordingPrepassRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_prepass(tmp_path, runner, sources)

    assert forbidden not in _script_of(runner)


def test_the_prepass_write_smt2_targets_its_own_file_and_never_the_formal_jobs(
    tmp_path: Path,
) -> None:
    """Requirement 14.21: the ``write_smt2`` is present, and it writes to the PRE-PASS's file.

    TWO CLAIMS, AND THE SECOND IS THE ONE A PRESENCE CHECK MISSES. A ``write_smt2 out.smt2``
    would satisfy "the pass is present" while targeting the ``formal`` job's own SMT2 - and a
    pre-pass and a formal job sharing a workspace would then have one overwrite the other's
    file, so a proof could be taken over the design ALONE rather than over the Property_Wrapper.
    That is a silent false result about the wrong circuit, so the filename is a pin.

    ``-wires`` is absent for the same family of reason: this SMT2 is read for ONE line, the
    initial-state predicate, and never solved over, so it does not need the lowering's wire
    detail. Its absence is what makes the two writes distinguishable at a glance.
    """
    runner = _RecordingPrepassRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_prepass(tmp_path, runner, sources)

    script = _script_of(runner)
    assert f"write_smt2 {_PREPASS_SMT2_FILE}" in script
    assert _FORMAL_SMT2_FILE not in script
    assert "write_smt2 -wires" not in script
    # And the netlist has its own name too, for the same reason from the other side.
    assert f"write_json {_NETLIST_FILE}" in script


# ---------------------------------------------------------------------------
# `int(v, 2)`: written so a string comparison against `"1"` FAILS
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("narrow", "wide", "expected_active_low"),
    [
        pytest.param(_ONE_NARROW, _ONE_WIDE, False, id="polarity-1-is-active-high"),
        pytest.param(_ZERO_NARROW, _ZERO_WIDE, True, id="polarity-0-is-active-low"),
    ],
)
def test_a_reset_polarity_reads_the_same_at_either_emitted_width(
    tmp_path: Path, narrow: str, wide: str, expected_active_low: bool
) -> None:
    """Requirement 14.16, 14.29: ``int(v, 2)`` over the whole string, never a ``"1"`` compare.

    WRITTEN SO A STRING COMPARISON AGAINST ``"1"`` FAILS, and that is the only form of this test
    worth having. ``write_json``'s emitted WIDTH IS NOT STABLE - ``ARST_POLARITY`` 1 prints as
    ``"1"`` after plain ``prep`` and as 32 characters after ``opt_dff -sat`` - so a string
    compare reads the same design differently depending on which passes ran. Under
    ``polarity == "1"`` the wide row below reads ``resetActiveLow`` TRUE where the narrow row
    reads FALSE, the two rows disagree, and the test fails naming the pair. A test using only
    ``"1"`` passes for both implementations and says nothing.

    The consequence of getting it wrong is not cosmetic: it would have read BOTH real
    sync-reset references, whose raw value IS the 32-character form, as active-LOW, and a wrong
    polarity arrives as a FAILING Base_Check over a PASSING Induction_Check - byte for byte the
    false-proof signature of the ``bad_init`` case, reported to the student as a refutation of
    their own design.
    """
    narrow_reset = _derive(tmp_path / "narrow", _async_reset_netlist(narrow))["reset"]
    wide_reset = _derive(tmp_path / "wide", _async_reset_netlist(wide))["reset"]

    assert narrow_reset == wide_reset
    assert narrow_reset == {
        "derived": True,
        "resetName": "rst",
        "resetActiveLow": expected_active_low,
        "resetKind": "async",
    }


@pytest.mark.parametrize(
    ("narrow", "wide", "expected"),
    [
        pytest.param(_ONE_NARROW, _ONE_WIDE, "posedge", id="polarity-1-is-posedge"),
        pytest.param(_ZERO_NARROW, _ZERO_WIDE, "negedge", id="polarity-0-is-negedge"),
    ],
)
def test_a_clock_polarity_reads_the_same_at_either_emitted_width(
    tmp_path: Path, narrow: str, wide: str, expected: str
) -> None:
    """Requirement 14.16, 14.29: the SAME parse rule on the THIRD parameter.

    ``CLK_POLARITY`` is the same trap on a third parameter and it was MEASURED to hit in one
    run: 1 printed as ``"1"`` on an ``$adff`` design and as 32 characters on an ``$sdffe`` one,
    IN THE SAME PASS SEQUENCE, so the two designs' identical real polarity is spelled two
    different ways at once. Under a ``"1"`` compare the wide row reads ``negedge`` where the
    narrow one reads ``posedge`` - and ``negedge`` REFUSES the design, so the failure direction
    here is a FALSE REFUSAL of a perfectly ordinary posedge design.
    """
    cells = {"ff": _ff_cell("$dff", clk_polarity=narrow)}
    wide_cells = {"ff": _ff_cell("$dff", clk_polarity=wide)}

    narrow_report = _derive(tmp_path / "narrow", _netlist(cells))
    wide_report = _derive(tmp_path / "wide", _netlist(wide_cells))

    assert narrow_report["clockPolarity"] == wide_report["clockPolarity"]
    assert narrow_report["clockPolarity"] == expected


@pytest.mark.parametrize(
    "unreadable",
    [
        pytest.param("2", id="binary-value-out-of-range"),
        pytest.param("x", id="dont-care"),
        pytest.param("", id="empty"),
        pytest.param("00000000000000000000000000000011", id="wide-value-out-of-range"),
        pytest.param(None, id="json-null"),
    ],
)
def test_an_unreadable_reset_polarity_refuses_rather_than_being_coerced(
    tmp_path: Path, unreadable: str | None
) -> None:
    """Requirement 14.18: a polarity that is neither 0 nor 1 refuses, and never guesses.

    Coercion is the failure this excludes, in both of its plausible shapes: ``int("2", 2)``
    raising is not licence to fall back to a default, and a value of an unexpected JSON type is
    not licence to read its truthiness. A refusal costs one ``could-not-verify``; a guess costs
    a polarity, which costs a refutation of a correct design.
    """
    netlist = _netlist(
        {
            "ff": _ff_cell(
                "$adff",
                reset_parameter="ARST_POLARITY",
                reset_polarity=unreadable,  # type: ignore[arg-type]
            )
        }
    )

    assert _derive(tmp_path, netlist)["reset"] == {"derived": False}


# ---------------------------------------------------------------------------
# The reset port filter, and the clock vote that is NOT filtered
# ---------------------------------------------------------------------------


def test_eleven_srst_cells_with_four_on_internal_nets_still_derive(tmp_path: Path) -> None:
    """Requirement 14.15: the port filter, over ``radix2_div``'s own measured shape.

    THIS FIXTURE SEPARATES THE FILTERED IMPLEMENTATION FROM THE UNFILTERED ONE, which is why it
    is eleven cells rather than two. ``radix2_div`` yields ELEVEN ``SRST`` cells, FOUR of them
    on internal nets that ``opt_dff -sat`` invented, and a derivation written WITHOUT the filter
    retains all eleven, sees FIVE distinct nets, and REFUSES the design outright. So the filter
    is doing real work on every sync-reset run rather than standing by for a rare case.
    """
    report = _derive(tmp_path, _radix2_div_netlist())

    assert report["reset"] == {
        "derived": True,
        "resetName": "rst",
        "resetActiveLow": False,
        "resetKind": "sync",
    }


@pytest.mark.parametrize(
    "direction",
    [pytest.param("output", id="output-port"), pytest.param("inout", id="inout-port")],
)
def test_a_reset_resolving_to_a_non_input_port_is_not_derivable(
    tmp_path: Path, direction: str
) -> None:
    """Requirement 14.15: INPUTS only, because only an input can be driven by a wrapper assume.

    An output or an ``inout`` looks every bit as unambiguous as an input to a rule that counts
    distinct nets, so "exactly one net" is not on its own the specified rule. The filter keeps
    entries whose net IS a top-level INPUT port, and a reset the Property_Wrapper cannot drive
    is no reset at all however cleanly it resolves.
    """
    netlist = _netlist(
        {"ff": _ff_cell("$adff", reset_parameter="ARST_POLARITY")},
        ports=_ports(clk="input", rst=direction, out="output"),
    )

    assert _derive(tmp_path, netlist)["reset"] == {"derived": False}


def test_a_reset_on_an_internal_net_alone_is_not_derivable(tmp_path: Path) -> None:
    """Requirement 14.15: the filter's own negative case, isolated.

    The ``radix2_div`` fixture above shows the filter DROPPING internal nets beside real ones.
    This shows what it does when the internal net is the ONLY one: nothing survives, so there is
    no net to derive from and the pre-pass refuses. That is the measured third refusal class -
    ``opt_dff -sat`` can MERGE a sync reset term into a coincident next-state term, so a
    sync-reset counter that wraps to zero AND resets to zero loses its reset port to an internal
    merged net. Model-generated RTL writes that shape constantly, so the refusal rate on
    sync-reset designs is HIGHER than the corpus figures suggest.
    """
    netlist = _netlist(
        {"ff": _ff_cell("$sdffe", reset_parameter="SRST_POLARITY", reset_bit=_INTERNAL_BITS[0])}
    )

    assert _derive(tmp_path, netlist)["reset"] == {"derived": False}


def test_the_clock_vote_is_not_port_filtered(tmp_path: Path) -> None:
    """Requirement 14.28, 14.29: the CLOCK question is asked of every cell, filter or no filter.

    THE ASYMMETRY IS THE CLAIM, and it is the one place a reader might reasonably assume the two
    reads share a rule. The RESET entries are filtered to top-level input ports because a
    Property_Wrapper assume has to DRIVE the reset. Nothing drives the clock vote: it asks
    whether ``write_smt2``'s transition relation can model this design at all, and a flop
    clocked from an internal net is just as unmodelled as one clocked from a port.

    So a design whose every flop is clocked from an INTERNAL net must still answer - here
    ``negedge``, which REFUSES - and must NOT read as ``none``, which is the SUPPORTED
    no-clocked-state class. Applying the port filter to the clock would turn the measured
    mixed-edge false refutation back on, silently, on exactly the designs that hide their
    clocking behind internal buffering.
    """
    internal_clock = {
        "ff": _ff_cell("$dff", clk_polarity=_ZERO_WIDE, clk_bit=_INTERNAL_BITS[1]),
    }

    report = _derive(tmp_path, _netlist(internal_clock))

    assert report["clockPolarity"] == "negedge"
    assert report["clockPolarity"] != "none"


# ---------------------------------------------------------------------------
# The derivation rule, and the cells that vote on nothing
# ---------------------------------------------------------------------------


def test_two_reset_nets_refuse_because_no_single_name_can_be_right(tmp_path: Path) -> None:
    """Requirement 14.18: several nets refuses - ``asyn_fifo``'s measured shape.

    ``asyn_fifo`` genuinely has TWO reset ports, so no single reset name can be right for all
    its flops. The refusal is a first-class OUTCOME carried in the report rather than an error,
    which is what ``derived: False`` being a member of the reset union says.
    """
    netlist = _netlist(
        {
            "ff_a": _ff_cell("$adff", reset_parameter="ARST_POLARITY", reset_bit=_RST_BIT),
            "ff_b": _ff_cell("$adff", reset_parameter="ARST_POLARITY", reset_bit=_SECOND_RST_BIT),
        },
        ports=_ports(clk="input", rst="input", rst2="input", out="output"),
    )

    assert _derive(tmp_path, netlist)["reset"] == {"derived": False}


def test_one_net_carrying_two_polarities_refuses(tmp_path: Path) -> None:
    """Requirement 14.18: several polarities refuses, even over a single net.

    A separate case from several nets, because a rule that only counted NETS would derive here
    and then have to pick one of two polarities - and picking is the one thing this derivation
    must never do, since the wrong pick is a refutation of a correct design.
    """
    netlist = _netlist(
        {
            "ff_high": _ff_cell("$adff", reset_parameter="ARST_POLARITY", reset_polarity=_ONE_WIDE),
            "ff_low": _ff_cell("$adff", reset_parameter="ARST_POLARITY", reset_polarity=_ZERO_WIDE),
        }
    )

    assert _derive(tmp_path, netlist)["reset"] == {"derived": False}


def test_one_net_carrying_two_reset_kinds_refuses(tmp_path: Path) -> None:
    """Requirement 14.18: a net that is ASYNC on one flop and SYNC on another refuses.

    The kind decides whether the ``if (!$initstate)`` assertion gate is emitted at all
    (Requirement 14.3, 14.4), so a design whose flops disagree about it has no single answer to
    give the renderer - and the two answers are gated differently, which is measured to be the
    difference between a proof and a base-case failure one step apart.
    """
    netlist = _netlist(
        {
            "ff_async": _ff_cell("$adff", reset_parameter="ARST_POLARITY"),
            "ff_sync": _ff_cell("$sdffe", reset_parameter="SRST_POLARITY"),
        }
    )

    assert _derive(tmp_path, netlist)["reset"] == {"derived": False}


def test_a_cell_set_with_no_reset_entry_refuses_with_no_guess(tmp_path: Path) -> None:
    """Requirement 14.18: no reset entry refuses, and nothing is guessed at.

    ``LIFObuffer`` does NOT arrive here: its reset is enable-gated, so
    :func:`_derived_reset_enable` names that enable and the derivation SUCCEEDS - see
    ``test_an_enable_gated_reset_reports_the_enable_net_and_its_asserted_level`` below. The clock
    still answers, which is what keeps this a RESET refusal rather than a report that says
    nothing.
    """
    report = _derive(tmp_path, _netlist({"ff": _ff_cell("$dff")}))

    assert report["reset"] == {"derived": False}
    assert report["clockPolarity"] == "posedge"


def test_an_enable_gated_reset_reports_the_enable_net_and_its_asserted_level(
    tmp_path: Path,
) -> None:
    """Criterion 4.15 of ``formal-gate-first-light``, which AMENDS Requirement 14.19.

    ``LIFObuffer``'s measured shape. An ``$sdffce`` resets only while its enable is active, so a
    contract naming ``rst`` alone states a conditional reset as if it were unconditional and the
    assume rendered from it leaves the solver free to hold the enable at the level that stops the
    reset firing. The enable is now NAMED, and the five internal-net cells are dropped by the
    same port filter the reset net goes through rather than making the vote ambiguous.
    """
    assert _derive(tmp_path, _lifobuffer_netlist())["reset"] == {
        "derived": True,
        "resetName": "rst",
        "resetActiveLow": False,
        "resetKind": "sync",
        "resetEnable": {"name": "en", "activeLow": False},
    }


def test_a_reset_carried_by_a_cell_with_no_enable_reports_no_enable_field_at_all(
    tmp_path: Path,
) -> None:
    """Criterion 4.15: an ABSENT enable is an absent KEY, not a defaulted level.

    An ``$adff`` has no ``EN`` connection, so there is no enable to name - and the report must
    say that by OMITTING the field rather than by writing one with a level nobody read. The two
    shapes drive opposite assumes: an absent enable leaves the assume where it is today, and an
    enable asserted low makes it pin that net low.
    """
    report = _derive(tmp_path, _async_reset_netlist(_ONE_WIDE))

    assert report["reset"] == {
        "derived": True,
        "resetName": "rst",
        "resetActiveLow": False,
        "resetKind": "async",
    }
    assert "resetEnable" not in report["reset"]


@pytest.mark.parametrize(
    ("enable_polarity", "expected_active_low"),
    [
        pytest.param(_ONE_NARROW, False, id="asserted-high-narrow"),
        pytest.param(_ONE_WIDE, False, id="asserted-high-wide"),
        pytest.param(_ZERO_NARROW, True, id="asserted-low-narrow"),
        pytest.param(_ZERO_WIDE, True, id="asserted-low-wide"),
    ],
)
def test_an_enable_level_reads_the_same_at_either_emitted_width(
    tmp_path: Path, enable_polarity: str, expected_active_low: bool
) -> None:
    """Requirement 14.16, 14.29 applied to ``EN_POLARITY``: ``int(v, 2)``, never a ``"1"`` compare.

    ``write_json``'s binary strings have an UNSTABLE WIDTH - measured on this workspace's Yosys,
    one real polarity is spelled both ``"1"`` and 32 characters inside one run - so a string
    comparison reads the same enable differently depending on which passes ran. On this field the
    misreading is silent and inverts the assumed enable level, which is the one level at which
    the reset does NOT fire.
    """
    reset = _derive(tmp_path, _lifobuffer_netlist(enable_polarity))["reset"]

    assert reset["resetEnable"] == {"name": "en", "activeLow": expected_active_low}


@pytest.mark.parametrize(
    ("cell_type", "reset_parameter", "kind"),
    [
        pytest.param("$adffe", "ARST_POLARITY", "async", id="adffe-on-counter_12"),
        pytest.param("$sdffe", "SRST_POLARITY", "sync", id="sdffe-reset-over-enable"),
    ],
)
def test_an_enable_on_a_cell_whose_reset_has_priority_is_not_reported(
    tmp_path: Path, cell_type: str, reset_parameter: str, kind: str
) -> None:
    """Criterion 4.15: only a cell whose ENABLE GATES ITS RESET contributes an enable.

    THE PRIORITY IS A CELL-TYPE FACT AND NO PARAMETER CARRIES IT, read directly from Yosys
    0.69's ``simlib.v``: ``$sdffce`` is ``if (EN == EN_POLARITY) begin if (pos_srst) ...``, so
    its enable gates its reset, while ``$sdffe`` is ``if (pos_srst) ... else if (EN == ...)``
    and ``$adffe`` is the same priority asynchronously - both reset whatever the enable does.

    MEASURED, and this is why the test exists rather than the rule being obvious: ``counter_12``
    is ``$adffe`` with the top-level input ``valid_count`` on ``EN``, and its reset is
    active-low asynchronous and fires regardless of it. Reporting that enable would make the
    rendered assume pin a net the reset does not depend on, which NARROWS step 0 for no reason -
    the false-PROOF direction, caught by the real pre-pass over the real netlist.
    """
    netlist = _netlist(
        {"ff": _ff_cell(cell_type, reset_parameter=reset_parameter, enable_polarity=_ONE_WIDE)},
        _ENABLE_GATED_PORTS,
    )

    assert _derive(tmp_path, netlist)["reset"] == {
        "derived": True,
        "resetName": "rst",
        "resetActiveLow": False,
        "resetKind": kind,
    }


def test_two_distinct_enable_nets_report_no_enable_rather_than_picking_one(
    tmp_path: Path,
) -> None:
    """Criterion 4.15: an UNCERTAIN enable is absent, because naming one pins MORE at step 0.

    Two retained reset entries on one net, gated by two different top-level enables. No single
    enable can be right for both, and the fail-safe direction here is the one that reports none:
    naming an enable NARROWS the assumed reset step, which is the false-PROOF direction, so an
    ambiguous vote leaves the assume exactly where it is today rather than guessing.
    """
    netlist = _netlist(
        {
            "ff_en": _ff_cell("$sdffce", reset_parameter="SRST_POLARITY"),
            "ff_en2": _ff_cell(
                "$sdffce", reset_parameter="SRST_POLARITY", enable_bit=_SECOND_EN_BIT
            ),
        },
        _ports(clk="input", rst="input", en="input", en2="input", out="output"),
    )

    assert _derive(tmp_path, netlist)["reset"] == {
        "derived": True,
        "resetName": "rst",
        "resetActiveLow": False,
        "resetKind": "sync",
    }


@pytest.mark.parametrize(
    ("netlist_kwargs", "case"),
    [
        pytest.param({"enable_polarity": "2"}, "unreadable-level", id="unreadable-level"),
        pytest.param(
            {"enable_polarity": _ONE_WIDE, "enable_bit": _INTERNAL_BITS[0]},
            "internal-net",
            id="internal-enable-net",
        ),
    ],
)
def test_an_enable_the_prepass_cannot_read_reports_no_enable_rather_than_guessing(
    tmp_path: Path, netlist_kwargs: dict[str, Any], case: str
) -> None:
    """Criterion 4.15: the two ways one enable fails to be nameable, both reporting none.

    An ``EN_POLARITY`` that is neither 0 nor 1 is UNREADABLE, so no asserted level can be
    reported. An enable on an INTERNAL net cannot be driven by a Property_Wrapper assume at all,
    so it is dropped by the same filter that drops an internal reset net. Both leave the reset
    itself derived - the enable is an additional fact, and failing to read it must not cost the
    contract the three facts that WERE read.
    """
    netlist = _netlist(
        {"ff": _ff_cell("$sdffce", reset_parameter="SRST_POLARITY", **netlist_kwargs)},
        _ENABLE_GATED_PORTS,
    )

    assert _derive(tmp_path, netlist)["reset"] == {
        "derived": True,
        "resetName": "rst",
        "resetActiveLow": False,
        "resetKind": "sync",
    }, case


def test_an_enable_is_named_even_where_another_retained_cell_carries_none(
    tmp_path: Path,
) -> None:
    """Criterion 4.15: a cell with no enable casts no enable vote rather than vetoing one.

    One ``$sdff`` and one ``$sdffce`` on the same reset net. The ``$sdff`` resets whenever the
    reset is asserted, so asserting the enable still makes the assumed step one at which EVERY
    retained reset fires - which is what the field is for. A cell with no enable abstaining is
    therefore not the same as two cells disagreeing, and the two must not collapse.
    """
    netlist = _netlist(
        {
            "ff_plain": _ff_cell("$sdff", reset_parameter="SRST_POLARITY"),
            "ff_gated": _ff_cell(
                "$sdffce", reset_parameter="SRST_POLARITY", enable_polarity=_ZERO_WIDE
            ),
        },
        _ENABLE_GATED_PORTS,
    )

    assert _derive(tmp_path, netlist)["reset"]["resetEnable"] == {"name": "en", "activeLow": True}


@pytest.mark.parametrize(
    ("parameter", "cell_type"),
    [
        pytest.param("ALOAD_POLARITY", "$aldff", id="async-load-on-booth4_mul"),
        pytest.param("EN_POLARITY", "$dlatch", id="latch-enable-on-fsm"),
    ],
)
def test_a_polarity_parameter_that_is_not_a_reset_votes_on_nothing(
    tmp_path: Path, parameter: str, cell_type: str
) -> None:
    """Requirement 14.14: ``ARST_POLARITY`` and ``SRST_POLARITY`` only, by NAME.

    Two MEASURED near-misses, and both are on real corpus designs: ``$aldff`` carries
    ``ALOAD_POLARITY`` - an async LOAD, on ``booth4_mul`` - and ``$dlatch`` carries
    ``EN_POLARITY``, on ``fsm``. Neither is a reset and neither may vote.

    The rule is driven by the PARAMETER NAME rather than by a cell-type whitelist, which is what
    excludes these two structurally while still covering every enable-carrying flop variant
    (``$adffe``, ``$sdffe``, ``$sdffce``) with no type list to keep up to date. This test is the
    negative half of that: a cell carrying a polarity parameter that is not one of the two named
    ones contributes no reset entry, so the design refuses for having none rather than deriving
    a "reset" from a load enable.
    """
    netlist = _netlist({"ff": _ff_cell(cell_type, reset_parameter=parameter)})

    assert _derive(tmp_path, netlist)["reset"] == {"derived": False}


@pytest.mark.parametrize(
    ("cells", "expected"),
    [
        pytest.param({}, "none", id="no-cells-at-all"),
        pytest.param({"comb": _ff_cell("$and", clk_polarity=None)}, "none", id="no-clocked-cell"),
        pytest.param({"ff": _ff_cell("$dff", clk_polarity=_ONE_WIDE)}, "posedge", id="posedge"),
        pytest.param({"ff": _ff_cell("$dff", clk_polarity=_ZERO_WIDE)}, "negedge", id="negedge"),
        pytest.param(
            {
                "up": _ff_cell("$dff", clk_polarity=_ONE_WIDE),
                "down": _ff_cell("$dff", clk_polarity=_ZERO_WIDE),
            },
            "mixed",
            id="mixed-freq_divbyodd",
        ),
    ],
)
def test_the_clock_finding_is_one_of_the_four_members(
    tmp_path: Path, cells: dict[str, Any], expected: str
) -> None:
    """Requirement 14.34, 14.36: the four-member vocabulary, one row per member.

    ``none`` is asserted TWICE and the two rows are different facts: an empty cell map, and a
    cell map whose cells carry no ``CLK_POLARITY`` at all. Both are the SUPPORTED
    no-clocked-state class - 15 of 50 references - and neither may collapse into ``posedge`` or
    read as a refusal. The presence of ``CLK_POLARITY`` is what makes a cell a CLOCKED cell, so
    the second row is what pins that rule rather than the cell TYPE.

    ``mixed`` is ``freq_divbyodd``'s measured shape: two ``posedge clk`` blocks and two
    ``negedge clk`` blocks ORed together, and an odd divider works PRECISELY because its negedge
    domain is offset half a cycle - which ``write_smt2``'s transition relation deletes, refuting
    a property iverilog reports 0 mismatches on.
    """
    assert _derive(tmp_path, _netlist(cells))["clockPolarity"] == expected


def test_an_unreadable_clock_polarity_writes_no_report_at_all(tmp_path: Path) -> None:
    """Requirement 14.26: an unreadable clock is a refusal of the whole report, not a fifth value.

    NONE OF THE FOUR MEMBERS NAMES "COULD NOT READ", and guessing ``posedge`` is exactly the
    FALSE-REFUTATION direction the whole Clock_Contract rule exists to close. So the honest
    answer is no report, which the TypeScript side already reads as ``toolchain-unavailable``
    because the required ``formalPrepassReport`` output is then absent.

    Asserted as the ABSENCE of the artifact rather than as a field value, because a report
    carrying a reset finding beside a missing clock finding is the shape that would let a
    contract be used over a design whose clocking was never established.
    """
    runner = _RecordingPrepassRunner(netlist=_netlist({"ff": _ff_cell("$dff", clk_polarity="2")}))
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_prepass(tmp_path, runner, sources)

    assert capture.artifacts == {}
    assert not (tmp_path / _REPORT_FILE).exists()


# ---------------------------------------------------------------------------
# The report as a REQUIRED output, and the absent-report case
# ---------------------------------------------------------------------------


def test_a_readable_netlist_registers_the_report_under_the_required_key(
    tmp_path: Path,
) -> None:
    """Requirement 14.11, and the ASYMMETRY that is the whole rule about required outputs.

    ``formalPrepassReport`` is a REQUIRED output for this job kind, unlike the ``formal`` job's
    counterexample trace, which is OPPORTUNISTIC. The rule behind the difference: an output is
    required exactly when its ABSENCE CANNOT BE A SUCCESS. A pre-pass that produced no report
    produced nothing - its entire output IS the report - while a SUCCESSFUL PROOF produces no
    trace, so listing the trace as required would classify every proof as ``error``.

    The key is a CHANNEL rather than a label: the TypeScript adapter reads the pre-pass report
    through exactly this name, so a rename here is a silent break rather than a cosmetic one.
    """
    runner = _RecordingPrepassRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_prepass(tmp_path, runner, sources)

    assert set(capture.artifacts) == {_REPORT_KEY}
    assert capture.artifacts[_REPORT_KEY].name == _REPORT_FILE
    assert capture.exit_code == 0
    # FOUR fields, all present: the reset finding, the clock finding, the predicate's TEXT, and
    # the per-port timing facts.
    # `initialStatePredicate` crosses the seam as a BODY rather than as a boolean, because
    # whether `true` means the initial state is FREE is decided ONCE on the TypeScript side,
    # together with the refusal an absent or unparseable predicate produces (Req 14.24).
    # `timing` crosses it as FACTS for the same reason: the classification rule is the
    # TypeScript side's, and this side must not become a second decider of it.
    assert set(_report(tmp_path)) == {
        "reset",
        "clockPolarity",
        "initialStatePredicate",
        "timing",
    }
    assert _report(tmp_path)["initialStatePredicate"] == "true"


def test_an_unelaborated_design_registers_no_report_rather_than_an_empty_derivation(
    tmp_path: Path,
) -> None:
    """Requirement 14.26: an absent netlist is reported as absent, not as "nothing found".

    THE TWO OUTCOMES THIS SEPARATES ARE OPPOSITE FACTS. A report carrying
    ``reset: {derived: false}`` says the pre-pass LOOKED and found no single reset - a finding
    about the design, which reaches the gate as ``reset-contract-unresolved``. NO report says the
    pre-pass could not look at all - a gap in our instrument, which reaches the gate as
    ``toolchain-unavailable``. An unreadable netlist that wrote an empty derivation would report
    the second as the first, and a student would be told their design's reset is ambiguous when
    in truth it never elaborated.

    The exit code is NOT the signal and is asserted as such: Yosys exited 0 here.
    """
    runner = _AbsentNetlistRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_prepass(tmp_path, runner, sources)

    assert capture.exit_code == 0
    assert capture.artifacts == {}
    assert not (tmp_path / _REPORT_FILE).exists()


def test_an_unwritten_predicate_crosses_the_seam_as_null(tmp_path: Path) -> None:
    """Requirement 14.21, 14.23: an unreadable predicate is ``null``, and the report still goes.

    The predicate is the ONE field the pre-pass may honestly fail to fill while still having
    something to report, because the reset and clock findings come from the netlist and the
    predicate from the SMT2. ``null`` is the worker saying so; the TypeScript side turns it into
    a refusal rather than a default, because BOTH defaults are unsafe in OPPOSITE directions -
    defaulting to free masks a wrong ``initial`` value, and defaulting to not free fails a
    correct sync-reset design's base case.

    The key is present and ``null`` rather than absent: ``json.dumps`` writes it on every run,
    so an ABSENT key is a document the TypeScript parse does not recognize at all.
    """
    report = _derive(tmp_path, _async_reset_netlist(_ZERO_WIDE), smt2=None)

    assert "initialStatePredicate" in report
    assert report["initialStatePredicate"] is None


def test_a_pinned_predicate_crosses_the_seam_as_its_own_body(tmp_path: Path) -> None:
    """Requirement 14.21, 14.22: the BODY crosses, not a verdict about it.

    A design carrying ``initial out = 4'd15`` pins a state bit, so its predicate is an equality
    rather than ``true``. What crosses is that equality's TEXT - the worker reports what
    ``write_smt2`` emitted and decides nothing - which is what keeps the free-initial-state rule
    to a single owner on the side that also owns the refusal it produces.

    The body spans the ``define-fun``'s own parentheses and Yosys annotates it with a ``;``
    comment naming the signal, both of which the read has to survive, so the fixture carries
    both rather than a one-word body.
    """
    pinned = (
        f"(define-fun |{_TOP}_i| ((state |{_TOP}_s|)) Bool (= ((|{_TOP}#0| state)) #b1111)) ; out\n"
    )

    report = _derive(tmp_path, _async_reset_netlist(_ZERO_WIDE), smt2=pinned)

    assert report["initialStatePredicate"] == f"(= ((|{_TOP}#0| state)) #b1111)"


# ---------------------------------------------------------------------------
# The trust boundary: what never reaches a command line
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "top_module",
    [
        pytest.param("has space", id="whitespace"),
        pytest.param("top; write_verilog INJECTED.v", id="semicolon"),
        pytest.param("9starts_with_digit", id="leading-digit"),
        pytest.param("-top", id="reads-as-an-option"),
        pytest.param("", id="empty"),
    ],
)
def test_a_non_identifier_top_module_is_refused_before_any_command(
    tmp_path: Path, top_module: str
) -> None:
    """Requirement 11.10: a design name that is not a plain identifier builds nothing.

    The worker is a trust boundary in its OWN right and does not take a job's word for a
    shell-bound value, even though the seam schema validated the same field: the schema's path
    is env-overridable, so the worker re-validates rather than inheriting.

    No depth rule here, and that is not an omission - the pre-pass runs no solver, so there is
    no ``-t`` for a depth to reach.
    """
    runner = _RecordingPrepassRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_prepass(tmp_path, runner, sources, top_module=top_module)

    assert runner.calls == []
    assert capture.exit_code != 0
    assert capture.artifacts == {}
    # The refusal names the RULE and never echoes the rejected value.
    assert capture.stderr == "formalPrepass topModule is not a plain Verilog identifier"


def test_no_sources_is_refused_before_any_command(tmp_path: Path) -> None:
    """Requirement 11.10: an empty source list is refused rather than elaborated to nothing.

    ``read_verilog`` with no files is a script Yosys would accept, elaborating nothing and then
    failing on ``prep -top``. Refusing first keeps the reported reason ours rather than a Yosys
    diagnostic about a module that was never submitted.
    """
    runner = _RecordingPrepassRunner()

    capture = _run_prepass(tmp_path, runner, [])

    assert runner.calls == []
    assert capture.exit_code != 0
    assert capture.artifacts == {}
    assert capture.stderr == "no Verilog source files to elaborate"


def test_a_source_path_carrying_a_semicolon_is_refused_before_any_command(
    tmp_path: Path,
) -> None:
    """Requirement 11.10: the ``;`` injection mitigation applies to the pre-pass too.

    THE PRE-PASS INHERITS THE CHANNEL BECAUSE IT ASSEMBLES ITS SCRIPT THE SAME WAY: one ``-p``
    argument holding a semicolon-separated command list Yosys splits ITSELF. MEASURED on Yosys
    0.66 in this workspace: a source file named ``design.v; write_verilog INJECTED.v`` makes
    Yosys run that second command.

    Driven through ``run_job`` rather than ``eda.formal_prepass`` directly, because the whole
    chain is the claim: path confinement ACCEPTS this name - it is relative, has no traversal,
    and resolves inside the workspace - so it is written, becomes a source relpath, and reaches
    the script assembly. Confinement bounds WHERE a job may write, not what a filename may SAY
    (``chipAgent/_inbox/gotcha-path-confinement-accepts-a-filename-carrying-a-semicolon.md``).

    TWO FILES, which is what the measurement required: the crafted name's leading token is
    ``design.v``, so a real ``design.v`` has to exist for ``read_verilog`` to resolve it and
    carry on into the injected command. The fake models that abort, and the fidelity check below
    pins both halves of it, so this refusal is not passing because the fake is inert.
    """
    runner = _RecordingPrepassRunner()

    report = run_job(
        SandboxJob(
            kind="formalPrepass",
            workspace_files=[
                SourceFile(path=_DESIGN_FILE, contents="module top; endmodule"),
                SourceFile(path=_INJECTING_FILE, contents="module top; endmodule"),
            ],
            limits=ResourceLimits(cpu=1.0, mem_mb=256, procs=32, disk_mb=64, wall_ms=5000),
            required_outputs=["stdout", "stderr", "exitCode", _REPORT_KEY],
            formal_prepass=FormalPrepassRequest(top_module=_TOP),
        ),
        tmp_path,
        runner,
    ).as_dict()

    assert runner.calls == []
    assert not (tmp_path / _INJECTED_FILE).exists()
    assert report["artifacts"] == {}
    assert report["deniedOperations"] == []
    assert report["exitCode"] != 0
    assert report["stderr"] == (
        "a source path holds a character the Yosys script grammar would reinterpret"
    )
    # Both files were materialized, so the refusal is the script guard's and not a confinement
    # denial in disguise.
    assert (tmp_path / _INJECTING_FILE).is_file()


def test_the_fake_reproduces_the_measured_injection_only_with_two_files(
    tmp_path: Path,
) -> None:
    """The fake's own fidelity check: the guard above refuses a REAL injection.

    Without this the refusal test could pass against a fake that never honoured a
    ``write_verilog`` at all. Handed the script the UNGUARDED code would have built - the
    pre-pass's own constant, formatted with the crafted name - the fake writes the injected file
    when two files are present and does NOT when only the crafted name is, which is the measured
    trap the vault note records and the reason a single-file case would have cleared this as a
    non-issue.

    Formatted from ``YOSYS_PREPASS_SCRIPT`` rather than from a hand-written script, because the
    claim is that THIS script is an injection channel: a hand-written one would prove only that
    the fake honours ``write_verilog``.
    """
    two_files = tmp_path / "two"
    one_file = tmp_path / "one"
    for workspace in (two_files, one_file):
        workspace.mkdir()
    _write_design(two_files, _DESIGN_FILE, _INJECTING_FILE)
    _write_design(one_file, _INJECTING_FILE)
    script = eda.YOSYS_PREPASS_SCRIPT.format(sources=_INJECTING_FILE, top=_TOP)

    for workspace in (two_files, one_file):
        _RecordingPrepassRunner().run(
            ["yosys", "-p", script], workspace, _TIMEOUT_S, _DISK_LIMIT_BYTES
        )

    assert (two_files / _INJECTED_FILE).is_file()
    assert not (one_file / _INJECTED_FILE).exists()


def test_the_module_is_looked_up_by_the_requested_top_and_not_by_whatever_elaborated(
    tmp_path: Path,
) -> None:
    """Requirement 11.10: the facts derived are the facts of the design the JOB named.

    A netlist can carry several modules, and Yosys also records its own ``top`` attribute. Using
    either of those instead of the requested ``-top`` would derive a contract from whichever
    module happened to be there - a reset polarity read off the wrong circuit, which is the
    silent wrong answer this whole component is shaped to avoid.
    """
    netlist = _async_reset_netlist(_ZERO_WIDE)
    netlist["modules"] = {"some_other_module": netlist["modules"][_TOP]}
    runner = _RecordingPrepassRunner(netlist=netlist)
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_prepass(tmp_path, runner, sources)

    assert capture.artifacts == {}
    assert not (tmp_path / _REPORT_FILE).exists()


# ---------------------------------------------------------------------------
# The cone walk: the two measured anchors
# ---------------------------------------------------------------------------
#
# Both are pinned over COMMITTED REAL NETLISTS rather than hand-written cells, because the
# cone walk's claims are about connectivity Yosys produces - a flattened hierarchy, a wide
# port, a bare alias merging an output net into a register's Q - and a hand-written fixture
# would be asserting the shape its author imagined.
#
# These two expectations are LOAD-BEARING for the whole component. `traffic_light`'s four
# ports are why the cone rule was chosen over flip-flop adjacency, and its `clock` port is
# what falsified an earlier source-text design: a CONTINUOUS assignment whose honest answer
# is state-dependent.


def test_a_combinational_design_reports_every_data_input_source_and_no_state(
    tmp_path: Path,
) -> None:
    """Requirement 1.11: a purely combinational port names its sources and reaches no state.

    ``adder_8bit`` is hierarchical - eight ``full_adder`` instances - so this also pins that
    ``prep -flatten``'s ``$scopeinfo`` cells, which carry an EMPTY ``port_directions`` and no
    output pin at all, neither drive a bit nor stop a walk.

    Both declared outputs must name all three data inputs: ``cout`` is the final carry and
    ``sum`` the ripple result, and in a ripple-carry adder every output bit depends on every
    input through the carry chain.
    """
    assert _timing_ports(tmp_path, _ADDER_8BIT) == [
        {"port": "sum", "sources": ["a", "b", "cin"], "reachesState": False, "undriven": False},
        {"port": "cout", "sources": ["a", "b", "cin"], "reachesState": False, "undriven": False},
    ]


def test_a_registered_design_reports_no_data_input_source_on_any_port(tmp_path: Path) -> None:
    """Requirement 1.4: a retained-state cell ENDS the cone, so nothing behind it is a source.

    All four of ``traffic_light``'s declared outputs are state-dependent and name NO source,
    and the declared data input ``pass_request`` appears in none of them - it drives the
    counter's next-state logic, which sits BEHIND the flop boundary.

    ``clock`` is the interesting one and the reason this anchor is here: it is driven by
    ``assign clock = cnt`` over a register, so ``write_json`` merges the output net into the
    flop's ``Q`` and the walk reaches the boundary with no cell in between. A rule keyed on the
    assignment's source context reads that continuous assignment as combinational and is wrong.
    """
    stateful = {"sources": [], "reachesState": True, "undriven": False}
    assert _timing_ports(tmp_path, _TRAFFIC_LIGHT) == [
        {"port": "clock", **stateful},
        {"port": "red", **stateful},
        {"port": "yellow", **stateful},
        {"port": "green", **stateful},
    ]


# The ASYNCHRONOUS-READ MEMORY rule (Requirements 1.4, 1.12).
#
# A memory is a retained-state boundary on every pin except an asynchronous `RD_DATA`, and
# `ROM` is why the exception exists: `always @(*) dout = mem[addr]` is a genuinely
# combinational read, so a rule that made every memory a plain boundary would derive
# `registered` for `dout` against Requirement 3.2's `combinational`.


def test_an_asynchronous_memory_read_names_its_address_and_still_reaches_state(
    tmp_path: Path,
) -> None:
    """Requirement 1.12: ``RD_CLK_ENABLE`` zero exposes ``RD_ADDR`` and sets ``reaches_state``.

    ``ROM``'s measured netlist: one ``$mem_v2`` whose ``RD_DATA`` IS the declared ``dout`` net
    and whose ``RD_ADDR`` IS the declared ``addr`` net, with ``RD_CLK_ENABLE`` written as
    ``'0'`` and ``RD_CLK`` tied to ``x``.

    BOTH halves are asserted together because each alone is satisfiable by a wrong rule: a
    plain boundary gives ``reaches_state`` with no source, and crossing the memory as ordinary
    logic gives the source with no ``reaches_state``. The value is read out of memory AND the
    address reaches it this cycle, so the honest answer carries both.
    """
    assert _timing_ports(tmp_path, _ROM, top_module=_ROM) == [
        {"port": "dout", "sources": ["addr"], "reachesState": True, "undriven": False},
    ]


@pytest.mark.parametrize("clock_enable", ["0", "00", 0, False, _ZERO_WIDE])
def test_every_spelling_of_a_zero_clock_enable_reads_as_asynchronous(
    tmp_path: Path, clock_enable: Any
) -> None:
    """``RD_CLK_ENABLE`` is read as a BINARY INTEGER, so its spelling cannot change the answer.

    ``write_json`` emits a parameter's width UNSTABLY - the measured ``CLK_POLARITY`` case is
    the same value spelled two ways in one run - so a reader comparing against ``"0"`` answers
    differently per pass sequence. A multi-bit ``"00"`` is included because it is what a
    two-read-port memory carries, and a string comparison fails it outright.
    """
    ports = _memory_timing_ports(tmp_path, _memory_netlist(clock_enable))
    assert ports == [
        {"port": "dout0", "sources": ["addr0", "en0"], "reachesState": True, "undriven": False},
    ]


def test_a_clocked_memory_read_is_a_boundary_that_names_no_source(tmp_path: Path) -> None:
    """Requirement 1.4: ``RD_CLK_ENABLE`` one keeps the memory a plain boundary.

    The clocked counterpart of the ``ROM`` case, and HAND-WRITTEN rather than measured: the
    rtllm corpus holds exactly two ``$mem_v2`` cells and both are asynchronous, so there is no
    reference netlist to read this direction off. ``verified_RAM`` is not it - Yosys reports
    ``Replacing memory \\RAM with list of registers``, because the reset loop writing
    ``RAM[i] <= 0`` forces ``mem2reg``, and the elaborated design carries no memory cell at all.
    """
    ports = _memory_timing_ports(tmp_path, _memory_netlist(_ONE_NARROW))
    assert ports == [
        {"port": "dout0", "sources": [], "reachesState": True, "undriven": False},
    ]


@pytest.mark.parametrize("clock_enable", ["x", "", "0b0", None, [0]])
def test_an_unreadable_clock_enable_refuses_rather_than_reading_as_a_boundary(
    tmp_path: Path, clock_enable: Any
) -> None:
    """An unreadable ``RD_CLK_ENABLE`` is ``cell-shape-unreadable``, not a silent boundary.

    A boundary would be the conservative ANSWER - state-dependent, no source - and that is
    exactly why it is wrong here: it is an answer, and we have no evidence for one. Without
    this parameter the memory is neither clocked nor asynchronous as far as this reader is
    concerned, so the honest report says the shape could not be read.

    The spellings are the ones :func:`_binary_parameter` must reject: a don't-care, an empty
    value, a Python literal ``int`` would accept, an absent parameter, and a non-string.
    """
    timing = _timing_finding(tmp_path, _memory_netlist(clock_enable))

    assert timing == {"derived": False, "cause": "cell-shape-unreadable"}


def test_each_read_port_of_a_memory_is_clocked_by_its_own_enable_bit(tmp_path: Path) -> None:
    """``RD_CLK_ENABLE`` is indexed PER READ PORT, from the bit's position within ``RD_DATA``.

    Two read ports, mask ``"10"``: port 0 asynchronous, port 1 clocked. So ``dout0`` names its
    own address and enable while ``dout1`` names nothing, and the two cannot be swapped or
    merged - a rule reading bit 0 for every ``RD_DATA`` bit would report BOTH as asynchronous,
    and one reading ``int(mask, 2)`` as a truth value would report both as clocked.

    It also pins the per-port SLICING of the input pins: ``dout0`` must not name ``addr1`` or
    ``en1``, which it would if the whole ``RD_ADDR`` connection joined the frontier.

    HAND-WRITTEN: the corpus holds no multi-read-port memory. Both of its memories report
    ``RD_PORTS=1``, including ``asyn_fifo``'s ``dual_port_RAM``, whose two ports are one READ
    and one WRITE.
    """
    ports = _memory_timing_ports(tmp_path, _memory_netlist("10", read_ports=2))
    assert ports == [
        {"port": "dout0", "sources": ["addr0", "en0"], "reachesState": True, "undriven": False},
        {"port": "dout1", "sources": [], "reachesState": True, "undriven": False},
    ]


# ---------------------------------------------------------------------------
# The three structural refusals (Requirements 1.13, 2.5)
# ---------------------------------------------------------------------------
#
# The three fixtures below are HAND-WRITTEN and are NOT corpus evidence, by the convention the
# `$mem_v2` fixtures above follow. They cannot be measured: `prep -flatten` leaves no module
# instance behind, Yosys 0.66 produces no clocked cell outside the ten named types, and it
# writes `port_directions` on every cell it emits. That is the POINT of all three - each
# guards a shape this reader has never seen, and a guard with no test is a comment.
#
# The corpus half of the claim is `test_no_structural_guard_refuses_a_real_netlist` below,
# which pins that the three COMMITTED REAL netlists still DERIVE. A guard that refuses the
# whole corpus is worse than no guard, and `adder_8bit`'s eight `$scopeinfo` cells - whose
# `port_directions` is legitimately an EMPTY dict - are the shape that would make
# `cell-shape-unreadable` over-fire.

#: A cell name as Yosys actually spells one, measured on `radix2_div`. It embeds the design's
#: SOURCE FILE and LINE, which is why the refusal Requirement 2.5 describes names no cell.
_SOURCE_BEARING_CELL_NAME = "$and$radix2_div.v:58$21_Y"

#: The ports every fixture below presents: one data input driving one declared output, plus the
#: clock the clocked fixture connects to.
_CONE_PORTS = _ports(clk="input", en="input", out="output")


def _cone_cell(cell_type: str, *, clocked: bool = False, shaped: bool = True) -> dict[str, Any]:
    """One cell driving the declared output ``out`` from the declared data input ``en``.

    ``clocked`` attaches the ``CLK`` pin that makes a cell a boundary, on BOTH the declared
    shape and the connections, as a real clocked cell carries it.

    ``shaped=False`` drops ``port_directions`` ENTIRELY rather than emptying it, because an
    empty one is what ``$scopeinfo`` legitimately carries and must keep deriving.
    """
    directions = {"A": "input", "Y": "output"}
    connections: dict[str, Any] = {"A": [_EN_BIT], "Y": [_OUTPUT_BIT]}
    parameters: dict[str, Any] = {}
    if clocked:
        directions["CLK"] = "input"
        connections["CLK"] = [_CLK_BIT]
        parameters["CLK_POLARITY"] = _ONE_WIDE
    cell: dict[str, Any] = {
        "type": cell_type,
        "parameters": parameters,
        "connections": connections,
    }
    if shaped:
        cell["port_directions"] = directions
    return cell


def test_an_unflattened_module_instance_refuses_the_whole_design(tmp_path: Path) -> None:
    """Requirement 1.13: a type not beginning with ``$`` is a structure we did not elaborate.

    THE DIRECTION IS THE WHOLE CLAIM. The alternative is not "a slightly worse answer": a
    submodule's internals were never elaborated, so a register inside it is invisible, and
    crossing the instance as ordinary logic reports every output behind it as
    ``combinational`` - the one error this feature exists to remove.

    The refusal is DESIGN-level and carries no ports list, because which cones this instance
    sits in is exactly what not having elaborated it leaves undecidable.
    """
    netlist = _netlist({"u_full_adder": _cone_cell("full_adder")}, _CONE_PORTS)

    assert _timing_finding(tmp_path, netlist) == {
        "derived": False,
        "cause": "module-instance",
    }


def test_a_clocked_cell_outside_the_named_set_refuses_the_whole_design(tmp_path: Path) -> None:
    """Requirement 1.13: a ``CLK``-bearing type the retained-state set does not name refuses.

    ``$dffsr`` is a REAL Yosys cell type - a flop with both set and clear - that the ten named
    types do not cover, so the fixture is a shape Yosys can write rather than an invented one.

    Measured as EMPTY over the corpus: the named ten are every clocked cell Yosys 0.66
    produces for it, so this is a GUARD against an unseen design or a future Yosys rather than
    a live branch. It still earns its place, because the failure it prevents is silent: an
    unnamed boundary is CROSSED, and crossing a flop reports a registered port as
    ``combinational``.
    """
    netlist = _netlist({"ff": _cone_cell("$dffsr", clocked=True)}, _CONE_PORTS)

    assert _timing_finding(tmp_path, netlist) == {
        "derived": False,
        "cause": "unrecognized-clocked-cell",
    }


def test_a_cell_with_no_port_directions_refuses_the_whole_design(tmp_path: Path) -> None:
    """Requirement 1.13: a shape we could not read is not evidence, so it refuses by name.

    Before this guard the same netlist still refused, but through the WRONG CAUSE: a cell
    contributing no driver left its output bit reading as ``undriven``, which is a claim about
    the DESIGN - this port has an unconnected bit - made on the strength of a claim about our
    READER. The two facts reach a student as different sentences, so they must not share a
    channel.
    """
    netlist = _netlist({"logic": _cone_cell("$add", shaped=False)}, _CONE_PORTS)

    assert _timing_finding(tmp_path, netlist) == {
        "derived": False,
        "cause": "cell-shape-unreadable",
    }


def test_a_refusal_carries_the_bare_cause_and_never_the_offending_cell_name(
    tmp_path: Path,
) -> None:
    """Requirement 2.5: the refusal carries declared names and a cause token, nothing else.

    A Yosys cell name is not a neutral identifier - it embeds the SOURCE PATH and LINE it was
    generated from - so naming the offending cell would leak the design's source through the
    one field whose job is to say we could not read it. Asserted rather than commented,
    because "we just don't add it" is not a property anything checks.

    The equality pins the whole object, so a later field carrying a diagnostic, a path, or a
    port list fails here; the substring check states the specific leak the cause token exists
    to avoid.
    """
    netlist = _netlist({_SOURCE_BEARING_CELL_NAME: _cone_cell("full_adder")}, _CONE_PORTS)

    timing = _timing_finding(tmp_path, netlist)

    assert timing == {"derived": False, "cause": "module-instance"}
    assert _SOURCE_BEARING_CELL_NAME not in json.dumps(timing)


@pytest.mark.parametrize(
    ("design", "top_module"),
    [
        (_ADDER_8BIT, f"verified_{_ADDER_8BIT}"),
        (_TRAFFIC_LIGHT, f"verified_{_TRAFFIC_LIGHT}"),
        (_ROM, _ROM),
    ],
)
def test_no_structural_guard_refuses_a_real_netlist(
    tmp_path: Path, design: str, top_module: str
) -> None:
    """Every COMMITTED reference netlist still DERIVES: the guards do not refuse the corpus.

    The regression this exists for is `cell-shape-unreadable` over-firing on ``adder_8bit``,
    whose eight ``$scopeinfo`` cells carry an EMPTY ``port_directions`` - a cell type with no
    output pin at all, which is a fact about that type rather than an unreadable shape. A
    guard keyed on "no pins" rather than "no readable dict" refuses this design and, with it,
    every flattened hierarchy in the corpus.

    ``ROM`` is here for the memory arm: its shape parameters must READ, or the asynchronous
    rule the ``dout`` claim above depends on would never be reached.
    """
    timing = _timing_finding(tmp_path, _reference_netlist(design), top_module)

    assert timing["derived"] is True
    assert "cause" not in timing
    assert timing["ports"]
