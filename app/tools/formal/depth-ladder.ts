// The depths the Formal_Oracle counts in, and the delay a clocked check reports with.
// Imports nothing, so `verilog/property.ts` can derive the Warm_Up_Ceiling from the first rung
// without closing a cycle back through `formal/adapter.ts`. See design.md, Component 18.

/**
 * The Proof_Depth for a design with no clocked state carrying a property with no clocking event.
 *
 * Measured: `adder_8bit` at depth 1, 0.09s. One step is the whole state space of a combinational
 * design, so there is nothing for a ladder to escalate into.
 */
export const COMBINATIONAL_DEPTH = 1;

/**
 * The first rung of the clocked ladder, declared once because the ladder's own first element
 * reads as `number | undefined`, and a ceiling derived from it would need a fallback value
 * nothing justifies. 20 is the measured anchor; the parent spec's design.md records its basis.
 */
export const FIRST_CLOCKED_RUNG = 20;

/**
 * Steps between the state a clocked assertion samples and the step it is reported at.
 *
 * So the last sample the first rung evaluates is `FIRST_CLOCKED_RUNG - 1 - CLOCKED_CHECK_DELAY`.
 */
export const CLOCKED_CHECK_DELAY = 1;

/**
 * The clocked ladder, tried in this order.
 *
 * The first rung is measured; doubling twice is a design choice rather than a measurement, and
 * the parent spec's design.md records both.
 */
export const CLOCKED_DEPTH_LADDER: readonly number[] = [FIRST_CLOCKED_RUNG, 40, 80];
