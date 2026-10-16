// Unit tests over the Measurement_Limit registry (Req 12.2, 12.8; task 3.2).
//
// Enumerates DECLARED_LIMITS rather than naming its limits one by one, so a limit added later
// is covered without this file being edited. Why a registry: see design.md, Component C3.

import { describe, expect, it } from 'vitest';

import type { DomainError } from '@app/core';
import { MAX_WARM_UP_DEPTH } from '@app/tools';

import {
  DECLARED_LIMITS,
  LIMIT_REASONS,
  limitOrRefuse,
  type MeasurementLimit,
} from './measurement-limit.js';

/** Names a bare `DECLARED_LIMITS[name]` resolves on the prototype instead of refusing. */
const PROTOTYPE_NAMES = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty'];

/** Names the registry does not hold: the prototype class, near misses of a real key, and nothing. */
const UNDECLARED_NAMES = [
  ...PROTOTYPE_NAMES,
  '',
  '  ',
  'proof-depth ',
  'PROOF-DEPTH',
  'proof_depth',
  'session-token-budget',
];

/** The limit a name resolves to, failing the test if it was refused. */
function resolved(name: string): MeasurementLimit {
  const result = limitOrRefuse(name);
  if (!result.ok) {
    throw new Error(`expected "${name}" to resolve but it was refused: ${result.error.message}`);
  }
  return result.value;
}

/** The refusal for a name, failing the test if the registry resolved it instead. */
function refusal(name: string): DomainError {
  const result = limitOrRefuse(name);
  if (result.ok) {
    throw new Error(`expected "${name}" to be refused but it resolved to "${result.value.name}"`);
  }
  return result.error;
}

describe('the Limit_Reason vocabulary', () => {
  it('given the vocabulary, when enumerated, then it is exactly the three declared reasons', () => {
    // Exact equality is what refuses a fourth member, cost-shaped or otherwise (Req 12.3).
    expect([...LIMIT_REASONS].sort()).toEqual([
      'anomaly-detection',
      'population-honesty',
      'termination',
    ]);
  });
});

describe('the Measurement_Limit registry', () => {
  it('given every declared limit, when its reason is read, then it is in the vocabulary', () => {
    const limits = Object.values(DECLARED_LIMITS);
    // An empty registry would pass the loop below without checking anything.
    expect(limits.length).toBeGreaterThan(0);

    for (const limit of limits) {
      expect(LIMIT_REASONS, `limit "${limit.name}" carries reason "${limit.reason}"`).toContain(
        limit.reason,
      );
    }
  });

  it('given every declared limit, when its key is read, then the name equals the key', () => {
    for (const [key, limit] of Object.entries(DECLARED_LIMITS)) {
      expect(limit.name, `limit under key "${key}"`).toBe(key);
    }
  });

  it('given every declared limit, when its value is read, then it is positive and finite', () => {
    for (const limit of Object.values(DECLARED_LIMITS)) {
      // Catches a ceiling whose imported constant went missing, which arrives as NaN.
      expect(Number.isFinite(limit.value), `limit "${limit.name}" value ${limit.value}`).toBe(true);
      expect(limit.value, `limit "${limit.name}"`).toBeGreaterThan(0);
    }
  });

  it('given the registry, when read, then the Warm_Up_Ceiling is not among its limits', () => {
    // The ceiling is a soundness bound in product code that no measurement chose to run under, so
    // it has no Limit_Reason to give and registering it would fail beside the rule it breaks.
    const inSteps = Object.values(DECLARED_LIMITS).filter((limit) => limit.unit === 'steps');
    // A populated slice, so the absence below is a measurement rather than a vacuous pass.
    expect(inSteps.length).toBeGreaterThan(0);

    expect(inSteps.filter((limit) => limit.value === MAX_WARM_UP_DEPTH)).toEqual([]);
  });

  it('given the registry, when read, then it and every entry is frozen', () => {
    expect(Object.isFrozen(DECLARED_LIMITS)).toBe(true);
    for (const limit of Object.values(DECLARED_LIMITS)) {
      expect(Object.isFrozen(limit), `limit "${limit.name}"`).toBe(true);
    }
  });
});

describe('limitOrRefuse', () => {
  it('given every declared name, when asked for, then the registry entry itself comes back', () => {
    // The positive control: the refusals below would otherwise pass for a function that
    // refuses every name.
    for (const [key, limit] of Object.entries(DECLARED_LIMITS)) {
      expect(resolved(key)).toBe(limit);
    }
  });

  it('given a name the registry does not hold, when asked for, then it refuses and names it', () => {
    for (const name of UNDECLARED_NAMES) {
      const error = refusal(name);
      expect(error.code, `name ${JSON.stringify(name)}`).toBe('MEASUREMENT_LIMIT_NOT_DECLARED');
      expect(error.field, `name ${JSON.stringify(name)}`).toBe('name');
      // Quoted, because the empty name is a substring of every message.
      expect(error.message).toContain(`"${name}"`);
    }
  });
});
