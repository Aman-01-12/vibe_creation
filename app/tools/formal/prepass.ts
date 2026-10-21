// The Reset_Contract_Prepass's TypeScript half: the `formal-prepass-report.json` the worker
// writes, its ONE validating parse, and the derivation that turns that document into a
// `FormalPrepassReport` or into a named `CouldNotVerifyCause`
// (design.md Component 14; Req 14.9, 14.10, 14.17 to 14.24, 14.26, 14.30 to 14.34, 14.36 to 14.38).
//
// WHAT THIS SIDE DECIDES, AND WHAT THE WORKER ALREADY DECIDED
//   The pre-pass is ONE component spanning two languages, and each of its facts has exactly ONE
//   owner, which is what Req 14.24 and 14.38 require. The split, as `eda.py`'s own header states
//   it:
//     - The WORKER walks the elaborated netlist's flip-flop cells, applies the top-level-input-port
//       filter, parses `ARST_POLARITY`, `SRST_POLARITY`, `EN_POLARITY`, and `CLK_POLARITY` with
//       `int(v, 2)`, and writes the reset finding - including the enabling signal a conditional
//       reset fires under - and the `clockPolarity` finding. It is the only side that HOLDS the
//       netlist, so it is the only side that could read them.
//     - THIS MODULE decides the free-initial-state fact from the predicate TEXT the worker hands
//       across, maps the four `clockPolarity` values onto supported-versus-refused, and orders the
//       two refusals. Those are the three decisions whose refusals are `CouldNotVerifyCause`
//       values, so they live on the side that owns that vocabulary.
//   There is therefore NO flip-flop-cell walk here. Adding one would make this module a SECOND
//   decider of the derived polarity, which is precisely what Req 14.24 forbids, and two
//   implementations of one measured rule are two things that can drift.
//
// THE SHAPE DIFFERENCE BETWEEN design.md AND THE WORKER, RESOLVED RATHER THAN PAPERED OVER
//   design.md Component 14 gives `FormalPrepassReport` as `{ reset; clockPolarity }` with
//   `initialStateFree` on `ResetContract`'s derived member. The worker writes THREE top-level
//   fields: `reset`, `clockPolarity`, and `initialStatePredicate` - the predicate's raw text, or
//   `null` where it could not be read. Both are right about different documents, so both are here
//   under different names:
//     - `FormalPrepassDocument` is the WIRE shape, mirrored field for field from
//       `eda.py`'s `_prepass_report`, and it is what `parseFormalPrepassReport` returns.
//     - `FormalPrepassReport` is the DERIVED shape design.md specifies, and it is what
//       `deriveFormalPrepassReport` returns once the predicate has been READ.
//   Folding the predicate into a boolean at the seam would have put the free-initial-state rule in
//   the worker, which is the one place Req 14.24's single-owner rule says it must not be.
//
// WHY THIS IS A PARSE AND NOT A CAST
//   Same reason as `report.ts`, and the file is read the same way: a JSON document written inside a
//   sandbox workspace by a separate process, carrying a net NAME and a predicate BODY that both
//   originate in a tool's output over untrusted input. Req 11.10 admits a Formal_Verdict derived
//   from Tool_Runner output only through a parse that REJECTS what it does not recognize, so the
//   schema is CLOSED (`additionalProperties: false` at every level, both arms of the reset union
//   included) and the parse returns a `Result`, never a partially-trusted object. No offending
//   VALUE is ever quoted into an issue string: a value in this document can be a host path or a
//   fragment of a Yosys diagnostic.
//
// THE ONE THING THIS PARSE MUST NOT DO
//   It must not default an unrecognized `clockPolarity` to `posedge`. That default is in the
//   FALSE-REFUTATION direction the whole Clock_Contract rule exists to close: a negedge or
//   mixed-edge design read as posedge is lowered by a chain that advances every `$dff` one step
//   together, which MEASURABLY refutes a property that is true of the real hardware
//   (`chipAgent/_inbox/gotcha-mixed-edge-clocking-collapses-in-write-smt2-and-falsely-refutes.md`).
//   So the vocabulary is closed by the schema's own `enum` and an out-of-vocabulary value fails the
//   parse, reaching the gate as `toolchain-unavailable` (Req 14.37). There is no `??`, no `||`, and
//   no fallback literal anywhere below.
//
// THE ajv STRICT-MODE TRAP THIS SCHEMA IS WRITTEN AROUND
//   The instance is built with `strict: true`, matching `report.ts` and `../sandbox/validation.ts`,
//   and `strict: true` turns `strictRequired` ON: every name in a `required` must be declared in
//   the `properties` of THE SAME subschema. A violation throws at ajv COMPILE time, which is module
//   load, so the failure shape is a suite reporting "0 tests" rather than a failing assertion
//   (`chipAgent/_inbox/gotcha-ajv-strictrequired-refuses-required-in-a-then-branch.md`). The reset
//   union is therefore a `oneOf` of two INDEPENDENTLY closed object schemas, each listing only the
//   names it declares itself, rather than an `if`/`then` over the `derived` discriminant.
//
// Pure and total: no model call, and no file, network, clock, or random-source read. The caller
// reads the file; this module only parses the text it is handed, and never throws on any input.

import { Ajv } from 'ajv';
import type { ErrorObject, SchemaObject, ValidateFunction } from 'ajv';

import { err, ok, type Result } from '@app/core';

import type { CouldNotVerifyCause } from './conditions.js';

/**
 * The Clock_Contract vocabulary, closed at four members and enumerable (Req 14.36).
 *
 * FOUR VALUES RATHER THAN A BOOLEAN, for two reasons that are both measurements.
 * `none` is a design with NO CLOCKED STATE - 15 of 50 corpus references - and it is SUPPORTED, so
 * it must not collapse into `posedge` and must not read as a refusal (Req 14.34).
 * Separating `negedge` from `mixed` records WHICH class a refusal came from even though both
 * refuse, and that is the only way the measured-EMPTY negedge-only class stops being an assumption
 * about the corpus and becomes an observation a report can contradict.
 *
 * An array plus a derived type, the same shape `COULD_NOT_VERIFY_CAUSES` uses, so the schema's
 * `enum` below is spelled FROM this list rather than beside it.
 */
export const CLOCK_POLARITIES = ['posedge', 'negedge', 'mixed', 'none'] as const;

/** The Clock_Contract the pre-pass found over every flip-flop cell of the elaborated design. */
export type ClockPolarity = (typeof CLOCK_POLARITIES)[number];

/**
 * Which `clockPolarity` values REFUSE, and which are supported. `null` means supported.
 *
 * A TOTAL map rather than a predicate, and that is the point: `Readonly<Record<ClockPolarity, ...>>`
 * cannot be written with a member missing, so a fifth `clockPolarity` is a COMPILE ERROR here
 * rather than a value that silently falls through to "supported". Falling through to supported is
 * the false-refutation direction, so the failure has to be at build time.
 *
 * `posedge` is the 31-of-50 class the whole chain was measured on. `none` is the 15-of-50
 * no-clocked-state class, SUPPORTED because a design with no `$dff` has no clock for `write_smt2`
 * to mis-advance. `negedge` and `mixed` both refuse under one cause: `async2sync` rewrites the
 * async reset only, so a negedge-clocked flop reaches `write_smt2` as an ordinary `$dff` and the
 * transition relation advances every `$dff` one step together, deleting the half-cycle offset.
 *
 * THE REFUSAL CONDITION IS THE WIDER ONE - any non-posedge polarity, not merely a MIXTURE - and
 * that is FAIL-SAFE REASONING rather than measurement (Req 14.32). What IS measured is that the two
 * conditions are INDISTINGUISHABLE on this corpus, because the negedge-only class is EMPTY, so no
 * reference separates them; a negedge-only design is equally unmodelled by a posedge-sampled
 * assertion, so the wider condition is chosen on fail-safe grounds.
 */
const CLOCK_CONTRACT_REFUSAL: Readonly<Record<ClockPolarity, CouldNotVerifyCause | null>> =
  Object.freeze({
    posedge: null,
    none: null,
    negedge: 'clock-contract-unsupported',
    mixed: 'clock-contract-unsupported',
  });

/**
 * The reset finding exactly as the worker writes it: derived facts, or a first-class refusal.
 *
 * Mirrored field for field from `eda.py`'s `_derived_reset`, which is the ground truth. It carries
 * NO `initialStateFree`: the worker hands the predicate's TEXT across and this module reads it, so
 * the derived member here is one field shorter than `ResetContract`'s.
 *
 * `derived: false` is an OUTCOME and never an error (Req 14.20): several retained reset nets,
 * several polarities, none at all, or an unreadable polarity all arrive as this member.
 * An enable-gated reset is not one of them: it DERIVES, and `resetEnable` below carries the enable
 * (criterion 4.15 of `formal-gate-first-light`, which AMENDS Req 14.19).
 * ON THE WIRE it does not yet say WHICH of those happened, and it does not need to: the
 * derivation below reads `clockPolarity` alongside it, and a design with no flip-flop cell arrives as
 * this member for the honest reason that it has no reset entry to report (Req 14.40).
 * Three measured refusal classes are named here so a later session does not read a
 * refusal as a defect - `asyn_fifo` genuinely has TWO reset ports so no single name can be right
 * for all its flops; under `opt_dff -sat` only, `multi_pipe_8bit` acquires a spurious `SRST` on the
 * data enable `mul_en_in` and is falsely refused; and `opt_dff -sat` can MERGE a sync reset term
 * into a coincident next-state term, so a sync-reset counter that wraps to zero AND resets to zero
 * loses its reset port to an internal merged net. Model-generated RTL writes that last shape
 * constantly, so the refusal rate on sync-reset designs is HIGHER than the corpus figures suggest.
 * Every one of them is fail-safe: a refusal, never a wrong polarity.
 */
export type PrepassResetFinding =
  | {
      readonly derived: true;
      /** The top-level input port the reset resolved to, after the port filter. */
      readonly resetName: string;
      /** `polarity === 0`, parsed by the worker with `int(v, 2)` and never a string compare. */
      readonly resetActiveLow: boolean;
      readonly resetKind: 'async' | 'sync';
      /** The enable this reset fires under, ABSENT where no one enable could be named. */
      readonly resetEnable?: ResetEnable;
    }
  | { readonly derived: false };

/**
 * The signal that must be held for a derived reset to actually fire (criterion 4.15 of
 * `formal-gate-first-light`, which AMENDS Req 14.19; see that spec's `design.md`, Component 20).
 *
 * WHY THIS EXISTS. Yosys's `$sdffce` resets only while its enable is active, so a contract naming
 * the reset alone states a conditional reset as if it were unconditional, and the reset assume
 * rendered from it pins the reset at step 0 while leaving the enable FREE - a step the solver may
 * choose not to be a reset at all. MEASURED on `LIFObuffer`: all 7 of its reset-carrying cells are
 * `$sdffce` with a non-constant enable, and criterion 4.8's property over it depends on step 0.
 *
 * WHY IT IS OPTIONAL ON THE DERIVED MEMBER RATHER THAN NULLABLE. A reset carried by `$sdff` or
 * `$adff` has NO enable to name, and so does one whose enable the worker could not resolve to a
 * single top-level input port with a readable polarity. Both are the ABSENCE of this field - the key
 * is not written - which is a DIFFERENT SHAPE from an enable asserted low rather than the same shape
 * with a defaulted level. A nullable field, or a defaulted `activeLow`, would make "we could not
 * name it" indistinguishable from "it is asserted low", and those two produce opposite assumes.
 *
 * It is one OBJECT rather than two sibling optional fields for the same reason: a name and a level
 * are one fact, and two independently optional fields admit a half-populated enable that the
 * renderer would have to decide about.
 */
export interface ResetEnable {
  /** The top-level input port the cell's `EN` connection resolved to, after the port filter. */
  readonly name: string;
  /**
   * `EN_POLARITY === 0`: the level at which the enable is NOT asserted.
   *
   * Spelled the same way round as `resetActiveLow` so one reading serves both: the signal is
   * ASSERTED low where this is `true`, and asserted high where it is `false`.
   */
  readonly activeLow: boolean;
}

/**
 * One declared output port's combinational cone, exactly as the worker's backward walk reports it.
 *
 * Mirrored field for field from `eda.py`'s `_port_timing_facts`, which is the ground truth, and
 * carrying no derived VALUE: the port's timing class is decided by `classifyPortTiming` on this side,
 * because only this side holds the `ModuleInterface` the Declared_Data_Input set is read from
 * (timing-contract-inference Req 1.13).
 */
export interface PortTimingFacts {
  /** The declared output port these facts are about. */
  readonly port: string;
  /**
   * Top-level INPUT ports reached combinationally, clock and reset INCLUDED.
   *
   * Deliberately unsubtracted: the worker has no `clocking` record, so it cannot know which input is
   * the clock or the reset, and the classifier on this side subtracts them. Filtering here would move
   * that rule to the side that cannot state it.
   */
  readonly sources: readonly string[];
  /** Whether the walk crossed into retained state, which makes the port sequential. */
  readonly reachesState: boolean;
  /** Whether any bit of the port has no driver at all, which refuses the port ahead of every clause. */
  readonly undriven: boolean;
}

/**
 * The design's timing finding: every declared output port's cone facts, or ONE structural refusal.
 *
 * TWO ARMS AND NOTHING BETWEEN THEM, matching `PrepassResetFinding`'s discipline and the worker's
 * `_timing_finding` exactly: `derived: true` carries `ports`, and `derived: false` carries a `cause`
 * and NO `ports`, because a refusal means the walk's answers are not evidence and half a finding
 * would be read as a finding. The refusal is per DESIGN rather than per port for the same reason -
 * an unreadable cell leaves open whether it sits in any port's cone.
 */
export type PrepassTimingFinding =
  | { readonly derived: true; readonly ports: readonly PortTimingFacts[] }
  | { readonly derived: false; readonly cause: PrepassTimingRefusalCause };

/**
 * Why the worker refused to derive timing for a whole design. Closed at the worker's three tokens.
 *
 * A cell type not beginning with `$` is an unelaborated `module-instance`; a `CLK`-bearing cell
 * outside the retained-state set is an `unrecognized-clocked-cell`; and a cell with no readable
 * `port_directions`, or an unparseable `RD_CLK_ENABLE`, is `cell-shape-unreadable`.
 */
export type PrepassTimingRefusalCause =
  'module-instance' | 'unrecognized-clocked-cell' | 'cell-shape-unreadable';

/**
 * The same three tokens as a runtime list, so the schema's `enum` is not a second hand-spelled copy.
 *
 * Annotated rather than `as const`-and-derived, which is the one direction that matters here: a token
 * spelled wrong, or one the type does not admit, is a COMPILE error. A token added to the type but
 * not to this list is refused by the parse, which is the fail-safe direction - an unreadable report
 * reaches the gate as `toolchain-unavailable` rather than as a fact about the design.
 */
const TIMING_REFUSAL_CAUSES: readonly PrepassTimingRefusalCause[] = [
  'module-instance',
  'unrecognized-clocked-cell',
  'cell-shape-unreadable',
];

/**
 * `formal-prepass-report.json` as the WORKER WRITES IT. The wire shape, mirrored field for field.
 *
 * Four fields, all required. `initialStatePredicate` is the only one design.md's
 * `FormalPrepassReport` does not carry, and it is the reason the two shapes are two types: the
 * worker hands the predicate's BODY across so the free-initial-state RULE has a single owner on the
 * side that also owns the refusal an unreadable predicate produces (Req 14.24). `timing` is the
 * second: the cone FACTS are the worker's and the timing CLASS is this side's.
 */
export interface FormalPrepassDocument {
  /** The derived reset facts or the refusal, before the free-initial-state fact is read. */
  readonly reset: PrepassResetFinding;
  /** The Clock_Contract finding, from `CLK_POLARITY` on every FF cell in the same walk. */
  readonly clockPolarity: ClockPolarity;
  /**
   * The body of `(define-fun |<design>_i| ...)`, or `null` where the worker could not read one.
   *
   * `null` covers an absent predicate, an unbalanced scan, and a body past the worker's own
   * 4096-character bound, because all three are the same fact on this side: no predicate arrived.
   */
  readonly initialStatePredicate: string | null;
  /**
   * The per-port cone facts of the same netlist walk, or the structural refusal that voids them.
   *
   * REQUIRED for the reason `initialStatePredicate` is: `json.dumps` writes the key on every run, so
   * an absent key is a document THIS SIDE DOES NOT RECOGNIZE rather than an honest absence. Both
   * halves ship in one increment, so no old report meets this schema.
   */
  readonly timing: PrepassTimingFinding;
}

/**
 * What the pre-pass DERIVED about the design's reset, or its refusal. The renderer's fourth input.
 *
 * `resetActiveLow` and `resetKind` come from the elaborated netlist, NEVER from the Spec:
 * `ClockingContract.resetActiveLow` originates in model-generated text, and a wrong polarity
 * produces a FAILING base case over a PASSING induction check, which is byte-for-byte the
 * false-proof signature of the measured `bad_init` case - so a model's misreading of the reset would
 * arrive as a REFUTATION of the student's own design (Req 14.9, 14.10). That field is at most a
 * cross-check, and nothing in this module reads it.
 *
 * `initialStateFree` is read from the SMT2 initial-state predicate by `readFreeInitialState` below.
 * Together the two decide whether the `if (!$initstate)` assertion gate is emitted; task 16.5 owns
 * that emission and this type is its input.
 *
 * ONE VALUE, TWO READINGS, DISTINGUISHED ONLY BY `clockPolarity` - AND A READER WHO MISSES THAT WILL
 * MISREAD THE RENDERER. `derived: false` leaves `deriveFormalPrepassReport` on EXACTLY ONE arm:
 *   - WHERE `clockPolarity` IS `none`, it means NO RESET IS REQUIRED. A design holding no clocked
 *     state has no flip-flop cell, so it has no reset entry to retain, and the absence is the
 *     EXPECTED finding rather than a failed derivation (Req 14.40). This arm is ADMITTED, and the
 *     wrapper built from it is a correct combinational wrapper.
 *   - ON EVERY OTHER POLARITY, it means THE DERIVATION REFUSED - several reset nets, several
 *     polarities, an unreadable polarity, or none at all where the design DOES hold clocked state.
 *     An enable-gated reset is NOT in that list: it derives, carrying `resetEnable` (criterion 4.15
 *     of `formal-gate-first-light`, which AMENDS Req 14.19). The refusal arm short-circuits to
 *     `reset-contract-unresolved` and no Property_Wrapper is built (Req 14.18 as narrowed).
 * The two are the same VALUE because the renderer needs nothing more from either: both emit no reset
 * assume and no gate, and only the admitted one ever reaches the renderer at all. The member would
 * have existed regardless, because `renderPropertyWrapper` takes a `ResetContract` and the refusal has
 * to be REPRESENTABLE at that seam rather than thrown (design.md Component 3).
 */
export type ResetContract =
  | {
      readonly derived: true;
      readonly resetName: string;
      readonly resetActiveLow: boolean;
      readonly resetKind: 'async' | 'sync';
      readonly initialStateFree: boolean;
      /**
       * The enable this reset fires under, ABSENT where no one enable could be named.
       *
       * TRANSPORTED rather than derived: the worker reads the `EN` connection and `EN_POLARITY`
       * of each retained reset entry, because it is the only side holding the netlist, and this
       * side carries the answer through unchanged. See `ResetEnable` for why absence is a shape
       * rather than a value, and `design.md`, Component 20 for the measurement behind it.
       */
      readonly resetEnable?: ResetEnable;
    }
  | { readonly derived: false };

/**
 * What one pre-pass established about one candidate design, once its evidence has been READ.
 *
 * design.md Component 14's shape. Reached only through `deriveFormalPrepassReport`, so a value of
 * this type has already passed the Clock_Contract check and carries a reset whose free-initial-state
 * fact was read rather than defaulted.
 */
export interface FormalPrepassReport {
  /** The derived reset contract. Carries `initialStateFree` on its derived member. */
  readonly reset: ResetContract;
  /** The Clock_Contract this run may be taken under: `posedge` or `none` (Req 14.39). */
  readonly clockPolarity: ClockPolarity;
}

/**
 * The accepted size of one pre-pass report document, in characters.
 *
 * Checked BEFORE `JSON.parse`, so an oversized blob is refused rather than turned into a parse tree
 * first. The document carries TWO findings and a predicate, and the honest worst case is all three
 * at once, MEASURED over the 48 corpus designs that elaborate by running the worker's own pre-pass
 * script and `json.dumps` (Yosys 0.69+post): the predicate at the worker's
 * `MAX_INITIAL_STATE_PREDICATE_CHARS` (4096, so 4098 once encoded), the widest reset finding
 * (`LIFObuffer`'s enable-gated one, 134), the widest timing finding (`alu`'s six output ports over
 * three inputs, 529), and the envelope's four field names, polarity string, and punctuation (78) -
 * 4839 characters, so 16 KiB carries 3.3x headroom over a worst case no single design reaches. The
 * widest document the corpus actually produces is `alu`'s 628.
 *
 * Reject rather than truncate, by the same rule `MAX_REPORT_CHARS` follows: a truncated JSON
 * document is not a report, and repairing one would be inventing evidence. No net NAME is bounded,
 * so a design far wider than this corpus is REFUSED and reaches the gate as `toolchain-unavailable`,
 * which is the fail-safe direction. `app/test/formal-prepass-report-size.test.ts` pins every figure
 * above, so a finding that grows fails there rather than in production.
 */
export const MAX_PREPASS_REPORT_CHARS = 16_384;

/**
 * The one predicate body that means every state bit starts FREE.
 *
 * Literally `true`, because a register with no init value contributes no equality to the
 * initial-state predicate, so a design whose predicate is nothing but `true` pins no state bit
 * (Req 14.22). Compared after trimming and CASE-SENSITIVELY: SMT-LIB's literal is lower case, and
 * `write_smt2` emits it that way, so a body spelled any other way is a predicate that is not the
 * free one rather than a spelling of it.
 */
export const FREE_INITIAL_STATE_PREDICATE = 'true';

/**
 * Why a pre-pass report text was refused. NAMED rather than boolean, because the caller records it.
 *
 * Every member falls to the same verdict - `could-not-verify` with `toolchain-unavailable`
 * (Req 14.26, 14.37) - so the names exist for the reader of a failure rather than for the gate: a
 * report we cannot read is not a Reset_Contract we may use, whichever way it was unreadable.
 */
export type FormalPrepassRejection =
  | { readonly reason: 'report-too-large' }
  | { readonly reason: 'not-json' }
  | { readonly reason: 'schema-violation'; readonly issues: readonly string[] };

/** The refused arm of the reset union: the discriminant and nothing else, closed. */
const REFUSED_RESET_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['derived'],
  properties: { derived: { type: 'boolean', const: false } },
};

/**
 * The enabling signal's arm: closed, and REQUIRING BOTH FACTS so a half-written one is refused.
 *
 * The whole object is OPTIONAL in the derived arm below, and that is the only optionality here: an
 * enable the worker could name is written with both its name and its level, and one it could not is
 * omitted entirely. So the three shapes a reader must tell apart - no enable, an enable asserted
 * high, an enable asserted low - are three shapes, and a document carrying `resetEnable` with a
 * missing level, an extra key, a raw polarity STRING where a boolean belongs, or a bare net name in
 * place of the object fails the parse rather than arriving as a defaulted enable.
 *
 * The string-where-a-boolean-belongs trap is the sharp one and it is the same one `resetActiveLow`
 * already guards: JavaScript reads the non-empty string `"0"` as TRUTHY, so a passed-through
 * `EN_POLARITY` of `"0"` would arrive as asserted HIGH and the assume would hold the enable at the
 * level that stops the reset firing.
 */
const RESET_ENABLE_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'activeLow'],
  properties: {
    // Unbounded HERE for the same reason `resetName` is: `MAX_PREPASS_REPORT_CHARS` bounds the whole
    // document before it is parsed, and this name came off a netlist port list rather than a job.
    name: { type: 'string' },
    activeLow: { type: 'boolean' },
  },
};

/** The derived arm: the discriminant, the three facts the worker read, and the optional enable. */
const DERIVED_RESET_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['derived', 'resetName', 'resetActiveLow', 'resetKind'],
  properties: {
    derived: { type: 'boolean', const: true },
    // Shape only, and unbounded HERE on purpose: `MAX_PREPASS_REPORT_CHARS` bounds the whole
    // document before it is parsed at all, so a second length bound on one field inside it would be
    // a magic number with nothing left to protect. The worker re-validates its own `topModule`
    // against a Verilog-identifier pattern; this name came off a netlist port list, not a job.
    resetName: { type: 'string' },
    resetActiveLow: { type: 'boolean' },
    resetKind: { type: 'string', enum: ['async', 'sync'] },
    // DECLARED but NOT in `required`, which is the whole of the optionality: `json.dumps` omits the
    // key where the worker named no enable, so an absent key is the honest no-enable document and a
    // present one must be the full object above.
    resetEnable: RESET_ENABLE_SCHEMA,
  },
};

/**
 * One port's cone facts: closed, and REQUIRING ALL FOUR so a half-written entry is refused.
 *
 * `sources` is an array of strings and nothing looser, because the classifier INTERSECTS it with the
 * Declared_Data_Input set: a number or a nested array arriving there would intersect with nothing and
 * read as "no data input reached", which is the sequential-looking answer for a combinational port.
 * Unbounded in length and in each name for the reason `resetName` is - `MAX_PREPASS_REPORT_CHARS`
 * bounds the whole document before it is parsed at all.
 */
const PORT_TIMING_FACTS_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['port', 'sources', 'reachesState', 'undriven'],
  properties: {
    port: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    // Booleans and never the raw bits they were read from, the same trap `resetActiveLow` guards:
    // JavaScript reads the non-empty string `"0"` as TRUTHY, so a passed-through bit would invert.
    reachesState: { type: 'boolean' },
    undriven: { type: 'boolean' },
  },
};

/** The derived arm of the timing union: the discriminant and the port list, closed. */
const DERIVED_TIMING_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['derived', 'ports'],
  properties: {
    derived: { type: 'boolean', const: true },
    ports: { type: 'array', items: PORT_TIMING_FACTS_SCHEMA },
  },
};

/**
 * The refused arm: the discriminant, the cause, and NO `ports`.
 *
 * `additionalProperties: false` is what makes the absence a RULE rather than a convention: a worker
 * that refused and shipped the walk's answers anyway fails the parse instead of having them ignored.
 */
const REFUSED_TIMING_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['derived', 'cause'],
  properties: {
    derived: { type: 'boolean', const: false },
    cause: { type: 'string', enum: [...TIMING_REFUSAL_CAUSES] },
  },
};

/**
 * The JSON Schema for `formal-prepass-report.json`, closed at every level.
 *
 * Exported so a test asserts against THIS object rather than a hand-copied restatement of it: a
 * test that re-spells the schema it checks asserts only that the schema equals itself.
 *
 * `clockPolarity`'s `enum` is spread FROM `CLOCK_POLARITIES`, so the closed vocabulary and the
 * TypeScript type have ONE owner. A fifth member added to the type widens this `enum` in the same
 * edit, and the total `CLOCK_CONTRACT_REFUSAL` map above then fails to compile until it is
 * classified - which is the order those two facts must be learned in.
 */
export const formalPrepassReportSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['reset', 'clockPolarity', 'initialStatePredicate', 'timing'],
  properties: {
    // A `oneOf` of two independently closed arms rather than an `if`/`then` over `derived`, because
    // `strictRequired` refuses a `required` naming a property a sibling subschema declares.
    reset: { oneOf: [DERIVED_RESET_SCHEMA, REFUSED_RESET_SCHEMA] },
    clockPolarity: { type: 'string', enum: [...CLOCK_POLARITIES] },
    // REQUIRED and NULLABLE, which are different facts. `json.dumps` writes the key on every run,
    // so an absent key is a document we do not recognize; `null` is the worker saying honestly that
    // it could not read a predicate, which this side turns into a refusal rather than a default.
    initialStatePredicate: { type: ['string', 'null'] },
    // The same `oneOf` of two independently closed arms, for the same `strictRequired` reason: the
    // refused arm's `required: ['cause']` would be refused as a sibling's property under an
    // `if`/`then` over `derived`, and the failure shape is a THROW at module load rather than a
    // failing assertion.
    timing: { oneOf: [DERIVED_TIMING_SCHEMA, REFUSED_TIMING_SCHEMA] },
  },
};

// One ajv instance and one compiled validator for the process, with the same options `report.ts`
// and `../sandbox/validation.ts` use: `strict` surfaces schema authoring mistakes at module load,
// and `allErrors` reports every failure so a rejection lists all issues rather than only the first.
// Compiled once here rather than per call, because compiling a schema is the expensive part and
// this parse runs once per candidate design.
const validatePrepassReport: ValidateFunction<FormalPrepassDocument> = new Ajv({
  allErrors: true,
  strict: true,
}).compile<FormalPrepassDocument>(formalPrepassReportSchema);

/**
 * Reduce ajv errors to sanitized `path rule` strings, copying `report.ts`'s discipline exactly.
 *
 * The offending VALUES are never included. This text describes a file produced inside a sandbox
 * workspace from a tool's output, so a value could carry a host path, a netlist net name, or a
 * fragment of a Yosys diagnostic; the issue list says which field broke which rule and nothing else.
 */
function summarizeIssues(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (errors === null || errors === undefined) {
    return [];
  }
  return errors.map((issue) => {
    const path = issue.instancePath.length > 0 ? issue.instancePath : '(root)';
    return `${path} ${issue.message ?? 'failed validation'}`;
  });
}

/** Whether every parenthesis in `body` closes, and none closes one that never opened. */
function isParenBalanced(body: string): boolean {
  let depth = 0;
  for (const character of body) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

/**
 * Whether the initial state is FREE, or `null` where the predicate could not be read at all.
 *
 * THREE OUTCOMES, AND THE THIRD IS NOT A DEFAULT. `true` and `false` are both readings of a
 * predicate that arrived; `null` is the refusal an ABSENT or UNPARSEABLE predicate produces
 * (Req 14.23), and it exists because BOTH defaults are unsafe in OPPOSITE directions. Defaulting to
 * free emits the `if (!$initstate)` gate on a design whose step 0 is PINNED, masking a wrong
 * `initial` value - the false-proof direction the `bad_init` control exists to catch. Defaulting to
 * not free suppresses the gate on a design whose step 0 is a free-variable artifact, failing a
 * correct sync-reset design's base case - the false-refutation direction. So there is nothing to
 * choose between and the only honest answer is to refuse.
 *
 * `null` from the worker is ABSENT. Empty-after-trimming and parenthesis-unbalanced are UNPARSEABLE,
 * and they are checked HERE rather than trusted from the worker for the reason the whole module
 * exists: this is a document crossing a trust boundary, and the worker's own balanced scan running
 * off the end of a truncated file is exactly the shape that would arrive as an unbalanced body.
 */
export function readFreeInitialState(predicate: string | null): boolean | null {
  if (predicate === null) {
    return null;
  }
  const body = predicate.trim();
  if (body.length === 0 || !isParenBalanced(body)) {
    return null;
  }
  return body === FREE_INITIAL_STATE_PREDICATE;
}

/**
 * Parse and validate one `formal-prepass-report.json` text. Total: never throws, on any input.
 *
 * Three refusals in order, cheapest first: the size bound, then JSON well-formedness, then the
 * schema. A `Result` rather than `FormalPrepassDocument | null`, so the caller that WANTS the reason
 * - the adapter, recording why a candidate design produced no contract - can have it.
 *
 * An out-of-vocabulary `clockPolarity` is refused HERE, by the schema's `enum`, and is therefore
 * never seen by the derivation below. That is deliberate: it puts the "never default to `posedge`"
 * rule in the one place a value could have been defaulted (Req 14.37).
 */
export function parseFormalPrepassReport(
  text: string,
): Result<FormalPrepassDocument, FormalPrepassRejection> {
  if (text.length > MAX_PREPASS_REPORT_CHARS) {
    return err({ reason: 'report-too-large' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not a silent catch: `JSON.parse` signals malformed input by throwing and carries no other
    // channel, so the throw IS the rejection. The thrown error is deliberately not surfaced - its
    // message quotes the offending input, which is untrusted text this layer must not carry.
    return err({ reason: 'not-json' });
  }
  if (validatePrepassReport(parsed)) {
    return ok(parsed);
  }
  return err({ reason: 'schema-violation', issues: summarizeIssues(validatePrepassReport.errors) });
}

/**
 * Turn one validated pre-pass document into a usable contract, or into the cause that refuses it.
 *
 * THE FIXED ORDER, AND WHY IT IS THIS ORDER. Three refusals can apply to one document, and the
 * order below is the whole rule:
 *
 *   1. THE CLOCK, FIRST. Where the Clock_Contract and the reset derivation BOTH refuse, the
 *      reported cause is `clock-contract-unsupported` (Req 14.33), because it is the refusal no
 *      better derivation recovers: `opt_dff -sat` measurably recovered the two sync-reset references
 *      plain `prep` could not read, and no derivation recovers a clocking the model cannot
 *      represent. **This ORDERING is a DETERMINISM choice rather than a MEASURED one** - design.md
 *      labels it so, and the label travels with it. What is measured is the refusal itself and its
 *      direction, not the precedence.
 *   2. THE RESET, NARROWED TO THE CLOCKED CLASS. A refused derivation is a first-class OUTCOME
 *      carrying `reset-contract-unresolved` and never an unrecognized error (Req 14.20). It does
 *      NOT cover an enable-gated reset: the pre-pass derives that enable and the contract names it,
 *      which is criterion 4.15 of `formal-gate-first-light` AMENDING Req 14.19. No Property_Wrapper
 *      is built for a refusal (Req 14.18). But a design with NO FLIP-FLOP CELL has no reset entry
 *      to retain, so on that class the absence is not a failed derivation and refusing it would
 *      refuse the whole combinational class - 15 of 50 corpus references, the same class
 *      Req 14.34 already calls SUPPORTED. MEASURED on the real toolchain: the pre-pass's own
 *      script over `verified_adder_8bit.v` yields ZERO cells carrying `ARST_POLARITY`,
 *      `SRST_POLARITY`, or `CLK_POLARITY`, so the worker reports `reset: { derived: false }` with
 *      `clockPolarity: 'none'`, and that design's initial-state predicate is literally `true`.
 *      So where the DERIVED `clockPolarity` is `none`, a `derived: false` finding is ADMITTED as a
 *      contract requiring no reset (Req 14.40), and the refusal applies to every other polarity
 *      exactly as before.
 *   3. THE PREDICATE, LAST, AND ONLY FOR A DERIVED RESET. `initialStateFree` lives on
 *      `ResetContract`'s derived member alone, so neither a refused reset nor the no-reset admission
 *      needs it; reading it earlier would let an unreadable predicate report `toolchain-unavailable`
 *      for a design whose reset ALREADY refused, which is exactly the "refused derivation reported as
 *      an unrecognized error" Req 14.20 forbids - and on the no-clocked-state arm it would report an
 *      instrument fault for a SUPPORTED design that has no state for a predicate to describe.
 *
 * THE GUARD READS THE DERIVED `clockPolarity` AND NOTHING ELSE, which is Req 14.42 and is Req 14.10's
 * rule applied to a second field. `ModuleInterface.clocking` would answer the same question and it
 * originates in MODEL-GENERATED Spec text, so reading the clocked-state question off it would
 * reintroduce exactly the dependency the derived polarity exists to remove. There is no second
 * parameter to this function for such a field to arrive through, and no flip-flop cell is walked here.
 *
 * THE RENDERER IS ALREADY CORRECT FOR THE ADMITTED NO-RESET ARM, and both of its omissions are correct
 * rather than incidental (Req 14.41). `resetAssumeLine` returns nothing on a non-derived reset, and a
 * reset assume over a design with no state would pin nothing. `gateCondition` requires
 * `derived && resetKind === 'sync' && initialStateFree`, and an `if (!$initstate)` gate here would be
 * actively WRONG: step 0 is the ONLY step at `COMBINATIONAL_DEPTH = 1`, so the gate would suppress the
 * single sample and yield a VACUOUS PASS - the exact failure mode the falsifiability assertion over
 * `adder_8bit` exists to catch.
 *
 * THE RESIDUAL IS NARROWED TO LATCHES, BECAUSE THE MEMORY HALF IS NOW MEASURED (Req 14, Evidence).
 * It was first stated over LATCHES or MEMORIES and closed with "no corpus reference is latch-only or
 * memory-only, so nothing in this corpus measures it", and THAT CLOSING CLAIM WAS FACTUALLY WRONG.
 * `verified_ROM` IS memory-only: MEASURED under the pre-pass's own script,
 * `read_verilog -sv <design>; prep -top ROM -flatten; opt_dff -sat`, its elaborated netlist carries
 * exactly ONE cell, `$mem_v2`, and ZERO `$dff`.
 *
 * ON THAT MEMBER THE OUTCOME IS MEASURED AND BENIGN, AND THE MECHANISM IS THIS FUNCTION'S OWN
 * NO-RESET ARM. The feared reading was "admitted with a FREE initial state", and that is not what
 * happens: the arm below reads NO initial-state predicate at all, so nothing is assumed free; the
 * renderer therefore emits no reset assume and no `if (!$initstate)` gate; so the `initial` block's
 * pinned ROM contents stay VISIBLE at step 0. MEASURED end to end through the real adapter: `mem[0]`
 * rewritten from `16'hA0A0` to `16'h1234` is REFUTED at depth 1 over 2 assertions, with `addr = 0`
 * and `dout = 16'h1234` read off step 0 of the counterexample VCD, and the unmutated design is
 * `proved`. So on the one member this residual has, a wrong memory entry is CAUGHT rather than
 * admitted.
 *
 * `clockPolarity: 'none'` MEANS "NO FLIP-FLOP CELL IN THE PRE-PASS NETLIST" AND NOT "NO STATE", and
 * that distinction is MEASURED rather than reasoned. One Yosys run over ROM's wrapper writing two
 * netlists: after `prep -top <wrapper> -flatten` it holds the `$mem_v2` and ZERO flops, and after the
 * four lowering passes it holds 252 `$ff` cells and a 255-way `$mux` tree, because
 * `memory_map -rom-only -keepdc` turns ROM's 252 UNINITIALISED entries into free constants. The two
 * layers legitimately DISAGREE because this pre-pass reads the netlist BEFORE `memory_map` runs:
 * Req 14.13 keeps `opt_dff -sat` out of the Lowering_Sequence and the pre-pass script
 * correspondingly runs no `memory_map`. That is a property of WHERE EACH LAYER SITS rather than a
 * defect in either one.
 *
 * WHAT REMAINS UNMEASURED IS THE LATCH CASE ALONE, and it keeps that label rather than losing it with
 * the memory half: a design holding state in LATCHES rather than `$dff` cells reports
 * `clockPolarity: 'none'` and is ADMITTED with a free initial state rather than refused. A free
 * initial state admits MORE behaviours, so the error runs in the false-REFUTATION direction, and it
 * cannot produce a false proof through the gate because no gate is emitted on this arm. No corpus
 * reference is latch-only, so nothing in this corpus measures that half.
 *
 * Pure and total over every schema-valid document: no branch throws and no field is defaulted.
 */
export function deriveFormalPrepassReport(
  document: FormalPrepassDocument,
): Result<FormalPrepassReport, CouldNotVerifyCause> {
  const clockRefusal = CLOCK_CONTRACT_REFUSAL[document.clockPolarity];
  if (clockRefusal !== null) {
    return err(clockRefusal);
  }
  const finding = document.reset;
  if (!finding.derived) {
    // The no-clocked-state arm (Req 14.40), keyed on the pre-pass's OWN derived Clock_Contract and on
    // nothing else (Req 14.42). No predicate read: `initialStateFree` lives on the derived member
    // alone, nothing consumes it here, and reading it would turn an unreadable predicate into
    // `toolchain-unavailable` for a design that holds no state for a predicate to describe.
    return document.clockPolarity === 'none'
      ? ok({ reset: finding, clockPolarity: document.clockPolarity })
      : err('reset-contract-unresolved');
  }
  const initialStateFree = readFreeInitialState(document.initialStatePredicate);
  if (initialStateFree === null) {
    return err('toolchain-unavailable');
  }
  return ok({
    reset: {
      derived: true,
      resetName: finding.resetName,
      resetActiveLow: finding.resetActiveLow,
      resetKind: finding.resetKind,
      initialStateFree,
      // A CONDITIONAL SPREAD rather than `resetEnable: finding.resetEnable`, and the build enforces
      // it: under `exactOptionalPropertyTypes` an explicit `undefined` is not assignable to an
      // optional field, so the absent enable stays an absent KEY rather than becoming a present key
      // holding nothing. The two are different shapes to `in`, to `JSON.stringify`, and to the
      // renderer, which is the distinction criterion 4.15 asks the field to carry.
      ...(finding.resetEnable === undefined ? {} : { resetEnable: finding.resetEnable }),
    },
    clockPolarity: document.clockPolarity,
  });
}

/**
 * A refused pre-pass, carrying the cause AND whatever the document had already established.
 *
 * TWO NULLABLE FIELDS RATHER THAN ONE CAUSE, because `FormalOutcome` has to distinguish a pre-pass
 * that RAN AND REFUSED from one that was NEVER READ AT ALL, and the cause alone cannot:
 * `toolchain-unavailable` is reported BOTH for a report this module could not read - nothing was
 * established - and for a document whose reset derived but whose initial-state predicate was
 * unreadable, where the Clock_Contract and the refusal both were (Req 14.27, 14.39).
 *
 * `null` on both means NO DOCUMENT WAS READ, which is the only case the Formal_Outcome records as
 * "the pre-pass was never reached". Where a document WAS read, `reset` is the refused arm
 * `{ derived: false }` - the derivation refused, whichever of its three refusals applied - and
 * `clockPolarity` is the contract the document carried, including the `negedge` or `mixed` value a
 * `clock-contract-unsupported` refusal is ABOUT. The two travel together because a reader of either
 * one needs to know whether a reading happened, and two independently nullable readings would let
 * one say yes while the other says no.
 */
export interface FormalPrepassRefusal {
  readonly cause: CouldNotVerifyCause;
  /** The refused reset arm where a document was read, or `null` where none could be. */
  readonly reset: ResetContract | null;
  /** The Clock_Contract the document carried, or `null` where no document could be read. */
  readonly clockPolarity: ClockPolarity | null;
}

/** The refusal for a text no document could be read from: nothing was established. */
const UNREADABLE_PREPASS: FormalPrepassRefusal = Object.freeze({
  cause: 'toolchain-unavailable',
  reset: null,
  clockPolarity: null,
});

/**
 * One pre-pass report text to one contract, or to the refusal AND the reading it still established.
 *
 * The composition of the two functions above, and the SINGLE OWNER of the mapping from a parse
 * rejection to a cause: every `FormalPrepassRejection` is `toolchain-unavailable`, because a report
 * that cannot be read is not a Reset_Contract that may be used (Req 14.26, 14.37). Owning that one
 * line here rather than at the adapter is what keeps an unreadable report from ever being reported
 * as a fact about the design.
 *
 * The refused reset arm is reported as `{ derived: false }` for EVERY derivation refusal rather
 * than as the document's own `reset` field, and that is the honest value on all three: a refused
 * derivation already IS that arm, a `clock-contract-unsupported` refusal never reached the reset at
 * all, and an unreadable predicate leaves `initialStateFree` unread so there is no derived member
 * to report. `{ derived: false }` says the derivation refused, which is what happened in each case.
 */
export function readFormalPrepassContract(
  text: string,
): Result<FormalPrepassReport, FormalPrepassRefusal> {
  const parsed = parseFormalPrepassReport(text);
  if (!parsed.ok) {
    return err(UNREADABLE_PREPASS);
  }
  const derived = deriveFormalPrepassReport(parsed.value);
  return derived.ok
    ? derived
    : err({
        cause: derived.error,
        reset: { derived: false },
        clockPolarity: parsed.value.clockPolarity,
      });
}

/**
 * One pre-pass report text to one contract, or to the `CouldNotVerifyCause` that refuses it.
 *
 * The cause-only projection of `readFormalPrepassContract` above, which is what every caller that
 * does not RECORD the run-level contract wants. It stays a function of its own rather than being
 * replaced by the richer one, because the cause is the whole of what the gate needs and a caller
 * reaching past it to a reading it will not use is a caller that can get the two out of step.
 */
export function readFormalPrepassReport(
  text: string,
): Result<FormalPrepassReport, CouldNotVerifyCause> {
  const read = readFormalPrepassContract(text);
  return read.ok ? read : err(read.error.cause);
}
