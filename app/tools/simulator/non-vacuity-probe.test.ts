// Smoke coverage for the Non_Vacuity_Probe renderer (C8; Req 7.1, 7.3, 7.6): the renderer's own
// basic shape - one module, the required dump block, the ECE_STIM line pair, and the two
// refusal paths it re-derives from the harness's own boundaries. The reader (C9, task 8.2) and
// the real-toolchain hold/strobe properties (tasks 8.8-8.11) own the behavioural claims; this
// file only pins the shape renderNonVacuityProbe itself is responsible for.

import { describe, expect, it } from 'vitest';

import type { ClockingContract, ModuleInterface, Port } from '@app/core';

import {
  renderStimulusFunction,
  sizedSampleBudget,
  type RoleDeclaration,
} from './consensus-harness.js';
import { NON_VACUITY_PROBE_PATH, renderNonVacuityProbe } from './non-vacuity-probe.js';

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

function moduleInterfaceWith(moduleName: string, ports: readonly Port[]): ModuleInterface {
  return { moduleName, ports, clocking: COMBINATIONAL, validityOutputName: null };
}

/** A total Role_Declaration naming every input port of `moduleInterface` as `data`. */
function allDataRoles(moduleInterface: ModuleInterface): RoleDeclaration {
  return moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => ({ portName: port.name, role: 'data' as const }));
}

const ADDER_INTERFACE = moduleInterfaceWith('adder', [
  { name: 'a', direction: 'input', width: 4 },
  { name: 'b', direction: 'input', width: 4 },
  { name: 'sum', direction: 'output', width: 5 },
]);

describe('renderNonVacuityProbe', () => {
  it('renders one module carrying the required dump block and the ECE_STIM/ECE_STIM_END lines', () => {
    const rendered = renderNonVacuityProbe({
      moduleInterface: ADDER_INTERFACE,
      nonce: 'abc123',
      roles: allDataRoles(ADDER_INTERFACE),
      sampleBudget: 2048,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.path).toBe(NON_VACUITY_PROBE_PATH);
    const text = rendered.value.contents;
    expect((text.match(/^module\s+\w/gmu) ?? []).length).toBe(1);
    expect(text).toContain('$dumpfile("dump.vcd");');
    expect(text).toContain('$dumpvars(0, ece_stimulus_probe);');
    expect(text).toContain('$display("ECE_STIM %0s %0d %0h", "abc123", step, v);');
    expect(text).toContain('$display("ECE_STIM_END %0s %0d", "abc123", ECE_PROBE_BUDGET);');
    // ECE_STIM must not collide with the harness's own ECE_SAMPLE prefix (Req 7.6).
    expect(text).not.toContain('ECE_SAMPLE');
  });

  it('renders the exact same Stimulus_Function text the harness would render for the same inputs', () => {
    const inputPorts = ADDER_INTERFACE.ports.filter((port) => port.direction === 'input');
    const roles = allDataRoles(ADDER_INTERFACE);
    const expectedStimulusFunction = renderStimulusFunction(inputPorts, 8, roles).join('\n');
    const rendered = renderNonVacuityProbe({
      moduleInterface: ADDER_INTERFACE,
      nonce: 'abc123',
      roles,
      sampleBudget: 2048,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.contents).toContain(expectedStimulusFunction);
  });

  it('refuses an incomplete Role_Declaration with the same DomainError the harness would give', () => {
    const rendered = renderNonVacuityProbe({
      moduleInterface: ADDER_INTERFACE,
      nonce: 'abc123',
      roles: [{ portName: 'a', role: 'data' }], // omits input port "b"
      sampleBudget: 2048,
    });
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.error.code).toBe('INCOMPLETE_ROLE_DECLARATION');
  });

  it('refuses rather than renders when the requested budget exceeds the input-width-sized cap', () => {
    const wideInterface = moduleInterfaceWith('wide', [
      { name: 'd', direction: 'input', width: 2_000_000 },
      { name: 'q', direction: 'output', width: 1 },
    ]);
    const requestedSampleBudget = 2048;
    const cap = sizedSampleBudget('abc123'.length, 2_000_000, requestedSampleBudget);
    expect(cap).toBeLessThan(requestedSampleBudget); // sanity: the fixture must exercise the cap
    const rendered = renderNonVacuityProbe({
      moduleInterface: wideInterface,
      nonce: 'abc123',
      roles: allDataRoles(wideInterface),
      sampleBudget: requestedSampleBudget,
    });
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.error.code).toBe('NON_VACUITY_PROBE_BUDGET_EXCEEDS_CAP');
    expect(rendered.error.message).toContain(String(requestedSampleBudget));
    expect(rendered.error.message).toContain(String(cap));
  });

  it('renders byte-identical text across two renders of one request', () => {
    const request = {
      moduleInterface: ADDER_INTERFACE,
      nonce: 'abc123',
      roles: allDataRoles(ADDER_INTERFACE),
      sampleBudget: 2048,
    };
    const first = renderNonVacuityProbe(request);
    const second = renderNonVacuityProbe(request);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.contents).toBe(second.value.contents);
  });
});
