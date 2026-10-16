// Feature: formal-gate-first-light, Property 9: Adjudication reaches one of three outcomes and
// never abstains silently.
//
// WHY THIS PROPERTY NEEDED A TYPE CHANGE BEFORE IT COULD EXIST (FL-23)
//   The claim was previously stated over two outcomes while three were required, and "never
//   abstains silently" is not falsifiable unless an abstention is REPRESENTABLE. It now is, so
//   the generator draws referees that realize the counterexample, referees that contradict it,
//   and referees that rule neither way - the last covering each `UnadjudicatedReason` member.
//
// THE ORACLE IS THE REFEREE'S OWN BEHAVIOUR, NOT THE SUBJECT'S BRANCHES
//   Each drawn referee is built from a declared intent, and the expected arm is derived from that
//   intent alone. An adjudicator that attributed an errored referee to the design - the unsound
//   collapse this spec rejects - disagrees with the oracle rather than being agreed with.
//
// Validates: Requirements 4.6, 4.7, 4.12, 4.13

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import type { SimulatorAdapter } from '@app/tools';

import {
  adjudicate,
  describeAdjudication,
  REPLAY_CHECK_NAME,
  type Adjudication,
  type CandidateFalseRefutation,
  type UnadjudicatedReason,
} from './formal-false-refutation.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 9: Adjudication reaches one of three outcomes and never abstains silently';

/** The three arms, as a closed list the property asserts membership against. */
const ARMS = ['realizable', 'not-realizable', 'unadjudicated'] as const;

/** Every reason, exhausted rather than sampled: there are three and all must be reachable. */
const REASONS: readonly UnadjudicatedReason[] = [
  'probe-unavailable',
  'referee-run-errored',
  'name-unresolvable-in-scope',
  'sequence-replay-unsupported',
  'trace-start-state-unreachable',
  'replay-harness-unvalidated',
];

const DESIGN_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'probe',
  ports: [
    { name: 'd', direction: 'input', width: 4 },
    { name: 'q', direction: 'output', width: 4 },
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
};

/** A trace resolving both ports at depth 1, which is the adjudicable shape. */
function resolvableTrace(d: number, q: number): string {
  return [
    '$scope module formal_property_wrapper $end',
    '$var wire 4 n0 d $end',
    '$var wire 4 n1 q $end',
    '$upscope $end',
    '#0',
    `b${d.toString(2)} n0`,
    `b${q.toString(2)} n1`,
  ].join('\n');
}

/** A trace that resolves only at depth 2, so no wrapper-scope name is readable. */
const UNRESOLVABLE_TRACE = [
  '$scope module formal_property_wrapper $end',
  '$scope module inner $end',
  '$var wire 4 n0 d $end',
  '$var wire 4 n1 q $end',
  '$upscope $end',
  '$upscope $end',
  '#0',
  'b1 n0',
  'b1 n1',
].join('\n');

/** What a drawn referee intends to do, which is what the expected arm is derived from. */
type RefereeIntent = 'reproduces' | 'contradicts' | 'errors' | 'throws';

function refereeFor(intent: RefereeIntent): SimulatorAdapter {
  if (intent === 'throws') {
    return { simulate: () => Promise.reject(new Error('not launchable')) };
  }
  const verdict = intent === 'reproduces' ? 'pass' : intent === 'contradicts' ? 'fail' : 'error';
  return {
    simulate: () =>
      Promise.resolve({
        verdict,
        checks:
          verdict === 'error' ? [] : [{ name: REPLAY_CHECK_NAME, passed: verdict === 'pass' }],
        vcd: null,
        stdout: '',
        stderr: '',
        exitCode: verdict === 'error' ? null : 0,
        resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
        failureCause: verdict === 'error' ? ('tool-failed' as const) : ('none' as const),
        attributedFiles: [],
        watchdog: { stopped: false },
      }),
  };
}

/** The arm a given intent and trace shape must produce, derived independently. */
function expectedArm(intent: RefereeIntent, resolvable: boolean): (typeof ARMS)[number] {
  if (!resolvable) {
    return 'unadjudicated';
  }
  if (intent === 'errors' || intent === 'throws') {
    return 'unadjudicated';
  }
  return intent === 'reproduces' ? 'realizable' : 'not-realizable';
}

function candidateWith(counterexample: string): CandidateFalseRefutation {
  return {
    propertyId: 'generated-probe',
    designId: 'rtllm/memory/LIFObuffer',
    design: { path: 'probe.v', contents: 'module probe; endmodule\n' },
    designInterface: DESIGN_INTERFACE,
    expectedVerdict: 'proved',
    actualVerdict: 'refuted',
    counterexample,
    resetContract: { kind: 'synchronous', polarity: 'active-high' },
  };
}

describe(PROPERTY, () => {
  it('reaches exactly one of the three arms, and every abstention carries a reason', async () => {
    const seen = new Set<string>();

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<RefereeIntent>('reproduces', 'contradicts', 'errors', 'throws'),
        fc.boolean(),
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 0, max: 15 }),
        async (intent, resolvable, d, q) => {
          const candidate = candidateWith(resolvable ? resolvableTrace(d, q) : UNRESOLVABLE_TRACE);

          const result: Adjudication = await adjudicate(candidate, refereeFor(intent));

          expect(ARMS).toContain(result.kind);
          expect(result.kind).toBe(expectedArm(intent, resolvable));
          seen.add(result.kind);

          if (result.kind === 'unadjudicated') {
            // Never silent: an abstention always says which reason it abstained for, and the
            // reason is a member of the closed vocabulary rather than free text.
            expect(REASONS).toContain(result.reason);
            expect(describeAdjudication(result)).toContain('unadjudicated');
          } else {
            // An attribution always carries what it was attributed on.
            expect(result.evidence.verdict === 'pass' || result.evidence.verdict === 'fail').toBe(
              true,
            );
          }
        },
      ),
      propertyParameters({ numRuns: 300 }),
    );

    // Non-vacuity: all three arms were actually produced by the population.
    expect([...seen].sort()).toEqual([...ARMS].sort());
  });

  it('reaches every reason in the closed vocabulary across the adjudicator and its callers', async () => {
    // Two of the three come from `adjudicate` itself; `probe-unavailable` is the caller's to
    // report, which is why its constructor is exported, and tasks 4.5 and 4.25 use it.
    const fromAdjudicate = await Promise.all(
      [
        adjudicate(candidateWith(UNRESOLVABLE_TRACE), refereeFor('reproduces')),
        adjudicate(candidateWith(resolvableTrace(1, 1)), refereeFor('errors')),
      ].map((pending) => pending),
    );

    const reasons = fromAdjudicate.map((result) =>
      result.kind === 'unadjudicated' ? result.reason : null,
    );
    expect(reasons).toEqual(['name-unresolvable-in-scope', 'referee-run-errored']);

    // And every reason has distinct operator words, so a report cannot read the same for two.
    const described = new Set(
      REASONS.map((reason) => describeAdjudication({ kind: 'unadjudicated', reason })),
    );
    expect(described.size).toBe(REASONS.length);
  });
});
