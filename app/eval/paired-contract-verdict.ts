// The Paired_Contract_Experiment's verdict (timing-contract-inference task 15.3; Req 8.6).
//
// WHY THIS IS ITS OWN PURE MODULE
//   Task 15.2's measurement harness (`app/test/timing-paired-contract-experiment-adder-8bit.
//   integration.test.ts`) decides pass/fail inline, over fixtures with structurally nothing
//   else to read. That proves the verdict ignores model-quality figures by ABSENCE: there is
//   nothing of that kind in the file. This module proves the same claim by SIGNATURE instead:
//   `decidePairedContractVerdict` takes exactly `{ checkFailCount, passed }` and nothing else,
//   so no trusted-testbench count, peer vote, or Mutation_Strength_Gate outcome could ever
//   reach it even if a caller tried to pass one in - the type itself refuses the attempt.
//
// WHY `passed` IS A SEPARATE FIELD RATHER THAN DERIVED FROM `checkFailCount === 0`
//   The run-matrix pass outcome and the CHECK-FAIL count are two independently reported facts
//   of one simulation run (Req 8.2's "report... for each contract"): a run can fail for a
//   reason the CHECK-FAIL count does not capture (a build failure, a watchdog timeout, a
//   resource kill), so collapsing them into one derived boolean would silently misreport that
//   class of failure as "contract supported, zero CHECK-FAIL" when nothing was actually judged.

/** Whether this measurement supports or undermines the Timing_Contract root-cause claim. */
export type PairedContractVerdict = 'supported' | 'unsupported';

/** The only two facts the verdict reads: the run-matrix pass outcome, and the CHECK-FAIL
 *  count of a single simulated run under one Timing_Contract and one reference-model style. */
export interface PairedContractMeasurement {
  readonly checkFailCount: number;
  readonly passed: boolean;
}

/**
 * Decide the verdict from exactly the run's own pass outcome and CHECK-FAIL count (Req 8.6).
 *
 * `'supported'`: the run passed with zero CHECK-FAIL, which is the derived contract's own
 * claim holding under measurement. `'unsupported'`: the run failed or reported a non-zero
 * CHECK-FAIL count, which is the pre-feature fabrication's own failure mode reproduced under
 * the measurement - task 15.2's own wording for this ("record the Timing_Contract root cause
 * as unsupported by that measurement").
 *
 * Pure and total: no file, network, model, or random-source read, and no parameter through
 * which a model-quality figure could arrive.
 */
export function decidePairedContractVerdict(
  measurement: PairedContractMeasurement,
): PairedContractVerdict {
  return measurement.passed && measurement.checkFailCount === 0 ? 'supported' : 'unsupported';
}
