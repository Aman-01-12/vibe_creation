// The reviewed Structural_Gate exclusion list: the designs the real Structural_Gate
// refuses even though Icarus Verilog compiles them.
//
// WHY THIS IS A COMMITTED CONSTANT RATHER THAN A RUNTIME RESULT
//   The Retained_Reference_Set has to be known without the toolchain - a reviewer, and
//   `isExcludedFromConsensusRegression`, must be able to see which designs the gate drops
//   and why without running Yosys. So the outcome is recorded here, and the calibration
//   suite of task 7.5 (C10) asserts that a real Structural_Gate run reproduces this list
//   EXACTLY - in both directions. A design that starts passing fails the ratchet test too,
//   so the list can only shrink through a deliberate, reviewed edit. It is the same ratchet
//   discipline `stage0-quarantine.ts` uses for the Stage 0 corpus baseline.
//
// WHAT THESE TWO CASES ACTUALLY ARE
//   Both compile fine under Icarus; both fail inside Yosys's synthesis frontend before the
//   Lint_Check can even reach `synth -top`, so each entry's `failingChecks` names both
//   checks. `rtllm/arithmetic/float_multi` reports "Found non-synthesizable event list" -
//   its reference uses an event-control construct Yosys's frontend does not accept.
//   `rtllm/miscellaneous/synchronizer` reports "Multiple edge sensitive events found for
//   this signal" - more than one edge-sensitive event drives the same always block.
//
// NOTE: this is a statement about Yosys 0.69's synthesis frontend, not about RTLLM's
// design quality - both references are valid Verilog that Icarus happily simulates.

import type { StructuralGateCheckName } from '@app/agent';

/** One reviewed Structural_Gate exclusion. */
export interface StructuralGateExclusion {
  readonly problemId: string;
  /** The Structural_Gate check names this reference does not pass. */
  readonly failingChecks: readonly StructuralGateCheckName[];
  /** The measured Yosys error, recorded so the exclusion is reviewable, not just counted. */
  readonly reason: string;
}

/**
 * The designs the real Structural_Gate refuses, measured against Yosys 0.69+post.
 *
 * Both entries fail with `failingChecks: ['lint', 'synthesis']`: the Lint_Job runs
 * `synth` first, so it cannot reach its own check on a design Yosys's frontend already
 * refused.
 */
export const STRUCTURAL_GATE_EXCLUSIONS: readonly StructuralGateExclusion[] = Object.freeze([
  {
    problemId: 'rtllm/arithmetic/float_multi',
    failingChecks: ['lint', 'synthesis'],
    reason: 'Yosys reports "Found non-synthesizable event list".',
  },
  {
    problemId: 'rtllm/miscellaneous/synchronizer',
    failingChecks: ['lint', 'synthesis'],
    reason: 'Yosys reports "Multiple edge sensitive events found for this signal".',
  },
]);

/** The excluded problem ids, derived so the two can never drift apart. */
export const STRUCTURAL_GATE_EXCLUSION_IDS: readonly string[] = Object.freeze(
  STRUCTURAL_GATE_EXCLUSIONS.map((entry) => entry.problemId),
);

/**
 * Student-facing framing for these two exclusions: a refusal to synthesize is correct
 * product behaviour, so the product refuses a Spec built from either design for a
 * student too, not just for this regression suite.
 */
export const STRUCTURAL_GATE_EXCLUSION_NOTE: string =
  'The Structural_Gate refuses these two designs because Yosys cannot synthesize ' +
  'them - a correct refusal, not a harness defect - and the product refuses a Spec ' +
  'built from either design for a student too.';
