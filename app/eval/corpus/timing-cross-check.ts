// The both-direction ratchet comparator: derived Port_Timing against the reviewed
// Ground_Truth_Manifest, one outcome per declared output port (Req 6.12, 6.5).
//
// WHY A PURE COMPARATOR OVER SUPPLIED DATA
//   The manifest's independence is a property of PROVENANCE, so the thing that checks
//   it must not reach for the derivation either. This module imports no derivation
//   code: derived results arrive as plain data, which is also what makes both failure
//   directions testable without a toolchain. The integration test that feeds it a real
//   run is task 12.8.
//
// BOTH DIRECTIONS FAIL, WHICH IS WHAT MAKES IT A RATCHET
//   A port the manifest expects to agree and which derives a different value - or
//   which the derivation refuses - fails. A port the manifest records as `refused` and
//   which the derivation CLASSIFIES also fails: without that second direction the
//   manifest silently stops being a pin. Same discipline as `stage0-quarantine.ts`.
//
// NOTHING IS A SILENT PASS
//   A derived result for a pair the manifest does not carry fails, because the manifest
//   claims totality over the Derivation_Population and an unknown pair refutes that
//   claim. A manifest entry with no supplied result fails too: an unchecked pin is not
//   a passed pin, and reading it as "not covered" would let a run that skipped half the
//   corpus report a clean ratchet.
//
// Scope: the comparator only. The count aggregation of C11's report lands in task 12.1
// and the witness rows in task 12.5, both built over `comparisons` below.

import type { PortTiming } from '@app/core';

import {
  TIMING_GROUND_TRUTH,
  timingGroundTruthKey,
  type TimingGroundTruthEntry,
} from './timing-ground-truth.js';
import type { TimingPopulationSummary } from './timing-populations.js';

/**
 * One declared output port's DERIVED outcome, as plain data.
 *
 * `'refused'` carries the fact of a Timing_Refusal rather than a value, and cannot
 * collide with a `PortTiming` member.
 */
export interface DerivedPortResult {
  readonly design: string;
  readonly port: string;
  readonly derived: PortTiming | 'refused';
}

/** What comparing one port against its manifest entry established. */
export type TimingComparisonOutcome =
  /** The manifest expects agreement and the derived value reproduces it. */
  | 'AGREED'
  /** The manifest records `refused` and the derivation refused. */
  | 'REFUSAL_COVERED'
  /** Direction 1: expected to agree, derived a different value. */
  | 'DISAGREED'
  /** Direction 1: expected to agree, the derivation refused the port instead. */
  | 'UNEXPECTED_REFUSAL'
  /** Direction 2: the manifest records `refused` and the derivation classified it. */
  | 'UNEXPECTED_AGREEMENT'
  /** A derived result for a design/port pair the manifest does not carry. */
  | 'UNKNOWN_PORT'
  /** A manifest entry no supplied result covers. */
  | 'MISSING_RESULT'
  /** Two supplied results disagree about one pair, so its derived value is ambiguous. */
  | 'CONFLICTING_RESULT';

/**
 * One port's comparison row, carrying every field a failure must name so it is
 * readable without opening the manifest (Req 6.12).
 *
 * `derived` is null only for `MISSING_RESULT`; the three manifest fields are null only
 * for `UNKNOWN_PORT`, where no entry exists to read them from.
 */
export interface TimingPortComparison {
  readonly design: string;
  readonly port: string;
  readonly outcome: TimingComparisonOutcome;
  readonly derived: PortTiming | 'refused' | null;
  readonly groundTruth: PortTiming | null;
  readonly expected: 'agrees' | 'refused' | null;
  readonly rationale: string | null;
}

/**
 * The comparison over every port, plus the failing subset.
 *
 * `failures` is a view over `comparisons`, not a second source of truth: the ratchet
 * holds exactly when it is empty.
 */
export interface TimingRatchetResult {
  readonly comparisons: readonly TimingPortComparison[];
  readonly failures: readonly TimingPortComparison[];
}

const FAILING_OUTCOMES: ReadonlySet<TimingComparisonOutcome> = new Set([
  'DISAGREED',
  'UNEXPECTED_REFUSAL',
  'UNEXPECTED_AGREEMENT',
  'UNKNOWN_PORT',
  'MISSING_RESULT',
  'CONFLICTING_RESULT',
]);

/** Whether an outcome fails the ratchet. Membership, so a new outcome is not a pass by default. */
export function isTimingRatchetFailure(outcome: TimingComparisonOutcome): boolean {
  return FAILING_OUTCOMES.has(outcome);
}

/**
 * Index supplied results by `design/port`, FIRST RESULT WINS and order-stable, with
 * any pair whose repeats disagree recorded as ambiguous rather than resolved.
 *
 * A `Map` rather than an object: a port named `__proto__` would otherwise read through
 * the prototype chain instead of through a real entry.
 */
function indexResults(results: readonly DerivedPortResult[]): {
  readonly byKey: ReadonlyMap<string, PortTiming | 'refused'>;
  readonly conflicting: ReadonlySet<string>;
} {
  const byKey = new Map<string, PortTiming | 'refused'>();
  const conflicting = new Set<string>();
  for (const result of results) {
    const key = timingGroundTruthKey(result.design, result.port);
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, result.derived);
      continue;
    }
    if (seen !== result.derived) conflicting.add(key);
  }
  return { byKey, conflicting };
}

/**
 * Classify one manifest entry against its supplied result. Total: every combination of
 * `expected` and derived outcome lands on a named outcome, with no default branch.
 */
function classify(
  entry: TimingGroundTruthEntry,
  derived: PortTiming | 'refused' | null,
  ambiguous: boolean,
): TimingComparisonOutcome {
  if (derived === null) return 'MISSING_RESULT';
  if (ambiguous) return 'CONFLICTING_RESULT';
  if (entry.expected === 'refused') {
    return derived === 'refused' ? 'REFUSAL_COVERED' : 'UNEXPECTED_AGREEMENT';
  }
  if (derived === 'refused') return 'UNEXPECTED_REFUSAL';
  return derived === entry.timing ? 'AGREED' : 'DISAGREED';
}

/**
 * Compare derived per-port results against the Ground_Truth_Manifest in both
 * directions.
 *
 * Pure and total: it returns a result value, never throws and never logs, so a caller
 * decides how a failure is reported. Rows come out in manifest order, one per entry,
 * followed by one row per distinct unknown pair in supplied order.
 *
 * `manifest` is a parameter so a unit test can pin the comparator's behaviour on a
 * handful of entries; a real run passes the committed manifest by omitting it.
 */
export function compareDerivedTiming(
  results: readonly DerivedPortResult[],
  manifest: readonly TimingGroundTruthEntry[] = TIMING_GROUND_TRUTH,
): TimingRatchetResult {
  const { byKey, conflicting } = indexResults(results);
  // Seeded with the manifest's pairs and then grown by the unknown pass below, so one
  // unknown pair reported twice yields one row rather than two.
  const seenKeys = new Set(manifest.map((entry) => timingGroundTruthKey(entry.design, entry.port)));
  const comparisons: TimingPortComparison[] = manifest.map((entry) => {
    const key = timingGroundTruthKey(entry.design, entry.port);
    const derived = byKey.get(key) ?? null;
    return {
      design: entry.design,
      port: entry.port,
      outcome: classify(entry, derived, conflicting.has(key)),
      derived,
      groundTruth: entry.timing,
      expected: entry.expected,
      rationale: entry.rationale,
    };
  });
  for (const result of results) {
    const key = timingGroundTruthKey(result.design, result.port);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    comparisons.push({
      design: result.design,
      port: result.port,
      outcome: 'UNKNOWN_PORT',
      derived: result.derived,
      groundTruth: null,
      expected: null,
      rationale: null,
    });
  }
  return {
    comparisons,
    failures: comparisons.filter((row) => isTimingRatchetFailure(row.outcome)),
  };
}

/**
 * The 14 corpus designs with no clock port at all: Requirement 3.2's 13 named designs
 * plus `alu`, the fourteenth purely-combinational design the requirements text records.
 * The manifest carries no `clocked` field, and `registered` already implies a clock by
 * definition (Retained_Sequential_State needs a Sequential_Element), so the only gap this
 * fills is a clocked design whose ports are ALL `combinational` - `fsm` chief among them.
 * Lifted verbatim from Req 3.2 rather than re-derived, so it cannot drift from the manifest
 * silently; several of these designs' own recorded rationale says "no clock" directly.
 */
const CLOCKLESS_DESIGNS: ReadonlySet<string> = new Set([
  'adder_8bit',
  'adder_16bit',
  'adder_32bit',
  'adder_bcd',
  'comparator_3bit',
  'comparator_4bit',
  'div_16bit',
  'multi_8bit',
  'fixed_point_adder',
  'fixed_point_substractor',
  'sub_64bit',
  'barrel_shifter',
  'ROM',
  'alu',
]);

function isClockedDesign(design: string): boolean {
  return !CLOCKLESS_DESIGNS.has(design);
}

/** One clocked-class figure of `CrossCheckReport`: agreement over its own total. */
export interface CrossCheckClockedFigure {
  readonly agreeing: number;
  readonly total: number;
}

/** One `DISAGREED` row, narrowed to the five fields a failure must name (Req 6.5). */
export interface TimingDisagreement {
  readonly design: string;
  readonly port: string;
  readonly derived: PortTiming;
  readonly groundTruth: PortTiming;
  readonly rationale: string;
}

/**
 * The six-figure cross-check count report (Req 6.3, 6.4, 6.6), plus the Timing_Population
 * figures and the per-port `disagreements` rows (Req 6.5) carried in the same object so a
 * rise in exclusions cannot present as a rise in accuracy (Q-05). `adjacencySeparating` is
 * a later task's addition (13.x); this shape covers what tasks 12.1, 12.3 and 12.5 assemble.
 */
export interface CrossCheckReport {
  readonly agreeing: number;
  readonly disagreeing: number;
  readonly refusalCovered: number;
  /** Derived `registered` where the manifest says `combinational`. */
  readonly falseRegistered: number;
  /** Derived `combinational` where the manifest says `registered`. */
  readonly falseCombinational: number;
  readonly clockedGroundTruthCombinational: CrossCheckClockedFigure;
  readonly clockedGroundTruthRegistered: CrossCheckClockedFigure;
  readonly populations: TimingPopulationSummary;
  /** One row per `DISAGREED` port, readable without opening the manifest (Req 6.5). */
  readonly disagreements: readonly TimingDisagreement[];
  /** One row per Mandatory_Witness design, never omitted even when unanalysable (Req 6.7-6.10). */
  readonly witnesses: readonly TimingWitnessRow[];
}

/** One Mandatory_Witness declared output port's derived value alongside its Ground_Truth (Req 6.8). */
export interface TimingWitnessPort {
  readonly port: string;
  readonly derived: PortTiming | 'refused';
  readonly groundTruth: PortTiming;
}

/**
 * One Mandatory_Witness's row: every declared output port reported separately (Req 6.8),
 * whether the collapse detector fires on it (Req 6.9), and its UNPROVEN cause when it
 * cannot be analysed (Req 6.10).
 */
export interface TimingWitnessRow {
  readonly design: string;
  readonly ports: readonly TimingWitnessPort[];
  readonly collapsed: boolean;
  /** Set when the witness could not be analysed; null otherwise. */
  readonly unproven: string | null;
}

/**
 * The three corpus designs the Timing_Cross_Check is required to cover (Req 6.7), each
 * tied to the validation obligation its own row serves when UNPROVEN (Req 6.10). Order
 * here is the order `witnesses` rows come out in.
 */
const MANDATORY_WITNESS_DESIGNS: readonly string[] = ['radix2_div', 'traffic_light', 'fsm'];

/**
 * The Requirement each Mandatory_Witness serves, per the design doc's glossary entry:
 * `radix2_div` is the collapse detector's only non-vacuous case (6.9); `traffic_light`
 * and `fsm` earn their place through the general coverage requirement (6.7) rather than
 * through the collapse detector, which is structurally vacuous on both of them.
 */
const MANDATORY_WITNESS_REQUIREMENT: ReadonlyMap<string, string> = new Map([
  ['radix2_div', '6.9'],
  ['traffic_light', '6.7'],
  ['fsm', '6.7'],
]);

/** Outcomes a witness port can be cleanly reported through; anything else is UNPROVEN. */
const UNANALYSABLE_OUTCOMES: ReadonlySet<TimingComparisonOutcome> = new Set([
  'MISSING_RESULT',
  'UNKNOWN_PORT',
  'CONFLICTING_RESULT',
]);

/**
 * Narrow a cleanly-classified row to a witness port. Only reached for outcomes outside
 * `UNANALYSABLE_OUTCOMES`, where `classify` guarantees both fields are concrete.
 */
function toWitnessPort(row: TimingPortComparison): TimingWitnessPort {
  const { port, derived, groundTruth } = row;
  if (derived === null || groundTruth === null) {
    throw new Error(`unreachable: ${row.design}/${port} witness port missing a concrete value`);
  }
  return { port, derived, groundTruth };
}

/** The cause string a witness's `unproven` field carries, naming the requirement it leaves unproven. */
function unprovenCause(design: string): string {
  return `incomplete-coverage (Requirement ${MANDATORY_WITNESS_REQUIREMENT.get(design)} UNPROVEN)`;
}

/**
 * Build one Mandatory_Witness's row from its design's rows within `comparisons`.
 *
 * Manifest-rooted rows are those with a non-null `groundTruth`: `compareDerivedTiming`
 * sets it from the manifest entry for every outcome except `UNKNOWN_PORT`, so filtering
 * on it is what keeps a stray unknown-port row out of this witness's declared ports
 * without a second pass over the manifest.
 *
 * The row is always returned, never omitted: an absent or partially unanalysable witness
 * still gets a row, with `unproven` set (Req 6.10) and `collapsed` left `false` rather
 * than claimed on incomplete data.
 */
function buildWitnessRow(
  design: string,
  comparisons: readonly TimingPortComparison[],
): TimingWitnessRow {
  const designRows = comparisons.filter((row) => row.design === design);
  if (designRows.length === 0) {
    return { design, ports: [], collapsed: false, unproven: unprovenCause(design) };
  }

  const hasUnanalysablePort = designRows.some((row) => UNANALYSABLE_OUTCOMES.has(row.outcome));
  const ports = designRows
    .filter((row) => row.groundTruth !== null && !UNANALYSABLE_OUTCOMES.has(row.outcome))
    .map(toWitnessPort);

  if (hasUnanalysablePort) {
    return { design, ports, collapsed: false, unproven: unprovenCause(design) };
  }

  // Non-vacuous on radix2_div alone: its two ports' groundTruth genuinely differ, so this
  // can fire there. traffic_light (4 ports, all `registered`) and fsm (1 port) each have a
  // single distinct groundTruth value, which makes `groundTruths.size > 1` false for both
  // without any design-specific exception.
  const groundTruths = new Set(ports.map((p) => p.groundTruth));
  const derivedValues = new Set(ports.map((p) => p.derived));
  const collapsed = groundTruths.size > 1 && derivedValues.size === 1;
  return { design, ports, collapsed, unproven: null };
}

/** Build the `witnesses` rows for every Mandatory_Witness, in a fixed, reviewable order (Req 6.7). */
function buildWitnessRows(
  comparisons: readonly TimingPortComparison[],
): readonly TimingWitnessRow[] {
  return MANDATORY_WITNESS_DESIGNS.map((design) => buildWitnessRow(design, comparisons));
}

/**
 * Narrow a `DISAGREED` row's loosely-typed fields to concrete values. `classify` only
 * reaches `DISAGREED` when `derived` and the manifest's `timing` are both real
 * `PortTiming` members that differ, so a row failing this is an invariant violation
 * worth throwing on, not a value to coerce around.
 */
function narrowDisagreement(row: TimingPortComparison): TimingDisagreement {
  const { design, port, derived, groundTruth, rationale } = row;
  if (derived === null || derived === 'refused' || groundTruth === null || rationale === null) {
    throw new Error(`unreachable: DISAGREED row ${design}/${port} missing a concrete timing value`);
  }
  return { design, port, derived, groundTruth, rationale };
}

/**
 * The clocked-class figure for one Ground_Truth value: agreement among `AGREED` and
 * `DISAGREED` rows of clocked designs whose manifest value is `groundTruth`. Scoped to
 * those two outcomes (not `REFUSAL_COVERED`) because only they carry a manifest entry
 * expected to `agree`, which is what makes the two figures a clean partition (Property 19).
 */
function clockedGroundTruthFigure(
  comparisons: readonly TimingPortComparison[],
  groundTruth: PortTiming,
): CrossCheckClockedFigure {
  const covered = comparisons.filter(
    (row) =>
      (row.outcome === 'AGREED' || row.outcome === 'DISAGREED') &&
      row.groundTruth === groundTruth &&
      isClockedDesign(row.design),
  );
  return {
    agreeing: covered.filter((row) => row.outcome === 'AGREED').length,
    total: covered.length,
  };
}

/**
 * Assemble the six published cross-check figures from a comparator result, plus the
 * population figures passed through unchanged.
 *
 * `disagreeing` counts `DISAGREED` rows only, excluding `UNEXPECTED_REFUSAL` and
 * `UNEXPECTED_AGREEMENT`: those two are ratchet-direction failures of Req 6.12, surfaced
 * through `result.failures` already, and neither has a `registered`-vs-`combinational`
 * direction to assign (an `UNEXPECTED_REFUSAL` row's derived value is `'refused'`, not a
 * `PortTiming`). Scoping `disagreeing` to `DISAGREED` is what lets `falseRegistered` and
 * `falseCombinational` sum to it exactly, which Property 19 requires.
 *
 * Pure: no I/O, derives every figure from the two arguments alone.
 */
export function assembleCrossCheckReport(
  result: TimingRatchetResult,
  populations: TimingPopulationSummary,
): CrossCheckReport {
  const { comparisons } = result;
  const disagreedRows = comparisons.filter((row) => row.outcome === 'DISAGREED');
  return {
    agreeing: comparisons.filter((row) => row.outcome === 'AGREED').length,
    disagreeing: disagreedRows.length,
    refusalCovered: comparisons.filter((row) => row.outcome === 'REFUSAL_COVERED').length,
    falseRegistered: disagreedRows.filter((row) => row.derived === 'registered').length,
    falseCombinational: disagreedRows.filter((row) => row.derived === 'combinational').length,
    clockedGroundTruthCombinational: clockedGroundTruthFigure(comparisons, 'combinational'),
    clockedGroundTruthRegistered: clockedGroundTruthFigure(comparisons, 'registered'),
    populations,
    disagreements: disagreedRows.map(narrowDisagreement),
    witnesses: buildWitnessRows(comparisons),
  };
}
