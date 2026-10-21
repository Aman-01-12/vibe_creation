// Shared Timing_Contract test fixture (task 1.3: `Spec` migration).
//
// No property test in this repository asserts anything about per-port timing yet
// (that is `reference-model-consensus-gate`'s own later work), so every fixture
// Spec just needs SOME valid `TimingContract` to satisfy the type. Placing every
// output port at `registered` here, once, is the shared "placeholder" the many
// `approvedSpec()`-style fixtures across `app/agent`, `app/eval`, and `app/test`
// would otherwise each re-derive by hand.
//
// ponytail: `registered` is a guess the design itself rules out as a default for
// production code (13 of 31 clocked references disagree, Req 6.2) - safe here only
// because these are test fixtures nothing reads the specific timing of. Replace a
// fixture's call to this helper with real per-port entries the moment a test
// starts asserting on `Spec.timingContract`.

import type { ModuleInterfaceDraft, TimingContractEntryDraft } from '@app/agent';
import { makeTimingContract, type ModuleInterface, type TimingContract } from '@app/core';

/**
 * Build a placeholder `TimingContract` placing every output port at `registered`.
 *
 * Throws if `moduleInterface`'s own output ports somehow fail to construct a
 * contract, which is unreachable: the entries are derived from exactly those ports.
 */
export function timingContractFor(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`timingContractFor built an invalid timing contract: ${built.error.message}`);
  }
  return built.value;
}

/**
 * One `registered` statement per distinct declared output port of a `SpecDraft`
 * interface, so the Spec role's timing gate never fires.
 *
 * Used by property tests whose subject is a DIFFERENT Spec gate: they need a
 * complete contract statement, not an interesting one. A name repeated across two
 * port declarations gets ONE entry, because a second would be the duplicate
 * statement the gate rejects.
 */
export function statedTimingEntriesFor(
  moduleInterface: ModuleInterfaceDraft,
): TimingContractEntryDraft[] {
  const outputNames = new Set(
    moduleInterface.ports.filter((port) => port.direction === 'output').map((port) => port.name),
  );
  return [...outputNames].map((portName) => ({ portName, timing: 'registered' }));
}
