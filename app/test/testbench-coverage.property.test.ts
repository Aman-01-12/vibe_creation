// Property 6 for the Testbench_Agent: the testbench covers every acceptance
// criterion (task 13.5; Req 7.3).
//
// This is the universal complement to the concrete examples in
// `testbench-agent.test.ts`. Over generated approved Specs whose acceptance
// criteria mix simulation / formal / manual-inspection methods and
// measurable / unmeasurable flags - and whose module descriptions sometimes
// name a standard block - it asserts the coverage guarantee the design binds to
// Property 6:
//
//   - Required set (deterministic, from the Spec alone): `requiredChecks(spec)`
//     yields exactly one whitespace-free, uniquely-named check per
//     simulation-verifiable acceptance criterion (measurable AND method
//     'simulation'), each traceable to its criterion id, plus any known-answer
//     checks - and never a check for a non-simulation or unmeasurable criterion.
//   - Complete branch: when the (fake) model returns a source that emits every
//     required CHECK line, `generateTestbench` returns a `generated` Testbench
//     whose coverage set equals the required set, and every required check is
//     present in the produced source (so a produced Testbench covers every
//     acceptance criterion by construction, Req 7.3).
//   - Incomplete branch: when the source omits at least one required check, the
//     outcome is `coverage-incomplete`, lists exactly the missing check(s), and
//     produces NO Testbench.
//
// The fake model source is CONSTRUCTED by the test from a chosen subset of the
// required checks (using `formatCheckLine`, the exact oracle-parseable line
// form), so both the complete and incomplete branches are forced deterministically
// rather than left to chance. A fresh agent + in-memory recorder + empty OKF
// retriever per run gives full independence between runs.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TestbenchAgent,
  coveredCriterionIds,
  formatCheckLine,
  isValidCheckName,
  requiredChecks,
  simulationCriteria,
  sourceEmitsCheck,
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
  type AcceptanceMethod,
  type Result,
  type Spec,
} from '@app/core';
import type { KnowledgeQuery, KnowledgeRetriever, RetrievalResult } from '@app/knowledge';
import { propertyParameters, propertyTag, routedModelIdFor } from '@app/test';

// --- Fakes -------------------------------------------------------------------

/** A successful routed result carrying the given output text as the model reply. */
function routed(outputText: string): Result<RoutedModelResult, ModelRouterFailure> {
  return {
    ok: true,
    value: {
      task: 'generation',
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

// --- Generators --------------------------------------------------------------

/** The closed set of acceptance-verification methods. */
const ACCEPTANCE_METHODS: readonly AcceptanceMethod[] = [
  'simulation',
  'formal',
  'manual-inspection',
];

/**
 * Criterion text that stresses `slugify`: plain ASCII, spaces, unicode, and empty.
 *
 * Whitespace and non-alphanumeric characters must be collapsed away so every
 * derived check name stays a single whitespace-free token, so the generator
 * deliberately includes them.
 */
const criterionTextArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc.string({ unit: 'grapheme', maxLength: 40 }),
  fc.constantFrom(
    'q increments by one on each clock while not in reset',
    'reset clears the output',
    'sum and carry match the truth table',
    'счётчик увеличивается на единицу',
    '计数器加一',
    '   ',
    '',
    '!!!',
  ),
);

/** A seed for one acceptance criterion (id is attached later, by position). */
interface CriterionSeed {
  readonly text: string;
  readonly measurable: boolean;
  readonly method: AcceptanceMethod;
}

/** A criterion guaranteed to be simulation-verifiable (measurable AND simulation). */
const simulationSeedArbitrary: fc.Arbitrary<CriterionSeed> = fc.record({
  text: criterionTextArbitrary,
  measurable: fc.constant(true),
  method: fc.constant<AcceptanceMethod>('simulation'),
});

/** An arbitrary criterion of any method / measurability (may or may not be simulation). */
const anySeedArbitrary: fc.Arbitrary<CriterionSeed> = fc.record({
  text: criterionTextArbitrary,
  measurable: fc.boolean(),
  method: fc.constantFrom(...ACCEPTANCE_METHODS),
});

/**
 * A non-empty, mixed list of criterion seeds with at least one simulation-verifiable
 * seed inserted at an arbitrary position, so `simulationCriteria` is never empty
 * (the agent fails closed on a Spec with no simulation criteria, a separate path).
 */
const criterionSeedsArbitrary: fc.Arbitrary<readonly CriterionSeed[]> = fc
  .tuple(fc.array(anySeedArbitrary, { maxLength: 6 }), simulationSeedArbitrary, fc.nat({ max: 64 }))
  .map(([rest, guaranteedSim, position]) => {
    const seeds = [...rest];
    seeds.splice(position % (seeds.length + 1), 0, guaranteedSim);
    return seeds;
  });

/** Attach a unique, deterministic id to each seed by position. */
function toCriteria(seeds: readonly CriterionSeed[]): readonly AcceptanceCriterion[] {
  return seeds.map((seed, index) => ({
    id: `criterion_${index}`,
    text: seed.text,
    measurable: seed.measurable,
    method: seed.method,
  }));
}

/**
 * Module descriptions that MIX standard-block designs (so known-answer checks are
 * added) with bespoke designs (criterion checks only).
 */
const moduleProfileArbitrary = fc.constantFrom(
  {
    moduleName: 'up_counter',
    goal: 'A 4-bit synchronous up counter with reset',
    architecture: 'A clocked always block increments q.',
  },
  {
    moduleName: 'full_adder',
    goal: 'A single-bit full adder',
    architecture: 'Combinational sum and carry logic.',
  },
  {
    moduleName: 'mux4',
    goal: 'A 4-to-1 multiplexer',
    architecture: 'Select-driven combinational mux.',
  },
  {
    moduleName: 'shift_register',
    goal: 'An 8-bit shift register',
    architecture: 'A clocked shift register chain.',
  },
  {
    moduleName: 'bus_arbiter',
    goal: 'A bespoke protocol arbiter for a custom bus',
    architecture: 'A custom priority arbiter with round-robin tie-breaking.',
  },
  {
    moduleName: 'datapath',
    goal: 'A bespoke datapath slice',
    architecture: 'A custom combinational datapath.',
  },
);

/** Build an approved Spec from a module profile and a criteria list. */
function makeSpec(
  profile: { moduleName: string; goal: string; architecture: string },
  criteria: readonly AcceptanceCriterion[],
  version: number,
): Spec {
  return {
    id: 'spec_ulid',
    projectId: 'project_ulid',
    goal: profile.goal,
    constraints: ['single module'],
    architecture: profile.architecture,
    moduleInterface: {
      moduleName: profile.moduleName,
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'q', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
    acceptanceCriteria: criteria,
    approved: true,
    version,
  };
}

/** An approved Spec with mixed acceptance criteria and a possibly-standard block. */
const specArbitrary: fc.Arbitrary<Spec> = fc
  .tuple(moduleProfileArbitrary, criterionSeedsArbitrary, fc.integer({ min: 1, max: 9 }))
  .map(([profile, seeds, version]) => makeSpec(profile, toCriteria(seeds), version));

/** The test's choice of which required checks the fake model source will emit. */
type CoveragePlan =
  | { readonly kind: 'complete' }
  | { readonly kind: 'incomplete'; readonly drop: readonly boolean[] };

/**
 * A coverage plan for a given number of required checks.
 *
 * `complete` emits every required check; `incomplete` drops a non-empty subset
 * (at least one drop is forced when the random mask happens to keep everything),
 * so both branches of `generateTestbench` are exercised deterministically.
 */
function coveragePlanArbitrary(checkCount: number): fc.Arbitrary<CoveragePlan> {
  const complete = fc.constant<CoveragePlan>({ kind: 'complete' });
  const incomplete = fc
    .array(fc.boolean(), { minLength: checkCount, maxLength: checkCount })
    .map((mask) => (mask.some((drop) => drop) ? mask : mask.map((_, index) => index === 0)))
    .map((drop): CoveragePlan => ({ kind: 'incomplete', drop }));
  return fc.oneof(complete, incomplete);
}

/** A whole scenario: an approved Spec and a coverage plan sized to its required checks. */
interface CoverageScenario {
  readonly spec: Spec;
  readonly plan: CoveragePlan;
}

const scenarioArbitrary: fc.Arbitrary<CoverageScenario> = specArbitrary.chain((spec) =>
  coveragePlanArbitrary(requiredChecks(spec).length).map((plan) => ({ spec, plan })),
);

// --- Source construction -----------------------------------------------------

/** Which required checks a plan keeps (emits) for a given required-check set. */
function keptChecks(
  checks: readonly RequiredCheck[],
  plan: CoveragePlan,
): readonly RequiredCheck[] {
  if (plan.kind === 'complete') {
    return checks;
  }
  return checks.filter((_, index) => plan.drop[index] !== true);
}

/** Build a parseable testbench source that emits a CHECK line for exactly `emitted`. */
function buildSource(emitted: readonly RequiredCheck[]): string {
  const lines = emitted.map((check) => `      $display("${formatCheckLine(check.name, true)}");`);
  return ['module tb;', '  initial begin', ...lines, '    $finish;', '  end', 'endmodule'].join(
    '\n',
  );
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

// --- The property ------------------------------------------------------------

describe('Testbench_Agent acceptance-criterion coverage (Property 6)', () => {
  // Feature: hdl-creation-loop, Property 6: The testbench covers every acceptance criterion
  it('produces a Testbench only when every simulation criterion is covered, and covers them all by construction', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ spec, plan }) => {
        const checks = requiredChecks(spec);
        const simCriteria = simulationCriteria(spec);
        const simIds = simCriteria.map((criterion) => criterion.id);
        const excludedIds = spec.acceptanceCriteria
          .filter((criterion) => !(criterion.measurable && criterion.method === 'simulation'))
          .map((criterion) => criterion.id);

        // --- The required set is derived correctly from the Spec alone (Req 7.3).
        const criterionChecks = checks.filter((check) => check.kind === 'criterion');
        const knownAnswerChecks = checks.filter((check) => check.kind === 'known-answer');

        // Exactly one criterion check per simulation-verifiable criterion, in order,
        // each traceable to its criterion id - and none for excluded criteria.
        expect(criterionChecks).toHaveLength(simCriteria.length);
        expect(criterionChecks.map((check) => check.criterionId)).toStrictEqual(simIds);
        expect(coveredCriterionIds(checks)).toStrictEqual(simIds);
        for (const excludedId of excludedIds) {
          expect(coveredCriterionIds(checks)).not.toContain(excludedId);
        }

        // Every check name is a single whitespace-free token, and names are unique.
        const names = checks.map((check) => check.name);
        for (const name of names) {
          expect(isValidCheckName(name)).toBe(true);
        }
        expect(new Set(names).size).toBe(names.length);

        // Known-answer checks carry no criterion id (they trace to a reference block).
        for (const known of knownAnswerChecks) {
          expect(known.criterionId).toBeUndefined();
        }

        // --- Drive the agent with a source that emits exactly the planned subset.
        const emitted = keptChecks(checks, plan);
        const source = buildSource(emitted);
        const agent = agentReturning(routed(JSON.stringify({ source })));
        const outcome = await agent.generateTestbench(request(spec), generousBudget());

        if (plan.kind === 'complete') {
          // A produced Testbench covers every acceptance criterion by construction.
          expect(outcome.status).toBe('generated');
          if (outcome.status !== 'generated') {
            return;
          }
          expect(outcome.testbench.sourceAttribution).toBe('spec');
          expect(outcome.testbench.specVersion).toBe(spec.version);
          // The produced Testbench's coverage set equals the required set.
          expect(outcome.testbench.coversCriteria).toStrictEqual(coveredCriterionIds(checks));
          expect(outcome.testbench.coversCriteria).toStrictEqual(simIds);
          expect(outcome.checks.map((check) => check.name)).toStrictEqual(names);
          // Every required check is emitted in the produced source.
          for (const check of checks) {
            expect(sourceEmitsCheck(outcome.testbench.source, check.name)).toBe(true);
          }
          return;
        }

        // --- Incomplete branch: no Testbench, and the missing checks are listed.
        expect(outcome.status).toBe('coverage-incomplete');
        if (outcome.status !== 'coverage-incomplete') {
          return;
        }
        // No Testbench is produced in this state.
        expect('testbench' in outcome).toBe(false);

        const expectedMissing = checks
          .filter((check) => !emitted.includes(check))
          .map((check) => check.name)
          .sort();
        expect(expectedMissing.length).toBeGreaterThan(0);
        expect(outcome.missingChecks.map((check) => check.name).sort()).toStrictEqual(
          expectedMissing,
        );
        // The kept checks really are present, so the gap is exactly the dropped set.
        for (const check of emitted) {
          expect(sourceEmitsCheck(outcome.source, check.name)).toBe(true);
        }
      }),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 6 tag is asserted, not just written in a
// comment: `Feature: hdl-creation-loop, Property 6: The testbench covers every acceptance criterion`.
describe('Property 6 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(propertyTag(6, 'The testbench covers every acceptance criterion')).toBe(
      'Feature: hdl-creation-loop, Property 6: The testbench covers every acceptance criterion',
    );
  });
});
