// **Feature: timing-contract-inference, Property 14: Every assembled contract value is sourced from the draft**
//
// THE REGRESSION THIS GUARDS
//   Task 8.7 deleted `assembleTimingContract`, the fabrication that mapped every declared output
//   port to `registered` regardless of what the draft said. `assembleSpec` now reads
//   `core.timingContract` straight from the validated draft (Req 4.4, 4.5, 4.11). This property
//   drives `SpecAgent.presentDraft` directly - no model call - over a draft whose timing entries
//   cover every declared output port, and checks the assembled Spec's contract is exactly those
//   entries, in the draft's own order.
//
// WHY THE FORCED PAIR, NOT LEFT TO CHANCE
//   A draft that happens to draw all-`registered` cannot distinguish "sourced from the draft" from
//   "fabricated all-registered": both produce the same contract. So every draw forces one port
//   index to `combinational` and a different index to `registered` by construction, guaranteeing a
//   mixed draft every run. The decisive assertion - the contract is not all-`registered` - is its
//   own `expect`, separate from the entry-equality check, so a reintroduced fabrication fails this
//   specific line rather than hiding inside a broader comparison.
//
// GENERATOR OBLIGATIONS
//   2-5 declared output ports, entries covering all of them (a permutation of the full index
//   range, so every port is stated exactly once), with a forced registered/combinational pair.
//   The forced pair makes every draw mixed; mixed draws are counted and required non-zero so the
//   coverage claim is measured rather than assumed.
//
// Validates: Requirements 4.4, 4.5, 4.11

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemoryTracePersistence,
  SpecAgent,
  TraceActionRecorder,
  type AcceptanceCriterionDraft,
  type ModelRouter,
  type ModelRouterFailure,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SpecDraft,
  type SpecRevisionContext,
  type TimingContractEntryDraft,
} from '@app/agent';
import { newUlid, type PortTiming, type Result } from '@app/core';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'timing-contract-inference, Property 14: Every assembled contract value is sourced from the draft';

const TIMINGS: readonly PortTiming[] = ['registered', 'combinational'];
const RIGOROUS_METHODS: readonly ['simulation', 'formal', 'manual-inspection'] = [
  'simulation',
  'formal',
  'manual-inspection',
];

/** One element of a generated array, failing loudly rather than widening to `undefined`. */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`the generator produced no element at index ${index}`);
  }
  return value;
}

/** An identifier drawn from an explicit ASCII alphabet, always non-empty. */
function identifierArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 1, 8);
}

/** `count` unique output port names. */
function outputNamesArbitrary(count: number): fc.Arbitrary<string[]> {
  return fc.uniqueArray(identifierArbitrary(), { minLength: count, maxLength: count });
}

/** A permutation of `[0, count)`, so the draft's entries cover every port exactly once. */
function permutationArbitrary(count: number): fc.Arbitrary<number[]> {
  return fc.shuffledSubarray([...Array(count).keys()], { minLength: count, maxLength: count });
}

/** Two distinct indices of `[0, count)`, forced to opposite timings below. */
function forcedPairArbitrary(count: number): fc.Arbitrary<number[]> {
  return fc.shuffledSubarray([...Array(count).keys()], { minLength: 2, maxLength: 2 });
}

/** Everything about one draw before the mix is forced onto it. */
interface Draw {
  readonly moduleName: string;
  readonly outputNames: readonly string[];
  readonly widths: readonly number[];
  readonly drawnTimings: readonly PortTiming[];
  readonly forcedPair: readonly number[];
  readonly entryOrder: readonly number[];
  readonly goal: string;
  readonly architecture: string;
  readonly criterionText: string;
  readonly criterionMethod: 'simulation' | 'formal' | 'manual-inspection';
}

/** Each port's final timing: `drawnTimings`, with the forced pair pinned to opposite values. */
function finalTimings(draw: Draw): readonly PortTiming[] {
  const timings = [...draw.drawnTimings];
  timings[at(draw.forcedPair, 0)] = 'combinational';
  timings[at(draw.forcedPair, 1)] = 'registered';
  return timings;
}

/** The draft the draw describes, plus the exact entries it states (for the equality check). */
function draftFor(draw: Draw): { draft: SpecDraft; entries: readonly TimingContractEntryDraft[] } {
  const timings = finalTimings(draw);
  const entries: TimingContractEntryDraft[] = draw.entryOrder.map((index) => ({
    portName: at(draw.outputNames, index),
    timing: at(timings, index),
  }));
  const ports = draw.outputNames.map((name, index) => ({
    name,
    direction: 'output',
    width: at(draw.widths, index),
  }));
  const criterion: AcceptanceCriterionDraft = {
    text: draw.criterionText,
    measurable: true,
    method: draw.criterionMethod,
  };
  const draft: SpecDraft = {
    goal: draw.goal,
    constraints: [],
    moduleInterface: {
      moduleName: draw.moduleName,
      ports,
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
    },
    timingContractEntries: entries,
    acceptanceCriteria: [criterion],
    architecture: draw.architecture,
  };
  return { draft, entries };
}

function drawArbitrary(): fc.Arbitrary<Draw> {
  return fc.integer({ min: 2, max: 5 }).chain((count) =>
    fc.record<Draw>({
      moduleName: identifierArbitrary(),
      outputNames: outputNamesArbitrary(count),
      widths: fc.array(fc.integer({ min: 1, max: 64 }), { minLength: count, maxLength: count }),
      drawnTimings: fc.array(fc.constantFrom(...TIMINGS), { minLength: count, maxLength: count }),
      forcedPair: forcedPairArbitrary(count),
      entryOrder: permutationArbitrary(count),
      goal: stringFromChars(ASCII_IDENT_CHARS, 3, 20),
      architecture: stringFromChars(ASCII_IDENT_CHARS, 3, 20),
      criterionText: stringFromChars(ASCII_IDENT_CHARS, 3, 20),
      criterionMethod: fc.constantFrom(...RIGOROUS_METHODS),
    }),
  );
}

/** A router that is never invoked: `presentDraft` is pure and model-free. */
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

/** A revision context for driving `presentDraft` directly. */
function freshContext(): SpecRevisionContext {
  return { sessionId: newUlid(), projectId: newUlid(), specId: newUlid(), version: 1 };
}

describe(PROPERTY, () => {
  it('assembles the contract from exactly the draft stated entries, never the fabricated all-registered one', () => {
    const coverage = { mixed: 0 };

    fc.assert(
      fc.property(drawArbitrary(), (draw) => {
        const { draft, entries } = draftFor(draw);
        const presentation = freshAgent().presentDraft(freshContext(), draft);

        expect(presentation.status).toBe('awaiting-approval');
        if (presentation.status !== 'awaiting-approval') {
          throw new Error('expected awaiting-approval: every declared output port is stated');
        }

        const assembledEntries = presentation.spec.timingContract.entries;
        // Entry for entry, exactly the draft's own statements, in the draft's own order.
        expect(assembledEntries).toEqual(entries);

        const timingsSeen = new Set(assembledEntries.map((entry) => entry.timing));
        if (timingsSeen.size > 1) coverage.mixed += 1;

        // THE DECISIVE CLAUSE: the draft always states at least one combinational entry (the
        // forced pair), so the assembled contract can never be the fabricated all-registered one.
        expect(assembledEntries.every((entry) => entry.timing === 'registered')).toBe(false);
      }),
      propertyParameters(),
    );

    // NON-VACUITY: without a mixed draw, the decisive clause above proves nothing about sourcing
    // versus fabrication - both would happen to produce the same contract.
    expect(coverage.mixed).toBeGreaterThan(0);
  });
});
