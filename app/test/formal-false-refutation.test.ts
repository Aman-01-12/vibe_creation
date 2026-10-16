// formal-gate-first-light, Component 6: the runnable check over the False_Refutation adjudicator.
//
// Needs no toolchain. The referee is injected, so all four outcomes are reachable from a fake:
// the real iverilog replay is exercised by the measurements in tasks 4.5 and 4.25, and what is
// under test here is the DECISION, which is the part that can silently misattribute.

import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import type { SimulatorAdapter, SourceFile } from '@app/tools';

import {
  adjudicate,
  describeAdjudication,
  isCandidateShape,
  realizable,
  notRealizable,
  replaySequenceTestbench,
  REPLAY_CHECK_NAME,
  traceSteps,
  unadjudicated,
  type Adjudication,
  type CandidateFalseRefutation,
  type UnadjudicatedReason,
} from './formal-false-refutation.js';

/** The first step's values, which is what the single-state assertions below are about. */
function firstStepValues(vcd: string): ReadonlyMap<string, bigint> {
  return traceSteps(vcd).at(0)?.values ?? new Map<string, bigint>();
}

/** The design under replay: one adder whose ports the counterexample must resolve. */
const DESIGN_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'adder_8bit',
  ports: [
    { name: 'a', direction: 'input', width: 8 },
    { name: 'b', direction: 'input', width: 8 },
    { name: 'sum', direction: 'output', width: 9 },
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
};

const DESIGN: SourceFile = { path: 'adder_8bit.v', contents: 'module adder_8bit; endmodule\n' };

/**
 * A counterexample whose wrapper scope declares all three ports, and whose FLATTENED inner
 * scope re-declares `a` at one bit. A scope-blind reader resolves `a` to the inner one.
 */
const TRACE = [
  '$timescale 1ns $end',
  '$scope module formal_property_wrapper $end',
  '$var wire 8 n0 a $end',
  '$var wire 8 n1 b $end',
  '$var wire 9 n2 sum $end',
  '$scope module full_adder_0 $end',
  '$var wire 1 n9 a $end',
  '$upscope $end',
  '$upscope $end',
  '$enddefinitions $end',
  '#0',
  'b11111111 n0',
  'b00000001 n1',
  'b100000000 n2',
  'b1 n9',
].join('\n');

function candidate(overrides: Partial<CandidateFalseRefutation> = {}): CandidateFalseRefutation {
  return {
    propertyId: 'adder-8bit-exact-sum',
    designId: 'rtllm/arithmetic/adder_8bit',
    design: DESIGN,
    designInterface: DESIGN_INTERFACE,
    expectedVerdict: 'proved',
    actualVerdict: 'refuted',
    counterexample: TRACE,
    resetContract: { kind: 'synchronous', polarity: 'active-high' },
    ...overrides,
  };
}

/** A referee answering one fixed verdict, recording every testbench it was handed. */
function fakeReferee(
  verdict: 'pass' | 'fail' | 'error',
  failedCheck = REPLAY_CHECK_NAME,
): { readonly referee: SimulatorAdapter; readonly seen: SourceFile[] } {
  const seen: SourceFile[] = [];
  return {
    seen,
    referee: {
      simulate: (_rtl: readonly SourceFile[], testbench: SourceFile) => {
        seen.push(testbench);
        return Promise.resolve({
          verdict,
          checks: verdict === 'error' ? [] : [{ name: failedCheck, passed: verdict === 'pass' }],
          vcd: null,
          stdout: '',
          stderr: '',
          exitCode: verdict === 'error' ? null : 0,
          resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
          failureCause: verdict === 'error' ? ('tool-failed' as const) : ('none' as const),
          attributedFiles: [],
          watchdog: { stopped: false },
        });
      },
    },
  };
}

/** A referee that throws rather than answering. */
const THROWING_REFEREE: SimulatorAdapter = {
  simulate: () => Promise.reject(new Error('the referee could not be launched')),
};

describe('the candidate shape (Req 4.3)', () => {
  it('is exactly proved-expected and refuted-returned', () => {
    expect(isCandidateShape('proved', 'refuted')).toBe(true);
    // Every other pair is not a contradiction, so it is not a candidate.
    for (const [expected, actual] of [
      ['proved', 'proved'],
      ['refuted', 'refuted'],
      ['refuted', 'proved'],
      ['could-not-verify', 'refuted'],
      ['proved', 'could-not-verify'],
    ] as const) {
      expect(isCandidateShape(expected, actual), `${expected}/${actual}`).toBe(false);
    }
  });
});

describe('stepZeroModel resolves names in the design scope only (Req 4.5)', () => {
  it('reads the wrapper-scope width, never the flattened one-bit re-declaration', () => {
    const model = firstStepValues(TRACE);

    // The trap: `a` is 255 at the wrapper, and 1 in `full_adder_0`. A scope-blind reader
    // would hand the replay the 1.
    expect(model.get('a')).toBe(255n);
    expect(model.get('b')).toBe(1n);
    expect(model.get('sum')).toBe(256n);
  });

  it('drops a don-t-care rather than coercing it, so no x reads as a witness', () => {
    const model = firstStepValues(
      ['$scope module w $end', '$var wire 8 n0 a $end', '$upscope $end', '#0', 'b1111xxxx n0'].join(
        '\n',
      ),
    );

    expect(model.has('a')).toBe(false);
  });

  it('yields an empty map for text carrying no readable step zero', () => {
    expect(firstStepValues('').size).toBe(0);
    expect(firstStepValues('not a vcd at all').size).toBe(0);
  });
});

describe('adjudicate attributes in three directions (Req 4.6, 4.7, 4.12, 4.13)', () => {
  it('reports realizable when the unmodified design reproduces the counterexample', async () => {
    const { referee, seen } = fakeReferee('pass');
    const result = await adjudicate(candidate(), referee);

    expect(result.kind).toBe('realizable');
    // Non-vacuity: the replay really was built and handed over, driving the wrapper-scope value.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.contents).toContain("a = 8'd255");
    expect(seen[0]?.contents).toContain(REPLAY_CHECK_NAME);
  });

  it('reports not-realizable when the design does not reproduce the path', async () => {
    // One-directional until the harness passes its positive control. The measured reason:
    // `adder-pipe-64bit-carry-never-set` is false by construction, so its refutation is genuine,
    // and the replay reports a mismatch for it anyway. An instrument failing its own control
    // must not be able to accuse the Reset_Contract derivation of a defect.
    const result = await adjudicate(candidate(), fakeReferee('fail').referee);

    expect(result.kind).toBe('not-realizable');
  });

  it('reports unadjudicated, NOT not-realizable, when the referee reached no verdict', async () => {
    // The soundness case FL-23 exists for: an errored referee has established nothing about the
    // Reset_Contract derivation, and recording it as a derivation defect would invent a finding.
    const result = await adjudicate(candidate(), fakeReferee('error').referee);

    expect(result).toEqual(unadjudicated('referee-run-errored'));
  });

  it('reports unadjudicated when the referee could not be launched at all', async () => {
    expect(await adjudicate(candidate(), THROWING_REFEREE)).toEqual(
      unadjudicated('referee-run-errored'),
    );
  });

  it('reports unadjudicated and spends no run when a name is unresolvable in scope', async () => {
    const { referee, seen } = fakeReferee('pass');
    const blind = candidate({
      counterexample: [
        '$scope module w $end',
        '$var wire 8 n0 a $end',
        '$upscope $end',
        '#0',
        'b1 n0',
      ].join('\n'),
    });

    const result = await adjudicate(blind, referee);

    expect(result).toEqual(unadjudicated('name-unresolvable-in-scope'));
    // Refused before the referee, because driving an unresolved name drives the wrong net.
    expect(seen).toEqual([]);
  });
});

describe('what the referee can and cannot replay (FL-24)', () => {
  /** The same trace shape, carrying a second time step. */
  const MULTI_STEP = [TRACE, '#5', 'b00000001 n0'].join('\n');

  it('refuses a multi-step trace before reading values, because a path is not a state', async () => {
    const { referee, seen } = fakeReferee('pass');

    const result = await adjudicate(candidate({ counterexample: MULTI_STEP }), referee);

    expect(result).toEqual(unadjudicated('sequence-replay-unsupported'));
    // Refused before the referee: answering a different question cheaply is still answering
    // the wrong one.
    expect(seen).toEqual([]);
    expect(traceSteps(MULTI_STEP).length).toBe(2);
    expect(traceSteps(TRACE).length).toBe(1);
  });

  it('adjudicates when an output the property never mentioned is absent from the trace', async () => {
    // The measured multi_16bit case: the wrapper declares only the signals the property
    // references, so requiring every port abstained on a trace that was perfectly replayable.
    const extraPort: ModuleInterface = {
      ...DESIGN_INTERFACE,
      ports: [...DESIGN_INTERFACE.ports, { name: 'done', direction: 'output', width: 1 }],
    };

    const result = await adjudicate(
      candidate({ designInterface: extraPort }),
      fakeReferee('pass').referee,
    );

    expect(result.kind).toBe('realizable');
  });

  it('abstains when NO output is comparable, because there is nothing to disagree with', async () => {
    const noOutputInTrace: ModuleInterface = {
      ...DESIGN_INTERFACE,
      ports: [
        ...DESIGN_INTERFACE.ports.filter((port) => port.direction === 'input'),
        { name: 'done', direction: 'output', width: 1 },
      ],
    };

    expect(
      await adjudicate(
        candidate({ designInterface: noOutputInTrace }),
        fakeReferee('pass').referee,
      ),
    ).toEqual(unadjudicated('name-unresolvable-in-scope'));
  });

  it('never treats smtbmc bookkeeping or our own gate counter as a design signal', () => {
    const withBookkeeping = [
      '$scope module formal_property_wrapper $end',
      '$var wire 1 s0 smt_clock $end',
      '$var wire 5 s1 __formal_warmup_age $end',
      '$var wire 8 n0 a $end',
      '$upscope $end',
      '#0',
      'b1 s0',
      'b00101 s1',
      'b11111111 n0',
    ].join('\n');

    const model = firstStepValues(withBookkeeping);

    expect(model.get('a')).toBe(255n);
    expect(model.has('smt_clock')).toBe(false);
    expect(model.has('__formal_warmup_age')).toBe(false);
  });
});

describe('sequence replay over a clocked multi-step trace (FL-24)', () => {
  /** A clocked design, so a multi-step path can actually be advanced. */
  const CLOCKED: ModuleInterface = {
    validityOutputName: null,
    moduleName: 'counter_12',
    ports: [
      { name: 'valid_count', direction: 'input', width: 1 },
      { name: 'out', direction: 'output', width: 4 },
    ],
    clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  };

  /**
   * Three steps where `valid_count` is written ONCE and then holds.
   *
   * That hold is the case carry-forward exists for: a reader taking each step literally would
   * see it absent at steps 1 and 2 and drive zero, replaying different stimulus than the solver
   * found.
   */
  const THREE_STEPS = [
    '$scope module formal_property_wrapper $end',
    '$var wire 1 c clk $end',
    '$var wire 1 r rst_n $end',
    '$var wire 1 v valid_count $end',
    '$var wire 4 o out $end',
    '$upscope $end',
    '$enddefinitions $end',
    '#0',
    '0r',
    '1v',
    'b0000 o',
    '#5',
    '1r',
    'b0001 o',
    '#10',
    'b0010 o',
  ].join('\n');

  it('reads every step and carries a held value forward', () => {
    const steps = traceSteps(THREE_STEPS);

    expect(steps.map((entry) => entry.step)).toEqual([0, 5, 10]);
    // Written once at step 0, asserted at all three.
    expect(steps.map((entry) => entry.values.get('valid_count'))).toEqual([1n, 1n, 1n]);
    // And the changing signals change.
    expect(steps.map((entry) => entry.values.get('out'))).toEqual([0n, 1n, 2n]);
    expect(steps.map((entry) => entry.values.get('rst_n'))).toEqual([0n, 1n, 1n]);
  });

  it('drives one rising edge between steps and compares the outputs at each', () => {
    const source = replaySequenceTestbench(
      candidate({ designInterface: CLOCKED, counterexample: THREE_STEPS }),
      traceSteps(THREE_STEPS),
    );

    // The clock is GENERATED, never driven from the trace: the trace's clock is the BMC's own
    // step encoding, and driving it as data would fight the design's own timing.
    expect(source).toContain("clk = 1'b1; #1; clk = 1'b0; #1;");
    expect(source).not.toContain("clk = 1'd");
    // One edge BETWEEN steps, so three steps take two edges rather than three.
    expect([...source.matchAll(/clk = 1'b1;/g)]).toHaveLength(2);
    // Every step's output is compared, which is what makes this a path check.
    expect(source).toContain("if (out !== 4'd0) mismatches = mismatches + 1;");
    expect(source).toContain("if (out !== 4'd1) mismatches = mismatches + 1;");
    expect(source).toContain("if (out !== 4'd2) mismatches = mismatches + 1;");
    // The carried value is RE-DRIVEN at every step rather than left to `reg` retention, so
    // each step's stimulus is stated in full in the text a reviewer reads.
    expect([...source.matchAll(/valid_count = 1'd1;/g)]).toHaveLength(3);
  });

  it('adjudicates a clocked multi-step counterexample instead of abstaining', async () => {
    const { referee, seen } = fakeReferee('pass');

    const result = await adjudicate(
      candidate({ designInterface: CLOCKED, counterexample: THREE_STEPS }),
      referee,
    );

    // The whole point of FL-24: this used to return unadjudicated for every clocked property.
    expect(result.kind).toBe('realizable');
    expect(seen).toHaveLength(1);
  });

  it('still abstains on a multi-step path over a design with no clock to advance', async () => {
    const result = await adjudicate(
      candidate({ counterexample: [TRACE, '#5', 'b00000001 n0'].join('\n') }),
      fakeReferee('pass').referee,
    );

    expect(result).toEqual(unadjudicated('sequence-replay-unsupported'));
  });
});

describe('the Adjudication type (Req 4.13)', () => {
  it('carries evidence on both attributions and a reason on neither', () => {
    const evidence = { verdict: 'pass', failedChecks: [], exitCode: 0, vcd: null } as const;

    for (const attributed of [realizable(evidence), notRealizable(evidence)]) {
      expect('evidence' in attributed).toBe(true);
      expect('reason' in attributed).toBe(false);
    }
  });

  it('carries a reason on an abstention and no evidence, so none can be mistaken for a verdict', () => {
    const reasons: readonly UnadjudicatedReason[] = [
      'probe-unavailable',
      'referee-run-errored',
      'name-unresolvable-in-scope',
    ];

    for (const reason of reasons) {
      const abstained: Adjudication = unadjudicated(reason);

      expect(abstained).toEqual({ kind: 'unadjudicated', reason });
      expect('evidence' in abstained).toBe(false);
      // Every reason has operator words, which is what the total Record buys.
      expect(describeAdjudication(abstained)).toContain('unadjudicated');
      expect(describeAdjudication(abstained).length).toBeGreaterThan(reason.length + 15);
    }
  });

  it('describes the two attributions distinctly, naming which side each accuses', () => {
    const evidence = { verdict: 'pass', failedChecks: [], exitCode: 0, vcd: null } as const;

    expect(describeAdjudication(realizable(evidence))).toContain('merits');
    expect(describeAdjudication(notRealizable(evidence))).toContain('Reset_Contract');
  });
});

describe('the replay testbench', () => {
  it('drives every input and compares every output at the counterexample values', () => {
    const source = replaySequenceTestbench(candidate(), traceSteps(TRACE));

    expect(source).toContain("a = 8'd255");
    expect(source).toContain("b = 8'd1");
    // The comparison is a mismatch COUNT, so one differing step fails the whole replay rather
    // than only the step that differed.
    expect(source).toContain("if (sum !== 9'd256) mismatches = mismatches + 1;");
    // It instantiates the design rather than reimplementing any part of it.
    expect(source).toContain('adder_8bit dut (');
    expect(source).not.toContain('assign');
  });
});
