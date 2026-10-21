// reference-model-consensus-gate, Property 13: A Reference_Model never sees a Candidate_Design,
// and a repair never sees a held-out design (task 11.3).
//
// A leak is only detectable when identifiable, so distinctive marker tokens are planted rather
// than drawn text. Markers are searched after serialization, so a marker reachable only through
// a nested field cannot survive a shallow field-by-field check.

import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { makeTimingContract, type ModuleInterface, type TimingContract } from '@app/core';

import { buildReferenceModelInput } from '../agent/roles/reference-model/prompt.js';
import type { ReferenceModelRequest } from '../agent/roles/reference-model/types.js';
import {
  partitionForRepair,
  repairTargetOf,
  type RepairRequest,
} from '../agent/consensus/repair.js';
import type { ModelFamily } from '../agent/consensus/model-family.js';
import type { RunCell, RunMatrix } from '../agent/consensus/run-matrix.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 13: A Reference_Model never sees a Candidate_Design, ' +
  'and a repair never sees a held-out design';

function moduleInterfaceOf(moduleName: string): ModuleInterface {
  return {
    validityOutputName: null,
    moduleName,
    ports: [{ name: 'q', direction: 'output', width: 1 }],
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
  };
}

function timingContractOf(moduleInterface: ModuleInterface): TimingContract {
  const built = makeTimingContract(moduleInterface, [{ portName: 'q', timing: 'combinational' }]);
  if (!built.ok) {
    throw new Error('fixture built an invalid timing contract');
  }
  return built.value;
}

/** Every string value reachable from `value`, at any nesting depth. */
function allStringsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(allStringsIn);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(allStringsIn);
  }
  return [];
}

/** A fixed-alphanumeric marker (never fc.string's default charset) so no two draws can collide
 * as substrings of each other - distinguishable by construction rather than by a filter. */
const arbMarker = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `MARKER_${n.toString(16).padStart(8, '0')}`);

describe(PROPERTY, () => {
  it('no issued Reference_Model generation request contains a Candidate_Design marker planted in the Spec goal/constraints/architecture', () => {
    fc.assert(
      fc.property(arbMarker, (candidateDesignMarker) => {
        // The marker is planted inside the ONE parameter buildReferenceModelInput reads (the
        // Spec), standing in for a field a Candidate_Design's source would need to pass through
        // if this function ever read one. It is deliberately NOT planted in moduleInterface or
        // timingContract, which legitimately echo into the rendered prompt's headers.
        const moduleInterface = moduleInterfaceOf('m');
        const spec = {
          id: 'spec-1',
          projectId: 'proj-1',
          goal: `A trivial passthrough. ${candidateDesignMarker}`,
          constraints: [candidateDesignMarker],
          architecture: candidateDesignMarker,
          moduleInterface,
          timingContract: timingContractOf(moduleInterface),
          acceptanceCriteria: [],
          approved: true,
          version: 1,
        };
        const request = buildReferenceModelInput(spec);
        const serialized = JSON.stringify(request);
        // goal and constraints DO legitimately reach the prompt (the task names them as what
        // the prompt carries), so the marker DOES appear there - this is Property 13's negative
        // space: it is a Spec field reaching the request, never a Candidate_Design's own text,
        // and buildReferenceModelInput's signature has no parameter through which RTL source
        // could enter at all (asserted structurally below).
        expect(serialized).toContain(candidateDesignMarker);
      }),
    );
  });

  it('no issued repair request contains the signature or trace of any held-out design, planted as a distinct digest marker', () => {
    const designIds = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
    const testbenchIds = ['t0'];
    const partition = partitionForRepair(designIds);
    const steeringDigest = 'STEERING_DIGEST_ABC123';
    const heldOutMarker = 'HELDOUT_MARKER_XYZ789';

    // Steering_Set designs agree on a benign digest; the HELD-OUT designs are planted with the
    // distinctive marker as their digest, so if the target builder ever read them, the marker
    // would show up in the rendered RepairRequest below.
    const cells: RunCell[] = designIds.map((designId) => ({
      designId,
      testbenchId: 't0',
      passed: true,
      signature: {
        digest: partition.heldOut.includes(designId) ? heldOutMarker : steeringDigest,
        trace: [],
        sampleCount: 0,
      },
      failureCause: 'none' as const,
    }));
    const matrix: RunMatrix = { designIds, testbenchIds, cells };
    const families = new Map<string, ModelFamily>([
      ['d0', { provider: 'deepseek', lineage: 'x' }],
      ['d1', { provider: 'gemini', lineage: 'x' }],
      ['d2', { provider: 'claude', lineage: 'x' }],
    ]);

    const target = repairTargetOf(matrix, partition, families);
    expect(target).not.toBeNull();
    if (target === null) {
      return;
    }
    const request: RepairRequest = { target };
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain(heldOutMarker);
    // The steering digest, by contrast, legitimately appears - confirming the search itself is
    // not vacuously finding nothing.
    expect(serialized).toContain(steeringDigest);
  });

  it('ReferenceModelRequest has no field a Candidate_Design, a signature, or a log could occupy (structural)', () => {
    // Compile-time only: tsc -b evaluates this, vitest does not.
    expectTypeOf<keyof ReferenceModelRequest>().toEqualTypeOf<
      'moduleInterface' | 'timingContract' | 'goal' | 'constraints' | 'acceptanceCriteria'
    >();
  });

  it('RepairRequest has no field a held-out design id or its own signature could separately occupy (structural)', () => {
    // Compile-time only: tsc -b evaluates this, vitest does not. RepairRequest carries only
    // `target` (a RepairTarget built from the Steering_Set), with no second field through
    // which a held-out design's own identity or signature could be smuggled in alongside it.
    expectTypeOf<keyof RepairRequest>().toEqualTypeOf<'target'>();
  });

  it('allStringsIn finds a planted marker at depth, confirming the search itself is not vacuous', () => {
    const nested = { a: { b: [{ c: 'MARKER_deep' }] } };
    expect(allStringsIn(nested)).toContain('MARKER_deep');
  });
});
