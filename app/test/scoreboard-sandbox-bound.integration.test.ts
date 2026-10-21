// The worst-case Scoreboard_Testbench run inside the real sandbox (task 11.3, Req 3.18).
//
// 512 transactions on the no-Input_Qualifier path, each held for just under DRAIN_BOUND by a
// reference that answers once every DRAIN_BOUND - 1 cycles: the longest run the static bounds
// allow without tripping the liveness check. It must finish under the Campaign's 30000 ms wall.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleScoreboardTestbench,
  DRAIN_BOUND,
  MAX_STIMULUS_CALLS,
  normalizeDialect,
  parseFragmentReply,
  renderScoreboardScaffold,
  requiredChecks,
} from '@app/agent';
import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  RTLLM_CHECKOUT_PATH,
  scoredRtllmCorpus,
} from '@app/eval';
import {
  DUMP_LIMIT_BYTES,
  LocalWorkerRuntime,
  SandboxToolRunner,
  assembleSimulateJob,
  interpretSandboxResult,
  renderSimulationHarness,
  type ResourceLimits,
  type SandboxJob,
  type SimulationVerdict,
} from '@app/tools';
import { describe, expect, it } from 'vitest';

import { CORPUS_TIMING_STAND_IN, PROBE } from './real-oracle-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  'fixtures',
  'scoreboard',
  'faulty',
  'parallel2serial.worst-case.fragments.json',
);
/** The Campaign config's `limits`. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

const CORPUS_PRESENT =
  (await new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH).listDirectories([])).length > 0;
const RUNNABLE = PROBE.available && CORPUS_PRESENT;
if (!RUNNABLE) {
  console.warn('[scoreboard-sandbox-bound] NOT exercised: no toolchain or no pinned corpus here.');
}

/** Answers once every DRAIN_BOUND - 1 cycles, with the live MSB of `d`. */
const SLOWEST_LIVE_REFERENCE = `module parallel2serial(input clk, input rst_n, input [3:0] d,
  output reg valid_out, output dout);
  reg [10:0] cnt;
  assign dout = d[3];
  always @(posedge clk or negedge rst_n)
    if (!rst_n) begin cnt <= 0; valid_out <= 0; end
    else if (cnt == ${String(DRAIN_BOUND - 2)}) begin cnt <= 0; valid_out <= 1; end
    else begin cnt <= cnt + 1; valid_out <= 0; end
endmodule
`;

/**
 * Simulate one testbench with the harness rendered at the measurement ceiling.
 *
 * The adapter only ever compiles the COMMITTED harness, so the job is assembled and its
 * harness file substituted - the same thing the Replay_Gate's `--select` pass does, and for
 * the same reason: a measurement must not be bounded by the value it is measuring against.
 */
async function simulateAtCeiling(testbench: string): Promise<SimulationVerdict> {
  const run = { requiredCheckNames: [] };
  const assembled = assembleSimulateJob(
    [{ path: 'parallel2serial.v', contents: SLOWEST_LIVE_REFERENCE }],
    { path: 'parallel2serial_tb.v', contents: testbench },
    LIMITS,
    run,
  );
  const harness = renderSimulationHarness(MEASUREMENT_CEILING_NS, DUMP_LIMIT_BYTES);
  const job: SandboxJob = {
    ...assembled,
    workspaceFiles: assembled.workspaceFiles.map((file) =>
      file.path === harness.path ? harness : file,
    ),
  };
  const result = await new SandboxToolRunner(new LocalWorkerRuntime(PROBE.pythonBin)).run(job);
  return interpretSandboxResult(
    result,
    job.workspaceFiles.map((file) => file.path),
    run,
  );
}

/** 1000 s simulated: far above anything this scaffold can need, so only the wall clock binds. */
const MEASUREMENT_CEILING_NS = 1_000_000_000_000;

/** The worst-case testbench: the parallel2serial scaffold filled with 512 sends. */
async function worstCaseTestbench(): Promise<string> {
  const corpus = scoredRtllmCorpus(
    await importRtllmCorpus(
      new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
      CORPUS_TIMING_STAND_IN,
    ),
  );
  const problem = corpus.problems.find((p) => p.id === 'rtllm/miscellaneous/parallel2serial');
  if (problem === undefined) {
    throw new Error('parallel2serial is not in the scored corpus');
  }
  const scaffold = renderScoreboardScaffold(
    problem.spec.moduleInterface,
    requiredChecks(problem.spec).map((check) => check.name),
  );
  if (!scaffold.ok) {
    throw new Error(scaffold.error.reason);
  }
  const fragments = parseFragmentReply(await readFile(FIXTURE, 'utf8'), scaffold.value);
  if (!fragments.ok) {
    throw new Error(JSON.stringify(fragments.error));
  }
  return normalizeDialect(assembleScoreboardTestbench(scaffold.value, fragments.value)).source;
}

describe.skipIf(!RUNNABLE)('11.3 the worst-case scaffold simulation in the real sandbox', () => {
  it('runs 512 held transactions to completion under the 30000 ms wall', async () => {
    const testbench = await worstCaseTestbench();
    const startedAt = Date.now();
    // A Testbench_Run, as the loop runs it: the normalizer removed the scaffold's own dump
    // calls, so the Simulation_Harness supplies dump.vcd (testbench-spec-grounding, C9).
    //
    // UNDER A NON-INTERFERING WATCHDOG_BUDGET, and that is the whole point of this override.
    // The committed `WATCHDOG_BUDGET_NS` is 2 ms, measured by the Replay_Gate over the 489
    // recorded CYCLE_TIMED control testbenches - a population that holds no scoreboard
    // testbench at all. This scaffold's 512 held transactions need more simulated time than
    // that, so the committed budget stops it before it prints a single CHECK line. The claim
    // under test is about the SCAFFOLD's wall-clock cost, so the budget is raised out of the
    // way rather than the claim weakened. See the vault note on the budget's population.
    const verdict = await simulateAtCeiling(testbench);
    const elapsedMs = Date.now() - startedAt;
    console.info(
      `[scoreboard-sandbox-bound] ${String(MAX_STIMULUS_CALLS)} held transactions: ` +
        `${String(elapsedMs)} ms end to end, ${String(verdict.resourceUsage.wallMs)} ms in the sandbox`,
    );
    expect(verdict.failureCause).toBe('none');
    // Not Watchdog-stopped at the ceiling, which is what makes the wall-clock figure above a
    // measurement of the scaffold rather than of the budget.
    expect(verdict.watchdog).toEqual({ stopped: false });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.stdout).not.toContain('FAIL');
    expect(verdict.resourceUsage.wallMs).toBeLessThan(LIMITS.wallMs);
  }, 120_000);
});
