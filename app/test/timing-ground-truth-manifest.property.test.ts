// **Feature: timing-contract-inference, Property 18: The Ground_Truth manifest is total and reviewable**
// (task 1.2).
//
// THE ORACLE
//   The manifest is the only thing the Timing_Cross_Check reads its expected values from, so a
//   port whose Ground_Truth is implied by ABSENCE is a silent hole in the check: the derivation
//   could be wrong about that port and nothing would say so. This file asserts the manifest is
//   total over the Derivation_Population, reviewable on every entry, and that its lookup resolves
//   a design/port pair exactly when that pair was recorded - never by prototype inheritance.
//
// WHY THE GENERATED PART IS THE LOOKUP KEYS
//   Re-reading the frozen array and comparing it against itself proves nothing about membership.
//   What can go wrong is the LOOKUP: `timingGroundTruthIndex` is a `Map` precisely because an
//   object index would answer `__proto__`, `constructor`, and `toString` as recorded members when
//   none was ever written. So the keys are generated - recorded pairs, crossed pairs that pair a
//   real design with another design's port, prototype-chain names, and free strings - and every
//   answer is checked against a linear scan of the entry array, an oracle that shares no code
//   with the `Map` under test.
//
// WHAT THIS CANNOT SEE
//   "One entry per DECLARED output port" has a second half that needs the elaborated design:
//   whether the manifest names a port the design does not declare, and whether a declared port is
//   missing. Neither is knowable without the toolchain, and the Timing_Cross_Check's real run
//   asserts both in both directions. Totality here is the part that holds without a checkout: the
//   manifest's design count equals the Derivation_Population's, every design it names is inside
//   that population, and no design is named twice for the same port. A design name that is not in
//   the upstream checkout at all would still pass here and fail there.
//
// Validates: Requirements 6.2, 6.12

import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isPortTiming } from '@app/core';

import {
  TIMING_GROUND_TRUTH,
  timingGroundTruthDesigns,
  timingGroundTruthIndex,
  timingGroundTruthKey,
  type TimingGroundTruthEntry,
} from '../eval/corpus/timing-ground-truth.js';
import {
  DERIVATION_POPULATION_SIZE,
  YOSYS_FRONTEND_REJECTED_PROBLEM_IDS,
  inDerivationPopulation,
} from '../eval/corpus/timing-populations.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'Feature: timing-contract-inference, Property 18: The Ground_Truth manifest is total and reviewable';

/** The two values `expected` may take; anything else is an unreviewed expectation. */
const EXPECTATIONS: ReadonlySet<string> = new Set(['agrees', 'refused']);

/**
 * The RTLLM category directory names a `rtllm/<category>/<design>` id can carry.
 *
 * Generated rather than fixed to one value because the manifest records the `<design>` segment
 * alone: a design's population membership must not depend on which category it files under.
 */
const CATEGORIES = ['arithmetic', 'control', 'memory', 'miscellaneous'] as const;

/** The designs the manifest names, and the port names it uses, each in first-appearance order. */
const DESIGNS = timingGroundTruthDesigns();
const PORTS = [...new Set(TIMING_GROUND_TRUTH.map((entry) => entry.port))];

/** Names that read as members of a plain object without ever having been assigned to one. */
const PROTOTYPE_NAMES = [
  '__proto__',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'prototype',
] as const;

/**
 * The entry recorded for a design/port pair, found by scanning the entry array.
 *
 * The independent oracle for the index: it shares no code with `timingGroundTruthIndex`, so a
 * `Map` that answered a key it was never given - or lost one it was - disagrees with it.
 */
function recordedEntryFor(design: string, port: string): TimingGroundTruthEntry | undefined {
  return TIMING_GROUND_TRUTH.find((entry) => entry.design === design && entry.port === port);
}

/** How a generated lookup key was drawn, counted so each kind is known to have been exercised. */
type KeyKind = 'recorded' | 'crossed' | 'prototype' | 'free';

interface KeyCase {
  readonly design: string;
  readonly port: string;
  readonly kind: KeyKind;
}

/** A pair that IS recorded, so the index is tested for hits and not only for misses. */
function recordedPairArbitrary(): fc.Arbitrary<KeyCase> {
  return fc
    .constantFrom(...TIMING_GROUND_TRUTH)
    .map((entry) => ({ design: entry.design, port: entry.port, kind: 'recorded' as const }));
}

/**
 * A real design paired with a real port name drawn independently of it.
 *
 * The decisive near-miss: both halves exist in the manifest, so only the PAIR decides, and a
 * lookup that matched on either half alone would resolve an entry that was never recorded.
 */
function crossedPairArbitrary(): fc.Arbitrary<KeyCase> {
  return fc
    .tuple(fc.constantFrom(...DESIGNS), fc.constantFrom(...PORTS))
    .map(([design, port]) => ({ design, port, kind: 'crossed' as const }));
}

/** A prototype-chain name in either half of the key, which must resolve to nothing. */
function prototypePairArbitrary(): fc.Arbitrary<KeyCase> {
  return fc
    .tuple(
      fc.constantFrom(...DESIGNS, ...PROTOTYPE_NAMES),
      fc.constantFrom(...PROTOTYPE_NAMES, ...PORTS),
    )
    .map(([design, port]) => ({ design, port, kind: 'prototype' as const }));
}

/** Free strings, including the empty one and ones carrying the key separator. */
function freePairArbitrary(): fc.Arbitrary<KeyCase> {
  return fc
    .tuple(fc.string({ maxLength: 24 }), fc.string({ maxLength: 24 }))
    .map(([design, port]) => ({ design, port, kind: 'free' as const }));
}

function keyCaseArbitrary(): fc.Arbitrary<KeyCase> {
  return fc.oneof(
    recordedPairArbitrary(),
    crossedPairArbitrary(),
    prototypePairArbitrary(),
    freePairArbitrary(),
  );
}

describe(PROPERTY, () => {
  it('is total over the Derivation_Population and carries a reviewable entry for every port', () => {
    // Exhaustive rather than sampled: the manifest is a fixed list, so every entry is checked
    // once instead of 100 random ones being checked repeatedly.
    for (const entry of TIMING_GROUND_TRUTH) {
      expect(isPortTiming(entry.timing)).toBe(true);
      expect(EXPECTATIONS.has(entry.expected)).toBe(true);
      // Reviewable: a rationale is the entry's engineering reason, so whitespace is no entry.
      expect(entry.rationale.trim()).not.toBe('');
      // The key is `design/port` joined, so a slash in either half would make two distinct
      // entries share one key.
      expect(entry.design).not.toContain('/');
      expect(entry.port).not.toContain('/');
    }

    // No design/port pair recorded twice: a duplicate is two reviewed answers to one question,
    // and the index would silently keep the last.
    const keys = TIMING_GROUND_TRUTH.map((entry) => timingGroundTruthKey(entry.design, entry.port));
    expect(new Set(keys).size).toBe(keys.length);

    // Totality: one design per population member. With the designs distinct and every one of
    // them inside the population (asserted below), equal counts leave no member without an
    // entry. `DERIVATION_POPULATION_SIZE` is owned by `timing-populations.ts`, read here.
    expect(DESIGNS).toHaveLength(DERIVATION_POPULATION_SIZE);
    // Non-vacuous: the manifest carries more entries than designs, so ports are per-port and
    // not one-per-design.
    expect(TIMING_GROUND_TRUTH.length).toBeGreaterThan(DESIGNS.length);

    // The designs the Yosys frontend rejects are outside the population, so the manifest must
    // name neither - the complement of the clause above, and its non-vacuity control.
    const rejectedNames = YOSYS_FRONTEND_REJECTED_PROBLEM_IDS.map((problemId) =>
      problemId.slice(problemId.lastIndexOf('/') + 1),
    );
    expect(rejectedNames.length).toBeGreaterThan(0);
    for (const rejected of YOSYS_FRONTEND_REJECTED_PROBLEM_IDS) {
      expect(inDerivationPopulation(rejected)).toBe(false);
    }
    for (const name of rejectedNames) {
      expect(DESIGNS).not.toContain(name);
    }
  });

  it('places every design it names inside the Derivation_Population, under any category path', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DESIGNS),
        fc.constantFrom(...CATEGORIES),
        (design, category) => {
          expect(inDerivationPopulation(`rtllm/${category}/${design}`)).toBe(true);
        },
      ),
      propertyParameters(),
    );
  });

  it('resolves a design/port key exactly when the pair was recorded, prototype names included', () => {
    const index = timingGroundTruthIndex();
    const seen = new Set<KeyKind>();
    let hits = 0;
    let misses = 0;

    fc.assert(
      fc.property(keyCaseArbitrary(), ({ design, port, kind }) => {
        const key = timingGroundTruthKey(design, port);
        const expected = recordedEntryFor(design, port);

        // `toBe`, not `toEqual`: the index must hand back the very entry object the array holds,
        // which is the one answer a re-derived or inherited value cannot give.
        expect(index.get(key)).toBe(expected);
        expect(index.has(key)).toBe(expected !== undefined);

        seen.add(kind);
        if (expected === undefined) {
          misses += 1;
        } else {
          hits += 1;
        }
      }),
      propertyParameters(),
    );

    // NON-VACUITY: every kind of key was drawn, and the run saw both a hit and a miss, so the
    // assertions above are not all one trivial branch.
    expect([...seen].sort()).toEqual(['crossed', 'free', 'prototype', 'recorded']);
    expect(hits).toBeGreaterThan(0);
    expect(misses).toBeGreaterThan(0);

    // Every recorded entry is reachable, which `misses` alone would not show.
    for (const entry of TIMING_GROUND_TRUTH) {
      expect(index.get(timingGroundTruthKey(entry.design, entry.port))).toBe(entry);
    }
    expect(index.size).toBe(TIMING_GROUND_TRUTH.length);

    // Positive control for the prototype names: the hazard the `Map` exists to avoid is real. A
    // nested design-to-port object index over these same entries answers `toString` as a member
    // of a design that never recorded it, through `Object.prototype`.
    const design = DESIGNS[0] ?? '';
    const nested: Record<string, Record<string, TimingGroundTruthEntry>> = {};
    for (const entry of TIMING_GROUND_TRUTH) {
      (nested[entry.design] ??= {})[entry.port] = entry;
    }
    expect(nested[design]?.['toString']).toBeDefined();
    expect(recordedEntryFor(design, 'toString')).toBeUndefined();
    expect(index.has(timingGroundTruthKey(design, 'toString'))).toBe(false);
  });
});

// -- Provenance independence (Req 6.2) ---------------------------------------------------------

/**
 * The manifest's own source, read fresh rather than from `dist`.
 *
 * Protecting the cross-check's independence: a manifest that imported the derivation, or computed
 * its values at load, would be comparing the derivation against itself.
 */
const MANIFEST_SOURCE = readFileSync(
  new URL('../eval/corpus/timing-ground-truth.ts', import.meta.url),
  'utf8',
);

/**
 * Every module one source file imports, type-only imports included.
 *
 * Wider than the runtime-import scans elsewhere in this suite on purpose: an `import type` loads
 * no code, but a type taken FROM the derivation is still the derivation in the manifest's
 * provenance, which is what Requirement 6.2 forbids.
 */
function allImportsOf(source: string): readonly string[] {
  return [...source.matchAll(/^import\s[^;]*?['"]([^'"]+)['"]/gm)].map((match) => match[1] ?? '');
}

describe('the Ground_Truth manifest imports no derivation and computes nothing at load (Req 6.2)', () => {
  it('imports `@app/core` and nothing else, so no derivation module is in its provenance', () => {
    expect(allImportsOf(MANIFEST_SOURCE)).toEqual(['@app/core']);
  });

  it('reports a derivation import when one is present, so the allow-list above is a measurement', () => {
    // Positive control over the three shapes the derivation could enter by: the timing module, the
    // prepass, and the package barrel that re-exports both.
    for (const derivationModule of [
      '../../tools/formal/timing.js',
      '../../tools/formal/prepass.js',
      '@app/tools',
    ]) {
      expect(
        allImportsOf(
          `${MANIFEST_SOURCE}\nimport { derivePortTiming } from '${derivationModule}';\n`,
        ),
      ).toEqual(['@app/core', derivationModule]);
    }
  });

  it('exports the entries as a frozen literal array rather than the result of a call', () => {
    // The export is `Object.freeze([` with a literal opening immediately after: a computed
    // manifest would read `= someDerivation(...)` or `= [...].map(...)` instead.
    expect(MANIFEST_SOURCE).toMatch(
      /export const TIMING_GROUND_TRUTH:[^=]*=\s*Object\.freeze\(\[\s*\n/,
    );
    expect(Object.isFrozen(TIMING_GROUND_TRUTH)).toBe(true);
  });
});
