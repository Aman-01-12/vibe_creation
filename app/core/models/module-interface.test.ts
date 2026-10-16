// Unit tests for the validating `makeModuleInterface` constructor (C5).
//
// Covers the four example cases task 1.1 names: a name that is an input port is
// refused; a name absent from the port list is refused; an empty-string name is
// refused rather than silently meaning none; omission yields exactly `null`.

import { describe, expect, it } from 'vitest';

import { makeModuleInterface } from './module-interface.js';
import type { ClockingContract, Port } from './spec.js';

const NO_CLOCKING: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

const PORTS: readonly Port[] = [
  { name: 'a', direction: 'input', width: 1 },
  { name: 'valid', direction: 'output', width: 1 },
  { name: 'result', direction: 'output', width: 8 },
];

describe('makeModuleInterface', () => {
  it('accepts a validityOutputName that names a declared output port', () => {
    const built = makeModuleInterface({
      moduleName: 'm',
      ports: PORTS,
      clocking: NO_CLOCKING,
      validityOutputName: 'valid',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.validityOutputName).toBe('valid');
  });

  it('fills validityOutputName with null when the field is omitted', () => {
    const built = makeModuleInterface({ moduleName: 'm', ports: PORTS, clocking: NO_CLOCKING });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.validityOutputName).toBeNull();
  });

  it('refuses a validityOutputName that is an input port', () => {
    const built = makeModuleInterface({
      moduleName: 'm',
      ports: PORTS,
      clocking: NO_CLOCKING,
      validityOutputName: 'a',
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('VALIDITY_OUTPUT_NOT_A_DECLARED_OUTPUT_PORT');
  });

  it('refuses a validityOutputName absent from the port list', () => {
    const built = makeModuleInterface({
      moduleName: 'm',
      ports: PORTS,
      clocking: NO_CLOCKING,
      validityOutputName: 'nonexistent',
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('VALIDITY_OUTPUT_NOT_A_DECLARED_OUTPUT_PORT');
  });

  it('refuses an empty-string validityOutputName rather than treating it as none', () => {
    const built = makeModuleInterface({
      moduleName: 'm',
      ports: PORTS,
      clocking: NO_CLOCKING,
      validityOutputName: '',
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('VALIDITY_OUTPUT_NOT_A_DECLARED_OUTPUT_PORT');
  });
});
