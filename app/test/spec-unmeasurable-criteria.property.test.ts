// Property 16 for the Spec_Agent: Unmeasurable acceptance criteria are flagged
// (task 11.5; Req 5.4).
//
// This is the universal complement to the concrete measurability examples in
// `spec-agent.test.ts`. Over generated `SpecDraft`s whose acceptance criteria mix
// measurable-by-a-rigorous-method criteria with unmeasurable ones, it asserts the
// measurability gate the design binds to Property 16:
//
//   - A criterion is flagged iff it is NOT verifiable. A criterion counts as
//     verifiable ONLY when it is marked measurable AND its method is one of the
//     rigorous methods (simulation, formal, manual-inspection). Any criterion that
//     is unmarked, carries a non-rigorous method, or both is flagged with a
//     measurable-replacement request; a verifiable criterion is never flagged and
//     is carried into the Spec (Req 5.4).
//   - Approvability iff every criterion is measurable. A draft presents as
//     `awaiting-approval` and `approveSpec` yields an approved `Spec` ONLY when
//     every criterion is verifiable; if ANY criterion is unmeasurable,
//     `presentDraft` returns `needs-revision` and `approveSpec` returns an error -
//     never an approved Spec.
//   - Every flag requests a measurable replacement. Each flagged criterion carries
//     its offending text and a non-empty replacement request, so the student knows
//     what to fix.
//
// The interface (module name and every port) is always generated well-formed, so
// the positive-width gate (Property 15) never fires and the MEASURABILITY gate is
// the sole thing under test here.
//
// Measurability is judged by an INDEPENDENT oracle (`criterionIsMeasurable`)
// computed from the draft, not by any tag carried out of the generator or by the
// production `isCriterionMeasurable`, so the assertions cannot silently agree with
// a generator or implementation bug. A fresh agent + in-memory recorder per run
// keeps runs fully independent (`approveSpec` records a Trace span).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemoryTracePersistence,
  SpecAgent,
  TraceActionRecorder,
  type AcceptanceCriterionDraft,
  type ModelRouter,
  type ModelRouterFailure,
  type PortDraft,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SpecDraft,
  type SpecRevisionContext,
} from '@app/agent';
import { isErr, isOk, newUlid, type Result } from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

// --- Independent measurability oracle (mirrors validation.ts, kept separate) -

/** The rigorous acceptance methods the core `AcceptanceMethod` union permits. */
const RIGOROUS_METHODS: readonly ['simulation', 'formal', 'manual-inspection'] = [
  'simulation',
  'formal',
  'manual-inspection',
];

/** The interface directions the core `PortDirection` union permits. */
const PORT_DIRECTIONS: readonly string[] = ['input', 'output', 'inout'];

/**
 * A criterion is verifiable iff it is BOTH marked measurable AND claims a rigorous
 * method. This mirrors `isCriterionMeasurable` in validation.ts but is recomputed
 * here so the property never trusts the code it verifies.
 */
function criterionIsMeasurable(criterion: AcceptanceCriterionDraft): boolean {
  return (
    criterion.measurable &&
    RIGOROUS_METHODS.includes(criterion.method as (typeof RIGOROUS_METHODS)[number])
  );
}

// --- Character helpers -------------------------------------------------------

const LOWER: readonly string[] = 'abcdefghijklmnopqrstuvwxyz'.split('');

/** An arbitrary string of length `[min, max]` drawn from an explicit alphabet. */
function fromChars(chars: readonly string[], min: number, max: number): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('fromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: min, maxLength: max })
    .map((picked) => picked.join(''));
}

/** A well-formed identifier: lowercase letters, always non-empty after trim. */
function identifierArbitrary(): fc.Arbitrary<string> {
  return fromChars(LOWER, 1, 8);
}

/** A method string outside the rigorous `AcceptanceMethod` set. */
function nonRigorousMethodArbitrary(): fc.Arbitrary<string> {
  return fromChars(LOWER, 3, 12).filter(
    (value) => !RIGOROUS_METHODS.includes(value as (typeof RIGOROUS_METHODS)[number]),
  );
}

// --- Criterion generators ----------------------------------------------------

/** A fully verifiable criterion: marked measurable AND a rigorous method. */
function measurableCriterionArbitrary(): fc.Arbitrary<AcceptanceCriterionDraft> {
  return fc.record<AcceptanceCriterionDraft>({
    text: fromChars(LOWER, 3, 24),
    measurable: fc.constant(true),
    method: fc.constantFrom(...RIGOROUS_METHODS),
  });
}

/**
 * An unmeasurable criterion carrying at least one defect: unmarked measurability,
 * a non-rigorous method, or both. Each defect independently must flag the criterion
 * for a measurable replacement (Req 5.4).
 */
function unmeasurableCriterionArbitrary(): fc.Arbitrary<AcceptanceCriterionDraft> {
  const notMarked = fc.record<AcceptanceCriterionDraft>({
    text: fromChars(LOWER, 3, 24),
    measurable: fc.constant(false),
    method: fc.constantFrom(...RIGOROUS_METHODS),
  });
  const badMethod = fc.record<AcceptanceCriterionDraft>({
    text: fromChars(LOWER, 3, 24),
    measurable: fc.constant(true),
    method: nonRigorousMethodArbitrary(),
  });
  const bothDefects = fc.record<AcceptanceCriterionDraft>({
    text: fromChars(LOWER, 3, 24),
    measurable: fc.constant(false),
    method: nonRigorousMethodArbitrary(),
  });
  return fc.oneof(
    { weight: 1, arbitrary: notMarked },
    { weight: 1, arbitrary: badMethod },
    { weight: 1, arbitrary: bothDefects },
  );
}

/** A criteria list of length `[1, 6]` mixing verifiable and unmeasurable criteria. */
function criteriaArbitrary(): fc.Arbitrary<readonly AcceptanceCriterionDraft[]> {
  const criterion = fc.oneof(
    { weight: 1, arbitrary: measurableCriterionArbitrary() },
    { weight: 1, arbitrary: unmeasurableCriterionArbitrary() },
  );
  return fc.array(criterion, { minLength: 1, maxLength: 6 });
}

/** A fully well-formed port, so the positive-width gate never fires here. */
function validPortArbitrary(): fc.Arbitrary<PortDraft> {
  return fc.record<PortDraft>({
    name: identifierArbitrary(),
    direction: fc.constantFrom(...PORT_DIRECTIONS),
    width: fc.integer({ min: 1, max: 64 }),
  });
}

/** A whole `SpecDraft` whose only possible offenders are its acceptance criteria. */
function specDraftArbitrary(): fc.Arbitrary<SpecDraft> {
  return fc.record<SpecDraft>({
    goal: fromChars(LOWER, 4, 40),
    constraints: fc.array(fromChars(LOWER, 3, 20), { maxLength: 3 }),
    architecture: fromChars(LOWER, 4, 40),
    moduleInterface: fc.record({
      moduleName: identifierArbitrary(),
      ports: fc.array(validPortArbitrary(), { minLength: 1, maxLength: 4 }),
      clocking: fc.constant({ clockName: 'clk', resetName: 'rst', resetActiveLow: false }),
    }),
    // No case under this property proposes a Timing_Contract entry; the
    // measurability gate under test does not read this field (task 1.3's migration).
    timingContractEntries: fc.constant([]),
    acceptanceCriteria: criteriaArbitrary(),
  });
}

// --- Agent wiring ------------------------------------------------------------

/**
 * A Model_Router that is never invoked: this property drives only the pure
 * `presentDraft` and the model-free `approveSpec`, so `invoke` returning a
 * fail-safe result is enough to satisfy the injected seam.
 */
class NeverInvokedRouter implements ModelRouter {
  invoke(): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    return Promise.resolve({
      ok: false,
      error: { code: 'ALL_PROVIDERS_FAILED', task: 'hard-planning', attempts: 0 },
    });
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A fresh Spec_Agent over a fresh recorder, with a fixed clock for span timing. */
function freshAgent(): SpecAgent {
  return new SpecAgent({
    router: new NeverInvokedRouter(),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    now: () => 1_700_000_000_000,
  });
}

/** A revision context for driving `presentDraft`/`approveSpec` directly. */
function freshContext(): SpecRevisionContext {
  return { sessionId: newUlid(), projectId: newUlid(), specId: newUlid(), version: 1 };
}

// --- The property ------------------------------------------------------------

describe('Spec_Agent unmeasurable-criteria flagging (Property 16)', () => {
  // Feature: hdl-creation-loop, Property 16: Unmeasurable acceptance criteria are flagged
  it('flags exactly the unmeasurable criteria with a replacement request, and approves iff none', async () => {
    await fc.assert(
      fc.asyncProperty(specDraftArbitrary(), async (draft) => {
        const agent = freshAgent();
        const context = freshContext();
        const criteria = draft.acceptanceCriteria;
        const offenders = criteria.filter((criterion) => !criterionIsMeasurable(criterion));
        const anyOffender = offenders.length > 0;

        const presentation = agent.presentDraft(context, draft);

        if (!anyOffender) {
          // Every criterion verifiable: presents as approvable, then approves.
          expect(presentation.status).toBe('awaiting-approval');
          if (presentation.status !== 'awaiting-approval') {
            throw new Error('expected awaiting-approval for an all-measurable criteria set');
          }
          expect(presentation.spec.approved).toBe(false);
          // Every generated criterion is carried into the Spec, all measurable.
          expect(presentation.spec.acceptanceCriteria).toHaveLength(criteria.length);
          expect(presentation.spec.acceptanceCriteria.every((c) => c.measurable)).toBe(true);
          expect(
            presentation.spec.acceptanceCriteria.every((c) => RIGOROUS_METHODS.includes(c.method)),
          ).toBe(true);

          const approval = await agent.approveSpec(presentation);
          expect(isOk(approval)).toBe(true);
          if (isOk(approval)) {
            expect(approval.value.approved).toBe(true);
            expect(approval.value.acceptanceCriteria.every((c) => c.measurable)).toBe(true);
          }
          return;
        }

        // At least one unmeasurable criterion: never approvable, each one flagged.
        expect(presentation.status).toBe('needs-revision');
        if (presentation.status !== 'needs-revision') {
          throw new Error('expected needs-revision when an acceptance criterion is unmeasurable');
        }
        // One flag per unmeasurable criterion, and the interface is always clean.
        expect(presentation.issues.unmeasurableCriteria).toHaveLength(offenders.length);
        expect(presentation.issues.signalIssues).toHaveLength(0);
        // Every flag names its offending criterion and requests a measurable replacement.
        const flaggedTexts = presentation.issues.unmeasurableCriteria.map(
          (flag) => flag.criterionText,
        );
        for (const offender of offenders) {
          expect(flaggedTexts).toContain(offender.text);
        }
        for (const flag of presentation.issues.unmeasurableCriteria) {
          expect(flag.replacementRequest.trim().length).toBeGreaterThan(0);
          expect(flag.replacementRequest.toLowerCase()).toContain('measurable');
          expect(flag.reason.trim().length).toBeGreaterThan(0);
        }

        // approveSpec must refuse and return the same offenders, never an approved Spec.
        const approval = await agent.approveSpec(presentation);
        expect(isErr(approval)).toBe(true);
        if (isErr(approval)) {
          expect(approval.error.unmeasurableCriteria).toHaveLength(offenders.length);
          const rejectedTexts = approval.error.unmeasurableCriteria.map(
            (flag) => flag.criterionText,
          );
          for (const offender of offenders) {
            expect(rejectedTexts).toContain(offender.text);
          }
        }
      }),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 16 tag is asserted, not only written in a
// comment: `Feature: hdl-creation-loop, Property 16: Unmeasurable acceptance criteria are flagged`.
describe('Property 16 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(propertyTag(16, 'Unmeasurable acceptance criteria are flagged')).toBe(
      'Feature: hdl-creation-loop, Property 16: Unmeasurable acceptance criteria are flagged',
    );
  });
});
