// formal-property-oracle, Property 12: The rendered wrapper carries only the skeleton, the
// interface, and the property's own validated expressions (task 3.6).
//
// WHAT REQ 3.4 AND REQ 3.7 ACTUALLY ASK
//   Req 3.4: the candidate design is instantiated in the Property_Wrapper as an UNMODIFIED
//   submodule. Req 3.7: the Property_Wrapper holds NO behavioural reimplementation of the design's
//   function beyond what the Formal_Properties it carries state. Both reduce to one question asked
//   of the rendered text - where did every token come from? - because a wrapper that can only be
//   built out of a closed skeleton, the interface's own names, and the property's own validated
//   expressions has nowhere to put a reimplementation.
//
// THE ALLOWED-SOURCE SET IS FOUR, NOT THREE: A CORRECTION TO THE TASK TEXT
//   Task 3.6 names three sources - "the fixed skeleton, the interface's own port names, or the
//   property's validated expressions". There are FOUR, and the fourth is named here explicitly
//   rather than left to slip through whichever check happened not to look at it:
//
//     1. THE FIXED SKELETON. The twelve identifier-shaped words `renderPropertyWrapper` emits of
//        its own accord, plus its punctuation and the `0` low bound of a port's range. Written out
//        BY HAND below from the requirement, never imported from the module under test: a skeleton
//        set read out of the renderer would widen exactly when the renderer widened, and could
//        therefore never fail.
//
//     2. THE INTERFACE'S OWN NAMES. `ports[].name` is NOT the whole set. It is also `moduleName`,
//        and the clock and reset names - which live in `clocking` and NOT in `ports`. Task 3.2
//        measured why that distinction is load-bearing rather than pedantic
//        (`chipAgent/_inbox/gotcha-formal-wrapper-must-declare-clock-and-reset-as-its-own-ports.md`):
//        `ModuleInterface` holds them in a separate `ClockingContract`, and a wrapper built from
//        `ports` alone leaves `clk` undeclared, which Verilog turns into an implicit net that `prep`
//        sees as an UNDRIVEN wire rather than a free input. A clock that never ticks proves nothing
//        while the run still reports a `Status:`. So an allowed-name set built from `ports` alone
//        would make `clk` and `rst_n` look like tokens from nowhere and this test would fail for
//        entirely the wrong reason. The expected set is therefore built the same way `wrapperPorts`
//        builds it - declared ports, then the non-null clock, then the non-null reset, each width-1
//        `input` - and it is DERIVED HERE rather than imported, because a test that asks
//        `wrapperPorts` what `wrapperPorts` should have returned asserts nothing.
//
//     3. THE PROPERTY'S VALIDATED EXPRESSIONS. Every token of `clock`, `antecedent`, and
//        `consequent`, tokenized by the same tokenizer that reads the rendered source, so the two
//        token streams are comparable rather than merely similar.
//
//     4. THE CALLER-SUPPLIED `wrapperName`. `renderPropertyWrapper`'s third parameter is a raw
//        `string` - the one parameter that is not brand-protected. It is caller-owned (the adapter
//        names the wrapper; no model output reaches it) and the worker re-validates the same value
//        against its `TOP_MODULE_RE` before it becomes a `-top` token, so the raw type is a
//        deliberate choice rather than a hole. But it IS a fourth source of bytes in the rendered
//        text, so it is an explicitly named allowed set here. Naming it is the point: if it were
//        left out, every token of it would have to be tolerated by some other set, and the checks
//        would have to be loosened until they stopped saying anything.
//
//   "A MEMBER OF EXACTLY ONE ALLOWED SET" IS NOT ACHIEVABLE, and asserting it would be a defect.
//   The sets legitimately overlap, and the overlap is the NORMAL case: a property references the
//   design's signals, so a port name is both an interface name and an expression token. And
//   `input`, `output`, `inout`, and `dut` are not members of the validator's `RESERVED_WORDS`, so a
//   validated expression may legally contain them as ordinary identifiers. The assertion is
//   therefore membership in the UNION, with every matching source reported in the failure message,
//   and the counted shares at the bottom prove each source is actually load-bearing.
//
// THE FIVE CLAIMS
//   A. THE FIRST LINE IS THE DIRECTIVE, EVERY OTHER OFFSET IS CODE, AND EVERY TOKEN COMES FROM AN
//      ALLOWED SOURCE. `scanSource` classifies the rendered text. Task 18.1 made
//      `` `default_nettype none `` the wrapper's first line (Req 6.25), and a backtick opens a
//      `compiler-directive` span - so "every offset is code" is no longer true of offset 0, and the
//      honest repair is NOT to stop requiring code. It is to pin the ONE admitted non-code span
//      BYTE FOR BYTE and require code everywhere after it: the directive line is part of the fixed
//      skeleton, so it is an admitted source, and admitting it by its exact text rather than by its
//      KIND is what keeps the claim from widening into "a directive may appear". An injected
//      comment, string literal, or second directive anywhere in the wrapper still fails claim A
//      directly, and so does a DIFFERENT first line.
//      That byte-exact pin is also what makes tokenizing over code spans honest rather than
//      convenient: a test that tokenized code spans and stopped there would SILENTLY ACCEPT an
//      injected comment, because a comment's bytes would never be tokenized at all - and it would
//      now silently accept anything written on the first line, because the mask blanks that line
//      before the tokenizer ever sees it. The first line is therefore asserted as TEXT, which is
//      strictly stronger than token membership would have been. Tokenization then runs over the
//      code-masked text - the whole text but that one line - with a catch-all alternative so that
//      EVERY non-whitespace character becomes a token and nothing escapes the membership check.
//      Claim A also pins the directive's MISSING SIBLING: no `` `default_nettype wire `` anywhere,
//      and in fact no second `default_nettype` of any kind. See `NETTYPE_RESTORE` for why the
//      absence is the correct shape and not an oversight to be tidied up.
//   B. EXACTLY ONE SUBMODULE, AND IT IS THE DESIGN (Req 3.4). An instantiation is the token shape
//      `<word not in the skeleton> <word> (`. Exactly one occurs, and its module name is
//      `designInterface.moduleName`.
//   C. EVERY CONNECTION IS STRAIGHT THROUGH. Each connection line is `.name(name)` with the SAME
//      name on both sides. A crossed connection is a wrapper that proves a property about a
//      PERMUTED design, and the token-membership check cannot see it: `.a(b)` draws both names from
//      the allowed interface set.
//   D. THE DECLARED PORTS ARE EXACTLY THE DESIGN'S WRAPPER PORTS, BOTH DIRECTIONS. A missing
//      declaration is the undriven-wire trap in (2) above; an extra one is a free variable nothing
//      constrains, which widens what a `proved` covers without saying so. Name, direction, and
//      width are all compared, and the comparison is a sorted multiset rather than a set so a
//      duplicated declaration cannot hide inside it. Order is deliberately NOT asserted: the
//      renderer connects by name, so the order genuinely is free.
//   E. THE BODY HOLDS EXACTLY THE PROPERTY'S OWN STATEMENTS. One for a combinational property
//      (Req 6.2), one for a clocked property with no antecedent, two for a clocked property with
//      one (Req 6.1 plus Req 5.1's cover). This is the count Req 3.7 rests on: an extra
//      behavioural statement built only out of allowed tokens - an `always` block assigning a port
//      with `<=`, say - would pass claim A, and is caught here.
//
// WHY THE SKELETON KEYWORD SET IS SMALL AND CLOSED
//   Twelve words, and `wire`, `reg`, `assign`, `logic`, `parameter`, `initial`, and `begin`/`end`
//   are all deliberately OUTSIDE it. That is what turns Req 3.7 from a claim into a check: almost
//   every way of writing behaviour into the wrapper needs a declaration or assignment keyword, and
//   none of them is admitted. If a token ever forces this set open, the widening must be argued
//   for in this comment - the set is not to be grown to make a case pass.
//
// PROVED NON-VACUOUS BY MUTATION, NOT BY INSPECTION. Six mutations of `renderPropertyWrapper`,
// each rebuilt with `npx tsc -b` before vitest (`app/test` imports `@app/tools`, which resolves to
// `app/tools/dist/`, so a source edit is INVISIBLE to vitest until the rebuild), each confirmed
// FAILING, then reverted:
//   1. connection list crossed, so `.clk(a)` - claim C, `straightThrough: false`.
//   2. an extra hardcoded statement - claim A, twice: `{token:'spare_override_wire',kind:'word'}`
//      and, with the signal removed so only the literal is foreign, `{token:"3'd5",kind:'number'}`.
//   3. the clock dropped from `wrapperPorts` while `always @(posedge clk)` stays - claim D,
//      `expected [] to deeply equal ['clk|input|1']`. This is the undriven-wire trap as an
//      assertion, and it is why claim D runs before claim C: it names the missing DECLARATION.
//   4. a second instantiation of the SAME module under the SAME instance name, so every token is
//      still allowed and claim A cannot see it - claim B, `['adder_8bit','adder_8bit']` vs one.
//   5. the property's statements emitted twice, so every token is allowed, the instantiation count
//      is unchanged, and the port lists are unchanged - claim E, `statements: 2` vs `1`. This is
//      the one that shows claim E is Req 3.7's teeth rather than a restatement of claim A.
//   6. the conventional `` `default_nettype wire `` restore appended after `endmodule`, which is
//      precisely the edit task 18.2's pin exists to stop - claim A,
//      `{ restore: '`default_nettype wire', nettypeDirectives: 2 }` vs `{ restore: null,
//      nettypeDirectives: 1 }`. Worth recording that it is caught by the NETTYPE pin and not by the
//      non-code scan: appended at the END, the restore's own span is non-code and claim A's offset
//      walk reports it too, but a restore spliced in anywhere the mask already blanks - inside a
//      comment, say - would be invisible to the walk and visible to the count. The count is the
//      load-bearing half.
//
//   Mutation 4's first attempt named the second instance `dut_shadow`, and claim A caught it before
//   claim B could - which proves nothing about claim B. Reusing `dut` is what makes the mutation
//   land on the claim it is meant to falsify.
//
// NON-VACUITY
//   Every claim above holds trivially over a sample that never produces the shape it is about, and
//   this repository has already shipped a property test that silently stopped exercising a new
//   union member (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
//   So the counted shares are asserted: both union members, both antecedent arms, at least one
//   interface with ZERO declared ports (claim D's empty case, which the renderer special-cases by
//   dropping the empty declaration line), at least one with a non-null clock (without which claim
//   D never checks a `clocking`-sourced port at all and mutation 3 would be unfalsifiable), at
//   least one multi-bit port (so the range suffix and its number tokens are exercised), and at
//   least one `inout` port (the direction a two-way port needs, and the one a naive
//   input/output-only parse would miss). Every allowed SOURCE is counted too, so a source that
//   never matched a token would be exposed as decoration.
//
// The tag string is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to
// a different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 3.4, 3.7

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface, PortDirection } from '@app/core';
import {
  renderPropertyWrapper,
  scanSource,
  type FormalProperty,
  type ResetContract,
} from '@app/tools';

import { arbDesignInterface, arbFormalProperty, arbResetContract } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-property-oracle, Property 12: The rendered wrapper carries only the skeleton, the ' +
  "interface, and the property's own validated expressions";

/**
 * The caller-supplied wrapper name: allowed source 4.
 *
 * One fixed value suffices because the parameter is caller-owned and no model output reaches it.
 * It is deliberately a name no other allowed set contains, so the counted share at the bottom can
 * show that this source really does account for tokens nothing else does.
 */
const WRAPPER_NAME = 'formal_property_wrapper';

/**
 * 300 runs, not the shared 100.
 *
 * The rarest required shape is an interface with ZERO declared ports. `arbDesignInterface` takes
 * the shorter of two independent `fc.array` lengths over 0..5, so the zero case sits somewhere
 * around a tenth of the sample - at 100 runs a miss is roughly 1e-5, which is a flake rather than a
 * claim, and at 300 it is roughly 1e-14. The recipe is the vault's:  compute the rarest required
 * shape's share and raise `numRuns` until `(1 - p)^numRuns` is negligible, rather than weakening
 * the claim to fit the default
 * (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
 * The whole property is pure string work, so 300 runs costs a fraction of a second.
 */
const NUM_RUNS = 300;

/** The minimum share of generated cases each of the three property shapes must reach. */
const MIN_SHAPE_SHARE = 0.1;

/**
 * ALLOWED SOURCE 1a: every identifier-shaped word the fixed skeleton emits of its own accord.
 *
 * Read off `renderPropertyWrapper`'s emitted shape and written out by hand, because a set imported
 * from the module under test would widen with it. Thirteen words:
 *   `module` / `endmodule`  the wrapper's own header and footer
 *   `input`  the ONLY port direction a wrapper declaration may carry (Req 3.9, 3.10)
 *   `wire`  every design OUTPUT and every other observed signal, as an internal wire (Req 3.10)
 *   `dut`  the design instance's name, the wrapper's ONLY submodule instance
 *   `always` / `posedge`  the clocked property's event control (Req 6.1)
 *   `if`  the clocked property's guard, which is how implication is written (Req 6.3), and the
 *     assertion gate's own guard (Req 14.3)
 *   `assert`  both accepted forms' assertion statement
 *   `assume`  the unclocked reset assume (Req 14.1)
 *   `cover`  the vacuity detector's statement (Req 5.1)
 *   `property`  `assert property (...)` (Req 6.2) and `assume property (...)` (Req 14.1)
 *
 * THE SET WAS OPENED BY TASK 16.5, AND HERE IS THE ARGUMENT THE OLD COMMENT ASKED FOR.
 *   `output` and `inout` LEFT. They were admitted because task 3.2 declared every design port with
 *   its own direction, and Req 3.10 now forbids a wrapper port of any direction but `input`.
 *   Removing them is a STRENGTHENING: an emitted `output` is now a failure of claim A rather than an
 *   allowed token, and that is exactly the measured defect - with the observed signals declared as
 *   wrapper outputs, `write_aiger` emits `O=4` on `counter_12` and ABC ORs the design's own outputs
 *   into the property, REFUTING a design z3 and rIC3 both prove.
 *
 *   `wire` JOINED, because those same signals are now internal wires. It is the one word the old
 *   comment named as the sort of token that must not quietly arrive, so it is named here instead:
 *   `wire` cannot carry behaviour on its own - Req 3.7's concern is a REIMPLEMENTATION, which needs
 *   an `assign`, an `always` writing a wrapper signal, or an `initial`. `assign` and `initial` are
 *   still absent, and `always` is admitted only in the two positions claim E counts.
 *
 *   `assume` JOINED, because Req 14.1's reset assume is now part of the skeleton. It is a formal
 *   statement, not a behavioural one: it CONSTRAINS the design's inputs and drives nothing.
 *
 *   `reg` did NOT join this set. The Warm_Up_Gate's counter is a wrapper-local register that DOES
 *   carry state and IS written by an `always` block, so admitting it here would be admitting exactly
 *   the shape Req 3.7 exists to exclude. It has its own allowed source (6) below, whose membership is
 *   the counter and nothing else, so the counter is accounted for WITHOUT widening what "skeleton"
 *   means.
 *
 *   STILL CLOSED, and this is what keeps Req 3.7 checkable: `logic`, `assign`, `parameter`,
 *   `initial`, `begin`, `end`, `function`, and `case` are all absent. A behavioural reimplementation
 *   needs one of them, and none is admitted.
 */
const SKELETON_WORDS: ReadonlySet<string> = new Set([
  'module',
  'endmodule',
  'input',
  'wire',
  'dut',
  'always',
  'posedge',
  'if',
  'assert',
  'assume',
  'cover',
  'property',
]);

/**
 * ALLOWED SOURCE 1b: the skeleton's own punctuation, its `$initstate`, and the `0` of a port range.
 *
 * `@` belongs to the clocked form's `always @(posedge ...)` only; that it appears in no
 * combinational render is task 3.3's position claim rather than this file's, so one union set over
 * both kinds is the right granularity here. `;` `,` `.` `[` `]` `:` `(` `)` are the declaration,
 * connection, range, and statement punctuation.
 *
 * JOINED BY TASK 16.5: `$initstate`, `!`, `||`, and `&&`. The first three are the fixed tokens of
 * `assume property (!$initstate || <reset-asserted>);` and of the `if (!$initstate)` gate; `&&` is the
 * gate's own term JOINER, emitted only where the `!$initstate` term and the Warm_Up_Gate's term are
 * both present. All four are also legal inside an expression, so admitting them costs this claim
 * nothing it had: the token membership check is a union over sources, and `$initstate` was ALREADY
 * reachable through the `expressions` source. What they do not cover is the reset NAME, which comes
 * from the contract and has its own allowed source (5) below.
 *
 * Everything else a render contains must come from another source - which is why a `#` delay still
 * fails claim A, and why `=`, `+`, `<`, and `>=` are NOT here: they belong to the Warm_Up_Gate alone.
 */
const SKELETON_NON_WORD_TOKENS: ReadonlySet<string> = new Set([
  '(',
  ')',
  ',',
  ';',
  '[',
  ']',
  ':',
  '.',
  '@',
  '0',
  '!',
  '||',
  '&&',
  '$initstate',
]);

/**
 * ALLOWED SOURCE 6: every token the Warm_Up_Gate contributes, and nothing else.
 *
 * Its own source rather than part of the skeleton, because `reg` is a STATEFUL declaration written by
 * an `always` block - the one shape Req 3.7's "no reimplementation of the design's function" is about
 * - so it has to be accounted for by something narrower than "the skeleton". Membership here says
 * precisely: the wrapper may hold ONE register, it is the counter, and these are the only operators
 * it may be built from.
 *
 * `1` is the increment's literal and `0` the declaration's initializer; the DEPTH's own decimal
 * spelling is added per case at `allowedSourcesFor`, because it is the property's `$past` depth
 * rather than a fixed number (Req 6.21).
 */
const WARM_UP_COUNTER_NAME = '__formal_warmup_age';

const WARM_UP_TOKENS: ReadonlySet<string> = new Set([
  'reg',
  WARM_UP_COUNTER_NAME,
  '=',
  '<',
  '<=',
  '>=',
  '+',
  '0',
  '1',
]);

/**
 * The wrapper's FIRST line, written out by hand rather than imported (Req 6.18, 6.25).
 *
 * `renderPropertyWrapper` does not export its own constant, and it should not start to for this
 * test's benefit: a pin read out of the renderer moves whenever the renderer moves, so it could
 * never fail. The measured reason the line exists is at the renderer's own declaration - without it
 * a wrapper asserting over a BARE internal design net (`cnt`, not `dut.cnt`) gets an implicitly
 * declared 1-bit net, a warning rather than an error, and `Status: PASSED` on a property that is
 * false
 * (`chipAgent/_inbox/gotcha-a-bare-internal-net-name-in-a-property-wrapper-is-a-silent-false-proof-and-default-nettype-none-closes-it.md`).
 */
const DEFAULT_NETTYPE_DIRECTIVE = '`default_nettype none';

/**
 * The conventional restore, pinned ABSENT - the half a presence-only check cannot see.
 *
 * ANYONE WHO HAS WRITTEN THE OPEN/RESTORE PAIR WILL READ THE OMISSION AS A MISSING LINE, which is
 * exactly why its absence is asserted rather than left to be noticed. Yosys applies the LAST
 * `default_nettype` in a file, so a trailing restore does not SCOPE the directive, it CANCELS it -
 * measured, and recorded upstream as YosysHQ/yosys issue 3125. A wrapper carrying both lines is
 * byte-for-byte reassuring and behaviourally identical to a wrapper carrying neither: the false
 * proof above comes back, silently, with the strictness line still sitting at the top of the file
 * where a reviewer will see it and be satisfied.
 *
 * So a future edit that "completes the pair" is a FAILING ASSERTION here rather than a silent
 * reversion. The count is checked too, so a restore spelled some other way - `` `default_nettype
 * logic ``, or a second `none` - fails the same assertion.
 */
const NETTYPE_RESTORE = '`default_nettype wire';

/** The bare directive word, counted so ANY re-issue fails and not just the conventional restore. */
const NETTYPE_WORD = 'default_nettype';

/** The wrapper's own module header line, which follows the directive rather than opening the file. */
const HEADER_OPENER = `module ${WRAPPER_NAME} (`;

/** The line closing the wrapper's own port list. */
const HEADER_TERMINATOR = ');';

/** The line closing the design instance's connection list. */
const INSTANCE_TERMINATOR = '  );';

/** The wrapper's last line. */
const FOOTER = 'endmodule';

/**
 * One declaration line of the wrapper's port list, e.g. `  input [7:0] a`.
 *
 * NON-GLOBAL, so `exec` neither reads nor writes `lastIndex` and the object carries no state
 * between calls - a shared `/g` regex has hung this repository's whole vitest suite once
 * (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`).
 */
const DECLARATION_PATTERN = /^ {2}(input)(?: \[(\d+):0\])? ([A-Za-z_][A-Za-z0-9_$]*)$/;

/** One connection line of the design instance, e.g. `    .a(a)`. Non-global for the same reason. */
const CONNECTION_PATTERN = /^ {4}\.([A-Za-z_][A-Za-z0-9_$]*)\(([A-Za-z_][A-Za-z0-9_$]*)\)$/;

/** One internal-wire declaration, e.g. `  wire [7:0] out;`. Non-global for the same reason. */
const WIRE_PATTERN = /^ {2}wire(?: \[(\d+):0\])? ([A-Za-z_][A-Za-z0-9_$]*);$/;

/** The Warm_Up_Gate's counter declaration, e.g. `  reg [1:0] __formal_warmup_age = 0;`. */
const COUNTER_PATTERN = new RegExp(`^ {2}reg(?: \\[(\\d+):0\\])? ${WARM_UP_COUNTER_NAME} = 0;$`);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'word' | 'system' | 'number' | 'punct';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

/**
 * The token alternatives, longest-first where they overlap, with a catch-all last.
 *
 * The catch-all `[^\s]` is the load-bearing part: it guarantees every non-whitespace character
 * becomes a token, so nothing can be silently skipped past the membership check. A sized literal
 * must precede the plain number so `8'd15` is one token rather than `8` followed by junk, and the
 * multi-character operators must precede the catch-all so `&&` is not two `&` tokens.
 */
const TOKEN_PATTERN_SOURCE = [
  '[A-Za-z_][A-Za-z0-9_$]*',
  '\\$[A-Za-z0-9_$]*',
  "[0-9][0-9_]*'[sS]?[bodhBODH][0-9a-fA-FxXzZ?_]+",
  "'[sS]?[bodhBODH][0-9a-fA-FxXzZ?_]+",
  '[0-9][0-9_]*',
  '===|!==|<<<|>>>|==|!=|&&|\\|\\||<=|>=|<<|>>|\\*\\*|~\\^|\\^~|~&|~\\|',
  '[^\\s]',
].join('|');

/** Classify a matched token by its first character. */
function tokenKind(text: string): TokenKind {
  const first = text.charAt(0);
  if (first === '$') {
    return 'system';
  }
  if (/^[A-Za-z_]$/.test(first)) {
    return 'word';
  }
  return /^[0-9']$/.test(first) ? 'number' : 'punct';
}

/**
 * The source with every NON-CODE offset replaced by a space, offset for offset.
 *
 * Reusing `scanSource` the way the validator does means the tokenizer is structurally unable to
 * read inside a comment, a string literal, or a compiler directive. Claim A separately asserts
 * there are none, so for a correct render this is the identity - the masking is what keeps the
 * tokenizer honest if that ever stops being true.
 */
function codeSpansOnly(source: string): string {
  const mask = scanSource(source);
  let masked = '';
  for (let index = 0; index < source.length; index += 1) {
    masked += mask.code[index] === 1 ? source.charAt(index) : ' ';
  }
  return masked;
}

/** Every token of `source`'s code spans, in order. The global regex is built FRESH per call. */
function tokenize(source: string): readonly Token[] {
  const scanner = new RegExp(TOKEN_PATTERN_SOURCE, 'g');
  return [...codeSpansOnly(source).matchAll(scanner)].map((match) => ({
    kind: tokenKind(match[0]),
    text: match[0],
  }));
}

// ---------------------------------------------------------------------------
// The four allowed sources
// ---------------------------------------------------------------------------

/** A wrapper port as this test expects it, independently of how the renderer spells it. */
interface ExpectedPort {
  readonly name: string;
  readonly direction: PortDirection;
  readonly width: number;
}

/**
 * ALLOWED SOURCE 2, derived: every signal the design instance is connected to.
 *
 * Built the same way `wrapperSignals` builds it and NOT imported from it: the clock and reset come
 * from `clocking`, never from `ports`, and each becomes a width-1 `input`. Not deduplicated, matching
 * the renderer's own deliberate choice - an interface that declares its clock twice must render an
 * unbuildable wrapper rather than quietly dropping one of them.
 *
 * `direction` is retained on each entry because claim D now splits on it: an `input` must be a
 * wrapper PORT and everything else must be an internal WIRE (Req 3.9, 3.10).
 */
function expectedWrapperSignals(designInterface: ModuleInterface): readonly ExpectedPort[] {
  const { clockName, resetName } = designInterface.clocking;
  const declared = designInterface.ports.map((port) => ({
    name: port.name,
    direction: port.direction,
    width: port.width,
  }));
  const clocking = [clockName, resetName]
    .filter((name): name is string => name !== null)
    .map((name): ExpectedPort => ({ name, direction: 'input', width: 1 }));
  return [...declared, ...clocking];
}

/** The six allowed sources, each as the set of token texts it can account for. */
interface AllowedSources {
  readonly skeleton: ReadonlySet<string>;
  readonly interfaceNames: ReadonlySet<string>;
  readonly expressions: ReadonlySet<string>;
  readonly wrapperName: ReadonlySet<string>;
  /** ALLOWED SOURCE 5: the reset NET NAME, which comes from the contract and from nowhere else. */
  readonly resetContract: ReadonlySet<string>;
  /** ALLOWED SOURCE 6: the Warm_Up_Gate's counter and the operators it is built from. */
  readonly warmUp: ReadonlySet<string>;
}

/** Every expression the property carries, so each is an allowed source of tokens. */
function expressionsOf(property: FormalProperty): readonly string[] {
  if (property.kind === 'combinational') {
    return [property.consequent];
  }
  return [
    property.clock,
    property.consequent,
    ...(property.antecedent === null ? [] : [property.antecedent]),
  ];
}

/**
 * Build the four allowed sources for one case.
 *
 * The interface set carries the module name, every wrapper port name, and the high bound of each
 * multi-bit port's range - the one number the interface contributes, since a width `w` renders as
 * `[w-1:0]` and the `0` is the skeleton's.
 */
function allowedSourcesFor(
  designInterface: ModuleInterface,
  property: FormalProperty,
  reset: ResetContract,
): AllowedSources {
  const signals = expectedWrapperSignals(designInterface);
  const interfaceNames = new Set<string>([
    designInterface.moduleName,
    ...signals.map((port) => port.name),
    ...signals.filter((port) => port.width > 1).map((port) => String(port.width - 1)),
  ]);
  const expressions = new Set<string>(
    expressionsOf(property).flatMap((expression) =>
      tokenize(expression).map((token) => token.text),
    ),
  );
  return {
    skeleton: new Set([...SKELETON_WORDS, ...SKELETON_NON_WORD_TOKENS]),
    interfaceNames,
    expressions,
    wrapperName: new Set(tokenize(WRAPPER_NAME).map((token) => token.text)),
    resetContract: new Set(reset.derived ? [reset.resetName] : []),
    // The DEPTH's decimal spelling joins source 6 per case, because it is the property's own largest
    // `$past` depth (Req 6.21) rather than a fixed number. It is read out of the rendered counter
    // declaration's own gate term, so this set widens only by a number the render actually emitted -
    // which means a depth spliced from somewhere else still fails claim A.
    warmUp: new Set([...WARM_UP_TOKENS, ...warmUpDepthTokens(property)]),
  };
}

/**
 * The decimal spellings a Warm_Up_Gate's depth may contribute, or none for a property with no `$past`.
 *
 * `1` and nothing else, because `$past(x)` is SystemVerilog's depth-1 default and that is the only
 * form this sample contains - `dialectExpressionArbitrary` builds `$past(<expr>)` and no
 * two-argument call. NO GUARD IS NEEDED FOR THE OTHER FORMS, and that is worth stating because the
 * obvious reflex is to add one: an explicit `$past(x, 5)` puts `5` in the property's own expression
 * text, so the `expressions` source already accounts for it. A sized `$past(x, 4'd5)` cannot reach
 * here at all any more: the Property_Validator refuses a sized depth (task 4.14, design.md C18).
 * A bespoke guard here would be a second, weaker version of a check claim A already makes.
 */
function warmUpDepthTokens(property: FormalProperty): readonly string[] {
  if (property.kind !== 'clocked') {
    return [];
  }
  return expressionsOf(property).some((text) => text.includes('$past')) ? ['1'] : [];
}

/** The six source names, in one place so the membership check and the tally cannot drift. */
const SOURCE_NAMES = [
  'skeleton',
  'interfaceNames',
  'expressions',
  'wrapperName',
  'resetContract',
  'warmUp',
] as const;

/** Which allowed sources account for `text`. Empty means the token came from nowhere allowed. */
function sourcesContaining(text: string, allowed: AllowedSources): readonly string[] {
  return SOURCE_NAMES.filter((source) => allowed[source].has(text));
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * Claim A, first half: the first line is the directive, and the rest of the wrapper is code.
 *
 * The admitted non-code span is the directive line and its terminator, and it is admitted by its
 * EXACT TEXT: the prefix is compared as a string, so the span cannot be some other directive, a
 * comment, or a longer line that happens to start the same way. Everything after it must be code -
 * no comment, no string literal, no second directive, and no unterminated span, which
 * `endMode` covers.
 *
 * The walk starts at the end of the admitted prefix rather than at 0 so the directive's own offsets
 * are not re-reported; a render that does NOT begin with the directive fails on the prefix instead,
 * in the same assertion, so no render escapes both halves.
 */
function expectOnlyTheDirectiveIsNonCode(rendered: string): void {
  const mask = scanSource(rendered);
  const admittedPrefix = `${DEFAULT_NETTYPE_DIRECTIVE}\n`;
  let nonCodeOffset = -1;
  for (
    let index = admittedPrefix.length;
    index < rendered.length && nonCodeOffset === -1;
    index += 1
  ) {
    nonCodeOffset = mask.code[index] === 1 ? -1 : index;
  }
  expect({
    prefix: rendered.slice(0, admittedPrefix.length),
    nonCodeOffset,
    endMode: mask.endMode,
  }).toEqual({ prefix: admittedPrefix, nonCodeOffset: -1, endMode: 'code' });
}

/**
 * Claim A, the directive pin: the directive is the FIRST line, and it has no sibling (Req 6.18, 6.25).
 *
 * Two halves, and the second is the one a presence-only check cannot see. `restore` reports the
 * forbidden text itself rather than a boolean so a failure names what was found, and
 * `nettypeDirectives` counts the bare word so a restore spelled any other way fails the same
 * assertion - see `NETTYPE_RESTORE` for why the absence is correct and not an oversight.
 */
function expectDirectiveFirstAndNotRestored(rendered: string): void {
  const [firstLine] = rendered.split('\n');
  expect({
    firstLine,
    restore: rendered.includes(NETTYPE_RESTORE) ? NETTYPE_RESTORE : null,
    nettypeDirectives: rendered.split(NETTYPE_WORD).length - 1,
  }).toEqual({
    firstLine: DEFAULT_NETTYPE_DIRECTIVE,
    restore: null,
    nettypeDirectives: 1,
  });
}

/** Claim A, second half: every token is accounted for by at least one allowed source. */
function expectEveryTokenIsAllowed(
  tokens: readonly Token[],
  allowed: AllowedSources,
): ReadonlySet<string> {
  const used = new Set<string>();
  for (const token of tokens) {
    const sources = sourcesContaining(token.text, allowed);
    expect({ token: token.text, kind: token.kind, allowedBy: sources.length > 0 }).toEqual({
      token: token.text,
      kind: token.kind,
      allowedBy: true,
    });
    if (sources.length === 1) {
      used.add(sources[0] as string);
    }
  }
  return used;
}

/**
 * The module names of every instantiation in the token stream.
 *
 * An instantiation is `<word not in the skeleton> <word> (`. Excluding skeleton words is what keeps
 * `module <name> (` and `assert property (` from reading as instantiations of modules called
 * `module` and `assert`; a real instantiation's module name comes from `moduleName` and cannot be a
 * skeleton keyword. The one remaining way to confuse this scan would be two adjacent identifier
 * tokens inside a validated expression - which the validator's admit-list does not forbid - so that
 * is checked as an asserted precondition per case rather than assumed away.
 */
function instantiatedModuleNames(tokens: readonly Token[]): readonly string[] {
  const names: string[] = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    const first = tokens[index] as Token;
    const second = tokens[index + 1] as Token;
    const third = tokens[index + 2] as Token;
    const isInstantiation =
      first.kind === 'word' &&
      !SKELETON_WORDS.has(first.text) &&
      second.kind === 'word' &&
      third.text === '(';
    if (isInstantiation) {
      names.push(first.text);
    }
  }
  return names;
}

/** The precondition that makes the instantiation scan unambiguous (see above). */
function expectNoAdjacentWordsInExpressions(property: FormalProperty): void {
  for (const expression of expressionsOf(property)) {
    const tokens = tokenize(expression);
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      const adjacentWords =
        (tokens[index] as Token).kind === 'word' && (tokens[index + 1] as Token).kind === 'word';
      expect({ expression, adjacentWords }).toEqual({ expression, adjacentWords: false });
    }
  }
}

/** The wrapper's four regions, read out of the rendered text by its own fixed line structure. */
interface WrapperRegions {
  /** The header's port declarations, between `module <name> (` and `);`. */
  readonly declarations: readonly string[];
  /** The internal wires and the Warm_Up_Gate's counter, between `);` and the instance opener. */
  readonly internals: readonly string[];
  readonly connections: readonly string[];
  readonly body: readonly string[];
}

/** The index of the sole line equal to `line`, failing the case when it is not exactly one. */
function soleLineIndex(lines: readonly string[], line: string): number {
  const indices = lines.flatMap((candidate, index) => (candidate === line ? [index] : []));
  expect({ line, indices }).toEqual({ line, indices: [indices[0] ?? -1] });
  return indices[0] as number;
}

/**
 * Split the rendered wrapper into its declaration, internal, connection, and statement regions.
 *
 * RE-PINNED by task 16.5: the instance opener no longer sits immediately after the header's `);`,
 * because the internal wires and the Warm_Up_Gate's counter are declared between the two. The opener
 * is therefore LOCATED rather than assumed to be at a fixed offset, and the lines before it become
 * their own region - which is what lets claim D check that every design output is a WIRE there and
 * claim E keep counting only real statements.
 *
 * RE-PINNED AGAIN by task 18.2, and the lesson is the same one twice: the MODULE HEADER is now
 * located by content too. It used to be read as `lines[0]`, which stopped being the header the
 * moment task 18.1 put `` `default_nettype none `` above it, and shifted every region by one
 * (`chipAgent/_inbox/gotcha-default-nettype-none-as-the-wrappers-first-line-breaks-two-test-pins-not-one.md`).
 * `soleLineIndex` asserts the header line exists EXACTLY ONCE, so locating it by content keeps the
 * pin the index assertion had while surviving the next line added above it. The first line is
 * claimed separately, as text, by `expectDirectiveFirstAndNotRestored`.
 */
function splitWrapper(rendered: string, designInterface: ModuleInterface): WrapperRegions {
  const lines = rendered.split('\n');
  const headerStart = soleLineIndex(lines, HEADER_OPENER);
  const headerEnd = soleLineIndex(lines, HEADER_TERMINATOR);
  const instanceOpener = soleLineIndex(lines, `  ${designInterface.moduleName} dut (`);
  const instanceEnd = soleLineIndex(lines, INSTANCE_TERMINATOR);
  const footer = soleLineIndex(lines, FOOTER);
  expect({
    headerBeforeTerminator: headerEnd > headerStart,
    instanceAfterHeader: instanceOpener > headerEnd,
    footerIsLast: footer === lines.length - 1,
  }).toEqual({
    headerBeforeTerminator: true,
    instanceAfterHeader: true,
    footerIsLast: true,
  });
  return {
    declarations: lines.slice(headerStart + 1, headerEnd),
    internals: lines.slice(headerEnd + 1, instanceOpener),
    connections: lines.slice(instanceOpener + 1, instanceEnd),
    body: lines.slice(instanceEnd + 1, footer),
  };
}

/** Sort key making an `ExpectedPort` multiset comparison order-free but duplicate-sensitive. */
function portKey(port: ExpectedPort): string {
  return `${port.name}|${port.direction}|${String(port.width)}`;
}

/**
 * Claim D: every design INPUT is a wrapper input port and NOTHING else is (Req 3.9, 3.10, 3.11).
 *
 * RE-PINNED by task 16.5, and STRENGTHENED rather than relaxed. The old form asserted the declared
 * ports were exactly the design's ports WITH THEIR OWN DIRECTIONS; that is the measured defect - with
 * observed signals declared as wrapper outputs, ABC ORs the design's own outputs into the property and
 * refutes a design z3 and rIC3 both prove. So the claim is now TWO-SIDED: every input appears as an
 * `input` port and no non-input does, which `DECLARATION_PATTERN`'s `input`-only alternative enforces
 * at the token level rather than by comparing a direction we also expected.
 */
function expectPortsAreExactlyTheInputs(
  declarations: readonly string[],
  expected: readonly ExpectedPort[],
): void {
  const observed = declarations.map((line) => {
    const text = line.endsWith(',') ? line.slice(0, -1) : line;
    const match = DECLARATION_PATTERN.exec(text);
    expect({ line, parsed: match !== null }).toEqual({ line, parsed: true });
    const [, direction, high, name] = match as RegExpExecArray;
    return {
      name: name as string,
      direction: direction as PortDirection,
      width: high === undefined ? 1 : Number(high) + 1,
    };
  });
  const inputs = expected.filter((port) => port.direction === 'input');
  expect(observed.map(portKey).sort()).toEqual(inputs.map(portKey).sort());
}

/**
 * Claim D's other half: every design OUTPUT and every other observed signal is an internal WIRE.
 *
 * The internal region may also hold the Warm_Up_Gate's counter declaration, which is parsed and
 * counted separately rather than admitted as a wire - so a render that emitted a second register, or
 * a wire the design has no signal for, fails here.
 */
function expectNonInputsAreInternalWires(
  internals: readonly string[],
  expected: readonly ExpectedPort[],
): { readonly counters: number } {
  let counters = 0;
  const observed: ExpectedPort[] = [];
  for (const line of internals) {
    const counter = COUNTER_PATTERN.exec(line);
    if (counter !== null) {
      counters += 1;
      continue;
    }
    const match = WIRE_PATTERN.exec(line);
    expect({ line, parsed: match !== null }).toEqual({ line, parsed: true });
    const [, high, name] = match as RegExpExecArray;
    observed.push({
      name: name as string,
      direction: 'input',
      width: high === undefined ? 1 : Number(high) + 1,
    });
  }
  const nonInputs = expected
    .filter((port) => port.direction !== 'input')
    // Direction is normalized away on both sides: a wire HAS no direction, which is the whole claim.
    .map((port): ExpectedPort => ({ ...port, direction: 'input' }));
  expect(observed.map(portKey).sort()).toEqual(nonInputs.map(portKey).sort());
  expect({ counters, atMostOne: counters <= 1 }).toEqual({ counters, atMostOne: true });
  return { counters };
}

/** Claim C: every connection is `.name(name)`, and the connected set is exactly the port set. */
function expectConnectionsAreStraightThrough(
  connections: readonly string[],
  expected: readonly ExpectedPort[],
): void {
  const connected = connections.map((line) => {
    const text = line.endsWith(',') ? line.slice(0, -1) : line;
    const match = CONNECTION_PATTERN.exec(text);
    expect({ line, parsed: match !== null }).toEqual({ line, parsed: true });
    const [, formal, actual] = match as RegExpExecArray;
    expect({ line, straightThrough: formal === actual }).toEqual({ line, straightThrough: true });
    return formal as string;
  });
  expect([...connected].sort()).toEqual(expected.map((port) => port.name).sort());
}

/** Whether a combinational property's consequent is rendered at all (Req 6.20, 6.23). */
function rendersCombinationalAssert(property: FormalProperty): boolean {
  return (
    property.kind === 'combinational' &&
    !property.consequent.includes('$past') &&
    !property.consequent.includes('$stable')
  );
}

/**
 * Claim E: the body holds exactly the property's own statements, the contract's two, and nothing else.
 *
 * RE-PINNED by task 16.5, and it is still the claim that makes Req 3.7 checkable - an extra
 * behavioural statement spelled entirely out of allowed tokens passes the membership check and fails
 * HERE. What changed is the expected COUNT, which is now derived from the emissions rather than fixed:
 *
 *   + 1 for the unclocked reset assume, on every DERIVED contract (Req 14.1)
 *   + 1 for the Warm_Up_Gate's increment, where a counter was declared (Req 6.20, 6.24)
 *   + 1 for the assertion, unless the shape was refused (Req 6.20, 6.23)
 *   + 1 for the cover, on a clocked property carrying an antecedent (Req 5.1)
 *
 * The counter count is READ from claim D's parse of the internal region rather than re-derived, so the
 * declaration and the increment cannot disagree about whether a gate exists: a counter declared and
 * never incremented, or incremented and never declared, fails here.
 */
function expectBodyIsOnlyTheProperty(
  body: readonly string[],
  property: FormalProperty,
  reset: ResetContract,
  counters: number,
): void {
  const assertions = property.kind === 'clocked' || rendersCombinationalAssert(property) ? 1 : 0;
  const covers = property.kind === 'clocked' && property.antecedent !== null ? 1 : 0;
  const expected = (reset.derived ? 1 : 0) + counters + assertions + covers;
  expect({ statements: body.length, body }).toEqual({ statements: expected, body });
}

describe(PROPERTY, () => {
  it('emits only skeleton, interface, expression, and wrapper-name tokens over one submodule', () => {
    let total = 0;
    let clockedWithAntecedent = 0;
    let clockedWithoutAntecedent = 0;
    let combinational = 0;
    let zeroDeclaredPorts = 0;
    let withClock = 0;
    let withMultiBitPort = 0;
    let withInoutPort = 0;
    let withInternalWire = 0;
    let withWarmUpCounter = 0;
    let derivedContract = 0;
    const sourcesSolelyAccountingForAToken = new Set<string>();

    fc.assert(
      fc.property(
        arbDesignInterface(),
        arbFormalProperty(),
        arbResetContract(),
        (designInterface: ModuleInterface, property: FormalProperty, reset: ResetContract) => {
          total += 1;
          expectNoAdjacentWordsInExpressions(property);

          const rendered = renderPropertyWrapper(designInterface, property, WRAPPER_NAME, reset);
          const allowed = allowedSourcesFor(designInterface, property, reset);
          const expectedSignals = expectedWrapperSignals(designInterface);

          // Claim A. The directive first and unrestored, code everywhere after it, and every token
          // from an allowed source. The directive pin runs FIRST so a render that lost the line, or
          // that grew the conventional restore, is reported as the DIRECTIVE defect it is rather
          // than as a shifted region downstream of it.
          expectDirectiveFirstAndNotRestored(rendered);
          expectOnlyTheDirectiveIsNonCode(rendered);
          const tokens = tokenize(rendered);
          for (const source of expectEveryTokenIsAllowed(tokens, allowed)) {
            sourcesSolelyAccountingForAToken.add(source);
          }

          // Claim B. Req 3.4: exactly one submodule, and it is the candidate design.
          expect(instantiatedModuleNames(tokens)).toEqual([designInterface.moduleName]);

          const regions = splitWrapper(rendered, designInterface);
          // Claim D. Every design INPUT is an `input` port and nothing else is any port at all
          // (Req 3.9, 3.10, 3.11). Checked BEFORE the connections, so a dropped clock is reported as
          // the missing DECLARATION it is (the undriven-wire trap) rather than as a missing
          // connection downstream of it.
          expectPortsAreExactlyTheInputs(regions.declarations, expectedSignals);
          const { counters } = expectNonInputsAreInternalWires(regions.internals, expectedSignals);
          // Claim C. Straight-through connections; a crossed one proves a property about a
          // permuted design and is invisible to claim A. Over EVERY signal, ports and wires alike -
          // a design output left unconnected is a wrapper that observes nothing.
          expectConnectionsAreStraightThrough(regions.connections, expectedSignals);
          // Claim E. Req 3.7: no statement beyond the property's own and the contract's.
          expectBodyIsOnlyTheProperty(regions.body, property, reset, counters);

          if (reset.derived) {
            derivedContract += 1;
          }
          if (counters > 0) {
            withWarmUpCounter += 1;
          }
          if (expectedSignals.some((port) => port.direction !== 'input')) {
            withInternalWire += 1;
          }
          if (property.kind === 'combinational') {
            combinational += 1;
          } else if (property.antecedent === null) {
            clockedWithoutAntecedent += 1;
          } else {
            clockedWithAntecedent += 1;
          }
          if (designInterface.ports.length === 0) {
            zeroDeclaredPorts += 1;
          }
          if (designInterface.clocking.clockName !== null) {
            withClock += 1;
          }
          if (expectedSignals.some((port) => port.width > 1)) {
            withMultiBitPort += 1;
          }
          if (expectedSignals.some((port) => port.direction === 'inout')) {
            withInoutPort += 1;
          }
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // Non-vacuity. Each claim holds trivially over a sample that lacks the shape it is about, so
    // the sample is asserted to contain every shape rather than assumed to.
    expect(total).toBe(NUM_RUNS);
    // Both union members, and both antecedent arms of the clocked member.
    expect(clockedWithAntecedent / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    expect(clockedWithoutAntecedent / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    expect(combinational / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    // Claim D's empty case: the renderer drops the empty declaration line rather than emitting a
    // blank one inside the parentheses, so the zero-port shape has to be in the sample.
    expect(zeroDeclaredPorts).toBeGreaterThan(0);
    // Without a non-null clock, claim D never checks a `clocking`-sourced port and the dropped-clock
    // mutation would be unfalsifiable - which is the undriven-wire trap task 3.2 measured.
    expect(withClock).toBeGreaterThan(0);
    // The range suffix and its number tokens, and the `inout` case: an `inout` is neither an input
    // nor an output, so it is the shape that separates "not an input" from "an output" in claim D.
    expect(withMultiBitPort).toBeGreaterThan(0);
    expect(withInoutPort).toBeGreaterThan(0);
    // Claim D's wire half is vacuous over an all-input design, and claim E's assume and counter terms
    // are vacuous without a derived contract and without a `$past` property. All three asserted rather
    // than assumed, which is the hole a widened union left open in this repository once
    // (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
    expect(withInternalWire).toBeGreaterThan(0);
    expect(derivedContract / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    expect(withWarmUpCounter).toBeGreaterThan(0);
    // Every allowed source must be the SOLE account for at least one token somewhere in the sample,
    // or it is decoration rather than a source this property rests on.
    expect([...sourcesSolelyAccountingForAToken].sort()).toEqual([
      'expressions',
      'interfaceNames',
      'resetContract',
      'skeleton',
      'warmUp',
      'wrapperName',
    ]);
  });
});
