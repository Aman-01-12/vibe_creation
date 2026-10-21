// **Feature: timing-contract-inference, Property 13: The draft entry list survives the parse unchanged**
//
// THE CLAIM: A ROUND TRIP THROUGH THE MODEL-OUTPUT SHAPE
//   A list of timing entry drafts is rendered into the JSON a model would emit, parsed with
//   `parseSpecDraft`, and compared against the list it started from. Array equality is
//   order-sensitive, so the same assertion carries "same entries" and "same order".
//
// WHY THE OUT-OF-VOCABULARY CLAUSE IS THE POINT
//   `parse.ts` checks SHAPE ONLY and leaves `timing` an arbitrary non-empty string, because
//   `validateSpecDraft` is the component that reports student-facing issues and must be the one
//   to see the bad value. A parser that dropped or narrowed an out-of-vocabulary `timing` would
//   turn a reportable issue into an invisible parse failure, so this property proves the parser
//   is a faithful carrier rather than a filter.
//
// WHAT THE ENVELOPE IS FOR
//   `parseSpecDraft` only reaches this field once the rest of the draft is well-formed, so the
//   surrounding draft is a constant and only `timingContractEntries` varies: a failure is then
//   attributable to the field under test and not to the envelope.
//
// GENERATOR OBLIGATIONS
//   Empty-list, out-of-vocabulary, in-vocabulary, duplicate-`portName`, and multi-entry draws are
//   each counted and each required non-zero, since an all-valid run would not exercise the clause
//   this property exists for. The decisive shapes are a closed table and are EXHAUSTED alongside
//   the generated draws, so each is graded on every run rather than when the seed obliges.
//
// Validates: Requirements 4.3, 4.2

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseSpecDraft, type SpecDraft, type TimingContractEntryDraft } from '@app/agent';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'timing-contract-inference, Property 13: The draft entry list survives the parse unchanged';

/** The closed `PortTiming` vocabulary that validation, not the parser, checks against. */
const IN_VOCABULARY: readonly string[] = ['registered', 'combinational'];

/**
 * Non-empty `timing` strings outside that vocabulary.
 *
 * `__proto__`, `constructor`, and `toString` are here because a downstream membership check
 * written as a record index would answer "known" for all three. `'registered '` differs from a
 * vocabulary member only by a trailing space, so it also pins that the parser does not trim.
 */
const OUT_OF_VOCABULARY: readonly string[] = [
  '__proto__',
  'constructor',
  'toString',
  'registered ',
  'Registered',
  'eventually maybe',
  'latched on clk',
];

/** A small port-name pool, so a duplicate `portName` arises from an ordinary draw. */
const PORT_NAMES: readonly string[] = ['q', 'sum', 'o_a', '__proto__'];

/** The rest of a well-formed draft, held constant so the parse reaches the field under test. */
const ENVELOPE: Omit<SpecDraft, 'timingContractEntries'> = {
  goal: 'A 4-bit synchronous up counter',
  constraints: ['synchronous active-high reset'],
  architecture: 'A single clocked always block increments q on each rising clk edge.',
  moduleInterface: {
    moduleName: 'counter',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'rst', direction: 'input', width: 1 },
      { name: 'q', direction: 'output', width: 4 },
    ],
    clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
  },
  acceptanceCriteria: [
    {
      text: 'q increments by one on each clock while not in reset',
      measurable: true,
      method: 'simulation',
    },
  ],
};

/** The model-output JSON a model would emit for `entries` inside that envelope. */
function renderModelOutput(entries: readonly TimingContractEntryDraft[]): string {
  return JSON.stringify({ ...ENVELOPE, timingContractEntries: entries });
}

/** The draw shapes that keep each clause of this property from going unexercised. */
interface Coverage {
  empty: number;
  outOfVocabulary: number;
  inVocabulary: number;
  duplicatePortName: number;
  multiEntry: number;
}

/** Record one drawn list's shape against the coverage counters. */
function countDraw(coverage: Coverage, entries: readonly TimingContractEntryDraft[]): void {
  if (entries.length === 0) {
    coverage.empty += 1;
  }
  if (entries.length > 1) {
    coverage.multiEntry += 1;
  }
  if (entries.some((entry) => IN_VOCABULARY.includes(entry.timing))) {
    coverage.inVocabulary += 1;
  }
  if (entries.some((entry) => !IN_VOCABULARY.includes(entry.timing))) {
    coverage.outOfVocabulary += 1;
  }
  if (new Set(entries.map((entry) => entry.portName)).size < entries.length) {
    coverage.duplicatePortName += 1;
  }
}

/** Render one list, parse it, and assert it came back entry for entry and in order. */
function assertRoundTrip(entries: readonly TimingContractEntryDraft[], coverage: Coverage): void {
  const parsed = parseSpecDraft(renderModelOutput(entries));

  expect(parsed).toStrictEqual({
    ok: true,
    value: { ...ENVELOPE, timingContractEntries: entries },
  });

  countDraw(coverage, entries);
}

/**
 * One drawn entry.
 *
 * Mapped to a plain object because `fc.record` builds null-prototype values, which never
 * strictly equal the literals the parser returns.
 */
function entryArbitrary(): fc.Arbitrary<TimingContractEntryDraft> {
  return fc
    .record({
      portName: fc.oneof(fc.constantFrom(...PORT_NAMES), stringFromChars(ASCII_IDENT_CHARS, 1, 6)),
      timing: fc.oneof(
        fc.constantFrom(...IN_VOCABULARY),
        fc.constantFrom(...OUT_OF_VOCABULARY),
        stringFromChars(ASCII_IDENT_CHARS, 1, 8),
      ),
    })
    .map(({ portName, timing }) => ({ portName, timing }));
}

/** Zero to five entries: the empty list is in range, and several make order observable. */
function entriesArbitrary(): fc.Arbitrary<readonly TimingContractEntryDraft[]> {
  return fc.array(entryArbitrary(), { minLength: 0, maxLength: 5 });
}

/** The closed shapes each clause of this property is about, exhausted on every run. */
const CONSTRUCTED_CASES: readonly (readonly TimingContractEntryDraft[])[] = [
  // The empty list, which must survive as an empty list.
  [],
  // One entry per vocabulary member, so the claim is not only about bad values.
  [
    { portName: 'q', timing: 'registered' },
    { portName: 'sum', timing: 'combinational' },
  ],
  // Every out-of-vocabulary string on its own, including the prototype-chain names.
  ...OUT_OF_VOCABULARY.map((timing) => [{ portName: 'q', timing }]),
  // A duplicate `portName` whose entries differ only by timing: nothing but order tells this
  // list apart from its reverse, so a parser that reordered entries fails here.
  [
    { portName: 'q', timing: 'registered' },
    { portName: 'q', timing: 'combinational' },
  ],
  // In- and out-of-vocabulary interleaved across several entries, with a repeated port name.
  [
    { portName: 'o_a', timing: 'registered' },
    { portName: 'o_b', timing: '__proto__' },
    { portName: 'o_c', timing: 'combinational' },
    { portName: 'o_b', timing: 'latched on clk' },
  ],
];

describe(PROPERTY, () => {
  it('carries every entry list through the parse unchanged, in order', () => {
    const coverage: Coverage = {
      empty: 0,
      outOfVocabulary: 0,
      inVocabulary: 0,
      duplicatePortName: 0,
      multiEntry: 0,
    };

    fc.assert(
      fc.property(entriesArbitrary(), (entries) => {
        assertRoundTrip(entries, coverage);
      }),
      propertyParameters(),
    );

    for (const entries of CONSTRUCTED_CASES) {
      assertRoundTrip(entries, coverage);
    }

    // NON-VACUITY: without an out-of-vocabulary draw the faithful-carrier claim proves nothing,
    // and without the other four shapes the list-level clauses would go untested.
    expect({
      empty: coverage.empty > 0,
      outOfVocabulary: coverage.outOfVocabulary > 0,
      inVocabulary: coverage.inVocabulary > 0,
      duplicatePortName: coverage.duplicatePortName > 0,
      multiEntry: coverage.multiEntry > 0,
    }).toEqual({
      empty: true,
      outOfVocabulary: true,
      inVocabulary: true,
      duplicatePortName: true,
      multiEntry: true,
    });
  });
});
