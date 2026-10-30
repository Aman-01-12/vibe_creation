// stimulus-transaction-structure, Property 15: Refusal totality at the parse boundary, one
// fault, fixed order (task 7.5, C2).
//
// THE CLAIM IS ABOUT ORDER, NOT ONLY REFUSAL
//   `parseRoleDeclaration`'s doc comment (`app/agent/roles/reference-model/parse.ts`) fixes the
//   check order as: no roles array -> too many entries -> malformed entry (including an empty
//   port name) -> out-of-vocabulary role -> duplicate port -> undeclared port -> omitted port.
//   A reply carrying only ONE fault already proves a refusal happens; it says nothing about
//   ORDER. This file injects TWO faults into one reply, for every ordered pair of the six
//   entry-reachable classes (criterion 2.6 names five checks plus criterion 2.10's four
//   envelope-shape faults, of which "too many entries" is the one still reachable alongside a
//   second fault), and asserts the reason returned always names the EARLIER one. "No roles
//   array" is excluded from the pairs: once `roles` is not an array, there is no second fault to
//   embed, so it already has its own single-fault unit coverage in `parse.test.ts`.
//
// WHY EXPLICIT PAIRS, NOT A RANDOM DOUBLE-FAULT DRAW
//   Same reasoning as `consensus-period-constraint-order.property.test.ts`'s task 3.2 property
//   for `periodConstraintFault`: a wide random draw rarely lands on a double failure by chance,
//   so every reachable ordered pair is CONSTRUCTED rather than hoped for, per the vault's
//   recorded rule for a closed-union non-vacuity row:
//   chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md
//   All 15 ordered pairs over the 6 classes are reachable (verified by hand against `parse.ts`'s
//   loop structure below), so all 15 are exhausted here rather than a sample of them.
//
// THE OUT-OF-VOCABULARY PROBE
//   Derived from the live `INPUT_ROLES` constant rather than a guessed string like `'strobe'`,
//   per the vault's other recorded rule:
//   chipAgent/_inbox/gotcha-a-hardcoded-outside-the-vocabulary-literal-stops-being-outside-it-the-moment-the-vocabulary-grows-to-include-it.md
//
// Validates: Requirements 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.10, 2.11

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseReferenceModelDraft } from '@app/agent';
import type { ModuleInterface } from '@app/core';
import { INPUT_ROLES } from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 15: Refusal totality at the parse boundary, one ' +
  'fault, fixed order';

/** The six role-declaration fault classes reachable alongside a second fault, in `parse.ts`'s fixed order. */
type FaultKind =
  | 'too-many-entries'
  | 'malformed-entry'
  | 'out-of-vocabulary'
  | 'duplicate-port'
  | 'undeclared-port'
  | 'omitted-port';

/** The exact refusal reason `parse.ts` returns for each class, so a wrong-reason refusal still fails this test. */
const FAULT_REASON: Record<FaultKind, string> = {
  'too-many-entries':
    'model output carried more role entries than the interface declares input ports',
  'malformed-entry': 'model output had a malformed role entry',
  'out-of-vocabulary': `model output named a role outside {${INPUT_ROLES.join(', ')}}`,
  'duplicate-port': 'model output named one input port twice',
  'undeclared-port': 'model output named a port the interface does not declare',
  'omitted-port': 'model output omitted an input port',
};

/** Outside the Role_Vocabulary no matter how many members it grows to (see the vault link above). */
const OUT_OF_VOCABULARY_ROLE = `${INPUT_ROLES.join('-')}-not-a-role`;

/** One role entry, or a malformed one when `role` is omitted. */
function roleEntry(port: string, role?: string): unknown {
  return role === undefined ? { port } : { port, role };
}

/** Three input ports (a, b, c) and one output; every pair below is built against this one interface. */
const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'm',
  ports: [
    { name: 'a', direction: 'input', width: 1 },
    { name: 'b', direction: 'input', width: 1 },
    { name: 'c', direction: 'input', width: 1 },
    { name: 'out', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

const VALID_FUNCTIONS = [
  { name: 'ece_reset_state', body: "ece_reset_state = 128'd0;" },
  { name: 'ece_next_state', body: 'ece_next_state = s;' },
  { name: 'ece_expect', body: "ece_expect = 1'b0;" },
];

/** One ordered pair of simultaneous faults: `roles` must carry both, and `earlier` must win. */
interface PairCase {
  readonly earlier: FaultKind;
  readonly later: FaultKind;
  readonly roles: unknown;
}

/**
 * All 15 ordered pairs over the 6 reachable classes (C(6,2)), each a `roles` value hand-built so
 * both named faults are genuinely present - not just the earlier one - which is what proves the
 * later fault was skipped rather than merely absent. Every case keeps the interface's 3 input
 * ports (a, b, c) fixed and varies only the role entries.
 */
const PAIR_CASES: readonly PairCase[] = [
  // too-many-entries (4 entries against 3 ports) beats every later class.
  {
    earlier: 'too-many-entries',
    later: 'malformed-entry',
    roles: [roleEntry('a', 'data'), roleEntry('b', 'data'), roleEntry('c', 'data'), roleEntry('a')],
  },
  {
    earlier: 'too-many-entries',
    later: 'out-of-vocabulary',
    roles: [
      roleEntry('a', 'data'),
      roleEntry('b', 'data'),
      roleEntry('c', 'data'),
      roleEntry('a', OUT_OF_VOCABULARY_ROLE),
    ],
  },
  {
    earlier: 'too-many-entries',
    later: 'duplicate-port',
    roles: [
      roleEntry('a', 'data'),
      roleEntry('a', 'enable'),
      roleEntry('b', 'data'),
      roleEntry('c', 'data'),
    ],
  },
  {
    earlier: 'too-many-entries',
    later: 'undeclared-port',
    roles: [
      roleEntry('a', 'data'),
      roleEntry('b', 'data'),
      roleEntry('c', 'data'),
      roleEntry('zz', 'data'),
    ],
  },
  {
    earlier: 'too-many-entries',
    later: 'omitted-port',
    // Four entries all naming 'a': over the 3-port count, and b/c are never named.
    roles: [
      roleEntry('a', 'data'),
      roleEntry('a', 'data'),
      roleEntry('a', 'data'),
      roleEntry('a', 'data'),
    ],
  },
  // malformed-entry (missing `role`) beats every later class.
  {
    earlier: 'malformed-entry',
    later: 'out-of-vocabulary',
    roles: [roleEntry('a'), roleEntry('b', OUT_OF_VOCABULARY_ROLE)],
  },
  {
    earlier: 'malformed-entry',
    later: 'duplicate-port',
    roles: [roleEntry('a'), roleEntry('b', 'data'), roleEntry('b', 'enable')],
  },
  {
    earlier: 'malformed-entry',
    later: 'undeclared-port',
    roles: [roleEntry('a'), roleEntry('zz', 'data')],
  },
  {
    earlier: 'malformed-entry',
    later: 'omitted-port',
    // b and c are never named; the single entry is malformed before omission is ever checked.
    roles: [roleEntry('a')],
  },
  // out-of-vocabulary beats every later class.
  {
    earlier: 'out-of-vocabulary',
    later: 'duplicate-port',
    roles: [roleEntry('a', OUT_OF_VOCABULARY_ROLE), roleEntry('a', 'data')],
  },
  {
    earlier: 'out-of-vocabulary',
    later: 'undeclared-port',
    roles: [roleEntry('a', OUT_OF_VOCABULARY_ROLE), roleEntry('zz', 'data')],
  },
  {
    earlier: 'out-of-vocabulary',
    later: 'omitted-port',
    roles: [roleEntry('a', OUT_OF_VOCABULARY_ROLE)],
  },
  // duplicate-port beats every later class.
  {
    earlier: 'duplicate-port',
    later: 'undeclared-port',
    // 3 entries against 3 ports (not too-many): 'a' is named twice before 'zz' is ever reached.
    roles: [roleEntry('a', 'data'), roleEntry('a', 'enable'), roleEntry('zz', 'data')],
  },
  {
    earlier: 'duplicate-port',
    later: 'omitted-port',
    roles: [roleEntry('a', 'data'), roleEntry('a', 'enable')],
  },
  // undeclared-port beats the last remaining later class.
  {
    earlier: 'undeclared-port',
    later: 'omitted-port',
    roles: [roleEntry('a', 'data'), roleEntry('zz', 'data')],
  },
];

describe(PROPERTY, () => {
  it('reports the earlier of two simultaneous role faults, for every ordered pair in the fixed check order', () => {
    const reached = new Set<string>();

    fc.assert(
      fc.property(fc.constantFrom(...PAIR_CASES), (pairCase) => {
        reached.add(`${pairCase.earlier}|${pairCase.later}`);
        const reply = JSON.stringify({ functions: VALID_FUNCTIONS, roles: pairCase.roles });
        const result = parseReferenceModelDraft(reply, MODULE_INTERFACE);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.reason).toBe(FAULT_REASON[pairCase.earlier]);
        }
      }),
      propertyParameters(),
    );

    // NON-VACUITY: all 15 ordered pairs were actually drawn, not just declared reachable - the
    // same discipline `consensus-period-constraint-order.property.test.ts` applies to its two
    // double-failure shapes.
    expect(reached.size).toBe(PAIR_CASES.length);
  });
});
