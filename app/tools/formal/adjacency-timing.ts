// The Sequential_Element-output Adjacency_Classifier: a SECOND, independent classifier over the
// same pre-pass `PrepassTimingFinding` facts, used ONLY by the task 13.2 search over the
// Derivation_Population (timing-contract-inference design.md Component 11; Req 6.13).
//
// NOT THE PRODUCTION RULE
//   `classifyPortTiming` in `timing.ts` is the one the Corpus_Importer and the Spec_Agent read.
//   This function exists for exactly one purpose: comparing against that rule's decision, port by
//   port, over every design that elaborates, so Requirement 1.10's "reachability rather than
//   adjacency" choice is backed by a measured search rather than an unmeasured assumption. It is
//   never wired into the Corpus_Importer, the Spec_Agent, or any production path.
//
// WHAT "ADJACENCY" MEANS HERE, AND ITS CEILING
//   Requirement 1.10 contrasts two tests: whether a Declared_Data_Input combinationally REACHES
//   the port (the question `classifyPortTiming` answers), against whether the port is ADJACENT TO
//   a Sequential_Element's own output - driven by it directly, with no intervening combinational
//   cell. The worker's cone walk stops at the first retained-state cell it meets and records only
//   `reachesState`, with no hop count and no "which cell drove this bit" field, so this classifier
//   cannot tell a bare `assign out = reg_q;` alias apart from a Moore decode sitting one gate
//   behind the same flop. The one signal the facts DO carry that bears on adjacency is whether the
//   cone also reaches a Declared_Data_Input: reaching one proves some combinational cell sits
//   between the port and any flop, because a bare flop-output alias reaches nothing else. Lacking
//   that proof, the cone's `reachesState` is read as adjacency.
//   ponytail: that is this module's ceiling, and it is why this rule reduces to the same decision
//   table as `classifyPortTiming` on every fact shape the worker currently reports - consistent
//   with Component 11's own measured finding that no corpus design separates the two rules. A
//   worker-reported immediate-driver fact is the upgrade path, and the task 13.2 search finding a
//   real disagreement is what would motivate spending it.
//
// Pure and total, like its sibling: no file, network, clock, model, or random-source read, and no
// throw on any input.

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
import type { TimingRefusal, TimingRefusalCause } from './timing.js';

/**
 * Lowest-number-wins precedence for a mixed-cause refusal, independent of `timing.ts`'s own
 * table: sharing one ranking between the two rules would make a refusal-ordering bug in either
 * rule invisible to the other, which defeats the point of keeping them separate implementations.
 */
const ADJACENCY_REFUSAL_CAUSE_PRECEDENCE: Readonly<Record<TimingRefusalCause, number>> =
  Object.freeze({
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

/** The Declared_Data_Input set: every input port minus the clock and the reset (Req 1.2, 1.3). */
function declaredDataInputNames(moduleInterface: ModuleInterface): ReadonlySet<string> {
  const names = new Set(
    moduleInterface.ports.filter((port) => port.direction === 'input').map((port) => port.name),
  );
  const { clockName, resetName } = moduleInterface.clocking;
  if (clockName !== null) names.delete(clockName);
  if (resetName !== null) names.delete(resetName);
  return names;
}

/** The finding's per-port cone facts keyed by port, or `null` where the whole walk refused. */
function reportedPortFacts(
  finding: PrepassTimingFinding,
): ReadonlyMap<string, PortTimingFacts> | null {
  if (!finding.derived) return null;
  return new Map(finding.ports.map((facts) => [facts.port, facts]));
}

/**
 * The adjacency decision for one declared output port.
 *
 * Reaching a Declared_Data_Input is read as proof of an intervening combinational cell, because a
 * bare flop-output alias reaches nothing else; absent that proof, `reachesState` is read as
 * adjacency to the Sequential_Element's own output.
 */
function classifyOnePortByAdjacency(
  reported: ReadonlyMap<string, PortTimingFacts> | null,
  portName: string,
  dataInputNames: ReadonlySet<string>,
): Result<PortTiming, TimingRefusalCause> {
  if (reported === null) return err('netlist-walk-unreliable');
  const facts = reported.get(portName);
  if (facts === undefined) return err('port-not-reported');
  if (facts.undriven) return err('undriven-output-port');
  if (facts.sources.some((source) => dataInputNames.has(source))) return ok('combinational');
  if (facts.reachesState) return ok('registered');
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
    ADJACENCY_REFUSAL_CAUSE_PRECEDENCE[cause] < ADJACENCY_REFUSAL_CAUSE_PRECEDENCE[refusal.cause]
      ? cause
      : refusal.cause;
  return { cause: dominant, ports: [...refusal.ports, portName] };
}

/**
 * Classify every declared output port of `moduleInterface` from one pre-pass timing finding, by
 * Sequential_Element-output adjacency rather than by Combinational_Path reachability.
 *
 * A search tool, not a production classifier (task 13.2 is its sole caller): returns a
 * Timing_Contract total over the declared output ports, or ONE `TimingRefusal` naming every
 * undetermined port, in the same shape `classifyPortTiming` returns so the two are directly
 * comparable port by port.
 *
 * Pure and total: reads nothing outside its two arguments and never throws.
 */
export function classifyPortTimingByAdjacency(
  moduleInterface: ModuleInterface,
  finding: PrepassTimingFinding,
): Result<TimingContract, TimingRefusal> {
  const dataInputNames = declaredDataInputNames(moduleInterface);
  const reported = reportedPortFacts(finding);
  const outputPortNames = declaredOutputPortNames(moduleInterface);
  const entries: TimingContractEntry[] = [];
  let refusal: TimingRefusal | null = null;
  for (const portName of outputPortNames) {
    const classified = classifyOnePortByAdjacency(reported, portName, dataInputNames);
    if (classified.ok) {
      entries.push({ portName, timing: classified.value });
      continue;
    }
    refusal = accumulate(refusal, portName, classified.error);
  }
  if (refusal !== null) return err(refusal);
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    // Unreachable, mirroring `classifyPortTiming`'s own guard: `entries` carries one value per
    // name of `outputPortNames`, the same deduplicated set `makeTimingContract` derives.
    return err({ cause: 'netlist-walk-unreliable', ports: outputPortNames });
  }
  return ok(built.value);
}
