// Feature: reference-model-rendered-stimulus, Property 1: The parse contract is exactly three
// bodies plus a total in-vocabulary Role_Declaration (task 2.6, C2).
//
// THE ORACLE
//   Restated directly over independently drawn reply envelopes rather than by re-deriving
//   `parse.ts`'s own check order: `parseReferenceModelDraft` returns a Reference_Model_Draft IF
//   AND ONLY IF the reply carries exactly three distinct non-empty length-bounded bodies named
//   `ece_reset_state`, `ece_next_state`, `ece_expect`, AND a `roles` array naming every input port
//   of the Declared_Interface exactly once with a role from `{data, enable}`. Every other
//   combination is a refusal carrying a non-empty reason, and no draft/refusal mixes the two
//   shapes.
//
//   The function-body catalog and the role catalog are each a small CLOSED set of defect kinds
//   (missing/extra/duplicate/unexpected name, empty/oversized body; no-array/malformed/out-of-
//   vocabulary/duplicate-port/undeclared-port/omitted-port/case-near-miss/empty-string role), so
//   `expectedOk` below is computed as `functionsCase.ok && rolesCase.ok` - a restatement of the
//   design's own "if and only if" sentence, not a read of `parse.ts`'s internals.
//
// WHY THE ROLES ENVELOPE IS BUILT AS A LIST
//   A duplicate-port defect (one port named twice) cannot be expressed at all by a `Record`, which
//   can hold only one value per key. The reply is a list of `{port, role}` entries, which is also
//   the real wire shape `parse.ts` reads.
//
// NON-VACUITY
//   Every defect kind in both closed catalogs is EXHAUSTED by a deterministic loop, both over the
//   generated Declared_Interface population below and once more over a fixed, constructed
//   interface with a real input port, per
//   `chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`:
//   raising `numRuns` narrows the odds of missing a case but never closes them, where exhausting
//   does. The case-sensitivity trap and the empty-string trap are near-misses of the real
//   vocabulary rather than arbitrary strings, because a random string is almost never one
//   character away from `data`/`enable`, and a case-insensitive comparison is the plausible
//   defect this guards against.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.10, 4.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseReferenceModelDraft } from '@app/agent';
import type { ModuleInterface } from '@app/core';
import { INPUT_ROLES, type InputRole } from '@app/tools';

import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

// The tag is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a different
// spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
const PROPERTY =
  'reference-model-rendered-stimulus, Property 1: The parse contract is exactly three bodies ' +
  'plus a total in-vocabulary Role_Declaration';

// ---------------------------------------------------------------------------
// The function-body catalog (independent of the Declared_Interface)
// ---------------------------------------------------------------------------

const RESET_BODY = "ece_reset_state = 128'd0;";
const NEXT_BODY = 'ece_next_state = s;';
const EXPECT_BODY = "ece_expect = 1'b0;";

/** The canonical, well-formed three entries. */
function validFunctionEntries(): unknown[] {
  return [
    { name: 'ece_reset_state', body: RESET_BODY },
    { name: 'ece_next_state', body: NEXT_BODY },
    { name: 'ece_expect', body: EXPECT_BODY },
  ];
}

/** One way the reply's `functions` field can be shaped, and whether that shape is total. */
interface FunctionsCase {
  readonly kind: string;
  readonly value: unknown;
  readonly ok: boolean;
}

/** Every closed defect kind Property 1 states for the three function bodies, plus the valid shape. */
const FUNCTION_CASES: readonly FunctionsCase[] = [
  { kind: 'valid', value: validFunctionEntries(), ok: true },
  {
    kind: 'missing-one',
    value: [
      { name: 'ece_reset_state', body: RESET_BODY },
      { name: 'ece_next_state', body: NEXT_BODY },
    ],
    ok: false,
  },
  {
    kind: 'extra-one',
    value: [...validFunctionEntries(), { name: 'ece_extra', body: 'x;' }],
    ok: false,
  },
  {
    kind: 'duplicate-name',
    value: [
      { name: 'ece_reset_state', body: RESET_BODY },
      { name: 'ece_reset_state', body: NEXT_BODY },
      { name: 'ece_expect', body: EXPECT_BODY },
    ],
    ok: false,
  },
  {
    kind: 'unexpected-name',
    value: [
      { name: 'ece_bogus', body: RESET_BODY },
      { name: 'ece_next_state', body: NEXT_BODY },
      { name: 'ece_expect', body: EXPECT_BODY },
    ],
    ok: false,
  },
  {
    kind: 'empty-body',
    value: [
      { name: 'ece_reset_state', body: '' },
      { name: 'ece_next_state', body: NEXT_BODY },
      { name: 'ece_expect', body: EXPECT_BODY },
    ],
    ok: false,
  },
  {
    kind: 'oversized-body',
    value: [
      { name: 'ece_reset_state', body: 'x'.repeat(20_001) },
      { name: 'ece_next_state', body: NEXT_BODY },
      { name: 'ece_expect', body: EXPECT_BODY },
    ],
    ok: false,
  },
  {
    kind: 'malformed-entry',
    value: [
      'not-an-object',
      { name: 'ece_next_state', body: NEXT_BODY },
      { name: 'ece_expect', body: EXPECT_BODY },
    ],
    ok: false,
  },
];

// ---------------------------------------------------------------------------
// The role catalog (depends on the Declared_Interface's own input port names)
// ---------------------------------------------------------------------------

/** One way the reply's `roles` field can be shaped, and whether that shape is a Total_Role_Declaration. */
interface RolesCase {
  readonly kind: string;
  readonly value: unknown;
  readonly ok: boolean;
}

/** A case-mismatched near-miss of a real vocabulary member, e.g. `data` -> `Data`. */
function caseNearMissOf(role: InputRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Every closed defect kind Property 1 states for the Role_Declaration, over `moduleInterface`'s
 * own input ports.
 *
 * A case that needs a real port name to deface (a malformed entry, an out-of-vocabulary role, a
 * duplicate, an omission, a near-miss) is included only when the interface declares at least one
 * input port - there is no name to build the defect against otherwise.
 */
function rolesCasesFor(moduleInterface: ModuleInterface): RolesCase[] {
  const inputNames = moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => port.name);

  const allRole = (role: InputRole): unknown[] => inputNames.map((name) => ({ port: name, role }));

  const cases: RolesCase[] = [
    { kind: 'valid-all-data', value: allRole('data'), ok: true },
    { kind: 'valid-all-enable', value: allRole('enable'), ok: true },
    { kind: 'no-roles-array', value: null, ok: false },
    {
      kind: 'undeclared-port',
      value: [...allRole('data'), { port: 'zz_undeclared_port', role: 'data' }],
      ok: false,
    },
  ];

  const [firstInputName] = inputNames;
  if (firstInputName === undefined) {
    return cases;
  }

  const restAsData = inputNames.slice(1).map((name) => ({ port: name, role: 'data' }));

  cases.push(
    {
      kind: 'malformed-entry',
      value: [{ port: firstInputName }, ...restAsData],
      ok: false,
    },
    {
      kind: 'out-of-vocabulary-role',
      value: [{ port: firstInputName, role: 'strobe' }, ...restAsData],
      ok: false,
    },
    {
      kind: 'duplicate-port',
      value: [...allRole('data'), { port: firstInputName, role: 'enable' }],
      ok: false,
    },
    {
      kind: 'omitted-port',
      value: restAsData,
      ok: false,
    },
    {
      kind: 'empty-string-role',
      value: [{ port: firstInputName, role: '' }, ...restAsData],
      ok: false,
    },
  );

  // EXHAUSTED, not sampled: both members of the closed {data, enable} union get their own
  // case-mismatched near-miss, per the vault's non-vacuity gotcha.
  for (const member of INPUT_ROLES) {
    cases.push({
      kind: `near-miss-case-${member}`,
      value: [{ port: firstInputName, role: caseNearMissOf(member) }, ...restAsData],
      ok: false,
    });
  }

  return cases;
}

// ---------------------------------------------------------------------------
// The shared grading function
// ---------------------------------------------------------------------------

/**
 * Grade one (functionsCase, rolesCase) combination against the independently stated oracle.
 *
 * Named so the SAME grading runs over the generated population and over the deterministic
 * exhaustion loop below, rather than two slightly different checks drifting apart.
 */
function assertCombination(
  moduleInterface: ModuleInterface,
  functionsCase: FunctionsCase,
  rolesCase: RolesCase,
): void {
  const reply = JSON.stringify({ functions: functionsCase.value, roles: rolesCase.value });
  const expectedOk = functionsCase.ok && rolesCase.ok;
  const result = parseReferenceModelDraft(reply, moduleInterface);

  expect(result.ok).toBe(expectedOk);
  if (result.ok) {
    // No returned draft carries a stimulus body: the type has no such field, checked at runtime
    // too so a future field addition cannot slip one back in unnoticed.
    expect(Object.keys(result.value).sort()).toEqual(
      ['expectBody', 'nextStateBody', 'resetStateBody', 'roles'].sort(),
    );
  } else {
    // No refusal path returns a partial draft: the error carries its reason, and nothing else.
    expect(Object.keys(result.error)).toEqual(['reason']);
    expect(result.error.reason.length).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// Garbage, non-JSON reply text: guaranteed to refuse by the envelope step alone.
// ---------------------------------------------------------------------------

function garbageTextArbitrary(): fc.Arbitrary<string> {
  return fc.string().filter((candidate) => {
    try {
      JSON.parse(candidate);
      return false;
    } catch {
      return true;
    }
  });
}

describe(PROPERTY, () => {
  it(
    'accepts iff the functions catalog and the roles catalog both hold, over every combination ' +
      'and every generated Declared_Interface, and refuses non-JSON text outright',
    () => {
      let trueCases = 0;
      let falseCases = 0;

      fc.assert(
        fc.property(
          arbModuleInterface(),
          garbageTextArbitrary(),
          (moduleInterface, garbageText) => {
            for (const functionsCase of FUNCTION_CASES) {
              for (const rolesCase of rolesCasesFor(moduleInterface)) {
                assertCombination(moduleInterface, functionsCase, rolesCase);
                if (functionsCase.ok && rolesCase.ok) {
                  trueCases += 1;
                } else {
                  falseCases += 1;
                }
              }
            }

            const garbageResult = parseReferenceModelDraft(garbageText, moduleInterface);
            expect(garbageResult.ok).toBe(false);
          },
        ),
        propertyParameters(),
      );

      // Non-vacuity: both the accept and the refuse side of the "if and only if" were actually
      // exercised across the generated population, not just declared possible.
      expect(trueCases).toBeGreaterThan(0);
      expect(falseCases).toBeGreaterThan(0);
    },
  );

  it('exhausts every defect kind in both catalogs over one fixed interface with a real input port', () => {
    // A constructed, non-sampled interface: one input and one output, so every case in
    // `rolesCasesFor` that needs a real port name to deface is always reachable here regardless
    // of what the generated population above happened to draw.
    const moduleInterface: ModuleInterface = {
      moduleName: 'fixed_mod',
      ports: [
        { name: 'en', direction: 'input', width: 1 },
        { name: 'q', direction: 'output', width: 1 },
      ],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
      validityOutputName: null,
    };

    const rolesCases = rolesCasesFor(moduleInterface);
    const observedRoleKinds = new Set(rolesCases.map((rolesCase) => rolesCase.kind));

    for (const functionsCase of FUNCTION_CASES) {
      for (const rolesCase of rolesCases) {
        assertCombination(moduleInterface, functionsCase, rolesCase);
      }
    }

    // Every near-miss member of the closed {data, enable} union was actually built, not just one
    // of the two picked at random.
    for (const member of INPUT_ROLES) {
      expect(observedRoleKinds.has(`near-miss-case-${member}`)).toBe(true);
    }
    expect(observedRoleKinds.has('duplicate-port')).toBe(true);
    expect(observedRoleKinds.has('empty-string-role')).toBe(true);
  });
});
