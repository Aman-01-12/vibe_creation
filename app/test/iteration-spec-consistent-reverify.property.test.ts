// Property 21: Iteration re-verifies with a spec-consistent testbench (task 16.3).
//
// THIS IS THE SPEC-CONSISTENCY (ANTI-STALE) PROPERTY FOR CONVERSATIONAL ITERATION.
// The Spec is the source of truth: a conversational change is applied to the Spec
// through the injected `IterationSpecUpdater`, and the full Verification_Loop then
// regenerates and re-verifies the RTL FROM THAT UPDATED SPEC. If an iteration could
// re-verify against a testbench derived from the OLD Spec (a stale, old-interface
// testbench), a pass could be reported that no longer matches what the Student
// actually asked for - so re-verification must always run against a testbench
// consistent with the CURRENT (updated) Spec.
//
// Over many generated iterations - interface-changing and interface-preserving,
// passing and failing, with and without a prior `Verified` baseline - this asserts,
// deriving every expectation independently of the code under test:
//
//   1. Full re-verification always runs (Req 10.1, 10.3). The `IterationReVerifier`
//      port - which stands in for the whole Verification_Loop that regenerates the
//      independent Testbench from the Spec - is invoked EXACTLY ONCE per iteration,
//      and its input has exactly the fields { intent, spec } with no channel to
//      request a partial/subset run.
//   2. Spec-consistent, never stale (Req 10.1, 10.2, 10.3). The spec handed to
//      re-verification is the UPDATED Spec returned by the Spec updater (a fresh
//      version), never the stale current Spec; and any Testbench the verdict was
//      produced against is attributed to that updated Spec version, never the old
//      one. This is the core anti-defect assertion: a fake re-verifier faithfully
//      derives its Testbench from whatever Spec it is handed, so passing the stale
//      Spec would surface as an old-version testbench and fail loudly.
//   3. Interface change drives Spec update + Testbench regeneration (Req 10.2). When
//      (and only when) the iteration changes the Module_Interface, a
//      `regenerating-testbench` step is emitted between the Spec update and
//      re-verification, and the recorded Spec-update span marks `interfaceChanged`.
//      The independent oracle is a per-scenario flag: the Spec updater is scripted
//      to either keep the interface byte-identical or change the module name, so the
//      expected outcome is known without consulting `interfaceChangedBetween`
//      (which is additionally cross-checked for non-vacuity).
//   4. Regression is reported with a revert offer (Req 10.4). A change that turns a
//      previously passing module failing yields a `regressed` outcome offering a
//      revert to the exact last `Verified` state; with no prior baseline the same
//      failing verdict yields a plain `unverified` outcome and no revert offer.
//      Either way the module is never presented as correct before a fresh pass.
//
// Validates: Requirements 10.1, 10.2, 10.3, 10.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  IterationAgent,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TraceActionRecorder,
  interfaceChangedBetween,
  intentArtifactLabel,
  type IntentSession,
  type IterationProgressEvent,
  type IterationRequest,
  type IterationReVerifier,
  type IterationSpecUpdater,
  type LastVerifiedState,
  type ReVerifyInput,
  type ReVerifyResult,
  type SessionBudgetHandle,
  type SpecChangeRequest,
  type SpecUpdateFailure,
} from '@app/agent';
import {
  makePort,
  makeSessionBudget,
  makeTestbench,
  makeVerificationResult,
  newUlid,
  ok,
  unverified,
  verified,
  type AcceptanceCriterion,
  type ClockingContract,
  type LabeledArtifact,
  type ModuleVersion,
  type Port,
  type PortDirection,
  type Result,
  type Spec,
  type Testbench,
  type Ulid,
  type VerificationResult,
} from '@app/core';
import type { ResourceLimits } from '@app/tools';
import { propertyParameters, propertyTag, timingContractFor } from '@app/test';

const PROPERTY = propertyTag(21, 'Iteration re-verifies with a spec-consistent testbench');

/** Which verdict the re-verification (Verification_Loop stand-in) reports. */
type VerdictKind = 'verified' | 'unverified';

// -- Generators -------------------------------------------------------------

/** Crockford base32 alphabet used by ULIDs (excludes I, L, O, U). */
const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');
/** The valid first-character set for a 48-bit ULID timestamp (0-7). */
const ULID_HEAD_CHARS = '01234567'.split('');
/** ASCII identifier characters for module/port names. */
const IDENT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');
/** A safe free-text word pool for Spec strings (no sentinel collisions needed here). */
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

/** A non-empty ASCII identifier for signal/module names. */
function identifierArbitrary(maxLength = 12): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...IDENT_CHARS), { minLength: 1, maxLength })
    .map((chars) => chars.join(''));
}

/** A short phrase drawn from the safe word pool. */
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
function criterionArbitrary(): fc.Arbitrary<AcceptanceCriterion> {
  return fc.record({
    id: ulidArbitrary(),
    text: phraseArbitrary(),
    measurable: fc.constant(true),
    method: fc.constant<'simulation'>('simulation'),
  });
}

/** An approved Spec: the current source of truth an iteration is applied to. */
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
      acceptanceCriteria: fc.array(criterionArbitrary(), { minLength: 1, maxLength: 3 }),
      architecture: phraseArbitrary(),
      version: fc.integer({ min: 1, max: 12 }),
    })
    .map((fields) => ({
      ...fields,
      approved: true as const,
      timingContract: timingContractFor(fields.moduleInterface),
    }));
}

/** The full generated scenario for one iteration. */
interface Scenario {
  readonly currentSpec: Spec;
  readonly mutateInterface: boolean;
  readonly verdictKind: VerdictKind;
  readonly hasLastVerified: boolean;
  readonly editedVerified: boolean;
  readonly requestedChange: string;
}

/** Generate an iteration scenario across all meaningful axes. */
function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return fc.record({
    currentSpec: approvedSpecArbitrary(),
    mutateInterface: fc.boolean(),
    verdictKind: fc.constantFrom<VerdictKind>('verified', 'unverified'),
    hasLastVerified: fc.boolean(),
    editedVerified: fc.boolean(),
    requestedChange: phraseArbitrary(),
  });
}

// -- Independent fixture builders -------------------------------------------

/** Unwrap a `Result`, failing the test loudly on the error arm. */
function expectOk<T>(result: Result<T, unknown>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/**
 * Derive the updated Spec the Spec updater returns for a scenario.
 *
 * INDEPENDENT ORACLE: the interface is changed IFF `mutateInterface`, by renaming
 * the module (which always differs from the original name); otherwise the exact
 * same `moduleInterface` reference is reused so it is byte-identical. Either way the
 * version is bumped, so a testbench attributed to the updated Spec is distinguishable
 * from one attributed to the stale current Spec.
 */
function updatedSpecFor(currentSpec: Spec, mutateInterface: boolean): Spec {
  const base: Spec = {
    ...currentSpec,
    version: currentSpec.version + 1,
    goal: `${currentSpec.goal} revised`,
  };
  if (!mutateInterface) {
    return base;
  }
  return {
    ...base,
    moduleInterface: {
      ...currentSpec.moduleInterface,
      moduleName: `${currentSpec.moduleInterface.moduleName}_ifchg`,
    },
  };
}

/** A module version attributed to the given Spec version. */
function moduleVersionFor(spec: Spec): ModuleVersion {
  return {
    id: newUlid(),
    projectId: spec.projectId,
    specVersion: spec.version,
    rtl: `module ${spec.moduleInterface.moduleName}; endmodule`,
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

/** A spec-derived testbench, attributed to the Spec it was generated from. */
function testbenchFor(spec: Spec): Testbench {
  return makeTestbench({
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source: 'module tb; initial begin $finish; end endmodule',
    coversCriteria: spec.acceptanceCriteria.map((criterion) => criterion.id),
  });
}

/** A recorded passing verification result for a module version + testbench. */
function passResult(moduleVersion: ModuleVersion, testbench: Testbench): VerificationResult {
  return expectOk(
    makeVerificationResult({
      id: newUlid(),
      moduleVersionId: moduleVersion.id,
      testbenchId: testbench.id,
      verdict: 'pass',
      allChecksPassed: true,
      iterations: 1,
      costCents: 1,
      oracleSpanId: newUlid(),
    }),
  );
}

/** A recorded failing verification result with a localized failing case. */
function failResult(moduleVersion: ModuleVersion, testbench: Testbench): VerificationResult {
  return expectOk(
    makeVerificationResult({
      id: newUlid(),
      moduleVersionId: moduleVersion.id,
      testbenchId: testbench.id,
      verdict: 'fail',
      allChecksPassed: false,
      iterations: 2,
      costCents: 1,
      oracleSpanId: newUlid(),
      failingCase: {
        checkName: 'increment',
        description: 'counter did not increment',
        expected: '1',
        observed: '0',
        atSimTimeNs: 10,
      },
    }),
  );
}

/**
 * The re-verification result derived from whatever Spec the loop is handed.
 *
 * This is the crux of the spec-consistency check: the testbench and module version
 * are built from `spec`, so if the Iteration_Agent were to pass the stale current
 * Spec, the produced testbench would carry the OLD version and the assertions would
 * fail. A faithful agent passes the updated Spec, so the testbench is current.
 */
function reVerifyResultFor(spec: Spec, verdictKind: VerdictKind): ReVerifyResult {
  const moduleVersion = moduleVersionFor(spec);
  const testbench = testbenchFor(spec);
  if (verdictKind === 'verified') {
    const result = passResult(moduleVersion, testbench);
    const label = expectOk(
      verified(
        { kind: 'module-version', id: moduleVersion.id, version: spec.version },
        result.oracleSpanId,
      ),
    );
    return { status: 'verified', label, moduleVersion, testbench, result };
  }
  const result = failResult(moduleVersion, testbench);
  const label = unverified({ kind: 'module-version', id: moduleVersion.id, version: spec.version });
  return {
    status: 'unverified',
    label,
    moduleVersion,
    testbench,
    result,
    failingCase: result.failingCase ?? null,
  };
}

/** A confirmed intent session so re-verification is admitted through the gate. */
function confirmedIntent(): IntentSession {
  return {
    sessionId: newUlid(),
    artifact: intentArtifactLabel(newUlid(), 1),
    restatement: { summary: 'A synchronous module.', constraints: [], assumptions: [] },
    scope: 'single-module',
    clarificationRounds: 1,
    outcome: { kind: 'ready-for-confirmation' },
    confirmation: 'confirmed',
  };
}

/** The current label of the module being edited (demoted on edit). */
function editedLabel(currentSpec: Spec, editedVerified: boolean): LabeledArtifact {
  const ref = { kind: 'module-version' as const, id: newUlid(), version: currentSpec.version };
  return editedVerified ? expectOk(verified(ref, newUlid())) : unverified(ref);
}

/** The last `Verified` state a regression can offer to revert to, built from the current Spec. */
function lastVerifiedFor(currentSpec: Spec): LastVerifiedState {
  const moduleVersion = moduleVersionFor(currentSpec);
  const testbench = testbenchFor(currentSpec);
  const result = passResult(moduleVersion, testbench);
  const label = expectOk(
    verified(
      { kind: 'module-version', id: moduleVersion.id, version: currentSpec.version },
      result.oracleSpanId,
    ),
  );
  return { moduleVersion, label, testbench, result };
}

/** A generous budget so nothing terminates the iteration prematurely. */
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

/** Sandbox resource limits; forwarded to the re-verifier but unused by the fakes. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 16, diskMb: 64, wallMs: 10_000 };

// -- Test doubles -----------------------------------------------------------

/** A Spec updater that records its request and returns a fixed updated Spec. */
class FixedSpecUpdater implements IterationSpecUpdater {
  readonly requests: SpecChangeRequest[] = [];

  constructor(private readonly updated: Spec) {}

  applyChange(
    request: SpecChangeRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<Spec, SpecUpdateFailure>> {
    void budget;
    this.requests.push(request);
    return Promise.resolve(ok(this.updated));
  }
}

/**
 * A re-verifier that captures the exact input it is handed and derives its result
 * from that input's Spec, so the test can prove which Spec version drove the run.
 */
class CapturingReVerifier implements IterationReVerifier {
  readonly inputs: ReVerifyInput[] = [];

  constructor(private readonly verdictKind: VerdictKind) {}

  reVerify(
    input: ReVerifyInput,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): Promise<ReVerifyResult> {
    void budget;
    void limits;
    this.inputs.push(input);
    return Promise.resolve(reVerifyResultFor(input.spec, this.verdictKind));
  }
}

// -- Property ---------------------------------------------------------------

describe(PROPERTY, () => {
  it('re-verifies the full testbench against the current (updated) spec, regenerating on interface change', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary(), async (scenario) => {
        const { currentSpec, mutateInterface, verdictKind, hasLastVerified, editedVerified } =
          scenario;

        const updatedSpec = updatedSpecFor(currentSpec, mutateInterface);
        const specUpdater = new FixedSpecUpdater(updatedSpec);
        const reVerifier = new CapturingReVerifier(verdictKind);
        const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
        const agent = new IterationAgent({
          specUpdater,
          reVerifier,
          recorder,
          now: () => 1_700_000_000_000,
        });

        const lastVerified = hasLastVerified ? lastVerifiedFor(currentSpec) : null;
        const request: IterationRequest = {
          sessionId: newUlid(),
          projectId: currentSpec.projectId,
          intent: confirmedIntent(),
          currentSpec,
          edited: editedLabel(currentSpec, editedVerified),
          requestedChange: scenario.requestedChange,
          lastVerified,
        };

        // Drive the streaming run, collecting progress events and the terminal outcome.
        const events: IterationProgressEvent[] = [];
        const iterator = agent.run(request, generousBudget(), LIMITS);
        let step = await iterator.next();
        while (!step.done) {
          events.push(step.value);
          step = await iterator.next();
        }
        const outcome = step.value;

        // (Non-vacuity) The independent interface-change oracle agrees with the helper.
        expect(
          interfaceChangedBetween(currentSpec.moduleInterface, updatedSpec.moduleInterface),
        ).toBe(mutateInterface);

        // (1) Full re-verification ran exactly once, over exactly { intent, spec }.
        expect(reVerifier.inputs).toHaveLength(1);
        const reVerifyInput = reVerifier.inputs[0]!;
        expect(Object.keys(reVerifyInput).sort()).toEqual(['intent', 'spec']);

        // (2) It ran against the UPDATED spec (fresh version), never the stale one.
        expect(reVerifyInput.spec).toBe(updatedSpec);
        expect(reVerifyInput.spec.version).toBe(currentSpec.version + 1);
        expect(reVerifyInput.spec.version).not.toBe(currentSpec.version);
        expect(reVerifyInput.intent).toBe(request.intent);

        // The change was applied to the current spec source of truth exactly once.
        expect(specUpdater.requests).toHaveLength(1);
        expect(specUpdater.requests[0]!.currentSpec).toBe(currentSpec);
        expect(specUpdater.requests[0]!.requestedChange).toBe(request.requestedChange);

        // (3) Interface change drives Spec update + Testbench regeneration.
        const phases = events.map((event) => event.phase);
        expect(phases[0]).toBe('demoting');
        const indexOf = (phase: IterationProgressEvent['phase']): number => phases.indexOf(phase);
        expect(indexOf('demoting')).toBeLessThan(indexOf('updating-spec'));
        expect(indexOf('updating-spec')).toBeLessThan(indexOf('verifying'));
        expect(phases.includes('regenerating-testbench')).toBe(mutateInterface);
        if (mutateInterface) {
          expect(indexOf('updating-spec')).toBeLessThan(indexOf('regenerating-testbench'));
          expect(indexOf('regenerating-testbench')).toBeLessThan(indexOf('verifying'));
        }

        // The recorded spec-update span marks the interface change and the new version.
        const trace = await recorder.getTrace(request.sessionId);
        const specUpdateSpan = trace.spans.find(
          (span) => (span.outputs as { readonly stage?: string }).stage === 'iteration-spec-update',
        );
        expect(specUpdateSpan).toBeDefined();
        expect(specUpdateSpan!.outputs).toMatchObject({
          interfaceChanged: mutateInterface,
          specVersion: updatedSpec.version,
        });

        // (4) Terminal outcome: verified / regressed / unverified, derived independently.
        const expectedStatus =
          verdictKind === 'verified' ? 'verified' : hasLastVerified ? 'regressed' : 'unverified';
        expect(outcome.status).toBe(expectedStatus);
        // The terminal phase is reported last, strictly after re-verification began.
        expect(phases[phases.length - 1]).toBe(expectedStatus);
        expect(indexOf('verifying')).toBeLessThan(phases.length - 1);

        if (
          outcome.status !== 'verified' &&
          outcome.status !== 'regressed' &&
          outcome.status !== 'unverified'
        ) {
          throw new Error(`unexpected terminal status: ${outcome.status}`);
        }

        // Spec-consistent testbench: attributed to the updated Spec, never the stale one.
        expect(outcome.diff.interfaceChanged).toBe(mutateInterface);
        expect(outcome.updatedSpec).toBe(updatedSpec);
        expect(outcome.testbench.sourceAttribution).toBe('spec');
        expect(outcome.testbench.specId).toBe(updatedSpec.id);
        expect(outcome.testbench.specVersion).toBe(updatedSpec.version);
        expect(outcome.testbench.specVersion).not.toBe(currentSpec.version);

        // The regression path offers a revert to the exact last Verified state (Req 10.4).
        if (outcome.status === 'regressed') {
          expect(outcome.revertOffer.offered).toBe(true);
          expect(outcome.revertOffer.lastVerified).toBe(lastVerified);
        }
      }),
      propertyParameters(),
    );
  });
});
