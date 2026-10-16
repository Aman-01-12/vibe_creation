// Property 4: The testbench generation input never contains the RTL (task 13.4).
//
// THIS IS THE ANTI-CIRCULARITY SECURITY PROPERTY. If the RTL under test could
// reach the Testbench_Agent's model input, a generated testbench could silently
// agree with a bug in the implementation and the oracle's independence would be
// destroyed. This property asserts, over many generated approved Specs, OKF
// passages, and a distinctive "candidate RTL" body the test actively tries to
// smuggle in, that:
//
//   1. Unrepresentability (compile time): the sole model-input type
//      `TestbenchGenerationInput` has exactly three fields - { spec, intentSummary,
//      okfPassages } - and NONE can carry RTL. The public request type
//      `GenerateTestbenchRequest` likewise has no RTL parameter. This is a
//      compile-time guarantee (the test does not - and cannot - pass RTL anywhere),
//      asserted with `expectTypeOf<keyof TestbenchGenerationInput>()`, which `tsc -b`
//      evaluates and vitest does not. A comparison over the keys of a literal typed as
//      `TestbenchGenerationInput` was replaced because it passes when an OPTIONAL field is
//      added: the literal omits the field, so its keys do not move.
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
// `formal-property-oracle` Property 30 (task 9.3) is discharged HERE as well, by the same
// extension rather than a parallel file, over the two roles a Formal_Property passes through
// on its way to the gate:
//
//   5. The Property_Author (`PropertyAgent#propertySetFor`, the `derivePropertySet` it
//      delegates to, and the pure `buildPropertyModelInput`) gets clauses 1 to 4 as
//      `generateTestbench` does. Unrepresentability is asserted at compile time with
//      `expectTypeOf`, which `tsc -b` evaluates and vitest does not: an extra, optional,
//      defaulted, or retyped parameter or deps field fails the build. Clause 1 asserts
//      `TestbenchGenerationInput` the same way. The runtime half is each entry point's arity
//      plus the deps literal's own keys. The captured model request must EQUAL the pure
//      Spec-only build, so no `ModelRequest` field, `metadata` included, carried anything
//      else.
//   6. The Property_Validator (`validateExpression`) takes ONE parameter, the expression
//      under validation, and design text placed in it is refused, so a candidate design
//      cannot become a `ValidatedExpression` by occupying it. Its "no model call and no
//      file, network, clock, or random-source read" (Req 6.9) is shown by TWO checks,
//      because no single check sees both kinds of read. A clock, random, or `fetch` read
//      needs no import, so those globals are TRAPPED for the duration of each call, with a
//      positive control proving the trap sees every source it names. A file or socket read
//      needs an import, which a global trap cannot see, so the module's runtime imports are
//      pinned as an allow-list. With no Model_Router parameter, a model call is a network
//      read and falls under the same two. NOT covered: a dynamic `import()` or a host
//      channel such as `process.binding` inside a function body, a read made at module load
//      before the trap is installed, a branch no generated input reaches, and anything
//      inside `@app/core` beyond the `err`/`ok` the validator calls.
//
// Req 3.8 is reached only through that property path: neither role has a parameter any
// design source, candidate or reference, could occupy. The Formal_Oracle's own parameter
// list is not asserted here.
//
// The Testbench_Agent's repair method (`testbench-repair-loop` task 4.3) is now covered
// too, inside the main property above: the same clauses, over `repairTestbench` and
// `buildRepairModelInput`, on the identical generated Spec/candidateRtl. `normalizeDialect`
// (`testbench-dialect-normalization` task 4.8) is NOT YET HERE, although formal-property-oracle
// Req 13.8 and task 9.3 describe it as already covered.
//
// Validates: Requirements 7.1, 7.2, 7.7, 9.5; formal-property-oracle Requirements 3.8, 6.9,
// 6.16, 13.8

import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  ARCHITECTURE_SECTION_LABEL,
  PropertyAgent,
  TestbenchAgent,
  buildGroundedRepairModelInput,
  buildGroundedTestbenchModelInput,
  buildRepairHint,
  buildRepairModelInput,
  normalizeDialect,
  requiredChecksFor,
  renderScoreboardScaffold,
  routeCheckingApproach,
  buildPropertyModelInput,
  buildTestbenchModelInput,
  derivePropertySet,
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
  type PropertyAgentDeps,
  type PropertyAuthorDeps,
  type RequiredCheck,
  type RoutedModelResult,
  type RepairTestbenchModelInput,
  type RepairTestbenchRequest,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
  type StrategyArm,
  type TestbenchGenerationInput,
} from '@app/agent';
import type { ModuleInterface } from '@app/core';
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
import { propertyParameters, propertyTag, routedModelIdFor, timingContractFor } from '@app/test';
import { renderSimulationHarness, validateExpression } from '@app/tools';

import { arbPropertyText } from './formal-arbitraries.js';

const PROPERTY = propertyTag(4, 'The testbench generation input never contains the RTL');

/**
 * `formal-property-oracle`'s own Property 30, which extends this property's guarantee.
 *
 * A literal rather than `propertyTag(...)`, whose feature slug is hardcoded to hdl-creation-loop
 * (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
 */
/** testbench-in-order-scoreboard's Properties 3 and 10, which extend this guarantee again. */
const SCOREBOARD_PROPERTY_3 =
  'Feature: testbench-in-order-scoreboard, Property 3: The router and the scaffold admit no RTL-shaped parameter';
const GROUNDED_PROPERTY_8 =
  'Feature: testbench-spec-grounding, Property 8: RTL isolation extends to the grounded requests';
const SCOREBOARD_PROPERTY_10 =
  'Feature: testbench-in-order-scoreboard, Property 10: RTL isolation extends to the scoreboard requests';
const PROPERTY_30 =
  'formal-property-oracle, Property 30: RTL isolation extends to the property author and the property validator';

/** The fixed wall clock every role under test records its span timing against. */
const FIXED_NOW_MS = 1_700_000_000_000;

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
        validityOutputName: fc.constant(null),
      }),
      acceptanceCriteria: fc.array(simulationCriterionArbitrary(), {
        minLength: 1,
        maxLength: 3,
      }),
      architecture: phraseArbitrary(),
      version: fc.integer({ min: 1, max: 12 }),
    })
    .map((fields) => ({
      ...fields,
      approved: true as const,
      timingContract: timingContractFor(fields.moduleInterface),
    }));
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

/**
 * A fake Model_Router that captures each request WHOLE and returns one scripted reply.
 *
 * The whole request rather than its prompt alone, because `ModelRequest.metadata` is a
 * model-visible field too. The reply echoes the task it was routed under, so the fake cannot
 * misreport its own route for a role that routes somewhere else.
 */
class CapturingModelRouter implements ModelRouter {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly outputText: string) {}

  /** The prompt of every captured request, in call order. */
  get prompts(): readonly string[] {
    return this.requests.map((request) => request.prompt);
  }

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.requests.push(request);
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve({
      ok: true,
      value: {
        task,
        provider: 'deepseek',
        modelId: routedModelIdFor('deepseek'),
        outputText: this.outputText,
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

/**
 * The consequent of every scripted Property_Author property: inside the accepted dialect.
 *
 * A constant rather than a port name, because a generated port name can spell a keyword the
 * validator refuses, and the reply has to PASS the validator so the role's property-building
 * path runs rather than its fail-closed one.
 */
const IN_DIALECT_CONSEQUENT = "1'b1";

/**
 * A Property_Author reply expressing every criterion of `spec` as one property.
 *
 * Combinational, because a clocked property needs a declared clock and a generated interface
 * may declare none.
 */
function propertyReplyCovering(spec: Spec): string {
  return JSON.stringify({
    properties: spec.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      kind: 'combinational',
      antecedent: null,
      consequent: IN_DIALECT_CONSEQUENT,
    })),
  });
}

/**
 * Every ambient clock, random, and network source the Property_Validator must not read
 * (Req 6.9), in the order {@link ambientReadsDuring} reports them.
 *
 * Only sources reachable WITHOUT an import belong here. A file or socket read needs a `node:`
 * import, which no global trap can see, so that half is pinned by {@link runtimeImportsOf}.
 */
const AMBIENT_SOURCES = [
  'Date() or new Date()',
  'Date.now',
  'performance.now',
  'process.hrtime',
  'process.hrtime.bigint',
  'process.uptime',
  'Math.random',
  'crypto.getRandomValues',
  'crypto.randomUUID',
  'fetch',
] as const;

/** One of {@link AMBIENT_SOURCES}. */
type AmbientSource = (typeof AMBIENT_SOURCES)[number];

/**
 * Run `call` with every {@link AMBIENT_SOURCES} entry trapped, and return the ones it read.
 *
 * Each trap RECORDS and passes through, so a read is reported by name rather than changing
 * what `call` computes - except `fetch`, which never passes through, so a trapped network read
 * cannot become a real one. `Date` itself is trapped by a Proxy, because `Date()` and
 * `new Date()` read the clock without touching `Date.now`; a `Date` constructed FROM an
 * argument reads nothing and is not counted. `call` is synchronous, so no other code runs
 * while the traps are live, and every trap is removed before this returns, even when `call`
 * throws.
 */
function ambientReadsDuring(call: () => void): readonly AmbientSource[] {
  const realDate = globalThis.Date;
  let clockDates = 0;
  const trapped = [
    ['Date.now', vi.spyOn(realDate, 'now')],
    ['performance.now', vi.spyOn(performance, 'now')],
    // `bigint` hangs off the ORIGINAL `process.hrtime`, so it is trapped before that is replaced.
    ['process.hrtime.bigint', vi.spyOn(process.hrtime, 'bigint')],
    ['process.hrtime', vi.spyOn(process, 'hrtime')],
    ['process.uptime', vi.spyOn(process, 'uptime')],
    ['Math.random', vi.spyOn(Math, 'random')],
    ['crypto.getRandomValues', vi.spyOn(crypto, 'getRandomValues')],
    ['crypto.randomUUID', vi.spyOn(crypto, 'randomUUID')],
    [
      'fetch',
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(null))),
    ],
  ] as const;
  vi.stubGlobal(
    'Date',
    new Proxy(realDate, {
      apply(target, thisArg: unknown, args: unknown[]): unknown {
        clockDates += 1;
        return Reflect.apply(target, thisArg, args) as unknown;
      },
      construct(target, args: unknown[], newTarget): object {
        if (args.length === 0) {
          clockDates += 1;
        }
        return Reflect.construct(target, args, newTarget) as object;
      },
    }),
  );
  try {
    call();
    const read = new Set<AmbientSource>(
      trapped.filter(([, spy]) => spy.mock.calls.length > 0).map(([source]) => source),
    );
    if (clockDates > 0) {
      read.add('Date() or new Date()');
    }
    return AMBIENT_SOURCES.filter((source) => read.has(source));
  } finally {
    vi.unstubAllGlobals();
    for (const [, spy] of trapped) {
      spy.mockRestore();
    }
  }
}

/** Read every {@link AMBIENT_SOURCES} entry once, so the trap's reach is measured, not assumed. */
function readEveryAmbientSource(): void {
  void new Date();
  Date.now();
  performance.now();
  process.hrtime();
  process.hrtime.bigint();
  process.uptime();
  Math.random();
  crypto.getRandomValues(new Uint8Array(1));
  crypto.randomUUID();
  void fetch('https://example.invalid/');
}

/**
 * The modules one source file loads at runtime, in source order.
 *
 * Every line-leading `import` counts except `import type`, which is exactly the set
 * `verbatimModuleSyntax` erases, so what remains is what loads. Read from the SOURCE rather
 * than from `dist`, so a new edge is caught even before `tsc -b` has rebuilt the output.
 */
function runtimeImportsOf(sourceFromHere: string): readonly string[] {
  const source = readFileSync(new URL(sourceFromHere, import.meta.url), 'utf8');
  return [...source.matchAll(/^import(?!\s+type\b)[^;]*?['"]([^'"]+)['"]/gm)].map(
    (match) => match[1] ?? '',
  );
}

describe(PROPERTY, () => {
  it('never lets the candidate RTL reach the testbench-generation model input', async () => {
    // (1) Unrepresentability, compile-time half: `tsc -b` evaluates this, vitest does not. The
    // key set is pinned on the TYPE, so an added OPTIONAL field fails the build; the typed
    // literal below still fails it on an added required field or a retyped one.
    expectTypeOf<keyof TestbenchGenerationInput>().toEqualTypeOf<
      'intentSummary' | 'okfPassages' | 'spec'
    >();

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

          // (2) Purity/independence over buildTestbenchModelInput.
          const generationInput: TestbenchGenerationInput = { spec, intentSummary, okfPassages };
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
          const router = new CapturingModelRouter(
            JSON.stringify({ source: sourceCovering(checks) }),
          );
          const retriever = new FixedKnowledgeRetriever(okfPassages);
          const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
          const agent = new TestbenchAgent({
            router,
            recorder,
            retriever,
            now: () => FIXED_NOW_MS,
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

          // (task 4.3, testbench-repair-loop) The SAME guarantee over `repairTestbench`:
          // `RepairTestbenchModelInput` has the identical three-field discipline as
          // `TestbenchGenerationInput` (spec, previousSource/intent-equivalent, hint), with
          // no field a candidate module could occupy. `buildRepairModelInput` is asserted
          // pure the same way `buildTestbenchModelInput` is above, and the real agent path
          // is driven on the SAME capturing router, so a repair prompt is checked against
          // the identical candidate RTL this property already tried to smuggle in.
          expectTypeOf<keyof RepairTestbenchModelInput>().toEqualTypeOf<
            'hint' | 'previousSource' | 'spec'
          >();

          const previousSource = sourceCovering(checks);
          const repairHint = buildRepairHint({
            kind: 'precheck-build-failed',
            diagnostic: 'syntax error near line 1',
          });
          const repairInput: RepairTestbenchModelInput = { spec, previousSource, hint: repairHint };
          const repairBuiltOnce = buildRepairModelInput(repairInput);
          const repairBuiltAgain = buildRepairModelInput(repairInput);
          // Pure function of (Spec, previousSource, hint): identical, and independent of
          // the candidate RTL string sitting in scope.
          expect(repairBuiltAgain).toEqual(repairBuiltOnce);
          expect(repairBuiltOnce.prompt).not.toContain(RTL_SENTINEL);
          // Non-vacuous: the repair prompt IS built from the Spec and the prior testbench.
          expect(repairBuiltOnce.prompt).toContain(spec.moduleInterface.moduleName);
          expect(repairBuiltOnce.prompt).toContain(previousSource);

          const repairRequest: RepairTestbenchRequest = {
            sessionId: newUlid(),
            spec,
            previousSource,
            hint: repairHint,
          };
          const repairOutcome = await agent.repairTestbench(repairRequest, generousBudget());

          // Captured-prompt isolation through the real agent path: the repair call is the
          // SECOND request this router captured, and it carries no RTL either.
          expect(router.requests).toHaveLength(2);
          for (const prompt of router.prompts) {
            expect(prompt).not.toContain(RTL_SENTINEL);
          }
          expect(repairOutcome.status).toBe('generated');
          if (repairOutcome.status === 'generated') {
            expect(repairOutcome.testbench.sourceAttribution).toBe('spec');
            expect(repairOutcome.testbench.specVersion).toBe(spec.version);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it(`${PROPERTY_30}: never lets the candidate RTL reach the Property_Author's model input`, async () => {
    // (5.1) Unrepresentability, compile-time half: `tsc -b` evaluates these, vitest does not.
    expectTypeOf(derivePropertySet).parameters.toEqualTypeOf<[Spec, PropertyAuthorDeps]>();
    expectTypeOf<PropertyAgent['propertySetFor']>().parameters.toEqualTypeOf<
      [Spec, SessionBudgetHandle]
    >();
    expectTypeOf(PropertyAgent).constructorParameters.toEqualTypeOf<[PropertyAgentDeps]>();
    expectTypeOf<keyof PropertyAuthorDeps>().toEqualTypeOf<
      'budget' | 'now' | 'recorder' | 'router'
    >();
    expectTypeOf(buildPropertyModelInput).parameters.toEqualTypeOf<[Spec]>();
    // Runtime half: the arity each entry point actually declares.
    expect({
      derivePropertySet: derivePropertySet.length,
      propertySetFor: PropertyAgent.prototype.propertySetFor.length,
      buildPropertyModelInput: buildPropertyModelInput.length,
    }).toEqual({ derivePropertySet: 2, propertySetFor: 2, buildPropertyModelInput: 1 });

    await fc.assert(
      fc.asyncProperty(
        approvedSpecArbitrary(),
        candidateRtlArbitrary(),
        async (spec, candidateRtl) => {
          // The candidate RTL exists in this scope, yet no parameter and no deps field of the
          // author can take it. Referencing it here proves it is inert.
          expect(candidateRtl).toContain(RTL_SENTINEL);

          // (5.2) Purity/independence: the model input is a function of the Spec alone.
          const builtOnce = buildPropertyModelInput(spec);
          const builtAgain = buildPropertyModelInput(spec);
          expect(builtAgain).toEqual(builtOnce);
          expect(builtOnce.prompt).not.toContain(RTL_SENTINEL);
          // Non-vacuous: the prompt IS built from the Spec (module + every criterion id).
          expect(builtOnce.prompt).toContain(spec.moduleInterface.moduleName);
          for (const criterion of spec.acceptanceCriteria) {
            expect(builtOnce.prompt).toContain(criterion.id);
          }

          // (5.3) Captured-request isolation through the entry point the Verification_Loop uses.
          const router = new CapturingModelRouter(propertyReplyCovering(spec));
          const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
          const authorDeps: PropertyAgentDeps = { router, recorder, now: () => FIXED_NOW_MS };
          expect(Object.keys(authorDeps).sort()).toEqual(['now', 'recorder', 'router']);
          const budget = generousBudget();

          const outcome = await new PropertyAgent(authorDeps).propertySetFor(spec, budget);

          // Exactly one model call, its prompt carries no RTL, and the WHOLE request is the
          // pure Spec-only build.
          expect(router.requests).toEqual([builtOnce]);
          for (const prompt of router.prompts) {
            expect(prompt).not.toContain(RTL_SENTINEL);
          }

          // (5.4) Spec attribution. Non-vacuous: the scripted reply passed the validator, so
          // this is the path that builds properties and not the fail-closed one.
          expect(outcome.properties.length).toBeGreaterThan(0);
          const criterionIds = spec.acceptanceCriteria.map((criterion) => criterion.id);
          for (const property of outcome.properties) {
            expect(criterionIds).toContain(property.criterionRef);
          }
          const trace = await recorder.getTrace(budget.sessionId);
          expect(trace.spans).toHaveLength(1);
          expect(trace.spans[0]?.stageOrTool).toBe('Property_Author');
          expect(trace.spans[0]?.outputs).toMatchObject({
            sourceAttribution: 'spec',
            specId: spec.id,
            specVersion: spec.version,
          });
        },
      ),
      propertyParameters(),
    );
  });

  it(`${PROPERTY_30}: the Property_Validator decides from its one argument and reads nothing else`, () => {
    // (6.1) One parameter, the expression under validation: none a design source could occupy,
    // and none a Model_Router could reach the validator through. Compile-time half for `tsc -b`.
    expectTypeOf(validateExpression).parameters.toEqualTypeOf<[string]>();
    expect(validateExpression.length).toBe(1);
    // (6.2) A file or socket read needs an import, so the runtime imports are an ALLOW-LIST: a
    // new edge fails here and has to be shown to read nothing ambient before it is admitted.
    expect(runtimeImportsOf('../tools/verilog/property.ts')).toEqual([
      '@app/core',
      '../formal/depth-ladder.js',
      './admit-lexer.js',
    ]);
    // The shared lexer (testbench-in-order-scoreboard, DQ-02) is admitted by the same rule: its
    // only edges are `@app/core` and the pure source mask, so it reads nothing ambient either.
    expect(runtimeImportsOf('../tools/verilog/admit-lexer.ts')).toEqual([
      '@app/core',
      './source-mask.js',
    ]);
    expect(runtimeImportsOf('../tools/verilog/source-mask.ts')).toEqual([]);
    // The depth leaf is admitted by the rule above: it imports nothing, so it reads nothing
    // ambient, and it holds four integers the Warm_Up_Ceiling is derived from.
    expect(runtimeImportsOf('../tools/formal/depth-ladder.ts')).toEqual([]);
    // (6.3) Positive control: the trap reports every source it names, so the empty reports
    // below are a measurement rather than a trap that sees nothing.
    expect(ambientReadsDuring(readEveryAmbientSource)).toEqual(AMBIENT_SOURCES);

    let accepted = 0;
    let refused = 0;
    fc.assert(
      fc.property(arbPropertyText(), candidateRtlArbitrary(), (text, candidateRtl) => {
        const verdicts: ReturnType<typeof validateExpression>[] = [];
        const reads = ambientReadsDuring(() => {
          verdicts.push(
            validateExpression(text),
            validateExpression(text),
            validateExpression(candidateRtl),
          );
        });
        // (6.4) No clock, random, or network read, on the accept path or the refusal path.
        expect(reads).toEqual([]);
        // Purity, stated the way clause 2 states it for `buildTestbenchModelInput`.
        const [first, again, ofDesign] = verdicts;
        expect(again).toEqual(first);
        // (6.5) Design text placed in the one parameter is refused, so a candidate design
        // cannot become a `ValidatedExpression` by occupying it.
        expect(ofDesign?.ok).toBe(false);
        if (first?.ok === true) {
          accepted += 1;
        } else {
          refused += 1;
        }
      }),
      propertyParameters(),
    );
    // Non-vacuous: the traps were live over BOTH the accept path and the refusal path.
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});

/**
 * A streaming interface: clocked, with exactly one Output_Qualifier, so the Treatment_Arm routes
 * it In_Order_Scoreboard. Port names are fixed, because a generated name could collide with a
 * scaffold-reserved prefix and be refused before the request this property inspects is built.
 */
const STREAMING_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'stream_dut',
  ports: [
    { name: 'clk', direction: 'input', width: 1 },
    { name: 'din', direction: 'input', width: 8 },
    { name: 'valid_out', direction: 'output', width: 1 },
    { name: 'dout', direction: 'output', width: 8 },
  ],
  clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
};

describe(SCOREBOARD_PROPERTY_3, () => {
  it('pins the router, the scaffold, and every request type to channels that cannot carry RTL', () => {
    // Compile-time half: `tsc -b` evaluates these, vitest does not.
    expectTypeOf(routeCheckingApproach).parameters.toEqualTypeOf<[ModuleInterface, StrategyArm]>();
    expectTypeOf(renderScoreboardScaffold).parameters.toEqualTypeOf<
      [ModuleInterface, readonly string[]]
    >();
    expectTypeOf<keyof GenerateTestbenchRequest>().toEqualTypeOf<
      'intentSummary' | 'sessionId' | 'spec' | 'testbenchId'
    >();
    expectTypeOf<keyof RepairTestbenchRequest>().toEqualTypeOf<
      'hint' | 'previousSource' | 'sessionId' | 'spec' | 'testbenchId'
    >();
    expectTypeOf<keyof TestbenchGenerationInput>().toEqualTypeOf<
      'intentSummary' | 'okfPassages' | 'spec'
    >();
    expectTypeOf<keyof RepairTestbenchModelInput>().toEqualTypeOf<
      'hint' | 'previousSource' | 'spec'
    >();
    // Runtime half: the arity each entry point actually declares.
    expect([routeCheckingApproach.length, renderScoreboardScaffold.length]).toEqual([2, 2]);
  });
});

describe(SCOREBOARD_PROPERTY_10, () => {
  it('never lets the candidate RTL reach a scoreboard generation or repair request', async () => {
    await fc.assert(
      fc.asyncProperty(
        approvedSpecArbitrary(),
        phraseArbitrary(),
        candidateRtlArbitrary(),
        async (generated, intentSummary, candidateRtl) => {
          const spec: Spec = { ...generated, moduleInterface: STREAMING_INTERFACE };
          expect(candidateRtl).toContain(RTL_SENTINEL);
          expect(routeCheckingApproach(spec.moduleInterface, 'treatment')).toBe(
            'in-order-scoreboard',
          );

          const router = new CapturingModelRouter('{"runLength": 1}');
          const agent = new TestbenchAgent({
            router,
            recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
            retriever: new FixedKnowledgeRetriever([]),
            now: () => FIXED_NOW_MS,
            strategyArm: 'treatment',
          });
          await agent.generateTestbench(
            { sessionId: newUlid(), spec, intentSummary },
            generousBudget(),
          );
          await agent.repairTestbench(
            {
              sessionId: newUlid(),
              spec,
              previousSource: '{"runLength": 1}',
              hint: buildRepairHint({ kind: 'precheck-build-failed', diagnostic: 'syntax error' }),
            },
            generousBudget(),
          );

          // Non-vacuous: both scoreboard requests were built and captured.
          expect(router.requests).toHaveLength(2);
          for (const request of router.requests) {
            expect(JSON.stringify(request)).not.toContain(RTL_SENTINEL);
            expect(request.prompt).toContain('Testbench (product-written, do not reproduce it):');
          }
        },
      ),
      propertyParameters(),
    );
  });
});

describe(GROUNDED_PROPERTY_8, () => {
  it('pins the grounded builders, the check list, the harness, and the normalizer to RTL-free inputs', () => {
    // Compile-time half: `tsc -b` evaluates these, vitest does not.
    expectTypeOf(buildGroundedTestbenchModelInput).parameters.toEqualTypeOf<
      [TestbenchGenerationInput, readonly RequiredCheck[]]
    >();
    expectTypeOf(buildGroundedRepairModelInput).parameters.toEqualTypeOf<
      [RepairTestbenchModelInput]
    >();
    expectTypeOf(requiredChecksFor).parameters.toEqualTypeOf<[Spec, StrategyArm]>();
    expectTypeOf(renderSimulationHarness).parameters.toEqualTypeOf<[number, number]>();
    expectTypeOf(normalizeDialect).parameters.toEqualTypeOf<[string]>();
    expect([
      buildGroundedTestbenchModelInput.length,
      buildGroundedRepairModelInput.length,
      requiredChecksFor.length,
      renderSimulationHarness.length,
      normalizeDialect.length,
    ]).toEqual([2, 1, 2, 2, 1]);
  });

  it('never lets the candidate RTL reach a grounded generation or repair request', async () => {
    await fc.assert(
      fc.asyncProperty(
        approvedSpecArbitrary(),
        phraseArbitrary(),
        candidateRtlArbitrary(),
        async (spec, intentSummary, candidateRtl) => {
          expect(candidateRtl).toContain(RTL_SENTINEL);
          const router = new CapturingModelRouter('no fenced block here');
          const agent = new TestbenchAgent({
            router,
            recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
            retriever: new FixedKnowledgeRetriever([]),
            now: () => FIXED_NOW_MS,
            strategyArm: 'grounded',
          });
          await agent.generateTestbench(
            { sessionId: newUlid(), spec, intentSummary },
            generousBudget(),
          );
          await agent.repairTestbench(
            {
              sessionId: newUlid(),
              spec,
              previousSource: 'module tb; endmodule',
              hint: buildRepairHint({ kind: 'precheck-build-failed', diagnostic: 'syntax error' }),
            },
            generousBudget(),
          );

          // Non-vacuous: both grounded requests were built, each with its Architecture_Section.
          expect(router.requests).toHaveLength(2);
          for (const request of router.requests) {
            expect(JSON.stringify(request)).not.toContain(RTL_SENTINEL);
            expect(request.prompt).toContain(ARCHITECTURE_SECTION_LABEL);
          }
        },
      ),
      propertyParameters(),
    );
  });
});
