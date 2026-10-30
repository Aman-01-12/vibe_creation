// Feature: stimulus-transaction-structure, Property 16: The renderer re-derives the refusal
// independently (task 7.2).
//
// THE FOUR FAULT CLASSES, CONSTRUCTED RATHER THAN SAMPLED INTO EXISTENCE
//   `requireTotalRoleDeclaration` (consensus-harness.ts, task 7.1) is four independent checks in a
//   fixed order: a role outside `INPUT_ROLES`, a duplicate input port, a port the Declared_Interface
//   does not declare, and an omitted input port. A uniform draw over `RoleDeclaration` would almost
//   never land on exactly one of these, so each case is built directly from a valid total
//   Role_Declaration with exactly one fault introduced, which is what makes every one of the four
//   classes exercised on every run rather than left to chance.
//
//   The first class is reachable only by a cast past `InputRole` (task 7.1's own note: the
//   membership check is unreachable through the typed path), modelling the one way an upstream
//   regression could still hand the renderer a role outside the vocabulary.
//
// THE FULL DISCRIMINATED UNION, NOT JUST `.ok`
//   `not.toHaveProperty('value')` fails if `rendered` carries a `value` key alongside its `error`,
//   so a renderer that returned `{ ok: false, error, value }` (harness text alongside a refusal)
//   would fail this assertion where `expect(rendered.ok).toBe(false)` alone would not have caught
//   it.
//
// Validates: Requirements 2.7, 2.12

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeTimingContract, type DomainErrorCode, type ModuleInterface } from '@app/core';
import {
  renderConsensusHarness,
  SAMPLE_BUDGET,
  type ConsensusHarnessRequest,
  type PortRole,
  type RoleDeclaration,
} from '@app/tools';

import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 16: The renderer re-derives the refusal independently';

const FAULT_CLASSES = [
  'outside-vocabulary',
  'duplicate-port',
  'undeclared-port',
  'omitted-port',
] as const;

type FaultClass = (typeof FAULT_CLASSES)[number];

/** The three totality classes share `INCOMPLETE_ROLE_DECLARATION`; only vocabulary gets its own
 * code (task 7.1). */
const EXPECTED_CODE: Record<FaultClass, DomainErrorCode> = {
  'outside-vocabulary': 'ROLE_OUTSIDE_VOCABULARY',
  'duplicate-port': 'INCOMPLETE_ROLE_DECLARATION',
  'undeclared-port': 'INCOMPLETE_ROLE_DECLARATION',
  'omitted-port': 'INCOMPLETE_ROLE_DECLARATION',
};

/** Codes `validateIdentifiers` can return when a generated name collides with a reserved Verilog
 * keyword outside `identifierArbitrary`'s own small guard - vanishingly rare, and orthogonal to
 * this property, which is why the main property discards it rather than asserting over it. */
const IDENTIFIER_FAULT_CODES: ReadonlySet<DomainErrorCode> = new Set([
  'INVALID_VERILOG_IDENTIFIER',
  'RESERVED_VERILOG_KEYWORD',
]);

/** A total Role_Declaration naming every one of `inputPorts` `data`. */
function totalDataRoles(inputPorts: readonly { readonly name: string }[]): PortRole[] {
  return inputPorts.map((port) => ({ portName: port.name, role: 'data' as const }));
}

/** A name not among any of `moduleInterface`'s own ports, for the "undeclared port" fault. */
function freshPortName(moduleInterface: ModuleInterface): string {
  const existing = new Set(moduleInterface.ports.map((port) => port.name));
  let candidate = 'ece_undeclared_port';
  while (existing.has(candidate)) {
    candidate += '_';
  }
  return candidate;
}

/**
 * A `RoleDeclaration` carrying exactly one fault of `faultClass`, built from the one total,
 * well-formed declaration over `inputPorts` so no other fault is introduced alongside it.
 */
function rolesForFault(
  moduleInterface: ModuleInterface,
  inputPorts: readonly { readonly name: string }[],
  faultClass: FaultClass,
  targetIndex: number,
): RoleDeclaration {
  const base = totalDataRoles(inputPorts);
  switch (faultClass) {
    case 'outside-vocabulary': {
      // Req 2.7, 2.2: `PortRole.role` is typed `InputRole`, so only a cast past that type reaches
      // this branch (task 7.1's own note on the membership check's unreachability).
      const withBogusRole = base.map((entry, index) =>
        index === targetIndex ? { ...entry, role: 'ece_not_a_role' } : entry,
      );
      return withBogusRole as unknown as RoleDeclaration;
    }
    case 'duplicate-port': {
      const duplicated = inputPorts[targetIndex];
      if (duplicated === undefined) {
        throw new Error('fixture defect: targetIndex out of range for duplicate-port');
      }
      return [...base, { portName: duplicated.name, role: 'data' as const }];
    }
    case 'undeclared-port': {
      return [...base, { portName: freshPortName(moduleInterface), role: 'data' as const }];
    }
    case 'omitted-port': {
      return base.filter((_, index) => index !== targetIndex);
    }
    default: {
      // Exhaustiveness: a new FaultClass must be given a construction explicitly.
      const unreachable: never = faultClass;
      return unreachable;
    }
  }
}

function requestFor(
  moduleInterface: ModuleInterface,
  roles: RoleDeclaration,
): ConsensusHarnessRequest {
  const timingEntries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'combinational' as const }));
  const timingContract = makeTimingContract(moduleInterface, timingEntries);
  if (!timingContract.ok) {
    throw new Error(`fixture defect building the Timing_Contract: ${timingContract.error.code}`);
  }
  return {
    moduleInterface,
    timingContract: timingContract.value,
    nonce: 'roleindep',
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    roles,
  };
}

// ---------------------------------------------------------------------------
// The sampled population
// ---------------------------------------------------------------------------

interface Scenario {
  readonly moduleInterface: ModuleInterface;
  readonly roles: RoleDeclaration;
  readonly expectedCode: DomainErrorCode;
  readonly faultClass: FaultClass;
}

/** One generated interface, paired with a Role_Declaration carrying exactly one of the four fault
 * classes. Carries an empty `roles` for a zero-input-port draw, discarded by the property's own
 * `fc.pre` (that draw cannot carry any of the four faults at all). */
function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return arbModuleInterface().chain((moduleInterface) => {
    const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
    if (inputPorts.length === 0) {
      return fc.constant<Scenario>({
        moduleInterface,
        roles: [],
        expectedCode: 'INCOMPLETE_ROLE_DECLARATION',
        faultClass: 'omitted-port',
      });
    }
    return fc.constantFrom(...FAULT_CLASSES).chain((faultClass) =>
      fc.integer({ min: 0, max: inputPorts.length - 1 }).map((targetIndex): Scenario => ({
        moduleInterface,
        roles: rolesForFault(moduleInterface, inputPorts, faultClass, targetIndex),
        expectedCode: EXPECTED_CODE[faultClass],
        faultClass,
      })),
    );
  });
}

describe(PROPERTY, () => {
  it('refuses with exactly its own fault class named, and no harness text, for each of the four fault classes', () => {
    const exercised = new Set<FaultClass>();

    fc.assert(
      fc.property(scenarioArbitrary(), (scenario) => {
        const { moduleInterface, roles, expectedCode, faultClass } = scenario;
        const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
        // A zero-input-port draw cannot carry any of the four faults.
        fc.pre(inputPorts.length > 0);
        exercised.add(faultClass);

        const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));

        // Vanishingly rare: a generated module or port name collides with a reserved Verilog
        // keyword outside `identifierArbitrary`'s own small guard, refusing for an identifier
        // reason before the role check ever runs. Orthogonal to this property, so discarded the
        // same way the sibling stimulus-rendering property tests already discard their own
        // analogous rare collision.
        fc.pre(!(!rendered.ok && IDENTIFIER_FAULT_CODES.has(rendered.error.code)));

        expect(rendered.ok).toBe(false);
        if (rendered.ok) {
          return;
        }
        // The FULL `Result` union, not just `.ok`: no `value` (no harness text) may accompany a
        // refusal, and the renderer must name exactly this fault's own class, reading no Role_
        // Parser result, record, or refusal reason to do it.
        expect(rendered).not.toHaveProperty('value');
        expect(rendered.error.code).toBe(expectedCode);
      }),
      propertyParameters(),
    );

    // NON-VACUITY: all four fault classes must have actually been exercised across the
    // population, not just declared possible.
    expect([...exercised].sort()).toEqual([...FAULT_CLASSES].sort());
  });
});
