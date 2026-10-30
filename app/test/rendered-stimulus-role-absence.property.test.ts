// stimulus-transaction-structure, Property 2: An absent role contributes zero characters (task
// 4.3, C3).
//
// THE ORACLE IS THE EXACT RENDERED LINE SHAPE, NOT A BARE "67" SUBSTRING SEARCH
//   `renderStimulusFunction` (consensus-harness.ts) guards three emission sites on the declared
//   roles: the `v_hold` declaration plus its per-lane `ece_mix(32'd<lane>, step / <period>)` loop
//   (guarded on at least one `hold` port), one `v[hi:lo] = {<width>{(step % STROBE_PERIOD) ==
//   0}};` line per `strobe` port (guarded on that port's own role), and the hold-window-key value
//   the `v_hold` loop keys on, which reads `STROBE_PERIOD` when a Strobe is ALSO declared and
//   `HOLD_FRAME_PERIOD` otherwise (C3's "no-Strobe case"). `STROBE_PERIOD` and `HOLD_FRAME_PERIOD`
//   are both 67 today, so a check that only greps for "67" cannot tell the hold line apart from
//   the strobe line, or tell which constant a hold line is really keyed on - it would stay green
//   even if a future edit un-equalled the two constants while a bug still used the wrong one. This
//   file instead matches each site's full, structurally distinct line shape (`v[...] = {...{(step
//   % N) == 0}};` for the strobe site, `v_hold[...] = ece_mix(32'd<lane>, step / N);` for the hold
//   site), so the two sites stay distinguishable by shape alone no matter what `N` is.
//
// NON-VACUITY
//   The sampled population draws each input port's role independently from all four
//   `INPUT_ROLES` members, so Strobe and Hold are each sometimes declared, sometimes not, and
//   sometimes both at once, across the run - tracked explicitly below rather than assumed.
//   `(hasStrobe, hasHold)` is a closed 2x2 space, so per
//   `chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`
//   all four combinations are also EXHAUSTED directly as constructed fixtures, including the one
//   decisive trap: a Strobe and a Held_Input declared together, where the hold-window-key line
//   must read `STROBE_PERIOD`, not `HOLD_FRAME_PERIOD` - indistinguishable today by numeric value
//   alone, since both constants equal 67.
//
// Validates: Requirements 5.2, 5.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface, type Port } from '@app/core';
import {
  INPUT_ROLES,
  packedPortSlices,
  renderConsensusHarness,
  SAMPLE_BUDGET,
  type ConsensusHarnessRequest,
  type InputRole,
  type RoleDeclaration,
} from '@app/tools';
// Neither period constant is re-exported through the `@app/tools` barrel (simulator/index.ts),
// matching the convention `rendered-stimulus-enable.property.test.ts` already uses for
// `ENABLE_FRAME_PERIOD`.
import { HOLD_FRAME_PERIOD, STROBE_PERIOD } from '../tools/simulator/consensus-harness.js';

import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 2: An absent role contributes zero characters';

const COMBINATIONAL = { clockName: null, resetName: null, resetActiveLow: false } as const;

function moduleInterfaceWith(moduleName: string, ports: readonly Port[]): ModuleInterface {
  return { moduleName, ports, clocking: COMBINATIONAL, validityOutputName: null };
}

/** Sum of the input ports' widths, floored at 1 - the renderer's own `inputBundleWidth`. */
function inputBundleWidthOf(inputPorts: readonly { readonly width: number }[]): number {
  return Math.max(
    1,
    inputPorts.reduce((sum, port) => sum + port.width, 0),
  );
}

/** The exact text of the `v_hold` declaration line for a bundle of `inputBundleWidth` bits. */
function heldBundleDeclarationLine(inputBundleWidth: number): string {
  return `  reg [${String(inputBundleWidth - 1)}:0] v_hold;`;
}

/** The exact text of one lane's hold-window-key line, keyed on `periodValue`. */
function holdWindowKeyLine(lane: number, high: number, low: number, periodValue: number): string {
  return `    v_hold[${String(high)}:${String(low)}] = ece_mix(32'd${String(lane)}, step / ${String(periodValue)});`;
}

/** The exact text of one `strobe`-role port's own overwrite line. */
function strobeOverwriteLine(high: number, low: number, width: number): string {
  return `    v[${String(high)}:${String(low)}] = {${String(width)}{(step % ${String(STROBE_PERIOD)}) == 0}};`;
}

/** The hold-window-key site's line shape, independent of the numeric period value it carries. */
const HOLD_WINDOW_KEY_SHAPE = /^ {4}v_hold\[\d+:\d+] = ece_mix\(32'd\d+, step \/ \d+\);$/;

/** The strobe-overwrite site's line shape, independent of the numeric period value it carries. */
const STROBE_OVERWRITE_SHAPE = /^ {4}v\[\d+:\d+] = \{\d+\{\(step % \d+\) == 0\}\};$/;

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

/**
 * Assert Property 2 over one rendered harness: each of the three guarded sites is present if
 * and only if the role it belongs to is declared, matched by the site's own line shape rather
 * than by the numeric period value it happens to carry today.
 */
function assertAbsentRoleContributesZeroCharacters(
  inputPorts: readonly { readonly name: string; readonly width: number }[],
  roles: RoleDeclaration,
  text: string,
): void {
  const hasStrobe = roles.some((entry) => entry.role === 'strobe');
  const hasHold = roles.some((entry) => entry.role === 'hold');
  const lines = text.split('\n');

  // Site 1: the held bundle identifier, declaration included, occurs at all iff at least one
  // port is `hold`. A plain substring check is correct here - `v_hold` is an identifier, not a
  // numeric literal two constants could collide on.
  expect(text.includes('v_hold')).toBe(hasHold);
  const inputBundleWidth = inputBundleWidthOf(inputPorts);
  if (hasHold) {
    expect(text).toContain(heldBundleDeclarationLine(inputBundleWidth));
  }

  // Site 2: one hold-window-key line per 64-bit lane, present iff `hasHold`, keyed on
  // STROBE_PERIOD when a Strobe is also declared and on HOLD_FRAME_PERIOD otherwise (C3's
  // no-Strobe case) - the exact branch a bare "67" search cannot distinguish.
  const holdWindowPeriod = hasStrobe ? STROBE_PERIOD : HOLD_FRAME_PERIOD;
  const laneCount = Math.ceil(inputBundleWidth / 64);
  for (let lane = 0; lane < laneCount; lane += 1) {
    const low = lane * 64;
    const high = Math.min(inputBundleWidth, 64 * (lane + 1)) - 1;
    const line = holdWindowKeyLine(lane, high, low, holdWindowPeriod);
    if (hasHold) {
      expect(text).toContain(line);
    } else {
      expect(text).not.toContain(line);
    }
  }
  expect(lines.some((line) => HOLD_WINDOW_KEY_SHAPE.test(line))).toBe(hasHold);

  // Site 3: one strobe-overwrite line per `strobe`-role port's own slice, present iff THAT port
  // is `strobe`, never for a `data`, `enable`, or `hold` port.
  for (const slice of packedPortSlices(inputPorts)) {
    const role = roles.find((entry) => entry.portName === slice.name)?.role;
    const width = slice.high - slice.low + 1;
    const line = strobeOverwriteLine(slice.high, slice.low, width);
    if (role === 'strobe') {
      expect(text).toContain(line);
    } else {
      expect(text).not.toContain(line);
    }
  }
  expect(lines.some((line) => STROBE_OVERWRITE_SHAPE.test(line))).toBe(hasStrobe);
}

// ---------------------------------------------------------------------------
// The sampled population
// ---------------------------------------------------------------------------

/** One generated interface, paired with a total Role_Declaration drawing each input port's
 * role independently from all four `INPUT_ROLES` members, so Strobe and Hold are each
 * sometimes present, sometimes absent, and sometimes both at once, across the run. Carries an
 * empty `roles` for a zero-input-port draw, discarded by the property's own `fc.pre`. */
function scenarioArbitrary(): fc.Arbitrary<{
  readonly moduleInterface: ModuleInterface;
  readonly roles: RoleDeclaration;
}> {
  return arbModuleInterface().chain(
    (
      moduleInterface,
    ): fc.Arbitrary<{
      readonly moduleInterface: ModuleInterface;
      readonly roles: RoleDeclaration;
    }> => {
      const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
      if (inputPorts.length === 0) {
        return fc.constant({ moduleInterface, roles: [] });
      }
      return fc
        .array(fc.constantFrom<InputRole>(...INPUT_ROLES), {
          minLength: inputPorts.length,
          maxLength: inputPorts.length,
        })
        .map((pickedRoles) => ({
          moduleInterface,
          roles: inputPorts.map((port, index) => ({
            portName: port.name,
            role: pickedRoles[index] as InputRole,
          })),
        }));
    },
  );
}

describe(PROPERTY, () => {
  it(
    'renders the held-bundle, hold-window-key, and strobe-overwrite sites if and only if the ' +
      'role each belongs to is declared, matched by line shape rather than by the numeric ' +
      'period value',
    () => {
      let strobeOnlyCases = 0;
      let holdOnlyCases = 0;
      let neitherCases = 0;
      let bothCases = 0;

      fc.assert(
        fc.property(scenarioArbitrary(), ({ moduleInterface, roles }) => {
          // A zero-input-port draw cannot carry a non-empty Role_Declaration at all.
          fc.pre(roles.length > 0);

          const rendered = renderConsensusHarness(requestFor(moduleInterface, roles, 'roleabsnc'));
          // A vanishingly rare reserved-keyword draw beyond `arbModuleInterface`'s own guard; not
          // the claim under test, so it is discarded (same reasoning as the enable/layout files).
          fc.pre(rendered.ok);
          if (!rendered.ok) {
            return;
          }

          const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
          const hasStrobe = roles.some((entry) => entry.role === 'strobe');
          const hasHold = roles.some((entry) => entry.role === 'hold');
          if (hasStrobe && hasHold) {
            bothCases += 1;
          } else if (hasStrobe) {
            strobeOnlyCases += 1;
          } else if (hasHold) {
            holdOnlyCases += 1;
          } else {
            neitherCases += 1;
          }

          assertAbsentRoleContributesZeroCharacters(inputPorts, roles, rendered.value.contents);
        }),
        propertyParameters(),
      );

      // NON-VACUITY: all four (Strobe declared, Held_Input declared) combinations must have
      // actually been exercised, not just declared possible - the "if and only if" clause is
      // untested in whichever combination the sampler happened to skip.
      expect({
        strobeOnly: strobeOnlyCases > 0,
        holdOnly: holdOnlyCases > 0,
        neither: neitherCases > 0,
        both: bothCases > 0,
      }).toEqual({ strobeOnly: true, holdOnly: true, neither: true, both: true });
    },
  );
});

// ---------------------------------------------------------------------------
// Non-vacuity: the closed 2x2 (Strobe, Hold) space, exhausted directly rather than sampled
// ---------------------------------------------------------------------------

describe(`${PROPERTY} (constructed fixtures)`, () => {
  it('contributes neither site for an interface naming no Strobe and no Held_Input', () => {
    const moduleInterface = moduleInterfaceWith('all_data_mod', [
      { name: 'a', direction: 'input', width: 8 },
      { name: 'b', direction: 'input', width: 4 },
      { name: 'q', direction: 'output', width: 8 },
    ]);
    const roles: RoleDeclaration = [
      { portName: 'a', role: 'data' },
      { portName: 'b', role: 'enable' },
    ];
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles, 'roleabsa'));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
    assertAbsentRoleContributesZeroCharacters(inputPorts, roles, rendered.value.contents);
  });

  it('contributes the strobe-overwrite site alone for an interface naming a Strobe but no Held_Input', () => {
    const moduleInterface = moduleInterfaceWith('strobe_only_mod', [
      { name: 's', direction: 'input', width: 1 },
      { name: 'q', direction: 'output', width: 8 },
    ]);
    const roles: RoleDeclaration = [{ portName: 's', role: 'strobe' }];
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles, 'roleabsb'));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
    assertAbsentRoleContributesZeroCharacters(inputPorts, roles, rendered.value.contents);
  });

  it('keys the hold-window-key site on HOLD_FRAME_PERIOD for an interface naming a Held_Input but no Strobe', () => {
    const moduleInterface = moduleInterfaceWith('hold_only_mod', [
      { name: 'h', direction: 'input', width: 8 },
      { name: 'q', direction: 'output', width: 8 },
    ]);
    const roles: RoleDeclaration = [{ portName: 'h', role: 'hold' }];
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles, 'roleabsc'));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
    assertAbsentRoleContributesZeroCharacters(inputPorts, roles, rendered.value.contents);
    expect(rendered.value.contents).toContain(holdWindowKeyLine(0, 7, 0, HOLD_FRAME_PERIOD));
  });

  it(
    'keys the hold-window-key site on STROBE_PERIOD instead when a Strobe is declared ' +
      'alongside the Held_Input - the divergence trap the two equal-valued constants hide today',
    () => {
      const moduleInterface = moduleInterfaceWith('hold_and_strobe_mod', [
        { name: 'h', direction: 'input', width: 8 },
        { name: 's', direction: 'input', width: 1 },
        { name: 'q', direction: 'output', width: 8 },
      ]);
      const roles: RoleDeclaration = [
        { portName: 'h', role: 'hold' },
        { portName: 's', role: 'strobe' },
      ];
      const rendered = renderConsensusHarness(requestFor(moduleInterface, roles, 'roleabsd'));
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
      assertAbsentRoleContributesZeroCharacters(inputPorts, roles, rendered.value.contents);
      // C3's own worked example: the hold line is keyed on STROBE_PERIOD, not HOLD_FRAME_PERIOD,
      // the moment a Strobe is declared too - both read 67 today, but this pins the BRANCH, so a
      // future edit that un-equals the two constants fails here instead of staying silently green.
      expect(rendered.value.contents).toContain(holdWindowKeyLine(0, 8, 0, STROBE_PERIOD));
      expect(rendered.value.contents).toContain(strobeOverwriteLine(8, 8, 1));
    },
  );
});
