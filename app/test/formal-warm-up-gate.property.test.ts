// formal-property-oracle, Property 33: the warm-up gate's depth (task 16.12).
//
// WHY THE GATE IS NOT OPTIONAL, AND WHY CROSS-ENGINE AGREEMENT OFFERS NO PROTECTION HERE
//   A clocked assert SAMPLES the step-0 state, so its first sample evaluates `$past(Q)` against a value
//   nothing ever drove. MEASURED: `JC_counter`'s exact-next-state property was refuted by ALL TWELVE
//   engine configurations until a wrapper-local age counter was added. Twelve for twelve is what makes
//   it dangerous rather than annoying - it is an instrument defect that looks EXACTLY like a design bug
//   on every engine at once, so the usual reflex of trusting unanimous refutation is precisely the wrong
//   conclusion
//   (`chipAgent/_inbox/gotcha-a-past-depth-n-property-needs-an-n-step-warm-up-gate-or-every-engine-refutes-it.md`).
//   The counter is FORCED rather than chosen: `assume(!($initstate || $past($initstate, 1)) || rst);` is
//   a hard Yosys error - `ERROR: Don't know how to detect sign and width for AST_FCALL node!` - so
//   nested `$past` on `$initstate` is unavailable and an N-step window has to be COUNTED in the wrapper
//   (Req 6.24).
//
// THE SEVEN CLAIMS
//   1. THE IFF (Req 6.20, 6.22). A wrapper-local counter is declared if and only if the property is
//      clocked, renders at all, and its own expressions carry at least one `$past`. A property using no
//      `$past` reaches backward across no boundary and is evaluated from its first sample.
//   2. THE DEPTH IS THE PROPERTY'S OWN LARGEST `$past` DEPTH (Req 6.21). The gate term is
//      `<counter> >= N` with N the largest depth the property's expressions carry - read from the
//      ANTECEDENT as readily as from the consequent, since Req 6.21 says "its own expressions" - and
//      never the first depth, never a sum, and never a constant.
//   3. NEVER A FIXED CONSTANT, asserted two ways. Claim 2 holds per case, and the sample is required to
//      carry at least three DISTINCT depths, so a renderer emitting one hardcoded number fails claim 2
//      on every case whose depth is not that number instead of passing a sample that only ever wanted
//      one.
//   4. THE THREE PLACES N APPEARS MUST AGREE. The gate's threshold, the increment's saturation bound,
//      and the counter's WIDTH are three independent emissions of one number, and a disagreement is a
//      silent vacuity hole rather than a cosmetic defect: a counter too NARROW to hold N wraps and never
//      reaches the threshold, so the assertion is never evaluated and the run reports a `proved` that
//      was never tested. The width is checked against the RULE - the counter must be able to REACH N -
//      rather than against the renderer's own width function.
//   5. THE COUNTER SATURATES AND STARTS PINNED. `< N` stops it at N so the gate holds forever once
//      reached; a WRAPPING counter would periodically re-disable the assertion. The declaration's `= 0`
//      initializer is load-bearing for the opposite reason: a FREE counter could start at or above N,
//      which is the gate doing nothing at all - the same false-refutation shape the gate exists to
//      close. `read_verilog -sv` turns the initializer into the register's `init` attribute, which is
//      what `prep` reads.
//   6. THE COUNTER IS LOCAL TO THE WRAPPER (Req 6.24). Its name never appears in the design instance's
//      connection list and the wrapper holds no hierarchical reference at all - a `dut.` path is a
//      MEASURED silent false proof, because Yosys binds it to a fresh 1-bit net rather than failing
//      (`chipAgent/_inbox/gotcha-hierarchical-reference-in-a-property-wrapper-is-a-silent-false-proof.md`).
//   7. A DEPTH ABOVE THE BOUND RENDERS NO ASSERTION AT ALL, and the counter goes with it. The bound is
//      required for a false-PROOF reason: the gate suppresses the assertion for N clock edges, and the
//      first clocked rung of the depth ladder is 20, so an N at or above it leaves no step for the
//      assertion to be evaluated at - and a property with no antecedent emits no cover, so nothing would
//      flag the vacuity. A refused shape lands on the zero-assertion guard instead, which is the first
//      condition of the five-condition gate.
//
// WHY THE EXPECTED DEPTH COMES FROM THE GENERATOR'S CONSTRUCTION
//   Each case is BUILT from a depth this file chose, so the expectation is known without parsing the
//   expression back. The alternative - re-reading `$past` depths out of the rendered text - would be a
//   second implementation of `pastDepthsIn`, and a test that re-derives the rule it asserts proves only
//   that the code equals itself. The generator is therefore structured rather than free: it emits the
//   depth alongside the property, and every generated expression is put through `validateExpression`, so
//   a case outside the accepted dialect fails loudly here rather than silently thinning the sample.
//
//   THE FORM THAT READS AS DEPTH 1. `$past(d)` is depth 1, SystemVerilog's own default and not a
//   fallback of ours.
//
//   TWO SHAPES LEFT THIS GENERATOR, and the Property_Validator now owns both (task 4.14, C18). A
//   sized literal such as `$past(d, 8'd2)` is refused, because a reader that ignores its width
//   sizes a gate the tool does not. A depth above the ceiling is refused by name. Both would now
//   throw inside `validatedOrThrow`, so the above-ceiling case is a deterministic example below
//   rather than a drawn shape, and `formal-warm-up-ceiling.property.test.ts` owns the refusals.
//
// NON-VACUITY AND THE RUN COUNT
//   The local generator crosses the property KIND (clocked 2, combinational 1 - `arbFormalProperty()`'s
//   own ratio) against four `$past` SHAPES weighted 2 none / 2 implicit / 4 explicit / 2 two-calls,
//   total 10. The required shapes and their shares:
//     clocked, no `$past`            (2/3)*(2/10) ~ 13.3%
//     clocked, implicit depth 1      (2/3)*(2/10) ~ 13.3%
//     clocked, explicit depth        (2/3)*(4/10) ~ 26.7%
//     clocked, two calls             (2/3)*(2/10) ~ 13.3%
//     combinational, no `$past`      (1/3)*(2/10) ~  6.7%   <- the rarest slot
//     combinational, some `$past`    (1/3)*(8/10) ~ 26.7%
//     the `$past` in the ANTECEDENT  half of the clocked `$past` cases ~ 30%
//   The rarest REQUIRED shape is 6.7%. The run count below was sized when the rarest was 5.6%, so
//   it is now more headroom than the table needs, and it is kept rather than trimmed: under D1 the
//   runs are close to free and a lower count would have to be re-justified.
//
//   THE RUN COUNT IS SIZED AGAINST THE SHARE FLOOR, NOT AGAINST "THE SHAPE NEVER APPEARED". Every row
//   here is checked against `MIN_SHAPE_SHARE`, so the question is the probability that an OBSERVED share
//   falls under the floor, which is a binomial lower tail rather than `(1 - p)^numRuns`. At the 500 runs
//   this file first carried, each of the three 5.6% rows fails whenever fewer than 15 of 500 draws land
//   on it - `P(X <= 14)` for `X ~ Bin(500, 0.056)`, about 0.6% each and roughly 2% across the three.
//   That was OBSERVED: this test failed once inside a full-suite run and then passed 40 consecutive
//   standalone runs. At 2000 runs the same row fails below 60 of 2000, which is ~5 standard deviations
//   out, ~3e-7. Measured cost: 56ms of test time at 500 runs, so the runs are close to free.
//   (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//
// The tag is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to a
// different spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 6.1, 6.4, 6.20, 6.21, 6.22, 6.24**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import {
  MAX_WARM_UP_DEPTH,
  renderPropertyWrapper,
  validateExpression,
  type FormalProperty,
  type ResetContract,
  type ValidatedExpression,
} from '@app/tools';

import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 33: A property reaching backward across the model
// boundary carries a warm-up gate of exactly its own depth**
const PROPERTY =
  'formal-property-oracle, Property 33: A property reaching backward across the model boundary carries a warm-up gate of exactly its own depth';

/** The wrapper name is caller-owned and no model output reaches it; one fixed value suffices. */
const WRAPPER_NAME = 'formal_property_wrapper';

/**
 * See the RUN COUNT note in the header: the rarest required shape is 5.6% of draws.
 *
 * Sized against the SHARE FLOOR rather than against that shape's absence. At 500 runs each 5.6% row fell
 * under the 3% floor about 0.6% of the time, which was observed as a one-off full-suite failure.
 */
const NUM_RUNS = 2000;

/**
 * The wrapper-local counter's name, spelled INDEPENDENTLY of the renderer's own constant.
 *
 * Not imported, because the constant is module-private in `property.ts` and importing it would make
 * this test agree with the renderer by construction. A rename in the renderer fails here, which is the
 * direction that matters: the name is the one thing the gate term, the increment, and the declaration
 * all have to spell the same way.
 */
const COUNTER_NAME = '__formal_warmup_age';

/** The counter's declaration: its optional range, and the `= 0` initializer claim 5 rests on. */
const DECLARATION_PATTERN = new RegExp(`^ {2}reg(?: \\[(\\d+):0\\])? ${COUNTER_NAME} = 0;$`);

/** The counter's increment: its clock, its saturation bound, and that it assigns the counter. */
const INCREMENT_PATTERN = new RegExp(
  `^ {2}always @\\(posedge ([A-Za-z_][A-Za-z0-9_$]*)\\) ` +
    `if \\(${COUNTER_NAME} < (\\d+)\\) ${COUNTER_NAME} <= ${COUNTER_NAME} \\+ 1;$`,
);

/** The gate term the assertion must carry, with the depth captured. */
const GATE_TERM_PATTERN = new RegExp(`^${COUNTER_NAME} >= (\\d+)$`);

/** The clocked shape's immediate assertion (Req 6.1). */
const ASSERT_PREFIX = 'assert(';

/** The combinational shape's module-level assertion (Req 6.2). */
const ASSERT_PROPERTY_PREFIX = 'assert property (';

/** The statement guard the gate terms are joined inside. */
const GUARD_PREFIX = 'if (';

/** The join between the gate's two independently decided terms. */
const TERM_JOIN = ' && ';

/** The design instance's name, so claim 6 can rule out a hierarchical reference through it. */
const DUT_INSTANCE_NAME = 'dut';

/** The minimum share of generated cases each required shape must reach. */
const MIN_SHAPE_SHARE = 0.03;

/** How many DISTINCT depths the sample must carry, so claim 3 cannot pass on one constant. */
const MIN_DISTINCT_DEPTHS = 3;

/** Put a generated expression through the sole constructor of the brand, or fail loudly. */
function validatedOrThrow(text: string): ValidatedExpression {
  const result = validateExpression(text);
  if (!result.ok) {
    throw new Error(`generated expression is outside the accepted dialect: ${text}`);
  }
  return result.value;
}

/** The design every case is rendered over: a clock, a reset, one input, one output. */
const DESIGN_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'shift_reg',
  ports: [
    { name: 'd', direction: 'input', width: 8 },
    { name: 'q', direction: 'output', width: 8 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
};

/**
 * A REFUSED contract, so no reset emission appears in any rendered case.
 *
 * Deliberate isolation: the assume and the `!$initstate` gate term are Properties 35 and 31, and a
 * derived contract would put a second term in the gate this file reads. Property 16's clause 7 already
 * asserts that the two gate terms are `&&`-joined into one guard and that the cover carries the
 * identical text, so nothing is lost by holding the contract refused here - and the gate-term reader
 * below still splits on the join, so a stray second term fails rather than being absorbed.
 */
const REFUSED_CONTRACT: ResetContract = { derived: false };

/** Which `$past` shape a case carries, so each is counted and required. */
type PastShape = 'none' | 'implicit' | 'explicit' | 'two-calls';

/** One generated case: a property, and the largest `$past` depth it carries BY CONSTRUCTION. */
interface WarmUpCase {
  readonly property: FormalProperty;
  /** The largest depth the property's own expressions carry, or `null` where it carries no `$past`. */
  readonly depth: number | null;
  readonly shape: PastShape;
  readonly clocked: boolean;
  /** Whether the `$past` sits in the ANTECEDENT rather than the consequent (Req 6.21). */
  readonly inAntecedent: boolean;
}

/** The `$past`-carrying expression text for one shape, at one depth. */
function pastExpression(shape: PastShape, depth: number, second: number): string {
  switch (shape) {
    case 'implicit':
      // `$past(d)` is depth 1 - SystemVerilog's own default, not a fallback of ours.
      return 'q == $past(d)';
    case 'two-calls':
      // TWO calls at DIFFERENT depths: the gate takes the LARGEST, so a renderer reading the first or
      // summing them fails here. `depth` is the larger by construction.
      return `$past(q, ${String(second)}) == $past(d, ${String(depth)})`;
    default:
      return `q == $past(d, ${String(depth)})`;
  }
}

/** Build one case from its drawn shape, depth, and placement. */
function buildCase(
  shape: PastShape,
  clocked: boolean,
  depth: number,
  second: number,
  inAntecedent: boolean,
): WarmUpCase {
  const identity = { id: 'p1', criterionRef: 'ac-1' } as const;
  if (shape === 'none') {
    const consequent = validatedOrThrow('q == d');
    return {
      property: clocked
        ? {
            kind: 'clocked',
            ...identity,
            clock: validatedOrThrow('clk'),
            antecedent: null,
            consequent,
          }
        : { kind: 'combinational', ...identity, consequent },
      depth: null,
      shape,
      clocked,
      inAntecedent: false,
    };
  }
  const reaching = validatedOrThrow(pastExpression(shape, depth, second));
  const carried = shape === 'implicit' ? 1 : Math.max(depth, shape === 'two-calls' ? second : 0);
  if (!clocked) {
    // A combinational property carrying `$past` has no clocking event to count edges on, so the gate
    // Req 6.20 mandates is unemittable and the shape is refused rather than rendered ungated.
    return {
      property: { kind: 'combinational', ...identity, consequent: reaching },
      depth: carried,
      shape,
      clocked,
      inAntecedent: false,
    };
  }
  return {
    property: {
      kind: 'clocked',
      ...identity,
      clock: validatedOrThrow('clk'),
      antecedent: inAntecedent ? reaching : null,
      consequent: inAntecedent ? validatedOrThrow('q == d') : reaching,
    },
    depth: carried,
    shape,
    clocked,
    inAntecedent,
  };
}

/**
 * Properties carrying `$past` at varied depths, plus the shapes that must carry no gate.
 *
 * LOCAL to this file rather than added to `formal-arbitraries.ts`: `arbFormalProperty()` emits only the
 * one-argument `$past(x)` form, so it cannot vary the depth at all, and a depth-varying generator has
 * exactly one consumer. Each case carries its own constructed depth, which is what lets the expectation
 * be known without re-implementing the renderer's `$past` reader.
 */
function arbWarmUpCase(): fc.Arbitrary<WarmUpCase> {
  const shape = fc.oneof(
    { weight: 2, arbitrary: fc.constant<PastShape>('none') },
    { weight: 2, arbitrary: fc.constant<PastShape>('implicit') },
    { weight: 4, arbitrary: fc.constant<PastShape>('explicit') },
    { weight: 2, arbitrary: fc.constant<PastShape>('two-calls') },
  );
  return fc
    .record({
      shape,
      clocked: fc.oneof(
        { weight: 2, arbitrary: fc.constant(true) },
        { weight: 1, arbitrary: fc.constant(false) },
      ),
      inBoundDepth: fc.integer({ min: 1, max: MAX_WARM_UP_DEPTH }),
      lesserDepth: fc.integer({ min: 1, max: MAX_WARM_UP_DEPTH }),
      inAntecedent: fc.boolean(),
    })
    .map((drawn) => {
      const depth = drawn.inBoundDepth;
      // The second call's depth is forced BELOW the first, so `depth` is the larger by construction and
      // the two-call case has an unambiguous expected answer.
      const second = Math.max(1, Math.min(drawn.lesserDepth, depth - 1));
      return buildCase(drawn.shape, drawn.clocked, depth, second, drawn.inAntecedent);
    });
}

/** The offset of the `)` closing the `(` at `openOffset`, or `-1` when it never closes. */
function matchingCloseParen(source: string, openOffset: number): number {
  let depth = 0;
  for (let index = openOffset; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Every paren-matched argument of `prefix` in `source`, in emitted order. */
function parenArguments(source: string, prefix: string): readonly string[] {
  const openOffsetInPrefix = prefix.length - 1;
  const found: string[] = [];
  let at = source.indexOf(prefix);
  while (at !== -1) {
    const open = at + openOffsetInPrefix;
    const close = matchingCloseParen(source, open);
    expect({ prefix, offset: at, closes: close > open }).toEqual({
      prefix,
      offset: at,
      closes: true,
    });
    found.push(source.slice(open + 1, close));
    at = source.indexOf(prefix, at + 1);
  }
  return found;
}

/** The lines of `rendered` carrying `prefix`. */
function linesCarrying(rendered: string, prefix: string): readonly string[] {
  return rendered.split('\n').filter((line) => line.includes(prefix));
}

/** What the wrapper emitted for the counter: the declared width, the clock, and the bound. */
interface EmittedCounter {
  readonly width: number;
  readonly clock: string;
  readonly saturationBound: number;
}

/** Read the counter's declaration and increment, or `null` where neither was emitted. */
function emittedCounter(rendered: string): EmittedCounter | null {
  const lines = rendered.split('\n');
  const declarations = lines.flatMap((line) => {
    const match = DECLARATION_PATTERN.exec(line);
    return match === null ? [] : [match];
  });
  const increments = lines.flatMap((line) => {
    const match = INCREMENT_PATTERN.exec(line);
    return match === null ? [] : [match];
  });
  // Claim 4's first half and claim 5: the declaration and the increment come as a PAIR. A counter
  // declared and never incremented never reaches the threshold, so the assertion is never evaluated;
  // one incremented and never declared is an implicit net `prep` reads as undriven.
  expect({ declarations: declarations.length, increments: increments.length }).toEqual({
    declarations: increments.length,
    increments: increments.length,
  });
  expect({ atMostOne: declarations.length <= 1 }).toEqual({ atMostOne: true });
  if (declarations.length === 0) {
    // Claim 1's negative direction, at its strongest: the NAME appears nowhere at all, so no gate term
    // can reference a counter that was never declared.
    expect({ mentionsCounter: rendered.includes(COUNTER_NAME) }).toEqual({
      mentionsCounter: false,
    });
    return null;
  }
  const [, high] = declarations[0] as RegExpExecArray;
  const [, clock, bound] = increments[0] as RegExpExecArray;
  return {
    width: high === undefined ? 1 : Number(high) + 1,
    clock: clock as string,
    saturationBound: Number(bound),
  };
}

/** The gate terms the assertion carries, or `null` where it carries no gate. */
function gateTermsOf(rendered: string, trailingGuards: number): readonly string[] | null {
  const assertLines = linesCarrying(rendered, ASSERT_PREFIX);
  expect({ assertLines: assertLines.length }).toEqual({ assertLines: 1 });
  const guards = parenArguments(assertLines[0] as string, GUARD_PREFIX);
  const gates = guards.slice(0, Math.max(0, guards.length - trailingGuards));
  expect({ gateGuards: gates.length <= 1 }).toEqual({ gateGuards: true });
  return gates.length === 0 ? null : (gates[0] as string).split(TERM_JOIN);
}

/** Claims 2, 4, and 5 over a case that must carry a gate. */
function expectGateOfExactlyItsOwnDepth(rendered: string, generated: WarmUpCase): void {
  const depth = generated.depth as number;
  const counter = emittedCounter(rendered);
  expect({ counterEmitted: counter !== null }).toEqual({ counterEmitted: true });
  const emitted = counter as EmittedCounter;

  // Claim 2. The gate term's threshold IS the property's own largest depth, read off the rendered text
  // and compared against the depth this case was BUILT from.
  const terms = gateTermsOf(rendered, generated.inAntecedent ? 1 : 0);
  expect({ terms }).toEqual({ terms: [`${COUNTER_NAME} >= ${String(depth)}`] });
  const threshold = GATE_TERM_PATTERN.exec((terms as readonly string[])[0] as string);
  expect({ parsed: threshold !== null }).toEqual({ parsed: true });

  // Claim 4. The three emissions of one number agree: the gate's threshold, the increment's saturation
  // bound, and a width that can REACH the threshold. The width claim is stated as representability -
  // the rule - rather than as the renderer's own width arithmetic restated.
  expect({
    threshold: Number((threshold as RegExpExecArray)[1]),
    saturationBound: emitted.saturationBound,
    widthHoldsTheDepth: 2 ** emitted.width > depth,
    clock: emitted.clock,
  }).toEqual({
    threshold: depth,
    saturationBound: depth,
    widthHoldsTheDepth: true,
    // Claim 4's last part: the counter counts edges of the PROPERTY'S OWN clock, so a property clocked
    // on some other signal cannot be gated by a counter advancing on a different one.
    clock: 'clk',
  });

  // Claim 6. The counter is LOCAL: it is never connected into the design instance, and the wrapper
  // holds no hierarchical reference at all.
  for (const connection of parenArguments(rendered, `.${COUNTER_NAME}(`)) {
    expect({ connection, connected: true }).toEqual({ connection, connected: false });
  }
  expect({ hierarchical: rendered.includes(`${DUT_INSTANCE_NAME}.`) }).toEqual({
    hierarchical: false,
  });
}

describe(PROPERTY, () => {
  it('gates on a wrapper-local counter of exactly its own largest $past depth, or not at all', () => {
    let total = 0;
    let clockedWithoutPast = 0;
    let clockedImplicit = 0;
    let clockedExplicit = 0;
    let clockedTwoCalls = 0;
    let combinationalWithoutPast = 0;
    let combinationalWithPast = 0;
    let pastInTheAntecedent = 0;
    const depths = new Set<number>();

    fc.assert(
      fc.property(arbWarmUpCase(), (generated: WarmUpCase) => {
        total += 1;
        const rendered = renderPropertyWrapper(
          DESIGN_INTERFACE,
          generated.property,
          WRAPPER_NAME,
          REFUSED_CONTRACT,
        );

        if (!generated.clocked) {
          if (generated.depth === null) {
            combinationalWithoutPast += 1;
            // Claim 1. No `$past`, no counter - and the combinational shape still renders its
            // module-level assert (Req 6.2), so this is not the refused path.
            expect({ asserts: linesCarrying(rendered, ASSERT_PROPERTY_PREFIX).length }).toEqual({
              asserts: 1,
            });
          } else {
            combinationalWithPast += 1;
            // Claim 7's sibling: the unclocked shape has no clocking event to count edges on, so a
            // `$past`-carrying combinational property renders NO assertion rather than an ungated one.
            expect({ asserts: linesCarrying(rendered, ASSERT_PROPERTY_PREFIX).length }).toEqual({
              asserts: 0,
            });
          }
          expect(emittedCounter(rendered)).toBeNull();
          return;
        }

        if (generated.depth === null) {
          clockedWithoutPast += 1;
          // Claim 1 (Req 6.22). A property reaching backward across no boundary is evaluated from its
          // first sample: no counter, and no gate term either.
          expect(emittedCounter(rendered)).toBeNull();
          expect(gateTermsOf(rendered, 0)).toBeNull();
          return;
        }

        depths.add(generated.depth);
        if (generated.inAntecedent) {
          pastInTheAntecedent += 1;
        }
        switch (generated.shape) {
          case 'implicit':
            clockedImplicit += 1;
            // The implicit form is depth 1 by SystemVerilog's own default.
            expect({ depth: generated.depth }).toEqual({ depth: 1 });
            break;
          case 'two-calls':
            clockedTwoCalls += 1;
            break;
          default:
            clockedExplicit += 1;
            break;
        }
        expectGateOfExactlyItsOwnDepth(rendered, generated);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY. Claim 3's "never a fixed constant" is the reason `depths` is counted: over a sample
    // carrying one depth, a renderer emitting that number as a literal passes every other claim here.
    expect({
      clockedWithoutPast: clockedWithoutPast / total >= MIN_SHAPE_SHARE,
      clockedImplicit: clockedImplicit / total >= MIN_SHAPE_SHARE,
      clockedExplicit: clockedExplicit / total >= MIN_SHAPE_SHARE,
      clockedTwoCalls: clockedTwoCalls / total >= MIN_SHAPE_SHARE,
      combinationalWithoutPast: combinationalWithoutPast / total >= MIN_SHAPE_SHARE,
      combinationalWithPast: combinationalWithPast / total >= MIN_SHAPE_SHARE,
      pastInTheAntecedent: pastInTheAntecedent / total >= MIN_SHAPE_SHARE,
      distinctDepths: depths.size >= MIN_DISTINCT_DEPTHS,
    }).toEqual({
      clockedWithoutPast: true,
      clockedImplicit: true,
      clockedExplicit: true,
      clockedTwoCalls: true,
      combinationalWithoutPast: true,
      combinationalWithPast: true,
      pastInTheAntecedent: true,
      distinctDepths: true,
    });
  });

  it('renders no assertion and no cover for a depth above the ceiling (criterion 13.6)', () => {
    // Claim 7, now a deterministic example rather than a generated shape: the Property_Validator
    // refuses this depth, so only a cast past the brand reaches the renderer's backstop.
    const tooDeep = `q == $past(d, ${String(MAX_WARM_UP_DEPTH + 1)})` as ValidatedExpression;
    const identity = { id: 'p1', criterionRef: 'ac-1' } as const;

    for (const inAntecedent of [false, true]) {
      const rendered = renderPropertyWrapper(
        DESIGN_INTERFACE,
        {
          kind: 'clocked',
          ...identity,
          clock: validatedOrThrow('clk'),
          antecedent: inAntecedent ? tooDeep : null,
          consequent: inAntecedent ? validatedOrThrow('q == d') : tooDeep,
        },
        WRAPPER_NAME,
        REFUSED_CONTRACT,
      );

      // The cover is counted too: an over-gated cover would under-report reachability rather
      // than refuse, which is the quieter half of the same defect.
      expect({
        inAntecedent,
        asserts: linesCarrying(rendered, ASSERT_PREFIX).length,
        covers: linesCarrying(rendered, 'cover(').length,
        counter: emittedCounter(rendered),
      }).toEqual({ inAntecedent, asserts: 0, covers: 0, counter: null });
    }
  });

  it('moves the gate with the depth, at the bound and one step under it', () => {
    // Claim 3 as a deterministic pair, so "never a fixed constant" has a named case and not only a
    // distinct-count over a sample: two properties differing ONLY in depth emit different thresholds,
    // and the largest gatable depth is still gated rather than refused.
    const atTheBound = renderPropertyWrapper(
      DESIGN_INTERFACE,
      buildCase('explicit', true, MAX_WARM_UP_DEPTH, 1, false).property,
      WRAPPER_NAME,
      REFUSED_CONTRACT,
    );
    const underIt = renderPropertyWrapper(
      DESIGN_INTERFACE,
      buildCase('explicit', true, MAX_WARM_UP_DEPTH - 1, 1, false).property,
      WRAPPER_NAME,
      REFUSED_CONTRACT,
    );
    expect(gateTermsOf(atTheBound, 0)).toEqual([`${COUNTER_NAME} >= ${String(MAX_WARM_UP_DEPTH)}`]);
    expect(gateTermsOf(underIt, 0)).toEqual([
      `${COUNTER_NAME} >= ${String(MAX_WARM_UP_DEPTH - 1)}`,
    ]);
  });
});
