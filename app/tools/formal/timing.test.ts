// Unit tests pinning the Timing_Classifier's CLAUSE ORDER on hand-built findings (task 4.4).
//
// The clause order is the whole rule, and every clause but one is only reachable because the
// clauses ahead of it did not fire, so each case below is built to make exactly one adjacent pair
// of clauses disagree. Properties 1 to 6, 9, and 10 over the same function belong to tasks 4.5
// through 4.12 and are not restated here.
//
// Findings are hand-built rather than read from a netlist on purpose: the shapes that separate the
// clauses - partial drive beside a reached data input, a Mealy output on a clocked design, a cone
// whose only input is the reset - are the shapes a real corpus design does not conveniently carry
// one at a time.

import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';

import type { PortTimingFacts, PrepassTimingFinding } from './prepass.js';
import { classifyPortTiming } from './timing.js';

/** A clocked interface with one data input, the clock, an active-low reset, and two outputs. */
const CLOCKED: ModuleInterface = {
  moduleName: 'fsm_like',
  ports: [
    { name: 'clk', direction: 'input', width: 1 },
    { name: 'rst_n', direction: 'input', width: 1 },
    { name: 'IN', direction: 'input', width: 8 },
    { name: 'MATCH', direction: 'output', width: 1 },
    { name: 'state_out', direction: 'output', width: 4 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

/** Cone facts for one port, defaulting to the fully-driven, input-free, stateless shape. */
function facts(port: string, overrides: Partial<Omit<PortTimingFacts, 'port'>>): PortTimingFacts {
  return { port, sources: [], reachesState: false, undriven: false, ...overrides };
}

/** A derived finding carrying exactly `ports`. */
function derived(ports: readonly PortTimingFacts[]): PrepassTimingFinding {
  return { derived: true, ports };
}

describe('classifyPortTiming clause order', () => {
  it('clause 1 names every declared output port when the whole walk refused', () => {
    const classified = classifyPortTiming(CLOCKED, {
      derived: false,
      cause: 'unrecognized-clocked-cell',
    });

    expect(classified.ok).toBe(false);
    if (classified.ok) return;
    expect(classified.error.cause).toBe('netlist-walk-unreliable');
    expect(classified.error.ports).toEqual(['MATCH', 'state_out']);
  });

  it('clause 1 refuses a declared output port the report omits', () => {
    const classified = classifyPortTiming(CLOCKED, derived([facts('MATCH', { sources: ['IN'] })]));

    expect(classified.ok).toBe(false);
    if (classified.ok) return;
    expect(classified.error.cause).toBe('port-not-reported');
    expect(classified.error.ports).toEqual(['state_out']);
  });

  it('clause 2 beats clause 3: a partially driven port reaching a data input still refuses', () => {
    const classified = classifyPortTiming(
      CLOCKED,
      derived([
        facts('MATCH', { sources: ['IN'], undriven: true }),
        facts('state_out', { reachesState: true }),
      ]),
    );

    expect(classified.ok).toBe(false);
    if (classified.ok) return;
    expect(classified.error.cause).toBe('undriven-output-port');
    expect(classified.error.ports).toEqual(['MATCH']);
  });

  it('clause 3 beats clause 4: a Mealy output on a clocked design is combinational', () => {
    const classified = classifyPortTiming(
      CLOCKED,
      derived([
        facts('MATCH', { sources: ['IN', 'rst_n'], reachesState: true }),
        facts('state_out', { reachesState: true }),
      ]),
    );

    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value.entries).toEqual([
      { portName: 'MATCH', timing: 'combinational' },
      { portName: 'state_out', timing: 'registered' },
    ]);
  });

  it('clause 4 takes the Moore decode, whose cone names only the clock and the reset', () => {
    const classified = classifyPortTiming(
      CLOCKED,
      derived([
        facts('MATCH', { sources: ['clk', 'rst_n'], reachesState: true }),
        facts('state_out', { sources: ['rst_n'], reachesState: true }),
      ]),
    );

    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value.entries).toEqual([
      { portName: 'MATCH', timing: 'registered' },
      { portName: 'state_out', timing: 'registered' },
    ]);
  });

  it('clause 5 refuses a driven constant output rather than calling it combinational', () => {
    const classified = classifyPortTiming(
      CLOCKED,
      derived([facts('MATCH', {}), facts('state_out', { reachesState: true })]),
    );

    expect(classified.ok).toBe(false);
    if (classified.ok) return;
    expect(classified.error.cause).toBe('input-and-state-independent');
    expect(classified.error.ports).toEqual(['MATCH']);
  });

  it('returns ONE refusal naming every accumulated port under the dominant cause', () => {
    const classified = classifyPortTiming(
      CLOCKED,
      derived([facts('MATCH', {}), facts('state_out', { undriven: true })]),
    );

    expect(classified.ok).toBe(false);
    if (classified.ok) return;
    // `undriven-output-port` is clause 2 and outranks clause 5's cause; both names survive.
    expect(classified.error.cause).toBe('undriven-output-port');
    expect(classified.error.ports).toEqual(['MATCH', 'state_out']);
  });

  it('builds the empty contract for an interface declaring no output port', () => {
    const inputsOnly: ModuleInterface = {
      ...CLOCKED,
      ports: CLOCKED.ports.filter((port) => port.direction === 'input'),
    };

    const classified = classifyPortTiming(inputsOnly, derived([]));

    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value.entries).toEqual([]);
  });

  it('carries no text from the finding into a refusal (Req 2.5)', () => {
    const classified = classifyPortTiming(CLOCKED, {
      derived: false,
      cause: 'cell-shape-unreadable',
    });

    expect(classified.ok).toBe(false);
    if (classified.ok) return;
    expect(Object.keys(classified.error).sort()).toEqual(['cause', 'ports']);
  });
});
