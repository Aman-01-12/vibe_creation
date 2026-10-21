// Unit test pinning the Adjacency_Classifier's own output on real measured cone facts, and
// confirming it agrees with `classifyPortTiming` on both (task 13.1; Req 6.13).
//
// `traffic_light`'s facts below are copied from the worker's own pinned assertion in
// `test_a_registered_design_reports_no_data_input_source_on_any_port`
// (`app/tools/sandbox/worker/tests/test_formal_prepass.py`): all four declared outputs report an
// empty `sources` list and `reachesState: true`. `fsm`'s `MATCH` facts follow design.md's own
// measured finding 6 and the committed Ground_Truth entry (`timing-ground-truth.ts`): a Mealy
// output whose cone reaches the declared data input `IN` directly, inside a process that also
// crosses the state register `ST_cr` - there is no committed netlist-fixture JSON for `fsm` at
// the worker layer to load from, so these facts are hand-built to the measured shape, the same
// way the sibling `timing.test.ts` hand-builds its own clause-order fixtures.
//
// Both designs are chosen because design.md records that the two rules AGREE on them -
// `traffic_light` is the Moore shape with no data input reachable, and `fsm` is Mealy - so this
// test is the "both rules agree" anchor task 13.1 asks for, not a search for a disagreement.
// The search over the whole Derivation_Population is task 13.2.

import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';

import { classifyPortTimingByAdjacency } from './adjacency-timing.js';
import type { PortTimingFacts, PrepassTimingFinding } from './prepass.js';
import { classifyPortTiming } from './timing.js';

/** `verified_traffic_light`'s declared interface: `clock` aliases the register `cnt` directly. */
const TRAFFIC_LIGHT: ModuleInterface = {
  moduleName: 'traffic_light',
  ports: [
    { name: 'rst_n', direction: 'input', width: 1 },
    { name: 'clk', direction: 'input', width: 1 },
    { name: 'pass_request', direction: 'input', width: 1 },
    { name: 'clock', direction: 'output', width: 8 },
    { name: 'red', direction: 'output', width: 1 },
    { name: 'yellow', direction: 'output', width: 1 },
    { name: 'green', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

/** Every declared output port of `traffic_light` reports no source and crosses retained state. */
const TRAFFIC_LIGHT_FACTS: readonly PortTimingFacts[] = [
  { port: 'clock', sources: [], reachesState: true, undriven: false },
  { port: 'red', sources: [], reachesState: true, undriven: false },
  { port: 'yellow', sources: [], reachesState: true, undriven: false },
  { port: 'green', sources: [], reachesState: true, undriven: false },
];

/** `verified_fsm`'s declared interface: a Mealy design with one clocked state register. */
const FSM: ModuleInterface = {
  moduleName: 'fsm',
  ports: [
    { name: 'IN', direction: 'input', width: 1 },
    { name: 'CLK', direction: 'input', width: 1 },
    { name: 'RST', direction: 'input', width: 1 },
    { name: 'MATCH', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'CLK', resetName: 'RST', resetActiveLow: false },
  validityOutputName: null,
};

/** `MATCH` reaches the data input `IN` directly and also crosses the state register `ST_cr`. */
const FSM_FACTS: readonly PortTimingFacts[] = [
  { port: 'MATCH', sources: ['IN', 'RST'], reachesState: true, undriven: false },
];

function derived(ports: readonly PortTimingFacts[]): PrepassTimingFinding {
  return { derived: true, ports };
}

describe('classifyPortTimingByAdjacency agrees with classifyPortTiming', () => {
  it('derives `registered` for every traffic_light port, matching the cone rule', () => {
    const finding = derived(TRAFFIC_LIGHT_FACTS);

    const cone = classifyPortTiming(TRAFFIC_LIGHT, finding);
    const adjacency = classifyPortTimingByAdjacency(TRAFFIC_LIGHT, finding);

    expect(cone.ok).toBe(true);
    expect(adjacency.ok).toBe(true);
    if (!cone.ok || !adjacency.ok) return;
    const expected = [
      { portName: 'clock', timing: 'registered' },
      { portName: 'red', timing: 'registered' },
      { portName: 'yellow', timing: 'registered' },
      { portName: 'green', timing: 'registered' },
    ];
    expect(cone.value.entries).toEqual(expected);
    expect(adjacency.value.entries).toEqual(expected);
  });

  it("derives `combinational` for fsm's MATCH, matching the cone rule", () => {
    const finding = derived(FSM_FACTS);

    const cone = classifyPortTiming(FSM, finding);
    const adjacency = classifyPortTimingByAdjacency(FSM, finding);

    expect(cone.ok).toBe(true);
    expect(adjacency.ok).toBe(true);
    if (!cone.ok || !adjacency.ok) return;
    const expected = [{ portName: 'MATCH', timing: 'combinational' }];
    expect(cone.value.entries).toEqual(expected);
    expect(adjacency.value.entries).toEqual(expected);
  });
});
