// The typed Formal_Property, the Property_Validator that is the only way to make one, and the
// Property_Renderer that is the only owner of property-to-source translation
// (design.md Component 3; Req 3.4, 3.7, 3.9, 3.10, 3.11, 5.1, 5.10, 6.1, 6.2, 6.3, 6.4, 6.5,
// 6.6, 6.7, 6.8, 6.9, 6.10, 6.13, 6.20, 6.21, 6.22, 6.23, 6.24, 14.1 to 14.7).
//
// THIS FILE CARRIES THREE THESES AND THAT IS ONE TOO MANY, recorded here rather than left for a
// reader to notice. The VALIDATOR and the RENDERER were already two, which is design.md's open
// question Q9; tasks 16.5 and 16.6 add a third - the CONTRACT-DRIVEN emissions, where what is
// emitted depends on a `ResetContract` and on the property's own `$past` depth rather than on the
// property's kind alone. The honest split is `renderPropertyWrapper` and everything below
// `coveredAntecedent` moving to a sibling `property-wrapper.ts` that imports the types from here,
// which leaves this file as the typed property plus its validator and keeps the emission rules in
// one place of their own. That is a module move touching this file, `app/tools/index.ts`, and
// `formal/interpret.ts`'s import of `coveredAntecedent`, so it is NAMED here rather than taken
// inside a task whose scope is the emissions themselves.
//
// WHY A WHITELIST AND NOT A BLACKLIST
//   This is the validator of the MEASURING INSTRUMENT. Yosys 0.66 has no SVA property parser
//   at all, so the accepted dialect is exactly what the feasibility probe measured working:
//   `always @(posedge clk) if (c) assert(e);`, unclocked module-level `assert property (e);`,
//   the sampled-value functions, and boolean implication written `!a || b` with no other form.
//   Anything not provably inside that dialect is REFUSED. Refusing costs one
//   `could-not-verify`; accepting something the toolchain silently mishandles costs a false
//   `Verified` label, which is the single failure mode this spec exists to prevent. So the
//   token classes below are a CLOSED admit-list and every other byte is a named rejection.
//
// WHY THE BRAND, AND WHAT THE SEAL DOES AND DOES NOT COVER
//   Req 6.13 wants a Formal_Property to be a typed value at the oracle's boundary rather than
//   a raw source string. `ValidatedExpression` is a branded string whose brand key is a
//   module-private `unique symbol`: no other module can name that key, so no other module can
//   build the brand, and `validateExpression` is the only exported function that returns one.
//   The honest ceiling: TypeScript's `as` can always be written by a caller who chooses to.
//   The brand makes that a deliberate, greppable act rather than something a `string`
//   parameter lets happen by accident, and no exported helper here performs one.
//
// WHY `scanSource` OWNS THE SPAN QUESTION
//   A `|->` inside a comment is not a `|->`. `scanSource` classifies every offset as code or
//   not, so construct detection below runs only over code and NEVER reads inside a comment, a
//   string literal, or a compiler directive. A prior session measured a CONFIRMED FALSE
//   REWRITE from treating comment text as code (see
//   `chipAgent/_inbox/pattern-verilog-adjacency-scans-must-continue-past-non-code-spans.md`),
//   and that is the mistake this reuse removes structurally rather than by care.
//   A non-code SPAN is nevertheless refused as expression content, named by its kind, for a
//   reason specific to this module: the renderer (task 3.2) splices a validated expression into
//   a SINGLE-LINE statement, so an accepted `x // note` would comment out the renderer's own
//   `assert(...)` tail. Both rules hold together - a construct inside a comment is reported as
//   `comment` and never as the construct it happens to contain.
//
// WHY ONE RENDERER AND NOT A TEMPLATE AT EACH CALL SITE
//   `renderPropertyWrapper` is the ONLY function in the system that turns a property into
//   Verilog text. Every code token it emits comes from exactly one of three places: the fixed
//   skeleton below, the `ModuleInterface`'s own port names, or the property's own
//   `ValidatedExpression`s. Nothing is derived, paraphrased, or reformatted on the way through.
//   That is what lets Req 3.7 - the wrapper holds no reimplementation of the design's function
//   - be read off the code rather than argued about, and it is why the cover can be the
//   property's own antecedent token for token rather than a second rendering of it.
//
// REJECT, NEVER REWRITE (Req 6.10)
//   On acceptance the input text is returned byte-identical: no trim, no normalization, no
//   repair. Repairing a property is writing a property, and this module does not write
//   properties.
//
// Pure and total: no model call, no file, network, clock, or random-source read, and never
// throws on any input (Req 6.9). One left-to-right pass, allocation-bounded, no recursion.

import { err, ok, type ModuleInterface, type Port, type Result } from '@app/core';

// TYPE-ONLY, and that is what keeps the file graph acyclic. `../formal/prepass.ts` is the SINGLE
// OWNER of `ResetContract` (Req 14.24, 14.38), so importing it is reuse rather than a second
// declaration - a structurally-identical local copy would be assignable to it and the duplication
// would hide rather than fail. `import type` is fully erased, so no runtime edge is created and
// `prepass.ts`'s module-load ajv compile is not pulled in here. It does add a DIRECTORY-level
// back-edge: `formal/interpret.ts` already imports this file, so `verilog` and `formal` now point
// at each other, while no FILE imports one that imports it back. design.md Component 3 places
// `ResetContract` in THIS module and task 16.3 placed it in Component 14's, which is the drift
// this import absorbs rather than resolves.
import { CLOCKED_CHECK_DELAY, FIRST_CLOCKED_RUNG } from '../formal/depth-ladder.js';
import type { ResetContract } from '../formal/prepass.js';
import { balanceRefusal, foreignSpanRefusal, lexAdmitted, type AdmitList } from './admit-lexer.js';

/**
 * Module-private brand key. Because this symbol is neither exported nor otherwise nameable,
 * no code outside this module can construct the brand's property, which is what makes
 * `validateExpression` the sole constructor of a `ValidatedExpression`.
 */
declare const VALIDATED_EXPRESSION: unique symbol;

/** An expression the Property_Validator has accepted. The brand is the point. */
export type ValidatedExpression = string & { readonly [VALIDATED_EXPRESSION]: true };

/**
 * Why a candidate expression was refused.
 *
 * `unaccepted-construct` always NAMES the construct it found (Req 6.7): the Property_Author
 * has to report an acceptance criterion as UNEXPRESSED, and it can only do that if it knows
 * what was refused. A generic "invalid expression" is a defect here, not a simplification.
 */
export type PropertyRejection =
  | { readonly reason: 'unaccepted-construct'; readonly construct: string }
  | { readonly reason: 'unbalanced-expression' }
  | { readonly reason: 'expression-too-long' }
  | { readonly reason: 'empty-expression' };

/**
 * One typed, structured property (Req 6.13). Never a raw source string at the boundary: every
 * expression field is a `ValidatedExpression`, so an unvalidated string cannot reach the
 * renderer or the Tool_Runner.
 */
export type FormalProperty =
  | {
      readonly kind: 'clocked';
      readonly id: string;
      /** The acceptance criterion this property was derived from (Req 6.14). */
      readonly criterionRef: string;
      readonly clock: ValidatedExpression;
      /** `null` for an unconditional clocked property, which has no cover. */
      readonly antecedent: ValidatedExpression | null;
      readonly consequent: ValidatedExpression;
    }
  | {
      readonly kind: 'combinational';
      readonly id: string;
      readonly criterionRef: string;
      readonly consequent: ValidatedExpression;
    };

/**
 * The accepted length of one property expression.
 *
 * The widest property the probe measured is `JC_counter`'s exact next state,
 * `Q == {~$past(Q[0]), $past(Q[63:1])}`, at 35 characters, and the exact-sum property for
 * `adder_pipe_64bit` is of the same order. 2000 is therefore roughly thirty times the widest
 * measured need, while still bounding the work this validator does on untrusted model output
 * and keeping a refused expression small enough to sit inside a bounded diagnostic. The bound
 * is checked before anything else, so an enormous input is refused rather than scanned.
 */
export const MAX_EXPRESSION_CHARS = 2_000;

// The construct-name bound is the shared lexer's, re-exported so existing imports keep working.
export { MAX_CONSTRUCT_CHARS } from './admit-lexer.js';

/**
 * The sampled-value and formal functions the probe measured Yosys 0.66 accepting.
 *
 * `$signed` and `$unsigned` are deliberately absent. The probe measured
 * `assert(p == $signed(a) * $signed(b))` computing an 8-bit product and then extending it -
 * `a=-44, b=76` yields `-16` where the true product is `-3344` - and iverilog agrees, so that
 * is standard Verilog width semantics rather than a Yosys deviation. It is an expression the
 * toolchain accepts and quietly gets wrong, which is exactly the class a whitelist exists to
 * keep out.
 */
const ACCEPTED_SYSTEM_FUNCTIONS: ReadonlySet<string> = new Set([
  '$past',
  '$rose',
  '$fell',
  '$stable',
  '$changed',
  '$initstate',
  '$anyconst',
  '$countones',
]);

/** One measured rejected form: the name to report for it, and the pattern that finds it. */
export interface MeasuredRejectedForm {
  readonly construct: string;
  readonly pattern: RegExp;
}

/**
 * Every form the probe MEASURED Yosys 0.66 rejecting, with the name to report for it.
 *
 * This table exists alongside the token whitelist rather than being subsumed by it, for two
 * reasons. A greedy tokenizer would name a misleading FRAGMENT - `|` for `|->`, `#` for `##`,
 * `[` for `[*` - and the two-word forms are not single tokens at all. And a reviewer checking
 * Req 6.7 against the measurement wants to read the twelve measured forms in one place.
 *
 * EXPORTED so the dialect properties (tasks 3.3, 3.4) assert against THIS table rather than a
 * hand-copied list of literals. A test that re-spells the table it checks cannot notice a
 * thirteenth row; reading the table means a new measured rejection is covered the moment it
 * lands here. Export only - nothing outside this module decides what the table contains.
 *
 * All twelve patterns are NON-GLOBAL on purpose: a shared `/g` regex carries `lastIndex`
 * between calls and has already hung this repository's whole vitest suite once
 * (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`). A consumer that
 * needs occurrence COUNTS must therefore build its own global regex from `pattern.source`,
 * freshly, per call - never add `/g` here.
 */
export const MEASURED_REJECTED_FORMS: readonly MeasuredRejectedForm[] = [
  // `assert property (@(posedge clk) e)` is `syntax error, unexpected '@'`. A clock reaches the
  // renderer as its own expression field and is wrapped in `@(posedge ...)` there.
  { construct: '@', pattern: /@/ },
  { construct: '|->', pattern: /\|->/ },
  { construct: '|=>', pattern: /\|=>/ },
  { construct: '##', pattern: /##/ },
  { construct: 'throughout', pattern: /\bthroughout\b/ },
  { construct: '[*', pattern: /\[\s*\*/ },
  { construct: 's_eventually', pattern: /\bs_eventually\b/ },
  { construct: 'disable iff', pattern: /\bdisable\s+iff\b/ },
  { construct: 'property', pattern: /\bproperty\b/ },
  { construct: 'endproperty', pattern: /\bendproperty\b/ },
  { construct: 'default clocking', pattern: /\bdefault\s+clocking\b/ },
  // `Can't resolve function name '\$sampled'` - the one measured rejection that is not a
  // syntax error, so it is the one a reader is most likely to assume works.
  { construct: '$sampled', pattern: /\$sampled\b/ },
];

/**
 * Identifier-shaped words that are keywords rather than signal names.
 *
 * An identifier token is otherwise open-ended, because a port name can be anything, so the
 * whitelist needs this one refinement to keep a keyword from entering as a signal.
 *
 * ponytail: this is NOT the full ~102-word Verilog keyword list, and deliberately so. Every
 * keyword outside this set lands as a loud Yosys parse error, which the adapter attributes to
 * `property-build-failed` - the fail-safe direction, never a false `Verified`. The set names
 * the words a property author plausibly writes: the assertion statements, SVA's sequence
 * algebra, the event-control words, and the statement keywords that are the splice-injection
 * shapes. Upgrade path if a keyword ever slips through with a confusing diagnostic: add it
 * here, or move to the expression AST the design's alternatives table already records.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'assert',
  'assume',
  'cover',
  'restrict',
  'expect',
  'property',
  'endproperty',
  'sequence',
  'endsequence',
  'clocking',
  'endclocking',
  'default',
  'disable',
  'iff',
  'throughout',
  'within',
  'intersect',
  'first_match',
  's_eventually',
  'eventually',
  's_until',
  'until',
  's_until_with',
  'until_with',
  'nexttime',
  's_nexttime',
  'posedge',
  'negedge',
  'edge',
  'always',
  'begin',
  'end',
  'module',
  'endmodule',
  'if',
  'else',
  'initial',
  'assign',
  'wait',
  'forever',
  'repeat',
  'while',
  'for',
  'case',
  'casex',
  'casez',
  'endcase',
  'function',
  'endfunction',
  'task',
  'endtask',
  'generate',
  'endgenerate',
]);

/**
 * The accepted operators and grouping punctuation: ordinary Verilog boolean, comparison,
 * arithmetic, bit-select, part-select, and concatenation text, and nothing else.
 *
 * Ordered LONGEST FIRST, because the tokenizer takes the first match: `===` must win over
 * `==`, and `**` over `*`. Absent on purpose and therefore refused: `;`, which is the
 * statement-injection shape, `#`, which is a delay, and `.`, for the reason below.
 *
 * `.` STAYS OUT BECAUSE A HIERARCHICAL PATH IS A MEASURED SILENT FALSE PROOF, NOT DIALECT
 * SCOPE (Req 6.18, 6.19). `assert(dut.cnt <= 4'd8)` on `radix2_div` compiles, lowers, and is a
 * LIVE assertion, yet `write_json` shows the design's real counter RENAMED to `dut.cnt_1` and
 * `dut.cnt` bound to a FRESH 1-bit net that nothing drives. Every variant then reported
 * `PASSED`, including the one carrying no assume at all, which is measured to FAIL for every
 * honest wrapper over that design. Yosys raises no error and no warning, and the report reads
 * exactly like a real proof, so nothing downstream of this list can catch it: refusing `.` here
 * is the ONLY thing standing between the gate and that false proof
 * (`chipAgent/_inbox/gotcha-hierarchical-reference-in-a-property-wrapper-is-a-silent-false-proof.md`).
 * Admitting `.` - for a struct member, an interface field, or anything else - is therefore never
 * only a question of how wide the dialect is: it reopens the false proof, which is why
 * `app/test/formal-property-validation.property.test.ts` pins this exclusion as a regression
 * rather than a preference.
 */
const ACCEPTED_OPERATORS: readonly string[] = [
  '===',
  '!==',
  '<<<',
  '>>>',
  '==',
  '!=',
  '&&',
  '||',
  '<=',
  '>=',
  '<<',
  '>>',
  '**',
  '~^',
  '^~',
  '~&',
  '~|',
  '!',
  '~',
  '&',
  '|',
  '^',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '?',
  ':',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
];

/** Verilog's whitespace set, spelled out rather than `\s` so the admit-list stays closed. */
function isWhitespace(character: string): boolean {
  return /^[ \t\r\n\f]$/.test(character);
}

function isWordPart(character: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(character);
}

/** The first measured rejected form present in the text, or `null`. */
function measuredFormRejection(text: string): PropertyRejection | null {
  const form = MEASURED_REJECTED_FORMS.find((candidate) => candidate.pattern.test(text));
  return form === undefined ? null : { reason: 'unaccepted-construct', construct: form.construct };
}

/** The Property_Validator's admit-list, handed to the shared lexer. */
const PROPERTY_ADMIT_LIST: AdmitList = {
  systemNames: ACCEPTED_SYSTEM_FUNCTIONS,
  reservedWords: RESERVED_WORDS,
  operators: ACCEPTED_OPERATORS,
};

/** The first token the admit-list refuses, or `null` when every token is admitted. */
function tokenRejection(text: string): PropertyRejection | null {
  const lexed = lexAdmitted(text, PROPERTY_ADMIT_LIST);
  return lexed.ok ? null : lexed.error;
}

/** The construct a depth this reader cannot read is refused as. */
const UNREADABLE_DEPTH_CONSTRUCT = '$past(_, unreadable)';

/**
 * The first `$past` call this renderer cannot gate for, or `null`.
 *
 * Last in `validateExpression`'s order: it reads meaning off tokens, so it relies on every
 * earlier guard having admitted the text. Why it refuses rather than guesses: design.md, C18.
 */
function pastDepthRejection(text: string): PropertyRejection | null {
  for (const depth of pastDepthsIn(text)) {
    if (depth === null) {
      return { reason: 'unaccepted-construct', construct: UNREADABLE_DEPTH_CONSTRUCT };
    }
    if (depth > MAX_WARM_UP_DEPTH) {
      const construct = `${PAST_FUNCTION}(_, ${String(depth)}) > ${String(MAX_WARM_UP_DEPTH)}`;
      return { reason: 'unaccepted-construct', construct };
    }
  }
  return null;
}

/**
 * The ONLY constructor of a `ValidatedExpression` (Req 6.6, 6.8). Pure, total, never throws.
 *
 * On acceptance the text is returned BYTE-IDENTICAL, so no validated property differs from
 * what was written (Req 6.10). On refusal the rejection names what it found (Req 6.7).
 *
 * The checks run cheapest-and-most-specific first: the length bound before any scan, then the
 * empty case which has no construct to name, then the span question, then the measured forms
 * whose names come from the probe, then the closed token admit-list, then bracket balance.
 */
export function validateExpression(text: string): Result<ValidatedExpression, PropertyRejection> {
  if (text.length > MAX_EXPRESSION_CHARS) {
    return err({ reason: 'expression-too-long' });
  }
  if (text.trim().length === 0) {
    return err({ reason: 'empty-expression' });
  }
  const rejection =
    foreignSpanRefusal(text) ??
    measuredFormRejection(text) ??
    tokenRejection(text) ??
    balanceRefusal(text) ??
    pastDepthRejection(text);
  return rejection === null ? ok(text as ValidatedExpression) : err(rejection);
}

/**
 * The design instance's name inside the Property_Wrapper.
 *
 * Exactly one submodule, because the wrapper's whole job is to carry properties beside an
 * UNMODIFIED design (Req 3.4): the design source is written byte-identical and the wrapper is
 * the `-top`, so the properties elaborate inside the design rather than beside it (Req 3.6).
 * `buildCompileHarness` already instantiates a DUT under this name, so the two harnesses read
 * the same way.
 */
const DUT_INSTANCE_NAME = 'dut';

/**
 * The wrapper's signals, split the ONE way `write_smt2` and the AIGER route both require.
 *
 * ONE SENTENCE SO IT CANNOT BE HALF-REMEMBERED: **inputs must be ports, outputs must not be.**
 * A reader holding one half gets it wrong in a silent direction either way, so both
 * measurements sit here together.
 *
 * DESIGN INPUTS MUST BE WRAPPER PORTS, because `write_smt2` makes only TOP-LEVEL INPUTS free
 * variables (Req 3.9). A design input declared as an internal wrapper wire is tied to a
 * constant, so the proof covers ONE input assignment instead of all of them - a `proved` that
 * means far less than it says.
 *
 * DESIGN OUTPUTS AND EVERY OTHER OBSERVED SIGNAL MUST BE INTERNAL WIRES (Req 3.10), and this
 * CORRECTS the `wrapperPorts` task 3.2 delivered, which declared them with their own
 * directions. MEASURED: with the observed signals declared as wrapper OUTPUTS, `write_aiger`
 * emits each as a regular AIGER output - `O=4` on `counter_12` - and ABC then prints its own
 * explanation and proceeds anyway, `Warning: All 5 outputs will be ORed together`, so it ORs
 * the DESIGN'S OWN OUTPUTS into the property and REFUTES a design that z3 and rIC3 both PROVE.
 * Moving the same signals to internal wires so `O=0` makes ABC report `Property proved.` on the
 * IDENTICAL property; nothing about the property changed, only the port direction. rIC3 is
 * IMMUNE throughout, because it reads the bad-state channel and ignores outputs, so the defect
 * is INVISIBLE on one engine and FATAL on another - a wrapper carrying it passes every z3 and
 * rIC3 check ever run against it, and the first engine that notices manufactures a refutation
 * instead of an error
 * (`chipAgent/_inbox/gotcha-property-wrapper-must-expose-no-output-ports.md`).
 *
 * CLOCK AND RESET BELONG TO THE CLOCKING CONTRACT RATHER THAN TO THE DECLARED PORT LIST
 * (Req 3.11). `ModuleInterface` holds them in `clocking`, but a Verilog header lists them as
 * ordinary width-1 inputs, so a wrapper assembled from `ports` alone leaves `clk` UNDECLARED -
 * and that does not fail loudly. Verilog gives it an implicit width-1 net, which `prep` sees as
 * an UNDRIVEN wire rather than a free input, and a clock that never ticks proves nothing while
 * still reporting a `Status:`. That was a measured defect
 * (`chipAgent/_inbox/gotcha-formal-wrapper-must-declare-clock-and-reset-as-its-own-ports.md`),
 * so flattening the contract in is load-bearing rather than cosmetic.
 *
 * ponytail: the flattening duplicates the rule `expectedInterfacePorts`
 * (`app/agent/roles/generation/spec-view.ts`) owns for the prompt, the interface check, and the
 * compile harness. It is not imported because `@app/tools` must not import `@app/agent`; the
 * ceiling is two owners of one rule, and the upgrade path when a third owner appears is to move
 * that function down into `@app/core` beside `ModuleInterface` and have both read it.
 *
 * Not deduplicated on purpose. A `ModuleInterface` that declares its clock both in `ports` and
 * in `clocking` yields a duplicate declaration and an unbuildable wrapper, which the adapter
 * attributes to `property-build-failed` - loud, and about our own instrument. Keeping the first
 * occurrence instead could silently keep an `output clk` and drop the clock input, which is the
 * same wrapper reporting a status over a clock that never ticks.
 */
interface WrapperSignals {
  /** Every design INPUT plus the clock and the reset: the wrapper's ONLY ports, all inputs. */
  readonly ports: readonly Port[];
  /** Every design output and every other observed signal, as internal wires. */
  readonly wires: readonly Port[];
  /** Ports then wires: every signal the design instance is connected to, BY NAME. */
  readonly connected: readonly Port[];
}

/**
 * Split one design interface into the wrapper's ports, its internal wires, and its connections.
 *
 * Derived from ONE list in one pass, so the port/wire partition and the connection list cannot
 * disagree about which signals exist: `connected` is the whole set and the other two are views
 * of it. Connections are made BY NAME below, so the order within each view is free.
 */
function wrapperSignals(designInterface: ModuleInterface): WrapperSignals {
  const { clockName, resetName } = designInterface.clocking;
  const clockingPorts: readonly Port[] = [clockName, resetName]
    .filter((name): name is string => name !== null)
    .map((name) => ({ name, direction: 'input', width: 1 }));
  const connected: readonly Port[] = [...designInterface.ports, ...clockingPorts];
  return {
    ports: connected.filter((port) => port.direction === 'input'),
    wires: connected.filter((port) => port.direction !== 'input'),
    connected,
  };
}

/** A Verilog range suffix for a signal wider than one bit, or empty for width 1. */
function rangeSuffix(width: number): string {
  return width > 1 ? ` [${width - 1}:0]` : '';
}

/**
 * Declare one design input as a wrapper INPUT port.
 *
 * `input` is a LITERAL rather than `port.direction`, deliberately: Req 3.10's "no Property_Wrapper
 * port whose direction is other than input" then holds of the EMITTED TEXT rather than of the
 * filter that fed this function, so a widened filter cannot reintroduce the measured ABC defect.
 */
function declareInputPort(port: Port): string {
  return `  input${rangeSuffix(port.width)} ${port.name}`;
}

/** Declare one design output, or any other observed signal, as an internal wire (Req 3.10). */
function declareInternalWire(port: Port): string {
  return `  wire${rangeSuffix(port.width)} ${port.name};`;
}

/** Connect one design port straight through to the wrapper port of the same name. */
function connectPort(port: Port): string {
  return `    .${port.name}(${port.name})`;
}

/**
 * The antecedent a Cover_Check evaluates for this property, or `null` when there is none.
 *
 * THE SINGLE OWNER OF "DOES A COVER APPLY". Two places need that answer and they must never
 * disagree: the renderer below, which emits the `cover`, and the formal gate's interpretation of
 * the Cover_Check result, which records the condition as `not-applicable` when no cover was
 * emitted (Req 5.10). If those two ever drifted, a property whose cover WAS emitted could have
 * its unreached cover recorded as not-applicable, and a vacuous proof would pass the very
 * detector that exists to catch it - the measured `multi_booth_8bit` case, whose `rdy` is first
 * reachable at step 19. So the rule is written once, here, and both sides call it.
 *
 * A combinational property has no antecedent at all, and a clocked one may be unconditional; the
 * return value collapses both into the same `null`, because a cover is emitted for exactly the
 * case where there is an antecedent to cover.
 */
export function coveredAntecedent(property: FormalProperty): ValidatedExpression | null {
  return property.kind === 'clocked' ? property.antecedent : null;
}

/** Every expression one property carries, so a rule over "its own expressions" can read them all. */
function expressionsOf(property: FormalProperty): readonly ValidatedExpression[] {
  if (property.kind === 'combinational') {
    return [property.consequent];
  }
  const antecedent = property.antecedent;
  return antecedent === null
    ? [property.clock, property.consequent]
    : [property.clock, antecedent, property.consequent];
}

/** The sampled-value function whose depth argument sets the Warm_Up_Gate's depth (Req 6.20). */
const PAST_FUNCTION = '$past';

/**
 * The sampled-value function Yosys refuses OUTSIDE a clocked block (Req 6.23).
 *
 * MEASURED: `ERROR: System function \$stable is only allowed in clocked blocks`. It is
 * `$past`-derived, so Yosys refuses it where there is no clock to define what the previous sample
 * even means, which is the honest response rather than a limitation.
 */
const STABLE_FUNCTION = '$stable';

/** The construct a combinational `$past` of nonzero depth is refused as. */
const COMBINATIONAL_PAST_CONSTRUCT = `${PAST_FUNCTION} in combinational`;

/** The construct a combinational `$stable` is refused as. */
const COMBINATIONAL_STABLE_CONSTRUCT = `${STABLE_FUNCTION} in combinational`;

/**
 * The largest `$past` depth this renderer will gate for: the last sample the first clocked
 * rung evaluates. A bound is required, because an unbounded gate is a false-proof path on a
 * property with no antecedent. Why this arithmetic, and why not 19: design.md, Component 18.
 */
export const MAX_WARM_UP_DEPTH = FIRST_CLOCKED_RUNG - 1 - CLOCKED_CHECK_DELAY;

/**
 * The Warm_Up_Gate's counter, LOCAL to the Property_Wrapper (Req 6.24).
 *
 * A wrapper-local counter rather than a reference into the design, and the counter is COUNTED
 * rather than expressed with sampled-value functions, because the sampled-value form is a HARD
 * Yosys error: `assume(!($initstate || $past($initstate, 1)) || rst);` reports
 * `ERROR: Don't know how to detect sign and width for AST_FCALL node!`, so nested `$past` on
 * `$initstate` is unavailable and an N-step window has to be counted here.
 *
 * ponytail: the name is not namespaced against a design signal or a property expression that
 * happens to spell it. A design port of this name yields a duplicate declaration and an
 * unbuildable wrapper, which the adapter attributes to `property-build-failed` - loud, about our
 * own instrument, and never a verdict about the design - which is the same fail-safe direction
 * `wrapperSignals` accepts for a duplicated clock. The upgrade path if that ever fires is to
 * derive a name disjoint from the interface's own, which needs the interface at every call site
 * that names it.
 */
const WARM_UP_COUNTER_NAME = '__formal_warmup_age';

/** One `$past` call's parsed depth, and the offset just past the call's closing paren. */
interface PastCall {
  /** `null` where the depth is not an unsized decimal literal this reader can hold exactly. */
  readonly depth: number | null;
  readonly end: number;
}

/**
 * The value of one unsized decimal literal, or `null` for every other form.
 *
 * Only this form: a reader that ignores a sized literal's width sizes a gate the tool does not,
 * because `2'd7` is 3 in Verilog. See design.md, Component 18.
 */
function literalValue(text: string): number | null {
  // Tested before underscores are stripped, so `_19`, which Verilog reads as an identifier,
  // does not read as 19.
  if (!/^\d[\d_]*$/.test(text)) {
    return null;
  }
  const value = Number(text.replaceAll('_', ''));
  return Number.isSafeInteger(value) ? value : null;
}

/** The offset of the first non-whitespace character at or after `index`. */
function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && isWhitespace(text.charAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

/**
 * The offset just past the `)` closing the `(` at `open`, or `text.length` when it never closes.
 *
 * `validateExpression` refuses an unbalanced expression, so a validated expression always closes;
 * the unclosed branch exists so this function is total over any string rather than only over the
 * ones that reach it.
 */
function callEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return text.length;
}

/**
 * The depth of the `$past` call whose `(` sits at `open`, and where that call ends.
 *
 * `$past(x)` is depth 1, which is SystemVerilog's own default and not a fallback of ours.
 * An UNREADABLE second argument also reads as 1 rather than as no `$past` at all: a `$past` IS
 * present, so the one answer that is certainly wrong is zero warm-up. It cannot be gated
 * correctly either, so the wrapper it renders fails to BUILD on the same bad argument - loud, and
 * about our own instrument.
 *
 * Only the TOP-LEVEL comma separates the arguments, so `$past({a, b}, 2)` reads 2 rather than `b`.
 */
function pastCallAt(text: string, open: number): PastCall {
  const end = callEnd(text, open);
  const inner = text.slice(open + 1, Math.max(open + 1, end - 1));
  let depth = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner.charAt(index);
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
    } else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      return { depth: literalValue(inner.slice(index + 1).trim()), end };
    }
  }
  return { depth: 1, end };
}

/**
 * Every `$past` depth one expression carries, in source order.
 *
 * Matched on the WORD `$past` rather than the string: `$pastx(` is a different token, and the
 * validator refuses it, so admitting it here would read a depth off something that can never be
 * rendered. Whitespace between the name and the `(` is admitted, because `validateExpression`
 * admits it.
 *
 * ponytail: NESTED `$past` depths are read independently rather than summed, so
 * `$past($past(a, 2), 3)` reads 3 where its true reach is 5. Req 6.21 asks for the largest depth
 * the expressions CARRY, which is what this returns, and the residual direction is an under-long
 * warm-up on a shape no measured property uses. Upgrade path is the expression AST design.md's
 * alternatives table already records, which is where nesting depth becomes cheap to know.
 */
function pastDepthsIn(expression: string): readonly (number | null)[] {
  const depths: (number | null)[] = [];
  let index = expression.indexOf(PAST_FUNCTION);
  while (index !== -1) {
    const after = index + PAST_FUNCTION.length;
    const open = skipWhitespace(expression, after);
    if (!isWordPart(expression.charAt(after)) && expression.charAt(open) === '(') {
      depths.push(pastCallAt(expression, open).depth);
    }
    index = expression.indexOf(PAST_FUNCTION, index + 1);
  }
  return depths;
}

/** Whether `expression` calls the system function `name`, as a whole token. */
function callsFunction(expression: string, name: string): boolean {
  let index = expression.indexOf(name);
  while (index !== -1) {
    if (!isWordPart(expression.charAt(index + name.length))) {
      return true;
    }
    index = expression.indexOf(name, index + 1);
  }
  return false;
}

/** The Warm_Up_Gate one property needs: its depth, and the counter width that holds it. */
interface WarmUpGate {
  readonly depth: number;
  readonly width: number;
}

/**
 * What the renderer will emit for one property: nothing at all, or its statements and any gate.
 *
 * `renderable: false` emits NO assertion and NO cover, which leaves the wrapper carrying ZERO
 * assertions. That is not a silent drop: a zero assertion count is the FIRST and hardest
 * condition of the five-condition gate (Req 1.1), so the sample reports `could-not-verify` with
 * `zero-assertions` and no verdict about the design is reachable from it. Choosing that over
 * letting Yosys reject the wrapper is deliberate - the guard is OURS and is already asserted,
 * where a tool error message is neither.
 */
type PropertyEmission =
  | { readonly renderable: false }
  | { readonly renderable: true; readonly warmUp: WarmUpGate | null };

/** The smallest counter width that holds every value from 0 to `depth`. */
function counterWidth(depth: number): number {
  let width = 1;
  while (2 ** width <= depth) {
    width += 1;
  }
  return width;
}

/**
 * The named refusal of a property shape the renderer cannot emit, or `null` (Req 13.16, 13.17).
 *
 * The clocked shape has no shape refusal of its own, so only a combinational property's
 * consequent is read, with the two readers `planEmission` uses. Both assembly paths - the
 * Property_Author and the test fixtures - call this, so neither re-states the rule.
 *
 * A combinational `$past` or `$stable` is unemittable for two different reasons:
 *   - `$stable` is a MEASURED hard Yosys error outside a clocked block (Req 6.23).
 *   - A `$past` of depth 1 or more REQUIRES an N-clock-edge Warm_Up_Gate (Req 6.20), and the
 *     module-level `assert property (...)` form has no clocking event to count edges on. Emitting
 *     it WITHOUT that gate is the twelve-for-twelve false refutation `planEmission` records.
 *
 * `$past(x, 0)` reads as depth 0 and renders, so it stays accepted. Why the refusal is named here
 * rather than left silent at the renderer: design.md, Component 18.
 *
 * ponytail: `$rose`, `$fell`, and `$changed` are `$past`-derived and get no warm-up either, but
 * the renderer emits them, so refusing them here would be wider than the silent refusal this
 * replaces. Their unclocked behaviour is UNMEASURED; residual direction if Yosys samples them at
 * step 0 is a false refutation, on properties no measured reference uses. The upgrade path is a
 * measurement of that shape, which would then move both the refusal and the render together.
 */
export function propertyShapeRejection(property: FormalProperty): PropertyRejection | null {
  if (property.kind !== 'combinational') {
    return null;
  }
  // An unreadable depth is the validator's refusal, not this one's, so it reads as no depth here
  // and `planEmission`'s own backstop still refuses the wrapper.
  if (pastDepthsIn(property.consequent).some((depth) => depth !== null && depth > 0)) {
    return { reason: 'unaccepted-construct', construct: COMBINATIONAL_PAST_CONSTRUCT };
  }
  if (callsFunction(property.consequent, STABLE_FUNCTION)) {
    return { reason: 'unaccepted-construct', construct: COMBINATIONAL_STABLE_CONSTRUCT };
  }
  return null;
}

/**
 * Decide, once, what this property's own shape admits. Every emitter below reads this.
 *
 * THE WARM-UP GATE IS NOT OPTIONAL AND ITS DEPTH IS NOT A CONSTANT (Req 6.20, 6.21). A clocked
 * assert SAMPLES the step-0 state, so its first sample evaluates `$past(Q)` against a value
 * nothing ever drove. MEASURED: `JC_counter`'s exact-next-state property was refuted by ALL
 * TWELVE engine configurations until a wrapper-local age counter was added. Twelve for twelve is
 * what makes it dangerous rather than annoying - it is an instrument defect that looks EXACTLY
 * like a design bug on every engine at once, so cross-engine agreement offers NO protection, and
 * the usual reflex of trusting unanimous refutation is precisely the wrong conclusion
 * (`chipAgent/_inbox/gotcha-a-past-depth-n-property-needs-an-n-step-warm-up-gate-or-every-engine-refutes-it.md`).
 *
 * NO `$past` MEANS NO GATE (Req 6.22), so a property that reaches backward across no boundary is
 * evaluated from its first sample.
 *
 * THE UNCLOCKED SHAPE CARRIES NEITHER `$past` NOR `$stable`, and that shape question is
 * `propertyShapeRejection`'s, which this calls first, so the backstop and the named refusal
 * cannot disagree.
 */
function planEmission(property: FormalProperty): PropertyEmission {
  if (propertyShapeRejection(property) !== null) {
    return { renderable: false };
  }
  const readable: number[] = [];
  for (const value of expressionsOf(property).flatMap((e) => pastDepthsIn(e))) {
    // The validator refuses an unreadable depth, so this is a backstop a validated expression
    // cannot reach; only a cast past the brand gets here.
    if (value === null) {
      return { renderable: false };
    }
    readable.push(value);
  }
  const depth = readable.length === 0 ? 0 : Math.max(...readable);
  if (property.kind === 'combinational') {
    return { renderable: true, warmUp: null };
  }
  if (depth === 0) {
    return { renderable: true, warmUp: null };
  }
  if (depth > MAX_WARM_UP_DEPTH) {
    return { renderable: false };
  }
  return { renderable: true, warmUp: { depth, width: counterWidth(depth) } };
}

/**
 * The UNCLOCKED reset assume, or `null` for a refused contract (Req 14.1).
 *
 * THE ASSUMED CONDITION IS THE RESET BEING **ASSERTED** (Req 14.2), which is what pins the base
 * case's starting state to the design's real reset state instead of a free one. So the emitted
 * term is `!<reset>` for an ACTIVE-LOW reset and the bare `<reset>` for an ACTIVE-HIGH one - the
 * `!` is present exactly when the reset is active LOW. Req 14.2 words the same rule as "inverted
 * where the derived polarity is active-high", which is relative to the `!$initstate || !<reset>`
 * TEMPLATE the measurement was recorded against
 * (`chipAgent/_inbox/pattern-formal-wrapper-reset-assume-repairs-base-case-and-vacuity.md`);
 * both readings name the same emitted text, and the invariant that decides it is "asserted".
 *
 * GETTING THIS BACKWARDS IS THE WORST OUTCOME IN THIS FILE. An inverted term assumes the design
 * OUT of reset, and that is MEASURED - the active-high form against `counter_12`'s active-low
 * reset - to arrive as a FAILING Base_Check over a PASSING Induction_Check, which is byte for
 * byte the false-proof signature of the `bad_init` case. So it does not surface as an instrument
 * fault: it reaches the student as a REFUTATION of their own correct design; and an assume that is
 * too WIDE fails the other way, excluding a reachable path for a vacuous pass, which is why the
 * enabling-signal clause below is held by a measured boundary pair rather than by argument
 * (`design.md`, Component 20 of `formal-gate-first-light`).
 *
 * WHERE THE CONTRACT CARRIES AN ENABLING SIGNAL, THAT SIGNAL IS ASSUMED ASSERTED TOO (criterion
 * 4.16 of that spec, which AMENDS Req 14.19). Yosys's `$sdffce` resets only while its enable is
 * active, so the reset alone pins a step the solver may choose not to be a reset at all: MEASURED
 * on `LIFObuffer`, all 7 reset-carrying cells are `$sdffce` with a non-constant enable. The
 * assumed term becomes the conjunction, each signal at its OWN asserted level, so the assumed
 * reset step is one that actually fires. An ABSENT enable is a reset that fires on its own -
 * `$sdffe` and `$adffe` reset whatever their enable does - and it emits exactly the line it always
 * has, which is why absence is a missing key rather than a defaulted level.
 *
 * THE POLARITY IS DERIVED AND NEVER READ FROM THE MODEL. `resetActiveLow` here comes from the
 * Reset_Contract_Prepass's read of the elaborated netlist, 31 of 31 in agreement with source-read
 * ground truth; `ClockingContract.resetActiveLow` originates in a model-generated Spec and is at
 * most a cross-check, so nothing in this renderer reads it (Req 14.9, 14.10).
 *
 * UNCLOCKED, AND THE CLOCKED FORM REPAIRS NOTHING. MEASURED on `counter_12` with `out <= 4'd11`:
 * a clocked assume plus a clocked assert passes, while a clocked assume plus a module-level
 * `assert property (...)` FAILS at step 0, because the clocked assume is gated by the same
 * clock-edge-detect register the clocked assert is - so at step 0 it is trivially satisfied while
 * the state is still FREE. This renderer emits BOTH assertion shapes, so a form that repairs only
 * one of them repairs nothing.
 *
 * ONE ASSUMED CYCLE IS ENOUGH for an async reset, and the mechanism was READ off the generated
 * SMT2 rather than inferred: `async2sync` lowers the `$adff` so the register output is a
 * combinational function of reset in the SAME step, so one asserted step pins the whole visible
 * state. Confirmed on the 4-stage `adder_pipe_64bit`, which needed no extra input assumption.
 *
 * Uses only the already-accepted dialect: `$initstate` and `assume` are both in the measured
 * accept list, and the implication is written `!a || b` because there is no other form.
 */
function resetAssumeLine(reset: ResetContract): readonly string[] {
  if (!reset.derived) {
    return [];
  }
  // ONE reading of `activeLow` for both signals: `ResetEnable.activeLow` is spelled the same way
  // round as `resetActiveLow`, so each is asserted LOW exactly where its own flag is set.
  const assertedLevel = (name: string, activeLow: boolean): string =>
    activeLow ? `!${name}` : name;
  const asserted = assertedLevel(reset.resetName, reset.resetActiveLow);
  const enable = reset.resetEnable;
  const fires =
    enable === undefined
      ? asserted
      : `(${asserted} && ${assertedLevel(enable.name, enable.activeLow)})`;
  return [`  assume property (!$initstate || ${fires});`];
}

/**
 * Whether the `if (!$initstate)` assertion gate is EMITTED for this property under this contract.
 *
 * THE SINGLE OWNER OF THAT QUESTION, read by `gateCondition` below and by the Formal_Oracle
 * adapter, which records the answer on the `FormalOutcome` so a verdict is re-readable against the
 * wrapper it was taken under (Req 14.27). Exported rather than re-derived there for the reason the
 * `ResetContract` union is imported rather than re-declared: two copies of a two-condition rule
 * would let the record and the emitted text drift apart on the one fact they must agree about.
 *
 * THE TERM IS EMITTED ONLY WHERE THE RESET IS SYNCHRONOUS **AND** THE INITIAL STATE IS FREE -
 * both conditions, not either (Req 14.3, 14.4, 14.5). This is the most important narrowing in the
 * file, because the failure it closes is in the FALSE-PROOF direction.
 *
 * MEASURED, with the gate applied UNIVERSALLY: `bad_init`, carrying `initial out = 4'd15` against
 * the property `out <= 11`, reports base `FAILED` WITHOUT the gate, and with the gate reports base
 * and induction both `PASSED` while rIC3 reports `UNSAT`. The gate turns a DETECTED BUG into a
 * PROOF on every engine measured, because the gate says do not evaluate the assertion at
 * `$initstate` and this defect IS the step-0 sample.
 *
 * The mechanism that makes BOTH conditions necessary:
 *   - For a SYNCHRONOUS reset `async2sync` cannot pin step 0 - the reset takes effect at step 1 -
 *     so the step-0 sample is a free-variable artifact of the model rather than a fact about the
 *     design, and suppressing it is correct.
 *   - For an ASYNCHRONOUS reset the assume DOES pin step 0 in the same step, so the sample is
 *     meaningful and no gate is needed.
 *   - A sync-reset design that HAS an `initial` value has step 0 pinned by that value, so gating
 *     it is exactly what would mask a wrong `initial` value. 6 of 50 corpus references contain an
 *     `initial` block, and every one of them is therefore ungated.
 *
 * THE OTHER TWO CONDITIONS ARE ABOUT WHAT IS EMITTED AT ALL, and they are read here rather than
 * left to the caller because this predicate answers "did the wrapper CARRY the gate" and not "does
 * the contract permit one". `propertyStatements` discards the gate text for the COMBINATIONAL
 * shape - a module-level `assert property (...)` has no `if` to carry it - and emits no statement
 * whatsoever for a property `planEmission` refused, so on both of those the gate is genuinely
 * absent however the reset reads.
 *
 * NO EMISSION DECISION IS DERIVED FROM A FAILING STEP (Req 14.7). A clocked assert never reports
 * step 0 - it samples the step-0 state and reports at step 1 - so a step-0 failing-step heuristic
 * was MEASURED as a no-op
 * (`chipAgent/_inbox/gotcha-step-0-base-case-threshold-is-a-no-op-for-clocked-assertions.md`).
 *
 * ACCEPTED RESIDUAL, named rather than left to be discovered. The gate is a statement guard, so
 * it reaches only the CLOCKED shape; design.md Component 3 renders the combinational shape as the
 * module-level `assert property (<consequent>);` with no gate, and there is no `if` at module
 * scope to put one in. A combinational property over a SYNC-reset free-initial-state design
 * therefore still evaluates the free step-0 sample, which is the FALSE-REFUTATION direction.
 * Closing it needs a SECOND gate form - the implication `!$initstate || <consequent>` inside the
 * assert - which is a spec decision about Req 14.3's emitted shape rather than a renderer one, so
 * it is recorded here rather than taken.
 *
 * Exposure is bounded, and the BOUND was restated when criterion 14.18 was narrowed. The residual
 * needs a design that holds CLOCKED STATE, because it needs a derived SYNC reset and a free initial
 * state; a design with NO clocked state is now ADMITTED with a contract requiring no reset
 * (Req 14.40) rather than refused, and it cannot enter this residual, because it has no reset for a
 * gate to be decided from and its step 0 is the only step at a Proof_Depth of 1 and is an honest
 * sample rather than a free-variable artifact. So the class the amendment added is outside the
 * residual, and the residual is unchanged by it.
 *
 * Pure and total: it reads the property and the contract and nothing else.
 */
export function emitsAssertionGate(property: FormalProperty, reset: ResetContract): boolean {
  return (
    property.kind === 'clocked' &&
    planEmission(property).renderable &&
    reset.derived &&
    reset.resetKind === 'sync' &&
    reset.initialStateFree
  );
}

/**
 * The gate terms this property's assertion and its cover both carry, or `null` for no gate.
 *
 * TWO INDEPENDENTLY DECIDED TERMS, and they are `&&`-joined rather than nested so the cover can
 * carry the identical text. The `!$initstate` term's whole rule is `emitsAssertionGate` above,
 * which is where its measurements and its residual are recorded.
 *
 * THE ASSUME AND THE GATE ARE NOT SUBSTITUTES (Req 14.6), and they are emitted as two
 * independently decided emissions for that reason. From the five-variant table at depths 5, 20,
 * and 40 on a constructed `sync_counter` and on the real `radix2_div`: the assume alone still
 * fails at step 1, the gate alone still fails at step 2, and only the PAIR passes. Failing one
 * step apart is the cleanest evidence available that neither stands in for the other.
 *
 * AN ENABLE-GATED RESET MEETS BOTH OF THE `!$initstate` TERM'S CONDITIONS, so the term still goes
 * out and `ResetContract.resetEnable` is read by `resetAssumeLine` alone (criterion 4.16;
 * `design.md`, Component 20 of `formal-gate-first-light`). The two answer different questions: the
 * enable decides whether the assumed step FIRES, while the term answers to the reset's KIND and to
 * the initial state, and a synchronous reset still takes effect at step 1 however it is enabled -
 * so a free step-0 sample is still the model artifact the term suppresses. Stated here rather than
 * left to be inferred from the narrower shape the two conditions were written against.
 */
function gateCondition(
  property: FormalProperty,
  reset: ResetContract,
  warmUp: WarmUpGate | null,
): string | null {
  const terms: string[] = [];
  if (emitsAssertionGate(property, reset)) {
    terms.push('!$initstate');
  }
  if (warmUp !== null) {
    terms.push(`${WARM_UP_COUNTER_NAME} >= ${String(warmUp.depth)}`);
  }
  return terms.length === 0 ? null : terms.join(' && ');
}

/** Wrap one statement in the gate terms, or emit it bare when there are none. */
function gated(gate: string | null, statement: string): string {
  return gate === null ? statement : `if (${gate}) ${statement}`;
}

/**
 * The statements for a clocked property: the guarded immediate assertion, and its cover.
 *
 * THE COVER IS THE VACUITY DETECTOR, AND ITS EXPRESSION IS THE ANTECEDENT ITSELF
 *   `antecedent` is read into ONE binding and spliced into both lines, so the proposition the
 *   Cover_Check evaluates is the same text the assertion is guarded by, token for token
 *   (Req 5.9). This is a correctness condition rather than a style preference: a cover on a
 *   paraphrase reports on a different proposition than the one the assert is gated on, and then
 *   a vacuous proof passes the detector that exists to catch it. The measured case is
 *   `multi_booth_8bit`, whose `rdy` is first reachable at step 19: a CORRECT product property
 *   reported `PASSED` at every depth at or below 19 without ever being evaluated, and only the
 *   cover on its own antecedent flagged it.
 *
 * NO COVER FOR A PROPERTY WITH NO ANTECEDENT (Req 5.10)
 *   An unconditional property cannot be vacuous through an unreached antecedent, because it has
 *   none. A cover on a constant would be a second thing that can go wrong - an unreached cover
 *   on a property that was in fact evaluated - so nothing is emitted and the adapter records
 *   the Cover_Check condition as satisfied without running one.
 *
 * NO IMPLICATION OPERATOR
 *   The guard is a Verilog `if`, and any implication inside either expression is written
 *   `!a || b`. There is no other form because there is no other form Yosys 0.66 accepts:
 *   `|->` and `|=>` are hard syntax errors, and the validator refuses both by name.
 *
 * THE COVER CARRIES THE SAME GATE TERMS AS THE ASSERTION, and `gate` is one binding spliced into
 * both lines for the same reason `antecedent` is. Without it the gate that exists because the
 * step-0 sample is a free-variable artifact would leave the COVER reading that artifact, which is
 * exactly the `Reached cover statement in step 1` defect the reset assume was added to close -
 * and the assume alone does not close it for a sync reset, because `async2sync` cannot pin step 0
 * there.
 *
 * THOSE GATE TERMS REST ON FAIL-SAFE REASONING AND NOT ON A MEASUREMENT, and the direction is
 * named rather than implied: an OVER-gated cover can only UNDER-report reachability, and an
 * under-reported reach yields `antecedent-unreached` yields `could-not-verify`, which is the safe
 * direction; an UNDER-gated one can report a reach that does not exist and so clear a vacuous
 * property. The assume-versus-cover interaction was measured on the ASYNC pair ONLY, where the
 * unclocked assume kept the honest minimum reachability steps at 13 and 6, and NO sync-reset cover
 * measurement was taken. This gating is the conservative choice in the absence of one.
 */
function clockedPropertyStatements(
  property: Extract<FormalProperty, { kind: 'clocked' }>,
  gate: string | null,
): readonly string[] {
  const edge = `always @(posedge ${property.clock})`;
  const antecedent = coveredAntecedent(property);
  if (antecedent === null) {
    return [`  ${edge} ${gated(gate, `assert(${property.consequent});`)}`];
  }
  return [
    `  ${edge} ${gated(gate, `if (${antecedent}) assert(${property.consequent});`)}`,
    `  ${edge} ${gated(gate, `cover(${antecedent});`)}`,
  ];
}

/**
 * The Warm_Up_Gate's counter declaration and its increment, or nothing where there is no gate.
 *
 * A SATURATING counter, not a wrapping one: `< depth` stops it at `depth`, so the gate term
 * `>= depth` holds forever once it is reached. A wrapping counter would periodically re-disable
 * the assertion, which is a silent vacuity hole rather than a cosmetic difference.
 *
 * The counter is PINNED to 0 by its declaration initializer, and that is load-bearing. A free
 * counter could start at or above `depth`, which is the gate doing nothing at all - the same
 * false-refutation shape the gate exists to close. `read_verilog -sv` turns the initializer into
 * the register's `init` attribute, which is what `prep` reads.
 *
 * The increment counts CLOCK EDGES, so the value SAMPLED inside the property's own `always` block
 * is the number of edges that have already happened: at the first edge it samples 0, so `>= N`
 * first holds at the edge after N edges have passed, which is exactly when `$past(x, N)` has a
 * value something drove (Req 6.20).
 */
function warmUpCounterLines(
  property: FormalProperty,
  warmUp: WarmUpGate | null,
): { readonly declaration: readonly string[]; readonly increment: readonly string[] } {
  if (warmUp === null || property.kind !== 'clocked') {
    return { declaration: [], increment: [] };
  }
  const name = WARM_UP_COUNTER_NAME;
  const depth = String(warmUp.depth);
  return {
    declaration: [`  reg${rangeSuffix(warmUp.width)} ${name} = 0;`],
    increment: [
      `  always @(posedge ${property.clock}) if (${name} < ${depth}) ${name} <= ${name} + 1;`,
    ],
  };
}

/**
 * The wrapper's FIRST line, and the guard that closes the UNDOTTED route to a false proof
 * (Req 6.18, 6.25).
 *
 * MEASURED: a wrapper asserting `cnt < 4'd2`, where `cnt` is the DESIGN's internal counter
 * register and not a wrapper signal, over a counter that reaches 9, printed only
 * `Warning: Identifier '\cnt' is implicitly declared`, exited 0, emitted 3 assertions, and then
 * reported `Status: PASSED` at step 19 and `Temporal induction successful` through the shipped
 * Lowering_Sequence under z3 - while the honest twin over the wrapper's own `out` reported
 * `FAILED`. Yosys declares an undeclared identifier implicitly as a fresh 1-bit net and WARNS
 * rather than erroring, so the proof is about a net nothing drives: base case, induction, and the
 * zero-assertion guard all pass, and a false property reaches the student labelled `Verified`
 * (`chipAgent/_inbox/gotcha-a-bare-internal-net-name-in-a-property-wrapper-is-a-silent-false-proof-and-default-nettype-none-closes-it.md`).
 * Under this directive the IDENTICAL wrapper fails in the frontend instead:
 * `ERROR: Identifier '\cnt' is implicitly declared and 'default_nettype is set to none.`, exit 1.
 *
 * THERE IS DELIBERATELY NO TRAILING `` `default_nettype wire ``, AND THAT IS NOT AN OVERSIGHT.
 * Anyone who has written the conventional open/restore pair will read the omission as a missing
 * line, so: Yosys applies the LAST directive in a file, so a trailing reset silently restores the
 * warning-only behaviour this directive exists to remove - measured, and recorded upstream as
 * YosysHQ/yosys issue 3125. Appending the restore does not scope the directive; it cancels it.
 *
 * MEASURED, the directive does NOT leak into the design file in either read order, so a student
 * design that relies on implicit nets still elaborates - the strictness applies to the wrapper
 * WE wrote and not to the candidate. And the resulting failure is a frontend error in the WRAPPER
 * file, which the interpreter already attributes as `property-build-failed` (Req 6.26), so the
 * sample falls back to simulation and the candidate design is never blamed for our instrument.
 *
 * The wrapper's existing `input clk` declarations need no net type added: measured, a port
 * declared with no net type is accepted under the directive.
 *
 * This closes ONE of the two routes to the same false proof. The DOTTED route - `dut.cnt` - is
 * held shut by the Property_Validator keeping `.` outside `ACCEPTED_OPERATORS`, which stays
 * exactly as it is: the two guards are independent, and neither subsumes the other.
 */
const DEFAULT_NETTYPE_DIRECTIVE = '`default_nettype none';

/**
 * The property statements for either kind.
 *
 * A clocked property is an IMMEDIATE assertion inside a clocked `always` block (Req 6.1); a
 * combinational one is a module-level `assert property (...)` carrying NO clocking event
 * (Req 6.2), because `assert property (@(posedge clk) e)` is `syntax error, unexpected '@'`.
 * Those are the two forms the feasibility probe measured Yosys 0.66 accepting, and the union
 * has exactly two members, so a third property shape would be a compile error here rather than
 * a runtime fallback that renders something unmeasured.
 */
function propertyStatements(
  property: FormalProperty,
  emission: PropertyEmission,
  gate: string | null,
): readonly string[] {
  if (!emission.renderable) {
    return [];
  }
  switch (property.kind) {
    case 'clocked':
      return clockedPropertyStatements(property, gate);
    case 'combinational':
      return [`  assert property (${property.consequent});`];
    default: {
      // Exhaustiveness: a new FormalProperty kind must be given a rendering explicitly.
      const unreachable: never = property;
      return unreachable;
    }
  }
}

/**
 * Render the Property_Wrapper carrying one property over one design. Pure, total, never throws.
 *
 * The emitted shape, which is the whole fixed skeleton:
 *
 * ```verilog
 * `default_nettype none
 * module <wrapperName> (
 *   <one `input` declaration per design INPUT, including the clock and the reset>
 * );
 *   <one `wire` declaration per design OUTPUT and per other observed signal>
 *   <the Warm_Up_Gate's counter, only where the property uses $past(x, N)>
 *   <designModule> dut (
 *     <one by-name connection per design port>
 *   );
 *   assume property (!$initstate || <reset-asserted>);
 *   <the Warm_Up_Gate's increment, only where the counter was declared>
 *   <the property's statements, each carrying the same gate terms>
 * endmodule
 * ```
 *
 * The FIVE emissions beyond task 3.2's skeleton each close a MEASURED defect that produced a
 * well-formed WRONG verdict, so none of them is a refinement: `wrapperSignals`'s port/wire split
 * (the ABC output-OR false refutation), `resetAssumeLine` (the 4-in-6 base-case failure rate on
 * correct designs), `gateCondition`'s `!$initstate` term (the sync-reset step-0 artifact, narrowed
 * by the `bad_init` false proof), `warmUpCounterLines` (the twelve-for-twelve `$past`
 * refutation), and `DEFAULT_NETTYPE_DIRECTIVE` (the bare-internal-name false proof). Each has its
 * own reasoning at its own declaration.
 *
 * Only a `ModuleInterface`, a `ResetContract`, and `ValidatedExpression`s reach the expressions, so
 * a raw model string cannot be rendered - not by convention but because the type does not permit
 * it - and every property shape has a rendering, so an unsupported one is a compile error rather
 * than a runtime branch (design.md's error table).
 *
 * `reset` is the pre-pass's contract, and its non-derived member carries TWO readings that this
 * renderer treats identically and correctly (Req 14.41):
 *   - WHERE THE DESIGN HOLDS NO CLOCKED STATE it means NO RESET IS REQUIRED, and it DOES reach a real
 *     run - the pre-pass admits it (Req 14.40), 15 of 50 corpus references are in that class, and the
 *     combinational wrapper built from it is correct. Both omissions are correct rather than
 *     incidental: a reset assume over a design with no state would pin nothing, and an
 *     `if (!$initstate)` gate would suppress the ONLY sample at a Proof_Depth of 1 and yield a
 *     VACUOUS PASS.
 *   - OTHERWISE it means THE DERIVATION REFUSED, and that never reaches a real run: the adapter
 *     reports `reset-contract-unresolved` and builds no wrapper, because a wrapper with no reset
 *     assume over a design that HAS state has a measured 4-in-6 base-case failure rate on CORRECT
 *     designs and its vacuity answers are taken against states the design cannot enter.
 * The member was accepted here so the refusal is REPRESENTABLE at this seam rather than thrown, and
 * it renders the wrapper without either reset emission - which is what made the amendment that
 * admitted the first reading a change to the derivation alone.
 *
 * `wrapperName` is caller-owned: the adapter names the wrapper, and no model output reaches
 * this parameter. It is emitted verbatim, because the worker re-validates the same value as a
 * plain Verilog identifier before it becomes the `-top` of a command line
 * (`TOP_MODULE_RE` in the worker's `contract.py`), and anything that gets past both is a
 * wrapper that does not build - `property-build-failed`, which is a verdict about our own
 * instrument and never about the design.
 */
export function renderPropertyWrapper(
  designInterface: ModuleInterface,
  property: FormalProperty,
  wrapperName: string,
  reset: ResetContract,
): string {
  const signals = wrapperSignals(designInterface);
  const emission = planEmission(property);
  const warmUp = emission.renderable ? emission.warmUp : null;
  const counter = warmUpCounterLines(property, warmUp);
  return (
    [
      // FIRST, ahead of the module header, and with no counterpart at the end - see the constant.
      DEFAULT_NETTYPE_DIRECTIVE,
      `module ${wrapperName} (`,
      signals.ports.map(declareInputPort).join(',\n'),
      ');',
      ...signals.wires.map(declareInternalWire),
      ...counter.declaration,
      `  ${designInterface.moduleName} ${DUT_INSTANCE_NAME} (`,
      signals.connected.map(connectPort).join(',\n'),
      '  );',
      ...resetAssumeLine(reset),
      ...counter.increment,
      ...propertyStatements(property, emission, gateCondition(property, reset, warmUp)),
      'endmodule',
    ]
      // A design with no inputs renders an empty declaration list, and one with no ports at all an
      // empty connection list too; both drop out rather than leaving a blank line inside the
      // parentheses.
      .filter((line) => line.length > 0)
      .join('\n')
  );
}
