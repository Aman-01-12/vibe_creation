// Feature: stimulus-transaction-structure, Property 18: The Reference_Model_Prompt carries no
// Candidate_Design (task 10.2, C10).
//
// WHY THIS IS STRUCTURAL, NOT A FILTER
//   Criterion 8.5 is the same "no channel, not a scrubbed one" guarantee the Testbench_Agent and
//   the Property_Author already carry (`testbench-rtl-isolation.property.test.ts`, Properties 4
//   and 30): `buildReferenceModelInput` takes exactly `(spec: Spec)` and has no second parameter
//   a Candidate_Design, its source text, or its identifier could occupy. A generated candidate
//   design is built below and kept in scope purely to demonstrate that referencing it is inert -
//   there is no call shape that would pass it to the function under test.
//
// WHAT EACH CLAUSE CHECKS
//   1. Unrepresentability (compile time): `buildReferenceModelInput`'s parameter list is
//      exactly `[Spec]`, pinned with `expectTypeOf`, which `tsc -b` evaluates and vitest does
//      not, plus the runtime arity it actually declares.
//   2. Purity: the built `ModelRequest` is identical across repeated builds of the same Spec,
//      independent of the candidate design string sitting in the surrounding scope.
//   3. Non-leak: the assembled prompt contains neither the candidate design's source-text
//      sentinel nor its identifier sentinel, across many generated Specs and candidate designs.
//   4. Non-vacuity: the prompt DOES contain the Spec fields it is specified to carry (goal,
//      every constraint, every acceptance criterion's text, every input/output port name, and
//      the architecture notes when stated), so clause 3 is not merely an artifact of an empty
//      prompt.
//
// Validates: Requirements 8.5

import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { buildReferenceModelInput } from '@app/agent';
import { newUlid, type AcceptanceCriterion, type AcceptanceMethod, type Spec } from '@app/core';

import { timingContractFor } from './generators/timing-contract.js';
import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 18: The Reference_Model_Prompt carries no ' +
  'Candidate_Design';

/**
 * A safe free-text word pool for Spec fields: no underscores, no digits, and lowercase only,
 * so no generated phrase can coincidentally equal either sentinel below.
 */
const WORDS = [
  'reset',
  'enable',
  'value',
  'signal',
  'clock',
  'output',
  'input',
  'width',
  'strobe',
  'ready',
  'valid',
  'state',
  'count',
  'edge',
  'level',
  'data',
  'load',
  'clear',
  'hold',
  'shift',
  'toggle',
  'sample',
  'when',
  'then',
  'each',
];

/** A short phrase drawn from the safe word pool (never contains either sentinel below). */
function phraseArbitrary(maxWords = 6): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: maxWords })
    .map((words) => words.join(' '));
}

/** One acceptance criterion, its id freshly drawn per sample rather than memoized. */
function criterionArbitrary(): fc.Arbitrary<AcceptanceCriterion> {
  return fc
    .record({
      text: phraseArbitrary(),
      measurable: fc.boolean(),
      method: fc.constantFrom<AcceptanceMethod>('simulation', 'formal', 'manual-inspection'),
    })
    .map((fields) => ({ ...fields, id: newUlid() }));
}

/** An approved Spec exercising every field `buildReferenceModelInput` reads from it. */
function specArbitrary(): fc.Arbitrary<Spec> {
  return fc
    .record({
      goal: phraseArbitrary(),
      constraints: fc.array(phraseArbitrary(4), { maxLength: 3 }),
      moduleInterface: arbModuleInterface(),
      acceptanceCriteria: fc.array(criterionArbitrary(), { minLength: 1, maxLength: 3 }),
      architecture: fc.oneof(fc.constant(''), phraseArbitrary(10)),
      version: fc.integer({ min: 1, max: 12 }),
    })
    .map((fields) => ({
      ...fields,
      id: newUlid(),
      projectId: newUlid(),
      approved: true as const,
      timingContract: timingContractFor(fields.moduleInterface),
    }));
}

/** A distinctive marker embedded in every generated candidate design's source text. */
const CANDIDATE_SOURCE_SENTINEL = '__CANDIDATE_DESIGN_SOURCE_DO_NOT_LEAK_9B4E1F2C__';
/** A distinctive marker embedded in every generated candidate design's identifier. */
const CANDIDATE_IDENTIFIER_SENTINEL = '__CANDIDATE_DESIGN_ID_DO_NOT_LEAK_2D77AAE1__';

/** A Candidate_Design: Verilog-shaped source text plus an identifier, both carrying a sentinel. */
interface CandidateDesign {
  readonly sourceText: string;
  readonly identifier: string;
}

/**
 * A distinctive Candidate_Design the test keeps in scope but structurally cannot pass to
 * `buildReferenceModelInput` - there is no parameter to pass it through.
 */
function candidateDesignArbitrary(): fc.Arbitrary<CandidateDesign> {
  return fc.array(fc.constantFrom(...WORDS), { maxLength: 6 }).map((words) => ({
    sourceText:
      `module dut(input clk, output reg [3:0] q); // ${CANDIDATE_SOURCE_SENTINEL}\n` +
      `  always @(posedge clk) q <= q + 1; // ${words.join(' ')}\n` +
      `endmodule // ${CANDIDATE_SOURCE_SENTINEL}`,
    identifier: `${CANDIDATE_IDENTIFIER_SENTINEL}-${words.join('-')}`,
  }));
}

describe(PROPERTY, () => {
  it('builds the prompt from the Spec alone; a Candidate_Design has no channel into it', () => {
    // (1) Unrepresentability, compile-time half: `tsc -b` evaluates this, vitest does not.
    expectTypeOf(buildReferenceModelInput).parameters.toEqualTypeOf<[Spec]>();
    // Runtime half: the one parameter the function actually declares.
    expect(buildReferenceModelInput).toHaveLength(1);

    fc.assert(
      fc.property(specArbitrary(), candidateDesignArbitrary(), (spec, candidateDesign) => {
        // The candidate design exists in this scope, yet there is no typed channel to pass
        // it through - referencing it here proves it is inert rather than merely absent.
        expect(candidateDesign.sourceText).toContain(CANDIDATE_SOURCE_SENTINEL);
        expect(candidateDesign.identifier).toContain(CANDIDATE_IDENTIFIER_SENTINEL);

        // (2) Purity: a pure function of the Spec alone, independent of the candidate design
        // string sitting in the surrounding scope.
        const builtOnce = buildReferenceModelInput(spec);
        const builtAgain = buildReferenceModelInput(spec);
        expect(builtAgain).toEqual(builtOnce);

        // (3) Non-leak: neither the candidate design's source-text sentinel nor its identifier
        // sentinel appears anywhere in the assembled prompt.
        expect(builtOnce.prompt).not.toContain(CANDIDATE_SOURCE_SENTINEL);
        expect(builtOnce.prompt).not.toContain(CANDIDATE_IDENTIFIER_SENTINEL);
        expect(builtOnce.prompt).not.toContain(candidateDesign.identifier);

        // (4) Non-vacuity: the Spec fields the prompt IS specified to carry really do appear,
        // so clause 3's absence is not simply an artifact of an empty prompt.
        expect(builtOnce.prompt).toContain(spec.goal);
        for (const constraint of spec.constraints) {
          expect(builtOnce.prompt).toContain(constraint);
        }
        for (const criterion of spec.acceptanceCriteria) {
          expect(builtOnce.prompt).toContain(criterion.text);
        }
        // Port names (not the module name - the prompt's own Scope rule keeps a port's name
        // tied to its `in`/result bit position and never states the module name at all).
        for (const port of spec.moduleInterface.ports) {
          if (port.direction === 'input' || port.direction === 'output') {
            expect(builtOnce.prompt).toContain(port.name);
          }
        }
        if (spec.architecture.trim().length > 0) {
          expect(builtOnce.prompt).toContain(spec.architecture);
        }
      }),
      propertyParameters(),
    );
  });
});
