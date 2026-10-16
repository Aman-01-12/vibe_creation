"""Thin EDA glue: ``iverilog``/``vvp`` for simulation, Yosys/bitwuzla for formal proof.

This is deliberately minimal. It compiles the workspace's Verilog sources, runs
the resulting simulation, and captures the run's exit code, streams, and any VCD
waveform the testbench produced. It makes no verdict decision - it only reports
what happened. When a tool is absent the invocation surfaces as a non-zero exit
with no artifact, which the TypeScript adapter classifies as ``error``; a
successful simulation is never fabricated.

:func:`formal` is the same shape for the formal oracle: it lowers the sources to
SMT2 through the one fixed Yosys sequence below, counts the assertions that
reached the SMT2, runs the FOUR ``yosys-smtbmc`` checks under ``-s bitwuzla``,
re-runs any ``PROVED``-shaped one under ``-s z3`` as a cross-check, and reports the
numbers. It decides nothing either - the five-condition gate that turns those
numbers into ``proved``/``refuted``/``could-not-verify`` lives on the TypeScript
side, matching the seam's own rule that classification never happens in the worker.

:func:`formal_prepass` is the Reset_Contract_Prepass: a SECOND Yosys invocation over
the candidate DESIGN ALONE, under its own job kind, because it must complete BEFORE the
Property_Wrapper exists and a ``formal`` job's ``-top`` IS that wrapper. It reads the
reset polarity and the clock polarity off the elaborated flop cells and the
initial-state predicate out of an SMT2 write, and it runs no solver at all.

Tool invocation goes through the injected :class:`CommandRunner`, so this glue is
exercised in unit tests with a fake runner even where ``iverilog``/``vvp``/Yosys
are not installed.

NOTE ON ``synthesize``, so nobody infers a fix that did not happen: the
``synthesize`` job kind is STILL undispatched
(``chipAgent/_inbox/gotcha-worker-synthesize-kind-unimplemented.md``).
``worker.py._run_kind`` continues to return its honest unsupported-kind capture
for it. :func:`formal` implements a THIRD kind and :func:`formal_prepass` a FOURTH;
neither changes anything about the second.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from itertools import chain
from pathlib import Path
from typing import Any, Final, cast

from .commands import CommandRunner, CompletedCommand
from .contract import (
    MAX_PROOF_DEPTH,
    TOP_MODULE_RE,
    FormalPrepassRequest,
    FormalRequest,
    SimulateRequest,
)
from .report import ArtifactRef, JsonValue

#: Artifact map key for the waveform, matching the seam's ``RequiredOutput`` name
#: so the TypeScript adapter finds it when ``vcd`` is a required output.
_VCD_ARTIFACT_KEY = "vcd"

#: Name of the compiled simulation image written into the workspace.
_SIM_IMAGE = "simulation.vvp"

#: Written by the worker, never by a job, so the command file can only ever hold this one entry.
_DEFAULT_TIMESCALE_COMMAND_FILE = "ece-default-timescale.cmd"

#: Exit code reported for a job this glue REFUSED to turn into a tool invocation -
#: nothing to compile because every source was denied or none were provided, or (for
#: :func:`formal`) a parameter that must not reach a command line. A non-zero signal
#: with no fabricated artifact, which the TypeScript adapter classifies as ``error``.
_REFUSED_EXIT = 1

#: Artifact map key for the formal report, matching the seam's ``RequiredOutput``
#: name so the TypeScript adapter finds it when ``formalReport`` is required.
_FORMAL_REPORT_ARTIFACT_KEY = "formalReport"

#: Name of the formal report written into the workspace and registered as the
#: ``formalReport`` artifact.
_FORMAL_REPORT_FILENAME = "formal-report.json"

#: Name of the SMT2 file the lowering writes. The assertion count is taken over
#: this file and all three solver checks are run against it.
_SMT2_FILENAME = "out.smt2"

#: THE COMPLETE YOSYS LOWERING SEQUENCE, IN ORDER, AS ONE CONSTANT.
#:
#: Only two values are substituted - the workspace-relative source list and the
#: Property_Wrapper to elaborate as ``-top`` - so this worker holds no code path
#: that can assemble a Yosys invocation with ``async2sync``, ``dffunmap``, or
#: ``chformal -lower`` missing. That is structural rather than checked, because the
#: cost of omitting a pass is not an error message; see the trap at the end.
#:
#: WHY EACH PASS IS LOAD-BEARING, in the tool's own words (Yosys 0.66):
#:
#: - ``read_verilog -sv -formal`` - without ``-formal`` the frontend does not admit
#:   the assertions in the submitted sources at all.
#: - ``async2sync`` - without it ``chformal -lower`` refuses an edge-triggered
#:   ``$check`` cell: "Cannot lower edge triggered $check cell ... run async2sync or
#:   clk2fflogic first".
#: - ``dffunmap`` - without it ``write_smt2`` rejects a synchronous-reset flop:
#:   "Unsupported cell type $sdff ... please run `dffunmap`".
#: - ``chformal -lower`` - Yosys 0.66 lowers assert/assume/cover into a unified
#:   ``$check`` cell and ``write_smt2`` does not translate ``$check`` at all. THIS IS
#:   THE PASS WHOSE ABSENCE IS SILENT: the other two abort loudly, this one simply
#:   emits an SMT2 file with no assertions in it.
#:
#: - ``memory_map -rom-only -keepdc`` - joins on a MEASURED NO-REGRESSION basis rather
#:   than on a failure of its own, which is the one pass here whose justification is
#:   not a tool error message. Measured across the reference corpus: zero regressions
#:   across all 48 elaborating references, all 48 assertion counts unchanged, 47 of 48
#:   SMT2 files byte-identical, the five known-true proofs unchanged in status and in
#:   timing, and the single effect being ``verified_ROM``'s SMT2 growing from 3253 to
#:   251269 bytes. It also converts one spurious induction failure into a proof - the
#:   Yosys issue-3378 ROM shape, which had previously been filed against the ENGINE as
#:   k-induction incompleteness, so a lowering defect was being read as an engine limit.
#:
#:   SCOPE LIMIT, stated rather than hidden: that 48-design sweep used a TRIVIALLY-TRUE
#:   assertion, so it establishes no elaboration break and no assertion-count change and
#:   does NOT establish provability preservation on arbitrary properties.
#:
#: ``opt_dff -sat`` IS NOT IN THIS SEQUENCE AND MUST NEVER BE ADDED TO IT
#: (Requirement 14.13). It belongs in the pre-pass (task 16.2) over the design alone, so
#: it cannot affect the SMT2 the proof is taken over, and it was NOT measured inside this
#: script in either direction - so there is no basis here for adding it, and the absence
#: is a decision rather than an omission.
#:
#: THE MEASURED TRAP the assertion count exists to catch: ``prep`` plus
#: ``write_smt2`` with NEITHER ``async2sync`` NOR ``chformal -lower`` exits 0, emits
#: ZERO assertions, and reports ``Status: PASSED`` for a property that is provably
#: FALSE of the design (measured on ``adder_8bit`` asserting ``cout == 1'b0``).
#: ``grep -c assert`` over the generated SMT2 returned 0 for that chain and 2 for
#: this one, which is the whole reason :func:`_count_smt2_assertions` exists and is
#: reported unconditionally.
YOSYS_FORMAL_SCRIPT = (
    "read_verilog -sv -formal {sources}; "
    "prep -top {top} -flatten; "
    "memory_map -rom-only -keepdc; "
    "async2sync; "
    "dffunmap; "
    "chformal -lower; "
    "write_smt2 -wires " + _SMT2_FILENAME
)

#: Characters of the Yosys lowering diagnostic retained in the formal report.
#:
#: Bounded here, in the worker, so a Yosys diagnostic cannot become an unbounded
#: field in an artifact the TypeScript side then has to carry (Requirement 8.4). The
#: same discipline as the stream caps one module over - a named constant, not a job
#: field - at a size suited to a report field rather than a stream: a Yosys ERROR
#: plus its surrounding context is a few hundred characters, and a lowering that has
#: produced 4 KiB of diagnostics has already said what it refused and why.
MAX_STDERR_TAIL_CHARS = 4096

#: One path segment safe to place inside the Yosys script above: alphanumerics,
#: ``_``, ``.``, ``+``, and ``-``, and never leading with ``.`` or ``-`` so no segment
#: reads as an option or as a traversal.
_SAFE_PATH_SEGMENT = r"[A-Za-z0-9_][A-Za-z0-9_.+-]*"

#: A workspace-relative path safe to place inside the Yosys script above.
#:
#: MEASURED, not hypothetical. The script is one ``-p`` argument holding a
#: semicolon-separated command list, and Yosys splits it on ``;`` itself, so a source
#: file named ``design.v; write_verilog INJECTED.v`` makes Yosys run that second
#: command - confirmed on Yosys 0.66 in this workspace, where the injected command
#: wrote its file. Path confinement (:mod:`tool_runner_worker.paths`) bounds WHERE a
#: job may write, not what its filename may SAY, so the script grammar needs its own
#: whitelist rather than inheriting that one.
_SCRIPT_SAFE_RELPATH_RE = re.compile(rf"{_SAFE_PATH_SEGMENT}(?:/{_SAFE_PATH_SEGMENT})*")

#: Artifact map key for the pre-pass report, matching the seam's ``RequiredOutput`` name so
#: the TypeScript adapter finds it. REQUIRED on a ``formalPrepass`` job, unlike the formal
#: job's opportunistic trace, because a pre-pass that produced no report produced nothing -
#: its entire output IS the report, so there is no success case in which it is absent.
_PREPASS_REPORT_ARTIFACT_KEY = "formalPrepassReport"

#: Name of the pre-pass report written into the workspace and registered under that key.
_PREPASS_REPORT_FILENAME = "formal-prepass-report.json"

#: Name of the netlist the pre-pass ``write_json`` produces. The flip-flop cell parameters
#: are read off this file and NOWHERE else.
_PREPASS_NETLIST_FILENAME = "prepass-netlist.json"

#: Name of the SMT2 the pre-pass ``write_smt2`` produces. Read for ONE line - the
#: initial-state predicate - and never solved over. Deliberately NOT ``out.smt2``
#: (:data:`_SMT2_FILENAME`), so a pre-pass and a formal job sharing a workspace could not
#: have one overwrite the other's file and be proved over the wrong one.
_PREPASS_SMT2_FILENAME = "prepass-design.smt2"

#: THE COMPLETE RESET_CONTRACT_PREPASS SCRIPT, IN ORDER, AS ONE CONSTANT (Requirement 14.12).
#:
#: A SECOND Yosys invocation over the candidate DESIGN ALONE, under its own job kind, because
#: it must complete BEFORE the Property_Wrapper exists and a ``formal`` job's ``-top`` IS that
#: wrapper (Requirement 14.11). Only the source list and the DESIGN's own module name are
#: substituted, so no code path here can assemble a pre-pass with a pass missing.
#:
#: ``opt_dff -sat`` IS LOAD-BEARING AND MUST BE PRESENT. Measured: under plain ``prep`` the
#: derivation is 29 of 31 reset-bearing references and the TWO failures are exactly the
#: SYNC-RESET designs, because ``prep`` folds a synchronous reset into the D-input mux and
#: leaves no reset flop to read. With ``opt_dff -sat`` it is 31 of 31 derivable and 31 of 31
#: in agreement with source-read ground truth, zero disagreements. So the pre-pass has to be
#: the RIGHT pass and not merely a pass.
#:
#: ``opt_dff -sat`` BELONGS HERE AND NOT IN :data:`YOSYS_FORMAL_SCRIPT` (Requirement 14.13),
#: so it cannot affect the SMT2 the proof is taken over. Its behaviour INSIDE the lowering
#: script was never measured, so that placement is INFERRED rather than measured and no claim
#: is made in either direction.
#:
#: ``read_verilog`` carries ``-sv`` and NOT ``-formal``, which is the one difference from the
#: lowering script's frontend call and is deliberate: the pre-pass reads flop cells, and
#: admitting the candidate design's own SVA would add ``$check`` cells ``write_smt2`` cannot
#: translate, aborting the write and losing the initial-state predicate below.
#:
#: THE ``write_smt2`` MUST BE PRESENT (Requirement 14.21), and its only purpose is the
#: initial-state predicate ``(define-fun |<design>_i| ...)``. It is read from the DESIGN's
#: predicate rather than the wrapper's because the wrapper does not exist when this runs.
#: Measured cost is roughly 0.01s on top of a pre-pass measured at 0.72s across 48 designs,
#: slowest 0.046s, median 0.012s, against the roughly 160s worst measured single property.
#:
#: WHY ``async2sync; dffunmap`` SIT BETWEEN THE TWO WRITES, which is a DEVIATION from the
#: script `tasks.md` 16.2 spells out, taken on a MEASUREMENT rather than a preference.
#: Measured here, Yosys 0.66: the script WITHOUT them aborts the ``write_smt2`` outright -
#: ``ERROR: Unsupported cell type $adff for cell ... -- please run `async2sync; dffunmap` or
#: `clk2fflogic` before `write_smt2`.`` on an async-reset counter, and the same error naming
#: ``$sdffe`` and ``dffunmap`` on a sync-reset one. So the literal script reads NO predicate
#: for any reset-bearing design, which is 33 of the 33 clocked references, and the fact the
#: gate's whole assertion-gate decision rests on would be permanently unreadable.
#:
#: THEY CHANGE NOTHING THIS PRE-PASS DERIVES, for two reasons that are both structural:
#:   - They run AFTER the ``write_json``, so every ``ARST_POLARITY``, ``SRST_POLARITY``, and
#:     ``CLK_POLARITY`` has already been written out. Measured: the netlist still carries
#:     ``$adff``/``$sdffe`` with their polarity parameters intact, and the predicate now reads
#:     ``true`` for a free design and ``(= (|m#1| state) #b1111)`` for one carrying
#:     ``initial out = 4'd15``.
#:   - This SMT2 is never proved over. Requirement 14.13's rule is about the SMT2 the PROOF is
#:     taken over, which is the ``formal`` job's ``out.smt2`` from :data:`YOSYS_FORMAL_SCRIPT`;
#:     nothing in this invocation can reach it.
YOSYS_PREPASS_SCRIPT = (
    "read_verilog -sv {sources}; "
    "prep -top {top} -flatten; "
    "opt_dff -sat; "
    "write_json " + _PREPASS_NETLIST_FILENAME + "; "
    "async2sync; "
    "dffunmap; "
    "write_smt2 " + _PREPASS_SMT2_FILENAME
)

#: The polarity parameter, the connection naming the reset NET, and the reset KIND that pair
#: means, for both reset flavours - read in ONE walk over the cells.
#:
#: DRIVEN BY THE PARAMETER NAME AND NOT BY A CELL-TYPE WHITELIST, which is what keeps two
#: measured near-misses out without naming them: ``$aldff`` carries ``ALOAD_POLARITY`` (an
#: async LOAD, on ``booth4_mul``) and ``$dlatch`` carries ``EN_POLARITY`` (on ``fsm``). Neither
#: is a reset and neither may vote, and neither is spelled ``ARST_POLARITY`` or
#: ``SRST_POLARITY``, so the rule excludes them structurally while still covering every
#: enable-carrying flop variant (``$adffe``, ``$sdffe``, ``$sdffce``) with no type list to keep
#: up to date.
_RESET_PARAMETERS: Final[tuple[tuple[str, str, str], ...]] = (
    ("ARST_POLARITY", "ARST", "async"),
    ("SRST_POLARITY", "SRST", "sync"),
)

#: The parameter and the connection naming a flop's ENABLE, read for a cell that already
#: produced a reset entry (Requirement 4.15 of ``formal-gate-first-light``).
#:
#: An ``$sdffce`` resets only while its enable is active, so a reset assume that pins the reset
#: alone leaves the solver free to hold the enable low and the assumed reset step never fires.
#: MEASURED on ``LIFObuffer``: all 7 of its reset cells are ``$sdffce`` with a non-constant
#: enable, 2 of them directly on the top-level input ``EN``. Reading this pair is what lets the
#: contract STATE a conditional reset rather than leave it silently conditional.
#:
#: These names are read ONLY for a cell already selected by :data:`_RESET_PARAMETERS`, so the
#: two measured ``EN_POLARITY`` near-misses stay out: a ``$dlatch`` carries ``EN_POLARITY`` and
#: no reset parameter, so it contributes no entry for an enable to be attached to.
_ENABLE_POLARITY_PARAMETER = "EN_POLARITY"
_ENABLE_CONNECTION = "EN"

#: The cell types whose ENABLE GATES THEIR RESET, and the only ones whose ``EN`` is read.
#:
#: THIS ONE FACT IS A CELL-TYPE FACT AND CANNOT BE A PARAMETER-NAME RULE, which is why it is the
#: single exception to :data:`_RESET_PARAMETERS`'s no-whitelist discipline: the PRIORITY between
#: a reset and an enable is encoded in the cell type and in no parameter. Read directly from
#: Yosys 0.69's ``simlib.v``:
#:   - ``$sdffce``: ``if (EN == EN_POLARITY) begin if (pos_srst) Q <= SRST_VALUE; ...`` - the
#:     enable is OUTSIDE the reset, so the reset fires only while the enable is asserted.
#:   - ``$sdffe``: ``if (pos_srst) Q <= SRST_VALUE; else if (EN == EN_POLARITY) ...`` - the
#:     reset has PRIORITY and fires whatever the enable does.
#:   - ``$adffe``: same priority as ``$sdffe``, with an asynchronous reset.
#: So an ``$sdffe`` or ``$adffe`` enable is not "the signal that must be held for the reset to
#: fire" and naming it would pin a net the reset does not depend on - MEASURED to matter:
#: ``counter_12``'s reset cells are ``$adffe`` enabled by the top-level input ``valid_count``,
#: and its reset is active-low asynchronous and fires regardless of it.
#:
#: The direction of an UNLISTED type is the safe one, which is what makes a list acceptable
#: here: a cell type absent from this set reports no enable, so a new Yosys flop variant arrives
#: as today's narrower assume rather than as a widened one.
_ENABLE_GATED_RESET_CELLS: Final[frozenset[str]] = frozenset({"$sdffce"})

#: The parameter carrying a cell's clock polarity, read in the SAME walk as the two above
#: (Requirement 14.28) - so the marginal cost of the Clock_Contract is nil.
#:
#: Its PRESENCE is also what makes a cell a CLOCKED cell: a cell carrying no
#: ``CLK_POLARITY`` casts no clock vote, which is how a design with no clocked state comes
#: out as ``none`` rather than as a refusal (Requirement 14.34, 15 of 50 references).
_CLK_POLARITY_PARAMETER = "CLK_POLARITY"

#: Largest pre-pass netlist this worker will parse, in bytes.
#:
#: Bounded because the netlist is a tool's output over UNTRUSTED input and is parsed WHOLE -
#: ``json.load`` cannot be chunked the way :func:`_hash_artifact` and
#: :func:`_count_smt2_assertions` are - so the file's size is the memory this step costs. The
#: ceiling is roughly 64x the largest artifact measured anywhere in this chain
#: (``verified_ROM``'s 251269-byte SMT2), so it never shapes a real design; it exists so a
#: pathological netlist is REFUSED rather than loaded. A refusal means no report, which the
#: TypeScript side reads as ``toolchain-unavailable`` (Requirement 14.26).
MAX_PREPASS_NETLIST_BYTES = 16 * 1024 * 1024

#: Longest initial-state predicate body retained, in characters.
#:
#: Same discipline as :data:`MAX_STDERR_TAIL_CHARS`: a field in an artifact the TypeScript side
#: has to carry must not be unbounded. A body OVER the bound is reported as UNREADABLE rather
#: than truncated, because a truncated predicate is not a predicate and the refusal direction
#: is the only safe one here - both defaults are unsafe in OPPOSITE directions, one masking a
#: wrong ``initial`` value and one failing a correct sync-reset design's base case. The free
#: form is the four characters ``true``, so no honest free predicate is anywhere near this.
MAX_INITIAL_STATE_PREDICATE_CHARS = 4096

#: ``yosys-smtbmc``'s cover-analysis flag: the vacuity detector.
_COVER_FLAG = "-c"

#: ``yosys-smtbmc``'s temporal-induction flag: the only unbounded proof.
_INDUCT_FLAG = "-i"

#: The name of the BASE CASE check, spelled once: it is the only check whose flag set
#: is empty and the only one whose counterexample trace can source a refutation.
_BASE_CHECK = "base"

#: The FOUR ``yosys-smtbmc`` checks, in the order they are RUN: contradictory
#: assumptions, the base case, antecedent reachability, then the unbounded induction
#: proof. The order the five conditions are REPORTED in belongs to the TypeScript gate,
#: not here; this worker runs all four and reports what each said.
#:
#: WHY THE SECOND ENTRY CARRIES NO FLAG AT ALL, AND WHY THAT IS A TUPLE RATHER THAN
#: ``None``. The base case IS plain BMC - neither ``-i`` nor ``-c`` - so its
#: distinguishing feature is an ABSENCE. Each entry therefore carries the TUPLE OF FLAGS
#: that check adds, and the base case's is EMPTY. An empty tuple is a value rather than a
#: missing one, so no call site needs an optional branch, :func:`_smtbmc_argv` splats it
#: uniformly, and :func:`_parse_check` asks membership questions (``_COVER_FLAG in
#: flags``) that answer correctly for a check carrying nothing. A ``str | None`` slot
#: would have put the same fact behind a sentinel every reader has to interpret.
#:
#: WHY THE BASE CASE IS NOT OPTIONAL. ``yosys-smtbmc -i`` checks only the inductive step
#: and never a base case, so ``initial out = 4'd15`` against ``out <= 11`` reports
#: ``Temporal induction successful`` and ``Status: PASSED`` at depths 5, 20, AND 40 while
#: plain BMC reports ``Status: FAILED`` at all three. The pass added to make the proof
#: unbounded produces a false ``PASSED`` of its own, and the base case is what separates
#: the two. Read from the tool's own source rather than inferred: in ``-i`` mode every
#: step asserts ``(not (|<top>_is| s<n>))``, which EXCLUDES the initial state, and the
#: init-constraint function is never asserted at all.
_SMTBMC_CHECKS: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    ("presat", ("--presat",)),
    (_BASE_CHECK, ()),
    ("cover", (_COVER_FLAG,)),
    ("induct", (_INDUCT_FLAG,)),
)

#: The solver every ``yosys-smtbmc`` invocation names explicitly.
#:
#: THE BASIS IS AGREEMENT FIRST AND SPEED SECOND, in that order. bitwuzla agreed with z3
#: on every verdict across 7 control cases in 2 modes plus 5 positive cases, with
#: identical statuses, identical failing steps, and identical source locations and zero
#: disagreements, and is 10.7x faster on the ``multi_booth_8bit`` base case at 2.38s
#: against 25.43s. A solver swap that changes no verdict anywhere is the cheapest
#: possible change to this chain: the lowering sequence, the wrapper, the report parser,
#: and every recorded depth all stay exactly as they are.
#:
#: THE BLOCKER, recorded here because it is a LIVE TRUST SURFACE rather than a footnote:
#: ``yosys-smtbmc -s bitwuzla`` is BROKEN against bitwuzla 0.9.x because
#: ``smtio.py:229`` builds ``bitwuzla --smt2 -i`` and 0.9.1 rejects both flags, so every
#: bitwuzla measurement came through a flag shim, the shim is NEW TRUST SURFACE, and that
#: is precisely why z3 is retained rather than retired - the cheapest audit of a wrapper
#: we wrote is a second solver we did not.
_SOLVER = "bitwuzla"

#: The Solver_Cross_Check's solver: the previous incumbent, kept as the audit of the
#: bitwuzla flag shim above (Requirement 4.15).
_CROSS_CHECK_SOLVER = "z3"

#: The parsed ``Status:`` string that admits the verdict ``proved``, and therefore the
#: one that triggers the Solver_Cross_Check re-run.
#:
#: PER INVOCATION, not per run, and the criterion is why: Requirement 4.15 says "WHERE an
#: invocation under ``-s bitwuzla`` reported a result admitting the Formal_Verdict
#: ``proved``, THE Formal_Oracle SHALL re-run THAT invocation". design.md's prose narrows
#: it to "the induction check"; the criterion is the wider of the two and governs, so any
#: check reporting this status is re-run and a check reporting anything else is not.
_PROVED_STATUS = "PASSED"

#: ``yosys-smtbmc``'s counterexample-trace flag. Passed on EVERY invocation, and the
#: resulting trace registered OPPORTUNISTICALLY where one was written - never as a
#: required output (Requirement 12.18, 12.19).
#:
#: WHY OPPORTUNISTIC IS LOAD-BEARING: ``missingRequiredOutputs`` in
#: ``app/tools/sandbox/classification.ts`` forces the whole invocation to ``error`` when a
#: required output is absent, and a SUCCESSFUL PROOF produces no trace, so listing it as
#: required would classify every proof as ``error``.
#:
#: AND WHY IT MUST BE PASSED AT ALL: ``refutation()`` on the TypeScript side reads
#: ``result.artifacts['vcd']``, so without a trace every refuting run becomes
#: ``toolchain-unavailable`` and ``refuted`` is unreachable.
_DUMP_VCD_FLAG = "--dump-vcd"

#: Filename template for one invocation's counterexample trace: ``<check>-<solver>``.
#:
#: DISTINCT PER INVOCATION, which is the point. A single shared path would let a later
#: check overwrite an earlier one's trace, and the BASE CASE's trace is the one that
#: sources a refutation (see :data:`_BASE_CHECK`) - so a cover check running after it
#: would silently destroy the counterexample the verdict rests on. The cross-check gets
#: its own file for the same reason: a disagreeing z3 re-run must not overwrite the
#: bitwuzla trace it disagrees with, because the whole point of the cross-check is to
#: report BOTH results rather than reconcile them.
#:
#: WHY IT IS SAFE TO PUT ON A COMMAND LINE. Both substituted values come from module
#: constants - a name out of :data:`_SMTBMC_CHECKS` and one of :data:`_SOLVER` /
#: :data:`_CROSS_CHECK_SOLVER` - so NO REQUEST FIELD reaches this string. That is
#: deliberate rather than incidental: a job-derived trace name would be a second
#: injection channel of exactly the shape :data:`_SCRIPT_SAFE_RELPATH_RE` exists to
#: close, and one that no whitelist here would be guarding.
_TRACE_RELPATH_TEMPLATE = "formal-trace-{check}-{solver}.vcd"

#: The ``Status:`` line every ``yosys-smtbmc`` invocation ends with. Observed values
#: are ``PASSED``, ``FAILED``, and ``PREUNSAT``; the string is parsed rather than
#: inferred from the exit code, because the exit code only distinguishes ``PASSED``
#: (0) from everything else (1).
_STATUS_RE = re.compile(r"Status:\s+([A-Z]+)")

#: The cover-analysis line reporting the step an antecedent became reachable at,
#: for example "Reached cover statement in step 13 at ...".
_COVER_STEP_RE = re.compile(r"Reached cover statement in step (\d+)")

#: EITHER cover-analysis line - the reached one above, or "Unreached cover statement".
#: Its presence is the one fact that says the cover analysis ANSWERED the reachability
#: question at all.
#:
#: WHY A SECOND PATTERN AND NOT JUST THE STEP. :attr:`_SmtBmcCheck.reached_step` is
#: ``None`` both for a cover that answered UNREACHED and for one that printed NEITHER
#: line, so without this flag those two OPPOSITE facts are the same document and the
#: TypeScript gate cannot tell an unreached antecedent from a reachability question
#: nothing answered - which its Requirement 5.12 requires it to report differently,
#: because an unanswered question is not an unreached antecedent.
#:
#: Matched CASE-SENSITIVELY, which is what keeps the alternation unambiguous: "Unreached"
#: carries a lowercase ``r``, so the reached form is not a substring of the unreached one
#: and neither line can be mistaken for the other. Only PRESENCE is read, so the order of
#: the alternatives does not matter either.
_COVER_ANSWER_RE = re.compile(r"(?:Reached|Unreached) cover statement")

#: The line ``yosys-smtbmc -i`` prints when the unbounded proof succeeded. Only this
#: is an induction success; a bounded pass prints no such line.
_INDUCTION_SUCCESS = "Temporal induction successful"

#: An absolute filesystem path in a tool diagnostic, redacted out of the report.
#: Workspace-relative names are left intact on purpose: the TypeScript side
#: attributes a lowering failure BY the submitted filename, so redacting those would
#: destroy the evidence rather than protect anything.
_ABSOLUTE_PATH_RE = re.compile(r"/(?:[\w.+$-]+/)*[\w.+$-]+")

#: A stack-frame line (a Yosys crash backtrace, or a ``yosys-smtbmc`` Python
#: traceback - it is a Python program), dropped whole rather than redacted.
_STACK_FRAME_RE = re.compile(r"^\s*(?:Traceback \(most recent call last\)|File \"|#\d+\s+0x|at 0x)")


@dataclass(frozen=True, slots=True)
class EdaCapture:
    """The raw capture of one EDA invocation (no verdict).

    The truncation flags describe the streams THIS capture reports, which is the
    only honest reading: a compile that overflowed its cap but still exited zero
    has its streams discarded in favour of the simulation's, so its truncation
    says nothing about the output the caller receives.

    ``disk_limit_exceeded`` is different in kind: the disk cap is measured over the
    whole workspace, which both invocations share, so a breach by EITHER of them is
    a fact about the run the caller receives and is carried forward accordingly.
    """

    exit_code: int | None
    stdout: str
    stderr: str
    #: True when the reported standard output is a bounded prefix, not the whole
    #: stream, so a discarded ``CHECK ... FAIL`` line cannot be ruled out.
    stdout_truncated: bool
    #: True when the reported standard error is a bounded prefix, not the whole stream.
    stderr_truncated: bool
    #: True when an invocation was KILLED for exceeding the workspace disk cap, so
    #: the run stopped mid-flight and its evidence is incomplete. Required rather
    #: than defaulted, for the same reason as the truncation flags: a producer that
    #: could omit it would report a killed run as one that finished.
    disk_limit_exceeded: bool
    artifacts: dict[str, ArtifactRef] = field(default_factory=dict)


#: Bytes read per chunk while hashing a produced artifact.
_HASH_CHUNK_BYTES = 65_536


def _hash_artifact(path: Path, workspace_root: Path) -> ArtifactRef:
    """Build an :class:`ArtifactRef` (name, size, SHA-256) for a produced file.

    Read in fixed-size chunks rather than whole. A waveform is as large as the run
    was allowed to make it - now the workspace disk cap, previously nothing at all -
    so slurping it would spend that entire budget in memory just to hash it, which
    is the same resource-exhaustion shape one layer over.
    """
    digest = hashlib.sha256()
    size_bytes = 0
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK_BYTES):
            digest.update(chunk)
            size_bytes += len(chunk)
    return ArtifactRef(
        name=str(path.relative_to(workspace_root)),
        size_bytes=size_bytes,
        sha256=digest.hexdigest(),
    )


def _collect_vcd(workspace_root: Path) -> dict[str, ArtifactRef]:
    """Register the first VCD waveform found in the workspace, if any."""
    vcd_files = sorted(workspace_root.rglob("*.vcd"))
    if not vcd_files:
        return {}
    return {_VCD_ARTIFACT_KEY: _hash_artifact(vcd_files[0], workspace_root)}


def _compile_command(source_relpaths: list[str], request: SimulateRequest | None) -> list[str]:
    """Today's command when ``request`` is None; otherwise the same command with ``-c <file>``."""
    if request is None:
        return ["iverilog", "-g2012", "-o", _SIM_IMAGE, *source_relpaths]
    return [
        "iverilog",
        "-g2012",
        "-c",
        _DEFAULT_TIMESCALE_COMMAND_FILE,
        "-o",
        _SIM_IMAGE,
        *source_relpaths,
    ]


def simulate(  # noqa: PLR0913 - six is what the seam needs; see :func:`formal`
    workspace_root: Path,
    source_relpaths: list[str],
    runner: CommandRunner,
    timeout_s: float,
    disk_limit_bytes: int,
    request: SimulateRequest | None = None,
) -> EdaCapture:
    """Compile and simulate the workspace sources, capturing the run's facts.

    Both invocations run under the same wall-clock and workspace-disk bounds. The
    disk cap is a ceiling on the whole workspace rather than on either step, because
    that is the resource the host actually has: the compiled image and the waveform
    accumulate in the same directory.
    """
    if not source_relpaths:
        return EdaCapture(
            _REFUSED_EXIT,
            "",
            "no Verilog source files to compile",
            stdout_truncated=False,
            stderr_truncated=False,
            disk_limit_exceeded=False,
        )

    if request is not None:
        # The one entry, from a value `load_job` already checked against DEFAULT_TIMESCALES.
        command_file = workspace_root / _DEFAULT_TIMESCALE_COMMAND_FILE
        command_file.write_text(f"+timescale+{request.default_timescale}\n", encoding="utf-8")
    compile_cmd = _compile_command(source_relpaths, request)
    compiled: CompletedCommand = runner.run(
        compile_cmd, workspace_root, timeout_s, disk_limit_bytes
    )
    if compiled.exit_code != 0:
        # Compile failed: report the compiler's exit and diagnostics, no artifact.
        return EdaCapture(
            compiled.exit_code,
            compiled.stdout,
            compiled.stderr,
            stdout_truncated=compiled.stdout_truncated,
            stderr_truncated=compiled.stderr_truncated,
            disk_limit_exceeded=compiled.disk_limit_exceeded,
        )

    run = runner.run(["vvp", _SIM_IMAGE], workspace_root, timeout_s, disk_limit_bytes)
    return EdaCapture(
        exit_code=run.exit_code,
        stdout=run.stdout,
        stderr=run.stderr,
        stdout_truncated=run.stdout_truncated,
        stderr_truncated=run.stderr_truncated,
        # Either step can breach a cap they share, and a breach during compile is
        # still a breach by the time the simulation is reported.
        disk_limit_exceeded=compiled.disk_limit_exceeded or run.disk_limit_exceeded,
        artifacts=_collect_vcd(workspace_root),
    )


@dataclass(frozen=True, slots=True)
class _CrossCheck:
    """The Solver_Cross_Check's reported facts: ONE check re-run under another solver.

    A type of its own rather than a nested :class:`_SmtBmcCheck`, so a cross-check OF a
    cross-check is unrepresentable rather than merely never built, and so the only fields
    present are the ones the audit actually answers. It carries ``solver`` because the
    whole value of the audit is WHICH solver said this - a status with no solver beside it
    is exactly the reconciled single answer Requirement 4.15 forbids.

    NO COMPARISON IS MADE HERE. Both results travel side by side in the report and the
    TypeScript gate decides what a disagreement means, matching this module's rule that
    classification never happens in the worker.
    """

    solver: str
    exit_code: int | None
    status: str | None
    #: Whether THIS solver reported temporal-induction success. Carried, where the status
    #: alone is not the whole result: a bounded pass and an unbounded proof both report
    #: ``PASSED`` and only the induction line separates them, so on the induction check a
    #: status-only audit could agree while the two solvers disagreed about the one fact
    #: ``proved`` rests on. Neither ``reachedStep`` nor ``coverAnswered`` is carried here -
    #: a differing cover step or a differing cover-line presence changes no verdict, because
    #: the antecedent condition is read from the MAIN run, while a differing induction line
    #: changes ``proved``.
    induction_successful: bool | None
    elapsed_ms: int
    #: The trace this re-run wrote, or ``None`` where it wrote none (a proof writes none).
    trace_relpath: str | None

    def as_dict(self) -> dict[str, JsonValue]:
        """Serialize to camelCase, emitting the two conditional fields only where they apply."""
        payload: dict[str, JsonValue] = {
            "solver": self.solver,
            "exitCode": self.exit_code,
            "status": self.status,
            "elapsedMs": self.elapsed_ms,
        }
        if self.induction_successful is not None:
            payload["inductionSuccessful"] = self.induction_successful
        if self.trace_relpath is not None:
            payload["tracePath"] = self.trace_relpath
        return payload


@dataclass(frozen=True, slots=True)
class _SmtBmcCheck:
    """One ``yosys-smtbmc`` invocation's reported facts (no verdict).

    ``exit_code`` is ``None`` exactly when the check did not run, because the lowering
    wrote no SMT2 file for it to solve. ``status`` is ``None`` when no ``Status:`` line
    could be parsed, which the TypeScript side reads as evidence it may not interpret
    rather than as a pass - the exit code is never consulted as a fallback, because 0
    means ``PASSED`` and 1 means everything else.

    ``trace_relpath`` and ``cross_check`` are REQUIRED rather than defaulted, by the same
    rule as :class:`EdaCapture`'s bound flags: a producer that could omit the trace would
    report a refuting run as one that left no counterexample, which is the exact defect
    that made ``refuted`` unreachable before this field existed.
    """

    exit_code: int | None
    status: str | None
    reached_step: int | None
    #: Whether the cover analysis printed EITHER cover line, or ``None`` on a check that is
    #: not the cover analysis. Carried BESIDE ``reached_step`` because the step cannot
    #: express it: an answered-UNREACHED cover and one that printed neither line both leave
    #: the step ``None``. See :data:`_COVER_ANSWER_RE` for why that distinction is load
    #: bearing on the TypeScript side.
    cover_answered: bool | None
    induction_successful: bool | None
    elapsed_ms: int
    #: The trace this check wrote, or ``None`` where it wrote none - a check that PASSED
    #: has no counterexample to dump, and that absence is the ordinary shape of a proof.
    trace_relpath: str | None
    #: The ``-s z3`` audit of this check, present only where its own result was
    #: ``PROVED``-shaped (Requirement 4.15).
    cross_check: _CrossCheck | None

    def as_dict(self) -> dict[str, JsonValue]:
        """Serialize to the camelCase shape the TypeScript report schema validates.

        ``reachedStep``, ``coverAnswered``, ``inductionSuccessful``, ``tracePath``, and
        ``crossCheck`` are emitted only where they apply - the cover check, the cover check,
        the induction check, a check that wrote a trace, and a check that was cross-checked -
        so a field's presence is itself information rather than a null every reader has to
        interpret.

        ``coverAnswered`` is the one field whose VALUE matters where ``reachedStep``'s
        absence does not: ``False`` beside no step means the analysis answered nothing.
        """
        payload: dict[str, JsonValue] = {
            "exitCode": self.exit_code,
            "status": self.status,
            "elapsedMs": self.elapsed_ms,
        }
        if self.reached_step is not None:
            payload["reachedStep"] = self.reached_step
        if self.cover_answered is not None:
            payload["coverAnswered"] = self.cover_answered
        if self.induction_successful is not None:
            payload["inductionSuccessful"] = self.induction_successful
        if self.trace_relpath is not None:
            payload["tracePath"] = self.trace_relpath
        if self.cross_check is not None:
            payload["crossCheck"] = self.cross_check.as_dict()
        return payload


@dataclass(frozen=True, slots=True)
class _ChecksOutcome:
    """The four checks' facts, plus what the caller needs to report the run itself.

    ``last`` is the final invocation's raw capture, or ``None`` when no check ran; the
    disk flag is the OR across every check, because they share one workspace cap.
    """

    checks: dict[str, _SmtBmcCheck]
    last: CompletedCommand | None
    disk_limit_exceeded: bool


def _checks_not_run() -> _ChecksOutcome:
    """The outcome for a lowering that produced no SMT2: four checks that never ran.

    Every check is still PRESENT, with a ``None`` exit code and no status, so a check
    that could not run is distinguishable from one that ran and said nothing - and
    never mistakable for one that passed.
    """
    return _ChecksOutcome(
        checks={
            name: _SmtBmcCheck(
                exit_code=None,
                status=None,
                reached_step=None,
                # ``None`` rather than ``False``, so a cover analysis that never ran is
                # distinguishable from one that ran and answered nothing: the field is
                # absent from the report entirely, and the TypeScript gate reads BOTH as
                # "no answer" through the exit code it also checks.
                cover_answered=None,
                induction_successful=None,
                elapsed_ms=0,
                trace_relpath=None,
                cross_check=None,
            )
            for name, _ in _SMTBMC_CHECKS
        },
        last=None,
        disk_limit_exceeded=False,
    )


def _formal_refusal(source_relpaths: list[str], request: FormalRequest) -> str | None:
    """The reason this job must not become a Yosys invocation, or ``None`` to proceed.

    The worker is a trust boundary in its own right, so it does not take a job's word
    for a value it is about to put on a command line - not even one the seam schema
    already validated. Two of the three rules exist because the value is INTERPRETED
    rather than merely passed: ``top_module`` and every source path land inside the
    one ``-p`` script, whose ``;`` separators Yosys splits on itself.

    THE PAYLOAD RULES ARE CHECKED TWICE ON PURPOSE. :func:`contract._formal_request`
    applies the same two - :data:`contract.TOP_MODULE_RE` and
    :data:`contract.MAX_PROOF_DEPTH`, imported here so there is one owner per rule and
    no chance of the two sites drifting - when the job is parsed, so a malformed
    payload never reaches dispatch. This is the LAST place before the value reaches a
    Yosys command line, and the source-path rule below has no earlier site at all: the
    relpaths are produced by workspace materialization, not carried by the job.

    Each message names the RULE and never echoes the value, matching the sanitized
    contract-validation diagnostics in :mod:`tool_runner_worker.contract`.
    """
    if not source_relpaths:
        return "no Verilog source files to lower"
    if TOP_MODULE_RE.fullmatch(request.top_module) is None:
        return "formal topModule is not a plain Verilog identifier"
    if not 0 < request.depth <= MAX_PROOF_DEPTH:
        return f"formal depth is outside 1..{MAX_PROOF_DEPTH}"
    if any(_SCRIPT_SAFE_RELPATH_RE.fullmatch(path) is None for path in source_relpaths):
        return "a source path holds a character the Yosys script grammar would reinterpret"
    return None


def _count_smt2_assertions(smt2_path: Path) -> int:
    """Count the SMT2 lines mentioning an assertion; an unreadable file counts as 0.

    Deliberately the probe's own guard, ``grep -c assert``, which returned 0 for the
    silent vacuous chain and 2 for the correct one. A line count rather than a parse
    of the SMT2 grammar, because the number only has to separate "nothing reached the
    solver" from "something did", and a parser would be a second thing to be wrong
    about the one check that does not depend on the model or on the solver's verdict.

    An absent or unreadable file counts as ZERO rather than raising or being omitted:
    an unwritten file must not read as a satisfied precondition, and a missing count
    must not read as a healthy one. Lines are read one at a time, like the chunked
    hashing above, so a large SMT2 is never held in memory whole.
    """
    try:
        with smt2_path.open(encoding="utf-8", errors="replace") as handle:
            return sum(1 for line in handle if "assert" in line)
    except OSError:
        return 0


def _sanitized_stderr_tail(stderr: str) -> str:
    """The bounded, sanitized tail of the Yosys lowering diagnostic.

    THE TAIL, not the prefix, because Yosys aborts on its first fatal error and the
    message it aborts with is the last thing it writes. The stream itself is already
    prefix-bounded by the capture caps one module over, so this is the tail of what
    was retained, and the bound here keeps a diagnostic from becoming an unbounded
    field in an artifact.

    Stack-frame lines are dropped whole and absolute paths are replaced, so neither a
    host path nor a backtrace can travel inside the report. Workspace-relative
    filenames survive ON PURPOSE: the TypeScript side attributes a lowering failure to
    the design file or to the Property_Wrapper by that name, so redacting those would
    destroy the evidence rather than protect anything.
    """
    kept = [line for line in stderr.splitlines() if _STACK_FRAME_RE.match(line) is None]
    redacted = _ABSOLUTE_PATH_RE.sub("<path>", "\n".join(kept))
    return redacted[-MAX_STDERR_TAIL_CHARS:]


def _parsed_status(stdout: str) -> str | None:
    """The reported ``Status:`` string, or ``None`` when no line carried one.

    The LAST match wins, because the status line is the last thing an invocation prints.
    Shared by the check and its cross-check so the two cannot come to disagree about how
    a status is read while appearing to disagree about the design.
    """
    statuses = _STATUS_RE.findall(stdout)
    return statuses[-1] if statuses else None


def _induction_successful(stdout: str, flags: tuple[str, ...]) -> bool | None:
    """Whether the unbounded proof succeeded, or ``None`` where the question does not apply.

    Only an induction invocation can answer it, so only one carrying :data:`_INDUCT_FLAG`
    is asked - which the base case's empty tuple answers correctly with no special case.
    One owner of the rule, shared by the check and its cross-check.
    """
    return _INDUCTION_SUCCESS in stdout if _INDUCT_FLAG in flags else None


def _cover_answered(stdout: str, flags: tuple[str, ...]) -> bool | None:
    """Whether the cover analysis ANSWERED reachability, or ``None`` where it cannot apply.

    Only a cover invocation can answer the question, so only one carrying
    :data:`_COVER_FLAG` is asked - which the base case's empty tuple answers correctly with
    no special case, the same shape :func:`_induction_successful` uses. One owner of the
    rule.

    It reports whether a line was PRINTED and never which line, because the reached case
    already travels as ``reached_step``: together the two say "reached at step N",
    "answered UNREACHED", or "answered nothing", which is three facts out of two fields and
    is exactly what Requirement 5.12 needs told apart. See :data:`_COVER_ANSWER_RE`.
    """
    return _COVER_ANSWER_RE.search(stdout) is not None if _COVER_FLAG in flags else None


def _trace_relpath(check_name: str, solver: str) -> str:
    """The workspace-relative ``--dump-vcd`` target for one invocation.

    Both arguments are module constants at every call site - a name out of
    :data:`_SMTBMC_CHECKS` and one of :data:`_SOLVER` / :data:`_CROSS_CHECK_SOLVER` - so
    the returned string is closed over fixed values and no request field can reach an
    argv through it. See :data:`_TRACE_RELPATH_TEMPLATE`.
    """
    return _TRACE_RELPATH_TEMPLATE.format(check=check_name, solver=solver)


def _written_trace(workspace_root: Path, trace_relpath: str) -> str | None:
    """The trace path where the invocation actually wrote one, else ``None``.

    ASKED RATHER THAN ASSUMED, because a passing check writes no trace at all: the
    absence of the file is the ordinary shape of a proof, so it must be reported as an
    absent trace and never as a path to a file nobody can read.
    """
    return trace_relpath if (workspace_root / trace_relpath).is_file() else None


def _smtbmc_argv(solver: str, flags: tuple[str, ...], depth: int, trace_relpath: str) -> list[str]:
    """Build one ``yosys-smtbmc`` invocation's argv.

    ``-s`` IS ALWAYS PRESENT, and the solver is a parameter rather than a constant so the
    same builder serves the main run and its cross-check. Presence is not a style choice:
    ``yosys-smtbmc``'s default ``-s`` is ``yices``, ``yices`` is NOT installed, so an
    invocation that omits ``-s`` is broken rather than defaulted.

    ``flags`` is SPLATTED, so the base case's empty tuple contributes nothing and needs no
    branch here - the reason :data:`_SMTBMC_CHECKS` carries tuples rather than a
    ``str | None`` sentinel.
    """
    return [
        "yosys-smtbmc",
        "-s",
        solver,
        *flags,
        _DUMP_VCD_FLAG,
        trace_relpath,
        "-t",
        str(depth),
        _SMT2_FILENAME,
    ]


def _parse_check(
    completed: CompletedCommand,
    flags: tuple[str, ...],
    elapsed_ms: int,
    trace_relpath: str | None,
) -> _SmtBmcCheck:
    """Extract one check's reported facts from its captured output.

    The ``Status:`` string is PARSED rather than inferred from the exit code, which
    only distinguishes ``PASSED`` from everything else and so cannot tell a false
    property from contradictory assumptions.

    Which check this is, is asked as MEMBERSHIP over ``flags`` rather than as equality
    against one flag, which is what makes the base case's empty tuple work: a check
    carrying no flags answers every membership question correctly - it is not the cover
    check and not the induction check - with no special case anywhere.

    Where several covers were reached the LARGEST step is recorded: that is the depth
    a non-vacuous proof has to clear, and the smallest would understate it. The
    renderer emits one cover per property, so in practice there is one line.

    The cover analysis reports TWO fields rather than one, and only this function can:
    the step says which step a cover was reached at, and ``cover_answered`` says whether
    either cover line was printed at all. The stdout is in hand here and nowhere downstream,
    so a reachability question that went unanswered has to be recorded here or it is lost.
    """
    steps = [int(step) for step in _COVER_STEP_RE.findall(completed.stdout)]
    return _SmtBmcCheck(
        exit_code=completed.exit_code,
        status=_parsed_status(completed.stdout),
        reached_step=max(steps) if _COVER_FLAG in flags and steps else None,
        cover_answered=_cover_answered(completed.stdout, flags),
        induction_successful=_induction_successful(completed.stdout, flags),
        elapsed_ms=elapsed_ms,
        trace_relpath=trace_relpath,
        cross_check=None,
    )


def _run_checks(
    workspace_root: Path,
    depth: int,
    runner: CommandRunner,
    timeout_s: float,
    disk_limit_bytes: int,
) -> _ChecksOutcome:
    """Run all four ``yosys-smtbmc`` checks over the lowered SMT2, in order.

    Every check runs at the requested depth and under the same wall-clock and
    workspace-disk bounds as the lowering, the same way :func:`simulate`'s two
    invocations share one budget.

    ALL FOUR ALWAYS RUN, including when no assertion reached the SMT2: each answers a
    different question, and deciding which failure decides the verdict belongs to the
    TypeScript gate, so withholding a check here would withhold evidence from the only
    side that classifies.

    A check whose own result is ``PROVED``-shaped is then re-run under
    :data:`_CROSS_CHECK_SOLVER`, and ONLY such a check (Requirement 4.15). Both results
    are recorded side by side and neither is preferred: a disagreement invalidates the
    basis on which the solver was chosen, so reconciling it here would be fitting the
    evidence to the choice. ``last`` stays the last MAIN invocation, so which streams the
    caller receives does not depend on whether an audit happened to run after them.
    """

    def invoke(
        solver: str, flags: tuple[str, ...], trace_relpath: str
    ) -> tuple[CompletedCommand, int]:
        """Run one invocation, returning its capture and its elapsed milliseconds."""
        argv = _smtbmc_argv(solver, flags, depth, trace_relpath)
        started = time.monotonic()
        completed = runner.run(argv, workspace_root, timeout_s, disk_limit_bytes)
        return completed, round((time.monotonic() - started) * 1000)

    checks: dict[str, _SmtBmcCheck] = {}
    last: CompletedCommand | None = None
    disk_limit_exceeded = False
    for name, flags in _SMTBMC_CHECKS:
        trace = _trace_relpath(name, _SOLVER)
        last, elapsed_ms = invoke(_SOLVER, flags, trace)
        check = _parse_check(last, flags, elapsed_ms, _written_trace(workspace_root, trace))
        disk_limit_exceeded = disk_limit_exceeded or last.disk_limit_exceeded
        if check.status == _PROVED_STATUS:
            cross_trace = _trace_relpath(name, _CROSS_CHECK_SOLVER)
            crossed, cross_elapsed_ms = invoke(_CROSS_CHECK_SOLVER, flags, cross_trace)
            check = replace(
                check,
                cross_check=_CrossCheck(
                    solver=_CROSS_CHECK_SOLVER,
                    exit_code=crossed.exit_code,
                    status=_parsed_status(crossed.stdout),
                    induction_successful=_induction_successful(crossed.stdout, flags),
                    elapsed_ms=cross_elapsed_ms,
                    trace_relpath=_written_trace(workspace_root, cross_trace),
                ),
            )
            disk_limit_exceeded = disk_limit_exceeded or crossed.disk_limit_exceeded
        checks[name] = check
    return _ChecksOutcome(checks=checks, last=last, disk_limit_exceeded=disk_limit_exceeded)


def _trace_artifacts(
    workspace_root: Path, checks: dict[str, _SmtBmcCheck]
) -> dict[str, ArtifactRef]:
    """Register every counterexample trace that was ACTUALLY written, and nothing else.

    OPPORTUNISTIC, never a required output (Requirement 12.18, 12.19):
    ``missingRequiredOutputs`` in ``app/tools/sandbox/classification.ts`` forces the whole
    invocation to ``error`` when a required output is absent, and a SUCCESSFUL PROOF writes
    no trace - so naming a trace as required would classify every proof as ``error``. A
    check that wrote none simply contributes no entry.

    THE BASE CASE'S TRACE TAKES THE ``vcd`` KEY, and that placement is the load-bearing
    part: ``refutation()`` on the TypeScript side reads ``result.artifacts['vcd']``, and the
    base case is the only check whose counterexample can source a refutation
    (:data:`_BASE_CHECK`). Every other trace is registered under its own workspace-relative
    name, so it survives as evidence without competing for that one key.
    """
    artifacts: dict[str, ArtifactRef] = {}
    for name, check in checks.items():
        if check.trace_relpath is not None:
            key = _VCD_ARTIFACT_KEY if name == _BASE_CHECK else check.trace_relpath
            artifacts[key] = _hash_artifact(workspace_root / check.trace_relpath, workspace_root)
        cross = check.cross_check
        if cross is not None and cross.trace_relpath is not None:
            artifacts[cross.trace_relpath] = _hash_artifact(
                workspace_root / cross.trace_relpath, workspace_root
            )
    return artifacts


def _write_formal_report(
    workspace_root: Path,
    lowering: CompletedCommand,
    assertion_count: int,
    checks: dict[str, _SmtBmcCheck],
) -> dict[str, ArtifactRef]:
    """Write ``formal-report.json``, register it, and register any trace that was written.

    ``assertionCount`` is written on EVERY run, including as 0, so the TypeScript
    guard can never read an absent count as a satisfied one, and a run that passed the
    guard is distinguishable from a guard that never ran.

    A failed write (the workspace disk cap being the realistic way) registers no
    artifact AT ALL, the traces included: the report is the evidence the classifying side
    reads, and handing back a counterexample with no report to place it in would offer
    evidence for a verdict that cannot be reached. That absence classifies as ``error`` on
    the TypeScript side and as ``could-not-verify`` at the formal gate. The run's own
    streams are still reported, so the failure is visible rather than crashing the worker
    and losing every fact about the run.
    """
    payload: dict[str, JsonValue] = {
        "lowering": {
            "exitCode": lowering.exit_code,
            "stderrTail": _sanitized_stderr_tail(lowering.stderr),
        },
        "assertionCount": assertion_count,
        "checks": {name: check.as_dict() for name, check in checks.items()},
    }
    report_path = workspace_root / _FORMAL_REPORT_FILENAME
    try:
        report_path.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        return {}
    # The report key is spelled LAST so no trace key could ever shadow it, whatever a
    # future trace filename becomes.
    return {
        **_trace_artifacts(workspace_root, checks),
        _FORMAL_REPORT_ARTIFACT_KEY: _hash_artifact(report_path, workspace_root),
    }


def formal(  # noqa: PLR0913 - six is what the seam needs; see the docstring
    workspace_root: Path,
    source_relpaths: list[str],
    request: FormalRequest,
    runner: CommandRunner,
    timeout_s: float,
    disk_limit_bytes: int,
) -> EdaCapture:
    """Lower the workspace sources to SMT2 and run the four solver checks.

    The parameters mirror :func:`simulate` - workspace, sources, injected runner, and
    the two resource bounds - plus the job's validated ``formal`` payload, which is
    the one thing a formal run needs and a simulation does not.

    NO VERDICT IS DECIDED HERE. The report carries the assertion count, each check's
    exit code, its parsed ``Status:`` string, the step a cover was reached at, whether
    induction succeeded, each elapsed time, the trace each check wrote where it wrote one,
    and the cross-check's own result where one was run; the five-condition gate that turns
    those into ``proved``/``refuted``/``could-not-verify`` is on the TypeScript side.

    The reported exit code is the last invocation that ran - the induction check when
    the lowering produced an SMT2, the lowering itself otherwise - mirroring
    :func:`simulate`, which reports the simulation's exit and falls back to the
    compiler's when the compile failed. It is NOT the verdict: a refuted property
    exits 1, and the classifying side reads the report rather than the code.
    """
    refusal = _formal_refusal(source_relpaths, request)
    if refusal is not None:
        # Refused before any command is built, so no artifact and an honest non-zero
        # exit: a missing `formalReport` is classified `error`, never a proof.
        return EdaCapture(
            _REFUSED_EXIT,
            "",
            refusal,
            stdout_truncated=False,
            stderr_truncated=False,
            disk_limit_exceeded=False,
        )

    script = YOSYS_FORMAL_SCRIPT.format(sources=" ".join(source_relpaths), top=request.top_module)
    lowering = runner.run(["yosys", "-p", script], workspace_root, timeout_s, disk_limit_bytes)
    smt2_path = workspace_root / _SMT2_FILENAME
    assertion_count = _count_smt2_assertions(smt2_path)
    checks = (
        _run_checks(workspace_root, request.depth, runner, timeout_s, disk_limit_bytes)
        if smt2_path.is_file()
        else _checks_not_run()
    )
    reported = lowering if checks.last is None else checks.last
    return EdaCapture(
        exit_code=reported.exit_code,
        stdout=reported.stdout,
        stderr=reported.stderr,
        stdout_truncated=reported.stdout_truncated,
        stderr_truncated=reported.stderr_truncated,
        # Every invocation shares one workspace cap, so a breach by any of them is a
        # fact about the run the caller receives.
        disk_limit_exceeded=lowering.disk_limit_exceeded or checks.disk_limit_exceeded,
        artifacts=_write_formal_report(workspace_root, lowering, assertion_count, checks.checks),
    )


# --- The Reset_Contract_Prepass (Requirement 14) --------------------------------------------
#
# A SECOND Yosys invocation over the candidate DESIGN ALONE, under its own job kind, deriving
# three facts the Property_Wrapper needs before it can be rendered: the reset net and its
# polarity, the Clock_Contract, and the initial-state predicate the free-initial-state fact is
# read from.
#
# WHAT IS DECIDED HERE AND WHAT IS NOT. This side reads the netlist and the SMT2, because it is
# the only side that holds them, and it derives the reset net, its polarity, its kind, and the
# clock finding - which is what Requirements 14.14 to 14.16, 14.28, and 14.29 place on the
# Reset_Contract_Prepass. The FREE-INITIAL-STATE FACT is NOT decided here: the predicate's TEXT
# crosses the seam and ``app/tools/formal/prepass.ts`` reads it, so that one rule has a single
# owner on the side that also owns the refusal it produces. See that module's header for why
# the split falls where it does.
#
# NOTE ON ``synthesize``, so nobody infers a fix that did not happen: this adds a FOURTH job
# kind and changes nothing about the second, which is STILL undispatched
# (``chipAgent/_inbox/gotcha-worker-synthesize-kind-unimplemented.md``).


@dataclass(frozen=True, slots=True)
class _ResetEntry:
    """One flip-flop cell's reset, as the pre-pass read it off the elaborated netlist.

    Built ONLY for a cell whose reset net resolved to a top-level INPUT PORT
    (Requirement 14.15), so the port filter is applied at construction rather than downstream:
    an internal reset net cannot be driven by a Property_Wrapper assume, so an entry naming one
    is not a weaker entry but no entry at all.

    The ENABLE pair is read for the same cell and through the same port filter, and it is
    reported rather than decided here: :func:`_derived_reset` owns the rule.
    """

    #: The top-level input port the reset resolved to.
    net: str
    #: ``"async"`` for an ``ARST`` cell, ``"sync"`` for an ``SRST`` one.
    kind: str
    #: The polarity as ``int(v, 2)``, or ``None`` where the value was not readable as 0 or 1.
    polarity: int | None
    #: The top-level input port this cell's ``EN`` resolved to, or ``None`` where the cell
    #: carries no enable or its enable is internal, constant, or wider than one bit.
    enable_net: str | None
    #: ``EN_POLARITY`` as ``int(v, 2)``, or ``None`` where absent or unreadable.
    enable_polarity: int | None


def _polarity_bit(raw: object) -> int | None:
    """One polarity parameter as a BINARY INTEGER, or ``None`` where it is not readable.

    ``int(v, 2)`` OVER THE WHOLE STRING, and NEVER a comparison against ``"1"``
    (Requirement 14.16, 14.29). MEASURED, on Yosys 0.66 in this workspace: ``write_json`` emits
    the value as a binary string whose WIDTH IS NOT STABLE.

    - ``ARST_POLARITY`` 0 prints as 32 characters after ``prep``.
    - ``SRST_POLARITY`` 1 prints as ``"00000000000000000000000000000001"`` after
      ``opt_dff -sat``, and ``ARST_POLARITY`` 1 prints as ``"1"`` after plain ``prep``.
    - ``CLK_POLARITY`` 1 printed as ``"1"`` on an ``$adff`` design and as 32 characters on an
      ``$sdffe`` one, IN THE SAME PASS SEQUENCE - so the two designs' identical real polarity
      is spelled two different ways in one run.

    A string compare against ``"1"`` therefore reads the same design differently depending on
    which passes ran and which cell type the flop became. It would have read BOTH real
    sync-reset references, whose raw value IS the 32-character form, as active-LOW, and it
    reads a posedge flop as negedge or the reverse on the clock parameter. That failure is
    SILENT and it flips a polarity, which is the worst mode available here.

    A value that is neither 0 nor 1, and a value of an unexpected JSON type, are both reported
    as UNREADABLE rather than coerced: the caller turns an unreadable polarity into a refusal,
    never into a guess.
    """
    if isinstance(raw, bool):
        return int(raw)
    if isinstance(raw, int):
        return raw if raw in (0, 1) else None
    if not isinstance(raw, str):
        return None
    try:
        value = int(raw, 2)
    except ValueError:
        return None
    return value if value in (0, 1) else None


def _top_level_input_bits(module: dict[str, Any]) -> dict[int, str]:
    """Every net bit that is a top-level INPUT port of the elaborated design, bit to port name.

    The lookup table the reset port filter is applied through (Requirement 14.15). INPUTS only:
    an output or an internal net cannot be driven by a Property_Wrapper assume, so a reset
    resolving to one is not derivable however unambiguous it looks.

    Every field is checked rather than assumed, because this is a tool's output over untrusted
    input; an unrecognized shape contributes nothing, which makes the derivation refuse.
    """
    ports = module.get("ports")
    if not isinstance(ports, dict):
        return {}
    bits: dict[int, str] = {}
    for name, port in ports.items():
        if not isinstance(port, dict) or port.get("direction") != "input":
            continue
        port_bits = port.get("bits")
        if not isinstance(port_bits, list):
            continue
        for bit in port_bits:
            if isinstance(bit, int):
                bits[bit] = str(name)
    return bits


def _connected_input_port(connections: object, name: str, input_bits: dict[int, str]) -> str | None:
    """The top-level input port a cell's one-bit ``name`` connection resolves to, else ``None``.

    THIS IS THE PORT FILTER, and it is doing real work on every sync-reset run rather than
    standing by for a rare case: MEASURED, ``radix2_div`` yields ELEVEN ``SRST`` cells, FOUR of
    them on internal nets (``$auto$opt_dff.cc:275:combine_resets$116``,
    ``$and$radix2_div.v:58$21_Y``, and that first name twice), and a derivation written without
    this filter would see several nets and REFUSE the design outright.

    A constant bit (``write_json`` spells those as strings), a multi-bit connection, and a bit
    belonging to no input port all resolve to ``None``, which drops the entry. That is the
    specified rule rather than a lenience: the filter keeps entries whose net IS a top-level
    input port, and everything else is not one.
    """
    if not isinstance(connections, dict):
        return None
    bits = connections.get(name)
    if not isinstance(bits, list) or len(bits) != 1 or not isinstance(bits[0], int):
        return None
    return input_bits.get(bits[0])


def _flip_flop_facts(
    module: dict[str, Any], input_bits: dict[int, str]
) -> tuple[list[_ResetEntry], list[int | None]]:
    """Every flip-flop cell's reset entry and clock polarity, read in ONE walk.

    ONE walk rather than two, because the walk is already happening and the marginal cost of
    the third parameter is nil (Requirement 14.28) - which is the whole reason the Clock_Contract
    is affordable at all against the pre-pass's measured 0.72s over 48 designs.

    The clock list carries one entry per CLOCKED cell, including an unreadable one as ``None``,
    so a polarity the pre-pass could not read cannot silently shrink the vote set.
    """
    cells = module.get("cells")
    resets: list[_ResetEntry] = []
    clocks: list[int | None] = []
    if not isinstance(cells, dict):
        return resets, clocks
    for cell in cells.values():
        parameters = cell.get("parameters") if isinstance(cell, dict) else None
        if not isinstance(parameters, dict):
            continue
        connections = cell.get("connections")
        # The enable is read ONLY for a cell type whose enable gates its reset, because on every
        # other type the reset fires whatever the enable does and that net is not part of the
        # reset. A type this set does not name has no enable FACT to read, which is the same
        # shape as an enable on an internal net.
        gates_its_reset = cell.get("type") in _ENABLE_GATED_RESET_CELLS
        if _CLK_POLARITY_PARAMETER in parameters:
            clocks.append(_polarity_bit(parameters[_CLK_POLARITY_PARAMETER]))
        for parameter, connection, kind in _RESET_PARAMETERS:
            if parameter not in parameters:
                continue
            net = _connected_input_port(connections, connection, input_bits)
            if net is not None:
                resets.append(
                    _ResetEntry(
                        net=net,
                        kind=kind,
                        polarity=_polarity_bit(parameters[parameter]),
                        # Same port filter as the reset net, because an enable this layer cannot
                        # NAME is one a Property_Wrapper assume cannot drive.
                        enable_net=(
                            _connected_input_port(connections, _ENABLE_CONNECTION, input_bits)
                            if gates_its_reset
                            else None
                        ),
                        enable_polarity=_polarity_bit(parameters.get(_ENABLE_POLARITY_PARAMETER)),
                    )
                )
    return resets, clocks


def _derived_reset(entries: list[_ResetEntry]) -> dict[str, JsonValue]:
    """The derived reset facts, or the refusal, from the entries that survived the port filter.

    THE MEASURED RULE (Requirement 14.17, 14.18): one retained net carrying one polarity
    DERIVES it; several nets, several polarities, or NONE refuses. ``len(nets) != 1`` covers the
    "none" case and the "several" case in one test, which is correct rather than terse - both
    mean no single reset name can be right for all this design's flops.

    An unreadable polarity refuses too. An ENABLE-GATED reset does NOT refuse: the enable IS
    read, by :func:`_derived_reset_enable` below, and the derived facts carry it. That is
    criterion 4.15 of ``formal-gate-first-light``, which AMENDS Requirement 14.19.

    ``resetActiveLow`` is ``polarity == 0``, confirmed on real designs rather than assumed:
    ``counter_12``'s ``rst_n`` reads ``ARST_POLARITY`` 0 and is active-LOW in source, and both
    ``radix2_div``'s ``rst`` and ``LIFObuffer``'s ``Rst`` read ``SRST_POLARITY`` 1 and are
    active-HIGH in source.

    Every refusal is FAIL-SAFE - a refusal, never a wrong polarity - which is what makes the
    three measured refusal classes acceptable: ``asyn_fifo`` genuinely has TWO reset ports;
    under ``opt_dff -sat`` only, ``multi_pipe_8bit`` acquires a spurious ``SRST`` on the data
    enable ``mul_en_in``; and ``opt_dff -sat`` can MERGE a sync reset term into a coincident
    next-state term, so a sync-reset counter that wraps to zero AND resets to zero can lose its
    reset port to an internal merged net. Model-generated RTL writes that last shape constantly,
    so the refusal rate on sync-reset designs is HIGHER than the corpus figures suggest.
    """
    nets = {entry.net for entry in entries}
    kinds = {entry.kind for entry in entries}
    polarities = {entry.polarity for entry in entries}
    if len(nets) != 1 or len(kinds) != 1 or len(polarities) != 1:
        return {"derived": False}
    polarity = next(iter(polarities))
    if polarity is None:
        return {"derived": False}
    reset: dict[str, JsonValue] = {
        "derived": True,
        "resetName": next(iter(nets)),
        "resetActiveLow": polarity == 0,
        "resetKind": next(iter(kinds)),
    }
    enable = _derived_reset_enable(entries)
    if enable is not None:
        reset["resetEnable"] = enable
    return reset


def _derived_reset_enable(entries: list[_ResetEntry]) -> dict[str, JsonValue] | None:
    """The one enable the retained reset entries agree on, or ``None`` where there is no one.

    THE RULE CRITERION 4.15 OF ``formal-gate-first-light`` ADDS, which AMENDS the parent spec's
    Requirement 14.19 (see that spec's ``design.md``, Component 20). An ``$sdffce`` resets only
    while its enable is active, so a contract naming the reset alone states a conditional reset
    as if it were unconditional and the assume rendered from it leaves the solver free to hold
    the enable at the one level where the reset does not fire.

    Where every retained entry CARRYING an enable agrees on one enable net with one readable
    polarity, that net and its asserted level are reported. An entry whose enable is internal,
    constant, absent, wider than one bit, or on a cell type whose reset has PRIORITY over its
    enable (:data:`_ENABLE_GATED_RESET_CELLS`) casts no vote, exactly as the port filter already
    drops an internal RESET net - MEASURED on ``LIFObuffer``, whose seven ``$sdffce`` cells put
    five enables on internal ``make_patterns_logic`` nets and two on the top-level input.

    AN UNCERTAIN ENABLE IS ABSENT RATHER THAN GUESSED, and the direction is the reason: naming
    an enable makes the reset assume pin MORE at step 0, which is the false-PROOF direction. So
    several enable nets, none nameable, or an unreadable ``EN_POLARITY`` all report no enable
    and leave the emitted assume exactly where it is today. Absence is a DIFFERENT SHAPE from
    an enable asserted low - the key is omitted rather than written with a defaulted level - so
    no reader can mistake "we could not name it" for "it is asserted low".

    Split out of :func:`_derived_reset` so the reset vote and the enable vote each read as one
    statement; that function stays the single owner of the reset rule and this is its enable
    half, called from one place.
    """
    enables = {
        (entry.enable_net, entry.enable_polarity)
        for entry in entries
        if entry.enable_net is not None
    }
    if len(enables) != 1:
        return None
    net, polarity = next(iter(enables))
    if polarity is None:
        return None
    return {"name": net, "activeLow": polarity == 0}


def _derived_clock_polarity(polarities: list[int | None]) -> str | None:
    """The Clock_Contract finding, or ``None`` where a polarity could not be read at all.

    FOUR VALUES RATHER THAN A BOOLEAN, and the TypeScript side holds the vocabulary
    (Requirement 14.36). ``none`` is a design with NO CLOCKED STATE, which is 15 of 50
    references and is SUPPORTED, so it must not collapse into ``posedge`` and must not read as a
    refusal (Requirement 14.34). Separating ``negedge`` from ``mixed`` records WHICH class a
    refusal came from even though both refuse, which is the only way the measured-EMPTY
    negedge-only class stops being an assumption about the corpus and becomes an observation
    this report can contradict.

    ``None`` - no finding at all - is returned where any clocked cell's polarity was UNREADABLE,
    and the caller then writes NO REPORT. That is deliberate and it is the only honest option:
    none of the four members names "could not read", guessing ``posedge`` is exactly the
    FALSE-REFUTATION direction the whole clock rule exists to close, and an absent report is
    already the shape the TypeScript side reads as ``toolchain-unavailable``
    (Requirement 14.26).
    """
    if not polarities:
        return "none"
    if None in polarities:
        return None
    distinct = set(polarities)
    if distinct == {1}:
        return "posedge"
    if distinct == {0}:
        return "negedge"
    return "mixed"


def _predicate_body(fragment: str, remaining: Iterable[str]) -> str | None:
    """The parenthesis-balanced body of the ``define-fun`` ``fragment`` opens, else ``None``.

    Depth starts at 1 because the caller has already consumed the ``define-fun``'s own opening
    parenthesis together with its ``Bool`` return type, so the parenthesis that takes the depth
    back to zero is the one that closes the whole form. Balanced rather than line-matched
    because both shapes are MEASURED: a free predicate is ``true`` on the header's own line,
    and a pinned one spans three lines.

    ``;`` to end of line is an SMT-LIB comment and is dropped before balancing, because Yosys
    annotates the predicate with the signal name it came from (``; out``).

    Accumulation stops at :data:`MAX_INITIAL_STATE_PREDICATE_CHARS` and the whole read then
    reports UNREADABLE, so neither the memory nor the reported field is unbounded, and a
    truncated predicate is never handed on as a predicate.

    ponytail: paren-balancing treats a parenthesis inside a QUOTED SMT-LIB symbol as structure.
    Yosys emits none in this predicate, and the failure direction is an unbalanced scan that
    runs off the end and reports UNREADABLE, which the TypeScript side refuses. Upgrade path is
    an SMT-LIB tokenizer, which is a large surface for a case never observed.
    """
    depth = 1
    body: list[str] = []
    for line in chain((fragment,), remaining):
        for char in line.split(";", 1)[0]:
            if char == ")":
                depth -= 1
                if depth == 0:
                    return "".join(body).strip()
            elif char == "(":
                depth += 1
            if len(body) >= MAX_INITIAL_STATE_PREDICATE_CHARS:
                return None
            body.append(char)
    return None


def _initial_state_predicate(smt2_path: Path, top_module: str) -> str | None:
    """The body of the SMT2 initial-state predicate, or ``None`` where it could not be read.

    ``(define-fun |<design>_i| ((state |<design>_s|)) Bool <body>)`` is the form
    ``write_smt2`` emits, and the BODY is the whole point: literally ``true`` means every state
    bit starts free, because a register with no init value contributes no equality to it
    (Requirement 14.21, 14.22). Read from the DESIGN's predicate rather than the
    Property_Wrapper's because the wrapper does not exist when the pre-pass runs
    (Requirement 14.23).

    THE BODY AND NOT THE FACT. Whether ``<body>`` being ``true`` means the initial state is FREE
    is decided ONCE, in ``app/tools/formal/prepass.ts``, together with the refusal an absent or
    unreadable predicate produces. This function's whole job is to hand that text across the
    seam, or to say it could not.

    ``re.escape`` is load-bearing rather than decorative: a Verilog identifier may contain
    ``$``, which the seam's own ``topModule`` pattern admits and which is a regex metacharacter.

    Streamed line by line, like :func:`_count_smt2_assertions`, because an SMT2 is as large as
    the design made it - 251269 bytes for ``verified_ROM`` - and holding one whole to find one
    line is the resource shape this module bounds everywhere else.
    """
    header = re.compile(rf"\(define-fun \|{re.escape(top_module)}_i\|[^\n]*?\bBool\b")
    try:
        with smt2_path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                match = header.search(line)
                if match is not None:
                    return _predicate_body(line[match.end() :], handle)
    except OSError:
        return None
    return None


def _prepass_netlist_module(workspace_root: Path, top_module: str) -> dict[str, Any] | None:
    """The elaborated top module from the pre-pass ``write_json``, or ``None`` if unreadable.

    Every step is checked rather than assumed - the size bound, the JSON parse, the ``modules``
    map, and the named module's presence - because this file is a tool's output over untrusted
    input and an unrecognized shape must refuse rather than derive from whatever it found.

    The module is looked up BY the requested ``-top`` name rather than by the ``top`` attribute,
    so the facts derived are the facts of the design the job named and not of whichever module
    Yosys happened to elaborate.
    """
    path = workspace_root / _PREPASS_NETLIST_FILENAME
    try:
        if path.stat().st_size > MAX_PREPASS_NETLIST_BYTES:
            return None
        with path.open(encoding="utf-8") as handle:
            netlist = json.load(handle)
    except (OSError, ValueError):
        return None
    modules = netlist.get("modules") if isinstance(netlist, dict) else None
    module = modules.get(top_module) if isinstance(modules, dict) else None
    return cast("dict[str, Any]", module) if isinstance(module, dict) else None


def _prepass_report(
    workspace_root: Path, request: FormalPrepassRequest
) -> dict[str, JsonValue] | None:
    """The derived pre-pass report, or ``None`` where the evidence could not be read at all.

    ``None`` means NO REPORT IS WRITTEN, which the TypeScript side reads as
    ``toolchain-unavailable`` because the required ``formalPrepassReport`` output is then absent
    (Requirement 14.26). It is reached for an unreadable netlist and for an unreadable clock
    polarity, and for nothing else - a REFUSED reset derivation is a first-class OUTCOME carried
    IN the report (Requirement 14.20), never an error, which is why ``reset`` is always present.
    """
    module = _prepass_netlist_module(workspace_root, request.top_module)
    if module is None:
        return None
    resets, clocks = _flip_flop_facts(module, _top_level_input_bits(module))
    clock_polarity = _derived_clock_polarity(clocks)
    if clock_polarity is None:
        return None
    return {
        "reset": _derived_reset(resets),
        "clockPolarity": clock_polarity,
        "initialStatePredicate": _initial_state_predicate(
            workspace_root / _PREPASS_SMT2_FILENAME, request.top_module
        ),
    }


def _write_prepass_report(
    workspace_root: Path, payload: dict[str, JsonValue]
) -> dict[str, ArtifactRef]:
    """Write ``formal-prepass-report.json`` and register it, or register nothing.

    A failed write (the workspace disk cap being the realistic way) registers NO artifact, by
    the same rule :func:`_write_formal_report` follows: the report is the entire output of a
    pre-pass, so a run that could not write it produced nothing to interpret. That absence
    classifies as ``error`` on the TypeScript side and as ``could-not-verify`` with
    ``toolchain-unavailable`` at the formal gate. The run's own streams are still reported, so
    the failure is visible rather than crashing the worker.
    """
    path = workspace_root / _PREPASS_REPORT_FILENAME
    try:
        path.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        return {}
    return {_PREPASS_REPORT_ARTIFACT_KEY: _hash_artifact(path, workspace_root)}


def _prepass_refusal(source_relpaths: list[str], request: FormalPrepassRequest) -> str | None:
    """The reason this job must not become a Yosys invocation, or ``None`` to proceed.

    The same two interpolation rules :func:`_formal_refusal` applies, through the SAME two
    owners - :data:`contract.TOP_MODULE_RE` and :data:`_SCRIPT_SAFE_RELPATH_RE` - and no depth
    rule, because the pre-pass runs no solver. There is no third rule and no relaxed one: the
    pre-pass's script is ONE ``-p`` argument holding a semicolon-separated command list exactly
    as the lowering's is, and Yosys splits it on ``;`` ITSELF.

    THE ``;`` INJECTION MITIGATION IS APPLIED HERE, at the last point before any source name
    reaches a Yosys command line, because the pre-pass ASSEMBLES ITS SCRIPT THE SAME WAY and so
    inherits the same channel. MEASURED on Yosys 0.66 in this workspace: a source file named
    ``design.v; write_verilog INJECTED.v`` makes Yosys run that second command. Path confinement
    (:mod:`tool_runner_worker.paths`) bounds WHERE a job may write, not what its filename may
    SAY, so the script grammar needs its own whitelist rather than inheriting that one
    (``chipAgent/_inbox/gotcha-path-confinement-accepts-a-filename-carrying-a-semicolon.md``).

    Each message names the RULE and never echoes the value.
    """
    if not source_relpaths:
        return "no Verilog source files to elaborate"
    if TOP_MODULE_RE.fullmatch(request.top_module) is None:
        return "formalPrepass topModule is not a plain Verilog identifier"
    if any(_SCRIPT_SAFE_RELPATH_RE.fullmatch(path) is None for path in source_relpaths):
        return "a source path holds a character the Yosys script grammar would reinterpret"
    return None


def formal_prepass(  # noqa: PLR0913 - six is what the seam needs; see :func:`formal`
    workspace_root: Path,
    source_relpaths: list[str],
    request: FormalPrepassRequest,
    runner: CommandRunner,
    timeout_s: float,
    disk_limit_bytes: int,
) -> EdaCapture:
    """Elaborate the candidate design alone and derive its reset and clock contracts.

    The parameters mirror :func:`formal` - workspace, sources, injected runner, and the two
    resource bounds - plus the job's validated ``formalPrepass`` payload. It executes through
    the same :class:`CommandRunner` under the same wall-clock and workspace-disk bounds as every
    other invocation in this module (Requirement 14.25).

    NO VERDICT IS DECIDED HERE, and no Formal_Verdict is reachable from here: the pre-pass runs
    no solver. The report carries the derived reset facts or their refusal, the clock finding,
    and the initial-state predicate's text; the causes those turn into
    (``reset-contract-unresolved``, ``clock-contract-unsupported``, ``toolchain-unavailable``)
    are named on the TypeScript side, which is where the Could_Not_Verify vocabulary lives.

    The reported exit code is Yosys's own. It is NOT the outcome: a design whose reset the
    derivation REFUSES still lowers cleanly and exits 0, and a ``write_smt2`` that aborted still
    leaves a readable netlist behind, so the classifying side reads the report rather than the
    code.
    """
    refusal = _prepass_refusal(source_relpaths, request)
    if refusal is not None:
        # Refused before any command is built, so no artifact and an honest non-zero exit: a
        # missing `formalPrepassReport` is classified `error`, never a derived contract.
        return EdaCapture(
            _REFUSED_EXIT,
            "",
            refusal,
            stdout_truncated=False,
            stderr_truncated=False,
            disk_limit_exceeded=False,
        )

    script = YOSYS_PREPASS_SCRIPT.format(sources=" ".join(source_relpaths), top=request.top_module)
    run = runner.run(["yosys", "-p", script], workspace_root, timeout_s, disk_limit_bytes)
    report = _prepass_report(workspace_root, request)
    return EdaCapture(
        exit_code=run.exit_code,
        stdout=run.stdout,
        stderr=run.stderr,
        stdout_truncated=run.stdout_truncated,
        stderr_truncated=run.stderr_truncated,
        disk_limit_exceeded=run.disk_limit_exceeded,
        artifacts={} if report is None else _write_prepass_report(workspace_root, report),
    )
