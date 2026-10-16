// formal-gate-first-light, Component 20: the Reset_Derivation_Measurement's CLASSIFICATION rule.
//
// WHY THE RULE IS ITS OWN MODULE
//   The measurement around it spawns `yosys`, decodes a netlist, and decides two properties
//   through the real oracle, none of which can run without the toolchain. The rule that reads the
//   result, though, is a pure function of a cell census and a derived contract, so it is checkable
//   on any host and is where a mistake would be most expensive: it is what decides whether we
//   report a defect in the parent spec's reset derivation or a stale comment.
//
// THE THREE OUTCOMES, AND WHY A REFUSAL IS NOT ONE OF THE TWO CLASSES
//   Stage A measured that `LIFObuffer` DOES derive a reset, under `if (EN == 0) nothing; else if
//   (Rst == 1)`, an enable-gated synchronous active-high reset. So:
//     - derived, and a retained reset entry comes from an `$sdffce` cell whose `EN` is not a
//       constant -> CANDIDATE BREACH of the parent's criterion 14.19, because a contract was
//       derived from a reset that only fires while an enable is asserted, and 14.19 says such a
//       reset is refused;
//     - derived, and no such cell exists -> STALE SOURCE TEXT, because the comments that say this
//       design's reset is refused describe behaviour the netlist does not have;
//     - NOT derived -> neither class. That contradicts Stage A and task 4.2, so it is reported as
//       a contradiction under Requirement 11 rather than squeezed into a class it does not fit.
//   Reporting a refusal as `stale-source-text` would be the dangerous collapse: the comments would
//   then be "wrong" in the opposite direction and someone would correct them to match a derivation
//   that had just disappeared.
//
// AN ENABLE THAT IS CONSTANT IS NOT AN ENABLE
//   `$sdffce` with `EN` tied to a constant fires its reset every cycle the clock ticks, which is
//   an ordinary synchronous reset wearing an enable's cell type. Only a non-constant `EN` makes
//   the reset conditional, which is the thing 14.19 is about.

/** One reset-carrying flip-flop cell, as the netlist census records it. */
export interface ResetCellEntry {
  /** The Yosys cell type, for example `$sdffce` or `$sdffe`. */
  readonly cellType: string;
  /** The net the cell's reset connection resolves to. */
  readonly resetNet: string;
  /** The cell's reset polarity, parsed from its binary parameter. */
  readonly resetPolarity: number;
  /** The net the cell's `EN` resolves to, or `null` where the cell has no `EN`. */
  readonly enableNet: string | null;
  /** The `EN` polarity where the cell has one. */
  readonly enablePolarity: number | null;
  /** Whether the `EN` connection resolves to a constant rather than to a driven net. */
  readonly enableIsConstant: boolean;
}

/** What the measurement found, before the rule below is applied to it. */
export interface ResetDerivationCensus {
  /** Whether the real run's `FormalOutcome` carried a derived Reset_Contract. */
  readonly resetDerived: boolean;
  /** Every cell the netlist carries that holds a reset polarity parameter. */
  readonly resetCells: readonly ResetCellEntry[];
}

/** The classification, which is exactly one of three and never a guess. */
export type ResetDerivationClass =
  /** A contract was derived from an enable-gated reset the parent's 14.19 says is refused. */
  | 'candidate-breach-14-19'
  /** A contract was derived, and the comments calling this reset refused are out of date. */
  | 'stale-source-text'
  /** No contract was derived, which contradicts Stage A and belongs to Requirement 11. */
  | 'refusal-contradiction';

/** The cell type whose reset fires only while an enable is asserted. */
export const ENABLE_GATED_RESET_CELL = '$sdffce';

/**
 * Whether one census entry is the enable-gated reset criterion 14.19 is about.
 *
 * Exported because the driver names the deciding entry in its record, and reading it from the
 * same predicate the class is computed from keeps the record and the class from disagreeing.
 */
export function isEnableGatedReset(entry: ResetCellEntry): boolean {
  return (
    entry.cellType === ENABLE_GATED_RESET_CELL &&
    entry.enableNet !== null &&
    !entry.enableIsConstant
  );
}

/**
 * Classify one census. Pure and total: every census maps to exactly one class.
 *
 * The derivation question is asked FIRST, because a refusal makes the cell census moot: there is
 * no derived contract for a cell to have been derived from, so neither class can be about it.
 */
export function classifyResetDerivation(census: ResetDerivationCensus): ResetDerivationClass {
  if (!census.resetDerived) {
    return 'refusal-contradiction';
  }
  return census.resetCells.some(isEnableGatedReset)
    ? 'candidate-breach-14-19'
    : 'stale-source-text';
}

/**
 * Whether this class requires a new clarification question before anything is fixed.
 *
 * Only the candidate breach does. The fix direction - refuse the reset as 14.19 states, or derive
 * a contract that pins the enable too - is a decision about the parent spec's derivation, and
 * task 4.25 is explicitly forbidden from choosing it.
 */
export function requiresFixDirectionQuestion(classification: ResetDerivationClass): boolean {
  return classification === 'candidate-breach-14-19';
}
