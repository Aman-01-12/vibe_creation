// reference-model-rendered-stimulus, Property 2: Rendering is deterministic and byte-identical
// (task 2.7, C5).
//
// WHAT IS CLAIMED
//   For any Declared_Interface, Timing_Contract, Role_Declaration, nonce and Sample_Budget, two
//   calls to `renderConsensusHarness` with the SAME request produce byte-identical text (Req 2.3,
//   2.14). The assertion is on the whole rendered `contents` string, not on a regex-extracted
//   stimulus region, because Property 2 is a claim about the renderer's output as a whole.
//
// WHY THE INTERFACE IS REUSED FROM `interface-header-arbitraries.ts` RATHER THAN HAND-ROLLED
//   `arbModuleInterface()` already draws a `ModuleInterface` with 1-6 uniquely-named ports of
//   varied direction and width, which is exactly the Declared_Interface shape this renderer takes.
//   Hand-rolling a second generator would duplicate that arbitrary's own identifier and
//   uniqueness rules for no new coverage.
//
// WHY THE RENDERER MAY LEGITIMATELY REFUSE A DRAW
//   `arbModuleInterface()`'s own identifier generator only avoids a small keyword set
//   (`module`, `input`, `wire`, ...; see that file's `RESERVED`), not the much larger
//   `VERILOG_KEYWORDS` set `consensus-harness.ts` refuses module/port names against (`begin`,
//   `case`, `always`, ...). So a drawn interface can collide with a reserved Verilog keyword and
//   be refused with a `DomainError`. The property under test is "renders twice with the SAME
//   request yields byte-identical output, or refuses both times for the same reason" - not "never
//   refuses" - so a refusal on this draw is checked for consistency between the two calls and the
//   byte-identity assertion is skipped for it, rather than failing the whole property.
//
// HOW THE ROLE_DECLARATION AND TIMING_CONTRACT ARE DERIVED, SO EVERY DRAW IS TOTAL
//   The Role_Declaration names every one of the drawn interface's own input ports `data` - the
//   point of this property is byte-identical rendering across two calls with an IDENTICAL
//   request, not stimulus content variety across roles (Property 4 covers `enable`). The
//   Timing_Contract is built the same way `consensus-harness.test.ts`'s own `allRegisteredTiming`
//   fixture does: one `registered` entry per the drawn interface's own output ports. Because both
//   are built directly from the SAME drawn interface's own port lists with no duplicate names
//   (`arbModuleInterface()` guarantees unique names), `makeTimingContract` cannot refuse here, so
//   a refusal is treated as a generator defect and thrown loudly rather than handled.
//
// **Validates: Requirements 2.3, 2.14**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface, type TimingContract } from '@app/core';
import {
  renderConsensusHarness,
  type ConsensusHarnessRequest,
  type RoleDeclaration,
} from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-rendered-stimulus, Property 2: Rendering is deterministic and byte-identical';

/** No SystemVerilog-2017 keyword begins with this, so a drawn nonce never needs a retry. */
const NONCE_PREFIX = 'zzid';

function nonceArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 0, 6).map((suffix) => `${NONCE_PREFIX}${suffix}`);
}

/** One `registered` entry per output port of `moduleInterface`, built directly from its own ports. */
function allRegisteredTiming(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(
      `arbModuleInterface produced an interface allRegisteredTiming could not cover: ${built.error.code}`,
    );
  }
  return built.value;
}

/** A total Role_Declaration naming every input port of `moduleInterface` as `data`. */
function allDataRoles(moduleInterface: ModuleInterface): RoleDeclaration {
  return moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => ({ portName: port.name, role: 'data' as const }));
}

/** A `ConsensusHarnessRequest` for a drawn `moduleInterface`, total by construction. */
function arbConsensusHarnessRequest(): fc.Arbitrary<ConsensusHarnessRequest> {
  return arbModuleInterface().chain((moduleInterface) =>
    fc
      .record({
        nonce: nonceArbitrary(),
        watchdogBudgetNs: fc.integer({ min: 1, max: 2_000_000 }),
        sampleBudget: fc.integer({ min: 1, max: 64 }),
      })
      .map(({ nonce, watchdogBudgetNs, sampleBudget }) => ({
        moduleInterface,
        timingContract: allRegisteredTiming(moduleInterface),
        nonce,
        watchdogBudgetNs,
        sampleBudget,
        roles: allDataRoles(moduleInterface),
      })),
  );
}

describe(PROPERTY, () => {
  it('renders byte-identical text for two calls with the same request, or refuses both consistently', () => {
    let acceptedAtLeastOnce = false;

    fc.assert(
      fc.property(arbConsensusHarnessRequest(), (request) => {
        const first = renderConsensusHarness(request);
        const second = renderConsensusHarness(request);

        if (!first.ok || !second.ok) {
          // A reserved-keyword name is a legitimate refusal (see header comment); the claim here
          // is that the SAME request is treated the same way twice, not that it is never refused.
          expect(second.ok, 'one call refused and the other accepted the same request').toBe(
            first.ok,
          );
          if (!first.ok && !second.ok) {
            expect(second.error.code).toBe(first.error.code);
          }
          return;
        }

        acceptedAtLeastOnce = true;
        // The whole rendered string, not a regex-extracted stimulus region alone (Req 2.3, 2.14).
        expect(second.value.contents).toBe(first.value.contents);
        expect(second.value.path).toBe(first.value.path);
      }),
      propertyParameters(),
    );

    expect(acceptedAtLeastOnce, 'no draw was accepted by the renderer').toBe(true);
  });
});
