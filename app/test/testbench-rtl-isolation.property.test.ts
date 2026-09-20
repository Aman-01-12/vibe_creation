// Property 4: The testbench generation input never contains the RTL (task 13.4).
//
// THIS IS THE ANTI-CIRCULARITY SECURITY PROPERTY. If the RTL under test could
// reach the Testbench_Agent's model input, a generated testbench could silently
// agree with a bug in the implementation and the oracle's independence would be
// destroyed. This property asserts, over many generated approved Specs, OKF
// passages, and a distinctive "candidate RTL" body the test actively tries to
// smuggle in, that:
//
//   1. Unrepresentability (type + runtime): the sole model-input type
//      `TestbenchGenerationInput` has exactly three fields - { spec, intentSummary,
//      okfPassages } - and NONE can carry RTL. The public request type
//      `GenerateTestbenchRequest` likewise has no RTL parameter. This is a
//      compile-time guarantee (the test does not - and cannot - pass RTL anywhere),
//      reinforced at runtime by checking the assembled input's own keys.
//   2. Purity/independence: `buildTestbenchModelInput` is a pure function of
//      (Spec, intent, OKF). The assembled prompt is byte-identical across repeated
//      builds and is independent of any RTL string that happens to exist in the
//      surrounding scope, because RTL has no channel into it.
//   3. Captured-prompt isolation: driving the real `TestbenchAgent` through a fake
//      Model_Router that CAPTURES the exact `ModelRequest.prompt` it receives, the
//      captured prompt contains none of the injected RTL sentinel across every
//      generated Spec - the strongest runtime form of "the RTL never got in".
//   4. Spec attribution (Req 7.7): any produced Testbench is attributed to the
//      Spec (`sourceAttribution === 'spec'`) and its Spec version, and the recorded
//      Trace span carries that attribution and version.
//
// A single defect here (the sentinel appearing in the captured prompt) is an
// anti-circularity breach and must fail loudly.
//
// This property is also the single owner of the same guarantee for every rule the
// prompt grows. `eval-campaign-readiness` Property 15 ("the input-window rule is
// assembled without RTL") is discharged HERE, by extension rather than by a second
// property file: an anti-circular guarantee with two owners is one that can be true
// in one place and false in the other. So each rule the prompt states is asserted
// present, and the whole assembled prompt is asserted free of the RTL sentinel, in
// one pass. The Verilog-2001 dialect rule and the RTL concurrency rule (prompt
// version 3) are asserted the same way: unconditional, so present for every Spec,
// and carrying no channel through which RTL could have entered.
//
// Validates: Requirements 7.1, 7.2, 7.7, 9.5

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TestbenchAgent,
  buildTestbenchModelInput,
  formatCheckLine,
  requiredChecks,
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
  type TestbenchGenerationInput,
} from '@app/agent';
import {
  makePort,
  makeSessionBudget,
  newUlid,
  type AcceptanceCriterion,
  type ClockingContract,
  type Port,
  type PortDirection,
  type Result,
  type Spec,
  type Ulid,
} from '@app/core';
import type {
  KnowledgePassage,
  KnowledgeQuery,
  KnowledgeRetriever,
  OkfStatus,
  PassageAuthority,
  RetrievalResult,
} from '@app/knowledge';
import { propertyParameters, propertyTag, routedModelIdFor } from '@app/test';

const PROPERTY = propertyTag(4, 'The testbench generation input never contains the RTL');

/**
 * A distinctive marker embedded in every generated candidate RTL body.
 *
 * It is long and lexically unlike anything the Spec/intent/OKF generators can
 * produce (those draw from a short lowercase word pool and bounded identifiers),
 * so its presence in an assembled prompt could only mean the RTL leaked in.
 */
const RTL_SENTINEL = '__RTL_SENTINEL_DO_NOT_LEAK_7F3A9C2E__';

// -- Generators -------------------------------------------------------------

/** Crockford base32 alphabet used by ULIDs (excludes I, L, O, U). */
const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');
/** The valid first-character set for a 48-bit ULID timestamp (0-7). */
const ULID_HEAD_CHARS = '01234567'.split('');
/** ASCII identifier characters for module/port names. */
const IDENT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');
/**
 * A safe free-text word pool for Spec/intent/OKF strings.
 *
 * Deliberately contains no underscores and none of the sentinel, so no generated
 * Spec field can coincidentally equal the RTL marker; the isolation assertions
 * therefore fail only on a genuine leak, never on a text collision.
 */
const WORDS = [
  'reset',
  'enable',
  'value',
  'signal',
  'clock',
  'output',
  'input',
  'width',
  'sum',
  'ready',
  'valid',
  'state',
  'count',
  'edge',
  'level',
  'data',
  'load',
  'clear',
  'hold',
  'shift',
  'toggle',
  'sample',
  'when',
  'then',
  'each',
];

/** A syntactically valid, deterministically shrinkable 26-char ULID. */
function ulidArbitrary(): fc.Arbitrary<Ulid> {
  return fc
    .tuple(
      fc.constantFrom(...ULID_HEAD_CHARS),
      fc.array(fc.constantFrom(...CROCKFORD_CHARS), { minLength: 25, maxLength: 25 }),
    )
    .map(([head, rest]) => `${head}${rest.join('')}`);
}

/** A non-empty, non-whitespace ASCII identifier for signal/module names. */
function identifierArbitrary(maxLength = 12): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...IDENT_CHARS), { minLength: 1, maxLength })
    .map((chars) => chars.join(''));
}

/** A short phrase drawn from the safe word pool (never contains the sentinel). */
function phraseArbitrary(maxWords = 6): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: maxWords })
    .map((words) => words.join(' '));
}

/** A valid `Port` built through the sole supported constructor. */
function portArbitrary(): fc.Arbitrary<Port> {
  return fc
    .record({
      name: identifierArbitrary(8),
      direction: fc.constantFrom<PortDirection>('input', 'output', 'inout'),
      width: fc.integer({ min: 1, max: 64 }),
    })
    .map((input) => {
      const built = makePort(input);
      if (!built.ok) {
        throw new Error('port generator must produce a valid port');
      }
      return built.value;
    });
}

/** A clocking contract, possibly combinational and/or reset-less. */
function clockingArbitrary(): fc.Arbitrary<ClockingContract> {
  return fc.record({
    clockName: fc.option(identifierArbitrary(8), { nil: null }),
    resetName: fc.option(identifierArbitrary(8), { nil: null }),
    resetActiveLow: fc.boolean(),
  });
}

/** One measurable, simulation-verifiable acceptance criterion. */
function simulationCriterionArbitrary(): fc.Arbitrary<AcceptanceCriterion> {
  return fc.record({
    id: ulidArbitrary(),
    text: phraseArbitrary(),
    measurable: fc.constant(true),
    method: fc.constant<'simulation'>('simulation'),
  });
}

/**
 * An approved Spec with at least one simulation-verifiable criterion.
 *
 * Approval and a non-empty simulation-criteria set are required so the
 * Testbench_Agent proceeds to assemble and route a generation call (rather than
 * failing closed before the model seam), exercising the real prompt-assembly path.
 */
function approvedSpecArbitrary(): fc.Arbitrary<Spec> {
  return fc
    .record({
      id: ulidArbitrary(),
      projectId: ulidArbitrary(),
      goal: phraseArbitrary(),
      constraints: fc.array(phraseArbitrary(4), { maxLength: 3 }),
      moduleInterface: fc.record({
        moduleName: identifierArbitrary(),
        ports: fc.array(portArbitrary(), { minLength: 1, maxLength: 4 }),
        clocking: clockingArbitrary(),
      }),
      acceptanceCriteria: fc.array(simulationCriterionArbitrary(), {
        minLength: 1,
        maxLength: 3,
      }),
      architecture: phraseArbitrary(),
      version: fc.integer({ min: 1, max: 12 }),
    })
    .map((fields) => ({ ...fields, approved: true as const }));
}

/** An OKF passage drawn entirely from the safe word pool (never the sentinel). */
function okfPassageArbitrary(): fc.Arbitrary<KnowledgePassage> {
  return fc.record({
    title: phraseArbitrary(4),
    content: phraseArbitrary(),
    origin: fc.constant<'okf'>('okf'),
    authority: fc.constantFrom<PassageAuthority>('authority', 'hint'),
    okfStatus: fc.constantFrom<OkfStatus>('trusted', 'candidate'),
  });
}

/**
 * A distinctive candidate RTL body the test tries (and structurally fails) to
 * smuggle into testbench generation. It always contains {@link RTL_SENTINEL}.
 */
function candidateRtlArbitrary(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...WORDS), { maxLength: 6 })
    .map(
      (words) =>
        `module dut(input clk, output reg [3:0] q); // ${RTL_SENTINEL}\n` +
        `  always @(posedge clk) q <= q + 1; // ${words.join(' ')} ${RTL_SENTINEL}\n` +
        `endmodule`,
    );
}

// -- Test doubles -----------------------------------------------------------

/** A fake Model_Router that captures each prompt and returns a scripted source. */
class CapturingModelRouter implements ModelRouter {
  readonly prompts: string[] = [];

  constructor(private readonly source: string) {}

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    void task;
    this.prompts.push(request.prompt);
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve({
      ok: true,
      value: {
        task: 'testbench',
        provider: 'deepseek',
        modelId: routedModelIdFor('deepseek'),
        outputText: JSON.stringify({ source: this.source }),
        tokensUsed: 16,
        costCents: 1,
        attempts: 1,
        fellBack: false,
      },
    });
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A fake Knowledge_Retriever returning the generated OKF passages as hints only. */
class FixedKnowledgeRetriever implements KnowledgeRetriever {
  constructor(private readonly passages: readonly KnowledgePassage[]) {}

  retrieve(query: KnowledgeQuery): Promise<RetrievalResult> {
    void query;
    return Promise.resolve({
      passages: this.passages,
      citations: [],
      facts: [],
      source: 'okf',
      sanitized: true,
    });
  }
}

// -- Helpers ----------------------------------------------------------------

/** A generous budget so the model seam, not the budget, drives generation. */
function generousBudget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 1000,
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

/** Build a testbench source that emits a passing CHECK line for every required check. */
function sourceCovering(checks: readonly RequiredCheck[]): string {
  const lines = checks.map((check) => `      $display("${formatCheckLine(check.name, true)}");`);
  return ['module tb;', '  initial begin', ...lines, '    $finish;', '  end', 'endmodule'].join(
    '\n',
  );
}

describe(PROPERTY, () => {
  it('never lets the candidate RTL reach the testbench-generation model input', async () => {
    await fc.assert(
      fc.asyncProperty(
        approvedSpecArbitrary(),
        fc.array(okfPassageArbitrary(), { maxLength: 3 }),
        phraseArbitrary(),
        candidateRtlArbitrary(),
        async (spec, okfPassages, intentSummary, candidateRtl) => {
          // The candidate RTL exists in this scope, yet there is no typed channel
          // to pass it: `GenerateTestbenchRequest` and `TestbenchGenerationInput`
          // have no RTL field. Referencing it here proves it is inert.
          expect(candidateRtl).toContain(RTL_SENTINEL);

          const checks = requiredChecks(spec);

          // (1) Unrepresentability + (2) purity/independence over buildTestbenchModelInput.
          const generationInput: TestbenchGenerationInput = { spec, intentSummary, okfPassages };
          expect(Object.keys(generationInput).sort()).toEqual([
            'intentSummary',
            'okfPassages',
            'spec',
          ]);
          const builtOnce = buildTestbenchModelInput(generationInput, checks);
          const builtAgain = buildTestbenchModelInput(generationInput, checks);
          // Pure function of (Spec, intent, OKF): identical, and independent of the
          // candidate RTL string sitting in scope.
          expect(builtAgain).toEqual(builtOnce);
          expect(builtOnce.prompt).not.toContain(RTL_SENTINEL);
          // Non-vacuous: the prompt IS built from the Spec (module + every check).
          expect(builtOnce.prompt).toContain(spec.moduleInterface.moduleName);
          for (const check of checks) {
            expect(builtOnce.prompt).toContain(check.name);
          }
          // The state-anchoring rule is derived from the DECLARED interface, so the
          // reset-free wording appears only when there is genuinely no reset port.
          expect(builtOnce.prompt).toContain('State anchoring:');
          const { resetName } = spec.moduleInterface.clocking;
          if (resetName === null) {
            expect(builtOnce.prompt).toContain('This interface declares NO reset');
          } else {
            expect(builtOnce.prompt).not.toContain('This interface declares NO reset');
            expect(builtOnce.prompt).toContain(`asserting ${resetName} (`);
          }
          // The compute-never-precompute rule depends on no interface detail, so it
          // is present for every Spec.
          expect(builtOnce.prompt).toContain('Expected values: COMPUTE each one in the testbench');
          // The timing prohibition is likewise unconditional. WHICH legal derivation
          // it offers is conditioned on the declared ports, and exactly one of the
          // two is offered - asserted without re-deriving which, so the branch stays
          // owned by the prompt rather than mirrored here.
          expect(builtOnce.prompt).toContain('Timing: the Spec is the only source of latency');
          const namesQualifier = builtOnce.prompt.includes("Wait on the design's own");
          const withholdsQualifier = builtOnce.prompt.includes('declares no such qualifier');
          expect(namesQualifier).not.toBe(withholdsQualifier);
          // Property 15 (eval-campaign-readiness): the INPUT-side rule is assembled from
          // the Spec, the intent, and OKF exactly as the others are - it is present for
          // every Spec, it offers exactly one derivation (asserted without re-deriving
          // which), and it is covered by the sentinel assertion above and below, so no
          // channel for RTL was opened by adding it.
          expect(builtOnce.prompt).toContain(
            'Input windows: the Spec is the only source of the edge',
          );
          const namesInputQualifier = builtOnce.prompt.includes(
            "Accept one input per assertion of the design's own ",
          );
          const withholdsInputQualifier = builtOnce.prompt.includes(
            'This interface declares NO input qualifier',
          );
          expect(namesInputQualifier).not.toBe(withholdsInputQualifier);
          // The Verilog-2001 dialect rule is a fact about the TOOLCHAIN, not about any
          // interface, so it is present - in full - for every Spec. Each clause is
          // asserted separately: the measured defect was a set of distinct offending
          // constructs, and a rule that lost one clause to an edit would still satisfy a
          // single "Dialect:" assertion.
          expect(builtOnce.prompt).toContain('Dialect: the testbench is compiled as Verilog-2001');
          expect(builtOnce.prompt).toContain('Declare EVERY `reg`, `integer`, and array at MODULE');
          expect(builtOnce.prompt).toContain('Give no declaration an initial value');
          expect(builtOnce.prompt).toContain('Use `reg` and `wire` only');
          expect(builtOnce.prompt).toContain('no array-with-initializer syntax');
          expect(builtOnce.prompt).toContain("`-9'sd1`, never `9'sd-1`");
          // The concurrency rule is likewise unconditional, and is the MENTAL-MODEL rule
          // the timing and input-window rules rest on - a different kind of rule, not a
          // restatement, so its three clauses are asserted on their own terms: the
          // machine is observed rather than stepped, no second implementation is built,
          // and sampling happens only in the settled part of the period.
          expect(builtOnce.prompt).toContain('Concurrency: a design is a CONCURRENT machine');
          expect(builtOnce.prompt).toContain(
            'Do NOT build a second implementation of the design inside the testbench',
          );
          expect(builtOnce.prompt).toContain(
            'Sample an output only in the SETTLED part of a clock period',
          );
          // And it must READ as consistent with the state-anchoring rule rather than as a
          // contradiction of it: the carve-out naming the observed carry-forward is part
          // of the rule text, so an edit that drops it fails here.
          expect(builtOnce.prompt).toContain('Carrying forward a value you OBSERVED');

          // (3) Captured-prompt isolation through the real agent path.
          const router = new CapturingModelRouter(sourceCovering(checks));
          const retriever = new FixedKnowledgeRetriever(okfPassages);
          const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
          const agent = new TestbenchAgent({
            router,
            recorder,
            retriever,
            now: () => 1_700_000_000_000,
          });
          const request: GenerateTestbenchRequest = {
            sessionId: newUlid(),
            spec,
            intentSummary,
          };

          const outcome = await agent.generateTestbench(request, generousBudget());

          // Exactly one model call, and its captured prompt carries no RTL.
          expect(router.prompts).toHaveLength(1);
          for (const prompt of router.prompts) {
            expect(prompt).not.toContain(RTL_SENTINEL);
          }

          // (4) Spec attribution and version on the produced Testbench and its span.
          expect(outcome.status).toBe('generated');
          if (outcome.status !== 'generated') {
            return;
          }
          expect(outcome.testbench.sourceAttribution).toBe('spec');
          expect(outcome.testbench.specVersion).toBe(spec.version);
          expect(outcome.testbench.specId).toBe(spec.id);

          const trace = await recorder.getTrace(request.sessionId);
          expect(trace.spans).toHaveLength(1);
          expect(trace.spans[0]?.stageOrTool).toBe('Testbench_Agent');
          expect(trace.spans[0]?.outputs).toMatchObject({
            sourceAttribution: 'spec',
            specVersion: spec.version,
          });
        },
      ),
      propertyParameters(),
    );
  });
});
