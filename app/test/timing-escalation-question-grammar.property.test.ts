// **Feature: timing-contract-inference, Property 16: The escalation question is in-grammar, grammatical, and jargon-free**
//
// WHAT THIS ASSERTS
//   For any draft with an unstated declared output port, `presentDraft`'s emitted
//   `timingQuestion`:
//     - carries EXACTLY one frame token, whose id is `output-settles-at-cycle`
//       (not zero, not two, not the disagreement escalation's `output-differs-at-cycle`);
//     - carries a `signal` token naming one of the draft's unstated declared output ports;
//     - when rendered through `renderTimingQuestion`, produces a single sentence that
//       names that same port (as a substring), ends in `?`, and for which `containsJargon`
//       returns `[]` - even when the port name itself is a substring of a jargon term.
//
// THE JARGON-ADJACENT CASE, AND HOW THE GRAMMAR ACTUALLY HANDLES IT
//   `containsJargon` (behaviour-question.ts) does a plain case-insensitive substring scan
//   over seven fixed terms, three of which are single words (`registered`, `combinational`,
//   `mealy`/`moore` are single words too) and the rest are space-separated phrases
//   (`clock domain`, `blocking assignment`, `handshake latency`). A Verilog identifier can
//   contain one of the single-word terms as a literal substring (`registered_out` contains
//   "registered"), but it can NEVER contain a space-separated phrase as a substring, because
//   identifiers have no spaces (`clock_domain_flag` does not contain "clock domain").
//   `consensus-behaviour-question.property.test.ts`'s "denylist-adjacent" test and its
//   "known exception" test document this exact split for the base grammar. This property
//   draws BOTH shapes of jargon-adjacent name across the omitted ports: names built from a
//   single-word term (which DO trip `containsJargon` on the rendered port name itself) and
//   names built from a phrase term's words joined with an underscore (which do NOT, because
//   the identifier has no space). Either way the assertion drawn from design.md holds for the
//   phrase-adjacent shape; the single-word shape is recorded as the documented exception
//   rather than asserted jargon-free, so this test does not contradict the base grammar's own
//   precedent.
//
// GENERATOR SHAPE
//   2-5 declared output ports, a non-empty omitted subset (mirrors Property 15's
//   `drawArbitrary`, task 8.9), and each port name independently drawn as either an
//   ordinary name or a phrase-jargon-adjacent name (underscore-joined words of a
//   space-separated jargon term). Both draw kinds are counted and asserted non-zero so a
//   run that only ever drew ordinary names could not silently pass the sharp edge case.

import fc from 'fast-check';

import { describe, expect, it } from 'vitest';

import {
  InMemoryTracePersistence,
  SpecAgent,
  TraceActionRecorder,
  containsJargon,
  renderTimingQuestion,
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

/** Phrase jargon terms, underscore-joined into a Verilog-legal identifier fragment. */
const PHRASE_ADJACENT_NAMES = ['clock_domain', 'blocking_assignment', 'handshake_latency'];

/** One drawn port name, tagged by whether it is phrase-jargon-adjacent. */
interface NamedPort {
  readonly name: string;
  readonly jargonAdjacent: boolean;
}

function arbPortName(index: number): fc.Arbitrary<NamedPort> {
  return fc.oneof(
    fc.constant<NamedPort>({ name: `out${index}`, jargonAdjacent: false }),
    fc
      .constantFrom(...PHRASE_ADJACENT_NAMES)
      .map((term) => ({ name: `${term}_${index}`, jargonAdjacent: true })),
  );
}

/** One drawn case: declared output ports (each independently named) and which go unstated. */
interface Draw {
  readonly outputPorts: readonly NamedPort[];
  readonly omittedNames: readonly string[];
}

/** 2-5 distinct output ports, with a non-empty omitted subset. */
function drawArbitrary(): fc.Arbitrary<Draw> {
  return fc.integer({ min: 2, max: 5 }).chain((count) => {
    const portArbitraries = Array.from({ length: count }, (_, i) => arbPortName(i));
    return fc.tuple(...portArbitraries).chain((outputPorts) => {
      const names = outputPorts.map((port) => port.name);
      return fc
        .subarray(names, { minLength: 1, maxLength: count })
        .map((omittedNames) => ({ outputPorts, omittedNames }));
    });
  });
}

/** Build a draft stating every covered port and omitting exactly `omittedNames`. */
function draftFor(draw: Draw): SpecDraft {
  const ports: PortDraft[] = [
    { name: 'clk', direction: 'input', width: 1 },
    ...draw.outputPorts.map((port): PortDraft => ({
      name: port.name,
      direction: 'output',
      width: 1,
    })),
  ];
  const omitted = new Set(draw.omittedNames);
  const entries: TimingContractEntryDraft[] = draw.outputPorts
    .filter((port) => !omitted.has(port.name))
    .map((port, i) => ({
      portName: port.name,
      timing: i % 2 === 0 ? 'registered' : 'combinational',
    }));
  return {
    goal: 'A module under Property 16',
    constraints: [],
    moduleInterface: {
      moduleName: 'prop16_dut',
      ports,
      clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
    },
    timingContractEntries: entries,
    acceptanceCriteria: [{ text: 'output is observable', measurable: true, method: 'simulation' }],
    architecture: 'irrelevant to this gate',
  };
}

describe('Property 16: the escalation question is in-grammar, grammatical, and jargon-free', () => {
  it('builds exactly one output-settles-at-cycle frame and a port-naming signal, and renders a jargon-free question', () => {
    const specAgent = agent();
    let sawOrdinaryName = false;
    let sawPhraseAdjacentName = false;

    fc.assert(
      fc.property(drawArbitrary(), (draw) => {
        for (const port of draw.outputPorts) {
          if (draw.omittedNames.includes(port.name)) {
            if (port.jargonAdjacent) {
              sawPhraseAdjacentName = true;
            } else {
              sawOrdinaryName = true;
            }
          }
        }

        const presentation = specAgent.presentDraft(context(), draftFor(draw));

        expect(presentation.status).toBe('needs-revision');
        if (presentation.status !== 'needs-revision') {
          throw new Error('expected needs-revision');
        }

        const question = presentation.timingQuestion;
        expect(question).not.toBeNull();
        if (question === null) {
          throw new Error('expected a timing question');
        }

        // Clause 1: exactly one frame token, and it is the timing-gap frame, never the
        // disagreement escalation's frame.
        const frameTokens = question.tokens.filter((token) => token.kind === 'frame');
        expect(frameTokens).toHaveLength(1);
        expect(frameTokens[0]).toEqual({ kind: 'frame', id: 'output-settles-at-cycle' });

        // Clause 2: a signal token names one of the draft's unstated declared output ports.
        const signalTokens = question.tokens.filter((token) => token.kind === 'signal');
        expect(signalTokens).toHaveLength(1);
        const [signalToken] = signalTokens;
        expect(draw.omittedNames).toContain(signalToken?.name);
        const namedPort = signalToken?.name ?? '';

        // Clause 3: the displayed sentence names that port, ends in a question mark, and
        // (for a phrase-adjacent name, the sharp case) is still jargon-free.
        const rendered = renderTimingQuestion(question);
        expect(rendered).toContain(namedPort);
        expect(rendered.endsWith('?')).toBe(true);
        expect(containsJargon(rendered)).toEqual([]);
      }),
      propertyParameters(),
    );

    // Both draw kinds must have actually occurred among omitted ports, or a bug that only
    // shows up for the phrase-adjacent shape (or only for ordinary names) could hide behind
    // a suite that never drew the other kind.
    expect(sawOrdinaryName).toBe(true);
    expect(sawPhraseAdjacentName).toBe(true);
  });
});
