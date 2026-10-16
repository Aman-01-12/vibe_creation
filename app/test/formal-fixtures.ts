// formal-gate-first-light, Component 4: the shared property constructors the formal measurements
// build on, extracted unchanged from `formal-oracle.integration.test.ts`.
// Rationale, and the three traps a fixture author hits: design.md, Component C4.

import {
  MAX_WARM_UP_DEPTH,
  propertyShapeRejection,
  validateExpression,
  type FormalProperty,
  type FormalVerdict,
  type ValidatedExpression,
} from '@app/tools';

/**
 * One expression, through `validateExpression` and never past it.
 *
 * A throw rather than a cast, so an expression outside the accepted dialect fails the load here
 * and names its own text instead of reaching a measurement.
 */
export function validated(text: string): ValidatedExpression {
  const expression = validateExpression(text);
  if (!expression.ok) {
    throw new Error(`the property is outside the accepted dialect: ${text}`);
  }
  return expression.value;
}

/**
 * One assembled property, through `propertyShapeRejection` and never past it.
 *
 * The throw is `validated`'s, one level up: a shape the renderer cannot emit fails the fixture
 * load naming its construct, rather than reaching a measurement as a wrapper with no assertion.
 */
function shaped(property: FormalProperty): FormalProperty {
  const rejection = propertyShapeRejection(property);
  if (rejection !== null) {
    const construct = 'construct' in rejection ? rejection.construct : rejection.reason;
    throw new Error(`the property shape is outside the accepted dialect: ${construct}`);
  }
  return property;
}

/** A module-level `assert property (...)` over a design with no clocking event (Req 6.2). */
export function combinationalProperty(id: string, text: string): FormalProperty {
  return shaped({ kind: 'combinational', id, criterionRef: 'AC-1', consequent: validated(text) });
}

/**
 * An unconditional clocked immediate assertion (Req 6.1).
 *
 * `antecedent: null` deliberately: no antecedent means no cover, so the Cover_Check is
 * `not-applicable`. The vacuity-capable shape is `guardedProperty`'s.
 */
export function clockedProperty(id: string, clock: string, text: string): FormalProperty {
  return shaped({
    kind: 'clocked',
    id,
    criterionRef: 'AC-1',
    clock: validated(clock),
    antecedent: null,
    consequent: validated(text),
  });
}

/**
 * A guarded clocked immediate assertion: the shape a Cover_Check exists for (Req 5.9, 5.10).
 *
 * The renderer emits `cover(<the antecedent>)` beside the assertion here, and that cover is what
 * detects an antecedent no run reaches.
 */
export function guardedProperty(
  id: string,
  clock: string,
  antecedent: string,
  consequent: string,
): FormalProperty {
  return shaped({
    kind: 'clocked',
    id,
    criterionRef: 'AC-1',
    clock: validated(clock),
    antecedent: validated(antecedent),
    consequent: validated(consequent),
  });
}

/**
 * A reset asserted `depth` edges ago and deasserted at every step since.
 *
 * One helper so the two multiplier entries cannot spell their windows differently, over either
 * reset polarity; see design.md, Component 19.
 */
function resetWindow(reset: string, assertedLevel: 'high' | 'low', depth: number): string {
  const high = assertedLevel === 'high';
  const asserted = (signal: string): string => (high ? signal : `!${signal}`);
  const deasserted = (signal: string): string => (high ? `!${signal}` : signal);
  const since = Array.from({ length: depth - 1 }, (_, index) => depth - 1 - index);
  return [
    asserted(`$past(${reset}, ${String(depth)})`),
    ...since.map((step) => deasserted(`$past(${reset}, ${String(step)})`)),
    deasserted(reset),
  ].join(' && ');
}

/** Both multipliers' operand-to-completion distance, measured off a trace (Req 3.12). */
const MULTIPLIER_WINDOW_DEPTH = 17;

/** One hand-authored property, the design it applies to, and the verdict its author expects. */
export interface FixtureProperty {
  /** The corpus importer's own problem id, so no entry holds Verilog source (Req 2.6, 2.9). */
  readonly designId: string;
  /** The acceptance criterion this entry answers, which is how a measurement is attributed. */
  readonly criterionRef: string;
  readonly property: FormalProperty;
  readonly expectedVerdict: FormalVerdict;
}

/** The three Scaling_Anchors (Req 3.1), by corpus problem id. */
export const SCALING_ANCHOR_IDS: readonly string[] = Object.freeze([
  'rtllm/arithmetic/adder_pipe_64bit',
  'rtllm/arithmetic/multi_booth_8bit',
  'rtllm/arithmetic/multi_16bit',
]);

/**
 * The Warm_Up_Boundary host (Req 13.9, 13.10).
 *
 * Chosen because its reset is ASYNCHRONOUS, so the emitted gate carries the warm-up term alone
 * with no `!$initstate` beside it, and the measurement then tests the warm-up arithmetic and
 * nothing else; see design.md, Component 19.
 */
export const COUNTER_12_ID = 'rtllm/control/counter_12';

/** The enable-gated-reset design both false-refutation probes are taken over (Req 4.1, 4.8). */
export const LIFO_BUFFER_ID = 'rtllm/memory/LIFObuffer';

/**
 * The properties the Scaling_Anchor measurement and the false-refutation probe both read.
 *
 * Every consequent states its design's exact arithmetic result rather than a range (Req 3.2), and
 * every expression names only the design's own ports; see design.md, Component C4.
 */
export const PROPERTY_FIXTURE: readonly FixtureProperty[] = Object.freeze([
  // `o_en` rises four edges after the operands enter, so the sum is over `$past(.., 4)`.
  {
    designId: 'rtllm/arithmetic/adder_pipe_64bit',
    criterionRef: '3.2',
    property: guardedProperty(
      'adder-pipe-64bit-exact-sum',
      'clk',
      'o_en',
      'result == $past(adda, 4) + $past(addb, 4)',
    ),
    expectedVerdict: 'proved',
  },
  // Deliberately false: `adda` and `addb` all ones carries out, so `result[64]` is 1. The fixture's
  // refutation control, and the only entry whose Counterexample does not depend on a ceiling.
  {
    designId: 'rtllm/arithmetic/adder_pipe_64bit',
    criterionRef: '2.5',
    property: guardedProperty(
      'adder-pipe-64bit-carry-never-set',
      'clk',
      'o_en',
      "result[64] == 1'b0",
    ),
    expectedVerdict: 'refuted',
  },
  // The 16-bit truncated product of the sign-extended operands the reset window latches, which is
  // what the design computes by the time the window closes; see design.md, Component 19.
  {
    designId: 'rtllm/arithmetic/multi_booth_8bit',
    criterionRef: '3.2',
    property: guardedProperty(
      'multi-booth-8bit-exact-product',
      'clk',
      resetWindow('reset', 'high', MULTIPLIER_WINDOW_DEPTH),
      `p == {{8{$past(a[7], ${String(MULTIPLIER_WINDOW_DEPTH)})}}, $past(a, ${String(MULTIPLIER_WINDOW_DEPTH)})} * ` +
        `{{8{$past(b[7], ${String(MULTIPLIER_WINDOW_DEPTH)})}}, $past(b, ${String(MULTIPLIER_WINDOW_DEPTH)})}`,
    ),
    expectedVerdict: 'proved',
  },
  // The 32-bit unsigned product over the same window on this design's active-low reset.
  // MEASURED `refuted`, and the refutation is on its merits rather than a False_Refutation: the
  // adjudicator replayed the 39-step counterexample on the unmodified design under iverilog and
  // REPRODUCED it, so the Reset_Contract derivation is not the suspect (criterion 4.7). Task 4.21
  // restated this entry to `proved` on reset-window reasoning, and that reasoning is what the
  // measurement contradicts. The adjudication is only trustworthy because the replay passes its
  // positive control; see `formal-false-refutation.integration.test.ts`.
  {
    designId: 'rtllm/arithmetic/multi_16bit',
    criterionRef: '3.2',
    property: guardedProperty(
      'multi-16bit-exact-product',
      'clk',
      resetWindow('rst_n', 'low', MULTIPLIER_WINDOW_DEPTH),
      `yout == {16'h0000, $past(ain, ${String(MULTIPLIER_WINDOW_DEPTH)})} * ` +
        `{16'h0000, $past(bin, ${String(MULTIPLIER_WINDOW_DEPTH)})}`,
    ),
    expectedVerdict: 'refuted',
  },
  // The reset branch runs only while `EN` is asserted, and it drives `EMPTY` high and `dataOut` to
  // zero. `FULL` is excluded because that branch never writes it. Believed true, so a refutation
  // here is a candidate False_Refutation of the derived Reset_Contract (Req 4.1, 4.3).
  {
    designId: LIFO_BUFFER_ID,
    criterionRef: '4.1',
    property: guardedProperty(
      'lifobuffer-enabled-reset-post-state',
      'Clk',
      '$past(EN, 1) && $past(Rst, 1)',
      "EMPTY == 1'b1 && dataOut == 4'h0",
    ),
    expectedVerdict: 'proved',
  },
  // The reset-dependent LIFObuffer probe: only an initial state no enabled step has touched breaks
  // it, so unlike the 4.1 probe it depends on step 0; see design.md, Component 20.
  {
    designId: LIFO_BUFFER_ID,
    criterionRef: '4.8',
    property: guardedProperty(
      'lifobuffer-empty-and-full-reads-zero',
      'Clk',
      'EMPTY && FULL',
      "dataOut == 4'h0",
    ),
    expectedVerdict: 'proved',
  },
  // The enable-gated extension's `refuted` half (Req 13.21). Unconditional, so it carries no
  // cover, and FALSE on the design's own push behaviour: one enabled write from the reset state
  // drops `EMPTY`. So it is refuted under the narrow reset assume AND under a widened one, which
  // is what lets it witness a widened assume that excludes a reachable path - the false-proof
  // direction, on a property whose falsity is not in question; see design.md, Component 19.
  {
    designId: LIFO_BUFFER_ID,
    criterionRef: '13.21',
    property: clockedProperty('lifobuffer-empty-always-high', 'Clk', "EMPTY == 1'b1"),
    expectedVerdict: 'refuted',
  },
  // THE CEILING-DEEP BOUNDARY PAIR, which measures the Warm_Up_Ceiling's exact edge rather than
  // arguing it. Both spell their depth from `MAX_WARM_UP_DEPTH`, so a later move of the first
  // clocked rung or of the check delay re-aims the measurement with them; see design.md,
  // Component 19.
  //
  // An asserted asynchronous reset pins the visible state in the same step, so `out` is 0 at
  // step 0 under the reset assume, which is what makes a claim about step 0 exact at the boundary
  // sample - the only sample the first rung can evaluate.
  {
    designId: COUNTER_12_ID,
    criterionRef: '13.9',
    property: guardedProperty(
      'counter-12-reset-count-at-ceiling',
      'clk',
      `!$past(rst_n, ${String(MAX_WARM_UP_DEPTH)})`,
      `$past(out, ${String(MAX_WARM_UP_DEPTH)}) == 4'd0`,
    ),
    expectedVerdict: 'proved',
  },
  // Unconditional (Req 13.11), so it has no cover: the count N cycles ago was never zero. False
  // at the first sample the gate opens, because that sample's N-back state IS the reset state, so
  // every path violates it there and a Counterexample comes back.
  {
    designId: COUNTER_12_ID,
    criterionRef: '13.10',
    property: clockedProperty(
      'counter-12-count-nonzero-at-ceiling',
      'clk',
      `$past(out, ${String(MAX_WARM_UP_DEPTH)}) != 4'd0`,
    ),
    expectedVerdict: 'refuted',
  },
]);
