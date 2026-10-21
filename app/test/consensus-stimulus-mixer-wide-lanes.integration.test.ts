// Real-toolchain integration test: the `lane` parameter on an interface wider than 64 bits,
// cross-checked against the independently-evaluated TypeScript BigInt model (task 8.3, C4, C5).
//
// WHY THIS TEST EXISTS
//
//   No probed design in `probe-splitmix.mjs` (task 7.4) exercises `lane` at all: every one of
//   the four hand-written corpus replies has an input bundle of at most 33 bits, so every prior
//   real-toolchain run only ever called `ece_mix(32'd0, step)`. The retained RTLLM corpus holds
//   a 129-bit shape (`adder_64bit`: two 64-bit operands plus a carry-in), which needs THREE
//   lanes - this is the first real run that ever exercises `ece_mix(32'd1, step)` and
//   `ece_mix(32'd2, step)` at all.
//
// WHY A STEP-BY-STEP VALUE COMPARISON, NOT ONLY A SHAPE CHECK
//
//   `rendered-stimulus-layout.property.test.ts` (task 2.8) already pins the rendered TEXT of the
//   lane-slicing loop; `rendered-stimulus-mixer.property.test.ts` (task 2.10) already proves the
//   BigInt model of `ece_mix` is free of near-periodicity. Design.md names the exact risk neither
//   closes alone: a test asserting the rendered mixer's TEXT and a test evaluating a TypeScript
//   model of the mixer can both be green while silently disagreeing with EACH OTHER - which
//   reinstates the model-versus-Verilog drift class this whole feature exists to remove. Only
//   extracting the REAL per-lane values the real simulator actually computed, and comparing them
//   step by step against the SAME BigInt translation task 2.10 already validated statistically,
//   closes that gap. A Reference_Model whose `ece_expect` echoes the full input bundle straight
//   back out is what makes the real per-lane values visible on the wire at all: nothing else in
//   this harness's own stdout protocol would expose them otherwise.
//
// WHY LANE OWNERSHIP, NOT ONLY LANE ACTIVITY
//
//   Asserting lane `k` owns bits `[64k+63 : 64k]`, rather than only that the high bits are
//   non-constant, because a renderer that swapped two lanes (fed the mixer's lane-1 output into
//   the bundle's lane-0 slice) would still look "active" under any aggregate activity check and
//   would only be caught by comparing the EXACT value at each specific slice.

import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import {
  renderConsensusHarness,
  type ConsensusHarnessRequest,
} from '../tools/simulator/consensus-harness.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[consensus-stimulus-mixer-wide-lanes.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'The lane parameter on a >64-bit interface is UNVALIDATED against real iverilog in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 60_000 };
const RUN_TIMEOUT = 120_000;
const SAMPLE_COUNT = 8;

// -- The independently-evaluated TypeScript BigInt model, verbatim from the statement sequence --
// -- `rendered-stimulus-mixer.property.test.ts` already validated (task 2.10's own translation) --

const MASK64 = (1n << 64n) - 1n;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const SPLITMIX_MIX1 = 0xbf58476d1ce4e5b9n;
const SPLITMIX_MIX2 = 0x94d049bb133111ebn;

/** `ece_mix(lane, step)`, translated to BigInt statement for statement from `renderStimulusMixer()`. */
function stimulusMixer(lane: number, step: number): bigint {
  let h = ((BigInt(lane) << 32n) | BigInt(step)) & MASK64;
  h = (h + SPLITMIX_GAMMA) & MASK64;
  h = (h ^ (h >> 30n)) & MASK64;
  h = (h * SPLITMIX_MIX1) & MASK64;
  h = (h ^ (h >> 27n)) & MASK64;
  h = (h * SPLITMIX_MIX2) & MASK64;
  h = (h ^ (h >> 31n)) & MASK64;
  return h;
}

// -- A 129-bit interface (two 64-bit operands plus a carry-in), the `adder_64bit` corpus shape --
// -- requiring exactly three lanes: ceil(129 / 64) = 3. --------------------------------------

const WIDE_ECHO_RTL: SourceFile = {
  path: 'wide_echo.v',
  contents: `module wide_echo (
  input  wire [63:0] a0,
  input  wire [63:0] b0,
  input  wire        cin,
  output wire [63:0] qa,
  output wire [63:0] qb,
  output wire        qc
);
  // A pure echo, deliberately: the claim under test is about the STIMULUS the harness drives,
  // not about any arithmetic a candidate design might perform on it, so the simplest RTL that
  // puts every driven bit onto an observable output is the right fixture.
  assign qa = a0;
  assign qb = b0;
  assign qc = cin;
endmodule
`,
};

const WIDE_ECHO_INTERFACE: ModuleInterface = {
  moduleName: 'wide_echo',
  ports: [
    { name: 'a0', direction: 'input', width: 64 },
    { name: 'b0', direction: 'input', width: 64 },
    { name: 'cin', direction: 'input', width: 1 },
    { name: 'qa', direction: 'output', width: 64 },
    { name: 'qb', direction: 'output', width: 64 },
    { name: 'qc', direction: 'output', width: 1 },
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

/** A correctly-written Reference_Model that echoes the full input bundle straight back out. */
const WIDE_ECHO_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "  ece_reset_state = 128'd0;",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [128:0] in);',
    '  ece_next_state = s;',
    'endfunction',
    'function automatic [128:0] ece_expect(input [127:0] s, input [128:0] in);',
    '  ece_expect = in;',
    'endfunction',
    '',
  ].join('\n'),
};

function renderHarnessOrThrow(nonce: string): SourceFile {
  const timingBuilt = makeTimingContract(WIDE_ECHO_INTERFACE, [
    { portName: 'qa', timing: 'combinational' },
    { portName: 'qb', timing: 'combinational' },
    { portName: 'qc', timing: 'combinational' },
  ]);
  if (!timingBuilt.ok) {
    throw new Error(`fixture defect: ${timingBuilt.error.code}`);
  }
  const request: ConsensusHarnessRequest = {
    moduleInterface: WIDE_ECHO_INTERFACE,
    timingContract: timingBuilt.value,
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_COUNT,
    roles: [
      { portName: 'a0', role: 'data' },
      { portName: 'b0', role: 'data' },
      { portName: 'cin', role: 'data' },
    ],
  };
  const rendered = renderConsensusHarness(request);
  if (!rendered.ok) {
    throw new Error(`fixture defect: ${rendered.error.code}`);
  }
  return rendered.value;
}

/** One real `ECE_SAMPLE` line's step and its three hex output values (qa, qb, qc), parsed from real stdout. */
interface SampleLine {
  readonly step: number;
  readonly qa: bigint;
  readonly qb: bigint;
  readonly qc: bigint;
}

function parseSampleLines(stdout: string, nonce: string): readonly SampleLine[] {
  const pattern = new RegExp(`^ECE_SAMPLE ${nonce} (\\d+) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+)$`);
  return stdout
    .split('\n')
    .map((line) => pattern.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      step: Number(match[1]),
      qa: BigInt(`0x${match[2] as string}`),
      qb: BigInt(`0x${match[3] as string}`),
      qc: BigInt(`0x${match[4] as string}`),
    }));
}

function checkFailLines(stdout: string, nonce: string): readonly string[] {
  const pattern = new RegExp(`^CHECK ${nonce}_\\w+ FAIL`);
  return stdout.split('\n').filter((line) => pattern.test(line.trim()));
}

describe('consensus stimulus mixer wide-lane real-toolchain capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'the lane parameter on a 129-bit interface matches the independently-evaluated TypeScript BigInt model, lane by lane, step by step (Req 2.2, 2.4, 2.12)',
  () => {
    it(
      'runs cleanly (zero CHECK FAIL) and every real per-lane value exactly matches stimulusMixer(lane, step)',
      async () => {
        const nonce = 'wideLane1';
        const harness = renderHarnessOrThrow(nonce);
        const verdict = await realOracleAdapter().simulate(
          [WIDE_ECHO_RTL, WIDE_ECHO_REFERENCE_MODEL],
          harness,
          REAL_LIMITS,
        );
        expect(verdict.failureCause).toBe('none');
        expect(checkFailLines(verdict.stdout, nonce)).toEqual([]);
        expect(verdict.verdict).toBe('pass');

        const samples = parseSampleLines(verdict.stdout, nonce);
        expect(samples).toHaveLength(SAMPLE_COUNT);
        expect(samples.map((sample) => sample.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

        for (const sample of samples) {
          // Lane 0 owns bits [63:0] (qa, a0's slice); lane 1 owns bits [127:64] (qb, b0's
          // slice); lane 2 owns bit [128:128] (qc, cin's slice) - the exact per-lane ownership
          // the packed-bundle layout assigns, confirmed against REAL simulator output rather
          // than only against the rendered text.
          expect(sample.qa).toBe(stimulusMixer(0, sample.step) & MASK64);
          expect(sample.qb).toBe(stimulusMixer(1, sample.step) & MASK64);
          expect(sample.qc).toBe(stimulusMixer(2, sample.step) & 1n);
        }
      },
      RUN_TIMEOUT,
    );

    it('the TypeScript model used for comparison is non-trivial: lane 0 and lane 1 differ at every sampled step (a swapped-lane renderer regression would be caught)', () => {
      for (let step = 0; step < SAMPLE_COUNT; step += 1) {
        expect(stimulusMixer(0, step)).not.toBe(stimulusMixer(1, step));
      }
    });
  },
);
