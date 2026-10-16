// Unit tests for the validating `makeTimingContract` constructor (C5).
//
// Covers the example cases task 1.2 names: a contract over zero output ports
// constructs empty; a single gap names exactly that port; three gaps name all
// three; an entry on an input port is refused; the decode refuses "__proto__"
// and "constructor" by membership rather than by record indexing.

import { describe, expect, it } from 'vitest';

import { isPortTiming, makeTimingContract } from './timing-contract.js';
import type { ClockingContract, ModuleInterface, Port } from './spec.js';

const NO_CLOCKING: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

function interfaceWith(ports: readonly Port[]): ModuleInterface {
  return { moduleName: 'm', ports, clocking: NO_CLOCKING, validityOutputName: null };
}

const THREE_OUTPUTS = interfaceWith([
  { name: 'en', direction: 'input', width: 1 },
  { name: 'sum', direction: 'output', width: 8 },
  { name: 'carry', direction: 'output', width: 1 },
  { name: 'match', direction: 'output', width: 1 },
]);

describe('makeTimingContract', () => {
  it('constructs empty over an interface with zero output ports', () => {
    const onlyInputs = interfaceWith([{ name: 'en', direction: 'input', width: 1 }]);
    const built = makeTimingContract(onlyInputs, []);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.entries).toEqual([]);
  });

  it('constructs with a mix of registered and combinational entries', () => {
    const built = makeTimingContract(THREE_OUTPUTS, [
      { portName: 'sum', timing: 'registered' },
      { portName: 'carry', timing: 'registered' },
      { portName: 'match', timing: 'combinational' },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.entries).toHaveLength(3);
  });

  it('names exactly the one missing port when a single entry is omitted', () => {
    const built = makeTimingContract(THREE_OUTPUTS, [
      { portName: 'sum', timing: 'registered' },
      { portName: 'carry', timing: 'registered' },
    ]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('MISSING_PORT_TIMING');
    expect(built.error.message).toContain('match');
    expect(built.error.message).not.toContain('sum');
    expect(built.error.message).not.toContain('carry');
  });

  it('names all three missing ports when every entry is omitted', () => {
    const built = makeTimingContract(THREE_OUTPUTS, []);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('MISSING_PORT_TIMING');
    expect(built.error.message).toContain('sum');
    expect(built.error.message).toContain('carry');
    expect(built.error.message).toContain('match');
  });

  it('refuses an entry naming an input port', () => {
    const built = makeTimingContract(THREE_OUTPUTS, [
      { portName: 'en', timing: 'combinational' },
      { portName: 'sum', timing: 'registered' },
      { portName: 'carry', timing: 'registered' },
      { portName: 'match', timing: 'combinational' },
    ]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('TIMING_ENTRY_NOT_AN_OUTPUT_PORT');
  });

  it('refuses a duplicate entry for one port', () => {
    const built = makeTimingContract(THREE_OUTPUTS, [
      { portName: 'sum', timing: 'registered' },
      { portName: 'sum', timing: 'combinational' },
      { portName: 'carry', timing: 'registered' },
      { portName: 'match', timing: 'combinational' },
    ]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('DUPLICATE_PORT_TIMING_ENTRY');
  });

  it('decodes PortTiming by Set membership, refusing "__proto__" and "constructor"', () => {
    expect(isPortTiming('__proto__')).toBe(false);
    expect(isPortTiming('constructor')).toBe(false);
    expect(isPortTiming('registered')).toBe(true);
    expect(isPortTiming('combinational')).toBe(true);
  });
});
