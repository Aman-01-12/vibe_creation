// formal-gate-first-light, Property 32: The Student_Path is unmoved by this spec's measurements.
//
// THE SPEC'S CENTRAL NON-GOAL, WRITTEN AS A TEST
//   Requirement 10 protects one thing: every measurement this spec adds leaves the student's
//   verification path exactly where it was, so the number measured is the number shipped. The
//   failure of this property is the only failure in the spec that would mean the spec HARMED the
//   product rather than mismeasured it.
//
// TWO CLAUSES, ASSERTED THREE WAYS
//   1. ORDERING, GENERATED. `student-path-ordering.test.ts` (task 9.10) pins the ordering with ONE
//      example. This is its generated form: the same recording-admission and recording-oracle
//      ports, the same read of the loop's OBSERVED call order rather than its source text, over
//      generated loop configurations - admission decision, Property_Set size and admission stamp,
//      Formal_Verdict, and a simulation that would pass or fail. The claim holds in the direction
//      that matters: a submission may never PRECEDE a consultation. Configurations that never
//      reach the oracle satisfy it, so both populations are counted and both are required to be
//      non-empty, since an ordering claim over a population that never reached the second event
//      is vacuous (Req 10.1).
//   2. IDENTITY, BEHAVIOURAL. The same 100 configurations run twice under one fixed seed - once
//      with the Property_Only_Mode absent from the process, once after it has been loaded into it
//      - and the verdict, the trust label and the Fallback_Route must match case for case
//      (Req 10.3, 10.6).
//   3. IDENTITY, STRUCTURAL. The Student_Path packages are shown to be CLOSED under imports over
//      themselves, so no module under `app/eval` - the Property_Only_Mode included - is reachable
//      from the code that decides a verdict, a trust label, or a route.
//
// THE JUDGEMENT CALL ON CLAUSE 2, AND WHAT IT DOES NOT COVER
//   "Identical whether or not the Property_Only_Mode exists in the build" cannot be tested
//   literally: a unit test cannot build the tree twice. What it MEANS is that nothing in the mode
//   is reachable from the Student_Path, and reachability has a static half and a dynamic half that
//   neither assertion alone covers.
//     - The STATIC half (claim 3) is the real content of "exists in the build", and it is a
//       source-read by necessity: behaviour cannot distinguish an unreachable module from an
//       absent one, which is the case the vault already records as needing a source-read pin.
//       It is computed over the real TypeScript scanner rather than a regex, because `@app/eval`
//       is named in a dozen COMMENTS inside these packages and a regex would call every one of
//       them an edge.
//     - The DYNAMIC half (claim 2) covers what the static half cannot see: an import-time side
//       effect. A module can be unreachable by import and still move a decision by mutating
//       shared state when it is loaded - patching a default, registering into a registry held in
//       `@app/core`. Loading the mode between two otherwise identical passes is the only way to
//       observe that, and the dynamic import is deliberately the FIRST thing in this file to
//       touch `@app/eval`, so the baseline pass is a genuinely unloaded one.
//   NEITHER COVERS, AND THIS IS STATED RATHER THAN PAPERED OVER:
//     - A real two-configuration BUILD. Nothing here compares bytes of two trees; a build that
//       dropped `app/eval` is not exercised.
//     - A reach created at RUNTIME that the scanner cannot see: a specifier assembled from a
//       string, or a Property_Only_Mode value injected into the loop by a composition root that
//       lives outside the four scanned packages. Covering the second would need a check at every
//       composition root that constructs a `VerificationLoop`, which is a wider claim than this
//       property states.
//     - Test files inside the scanned packages, which are excluded: a test may legitimately reach
//       the eval layer, and a test is not the Student_Path.
//   A fourth option was weighed and rejected: asserting the mode "exports nothing the loop's
//   decision functions accept". That is a claim about TYPES, it passes for the wrong reason the
//   moment a shape happens to be structurally compatible, and it says nothing about either half
//   of reachability.
//
//   The config boundary's refusal of Student_Path-shaped keys (Req 10.4) is task 11.16's property
//   and is not re-asserted here.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 10.1, 10.3, 10.6**

import { readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TraceActionRecorder,
  VerificationLoop,
  type CandidateEval,
  type CandidateFailure,
  type CandidateGenerator,
  type ConfirmedGenerationContext,
  type FallbackRoute,
  type FormalPropertySet,
  type GeneratedCandidate,
  type GenerationAdmissionRequest,
  type GenerationContextOpener,
  type GenerationGateRefusal,
  type IndependentTestbenchGenerator,
  type InstrumentAdmission,
  type InstrumentAdmissionDecision,
  type PropertySetAdmissionOutcome,
  type PropertySetSource,
  type TestbenchGenerationOutcome,
  type VerificationOutcome,
} from '@app/agent';
import {
  err,
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type Result,
  type Spec,
  type Testbench,
} from '@app/core';
import {
  admitProved,
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  refusedWithoutProof,
  SandboxToolRunner,
  validateExpression,
  type ArtifactBlobRef,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProperty,
  type ProofConditions,
  type PropertyResult,
  type ProvedEvidence,
  type RawRunCapture,
  type ResourceLimits,
  type SandboxJob,
} from '@app/tools';

import { DEFAULT_NUM_RUNS, propertyParameters } from './property.js';
import { timingContractFor } from '@app/test';

// **Feature: formal-gate-first-light, Property 32: The Student_Path is unmoved by this spec's
// measurements**
const PROPERTY_32 =
  "formal-gate-first-light, Property 32: The Student_Path is unmoved by this spec's measurements";

/** Headroom for a property driving the whole real loop a few hundred times. */
const SLOW_PROPERTY_TIMEOUT_MS = 120_000;

/**
 * The seed both identity passes run under.
 *
 * FIXED, because the claim is a per-case comparison and the two passes must therefore generate the
 * SAME cases in the same order. The replay is not assumed: each case's own configuration is
 * recorded in pass one and compared in pass two, so a generator that stopped replaying fails as a
 * replay mismatch rather than as a false identity failure.
 */
const IDENTITY_SEED = 20_260_207;

const LIMITS: ResourceLimits = Object.freeze({
  cpu: 1,
  memMb: 256,
  procs: 64,
  diskMb: 64,
  wallMs: 5_000,
});

/** The admission request. The gate double ignores it, so its shape is never read. */
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/** The Testbench_Precheck's own stub filename, so its build check is told apart from a run. */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

/** The check name the fixture testbench declares, and the one its captures report. */
const CHECK_NAME = 'q_captures_d';

/** What each recording port appends to the ONE shared log; the order between them is the claim. */
type CallName = 'instrument-admission' | 'formal-oracle';

// ---------------------------------------------------------------------------
// The generated loop configuration
// ---------------------------------------------------------------------------

/** The Formal_Verdict every property in a generated set is answered with. */
type ScriptedVerdict = 'proved' | 'refuted' | 'could-not-verify';

/**
 * One loop configuration.
 *
 * Every field changes WHETHER or WHEN the loop reaches the Formal_Oracle, which is what makes the
 * ordering claim worth generating: an inadmissible instrument stops before it, a refused
 * Property_Set is withheld from it, and a failing simulation reaches it on a different path from a
 * passing one. Sets are always non-empty: the empty-set routes are Property 20's population, and a
 * set that gives the loop nothing to prove would make the ordering claim vacuous by construction.
 */
interface LoopConfig {
  readonly admission: InstrumentAdmissionDecision;
  readonly propertyCount: number;
  readonly setAdmitted: PropertySetAdmissionOutcome;
  readonly verdict: ScriptedVerdict;
  readonly simulation: 'passes' | 'fails';
}

const arbLoopConfig: fc.Arbitrary<LoopConfig> = fc.record({
  admission: fc.constantFrom<InstrumentAdmissionDecision>(
    'admissible',
    'inadmissible',
    'undecided',
  ),
  propertyCount: fc.constantFrom(1, 2, 3),
  // `no-gate-set` is excluded: it is the stamp for a gate that found nothing to test, which only
  // an empty set can carry, and every set here is non-empty.
  setAdmitted: fc.constantFrom<PropertySetAdmissionOutcome>('not-gated', 'admitted', 'refused'),
  verdict: fc.constantFrom<ScriptedVerdict>('proved', 'refuted', 'could-not-verify'),
  simulation: fc.constantFrom<'passes' | 'fails'>('passes', 'fails'),
});

// ---------------------------------------------------------------------------
// The scripted formal answers
// ---------------------------------------------------------------------------

/** The counterexample a refuted result carries. Nothing reads its bytes. */
const COUNTEREXAMPLE: ArtifactBlobRef = Object.freeze({
  name: 'counterexample.vcd',
  sizeBytes: 24,
  sha256: 'c'.repeat(64),
});

const SCRIPTED_DEPTH = 20;
const SCRIPTED_ELAPSED_MS = 10;

/** The conditions a refutation is reported over: a FAILED base case beside a passing presat. */
const REFUTED_CONDITIONS: ProofConditions = Object.freeze<ProofConditions>({
  assertionCount: 2,
  presat: 'satisfiable',
  cover: { reached: 'not-applicable' },
  base: 'failed',
  induction: 'not-run',
});

/** The one cause every scripted `could-not-verify` carries; which cause it is decides nothing. */
const SCRIPTED_CAUSE = 'induction-inconclusive' as const;

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

/** A validated combinational property naming the criterion at `position`. Its text decides nothing. */
function propertyAt(position: number): FormalProperty {
  const consequent = validateExpression('q == d');
  if (!consequent.ok) {
    throw new Error('the fixture expression was refused by the validator');
  }
  return {
    kind: 'combinational',
    id: `p${position + 1}`,
    criterionRef: `AC-${position + 1}`,
    consequent: consequent.value,
  };
}

function propertiesOfSize(size: number): readonly FormalProperty[] {
  return Array.from({ length: size }, (_unused, position) => propertyAt(position));
}

/** The `PropertyResult` the scripted oracle reports for one property. */
function resultFor(verdict: ScriptedVerdict, property: FormalProperty): PropertyResult {
  const run = { depth: SCRIPTED_DEPTH, elapsedMs: SCRIPTED_ELAPSED_MS };
  switch (verdict) {
    case 'proved':
      return {
        verdict: 'proved',
        evidence: PROVED_EVIDENCE,
        ...run,
        criterionRef: property.criterionRef,
      };
    case 'refuted':
      return {
        verdict: 'refuted',
        counterexample: COUNTEREXAMPLE,
        conditions: REFUTED_CONDITIONS,
        ...run,
        criterionRef: property.criterionRef,
      };
    case 'could-not-verify':
      return refusedWithoutProof(SCRIPTED_CAUSE, property, run, '');
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

/** One result and one rendered wrapper per submitted property, under a derived Reset_Contract. */
function scriptedOutcome(config: LoopConfig): FormalOutcome {
  const properties = propertiesOfSize(config.propertyCount);
  return {
    results: properties.map((property) => resultFor(config.verdict, property)),
    propertyWrapperSources: properties.map(
      (property) => `module formal_property_wrapper; // ${property.id}\nendmodule\n`,
    ),
    // This double resolves no artifact reference, so no property carries a trace.
    counterexampleCaptures: properties.map(() => null),
    resetContract: {
      derived: true,
      resetName: 'rst_n',
      resetActiveLow: true,
      resetKind: 'async',
      initialStateFree: true,
    },
    assertionGateEmitted: false,
    clockPolarity: 'posedge',
  };
}

function propertySetFor(config: LoopConfig): FormalPropertySet {
  return {
    properties: propertiesOfSize(config.propertyCount),
    unexpressedCriteria: [],
    propertySetAdmitted: config.setAdmitted,
  };
}

// ---------------------------------------------------------------------------
// The loop's collaborators
// ---------------------------------------------------------------------------

/** An approved single-module Spec with one simulation-verifiable acceptance criterion. */
function approvedSpec(): Spec {
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: 'byte_reg',
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    }),
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A byte register that captures d on the clock edge.',
    constraints: [],
    moduleInterface: {
      validityOutputName: null,
      moduleName: 'byte_reg',
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    },
    acceptanceCriteria: [
      { id: newUlid(), text: 'q captures d', measurable: true, method: 'simulation' },
    ],
    architecture: 'Single always block latching d into q.',
    approved: true,
    version: 1,
  };
}

function candidateFor(spec: Spec): GeneratedCandidate {
  const id = newUlid();
  const rtl = 'module byte_reg; endmodule';
  const artifactRef: ArtifactRef = { kind: 'module-version', id, version: 1 };
  return {
    rtl,
    parsedInterface: { moduleName: 'byte_reg', ports: [] },
    interfaceMatch: {
      matches: true,
      moduleNameMatches: true,
      expectedModuleName: 'byte_reg',
      actualModuleName: 'byte_reg',
      missingPorts: [],
      extraPorts: [],
      mismatchedPorts: [],
    },
    moduleVersion: {
      id,
      projectId: spec.projectId,
      specVersion: spec.version,
      rtl,
      createdAt: new Date(0).toISOString(),
    },
    label: unverified(artifactRef),
  };
}

function testbenchFor(spec: Spec): Testbench {
  return {
    id: spec.id,
    specId: spec.id,
    specVersion: spec.version,
    source: `module byte_reg_tb;\n  initial $display("CHECK ${CHECK_NAME} PASS");\nendmodule\n`,
    sourceAttribution: 'spec',
    coversCriteria: spec.acceptanceCriteria.map((criterion) => criterion.id),
  };
}

function confirmedContext(spec: Spec): ConfirmedGenerationContext {
  return {
    sessionId: newUlid(),
    projectId: spec.projectId,
    confirmedIntent: { summary: 'A byte register.', constraints: [], assumptions: [] },
    approvedSpec: spec,
  } as unknown as ConfirmedGenerationContext;
}

/** A gate opener that always admits, so no case terminates before the admission step. */
class AdmittingGate implements GenerationContextOpener {
  readonly #context: ConfirmedGenerationContext;

  constructor(context: ConfirmedGenerationContext) {
    this.#context = context;
  }

  openGenerationContext(): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>> {
    return Promise.resolve(ok(this.#context));
  }
}

/**
 * One candidate, and no revision ever.
 *
 * The refusal to revise is what BOUNDS a failing-simulation case: the run ends on its first
 * iteration instead of looping against a budget this fixture would rather not depend on.
 */
class OneCandidateGenerator implements CandidateGenerator {
  readonly #candidate: GeneratedCandidate;

  constructor(spec: Spec) {
    this.#candidate = candidateFor(spec);
  }

  generateCandidate(): Promise<Result<CandidateEval, CandidateFailure>> {
    return Promise.resolve(ok({ candidate: this.#candidate, interfaceDiagnostics: '' }));
  }

  reviseFromErrors(): Promise<Result<CandidateEval, CandidateFailure>> {
    return Promise.resolve(
      err({ reason: 'model-unavailable', detail: 'this double never revises' }),
    );
  }
}

/** A Testbench_Agent double that produces one Testbench and never repairs it. */
class OneTestbench implements IndependentTestbenchGenerator {
  readonly #spec: Spec;

  constructor(spec: Spec) {
    this.#spec = spec;
  }

  generateTestbench(): Promise<TestbenchGenerationOutcome> {
    return Promise.resolve({
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench: testbenchFor(this.#spec),
      checks: [],
    });
  }

  repairTestbench(): Promise<TestbenchGenerationOutcome> {
    return Promise.resolve({
      status: 'generation-failed',
      failure: { reason: 'model-call-failed', detail: 'this double never repairs' },
    });
  }
}

/** An admission port that logs when it was consulted, then answers as configured. */
class RecordingAdmission implements InstrumentAdmission {
  readonly #log: CallName[];
  readonly #decision: InstrumentAdmissionDecision;

  constructor(log: CallName[], decision: InstrumentAdmissionDecision) {
    this.#log = log;
    this.#decision = decision;
  }

  admit(): Promise<InstrumentAdmissionDecision> {
    this.#log.push('instrument-admission');
    return Promise.resolve(this.#decision);
  }
}

/**
 * A Formal_Oracle port that logs every submission, then answers with the scripted outcome.
 *
 * It must ANSWER rather than reject, unlike the single-example ordering test's recorder: the
 * identity claim reads a terminal verdict, a trust label and a route off the loop, and a rejecting
 * oracle never lets one be reached.
 */
class RecordingOracle implements FormalOraclePort {
  readonly #log: CallName[];
  readonly #outcome: FormalOutcome;

  constructor(log: CallName[], outcome: FormalOutcome) {
    this.#log = log;
    this.#outcome = outcome;
  }

  proveSet(): Promise<FormalOutcome> {
    this.#log.push('formal-oracle');
    return Promise.resolve(this.#outcome);
  }

  /**
   * The per-property window, routed THROUGH `proveSet` so a `prove` call is logged as the
   * submission it is. Neither method reads its request: the scripted answer is fixed per case.
   */
  async prove(): Promise<PropertyResult> {
    const outcome = await this.proveSet();
    const [result] = outcome.results;
    if (result === undefined) {
      throw new Error('the scripted oracle holds no result for this property');
    }
    return result;
  }
}

/** A Property_Set source returning one fixed set, already past any admission gate. */
class FixedPropertySet implements PropertySetSource {
  readonly #set: FormalPropertySet;

  constructor(set: FormalPropertySet) {
    this.#set = set;
  }

  propertySetFor(): Promise<FormalPropertySet> {
    return Promise.resolve(this.#set);
  }
}

/** A raw capture whose testbench reported its one check with the given result. */
function checkCapture(result: 'PASS' | 'FAIL'): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: `CHECK ${CHECK_NAME} ${result}\n`,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: { wallMs: 12, maxMemMb: 8, cpuMs: 10 },
  };
}

/** Whether a sandbox job is the Testbench_Precheck's own build check, not an iteration. */
function isPrecheckJob(job: SandboxJob): boolean {
  return job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH);
}

/** A budget bounded well above what any case here spends, so no cap decides an outcome. */
function boundedBudget(): InMemorySessionBudgetHandle {
  return new InMemorySessionBudgetHandle({
    sessionId: newUlid(),
    maxIterations: 4,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
}

// ---------------------------------------------------------------------------
// One case, run through the real loop
// ---------------------------------------------------------------------------

/** The three outcomes Requirement 10.3 and 10.6 forbid this spec from moving. */
interface StudentOutcomes {
  readonly status: VerificationOutcome['status'];
  /** The trust label's tier: the field a student is actually shown. */
  readonly trustTier: string;
  readonly fallbackRoute: FallbackRoute;
  /** Every submitted property's Formal_Verdict, in submission order. */
  readonly verdicts: readonly string[];
}

/** What one case observed: the order its two logged ports were reached in, and the outcomes. */
interface Observation {
  readonly order: readonly CallName[];
  readonly outcomes: StudentOutcomes;
}

/**
 * Project the three protected outcomes off a terminal outcome.
 *
 * `blocked` and `setup-failed` carry no label and no formal record, so they are a BROKEN FIXTURE
 * here rather than a case to project: this file's gate always admits and its first generation
 * always succeeds, so neither is reachable, and throwing names the fixture defect instead of
 * comparing two absent values and calling them identical.
 */
function outcomesOf(outcome: VerificationOutcome): StudentOutcomes {
  if (outcome.status === 'blocked' || outcome.status === 'setup-failed') {
    throw new Error(`this fixture must reach a labelled outcome, not "${outcome.status}"`);
  }
  return {
    status: outcome.status,
    trustTier: outcome.label.tier,
    fallbackRoute: outcome.formal.fallbackRoute,
    verdicts: outcome.formal.results.map((result) => result.verdict),
  };
}

/** Drive one real loop and read back the observed call order and the protected outcomes. */
async function observe(config: LoopConfig): Promise<Observation> {
  const spec = approvedSpec();
  const log: CallName[] = [];
  const iteration = checkCapture(config.simulation === 'passes' ? 'PASS' : 'FAIL');
  const runtime = new FakeSandboxRuntime((job: SandboxJob) =>
    isPrecheckJob(job) ? checkCapture('PASS') : iteration,
  );
  const loop = new VerificationLoop({
    gate: new AdmittingGate(confirmedContext(spec)),
    generator: new OneCandidateGenerator(spec),
    testbench: new OneTestbench(spec),
    simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(runtime)),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    trustLabeler: oracleTrustLabeler,
    instrumentAdmission: new RecordingAdmission(log, config.admission),
    formal: {
      oracle: new RecordingOracle(log, scriptedOutcome(config)),
      properties: new FixedPropertySet(propertySetFor(config)),
    },
  });
  const outcome = await loop.verify(REQUEST, boundedBudget(), LIMITS);
  return { order: log, outcomes: outcomesOf(outcome) };
}

/**
 * Assert the ordering claim over one observed log.
 *
 * Stated in the direction the requirement states it: a submission may never PRECEDE a
 * consultation. A case that never reached the oracle satisfies that, which is why the caller
 * counts both populations rather than guarding on one.
 */
function expectNoSubmissionBeforeAdmission(order: readonly CallName[], where: string): void {
  const firstSubmission = order.indexOf('formal-oracle');
  if (firstSubmission === -1) {
    return;
  }
  const consultation = order.indexOf('instrument-admission');
  expect(consultation, `${where}: the oracle was reached with no admission step at all`).not.toBe(
    -1,
  );
  expect(
    consultation,
    `${where}: a Formal_Oracle submission preceded the Instrument_Admission consultation`,
  ).toBeLessThan(firstSubmission);
}

// ---------------------------------------------------------------------------
// The Student_Path import graph
// ---------------------------------------------------------------------------

/**
 * The packages that decide a Formal_Verdict, a trust label, and a Fallback_Route.
 *
 * `knowledge` is included because `agent` imports it, so a closure claim that omitted it would
 * leave a reachable package unscanned.
 */
const STUDENT_PATH_PACKAGES: readonly string[] = Object.freeze([
  'core',
  'knowledge',
  'tools',
  'agent',
]);

/** The repository root: this file sits at `app/test/`, two levels below it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every non-test TypeScript source file under one directory, `dist` and generated types aside. */
function sourceFilesUnder(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'dist' && entry.name !== 'node_modules') {
        found.push(...sourceFilesUnder(full));
      }
      continue;
    }
    const isSource = entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts');
    if (isSource && !/\.(?:test|spec)\.ts$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** One import edge that leaves the scanned package set. */
interface Offender {
  readonly file: string;
  readonly specifier: string;
}

/**
 * Every import edge out of `packages` that does not land back inside `packages`.
 *
 * Specifiers come from the real TypeScript scanner rather than a regex: `@app/eval` is named in a
 * dozen comments inside these packages, and a regex would report every one as an edge. A bare
 * specifier that is not `@app/...` is an npm dependency or a node builtin, neither of which is a
 * module in this repository, so neither can be the Property_Only_Mode.
 */
function importsLeaving(packages: readonly string[]): readonly Offender[] {
  const roots = packages.map((name) => join(REPO_ROOT, 'app', name));
  const inside = (path: string): boolean =>
    roots.some((root) => path === root || path.startsWith(root + sep));
  const offenders: Offender[] = [];
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const text = ts.sys.readFile(file) ?? '';
      for (const reference of ts.preProcessFile(text, true, true).importedFiles) {
        const specifier = reference.fileName;
        const landing = specifier.startsWith('@app/')
          ? join(REPO_ROOT, 'app', specifier.slice('@app/'.length))
          : specifier.startsWith('.')
            ? resolve(dirname(file), specifier)
            : null;
        if (landing !== null && !inside(landing)) {
          offenders.push({ file: file.slice(REPO_ROOT.length + 1), specifier });
        }
      }
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe(PROPERTY_32, () => {
  it(
    'submits nothing to the Formal_Oracle before the Instrument_Admission consultation',
    async () => {
      let reachedOracle = 0;
      let stoppedShort = 0;

      await fc.assert(
        fc.asyncProperty(arbLoopConfig, async (config) => {
          const { order } = await observe(config);
          if (order.includes('formal-oracle')) {
            reachedOracle += 1;
          } else {
            stoppedShort += 1;
          }
          expectNoSubmissionBeforeAdmission(order, JSON.stringify(config));

          // Consulted AT MOST ONCE per sample, which Req 4.12 also requires: a second
          // consultation after a submission would satisfy the ordering claim above and still
          // break the Student_Path's own contract.
          expect(
            order.filter((name) => name === 'instrument-admission').length,
          ).toBeLessThanOrEqual(1);
        }),
        propertyParameters(),
      );

      // NON-VACUITY AS AN ASSERTION. An ordering claim over a population that never reached the
      // second event is worth nothing, and a population that ALWAYS reached it would mean the
      // generator never produced a case the ordering actually protects.
      expect(reachedOracle, 'no generated configuration reached the Formal_Oracle').toBeGreaterThan(
        0,
      );
      expect(stoppedShort, 'no generated configuration stopped before the oracle').toBeGreaterThan(
        0,
      );
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  it(
    'yields the same verdict, trust label and Fallback_Route with the Property_Only_Mode loaded and not loaded',
    async () => {
      const baseline: { readonly config: string; readonly outcomes: StudentOutcomes }[] = [];

      // PASS ONE, the mode ABSENT. Nothing this file imports statically reaches `@app/eval`, which
      // is the claim the import-graph test below computes, so this really is an unloaded baseline.
      await fc.assert(
        fc.asyncProperty(arbLoopConfig, async (config) => {
          const { order, outcomes } = await observe(config);
          expectNoSubmissionBeforeAdmission(order, JSON.stringify(config));
          baseline.push({ config: JSON.stringify(config), outcomes });
        }),
        propertyParameters({ seed: IDENTITY_SEED }),
      );
      expect(baseline.length).toBe(DEFAULT_NUM_RUNS);

      // The Property_Only_Mode, loaded into this process. A deep import is not available - the
      // package exports its root alone - so the whole eval surface arrives, which only widens what
      // an import-time side effect could have come from.
      const evalSurface: Record<string, unknown> = await import('@app/eval');
      expect(
        typeof evalSurface.parsePropertyOnlyConfig,
        'the Property_Only_Mode was not actually loaded, so this pass proves nothing',
      ).toBe('function');

      // PASS TWO, the mode PRESENT, same seed and same run count.
      let index = 0;
      await fc.assert(
        fc.asyncProperty(arbLoopConfig, async (config) => {
          const recorded = baseline[index];
          index += 1;
          // The replay is ASSERTED, not assumed: a generator that stopped replaying the same cases
          // would otherwise be read as an identity failure.
          expect(recorded?.config, 'the two passes generated different cases').toBe(
            JSON.stringify(config),
          );

          const { order, outcomes } = await observe(config);
          expectNoSubmissionBeforeAdmission(order, JSON.stringify(config));
          expect(outcomes).toEqual(recorded?.outcomes);
        }),
        // `endOnFailure` BECAUSE THE TWO PASSES ARE INDEX-ALIGNED. Shrinking re-generates values,
        // so a real outcome difference would otherwise be re-reported as the replay mismatch it
        // causes, sending a reader after fast-check's determinism instead of after the
        // non-interference break. Measured: a deliberately mutated trust label reported "the two
        // passes generated different cases" until this was set.
        propertyParameters({ seed: IDENTITY_SEED, endOnFailure: true }),
      );
      expect(index, 'the second pass ran a different number of cases').toBe(baseline.length);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  it('reaches no module under app/eval from the Student_Path packages', () => {
    // The closure claim: these four packages import only each other, node builtins, and npm
    // dependencies. Nothing under `app/eval` is therefore reachable from the code that decides a
    // verdict, a trust label, or a route - the Property_Only_Mode included.
    expect(importsLeaving(STUDENT_PATH_PACKAGES)).toEqual([]);

    // THE SCANNER'S OWN SELF-CHECK, so the assertion above cannot pass by seeing nothing. Narrowed
    // to `agent` alone, the same scan must report the real edges into `core`, `tools` and
    // `knowledge` that the four-package set absorbs. A scanner that read no imports at all, or one
    // a comment-stripping bug had blinded, passes the claim above and fails here.
    const narrowed = importsLeaving(['agent']);
    expect(new Set(narrowed.map((offender) => offender.specifier))).toEqual(
      new Set(['@app/core', '@app/tools', '@app/knowledge']),
    );
  });
});
