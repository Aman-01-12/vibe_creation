// stimulus-transaction-structure, Property 1: A Legacy_Interface renders Byte_Identical text
// (task 4.2, C3).
//
// WHY THIS IS A STRUCTURAL CHECK, NOT A LITERAL TWO-VERSION DIFF
//   The design states this property as a comparison against "the text the harness at
//   CONSENSUS_HARNESS_VERSION 3 returned for the same render request". There is only ever one
//   `renderConsensusHarness` to call - task 1.1 captured that version's golden text for the 46
//   real corpus designs BEFORE task 4.1 touched the renderer, because that text cannot be
//   re-rendered once the renderer moves. This file has no access to that captured golden text and
//   no second renderer to call, so it cannot re-run a literal byte diff for an arbitrary
//   GENERATED interface; the exhaustive byte-for-byte comparison against the committed golden
//   corpus is task 5.1, over the fixed 46 designs only.
//   What this file checks instead, over a widely varied generated population, is C3's own stated
//   mechanism for byte identity ("Byte identity by construction", design.md C3): the Stimulus_
//   Function has exactly three new emission sites and each is guarded on the roles actually
//   declared, so a Legacy_Interface (every input port `data` or `enable`) reaches none of them -
//   no `v_hold` declaration, no held/strobe overwrite line, and no inline Strobe_Period or
//   Hold_Frame_Period literal anywhere in the rendered text. That absence is what keeps a
//   Legacy_Interface's text identical to what it was before task 4.1 added those sites at all.
//
// THE ORACLE IS AN INDEPENDENT PARSE OF THE RENDERED TEXT
//   Four regexes, each anchored to the exact fixed syntax `renderStimulusFunction` emits around a
//   guarded site - not called from that function and not re-deriving its logic - the same
//   "independent parse as the oracle" discipline `rendered-stimulus-layout.property.test.ts`
//   already uses for Property 3's layout claim.
//
// THE SUBSTRING-NEEDLE GUARD
//   Per `chipAgent/_inbox/gotcha-a-byte-identity-via-substring-substitution-property-must-guard-
//   the-needle-against-the-renderers-own-fixed-text-too.md`, a loose `rendered.includes('67')` is
//   NOT what this file does. `arbModuleInterface()` draws port widths up to 64 across up to 6
//   ports, so the input bundle's own bit-range HIGH index (`v[67:0]`, `v[134:67]`, ...) routinely
//   contains the digits "67" by pure arithmetic coincidence, with no Strobe or Held_Input
//   anywhere in the draw. A bare digit needle would flake on the renderer's own fixed numbering,
//   exactly the collision class the vault note records. Each regex below instead requires the
//   surrounding fixed tokens only the guarded sites emit (`v_hold`, `step /`, and `== 0` as the
//   strobe line's exact inverse of the enable line's `!= 0`), confirmed against the renderer's
//   source directly: the only place `(step % <digits>) == 0` appears anywhere in
//   `consensus-harness.ts` is the strobe overwrite line itself - the mid-run reset check renders
//   its period symbolically as `ECE_RESET_FRAME`, never as an inline digit run, so it cannot
//   collide with this shape.
//
// Validates: Requirements 1.3, 5.1, 5.5

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface, type Port } from '@app/core';
import {
  renderConsensusHarness,
  SAMPLE_BUDGET,
  type ConsensusHarnessRequest,
  type InputRole,
  type RoleDeclaration,
} from '@app/tools';

import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 1: A Legacy_Interface renders Byte_Identical text';

/** The Legacy_Role_Set (Req 1.3): the Role_Vocabulary as it stood before this feature. */
const LEGACY_ROLES = ['data', 'enable'] as const;

/**
 * The four fixed-shape patterns only the Strobe and Held_Input emission sites (C3) can produce.
 * Anchored to each site's own surrounding syntax rather than to the bare period value - see the
 * substring-needle guard above.
 */
const V_HOLD_DECLARATION = /\breg \[\d+:0\] v_hold;/;
const HOLD_LANE_ASSIGNMENT = /\bv_hold\[\d+:\d+\] = ece_mix\(32'd\d+, step \/ \d+\);/;
const HOLD_OVERWRITE_LINE = /\bv\[\d+:\d+\] = v_hold\[\d+:\d+\];/;
const STROBE_OVERWRITE_LINE = /\(step % \d+\) == 0/;

/** Asserts none of the three guarded (Strobe/Held_Input) emission sites left any trace. */
function assertNoHeldOrStrobeText(renderedContents: string): void {
  expect(renderedContents).not.toMatch(V_HOLD_DECLARATION);
  expect(renderedContents).not.toMatch(HOLD_LANE_ASSIGNMENT);
  expect(renderedContents).not.toMatch(HOLD_OVERWRITE_LINE);
  expect(renderedContents).not.toMatch(STROBE_OVERWRITE_LINE);
}

function allCombinationalTiming(moduleInterface: ModuleInterface) {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'combinational' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`fixture defect building the Timing_Contract: ${built.error.code}`);
  }
  return built.value;
}

function requestFor(
  moduleInterface: ModuleInterface,
  roles: RoleDeclaration,
): ConsensusHarnessRequest {
  return {
    moduleInterface,
    timingContract: allCombinationalTiming(moduleInterface),
    nonce: 'legacybyteid',
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    roles,
  };
}

// ---------------------------------------------------------------------------
// The sampled population
// ---------------------------------------------------------------------------

/** A total Role_Declaration over every input port, each independently `data` or `enable` only. */
function legacyRolesArbitrary(moduleInterface: ModuleInterface): fc.Arbitrary<RoleDeclaration> {
  const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
  return fc
    .array(fc.constantFrom<InputRole>(...LEGACY_ROLES), {
      minLength: inputPorts.length,
      maxLength: inputPorts.length,
    })
    .map((roles) =>
      inputPorts.map((port, index) => ({ portName: port.name, role: roles[index] as InputRole })),
    );
}

function scenarioArbitrary(): fc.Arbitrary<{
  readonly moduleInterface: ModuleInterface;
  readonly roles: RoleDeclaration;
}> {
  return arbModuleInterface().chain((moduleInterface) =>
    legacyRolesArbitrary(moduleInterface).map((roles) => ({ moduleInterface, roles })),
  );
}

describe(PROPERTY, () => {
  it(
    'renders no v_hold declaration, no held/strobe overwrite line, and no inline Strobe_Period ' +
      'or Hold_Frame_Period literal for any Legacy_Interface, over widely varied port widths, ' +
      'counts and names',
    () => {
      let acceptedAtLeastOnce = false;

      fc.assert(
        fc.property(scenarioArbitrary(), ({ moduleInterface, roles }) => {
          const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
          if (!rendered.ok) {
            // A generated identifier occasionally collides with a reserved Verilog keyword past
            // what `arbModuleInterface()`'s own `RESERVED` guard excludes - a legitimate refusal
            // unrelated to this property, the same reasoning
            // `rendered-stimulus-layout.property.test.ts` already applies at this call site.
            return;
          }
          acceptedAtLeastOnce = true;
          assertNoHeldOrStrobeText(rendered.value.contents);
        }),
        propertyParameters(),
      );

      expect(acceptedAtLeastOnce, 'no draw was accepted by the renderer').toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Non-vacuity: the detectors themselves must be able to fire
// ---------------------------------------------------------------------------
//
// A regex that never matches anything would pass the property above regardless of what the
// renderer actually does - the same "equivalent mutant" trap the vault records for an aggregation
// check held constant over its own sub-population. These two constructed fixtures declare a
// Held_Input and a Strobe respectively - never a Legacy_Role_Set - and are the only thing proving
// each detector can actually see what it is looking for.

describe(`${PROPERTY} (detector non-vacuity)`, () => {
  function moduleInterfaceWith(ports: readonly Port[]): ModuleInterface {
    return {
      moduleName: 'detector_mod',
      ports,
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
      validityOutputName: null,
    };
  }

  it('matches the hold declaration, the hold lane assignment and the hold overwrite line for a declared Held_Input', () => {
    const moduleInterface = moduleInterfaceWith([
      { name: 'a', direction: 'input', width: 8 },
      { name: 'q', direction: 'output', width: 8 },
    ]);
    const roles: RoleDeclaration = [{ portName: 'a', role: 'hold' }];
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.contents).toMatch(V_HOLD_DECLARATION);
    expect(rendered.value.contents).toMatch(HOLD_LANE_ASSIGNMENT);
    expect(rendered.value.contents).toMatch(HOLD_OVERWRITE_LINE);
  });

  it('matches the strobe overwrite line for a declared Strobe', () => {
    const moduleInterface = moduleInterfaceWith([
      { name: 's', direction: 'input', width: 1 },
      { name: 'q', direction: 'output', width: 1 },
    ]);
    const roles: RoleDeclaration = [{ portName: 's', role: 'strobe' }];
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.contents).toMatch(STROBE_OVERWRITE_LINE);
  });
});
