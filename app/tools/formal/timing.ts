// The Timing_Classifier: the five-clause ordered rule that turns one pre-pass timing finding plus
// one `ModuleInterface` into a Timing_Contract or ONE named Timing_Refusal
// (timing-contract-inference design.md Component 3; Req 1.1 to 1.11, 1.15 to 1.18, 2.1 to 2.6).
//
// WHY THE PARAMETERS ARE EXACTLY THESE TWO
//   `classifyPortTiming` reads `moduleInterface` for two things and nothing else: the declared
//   output port names, and the Declared_Data_Input set. It never sees the design description, the
//   raw RTL, or a `reg`/`wire` qualifier, which is Requirement 1.11 enforced by the SIGNATURE
//   rather than by a convention - there is no parameter through which any of them could arrive.
//   The cone facts come from the worker, which holds the netlist; the Declared_Data_Input
//   subtraction is decided here, because this is the only side holding a `clocking` record.
//
// THE SUBTRACTION IS LOAD-BEARING AND MEASURED
//   The Declared_Data_Input set is every `direction === 'input'` port MINUS `clocking.clockName`
//   and `clocking.resetName`. `fsm`'s `MATCH` cone contains `RST` and `pulse_detect`'s `data_out`
//   cone contains `rst_n`, so counting the reset as a data input would classify an asynchronously
//   cleared state output as `combinational`. The worker reports `sources` with the clock and reset
//   INCLUDED on purpose: it has no `clocking` record, so it cannot name them.
//
// WHY CLAUSE ORDER IS THE WHOLE RULE
//   Clause 2 (undriven) MUST precede clause 3 (data-input reachability). A multi-bit output with
//   one undriven bit and another bit reaching a declared data input would otherwise receive a
//   valid-looking whole-port value, and that value is FABRICATED for the bits with no driver
//   (Req 1.18). Partial drive is the case this ordering exists for, and it is the one a per-design
//   or source-level rule cannot see.
//   Clause 3 before clause 4 is what makes a Mealy output `combinational` on a clocked design,
//   which is `fsm`, `pulse_detect`, and `radix2_div`'s `result`.
//   Clause 4 covers the Moore shape of Req 1.7 with NO separate branch, because a combinational
//   decode over a state register is exactly an empty data-input intersection plus state
//   dependence. There is no sixth clause to add for it.
//   Clause 5 stays a REFUSAL and deliberately does NOT classify a fully-driven constant output as
//   `combinational` (Req 1.15). Two recorded reasons: no corpus design witnesses that shape, and
//   it is behaviourally inert, because a constant output's harness comparison target is identical
//   under `registered` and under `combinational`. `alu`'s three unassigned ports and
//   `clkgenerator`'s `clk` are witnesses for clause 2, NOT for clause 5.
//
// Pure and total: no file, network, clock, model, or random-source read, no log, and no throw on
// any input. Every outcome is a `Result`.

import {
  err,
  makeTimingContract,
  ok,
  type ModuleInterface,
  type PortTiming,
  type Result,
  type TimingContract,
  type TimingContractEntry,
} from '@app/core';

import type { PortTimingFacts, PrepassTimingFinding } from './prepass.js';

/**
 * Why a Port_Timing could not be derived. Names and a closed token only, never text from a tool.
 *
 * Req 2.5: declared port names and a cause, excluding host file paths, design source text, and
 * tool diagnostic text. Nothing below quotes a `DomainError` message or a worker string into it.
 */
export interface TimingRefusal {
  readonly cause: TimingRefusalCause;
  /** The declared output ports whose timing is undetermined, named in full (Req 2.2). */
  readonly ports: readonly string[];
}

/**
 * The closed refusal vocabulary.
 *
 * `netlist-unavailable` is NOT produced by `classifyPortTiming`. Its producer is the
 * Timing_Derivation port, for a run that registered no report at all or whose report failed the
 * parse (Req 2.3, task 5.1). It is declared here so that cause stays distinct from the
 * undetermined-port causes rather than being folded into one of them.
 */
export type TimingRefusalCause =
  | 'netlist-unavailable'
  | 'netlist-walk-unreliable'
  | 'port-not-reported'
  | 'undriven-output-port'
  | 'input-and-state-independent';

/**
 * Which cause a mixed-cause refusal reports, lowest number winning. Total over the union.
 *
 * Ports may accumulate under DIFFERENT causes and Req 2.2 admits only ONE refusal, so one cause is
 * chosen and every port name is kept. The ranking is the CLAUSE ORDER itself, which is the only
 * non-arbitrary choice available: an earlier clause describes a more fundamental failure, and the
 * later causes are only meaningful once the earlier ones did not fire. Reporting the earliest
 * therefore never overstates what was established - saying `undriven-output-port` for a design
 * whose whole walk was unreliable would assert a fact about a driver that the walk never
 * established. `netlist-unavailable` is ranked first, ahead of every cause produced here, so a
 * caller that merges its own refusal into one of these need not re-decide the order.
 *
 * A `Readonly<Record<TimingRefusalCause, number>>` rather than an ordered list, for the reason
 * `CLOCK_CONTRACT_REFUSAL` in `prepass.ts` is one: a sixth cause added to the union is a COMPILE
 * error here until it is ranked, instead of an unranked value that an `indexOf` would read as -1
 * and silently promote above everything.
 */
const REFUSAL_CAUSE_PRECEDENCE: Readonly<Record<TimingRefusalCause, number>> = Object.freeze({
  'netlist-unavailable': 0,
  'netlist-walk-unreliable': 1,
  'port-not-reported': 2,
  'undriven-output-port': 3,
  'input-and-state-independent': 4,
});

/** The declared output port names, in declaration order and deduplicated. */
function declaredOutputPortNames(moduleInterface: ModuleInterface): readonly string[] {
  return [
    ...new Set(
      moduleInterface.ports.filter((port) => port.direction === 'output').map((port) => port.name),
    ),
  ];
}

/**
 * The Declared_Data_Input set: every input port MINUS the clock and the reset (Req 1.2, 1.3).
 *
 * A `Set` rather than a `Record`, for the key-coercion reason `timing-contract.ts` gives: a port
 * literally named `__proto__` must be decided by an explicit member, not by the prototype chain.
 */
function declaredDataInputNames(moduleInterface: ModuleInterface): ReadonlySet<string> {
  const names = new Set(
    moduleInterface.ports.filter((port) => port.direction === 'input').map((port) => port.name),
  );
  const { clockName, resetName } = moduleInterface.clocking;
  if (clockName !== null) names.delete(clockName);
  if (resetName !== null) names.delete(resetName);
  return names;
}

/**
 * The finding's per-port cone facts keyed by port, or `null` where the whole walk refused.
 *
 * `null` and a present map missing a key are DIFFERENT facts, and they carry different causes:
 * the walk's answers being void is design-level, a single port's absence is that port's.
 */
function reportedPortFacts(
  finding: PrepassTimingFinding,
): ReadonlyMap<string, PortTimingFacts> | null {
  if (!finding.derived) return null;
  return new Map(finding.ports.map((facts) => [facts.port, facts]));
}

/** The five clauses, in their fixed order, for one declared output port. */
function classifyOnePort(
  reported: ReadonlyMap<string, PortTimingFacts> | null,
  portName: string,
  dataInputNames: ReadonlySet<string>,
): Result<PortTiming, TimingRefusalCause> {
  // Clause 1: no report, or none this port appears in.
  if (reported === null) return err('netlist-walk-unreliable');
  const facts = reported.get(portName);
  if (facts === undefined) return err('port-not-reported');
  // Clause 2, ahead of clause 3: a whole-port value is fabricated for a bit with no driver, so
  // partial drive refuses even where another bit does reach a data input (Req 1.17, 1.18).
  if (facts.undriven) return err('undriven-output-port');
  // Clause 3: reachability from a declared data input, which is what the harness really asks.
  if (facts.sources.some((source) => dataInputNames.has(source))) return ok('combinational');
  // Clause 4: state dependence with no data input reached. Moore decode lands here too (Req 1.7).
  if (facts.reachesState) return ok('registered');
  // Clause 5: driven, stateless, input-independent. A refusal, never `combinational` (Req 1.15).
  return err('input-and-state-independent');
}

/** Fold one more undetermined port into the single refusal, keeping its name and the top cause. */
function accumulate(
  refusal: TimingRefusal | null,
  portName: string,
  cause: TimingRefusalCause,
): TimingRefusal {
  if (refusal === null) return { cause, ports: [portName] };
  const dominant =
    REFUSAL_CAUSE_PRECEDENCE[cause] < REFUSAL_CAUSE_PRECEDENCE[refusal.cause]
      ? cause
      : refusal.cause;
  return { cause: dominant, ports: [...refusal.ports, portName] };
}

/**
 * Classify every declared output port of `moduleInterface` from one pre-pass timing finding.
 *
 * Returns a Timing_Contract total over those ports, or ONE `TimingRefusal` naming EVERY
 * undetermined port - Req 2.2's "every" rather than "the first" - under the dominant cause of
 * `REFUSAL_CAUSE_PRECEDENCE`. An interface declaring no output port yields the empty contract,
 * because nothing is undetermined there.
 *
 * Pure and total: reads nothing outside its two arguments and never throws.
 */
export function classifyPortTiming(
  moduleInterface: ModuleInterface,
  finding: PrepassTimingFinding,
): Result<TimingContract, TimingRefusal> {
  const dataInputNames = declaredDataInputNames(moduleInterface);
  const reported = reportedPortFacts(finding);
  const outputPortNames = declaredOutputPortNames(moduleInterface);
  const entries: TimingContractEntry[] = [];
  let refusal: TimingRefusal | null = null;
  for (const portName of outputPortNames) {
    const classified = classifyOnePort(reported, portName, dataInputNames);
    if (classified.ok) {
      entries.push({ portName, timing: classified.value });
      continue;
    }
    refusal = accumulate(refusal, portName, classified.error);
  }
  if (refusal !== null) return err(refusal);
  // The sole supported constructor (Req 2.6). Its totality check is a SECOND line of defence here:
  // `entries` carries one value per name of `outputPortNames`, which is the same deduplicated set
  // `makeTimingContract` derives, so no entry can be extra, duplicated, or missing.
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    // Unreachable. A reached arm would mean this module and `makeTimingContract` disagree about the
    // declared output set, which voids the finding for every port, so it refuses under the
    // design-level cause rather than throwing or quoting the constructor's message (Req 2.5).
    return err({ cause: 'netlist-walk-unreliable', ports: outputPortNames });
  }
  return ok(built.value);
}
