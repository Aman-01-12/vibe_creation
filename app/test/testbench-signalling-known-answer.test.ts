// Example/edge-case unit tests for the Testbench_Agent's per-check pass/fail
// signalling and its known-answer checks for standard blocks (task 13.6; Req 7.4,
// 7.5, 7.6).
//
// These are concrete example-based unit tests that complement the universal
// fast-check properties (Property 4 RTL-isolation, Property 6 criterion coverage).
// They pin three behaviors the design's Testing Strategy calls out as example/
// edge-case cases:
//
//   - Req 7.6 - the emitted per-check signal is UNAMBIGUOUS and the Simulator run
//     can report it: every `formatCheckLine` output round-trips through the REAL
//     oracle reader (`@app/tools` `readCheckSignals`) to exactly one pass/fail
//     result, PASS and FAIL are mutually exclusive interpretations, and an
//     unparseable (whitespace-bearing) check name is rejected at construction
//     rather than emitted as an ambiguous line.
//   - Req 7.4 - the generation input directs boundary/error stimulus, not only
//     nominal inputs, and pins the exact per-check output contract.
//   - Req 7.5 - every curated standard block is detected from Spec-derived text
//     ALONE (module name / goal / architecture, never RTL) and contributes exactly
//     one known-answer check, while a bespoke design contributes none; the
//     known-answer check flows through to the produced Testbench and its prompt.
//
// The oracle round-trip is the crux of "unambiguous": the generation side
// (`formatCheckLine`) and the oracle side (`readCheckSignals`) are asserted to
// agree, so the two cannot drift into an ambiguous or unreadable signal.

import { describe, expect, it } from 'vitest';

import {
  TestbenchAgent,
  buildTestbenchModelInput,
  detectStandardBlocks,
  formatCheckLine,
  isValidCheckName,
  requiredChecks,
  simulationCriteria,
  sourceEmitsCheck,
  CHECK_KEYWORD,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TraceActionRecorder,
  type GenerateTestbenchRequest,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RequiredCheck,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
} from '@app/agent';
import {
  makeSessionBudget,
  newUlid,
  type AcceptanceCriterion,
  type ClockingContract,
  type Port,
  type Result,
  type Spec,
} from '@app/core';
import type { KnowledgeQuery, KnowledgeRetriever, RetrievalResult } from '@app/knowledge';
import { routedModelIdFor, timingContractFor } from '@app/test';
import { readCheckSignals } from '@app/tools';

// --- Fixtures ----------------------------------------------------------------

/** A short profile of a module under construction, used to build a Spec. */
interface ModuleProfile {
  readonly moduleName: string;
  readonly goal: string;
  readonly architecture: string;
  /**
   * The declared clocking, defaulting to combinational.
   *
   * A known-answer reference whose behavior is a clocked SEQUENCE is only
   * justifiable when the interface declares a clock, so a profile for such a block
   * must declare one rather than describe an unsteppable design.
   */
  readonly clocking?: ClockingContract;
}

/** The clocking contract a sequential profile declares. */
const CLOCKED: ClockingContract = { clockName: 'clk', resetName: 'rst', resetActiveLow: false };

/** The clocking contract a combinational profile declares (the default). */
const COMBINATIONAL: ClockingContract = {
  clockName: null,
  resetName: null,
  resetActiveLow: false,
};

/** Build one measurable, simulation-verifiable acceptance criterion. */
function criterion(text: string): AcceptanceCriterion {
  return { id: newUlid(), text, measurable: true, method: 'simulation' };
}

/** The single-bit data ports every profile declares. */
const DATA_PORTS: readonly Port[] = [
  { name: 'a', direction: 'input', width: 1 },
  { name: 'b', direction: 'input', width: 1 },
  { name: 'y', direction: 'output', width: 1 },
];

/** The clock and reset ports a sequential profile declares alongside its data ports. */
const CLOCK_PORTS: readonly Port[] = [
  { name: 'clk', direction: 'input', width: 1 },
  { name: 'rst', direction: 'input', width: 1 },
];

/** Build an approved Spec for a module profile with a single simulation criterion. */
function approvedSpec(profile: ModuleProfile): Spec {
  const clocking = profile.clocking ?? COMBINATIONAL;
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: profile.moduleName,
      ports: clocking.clockName === null ? DATA_PORTS : [...CLOCK_PORTS, ...DATA_PORTS],
      clocking,
    }),
    id: newUlid(),
    projectId: newUlid(),
    goal: profile.goal,
    constraints: ['single module'],
    architecture: profile.architecture,
    moduleInterface: {
      validityOutputName: null,
      moduleName: profile.moduleName,
      ports: clocking.clockName === null ? DATA_PORTS : [...CLOCK_PORTS, ...DATA_PORTS],
      clocking,
    },
    acceptanceCriteria: [criterion('output matches the reference for every input combination')],
    approved: true,
    version: 1,
  };
}

/** A generous budget so the model seam, not the budget, drives every case. */
function generousBudget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 100,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) {
    throw new Error('test budget must be valid');
  }
  return new InMemorySessionBudgetHandle(built.value);
}

/** A successful routed result carrying the given output text as the model reply. */
function routed(outputText: string): Result<RoutedModelResult, ModelRouterFailure> {
  return {
    ok: true,
    value: {
      task: 'testbench',
      provider: 'deepseek',
      modelId: routedModelIdFor('deepseek'),
      outputText,
      tokensUsed: 42,
      costCents: 5,
      attempts: 1,
      fellBack: false,
    },
  };
}

/** A fake Model_Router that returns a scripted result and charges the budget once. */
class FakeModelRouter implements ModelRouter {
  constructor(private readonly script: Result<RoutedModelResult, ModelRouterFailure>) {}

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    void task;
    void request;
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve(this.script);
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A fake Knowledge_Retriever that returns no passages (OKF hints are optional). */
class EmptyKnowledgeRetriever implements KnowledgeRetriever {
  retrieve(query: KnowledgeQuery): Promise<RetrievalResult> {
    void query;
    return Promise.resolve({
      passages: [],
      citations: [],
      facts: [],
      source: 'okf',
      sanitized: true,
    });
  }
}

/** Wire a fresh Testbench_Agent around a scripted fake router + recorder + retriever. */
function agentReturning(script: Result<RoutedModelResult, ModelRouterFailure>): TestbenchAgent {
  return new TestbenchAgent({
    router: new FakeModelRouter(script),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    retriever: new EmptyKnowledgeRetriever(),
    now: () => 1_700_000_000_000,
  });
}

/** A generate request for a fresh session against the given Spec. */
function request(spec: Spec): GenerateTestbenchRequest {
  return { sessionId: newUlid(), spec, intentSummary: 'Build the module described by the Spec.' };
}

/** Build a parseable testbench source that emits a passing CHECK line for each check. */
function sourceCovering(checks: readonly RequiredCheck[]): string {
  const lines = checks.map((check) => `      $display("${formatCheckLine(check.name, true)}");`);
  return ['module tb;', '  initial begin', ...lines, '    $finish;', '  end', 'endmodule'].join(
    '\n',
  );
}

// --- Req 7.6: unambiguous per-check pass/fail signalling ----------------------

describe('per-check signal is unambiguous and the oracle can report it (Req 7.6)', () => {
  it('formats each check as exactly "CHECK <name> PASS|FAIL"', () => {
    expect(formatCheckLine('reset_clears_output', true)).toBe('CHECK reset_clears_output PASS');
    expect(formatCheckLine('counts_up', false)).toBe('CHECK counts_up FAIL');
    expect(CHECK_KEYWORD).toBe('CHECK');
  });

  it('round-trips a PASS line through the real oracle reader to one passing result', () => {
    const reading = readCheckSignals(`${formatCheckLine('sum_matches_reference', true)}\n`);
    expect(reading.checks).toEqual([{ name: 'sum_matches_reference', passed: true }]);
    expect(reading.unreadableSignals).toBe(0);
  });

  it('round-trips a FAIL line through the real oracle reader to one failing result', () => {
    const reading = readCheckSignals(`${formatCheckLine('carry_matches_reference', false)}\n`);
    expect(reading.checks).toEqual([{ name: 'carry_matches_reference', passed: false }]);
    expect(reading.unreadableSignals).toBe(0);
  });

  it('reports one unambiguous result per check, in emission order, ignoring diagnostics', () => {
    const stdout = [
      'VCD info: dumpfile dump.vcd opened',
      formatCheckLine('drives_nominal', true),
      'some human-readable $display note',
      formatCheckLine('drives_boundary', false),
      'simulation finished',
    ].join('\n');

    expect(readCheckSignals(stdout).checks).toEqual([
      { name: 'drives_nominal', passed: true },
      { name: 'drives_boundary', passed: false },
    ]);
  });

  it('treats PASS and FAIL as mutually exclusive: a line means exactly one verdict', () => {
    const name = 'edge_case';
    const passResults = readCheckSignals(formatCheckLine(name, true)).checks;
    const failResults = readCheckSignals(formatCheckLine(name, false)).checks;

    expect(passResults).toEqual([{ name, passed: true }]);
    expect(failResults).toEqual([{ name, passed: false }]);
    // The same name never parses to both verdicts from a single formatted line.
    expect(passResults[0]?.passed).not.toBe(failResults[0]?.passed);
  });

  it('rejects a check name with whitespace instead of emitting an unparseable line', () => {
    expect(isValidCheckName('has spaces')).toBe(false);
    expect(isValidCheckName('has\ttab')).toBe(false);
    expect(isValidCheckName('')).toBe(false);
    expect(isValidCheckName('sum_matches_reference')).toBe(true);
    // A whitespace-bearing name would split the line and be ambiguous, so
    // formatting fails closed rather than emitting a signal the oracle misreads.
    expect(() => formatCheckLine('has spaces', true)).toThrow();
  });

  it('detects a check emission without matching a longer-named sibling by prefix', () => {
    const source = sourceCovering([
      { name: 'reset_clears_output', kind: 'criterion', description: 'reset clears output' },
    ]);
    expect(sourceEmitsCheck(source, 'reset_clears_output')).toBe(true);
    // `reset` must not spuriously match the `reset_clears_output` emission.
    expect(sourceEmitsCheck(source, 'reset')).toBe(false);
  });
});

// --- Req 7.4/7.6: the generation input pins the contract ----------------------

describe('generation input directs boundary/error stimulus and the output contract (Req 7.4, 7.6)', () => {
  it('instructs the model to drive boundary/error stimulus, not only nominal inputs', () => {
    const spec = approvedSpec({
      moduleName: 'full_adder',
      goal: 'A single-bit full adder',
      architecture: 'Combinational sum and carry logic.',
    });
    const modelInput = buildTestbenchModelInput(
      { spec, intentSummary: 'a full adder', okfPassages: [] },
      requiredChecks(spec),
    );

    expect(modelInput.prompt).toContain('boundary/error stimulus');
    // The exact per-check output contract is pinned in the instructions (Req 7.6).
    expect(modelInput.prompt).toContain(`${CHECK_KEYWORD} <name> PASS`);
    expect(modelInput.prompt).toContain(`${CHECK_KEYWORD} <name> FAIL`);
  });

  it('names every required check (criterion and known-answer) in the prompt', () => {
    const spec = approvedSpec({
      moduleName: 'full_adder',
      goal: 'A single-bit full adder',
      architecture: 'Combinational sum and carry logic.',
    });
    const checks = requiredChecks(spec);
    const modelInput = buildTestbenchModelInput(
      { spec, intentSummary: 'a full adder', okfPassages: [] },
      checks,
    );

    expect(checks.some((check) => check.kind === 'known-answer')).toBe(true);
    for (const check of checks) {
      expect(modelInput.prompt).toContain(check.name);
    }
  });
});

// --- Req 7.5: known-answer checks for standard blocks -------------------------

/** Each curated standard block, a Spec phrasing that names it, and its check name. */
const STANDARD_BLOCK_CASES: ReadonlyArray<{
  readonly label: string;
  readonly profile: ModuleProfile;
  readonly block: string;
  readonly checkName: string;
}> = [
  {
    label: 'full adder',
    profile: {
      moduleName: 'full_adder',
      goal: 'A single-bit full adder',
      architecture: 'Sum and carry logic.',
    },
    block: 'full-adder',
    checkName: 'known_answer_full_adder_truth_table',
  },
  {
    label: 'half adder',
    profile: {
      moduleName: 'half_adder',
      goal: 'A single-bit half adder',
      architecture: 'Sum and carry logic.',
    },
    block: 'half-adder',
    checkName: 'known_answer_half_adder_truth_table',
  },
  {
    label: 'multiplexer',
    profile: {
      moduleName: 'mux2',
      goal: 'A 2-to-1 multiplexer',
      architecture: 'Select-driven combinational mux.',
    },
    block: 'multiplexer',
    checkName: 'known_answer_mux_selects_reference_input',
  },
  {
    label: 'decoder',
    profile: {
      moduleName: 'dec2to4',
      goal: 'A 2-to-4 decoder',
      architecture: 'One-hot decode logic.',
    },
    block: 'decoder',
    checkName: 'known_answer_decoder_one_hot',
  },
  {
    label: 'up counter',
    profile: {
      moduleName: 'up_counter',
      goal: 'A 4-bit up counter with reset',
      architecture: 'Clocked increment.',
      clocking: CLOCKED,
    },
    block: 'up-counter',
    checkName: 'known_answer_counter_increments',
  },
  {
    label: 'shift register',
    profile: {
      moduleName: 'shift_register',
      goal: 'An 8-bit shift register',
      architecture: 'Clocked shift chain.',
      clocking: CLOCKED,
    },
    block: 'shift-register',
    checkName: 'known_answer_shift_register_sequence',
  },
];

describe('known-answer checks for standard blocks (Req 7.5)', () => {
  it.each(STANDARD_BLOCK_CASES)(
    'detects the $label block from Spec text and adds its known-answer check',
    ({ profile, block, checkName }) => {
      const spec = approvedSpec(profile);

      const detected = detectStandardBlocks(spec);
      expect(detected.map((reference) => reference.block)).toContain(block);

      const knownAnswer = requiredChecks(spec).filter((check) => check.kind === 'known-answer');
      const names = knownAnswer.map((check) => check.name);
      expect(names).toContain(checkName);
      // A known-answer check traces to a reference block, never to a criterion id.
      for (const check of knownAnswer) {
        expect(check.criterionId).toBeUndefined();
      }
    },
  );

  it('detects a standard block from the architecture text alone, not just the name', () => {
    const spec = approvedSpec({
      moduleName: 'widget',
      goal: 'A combinational logic block',
      architecture: 'Implements a full adder producing sum and carry.',
    });
    expect(detectStandardBlocks(spec).map((reference) => reference.block)).toContain('full-adder');
  });

  it('adds no known-answer check for a bespoke, non-standard design', () => {
    const spec = approvedSpec({
      moduleName: 'bus_arbiter',
      goal: 'A bespoke protocol arbiter for a custom bus',
      architecture: 'A custom priority arbiter with round-robin tie-breaking.',
    });

    expect(detectStandardBlocks(spec)).toHaveLength(0);
    expect(requiredChecks(spec).every((check) => check.kind === 'criterion')).toBe(true);
  });

  it('derives known-answer checks from Spec text only, never from RTL', () => {
    // A bespoke Spec whose text names no standard block yields no known-answer
    // checks, even though a full-adder RTL body exists in scope: detection has no
    // channel to the RTL, preserving the anti-circular guarantee.
    const spec = approvedSpec({
      moduleName: 'custom_block',
      goal: 'A bespoke datapath slice',
      architecture: 'A custom combinational datapath.',
    });
    const fullAdderRtl =
      'module fulladder(input a, input b, input cin, output sum, output cout);\n' +
      '  assign {cout, sum} = a + b + cin;\nendmodule';
    expect(fullAdderRtl).toContain('fulladder');

    expect(detectStandardBlocks(spec)).toHaveLength(0);
  });
});

// --- Req 7.5: the declared interface must justify the known-answer check --------

describe('a known-answer check is justified by the declared interface (Req 7.5)', () => {
  /** The same Spec with its declared ports replaced. */
  function withPorts(spec: Spec, ports: readonly Port[]): Spec {
    return { ...spec, moduleInterface: { ...spec.moduleInterface, ports } };
  }

  /** Data ports of the given width: the shape a bit-level truth table cannot judge. */
  function busPorts(width: number): readonly Port[] {
    return [
      { name: 'a', direction: 'input', width },
      { name: 'b', direction: 'input', width },
      { name: 'cin', direction: 'input', width: 1 },
      { name: 'sum', direction: 'output', width },
      { name: 'cout', direction: 'output', width: 1 },
    ];
  }

  it('given prose naming a full adder but MULTI-BIT declared ports when blocks are detected then the truth-table check is not emitted', () => {
    // The real regression: a design described as "a 16-bit full adder" names the
    // primitive it is built from, and the 1-bit truth table driven onto its 16-bit
    // ports failed the human-verified reference design.
    const spec = withPorts(
      approvedSpec({
        moduleName: 'adder_16bit',
        goal: 'A 16-bit full adder in combinational logic',
        architecture: 'A ripple-carry chain of full adders.',
      }),
      busPorts(16),
    );

    expect(detectStandardBlocks(spec).map((reference) => reference.block)).not.toContain(
      'full-adder',
    );
    expect(requiredChecks(spec).map((check) => check.name)).not.toContain(
      'known_answer_full_adder_truth_table',
    );
  });

  it('given the same prose with SINGLE-BIT declared ports when blocks are detected then the truth-table check is emitted', () => {
    // Non-vacuity: the guard reads the ports, not the prose, so the genuine 1-bit
    // full adder still gets its known-answer check.
    const spec = withPorts(
      approvedSpec({
        moduleName: 'full_adder',
        goal: 'A single-bit full adder',
        architecture: 'Combinational sum and carry logic.',
      }),
      busPorts(1),
    );

    expect(detectStandardBlocks(spec).map((reference) => reference.block)).toContain('full-adder');
    expect(requiredChecks(spec).map((check) => check.name)).toContain(
      'known_answer_full_adder_truth_table',
    );
  });

  it('given a multi-bit interface when the known-answer check is dropped then criterion coverage still stands', () => {
    const spec = withPorts(
      approvedSpec({
        moduleName: 'adder_32bit',
        goal: 'A 32-bit full adder',
        architecture: 'A carry-select chain of full adders.',
      }),
      busPorts(32),
    );

    const checks = requiredChecks(spec);
    expect(checks.every((check) => check.kind === 'criterion')).toBe(true);
    expect(checks).toHaveLength(simulationCriteria(spec).length);
    expect(checks.length).toBeGreaterThan(0);
  });

  it('given a half adder whose declared ports are wide when blocks are detected then its truth table is dropped too', () => {
    // The guard is a property of the reference, not a patch for one block.
    const spec = withPorts(
      approvedSpec({
        moduleName: 'adder_8bit',
        goal: 'An 8-bit adder built from a half adder chain',
        architecture: 'Half adder based carry propagation.',
      }),
      busPorts(8),
    );

    expect(detectStandardBlocks(spec)).toHaveLength(0);
  });

  it('given a clocked-sequence block with NO declared clock when blocks are detected then its check is not emitted', () => {
    // A reference increment sequence cannot be stepped without a clock, so the
    // check would be unpassable by any design.
    const spec = approvedSpec({
      moduleName: 'counter',
      goal: 'A counter of set bits in the input word',
      architecture: 'Combinational population count.',
    });

    expect(detectStandardBlocks(spec)).toHaveLength(0);
    expect(requiredChecks(spec).every((check) => check.kind === 'criterion')).toBe(true);
  });

  it('given the same clocked block WITH a declared clock when blocks are detected then its check is emitted', () => {
    const spec = approvedSpec({
      moduleName: 'counter',
      goal: 'A 4-bit up counter',
      architecture: 'Clocked increment.',
      clocking: CLOCKED,
    });

    expect(detectStandardBlocks(spec).map((reference) => reference.block)).toContain('up-counter');
  });

  it('given a Spec with no declared data ports when a bit-level block is named then its check is not emitted', () => {
    const spec = withPorts(
      approvedSpec({
        moduleName: 'full_adder',
        goal: 'A single-bit full adder',
        architecture: 'Combinational sum and carry logic.',
        clocking: CLOCKED,
      }),
      CLOCK_PORTS,
    );

    // Clock and reset are not data, so there is nothing a truth table could drive.
    expect(detectStandardBlocks(spec)).toHaveLength(0);
  });
});

describe('known-answer checks reach the produced Testbench (Req 7.5, 7.6)', () => {
  it('produces a Testbench that emits the known-answer CHECK line for a standard block', async () => {
    const spec = approvedSpec({
      moduleName: 'full_adder',
      goal: 'A single-bit full adder',
      architecture: 'Combinational sum and carry logic.',
    });
    const checks = requiredChecks(spec);
    const knownAnswer = checks.find((check) => check.kind === 'known-answer');
    expect(knownAnswer?.name).toBe('known_answer_full_adder_truth_table');

    const agent = agentReturning(routed(JSON.stringify({ source: sourceCovering(checks) })));
    const outcome = await agent.generateTestbench(request(spec), generousBudget());

    expect(outcome.status).toBe('generated');
    if (outcome.status !== 'generated') {
      throw new Error('expected a generated Testbench');
    }
    // The produced source emits the known-answer signal the oracle will later read
    // from the simulation's stdout (the `$display` printed at run time).
    expect(sourceEmitsCheck(outcome.testbench.source, 'known_answer_full_adder_truth_table')).toBe(
      true,
    );
    // Simulation criteria are still covered alongside the known-answer check.
    expect(simulationCriteria(spec).length).toBeGreaterThan(0);
  });
});
