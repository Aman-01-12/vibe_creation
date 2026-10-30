// Real-toolchain integration test: a full rendered Consensus_Harness over a Strobe-and-Held_Input
// interface still compiles, still emits its three line shapes correctly ordered, and still
// exercises its mid-run reset branch (task 8.12, C3; Req 4.8, 4.10, 5.5).
//
// WHY THIS TEST EXISTS, AND HOW IT DIFFERS FROM THE OTHER NEW-ROLE INTEGRATION TESTS
//
//   Tasks 8.8-8.11 exercise the standalone Non_Vacuity_Probe reading over a Strobe/Held_Input
//   interface - a different code path that never renders or runs a full Consensus_Harness. This
//   test is the one check that the two new `ece_stimulus` emission sites (the strobe branch and
//   the hold branch in `renderStimulusFunction`) did not break the harness MODULE they render
//   into: its CHECK lines, its ECE_SAMPLE lines, and its mid-run reset branch, all still compile
//   and run correctly for an interface that actually declares both new roles together.
//
// WHY THE RESET COUNT IS ASSERTED FROM DUMPED VALUES, NOT INFERRED FROM A CLEAN EXIT
//
//   `chipAgent/_inbox/gotcha-a-resetless-clocked-harness-clocked-the-design-twice-before-step-0-and-the-smoke-fixture-absorbed-it.md`
//   records a case where the one smoke fixture covering a reset-adjacent shape absorbed an
//   alignment defect instead of catching it, because its Reference_Model was fitted to the bug
//   (hand-tuned to agree with the wrong harness output) rather than independently checked. The
//   defence here is the same one `consensus-mid-run-reset.integration.test.ts` already applies:
//   read the REAL `ECE_SAMPLE` trace at every step this run's own rendered `ECE_RESET_FRAME`
//   predicts a reset fires, and assert the design's real registered output reads its reset value
//   (0) at every one of those steps - not just that the run finished with `failureCause: 'none'`.
//   A broken or un-rendered reset branch would leave `latched` holding whatever a prior Strobe
//   last wrote, which this assertion would catch.
//
// THE FIXTURE: A HELD OPERAND LATCHED ON STROBE
//
//   `hold_latch` registers `operand` into `latched` on the one step of every Hold_Window that a
//   Strobe asserts, and holds `latched` on every other step - the simplest real design that
//   gives a Strobe role and a Held_Input role something observable to do together. Because a
//   Strobe is declared, the Hold_Window equals the Strobe_Period (Req 4.2, 4.7), so `operand`'s
//   held value is already stable on the exact step `strobe` pulses.

import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import {
  RESET_FRAME_PERIOD,
  renderConsensusHarness,
  type ConsensusHarnessRequest,
} from '../tools/simulator/consensus-harness.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[consensus-strobe-hold-reset.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'The full Consensus_Harness over a Strobe/Held_Input interface is UNVALIDATED against real iverilog in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 60_000 };
const RUN_TIMEOUT = 120_000;

// 8 * RESET_FRAME_PERIOD (2048) plus one whole extra reset frame of margin, so the run is sized
// from the harness's own reset-firing constant rather than a copied literal, and comfortably
// exercises at least 8 mid-run resets even if a future change nudges the constant.
const STROBE_HOLD_SAMPLE_BUDGET = 8 * RESET_FRAME_PERIOD + RESET_FRAME_PERIOD;

/** Parse every `ECE_SAMPLE <nonce> <step> <values...>` line's step and hex values from real stdout. */
function parseSampleLines(
  stdout: string,
  nonce: string,
): readonly { readonly step: number; readonly values: readonly string[] }[] {
  const pattern = new RegExp(`^ECE_SAMPLE ${nonce} (\\d+) (.+)$`);
  return stdout
    .split('\n')
    .map((line) => pattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      step: Number(match[1]),
      values: (match[2] as string).trim().split(/\s+/),
    }));
}

/** The single `ECE_SAMPLE_END <nonce> <count>` line's count, or null if absent/duplicated. */
function endMarkerCount(stdout: string, nonce: string): number | null {
  const pattern = new RegExp(`^ECE_SAMPLE_END ${nonce} (\\d+)$`);
  const matches = stdout
    .split('\n')
    .map((line) => pattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  return matches.length === 1 ? Number((matches[0] as RegExpExecArray)[1]) : null;
}

/** Every `CHECK <nonce>_<port> FAIL` line in real stdout, which must be empty for a clean run. */
function checkFailLines(stdout: string, nonce: string): readonly string[] {
  const pattern = new RegExp(`^CHECK ${nonce}_\\w+ FAIL`);
  return stdout.split('\n').filter((line) => pattern.test(line.trim()));
}

/** The rendered `ECE_SAMPLE_BUDGET` localparam's integer value, read from the harness text. */
function renderedSampleBudget(harnessText: string): number {
  const match = /localparam integer ECE_SAMPLE_BUDGET = (\d+);/.exec(harnessText);
  if (match === null) {
    throw new Error('fixture defect: ECE_SAMPLE_BUDGET localparam not found in rendered text');
  }
  return Number(match[1]);
}

// -- The fixture: a Strobe + Held_Input interface --------------------------------------------

const HOLD_LATCH_RTL: SourceFile = {
  path: 'hold_latch.v',
  contents: `module hold_latch (
  input  wire       clk,
  input  wire       rst,
  input  wire       strobe,
  input  wire [3:0] operand,
  output reg  [3:0] latched
);
  always @(posedge clk) begin
    if (rst)
      latched <= 4'd0;
    else if (strobe)
      latched <= operand;
  end
endmodule
`,
};

const HOLD_LATCH_INTERFACE: ModuleInterface = {
  moduleName: 'hold_latch',
  ports: [
    { name: 'strobe', direction: 'input', width: 1 },
    { name: 'operand', direction: 'input', width: 4 },
    { name: 'latched', direction: 'output', width: 4 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
  validityOutputName: null,
};

/**
 * A correctly-written Reference_Model mirroring `hold_latch`'s own strobe-gated latch. The
 * threaded state IS the current `latched` value. `ece_expect` ignores `in` entirely: `latched`
 * is a registered port, so the harness evaluates it with an all-zero `in` (the registered output
 * cannot depend on the input applied in the same cycle), and the current displayed value is a
 * pure function of state alone.
 *
 * `in`'s bit layout follows the declared input-port order: bit 0 is `strobe` (the first declared
 * input port, width 1), bits [4:1] are `operand` (the second, width 4).
 */
const HOLD_LATCH_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "  ece_reset_state = 128'd0;",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [4:0] in);',
    '  if (in[0])',
    "    ece_next_state = {123'd0, in[4:1]};",
    '  else',
    '    ece_next_state = s;',
    'endfunction',
    'function automatic [3:0] ece_expect(input [127:0] s, input [4:0] in);',
    '  ece_expect = s[3:0];',
    'endfunction',
    '',
  ].join('\n'),
};

function renderHarnessOrThrow(nonce: string): SourceFile {
  const timingBuilt = makeTimingContract(HOLD_LATCH_INTERFACE, [
    { portName: 'latched', timing: 'registered' },
  ]);
  if (!timingBuilt.ok) {
    throw new Error(`fixture defect: ${timingBuilt.error.code}`);
  }
  const request: ConsensusHarnessRequest = {
    moduleInterface: HOLD_LATCH_INTERFACE,
    timingContract: timingBuilt.value,
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget: STROBE_HOLD_SAMPLE_BUDGET,
    roles: [
      { portName: 'strobe', role: 'strobe' as const },
      { portName: 'operand', role: 'hold' as const },
    ],
  };
  const rendered = renderConsensusHarness(request);
  if (!rendered.ok) {
    throw new Error(`fixture defect: ${rendered.error.code}`);
  }
  return rendered.value;
}

describe('consensus strobe-and-hold full harness real-toolchain capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'a full Consensus_Run over a Strobe + Held_Input interface compiles, streams correctly, and still resets (Req 4.8, 4.10, 5.5)',
  () => {
    it(
      'emits ECE_SAMPLE lines in increasing step order, one hex value each, a matching end marker, and zero CHECK FAIL',
      async () => {
        const nonce = 'strobeHold1';
        const harness = renderHarnessOrThrow(nonce);

        const verdict = await realOracleAdapter().simulate(
          [HOLD_LATCH_RTL, HOLD_LATCH_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');
        expect(checkFailLines(verdict.stdout, nonce)).toEqual([]);
        expect(verdict.verdict).toBe('pass');

        const emittedBudget = renderedSampleBudget(harness.contents);
        const samples = parseSampleLines(verdict.stdout, nonce);
        expect(samples.map((sample) => sample.step)).toEqual(
          Array.from({ length: emittedBudget }, (_, step) => step),
        );
        expect(samples.every((sample) => sample.values.length === 1)).toBe(true);
        expect(endMarkerCount(verdict.stdout, nonce)).toBe(samples.length);

        // Non-vacuity: the latch is actually live over this run, not stuck at its reset value
        // for the whole budget - otherwise the reset-count assertion below would be trivially
        // true regardless of whether the reset branch is rendered at all.
        expect(samples.some((sample) => sample.values[0] !== '0')).toBe(true);
      },
      RUN_TIMEOUT,
    );

    it(
      'fires the mid-run reset branch at least 8 times, confirmed by reading `latched` back to 0 at every rendered reset boundary',
      async () => {
        const nonce = 'strobeHold2';
        const harness = renderHarnessOrThrow(nonce);
        expect(harness.contents).toContain('ece_harness_reset');
        expect(harness.contents).toContain(
          `localparam integer ECE_RESET_FRAME = ${String(RESET_FRAME_PERIOD)};`,
        );

        const verdict = await realOracleAdapter().simulate(
          [HOLD_LATCH_RTL, HOLD_LATCH_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');

        const emittedBudget = renderedSampleBudget(harness.contents);
        const resetSteps = Array.from({ length: emittedBudget }, (_, step) => step).filter(
          (step) => step % RESET_FRAME_PERIOD === 0,
        );
        // The check this task exists to make: at least 8 real mid-run reset assertions, sized
        // from the harness's own RESET_FRAME_PERIOD rather than a copied literal.
        expect(resetSteps.length).toBeGreaterThanOrEqual(8);

        const samplesByStep = new Map(
          parseSampleLines(verdict.stdout, nonce).map((sample) => [sample.step, sample.values]),
        );
        // The counted claim: `latched` (the registered output) really reads back to its reset
        // value at EVERY step the rendered loop's own modulo check predicts a reset fires - read
        // from the real ECE_SAMPLE trace, not inferred from a clean exit. A reset branch that
        // failed to render or fired at the wrong steps would leave `latched` holding whatever a
        // prior Strobe last wrote, which this would catch.
        for (const resetStep of resetSteps) {
          const values = samplesByStep.get(resetStep);
          expect(values).toEqual(['0']);
        }
      },
      RUN_TIMEOUT,
    );
  },
);
