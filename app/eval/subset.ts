// The fixed, hand-written SMOKE subset (Req 15.1).
//
// KEPT, DELIBERATELY, NOW THAT A REAL CORPUS EXISTS
//   `./corpus/` imports the full 50-design RTLLM benchmark at a pinned commit, and
//   that is the real, benchmark-sized corpus pass@k should be reported against. These
//   three hand-written problems are NOT superseded by it, because they are the only
//   subset the harness can be exercised against with NO corpus fetch and NO EDA
//   toolchain: every harness unit test, the pass@k measurement seam, and the
//   eval-harness integration test drive this list. Retiring it would leave those with
//   nothing to run on a plain dev box, and the recorded `eval-baseline.json` arming
//   procedure refers to it. So it stays, scoped explicitly as a smoke subset rather
//   than as the benchmark.
//
// Each problem is a pre-approved `Spec` with an exact module interface and
// simulation-verifiable acceptance criteria, carrying only what the loop needs to
// attempt it.
//
// The problem ids are stable slugs: a recorded baseline references them, and they
// feed the deterministic per-sample seed, so they must not change once published.
// They also must never collide with an imported corpus id (`rtllm/<category>/<design>`);
// `subset.test.ts` asserts that structurally rather than trusting this comment.

import {
  makePort,
  makeTimingContract,
  newUlid,
  type AcceptanceCriterion,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type Spec,
  type TimingContract,
  type TimingContractEntry,
} from '@app/core';

import type { EvalProblem } from './problem.js';

/**
 * Build a `Port` for a fixture, throwing if the hardcoded values are invalid.
 *
 * These are static, in-repo fixtures, so an invalid width or empty name is an
 * authoring defect that must fail loudly at load time, not a runtime input to be
 * handled gracefully. `makePort` enforces the positive-width invariant (Req 5.3).
 */
function port(name: string, direction: PortDirection, width: number): Port {
  const built = makePort({ name, direction, width });
  if (!built.ok) {
    throw new Error(`Invalid eval fixture port "${name}": ${built.error.message}`);
  }
  return built.value;
}

/** Build one simulation-verifiable acceptance criterion with a fresh identity. */
function criterion(text: string): AcceptanceCriterion {
  return { id: newUlid(), text, measurable: true, method: 'simulation' };
}

/**
 * Build the Timing_Contract for a fixture, throwing if a declared entry does not
 * exactly cover the interface's output ports.
 *
 * Built through `makeTimingContract` rather than hand-assembled, so a fixture that
 * later gains an output port fails construction instead of silently shipping a
 * contract with a missing entry.
 */
function timingContract(
  moduleInterface: ModuleInterface,
  entries: readonly TimingContractEntry[],
): TimingContract {
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`Invalid eval fixture timing contract: ${built.error.message}`);
  }
  return built.value;
}

/** Assemble an approved single-module Spec fixture. */
function approvedSpec(input: {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly moduleInterface: ModuleInterface;
  readonly portTimings: readonly TimingContractEntry[];
  readonly criteria: readonly string[];
  readonly architecture: string;
}): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: input.goal,
    constraints: input.constraints,
    moduleInterface: input.moduleInterface,
    timingContract: timingContract(input.moduleInterface, input.portTimings),
    acceptanceCriteria: input.criteria.map(criterion),
    architecture: input.architecture,
    approved: true,
    version: 1,
  };
}

/** VerilogEval-style: an 8-bit ripple-carry adder with carry in/out. */
const ADDER8: EvalProblem = {
  id: 'verilogeval/adder8',
  title: '8-bit adder with carry',
  source: 'VerilogEval',
  intentSummary: 'A combinational 8-bit adder that sums two bytes with a carry in and carry out.',
  spec: approvedSpec({
    goal: 'Add two 8-bit operands with a carry-in, producing an 8-bit sum and a carry-out.',
    constraints: ['Purely combinational', 'No latches'],
    moduleInterface: {
      moduleName: 'adder8',
      ports: [
        port('a', 'input', 8),
        port('b', 'input', 8),
        port('cin', 'input', 1),
        port('sum', 'output', 8),
        port('cout', 'output', 1),
      ],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
      validityOutputName: null,
    },
    portTimings: [
      { portName: 'sum', timing: 'combinational' },
      { portName: 'cout', timing: 'combinational' },
    ],
    criteria: [
      'sum equals the low 8 bits of a + b + cin across representative operand pairs',
      'cout equals the carry out of a + b + cin, including the all-ones overflow case',
    ],
    architecture: 'A single continuous assignment computing {cout, sum} = a + b + cin.',
  }),
};

/** RTLLM-style: a synchronous 4-bit up counter with active-low reset and enable. */
const COUNTER4: EvalProblem = {
  id: 'rtllm/counter4',
  title: '4-bit synchronous up counter',
  source: 'RTLLM',
  intentSummary:
    'A 4-bit counter that increments on each rising clock edge when enabled and clears on an active-low synchronous reset.',
  spec: approvedSpec({
    goal: 'Count up modulo 16 on each clock edge while enabled, clearing to zero on reset.',
    constraints: ['Synchronous active-low reset', 'Increment gated by enable'],
    moduleInterface: {
      moduleName: 'counter4',
      ports: [port('en', 'input', 1), port('count', 'output', 4)],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
      validityOutputName: null,
    },
    portTimings: [{ portName: 'count', timing: 'registered' }],
    criteria: [
      'count holds its value on any cycle where en is low',
      'count increments by one modulo 16 on each rising edge while en is high',
      'count is zero on the cycle after rst_n is asserted low',
    ],
    architecture: 'A single clocked always block with synchronous reset and an enable guard.',
  }),
};

/** VerilogEval-style: a 2:1 multiplexer over a parameterizable-looking 8-bit datapath. */
const MUX2: EvalProblem = {
  id: 'verilogeval/mux2',
  title: '8-bit 2:1 multiplexer',
  source: 'VerilogEval',
  intentSummary: 'A combinational 2:1 multiplexer that selects between two 8-bit inputs.',
  spec: approvedSpec({
    goal: 'Drive the output with input a when sel is 0 and input b when sel is 1.',
    constraints: ['Purely combinational'],
    moduleInterface: {
      moduleName: 'mux2',
      ports: [
        port('a', 'input', 8),
        port('b', 'input', 8),
        port('sel', 'input', 1),
        port('y', 'output', 8),
      ],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
      validityOutputName: null,
    },
    portTimings: [{ portName: 'y', timing: 'combinational' }],
    criteria: [
      'y equals a for every value of a when sel is 0',
      'y equals b for every value of b when sel is 1',
    ],
    architecture: 'A single continuous assignment: y = sel ? b : a.',
  }),
};

/**
 * The fixed curated subset the eval gate runs (Req 15.1).
 *
 * Ordered and immutable: the harness iterates it in this order and never mutates
 * it, so the run is deterministic. Exposed as a frozen array to make the "fixed"
 * guarantee structural.
 */
export const FIXED_EVAL_SUBSET: readonly EvalProblem[] = Object.freeze([ADDER8, COUNTER4, MUX2]);
