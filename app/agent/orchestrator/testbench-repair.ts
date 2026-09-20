// The Testbench_Repair port (Req 1.6, 2.8, 2.9, 6.4, 8.4, 8.5; task 6.2).
//
// WHY THIS IS A PORT DECLARED HERE AND IMPLEMENTED IN @app/eval
//   The Eval_Harness is the only caller that needs to consult repair, and it must
//   consult it for a Positive_Control-caused Repair_Trigger, before that sample's
//   Session_Budget is read for the record (Req 8.4). But repairing a testbench
//   against a Positive_Control needs the reference design, which only `@app/eval`
//   holds. `@app/agent` must never import `@app/eval` (Req 9.7), so the port lives
//   here, undecided by any implementation, and `EvalTestbenchRepair` (task 8.3,
//   `app/eval/testbench-repair.ts`) implements it by calling the SAME
//   `TestbenchAgent#repairTestbench` method the precheck path calls directly
//   (Req 8.4). This is the same role-local-port shape `instrument-admission.ts`
//   already uses to keep the orchestrator free of its callers.
//
// WHY `TestbenchRepairRequest` HAS EXACTLY THREE FIELDS, AND NO OTHERS
//   Structurally incapable of carrying candidate RTL or a wider budget handle: the
//   two fields beyond the Spec are the previously-generated testbench source and
//   the Repair_Hint, mirroring `InstrumentAdmissionRequest`'s one-field discipline
//   (Req 1.6, 2.8, 2.9). There is no field a `SessionBudgetHandle` or any
//   candidate's RTL could occupy, by construction rather than by convention.
//
// WHY THE OUTCOME COLLAPSES TO TWO SHAPES INSTEAD OF A THREE-WAY UNION
//   The three-member decision shape mirrors `InstrumentAdmissionDecision` exactly
//   (Req 6.4): `undecided` is the ONLY thing a throw or an internal failure may
//   report, and both `not-repaired` and `undecided` are handled identically by
//   every caller - "proceed exactly as without a repair" - so collapsing them to
//   one `TestbenchRepairDeclined` shape at the type level (rather than a
//   three-way switch at every call site) makes that equivalence a compile-time
//   fact instead of a convention three different callers each have to remember.

import type { Spec } from '@app/core';

import type { RepairHint } from './repair-hint.js';

/**
 * Whether a Testbench_Repair attempt produced a revised testbench.
 *
 * - `repaired`: the attempt produced a revised testbench source.
 * - `not-repaired`: the attempt ran and declined to revise the testbench.
 * - `undecided`: repair could not be determined; the caller proceeds exactly as
 *   it would with no port wired.
 */
export type TestbenchRepairDecision = 'repaired' | 'not-repaired' | 'undecided';

/**
 * Structurally incapable of carrying candidate RTL or a wider budget handle:
 * the two fields are the previously-generated testbench source and the
 * Repair_Hint, mirroring `InstrumentAdmissionRequest`'s one-field discipline
 * (Req 1.6, 2.8, 2.9).
 */
export interface TestbenchRepairRequest {
  readonly spec: Spec;
  readonly previousSource: string;
  readonly hint: RepairHint;
}

/** The revised testbench a successful repair produced, re-checked exactly like a first draft. */
export interface TestbenchRepairResult {
  readonly decision: 'repaired';
  readonly revisedSource: string;
}

/** Every non-`repaired` outcome collapses to this: the caller proceeds as if no port existed. */
export interface TestbenchRepairDeclined {
  readonly decision: 'not-repaired' | 'undecided';
}

export type TestbenchRepairOutcome = TestbenchRepairResult | TestbenchRepairDeclined;

/**
 * A port the Eval_Harness consults for a Positive_Control-caused Repair_Trigger,
 * before that sample's Session_Budget is read for the record (Req 5.4, 8.4).
 *
 * No implementation lives in `@app/agent`. See `app/eval/testbench-repair.ts`
 * for `EvalTestbenchRepair`, which calls the SAME `TestbenchAgent#repairTestbench`
 * method the precheck path calls directly (Req 8.4).
 */
export interface TestbenchRepair {
  repair(request: TestbenchRepairRequest): Promise<TestbenchRepairOutcome>;
}
