// formal-elapsed-time-undercharge, Property 1: A formal run is charged the whole wall clock it
// spent (task 1). Property 2, Preservation (task 2), is the block at the end of this file.
//
// WHAT IS CLAIMED, AND OVER WHAT
//   Four cases, two heights. Cases A and C drive the REAL `YosysSmtBmcFormalOracle.proveSet` under
//   the real `SandboxToolRunner` over a `FakeSandboxRuntime`, on a job-advanced `ManualClock` that
//   only a scripted sandbox job moves - the harness `formal-verdict-independence.property.test.ts`
//   and `formal-depth-ladder.property.test.ts` already use, reused here rather than re-declared.
//   Case B drives the same script through the REAL `VerificationLoop`, with the real adapter as its
//   `FormalOraclePort`, the loop's own `now` and the adapter's `now` both the SAME `ManualClock`, into
//   a fresh `MeteredSessionBudget`. Case D is the one port double in this file: a throwing
//   `FormalOraclePort`, because the throw path is by definition a port that reports nothing, and only
//   the loop's own measurement around that call is under test there. No oracle double appears on the
//   admitted path (A, B, C), which is the gap design.md's Hypothesized Root Cause names as the reason
//   this bug stayed hidden: a scripted oracle double reports its own elapsed time, so the adapter's
//   measurement defect never reaches a budget test driven that way.
//
// WHY THIS TEST MUST FAIL ON UNFIXED CODE
//   This is the EXPLORATION test, run before the fix (bugfix workflow, task 1). Design.md's bug
//   condition predicts: Case A and B report 1,000 ms where the clock advanced 8,000 ms (every ladder
//   rung but the last is dropped, and the shared pre-pass is deducted from every window but recorded
//   on no result); Case C shrinks fast-check's counterexample to a multi-rung ladder or a nonzero
//   pre-pass; Case D reports 0 ms where the loop's own clock measured 3,000 ms around the throwing
//   call. A PASS here would mean the bug is already fixed, or the harness is not reaching the adapter
//   it claims to.
//
// Validates: Requirements 1.1-1.8, 2.1-2.8 (bugfix.md); Property 1 (design.md).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeSessionBudget,
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type ModuleInterface,
  type Result,
  type SessionBudget,
  type Spec,
  type Testbench,
} from '@app/core';
import {
  ConfirmedGenerationContext,
  InMemoryTracePersistence,
  TraceActionRecorder,
  VerificationLoop,
  type CandidateEval,
  type CandidateFailure,
  type CandidateGenerator,
  type FormalGate,
  type FormalPropertySet,
  type GeneratedCandidate,
  type GenerateTestbenchRequest,
  type GenerationAdmissionRequest,
  type GenerationContextOpener,
  type GenerationGateRefusal,
  type GenerationInput,
  type IndependentTestbenchGenerator,
  type PropertySetSource,
  type RepairTestbenchRequest,
  type SessionBudgetHandle,
  type TestbenchGenerationOutcome,
} from '@app/agent';
import { MeteredSessionBudget } from '@app/eval';
import {
  COUNTEREXAMPLE_ARTIFACT_KEY,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  renderPropertyWrapper,
  SandboxToolRunner,
  validateExpression,
  YosysSmtBmcFormalOracle,
  type ArtifactBlobRef,
  type FormalArtifactReader,
  type FormalCheckReport,
  type FormalChecksReport,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalPrepassDocument,
  type FormalProperty,
  type FormalReport,
  type FormalResourceCaps,
  type PropertyResult,
  type RawRunCapture,
  type RequiredOutput,
  type ResetContract,
  type SandboxJob,
  type SourceFile,
} from '@app/tools';

import { propertyParameters } from './property.js';
import { timingContractFor } from '@app/test';

const PROPERTY_1 =
  'formal-elapsed-time-undercharge, Property 1: A formal run is charged the whole wall clock it spent';

/** Headroom for a fast-check property driving a real adapter and loop; nothing depends on it. */
const SLOW_PROPERTY_TIMEOUT_MS = 30_000;

/** The four caps every job carries. Not under test here; any valid set serves. */
const CAPS: FormalResourceCaps = Object.freeze({ cpu: 1, memMb: 512, procs: 64, diskMb: 64 });

/** The production Property_Time_Budget, so a generated multi-property run can genuinely spend it. */
const BUDGET_MS = DEFAULT_PROPERTY_TIME_BUDGET_MS;

/** The largest generated Property_Set in Case C. */
const MAX_SET_SIZE = 4;

/** The candidate design every case submits. Nothing reads its text. */
const DESIGN: SourceFile = Object.freeze({
  path: 'design.v',
  contents: 'module design(input clk, input rst_n, output reg [3:0] out); endmodule\n',
});

// ---------------------------------------------------------------------------
// The job-advanced clock, matching the sibling property files' own `ManualClock`
// ---------------------------------------------------------------------------

/** A clock the test owns. It moves only when a scripted run says time passed, so nothing waits. */
class ManualClock {
  #nowMs = 0;

  /** The adapter's (and, in Case B/D, the loop's) injected `now`. An arrow property. */
  readonly now = (): number => this.#nowMs;

  advance(ms: number): void {
    this.#nowMs += ms;
  }
}

/** A `FormalArtifactReader` resolving refs by content, matching the sibling harnesses. */
class ContentAddressedArtifacts implements FormalArtifactReader {
  readonly #texts = new Map<string, string>();
  #nextId = 0;

  register(text: string): ArtifactBlobRef {
    this.#nextId += 1;
    const sha256 = this.#nextId.toString(16).padStart(64, '0');
    this.#texts.set(sha256, text);
    return { name: `artifact-${this.#nextId}`, sizeBytes: Buffer.byteLength(text, 'utf8'), sha256 };
  }

  readText(artifact: ArtifactBlobRef): Promise<string | null> {
    return Promise.resolve(this.#texts.get(artifact.sha256) ?? null);
  }
}

// ---------------------------------------------------------------------------
// The documents a scripted job registers
// ---------------------------------------------------------------------------

const PASSED_CHECK: FormalCheckReport = Object.freeze({
  exitCode: 0,
  status: 'PASSED',
  elapsedMs: 1,
});
const FAILED_CHECK: FormalCheckReport = Object.freeze({
  exitCode: 1,
  status: 'FAILED',
  elapsedMs: 1,
});

/** A cover reached at step 13, `counter_12`'s measured honest first-reachable step. */
const REACHED_COVER: FormalCheckReport = Object.freeze({
  ...PASSED_CHECK,
  reachedStep: 13,
  coverAnswered: true,
});

/** A cover that ANSWERED and was not reached: the one outcome escalation watches for. */
const UNREACHED_COVER: FormalCheckReport = Object.freeze({
  ...FAILED_CHECK,
  exitCode: 0,
  coverAnswered: true,
});

/** Temporal induction reported successful: the fifth condition satisfied. */
const INDUCTION_PROVED: FormalCheckReport = Object.freeze({
  ...PASSED_CHECK,
  inductionSuccessful: true,
});

/** A completed lowering with a non-zero count, carrying the given three checks. */
function formalReport(checks: Omit<FormalChecksReport, 'presat'>): FormalReport {
  return {
    lowering: { exitCode: 0, stderrTail: '' },
    assertionCount: 2,
    checks: { presat: PASSED_CHECK, ...checks },
  };
}

/** All five conditions hold: `proved` for any property, at any depth it is served at. */
const PROVING_REPORT = formalReport({
  base: PASSED_CHECK,
  cover: REACHED_COVER,
  induct: INDUCTION_PROVED,
});

/** An unreached antecedent: escalates a property that has one. */
const ESCALATING_REPORT = formalReport({
  base: PASSED_CHECK,
  cover: UNREACHED_COVER,
  induct: INDUCTION_PROVED,
});

/** The pre-pass document the worker would write for a synchronous reset over a free initial state. */
const PREPASS_DOCUMENT: FormalPrepassDocument = Object.freeze({
  reset: {
    derived: true as const,
    resetName: 'rst_n',
    resetActiveLow: true,
    resetKind: 'sync' as const,
  },
  clockPolarity: 'posedge' as const,
  initialStatePredicate: 'true',
  // Required on the wire, and this fixture is about the elapsed-time charge rather than timing.
  timing: { derived: true as const, ports: [] },
});

const PREPASS_REPORT_KEY = 'formalPrepassReport' satisfies RequiredOutput;
const FORMAL_REPORT_KEY = 'formalReport' satisfies RequiredOutput;

/** One run's registered artifacts for the pre-pass. */
function prepassArtifacts(store: ContentAddressedArtifacts): Record<string, ArtifactBlobRef> {
  return { [PREPASS_REPORT_KEY]: store.register(JSON.stringify(PREPASS_DOCUMENT)) };
}

/** One run's registered artifacts for a `formal` rung's report. */
function reportArtifacts(
  report: FormalReport,
  store: ContentAddressedArtifacts,
): Record<string, ArtifactBlobRef> {
  return { [FORMAL_REPORT_KEY]: store.register(JSON.stringify(report)) };
}

// ---------------------------------------------------------------------------
// Case A / Case C: the adapter-level harness, no oracle double
// ---------------------------------------------------------------------------

/** What one scripted job takes and leaves behind, resolved by `kind` and submission order. */
interface ScriptedJobRun {
  readonly elapsedMs: number;
  readonly artifacts: Record<string, ArtifactBlobRef>;
}

/** A scripted job, given the one store the oracle reads, so its registered blobs resolve. */
type RunScript = (job: SandboxJob, store: ContentAddressedArtifacts) => ScriptedJobRun;

/** A `RawRunCapture` for a run that completed inside its cap and registered `artifacts`. */
function capturedRun(run: ScriptedJobRun): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: run.artifacts,
    deniedOperations: [],
    resourceUsage: { wallMs: run.elapsedMs, maxMemMb: 1, cpuMs: run.elapsedMs },
  };
}

/** Wire the real adapter over a scripted runtime driven by `script`, on a fresh `ManualClock`. */
function adapterHarness(script: RunScript): {
  readonly oracle: YosysSmtBmcFormalOracle;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const store = new ContentAddressedArtifacts();
  const runner = new SandboxToolRunner(
    new FakeSandboxRuntime((job) => {
      const run = script(job, store);
      clock.advance(run.elapsedMs);
      return capturedRun(run);
    }),
  );
  const oracle = new YosysSmtBmcFormalOracle({
    toolRunner: runner,
    artifacts: store,
    caps: CAPS,
    now: clock.now,
  });
  return { oracle, clock };
}

/** One validated combinational property, so a single-rung ladder needs no antecedent. */
function combinationalProperty(criterionRef: string): FormalProperty {
  const consequent = validateExpression('out == 11');
  if (!consequent.ok) {
    throw new Error('fixture expression was rejected by the validator');
  }
  return {
    kind: 'combinational',
    id: `p-${criterionRef}`,
    criterionRef,
    consequent: consequent.value,
  };
}

/** A clocked property WITH an antecedent, so a ladder can actually escalate past its first rung. */
function clockedProperty(criterionRef: string): FormalProperty {
  const clock = validateExpression('clk');
  const antecedent = validateExpression('out == 11');
  const consequent = validateExpression('out <= 11');
  if (!clock.ok || !antecedent.ok || !consequent.ok) {
    throw new Error('fixture expression was rejected by the validator');
  }
  return {
    kind: 'clocked',
    id: `p-${criterionRef}`,
    criterionRef,
    clock: clock.value,
    antecedent: antecedent.value,
    consequent: consequent.value,
  };
}

/** A design interface with a clock, so a clocked property's ladder (3 rungs) can run. */
const CLOCKED_DESIGN_INTERFACE: ModuleInterface = Object.freeze({
  moduleName: 'design',
  ports: [{ name: 'out', direction: 'output' as const, width: 4 }],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
});

describe(PROPERTY_1, () => {
  // Case A: the measured probe, adapter level - design.md's "Examples" first row.
  it('Case A (adapter level): the measured probe is charged 8,000 ms, not 1,000 ms', async () => {
    let rung = 0;
    const { oracle, clock } = adapterHarness((job, store) => {
      if (job.kind === 'formalPrepass') {
        return { elapsedMs: 5_000, artifacts: prepassArtifacts(store) };
      }
      // Rungs 20 and 40 report antecedent-unreached at 1,000 ms each; rung 80 proves at 1,000 ms.
      const answer = rung < 2 ? ESCALATING_REPORT : PROVING_REPORT;
      rung += 1;
      return { elapsedMs: 1_000, artifacts: reportArtifacts(answer, store) };
    });

    const property = clockedProperty('ac-1');
    const outcome = await oracle.proveSet({
      designSource: DESIGN,
      designInterface: CLOCKED_DESIGN_INTERFACE,
      properties: [property],
      budgetMs: BUDGET_MS,
    });

    // UNFIXED: records 1,000 (the deciding rung's own time) where the clock advanced 8,000.
    // FIXED: records 8,000 (the pre-pass plus every rung of the property's one ladder).
    expect(clock.now()).toBe(8_000);
    expect(outcome.results[0]?.elapsedMs).toBe(8_000);
  });

  // Case B: the measured probe, loop level - the real VerificationLoop, the real adapter as its
  // formal oracle, one shared ManualClock, into a fresh MeteredSessionBudget.
  it(
    'Case B (loop level): the measured probe charges 8,000 formal ms to the Session_Budget and span',
    async () => {
      const clock = new ManualClock();
      const store = new ContentAddressedArtifacts();
      let rung = 0;
      const runner = new SandboxToolRunner(
        new FakeSandboxRuntime((job) => {
          const run: ScriptedJobRun =
            job.kind === 'formalPrepass'
              ? { elapsedMs: 5_000, artifacts: prepassArtifacts(store) }
              : (() => {
                  const answer = rung < 2 ? ESCALATING_REPORT : PROVING_REPORT;
                  rung += 1;
                  return { elapsedMs: 1_000, artifacts: reportArtifacts(answer, store) };
                })();
          clock.advance(run.elapsedMs);
          return capturedRun(run);
        }),
      );
      const oracle = new YosysSmtBmcFormalOracle({
        toolRunner: runner,
        artifacts: store,
        caps: CAPS,
        now: clock.now,
      });

      const spec = formalSpec();
      const context = confirmedContext(spec);
      const property = clockedProperty('ac-1');
      const gate: FormalGate = {
        oracle,
        properties: new ScriptedPropertySet({
          properties: [property],
          unexpressedCriteria: [],
          propertySetAdmitted: 'not-gated',
        }),
      };
      const { loop, recorder } = makeLoop(spec, context, gate, clock.now);
      const ledger = new ChargeLedger(freshMeteredBudget());

      const outcome = await loop.verify(REQUEST, ledger, LIMITS);

      expect(outcome.status).toBe('verified');
      if (outcome.status !== 'verified') return;
      // The fixtures' model calls charge tokens; every zero-token charge must be a formal one.
      const formalCharges = ledger.charges().filter((charge) => charge.tokens === 0);
      expect(formalCharges).toHaveLength(outcome.formal.results.length);
      // UNFIXED: the formal share of consumed wall clock, and the span's duration, are 1,000.
      // FIXED: both are 8,000, and the span starts at the run's own start.
      expect(formalCharges.reduce((sum, charge) => sum + charge.wallClockMs, 0)).toBe(8_000);
      expect(outcome.formal.results[0]?.elapsedMs).toBe(8_000);

      const trace = await recorder.getTrace(context.sessionId);
      const formalSpan = trace.spans.find((span) => span.stageOrTool === 'Formal_Oracle');
      expect(formalSpan?.durationMs).toBe(8_000);
      expect(formalSpan?.startedAt).toBe(new Date(0).toISOString());
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  // Case C: a generated Property_Set, adapter level - filtered to isBugCondition from design.md.
  it(
    'Case C (generated property): every buggy run sums its results to the clock advance',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: MAX_SET_SIZE }),
          fc.integer({ min: 0, max: 20_000 }),
          async (size, prepassMs) => {
            // Each property gets its own ladder: a list of per-rung millisecond costs, ending on
            // either a proof (short ladder) or an exhausted/escalating ladder (longer).
            const ladders: readonly number[][] = Array.from({ length: size }, (_, index) =>
              index % 2 === 0 ? [1_000] : [1_000, 1_000, 1_000],
            );
            const properties = ladders.map((_, index) => clockedProperty(`ac-${index}`));

            const isBugCondition = prepassMs > 0 || ladders.some((ladder) => ladder.length > 1);
            if (!isBugCondition) {
              return;
            }

            const rungIndexByProperty: number[] = ladders.map(() => 0);
            let currentProperty = 0;
            const { oracle, clock } = adapterHarness((job, store) => {
              if (job.kind === 'formalPrepass') {
                return { elapsedMs: prepassMs, artifacts: prepassArtifacts(store) };
              }
              const ladder = ladders[currentProperty] ?? [1_000];
              const rungIndex = rungIndexByProperty[currentProperty] ?? 0;
              const isLastRung = rungIndex === ladder.length - 1;
              const answer = isLastRung ? PROVING_REPORT : ESCALATING_REPORT;
              const elapsedMs = ladder[rungIndex] ?? 1_000;
              rungIndexByProperty[currentProperty] = rungIndex + 1;
              if (isLastRung) {
                currentProperty += 1;
              }
              return { elapsedMs, artifacts: reportArtifacts(answer, store) };
            });

            const outcome = await oracle.proveSet({
              designSource: DESIGN,
              designInterface: CLOCKED_DESIGN_INTERFACE,
              properties,
              budgetMs: BUDGET_MS,
            });

            const totalClockMs = clock.now();
            const totalResultsMs = outcome.results.reduce((sum, r) => sum + r.elapsedMs, 0);
            // UNFIXED: the sum is short by every dropped rung and by the pre-pass.
            // FIXED: the results tile the run, so the sum equals the clock's advance.
            expect(totalResultsMs).toBe(totalClockMs);

            const firstLadderMs = (ladders[0] ?? [1_000]).reduce((sum, ms) => sum + ms, 0);
            expect(outcome.results[0]?.elapsedMs).toBe(prepassMs + firstLadderMs);
            for (let i = 1; i < ladders.length; i += 1) {
              const ladderMs = (ladders[i] ?? [1_000]).reduce((sum, ms) => sum + ms, 0);
              expect(outcome.results[i]?.elapsedMs).toBe(ladderMs);
            }
          },
        ),
        propertyParameters({ numRuns: 100 }),
      );
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  // Case D: a throwing port at the loop level - the loop's OWN clock measures the call.
  it('Case D (throwing port, loop level): the throw is charged 3,000 ms, not 0 ms', async () => {
    const clock = new ManualClock();
    const spec = formalSpec();
    const context = confirmedContext(spec);
    const properties = [combinationalProperty('ac-1'), combinationalProperty('ac-2')];
    const gate: FormalGate = {
      oracle: new ClockAdvancingThrowingOracle(clock, 3_000),
      properties: new ScriptedPropertySet({
        properties,
        unexpressedCriteria: [],
        propertySetAdmitted: 'not-gated',
      }),
    };
    const { loop } = makeLoop(spec, context, gate, clock.now);
    const budget = freshMeteredBudget();

    const outcome = await loop.verify(REQUEST, budget, LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    // UNFIXED: the loop synthesizes elapsedMs: 0 for every result, so the throw is charged nothing.
    // FIXED: the first synthesized result carries the loop's own measured 3,000 ms, the rest 0.
    expect(outcome.formal.results.map((result) => result.elapsedMs)).toEqual([3_000, 0]);
    expect(budget.consumed().iterations).toBeGreaterThanOrEqual(2);
    expect(budget.consumed().wallClockMs).toBeGreaterThanOrEqual(3_000);
    expect(outcome.formal.fallbackReason).toBe('toolchain-unavailable');
  });
});

// ---------------------------------------------------------------------------
// Case B / D's loop-level fixtures: the minimum needed to reach a `verified` outcome from the
// simulation path once the formal gate has decided or fallen back.
// ---------------------------------------------------------------------------

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 } as const;
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/** An approved single-module Spec with one simulation-verifiable acceptance criterion. */
function formalSpec(): Spec {
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

/** A confirmed generation context standing in for a successful gate admission. */
function confirmedContext(spec: Spec): ConfirmedGenerationContext {
  return {
    sessionId: newUlid(),
    projectId: spec.projectId,
    confirmedIntent: { summary: 'A byte register.', constraints: [], assumptions: [] },
    approvedSpec: spec,
  } as unknown as ConfirmedGenerationContext;
}

/** A gate opener that always admits with the given context. */
class AdmittingGate implements GenerationContextOpener {
  readonly #context: ConfirmedGenerationContext;
  constructor(context: ConfirmedGenerationContext) {
    this.#context = context;
  }
  openGenerationContext(): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>> {
    return Promise.resolve(ok(this.#context));
  }
}

/** A minimal generated candidate whose label carries a fresh module-version ref. */
function candidateFor(spec: Spec): GeneratedCandidate {
  const id = newUlid();
  const rtl = `module ${spec.moduleInterface.moduleName}; endmodule`;
  const artifactRef: ArtifactRef = { kind: 'module-version', id, version: 1 };
  return {
    rtl,
    parsedInterface: { moduleName: spec.moduleInterface.moduleName, ports: [] },
    interfaceMatch: {
      matches: true,
      moduleNameMatches: true,
      expectedModuleName: spec.moduleInterface.moduleName,
      actualModuleName: spec.moduleInterface.moduleName,
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

/** A one-shot generator: one candidate, no revision scripted (the formal gate decides first). */
class OneShotGenerator implements CandidateGenerator {
  readonly #candidate: GeneratedCandidate;
  constructor(candidate: GeneratedCandidate) {
    this.#candidate = candidate;
  }
  generateCandidate(
    _input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(ok({ candidate: this.#candidate, interfaceDiagnostics: '' }));
  }
  reviseFromErrors(
    _input: GenerationInput,
    _previousRtl: string,
    _diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      ok: false,
      error: { reason: 'model-unavailable', detail: 'this fixture scripts no revision' },
    });
  }
}

/** A testbench port returning one produced Testbench; never repairs. */
class FixedTestbench implements IndependentTestbenchGenerator {
  readonly #outcome: TestbenchGenerationOutcome;
  constructor(testbench: Testbench) {
    this.#outcome = { status: 'generated', checkingApproach: 'cycle-timed', testbench, checks: [] };
  }
  generateTestbench(
    _request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#outcome);
  }
  repairTestbench(
    _request: RepairTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generation-failed',
      failure: { reason: 'model-call-failed', detail: 'FixedTestbench never repairs' },
    });
  }
}

/** A produced Testbench derived from the Spec, attributed to the Spec version. */
function testbenchFor(spec: Spec): Testbench {
  return {
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source: `module ${spec.moduleInterface.moduleName}_tb; endmodule`,
    sourceAttribution: 'spec',
    coversCriteria: spec.acceptanceCriteria.map((c) => c.id),
  };
}

/** A property-set source returning one fixed scripted set, charging no budget of its own. */
class ScriptedPropertySet implements PropertySetSource {
  readonly #set: FormalPropertySet;
  constructor(set: FormalPropertySet) {
    this.#set = set;
  }
  propertySetFor(): Promise<FormalPropertySet> {
    return Promise.resolve(this.#set);
  }
}

/**
 * Case D's port double: advances the LOOP's own `ManualClock` by `afterMs` and then throws.
 *
 * The throw path is by definition a port that reports nothing, so the loop's own measurement
 * around the `proveSet` call is what this case is about; the double's only job is to make that
 * call take real (clock) time before it rejects.
 */
class ClockAdvancingThrowingOracle implements FormalOraclePort {
  readonly #clock: ManualClock;
  readonly #afterMs: number;
  constructor(clock: ManualClock, afterMs: number) {
    this.#clock = clock;
    this.#afterMs = afterMs;
  }
  proveSet(): Promise<FormalOutcome> {
    this.#clock.advance(this.#afterMs);
    return Promise.reject(new Error('the formal oracle is unavailable'));
  }
  prove(): Promise<PropertyResult> {
    this.#clock.advance(this.#afterMs);
    return Promise.reject(new Error('the formal oracle is unavailable'));
  }
}

/** A capture whose testbench prints the one required check passing, for the simulate path. */
function passCapture(): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: 'CHECK q_captures_d PASS\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: { wallMs: 1, maxMemMb: 8, cpuMs: 1 },
  };
}

/** Assemble a loop whose simulate path always passes, sharing `now` with the formal gate's clock. */
function makeLoop(
  spec: Spec,
  context: ConfirmedGenerationContext,
  formal: FormalGate,
  now: () => number,
): { loop: VerificationLoop; recorder: TraceActionRecorder } {
  const candidate = candidateFor(spec);
  const testbench = testbenchFor(spec);
  const runtime = new FakeSandboxRuntime(() => passCapture());
  const simulator = new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const loop = new VerificationLoop({
    gate: new AdmittingGate(context),
    generator: new OneShotGenerator(candidate),
    testbench: new FixedTestbench(testbench),
    simulator,
    recorder,
    trustLabeler: oracleTrustLabeler,
    formal,
    now,
  });
  return { loop, recorder };
}

type ChargedCost = Parameters<SessionBudgetHandle['charge']>[0];

/** A pass-through budget handle that keeps every charge, so a test can isolate the formal share. */
class ChargeLedger implements SessionBudgetHandle {
  readonly #inner: MeteredSessionBudget;
  readonly #charges: ChargedCost[] = [];

  constructor(inner: MeteredSessionBudget) {
    this.#inner = inner;
  }

  get sessionId(): SessionBudgetHandle['sessionId'] {
    return this.#inner.sessionId;
  }

  canAfford(): boolean {
    return this.#inner.canAfford();
  }

  charge(cost: ChargedCost): ReturnType<SessionBudgetHandle['charge']> {
    this.#charges.push(cost);
    return this.#inner.charge(cost);
  }

  stopReason(): ReturnType<SessionBudgetHandle['stopReason']> {
    return this.#inner.stopReason();
  }

  /** Every charge in the order the loop made it. */
  charges(): readonly ChargedCost[] {
    return [...this.#charges];
  }
}

/** A fresh `MeteredSessionBudget` over generous caps. */
function freshMeteredBudget(): MeteredSessionBudget {
  const budget: SessionBudget = {
    sessionId: newUlid(),
    maxIterations: 1_000,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  };
  const built = makeSessionBudget(budget);
  if (!built.ok) {
    throw new Error(`fixture budget construction failed: ${built.error.message}`);
  }
  return new MeteredSessionBudget(built.value);
}

// ---------------------------------------------------------------------------
// Property 2: Preservation (task 2). Written BEFORE the fix and expected to PASS on unfixed code.
//
// Every expectation below is computed from the script and the fixed escalation rule alone: a
// clocked property climbs [20, 40, 80], a combinational property over a clockless design runs [1],
// and only `antecedent-unreached` escalates. Rung classification is a literal table observed on the
// unfixed adapter, never a call into it. The one shared owner reused is `renderPropertyWrapper`,
// which the fix does not touch, for the wrapper text each job and outcome must carry.
//
// Validates: Requirements 3.1-3.16 (bugfix.md); Property 2 (design.md).
// ---------------------------------------------------------------------------

const PROPERTY_2 =
  'formal-elapsed-time-undercharge, Property 2: Verdicts, jobs, windows, refusal attribution, and charge arithmetic are unchanged';

/** The fixed Proof_Depth ladders (Req 4.5). */
const CLOCKED_LADDER: readonly number[] = [20, 40, 80];
const STATELESS_LADDER: readonly number[] = [1];

/** The wrapper's `-top` and filename, spelled as literals so a rename in the adapter is caught. */
const WRAPPER_MODULE_NAME = 'formal_property_wrapper';
const WRAPPER_FILE_NAME = 'formal_property_wrapper.v';

/** The Counterexample trace a refuting rung registers. */
const VCD_TEXT = '$var wire 1 ! clk $end\n';

/** A clockless design, so a combinational property takes the one-rung ladder. */
const STATELESS_DESIGN_INTERFACE: ModuleInterface = Object.freeze({
  moduleName: 'design',
  ports: [{ name: 'out', direction: 'output' as const, width: 4 }],
  clocking: { clockName: null, resetName: null, resetActiveLow: true },
  validityOutputName: null,
});

/** The Reset_Contract `PREPASS_DOCUMENT` derives, as observed on unfixed code. */
const ADMITTED_RESET: ResetContract = Object.freeze({
  derived: true as const,
  resetName: 'rst_n',
  resetActiveLow: true,
  resetKind: 'sync' as const,
  initialStateFree: true,
});

/** A cover reached at step 0, the only step a depth-1 run can honestly report. */
const FIRST_STEP_COVER: FormalCheckReport = Object.freeze({ ...REACHED_COVER, reachedStep: 0 });

type RungAnswer = 'proved' | 'refuted' | 'unreached' | 'incomplete';
type PrepassAnswer = 'admitted' | 'report-missing' | 'reset-refused';

interface ScriptedRung {
  readonly answer: RungAnswer;
  readonly ms: number;
}

/** One property and the answer each ladder rung would give, if it is reached. Always 3 rungs. */
interface ScriptedProperty {
  readonly kind: 'clocked' | 'combinational';
  readonly rungs: readonly ScriptedRung[];
}

/** design.md's FormalRunScript at the adapter height, where no port throws. */
interface FormalRunScript {
  readonly stateless: boolean;
  readonly prepass: { readonly answer: PrepassAnswer; readonly ms: number };
  readonly properties: readonly ScriptedProperty[];
}

/** One rung the fixed rule says the adapter submits, with the window it has left. */
interface PlannedRung {
  readonly depth: number;
  readonly wallMs: number;
  readonly rung: ScriptedRung;
}

/** The rungs one property actually runs, how its ladder ends, and the time they take. */
interface PlannedLadder {
  readonly ran: readonly PlannedRung[];
  readonly end: 'decided' | 'exhausted' | 'timeout';
  readonly spentMs: number;
}

function designInterfaceOf(script: FormalRunScript): ModuleInterface {
  return script.stateless ? STATELESS_DESIGN_INTERFACE : CLOCKED_DESIGN_INTERFACE;
}

function propertiesOf(script: FormalRunScript): FormalProperty[] {
  return script.properties.map((property, index) =>
    property.kind === 'clocked'
      ? clockedProperty(`ac-${index}`)
      : combinationalProperty(`ac-${index}`),
  );
}

/** The window rule: climb while time is left, stop on any answer but `unreached`. */
function planLadder(
  script: FormalRunScript,
  property: ScriptedProperty,
  windowMs: number,
): PlannedLadder {
  const stateless = script.stateless && property.kind === 'combinational';
  const ran: PlannedRung[] = [];
  let spentMs = 0;
  for (const [index, depth] of (stateless ? STATELESS_LADDER : CLOCKED_LADDER).entries()) {
    const remainingMs = windowMs - spentMs;
    if (remainingMs <= 0) {
      return { ran, end: 'timeout', spentMs };
    }
    const rung = property.rungs[index];
    if (rung === undefined) {
      throw new Error('a scripted property must answer every rung of its ladder');
    }
    ran.push({ depth, wallMs: Math.max(1, Math.floor(remainingMs)), rung });
    spentMs += rung.ms;
    if (rung.answer !== 'unreached') {
      return { ran, end: 'decided', spentMs };
    }
  }
  return { ran, end: 'exhausted', spentMs };
}

/** Each property's ladder, or none where the set is empty or the pre-pass refused. */
function planRun(script: FormalRunScript): readonly PlannedLadder[] {
  if (script.properties.length === 0 || script.prepass.answer !== 'admitted') {
    return [];
  }
  const windowMs = BUDGET_MS - script.prepass.ms;
  return script.properties.map((property) => planLadder(script, property, windowMs));
}

/** design.md's `isBugCondition`, over the rungs each ladder actually ran. */
function isBugCondition(script: FormalRunScript, ladders: readonly PlannedLadder[]): boolean {
  if (script.prepass.answer !== 'admitted' || script.properties.length === 0) {
    return false;
  }
  return (
    script.prepass.ms > 0 ||
    ladders.some(
      (ladder) =>
        ladder.ran.length > 1 &&
        ladder.end !== 'timeout' &&
        ladder.ran.slice(0, -1).reduce((sum, planned) => sum + planned.rung.ms, 0) > 0,
    )
  );
}

/** The report a scripted rung serves. A depth-1 run reports its cover at step 0. */
function reportFor(answer: RungAnswer, depth: number): FormalReport {
  const reached = depth === 1 ? FIRST_STEP_COVER : REACHED_COVER;
  switch (answer) {
    case 'proved':
      return formalReport({ base: PASSED_CHECK, cover: reached, induct: INDUCTION_PROVED });
    case 'refuted':
      return formalReport({ base: FAILED_CHECK, cover: reached, induct: INDUCTION_PROVED });
    case 'unreached':
      return ESCALATING_REPORT;
    case 'incomplete':
      return formalReport({ base: PASSED_CHECK, cover: reached, induct: FAILED_CHECK });
  }
}

/** The pre-pass artifacts for each scripted pre-pass answer. */
function prepassAnswerArtifacts(
  answer: PrepassAnswer,
  store: ContentAddressedArtifacts,
): Record<string, ArtifactBlobRef> {
  switch (answer) {
    case 'admitted':
      return prepassArtifacts(store);
    case 'report-missing':
      return {};
    case 'reset-refused':
      return {
        [PREPASS_REPORT_KEY]: store.register(
          JSON.stringify({ ...PREPASS_DOCUMENT, reset: { derived: false } }),
        ),
      };
  }
}

interface ScriptedRun {
  readonly outcome: FormalOutcome;
  readonly jobs: readonly SandboxJob[];
  readonly clockMs: number;
  /** The Counterexample each refuting rung registered, keyed by its planned rung. */
  readonly counterexamples: ReadonlyMap<PlannedRung, ArtifactBlobRef>;
}

/** Drive the real adapter through `script`, serving each formal job the planned rung's answer. */
async function runScript(
  script: FormalRunScript,
  ladders: readonly PlannedLadder[],
): Promise<ScriptedRun> {
  const planned = ladders.flatMap((ladder) => ladder.ran);
  const jobs: SandboxJob[] = [];
  const counterexamples = new Map<PlannedRung, ArtifactBlobRef>();
  const { oracle, clock } = adapterHarness((job, store) => {
    jobs.push(job);
    if (job.kind === 'formalPrepass') {
      return {
        elapsedMs: script.prepass.ms,
        artifacts: prepassAnswerArtifacts(script.prepass.answer, store),
      };
    }
    const next = planned[jobs.length - 2];
    if (next === undefined) {
      throw new Error('the adapter submitted a formal job the fixed ladder rule does not plan');
    }
    const artifacts = reportArtifacts(reportFor(next.rung.answer, next.depth), store);
    if (next.rung.answer === 'refuted') {
      const counterexample = store.register(VCD_TEXT);
      counterexamples.set(next, counterexample);
      artifacts[COUNTEREXAMPLE_ARTIFACT_KEY] = counterexample;
    }
    return { elapsedMs: next.rung.ms, artifacts };
  });
  const outcome = await oracle.proveSet({
    designSource: DESIGN,
    designInterface: designInterfaceOf(script),
    properties: propertiesOf(script),
    budgetMs: BUDGET_MS,
  });
  return { outcome, jobs, clockMs: clock.now(), counterexamples };
}

/** The Proof_Conditions of a property no invocation ran for. */
function notRunConditions(property: FormalProperty): Record<string, unknown> {
  return {
    assertionCount: 0,
    presat: 'not-run',
    cover: { reached: property.kind === 'clocked' ? false : 'not-applicable' },
    base: 'not-run',
    induction: 'not-run',
  };
}

/** The Proof_Conditions a scripted rung's report yields. */
function ranConditions(property: FormalProperty, answer: RungAnswer): Record<string, unknown> {
  const reachedCover = { reached: true, step: REACHED_COVER.reachedStep };
  const cover =
    property.kind === 'combinational'
      ? { reached: 'not-applicable' }
      : answer === 'unreached'
        ? { reached: false }
        : reachedCover;
  return {
    assertionCount: 2,
    presat: 'satisfiable',
    cover,
    base: answer === 'refuted' ? 'failed' : 'passed',
    induction: answer === 'incomplete' ? 'inconclusive' : 'successful',
  };
}

/** A `could-not-verify` result with no tool diagnostic and no cross-check disagreement. */
function couldNotVerify(
  property: FormalProperty,
  cause: string,
  conditions: Record<string, unknown>,
  run: { readonly depth: number; readonly elapsedMs: number },
): Record<string, unknown> {
  return {
    verdict: 'could-not-verify',
    cause,
    conditions,
    diagnostic: null,
    crossCheckDisagreed: false,
    criterionRef: property.criterionRef,
    ...run,
  };
}

/** The result one ladder's deciding (or last) rung yields. */
function decidedResult(
  property: FormalProperty,
  deciding: PlannedRung,
  elapsedMs: number,
  counterexample: ArtifactBlobRef | undefined,
): Record<string, unknown> {
  const conditions = ranConditions(property, deciding.rung.answer);
  const run = { depth: deciding.depth, elapsedMs };
  const { criterionRef } = property;
  switch (deciding.rung.answer) {
    case 'proved':
      return { verdict: 'proved', evidence: conditions, criterionRef, ...run };
    case 'refuted':
      return { verdict: 'refuted', counterexample, conditions, criterionRef, ...run };
    case 'unreached':
      return couldNotVerify(property, 'antecedent-unreached', conditions, run);
    case 'incomplete':
      return couldNotVerify(property, 'induction-engine-incomplete', conditions, run);
  }
}

/**
 * One property's expected result. `elapsedMs` is its whole ladder, plus the pre-pass on the first
 * result, which on a non-buggy run reduces to exactly what unfixed code records.
 */
function expectedResult(
  property: FormalProperty,
  ladder: PlannedLadder,
  elapsedMs: number,
  counterexamples: ReadonlyMap<PlannedRung, ArtifactBlobRef>,
): Record<string, unknown> {
  const last = ladder.ran.at(-1);
  if (ladder.end === 'timeout' || last === undefined) {
    const run = { depth: last?.depth ?? 0, elapsedMs };
    return couldNotVerify(property, 'proof-timeout', notRunConditions(property), run);
  }
  return decidedResult(property, last, elapsedMs, counterexamples.get(last));
}

/** The whole Formal_Outcome the script predicts. */
function expectedOutcome(
  script: FormalRunScript,
  ladders: readonly PlannedLadder[],
  counterexamples: ReadonlyMap<PlannedRung, ArtifactBlobRef>,
): Record<string, unknown> {
  const properties = propertiesOf(script);
  if (properties.length === 0) {
    return {
      results: [],
      propertyWrapperSources: [],
      counterexampleCaptures: [],
      resetContract: null,
      assertionGateEmitted: false,
      clockPolarity: null,
    };
  }
  if (script.prepass.answer !== 'admitted') {
    return expectedRefusal(script, properties);
  }
  const results = properties.map((property, index) => {
    const ladder = ladders[index];
    if (ladder === undefined) throw new Error('every admitted property has a planned ladder');
    const elapsedMs = ladder.spentMs + (index === 0 ? script.prepass.ms : 0);
    return expectedResult(property, ladder, elapsedMs, counterexamples);
  });
  const captures = ladders.map((ladder) => {
    const last = ladder.ran.at(-1);
    const reference = last === undefined ? undefined : counterexamples.get(last);
    return ladder.end === 'decided' && reference !== undefined
      ? { kind: 'trace', reference, trace: VCD_TEXT }
      : null;
  });
  return {
    results,
    propertyWrapperSources: properties.map((property) =>
      renderPropertyWrapper(
        designInterfaceOf(script),
        property,
        WRAPPER_MODULE_NAME,
        ADMITTED_RESET,
      ),
    ),
    counterexampleCaptures: captures,
    resetContract: ADMITTED_RESET,
    // The sync, free-initial-state contract gates a clocked wrapper and never a combinational one.
    assertionGateEmitted: properties.some((property) => property.kind === 'clocked'),
    clockPolarity: 'posedge',
  };
}

/** A refused pre-pass: one refusal per property, the pre-pass time on the first result alone. */
function expectedRefusal(
  script: FormalRunScript,
  properties: readonly FormalProperty[],
): Record<string, unknown> {
  const missing = script.prepass.answer === 'report-missing';
  const cause = missing ? 'toolchain-unavailable' : 'reset-contract-unresolved';
  return {
    results: properties.map((property, index) =>
      couldNotVerify(property, cause, notRunConditions(property), {
        depth: 0,
        elapsedMs: index === 0 ? script.prepass.ms : 0,
      }),
    ),
    propertyWrapperSources: properties.map(() => null),
    counterexampleCaptures: properties.map(() => null),
    resetContract: missing ? null : { derived: false },
    assertionGateEmitted: false,
    clockPolarity: missing ? null : 'posedge',
  };
}

/** Every job the script predicts, in order, with every resource limit. */
function expectedJobs(
  script: FormalRunScript,
  ladders: readonly PlannedLadder[],
): readonly Record<string, unknown>[] {
  if (script.properties.length === 0) {
    return [];
  }
  const designInterface = designInterfaceOf(script);
  const prepass = {
    kind: 'formalPrepass',
    workspaceFiles: [DESIGN],
    limits: { ...CAPS, wallMs: BUDGET_MS },
    requiredOutputs: [PREPASS_REPORT_KEY],
    formalPrepass: { topModule: designInterface.moduleName },
  };
  const properties = propertiesOf(script);
  const formal = ladders.flatMap((ladder, index) => {
    const property = properties[index];
    if (property === undefined) throw new Error('every planned ladder has a property');
    const wrapper = {
      path: WRAPPER_FILE_NAME,
      contents: renderPropertyWrapper(
        designInterface,
        property,
        WRAPPER_MODULE_NAME,
        ADMITTED_RESET,
      ),
    };
    return ladder.ran.map((planned) => ({
      kind: 'formal',
      workspaceFiles: [DESIGN, wrapper],
      limits: { ...CAPS, wallMs: planned.wallMs },
      requiredOutputs: [FORMAL_REPORT_KEY],
      formal: { topModule: WRAPPER_MODULE_NAME, depth: planned.depth },
    }));
  });
  return [prepass, ...formal];
}

/** An outcome with every result's `elapsedMs` removed: what the fix may not change on any run. */
function withoutElapsed(outcome: { readonly results: readonly object[] }): Record<string, unknown> {
  return {
    ...outcome,
    results: outcome.results.map((result) =>
      Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'elapsedMs')),
    ),
  };
}

// --- Generators -----------------------------------------------------------------------------

/** Zero, a short rung, and a rung long enough that two of them spend the 150 s window. */
const rungMsArb = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 1, max: 2_000 }),
  fc.integer({ min: 40_000, max: 90_000 }),
);
const decidingAnswerArb = fc.constantFrom<RungAnswer>('proved', 'refuted', 'incomplete');
const clockedAnswerArb = fc.constantFrom<RungAnswer>(
  'proved',
  'refuted',
  'unreached',
  'unreached',
  'incomplete',
);
const rungArb = (answer: fc.Arbitrary<RungAnswer>): fc.Arbitrary<ScriptedRung> =>
  fc.record({ answer, ms: rungMsArb });
const threeRungs = (answer: fc.Arbitrary<RungAnswer>): fc.Arbitrary<ScriptedRung[]> =>
  fc.array(rungArb(answer), { minLength: 3, maxLength: 3 });

/** Any property; combinational ones never escalate, so `unreached` is a clocked answer only. */
const anyPropertyArb = (stateless: boolean): fc.Arbitrary<ScriptedProperty> => {
  const combinational = fc.record({
    kind: fc.constant('combinational' as const),
    rungs: threeRungs(decidingAnswerArb),
  });
  const clocked = fc.record({
    kind: fc.constant('clocked' as const),
    rungs: threeRungs(clockedAnswerArb),
  });
  return stateless ? combinational : fc.oneof(clocked, combinational);
};

/** A pre-pass of 0 ms, a few seconds, or one that spends the whole window. */
const prepassMsArb = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 1, max: 5_000 }),
  fc.integer({ min: 140_000, max: 160_000 }),
);
const refusingPrepassArb = fc.constantFrom<PrepassAnswer>('report-missing', 'reset-refused');

const anyScriptArb: fc.Arbitrary<FormalRunScript> = fc.boolean().chain((stateless) =>
  fc.record({
    stateless: fc.constant(stateless),
    prepass: fc.record({
      answer: fc.oneof(fc.constant<PrepassAnswer>('admitted'), refusingPrepassArb),
      ms: prepassMsArb,
    }),
    properties: fc.array(anyPropertyArb(stateless), { maxLength: MAX_SET_SIZE }),
  }),
);

/** A clocked ladder decided on its first rung. */
const firstRungClockedArb: fc.Arbitrary<ScriptedProperty> = fc.record({
  kind: fc.constant('clocked' as const),
  rungs: fc.tuple(rungArb(decidingAnswerArb), rungArb(clockedAnswerArb), rungArb(clockedAnswerArb)),
});

/** A 0 ms unreached rung: it escalates and costs nothing a fix could add. */
const ZERO_MS_UNREACHED: ScriptedRung = Object.freeze({ answer: 'unreached', ms: 0 });

/**
 * A clocked ladder that climbs only on 0 ms rungs, so every rung before its last took no time:
 * decided on rung 40, or decided or exhausted on rung 80.
 */
const zeroLeadClimbArb: fc.Arbitrary<ScriptedProperty> = fc.oneof(
  fc.tuple(rungArb(decidingAnswerArb), rungArb(clockedAnswerArb)).map(([deciding, unused]) => ({
    kind: 'clocked' as const,
    rungs: [ZERO_MS_UNREACHED, deciding, unused],
  })),
  rungArb(clockedAnswerArb).map((last) => ({
    kind: 'clocked' as const,
    rungs: [ZERO_MS_UNREACHED, ZERO_MS_UNREACHED, last],
  })),
);

/** A clocked ladder whose window runs out between rungs, after one rung or two. */
const betweenRungTimeoutArb: fc.Arbitrary<ScriptedProperty> = fc.oneof(
  fc
    .tuple(fc.integer({ min: BUDGET_MS, max: BUDGET_MS + 50_000 }), rungArb(clockedAnswerArb))
    .map(([ms, rest]) => ({
      kind: 'clocked' as const,
      rungs: [{ answer: 'unreached' as const, ms }, rest, rest],
    })),
  fc
    .tuple(fc.integer({ min: 0, max: BUDGET_MS - 1 }), fc.integer({ min: 0, max: 50_000 }))
    .map(([first, extra]) => ({
      kind: 'clocked' as const,
      rungs: [
        { answer: 'unreached' as const, ms: first },
        { answer: 'unreached' as const, ms: BUDGET_MS - first + extra },
        { answer: 'proved' as const, ms: 1 },
      ],
    })),
);

/** Every non-buggy shape design.md names, each generated on purpose rather than sampled. */
const nonBuggyScriptArb: fc.Arbitrary<FormalRunScript> = fc.oneof(
  // A refused pre-pass, of any duration, over any set.
  fc.record({
    stateless: fc.constant(false),
    prepass: fc.record({ answer: refusingPrepassArb, ms: prepassMsArb }),
    properties: fc.array(anyPropertyArb(false), { minLength: 1, maxLength: MAX_SET_SIZE }),
  }),
  // An empty set.
  fc.record({
    stateless: fc.boolean(),
    prepass: fc.record({ answer: fc.constant<PrepassAnswer>('admitted'), ms: prepassMsArb }),
    properties: fc.constant([]),
  }),
  // A 0 ms pre-pass over a clocked design: first-rung, zero-lead, and between-rung-timeout ladders.
  fc.record({
    stateless: fc.constant(false),
    prepass: fc.constant({ answer: 'admitted' as const, ms: 0 }),
    properties: fc.array(
      fc.oneof(
        firstRungClockedArb,
        zeroLeadClimbArb,
        betweenRungTimeoutArb,
        fc.record({
          kind: fc.constant('combinational' as const),
          rungs: threeRungs(decidingAnswerArb),
        }),
      ),
      { minLength: 1, maxLength: MAX_SET_SIZE },
    ),
  }),
  // A 0 ms pre-pass over a clockless design: every ladder is one rung.
  fc.record({
    stateless: fc.constant(true),
    prepass: fc.constant({ answer: 'admitted' as const, ms: 0 }),
    properties: fc.array(anyPropertyArb(true), { minLength: 1, maxLength: MAX_SET_SIZE }),
  }),
);

// --- The task's observations, pinned as examples so each shape always runs ------------------

const proveOnFirstRung = (ms: number): ScriptedProperty => ({
  kind: 'clocked',
  rungs: [
    { answer: 'proved', ms },
    { answer: 'proved', ms: 1 },
    { answer: 'proved', ms: 1 },
  ],
});

/** A refused pre-pass of 200 ms over two properties, which records [200, 0]. */
const REFUSED_200_MS: FormalRunScript = {
  stateless: false,
  prepass: { answer: 'report-missing', ms: 200 },
  properties: [proveOnFirstRung(10), proveOnFirstRung(10)],
};
/** An empty set: no job and no result. */
const EMPTY_SET: FormalRunScript = {
  stateless: false,
  prepass: { answer: 'admitted', ms: 0 },
  properties: [],
};
/** A 0 ms pre-pass with single-rung ladders, each recording its own rung's time. */
const SINGLE_RUNGS: FormalRunScript = {
  stateless: false,
  prepass: { answer: 'admitted', ms: 0 },
  properties: [proveOnFirstRung(300), proveOnFirstRung(700)],
};
/** A between-rung timeout: the whole ladder at the deepest depth attempted. */
const BETWEEN_RUNG_TIMEOUT: FormalRunScript = {
  stateless: false,
  prepass: { answer: 'admitted', ms: 0 },
  properties: [
    {
      kind: 'clocked',
      rungs: [
        { answer: 'unreached', ms: 100_000 },
        { answer: 'unreached', ms: 60_000 },
        { answer: 'proved', ms: 1 },
      ],
    },
  ],
};
/** The measured probe, a buggy run, so 2b always sees one. */
const MEASURED_PROBE: FormalRunScript = {
  stateless: false,
  prepass: { answer: 'admitted', ms: 5_000 },
  properties: [
    {
      kind: 'clocked',
      rungs: [
        { answer: 'unreached', ms: 1_000 },
        { answer: 'unreached', ms: 1_000 },
        { answer: 'proved', ms: 1_000 },
      ],
    },
  ],
};

describe(PROPERTY_2, () => {
  it('pins the observed unfixed values the task names', async () => {
    const elapsedOf = async (script: FormalRunScript): Promise<number[]> =>
      (await runScript(script, planRun(script))).outcome.results.map((result) => result.elapsedMs);

    expect(await elapsedOf(REFUSED_200_MS)).toEqual([200, 0]);
    const empty = await runScript(EMPTY_SET, planRun(EMPTY_SET));
    expect(empty.jobs).toEqual([]);
    expect(empty.outcome.results).toEqual([]);
    expect(await elapsedOf(SINGLE_RUNGS)).toEqual([300, 700]);
    const timeout = await runScript(BETWEEN_RUNG_TIMEOUT, planRun(BETWEEN_RUNG_TIMEOUT));
    expect(timeout.outcome.results[0]).toMatchObject({
      cause: 'proof-timeout',
      depth: 40,
      elapsedMs: 160_000,
    });
  });

  it(
    'Property 2a: a non-buggy run returns the whole Formal_Outcome the script predicts',
    async () => {
      const seen = { refused: 0, empty: 0, singleRung: 0, zeroLead: 0, timeout: 0 };
      await fc.assert(
        fc.asyncProperty(nonBuggyScriptArb, async (script) => {
          const ladders = planRun(script);
          // A guard on the generator itself: every shape here must be outside the bug condition.
          expect(isBugCondition(script, ladders)).toBe(false);

          const run = await runScript(script, ladders);

          expect(run.outcome).toEqual(expectedOutcome(script, ladders, run.counterexamples));
          expect(run.jobs).toEqual(expectedJobs(script, ladders));
          tallyShapes(seen, script, ladders);
        }),
        propertyParameters({
          numRuns: 100,
          examples: [[REFUSED_200_MS], [EMPTY_SET], [SINGLE_RUNGS], [BETWEEN_RUNG_TIMEOUT]],
        }),
      );
      // Non-vacuity: every non-buggy shape design.md names actually ran.
      for (const count of Object.values(seen)) {
        expect(count).toBeGreaterThan(0);
      }
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  it(
    'Property 2b: on every run, all but elapsedMs, and every submitted job, match the script',
    async () => {
      let buggy = 0;
      let nonBuggy = 0;
      await fc.assert(
        fc.asyncProperty(fc.oneof(anyScriptArb, nonBuggyScriptArb), async (script) => {
          const ladders = planRun(script);
          if (isBugCondition(script, ladders)) buggy += 1;
          else nonBuggy += 1;

          const run = await runScript(script, ladders);

          expect(withoutElapsed(run.outcome)).toEqual(
            withoutElapsed(
              expectedOutcome(script, ladders, run.counterexamples) as {
                readonly results: readonly object[];
              },
            ),
          );
          expect(run.jobs).toEqual(expectedJobs(script, ladders));
        }),
        propertyParameters({ numRuns: 150, examples: [[MEASURED_PROBE], [BETWEEN_RUNG_TIMEOUT]] }),
      );
      // Non-vacuity: both sides of the bug condition were exercised.
      expect(buggy).toBeGreaterThan(0);
      expect(nonBuggy).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  it(
    'Property 2c: a throwing port yields one toolchain-unavailable result per property and falls back',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom('clocked' as const, 'combinational' as const), {
            minLength: 1,
            maxLength: MAX_SET_SIZE,
          }),
          fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 10_000 })),
          async (kinds, afterMs) => {
            const clock = new ManualClock();
            const spec = formalSpec();
            const properties = kinds.map((kind, index) =>
              kind === 'clocked'
                ? clockedProperty(`ac-${index}`)
                : combinationalProperty(`ac-${index}`),
            );
            const gate: FormalGate = {
              oracle: new ClockAdvancingThrowingOracle(clock, afterMs),
              properties: new ScriptedPropertySet({
                properties,
                unexpressedCriteria: [],
                propertySetAdmitted: 'not-gated',
              }),
            };
            const { loop } = makeLoop(spec, confirmedContext(spec), gate, clock.now);
            const ledger = new ChargeLedger(freshMeteredBudget());

            const outcome = await loop.verify(REQUEST, ledger, LIMITS);

            expect(outcome.status).toBe('verified');
            if (outcome.status !== 'verified') return;
            const refusals = properties.map((property) =>
              couldNotVerify(property, 'toolchain-unavailable', notRunConditions(property), {
                depth: 0,
                elapsedMs: 0,
              }),
            );
            expect(withoutElapsed(outcome.formal)).toMatchObject({
              ...withoutElapsed({ results: refusals }),
              propertyWrapperSources: properties.map(() => null),
              fallbackReason: 'toolchain-unavailable',
            });
            // The zero-token charges are one formal iteration per submitted property (Property 21),
            // then the one simulate iteration the fallback runs; every one costs zero cents.
            const toolCharges = ledger.charges().filter((charge) => charge.tokens === 0);
            expect(toolCharges).toHaveLength(properties.length + 1);
            expect(toolCharges.every((charge) => charge.costCents === 0)).toBe(true);
          },
        ),
        propertyParameters({ numRuns: 100 }),
      );
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

/** Count which non-buggy shapes a 2a run exercised, so the property cannot pass vacuously. */
function tallyShapes(
  seen: Record<'refused' | 'empty' | 'singleRung' | 'zeroLead' | 'timeout', number>,
  script: FormalRunScript,
  ladders: readonly PlannedLadder[],
): void {
  if (script.properties.length === 0) seen.empty += 1;
  else if (script.prepass.answer !== 'admitted') seen.refused += 1;
  if (ladders.some((ladder) => ladder.end === 'decided' && ladder.ran.length === 1)) {
    seen.singleRung += 1;
  }
  if (ladders.some((ladder) => ladder.end !== 'timeout' && ladder.ran.length > 1)) {
    seen.zeroLead += 1;
  }
  if (ladders.some((ladder) => ladder.end === 'timeout' && ladder.ran.length > 0)) {
    seen.timeout += 1;
  }
}
