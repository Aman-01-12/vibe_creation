// reference-model-rendered-stimulus, Property 8: The rendered budget is the minimum of the
// request and the width cap, and is recorded (task 5.2, C7).
//
// WHAT IS CLAIMED
//   For any requested step count and any Declared_Interface, the rendered loop bound equals the
//   recorded `ECE_SAMPLE_BUDGET`, equals the smaller of the request and the width-derived cap, and
//   is at least 1 (Req 3.3, 3.4). This is Property 8's own restatement; the test adds a second
//   half beyond design.md's sentence, since task 5.1 unified the budget specifically so the
//   renderer and the Reference_Model_Prompt never disagree about the figure the model is told
//   versus the figure that actually runs (Req 3.5) - so this file also asserts the prompt's own
//   "Sample_Budget:" line (task 2.4) states the SAME number the harness renders, for the same
//   interface.
//
// THE ORACLE IS THE SHARED SIZING FUNCTION ITSELF, NOT A RE-DERIVATION
//   `sizedSampleBudget` is the one function both `renderConsensusHarness` and
//   `buildReferenceModelInput`'s `sampleBudgetFor` already call. Re-deriving its width-cap
//   arithmetic a second time here would duplicate logic the design deliberately shares (the same
//   reasoning `rendered-stimulus-layout.property.test.ts` already applied to `packedPortSlices`),
//   so this file imports and calls the real `sizedSampleBudget` as its own independent check.
//
//   The renderer's call and the prompt's call size against DIFFERENT inputs by design, and this
//   file keeps both differences explicit rather than assuming they coincide. The renderer sizes
//   against the REAL per-run nonce's length and the caller's own `requestedSampleBudget`. The
//   prompt (built before any nonce or per-run request exists, and carrying no request parameter
//   of its own - `sampleBudgetFor` always sizes against the global `SAMPLE_BUDGET` constant) uses
//   `REPRESENTATIVE_NONCE_LENGTH` (13) as its nonce stand-in and `SAMPLE_BUDGET` (2048) as its
//   request stand-in. So the two expected figures are computed independently with their own
//   inputs, and this file does not assert they are equal to each other.
//
// NON-VACUITY: AN INTERFACE WIDE ENOUGH THAT THE CAP ACTUALLY BINDS
//   A narrow interface's width cap is always far above any reasonable requested budget, so every
//   draw would trivially satisfy "rendered equals request" without ever exercising "rendered
//   equals the width-derived cap". A wide-output fixture (4096 output bits, mirroring the one
//   already proven to trigger the cap in `consensus-harness.test.ts`'s own
//   `sizedSampleBudget (C6, C8)` describe block) is added as its own constructed, exhausted case
//   so the cap-binding half of Property 8 is actually reached, not merely declared possible.
//
// **Validates: Requirements 3.3, 3.4**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildReferenceModelInput } from '@app/agent';
import {
  makeTimingContract,
  type ModuleInterface,
  type Spec,
  type TimingContract,
} from '@app/core';
import {
  renderConsensusHarness,
  SAMPLE_BUDGET,
  sizedSampleBudget,
  type ConsensusHarnessRequest,
  type RoleDeclaration,
} from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-rendered-stimulus, Property 8: The rendered budget is the minimum of the ' +
  'request and the width cap, and is recorded';

/** The prompt's own placeholder nonce length, read from `prompt.ts`'s `REPRESENTATIVE_NONCE_LENGTH`
 * - not re-exported, so mirrored here as the one number that constant is pinned to. */
const REPRESENTATIVE_NONCE_LENGTH = 13;

/** No SystemVerilog-2017 keyword begins with this, so a drawn nonce never needs a retry. */
const NONCE_PREFIX = 'zzid';

function nonceArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 0, 6).map((suffix) => `${NONCE_PREFIX}${suffix}`);
}

/** One `registered` entry per output port of `moduleInterface`, built directly from its own ports. */
function allRegisteredTiming(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(
      `arbModuleInterface produced an interface allRegisteredTiming could not cover: ${built.error.code}`,
    );
  }
  return built.value;
}

/** A total Role_Declaration naming every input port of `moduleInterface` as `data`. */
function allDataRoles(moduleInterface: ModuleInterface): RoleDeclaration {
  return moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => ({ portName: port.name, role: 'data' as const }));
}

/** The width-reduced budget the renderer's own `ECE_SAMPLE_BUDGET` literal records. */
function readRenderedBudget(contents: string): number {
  const match = /localparam integer ECE_SAMPLE_BUDGET = (\d+);/u.exec(contents);
  if (match === null) {
    throw new Error('rendered text carries no ECE_SAMPLE_BUDGET localparam');
  }
  return Number(match[1]);
}

/**
 * The width-reduced figure the Reference_Model_Prompt's own "Sample_Budget:" line states FOR THE
 * SPEC'S OWN INTERFACE, not for the worked example's. `describeExample()` renders a second,
 * earlier "Sample_Budget:" line of its own (for `EXAMPLE_INTERFACE`, always small enough that the
 * width cap never binds, so it always reads 2048) ahead of the one that matters here - taking the
 * LAST match is what distinguishes the two.
 */
function readPromptBudget(spec: Spec): number {
  const prompt = buildReferenceModelInput(spec).prompt;
  const matches = [
    ...prompt.matchAll(
      /Sample_Budget: ece_next_state and ece_expect are authored against (\d+) steps/gu,
    ),
  ];
  const last = matches[matches.length - 1];
  if (last === undefined) {
    throw new Error('rendered prompt carries no Sample_Budget line');
  }
  return Number(last[1]);
}

function outputBundleWidthOf(moduleInterface: ModuleInterface): number {
  return Math.max(
    1,
    moduleInterface.ports
      .filter((port) => port.direction === 'output')
      .reduce((sum, port) => sum + port.width, 0),
  );
}

function specFor(moduleInterface: ModuleInterface, timingContract: TimingContract): Spec {
  return {
    id: 'budget-property-fixture',
    projectId: 'budget-property-fixture',
    goal: 'fixture',
    constraints: [],
    architecture: '',
    moduleInterface,
    timingContract,
    acceptanceCriteria: [],
    approved: true,
    version: 1,
  };
}

function requestFor(
  moduleInterface: ModuleInterface,
  timingContract: TimingContract,
  nonce: string,
  requestedSampleBudget: number,
): ConsensusHarnessRequest {
  return {
    moduleInterface,
    timingContract,
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget: requestedSampleBudget,
    roles: allDataRoles(moduleInterface),
  };
}

/** Assert Property 8 over one (interface, nonce, requested-budget) draw. */
function assertBudgetFaithful(
  moduleInterface: ModuleInterface,
  timingContract: TimingContract,
  nonce: string,
  requestedSampleBudget: number,
): void {
  const rendered = renderConsensusHarness(
    requestFor(moduleInterface, timingContract, nonce, requestedSampleBudget),
  );
  if (!rendered.ok) {
    // A reserved-keyword collision is a legitimate refusal, not the claim under test (the same
    // reasoning rendered-stimulus-determinism.property.test.ts and rendered-stimulus-layout.
    // property.test.ts already apply to arbModuleInterface()'s narrower identifier generator).
    return;
  }
  const outputBundleWidth = outputBundleWidthOf(moduleInterface);

  // The renderer's own half: sized against the REAL nonce this render used.
  const expectedRendered = sizedSampleBudget(
    nonce.length,
    outputBundleWidth,
    requestedSampleBudget,
  );
  const actualRendered = readRenderedBudget(rendered.value.contents);
  expect(actualRendered).toBe(expectedRendered);
  // Property 8's own second clause: equals the SMALLER of the request and the width cap.
  expect(actualRendered).toBeLessThanOrEqual(requestedSampleBudget);
  expect(actualRendered).toBeGreaterThanOrEqual(1);

  // The prompt's own half: sized against the PLACEHOLDER nonce length AND the global
  // SAMPLE_BUDGET constant, independent of this draw's real nonce and requested budget -
  // `sampleBudgetFor` carries no request parameter of its own, so `requestedSampleBudget` is
  // deliberately NOT an input to this expectation.
  const expectedPrompt = sizedSampleBudget(
    REPRESENTATIVE_NONCE_LENGTH,
    outputBundleWidth,
    SAMPLE_BUDGET,
  );
  const actualPrompt = readPromptBudget(specFor(moduleInterface, timingContract));
  expect(actualPrompt).toBe(expectedPrompt);
}

describe(PROPERTY, () => {
  it(
    'renders ECE_SAMPLE_BUDGET as the minimum of the request and the width cap, at least 1, and ' +
      'states the same width-reduced figure in the Reference_Model_Prompt',
    () => {
      let acceptedAtLeastOnce = false;

      fc.assert(
        fc.property(
          arbModuleInterface(),
          nonceArbitrary(),
          fc.integer({ min: 1, max: 4096 }),
          (moduleInterface, nonce, requestedSampleBudget) => {
            const timingContract = allRegisteredTiming(moduleInterface);
            const rendered = renderConsensusHarness(
              requestFor(moduleInterface, timingContract, nonce, requestedSampleBudget),
            );
            if (!rendered.ok) {
              return;
            }
            acceptedAtLeastOnce = true;
            assertBudgetFaithful(moduleInterface, timingContract, nonce, requestedSampleBudget);
          },
        ),
        propertyParameters(),
      );

      expect(acceptedAtLeastOnce, 'no draw was accepted by the renderer').toBe(true);
    },
  );

  // NON-VACUITY: an interface wide enough that the width-derived cap actually binds below the
  // requested budget, so "rendered equals the width cap" is reached and not merely declared
  // possible - mirrors the fixture consensus-harness.test.ts's own
  // "sizedSampleBudget (C6, C8)" describe block already proved triggers the cap.
  it('renders the width-derived cap, strictly below the raw request, for a wide-output interface', () => {
    const moduleInterface: ModuleInterface = {
      moduleName: 'wide_dut',
      ports: [
        { name: 'a', direction: 'input', width: 1 },
        { name: 'y', direction: 'output', width: 4096 },
      ],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
      validityOutputName: null,
    };
    const timingContract = allRegisteredTiming(moduleInterface);
    const requestedSampleBudget = 2048;
    const nonce = `${NONCE_PREFIX}wide`;

    const rendered = renderConsensusHarness(
      requestFor(moduleInterface, timingContract, nonce, requestedSampleBudget),
    );
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    const actualRendered = readRenderedBudget(rendered.value.contents);
    // The trap this fixture exists to catch: a renderer that always echoes the raw request would
    // pass every narrow draw above while failing only here.
    expect(actualRendered).toBeLessThan(requestedSampleBudget);
    assertBudgetFaithful(moduleInterface, timingContract, nonce, requestedSampleBudget);
  });
});
