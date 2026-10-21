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

:func:`synthesize` is the Netlist_Stage (and, where requested, the Schematic_Stage) of a
Synthesize_Job: it runs Yosys ``synth`` once, decides nothing, and reports the same raw
shape as every routine above. ``worker.py._run_kind`` now dispatches it, closing the gap
``chipAgent/_inbox/gotcha-worker-synthesize-kind-unimplemented.md`` recorded.

:func:`lint` is the Lint_Engine's one Yosys invocation for a Lint_Job: ``synth -top`` followed
by ``check -assert`` under a ``tee -q -o`` log, so the worker can tell "the check never ran"
from "the check ran and found N problems" - a distinction the Yosys exit code alone collapses.
It decides nothing either; ``_lint_report`` only reads the log and the TypeScript side
classifies.
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
    LintRequest,
    SimulateRequest,
    SynthesizeRequest,
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

#: The cell types that RETAIN STATE, and so END a backward cone walk (Requirement 1.4).
#:
#: Reaching one of these means the port's value is held across a clock edge rather than
#: computed from this cycle's inputs, which is the Sequential_Element boundary the Port_Timing
#: question turns on.
#:
#: NAMED rather than inferred, exactly as :data:`_ENABLE_GATED_RESET_CELLS` is named, because
#: an unlisted type would otherwise be CROSSED as combinational logic here, and that is the
#: false-``combinational`` direction. Measured over the corpus: these eleven, and no clocked
#: cell outside them. ``$aldff`` (bare async-load, no enable) joined this set after the task
#: 11.1 pass-sequence equivalence measurement found it missing: under ``prep`` alone,
#: ``multi_booth_8bit``'s async-load reset elaborates to a bare ``$aldff`` rather than the
#: enabled ``$aldffe`` the existing ``opt_dff -sat`` pass happens to fold it into, so without
#: this entry the port refused as ``unrecognized-clocked-cell`` under the un-enriched sequence
#: instead of deriving ``registered`` as the committed Ground_Truth_Manifest records. The guard
#: that turns an unlisted clocked cell into a REFUSAL rather than a crossing is
#: :func:`_cell_timing_refusal`'s ``unrecognized-clocked-cell``.
_RETAINED_STATE_CELLS: Final[frozenset[str]] = frozenset(
    {
        "$adff",
        "$adffe",
        "$aldff",
        "$aldffe",
        "$dff",
        "$dffe",
        "$dlatch",
        "$mem_v2",
        "$sdff",
        "$sdffce",
        "$sdffe",
    }
)

#: The memory cell type, which is a retained-state boundary on every pin EXCEPT an
#: ASYNCHRONOUS ``RD_DATA`` bit (Requirement 1.12).
#:
#: It stays a member of :data:`_RETAINED_STATE_CELLS` and is tested BEFORE that set, because a
#: memory still carries ``RD_CLK`` and ``WR_CLK`` and so must keep its place among the NAMED
#: clocked types the ``unrecognized-clocked-cell`` guard is defined against. Removing it there
#: to special-case it here would make a memory look like a type nobody named.
_MEMORY_CELL = "$mem_v2"

#: The memory parameters the asynchronous-read rule reads: the per-read-port clock-enable MASK,
#: and the data WIDTH that turns an ``RD_DATA`` bit position into a read-port index.
_READ_CLOCK_ENABLE_PARAMETER = "RD_CLK_ENABLE"
_MEMORY_WIDTH_PARAMETER = "WIDTH"

#: The memory's only OUTPUT pin, and so the only pin the cone walk can arrive at.
_READ_DATA_PIN = "RD_DATA"

#: What an ASYNCHRONOUS read exposes combinationally, paired with the parameter giving ONE read
#: port's share of that pin: the address it is reading (``ABITS`` bits per port) and the enable
#: qualifying the read (one bit per port, hence ``None``).
#:
#: Every pin on a ``$mem_v2`` is the read ports' slices CONCATENATED, so each is sliced per port
#: rather than traversed whole. Traversing it whole would report one read port as depending on
#: ANOTHER port's address input, which is a source that does not reach it.
#:
#: ``RD_CLK`` is absent because an asynchronous read port ties its clock to ``x`` (measured on
#: both corpus memories), and ``WR_DATA`` is absent because a value written on a previous edge
#: arrives through retained state - which is the ``reaches_state`` this rule sets, not a
#: combinational source.
_ASYNC_READ_INPUT_PINS: Final[tuple[tuple[str, str | None], ...]] = (
    ("RD_ADDR", "ABITS"),
    ("RD_EN", None),
)

#: The cell type that carries NO output pin, and so drives nothing in the cone walk.
#:
#: A fact about this cell type rather than a lenience: ``$scopeinfo`` records which source
#: module a flattened cell came from and its ``port_directions`` is legitimately EMPTY -
#: measured on ``adder_8bit``, which carries eight of them, one per flattened ``full_adder``.
#: Named so it stays out of the ``cell-shape-unreadable`` refusal, which must fire on a shape
#: that could not be READ and not on one that genuinely has no output.
_SCOPE_INFO_CELL = "$scopeinfo"

#: The pin that makes a cell CLOCKED, and so a boundary the cone walk has to recognise BY NAME.
_CLOCK_PIN = "CLK"

#: The CLOSED set of causes a design-level timing refusal may carry (Requirement 2.5).
#:
#: A cause is a bare TOKEN and carries nothing with it. No path, no design source text, no tool
#: diagnostic, and in particular no cell NAME: a Yosys cell name embeds the source file and
#: line it came from (``$auto$opt_dff.cc:275:combine_resets$116``,
#: ``$and$radix2_div.v:58$21_Y``), so naming the offending cell would leak a host path through
#: the one field that exists to say we could not read the design.
_MODULE_INSTANCE_CAUSE = "module-instance"
_UNRECOGNIZED_CLOCKED_CELL_CAUSE = "unrecognized-clocked-cell"
_CELL_SHAPE_UNREADABLE_CAUSE = "cell-shape-unreadable"

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


def _binary_parameter(raw: object) -> int | None:
    """One Yosys cell parameter as an INTEGER, or ``None`` where it is not readable.

    THE ONLY place a parameter is turned into a number, so that every rule reading one agrees
    on what a value means. The width restriction belongs to the CALLER: :func:`_polarity_bit`
    admits only 0 or 1 because a polarity wider than a bit is not a polarity, while a per-port
    mask like ``RD_CLK_ENABLE`` is legitimately many bits wide and is indexed instead.

    Read over the WHOLE string, so an unparseable value (``"x"``, ``"xxxx"``, an ``INIT``
    carrying don't-cares) reads as UNREADABLE rather than as zero. That direction is
    load-bearing: a caller that read an unreadable value as zero would call a clocked memory
    read asynchronous.

    BINARY DIGITS ONLY, rather than ``int(v, 2)`` on whatever arrived, because ``int`` is
    LENIENT in a way this netlist is not: it accepts a ``0b`` prefix, ``_`` separators, and
    surrounding whitespace, so ``"0b0"`` would read as zero. Yosys writes none of those, and
    the netlist is a tool's output over untrusted input, so a spelling the writer cannot
    produce is unreadable by definition.
    """
    if isinstance(raw, bool):
        return int(raw)
    if isinstance(raw, int):
        return raw
    if not isinstance(raw, str) or not raw or set(raw) - {"0", "1"}:
        return None
    return int(raw, 2)


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
    value = _binary_parameter(raw)
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


@dataclass(frozen=True, slots=True)
class _PortTimingFacts:
    """One declared output port's cone, as read off the elaborated netlist.

    FOUR FIELDS AND NO PER-PORT REFUSAL FIELD. A structural refusal has ONE representation,
    the design-level arm of the report, so a port this walk could not read is reported by that
    arm and not by a fifth field here that the wire schema does not carry.

    The classification itself is NOT here: these are the facts, and
    ``app/tools/formal/timing.ts`` owns the rule that turns them into a Port_Timing value, the
    same split the reset facts and :func:`_derived_reset` already follow.
    """

    #: The top-level output port name.
    port: str
    #: Top-level INPUT ports the cone reached without crossing a retained-state boundary,
    #: INCLUDING the clock and reset ports - the TypeScript side subtracts those, because it is
    #: the side that already knows which port is the clock and which is the reset.
    sources: list[str]
    #: Whether the cone reached a cell in :data:`_RETAINED_STATE_CELLS`.
    reaches_state: bool
    #: Whether a bit in the cone had no driver at all.
    undriven: bool


def _memory_shape_unreadable(cell: dict[str, Any]) -> bool:
    """Whether a ``$mem_v2``'s own shape parameters cannot be read.

    A shape we could not read is not evidence, so this is a refusal rather than a boundary:
    ``WIDTH`` is what places an ``RD_DATA`` bit on a read port and ``RD_CLK_ENABLE`` is what
    says whether that port is clocked, so without both there is no reading of this memory at
    all - not a clocked one and not an asynchronous one.

    The per-port widths are taken FROM :data:`_ASYNC_READ_INPUT_PINS` rather than respelled
    here, so what this guard covers is exactly what :func:`_async_read_bits` reads.

    ``RD_CLK_ENABLE`` is checked for READABILITY only and never against a value, because zero
    and one are both answers.
    """
    parameters = cell.get("parameters")
    if not isinstance(parameters, dict):
        return True
    if _binary_parameter(parameters.get(_READ_CLOCK_ENABLE_PARAMETER)) is None:
        return True
    widths = (_MEMORY_WIDTH_PARAMETER, *(name for _, name in _ASYNC_READ_INPUT_PINS if name))
    return any(
        (width := _binary_parameter(parameters.get(name))) is None or width <= 0 for name in widths
    )


def _cell_shape_unreadable(cell: dict[str, Any], cell_type: str) -> bool:
    """Whether this cell's SHAPE could not be read, which is evidence for nothing.

    ``port_directions`` and ``connections`` are the two things the cone walk reads a cell
    THROUGH - the first says which pins are outputs and the second says which bits they carry -
    so a cell missing either cannot be placed in any cone at all. A memory additionally has to
    parse its own shape parameters.

    "Not a dict" rather than "empty", because an EMPTY ``port_directions`` is exactly what
    :data:`_SCOPE_INFO_CELL` legitimately carries.
    """
    if not isinstance(cell.get("port_directions"), dict):
        return True
    if not isinstance(cell.get("connections"), dict):
        return True
    return cell_type == _MEMORY_CELL and _memory_shape_unreadable(cell)


def _cell_is_clocked(cell: dict[str, Any]) -> bool:
    """Whether this cell carries a :data:`_CLOCK_PIN`, read from BOTH places one can appear.

    The declared shape and the connections are both consulted because the guard this serves
    fails SAFE in only one direction: a cell wrongly called clocked is refused, while a clocked
    cell missed here is CROSSED as combinational logic.
    """
    return any(_CLOCK_PIN in cell.get(key, {}) for key in ("port_directions", "connections"))


def _cell_timing_refusal(cell: dict[str, Any]) -> str | None:
    """The structural cause by which this ONE cell refuses the design's timing finding.

    THREE CAUSES, ALL FAILING IN THE SAME DIRECTION. Each names a cell the cone walk would
    otherwise CROSS as ordinary combinational logic, and crossing something that is really a
    boundary is what reports a false ``combinational`` - the one error direction this feature
    exists to avoid.

    ``module-instance``
        A type not beginning with ``$`` is an unflattened submodule, so its internals were
        never elaborated and whatever state it holds is invisible here.
    ``unrecognized-clocked-cell``
        A cell carrying a :data:`_CLOCK_PIN` that :data:`_RETAINED_STATE_CELLS` does not name
        is a boundary we failed to recognise. Measured as EMPTY over the corpus - the eleven
        named types are every clocked cell it produces - so this is a GUARD against a future Yosys
        version or an unseen design rather than a live branch, in the same spirit as
        :data:`_ENABLE_GATED_RESET_CELLS` documenting its own direction.
    ``cell-shape-unreadable``
        A shape we could not read is not evidence: an unreadable type, ``port_directions``, or
        ``connections``, or a memory whose shape parameters do not parse.

    ``$scopeinfo`` is skipped FIRST: it is a metadata cell carrying no pins, the one cell type
    whose empty shape is a fact rather than a gap (eight of them on ``adder_8bit``).

    The TYPE is read before the shape, so an unflattened instance is reported as the submodule
    it is rather than as a shape we could not read - its type IS readable, and it is the
    decisive fact about it.
    """
    cell_type = cell.get("type")
    if cell_type == _SCOPE_INFO_CELL:
        return None
    if not isinstance(cell_type, str):
        return _CELL_SHAPE_UNREADABLE_CAUSE
    if not cell_type.startswith("$"):
        return _MODULE_INSTANCE_CAUSE
    if _cell_shape_unreadable(cell, cell_type):
        return _CELL_SHAPE_UNREADABLE_CAUSE
    if cell_type not in _RETAINED_STATE_CELLS and _cell_is_clocked(cell):
        return _UNRECOGNIZED_CLOCKED_CELL_CAUSE
    return None


def _structural_timing_refusal(cells: dict[str, Any]) -> str | None:
    """The ONE cause that refuses this design's whole timing finding, or ``None`` to derive.

    WHOLE-DESIGN rather than per-port: a cell the walk cannot cross honestly sits in some
    cone, and which cones it sits in is exactly what an unreadable shape leaves undecidable.

    The FIRST cause in the netlist's own cell order, because one cause is enough to refuse and
    the finding carries one. A netlist listing two defective cells is refused by whichever it
    lists first, which is stable for a given netlist.

    An entry of the ``cells`` map that is not a cell OBJECT at all is handled here rather than
    per cell: at that point there is no cell to ask about, only a document we could not read.
    """
    for cell in cells.values():
        if not isinstance(cell, dict):
            return _CELL_SHAPE_UNREADABLE_CAUSE
        cause = _cell_timing_refusal(cell)
        if cause is not None:
            return cause
    return None


def _cell_bit_drivers(cells: dict[str, Any]) -> dict[int, dict[str, Any]]:
    """Every net bit to the cell driving it, resolved from each cell's OUTPUT pins.

    STRUCTURAL rather than a pin-name table: ``port_directions`` is present on internal Yosys
    cells after ``prep -flatten`` - measured on ``$add``, ``$mux``, ``$pmux``, and ``$mem_v2`` -
    so the output pins are read off the cell itself and no list of pin names has to be kept up
    to date per cell type.

    Reached only for a netlist :func:`_structural_timing_refusal` has already accepted, so the
    two shapes this function cannot represent honestly - a cell whose ``port_directions`` could
    not be read, and a non-``$`` module instance - are REFUSED by name before the walk runs.
    The ``isinstance`` guards below therefore skip nothing a real netlist reaches here; they
    stay because this function must be correct about the shape it reads either way.
    """
    drivers: dict[int, dict[str, Any]] = {}
    for cell in cells.values():
        if not isinstance(cell, dict) or cell.get("type") == _SCOPE_INFO_CELL:
            continue
        directions = cell.get("port_directions")
        connections = cell.get("connections")
        if not isinstance(directions, dict) or not isinstance(connections, dict):
            continue
        for pin, direction in directions.items():
            if direction != "output":
                continue
            for bit in _connection_bits(connections, pin):
                if isinstance(bit, int):
                    drivers[bit] = cell
    return drivers


def _connection_bits(connections: dict[str, Any], pin: str) -> list[Any]:
    """The bit list on one cell pin, or an empty list where it is not a list at all.

    Bits are left UNTYPED here because ``write_json`` spells a constant bit as a STRING
    (``"0"``, ``"1"``, ``"x"``, ``"z"``) and an integer bit as an integer, and the walk needs
    to see both: a constant stops the walk, which is a different outcome from a bit it never
    visited.
    """
    bits = connections.get(pin)
    return bits if isinstance(bits, list) else []


def _cell_input_bits(cell: dict[str, Any]) -> list[Any]:
    """Every bit on every INPUT pin of ``cell``: what joins the frontier when it is crossed."""
    directions = cell.get("port_directions")
    connections = cell.get("connections")
    if not isinstance(directions, dict) or not isinstance(connections, dict):
        return []
    bits: list[Any] = []
    for pin, direction in directions.items():
        if direction == "input":
            bits.extend(_connection_bits(connections, pin))
    return bits


def _read_port_index(
    parameters: dict[str, Any], connections: dict[str, Any], bit: int
) -> int | None:
    """Which READ PORT of a memory owns ``bit`` of its ``RD_DATA``, else ``None``.

    DERIVED FROM THE BIT'S POSITION, because position is the only thing the walk holds. A
    ``$mem_v2``'s ``RD_DATA`` is ``RD_PORTS * WIDTH`` bits wide and read port ``p`` owns the
    contiguous slice ``[p * WIDTH, (p + 1) * WIDTH)``, so the port is the bit's index in that
    list floor-divided by the memory's ``WIDTH``.

    This is what makes the per-port parameter read land on the RIGHT port: on a two-read-port
    memory, reading bit 0 of the mask for every ``RD_DATA`` bit would clock the second port by
    the first one's rule, and that error is silent.
    """
    width = _binary_parameter(parameters.get(_MEMORY_WIDTH_PARAMETER))
    if width is None or width <= 0:
        return None
    data_bits = _connection_bits(connections, _READ_DATA_PIN)
    if bit not in data_bits:
        return None
    return data_bits.index(bit) // width


def _async_read_bits(cell: dict[str, Any], bit: int) -> list[Any] | None:
    """The bits an ASYNCHRONOUS memory read exposes at ``bit``, or ``None`` for a boundary.

    ``None`` means "treat this memory as the plain boundary it otherwise is", which is now a
    FACT about the read port rather than a mix of facts and gaps: a memory whose shape could
    not be read is refused as ``cell-shape-unreadable`` by :func:`_memory_shape_unreadable`
    before the walk starts, so the only ways past the asynchronous branch here are a genuinely
    CLOCKED read port and a bit that is not an ``RD_DATA`` bit at all.

    The guards below are kept rather than dropped on the strength of that: the structural pass
    reads the cell's own parameters and this one reads a per-bit slice of them, and a boundary
    is the right answer for a bit this rule cannot place either way.

    The mask is indexed by SHIFT rather than by character, so read port ``p``'s bit is the
    ``p``-th least significant one - the rightmost character of the string Yosys writes.
    """
    parameters = cell.get("parameters")
    connections = cell.get("connections")
    if not isinstance(parameters, dict) or not isinstance(connections, dict):
        return None
    read_port = _read_port_index(parameters, connections, bit)
    if read_port is None:
        return None
    clock_enables = _binary_parameter(parameters.get(_READ_CLOCK_ENABLE_PARAMETER))
    if clock_enables is None or (clock_enables >> read_port) & 1:
        return None
    exposed: list[Any] = []
    for pin, width_parameter in _ASYNC_READ_INPUT_PINS:
        per_port = (
            1 if width_parameter is None else _binary_parameter(parameters.get(width_parameter))
        )
        if per_port is None or per_port <= 0:
            return None
        start = read_port * per_port
        exposed.extend(_connection_bits(connections, pin)[start : start + per_port])
    return exposed


def _port_cone_facts(
    port: str,
    bits: list[Any],
    input_bits: dict[int, str],
    drivers: dict[int, dict[str, Any]],
) -> _PortTimingFacts:
    """One declared output port's cone facts, by backward breadth-first walk over net BITS.

    FOUR TERMINATIONS, and each one is a different fact rather than a shared "stop":
    a bit belonging to a top-level INPUT port records that port and stops; a CONSTANT bit
    (a string in ``write_json``) stops carrying nothing; a bit with NO DRIVER sets ``undriven``
    and stops; and a retained-state cell sets ``reaches_state`` and stops. Any other cell is
    CROSSED, putting every input pin's bits on the frontier.

    ONE EXCEPTION, and it is the only place a boundary is both set AND crossed: an
    ASYNCHRONOUS memory read sets ``reaches_state`` and still continues through the address
    and enable reaching it, which is the measured ``ROM`` case (Requirement 1.12).

    The visited set is over BITS and not over cells, because a cell with a wide output is
    reached once per bit and the question is per bit - which is also what bounds the walk: the
    frontier can only ever hold bits of this module.

    ``sources`` is sorted so one netlist derives one report, since the walk order of a frontier
    is not a fact about the design.
    """
    frontier = list(bits)
    visited: set[int] = set()
    sources: set[str] = set()
    reaches_state = False
    undriven = False
    while frontier:
        bit = frontier.pop()
        if not isinstance(bit, int) or bit in visited:
            continue
        visited.add(bit)
        if bit in input_bits:
            sources.add(input_bits[bit])
            continue
        cell = drivers.get(bit)
        if cell is None:
            undriven = True
            continue
        # A memory is checked BEFORE the retained-state set it belongs to, because an
        # asynchronous read is the one way past that boundary: the value still comes out of
        # memory, so `reaches_state` holds either way, but the address and enable reaching it
        # combinationally are real sources and a plain boundary would hide them.
        if cell.get("type") == _MEMORY_CELL:
            reaches_state = True
            exposed = _async_read_bits(cell, bit)
            if exposed is not None:
                frontier.extend(exposed)
            continue
        if cell.get("type") in _RETAINED_STATE_CELLS:
            reaches_state = True
            continue
        frontier.extend(_cell_input_bits(cell))
    return _PortTimingFacts(
        port=port,
        sources=sorted(sources),
        reaches_state=reaches_state,
        undriven=undriven,
    )


def _port_timing_facts(module: dict[str, Any], input_bits: dict[int, str]) -> list[JsonValue]:
    """The cone facts of every declared OUTPUT port, as the report carries them.

    Runs over the SAME ``cells`` map as :func:`_flip_flop_facts`, in the same call, and shares
    nothing with it: that walk reads cell PARAMETERS and this one reads CONNECTIVITY.

    Returned as the wire's own ``list[JsonValue]`` rather than as a list of the dataclass, so
    the report carries it directly and no second shape exists between here and the seam.

    A port whose declared ``bits`` are not a readable list contributes NO entry, which is the
    same fail-safe direction as the rest of this module - a reader that finds a declared port
    missing from this list has no derived value for it and must not invent one.
    """
    ports = module.get("ports")
    cells = module.get("cells")
    if not isinstance(ports, dict):
        return []
    drivers = _cell_bit_drivers(cells if isinstance(cells, dict) else {})
    facts: list[JsonValue] = []
    for name, port in ports.items():
        if not isinstance(port, dict) or port.get("direction") != "output":
            continue
        bits = port.get("bits")
        if not isinstance(bits, list):
            continue
        cone = _port_cone_facts(str(name), bits, input_bits, drivers)
        facts.append(
            {
                "port": cone.port,
                "sources": list(cone.sources),
                "reachesState": cone.reaches_state,
                "undriven": cone.undriven,
            }
        )
    return facts


def _timing_finding(module: dict[str, Any], input_bits: dict[int, str]) -> dict[str, JsonValue]:
    """The design's timing finding: every declared output port's cone facts, or ONE refusal.

    TWO ARMS AND NOTHING BETWEEN THEM. ``derived`` true carries ``ports``; ``derived`` false
    carries ``cause`` and NO ``ports``, because a refusal means the walk's answers are not
    evidence and half a finding would be read as a finding. That is also why there is no
    per-port refusal field on :class:`_PortTimingFacts`: one refusal, one representation.

    The structural pass runs BEFORE the walk rather than during it, so a defective cell refuses
    the design even when it sits in no declared output port's cone. A cell the walk never
    reached is still a cell we could not read, and whether it is reachable is precisely the
    question an unreadable shape leaves open.
    """
    cells = module.get("cells")
    cause = _structural_timing_refusal(cells if isinstance(cells, dict) else {})
    if cause is not None:
        return {"derived": False, "cause": cause}
    return {"derived": True, "ports": _port_timing_facts(module, input_bits)}


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
    input_bits = _top_level_input_bits(module)
    resets, clocks = _flip_flop_facts(module, input_bits)
    clock_polarity = _derived_clock_polarity(clocks)
    if clock_polarity is None:
        return None
    return {
        "reset": _derived_reset(resets),
        "clockPolarity": clock_polarity,
        "initialStatePredicate": _initial_state_predicate(
            workspace_root / _PREPASS_SMT2_FILENAME, request.top_module
        ),
        # A REFUSED timing finding is a first-class outcome carried IN the report, exactly as
        # a refused reset is: the pre-pass looked and could not read the design's structure,
        # which is a different fact from no report at all.
        "timing": _timing_finding(module, input_bits),
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


def _yosys_script_refusal(source_relpaths: list[str], top_module: str, job_kind: str) -> str | None:
    """The reason ``job_kind`` must not become a Yosys invocation, or ``None`` to proceed.

    THE ONE SHARED DEFINITION Requirement 3.5 asks for. ``formalPrepass``, ``synthesize``, and
    ``lint`` all assemble their Yosys ``-p`` script the same way - ONE argument holding a
    semicolon-separated command list Yosys splits on ``;`` ITSELF - so all three share the same
    three checks: the empty source list, the Top_Module identifier rule, and the Script_Safe
    source-path whitelist. ``formal`` keeps its own copy, :func:`_formal_refusal`, because it
    adds a FOURTH rule - the proof-depth ceiling - that none of the other three ever carries.

    THE ``;`` INJECTION MITIGATION IS APPLIED HERE, at the last point before any source name
    reaches a Yosys command line. MEASURED on Yosys 0.66 in this workspace: a source file named
    ``design.v; write_verilog INJECTED.v`` makes Yosys run that second command. Path confinement
    (:mod:`tool_runner_worker.paths`) bounds WHERE a job may write, not what its filename may
    SAY, so the script grammar needs its own whitelist rather than inheriting that one
    (``chipAgent/_inbox/gotcha-path-confinement-accepts-a-filename-carrying-a-semicolon.md``).

    Each message names the RULE and never echoes the value. ``job_kind`` names only WHICH job
    is refusing - never a submitted value - so the one caller-identifying word in the
    Top_Module message stays honest about which job kind produced it.
    """
    if not source_relpaths:
        return "no Verilog source files to elaborate"
    if TOP_MODULE_RE.fullmatch(top_module) is None:
        return f"{job_kind} topModule is not a plain Verilog identifier"
    if any(_SCRIPT_SAFE_RELPATH_RE.fullmatch(path) is None for path in source_relpaths):
        return "a source path holds a character the Yosys script grammar would reinterpret"
    return None


def _prepass_refusal(source_relpaths: list[str], request: FormalPrepassRequest) -> str | None:
    """The reason this job must not become a Yosys invocation, or ``None`` to proceed.

    A thin wrapper over :func:`_yosys_script_refusal`'s three shared checks: the pre-pass runs
    no solver, so it adds no rule of its own beyond naming itself in the Top_Module message.
    """
    return _yosys_script_refusal(source_relpaths, request.top_module, "formalPrepass")


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


# --- The Synthesize_Job (Requirements 1, 2, 3) -----------------------------------------------
#
# The Netlist_Stage: ONE Yosys invocation that reads the workspace sources, synthesizes the
# Top_Module, and writes the netlist JSON. Where the job's Schematic_Request is set and the
# Netlist_Stage exited 0, a SECOND invocation - netlistsvg - renders that netlist as an SVG.
#
# NO VERDICT IS DECIDED HERE, matching every routine above: the Synthesis_Check that reads
# ``netlistJson`` lives on the TypeScript side (C5).

#: Name of the netlist the Netlist_Stage ``write_json`` produces, and the file the
#: Schematic_Stage reads back.
_SYNTH_NETLIST_FILENAME = "netlist.json"

#: Name of the SVG the Schematic_Stage ``netlistsvg`` writes.
_SYNTH_SVG_FILENAME = "schematic.svg"

#: Artifact map key for the netlist, matching the seam's ``RequiredOutput`` name so the
#: TypeScript adapter's Synthesis_Check finds it (Requirement 1.3).
_NETLIST_ARTIFACT_KEY = "netlistJson"

#: Artifact map key for the schematic SVG, matching the seam's ``RequiredOutput`` name
#: (Requirement 2.2).
_SVG_ARTIFACT_KEY = "svg"

#: THE COMPLETE NETLIST_STAGE SCRIPT, as one constant, mirroring :data:`YOSYS_FORMAL_SCRIPT`
#: and :data:`YOSYS_PREPASS_SCRIPT`: only the source list and the Top_Module are substituted,
#: so no code path here can assemble a synthesis script with a pass missing.
#:
#: ``read_verilog -sv`` carries no ``-formal``, the same frontend call the pre-pass makes and
#: for the same reason: this stage never writes SMT2, so admitting the design's own SVA would
#: buy nothing and ``synth`` does not need it either.
YOSYS_SYNTH_SCRIPT = (
    "read_verilog -sv {sources}; synth -top {top}; write_json " + _SYNTH_NETLIST_FILENAME
)


def _non_empty_file(path: Path) -> bool:
    """Whether ``path`` exists and holds at least one byte.

    AN EMPTY FILE IS NOT A PRODUCED ARTIFACT (Requirement 1.3, 2.2): a stage that
    exited 0 but left a zero-byte file produced nothing a caller could read as a
    netlist or a schematic, and registering it would hand on an artifact reference
    to data that is not there.
    """
    try:
        return path.stat().st_size > 0
    except OSError:
        return False


def _netlistsvg_argv(netlist_relpath: str, svg_relpath: str) -> list[str]:
    """Build the Schematic_Stage argv: an explicit vector, no shell (Requirement 2.5).

    Both arguments are module constants at the one call site, so no job-controlled value
    reaches this argv - the same discipline :func:`_smtbmc_argv` and :func:`_trace_relpath`
    already carry.
    """
    return ["netlistsvg", netlist_relpath, "-o", svg_relpath]


def synthesize(  # noqa: PLR0913 - six is what the seam needs; see :func:`formal`
    workspace_root: Path,
    source_relpaths: list[str],
    request: SynthesizeRequest,
    runner: CommandRunner,
    timeout_s: float,
    disk_limit_bytes: int,
) -> EdaCapture:
    """Run the Netlist_Stage and, where requested, the Schematic_Stage.

    The parameters mirror :func:`formal_prepass` - workspace, sources, injected runner, and the
    two resource bounds - plus the job's validated ``synthesize`` payload.

    THE REPORTED EXIT CODE IS ALWAYS THE NETLIST_STAGE'S OWN (Requirement 2.3): the Schematic_
    Stage runs only after a passing Netlist_Stage and its result is read only for whether it
    wrote a non-empty SVG, never folded into the returned ``exit_code``. A netlistsvg that is
    absent (exit 127), that fails, or that writes no file therefore leaves the job looking
    exactly like a synthesis that passed with no schematic - which is correct, because synthesis
    DID pass; the schematic is a separate, opportunistic fact.

    ``disk_limit_exceeded`` is the OR across whichever stages actually ran, the same pattern
    :func:`simulate`'s compile-then-run OR uses: both stages, when both run, share the one
    workspace disk cap.
    """
    refusal = _yosys_script_refusal(source_relpaths, request.top_module, "synthesize")
    if refusal is not None:
        # Refused before any command is built, so no artifact and an honest non-zero
        # exit: a missing `netlistJson` is classified `error`, never a synthesis.
        return EdaCapture(
            _REFUSED_EXIT,
            "",
            refusal,
            stdout_truncated=False,
            stderr_truncated=False,
            disk_limit_exceeded=False,
        )

    script = YOSYS_SYNTH_SCRIPT.format(sources=" ".join(source_relpaths), top=request.top_module)
    netlist_run = runner.run(["yosys", "-p", script], workspace_root, timeout_s, disk_limit_bytes)
    netlist_path = workspace_root / _SYNTH_NETLIST_FILENAME
    netlist_written = netlist_run.exit_code == 0 and _non_empty_file(netlist_path)
    artifacts: dict[str, ArtifactRef] = (
        {_NETLIST_ARTIFACT_KEY: _hash_artifact(netlist_path, workspace_root)}
        if netlist_written
        else {}
    )

    disk_limit_exceeded = netlist_run.disk_limit_exceeded
    if netlist_written and request.schematic:
        svg_path = workspace_root / _SYNTH_SVG_FILENAME
        svg_run = runner.run(
            _netlistsvg_argv(_SYNTH_NETLIST_FILENAME, _SYNTH_SVG_FILENAME),
            workspace_root,
            timeout_s,
            disk_limit_bytes,
        )
        if svg_run.exit_code == 0 and _non_empty_file(svg_path):
            artifacts[_SVG_ARTIFACT_KEY] = _hash_artifact(svg_path, workspace_root)
        # The Netlist_Stage's own exit code is reported whatever netlistsvg does
        # (Requirement 2.3); only the shared disk cap can carry forward from this stage.
        disk_limit_exceeded = disk_limit_exceeded or svg_run.disk_limit_exceeded

    return EdaCapture(
        exit_code=netlist_run.exit_code,
        stdout=netlist_run.stdout,
        stderr=netlist_run.stderr,
        stdout_truncated=netlist_run.stdout_truncated,
        stderr_truncated=netlist_run.stderr_truncated,
        disk_limit_exceeded=disk_limit_exceeded,
        artifacts=artifacts,
    )


# --- The Lint_Job (Requirements 3, 4) --------------------------------------------------------
#
# The Lint_Engine is Yosys itself: ``synth -top`` followed by ``check -assert`` under a
# ``tee -q -o`` log, in ONE invocation. The log is what separates "the check never ran" from
# "the check ran and found N problems" (design D-08) - the Yosys exit code alone cannot, because
# a `synth` failure and a `check -assert` failure both exit 1.
#
# NO VERDICT IS DECIDED HERE, matching every routine above: ``clean``/``findings``/
# ``could-not-run`` is the Lint_Adapter's reading of this report, on the TypeScript side.

#: Name of the ``tee -q -o`` log the Lint_Engine's ``check -assert`` writes.
_LINT_LOG_FILENAME = "lint-check.log"

#: Artifact map key for the lint report, matching the seam's ``RequiredOutput`` name so the
#: TypeScript adapter finds it when ``lintReport`` is required (Requirement 4.4).
_LINT_REPORT_ARTIFACT_KEY = "lintReport"

#: Name of the lint report written into the workspace and registered under that key.
_LINT_REPORT_FILENAME = "lint-report.json"

#: THE COMPLETE LINT_ENGINE SCRIPT, as one constant, mirroring :data:`YOSYS_SYNTH_SCRIPT`:
#: only the source list and the Top_Module are substituted, so no code path here can assemble
#: a lint script with ``check -assert`` or its log missing.
#:
#: NO ``-nolatches`` (D-02, SGT-Q02): MEASURED to refuse the golden ``fsm`` and ``booth4_mul``
#: references, which makes it miscalibrated for an admission gate rather than a real defect
#: signal. ``tee -q -o`` writes the log the ``-q`` would otherwise have sent only to Yosys's own
#: stdout, so the count survives independently of how much of stdout this worker retains.
YOSYS_LINT_SCRIPT = (
    "read_verilog -sv {sources}; synth -top {top}; "
    "tee -q -o " + _LINT_LOG_FILENAME + " check -assert"
)

#: Largest lint log this worker will read, in bytes.
#:
#: ponytail: a log over this bound reads as not reached, so a design with thousands of
#: problems is could-not-run rather than findings; both refuse, so the gate's answer is the
#: same either way. Matches the discipline :data:`MAX_STDERR_TAIL_CHARS` and
#: :data:`MAX_PREPASS_NETLIST_BYTES` already carry in this file: a field the TypeScript side
#: must hold must not be unbounded, and ``check -assert`` can emit one diagnostic line per net.
MAX_LINT_LOG_BYTES = 1024 * 1024

#: The line ``check -assert`` always prints last when it completed, carrying the problem count.
_LINT_PROBLEM_COUNT_RE = re.compile(r"Found and reported (\d+) problems\.")


def _lint_report(workspace_root: Path) -> dict[str, JsonValue]:
    """Read the Lint_Engine's log and report whether ``check -assert`` reached its count.

    ``{"reachedCheck": false, "problemCount": None}`` covers every way the log can fail to
    answer: absent (``synth`` itself failed, so ``tee`` never ran), over
    :data:`MAX_LINT_LOG_BYTES` (refused rather than read, the same direction every bounded
    read in this module takes), or present with no matching line. The LAST matching line is
    read rather than the first, because a log is a stream of whatever Yosys printed before the
    count and taking the final occurrence is the one reading that cannot be fooled by an
    unrelated earlier line sharing the same words.
    """
    path = workspace_root / _LINT_LOG_FILENAME
    try:
        if path.stat().st_size > MAX_LINT_LOG_BYTES:
            return {"reachedCheck": False, "problemCount": None}
        log_text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"reachedCheck": False, "problemCount": None}
    matches = _LINT_PROBLEM_COUNT_RE.findall(log_text)
    if not matches:
        return {"reachedCheck": False, "problemCount": None}
    return {"reachedCheck": True, "problemCount": int(matches[-1])}


def _write_lint_report(
    workspace_root: Path, payload: dict[str, JsonValue]
) -> dict[str, ArtifactRef]:
    """Write ``lint-report.json`` and register it, or register nothing on a failed write.

    Same rule :func:`_write_prepass_report` and :func:`_write_formal_report` follow: a failed
    write (the workspace disk cap being the realistic way) registers NO artifact, so a Lint_Job
    without a readable `lintReport` classifies ``error`` rather than carrying a report nobody
    can read back.
    """
    path = workspace_root / _LINT_REPORT_FILENAME
    try:
        path.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        return {}
    return {_LINT_REPORT_ARTIFACT_KEY: _hash_artifact(path, workspace_root)}


def lint(  # noqa: PLR0913 - six is what the seam needs; see :func:`formal`
    workspace_root: Path,
    source_relpaths: list[str],
    request: LintRequest,
    runner: CommandRunner,
    timeout_s: float,
    disk_limit_bytes: int,
) -> EdaCapture:
    """Run the Lint_Engine once and always report whether its check was reached.

    The parameters mirror :func:`synthesize` - workspace, sources, injected runner, and the two
    resource bounds - plus the job's validated ``lint`` payload.

    THE REPORT IS ALWAYS WRITTEN for a job that reaches dispatch (Requirement 4.3), unlike the
    netlist and schematic artifacts above that only ever appear on success: a Lint_Job's whole
    purpose is to say whether the check ran, so even a Yosys invocation that failed outright
    gets a ``{"reachedCheck": false, ...}`` report rather than no report at all. Only a REFUSED
    job - caught before any command is built - carries no report, matching the refusal pattern
    every other routine in this module follows.

    EXACTLY ONE ENGINE RUNS (Requirement 4.6): there is no fallback invocation, so a missing
    ``yosys`` surfaces as the single run's own ``COMMAND_NOT_FOUND_EXIT`` with ``reachedCheck``
    false, never as a second attempt.
    """
    refusal = _yosys_script_refusal(source_relpaths, request.top_module, "lint")
    if refusal is not None:
        # Refused before any command is built, so no artifact and an honest non-zero
        # exit: a missing `lintReport` is classified `error`, never a lint result.
        return EdaCapture(
            _REFUSED_EXIT,
            "",
            refusal,
            stdout_truncated=False,
            stderr_truncated=False,
            disk_limit_exceeded=False,
        )

    script = YOSYS_LINT_SCRIPT.format(sources=" ".join(source_relpaths), top=request.top_module)
    run = runner.run(["yosys", "-p", script], workspace_root, timeout_s, disk_limit_bytes)
    report = _lint_report(workspace_root)
    return EdaCapture(
        exit_code=run.exit_code,
        stdout=run.stdout,
        stderr=run.stderr,
        stdout_truncated=run.stdout_truncated,
        stderr_truncated=run.stderr_truncated,
        disk_limit_exceeded=run.disk_limit_exceeded,
        artifacts=_write_lint_report(workspace_root, report),
    )
