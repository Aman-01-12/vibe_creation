// formal-gate-first-light, Property 10: The property-only path touches no testbench and no
// admission step.
//
// WHERE THE PATH IS ENTERED, AND WHY HERE
//   `measureDesign` IS the Property_Only_Mode's per-design path, and the one seam past preflight a
//   test can drive: it takes the whole composed `PropertyOnlyStack`, so the Property_Author and
//   the Formal_Oracle can be replaced while the ORDER, the pass-through and the submitted bytes
//   stay the real module's. `app/eval/property-only/cli.test.ts` holds the preflight, gate and
//   record examples and never reaches this function; this is its generated form.
//
// THE BYTE CLAUSE
//   Every case submits a design the REAL corpus importer produced, and the assertion is a
//   `Buffer.compare` against a snapshot of those bytes taken at import time, before the call. A
//   comparison that normalised whitespace would pass a path that re-rendered, trimmed or
//   instrumented the golden reference, which is the one defect criterion 5.1 exists to forbid.
//   The 46 scored RTLLM references are real files carrying real tabs, blank lines and trailing
//   whitespace, so the snapshot is not a tidy string.
//
// THE ABSENCE CLAUSE, WIRED TO FAIL LOUDLY
//   "No Testbench_Agent call, no Instrument_Admission step" is asserted as something a present
//   call BREAKS, rather than as a counter reading zero over a seam that may not exist:
//     1. The stack, the author and the oracle are each SEALED behind a proxy that THROWS on a
//        read of any key outside the fields the path may reach for. The stack is the path's only
//        injection point, so a path that acquired a testbench generator or an admission port
//        would have to read a key off it, and that read throws by name.
//     2. One shared call log, asserted to be exactly `['property-author', 'formal-oracle']`: the
//        C7 order, with no third collaborator and no second submission.
//
// WHAT THIS DOES NOT COVER, STATED RATHER THAN IMPLIED
//   "The same Property_Validator, Reset_Contract_Prepass and Formal_Oracle the Student_Path uses"
//   has a COMPOSITION half this seam cannot reach. `buildStack` and `authorFactory` are private to
//   `cli.ts` and need a real interpreter and a real credential to construct, so nothing here can
//   assert that the oracle IS a `YosysSmtBmcFormalOracle` or that the author was built through
//   `propertyAuthorFor`. The missing seam is an exported composer with the signature the private
//   one already has - `buildStack(config, prepared, designs, report): PropertyOnlyStack` - which
//   one example test could then assert both class identities against.
//   What IS asserted behaviourally is the half a wrong composition would still break: every
//   property the oracle decides is the author's own output, unmodified and in submission order,
//   under the shipped Property_Time_Budget read from the limit registry, and the pre-pass outcome
//   is what decides the recorded population. Each fixture property is built through the real
//   `validateExpression`, so a submitted property is validator output - but that is this file's
//   construction and not a claim about the shipped author.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

import { Buffer } from 'node:buffer';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PropertySetSource, FormalPropertySet } from '@app/agent';
import type { Spec } from '@app/core';
import {
  declaredLimitsOrRefuse,
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  measureDesign,
  RTLLM_CHECKOUT_PATH,
  scoredRtllmCorpus,
  type PropertyOnlyConfig,
  type PropertyOnlyDesign,
  type PropertyOnlyStack,
} from '@app/eval';
import {
  admitProved,
  refusedWithoutProof,
  validateExpression,
  type ArtifactBlobRef,
  type CouldNotVerifyCause,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProperty,
  type FormalProveRequest,
  type FormalProveSetRequest,
  type ProofConditions,
  type PropertyResult,
  type ProvedEvidence,
  type SourceFile,
} from '@app/tools';

import { propertyParameters } from './property.js';

// **Feature: formal-gate-first-light, Property 10: The property-only path touches no testbench
// and no admission step**
const PROPERTY_10 =
  'formal-gate-first-light, Property 10: The property-only path touches no testbench and no admission step';

/** Headroom for 100 cases over a corpus imported once; the import is the only slow part. */
const SLOW_PROPERTY_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// The imported corpus, and the byte snapshot the claim is made against
// ---------------------------------------------------------------------------

/** Every scored design that has a reference, read exactly as the mode's own importer reads it. */
function importedDesigns(
  corpus: Awaited<ReturnType<typeof importRtllmCorpus>>,
): ReadonlyMap<string, PropertyOnlyDesign> {
  const designs = new Map<string, PropertyOnlyDesign>();
  for (const problem of corpus.problems) {
    const reference = corpus.references.get(problem.id);
    if (reference !== undefined) {
      designs.set(problem.id, { problem, source: reference.rtl });
    }
  }
  return designs;
}

const DESIGNS = importedDesigns(
  scoredRtllmCorpus(await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH))),
);

const DESIGN_IDS: readonly string[] = [...DESIGNS.keys()];

/**
 * The corpus is unfetched on a fresh clone, which is a skip rather than a failure.
 *
 * Same convention as every other corpus-backed suite here (for example
 * `formal-cover-cross-check-refutation.integration.test.ts`): a missing checkout is an absent
 * input, not a defect, so it must not turn `npm test` red on a clone or on a CI runner that has
 * not fetched it. The skip is loud, and it is NOT a pass.
 */
const CORPUS_AVAILABLE = DESIGN_IDS.length > 0;

if (!CORPUS_AVAILABLE) {
  console.warn(
    '[property-only-path] Property 10 was NOT exercised: the pinned RTLLM checkout holds no ' +
      'scored design, so there is no golden reference to submit. Run `npm run corpus:fetch`.',
  );
}

/**
 * An INDEPENDENT copy of each imported reference, taken before any call.
 *
 * The byte claim is made against this snapshot rather than against the object handed to the path,
 * so a path that reassigned a field on the design it was given is a failure here rather than a
 * comparison of a value with itself.
 */
const GOLDEN: ReadonlyMap<string, SourceFile> = new Map(
  [...DESIGNS].map(([id, design]) => [
    id,
    Object.freeze({ path: design.source.path, contents: design.source.contents }),
  ]),
);

// ---------------------------------------------------------------------------
// The stack every case is driven through
// ---------------------------------------------------------------------------

/** The two Authoring_Models criterion 5.11 names; which one authors decides nothing here. */
const AUTHORING_MODELS: readonly string[] = ['zai.glm-5', 'moonshotai.kimi-k2.5'];

/** Caps bounded well above anything a fake author spends, so no cap decides an outcome. */
const CONFIG: PropertyOnlyConfig = {
  runName: 'property-only-path-property',
  outputDir: '.eval-runs/property-only-path-property',
  region: 'us-east-1',
  authoringModels: AUTHORING_MODELS,
  costPilotDesignIds: [DESIGN_IDS[0] ?? ''],
  limits: { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 },
  caps: {
    maxIterations: 1,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
  },
  extrapolationFrom: null,
};

/** No toolchain is probed here, and no verdict in this file came from one. */
const TOOLCHAIN: PropertyOnlyStack['toolchain'] = {
  iverilogVersion: null,
  vvpVersion: null,
  workerPython: null,
  yosysVersion: { kind: 'not-measured', reason: 'this fixture probes no toolchain' },
  yosysBuildId: { kind: 'not-measured', reason: 'this fixture probes no toolchain' },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'this fixture probes no toolchain' },
  bitwuzlaVersion: { kind: 'not-measured', reason: 'this fixture probes no toolchain' },
  z3Version: { kind: 'not-measured', reason: 'this fixture probes no toolchain' },
};

/** The shipped Property_Time_Budget, read from the registry the mode itself reads (Req 5.4). */
function shippedBudgetMs(): number {
  const limits = declaredLimitsOrRefuse();
  if (!limits.ok) {
    throw new Error(`the limit registry refused this fixture: ${limits.error.message}`);
  }
  return limits.value.propertyTimeBudget.value;
}

const BUDGET_MS = shippedBudgetMs();

/** What each collaborator appends to the ONE shared log; what is ABSENT from it is the claim. */
type CallName = 'property-author' | 'formal-oracle';

/** The fields the path may read off its stack. Every other key throws (Req 5.2, 5.3). */
const STACK_FIELDS: readonly string[] = [
  'config',
  'designs',
  'oracle',
  'authorFor',
  'toolchain',
  'budgetMs',
  'now',
  'report',
];

const ORACLE_METHODS: readonly string[] = ['prove', 'proveSet'];

const AUTHOR_METHODS: readonly string[] = ['propertySetFor'];

/**
 * `subject` behind a proxy that throws on a read of any key outside `allowed`.
 *
 * This is how the absence is made breakable rather than merely unobserved: the stack is the
 * path's only injection point, so a Testbench_Agent or an Instrument_Admission port could only
 * arrive as a field on it, and reading that field fails by name instead of passing silently.
 * Symbol keys pass through untouched - no collaborator arrives under one, and throwing on them
 * would break ordinary inspection of the value.
 */
function sealed<T extends object>(subject: T, allowed: readonly string[], what: string): T {
  return new Proxy(subject, {
    get(target, key, receiver): unknown {
      if (typeof key === 'string' && !allowed.includes(key)) {
        throw new Error(
          `the property-only path read "${key}" off ${what}: this path makes no Testbench_Agent call and consults no Instrument_Admission step (Req 5.2, 5.3), so ${allowed.join(', ')} is all it may reach for`,
        );
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

// ---------------------------------------------------------------------------
// The scripted formal answers
// ---------------------------------------------------------------------------

/** The three causes this fixture scripts, tied to the real vocabulary so a rename fails to build. */
type ScriptedCause = Extract<
  CouldNotVerifyCause,
  'induction-inconclusive' | 'reset-contract-unresolved' | 'clock-contract-unsupported'
>;

/** What the oracle answers one submitted set with. */
type ScriptedVerdict = 'proved' | 'refuted' | ScriptedCause;

/**
 * The causes that mean the Reset_Contract_Prepass refused before a solver ran.
 *
 * Stated here independently of the CLI's own private list: a test that imported the list it is
 * checking against would agree with the code by construction.
 */
const PREPASS_REFUSALS: readonly ScriptedVerdict[] = [
  'reset-contract-unresolved',
  'clock-contract-unsupported',
];

const SCRIPTED_RUN = Object.freeze({ depth: 20, elapsedMs: 10 });

/** The counterexample a refuted result carries. Nothing in this path reads its bytes. */
const COUNTEREXAMPLE: ArtifactBlobRef = Object.freeze({
  name: 'counterexample.vcd',
  sizeBytes: 24,
  sha256: 'c'.repeat(64),
});

/** The conditions a refutation is reported over: a FAILED base case beside a passing presat. */
const REFUTED_CONDITIONS: ProofConditions = Object.freeze<ProofConditions>({
  assertionCount: 2,
  presat: 'satisfiable',
  cover: { reached: 'not-applicable' },
  base: 'failed',
  induction: 'not-run',
});

/** The one value a `proved` result can be built from, through its sole constructor. */
function provedEvidence(): ProvedEvidence {
  const admitted = admitProved({
    assertionCount: 2,
    presat: 'satisfiable',
    cover: { reached: 'not-applicable' },
    base: 'passed',
    induction: 'successful',
  });
  if (typeof admitted === 'string') {
    throw new Error(`the proving fixture was refused as ${admitted}`);
  }
  return admitted;
}

const PROVED_EVIDENCE = provedEvidence();

function resultFor(verdict: ScriptedVerdict, property: FormalProperty): PropertyResult {
  if (verdict === 'proved') {
    return {
      verdict: 'proved',
      evidence: PROVED_EVIDENCE,
      ...SCRIPTED_RUN,
      criterionRef: property.criterionRef,
    };
  }
  if (verdict === 'refuted') {
    return {
      verdict: 'refuted',
      counterexample: COUNTEREXAMPLE,
      conditions: REFUTED_CONDITIONS,
      ...SCRIPTED_RUN,
      criterionRef: property.criterionRef,
    };
  }
  return refusedWithoutProof(verdict, property, SCRIPTED_RUN, '');
}

/** One result per submitted property, under a Reset_Contract the scripted verdict decides. */
function scriptedOutcome(
  properties: readonly FormalProperty[],
  verdict: ScriptedVerdict,
): FormalOutcome {
  const refused = PREPASS_REFUSALS.includes(verdict);
  return {
    results: properties.map((property) => resultFor(verdict, property)),
    // A pre-pass refusal builds no Property_Wrapper, so none is reported for it (Req 5.17).
    propertyWrapperSources: properties.map((property) =>
      refused ? null : `module formal_property_wrapper; // ${property.id}\nendmodule\n`,
    ),
    // This double resolves no artifact reference, so no property carries a trace.
    counterexampleCaptures: properties.map(() => null),
    resetContract: refused
      ? { derived: false }
      : {
          derived: true,
          resetName: 'rst_n',
          resetActiveLow: true,
          resetKind: 'async',
          initialStateFree: true,
        },
    assertionGateEmitted: false,
    clockPolarity: verdict === 'clock-contract-unsupported' ? 'negedge' : 'posedge',
  };
}

// ---------------------------------------------------------------------------
// The fake Property_Author, which derives its set from the Spec it is handed
// ---------------------------------------------------------------------------

/** The one validated expression every fixture property carries; its text decides nothing. */
function fixtureConsequent(): FormalProperty & { readonly kind: 'combinational' } {
  const consequent = validateExpression('q == d');
  if (!consequent.ok) {
    throw new Error('the fixture expression was refused by the Property_Validator');
  }
  return { kind: 'combinational', id: 'p1', criterionRef: '', consequent: consequent.value };
}

const FIXTURE_PROPERTY = fixtureConsequent();

/**
 * A Property_Set DERIVED from the Spec the author was handed.
 *
 * Faithful rather than fixed: each property names one of that Spec's OWN acceptance criteria, so
 * a path that authored from one design and proved against another submits criteria the asserted
 * design does not hold (`chipAgent/_inbox/pattern-faithful-fake-detects-stale-input-defect.md`).
 */
function propertiesFromSpec(spec: Spec, count: number): readonly FormalProperty[] {
  const criteria = spec.acceptanceCriteria;
  const first = criteria[0];
  if (first === undefined) {
    throw new Error(`this fixture needs a Spec with at least one acceptance criterion: ${spec.id}`);
  }
  return Array.from({ length: count }, (_unused, index) => ({
    ...FIXTURE_PROPERTY,
    id: `p${index + 1}`,
    criterionRef: (criteria[index % criteria.length] ?? first).id,
  }));
}

// ---------------------------------------------------------------------------
// One case, driven through the real `measureDesign`
// ---------------------------------------------------------------------------

/** One generated case: which design, which Authoring_Model, how many properties, what verdict. */
interface Scenario {
  readonly designId: string;
  readonly model: string;
  readonly propertyCount: number;
  readonly verdict: ScriptedVerdict;
}

/**
 * The design ids the generator draws from.
 *
 * `fc.constantFrom` rejects an empty parameter list, and this arbitrary is built at module scope,
 * so an absent checkout would throw here before `describe.skipIf` could skip the suite. The
 * placeholder is only ever reachable when `CORPUS_AVAILABLE` is false, in which case every case
 * below is skipped and no scenario is generated from it.
 */
const ARB_DESIGN_IDS: readonly string[] = CORPUS_AVAILABLE
  ? DESIGN_IDS
  : ['corpus-absent-placeholder'];

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  designId: fc.constantFrom(...ARB_DESIGN_IDS),
  model: fc.constantFrom(...AUTHORING_MODELS),
  propertyCount: fc.constantFrom(1, 2, 3),
  verdict: fc.constantFrom<ScriptedVerdict>(
    'proved',
    'refuted',
    'induction-inconclusive',
    'reset-contract-unresolved',
    'clock-contract-unsupported',
  ),
});

/** What one driven case observed. */
interface Observation {
  readonly log: readonly CallName[];
  readonly submitted: readonly FormalProveSetRequest[];
  readonly authored: readonly FormalPropertySet[];
  readonly result: Awaited<ReturnType<typeof measureDesign>>;
}

async function observe(design: PropertyOnlyDesign, scenario: Scenario): Promise<Observation> {
  const log: CallName[] = [];
  const submitted: FormalProveSetRequest[] = [];
  const authored: FormalPropertySet[] = [];

  const author: PropertySetSource = {
    propertySetFor(spec: Spec): Promise<FormalPropertySet> {
      log.push('property-author');
      const set: FormalPropertySet = {
        properties: propertiesFromSpec(spec, scenario.propertyCount),
        unexpressedCriteria: [],
        propertySetAdmitted: 'not-gated',
      };
      authored.push(set);
      return Promise.resolve(set);
    },
  };

  const proveSet = (request: FormalProveSetRequest): Promise<FormalOutcome> => {
    log.push('formal-oracle');
    submitted.push(request);
    return Promise.resolve(scriptedOutcome(request.properties, scenario.verdict));
  };

  const oracle: FormalOraclePort = {
    proveSet,
    // Routed THROUGH `proveSet` so a per-property call is logged as the submission it is.
    async prove(request: FormalProveRequest): Promise<PropertyResult> {
      const outcome = await proveSet({
        designSource: request.designSource,
        designInterface: request.designInterface,
        properties: [request.property],
        budgetMs: request.budgetMs,
      });
      const [result] = outcome.results;
      if (result === undefined) {
        throw new Error('the scripted oracle holds no result for this property');
      }
      return result;
    },
  };

  let tick = 0;
  const stack: PropertyOnlyStack = {
    config: CONFIG,
    designs: DESIGNS,
    oracle: sealed(oracle, ORACLE_METHODS, 'the Formal_Oracle'),
    authorFor: () => sealed(author, AUTHOR_METHODS, 'the Property_Author'),
    toolchain: TOOLCHAIN,
    budgetMs: BUDGET_MS,
    now: () => (tick += 7),
    report: () => undefined,
  };

  const result = await measureDesign(
    sealed(stack, STACK_FIELDS, 'the property-only stack'),
    scenario.model,
    design,
  );
  return { log, submitted, authored, result };
}

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

/**
 * The submitted design equals the imported golden reference BYTE FOR BYTE.
 *
 * `Buffer.compare` and not a normalising comparison: the defect this guards against is a path
 * that trims, re-indents, re-renders or instruments the reference, and every one of those
 * survives a whitespace-insensitive check.
 */
function expectByteIdentical(submitted: SourceFile, golden: SourceFile, where: string): void {
  expect(submitted.path, `${where}: the submitted file is not the reference's own path`).toBe(
    golden.path,
  );
  const left = Buffer.from(submitted.contents, 'utf8');
  const right = Buffer.from(golden.contents, 'utf8');
  expect(
    left.length,
    `${where}: the submitted design is ${left.length} bytes against the reference's ${right.length}`,
  ).toBe(right.length);
  expect(
    Buffer.compare(left, right),
    `${where}: the design submitted to the Formal_Oracle is not byte-identical to the imported golden reference`,
  ).toBe(0);
}

describe.skipIf(!CORPUS_AVAILABLE)(PROPERTY_10, () => {
  it(
    'submits the imported golden reference byte for byte, through the Property_Author and the Formal_Oracle alone',
    async () => {
      const populations = new Set<string>();
      const submittedBytes = new Set<string>();

      await fc.assert(
        fc.asyncProperty(arbScenario, async (scenario) => {
          const where = JSON.stringify(scenario);
          const design = DESIGNS.get(scenario.designId);
          const golden = GOLDEN.get(scenario.designId);
          if (design === undefined || golden === undefined) {
            throw new Error(`${where}: this fixture holds no such design`);
          }

          const observed = await observe(design, scenario);

          // Req 5.2, 5.3: the author, then the oracle, and no third collaborator was even
          // reachable - every other key on the stack and on both ports throws.
          expect(
            observed.log,
            `${where}: the path's observed calls are not the author then the oracle alone`,
          ).toEqual(['property-author', 'formal-oracle']);

          const request = observed.submitted[0];
          const set = observed.authored[0];
          if (request === undefined || set === undefined) {
            throw new Error(`${where}: the path neither authored nor submitted`);
          }
          expect(observed.submitted.length, `${where}: the oracle was submitted to twice`).toBe(1);

          // Req 5.1: the unmodified golden reference, and the interface it was imported with.
          expectByteIdentical(request.designSource, golden, where);
          expect(request.designInterface).toEqual(design.problem.spec.moduleInterface);

          // Req 5.4: the author's own set, in submission order, under the shipped budget.
          expect(
            request.properties,
            `${where}: the submitted set is not the one the author produced`,
          ).toEqual(set.properties);
          expect(request.properties.length).toBe(scenario.propertyCount);
          expect(request.budgetMs, `${where}: the shipped Property_Time_Budget was not used`).toBe(
            BUDGET_MS,
          );

          // The set was authored from THIS design's Spec, not from another's.
          const ownCriteria = new Set(
            design.problem.spec.acceptanceCriteria.map((criterion) => criterion.id),
          );
          for (const property of request.properties) {
            expect(
              ownCriteria.has(property.criterionRef),
              `${where}: a submitted property names a criterion this design does not hold`,
            ).toBe(true);
          }

          // The record: attributed to the design and the model, with the population the
          // Reset_Contract_Prepass outcome decided and one entry per submitted property.
          expect(observed.result.designId).toBe(design.problem.id);
          expect(observed.result.authoringModel).toBe(scenario.model);
          expect(observed.result.population, `${where}: the recorded population is wrong`).toBe(
            PREPASS_REFUSALS.includes(scenario.verdict) ? 'refused' : 'admitted',
          );
          expect(observed.result.properties.map((property) => property.propertyId)).toEqual(
            request.properties.map((property) => property.id),
          );

          populations.add(observed.result.population);
          submittedBytes.add(request.designSource.contents);
        }),
        propertyParameters(),
      );

      // NON-VACUITY. A byte claim checked against one constant design would hold for a path that
      // hardcoded that design, and a population claim needs both arms of the pre-pass outcome.
      expect(
        submittedBytes.size,
        'every case submitted the same bytes, so the byte claim was made over one design',
      ).toBeGreaterThan(1);
      expect(populations).toEqual(new Set(['admitted', 'refused']));
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});
