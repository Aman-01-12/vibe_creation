// The Structural_Gate port: the existing ADR-018 layer 1 admission checks (port
// and width conformance against the Declared_Interface, compilation under Icarus
// Verilog, lint, and synthesis under Yosys), consumed through one port so the
// per-check results are retained for the Unverified_Outcome (C4; Req 1.5, 14.3,
// 17.3).
//
// NO NEW GATE LOGIC. This file declares the seam, never a new check: a production
// `StructuralGate` is built by composing the admission tools that already exist -
// `checkInterfaceExact`/`parseModuleInterface` (`app/agent/roles/generation`) for
// port and width conformance, `SimulatorCandidateCompiler` (same package) for
// Icarus compilation, and `YosysNetlistSvgAdapter` (`app/tools/synth`) for Yosys
// synthesis - rather than reimplementing any of them here. Lint has no existing
// adapter in this codebase (`chipAgent/_inbox/gotcha-worker-synthesize-kind-unimplemented.md`
// records that even the worker's Yosys synthesize path is not yet wired), so the
// composition that fills `admit` is a later task's wiring, not this file's job.
//
// A design that fails the gate never enters the Design_Pool, so it is not an
// Agreement_Cluster member, not a Trust_Vote voter, and not a Fault_Attributor
// peer (Req 1.5). `checks` is a fixed-order list of `{name, passed}` rather than a
// map, so the Unverified_Outcome report renders in one order across every Session
// and a missing check is visible rather than silently absent from a key set
// (Req 14.3).

import type { Spec } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

/** One Candidate_Design's Structural_Gate outcome, with per-check retention (Req 14.3). */
export interface StructuralGateResult {
  readonly admitted: boolean;
  /** Per-check outcomes in a fixed order, retained for the Unverified_Outcome. */
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
}

/**
 * The Structural_Gate port (design C4): admit one Candidate_Design or refuse it,
 * retaining why.
 *
 * Callers depend on this interface, never on the concrete interface-check,
 * compile, and synthesis tools a production adapter composes to implement it.
 */
export interface StructuralGate {
  admit(
    spec: Spec,
    rtl: readonly SourceFile[],
    limits: ResourceLimits,
  ): Promise<StructuralGateResult>;
}

/**
 * Filter a candidate list to the subset the Structural_Gate admitted.
 *
 * This is what defines the Design_Pool's cardinality N (Req 1.5): a design that
 * fails the gate never enters the pool, and every later decision reads the
 * admitted cardinality rather than the generated count. Pure and generic over the
 * candidate's own shape, because the Design_Pool's element type belongs to the
 * orchestrator (C1) that assembles it, not to this gate.
 */
export function admittedPool<T>(
  candidates: readonly { readonly design: T; readonly result: StructuralGateResult }[],
): readonly T[] {
  return candidates
    .filter((candidate) => candidate.result.admitted)
    .map((candidate) => candidate.design);
}
