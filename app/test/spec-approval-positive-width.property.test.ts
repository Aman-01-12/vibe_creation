// Property 15 for the Spec_Agent: Spec approval requires positive-width ports
// (task 11.4; Req 5.3, 5.9).
//
// This is the universal complement to the concrete positive-width examples in
// `spec-agent.test.ts`. Over generated `SpecDraft`s whose interface mixes
// well-formed ports with malformed ones, it asserts the width gate the design
// binds to Property 15:
//
//   - Approvability iff every signal is well-formed. A draft presents as
//     `awaiting-approval` and `approveSpec` yields an approved `Spec` ONLY when
//     every port has a positive integer width, a valid direction, and a
//     non-empty name. If ANY port has a non-positive/non-integer width (or an
//     invalid direction, or an empty name), `presentDraft` returns
//     `needs-revision` and `approveSpec` returns an error - never an approved
//     Spec (Req 5.3, 5.9).
//   - The offending signal is named. Every malformed port is named in the
//     signal issues (by its declared name, or a positional fallback when the
//     name itself is empty), so the student can locate each one.
//
// The acceptance criteria are always generated measurable-by-a-rigorous-method,
// so the measurability gate (Property 16) never fires and the WIDTH gate is the
// sole thing under test here. The module name is always well-formed for the same
// reason: the only offenders are the ports.
//
// Validity is judged by an INDEPENDENT oracle (`portIsValid`) computed from the
// draft, not by any tag carried out of the generator, so the assertions cannot
// silently agree with a generator bug. A fresh agent + in-memory recorder per run
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

// --- Independent validity oracle (mirrors validation.ts, kept separate) ------

/** The interface directions the core `PortDirection` union permits. */
const PORT_DIRECTIONS: readonly string[] = ['input', 'output', 'inout'];

/** The rigorous acceptance methods the core `AcceptanceMethod` union permits. */
const RIGOROUS_METHODS: readonly ['simulation', 'formal', 'manual-inspection'] = [
  'simulation',
  'formal',
  'manual-inspection',
];

/** A port is well-formed iff it has a non-empty name, a valid direction, and a positive integer width. */
function portIsValid(port: PortDraft): boolean {
  const hasName = port.name.trim().length > 0;
  const hasDirection = PORT_DIRECTIONS.includes(port.direction);
  const hasPositiveWidth = Number.isInteger(port.width) && port.width > 0;
  return hasName && hasDirection && hasPositiveWidth;
}

/** The student-facing label the validator uses: the name, or a positional fallback when unnamed. */
function labelFor(port: PortDraft, index: number): string {
  return port.name.trim().length > 0 ? port.name : `signal #${index + 1}`;
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

// --- Port generators ---------------------------------------------------------

/** A fully well-formed port: valid name, valid direction, positive integer width. */
function validPortArbitrary(): fc.Arbitrary<PortDraft> {
  return fc.record<PortDraft>({
    name: identifierArbitrary(),
    direction: fc.constantFrom(...PORT_DIRECTIONS),
    width: fc.integer({ min: 1, max: 64 }),
  });
}

/** A non-positive or non-integer bit width (0, negative, or fractional). */
function invalidWidthArbitrary(): fc.Arbitrary<number> {
  return fc.oneof(
    fc.integer({ min: -32, max: 0 }), // zero and negative integers
    fc.integer({ min: 1, max: 32 }).map((n) => n + 0.5), // positive non-integer
    fc.integer({ min: -16, max: -1 }).map((n) => n - 0.5), // negative non-integer
  );
}

/** A direction string outside the closed `PortDirection` union. */
function invalidDirectionArbitrary(): fc.Arbitrary<string> {
  return fromChars(LOWER, 3, 10).filter((value) => !PORT_DIRECTIONS.includes(value));
}

/** An empty or whitespace-only name, which trims to nothing. */
function emptyNameArbitrary(): fc.Arbitrary<string> {
  return fc.constantFrom('', ' ', '  ', '\t', '\n');
}

/**
 * A malformed port carrying exactly one defect. Width defects dominate because
 * the positive-width gate is the property under test; invalid direction and empty
 * name are the sibling interface defects that must also block approval (Req 5.3).
 */
function invalidPortArbitrary(): fc.Arbitrary<PortDraft> {
  const widthDefect = fc.record<PortDraft>({
    name: identifierArbitrary(),
    direction: fc.constantFrom(...PORT_DIRECTIONS),
    width: invalidWidthArbitrary(),
  });
  const directionDefect = fc.record<PortDraft>({
    name: identifierArbitrary(),
    direction: invalidDirectionArbitrary(),
    width: fc.integer({ min: 1, max: 64 }),
  });
  const nameDefect = fc.record<PortDraft>({
    name: emptyNameArbitrary(),
    direction: fc.constantFrom(...PORT_DIRECTIONS),
    width: fc.integer({ min: 1, max: 64 }),
  });
  return fc.oneof(
    { weight: 3, arbitrary: widthDefect },
    { weight: 1, arbitrary: directionDefect },
    { weight: 1, arbitrary: nameDefect },
  );
}

/** A port list of length `[1, 6]` mixing well-formed and malformed ports. */
function portsArbitrary(): fc.Arbitrary<readonly PortDraft[]> {
  const port = fc.oneof(
    { weight: 1, arbitrary: validPortArbitrary() },
    { weight: 1, arbitrary: invalidPortArbitrary() },
  );
  return fc.array(port, { minLength: 1, maxLength: 6 });
}

/** A measurable acceptance criterion, so the measurability gate never fires here. */
function measurableCriterionArbitrary(): fc.Arbitrary<AcceptanceCriterionDraft> {
  return fc.record<AcceptanceCriterionDraft>({
    text: fromChars(LOWER, 3, 24),
    measurable: fc.constant(true),
    method: fc.constantFrom(...RIGOROUS_METHODS),
  });
}

/** A whole `SpecDraft` whose only possible offenders are its ports. */
function specDraftArbitrary(): fc.Arbitrary<SpecDraft> {
  return fc.record<SpecDraft>({
    goal: fromChars(LOWER, 4, 40),
    constraints: fc.array(fromChars(LOWER, 3, 20), { maxLength: 3 }),
    architecture: fromChars(LOWER, 4, 40),
    moduleInterface: fc.record({
      moduleName: identifierArbitrary(),
      ports: portsArbitrary(),
      clocking: fc.constant({ clockName: 'clk', resetName: 'rst', resetActiveLow: false }),
    }),
    // No case under this property proposes a Timing_Contract entry; the width
    // gate under test does not read this field (task 1.3's migration).
    timingContractEntries: fc.constant([]),
    acceptanceCriteria: fc.array(measurableCriterionArbitrary(), { minLength: 1, maxLength: 3 }),
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

describe('Spec_Agent positive-width approval (Property 15)', () => {
  // Feature: hdl-creation-loop, Property 15: Spec approval requires positive-width ports
  it('is approvable iff every port is positive-width, naming every offending signal', async () => {
    await fc.assert(
      fc.asyncProperty(specDraftArbitrary(), async (draft) => {
        const agent = freshAgent();
        const context = freshContext();
        const ports = draft.moduleInterface.ports;
        const offenders = ports
          .map((port, index) => ({ port, index }))
          .filter(({ port }) => !portIsValid(port));
        const anyOffender = offenders.length > 0;

        const presentation = agent.presentDraft(context, draft);

        if (!anyOffender) {
          // Every port well-formed: presents as approvable, then approves.
          expect(presentation.status).toBe('awaiting-approval');
          if (presentation.status !== 'awaiting-approval') {
            throw new Error('expected awaiting-approval for an all-positive-width interface');
          }
          expect(presentation.spec.approved).toBe(false);
          expect(
            presentation.spec.moduleInterface.ports.every(
              (port) => Number.isInteger(port.width) && port.width > 0,
            ),
          ).toBe(true);

          const approval = await agent.approveSpec(presentation);
          expect(isOk(approval)).toBe(true);
          if (isOk(approval)) {
            expect(approval.value.approved).toBe(true);
            expect(approval.value.moduleInterface.ports.every((port) => port.width > 0)).toBe(true);
          }
          return;
        }

        // At least one malformed port: never approvable, every offender named.
        expect(presentation.status).toBe('needs-revision');
        if (presentation.status !== 'needs-revision') {
          throw new Error('expected needs-revision when an interface signal is malformed');
        }
        const presentedNames = presentation.issues.signalIssues.map((issue) => issue.signalName);
        // One issue per offending port; the module and criteria are always well-formed.
        expect(presentation.issues.signalIssues).toHaveLength(offenders.length);
        expect(presentation.issues.unmeasurableCriteria).toHaveLength(0);
        for (const { port, index } of offenders) {
          expect(presentedNames).toContain(labelFor(port, index));
        }

        // approveSpec must refuse and return the same offenders, never an approved Spec.
        const approval = await agent.approveSpec(presentation);
        expect(isErr(approval)).toBe(true);
        if (isErr(approval)) {
          const rejectedNames = approval.error.signalIssues.map((issue) => issue.signalName);
          for (const { port, index } of offenders) {
            expect(rejectedNames).toContain(labelFor(port, index));
          }
        }
      }),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 15 tag is asserted, not only written in a
// comment: `Feature: hdl-creation-loop, Property 15: Spec approval requires positive-width ports`.
describe('Property 15 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(propertyTag(15, 'Spec approval requires positive-width ports')).toBe(
      'Feature: hdl-creation-loop, Property 15: Spec approval requires positive-width ports',
    );
  });
});
