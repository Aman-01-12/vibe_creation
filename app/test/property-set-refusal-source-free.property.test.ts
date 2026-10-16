// Feature: formal-gate-first-light, Property 18: A refusal carries identities and no design
// source.
//
// WHAT IS CLAIMED, OVER WHAT
//   Over every calibrated mutant population - including one whose mutant identities are FULL
//   mutants carrying their own RTL - no payload `admitPropertySet` returns holds Verilog source
//   text. The claim is checked on the SERIALIZED admission, because a type pin cannot see what
//   rides on an object: `readonly survivors: readonly MutantIdentity[]` states what a reader may
//   rely on, not what the objects hold.
//
// WHY THE POPULATION MUST CARRY FULL MUTANTS, AND WHY A TYPE PIN IS NOT ENOUGH
//   `Mutant extends MutantIdentity`, so a `PropertySetGate` that sets `identity` straight from
//   `generateMutants` TYPE-CHECKS while handing the whole mutated reference RTL to the admission
//   gate. That was measured once against the built module: the refusal came back with
//   `"rtl":"module counter_12(...)"` on its survivors, and `survivors[0]` was the object passed in
//   (`chipAgent/_inbox/gotcha-a-refusal-passes-survivor-identities-through-by-reference-so-a-full-mutant-puts-its-rtl-on-the-refusal.md`).
//   `identityOf` is the projection that closes the runtime half, and `admitPropertySet` applies it
//   as the backstop no gate implementation can skip - which is exactly what Component 10 relies on
//   when it says criterion 6.8 is satisfied upstream. So a population that only ever held bare
//   identities would leave this property passing over inputs that cannot produce the defect.
//
// THE GENERATED FORM OF AN EXAMPLE THAT ALREADY EXISTS
//   `app/eval/property-set-gate-rtllm.test.ts` makes the same claim about the production adapter
//   on two hand-built mutants. This file makes it over populations: every mix of golden and formal
//   calibration, every population size including zero, and an identity that is a full mutant or a
//   bare projection drawn per member. The two together cover the one adapter and the rule it
//   cannot weaken.
//
// NON-VACUITY IS A POSITIVE CONTROL, NOT A COUNTER
//   Each run that names a full mutant among its survivors also rebuilds the refusal the way the
//   gate returned it BEFORE the projection landed - production's own answer with each survivor
//   re-attached by reference - and asserts the source-free clauses REJECT it. So the property
//   fails if the projection is removed, demonstrated on every such run rather than argued. The
//   control is built from the admission's own survivor list, so this file re-states none of the
//   gate rule and cannot agree with itself about which mutants survive.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 6.8**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  admitPropertySet,
  type CalibratedFormalMutant,
  type Mutant,
  type MutantIdentity,
  type PropertySetAdmission,
} from '@app/eval';

import { arbCalibratedMutantPopulation } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 18: A refusal carries identities and no design source';

/** Well above the mandated 100: the row that matters is a refusal that names a full mutant. */
const NUM_RUNS = 300;

/** The three fields a survivor may carry, which is `MutantIdentity` and nothing else (Req 6.8). */
const IDENTITY_KEYS: readonly string[] = Object.freeze(['mutantId', 'operator', 'site']);

/**
 * Verilog tokens no refusal may carry, each present in the generated mutant RTL below.
 *
 * Tokens rather than the whole string, because a refusal that leaked one line of the design is
 * as wrong as one that leaked all of it. None of them can arise from an identity: a `mutantId` is
 * `<operator>@<line>:<column>`, every operator id is upper-case and names an operator rather than
 * a keyword, and the site excerpts are short operator and literal texts.
 */
const VERILOG_TOKENS: readonly string[] = Object.freeze(['module', 'endmodule', 'posedge']);

/**
 * The mutated reference one mutant carries, shaped like the source the gate really submits.
 *
 * It holds all three tokens above and the mutant's own site, so a leak is attributable to the
 * mutant that leaked it. Never compiled: this is the payload the refusal must not carry, not a
 * design under test.
 */
function mutatedRtlFor(identity: MutantIdentity): string {
  return [
    `module counter_${identity.site.line.toString()} (input clk, input rst_n, output reg [7:0] q);`,
    `  // ${identity.mutantId}: ${identity.site.before} -> ${identity.site.after}`,
    "  always @(posedge clk or negedge rst_n) q <= rst_n ? q + 8'd1 : 8'd0;",
    'endmodule',
    '',
  ].join('\n');
}

/**
 * The identity a careless gate hands in: the FULL mutant, RTL included.
 *
 * Typed `Mutant` and assigned into a `MutantIdentity` field, which is the whole point - this
 * compiles, and only a runtime projection keeps the `rtl` off the refusal.
 */
function fullMutantOf(identity: MutantIdentity): Mutant {
  return { ...identity, rtl: mutatedRtlFor(identity) };
}

/** One calibrated mutant whose identity is the full mutant rather than a projection of it. */
function carryingSource(mutant: CalibratedFormalMutant): CalibratedFormalMutant {
  return { ...mutant, identity: fullMutantOf(mutant.identity) };
}

/** Whether this record's identity is a full mutant, so its RTL was available to leak. */
function identityCarriesSource(mutant: CalibratedFormalMutant): boolean {
  return 'rtl' in mutant.identity;
}

/** How much likelier a member carries its RTL than not: the dangerous row is the common one. */
const CARRIES_SOURCE_WEIGHT = 3;

/** Whether each member of a population of this size hands in a full mutant. */
function arbCarriesSourceFlags(size: number): fc.Arbitrary<readonly boolean[]> {
  return fc.array(
    fc.oneof(
      { weight: CARRIES_SOURCE_WEIGHT, arbitrary: fc.constant(true) },
      { weight: 1, arbitrary: fc.constant(false) },
    ),
    { minLength: size, maxLength: size },
  );
}

/**
 * A calibrated population in which SOME identities are full mutants and some are projections.
 *
 * Built by upgrading `arbCalibratedMutantPopulation()` rather than by a second generator, so the
 * calibration vocabularies, the independent golden verdict, and the unique-id rule keep their one
 * owner; this file adds only the field a type cannot stop.
 */
function arbPopulationWithFullMutants(): fc.Arbitrary<readonly CalibratedFormalMutant[]> {
  return arbCalibratedMutantPopulation().chain((population) =>
    arbCarriesSourceFlags(population.length).map((flags) =>
      population.map((mutant, index) => (flags[index] === true ? carryingSource(mutant) : mutant)),
    ),
  );
}

/**
 * The refusal the gate returned BEFORE `identityOf` landed: every survivor by reference.
 *
 * Rebuilt from the admission's OWN survivor list, by looking each named survivor back up in the
 * population it came from, so the control differs from production in exactly one way - the
 * projection - and restates no part of the gate rule. A non-refusal is returned unchanged, which
 * is what the gate did with it too.
 */
function withSurvivorsByReference(
  admission: PropertySetAdmission,
  population: readonly CalibratedFormalMutant[],
): PropertySetAdmission {
  if (admission.kind !== 'refused') {
    return admission;
  }
  const identities = new Map(
    population.map((mutant) => [mutant.identity.mutantId, mutant.identity]),
  );
  return {
    kind: 'refused',
    survivors: admission.survivors.map((survivor) => identities.get(survivor.mutantId) ?? survivor),
  };
}

/**
 * The property's own clauses: no Verilog anywhere in the payload, and every survivor rebuilt.
 *
 * Total over the three-member union, so `admitted` and `no-gate-set` are graded too - "no refusal
 * payload contains Verilog source text" is a claim about everything this gate can return.
 */
function assertSourceFree(admission: PropertySetAdmission): void {
  const serialized = JSON.stringify(admission);
  for (const token of VERILOG_TOKENS) {
    expect(serialized, `a gate payload carries no Verilog: ${token}`).not.toContain(token);
  }
  if (admission.kind !== 'refused') {
    return;
  }
  for (const survivor of admission.survivors) {
    expect(Object.keys(survivor).sort(), 'a survivor carries identity fields alone').toEqual([
      ...IDENTITY_KEYS,
    ]);
  }
}

/** Every survivor names the mutant the population named, so projecting dropped no evidence. */
function assertSurvivorsStillAttributable(
  admission: PropertySetAdmission,
  population: readonly CalibratedFormalMutant[],
): void {
  if (admission.kind !== 'refused') {
    return;
  }
  for (const survivor of admission.survivors) {
    const source = population.find((mutant) => mutant.identity.mutantId === survivor.mutantId);
    expect(source, 'a refusal names a mutant from its own population').toBeDefined();
    expect(survivor.operator).toBe(source?.identity.operator);
    expect(survivor.site).toEqual(source?.identity.site);
    // Rebuilt, not passed through: the one call that keeps a promise the type cannot.
    expect(survivor).not.toBe(source?.identity);
  }
}

/** What the run drew, so no clause above passed by never meeting the case it is about. */
interface DrawnShapes {
  runs: number;
  refusalsNamingAFullMutant: number;
  refusalsNamingNoFullMutant: number;
  populationsHoldingSource: number;
  controlsRejected: number;
}

function noShapesDrawn(): DrawnShapes {
  return {
    runs: 0,
    refusalsNamingAFullMutant: 0,
    refusalsNamingNoFullMutant: 0,
    populationsHoldingSource: 0,
    controlsRejected: 0,
  };
}

/** Whether this refusal names at least one mutant that handed in its own RTL. */
function namesAFullMutant(
  admission: PropertySetAdmission,
  population: readonly CalibratedFormalMutant[],
): boolean {
  if (admission.kind !== 'refused') {
    return false;
  }
  const carrying = new Set(
    population.filter(identityCarriesSource).map((mutant) => mutant.identity.mutantId),
  );
  return admission.survivors.some((survivor) => carrying.has(survivor.mutantId));
}

describe(PROPERTY, () => {
  it('keeps every Verilog token off the payload, even when the identities handed in are full mutants', () => {
    const drawn = noShapesDrawn();

    fc.assert(
      fc.property(arbPopulationWithFullMutants(), (population) => {
        drawn.runs += 1;
        drawn.populationsHoldingSource += population.some(identityCarriesSource) ? 1 : 0;

        const admission = admitPropertySet(population);

        assertSourceFree(admission);
        assertSurvivorsStillAttributable(admission, population);

        if (!namesAFullMutant(admission, population)) {
          drawn.refusalsNamingNoFullMutant += admission.kind === 'refused' ? 1 : 0;
          return;
        }
        drawn.refusalsNamingAFullMutant += 1;

        // THE POSITIVE CONTROL. The RTL was there to leak: the input population serializes with
        // the tokens on it, so the clause above is reading an absence the projection created.
        expect(JSON.stringify(population)).toContain('endmodule');
        // And the clause DISCRIMINATES: the same refusal with its survivors re-attached by
        // reference - the shape `.map((mutant) => mutant.identity)` returned - is rejected.
        expect(() => {
          assertSourceFree(withSurvivorsByReference(admission, population));
        }, 'the source-free clause must reject an unprojected refusal').toThrow();
        drawn.controlsRejected += 1;
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    expect(drawn.runs).toBe(NUM_RUNS);
    // The dangerous row - a refusal whose survivors handed in their own RTL - is where the
    // projection is load-bearing, so it is required to be common rather than merely reached.
    expect(drawn.refusalsNamingAFullMutant).toBeGreaterThan(NUM_RUNS / 10);
    // Every one of those runs also showed the clause rejecting the unprojected refusal.
    expect(drawn.controlsRejected).toBe(drawn.refusalsNamingAFullMutant);
    // And the harmless rows were drawn too: a refusal naming only projected identities, and
    // populations carrying source whatever the gate then decided.
    expect(drawn.refusalsNamingNoFullMutant).toBeGreaterThan(0);
    expect(drawn.populationsHoldingSource).toBeGreaterThan(0);
  });
});
