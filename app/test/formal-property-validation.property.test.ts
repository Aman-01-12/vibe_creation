// formal-property-oracle, Property 15: Validation accepts only dialect members, rewrites nothing,
// and names what it rejects (task 3.4).
//
// THE ONE PART OF THE TASK TEXT THAT IS FALSE, AND WHAT REPLACES IT
//   tasks.md asks for "a rejection always names a construct". Asserted as written that FAILS, and
//   it should: only ONE of `PropertyRejection`'s four members carries a `construct` field.
//   `unbalanced-expression` and `expression-too-long` are whole-text verdicts with no single
//   offending token to point at, and `empty-expression` deliberately has nothing to name at all -
//   a validator that invented a construct name for empty input would be making one up. So the
//   claim is restated in three parts that are each true and strictly sharper where it counts:
//
//     A. REASONS ARE A CLOSED SET. Every rejection's `reason` is one of the FOUR declared members
//        and nothing else. Asserted at runtime against `DECLARED_REASONS`, whose total `Record`
//        keying makes a fifth union member a COMPILE error here rather than a silently untested
//        one (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`
//        is this repository's own record of a generator that stopped covering a widened union while
//        staying green).
//
//     B. THE ONE MEMBER THAT NAMES SOMETHING NAMES IT USABLY. Every `unaccepted-construct`
//        rejection carries a NON-EMPTY, printable-ASCII, length-bounded `construct`, because that
//        name flows into the diagnostic the Property_Author reads to report an acceptance criterion
//        as unexpressed (Req 6.7). An untrusted expression can carry NUL bytes, control characters,
//        and lone surrogates, so "printable" is a property of the OUTPUT, asserted over an input
//        sample that contains all three.
//
//     C. A GENERIC REJECTION FOR A MEASURED FORM IS A DEFECT. Text carrying a measured rejected
//        form IN CODE is rejected as `unaccepted-construct` naming THAT form - never as
//        `unbalanced-expression`, never as a different row of the table, never as a bare token
//        fragment like `|` for `|->` or `[` for `[*`. The expected name is read off
//        `MEASURED_REJECTED_FORMS` in table order, which is the order the validator itself resolves
//        in, so a thirteenth measured row is covered the moment it lands rather than needing this
//        file edited.
//
// THE CASE THAT MATTERS MOST: A FORM INSIDE A NON-CODE SPAN IS NOT THAT FORM
//   `a && b // was a |-> b` must be refused as `comment`, NEVER as `|->`. Both halves are asserted:
//   the SPAN is named (`comment` / `string-literal` / `compiler-directive`), and the construct the
//   span contains is NOT named. This is the whole reason `validateExpression` reuses `scanSource`
//   instead of scanning raw text, and a prior session measured a CONFIRMED FALSE REWRITE from
//   getting it wrong
//   (`chipAgent/_inbox/pattern-verilog-adjacency-scans-must-continue-past-non-code-spans.md`).
//   The span opener is located here by a four-line scanner of this file's own rather than by calling
//   `scanSource`, so the claim is checked against an independent reading of the text instead of
//   against the same helper the validator used to reach its answer.
//
// THREE CLAIMS THAT RIDE ON THE SAME SAMPLE
//   NEVER THROWS (Req 6.9). Every call is wrapped, and a throw is turned into a FAILING CASE with
//   fast-check's shrinking rather than escaping as an unhandled error. The adversarial arm of
//   `arbPropertyText()` - NUL, control characters, a lone surrogate, and over-length text - is what
//   makes this more than a formality.
//
//   BYTE-IDENTICAL ON ACCEPTANCE (Req 6.10). The accepted value is compared with `===` against the
//   input string, not "equal after trim": repairing a property is writing a property, and this
//   module does not write properties.
//
//   DETERMINISTIC AND PURE (Req 6.9). Validating the same text twice yields the same result. Cheap,
//   and it is exactly the shared-`lastIndex` class of bug the vault records: a `/g` regex object
//   carries mutable state between calls and has hung this repository's whole vitest suite once
//   (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`), so a second call
//   that starts mid-string would disagree with the first.
//
// NON-VACUITY
//   Every claim above holds trivially over a sample that lacks the shape it is about, so the shares
//   and counts below are ASSERTED: accepted cases, `unaccepted-construct` cases, non-code-span cases
//   (each of the three span kinds), span cases that actually CONTAIN a measured form, and each of
//   the four declared reasons observed at least once - iterated from `DECLARED_REASONS` so a new
//   member forces the generator to grow too. The strongest one is last: EVERY row of
//   `MEASURED_REJECTED_FORMS` was generated at least once in code position AND correctly named,
//   derived from the table rather than from a copy of it.
//
//   RUN COUNT: 2000, not the shared 100. The injected-form arm of `arbPropertyText()` carries weight
//   5 of 13 and then picks uniformly from a TWELVE-row table, so one row is roughly 3.2% of cases
//   and at 100 runs the chance of missing at least one row is about 38% - a flaky test, or a
//   weakened claim. The rarest required shape overall is `empty-expression` at about 2.3%
//   (weight 3 of 13, then 1 of 10 inner arms); at 2000 runs its miss probability is under 1e-15.
//   Raising the runs keeps the every-row claim intact instead of trading it for speed. The whole
//   property is pure string work, so 2000 runs costs a fraction of a second.
//
// AND ONE REGRESSION PIN BESIDE THE PROPERTY (task 3.7)
//   The second `describe` holds `.` OUTSIDE the accepted operator set, refuses every hierarchical
//   path BY NAME, pins the guard comment's stated reason, and records the measured system-function
//   accept list. It is a pin rather than a preference because a hierarchical path is a MEASURED
//   silent false proof; the measurement is in the comment above that block.
//
// The tag string is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to
// a different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 6.6, 6.7, 6.8, 6.10

import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Result } from '@app/core';
import {
  MAX_CONSTRUCT_CHARS,
  MAX_EXPRESSION_CHARS,
  MEASURED_REJECTED_FORMS,
  validateExpression,
  type MeasuredRejectedForm,
  type PropertyRejection,
  type ValidatedExpression,
} from '@app/tools';

import { arbPropertyText } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-property-oracle, Property 15: Validation accepts only dialect members, rewrites nothing, and names what it rejects';

/** See the RUN COUNT note in the header: 100 runs cannot cover a twelve-row table reliably. */
const NUM_RUNS = 2_000;

/** The minimum share of cases each of the three high-weight shapes must reach. */
const MIN_SHAPE_SHARE = 0.05;

/**
 * The declared members of `PropertyRejection['reason']`, as a TOTAL record over the union.
 *
 * The record type is the point: a fifth member added to `PropertyRejection` makes this object fail
 * to type-check, so claim A cannot silently stop covering the union the way a hand-written literal
 * array would. The runtime key list is derived from it rather than written twice.
 */
const DECLARED_REASONS: Readonly<Record<PropertyRejection['reason'], true>> = {
  'unaccepted-construct': true,
  'unbalanced-expression': true,
  'expression-too-long': true,
  'empty-expression': true,
};

const DECLARED_REASON_NAMES: readonly PropertyRejection['reason'][] = Object.keys(
  DECLARED_REASONS,
) as PropertyRejection['reason'][];

/** Every measured form's construct name, read from the table rather than restated. */
const MEASURED_CONSTRUCT_NAMES: readonly string[] = Object.freeze(
  MEASURED_REJECTED_FORMS.map((form) => form.construct),
);

/** The kinds of non-code span the validator names, and the names it reports for them. */
type NonCodeSpanKind = 'comment' | 'string-literal' | 'compiler-directive';

const NON_CODE_SPAN_KINDS: readonly NonCodeSpanKind[] = Object.freeze<NonCodeSpanKind[]>([
  'comment',
  'string-literal',
  'compiler-directive',
]);

/**
 * The first non-code span opener in `text`, or `null` when every offset is code.
 *
 * Deliberately NOT `scanSource`: the validator reached its answer through that scanner, so reading
 * the span back out of it would compare the implementation against itself. This is an independent
 * four-case reading of the same text, and it is sound over this sample because the only `/`, `"`,
 * and backtick characters `arbPropertyText()` produces are the span openers it plants - a lone `/`
 * is the division operator and opens nothing, which is why the comment case tests two characters.
 */
function firstNonCodeSpan(
  text: string,
): { readonly kind: NonCodeSpanKind; readonly offset: number } | null {
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    const next = text.charAt(index + 1);
    if (character === '/' && (next === '/' || next === '*')) {
      return { kind: 'comment', offset: index };
    }
    if (character === '"') {
      return { kind: 'string-literal', offset: index };
    }
    if (character === '`') {
      return { kind: 'compiler-directive', offset: index };
    }
  }
  return null;
}

/**
 * The offsets of every occurrence of `form` in `text`.
 *
 * The global regex is built FRESH per call from the table's non-global `pattern.source`, and this
 * object must never be hoisted to module scope: a shared `/g` regex carries mutable `lastIndex`
 * between callers and has hung this repository's whole vitest suite once
 * (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`). No pattern in the
 * table can match the empty string, so the scan always advances.
 */
function occurrenceOffsets(text: string, form: MeasuredRejectedForm): readonly number[] {
  const scanner = new RegExp(form.pattern.source, 'g');
  return [...text.matchAll(scanner)].map((match) => match.index);
}

/** Every measured form present at least once in `text`, IN TABLE ORDER. */
function measuredFormsPresent(text: string): readonly MeasuredRejectedForm[] {
  return MEASURED_REJECTED_FORMS.filter((form) => occurrenceOffsets(text, form).length > 0);
}

/** Whether every code point of `text` is printable ASCII, so a lone surrogate fails. */
function isPrintableAscii(text: string): boolean {
  for (const character of text) {
    if (character < ' ' || character > '~') {
      return false;
    }
  }
  return true;
}

/**
 * Validate `text`, failing the CASE rather than the run if the validator throws (Req 6.9).
 *
 * A throw inside a fast-check predicate is reported as a failing case and shrunk, so this both
 * satisfies the never-throws claim and names the input that broke it, instead of escaping the
 * property as an unhandled error.
 */
function validateWithoutThrowing(text: string): Result<ValidatedExpression, PropertyRejection> {
  try {
    return validateExpression(text);
  } catch (cause) {
    throw new Error(
      `validateExpression threw on ${JSON.stringify(text)}, but Req 6.9 requires it never to: ` +
        String(cause),
    );
  }
}

/**
 * The named construct, or a failing case naming the reason that was reported instead.
 *
 * There is no companion "expect a rejection" helper because an accepted case never reaches here:
 * the accept branch asserts that the text carries no measured form and opens no span, so a span
 * case or a measured-form case that were wrongly ACCEPTED fails there instead.
 */
function expectNamedConstruct(rejection: PropertyRejection, text: string): string {
  if (rejection.reason !== 'unaccepted-construct') {
    throw new Error(
      `expected \`unaccepted-construct\` for ${JSON.stringify(text)}, got \`${rejection.reason}\`; ` +
        `a generic rejection for text whose offending construct IS identifiable is the defect ` +
        `Req 6.7 exists to prevent`,
    );
  }
  return rejection.construct;
}

/** A counter per key, so a shape's coverage is read off the sample rather than assumed. */
function tally<Key>(counts: Map<Key, number>, key: Key): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

describe(PROPERTY, () => {
  it('accepts byte-identically, closes its reason set, and names the construct it refuses', () => {
    let total = 0;
    let accepted = 0;
    let unacceptedConstruct = 0;
    let nonCodeSpanCases = 0;
    let spanCasesCarryingAContainedForm = 0;
    const reasonCounts = new Map<PropertyRejection['reason'], number>();
    const spanKindCounts = new Map<NonCodeSpanKind, number>();
    const namedInCodeCounts = new Map<string, number>();

    fc.assert(
      fc.property(arbPropertyText(), (text: string) => {
        total += 1;

        // Req 6.9: never throws, on any input, including NUL, a control character, a lone
        // surrogate, and text past the length bound.
        const result = validateWithoutThrowing(text);

        // Req 6.9: deterministic and pure. A `/g` regex leaking `lastIndex` between calls would
        // make the second answer disagree with the first.
        expect(validateWithoutThrowing(text)).toEqual(result);

        const span = firstNonCodeSpan(text);
        const formsPresent = measuredFormsPresent(text);

        if (result.ok) {
          accepted += 1;
          // Req 6.10: BYTE-identical, `===` on the string and not "equal after trim". No repair,
          // no normalization, no rewrite.
          expect({ identical: result.value === text, value: result.value }).toEqual({
            identical: true,
            value: text,
          });
          // Req 6.6: an accepted expression is inside the dialect, so it carries no measured
          // rejected form, opens no non-code span, and sits within the length bound.
          expect(formsPresent.map((form) => form.construct)).toEqual([]);
          expect(span).toBeNull();
          expect(text.length).toBeLessThanOrEqual(MAX_EXPRESSION_CHARS);
          return;
        }

        const rejection = result.error;

        // Claim A: the reason is one of the four declared members and nothing else.
        expect(DECLARED_REASON_NAMES).toContain(rejection.reason);
        tally(reasonCounts, rejection.reason);

        // Claim B: the one member that names something names it usably. `construct` flows into a
        // diagnostic, so it must be non-empty, printable, and bounded.
        if (rejection.reason === 'unaccepted-construct') {
          unacceptedConstruct += 1;
          const { construct } = rejection;
          expect({
            construct,
            nonEmpty: construct.length > 0,
            printable: isPrintableAscii(construct),
            withinBound: construct.length <= MAX_CONSTRUCT_CHARS,
          }).toEqual({ construct, nonEmpty: true, printable: true, withinBound: true });
        }

        // THE CASE THAT MATTERS MOST. A measured form inside a comment, a block comment, a string
        // literal, or a compiler directive is not that form: the SPAN is named, and the construct
        // the span contains is NEVER named.
        if (span !== null) {
          nonCodeSpanCases += 1;
          tally(spanKindCounts, span.kind);
          const construct = expectNamedConstruct(rejection, text);
          expect({ construct, reportedTheSpan: construct === span.kind }).toEqual({
            construct,
            reportedTheSpan: true,
          });
          expect(MEASURED_CONSTRUCT_NAMES).not.toContain(construct);
          // Only count this case as covering the claim when a form really is inside the span,
          // rather than in code beside one; otherwise "the contained form is not named" would be
          // tallied over cases that contain nothing.
          const everyOccurrenceInsideTheSpan =
            formsPresent.length > 0 &&
            formsPresent.every((form) =>
              occurrenceOffsets(text, form).every((offset) => offset > span.offset),
            );
          if (everyOccurrenceInsideTheSpan) {
            spanCasesCarryingAContainedForm += 1;
          }
          return;
        }

        // Claim C: a measured form IN CODE is named, and it is the first row of the table present -
        // which is the order the validator resolves in - never a generic reason and never a token
        // fragment. Guarded on the length bound because that check runs first by design.
        const firstPresent = formsPresent[0];
        if (firstPresent !== undefined && text.length <= MAX_EXPRESSION_CHARS) {
          const construct = expectNamedConstruct(rejection, text);
          expect({ construct, expected: firstPresent.construct }).toEqual({
            construct: firstPresent.construct,
            expected: firstPresent.construct,
          });
          tally(namedInCodeCounts, construct);
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // Non-vacuity. Each claim above is trivially true over a sample that lacks the shape it is
    // about, so the sample is asserted to contain every shape rather than assumed to.
    expect(total).toBe(NUM_RUNS);
    expect(accepted / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    expect(unacceptedConstruct / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    expect(nonCodeSpanCases / total).toBeGreaterThanOrEqual(MIN_SHAPE_SHARE);
    // Without this the "contained form is not named" half is counted over span cases that contain
    // no form at all, which would say nothing.
    expect(spanCasesCarryingAContainedForm).toBeGreaterThan(0);

    // Every declared reason was observed. Iterated from the total record, so a fifth union member
    // forces the generator to produce it rather than leaving claim A covering three of five.
    for (const reason of DECLARED_REASON_NAMES) {
      expect({ reason, observed: (reasonCounts.get(reason) ?? 0) > 0 }).toEqual({
        reason,
        observed: true,
      });
    }

    // Every span kind was observed, so the span claim is not carried by comments alone.
    for (const kind of NON_CODE_SPAN_KINDS) {
      expect({ kind, observed: (spanKindCounts.get(kind) ?? 0) > 0 }).toEqual({
        kind,
        observed: true,
      });
    }

    // The strongest assertion available here: EVERY row of the measured table was generated in code
    // position and correctly named. Derived from the table, so a thirteenth row is covered the
    // moment it lands rather than passing unnoticed.
    for (const form of MEASURED_REJECTED_FORMS) {
      expect({
        construct: form.construct,
        namedInCodeAtLeastOnce: (namedInCodeCounts.get(form.construct) ?? 0) > 0,
      }).toEqual({ construct: form.construct, namedInCodeAtLeastOnce: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Regression pin (task 3.7): `.` stays outside the accepted operator set
// ---------------------------------------------------------------------------
//
// WHY A PIN AND NOT A PREFERENCE
//   The exclusion is the only thing standing between the gate and a MEASURED silent false proof.
//   `assert(dut.cnt <= 4'd8)` on `radix2_div` compiles, lowers, and becomes a LIVE assertion - its
//   deliberately false twin `dut.cnt == 4'd3` reports FAILED - while `write_json` shows the design's
//   real counter RENAMED to `dut.cnt_1` and `dut.cnt` bound to a FRESH 1-bit net. Every variant then
//   reported `PASSED`, including the one carrying no assume at all, which is the variant measured to
//   FAIL for every honest wrapper over that design. Yosys printed no diagnostic and the report reads
//   as a real proof, so no check downstream of the validator can recover from it
//   (`chipAgent/_inbox/gotcha-hierarchical-reference-in-a-property-wrapper-is-a-silent-false-proof.md`).
//   A reader who turns this block red by widening the dialect is therefore not weighing dialect
//   scope. They are weighing whether to reopen that false proof.
//
// WHAT IS PINNED
//   1. The measured texts: `dut.cnt <= 4'd8` and its live twin are refused naming `.`, and the same
//      expressions naming the plain signal `cnt` are accepted.
//   2. EVERY VARIANT, generated rather than listed. The instance (the measured `dut` or any other
//      name), the net (`cnt` or any other), the depth (two to four names, any scope optionally
//      carrying an instance- or generate-array index), and the whitespace on each side of each dot
//      (none, or a run of the validator's own whitespace) all vary. Each generated path is then
//      checked in EVERY surrounding form - either side of a comparison, an implication's antecedent
//      and consequent, a `$past` and a `$countones` argument, a part-select in a concatenation, a
//      ternary arm, a parenthesized sum - around a dialect expression drawn from the shared
//      `arbPropertyText()`. The forms are a closed list, so they are EXHAUSTED per case, not sampled.
//   3. `.` is absent from `ACCEPTED_OPERATORS` ITSELF, read from SOURCE the way
//      `testbench-rtl-isolation.property.test.ts` reads that module's imports. Behaviour alone cannot
//      tell "preserved" from "replaced" (Req 6.19): a list that admitted `.` beside a separate path
//      detector would refuse every path above and still have replaced the guard. The same read checks
//      that the guard's comment gives the false proof, and not dialect scope, as its reason.
//   4. The measured system-function accept list, `$countones` among the eight, held CLOSED: each of
//      the eight is accepted, and `$signed`, `$unsigned`, `$sampled`, and any other `$`-word are
//      refused naming themselves.
//
// REFUSED BY NAME means exactly `{ reason: 'unaccepted-construct', construct: '.' }`. Being refused is
//   not enough: the Property_Author reports a criterion unexpressed from that name (Req 6.7), so a
//   refusal naming anything else hides WHY. Every refused case also carries a positive control, the
//   same form naming the net as a plain signal, which must be ACCEPTED. That turns "the dot is the
//   only thing standing between this text and acceptance" from a sentence into a check.
//
// EACH CORE TAKES THE VALIDATOR, OR THE SOURCE TEXT, AS A PARAMETER, so a pin is shown to fail by
//   running it against a weakened validator or a mutated copy of the source, never by editing the
//   shared module
//   (`chipAgent/_inbox/gotcha-a-scratch-script-exit-trap-does-not-run-when-the-agent-tool-kills-the-shell.md`).
//
// Validates: Requirements 6.4, 6.18, 6.19

const HIERARCHICAL_PATH_PIN =
  'formal-property-oracle, regression pin (task 3.7): `.` stays outside the accepted operator set, because a hierarchical path is a measured silent false proof';

/**
 * Generated paths per run. Every case already exhausts the surrounding forms, so the runs only have
 * to cover the path's own shapes. The rarest required one is a path with no whitespace at any dot:
 * about one case in nine, computed from the sampled shares (a gap is empty half the time, and one,
 * two, and three dots each come up about a third of the time), which 300 runs miss with
 * probability under 1e-15.
 */
const PATH_VARIANT_RUNS = 300;

/** The validator under test, as a parameter, so each pin's core can be run against a weakened one. */
type Validator = typeof validateExpression;

/** The only acceptable verdict on text whose sole out-of-dialect construct is a path's dot. */
const REFUSED_NAMING_THE_DOT = {
  ok: false,
  error: { reason: 'unaccepted-construct', construct: '.' },
} as const;

/** The probe's texts: the measured false proof, and the deliberately false twin that FAILED. */
const MEASURED_PATH_TEXTS: readonly { readonly path: string; readonly plain: string }[] =
  Object.freeze([
    { path: "dut.cnt <= 4'd8", plain: "cnt <= 4'd8" },
    { path: "dut.cnt == 4'd3", plain: "cnt == 4'd3" },
  ]);

/** The measured case's instance and net, so the sample keeps returning to the shape measured. */
const MEASURED_INSTANCE = 'dut';
const MEASURED_NET = 'cnt';

/** Scopes nested below the instance, so a path carries two to four names in all. */
const MAX_NESTED_SCOPES = 2;

/** The highest instance- or generate-array index a scope carries, as in `gen[7].cnt`. */
const MAX_SCOPE_INDEX = 7;

/** The validator's own whitespace set, so whitespace around a dot is never itself the refusal. */
const DIALECT_WHITESPACE: readonly string[] = Object.freeze([' ', '\t', '\r', '\n', '\f']);

/** One scope of a hierarchical path, and the dot that ends it. */
interface PathScope {
  readonly name: string;
  /** An instance-array or generate-block index, as in `gen[1].cnt`, or `null` for none. */
  readonly index: number | null;
  /** The whitespace before and after the dot that ends this scope. */
  readonly before: string;
  readonly after: string;
}

/** A hierarchical path into the design instance, held as its parts so each one can vary. */
interface HierarchicalPath {
  /** The design instance first, then any nested scopes. Never empty, so a dot always exists. */
  readonly scopes: readonly PathScope[];
  /** The net the path ends at, which the positive control names as a plain signal instead. */
  readonly net: string;
}

/**
 * A plain signal name the dialect admits on its own: never a keyword, never a measured form.
 *
 * Filtered through the validator rather than through a local keyword list, because the keyword set
 * is private to `property.ts` and a copy here would drift. A name refused on its own would make the
 * path's refusal name the NAME rather than the dot, which is a generator defect, not a finding.
 */
function signalNameArbitrary(): fc.Arbitrary<string> {
  return fc
    .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,7}$/)
    .filter((name) => validateExpression(name).ok);
}

/** Whitespace on one side of a dot: none half the time, so tight paths stay common. */
function gapArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant(''),
    fc
      .array(fc.constantFrom(...DIALECT_WHITESPACE), { minLength: 1, maxLength: 2 })
      .map((run) => run.join('')),
  );
}

/** One scope named from `name`, indexed a quarter of the time, with its own dot's whitespace. */
function scopeArbitrary(name: fc.Arbitrary<string>): fc.Arbitrary<PathScope> {
  return fc.record({
    name,
    index: fc.oneof(
      { weight: 3, arbitrary: fc.constant(null) },
      { weight: 1, arbitrary: fc.nat({ max: MAX_SCOPE_INDEX }) },
    ),
    before: gapArbitrary(),
    after: gapArbitrary(),
  });
}

/** A path whose instance and net are the measured `dut` and `cnt` half the time each. */
function hierarchicalPathArbitrary(): fc.Arbitrary<HierarchicalPath> {
  const instance = scopeArbitrary(fc.oneof(fc.constant(MEASURED_INSTANCE), signalNameArbitrary()));
  const nested = fc.array(scopeArbitrary(signalNameArbitrary()), { maxLength: MAX_NESTED_SCOPES });
  return fc.record({
    scopes: fc.tuple(instance, nested).map(([first, rest]) => [first, ...rest]),
    net: fc.oneof(fc.constant(MEASURED_NET), signalNameArbitrary()),
  });
}

/** The path as text: each scope, its index, and its dot with the whitespace around it, then the net. */
function renderPath(path: HierarchicalPath): string {
  const scopes = path.scopes.map(({ name, index, before, after }) => {
    const indexed = index === null ? name : `${name}[${index}]`;
    return `${indexed}${before}.${after}`;
  });
  return `${scopes.join('')}${path.net}`;
}

/** A dialect expression the validator accepts, drawn from the shared untrusted-text generator. */
function acceptedExpressionArbitrary(): fc.Arbitrary<string> {
  return arbPropertyText().filter((text) => validateExpression(text).ok);
}

/** One position a signal reference takes, around a generated dialect `expression`. */
type SurroundingForm = (signal: string, expression: string) => string;

/**
 * Every surrounding form a path is checked in. A closed list, so it is exhausted per generated path
 * rather than sampled; each form keeps a space or a bracket between the signal and the expression,
 * so no measured form or comment opener can arise at a junction.
 */
const SURROUNDING_FORMS: readonly SurroundingForm[] = Object.freeze<SurroundingForm[]>([
  (signal) => signal,
  (signal, expression) => `${signal} <= ${expression}`,
  (signal, expression) => `${expression} == ${signal}`,
  (signal, expression) => `!(${expression}) || ${signal}`,
  (signal, expression) => `!${signal} || (${expression})`,
  (signal, expression) => `$past(${signal}, 2) != ${expression}`,
  (signal) => `$countones(${signal}) == 1`,
  (signal, expression) => `{${signal}[3:0], ${expression}}`,
  (signal, expression) => `${expression} ? ${signal}[0] : (${expression})`,
  (signal, expression) => `(${signal} + 1) < ${expression}`,
]);

/** Refused as `unaccepted-construct` naming `.` exactly: refused alone is not enough. */
function expectRefusedNamingTheDot(validate: Validator, text: string): void {
  expect({ text, result: validate(text) }).toEqual({ text, result: REFUSED_NAMING_THE_DOT });
}

/** The positive control: text that names a plain signal where the path stood is accepted. */
function expectAccepted(validate: Validator, text: string): void {
  expect({ text, accepted: validate(text).ok }).toEqual({ text, accepted: true });
}

/**
 * THE CORE OF PIN 2: in every surrounding form, the path is refused naming `.`, and the same form
 * naming the net as a plain signal is accepted, so the dot is the only thing the validator refused.
 */
function expectPathRefusedInEveryForm(
  validate: Validator,
  path: HierarchicalPath,
  expression: string,
): void {
  const hierarchical = renderPath(path);
  for (const form of SURROUNDING_FORMS) {
    expectAccepted(validate, form(path.net, expression));
    expectRefusedNamingTheDot(validate, form(hierarchical, expression));
  }
}

/** Every path shape the sample must contain, so no variation is claimed over cases lacking it. */
const REQUIRED_PATH_SHAPES: readonly string[] = Object.freeze([
  ...Array.from({ length: MAX_NESTED_SCOPES + 1 }, (_, nested) => `depth-${nested + 2}`),
  'measured-instance',
  'other-instance',
  'measured-net',
  'other-net',
  'tight-dot',
  'spaced-dot',
  'indexed-scope',
  'unindexed-scope',
]);

/** The shapes one generated path exercises, read off the path rather than assumed of the sample. */
function pathShapes(path: HierarchicalPath): readonly string[] {
  const spaced = path.scopes.some(({ before, after }) => before !== '' || after !== '');
  const indexed = path.scopes.some(({ index }) => index !== null);
  return [
    `depth-${path.scopes.length + 1}`,
    path.scopes[0]?.name === MEASURED_INSTANCE ? 'measured-instance' : 'other-instance',
    path.net === MEASURED_NET ? 'measured-net' : 'other-net',
    spaced ? 'spaced-dot' : 'tight-dot',
    indexed ? 'indexed-scope' : 'unindexed-scope',
  ];
}

/** `property.ts` from here, read from SOURCE so the pin sees the guard exactly as a reader does. */
const PROPERTY_MODULE = '../tools/verilog/property.ts';

/** The guard's declaration as `property.ts` spells it. A rename re-points this pin; it never drops it. */
const OPERATOR_GUARD_DECLARATION = 'const ACCEPTED_OPERATORS';

/**
 * What the guard's comment must state, matched case- and whitespace-insensitively so the prose can be
 * rewrapped or reworded around it: the reason is the measured silent false proof, the fresh-net
 * binding that makes it one, and explicitly not dialect scope.
 */
const REQUIRED_GUARD_JUSTIFICATION: readonly string[] = Object.freeze([
  'silent false proof',
  'fresh 1-bit net',
  'not dialect scope',
]);

/** The operators the dialect's only implication form, `!a || b`, needs, so the list holds them. */
const IMPLICATION_OPERATORS: readonly string[] = Object.freeze(['!', '||']);

/** The guard as written: the doc comment directly above the list, and the list's operators. */
interface OperatorGuard {
  /** The comment's text, delimiters and line prefixes stripped, whitespace collapsed, lower case. */
  readonly justification: string;
  readonly operators: readonly string[];
}

/** A doc comment's body as plain prose, so a rewrap cannot split a required phrase. */
function normalizedComment(body: string): string {
  return body
    .split('\n')
    .map((line) => line.replace(/^\s*\*?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The operator guard as `source` spells it.
 *
 * Throws, rather than returning an empty guard, when the declaration or the doc comment directly
 * above it cannot be found, because an empty operator list holds no `.` either and would pass.
 */
function readOperatorGuard(source: string): OperatorGuard {
  const declaredAt = source.indexOf(OPERATOR_GUARD_DECLARATION);
  const commentEnd = declaredAt < 0 ? -1 : source.lastIndexOf('*/', declaredAt);
  const commentStart = commentEnd < 0 ? -1 : source.lastIndexOf('/**', commentEnd);
  const listEnd = declaredAt < 0 ? -1 : source.indexOf('];', declaredAt);
  const commentIsAdjacent =
    commentEnd >= 0 && source.slice(commentEnd + '*/'.length, declaredAt).trim() === '';
  if (commentStart < 0 || listEnd < 0 || !commentIsAdjacent) {
    throw new Error(
      `could not read \`${OPERATOR_GUARD_DECLARATION}\` and the doc comment directly above it ` +
        `from ${PROPERTY_MODULE}; re-point this pin at the guard rather than deleting it`,
    );
  }
  const entries = source.slice(declaredAt, listEnd).matchAll(/^[ \t]*'([^']+)',?[ \t]*$/gm);
  return {
    justification: normalizedComment(source.slice(commentStart + '/**'.length, commentEnd)),
    operators: [...entries].map((match) => match[1] ?? ''),
  };
}

/**
 * THE CORE OF PIN 3: no operator in the declared list contains `.`, and the comment above the list
 * states the measured false proof, not dialect scope, as the reason.
 */
function expectGuardHoldsTheDotOut(source: string): void {
  const { justification, operators } = readOperatorGuard(source);
  // Positive control: the read found the real list, because an empty one holds no `.` either.
  expect(IMPLICATION_OPERATORS.filter((operator) => !operators.includes(operator))).toEqual([]);
  expect(operators.filter((operator) => operator.includes('.'))).toEqual([]);
  for (const fact of REQUIRED_GUARD_JUSTIFICATION) {
    expect({ fact, stated: justification.includes(fact) }).toEqual({ fact, stated: true });
  }
}

/**
 * The system functions the probe MEASURED Yosys 0.66 accepting, which is the whole accept list
 * (Req 6.4). Restated rather than imported on purpose: this is the record the code is held to.
 */
const MEASURED_SYSTEM_FUNCTIONS: readonly string[] = Object.freeze([
  '$past',
  '$rose',
  '$fell',
  '$stable',
  '$changed',
  '$countones',
  '$initstate',
  '$anyconst',
]);

/**
 * The functions refused for a MEASURED reason: `$signed` and `$unsigned` compute a silently
 * truncated product (`a=-44, b=76` yields `-16`), and `$sampled` is `Can't resolve function name`.
 */
const MEASURED_REFUSED_FUNCTIONS: readonly string[] = Object.freeze([
  '$signed',
  '$unsigned',
  '$sampled',
]);

/**
 * THE CORE OF PIN 4: `name` is accepted when it is one of the measured eight, and refused naming
 * itself otherwise. The validator decides on the `$`-word alone and checks no arity, so one call
 * form serves every name.
 */
function expectSystemFunctionVerdict(validate: Validator, name: string): void {
  const text = `${name}(${MEASURED_NET})`;
  const expected = MEASURED_SYSTEM_FUNCTIONS.includes(name)
    ? { ok: true, value: text }
    : { ok: false, error: { reason: 'unaccepted-construct', construct: name } };
  expect({ name, result: validate(text) }).toEqual({ name, result: expected });
}

/**
 * Any other `$`-word. A word carrying a measured rejected form is left to Property 15, which owns
 * that naming: `$throughout` is refused naming `throughout`, the form the table resolves first.
 */
function unmeasuredSystemFunctionArbitrary(): fc.Arbitrary<string> {
  return fc
    .stringMatching(/^\$[A-Za-z_][A-Za-z0-9_]{0,9}$/)
    .filter(
      (name) =>
        !MEASURED_SYSTEM_FUNCTIONS.includes(name) &&
        !MEASURED_REJECTED_FORMS.some((form) => form.pattern.test(name)),
    );
}

describe(HIERARCHICAL_PATH_PIN, () => {
  it('refuses the measured false-proof texts by naming `.`, and accepts them naming the port', () => {
    for (const { path, plain } of MEASURED_PATH_TEXTS) {
      expectAccepted(validateExpression, plain);
      expectRefusedNamingTheDot(validateExpression, path);
    }
  });

  it('refuses every generated hierarchical path by naming `.`, in every surrounding form', () => {
    const observed = new Set<string>();

    fc.assert(
      fc.property(
        hierarchicalPathArbitrary(),
        acceptedExpressionArbitrary(),
        (path, expression) => {
          expectPathRefusedInEveryForm(validateExpression, path, expression);
          for (const shape of pathShapes(path)) {
            observed.add(shape);
          }
        },
      ),
      propertyParameters({ numRuns: PATH_VARIANT_RUNS }),
    );

    // Non-vacuity: "every variant" is claimed only over shapes the sample actually contained.
    expect(REQUIRED_PATH_SHAPES.filter((shape) => !observed.has(shape))).toEqual([]);
  });

  it('holds `.` outside ACCEPTED_OPERATORS, and its comment gives the false proof as the reason', () => {
    expectGuardHoldsTheDotOut(readFileSync(new URL(PROPERTY_MODULE, import.meta.url), 'utf8'));
  });

  it('accepts exactly the measured system functions, `$countones` among them', () => {
    for (const name of [...MEASURED_SYSTEM_FUNCTIONS, ...MEASURED_REFUSED_FUNCTIONS]) {
      expectSystemFunctionVerdict(validateExpression, name);
    }

    fc.assert(
      fc.property(unmeasuredSystemFunctionArbitrary(), (name) => {
        expectSystemFunctionVerdict(validateExpression, name);
      }),
      propertyParameters(),
    );
  });
});
