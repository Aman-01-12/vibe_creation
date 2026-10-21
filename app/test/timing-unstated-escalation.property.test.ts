// **Feature: timing-contract-inference, Property 15: An unstated port escalates, naming every unstated port**
//
// WHAT THIS ASSERTS
//   For a draft that omits a non-empty PROPER SUBSET of its declared output ports from
//   `timingContractEntries` (every other output port covered by a valid, in-vocabulary
//   statement), `presentDraft` always:
//     - returns `needs-revision`, never `awaiting-approval` - no Spec is assembled;
//     - sets `issues.timingUnstated` to EXACTLY the omitted port name set (same elements,
//       same count - not a prefix, not a superset, not just the first);
//     - leaves `issues.signalIssues` free of anything attributable to the omission, matching
//       task 8.4's own documented split: an absent statement is a question to ask, not a
//       mistake to list;
//     - returns a non-null `timingQuestion` whose lone `signal` token names one of the
//       unstated ports, specifically the one `buildTimingQuestion` picks (its own first
//       element of the `unstatedPorts` list it is handed, per the source read for this task).
//
//   Covered ports are given alternating `registered`/`combinational` statements so the
//   draft's only fault is the omission itself - never a bad value, never a non-output entry.
//
// GENERATOR SHAPE
//   3-6 declared output ports (plus one `clk` input, irrelevant to the timing gate), and an
//   omitted subset drawn from `fc.subarray` over size 1..(count - 1) so the omission is always
//   a genuine proper subset: never empty (that is Property 14's shape, task 8.8) and never
//   total (every port covered has nothing left to escalate). The covered/omitted partition is
//   counted across runs and asserted non-zero for BOTH the single-omission and the
//   multi-omission arm, so a run that only ever omitted one port could not silently pass a
//   superset-naming bug.

import fc from 'fast-check';

import { describe, expect, it } from 'vitest';

import {
  InMemoryTracePersistence,
  SpecAgent,
  TraceActionRecorder,
  type ModelRouter,
  type ModelRouterFailure,
  type PortDraft,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SpecDraft,
  type SpecRevisionContext,
  type TimingContractEntryDraft,
} from '@app/agent';
import { newUlid, type Result } from '@app/core';

import { propertyParameters } from './property.js';

/** A Model_Router this property never calls: `presentDraft` is the pure, model-free core. */
class UnusedModelRouter implements ModelRouter {
  invoke(): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    throw new Error('presentDraft must not call the Model_Router');
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

function agent(): SpecAgent {
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  return new SpecAgent({ router: new UnusedModelRouter(), recorder, now: () => 1_700_000_000_000 });
}

function context(): SpecRevisionContext {
  return { sessionId: newUlid(), projectId: newUlid(), specId: newUlid(), version: 1 };
}

/** One drawn case: the declared output port names and which of them go unstated. */
interface Draw {
  readonly outputPortNames: readonly string[];
  readonly omittedNames: readonly string[];
}

/** 3-6 distinct output port names, with a non-empty, non-total omitted subset. */
function drawArbitrary(): fc.Arbitrary<Draw> {
  return fc.integer({ min: 3, max: 6 }).chain((count) => {
    const outputPortNames = Array.from({ length: count }, (_, i) => `out${i}`);
    return fc
      .subarray(outputPortNames, { minLength: 1, maxLength: count - 1 })
      .map((omittedNames) => ({ outputPortNames, omittedNames }));
  });
}

/** Build a draft stating every covered port and omitting exactly `omittedNames`. */
function draftFor(draw: Draw): SpecDraft {
  const ports: PortDraft[] = [
    { name: 'clk', direction: 'input', width: 1 },
    ...draw.outputPortNames.map((name): PortDraft => ({ name, direction: 'output', width: 1 })),
  ];
  const omitted = new Set(draw.omittedNames);
  const entries: TimingContractEntryDraft[] = draw.outputPortNames
    .filter((name) => !omitted.has(name))
    .map((name, i) => ({ portName: name, timing: i % 2 === 0 ? 'registered' : 'combinational' }));
  return {
    goal: 'A module under Property 15',
    constraints: [],
    moduleInterface: {
      moduleName: 'prop15_dut',
      ports,
      clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
    },
    timingContractEntries: entries,
    acceptanceCriteria: [{ text: 'output is observable', measurable: true, method: 'simulation' }],
    architecture: 'irrelevant to this gate',
  };
}

describe('Property 15: an unstated port escalates, naming every unstated port', () => {
  it('names exactly the omitted ports and never assembles a Spec', () => {
    const specAgent = agent();
    let sawSingleOmission = false;
    let sawMultiOmission = false;

    fc.assert(
      fc.property(drawArbitrary(), (draw) => {
        if (draw.omittedNames.length === 1) {
          sawSingleOmission = true;
        } else {
          sawMultiOmission = true;
        }

        const presentation = specAgent.presentDraft(context(), draftFor(draw));

        expect(presentation.status).toBe('needs-revision');
        if (presentation.status !== 'needs-revision') {
          throw new Error('expected needs-revision');
        }

        // Exact set equality: same elements, same count. Guards both a dropped
        // omission and a spuriously added one.
        expect(new Set(presentation.issues.timingUnstated)).toEqual(new Set(draw.omittedNames));
        expect(presentation.issues.timingUnstated).toHaveLength(draw.omittedNames.length);

        // The omission is a question, never a listed mistake (task 8.4's split).
        expect(presentation.issues.signalIssues).toEqual([]);

        // `buildTimingQuestion` asks about `unstatedPorts[0]` - the first omitted port in
        // the draft's own output-port declaration order, which `timingUnstated` preserves
        // (validation.ts filters `outputNames` in that order).
        const expectedSignal = draw.outputPortNames.find((name) =>
          draw.omittedNames.includes(name),
        );
        expect(presentation.timingQuestion).not.toBeNull();
        expect(presentation.timingQuestion?.tokens[0]).toEqual({
          kind: 'signal',
          name: expectedSignal,
        });
      }),
      propertyParameters(),
    );

    // Both arms must have actually run, or a superset-naming bug in the single-omission
    // case could hide behind a suite that only ever drew multi-omission cases (or vice versa).
    expect(sawSingleOmission).toBe(true);
    expect(sawMultiOmission).toBe(true);
  });
});
