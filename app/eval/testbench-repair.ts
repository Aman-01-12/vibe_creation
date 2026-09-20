// The EVAL TESTBENCH_REPAIR adapter, and the total trigger-selection function it
// is driven by (Req 1.1-1.2, 5.1, 5.5, 6.1-6.4, 8.4; task 8.1, 8.2).
//
// WHAT THIS ADAPTS
//   `TestbenchRepair` (`@app/agent`) is a port the Eval_Harness consults for a
//   Positive_Control-caused Repair_Trigger, before that sample's Session_Budget is
//   read for the record (Req 5.4, 8.4). Repairing a testbench against a Positive_
//   Control needs the reference design, which only `@app/eval` holds, so the
//   decision has to be made here and handed to the harness through the port it
//   already knows about - the same role-local-port shape `instrument-admission.ts`
//   already uses (Req 9.7 forbids `@app/agent` importing `@app/eval`).
//
// WHY NO MEMOIZATION FIELD, UNLIKE `MemoizingInstrumentAdmission`
//   `MemoizingInstrumentAdmission` memoizes because the loop and the harness might
//   BOTH read the same control result, and the control must run at most once
//   either way it is asked for. `EvalTestbenchRepair` has exactly one caller (the
//   harness's `#repairIfTriggered`, called at most once per sample because of the
//   `precheckProvenance.attempted` gate upstream of it), so there is no second
//   reader to protect against a duplicate run - Req 1.5's "exactly one model call
//   when it fires" is a property of that single call site, not of this class.
//
// `repairTriggerFor` READS ONLY SPEC-DERIVED AND CALLER-SUPPLIED FACTS
//   `RecordedInstrumentVerdict` is a closed enum with no free-text field and no
//   Spec/diagnostic of its own (see `./instrument-control.ts`'s "WHY THE RECORDED
//   VERDICT CARRIES NO FREE TEXT"), so a `failed-reference` trigger's failing
//   check name and rule family, and a `reference-unbuildable` trigger's
//   diagnostic, cannot be derived from the verdict alone. They are supplied by
//   the caller instead: `spec` (the SAME `Spec` the harness's `EvalProblem`
//   already carries) for the first two, and `diagnostic` (the SAME
//   `InstrumentControlResult.stderr` the harness's control result already
//   carries alongside the verdict) for the third. Passing exactly these two
//   extra parameters - never a wider object, never the control's stdout - keeps
//   this function reading only what design.md's Component 2 data-flow trace
//   already proves is Spec-derived-or-toolchain-diagnostic, never the
//   reference's observed value (Req 2.4-2.6's anti-circularity guarantee,
//   extended to this call site).
//
//   The failing check name is taken as `requiredChecks(spec)[0].name`: this
//   function deliberately picks the first required check rather than
//   disambiguating which of several actually failed, mirroring design.md's own
//   note that "a future task may additionally read `simulation.checks` ... to
//   confirm which of the several required checks failed when more than one
//   exists" - a refinement left to a later task, not attempted here.

import { requiredChecks, ruleFamilyFor } from '@app/agent';
import type {
  RepairTestbenchRequest,
  RepairTrigger,
  SessionBudgetHandle,
  TestbenchGenerationOutcome,
  TestbenchRepair,
  TestbenchRepairOutcome,
  TestbenchRepairRequest,
} from '@app/agent';
import type { Spec, Ulid } from '@app/core';

import type { InstrumentDefectCode, RecordedInstrumentVerdict } from './instrument-control.js';

/** The narrow port `EvalTestbenchRepair` depends on: `repairTestbench` alone. */
export interface RepairingTestbenchGenerator {
  repairTestbench(
    request: RepairTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome>;
}

/**
 * How each triggering defect builds its `RepairTrigger`; total, so a new
 * `InstrumentDefectCode` member is a compile error here rather than a silent
 * no-fire (Req 1.1, 1.2).
 */
const TRIGGERING_DEFECTS: ReadonlySet<InstrumentDefectCode> = new Set([
  'TESTBENCH_FAILED_REFERENCE',
  'TESTBENCH_REFERENCE_UNBUILDABLE',
]);

/**
 * The total function reading Requirement 1.1-1.2's closed trigger set directly
 * off a `RecordedInstrumentVerdict` (Req 1.1, 1.2).
 *
 * Returns a `RepairTrigger` for exactly `{ invalid, TESTBENCH_FAILED_REFERENCE }`
 * and `{ invalid, TESTBENCH_REFERENCE_UNBUILDABLE }`, and `null` for every other
 * validity/defect combination - including `TESTBENCH_SURVIVED_MUTANTS`,
 * `CONTROL_RUN_ERRORED`, and every `unchecked` reason.
 *
 * `spec` and `diagnostic` are supplied by the caller because the verdict alone
 * cannot carry them: `spec` derives the `failed-reference` trigger's
 * `failingCheckName` (via `requiredChecks`) and `ruleFamily` (via
 * `ruleFamilyFor`, over `spec.moduleInterface`); `diagnostic` is the
 * `reference-unbuildable` trigger's build-diagnostic text, read from the SAME
 * control result the verdict itself came from (`InstrumentControlResult.stderr`)
 * and never from the reference's observed stdout.
 */
export function repairTriggerFor(
  verdict: RecordedInstrumentVerdict,
  spec: Spec,
  diagnostic: string,
): RepairTrigger | null {
  if (verdict.validity !== 'invalid' || !TRIGGERING_DEFECTS.has(verdict.defect)) {
    return null;
  }
  if (verdict.defect === 'TESTBENCH_REFERENCE_UNBUILDABLE') {
    return { kind: 'reference-unbuildable', diagnostic };
  }
  const [firstCheck] = requiredChecks(spec);
  if (firstCheck === undefined) {
    return null; // No required check exists to name; nothing to attribute the failure to.
  }
  return {
    kind: 'failed-reference',
    failingCheckName: firstCheck.name,
    ruleFamily: ruleFamilyFor(firstCheck, spec.moduleInterface),
  };
}

/**
 * The `TestbenchRepair` port, backed by the SAME `TestbenchAgent` the loop's
 * setup uses.
 *
 * One instance per sample, constructed with the sample's own `sessionId` and its
 * own `SessionBudgetHandle` - the SAME per-sample budget the loop's generation
 * and testbench calls already charge against (Req 5.1, 5.5), so a repair attempt
 * is accounted for inside the identical budget a first draft is.
 */
export class EvalTestbenchRepair implements TestbenchRepair {
  readonly #testbenchAgent: RepairingTestbenchGenerator;
  readonly #sessionId: Ulid;
  readonly #budget: SessionBudgetHandle;

  constructor(
    testbenchAgent: RepairingTestbenchGenerator,
    sessionId: Ulid,
    budget: SessionBudgetHandle,
  ) {
    this.#testbenchAgent = testbenchAgent;
    this.#sessionId = sessionId;
    this.#budget = budget;
  }

  async repair(request: TestbenchRepairRequest): Promise<TestbenchRepairOutcome> {
    let outcome: TestbenchGenerationOutcome;
    try {
      outcome = await this.#testbenchAgent.repairTestbench(
        {
          sessionId: this.#sessionId,
          spec: request.spec,
          previousSource: request.previousSource,
          hint: request.hint,
        },
        this.#budget,
      );
    } catch {
      return { decision: 'undecided' }; // Req 6.1, 6.2, 6.4: fail-safe, never propagates.
    }
    return outcome.status === 'generated'
      ? { decision: 'repaired', revisedSource: outcome.testbench.source }
      : { decision: 'not-repaired' }; // coverage-incomplete or generation-failed: Req 6.1, 6.3
  }
}
