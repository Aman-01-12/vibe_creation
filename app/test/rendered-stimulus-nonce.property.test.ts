// Feature: reference-model-rendered-stimulus, Property 6: One Role_Declaration renders one
// stimulus and one reset schedule (task 6.3, C5, C6).
//
// THE CLAIM IS NARROWER THAN PROPERTY 2 AND PROPERTY 7
//   Property 2 (task 2.7) already states that two calls with the SAME request render
//   byte-identical text. Property 7 (task 6.2) already states the reset schedule's own
//   correctness. Property 6 adds a third, narrower claim neither of those covers: across two
//   requests that differ ONLY in their nonce, the nonce is the ONLY thing that may vary. The
//   Stimulus_Function region and the reset region must be byte-IDENTICAL regardless of which
//   nonce was used, because neither is a function of the nonce at all - confirmed directly by
//   reading `consensus-harness.ts`: `renderStimulusMixer()` takes no arguments,
//   `renderStimulusFunction(inputPorts, inputBundleWidth, roles)` takes no nonce parameter, and
//   `renderHarnessResetTask(inputBundleWidth, resetActiveLow)` takes no nonce parameter either.
//   This is what makes a disagreement between two cells of the Run_Matrix localise to a Spec
//   reading rather than to a per-run stimulus difference (Req 2.10, 5.7).
//
// BOTH HALVES OF THE CLAIM ARE ASSERTED, PLUS THE NON-VACUITY HALF
//   Equality of the two regions alone would pass a renderer that ignored the nonce entirely, so
//   this file also asserts (c): the two FULL renders differ somewhere. The nonce reaches the
//   CHECK and ECE_SAMPLE/ECE_SAMPLE_END lines (`"${nonce}_${port.name}"` and
//   `` `${SAMPLE_LINE_PREFIX} ${nonce} ...` `` in `renderConsensusHarness`), so as soon as the two
//   drawn nonces differ as strings, the full text must differ there even on a zero-output-port
//   interface, which is why no output-port non-vacuity row is needed for part (c).
//
// WHY REGIONS ARE EXTRACTED BY THEIR RENDERED BOUNDARIES, NOT BY LINE OFFSETS OR SUBSTRING-SWAP
//   A later renderer edit that shifts the regions must fail this test loudly rather than compare
//   the wrong text, so both regions are located by their own literal markers
//   (`'function automatic [63:0] ece_mix'`, `'endfunction'`, `'task ece_harness_reset;'`,
//   `'endtask'`) and sliced directly - a simpler index-based approach than
//   `rendered-stimulus-layout.property.test.ts`'s regex parse, which is unneeded here since this
//   file only needs byte equality, not semantic parsing of the body. This also sidesteps the
//   cross-file-recorded gotcha about substring-substitution byte-identity checks colliding with
//   the renderer's own fixed prose
//   (`chipAgent/_inbox/gotcha-a-byte-identity-via-substring-substitution-property-must-guard-the-needle-against-the-renderers-own-fixed-text-too.md`):
//   there is no substitution here, only independent slicing of each render.
//
// WHY THE SAMPLED POPULATION NEEDS A CONSTRUCTED RESET-BEARING FIXTURE TOO
//   `arbModuleInterface()` (reused from `interface-header-arbitraries.ts`, per the task's own
//   instruction to reuse rather than rebuild) always draws `clocking: { clockName: null, ... }`,
//   so the sampled population's reset region is always the empty string and part (b) would be
//   proved only in its vacuous half. A locally-built reset-bearing interface (not appended to the
//   shared `CONSTRUCTED_DRAWS`, which belongs to a different spec's property) is exhausted
//   directly in its own `it()` block, the same non-vacuity convention
//   `rendered-stimulus-layout.property.test.ts` and `rendered-stimulus-reset.property.test.ts`
//   already use, so the non-empty branch of part (b) is actually exercised.
//
// Validates: Requirements 2.10, 5.7

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ClockingContract,
  type ModuleInterface,
  type TimingContract,
} from '@app/core';
import {
  renderConsensusHarness,
  type ConsensusHarnessRequest,
  type RoleDeclaration,
} from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-rendered-stimulus, Property 6: One Role_Declaration renders one stimulus ' +
  'and one reset schedule';

// ---------------------------------------------------------------------------
// Region extraction, by literal rendered markers
// ---------------------------------------------------------------------------

const MIXER_HEADER_MARKER = 'function automatic [63:0] ece_mix';
const RESET_TASK_MARKER = 'task ece_harness_reset;';

/**
 * Slice `contents` from `ece_mix`'s own header through `ece_stimulus`'s own `endfunction` - the
 * Stimulus_Function region plus the Stimulus_Mixer function rendered immediately above it, which
 * is exactly how the task names the region. Both functions are rendered by `renderStimulusMixer`
 * and `renderStimulusFunction`, neither of which takes a nonce.
 */
function extractStimulusRegion(contents: string): string {
  const mixerStart = contents.indexOf(MIXER_HEADER_MARKER);
  if (mixerStart === -1) {
    throw new Error('rendered text carries no ece_mix header');
  }
  const mixerEnd = contents.indexOf('endfunction', mixerStart);
  if (mixerEnd === -1) {
    throw new Error('ece_mix has no matching endfunction');
  }
  const stimulusEnd = contents.indexOf('endfunction', mixerEnd + 'endfunction'.length);
  if (stimulusEnd === -1) {
    throw new Error('ece_stimulus has no matching endfunction');
  }
  return contents.slice(mixerStart, stimulusEnd + 'endfunction'.length);
}

/**
 * Slice `contents`'s reset region: `task ece_harness_reset; ... endtask` when reset-bearing, or
 * the empty string when the harness renders no reset task at all (no declared reset, or no
 * declared clock) - asserting that absence directly rather than treating a missing marker as a
 * parse failure, since `renderHarnessResetTask` is only ever called conditionally.
 */
function extractResetRegion(contents: string): string {
  const taskStart = contents.indexOf(RESET_TASK_MARKER);
  if (taskStart === -1) {
    expect(contents).not.toContain('ece_harness_reset');
    return '';
  }
  const taskEnd = contents.indexOf('endtask', taskStart);
  if (taskEnd === -1) {
    throw new Error('ece_harness_reset task has no matching endtask');
  }
  return contents.slice(taskStart, taskEnd + 'endtask'.length);
}

/** Assert Property 6 over one already-accepted pair of renders of the SAME base request. */
function assertNonceIsolated(renderedA: string, renderedB: string): void {
  expect(extractStimulusRegion(renderedB)).toBe(extractStimulusRegion(renderedA));
  expect(extractResetRegion(renderedB)).toBe(extractResetRegion(renderedA));
  // Part (c), non-vacuity: the two full renders really do differ, confirming the nonce is not
  // simply dropped - the CHECK/SAMPLE/SAMPLE_END lines are where it shows up.
  expect(renderedB).not.toBe(renderedA);
}

// ---------------------------------------------------------------------------
// Shared fixture plumbing (reused from `rendered-stimulus-determinism.property.test.ts`)
// ---------------------------------------------------------------------------

/** No SystemVerilog-2017 keyword begins with this, so a drawn nonce never needs a retry. */
const NONCE_PREFIX = 'zzid';

/** Two distinct nonces sharing `NONCE_PREFIX`: distinct suffixes guarantee distinct full nonces. */
function noncePairArbitrary(): fc.Arbitrary<readonly [string, string]> {
  return fc
    .uniqueArray(stringFromChars(ASCII_IDENT_CHARS, 0, 6), { minLength: 2, maxLength: 2 })
    .map(([a, b]) => [`${NONCE_PREFIX}${a}`, `${NONCE_PREFIX}${b}`] as const);
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

/** The (interface, timingContract, roles, sampleBudget) held fixed, and a pair of nonces to vary. */
function arbFixedRequestWithNoncePair(): fc.Arbitrary<{
  readonly base: Omit<ConsensusHarnessRequest, 'nonce'>;
  readonly nonceA: string;
  readonly nonceB: string;
}> {
  return arbModuleInterface().chain((moduleInterface) =>
    fc
      .record({
        watchdogBudgetNs: fc.integer({ min: 1, max: 2_000_000 }),
        sampleBudget: fc.integer({ min: 1, max: 64 }),
        noncePair: noncePairArbitrary(),
      })
      .map(({ watchdogBudgetNs, sampleBudget, noncePair }) => ({
        base: {
          moduleInterface,
          timingContract: allRegisteredTiming(moduleInterface),
          watchdogBudgetNs,
          sampleBudget,
          roles: allDataRoles(moduleInterface),
        },
        nonceA: noncePair[0],
        nonceB: noncePair[1],
      })),
  );
}

describe(PROPERTY, () => {
  it(
    'renders a byte-identical Stimulus_Function region and reset region for two requests that ' +
      'differ only in their nonce, while the full renders differ',
    () => {
      let acceptedAtLeastOnce = false;

      fc.assert(
        fc.property(arbFixedRequestWithNoncePair(), ({ base, nonceA, nonceB }) => {
          const renderedA = renderConsensusHarness({ ...base, nonce: nonceA });
          const renderedB = renderConsensusHarness({ ...base, nonce: nonceB });

          if (!renderedA.ok || !renderedB.ok) {
            // A reserved-keyword nonce is a legitimate refusal (same reasoning
            // `rendered-stimulus-determinism.property.test.ts` already documents for port/module
            // names); the claim here is isolation of an ACCEPTED pair, not that every nonce is
            // accepted.
            expect(
              renderedB.ok,
              'one nonce was refused and the other accepted on the same base',
            ).toBe(renderedA.ok);
            return;
          }

          acceptedAtLeastOnce = true;
          assertNonceIsolated(renderedA.value.contents, renderedB.value.contents);
        }),
        propertyParameters(),
      );

      expect(acceptedAtLeastOnce, 'no draw was accepted by the renderer').toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Non-vacuity: a reset-bearing interface, exhausted directly rather than sampled
// ---------------------------------------------------------------------------
//
// `arbModuleInterface()` never draws a declared clock or reset, so the sampled property above
// only ever exercises the EMPTY half of the reset region's equality claim. This fixture is the
// only thing in this file that exercises the non-empty `task ece_harness_reset; ... endtask`
// half of part (b).

const RESET_BEARING_CLOCKING: ClockingContract = {
  clockName: 'clk',
  resetName: 'rst',
  resetActiveLow: false,
};

const RESET_BEARING_INTERFACE: ModuleInterface = {
  moduleName: 'nonce_isolation_reset_mod',
  ports: [
    { name: 'en', direction: 'input', width: 1 },
    { name: 'q', direction: 'output', width: 4 },
  ],
  clocking: RESET_BEARING_CLOCKING,
  validityOutputName: null,
};

describe(`${PROPERTY} - non-vacuity: a reset-bearing interface`, () => {
  it('renders a byte-identical, non-empty reset region across two nonces', () => {
    const base = {
      moduleInterface: RESET_BEARING_INTERFACE,
      timingContract: allRegisteredTiming(RESET_BEARING_INTERFACE),
      watchdogBudgetNs: 2_000_000,
      sampleBudget: 300,
      roles: allDataRoles(RESET_BEARING_INTERFACE),
    };
    const renderedA = renderConsensusHarness({ ...base, nonce: `${NONCE_PREFIX}aaa` });
    const renderedB = renderConsensusHarness({ ...base, nonce: `${NONCE_PREFIX}bbb` });
    if (!renderedA.ok || !renderedB.ok) {
      throw new Error(
        `fixture defect: renderer refused the reset-bearing fixture (A: ${String(renderedA.ok)}, B: ${String(renderedB.ok)})`,
      );
    }

    const resetRegion = extractResetRegion(renderedA.value.contents);
    expect(resetRegion).not.toBe('');
    expect(resetRegion).toContain(RESET_TASK_MARKER);
    expect(resetRegion).toContain('endtask');

    assertNonceIsolated(renderedA.value.contents, renderedB.value.contents);
  });
});
