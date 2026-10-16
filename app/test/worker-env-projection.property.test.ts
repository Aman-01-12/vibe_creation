// The total form of the claim the example tests beside `app/tools/sandbox/worker-environment.ts`
// only sample: over any host environment, no name outside the allowlist reaches the child and
// every allowlisted name is accounted for exactly once. See design.md, Component C1.
//
// Values are materialized from a closed kind union inside the property, so a counterexample
// prints names and kind labels and never a value (Req 1.9). Nothing here reads `process.env`.
//
// The tag is a literal because `propertyTag` in this package hardcodes another spec's slug.
//
// **Validates: Requirements 1.1, 1.3**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { WORKER_ENVIRONMENT_ALLOWLIST, projectWorkerEnvironment } from '@app/tools';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 1: The worker environment projection is total and closed
const PROPERTY =
  'formal-gate-first-light, Property 1: The worker environment projection is total and closed';

/** Every shape below runs at worst ~20% of draws, so 2000 leaves no row to luck. */
const NUM_RUNS = 2000;

/** A host environment as `projectWorkerEnvironment` declares it. */
type HostEnvironment = Readonly<Record<string, string | undefined>>;

// -- Generators ---------------------------------------------------------------

const VALUE_KINDS = ['unset', 'empty', 'plain', 'extends-plain', 'contains-plain'] as const;

type ValueKind = (typeof VALUE_KINDS)[number];

/** `unset` is the host holding a key with no value, which the projection must read as absent. */
const VALUE_BY_KIND: Record<ValueKind, string | undefined> = {
  unset: undefined,
  empty: '',
  plain: 'v',
  'extends-plain': 'v-tail',
  'contains-plain': 'head-v-tail',
};

/** Names differing from an allowlisted one only in case: what a case-blind lookup would leak. */
const CASE_VARIANT_NAMES = ['path', 'Path', 'pAtH'] as const;

/** Names containing an allowlisted name: what a prefix or substring match would leak. */
const SUPERSTRING_NAMES = ['PATHEXT', 'XPATH', 'PATH_INFO'] as const;

/** Keys that `Object.prototype` holds, which a prototype-blind lookup would read as present. */
const PROTOTYPE_SHAPED_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'] as const;

/** Ordinary host names. A credential's name belongs in source; only its value does not. */
const UNRELATED_NAMES = ['HOME', 'SHELL', 'LANG', 'TMPDIR', 'AWS_BEARER_TOKEN_BEDROCK'] as const;

const hostNameArbitrary: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.constantFrom(...WORKER_ENVIRONMENT_ALLOWLIST), weight: 4 },
  { arbitrary: fc.constantFrom(...UNRELATED_NAMES), weight: 4 },
  { arbitrary: fc.constantFrom(...CASE_VARIANT_NAMES), weight: 3 },
  { arbitrary: fc.constantFrom(...SUPERSTRING_NAMES), weight: 3 },
  { arbitrary: fc.constantFrom(...PROTOTYPE_SHAPED_NAMES), weight: 3 },
  { arbitrary: fc.string({ unit: 'grapheme' }), weight: 2 },
);

/** Draw-order entries, so a repeated name resolves the way an assignment would. */
const hostEntriesArbitrary = fc.array(
  fc.tuple(hostNameArbitrary, fc.constantFrom(...VALUE_KINDS)),
  { maxLength: 10 },
);

/** `Object.fromEntries` defines own properties, so `__proto__` lands as a key, not a prototype. */
function materialize(entries: readonly (readonly [string, ValueKind])[]): HostEnvironment {
  return Object.fromEntries(entries.map(([name, kind]) => [name, VALUE_BY_KIND[kind]]));
}

// -- The oracle: design.md's sentence, read over own properties ---------------

/** The allowlist intersected with the host. Own properties only, so no inherited name counts. */
function heldNames(host: HostEnvironment): readonly string[] {
  return WORKER_ENVIRONMENT_ALLOWLIST.filter(
    (name) => Object.hasOwn(host, name) && host[name] !== undefined,
  );
}

/** The allowlist minus the host, taken as the complement so each name is counted once. */
function absentNames(host: HostEnvironment): readonly string[] {
  const held = new Set(heldNames(host));
  return WORKER_ENVIRONMENT_ALLOWLIST.filter((name) => !held.has(name));
}

// -- Non-vacuity: the shapes a loose projection would leak through ------------

const SHAPES = [
  'allowlisted-name-held',
  'allowlisted-name-absent',
  'foreign-name',
  'case-variant-while-absent',
  'superstring-name',
  'prototype-shaped-name',
  'empty-value',
  'key-without-value',
] as const;

type Shape = (typeof SHAPES)[number];

function isForeign(name: string): boolean {
  return !WORKER_ENVIRONMENT_ALLOWLIST.includes(name);
}

const EXHIBITS: Record<Shape, (host: HostEnvironment) => boolean> = {
  'allowlisted-name-held': (host) => heldNames(host).length > 0,
  'allowlisted-name-absent': (host) => absentNames(host).length > 0,
  'foreign-name': (host) => Object.keys(host).some(isForeign),
  'case-variant-while-absent': (host) =>
    absentNames(host).some((missing) =>
      Object.keys(host).some(
        (name) => name !== missing && name.toLowerCase() === missing.toLowerCase(),
      ),
    ),
  'superstring-name': (host) =>
    Object.keys(host).some(
      (name) =>
        isForeign(name) && WORKER_ENVIRONMENT_ALLOWLIST.some((allowed) => name.includes(allowed)),
    ),
  'prototype-shaped-name': (host) => Object.keys(host).some((name) => name in Object.prototype),
  'empty-value': (host) => heldNames(host).some((name) => host[name] === ''),
  'key-without-value': (host) => absentNames(host).some((name) => Object.hasOwn(host, name)),
};

function zeroedShapeCounts(): Record<Shape, number> {
  return {
    'allowlisted-name-held': 0,
    'allowlisted-name-absent': 0,
    'foreign-name': 0,
    'case-variant-while-absent': 0,
    'superstring-name': 0,
    'prototype-shaped-name': 0,
    'empty-value': 0,
    'key-without-value': 0,
  };
}

// -- Property 1 ---------------------------------------------------------------

describe(PROPERTY, () => {
  it('projects exactly the allowlisted names the host held, and names the rest absent', () => {
    const seen = zeroedShapeCounts();

    fc.assert(
      fc.property(hostEntriesArbitrary, (entries) => {
        const host = materialize(entries);
        for (const shape of SHAPES) {
          if (EXHIBITS[shape](host)) {
            seen[shape] += 1;
          }
        }

        const projected = projectWorkerEnvironment(host);

        expect(Object.keys(projected.env).sort()).toEqual([...heldNames(host)].sort());
        expect([...projected.absent].sort()).toEqual([...absentNames(host)].sort());

        // Compared by name, so a failure here reports which variable changed and not what to.
        const altered = heldNames(host).filter((name) => projected.env[name] !== host[name]);
        expect(altered).toEqual([]);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const shape of SHAPES) {
      expect(seen[shape], `no draw exercised ${shape}`).toBeGreaterThan(0);
    }
  });
});
