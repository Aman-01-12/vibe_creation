// Real-toolchain integration test: every kill path yields a non-passing cell and no signature
// (task 8.5; Req 7.7, 9.6, 14.2).
//
// THREE FIXTURES, ONE PER PATH
//   A wall-clock kill at the 30,000 ms RUN_CELL_RESOURCE_LIMITS ceiling, a disk-cap kill at
//   diskMb 128, and the stdout-truncation case (the real worker's 1,048,576-byte stdout cap).
//   Each is driven through the REAL `IcarusSimulatorAdapter` (no fakes), so the classification
//   is measured rather than assumed.
//
// KNOWN GAP: THE "WATCHDOG STOP IN SIMULATED TIME" PATH HAS NO DISTINCT MECHANISM TO MEASURE
//
//   `app/tools/simulator/consensus-harness.ts` declares `ECE_WATCHDOG_BUDGET_NS` as a
//   `localparam`, but no statement in the rendered harness ever consumes it - no `#(...)` delay,
//   no `wait`, nothing reads the value at all. There is no enforcing simulated-time watchdog in
//   the Consensus_Harness renderer today (unlike `simulation-harness.ts`'s own `SIMULATION_
//   HARNESS`, which DOES print its sentinel and `$finish` after `#(WATCHDOG_BUDGET_NS)`). This is
//   a pre-existing gap in the renderer, not something this task is asked to fix (and the task
//   explicitly says not to attempt a renderer fix here).
//
//   So "a watchdog stop in simulated time" is not independently measurable against the
//   Consensus_Harness as it exists: a candidate that never reaches `$finish` is stopped by
//   nothing inside the harness. The fixture below (`HANGING_CANDIDATE`) is exactly the shape such
//   a watchdog would need to catch - a zero-delay `forever` block that monopolizes the simulator's
//   single-threaded event loop and advances no simulated time at all - rendered inside the REAL
//   `renderConsensusHarness` output, so the claim "nothing in this harness stops it" is checked
//   against the actual rendered text, not asserted from reading the renderer's source. The ONLY
//   thing that stops it is the sandbox's own wall-clock cap, which is the real wall-clock-kill
//   path this task also names - so the two paths collapse into one measured fixture, and this
//   file documents that collapse rather than silently covering only one of the two named paths.
//   (Checked against `chipAgent/MANIFEST.md` first: no existing note records this gap, so once
//   this task lands it is captured as a new `candidate` vault note.)
//
// TWO MECHANISMS REACHING THE SAME ANSWER
//
//   Each fixture is asserted twice: once against the sandbox's own classification
//   (`verdict.failureCause`, read from `timedOut` / `diskLimitExceeded` / `stdoutTruncated`,
//   never from stream content), and once against `reduceSignature` fed the SAME run's real
//   stdout directly. The reducer never sees `timedOut`/`diskLimitExceeded`/`stdoutTruncated`; it
//   returns `null` purely because no well-formed `ECE_SAMPLE_END` line exists in what it was
//   given. Two independent routes to the same "no signature" answer is the claim under test, not
//   assumed from one or the other.
//
// THE RunCell SHAPE IS BUILT THE SAME WAY `run-matrix-executor.ts`'s OWN `runCell` BUILDS IT
//
//   `signature: verdict.verdict === 'error' ? null : reduceSignature(...)`, then
//   `passed: signature === null ? null : verdict.verdict === 'pass'`. One fixture (the disk-cap
//   path, the fastest to run) is ALSO driven through the real, exported `executeRunMatrix` to
//   confirm the production code path produces the identically-shaped cell, rather than trusting
//   only a re-derivation of its formula.
//
// WHY NO FIXTURE HERE NEEDS TO CLEAR `artifacts`
//
//   A vault note (`gotcha-a-nonzero-exit-code-with-a-vcd-still-present-never-reaches-error...md`)
//   warns that a SCRIPTED build-failure `RawRunCapture` must clear `artifacts`, or a VCD left in
//   place keeps `completed: true` and the run classifies `fail` rather than `error`. Consulted
//   and checked for applicability: none of the three fixtures below are scripted RawRunCaptures,
//   and none is build-failure shaped. All three run through the real toolchain and reach `error`
//   via `timedOut`, `diskLimitExceeded`, or `stdoutTruncated` - three precedence rules in
//   `classifyVerdict` (`@app/core`) that are checked and win BEFORE the `completed`/missing-output
//   check the vault note is about, so VCD presence or absence has no bearing on any of them.
//
// THE DOWNSTREAM CONSEQUENCE: A FAILING PAIR PUSHES THE Fault_Attributor TOWARD ABSTAIN
//
//   `trustVote` and `peersOf` read only `passed`, never `failureCause`, so the same demonstration
//   applies uniformly to all three kill paths; it is shown once, using the real disk-cap cell
//   (the fastest of the three to produce), spliced into an otherwise-synthetic 4x4 Run_Matrix.
//   One pre-existing ordinary functional fail plus this one real killed cell is engineered to
//   flip `attributeFault` from a decisive `RTL` verdict to `ABSTAIN` for a third pair that shares
//   the killed cell's row, and to lower a peer share for a fourth pair that shares its column -
//   the "fail toward less trust" direction a cell-shape assertion alone would not see.

import { describe, expect, it } from 'vitest';

import { makeTimingContract, type ModuleInterface } from '@app/core';
import type { SourceFile } from '@app/tools';

import { attributeFault, PEER_FLOOR } from '../agent/consensus/fault-attributor.js';
import type { RunCell, RunMatrix } from '../agent/consensus/run-matrix.js';
import { peersOf } from '../agent/consensus/run-matrix.js';
import {
  executeRunMatrix,
  RUN_CELL_RESOURCE_LIMITS,
  type RunMatrixDesign,
  type RunMatrixTestbench,
} from '../agent/consensus/run-matrix-executor.js';
import { reduceSignature } from '../agent/consensus/signature.js';
import { trustVote } from '../agent/consensus/trust-vote.js';
import {
  renderConsensusHarness,
  type ConsensusHarnessRequest,
} from '../tools/simulator/consensus-harness.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[consensus-run-failure.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'Every kill-path classification below is UNVALIDATED against real iverilog in this environment.',
  );
}

/** Vitest timeout covering the real 30,000 ms wall-clock-kill fixture plus overhead. */
const WALL_CLOCK_TIMEOUT = 45_000;
/** Vitest timeout for the fast fixtures (disk-cap, truncation): both resolve in a few seconds. */
const FAST_TIMEOUT = 30_000;
/** Vitest timeout for the disk-cap fixture, which runs the real adapter twice plus executeRunMatrix. */
const DISK_CAP_TIMEOUT = 60_000;

// -- Fixture 1: wall-clock kill, substituting for the undocumented simulated-time watchdog ------

/** A candidate whose zero-delay `forever` block never yields, so no watchdog could ever reach it. */
const HANGING_CANDIDATE_RTL: SourceFile = {
  path: 'hanging_candidate.v',
  contents: `module hanging_candidate (input wire a, output wire y);
  assign y = a;
  initial begin
    forever begin
    end
  end
endmodule
`,
};

const HANGING_CANDIDATE_INTERFACE: ModuleInterface = {
  moduleName: 'hanging_candidate',
  ports: [
    { name: 'a', direction: 'input', width: 1 },
    { name: 'y', direction: 'output', width: 1 },
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

/** A trivial pass-through Reference_Model; never reached, since the candidate never yields. */
const TRIVIAL_REFERENCE_MODEL: SourceFile = {
  path: 'refmodel.v',
  contents: [
    'function automatic [127:0] ece_reset_state(input dummy);',
    "  ece_reset_state = 128'd0;",
    'endfunction',
    'function automatic [127:0] ece_next_state(input [127:0] s, input [0:0] in);',
    '  ece_next_state = s;',
    'endfunction',
    'function automatic [0:0] ece_expect(input [127:0] s, input [0:0] in);',
    "  ece_expect = 1'b0;",
    'endfunction',
    '',
  ].join('\n'),
};

function renderHangingHarness(nonce: string): SourceFile {
  const timingBuilt = makeTimingContract(HANGING_CANDIDATE_INTERFACE, [
    { portName: 'y', timing: 'combinational' },
  ]);
  if (!timingBuilt.ok) {
    throw new Error(`fixture defect: ${timingBuilt.error.code}`);
  }
  const request: ConsensusHarnessRequest = {
    moduleInterface: HANGING_CANDIDATE_INTERFACE,
    timingContract: timingBuilt.value,
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget: 8,
    roles: [{ portName: 'a', role: 'data' }],
  };
  const rendered = renderConsensusHarness(request);
  if (!rendered.ok) {
    throw new Error(`fixture defect: ${rendered.error.code}`);
  }
  return rendered.value;
}

// -- Fixture 2: disk-cap kill at diskMb 128 ------------------------------------------------------
//
// A custom harness (not the production Consensus_Harness renderer): a 64-Kibit register
// toggling every tick of a free-running internal clock, dumped in full with no per-step
// `$display`. Rendering this candidate through the real Consensus_Harness instead would hit the
// worker's 1 MiB STDOUT cap before the 128 MiB DISK cap (measured while building this fixture:
// one `ECE_SAMPLE` line per step floods stdout faster than the waveform fills disk at this
// width), which would exercise fixture 3's path instead of this one. A direct custom harness
// isolates the disk-cap mechanism cleanly.

const DISK_CAP_CANDIDATE_RTL: SourceFile = {
  path: 'churner.v',
  contents: `module churner (output wire y);
  reg clk_int = 1'b0;
  reg [65535:0] churn = 0;
  always #1 clk_int = ~clk_int;
  always @(posedge clk_int) churn <= ~churn;
  assign y = churn[0];
endmodule
`,
};

const DISK_CAP_INTERFACE: ModuleInterface = {
  moduleName: 'churner',
  ports: [{ name: 'y', direction: 'output', width: 1 }],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

const DISK_CAP_HARNESS: SourceFile = {
  path: 'disk_cap_harness.v',
  contents: `module ece_disk_cap_harness;
  wire y;
  churner ece_candidate(.y(y));
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, ece_disk_cap_harness);
    #100000000;
    $finish;
  end
endmodule
`,
};

// -- Fixture 3: stdout truncation past the worker's 1,048,576-byte cap --------------------------
//
// A real `ECE_SAMPLE`/`ECE_SAMPLE_END` pair under a real nonce, preceded by enough filler
// `$display` output that the end marker falls in the bytes the worker discards. The nonce-correct
// sample line at step 0 is retained (proving the retained prefix really did carry a legitimate
// sample), but the end marker is not, which is the exact shape Req 7.7 names: the run completed
// from the toolchain's own perspective (no timeout, no disk kill) but the EVIDENCE is incomplete.

const TRUNCATION_NONCE = 'truncNonce1';
const TRUNCATION_FILLER_LINES = 20_000;

const TRUNCATION_CANDIDATE_RTL: SourceFile = {
  path: 'empty_dut.v',
  contents: 'module empty_dut; endmodule\n',
};

const TRUNCATION_INTERFACE: ModuleInterface = {
  moduleName: 'empty_dut',
  ports: [{ name: 'y', direction: 'output', width: 1 }],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

const TRUNCATION_HARNESS: SourceFile = {
  path: 'trunc_harness.v',
  contents: `module ece_trunc_harness;
  integer i;
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, ece_trunc_harness);
    $display("ECE_SAMPLE ${TRUNCATION_NONCE} 0 0");
    for (i = 0; i < ${TRUNCATION_FILLER_LINES}; i = i + 1) begin
      $display("FILLER_PADDING_LINE_%0d_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmno", i);
    end
    $display("ECE_SAMPLE_END ${TRUNCATION_NONCE} 1");
    $finish;
  end
endmodule
`,
};

// -- Shared helper: the RunCell shape `run-matrix-executor.ts`'s own `runCell` produces ----------

/** Rebuild the RunCell `run-matrix-executor.ts`'s `runCell` would produce for one real verdict. */
function cellFromVerdict(
  designId: string,
  testbenchId: string,
  nonce: string,
  moduleInterface: ModuleInterface,
  verdict: {
    verdict: 'pass' | 'fail' | 'error';
    stdout: string;
    failureCause: RunCell['failureCause'];
  },
): RunCell {
  const signature =
    verdict.verdict === 'error' ? null : reduceSignature(verdict.stdout, nonce, moduleInterface);
  return {
    designId,
    testbenchId,
    passed: signature === null ? null : verdict.verdict === 'pass',
    signature,
    failureCause: verdict.failureCause,
  };
}

describe('consensus run-failure capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'every kill path yields a non-passing cell and no signature (Req 7.7, 9.6, 14.2)',
  () => {
    it(
      'wall-clock kill at the 30,000 ms ceiling - also the ONLY mechanism that stops a hang the ' +
        'declared-but-unconsumed ECE_WATCHDOG_BUDGET_NS cannot (the simulated-time watchdog gap)',
      async () => {
        const nonce = 'hangNonce1';
        const harness = renderHangingHarness(nonce);
        // The one statement the gap claims from the TEXT: nothing in the rendered harness reads
        // `ECE_WATCHDOG_BUDGET_NS` in a delay, a wait, or any other consuming context - it is
        // declared and never used, so no simulated-time mechanism could have stopped this run.
        const consumingUses = harness.contents
          .split('\n')
          .filter(
            (line) => line.includes('ECE_WATCHDOG_BUDGET_NS') && !line.includes('localparam'),
          );
        expect(consumingUses).toEqual([]);

        const startedAt = Date.now();
        const verdict = await realOracleAdapter().simulate(
          [HANGING_CANDIDATE_RTL, TRIVIAL_REFERENCE_MODEL],
          harness,
          RUN_CELL_RESOURCE_LIMITS,
        );
        const elapsedMs = Date.now() - startedAt;

        // Mechanism 1: the sandbox's own wall-clock cap, not the harness, stopped this run - and
        // it took the whole real cap to do it, which is itself evidence nothing stopped it sooner.
        expect(elapsedMs).toBeGreaterThanOrEqual(RUN_CELL_RESOURCE_LIMITS.wallMs - 500);
        expect(verdict.verdict).toBe('error');
        expect(verdict.failureCause).toBe('timed-out');
        // A wall-clock kill reports no streams at all (the real-mechanism contrast with the
        // disk-cap and truncation fixtures below, which DO retain a partial stream).
        expect(verdict.stdout).toBe('');

        // Mechanism 2: fed this run's own (empty) stdout, the reducer independently returns null
        // because no `ECE_SAMPLE_END` line exists in it - it never consults timedOut at all.
        expect(reduceSignature(verdict.stdout, nonce, HANGING_CANDIDATE_INTERFACE)).toBeNull();

        const cell = cellFromVerdict(
          'design-hang',
          'testbench-hang',
          nonce,
          HANGING_CANDIDATE_INTERFACE,
          verdict,
        );
        expect(cell.passed).not.toBe(true);
        expect(cell.signature).toBeNull();
        expect(cell.failureCause).toBe('timed-out');
      },
      WALL_CLOCK_TIMEOUT,
    );

    it(
      'disk-cap kill at diskMb 128 - and the real executeRunMatrix production path confirms the ' +
        'same cell shape, with the downstream Fault_Attributor consequence of one failing pair',
      async () => {
        const startedAt = Date.now();
        const verdict = await realOracleAdapter().simulate(
          [DISK_CAP_CANDIDATE_RTL],
          DISK_CAP_HARNESS,
          RUN_CELL_RESOURCE_LIMITS,
        );
        const elapsedMs = Date.now() - startedAt;

        // Really was killed mid-flight, well inside the wall-clock cap, so this is a disk-cap
        // kill and not a slow wall-clock one wearing the same clothes.
        expect(elapsedMs).toBeLessThan(RUN_CELL_RESOURCE_LIMITS.wallMs / 2);
        expect(verdict.verdict).toBe('error');
        expect(verdict.failureCause).toBe('disk-capped');

        // Mechanism 2: the reducer independently returns null - this harness never printed any
        // ECE_SAMPLE line at all, so there is no end marker for it to find regardless of cause.
        expect(reduceSignature(verdict.stdout, 'unused-nonce', DISK_CAP_INTERFACE)).toBeNull();

        const designOne: RunMatrixDesign = {
          designId: 'disk-design',
          rtl: [DISK_CAP_CANDIDATE_RTL],
        };
        const testbenchOne: RunMatrixTestbench = {
          testbenchId: 'disk-testbench',
          referenceModel: { path: 'unused-ref.v', contents: '' },
          harness: DISK_CAP_HARNESS,
          nonce: 'unused-nonce',
          moduleInterface: DISK_CAP_INTERFACE,
        };
        const matrix = await executeRunMatrix({
          designs: [designOne],
          testbenches: [testbenchOne],
          simulator: realOracleAdapter(),
        });
        const producedCell = matrix.cells[0];
        expect(producedCell).toMatchObject({
          passed: null,
          signature: null,
          failureCause: 'disk-capped',
        });

        // -- Downstream consequence: the Trust_Vote count and the Fault_Attributor's drift toward
        //    ABSTAIN, demonstrated with this one real killed cell spliced into an otherwise-
        //    synthetic 4x4 Run_Matrix (4 designs clear the Peer_Floor of 3 on each side).
        //
        //    Subject pair: (D1, T0). Baseline (D0 vs T0 synthetically PASSES): D1 fails T0, and
        //    among D1's other peers against T0 (D0, D2, D3) two pass and one (D3) fails, giving
        //    peerPassShare = 2/3 (> 0.5); D1 itself fails two of its three OTHER testbenches
        //    (T1, T2), giving peerTestbenchShare = 1/3 (< 0.5). Both RTL conditions hold:
        //    attributeFault(D1, T0) = 'RTL'.
        //
        //    Swap in the real killed cell at (D0, T0): peerPassShare for (D1, T0) drops to 1/3
        //    (< 0.5), which fails RTL's first condition and TESTBENCH's second, so the SAME pair
        //    flips to 'ABSTAIN' - the fail-toward-less-trust direction a cell-shape check alone
        //    would never show. The real killed cell ALSO sits in column T0's own PASS count for
        //    the Trust_Vote, and in design D0's peer-testbench set for pair (D0, T1).
        const killedCell: RunCell = producedCell as RunCell;
        const passCell = (designId: string, testbenchId: string): RunCell => ({
          designId,
          testbenchId,
          passed: true,
          signature: null,
          failureCause: 'none',
        });
        const failCell = (designId: string, testbenchId: string): RunCell => ({
          designId,
          testbenchId,
          passed: false,
          signature: null,
          failureCause: 'none',
        });
        const designIds = ['D0', 'D1', 'D2', 'D3'];
        const testbenchIds = ['T0', 'T1', 'T2', 'T3'];

        function cellsWith(d0t0: RunCell): readonly RunCell[] {
          return [
            { ...d0t0, designId: 'D0', testbenchId: 'T0' },
            passCell('D0', 'T1'),
            passCell('D0', 'T2'),
            passCell('D0', 'T3'),
            failCell('D1', 'T0'), // the subject pair under attribution
            failCell('D1', 'T1'),
            failCell('D1', 'T2'),
            passCell('D1', 'T3'),
            passCell('D2', 'T0'),
            passCell('D2', 'T1'),
            passCell('D2', 'T2'),
            passCell('D2', 'T3'),
            failCell('D3', 'T0'),
            passCell('D3', 'T1'),
            passCell('D3', 'T2'),
            passCell('D3', 'T3'),
          ];
        }

        const baselineMatrix: RunMatrix = {
          designIds,
          testbenchIds,
          cells: cellsWith(passCell('D0', 'T0')),
        };
        const withKillMatrix: RunMatrix = {
          designIds,
          testbenchIds,
          cells: cellsWith(killedCell),
        };

        // Trust_Vote count for T0 is LOWERED by the one killed cell: 2 passing designs -> 1.
        const baselineTrust = trustVote(baselineMatrix, new Map());
        const withKillTrust = trustVote(withKillMatrix, new Map());
        const t0Baseline = baselineTrust.find((t) => t.testbenchId === 'T0');
        const t0WithKill = withKillTrust.find((t) => t.testbenchId === 'T0');
        expect(t0Baseline?.passingDesignCount).toBe(2);
        expect(t0WithKill?.passingDesignCount).toBe(1);

        // The subject pair (D1, T0): peerPassShare drops below half, flipping RTL to ABSTAIN.
        const baselinePeers = peersOf(baselineMatrix, 'D1', 'T0');
        const withKillPeers = peersOf(withKillMatrix, 'D1', 'T0');
        expect(baselinePeers.peerDesignCount).toBeGreaterThanOrEqual(PEER_FLOOR);
        expect(baselinePeers.peerPassCount / baselinePeers.peerDesignCount).toBeCloseTo(2 / 3);
        expect(withKillPeers.peerPassCount / withKillPeers.peerDesignCount).toBeCloseTo(1 / 3);
        expect(attributeFault(baselinePeers)).toBe('RTL');
        expect(attributeFault(withKillPeers)).toBe('ABSTAIN');

        // A second pair sharing the killed cell's COLUMN (D0, T1): its peerTestbenchShare (over
        // T0, T2, T3) is also lowered by the one killed cell - "both sides" of the row/column.
        const baselineColumnPeers = peersOf(baselineMatrix, 'D0', 'T1');
        const withKillColumnPeers = peersOf(withKillMatrix, 'D0', 'T1');
        expect(
          baselineColumnPeers.peerTestbenchPassCount / baselineColumnPeers.peerTestbenchCount,
        ).toBe(1);
        expect(
          withKillColumnPeers.peerTestbenchPassCount / withKillColumnPeers.peerTestbenchCount,
        ).toBeCloseTo(2 / 3);
      },
      DISK_CAP_TIMEOUT,
    );

    it(
      'stdout truncation past the 1,048,576-byte stdout cap: the end marker sits in the discarded ' +
        'bytes, and both mechanisms (sandbox classification, reducer) independently say so',
      async () => {
        const verdict = await realOracleAdapter().simulate(
          [TRUNCATION_CANDIDATE_RTL],
          TRUNCATION_HARNESS,
          RUN_CELL_RESOURCE_LIMITS,
        );

        // Mechanism 1: the sandbox already classifies this run error BEFORE any reducer runs -
        // this is a run that finished cleanly from the toolchain's perspective (no timeout, no
        // disk kill), so the ONLY reason it is `error` is the bounded-prefix capture.
        expect(verdict.verdict).toBe('error');
        expect(verdict.failureCause).toBe('output-incomplete');
        expect(Buffer.byteLength(verdict.stdout, 'utf8')).toBe(1_048_576);
        // The retained prefix really did carry a legitimate sample at step 0...
        expect(verdict.stdout).toContain(`ECE_SAMPLE ${TRUNCATION_NONCE} 0 0`);
        // ...but the end marker that would have closed it out was never retained.
        expect(verdict.stdout).not.toContain('ECE_SAMPLE_END');

        // Mechanism 2: reduceSignature, given the SAME real stdout, independently returns null -
        // it never reads timedOut/diskLimitExceeded/stdoutTruncated at all, only the text itself.
        const signature = reduceSignature(verdict.stdout, TRUNCATION_NONCE, TRUNCATION_INTERFACE);
        expect(signature).toBeNull();

        const cell = cellFromVerdict(
          'design-trunc',
          'testbench-trunc',
          TRUNCATION_NONCE,
          TRUNCATION_INTERFACE,
          verdict,
        );
        expect(cell.passed).not.toBe(true);
        expect(cell.signature).toBeNull();
        expect(cell.failureCause).toBe('output-incomplete');
      },
      FAST_TIMEOUT,
    );
  },
);
