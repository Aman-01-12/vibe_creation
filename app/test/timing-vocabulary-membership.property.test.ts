// **Feature: timing-contract-inference, Property 23: An out-of-vocabulary timing value is refused, never coerced**
//
// THE CLAIM IS A BICONDITIONAL
//   `validateSpecDraft` accepts a `timing` string EXACTLY when it is one of the two closed
//   `PortTiming` members. Both directions are asserted on every draw: an in-vocabulary value is
//   accepted AND arrives in the contract as that same value, and any other string refuses the
//   draft with an issue naming the offending PORT. One direction alone would be satisfied by a
//   validator that refuses everything, or by one that accepts everything.
//
// WHY THE PROTOTYPE-CHAIN NAMES ARE THE SHARP CASE
//   Membership is decided by `isPortTiming`, which is `Set.has`. A `Record<PortTiming, ...>` index
//   stringifies the key and walks the prototype chain, so `__proto__`, `constructor`, and
//   `toString` would all read as real members under that implementation (Req 10.6). They are drawn
//   as timing VALUES and also as PORT names, because the declared-output lookup is a `Set` for the
//   same reason and a port literally named `__proto__` must still be found through its own entry.
//
// NO COERCION, ASSERTED AS A SHAPE
//   A refused draft returns the error arm and carries no `ValidatedSpecCore`, so the result has no
//   `value` member at all (Req 10.4). That is checked structurally rather than by inspecting a
//   contract that should not exist: there is then no path on which an unreadable value becomes a
//   contract entry.
//
// GENERATOR OBLIGATIONS
//   Drawn timing strings cover both vocabulary members, the three prototype-chain names, case
//   variants (`Registered`), whitespace variants (`'registered '`, which must be refused because
//   the validator does not trim), the empty string, and free text. In- and out-of-vocabulary draws
//   are counted and both required non-zero, as are prototype-chain draws in both positions. The
//   decisive shapes are a closed table and are EXHAUSTED as a cross product on every run, so they
//   are graded by every seed rather than when a draw obliges.
//
//   THE EMPTY STRING CANNOT REACH VALIDATION THROUGH THE PARSER: `parseTimingContractEntry` reads
//   `timing` with `readNonEmptyString`, which refuses an empty or whitespace-only string. It is
//   drawn anyway because validation is the trust boundary and must refuse it on its own, whatever
//   the parser ahead of it does. `'registered '` by contrast does survive the parse, since that
//   reader tests emptiness after trimming but returns the untrimmed string.
//
// Validates: Requirements 10.2, 10.3, 10.4, 10.6

import { validateSpecDraft, type SpecDraft } from '@app/agent';
import { newUlid } from '@app/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LOWER_ALPHA, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'timing-contract-inference, Property 23: An out-of-vocabulary timing value is refused, never coerced';

/** The two closed `PortTiming` members, which are the whole accepted vocabulary. */
const IN_VOCABULARY: readonly string[] = ['registered', 'combinational'];

/** The names a record-index membership check would read through the prototype chain. */
const PROTOTYPE_CHAIN_NAMES: readonly string[] = ['__proto__', 'constructor', 'toString'];

/**
 * Strings outside the vocabulary that a coercing validator would most plausibly admit.
 *
 * The case and whitespace variants differ from a member by one transformation each, so they pin
 * that nothing lower-cases and nothing trims; the empty string pins that absence is not a member.
 */
const OUT_OF_VOCABULARY: readonly string[] = [
  ...PROTOTYPE_CHAIN_NAMES,
  'Registered',
  'COMBINATIONAL',
  'registered ',
  ' combinational',
  '',
  'registeredd',
  'latched on clk',
];

/** Output port names, including the three a record-keyed contract would mishandle. */
const PORT_NAMES: readonly string[] = ['q', 'sum', ...PROTOTYPE_CHAIN_NAMES];

/** A draft whose interface and criteria both pass, so only the timing value can reject it. */
function buildDraft(portName: string, timing: string): SpecDraft {
  return {
    goal: 'a 4-bit synchronous up counter',
    constraints: [],
    architecture: 'one clocked always block updates the output on each rising clk edge',
    moduleInterface: {
      moduleName: 'counter',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: portName, direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
    },
    timingContractEntries: [{ portName, timing }],
    acceptanceCriteria: [
      { text: 'the output settles as stated', measurable: true, method: 'simulation' },
    ],
  };
}

/** The draw shapes without which a clause of this property would go unexercised. */
interface Coverage {
  inVocabulary: number;
  outOfVocabulary: number;
  prototypeTiming: number;
  prototypePortName: number;
}

/** Record one draw's shape against the coverage counters. */
function countDraw(coverage: Coverage, portName: string, timing: string): void {
  if (IN_VOCABULARY.includes(timing)) {
    coverage.inVocabulary += 1;
  } else {
    coverage.outOfVocabulary += 1;
  }
  if (PROTOTYPE_CHAIN_NAMES.includes(timing)) {
    coverage.prototypeTiming += 1;
  }
  if (PROTOTYPE_CHAIN_NAMES.includes(portName)) {
    coverage.prototypePortName += 1;
  }
}

/** The accepted direction: the value reaches the contract as itself, for that port. */
function assertAccepted(result: ReturnType<typeof validateSpecDraft>, draft: SpecDraft): void {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('expected a validated core');
  }
  expect(result.value.timingContract).toStrictEqual({ entries: draft.timingContractEntries });
}

/** The refused direction: an issue naming the port, no unstated question, and no core. */
function assertRefused(
  result: ReturnType<typeof validateSpecDraft>,
  portName: string,
  timing: string,
): void {
  expect(result.ok).toBe(false);
  // No-coercion as a shape: the error arm carries no `ValidatedSpecCore` to coerce into.
  expect(Object.hasOwn(result, 'value')).toBe(false);
  if (result.ok) {
    throw new Error('expected a refusal');
  }
  expect(result.error.signalIssues).toHaveLength(1);
  expect(result.error.signalIssues[0]?.signalName).toBe(portName);
  // Quoted, so the empty-string draw asserts something rather than passing vacuously.
  expect(result.error.signalIssues[0]?.reason).toContain(`"${timing}"`);
  // Stated-but-inadmissible is a mistake to fix, so the port is not also an open question.
  expect(result.error.timingUnstated).toEqual([]);
}

/** Validate one port-and-timing pair and grade whichever direction of the claim it falls in. */
function assertMembershipDecidesOutcome(
  portName: string,
  timing: string,
  coverage: Coverage,
): void {
  const draft = buildDraft(portName, timing);
  const result = validateSpecDraft(draft, newUlid);

  if (IN_VOCABULARY.includes(timing)) {
    assertAccepted(result, draft);
  } else {
    assertRefused(result, portName, timing);
  }

  countDraw(coverage, portName, timing);
}

/** An output port name: the decisive pool, plus free identifiers kept distinct from `clk`. */
function portNameArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constantFrom(...PORT_NAMES),
    stringFromChars(LOWER_ALPHA, 1, 5).map((tail) => `o_${tail}`),
  );
}

/** A timing string: both members, the near misses, and free text that is plainly neither. */
function timingArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constantFrom(...IN_VOCABULARY),
    fc.constantFrom(...OUT_OF_VOCABULARY),
    stringFromChars(LOWER_ALPHA, 0, 8),
  );
}

describe(PROPERTY, () => {
  it('accepts a timing value exactly when it is a closed vocabulary member', () => {
    const coverage: Coverage = {
      inVocabulary: 0,
      outOfVocabulary: 0,
      prototypeTiming: 0,
      prototypePortName: 0,
    };

    fc.assert(
      fc.property(portNameArbitrary(), timingArbitrary(), (portName, timing) => {
        assertMembershipDecidesOutcome(portName, timing, coverage);
      }),
      propertyParameters(),
    );

    // Every decisive port name against every decisive timing value, on every run.
    for (const portName of PORT_NAMES) {
      for (const timing of [...IN_VOCABULARY, ...OUT_OF_VOCABULARY]) {
        assertMembershipDecidesOutcome(portName, timing, coverage);
      }
    }

    // NON-VACUITY: one direction alone proves nothing, and the prototype-chain clause is the
    // reason membership is `Set.has` in both the vocabulary check and the port lookup.
    expect({
      inVocabulary: coverage.inVocabulary > 0,
      outOfVocabulary: coverage.outOfVocabulary > 0,
      prototypeTiming: coverage.prototypeTiming > 0,
      prototypePortName: coverage.prototypePortName > 0,
    }).toEqual({
      inVocabulary: true,
      outOfVocabulary: true,
      prototypeTiming: true,
      prototypePortName: true,
    });
  });
});
