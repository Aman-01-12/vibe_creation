// formal-property-oracle: the shared fast-check generators the formal properties rest on.
//
// SCOPE OF THIS FILE TODAY
//   Task 5.3 owns this module and names FIVE arbitraries for it. Two of them - `arbFormalProperty`
//   and `arbPropertyText` - are consumed by GROUP 3 (tasks 3.3, 3.4, 3.5, 3.6), which lands before
//   group 5, so they were written here first rather than being duplicated in a group-3 test file
//   and then hoisted. THREE more now land beside them, because the surfaces they read exist:
//   `arbProofConditions()` over `ProofConditions` (task 5.1), `arbFormalReport()` over
//   `FormalReport` (task 5.2's reworked four-check schema), and `arbCalibratedMutantPopulation()`
//   over vocabularies both `@app/tools` and `@app/eval` already export. Extend this module; do not
//   start a second one.
//
//   `arbDesignInterface()` is here for the same reason and is not one of task 5.3's named
//   generators: every group-3 render property needs a `ModuleInterface` to render against, and a
//   generator copied into three test files is three chances to drift.
//
// TWO OF TASK 5.3's GENERATORS WERE DEFERRED, AND TASK 16.3 LANDED THEM HERE
//   `arbResetContract()` and `arbInitialStatePredicate()` are now at the bottom of this file. The
//   deferral is kept on the record because it is the RULE rather than an accident: `ResetContract`
//   is a type `app/tools/formal/prepass.ts` owns, and it is the FOURTH PARAMETER of
//   `renderPropertyWrapper`, so the generator's return type IS that type. Declaring a
//   structurally-identical shape here would have made `app/test` a second owner of it -
//   TypeScript's structural assignability would hide the duplication rather than catch it - and
//   16.3 would then have had to keep two declarations in step. The same argument held one step
//   harder for `arbInitialStatePredicate()`: its whole value is that the initial-state-predicate
//   READER separates the literal `true` from a non-trivial predicate and both of those from the
//   ABSENT and UNPARSEABLE shapes, and until that reader existed an expected-outcome tag would have
//   been a guess at a contract rather than a generator over one.
//
//   The rule, stated once so a later task applies it rather than re-deriving it: a generator LANDS
//   when every vocabulary it generates over exists, and is DEFERRED when the type it must RETURN is
//   owned by a module another task creates.
//
//   The same rule defers one more line of task 5.3: "extend every existing terminal-outcome
//   arbitrary to VARY `FormalProvenance`". `FormalProvenance` does not exist anywhere in `app/`
//   yet - TASK 8.2 makes it a required field on all three terminal outcomes - and a generator
//   cannot vary a field the outcome types do not carry. It belongs with 8.2, for the reason 8.2
//   itself gives: a pinned default would silently weaken every property that varies it.
//
// WHY A STRUCTURED EXPRESSION GENERATOR AND NOT RANDOM TEXT
//   `arbFormalProperty()` must yield properties the renderer can actually render, which means
//   every expression field has to be a `ValidatedExpression`. A character-level generator would
//   spend essentially its whole budget on text `validateExpression` refuses, so the render
//   properties would hold over an empty sample. `dialectExpressionArbitrary` therefore BUILDS from
//   the accepted dialect's own pieces - signals, sized and unsized literals, bit- and part-selects,
//   concatenation, the sampled-value functions, the ternary, and boolean implication written
//   `!a || b` because Req 6.3 admits no other form - and then puts every one through
//   `validateExpression`, throwing if it is refused. A refusal there means THE GENERATOR is wrong,
//   not the code under test, and it must be loud rather than silently thinning the sample.
//
// WHY `arbPropertyText()` IS BIASED FROM THE MEASURED TABLE RATHER THAN FROM LITERALS
//   Task 5.3 requires every measured rejected form to be represented, so the validator is tested
//   against what the probe OBSERVED and not only against noise. The injection list is read from
//   `MEASURED_REJECTED_FORMS` itself, so a thirteenth measured row is generated the moment it is
//   added to the table - a hand-copied list of twelve literals would keep passing while covering
//   twelve of thirteen.
//
// NO SHARED `/g` REGEX. Nothing here holds a mutable regex. The one pattern-matching helper builds
// a fresh NON-GLOBAL regex per call from `MeasuredRejectedForm.pattern.source`, because a shared
// `/g` object carries `lastIndex` across calls and has hung this repository's whole vitest suite
// once (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`).
//
// Pure: no clock, no I/O, no model call. Every generated value comes from fast-check's seed.

import fc from 'fast-check';

import { makePort, type ModuleInterface, type Port, type PortDirection } from '@app/core';
import {
  formalCalibrationOf,
  mutantIdOf,
  MUTATION_OPERATORS,
  type FormalMutantCalibration,
  type MutantCalibration,
  type MutantIdentity,
  type MutationSite,
} from '@app/eval';
import {
  FALLBACK_ROUTES,
  FORMAL_ORACLE_VERSION,
  PROPERTY_SET_ADMISSION_OUTCOMES,
  type FallbackRoute,
  type FormalProvenance,
  type PropertySetAdmissionOutcome,
  type RecordedCounterexampleCapture,
} from '@app/agent';
import {
  admitProved,
  CLOCK_POLARITIES,
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  MAX_DIAGNOSTIC_CHARS,
  MAX_EXPRESSION_CHARS,
  MEASURED_REJECTED_FORMS,
  PROPERTY_WRAPPER_MODULE_NAME,
  validateExpression,
  type ArtifactBlobRef,
  type ClockPolarity,
  type CouldNotVerifyCause,
  type CounterexampleRefusal,
  type CoverCondition,
  type FormalCheckReport,
  type FormalChecksReport,
  type FormalCrossCheckReport,
  type FormalLoweringReport,
  type FormalProperty,
  type FormalReport,
  type ProofConditions,
  type PropertyResult,
  type ResetContract,
  type ValidatedExpression,
} from '@app/tools';

// ---------------------------------------------------------------------------
// Names, and why they are a fixed pool
// ---------------------------------------------------------------------------

/**
 * Whether `text` carries none of the measured rejected forms.
 *
 * Every regex is constructed fresh and NON-GLOBAL: `RegExp.prototype.test` on a non-global regex
 * reads no `lastIndex` and writes none, so there is no state to leak between calls.
 */
function isDialectSafeName(text: string): boolean {
  return !MEASURED_REJECTED_FORMS.some((form) => new RegExp(form.pattern.source).test(text));
}

/**
 * The signal and module names every generated interface and expression draws from.
 *
 * A fixed pool rather than a character-level identifier generator, for one reason that is a
 * correctness condition rather than a convenience: a generated name is spliced into the rendered
 * wrapper's PORT LIST, and the render properties assert that a measured rejected form appears
 * nowhere except its own skeleton position. A randomly generated name that happened to be
 * `throughout` or to contain `@` would make that assertion fail for a reason that says nothing
 * about the renderer. These are all SystemVerilog-legal signal names that no measured rejected
 * form matches, and the filter below keeps that true by construction if the pool ever grows.
 */
const SIGNAL_NAMES: readonly string[] = Object.freeze(
  [
    'clk',
    'rst_n',
    'a',
    'b',
    'c',
    'd',
    'q',
    'en',
    'valid',
    'data',
    'cnt',
    'sum',
    'sel',
    'load',
    'done',
  ].filter(isDialectSafeName),
);

/** Module names, drawn from the probe's own reference designs. */
const MODULE_NAMES: readonly string[] = Object.freeze(
  ['adder_8bit', 'counter_12', 'JC_counter', 'multi_booth_8bit'].filter(isDialectSafeName),
);

/** Acceptance-criterion references, so `criterionRef` is a plausible value rather than noise. */
const CRITERION_REFS: readonly string[] = Object.freeze(['ac-1', 'ac-2', 'ac-3', 'ac-7']);

/** Property identifiers. */
const PROPERTY_IDS: readonly string[] = Object.freeze(['p1', 'p2', 'p3', 'prop_sum_exact']);

// ---------------------------------------------------------------------------
// The accepted-dialect expression generator
// ---------------------------------------------------------------------------

/** Sized and unsized literals, spanning every base the validator's number reader admits. */
const LITERALS: readonly string[] = Object.freeze([
  '0',
  '1',
  '255',
  "1'b0",
  "4'hF",
  "8'd15",
  "8'sh7F",
  "'b1",
]);

/** The formal functions that take no argument (Req 6.4). */
const NULLARY_FORMAL_FUNCTIONS: readonly string[] = Object.freeze(['$initstate', '$anyconst']);

/** The sampled-value and counting functions that take one argument (Req 6.4). */
const UNARY_FORMAL_FUNCTIONS: readonly string[] = Object.freeze([
  '$past',
  '$rose',
  '$fell',
  '$stable',
  '$changed',
  '$countones',
]);

/** The accepted unary operators. No unary `-`: the dialect's `-` is the binary subtraction. */
const UNARY_OPERATORS: readonly string[] = Object.freeze(['!', '~']);

/** The accepted binary operators, boolean, comparison, arithmetic, and bitwise. */
const BINARY_OPERATORS: readonly string[] = Object.freeze([
  '==',
  '!=',
  '===',
  '!==',
  '&&',
  '||',
  '<',
  '>',
  '<=',
  '>=',
  '+',
  '-',
  '*',
  '&',
  '|',
  '^',
]);

/** The leaves of a dialect expression: a signal, a literal, a select, or a nullary function. */
function expressionLeafArbitrary(): fc.Arbitrary<string> {
  const signal = fc.constantFrom(...SIGNAL_NAMES);
  return fc.oneof(
    signal,
    fc.constantFrom(...LITERALS),
    fc.constantFrom(...NULLARY_FORMAL_FUNCTIONS),
    fc.tuple(signal, fc.integer({ min: 0, max: 7 })).map(([name, bit]) => `${name}[${bit}]`),
    fc.tuple(signal, fc.integer({ min: 1, max: 7 })).map(([name, high]) => `${name}[${high}:0]`),
  );
}

/**
 * An expression inside the accepted dialect, nested to `depth` levels.
 *
 * `depth` is bounded at 2 by every caller: deep enough that a case is a real compound expression
 * whose splice into the wrapper is worth asserting over, shallow enough that a counterexample
 * shrinks to something a reader can hold, and far enough under `MAX_EXPRESSION_CHARS` that the
 * length bound is never the reason a case is refused.
 */
function dialectExpressionArbitrary(depth = 2): fc.Arbitrary<string> {
  const leaf = expressionLeafArbitrary();
  if (depth <= 0) {
    return leaf;
  }
  const inner = dialectExpressionArbitrary(depth - 1);
  return fc.oneof(
    { weight: 3, arbitrary: leaf },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom(...UNARY_OPERATORS), inner)
        .map(([operator, operand]) => `${operator}${operand}`),
    },
    {
      weight: 3,
      arbitrary: fc
        .tuple(inner, fc.constantFrom(...BINARY_OPERATORS), inner)
        .map(([left, operator, right]) => `${left} ${operator} ${right}`),
    },
    {
      // Req 6.3: a boolean implication is written `!a || b`, and there is no other form, because
      // `|->` and `|=>` are hard syntax errors the validator refuses by name. Generated on purpose
      // and weighted, so the render properties actually carry implications rather than asserting
      // the absence of `|->` over a sample that never wanted one.
      weight: 2,
      arbitrary: fc
        .tuple(inner, inner)
        .map(([antecedent, consequent]) => `!${antecedent} || ${consequent}`),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.constantFrom(...UNARY_FORMAL_FUNCTIONS), inner)
        .map(([name, argument]) => `${name}(${argument})`),
    },
    {
      weight: 1,
      arbitrary: fc.tuple(inner, inner).map(([high, low]) => `{${high}, ${low}}`),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(inner, inner, inner)
        .map(([condition, whenTrue, whenFalse]) => `${condition} ? ${whenTrue} : ${whenFalse}`),
    },
  );
}

/**
 * Put a generated expression through the sole constructor of the brand, or fail loudly.
 *
 * A refusal here is a defect in THIS generator, never in the code under test: the dialect pieces
 * above are all inside the accepted dialect, so a rejection means one of them drifted out of it.
 * Throwing surfaces that as a failing case naming the construct, which is what stops a drifted
 * generator from quietly shrinking the sample the render properties hold over.
 */
function validatedOrThrow(text: string): ValidatedExpression {
  const result = validateExpression(text);
  if (!result.ok) {
    const named = 'construct' in result.error ? `: ${result.error.construct}` : '';
    throw new Error(
      `formal-arbitraries generated an expression outside the accepted dialect ` +
        `(${result.error.reason}${named}): ${text}`,
    );
  }
  return result.value;
}

/** A `ValidatedExpression` drawn from the accepted dialect. */
function validatedExpressionArbitrary(): fc.Arbitrary<ValidatedExpression> {
  return dialectExpressionArbitrary().map(validatedOrThrow);
}

// ---------------------------------------------------------------------------
// `arbFormalProperty`
// ---------------------------------------------------------------------------

/**
 * A clocked `FormalProperty`, with `antecedent` null on roughly half of all cases.
 *
 * The null share is written as an explicit 50/50 `oneof` rather than left to `fc.option`'s default
 * nil frequency, because BOTH arms are load-bearing and neither may be a rare draw: Req 5.10 and
 * task 3.5 state opposite claims over them - a property with an antecedent must yield a cover on
 * that antecedent token for token, and a property with none must yield no cover at all - so a
 * generator that produced one arm a fifth of the time would leave the other claim asserted over a
 * handful of cases at 100 runs.
 */
function clockedPropertyArbitrary(): fc.Arbitrary<FormalProperty> {
  return fc
    .record({
      id: fc.constantFrom(...PROPERTY_IDS),
      criterionRef: fc.constantFrom(...CRITERION_REFS),
      clock: fc.constantFrom(...SIGNAL_NAMES).map(validatedOrThrow),
      antecedent: fc.oneof(
        fc.constant<ValidatedExpression | null>(null),
        validatedExpressionArbitrary(),
      ),
      consequent: validatedExpressionArbitrary(),
    })
    .map((fields) => ({ kind: 'clocked', ...fields }));
}

/** A combinational `FormalProperty`: a consequent and nothing else, because it carries no clock. */
function combinationalPropertyArbitrary(): fc.Arbitrary<FormalProperty> {
  return fc
    .record({
      id: fc.constantFrom(...PROPERTY_IDS),
      criterionRef: fc.constantFrom(...CRITERION_REFS),
      consequent: validatedExpressionArbitrary(),
    })
    .map((fields) => ({ kind: 'combinational', ...fields }));
}

/**
 * A `FormalProperty` of either kind, every expression field validated.
 *
 * Both union members are generated, and the clocked member generates both the `antecedent === null`
 * and the non-null case. Every consumer asserts that coverage explicitly rather than trusting these
 * weights: a union that grows a third member, or a weight edited to zero, would otherwise leave a
 * property passing over a sample that no longer contains the shape it is about
 * (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
 *
 * Clocked is weighted higher because it is the member with two arms and the only one that emits a
 * cover, so it carries strictly more of the renderer's behaviour.
 */
export function arbFormalProperty(): fc.Arbitrary<FormalProperty> {
  return fc.oneof(
    { weight: 2, arbitrary: clockedPropertyArbitrary() },
    { weight: 1, arbitrary: combinationalPropertyArbitrary() },
  );
}

// ---------------------------------------------------------------------------
// `arbDesignInterface`
// ---------------------------------------------------------------------------

const PORT_DIRECTIONS: readonly PortDirection[] = Object.freeze<PortDirection[]>([
  'input',
  'output',
  'inout',
]);

/** Build a `Port` through the validating constructor, or fail the generator loudly. */
function portOrThrow(name: string, direction: PortDirection, width: number): Port {
  const result = makePort({ name, direction, width });
  if (!result.ok) {
    throw new Error(`formal-arbitraries generated an invalid port: ${result.error.code}`);
  }
  return result.value;
}

/** The raw shape of a design interface, before names are dealt out. */
interface DesignInterfaceShape {
  readonly moduleName: string;
  readonly directions: readonly PortDirection[];
  readonly widths: readonly number[];
  readonly hasClock: boolean;
  readonly hasReset: boolean;
  readonly resetActiveLow: boolean;
}

/** Deal unique names to the declared ports, then the clock, then the reset. */
function buildDesignInterface(
  shape: DesignInterfaceShape,
  uniqueNames: readonly string[],
): ModuleInterface {
  const declaredCount = shape.directions.length;
  const ports = shape.directions.map((direction, index) =>
    portOrThrow(
      uniqueNames[index] as string,
      direction,
      // Widths are paired by index; the arbitrary trims both lists to the shorter length first.
      shape.widths[index] as number,
    ),
  );
  let next = declaredCount;
  const clockName = shape.hasClock ? (uniqueNames[next++] as string) : null;
  const resetName = shape.hasReset ? (uniqueNames[next++] as string) : null;
  return {
    moduleName: shape.moduleName,
    ports,
    clocking: { clockName, resetName, resetActiveLow: shape.resetActiveLow },
    // No generated case needs a Validity_Output; this task changes no behaviour.
    validityOutputName: null,
  };
}

/**
 * A `ModuleInterface` for the design a Property_Wrapper is rendered around.
 *
 * Every declared port, the clock, and the reset carry DISTINCT names, because a real module cannot
 * declare one name twice and `wrapperPorts` does not deduplicate - a duplicated name renders an
 * unbuildable wrapper, which is a different (and deliberately loud) behaviour than the one the
 * render properties are about.
 *
 * Width 1 is in range on purpose: it is the width the renderer must NOT suffix with a bit range.
 * Zero declared ports is in range too, because the renderer drops the empty declaration and
 * connection lines rather than emitting a blank line inside the parentheses.
 */
export function arbDesignInterface(): fc.Arbitrary<ModuleInterface> {
  return fc
    .record<DesignInterfaceShape>({
      moduleName: fc.constantFrom(...MODULE_NAMES),
      directions: fc.array(fc.constantFrom(...PORT_DIRECTIONS), { minLength: 0, maxLength: 5 }),
      widths: fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 0, maxLength: 5 }),
      hasClock: fc.boolean(),
      hasReset: fc.boolean(),
      resetActiveLow: fc.boolean(),
    })
    .map((shape) => ({
      ...shape,
      // `fc.array` lengths are independent, so pair by index over the shorter of the two.
      widths: shape.widths.slice(0, shape.directions.length),
      directions: shape.directions.slice(0, shape.widths.length),
    }))
    .chain((shape) => {
      const needed = shape.directions.length + (shape.hasClock ? 1 : 0) + (shape.hasReset ? 1 : 0);
      return fc
        .uniqueArray(fc.constantFrom(...SIGNAL_NAMES), { minLength: needed, maxLength: needed })
        .map((names) => buildDesignInterface(shape, names));
    });
}

// ---------------------------------------------------------------------------
// `arbPropertyText`
// ---------------------------------------------------------------------------

/** Every measured rejected form's construct text, read from the table rather than restated. */
const MEASURED_REJECTED_CONSTRUCTS: readonly string[] = Object.freeze(
  MEASURED_REJECTED_FORMS.map((form) => form.construct),
);

/** A dialect expression carrying exactly one measured rejected form, in one of three positions. */
function injectedRejectedFormArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(...MEASURED_REJECTED_CONSTRUCTS),
      dialectExpressionArbitrary(1),
      dialectExpressionArbitrary(1),
      fc.constantFrom('prefix', 'infix', 'suffix'),
    )
    .map(([form, left, right, position]) => {
      if (position === 'prefix') {
        return `${form} ${left}`;
      }
      if (position === 'suffix') {
        return `${left} ${form}`;
      }
      return `${left} ${form} ${right}`;
    });
}

/**
 * A measured rejected form placed inside a comment, a string literal, or a compiler directive.
 *
 * These are the cases that separate "found a construct" from "found a construct IN CODE": the
 * validator reports the SPAN (`comment`, `string-literal`, `compiler-directive`) and never the
 * construct the span happens to contain, because a `|->` inside a comment is not a `|->`.
 */
function rejectedFormInNonCodeSpanArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(...MEASURED_REJECTED_CONSTRUCTS),
      dialectExpressionArbitrary(1),
      fc.constantFrom('line-comment', 'block-comment', 'string', 'directive'),
    )
    .map(([form, expression, span]) => {
      switch (span) {
        case 'line-comment':
          return `${expression} // ${form}`;
        case 'block-comment':
          return `/* ${form} */ ${expression}`;
        case 'string':
          return `${expression} == "${form}"`;
        default:
          return `\`define GUARD ${form}`;
      }
    });
}

/** Identifier-shaped words the validator refuses because they are keywords, not signal names. */
const KEYWORDS_WEARING_A_SIGNAL_NAME: readonly string[] = Object.freeze([
  'assert',
  'assume',
  'cover',
  'sequence',
  'endsequence',
  'always',
  'begin',
  'end',
  'module',
  'endmodule',
  'if',
  'else',
  'posedge',
  'negedge',
  'case',
  'endcase',
  'function',
  'wait',
  'while',
]);

/**
 * System functions the dialect does NOT admit.
 *
 * `$signed` and `$unsigned` are here rather than in the accepted set on purpose: the probe measured
 * `assert(p == $signed(a) * $signed(b))` computing an 8-bit product and then extending it, so they
 * are expressions the toolchain accepts and quietly gets wrong - the class a whitelist exists to
 * keep out, and therefore a case worth generating.
 */
const UNACCEPTED_SYSTEM_FUNCTIONS: readonly string[] = Object.freeze([
  '$signed',
  '$unsigned',
  '$sampled',
  '$onehot',
  '$bits',
  '$time',
  '$display',
  '$',
]);

/** Punctuation the dialect refuses: the statement-injection, hierarchy, and delay shapes. */
const REFUSED_PUNCTUATION: readonly string[] = Object.freeze([';', '.', '#', '\\', '@@', '=>']);

/** Text refused for a reason other than a measured form: token, balance, length, or emptiness. */
function otherwiseUnacceptedArbitrary(): fc.Arbitrary<string> {
  const expression = dialectExpressionArbitrary(1);
  return fc.oneof(
    fc
      .tuple(expression, fc.constantFrom(...KEYWORDS_WEARING_A_SIGNAL_NAME))
      .map(([left, keyword]) => `${left} && ${keyword}`),
    fc
      .tuple(fc.constantFrom(...UNACCEPTED_SYSTEM_FUNCTIONS), expression)
      .map(([name, argument]) => `${name}(${argument})`),
    fc
      .tuple(expression, fc.constantFrom(...REFUSED_PUNCTUATION))
      .map(([left, punctuation]) => `${left}${punctuation}`),
    // Unbalanced: even-but-mismatched (`([a)]`) as well as plainly unclosed, because an evenness
    // check would admit the first.
    expression.map((text) => `(${text}`),
    expression.map((text) => `${text})`),
    expression.map((text) => `([${text})]`),
    expression.map((text) => `{${text}`),
    // Empty and whitespace-only: refused with no construct to name.
    fc.constantFrom('', ' ', '\t\n', '   \r\n  '),
    // Over-length. Built by `repeat` rather than by a string arbitrary at cap size, which is
    // ruinously slow at this length
    // (`chipAgent/_inbox/gotcha-artifact-sink-property-test-needs-app-test-and-cheap-length-generators.md`).
    fc.integer({ min: 1, max: 64 }).map((excess) => 'a'.repeat(MAX_EXPRESSION_CHARS + excess)),
    // Bytes a diagnostic must survive: a NUL, a control character, and a lone surrogate.
    fc.constantFrom('a\u0000b', 'a\u0007b', 'a\ud800b', '\ud800'),
  );
}

/**
 * Candidate property text as it reaches `validateExpression`: untrusted model output.
 *
 * BIASED, per task 5.3, so every one of the measured rejected forms is generated - the injection
 * list is read from `MEASURED_REJECTED_FORMS`, so the bias follows the table rather than a copy of
 * it. The weights put the majority of the sample on text that carries a measured form (injected in
 * code, or planted inside a comment, string, or directive where it must NOT be reported as that
 * form), with a real share of accepted dialect text so the accept path is exercised too, and a
 * share of the other refusal reasons - keyword, unaccepted system function, refused punctuation,
 * unbalanced, empty, over-length, and non-printable bytes.
 */
export function arbPropertyText(): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 3, arbitrary: dialectExpressionArbitrary() },
    { weight: 5, arbitrary: injectedRejectedFormArbitrary() },
    { weight: 2, arbitrary: rejectedFormInNonCodeSpanArbitrary() },
    { weight: 3, arbitrary: otherwiseUnacceptedArbitrary() },
  );
}
// ---------------------------------------------------------------------------
// Vocabularies, derived rather than restated
// ---------------------------------------------------------------------------

/**
 * The runtime member list of a closed string union, derived from a TOTAL map over it.
 *
 * The map is what does the work: `Readonly<Record<Member, true>>` cannot be written with a member
 * missing, so a union that grows a fourth value is a COMPILE ERROR at the map rather than a
 * generator that silently stops producing the new value. That is the structural version of the
 * fix `chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`
 * had to make by hand after a widened union left a property test passing over a sample that no
 * longer contained the shape it was about.
 *
 * The one cast in this module, and it is sound by construction: `Object.keys` of a total map over
 * a string union returns exactly that union's members.
 */
function membersOf<Member extends string>(
  total: Readonly<Record<Member, true>>,
): readonly Member[] {
  // `Object.keys` is typed `string[]` however narrow the record's key type is, and TypeScript
  // will not narrow `string` back to a type PARAMETER in one step, so the widening hop is
  // unavoidable rather than careless. It is sound because `total` is a TOTAL map over `Member`
  // and nothing else can be a key of it. One hop, one place, and no other cast in this module.
  return Object.keys(total) as unknown as readonly Member[];
}

/**
 * How much likelier a condition's ADMITTING value is than each of its failing values.
 *
 * Not a style knob - it sets how often the five conditions all admit at once, which is the ONLY
 * direction in which Property 1's if-and-only-if can be non-vacuous. At 2-against-1 each
 * three-member condition admits half the time; see the arithmetic on `arbProofConditions`.
 */
const ADMITTING_WEIGHT = 2;

/** The weight carried by the failing values of one condition, together. */
const FAILING_WEIGHT = 1;

/**
 * One closed condition vocabulary, biased toward its admitting value.
 *
 * Two arms rather than one weighted arm per member, so the failing values stay UNIFORM among
 * themselves whatever their number: a third failing value added to a condition must not halve
 * the share of the two that were already there.
 */
function admittingBiased<Member extends string>(
  members: readonly Member[],
  admitting: Member,
): fc.Arbitrary<Member> {
  const failing = members.filter((member) => member !== admitting);
  return fc.oneof(
    { weight: ADMITTING_WEIGHT, arbitrary: fc.constant(admitting) },
    { weight: FAILING_WEIGHT * failing.length, arbitrary: fc.constantFrom(...failing) },
  );
}

/** Every Presat_Check value. Total, so a fourth member fails to compile here. */
const PRESAT_VALUES: Readonly<Record<ProofConditions['presat'], true>> = Object.freeze({
  satisfiable: true,
  preunsat: true,
  'not-run': true,
});

/** Every Base_Check value. Total, for the same reason. */
const BASE_VALUES: Readonly<Record<ProofConditions['base'], true>> = Object.freeze({
  passed: true,
  failed: true,
  'not-run': true,
});

/** Every Induction_Check value. Total, for the same reason. */
const INDUCTION_VALUES: Readonly<Record<ProofConditions['induction'], true>> = Object.freeze({
  successful: true,
  inconclusive: true,
  'not-run': true,
});

// ---------------------------------------------------------------------------
// `arbProofConditions`
// ---------------------------------------------------------------------------

/** Highest assertion count generated. Well past any real lowering; the value is not the point. */
const MAX_GENERATED_ASSERTION_COUNT = 4096;

/** Highest step a cover or a BMC failure is reported at. Measured worst on this corpus is 19. */
const MAX_GENERATED_STEP = 64;

/**
 * Counts `isNonZeroAssertionCount` exists to refuse but a `JSON.parse` could still hand it.
 *
 * `ProofConditions['assertionCount']` is a plain `number` on purpose, and its guard is
 * `Number.isSafeInteger(count) && count > 0` - not `count !== 0`. So the values that guard was
 * written for are in range here, or the guard's `isSafeInteger` half is never exercised by any
 * property and Property 1 would be asserting something about the report SCHEMA (which does bound
 * this field to a non-negative integer) rather than about the gate.
 *
 * NAMED FOR THE NEXT READER, because it decides how task 5.4 must phrase its iff: the admitting
 * clause is "a POSITIVE SAFE INTEGER", never "non-zero". `NaN !== 0` is true and `admitProved`
 * correctly returns `zero-assertions` for it, so an iff written as `!== 0` fails on these cases -
 * and it fails correctly, which is the same shape
 * `chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`
 * records for "a rejection always names a construct".
 */
const UNUSABLE_ASSERTION_COUNTS: readonly number[] = Object.freeze([
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
]);

/**
 * An assertion count as `ProofConditions` carries it: usable, zero, or unusable.
 *
 * Zero is its own arm rather than the bottom of an integer range, because it is the MEASURED
 * silent-failure trap - the chain missing `async2sync` and `chformal -lower` reports
 * `Status: PASSED` over 0 assertions - so it must be a fifth of the sample rather than 1 in 4096.
 */
function proofAssertionCountArbitrary(): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 1, max: MAX_GENERATED_ASSERTION_COUNT }) },
    { weight: 1, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.constantFrom(...UNUSABLE_ASSERTION_COUNTS) },
  );
}

/**
 * All THREE `CoverCondition` shapes, two of which admit a proof.
 *
 * Spelled as three arms rather than derived from a member list, because `CoverCondition` is a
 * union of OBJECT shapes and only one of them carries a `step`; a fourth member added later
 * cannot be silently absent here, because `admitProved` narrows on `reached === false` and
 * `ProvedEvidence` spells its two admitting shapes out, so a fourth member is already a compile
 * error in `conditions.ts` before it could be a gap in this generator.
 */
function coverConditionArbitrary(): fc.Arbitrary<CoverCondition> {
  const reached = fc
    .integer({ min: 0, max: MAX_GENERATED_STEP })
    .map((step): CoverCondition => ({ reached: true, step }));
  return fc.oneof(
    { weight: ADMITTING_WEIGHT, arbitrary: reached },
    { weight: FAILING_WEIGHT, arbitrary: fc.constant<CoverCondition>({ reached: false }) },
    {
      // `not-applicable` ADMITS - a property with no antecedent cannot be vacuous through an
      // unreached one - so it is weighted with the failing arm only because it is the rarer
      // shape in practice, never because it is a failure.
      weight: FAILING_WEIGHT,
      arbitrary: fc.constant<CoverCondition>({ reached: 'not-applicable' }),
    },
  );
}

/**
 * The five Proof_Conditions, drawn INDEPENDENTLY, so every combination is reachable.
 *
 * THE BASE-CASE FIELD IS GENERATED OVER ALL THREE OF ITS VALUES AND IS NEVER DEFAULTED TO
 * `passed`. That is the whole reason this generator is task content rather than a convenience: a
 * pinned `base` leaves Properties 1, 5, and 6 - the three the fifth condition exists for -
 * asserted over a sample in which the fifth condition never fails, so Property 1's
 * if-and-only-if could not fail however wrong the gate was. The same holds one step weaker for
 * `presat` and `induction`, so all three are drawn from their own total vocabulary.
 *
 * THE ARITHMETIC, so a consumer can size `numRuns` instead of guessing. Each three-member
 * condition admits with probability 1/2 (`ADMITTING_WEIGHT` against `FAILING_WEIGHT` times two
 * failing values), the cover admits with probability 3/4, and the count is usable with
 * probability 3/5. So:
 *   - ALL FIVE admit - the `proved` direction - on about 5.6% of cases (0.6 x 0.5 x 0.75 x 0.5 x
 *     0.5). At the shared 100-run default that is roughly 6 cases, which is thin for an iff; a
 *     property asserting anything about the admitting direction should raise `numRuns`.
 *   - Exactly one condition fails on about 22%.
 *   - TWO OR MORE fail on about 72%, which is the sample task 5.5 filters to when it asserts the
 *     fixed order over combinations rather than over the single-failure cases a naive generator
 *     would mostly produce.
 */
export function arbProofConditions(): fc.Arbitrary<ProofConditions> {
  return fc.record<ProofConditions>({
    assertionCount: proofAssertionCountArbitrary(),
    presat: admittingBiased(membersOf(PRESAT_VALUES), 'satisfiable'),
    cover: coverConditionArbitrary(),
    base: admittingBiased(membersOf(BASE_VALUES), 'passed'),
    induction: admittingBiased(membersOf(INDUCTION_VALUES), 'successful'),
  });
}

// ---------------------------------------------------------------------------
// `arbFormalReport`
// ---------------------------------------------------------------------------

/**
 * The `Status:` strings the probe MEASURED, weighted so the two that carry verdicts dominate.
 *
 * ONE status generator is shared by all four checks, deliberately, rather than a per-check
 * generator emitting only the strings that check realistically prints. The shared one is
 * strictly stronger: `PREUNSAT` is meaningful on the Presat_Check alone, so generating it on
 * `base` is what makes "the interpreter reads PREUNSAT off presat and nowhere else" a claim a
 * property can falsify. It is also the honest reading of the trust boundary - the report is a
 * file written by another process, and shape is all the schema promises.
 */
const MEASURED_STATUS_WEIGHT = 4;

/** The weight carried by `PREUNSAT`, and by a null status, each. */
const RARE_STATUS_WEIGHT = 1;

/** The weight carried by the unrecognized strings, together. */
const UNRECOGNIZED_STATUS_WEIGHT = 2;

/**
 * `Status:` strings outside the measured vocabulary, which Req 1.9 requires to be CLASSIFIED.
 *
 * `'passed'` is in the list on purpose: a case-insensitive read of the status line would accept
 * it, and the measured vocabulary is upper case.
 */
const UNRECOGNIZED_STATUS_LINES: readonly string[] = Object.freeze([
  'UNKNOWN',
  'ERROR',
  'TIMEOUT',
  'passed',
  '',
]);

/** One invocation's parsed `Status:` string, or `null` where none could be parsed. */
function statusArbitrary(): fc.Arbitrary<string | null> {
  return fc.oneof(
    { weight: MEASURED_STATUS_WEIGHT, arbitrary: fc.constant<string | null>('PASSED') },
    { weight: MEASURED_STATUS_WEIGHT, arbitrary: fc.constant<string | null>('FAILED') },
    { weight: RARE_STATUS_WEIGHT, arbitrary: fc.constant<string | null>('PREUNSAT') },
    {
      weight: UNRECOGNIZED_STATUS_WEIGHT,
      arbitrary: fc.constantFrom(...UNRECOGNIZED_STATUS_LINES),
    },
    { weight: RARE_STATUS_WEIGHT, arbitrary: fc.constant<string | null>(null) },
  );
}

/** Exit codes other than success and the ordinary failure: a kill, a missing binary, a signal. */
const UNUSUAL_EXIT_CODES: readonly number[] = Object.freeze([2, 124, 127, -1]);

/**
 * One invocation's exit code, drawn INDEPENDENTLY of its `Status:` string.
 *
 * The independence is the requirement, not a side effect: a report whose exit code DISAGREES with
 * its status - `Status: PASSED` at exit 1, or `Status: FAILED` at exit 0 - has to be a generated
 * case rather than a hand-written fixture, because the whole premise of this spec is that the
 * chain's own summary line has been measured lying about what it checked. About a fifth of
 * generated checks carry a `PASSED` status at a non-zero exit.
 */
function exitCodeArbitrary(): fc.Arbitrary<number | null> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant<number | null>(0) },
    { weight: 3, arbitrary: fc.constant<number | null>(1) },
    { weight: 1, arbitrary: fc.constantFrom(...UNUSUAL_EXIT_CODES) },
    // `null` exactly when the check did not run because no SMT2 was written.
    { weight: 1, arbitrary: fc.constant<number | null>(null) },
  );
}

/**
 * One invocation's elapsed milliseconds.
 *
 * The ceiling is drawn from the measurement rather than chosen: the worst single property
 * measured on this corpus took roughly 160s, so 200_000 covers it with room and nothing here
 * implies a timeout the run did not have.
 */
function elapsedMsArbitrary(): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: 200_000 });
}

/** The fields every invocation reports, main run and audit alike. Spelled once, as the schema does. */
function invocationFieldsArbitrary(): fc.Arbitrary<{
  readonly exitCode: number | null;
  readonly status: string | null;
  readonly elapsedMs: number;
}> {
  return fc.record({
    exitCode: exitCodeArbitrary(),
    status: statusArbitrary(),
    elapsedMs: elapsedMsArbitrary(),
  });
}

/** Trace filenames the worker's `--dump-vcd` would have chosen. Recorded, never read as evidence. */
const TRACE_FILENAMES: readonly string[] = Object.freeze([
  'trace_presat.vcd',
  'trace_base.vcd',
  'trace_cover.vcd',
  'trace_induct.vcd',
]);

/**
 * An OPTIONAL field is generated as a SPREADABLE FRAGMENT - `{}` or `{ field: value }`.
 *
 * Not a style choice: this package compiles under `exactOptionalPropertyTypes`, so
 * `{ tracePath: undefined }` is NOT assignable to `tracePath?: string`. A fragment spread is the
 * only shape that makes "absent" and "present" both buildable, and absence is information here -
 * a successful proof writes no trace, and the worker emits the field only where one exists.
 */
function tracePathArbitrary(): fc.Arbitrary<{ readonly tracePath?: string }> {
  return fc.oneof(
    fc.constant<{ readonly tracePath?: string }>({}),
    fc.constantFrom(...TRACE_FILENAMES).map((tracePath) => ({ tracePath })),
  );
}

/** The induction line, present only on the Induction_Check and on ITS audit (the schema's rule). */
function inductionSuccessfulArbitrary(): fc.Arbitrary<{ readonly inductionSuccessful?: boolean }> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant<{ readonly inductionSuccessful?: boolean }>({}) },
    { weight: 3, arbitrary: fc.boolean().map((inductionSuccessful) => ({ inductionSuccessful })) },
  );
}

/** The reached step, present only on the Cover_Check, and only where one was reached. */
function reachedStepArbitrary(): fc.Arbitrary<{ readonly reachedStep?: number }> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant<{ readonly reachedStep?: number }>({}) },
    {
      weight: 2,
      arbitrary: fc.integer({ min: 0, max: MAX_GENERATED_STEP }).map((reachedStep) => ({
        reachedStep,
      })),
    },
  );
}

/**
 * Whether the cover analysis ANSWERED reachability, present only on the Cover_Check.
 *
 * DRAWN INDEPENDENTLY OF `reachedStep`, and that independence is the point rather than an
 * oversight. The worker only ever writes `coverAnswered: true` beside a reached step, but the
 * schema permits either field without the other, the report is untrusted text at a trust boundary,
 * and `interpretFormalReport` is required to be TOTAL over every schema-valid document - so a step
 * with no answer flag, and an answer flag with no step, are precisely the shapes the interpreter
 * must handle rather than documents we may assume away.
 *
 * `true` carries the weight because it is the value that keeps `antecedent-unreached` REACHABLE
 * through `interpretFormalReport` at all: an unanswered cover is reported as
 * `toolchain-unavailable` instead (Req 5.12), so a generator that never answered would silently
 * delete that cause from the whole sample.
 */
function coverAnsweredArbitrary(): fc.Arbitrary<{ readonly coverAnswered?: boolean }> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant<{ readonly coverAnswered?: boolean }>({}) },
    {
      weight: 1,
      arbitrary: fc.constant<{ readonly coverAnswered?: boolean }>({ coverAnswered: false }),
    },
    {
      weight: 4,
      arbitrary: fc.constant<{ readonly coverAnswered?: boolean }>({ coverAnswered: true }),
    },
  );
}

/** The TWO fields the Cover_Check's schema slot declares, each drawn on its own. */
function coverFieldsArbitrary(): fc.Arbitrary<{
  readonly reachedStep?: number;
  readonly coverAnswered?: boolean;
}> {
  return fc
    .tuple(reachedStepArbitrary(), coverAnsweredArbitrary())
    .map(([step, answered]) => ({ ...step, ...answered }));
}

/** No conditional field at all: the shape `presat` and `base` carry. */
function noConditionalFieldArbitrary(): fc.Arbitrary<Record<string, never>> {
  return fc.constant({});
}

/** The solvers a Solver_Cross_Check can name. `bitwuzla` is the main run's, `z3` the audit's. */
const CROSS_CHECK_SOLVERS: readonly string[] = Object.freeze(['z3', 'bitwuzla']);

/**
 * One check's Solver_Cross_Check, absent on two thirds of checks.
 *
 * TWO INDEPENDENCE DECISIONS, both stated because both are load-bearing.
 *
 * The audit's own `Status:` is drawn INDEPENDENTLY of the status of the check it audits, so an
 * audit that DISAGREES is a generated case. That is now a classification path rather than a
 * curiosity: a disagreement is reported as `could-not-verify` / `toolchain-unavailable`
 * preferring NEITHER solver, because a solver disagreement is a fault in the instrument and
 * reconciling it would be fitting the evidence to the solver choice. About a fifth of generated
 * audits disagree with their check.
 *
 * The audit's PRESENCE is drawn independently of that status too, even though the worker emits
 * one only where the main run was `PASSED`-shaped. The schema permits an audit on any check, the
 * report is untrusted text at a trust boundary, and `interpretFormalReport` is required to be
 * TOTAL over every schema-valid document - so an audit arriving on a `FAILED` check is precisely
 * the malformed-evidence shape the interpreter must handle rather than a document we may assume
 * away.
 */
function crossCheckArbitrary(
  inductionLine: fc.Arbitrary<{ readonly inductionSuccessful?: boolean }>,
): fc.Arbitrary<{ readonly crossCheck?: FormalCrossCheckReport }> {
  const audit = fc
    .tuple(
      fc.constantFrom(...CROSS_CHECK_SOLVERS),
      invocationFieldsArbitrary(),
      tracePathArbitrary(),
      inductionLine,
    )
    .map(([solver, fields, trace, induction]): FormalCrossCheckReport => ({
      solver,
      ...fields,
      ...trace,
      ...induction,
    }));
  return fc.oneof(
    { weight: 2, arbitrary: fc.constant<{ readonly crossCheck?: FormalCrossCheckReport }>({}) },
    { weight: 1, arbitrary: audit.map((crossCheck) => ({ crossCheck })) },
  );
}

/**
 * One `yosys-smtbmc` check, plus only the conditional fields ITS schema slot declares.
 *
 * The conditional fields are parameters rather than branches on a check name, because the schema
 * declares `reachedStep` on the cover alone and `inductionSuccessful` on the induction check
 * alone: a generator that put either field on the wrong check would emit documents
 * `parseFormalReport` REJECTS, and every property that round-trips a generated report through the
 * parse would then hold over a thinned sample instead of failing.
 */
function checkArbitrary(
  conditionalFields: fc.Arbitrary<{
    readonly reachedStep?: number;
    readonly coverAnswered?: boolean;
    readonly inductionSuccessful?: boolean;
  }>,
  crossCheck: fc.Arbitrary<{ readonly crossCheck?: FormalCrossCheckReport }>,
): fc.Arbitrary<FormalCheckReport> {
  return fc
    .tuple(invocationFieldsArbitrary(), tracePathArbitrary(), conditionalFields, crossCheck)
    .map(([fields, trace, conditional, audit]): FormalCheckReport => ({
      ...fields,
      ...trace,
      ...conditional,
      ...audit,
    }));
}

/** Yosys diagnostic tails, including the shapes the sanitizer and the bound exist for. */
const STDERR_TAILS: readonly string[] = Object.freeze([
  '',
  'Warning: Wire dut.cnt is used but has no driver.',
  "ERROR: Module `\\float_multi' contains unmapped cells.",
  '/workspace/job-7f2a/design.v:41: syntax error',
  'ERROR: assertion failed\u0000 in cell $check$1',
]);

/**
 * One lowering report: an exit code and the worker's bounded, path-redacted diagnostic tail.
 *
 * The over-length arm is built with `repeat` rather than a string arbitrary at cap size, which is
 * ruinously slow at this length
 * (`chipAgent/_inbox/gotcha-artifact-sink-property-test-needs-app-test-and-cheap-length-generators.md`).
 * It is here because the tail is re-sanitized and re-bounded on our side of the seam, so a tail
 * longer than `MAX_DIAGNOSTIC_CHARS` is the case that bound exists for.
 */
function loweringArbitrary(): fc.Arbitrary<FormalLoweringReport> {
  const stderrTail = fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...STDERR_TAILS) },
    {
      weight: 1,
      arbitrary: fc
        .integer({ min: 1, max: 64 })
        .map((excess) => 'e'.repeat(MAX_DIAGNOSTIC_CHARS + excess)),
    },
  );
  return fc.record<FormalLoweringReport>({ exitCode: exitCodeArbitrary(), stderrTail });
}

/**
 * An assertion count as the REPORT carries it: a non-negative integer, zero a fifth of the time.
 *
 * Deliberately narrower than `proofAssertionCountArbitrary` and the difference is the schema:
 * `assertionCount` is `{ type: 'integer', minimum: 0 }`, so `NaN` and a negative cannot survive
 * `parseFormalReport` and generating them here would only produce documents the parse refuses.
 * The unusable values belong to `ProofConditions`, whose guard is the thing that catches them.
 */
function reportAssertionCountArbitrary(): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 1, max: MAX_GENERATED_ASSERTION_COUNT }) },
    { weight: 1, arbitrary: fc.constant(0) },
  );
}

/**
 * One `formal-report.json` as the worker writes it, with ALL FOUR CHECKS VARIED INDEPENDENTLY.
 *
 * Every check draws its own exit code, its own `Status:` string, its own elapsed time, its own
 * trace presence, and its own audit, and the assertion count is drawn once for the document. No
 * check's value is derived from another's, which is what makes two combinations GENERATED rather
 * than fixtures:
 *
 *   - AN EXIT CODE THAT DISAGREES WITH ITS `Status:`. About a fifth of checks report `PASSED` at
 *     a non-zero exit.
 *   - A BASE CASE THAT `FAILED` UNDER AN INDUCTION CHECK THAT `PASSED`. About 11% of documents,
 *     and about 4% also carry `inductionSuccessful: true` on that induction check. This is the
 *     measured `bad_init` signature - `initial out = 4'd15` against `out <= 11` reports
 *     `Temporal induction successful` and `Status: PASSED` at depths 5, 20, and 40 while plain
 *     BMC reports `Status: FAILED` at all three - and it is ALSO the signature a wrong derived
 *     reset polarity produces, so the two facts a reader most needs separated arrive in the same
 *     document shape and neither may be unreachable by the generator.
 *
 * The one thing NOT varied independently is which conditional field lands on which check, and
 * `checkArbitrary` records why: the schema declares those per check, so crossing them would only
 * manufacture documents the parse rejects.
 *
 * A property asserting anything about the `bad_init` signature should raise `numRuns` above the
 * shared 100 default: at 100 runs it appears about 11 times, and the `inductionSuccessful` form
 * about 4.
 */
export function arbFormalReport(): fc.Arbitrary<FormalReport> {
  const plainCheck = (): fc.Arbitrary<FormalCheckReport> =>
    checkArbitrary(
      noConditionalFieldArbitrary(),
      crossCheckArbitrary(noConditionalFieldArbitrary()),
    );
  return fc.record<FormalReport>({
    lowering: loweringArbitrary(),
    assertionCount: reportAssertionCountArbitrary(),
    checks: fc.record<FormalChecksReport>({
      presat: plainCheck(),
      base: plainCheck(),
      cover: checkArbitrary(
        coverFieldsArbitrary(),
        crossCheckArbitrary(noConditionalFieldArbitrary()),
      ),
      induct: checkArbitrary(
        inductionSuccessfulArbitrary(),
        crossCheckArbitrary(inductionSuccessfulArbitrary()),
      ),
    }),
  });
}

// ---------------------------------------------------------------------------
// `arbCalibratedMutantPopulation`
// ---------------------------------------------------------------------------

/**
 * Every formal calibration, derived through `@app/eval`'s own verdict-to-calibration mapping.
 *
 * `FormalMutantCalibration` is IMPORTED from `@app/eval` rather than declared here. This module
 * used to declare its own as the template-literal type `` `formal-${FormalVerdict}` ``, with a
 * comment claiming a fourth Formal_Verdict "would widen this type automatically while failing
 * to compile against group 10's total `Record`". That claim was FALSE: two independently
 * declared unions do not interact, so a fourth verdict would have widened only this one and
 * left the eval-side `Record` compiling, total over its own three stale members - the single
 * outcome the derivation existed to prevent
 * (`chipAgent/_inbox/decision-the-formal-calibration-tie-to-formalverdict-lives-in-a-verdict-keyed-record-not-in-the-union.md`).
 *
 * One owner, and the tie is real now: the member list comes from `FORMAL_VERDICTS` through
 * `formalCalibrationOf`, which is TOTAL over `FormalVerdict` in `@app/eval`, so a fourth verdict
 * is a compile error there and this list follows it rather than re-spelling it. `app/test` may
 * import `@app/eval` and this module already does, so nothing about the import direction or the
 * layer boundary changes.
 */
const FORMAL_MUTANT_CALIBRATIONS: readonly FormalMutantCalibration[] = Object.freeze(
  FORMAL_VERDICTS.map((verdict) => formalCalibrationOf(verdict)),
);

/**
 * The ONE calibration that leaves the formal kill-rate denominator, and the one that carries a
 * cause. `satisfies` rather than a bare literal, so a rename of the verdict breaks here.
 */
const FORMAL_UNSCORABLE = 'formal-could-not-verify' satisfies FormalMutantCalibration;

/** A calibration the Formal_Oracle actually reasoned to, so it admits its mutant to the denominator. */
type ScorableCalibration = Exclude<FormalMutantCalibration, typeof FORMAL_UNSCORABLE>;

/** Narrow a calibration to the scorable pair. A predicate, so the filter below keeps the type. */
function isScorableCalibration(
  calibration: FormalMutantCalibration,
): calibration is ScorableCalibration {
  return calibration !== FORMAL_UNSCORABLE;
}

/** The facts every calibrated mutant carries, whatever the Formal_Oracle made of it. */
interface CalibratedMutantFacts {
  readonly identity: MutantIdentity;
  /**
   * The INDEPENDENT judge's own verdict, drawn independently of the formal one.
   *
   * Independent because that is the whole gate: Req 10.2 refuses a Property_Set that returned
   * `formal-proved` for a mutant the independent judge KILLED, so the disagreeing pair has to be
   * a generated case. A generator that derived one from the other could not produce it at all.
   */
  readonly golden: MutantCalibration;
}

/**
 * One mutant, calibrated by the Formal_Oracle and by the independent golden judge.
 *
 * A two-member union rather than one record with an optional `cause`, so an unscorable mutant
 * with NO cause is UNREPRESENTABLE: Property 22 requires every `formal-could-not-verify` mutant
 * to carry its own cause, and an optional field would let the generator satisfy the type while
 * producing exactly the value the property is about.
 */
export type CalibratedMutant =
  | (CalibratedMutantFacts & { readonly formal: ScorableCalibration })
  | (CalibratedMutantFacts & {
      readonly formal: typeof FORMAL_UNSCORABLE;
      readonly cause: CouldNotVerifyCause;
    });

/** Every golden calibration. Total, so a sixth member fails to compile here. */
const GOLDEN_CALIBRATION_VALUES: Readonly<Record<MutantCalibration, true>> = Object.freeze({
  'golden-killed': true,
  'golden-timeout': true,
  'golden-survived': true,
  'non-compiling': true,
  'golden-errored': true,
});

/** Short before/after excerpts, well inside `MAX_SITE_TEXT_CHARS`. The text is not the point. */
const MUTATION_SITE_TEXTS: readonly string[] = Object.freeze([
  '+',
  '-',
  '&',
  '|',
  '<',
  '<=',
  '==',
  '!=',
  "1'b0",
  "1'b1",
]);

/** Highest line and column a generated mutation site sits at; a reference-design-sized file. */
const MAX_SITE_LINE = 200;
const MAX_SITE_COLUMN = 80;

/**
 * One mutant's identity, with `mutantId` DERIVED through `mutantIdOf` rather than string-built.
 *
 * Reusing the real id function is what keeps a population's ids in the same spelling the
 * calibration cache and the report use; a generator that formatted `<operator>@<line>:<column>`
 * itself would be a second owner of that format and would keep passing after the first changed.
 */
function mutantIdentityArbitrary(): fc.Arbitrary<MutantIdentity> {
  return fc
    .record({
      operator: fc.constantFrom(...MUTATION_OPERATORS),
      line: fc.integer({ min: 1, max: MAX_SITE_LINE }),
      column: fc.integer({ min: 1, max: MAX_SITE_COLUMN }),
      before: fc.constantFrom(...MUTATION_SITE_TEXTS),
      after: fc.constantFrom(...MUTATION_SITE_TEXTS),
    })
    .map(({ operator, line, column, before, after }): MutantIdentity => {
      const site: MutationSite = { line, column, before, after };
      return { mutantId: mutantIdOf(operator, site), operator, site };
    });
}

/** How much likelier a mutant the oracle REASONED about is than one it could not. */
const SCORABLE_CALIBRATION_WEIGHT = 2;

/** One calibrated mutant: the facts, plus the formal arm and the cause that arm requires. */
function calibratedMutantArbitrary(): fc.Arbitrary<CalibratedMutant> {
  const facts = fc.record<CalibratedMutantFacts>({
    identity: mutantIdentityArbitrary(),
    golden: fc.constantFrom(...membersOf(GOLDEN_CALIBRATION_VALUES)),
  });
  const scorable = fc
    .tuple(facts, fc.constantFrom(...FORMAL_MUTANT_CALIBRATIONS.filter(isScorableCalibration)))
    .map(([base, formal]): CalibratedMutant => ({ ...base, formal }));
  const unscorable = fc
    .tuple(facts, fc.constantFrom(...COULD_NOT_VERIFY_CAUSES))
    .map(([base, cause]): CalibratedMutant => ({ ...base, formal: FORMAL_UNSCORABLE, cause }));
  return fc.oneof(
    { weight: SCORABLE_CALIBRATION_WEIGHT, arbitrary: scorable },
    { weight: 1, arbitrary: unscorable },
  );
}

/** Largest generated population. The real cap is `DEFAULT_MAX_MUTANTS_PER_PROBLEM` (24). */
const MAX_POPULATION_SIZE = 12;

/**
 * A population of calibrated mutants, mixing all three formal calibrations with the independent
 * judge's own verdict.
 *
 * EMPTY POPULATIONS ARE IN RANGE. Group 10's counts have to partition a population of zero, and
 * `judgeCoverageGaps` already carries a `no-valid-mutants` member for exactly that case, so a
 * generator with `minLength: 1` would leave the degenerate row - where "our Property_Set killed
 * every mutant the judge killed" is VACUOUSLY true - reachable only by a fixture.
 *
 * IDS ARE UNIQUE ACROSS A POPULATION, because a real mutant set is keyed by `mutantId`: the id is
 * derived from the operator and the site and is stable across runs, which is what lets the
 * calibration cache be keyed by mutant rather than by ordinal. Two entries sharing an id is a
 * population no reference can produce, and it would make a count-partition property fail for a
 * reason that says nothing about the gate.
 *
 * A single SMALL population does not contain all three calibrations, and that is correct - the
 * properties are over ANY population, including one that is entirely unscorable. It is across the
 * sample that all three appear; about a third of mutants are `formal-could-not-verify`, which is
 * higher than any measured rate and is chosen so the excluded-from-the-denominator arm Property
 * 22 is about is common rather than incidental.
 */
export function arbCalibratedMutantPopulation(): fc.Arbitrary<readonly CalibratedMutant[]> {
  return fc.uniqueArray(calibratedMutantArbitrary(), {
    selector: (mutant) => mutant.identity.mutantId,
    minLength: 0,
    maxLength: MAX_POPULATION_SIZE,
  });
}

// ---------------------------------------------------------------------------
// `arbResetContract`
// ---------------------------------------------------------------------------

/** The derived arm of `ResetContract`, named so a total map over `resetKind` can be written. */
type DerivedResetContract = Extract<ResetContract, { readonly derived: true }>;

/** Every derived reset KIND. Total, so a third kind fails to compile here. */
const RESET_KINDS: Readonly<Record<DerivedResetContract['resetKind'], true>> = Object.freeze({
  async: true,
  sync: true,
});

/**
 * Reset port names, drawn from the corpus references the derivation was MEASURED against.
 *
 * `rst_n` is `counter_12`'s active-low async reset, `rst` is `radix2_div`'s active-high sync reset
 * and also `instr_reg`'s active-LOW one - the case that beats a name heuristic - and `Rst` is
 * `LIFObuffer`'s. Real names rather than noise, because this value is spliced into the rendered
 * wrapper's assume, and filtered through `isDialectSafeName` for the reason `SIGNAL_NAMES` is: a
 * name matching a measured rejected form would fail a render property for a reason that says
 * nothing about the renderer.
 */
const RESET_NAMES: readonly string[] = Object.freeze(
  ['rst_n', 'rst', 'Rst', 'reset'].filter(isDialectSafeName),
);

/** How much likelier a DERIVED contract is than a refused one. */
const DERIVED_CONTRACT_WEIGHT = 4;

/**
 * A `ResetContract` as the Reset_Contract_Prepass derives or refuses it.
 *
 * THE DERIVED POLARITY IS GENERATED AND NEVER PINNED, and that is the single most important line in
 * this generator. Property 35 asserts that the emitted assume's reset term is inverted if and only
 * if the derived polarity is ACTIVE-HIGH, so a generator pinning `resetActiveLow` reduces Property
 * 35 to an emission check - it would still assert that an assume appears, over a sample in which
 * only one inversion was ever possible, which is the exact hole Property 35 exists to close. A wrong
 * inversion is MEASURED to arrive as a failing base case over a passing induction check, which is
 * the same signature the `bad_init` false proof produces, so it reaches the student as a refutation
 * of their own design.
 *
 * BOTH RESET KINDS ARE CROSSED AGAINST BOTH INITIAL-STATE SHAPES, drawn independently, so all FOUR
 * rows of Property 31's case table are GENERATED rather than three being reached by accident. The
 * gate is emitted for exactly one of those four rows - synchronous AND free - and the other three
 * are the rows that must render no gate, each for its own measured reason: an async reset has step 0
 * pinned by the unclocked assume in the same step, and a design whose initial state is not free has
 * step 0 pinned by its own `initial` value, where a gate would mask a wrong one.
 *
 * REFUSED CONTRACTS ARE GENERATED TOO, because `renderPropertyWrapper` takes a `ResetContract` and
 * the refusal is representable at that seam rather than thrown; a generator that only produced
 * derived contracts would leave the renderer's behaviour on the refused member unasserted.
 *
 * THE ARITHMETIC, so a consumer sizes `numRuns` instead of guessing. A contract is derived on 4 of 5
 * cases, and within those the kind, the polarity, and the initial-state shape are three independent
 * fair coins, so each of the EIGHT derived combinations is 0.8 / 8 = 10% and each of Property 31's
 * FOUR rows is 20%. The rarest required shape is therefore 10%: at the self-check's 500 samples the
 * chance of missing one is `(1 - 0.1)^500` ~ 1.3e-23, and at the shared 100-run default it is
 * ~2.7e-5, so a property over the full cross is sound at either size. A refused contract is 20%.
 */
export function arbResetContract(): fc.Arbitrary<ResetContract> {
  const derived = fc
    .record<Omit<DerivedResetContract, 'derived'>>({
      resetName: fc.constantFrom(...RESET_NAMES),
      resetActiveLow: fc.boolean(),
      resetKind: fc.constantFrom(...membersOf(RESET_KINDS)),
      initialStateFree: fc.boolean(),
    })
    .map((fields): ResetContract => ({ derived: true, ...fields }));
  return fc.oneof(
    { weight: DERIVED_CONTRACT_WEIGHT, arbitrary: derived },
    { weight: 1, arbitrary: fc.constant<ResetContract>({ derived: false }) },
  );
}

// ---------------------------------------------------------------------------
// `arbInitialStatePredicate`
// ---------------------------------------------------------------------------

/**
 * Initial-state predicate bodies that PIN at least one state bit, so the initial state is not free.
 *
 * Shaped like what `write_smt2` emits for a design carrying an `initial` value - 6 of 50 corpus
 * references do - which is a `(= ...)` equality, or an `(and ...)` of them when several registers
 * are pinned. `false` and `TRUE` are in the list on purpose and neither is filler: `false` is a
 * legitimate SMT-LIB literal that is NOT the free one, and `TRUE` is the value a case-INSENSITIVE
 * read would accept as free, which is the same trap `'passed'` guards in `UNRECOGNIZED_STATUS_LINES`.
 * Both are balanced and non-empty, so both must read as a predicate that is not free rather than as
 * unparseable.
 */
const PINNED_INITIAL_STATE_PREDICATES: readonly string[] = Object.freeze([
  '(= ((|counter_12_n out| state)) #b1111)',
  '(and (= ((|m_n a| state)) #b0) (= ((|m_n b| state)) #b1))',
  '(and (= ((|acc_n sum| state)) #b00000000))',
  'false',
  'TRUE',
]);

/**
 * Predicate bodies that cannot be read as a predicate at all, in the two shapes that arise.
 *
 * EMPTY AFTER TRIMMING is what a `define-fun` whose body the worker's scan consumed nothing of
 * leaves behind. PARENTHESIS-UNBALANCED is what a truncated or garbled SMT2 leaves: the worker's own
 * reader balances parentheses and returns nothing when the scan runs off the end, so an unbalanced
 * body is precisely the shape that arrives when the file it came from was cut short. Both close and
 * open directions are generated, because a reader counting only depth-at-end would admit a stray
 * leading `)`.
 */
const UNPARSEABLE_INITIAL_STATE_PREDICATES: readonly string[] = Object.freeze([
  '',
  '   ',
  '\n\t ',
  '(and (= ((|m_n q| state)) #b0)',
  '(= ((|m_n q| state)) #b0',
  'true)',
  ')(',
]);

/** How much likelier each READABLE arm is than the absent one. */
const READABLE_PREDICATE_WEIGHT = 3;

/**
 * The `initialStatePredicate` field of a pre-pass report, across all four shapes it can take.
 *
 * FOUR ARMS, and the two refusing ones are SEPARATE arms rather than one, because they refuse for
 * different reasons and a generator that produced only `null` would leave the UNPARSEABLE path
 * untested while every outcome-level assertion still passed. `null` is the worker saying it could not
 * read a predicate - an absent `define-fun`, a scan that ran off the end, or a body past its own
 * 4096-character bound - and a non-null-but-unreadable body is this side's own refusal at the trust
 * boundary.
 *
 * NO EXPECTED-OUTCOME TAG IS CARRIED. The generator yields the raw field value and nothing else, so a
 * property over it computes the expectation from the rule under test rather than from a label this
 * file attached; a tagged generator would make `app/test` a second owner of the free-initial-state
 * rule and the property would then assert the generator against itself.
 *
 * Why the refusal is FORCED rather than chosen, recorded here because it is the reason the third
 * outcome exists: both defaults are unsafe in OPPOSITE directions. Defaulting to free emits the
 * `if (!$initstate)` gate on a design whose step 0 is PINNED, masking a wrong `initial` value, which
 * is the false-proof direction the `bad_init` control exists to catch; defaulting to not free
 * suppresses the gate on a design whose step 0 is a free-variable artifact, failing a correct
 * sync-reset design's base case, which is the false-refutation direction.
 *
 * THE ARITHMETIC. Weights are 2 for absent and 3 for each of the three readable arms, so the total is
 * 11 and the rarest required shape is ABSENT at 2/11 ~ 18.2%. At the self-check's 500 samples the
 * chance of missing it is `(1 - 0.182)^500` ~ 4e-44, and at the shared 100-run default ~2e-9, so
 * either size carries all four shapes. The literal `true` - the only value that yields a FREE initial
 * state, and therefore the only one that reaches the gate's emitting row - is 3/11 ~ 27%.
 */
export function arbInitialStatePredicate(): fc.Arbitrary<string | null> {
  return fc.oneof(
    // ABSENT: the worker read no predicate, and `json.dumps` writes the key as `null`.
    { weight: 2, arbitrary: fc.constant<string | null>(null) },
    // The literal `true`: every state bit starts free, because a register with no init value
    // contributes no equality to the predicate. Generated with the surrounding whitespace a reader
    // must trim, so a comparison written against the untrimmed text fails here.
    {
      weight: READABLE_PREDICATE_WEIGHT,
      arbitrary: fc.constantFrom<string | null>('true', ' true', 'true\n', '  true  '),
    },
    {
      weight: READABLE_PREDICATE_WEIGHT,
      arbitrary: fc.constantFrom<string | null>(...PINNED_INITIAL_STATE_PREDICATES),
    },
    {
      weight: READABLE_PREDICATE_WEIGHT,
      arbitrary: fc.constantFrom<string | null>(...UNPARSEABLE_INITIAL_STATE_PREDICATES),
    },
  );
}

// ---------------------------------------------------------------------------
// `arbFormalProvenance` and the field generators it rests on
// ---------------------------------------------------------------------------

/**
 * A `ResetContract` as a `FormalProvenance` carries it: derived, refused, or ABSENT.
 *
 * A SEPARATE generator rather than a `null` arm added to `arbResetContract()`, and the reason is a
 * type boundary rather than taste: `arbResetContract()`'s return type is the type
 * `renderPropertyWrapper` takes as its fourth parameter, and `null` is not a member of it. Widening
 * that generator would either force every render property to filter the arm out or, worse, make the
 * renderer's parameter type look nullable when it is not.
 *
 * THE THIRD ARM IS THE POINT. `null` means the pre-pass was NEVER REACHED - a killed or missing
 * invocation, a frontend rejection, or the product path - and `{ derived: false }` means it RAN and
 * REFUSED. They are different facts, and a generator producing only the two `arbResetContract()`
 * arms would leave every property over the record asserting nothing about the distinction design.md
 * requires to survive encode and decode as a distinct value.
 *
 * THE ARITHMETIC. Absent is 1 of 5, so `arbResetContract()`'s own shares scale by 4/5: a derived
 * contract is 64%, each of its eight kind-by-polarity-by-initial-state combinations 8%, the refused
 * arm 16%, and absent 20%. The rarest required shape is therefore 8%: at 500 samples the chance of
 * missing one is `(1 - 0.08)^500` ~ 7e-19, and at the shared 100-run default ~2.4e-4.
 */
export function arbResetContractOrAbsent(): fc.Arbitrary<ResetContract | null> {
  return fc.oneof(
    { weight: 4, arbitrary: arbResetContract() },
    { weight: 1, arbitrary: fc.constant<ResetContract | null>(null) },
  );
}

/**
 * A `clockPolarity` as a `FormalProvenance` carries it: one of the four members, or ABSENT.
 *
 * FIVE VALUES, and `null` is NOT `'none'`. `'none'` is the SUPPORTED no-clocked-state finding - 15
 * of 50 corpus references - so collapsing an absent reading into it would record a clock contract
 * the run was never taken under. Any property that reads this field has to be able to tell the two
 * apart, which it cannot do over a sample that contains only one of them.
 *
 * The member list is spread from `CLOCK_POLARITIES` rather than restated, so a fifth member is
 * generated the moment it is added to the vocabulary instead of leaving this generator silently one
 * value short. Weights are uniform: no arm here is rarer than 1/5, so the shared 100-run default
 * carries all five (missing one is `(1 - 0.2)^100` ~ 2e-10).
 */
export function arbClockPolarityOrAbsent(): fc.Arbitrary<ClockPolarity | null> {
  return fc.constantFrom<ClockPolarity | null>(...CLOCK_POLARITIES, null);
}

/**
 * Property_Wrapper sources in the shape the adapter submits them: a module under the adapter's own
 * name, one per criterion so two entries are told apart by equality and a mispairing is visible.
 *
 * A fixed pool rather than a render through `renderPropertyWrapper`, because no consumer of a
 * `FormalProvenance` reads the wrapper's CONTENT - the Artifact_Sink bounds and copies it - so a
 * render would couple every record-level property to the renderer for no assertion it could make.
 */
const PROPERTY_WRAPPER_SOURCES: readonly string[] = Object.freeze(
  CRITERION_REFS.map(
    (criterionRef) =>
      `module ${PROPERTY_WRAPPER_MODULE_NAME}(input clk);\n  // ${criterionRef}\nendmodule\n`,
  ),
);

/**
 * One `propertyWrapperSources` entry: the submitted source, or ABSENT.
 *
 * `null` is "no wrapper was rendered for this property" - its pre-pass refused, or the port threw -
 * and it is a quarter of the entries, so at the self-check's 500 samples both arms are certain.
 */
function propertyWrapperSourceOrAbsentArbitrary(): fc.Arbitrary<string | null> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom<string | null>(...PROPERTY_WRAPPER_SOURCES) },
    { weight: 1, arbitrary: fc.constant<string | null>(null) },
  );
}

/** Counterexample VCD names, in the shape the worker registers them under. */
const COUNTEREXAMPLE_NAMES: readonly string[] = Object.freeze([
  'formal-trace-base-bitwuzla.vcd',
  'formal-trace-cover-bitwuzla.vcd',
]);

/** A registered counterexample blob reference, as a `refuted` result carries it (Req 1.10). */
function counterexampleArbitrary(): fc.Arbitrary<ArtifactBlobRef> {
  return fc
    .tuple(
      fc.constantFrom(...COUNTEREXAMPLE_NAMES),
      fc.integer({ min: 1, max: 65_536 }),
      fc.constantFrom('0', '9', 'a', 'f'),
    )
    .map(([name, sizeBytes, digit]): ArtifactBlobRef => ({
      name,
      sizeBytes,
      sha256: digit.repeat(64),
    }));
}

/** The three reasons the Formal_Oracle could not read a trace whole, as it reports them. */
const COUNTEREXAMPLE_REFUSALS: readonly CounterexampleRefusal[] = Object.freeze([
  'over-cap',
  'unresolved',
  'read-failed',
]);

/**
 * One `counterexampleCaptures` entry: the trace, one of the three refusals, the
 * malformed-reference marker, or ABSENT.
 *
 * ALL FOUR PRESENT SHAPES PLUS `null`, in roughly even weight, because they are the four notes a
 * reader of this field has to tell apart plus the one state that is NOT a note: `null` means "this
 * result is not `refuted`, so there is no counterexample", and the marker means "it IS `refuted`
 * and the evidence cannot be located". A generator missing the marker would leave every property
 * asserting that distinction unable to draw the record it exists to refuse, while still reporting
 * green - the trap `arbFormalProvenance`'s own header names.
 *
 * The `trace` text is a fixed short VCD-shaped string rather than generated bytes: no consumer of
 * a `FormalProvenance` reads its content - the Artifact_Sink hashes and copies it - so generating
 * it would couple every record-level property to a format for no assertion it could make.
 */
function recordedCaptureOrAbsentArbitrary(): fc.Arbitrary<RecordedCounterexampleCapture | null> {
  return fc.oneof(
    counterexampleArbitrary().map((reference): RecordedCounterexampleCapture | null => ({
      kind: 'trace',
      reference,
      trace: '$date generated $end\n$enddefinitions $end\n#0\n',
    })),
    fc
      .tuple(counterexampleArbitrary(), fc.constantFrom(...COUNTEREXAMPLE_REFUSALS))
      .map(([reference, refusal]): RecordedCounterexampleCapture | null => ({
        kind: 'refused',
        reference,
        refusal,
      })),
    fc.constant<RecordedCounterexampleCapture | null>({ kind: 'malformed-reference' }),
    fc.constant<RecordedCounterexampleCapture | null>(null),
  );
}

/** The Proof_Depths the ladder can report: the combinational rung, then the three clocked ones. */
const GENERATED_PROOF_DEPTHS: readonly number[] = Object.freeze([1, 20, 40, 80]);

/**
 * One `PropertyResult`, across all three Formal_Verdicts.
 *
 * The `proved` and `could-not-verify` arms are built by putting generated `ProofConditions` through
 * `admitProved`, which is the SOLE constructor of `ProvedEvidence` and the single owner of the
 * five-condition rule. Assembling either arm here by hand would make `app/test` a second owner of
 * that rule, and the brand exists precisely to make that impossible without a cast.
 *
 * The `refuted` arm is its own arm because `admitProved` cannot return it: a refutation carries a
 * Counterexample, which lives on the run rather than in any condition, so only the interpreter can
 * report it (see `BASE_FAILURE_CAUSE`'s comment). Its `conditions` are left unconstrained on
 * purpose - the interpreter's own properties assert which conditions a refutation is sourced from,
 * and constraining them here would make this generator assert that rule against itself.
 */
export function arbPropertyResult(): fc.Arbitrary<PropertyResult> {
  const shared = {
    depth: fc.constantFrom(...GENERATED_PROOF_DEPTHS),
    elapsedMs: fc.integer({ min: 0, max: 900_000 }),
    criterionRef: fc.constantFrom(...CRITERION_REFS),
  };
  const fromConditions = fc
    .record({ ...shared, conditions: arbProofConditions() })
    .map((fields): PropertyResult => {
      const admitted = admitProved(fields.conditions);
      if (typeof admitted === 'string') {
        // `admitProved` names a gate condition, never a solver disagreement, so no audit disagreed.
        return {
          verdict: 'could-not-verify',
          cause: admitted,
          ...fields,
          diagnostic: null,
          crossCheckDisagreed: false,
        };
      }
      // The three shared fields are named rather than spread from an omit-a-key destructure:
      // typescript-eslint's `no-unused-vars` defaults `ignoreRestSiblings` to FALSE, so the
      // discarded binding is an error here
      // (`chipAgent/_inbox/gotcha-eslint-ignore-rest-siblings-defaults-false.md`). A `proved`
      // result carries `evidence` INSTEAD of `conditions`, so the omission is the point.
      return {
        verdict: 'proved',
        evidence: admitted,
        depth: fields.depth,
        elapsedMs: fields.elapsedMs,
        criterionRef: fields.criterionRef,
      };
    });
  const refuted = fc
    .record({
      ...shared,
      conditions: arbProofConditions(),
      counterexample: counterexampleArbitrary(),
    })
    .map((fields): PropertyResult => ({ verdict: 'refuted', ...fields }));
  return fc.oneof({ weight: 2, arbitrary: fromConditions }, { weight: 1, arbitrary: refuted });
}

/**
 * A `FormalProvenance` as a terminal outcome carries it (task 8.2).
 *
 * EVERY FIELD IS GENERATED AND NOTHING IS PINNED TO A DEFAULT, except the one build constant, and
 * that is the whole reason this generator exists rather than a shared fixture. design.md's testing
 * strategy names the trap by the case that produced it: when `NormalizationProvenance` became
 * required, a pinned default would have silently weakened every property that varies it, because a
 * property over a pinned field asserts only the pinned case while still reporting green.
 *
 * `formalOracleVersion` is the exception and is read from the build constant rather than generated.
 * It is not a degree of freedom: exactly one value of it can exist in a given build, so a generated
 * version would produce records that cannot occur and any property reading it would be asserting
 * something about a value the product can never emit.
 *
 * THE `fallbackReason` IFF IS DELIBERATELY NOT ENFORCED HERE. design.md states that the field is
 * present if and only if the sample was decided by the Simulation_Fallback, which couples it to
 * `results` carrying a `could-not-verify` verdict. That coupling is exactly what task 8.4's
 * Property 20 asserts, so a generator that pre-established it would make that property vacuous -
 * it would pass over a sample in which no violating record could ever be drawn. Consumers that need
 * the consistent pairing build it from these parts; this generator supplies the full cross.
 */
export function arbFormalProvenance(): fc.Arbitrary<FormalProvenance> {
  return fc.record<FormalProvenance>({
    // Zero-length included: a sample that submitted no property carries no result, and that is a
    // real state rather than a placeholder for one.
    results: fc.array(arbPropertyResult(), { minLength: 0, maxLength: 3 }),
    // All FOUR members, spread from the vocabulary rather than restated, so a fifth member
    // fails to compile here instead of silently going ungenerated. The three ways this can
    // be got wrong are all conflations: `'not-gated'` is "no gate ran", `'no-gate-set'` is
    // "the gate ran and had nothing to test", and `'refused'` is "the gate ran and found a
    // demonstrated weakness" - a generator missing any of them leaves every record-level
    // property unable to tell those facts apart while still reporting green.
    propertySetAdmitted: fc.constantFrom<PropertySetAdmissionOutcome>(
      ...PROPERTY_SET_ADMISSION_OUTCOMES,
    ),
    unexpressedCriteria: fc.uniqueArray(fc.constantFrom(...CRITERION_REFS), {
      minLength: 0,
      maxLength: 3,
    }),
    fallbackReason: fc.oneof(
      fc.constant<CouldNotVerifyCause | null>(null),
      fc.constantFrom<CouldNotVerifyCause | null>(...COULD_NOT_VERIFY_CAUSES),
    ),
    // All FOUR routes, spread from the vocabulary rather than restated, so a fifth member
    // fails to compile here instead of going ungenerated. Drawn INDEPENDENTLY of
    // `fallbackReason` above for the same reason that field's own iff is not enforced here:
    // Req 7.19 couples the two - a reason exactly on `'cause'` - and a generator that
    // pre-established the coupling would leave every property asserting it vacuous, unable
    // to draw the violating record it exists to refuse.
    fallbackRoute: fc.constantFrom<FallbackRoute>(...FALLBACK_ROUTES),
    // Each entry PRESENT or ABSENT, and the list's length drawn independently of `results` - the
    // full cross, for the reason the `fallbackReason` iff is not enforced above. One entry per
    // result is the adapter's contract, but the pairing is BY INDEX across a caller-implementable
    // port, so a list of another length is a reachable state the Artifact_Sink must read as "no
    // wrapper" rather than mispair, and a generator that pre-aligned the two would leave that
    // guard's property unable to fail.
    propertyWrapperSources: fc.array(propertyWrapperSourceOrAbsentArbitrary(), {
      minLength: 0,
      maxLength: 3,
    }),
    // Each entry one of the four notes or ABSENT, and the list's length drawn independently of
    // `results`, by the rule `propertyWrapperSources` above follows: the pairing is BY INDEX
    // across a caller-implementable port, so a list of another length is a reachable state the
    // Artifact_Sink must read as "no capture" rather than mispair. The verdict coupling
    // `recordedCaptureOf` enforces - `null` exactly where a result is not `refuted` - is NOT
    // pre-established here for the same reason the `fallbackReason` iff is not: a generator that
    // established it would leave the property asserting it vacuous.
    counterexampleCaptures: fc.array(recordedCaptureOrAbsentArbitrary(), {
      minLength: 0,
      maxLength: 3,
    }),
    resetContract: arbResetContractOrAbsent(),
    assertionGateEmitted: fc.boolean(),
    clockPolarity: arbClockPolarityOrAbsent(),
    formalOracleVersion: fc.constant(FORMAL_ORACLE_VERSION),
  });
}
