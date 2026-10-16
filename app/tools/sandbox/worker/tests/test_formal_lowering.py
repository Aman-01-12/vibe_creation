"""Tests for the formal lowering sequence, the four solver checks, and the report.

Covers the worker half of the formal oracle: the one Yosys script it emits, the FOUR
``yosys-smtbmc`` invocations it issues, the ``-s z3`` audit it re-runs over any one of
those that reported a proof, the counterexample trace each one dumps and where that
trace is registered, the payload values it refuses to put on a command line at all, and
the assertion count it reports unconditionally.

WHAT IS PINNED AS A LITERAL AND WHAT IS READ FROM THE MODULE. Every wire value - the
argv tokens, the solver names, the trace filenames, the check names, the passes of the
lowering sequence - is spelled out here as an independent copy, because a pin written in
terms of the constant it is pinning asserts only that the constant equals itself. The
two payload BOUNDS are the exception and are imported (:data:`contract.MAX_PROOF_DEPTH`
and the identifier rule), because there the claim is that the worker applies the seam's
own rule rather than a second copy of it.

The toolchain is stubbed with a fake :class:`CommandRunner` following the conventions
of ``_FakeEdaRunner`` in ``test_worker_report.py`` - same protocol, same
:class:`CompletedCommand` construction, same "the fake enforces neither bound" note -
so these run with neither Yosys nor ``yosys-smtbmc`` installed. It is a separate fake
rather than a subclass of that one because it stubs a different toolchain, and because
every assertion about a REFUSED job is an assertion about what was never invoked, which
needs the argv recorded.

WHY A REFUSAL IS ASSERTED AS ZERO INVOCATIONS AND NOT AS A NON-ZERO EXIT. A failed
Yosys run also exits non-zero with no artifact, so the exit code alone cannot tell a
refusal from a failure. "Refused before any command is built" is a claim about the
runner having been handed nothing, so that is what is asserted.
"""

from __future__ import annotations

import ast
import dataclasses
import inspect
import itertools
import json
import string
from collections.abc import Iterator, Mapping
from pathlib import Path

import pytest

from tool_runner_worker import eda
from tool_runner_worker.commands import (
    COMMAND_NOT_FOUND_EXIT,
    CommandRunner,
    CompletedCommand,
)
from tool_runner_worker.contract import (
    MAX_PROOF_DEPTH,
    FormalRequest,
    ResourceLimits,
    SandboxJob,
    SourceFile,
)
from tool_runner_worker.eda import formal
from tool_runner_worker.worker import run_job

#: The wire names this suite pins. Spelled as literals rather than imported from
#: :mod:`tool_runner_worker.eda`, because a test that mirrors the constant it is
#: checking asserts only that the constant equals itself.
_SMT2_FILE = "out.smt2"
_REPORT_FILE = "formal-report.json"
_DESIGN_FILE = "design.v"
_INJECTED_FILE = "INJECTED.v"

#: A source path crafted to close the Yosys ``-p`` script's ``read_verilog`` command
#: early and start a second one. Measured in this workspace against Yosys 0.66; see
#: ``chipAgent/_inbox/gotcha-yosys-p-script-is-an-injection-channel-for-source-filenames.md``.
_INJECTING_FILE = f"{_DESIGN_FILE}; write_verilog {_INJECTED_FILE}"

#: The complete Lowering_Sequence Requirement 3.1 pins, in the order it must run. The
#: four in the middle are the ones Requirement 3.3 forbids any code path from omitting;
#: the frontend and the writer bracket them, so the order asserted over this tuple is the
#: order inside one complete lowering rather than four loose tokens.
_LOWERING_SEQUENCE = (
    "read_verilog -sv -formal",
    "prep -top",
    "memory_map -rom-only -keepdc",
    "async2sync",
    "dffunmap",
    "chformal -lower",
    "write_smt2 -wires",
)

#: The pass Requirement 14.13 forbids the Lowering_Sequence from holding. It belongs to
#: the Reset_Contract_Prepass, which runs over the candidate design ALONE and so cannot
#: affect the SMT2 the proof is taken over - which is why its absence here is a pin and
#: not an omission. BOTH halves of that requirement are asserted together in
#: :func:`test_only_the_two_known_yosys_scripts_exist_in_the_module`: absent from the
#: lowering, and PRESENT in the pre-pass, where it is what recovers a synchronous reset.
_FORBIDDEN_LOWERING_PASS = "opt_dff -sat"

#: The solver every invocation names explicitly (Requirement 4.14), and the one a
#: ``PROVED``-shaped result is re-run under as the Solver_Cross_Check (Requirement 4.15).
_SOLVER = "bitwuzla"
_CROSS_CHECK_SOLVER = "z3"

#: ``yosys-smtbmc``'s counterexample-trace flag and the filename one invocation dumps to,
#: keyed by check AND by solver so no invocation can overwrite another's trace.
_DUMP_VCD_FLAG = "--dump-vcd"
_TRACE_FILE = "formal-trace-{check}-{solver}.vcd"

#: The artifact key a refutation travels through: ``refutation()`` on the TypeScript side
#: reads ``result.artifacts['vcd']``, so this name is a channel rather than a preference.
_VCD_KEY = "vcd"
_REPORT_KEY = "formalReport"

#: The name of the BASE CASE, whose distinguishing feature is an ABSENCE: plain BMC
#: carrying neither ``-c`` nor ``-i`` (Requirement 4.9).
_BASE_CHECK = "base"

#: The FOUR checks in the order they are run, each with the flags that identify it on a
#: command line. The base case's tuple is EMPTY, which is the whole of what makes it the
#: base case, and is why the four expected argvs below differ in length.
_CHECKS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("presat", ("--presat",)),
    (_BASE_CHECK, ()),
    ("cover", ("-c",)),
    ("induct", ("-i",)),
)

_DEPTH = 20
_TOP = "property_wrapper"

#: THE FOUR MAIN INVOCATIONS, END TO END. Written as command lines rather than as argv
#: lists so a reader can hold them beside what ``yosys-smtbmc`` would actually be run with,
#: and compared token by token at the assertion so nothing is lost by the rendering.
#:
#: THE BASE CASE IS THE LINE THAT READS ODDLY, AND IT IS MEANT TO. It is the only one with
#: nothing between its solver and its ``--dump-vcd``, which is Requirement 4.9's "carrying
#: neither ``-i`` nor ``-c``" made visible rather than described - and that absence is what
#: separates a real unbounded proof from the false ``PASSED`` that ``-i`` alone reports.
#:
#: The depth is spelled ``20`` to match :data:`_DEPTH`; the assertion ties the two, so a
#: changed ``_DEPTH`` fails as a depth mismatch rather than as an opaque argv diff.
_EXPECTED_MAIN_COMMANDS = (
    "yosys-smtbmc -s bitwuzla --presat --dump-vcd formal-trace-presat-bitwuzla.vcd -t 20 out.smt2",
    "yosys-smtbmc -s bitwuzla --dump-vcd formal-trace-base-bitwuzla.vcd -t 20 out.smt2",
    "yosys-smtbmc -s bitwuzla -c --dump-vcd formal-trace-cover-bitwuzla.vcd -t 20 out.smt2",
    "yosys-smtbmc -s bitwuzla -i --dump-vcd formal-trace-induct-bitwuzla.vcd -t 20 out.smt2",
)


def _sequence_positions(script: str) -> list[int]:
    """Where each pass of :data:`_LOWERING_SEQUENCE` sits in ``script``.

    An absent pass is reported as its own failure NAMING the pass, because
    ``str.index`` raising ``ValueError`` would say only that something was not found.
    """
    missing = [pass_name for pass_name in _LOWERING_SEQUENCE if pass_name not in script]
    assert missing == [], f"the lowering script omits: {missing}"
    return [script.index(pass_name) for pass_name in _LOWERING_SEQUENCE]


def _check_of(argv: list[str]) -> str:
    """Which check an invocation is, read off its FLAGS the way ``_parse_check`` does.

    The base case is what is left when no other check's flag is present, so this answers
    correctly for an invocation carrying none rather than needing a sentinel for it.
    """
    named = [name for name, flags in _CHECKS if flags and flags[0] in argv]
    return named[0] if named else _BASE_CHECK


def _issued(calls: list[list[str]]) -> list[tuple[str, str]]:
    """Every ``yosys-smtbmc`` invocation as a ``(check, solver)`` pair, in order.

    The solver is read from the token after ``-s``, so this cannot be computed at all for
    an invocation that omitted ``-s`` - the shape Requirement 4.14 forbids, and which
    :func:`test_every_invocation_names_its_solver_explicitly` pins as itself.
    """
    return [
        (_check_of(argv), argv[argv.index("-s") + 1]) for argv in calls if argv[0] == "yosys-smtbmc"
    ]


#: The bounds every invocation in this suite is given. Carried, not enforced: see
#: :func:`_captured`.
_TIMEOUT_S = 5.0
_DISK_LIMIT_BYTES = 64 * 1024 * 1024

#: The THREE measured replies a ``yosys-smtbmc -c`` invocation can give, which is one more
#: than the report used to be able to express. The step in the reached form is
#: ``counter_12``'s ``out == 11``, reached at 13.
#:
#: The third is not a contrivance: it is the measured shape of a ``-c`` run in which an
#: assert failed on the covering path before the cover analysis reported anything, so the
#: output carries a failing STEP and NO cover line at all - and that run answered the
#: reachability question with nothing. The reached and unreached forms both ANSWER it, the
#: second in the negative, which is why one flag covers the first two and excludes the third.
#:
#: The third also pins the negative half of Requirement 1.15: ``step 1`` on an
#: ``Assert failed`` line is NOT a cover step and must not be read as one, which is exactly
#: what :data:`eda._COVER_STEP_RE` being anchored on the cover line buys.
_REACHED_COVER_STDOUT = "Reached cover statement in step 13 at 1\nStatus: PASSED\n"
_UNREACHED_COVER_STDOUT = "Unreached cover statement in top.\nStatus: FAILED\n"
_SILENT_COVER_STDOUT = "Assert failed in top: step 1\nStatus: FAILED\n"


def _captured(exit_code: int, stdout: str = "", stderr: str = "") -> CompletedCommand:
    """Build a fake capture. Every bound flag is False: this fake enforces none.

    The wall clock is enforced by the runtime that spawned the worker and the
    workspace cap by the real runner's pump loop; both are asserted against the REAL
    runner in ``test_command_capture_bounds.py``.
    """
    return CompletedCommand(
        exit_code,
        stdout,
        stderr,
        stdout_truncated=False,
        stderr_truncated=False,
        disk_limit_exceeded=False,
    )


class _RecordingYosysRunner(CommandRunner):
    """A fake Yosys / ``yosys-smtbmc`` toolchain that records every argv it is handed.

    Two MEASURED Yosys behaviours are modelled deliberately, because without them the
    injection test below would pass for the wrong reason:

    - The ``-p`` argument is a semicolon-separated command list Yosys splits ITSELF, so
      a ``write_verilog <file>`` appearing anywhere inside it writes that file.
    - ``read_verilog`` aborts the whole script when a file it names does not resolve,
      which is why the injection needs a SECOND, legitimately-named file: with only the
      crafted name present the leading token does not resolve, Yosys aborts, and the
      injected command never runs.

    ``writes_smt2=False`` models the other measured shape: a lowering that exits
    without producing an SMT2 for the checks to solve.

    ``refuting_checks`` names the checks that report ``Status: FAILED`` and DUMP the trace
    they were asked for; every other check reports ``Status: PASSED`` and writes NO trace
    at all, which is the measured shape of a proof and the reason the trace is registered
    opportunistically rather than required. The default - nothing refutes - is the
    all-proved run every pre-existing test in this file was written against.

    ``cover_stdout`` is the whole reply a ``-c`` invocation gives, defaulting to the measured
    reached shape. It is a whole string rather than a pair of booleans because the three
    outcomes of the cover analysis differ ONLY in their stdout - reached at a step, answered
    ``Unreached cover statement``, or printed neither line - and those three are what
    ``cover_answered`` exists to tell apart, so the knob is the text itself.
    """

    def __init__(
        self,
        *,
        writes_smt2: bool = True,
        refuting_checks: frozenset[str] = frozenset(),
        cover_stdout: str = _REACHED_COVER_STDOUT,
    ) -> None:
        self.calls: list[list[str]] = []
        self._writes_smt2 = writes_smt2
        self._refuting_checks = refuting_checks
        self._cover_stdout = cover_stdout

    def run(
        self, argv: list[str], cwd: Path, timeout_s: float, disk_limit_bytes: int
    ) -> CompletedCommand:
        _ = (timeout_s, disk_limit_bytes)
        self.calls.append(list(argv))
        if argv[0] == "yosys":
            return self._yosys(argv, cwd)
        if argv[0] == "yosys-smtbmc":
            return self._smtbmc(argv, cwd)
        return _captured(COMMAND_NOT_FOUND_EXIT, stderr=f"unknown tool: {argv[0]}")

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
        if self._writes_smt2:
            (cwd / _SMT2_FILE).write_text("(assert a)\n(assert b)\n", encoding="utf-8")
        return _captured(0)

    def _smtbmc(self, argv: list[str], cwd: Path) -> CompletedCommand:
        """Reply in the shapes ``_parse_check`` parses: status, cover step, induction.

        A refuting check writes the ``--dump-vcd`` target it was handed, which is the only
        behaviour that leaves a counterexample for the artifact map to pick up; a passing
        one writes nothing, so the absence of a trace is modelled rather than assumed.
        """
        if _check_of(argv) in self._refuting_checks:
            (cwd / argv[argv.index(_DUMP_VCD_FLAG) + 1]).write_text(
                "$enddefinitions $end\n", encoding="utf-8"
            )
            return _captured(1, stdout="Assert failed in top: step 1\nStatus: FAILED\n")
        if "-c" in argv:
            return _captured(0, stdout=self._cover_stdout)
        if "-i" in argv:
            return _captured(0, stdout="Temporal induction successful.\nStatus: PASSED\n")
        return _captured(0, stdout="Status: PASSED\n")


def _write_design(workspace_root: Path, *names: str) -> list[str]:
    """Write a trivial module under each name and return the names as relpaths."""
    for name in names:
        (workspace_root / name).write_text("module top; endmodule", encoding="utf-8")
    return list(names)


def _formal_job(*files: SourceFile, formal_request: FormalRequest | None) -> SandboxJob:
    """A ``formal`` job carrying ``files`` and (optionally) a formal payload."""
    return SandboxJob(
        kind="formal",
        workspace_files=list(files),
        limits=ResourceLimits(cpu=1.0, mem_mb=256, procs=32, disk_mb=64, wall_ms=5000),
        required_outputs=["stdout", "stderr", "exitCode", "formalReport"],
        formal=formal_request,
    )


def _source(path: str) -> SourceFile:
    return SourceFile(path=path, contents="module top; endmodule")


def _run_formal(
    workspace_root: Path,
    runner: CommandRunner,
    source_relpaths: list[str],
    request: FormalRequest,
) -> eda.EdaCapture:
    """Drive ``eda.formal`` with this suite's fixed bounds."""
    return formal(workspace_root, source_relpaths, request, runner, _TIMEOUT_S, _DISK_LIMIT_BYTES)


def _report(workspace_root: Path) -> dict[str, object]:
    with (workspace_root / _REPORT_FILE).open(encoding="utf-8") as handle:
        loaded: dict[str, object] = json.load(handle)
    return loaded


def test_the_lowering_emits_the_whole_sequence_in_order(tmp_path: Path) -> None:
    """Requirement 3.1: the emitted script carries the complete sequence, in order.

    ``memory_map -rom-only -keepdc`` is pinned IN ITS MEASURED POSITION - after ``prep``
    and before ``async2sync`` - rather than merely as present. It is the one pass in this
    sequence that joined on a no-regression measurement rather than on a tool error
    message of its own, so it is also the one whose displacement nothing else would
    notice: the other three abort the run or empty the SMT2 when they are wrong, and this
    one would just quietly stop repairing the ROM shape it was added for.
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    lowering = runner.calls[0]
    assert lowering[:2] == ["yosys", "-p"]
    script = lowering[2]
    positions = _sequence_positions(script)
    assert positions == sorted(positions)
    # The substituted `-top` and `-flatten` are pinned here rather than in the sequence
    # tuple, because only the emitted script carries the substitution at all.
    assert f"prep -top {_TOP} -flatten" in script
    assert f"write_smt2 -wires {_SMT2_FILE}" in script


def test_the_lowering_holds_no_opt_dff_sat_pass(tmp_path: Path) -> None:
    """Requirement 14.13: the pass that recovers a synchronous reset stays out of here.

    ``opt_dff -sat`` is what the Reset_Contract_Prepass runs to derive a reset polarity,
    and it runs there over the candidate design ALONE for exactly this reason: a pass that
    rewrites flip-flop cells must not reach the SMT2 the proof is taken over, or the
    property would be proved against a design the pass reshaped. The pre-pass suite
    asserts the pass IS present in its own script; this is the other half of that pin.

    Asserted over the EMITTED argv rather than over ``YOSYS_FORMAL_SCRIPT``, because the
    command line is what Yosys would act on, and a pass appended after formatting would
    satisfy a pin on the constant alone.
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    assert _FORBIDDEN_LOWERING_PASS not in runner.calls[0][2]
    assert "opt_dff" not in runner.calls[0][2]


def _non_docstring_str_literals(tree: ast.Module) -> list[str]:
    """Every ``str`` literal in the module except the docstrings.

    Comments are absent from the AST already, so excluding docstrings leaves exactly
    the strings the module can put on a command line.
    """
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Module | ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
        and isinstance(node.body[0].value.value, str)
    }
    return [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


def test_only_the_two_known_yosys_scripts_exist_in_the_module() -> None:
    """Requirements 3.3, 14.12, 14.13: neither Yosys script can be assembled wrongly.

    HOW THIS IS STRUCTURAL rather than a restatement of the test above. Each complete
    Yosys sequence lives in ONE module-level string constant, so the only way to emit a
    lowering with a pass missing is to spell another script somewhere. This walks
    ``eda.py``'s own AST and counts, across every non-docstring string literal in the
    module, how many times a Yosys FRONTEND call and an SMT2 WRITE appear. There are
    exactly two of each, one per script, so a hand-built third script path fails here -
    which the single-call assertion above would not notice.

    RE-PINNED, deliberately, for the Reset_Contract_Prepass: this module now emits TWO
    Yosys scripts rather than one, because the pre-pass is a SECOND invocation over the
    candidate design ALONE and cannot be a step inside the ``formal`` kind
    (Requirement 14.11). The old form asserted exactly ONE script literal and therefore
    failed by construction once the second script landed, and that failure was the point
    rather than a problem: the count is what stops a script arriving unnoticed.

    COUNTED OVER OCCURRENCES RATHER THAN OVER LITERALS, which also closes the hole the
    previous version's own docstring admitted it could not see: a script spelled as
    several adjacent literals, or concatenated around a filename constant, used to escape
    a literal count entirely. Both scripts here are built that way.

    WHAT IT DOES NOT COVER, stated rather than implied: a Yosys script assembled in a
    DIFFERENT module is outside this assertion's reach. ``eda.py`` is the only module in
    the worker that invokes Yosys today.
    """
    source_path = Path(eda.__file__)
    literals = _non_docstring_str_literals(ast.parse(source_path.read_text(encoding="utf-8")))
    scripts = "\n".join(text for text in literals if "read_verilog" in text or "write_smt2" in text)

    # TWO Yosys scripts and no third: the Lowering_Sequence and the Reset_Contract_Prepass.
    assert scripts.count("read_verilog") == 2
    assert scripts.count("write_smt2") == 2

    # The Lowering_Sequence carries every pass in order, checked against this suite's own
    # independent copy of the sequence rather than against the constant's own spelling.
    positions = _sequence_positions(eda.YOSYS_FORMAL_SCRIPT)
    assert positions == sorted(positions)

    # THE TWO HALVES OF REQUIREMENT 14.13, IN ONE PLACE so a reader who finds either finds
    # both: the pass that recovers a synchronous reset is ABSENT from the lowering, so it
    # cannot affect the SMT2 the proof is taken over, and PRESENT in the pre-pass, where it
    # is load-bearing - under plain ``prep`` the derivation is 29 of 31 and the two failures
    # are exactly the sync-reset designs.
    assert _FORBIDDEN_LOWERING_PASS not in eda.YOSYS_FORMAL_SCRIPT
    assert _FORBIDDEN_LOWERING_PASS in eda.YOSYS_PREPASS_SCRIPT


def test_the_four_checks_are_issued_with_their_flags_at_the_requested_depth(
    tmp_path: Path,
) -> None:
    """Requirements 4.9, 4.14, 12.18: FOUR main invocations, spelled out end to end.

    The expected shapes are :data:`_EXPECTED_MAIN_COMMANDS`, written out in full rather
    than built from a template, because the shape itself is the claim. The base case's
    presence is what separates a genuine unbounded proof from the false ``PASSED`` that
    ``-i`` alone reports for ``initial out = 4'd15`` against ``out <= 11``.

    Filtered to the MAIN solver, because an all-proved run also issues the ``-s z3``
    audit of each one; the audit's own pins are the two cross-check tests below.
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    main = [argv for argv in runner.calls if argv[0] == "yosys-smtbmc" and _SOLVER in argv]
    # Compared TOKEN BY TOKEN - `split()` renders each expected command line back into the
    # argv it must be issued as - so a token that gained an embedded space would still fail.
    assert main == [command.split() for command in _EXPECTED_MAIN_COMMANDS]
    # The pin above spells `-t 20` out as a literal; this is what makes it a pin on the
    # REQUESTED depth rather than on a number that happens to match one.
    assert all(argv[argv.index("-t") + 1] == str(_DEPTH) for argv in main)


def test_every_invocation_names_its_solver_explicitly(tmp_path: Path) -> None:
    """Requirement 4.14: no ``yosys-smtbmc`` invocation may omit ``-s``.

    NOT A STYLE POINT. ``yosys-smtbmc``'s default ``-s`` is ``yices``, ``yices`` is not
    installed, so an invocation that omits ``-s`` is BROKEN rather than defaulted - and it
    would fail as a missing binary, which classifies as ``toolchain-unavailable`` rather
    than as the wrong-solver mistake it actually is.

    Asserted over EVERY invocation including the audits, because the cross-check is the
    one place a solver name is not the module default and so the one place an omission
    could hide.
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    smtbmc = [argv for argv in runner.calls if argv[0] == "yosys-smtbmc"]
    assert smtbmc != []
    assert all(argv[1:3] in (["-s", "bitwuzla"], ["-s", "z3"]) for argv in smtbmc)


def test_a_proved_result_is_audited_once_under_the_cross_check_solver(tmp_path: Path) -> None:
    """Requirement 4.15: a ``PROVED``-shaped result is re-run under ``-s z3``, once.

    THE AUDIT IS INTERLEAVED, issued immediately after the check it audits rather than
    batched after all four, and that ordering is pinned because it is what makes the audit
    attributable: the report nests each cross-check under its own check, and a batched tail
    would be reconstructible only by matching flags.

    ONCE, not repeatedly: an audit is not itself audited. A second round would be a
    cross-check of a cross-check, which the report shape makes unrepresentable, and this
    is the behavioural half of that.

    It exists because ``yosys-smtbmc -s bitwuzla`` reaches bitwuzla 0.9.x through a flag
    shim we wrote, and the cheapest audit of a wrapper we wrote is a solver we did not.
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    assert _issued(runner.calls) == [
        ("presat", "bitwuzla"),
        ("presat", "z3"),
        ("base", "bitwuzla"),
        ("base", "z3"),
        ("cover", "bitwuzla"),
        ("cover", "z3"),
        ("induct", "bitwuzla"),
        ("induct", "z3"),
    ]


def test_a_non_proved_result_is_not_audited(tmp_path: Path) -> None:
    """Requirement 4.15: the audit fires on exactly the path that admits ``proved``.

    The other half of the test above, and the half that says the trigger is the RESULT
    rather than the check: with the base case refuting and the other three passing, seven
    invocations are issued - four main plus three audits - and the refuted one gets none.

    An audit of a refutation would buy nothing the gate could use. A disagreement is only
    meaningful where one solver claims a proof, because that is the only claim the flag
    shim could have manufactured.
    """
    runner = _RecordingYosysRunner(refuting_checks=frozenset({_BASE_CHECK}))
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    issued = _issued(runner.calls)
    assert issued == [
        ("presat", "bitwuzla"),
        ("presat", "z3"),
        ("base", "bitwuzla"),
        ("cover", "bitwuzla"),
        ("cover", "z3"),
        ("induct", "bitwuzla"),
        ("induct", "z3"),
    ]
    assert ("base", "z3") not in issued


def test_every_invocation_dumps_to_a_trace_path_of_its_own(tmp_path: Path) -> None:
    """Requirement 12.18: each invocation gets its own ``--dump-vcd`` target.

    WHY DISTINCTNESS IS LOAD-BEARING rather than tidy. One shared path would let a later
    check overwrite an earlier one's trace, and the base case's trace is the only one a
    refutation can be sourced from - so a cover check running after it would destroy the
    counterexample the verdict rests on. The audit needs its own file for the same reason
    from the other direction: a DISAGREEING ``-s z3`` re-run must not overwrite the
    bitwuzla trace it disagrees with, because the point of the audit is to report both
    results rather than reconcile them.
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    targets = [
        argv[argv.index(_DUMP_VCD_FLAG) + 1] for argv in runner.calls if argv[0] == "yosys-smtbmc"
    ]
    assert len(targets) == 8
    assert len(set(targets)) == len(targets)
    assert set(targets) == {
        _TRACE_FILE.format(check=check, solver=solver)
        for check, _ in _CHECKS
        for solver in (_SOLVER, _CROSS_CHECK_SOLVER)
    }


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
    """Requirement 11.10: a top module that is not a plain identifier builds nothing."""
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_formal(
        tmp_path, runner, sources, FormalRequest(top_module=top_module, depth=_DEPTH)
    )

    assert runner.calls == []
    assert capture.exit_code != 0
    assert capture.artifacts == {}
    # The refusal names the rule and never echoes the rejected value.
    assert capture.stderr == "formal topModule is not a plain Verilog identifier"


@pytest.mark.parametrize(
    "depth",
    [
        pytest.param(0, id="zero"),
        pytest.param(-1, id="negative"),
        pytest.param(MAX_PROOF_DEPTH + 1, id="one-over-the-ceiling"),
        pytest.param(2**62, id="absurd"),
    ],
)
def test_a_depth_outside_the_ceiling_is_refused_before_any_command(
    tmp_path: Path, depth: int
) -> None:
    """Requirement 11.10: the proof depth is bounded on both sides before ``-t``.

    THE CEILING HAS NO OTHER SITE. The seam schema bounds ``depth`` below and not
    above, so :data:`contract.MAX_PROOF_DEPTH` is the only upper bound on it anywhere,
    and this is the only thing holding it.
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=depth))

    assert runner.calls == []
    assert capture.exit_code != 0
    assert capture.artifacts == {}
    assert capture.stderr == f"formal depth is outside 1..{MAX_PROOF_DEPTH}"


def test_a_source_path_carrying_a_semicolon_is_refused_before_any_command(
    tmp_path: Path,
) -> None:
    """Requirement 11.10: a filename the Yosys script grammar would reinterpret.

    Driven through ``run_job`` rather than ``eda.formal`` directly, because the whole
    chain is the claim: path confinement ACCEPTS this name (it is relative, has no
    traversal, and resolves inside the workspace), so it is written, becomes a source
    relpath, and reaches the script assembly. Confinement bounds where a job may write,
    not what a filename may say.

    TWO FILES, which is what the measurement required: the crafted name's leading token
    is ``design.v``, so a real ``design.v`` has to exist for ``read_verilog`` to resolve
    it and carry on into the injected command. The fake models that abort, and
    ``test_the_fake_reproduces_the_measured_injection_only_with_two_files`` below pins
    both halves of it, so this refusal is not passing because the fake is inert.
    """
    runner = _RecordingYosysRunner()

    report = run_job(
        _formal_job(
            _source(_DESIGN_FILE),
            _source(_INJECTING_FILE),
            formal_request=FormalRequest(top_module=_TOP, depth=_DEPTH),
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
    # Both files were materialized, so the refusal is the script guard's and not a
    # confinement denial in disguise.
    assert (tmp_path / _INJECTING_FILE).is_file()


def test_the_fake_reproduces_the_measured_injection_only_with_two_files(
    tmp_path: Path,
) -> None:
    """The fake's own fidelity check: the guard above refuses a REAL injection.

    Without this the refusal test could pass against a fake that never honoured a
    ``write_verilog`` at all. Handed the script the unguarded code would have built,
    the fake writes the injected file when two files are present and does NOT when only
    the crafted name is - which is the measured trap the vault note records, and the
    reason a single-file case would have cleared this as a non-issue.
    """
    two_files = tmp_path / "two"
    one_file = tmp_path / "one"
    for workspace in (two_files, one_file):
        workspace.mkdir()
    _write_design(two_files, _DESIGN_FILE, _INJECTING_FILE)
    _write_design(one_file, _INJECTING_FILE)
    script = eda.YOSYS_FORMAL_SCRIPT.format(sources=_INJECTING_FILE, top=_TOP)

    for workspace in (two_files, one_file):
        _RecordingYosysRunner().run(
            ["yosys", "-p", script], workspace, _TIMEOUT_S, _DISK_LIMIT_BYTES
        )

    assert (two_files / _INJECTED_FILE).is_file()
    assert not (one_file / _INJECTED_FILE).exists()


def test_a_missing_smt2_reports_an_assertion_count_of_zero(tmp_path: Path) -> None:
    """Requirement 2.8: an unwritten SMT2 counts zero, and the field is still there.

    An ABSENT count would let the TypeScript guard read "no count" as "guard passed",
    which is the one silent failure the count exists to catch. So the count is present
    and zero, and all FOUR checks are present with no exit code rather than omitted -
    a check that could not run stays distinguishable from one that passed.
    """
    runner = _RecordingYosysRunner(writes_smt2=False)
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    payload = _report(tmp_path)
    assert "assertionCount" in payload
    assert payload["assertionCount"] == 0
    checks = payload["checks"]
    assert isinstance(checks, dict)
    assert set(checks) == {"presat", "base", "cover", "induct"}
    assert all(check["exitCode"] is None for check in checks.values())
    # And no STATUS either, which is the half that makes "never mistakable for a pass"
    # true rather than merely intended: the TypeScript side derives its verdict from the
    # parsed `Status:` string, so a check that never ran reporting `PASSED` here would be
    # a proof of a property no solver ever looked at.
    assert all(check["status"] is None for check in checks.values())
    # And no cover answer, for the same reason one step further on: `coverAnswered: false`
    # here would be a cover analysis reporting that it ran and answered nothing, where the
    # truth is that it never ran. The field is ABSENT, and the TypeScript gate reads an
    # absent field and a `false` one the same fail-safe way.
    assert "coverAnswered" not in checks["cover"]
    # No SMT2 to solve, so the lowering was the only invocation.
    assert [call[0] for call in runner.calls] == ["yosys"]


def test_a_written_smt2_reports_the_counted_assertions(tmp_path: Path) -> None:
    """Requirement 2.7: the count is recorded on a run that PASSED the guard too.

    The positive half of the test above: without it, a report that always said zero
    would satisfy the missing-file case and say nothing about the guard working.
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    assert _report(tmp_path)["assertionCount"] == 2


def test_the_cover_step_and_the_induction_success_are_reported_where_they_apply(
    tmp_path: Path,
) -> None:
    """Requirement 5.5: a reached cover records the STEP it was reached at.

    THE ONLY THING PINNING EITHER FIELD. ``_parse_check`` extracts the step with
    ``_COVER_STEP_RE`` and ``max(steps)``, and the induction success by looking for
    ``Temporal induction successful`` - and until this test, nothing asserted that
    either value ever reached the report. A mutation to the capture group, to the
    ``max``, or to the flag the fields are gated on would have kept the whole Python
    gate green while silently emitting no step, and the TypeScript side reads a reached
    cover BY the presence of that step: with it gone, every proved property would have
    reported ``antecedent-unreached`` instead.

    Both fields are also asserted to appear on ONLY the check that can carry them, which
    is the other half of ``as_dict``'s contract: the field's presence is information, so
    a ``reachedStep`` on the presat check would be a report the reader cannot trust.

    ``coverAnswered`` is pinned here on the same terms - cover check only, and ``True``
    where a cover line was printed. The case where it carries ``False`` is its own test
    below, because that is the value the field was added for.

    The numbers come from this suite's fake toolchain, which replies in the shapes the
    probe measured (``Reached cover statement in step 13``, from ``counter_12``'s
    ``out == 11``, and ``Temporal induction successful``).
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    checks = _report(tmp_path)["checks"]
    assert isinstance(checks, dict)
    assert checks["cover"]["reachedStep"] == 13
    assert checks["cover"]["coverAnswered"] is True
    assert checks["induct"]["inductionSuccessful"] is True
    assert "reachedStep" not in checks["presat"]
    assert "reachedStep" not in checks["induct"]
    assert "inductionSuccessful" not in checks["presat"]
    assert "inductionSuccessful" not in checks["cover"]
    assert "coverAnswered" not in checks["presat"]
    assert "coverAnswered" not in checks[_BASE_CHECK]
    assert "coverAnswered" not in checks["induct"]


@pytest.mark.parametrize(
    ("cover_stdout", "answered", "has_step"),
    [
        (_REACHED_COVER_STDOUT, True, True),
        (_UNREACHED_COVER_STDOUT, True, False),
        (_SILENT_COVER_STDOUT, False, False),
    ],
)
def test_the_cover_reports_whether_it_answered_reachability_at_all(
    tmp_path: Path, cover_stdout: str, answered: bool, has_step: bool
) -> None:
    """Requirement 5.12: an UNANSWERED reachability question is not an unreached antecedent.

    THE STEP CANNOT CARRY THIS AND THAT IS THE WHOLE REASON THE FIELD EXISTS. Rows two and
    three below both report NO ``reachedStep``, so before ``cover_answered`` they were the
    SAME DOCUMENT - and they are opposite facts. Row two is an antecedent the analysis
    reached a verdict on and says is not reachable within the depth, which the TypeScript
    gate reports as ``antecedent-unreached``, a finding about the property. Row three is an
    analysis that said nothing, which is a gap in our instrument and must report
    ``toolchain-unavailable`` instead.

    The ``-c`` mode ``Status:`` string cannot separate them either, in either direction:
    rows two and three BOTH report ``FAILED``, and row one reports ``PASSED`` beside a
    reached cover while a real run can report ``FAILED`` beside one - an assert failing on
    the covering path. So the cover LINE is the only signal, it is visible only in the
    stdout ``_parse_check`` holds, and nothing carried it across until this field.

    Row three carries ``Assert failed in top: step 1`` and so pins the negative half of
    Requirement 1.15 in the same breath: that ``step 1`` is NOT a cover step, and a reader
    that took its number would report a cover reached at step 1 on a run whose cover
    analysis said nothing.
    """
    runner = _RecordingYosysRunner(cover_stdout=cover_stdout)
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    checks = _report(tmp_path)["checks"]
    assert isinstance(checks, dict)
    assert checks["cover"]["coverAnswered"] is answered
    assert ("reachedStep" in checks["cover"]) is has_step


def test_the_refuting_base_case_takes_the_vcd_key_and_other_traces_take_their_own(
    tmp_path: Path,
) -> None:
    """Requirement 12.18: where each counterexample trace is registered, and why there.

    THE ``vcd`` KEY IS A CHANNEL, NOT A NAME. ``refutation()`` on the TypeScript side reads
    ``result.artifacts['vcd']``, and the base case is the only check whose counterexample
    can source a refutation - so the base case's trace takes that key and every other trace
    takes its own workspace-relative name. Registering all four under four sibling keys
    would leave ``artifacts['vcd']`` empty and make the verdict ``refuted`` unreachable,
    which is the exact defect this whole trace path exists to close.

    The cover check refutes here alongside the base case ON PURPOSE, and it is a real
    shape rather than a contrivance: in ``-c`` mode ``Status: FAILED`` is reported both for
    an unreached cover and for an assert failing on a covering path. Its trace has to
    survive as evidence WITHOUT competing for the one key the refutation travels through.
    """
    runner = _RecordingYosysRunner(refuting_checks=frozenset({_BASE_CHECK, "cover"}))
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    assert set(capture.artifacts) == {_VCD_KEY, "formal-trace-cover-bitwuzla.vcd", _REPORT_KEY}
    # The key is `vcd`; the FILE under it is the base case's own trace.
    assert capture.artifacts[_VCD_KEY].name == "formal-trace-base-bitwuzla.vcd"
    checks = _report(tmp_path)["checks"]
    assert isinstance(checks, dict)
    assert checks[_BASE_CHECK]["tracePath"] == "formal-trace-base-bitwuzla.vcd"
    assert checks["cover"]["tracePath"] == "formal-trace-cover-bitwuzla.vcd"
    # The two that proved wrote nothing, so they report no trace rather than a path to a
    # file nobody can read.
    assert "tracePath" not in checks["presat"]
    assert "tracePath" not in checks["induct"]


def test_a_run_whose_checks_all_proved_registers_no_trace_at_all(tmp_path: Path) -> None:
    """Requirement 12.18: a proof writes no trace, and that absence is the ordinary shape.

    THE OPPORTUNISTIC HALF, and the reason it cannot be a required output:
    ``missingRequiredOutputs`` forces the WHOLE invocation to ``error`` when a required
    output is absent, so naming the trace as required would classify every successful proof
    as an error - the instrument would fail precisely on the runs it succeeded at.

    ``--dump-vcd`` is still passed on all eight invocations here (pinned above); what is
    asserted is that being asked for a trace and not writing one registers nothing.
    """
    runner = _RecordingYosysRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    capture = _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    assert set(capture.artifacts) == {_REPORT_KEY}
    checks = _report(tmp_path)["checks"]
    assert isinstance(checks, dict)
    assert all("tracePath" not in check for check in checks.values())
    # Every check proved, so every one was audited - and the audits wrote no trace either.
    assert all("crossCheck" in check for check in checks.values())
    assert all("tracePath" not in check["crossCheck"] for check in checks.values())


def test_a_formal_job_with_no_payload_is_refused_honestly(tmp_path: Path) -> None:
    """Requirement 11.10: a ``formal`` kind with no payload invokes nothing.

    There is no default top module or depth to fall back to, so the dispatch refuses
    rather than running - and refuses as itself rather than falling through to the
    unsupported-kind message, which would report a supported kind as unimplemented.
    """
    runner = _RecordingYosysRunner()

    report = run_job(
        _formal_job(_source(_DESIGN_FILE), formal_request=None), tmp_path, runner
    ).as_dict()

    assert runner.calls == []
    assert report["exitCode"] != 0
    assert report["artifacts"] == {}
    assert report["stderr"] == "formal job carries no formal payload"


def test_the_unsupported_synthesize_kind_still_reports_its_own_refusal(tmp_path: Path) -> None:
    """``synthesize`` is still undispatched, and adding a third kind did not change it.

    Guards the fallback branch the formal dispatch was inserted ahead of; see
    ``chipAgent/_inbox/gotcha-worker-synthesize-kind-unimplemented.md``.
    """
    runner = _RecordingYosysRunner()
    job = SandboxJob(
        kind="synthesize",
        workspace_files=[_source(_DESIGN_FILE)],
        limits=ResourceLimits(cpu=1.0, mem_mb=256, procs=32, disk_mb=64, wall_ms=5000),
        required_outputs=["stdout", "stderr", "exitCode"],
    )

    report = run_job(job, tmp_path, runner).as_dict()

    assert runner.calls == []
    assert report["exitCode"] != 0
    assert report["artifacts"] == {}
    assert report["stderr"] == "unsupported job kind: synthesize"


# --- Task 6.8: the structural claims the worker carries --------------------------------------
#
# The Lowering_Sequence, the check list, and the Solver_Cross_Check all live in this worker, so
# the claims task 6.8 makes about them are asserted here. The TypeScript halves are in
# ``app/tools/formal/structural-claims.test.ts``, whose header maps all eight claims, and in
# ``app/tools/formal/adapter.test.ts``.
#
# What the tests above already pin is CITED, not restated: the four main commands on the
# all-proved path (``test_the_four_checks_are_issued_with_their_flags_at_the_requested_depth``),
# the audit on the all-proved and base-refuting paths (``test_a_proved_result_is_audited_once_
# under_the_cross_check_solver``, ``test_a_non_proved_result_is_not_audited``), and the
# opportunistic trace (``test_a_run_whose_checks_all_proved_registers_no_trace_at_all``,
# ``test_the_refuting_base_case_takes_the_vcd_key_and_other_traces_take_their_own``). Each of
# those holds on one or two outcome paths. What follows is the half they leave open: the same
# claims on EVERY path, and the one channel into the script no test above reads.

#: The measured reply of ``yosys-smtbmc -s bitwuzla`` against an UNSHIMMED bitwuzla 0.9.1, which
#: rejects the ``--smt2 -i`` that ``smtio.py`` passes it: exit 1, and NO ``Status:`` line at all.
#: This is Requirement 11.15's present-but-not-invocable path, measured on this machine and
#: recorded in ``chipAgent/_inbox/decision-the-seam-gap-is-closed-by-bounded-content-addressed-
#: retention-in-the-runtime-not-by-widening-the-seam.md``.
_NOT_INVOCABLE_STDOUT = (
    "##   0:00:00  Solver: bitwuzla\n"
    "##   0:00:00  Checking assertions in step 0..\n"
    "##   0:00:00  Unexpected response from solver: [error] invalid option '--smt2'\n"
)

#: Every reply one check can give, CLOSED: the three measured ``Status:`` strings, plus no status
#: line at all, which is :data:`_NOT_INVOCABLE_STDOUT`. Four replies over four checks is 256
#: outcome paths, few enough to EXHAUST rather than sample.
_STATUS_REPLIES: tuple[str | None, ...] = ("PASSED", "FAILED", "PREUNSAT", None)


class _StatusScriptedRunner(_RecordingYosysRunner):
    """The recording toolchain, answering each check with a scripted ``Status:`` reply.

    Both solvers give a check the SAME reply, so every audit agrees with what it audits. What is
    asserted over this fake is which invocations are ISSUED, and the worker issues the same ones
    whether an audit agrees or not, because it compares nothing (``_run_checks``).

    A ``FAILED`` check dumps the trace it was asked for, as the parent does; a ``None`` reply is
    :data:`_NOT_INVOCABLE_STDOUT`.
    """

    def __init__(self, statuses: Mapping[str, str | None]) -> None:
        super().__init__()
        self._statuses = statuses

    def _smtbmc(self, argv: list[str], cwd: Path) -> CompletedCommand:
        status = self._statuses[_check_of(argv)]
        if status is None:
            return _captured(1, stdout=_NOT_INVOCABLE_STDOUT)
        if status == "FAILED":
            (cwd / argv[argv.index(_DUMP_VCD_FLAG) + 1]).write_text(
                "$enddefinitions $end\n", encoding="utf-8"
            )
        return _captured(0 if status == "PASSED" else 1, stdout=f"Status: {status}\n")


class _ProofPrintsACoverLineRunner(_RecordingYosysRunner):
    """Every PROOF invocation prints a reached-cover line; the cover analysis prints neither line.

    No measured proof run prints a cover line. The fake makes every one of them print one so that
    the only thing keeping it out of the vacuity answer is which invocation that answer is read
    from. The cover run's own reply is :data:`_SILENT_COVER_STDOUT`, the measured shape of an
    assert failing on the covering path before the analysis said anything.
    """

    def _smtbmc(self, argv: list[str], cwd: Path) -> CompletedCommand:
        _ = cwd
        if "-c" in argv:
            return _captured(1, stdout=_SILENT_COVER_STDOUT)
        return _captured(
            0,
            stdout=(
                "Reached cover statement in step 13 at 1\n"
                "Temporal induction successful.\n"
                "Status: PASSED\n"
            ),
        )


def _every_outcome() -> Iterator[dict[str, str | None]]:
    """Every assignment of a :data:`_STATUS_REPLIES` member to each of the four checks."""
    names = [name for name, _ in _CHECKS]
    for replies in itertools.product(_STATUS_REPLIES, repeat=len(names)):
        yield dict(zip(names, replies, strict=True))


def _calls_on(workspace_root: Path, statuses: Mapping[str, str | None]) -> list[list[str]]:
    """Every argv one formal run issues against the scripted replies, in a workspace of its own."""
    workspace_root.mkdir()
    runner = _StatusScriptedRunner(statuses)
    sources = _write_design(workspace_root, _DESIGN_FILE)
    _run_formal(workspace_root, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))
    return runner.calls


def test_only_the_sources_and_the_top_module_reach_the_lowering_script() -> None:
    """Requirement 3.3: no job field can carry a pass into the Lowering_Sequence.

    The script is one constant (``test_only_the_two_known_yosys_scripts_exist_in_the_module``) and
    it emits every pass in order (``test_the_lowering_emits_the_whole_sequence_in_order``). Neither
    pins what a JOB can put into it, and three facts together close that: the script's only
    substitution slots are the source list and the top module; ``formal`` receives nothing from the
    job but those sources and its validated ``FormalRequest``; and that request carries the top
    module and the depth and no third field. The two substituted values are refused unless they are
    a plain identifier and a script-safe relpath (the two refusal tests above), so neither can spell
    a command, and the depth reaches ``-t`` alone.

    WHAT THIS CANNOT SEE: text appended to the script after ``format``, which the emitted-argv test
    above reads, and a Yosys invocation assembled outside ``formal``, which the script-count test
    above bounds.
    """
    slots = {
        slot
        for _, slot, _, _ in string.Formatter().parse(eda.YOSYS_FORMAL_SCRIPT)
        if slot is not None
    }

    assert slots == {"sources", "top"}
    assert list(inspect.signature(eda.formal).parameters) == [
        "workspace_root",
        "source_relpaths",
        "request",
        "runner",
        "timeout_s",
        "disk_limit_bytes",
    ]
    assert {field.name for field in dataclasses.fields(FormalRequest)} == {"top_module", "depth"}


def test_every_outcome_path_issues_the_same_four_main_checks_and_no_step_0_check(
    tmp_path: Path,
) -> None:
    """Requirements 14.8, 5.13: the same four checks on EVERY path, the cover as a run of its own.

    The half the all-proved pin above leaves open. That test fixes the four main commands on ONE
    path, and a step-0 check or a dropped cover would be CONDITIONAL - issued only after a
    ``PREUNSAT``, say, or skipped once some earlier check had answered - so it would never show on
    that path. The same four commands are therefore pinned on all 256 paths.

    No step-0 check exists separate from the base case, because the two-condition gate rule leaves
    it no residual to cover (Requirement 14.8): every main invocation is one of the four, at the
    REQUESTED depth, so no ``-t 0`` or ``-t 1`` probe can hide among them. And the Cover_Check is a
    run of its own carrying ``-c`` and never ``-i`` (Requirement 5.13), because a vacuously true
    property is true and no prover reports vacuity as a defect, so no proof's result can stand in
    for it.
    """
    expected = [command.split() for command in _EXPECTED_MAIN_COMMANDS]

    for index, statuses in enumerate(_every_outcome()):
        calls = _calls_on(tmp_path / f"path-{index}", statuses)

        main = [
            argv for argv in calls if argv[0] == "yosys-smtbmc" and argv[1:3] == ["-s", _SOLVER]
        ]
        assert main == expected, statuses


def test_the_cross_check_follows_exactly_the_proved_shaped_reply_on_every_path(
    tmp_path: Path,
) -> None:
    """Requirements 4.15, 11.15: a ``-s z3`` audit exactly where a check replied ``PASSED``.

    The two audit tests above pin this on the all-proved path and the base-refuting one, and a
    trigger widened to "anything but ``FAILED``" passes both. That trigger also audits a
    ``PREUNSAT`` and a run that printed no status at all, and the second is the present-but-not-
    invocable reply Requirement 11.15 forbids re-running under ``-s z3``. Only the other paths tell
    the two triggers apart, so every path is asserted: one audit, issued immediately after its
    check, for each check that replied ``PASSED``, and none for any other.
    """
    for index, statuses in enumerate(_every_outcome()):
        expected: list[tuple[str, str]] = []
        for name, _ in _CHECKS:
            expected.append((name, _SOLVER))
            if statuses[name] == "PASSED":
                expected.append((name, _CROSS_CHECK_SOLVER))

        assert _issued(_calls_on(tmp_path / f"path-{index}", statuses)) == expected, statuses


def test_a_present_but_not_invocable_solver_is_never_rerun_under_z3(tmp_path: Path) -> None:
    """Requirement 11.15: the unshimmed bitwuzla 0.9.x path issues no ``-s z3`` re-run at all.

    The solver choice is part of the Formal_Oracle_Version, so running z3 in bitwuzla's place would
    record an experiment identity that never ran. The every-path test above holds this row; it is
    named here with the MEASURED reply, and with the report that reply produces: four checks with no
    status and no ``crossCheck``, which the TypeScript gate reads as ``toolchain-unavailable`` after
    ONE formal job (``adapter.test.ts``).
    """
    runner = _StatusScriptedRunner(dict.fromkeys((name for name, _ in _CHECKS), None))
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    assert [argv for argv in runner.calls if argv[1:3] == ["-s", _CROSS_CHECK_SOLVER]] == []
    checks = _report(tmp_path)["checks"]
    assert isinstance(checks, dict)
    assert all(check["status"] is None for check in checks.values())
    assert all("crossCheck" not in check for check in checks.values())


def test_the_vacuity_answer_is_read_from_the_cover_run_alone(tmp_path: Path) -> None:
    """Requirement 5.13: no proof's own output answers the vacuity question.

    The fields-where-they-apply test above pins each cover field to the cover check, but over
    replies in which only the cover run printed a cover line, so a parse that read ANY run's cover
    line would pass it. Here every proof run prints one and the cover run prints neither, and the
    vacuity answer must still be "answered nothing": the cover analysis is a query of its own, and
    no proof's result stands in for it.
    """
    runner = _ProofPrintsACoverLineRunner()
    sources = _write_design(tmp_path, _DESIGN_FILE)

    _run_formal(tmp_path, runner, sources, FormalRequest(top_module=_TOP, depth=_DEPTH))

    checks = _report(tmp_path)["checks"]
    assert isinstance(checks, dict)
    assert checks["cover"]["coverAnswered"] is False
    assert "reachedStep" not in checks["cover"]
    for name in ("presat", _BASE_CHECK, "induct"):
        assert "reachedStep" not in checks[name], name
        assert "coverAnswered" not in checks[name], name
