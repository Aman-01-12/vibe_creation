// stimulus-transaction-structure, Property 3: The Stimulus_Function is deterministic for a
// fixed request (task 4.4, C3).
//
// THE ORACLE IS TEXTUAL, NOT A SIMULATOR RUN
//   `renderConsensusHarness` is pure and total (Req 4.8's own claim, restated here for the
//   Stimulus_Function specifically): no file, clock, or random-source read, so two calls over one
//   `ConsensusHarnessRequest` returning the same text is the direct consequence of that purity
//   rather than a separate mechanism - this half of the property is checked by straight string
//   equality over two independently-built request objects, not by inspecting the renderer's
//   internals.
//
// THE SECOND HALF IS THE ONE THAT BITES
//   Purity by construction does not survive an edit that reaches for `Date.now()`, a module-level
//   counter, or a run index "just this once". This file's real check is an independent scan of the
//   rendered `ece_stimulus` function's own text (its declaration line through its matching
//   `endfunction`, isolated from `ece_mix` above it and the `ece_stimulus(step)` call site below
//   it): every maximal run of identifier characters in that text must be one of the function's own
//   fixed vocabulary (`step`, `ece_mix`, `v`, `v_hold`, `ece_stimulus`, and the Verilog syntax that
//   frames them) or a sized literal's radix fragment (e.g. `32'd0` tokenizes to `d0`) - never a
//   wall-clock read, a run index, or any other identifier a future edit might introduce. The
//   allowed vocabulary is hand-enumerated by reading `renderStimulusFunction`'s own
//   `lines.push(...)` text directly (`consensus-harness.ts`), the same discipline
//   `consensus-harness-identifier.property.test.ts`'s `SKELETON_VOCABULARY` already applies to the
//   whole harness.
//
// NON-VACUITY
//   `strobe` and `hold` are the two Input_Roles this check did not exist for until this task:
//   `roleDeclarationArbitrary` forces every generated interface with at least one input port to
//   carry a non-empty subset of `strobe`- or `hold`-role ports (chosen per draw), so both are
//   exercised by construction across the sampled population rather than left to a uniform draw
//   over the full Role_Vocabulary that could land on neither.
//
// Validates: Requirements 3.8

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface } from '@app/core';
import {
  renderConsensusHarness,
  SAMPLE_BUDGET,
  type ConsensusHarnessRequest,
  type RoleDeclaration,
} from '@app/tools';

import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 3: The Stimulus_Function is deterministic for a ' +
  'fixed request';

/** The literal fragment `ece_stimulus`'s own declaration line always contains. */
const STIMULUS_FUNCTION_DECLARATION_FRAGMENT = 'ece_stimulus(input [31:0] step)';

/**
 * `ece_stimulus`'s own rendered text: its declaration line through its matching `endfunction`,
 * isolated from the Stimulus_Mixer (`ece_mix`) rendered just above it and from the
 * `ece_stimulus(step)` call site rendered inside the module below it.
 */
function extractStimulusFunctionBody(renderedText: string): string {
  const lines = renderedText.split('\n');
  const startIndex = lines.findIndex((line) =>
    line.includes(STIMULUS_FUNCTION_DECLARATION_FRAGMENT),
  );
  if (startIndex === -1) {
    throw new Error('fixture defect: no ece_stimulus function declaration found in rendered text');
  }
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === 'endfunction',
  );
  if (endIndex === -1) {
    throw new Error('fixture defect: no matching endfunction found for ece_stimulus');
  }
  return lines.slice(startIndex, endIndex + 1).join('\n');
}

/**
 * `ece_stimulus`'s own fixed vocabulary (Req 3.8): its own name, its `step` parameter, the
 * Stimulus_Mixer it calls, its two local registers, and the Verilog syntax that frames them.
 */
const ALLOWED_STIMULUS_IDENTIFIERS: ReadonlySet<string> = new Set([
  'function',
  'automatic',
  'input',
  'reg',
  'begin',
  'end',
  'endfunction',
  'step',
  'ece_mix',
  'v',
  'v_hold',
  'ece_stimulus',
]);

/**
 * A sized Verilog literal's radix fragment (e.g. `32'd0` tokenizes to `d0`), excluded by shape
 * rather than enumerated by value since the digits vary with every lane index and width.
 */
const RADIX_LITERAL_FRAGMENT = /^(?:[bdo]\d+|h[0-9A-Fa-f]+)$/;

/** Every maximal run of identifier characters in `text`. */
function identifierTokensIn(text: string): readonly string[] {
  return text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

/**
 * A total Role_Declaration over `moduleInterface`'s own input ports: a non-empty subset forced to
 * one of `strobe` or `hold` (chosen per draw), the rest `data`. Empty when `moduleInterface`
 * declares no input port at all.
 */
function roleDeclarationArbitrary(moduleInterface: ModuleInterface): fc.Arbitrary<RoleDeclaration> {
  const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
  if (inputPorts.length === 0) {
    return fc.constant([]);
  }
  const inputNames = inputPorts.map((port) => port.name);
  return fc
    .tuple(
      fc.constantFrom<'strobe' | 'hold'>('strobe', 'hold'),
      fc.subarray(inputNames, { minLength: 1 }),
    )
    .map(([focusRole, focusNames]) => {
      const focusSet = new Set(focusNames);
      return inputPorts.map((port) => ({
        portName: port.name,
        role: focusSet.has(port.name) ? focusRole : ('data' as const),
      }));
    });
}

function scenarioArbitrary(): fc.Arbitrary<{
  readonly moduleInterface: ModuleInterface;
  readonly roles: RoleDeclaration;
}> {
  return arbModuleInterface().chain((moduleInterface) =>
    roleDeclarationArbitrary(moduleInterface).map((roles) => ({ moduleInterface, roles })),
  );
}

/** Build a `ConsensusHarnessRequest` over `moduleInterface` and `roles`, all-combinational. */
function requestFor(
  moduleInterface: ModuleInterface,
  roles: RoleDeclaration,
  nonce: string,
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
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    roles,
  };
}

describe(PROPERTY, () => {
  it(
    'renders byte-identical text from two calls over the same request, and the rendered ' +
      'ece_stimulus body reads no identifier beyond its own fixed vocabulary and Verilog literals',
    () => {
      let strobeCases = 0;
      let holdCases = 0;

      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const { moduleInterface, roles } = scenario;
          const renderedA = renderConsensusHarness(requestFor(moduleInterface, roles, 'det_a'));
          const renderedB = renderConsensusHarness(requestFor(moduleInterface, roles, 'det_a'));
          // A generated module/port name may coincidentally collide with a reserved Verilog
          // keyword `arbModuleInterface`'s own narrower RESERVED set does not exclude; not the
          // claim under test, so it is discarded (the convention
          // `rendered-stimulus-enable.property.test.ts` already uses for this same generator).
          fc.pre(renderedA.ok);
          if (!renderedA.ok || !renderedB.ok) {
            return;
          }

          expect(renderedB.value.contents).toBe(renderedA.value.contents);

          if (roles.some((role) => role.role === 'strobe')) {
            strobeCases += 1;
          }
          if (roles.some((role) => role.role === 'hold')) {
            holdCases += 1;
          }

          const body = extractStimulusFunctionBody(renderedA.value.contents);
          const unexpected = identifierTokensIn(body).filter(
            (token) =>
              !ALLOWED_STIMULUS_IDENTIFIERS.has(token) && !RADIX_LITERAL_FRAGMENT.test(token),
          );
          expect(unexpected).toEqual([]);
        }),
        propertyParameters(),
      );

      // NON-VACUITY: strobe and hold must both actually appear in the sampled population, not
      // just be possible - `roleDeclarationArbitrary` forces one or the other on every draw that
      // has an input port, so both are exercised by construction rather than by chance.
      expect({ strobeCases: strobeCases > 0, holdCases: holdCases > 0 }).toEqual({
        strobeCases: true,
        holdCases: true,
      });
    },
  );
});
