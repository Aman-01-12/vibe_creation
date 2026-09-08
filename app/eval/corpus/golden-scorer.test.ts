// Unit tests for the golden-testbench scorer, driven through a FAKE ToolRunner.
//
// These pin down the two decisions that make the scorer a usable independent judge:
//
//   1. The job it assembles. The golden testbenches never call `$dumpfile`, so
//      requiring a `vcd` output - as the loop's own Simulator adapter does - would
//      classify EVERY golden run as an error. The testbench must also arrive
//      byte-identical, with its data files alongside it.
//   2. The verdict it derives. It comes only from what the testbench PRINTED. Exit
//      codes are not read as verdicts, and a run that printed nothing is `error`,
//      never a pass.

import { describe, expect, it } from 'vitest';

import type { ResourceLimits, SandboxJob, SandboxResult, ToolRunner } from '@app/tools';

import type { GoldenTestbench } from './corpus-types.js';
import {
  assembleGoldenJob,
  CANDIDATE_WORKSPACE_FILENAME,
  SandboxGoldenTestbenchScorer,
} from './golden-scorer.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

/** Upstream testbench text, used verbatim so byte-identity can be asserted. */
const UPSTREAM_TESTBENCH = `\`timescale 1ns / 1ps
module testbench;
  adder_8bit uut (.a(a), .b(b), .sum(sum));
  initial $display("===========Your Design Passed===========");
endmodule
`;

const GOLDEN: GoldenTestbench = {
  problemId: 'rtllm/arithmetic/adder_8bit',
  moduleName: 'adder_8bit',
  testbench: { path: 'testbench.v', contents: UPSTREAM_TESTBENCH },
  dataFiles: [{ path: 'reference.dat', contents: '00\n01\n' }],
  overriddenParameters: [],
};

const CANDIDATE = {
  path: CANDIDATE_WORKSPACE_FILENAME,
  contents: 'module adder_8bit();\nendmodule\n',
};

/** A ToolRunner returning a scripted result and recording the job it received. */
class FakeToolRunner implements ToolRunner {
  readonly jobs: SandboxJob[] = [];
  readonly #result: SandboxResult;

  constructor(result: Partial<SandboxResult> = {}) {
    this.#result = {
      verdict: 'pass',
      timedOut: false,
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      diskLimitExceeded: false,
      artifacts: {},
      deniedOperations: [],
      resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
      ...result,
    };
  }

  run(job: SandboxJob): Promise<SandboxResult> {
    this.jobs.push(job);
    return Promise.resolve(this.#result);
  }
}

describe('assembleGoldenJob', () => {
  it('requires stdout and exitCode but NOT a vcd waveform', () => {
    // The golden testbenches write no waveform; requiring one would error every run.
    const job = assembleGoldenJob(CANDIDATE, GOLDEN, LIMITS);
    expect([...job.requiredOutputs].sort()).toEqual(['exitCode', 'stdout']);
    expect(job.requiredOutputs).not.toContain('vcd');
  });

  it('materializes the candidate, the unmodified testbench, and the data files', () => {
    const job = assembleGoldenJob(CANDIDATE, GOLDEN, LIMITS);
    expect(job.workspaceFiles.map((file) => file.path)).toEqual([
      CANDIDATE_WORKSPACE_FILENAME,
      'testbench.v',
      'reference.dat',
    ]);
    const testbenchFile = job.workspaceFiles.find((file) => file.path === 'testbench.v');
    expect(testbenchFile?.contents).toBe(UPSTREAM_TESTBENCH);
  });

  it("threads the caller's resource limits through unchanged", () => {
    expect(assembleGoldenJob(CANDIDATE, GOLDEN, LIMITS).limits).toEqual(LIMITS);
  });
});

describe('SandboxGoldenTestbenchScorer.score - verdicts come from the banner', () => {
  it('passes a candidate whose golden run printed the pass banner', async () => {
    const runner = new FakeToolRunner({
      stdout: '===========Your Design Passed===========\n',
    });
    const score = await new SandboxGoldenTestbenchScorer(runner).score(CANDIDATE, GOLDEN, LIMITS);

    expect(score.verdict.kind).toBe('passed');
    expect(score.problemId).toBe(GOLDEN.problemId);
  });

  it('fails a candidate whose golden run reported failures, with the count', async () => {
    const runner = new FakeToolRunner({
      stdout: '=========== Test completed with 7 /100 failures ===========\n',
    });
    const score = await new SandboxGoldenTestbenchScorer(runner).score(CANDIDATE, GOLDEN, LIMITS);

    expect(score.verdict.kind).toBe('failed');
    expect(score.verdict.failureCount).toBe(7);
  });

  it('errors a candidate that printed no banner, even on a zero exit code', async () => {
    // A zero exit is not evidence of a pass; several golden testbenches never $finish.
    const runner = new FakeToolRunner({ verdict: 'pass', exitCode: 0, stdout: 'no banner here\n' });
    const score = await new SandboxGoldenTestbenchScorer(runner).score(CANDIDATE, GOLDEN, LIMITS);

    expect(score.verdict.kind).toBe('error');
  });

  it('passes a candidate that printed the banner despite a non-zero exit code', async () => {
    // Conversely, a non-zero exit is not evidence of failure; the banner is the signal.
    const runner = new FakeToolRunner({
      verdict: 'fail',
      exitCode: 1,
      stdout: '===========Your Design Passed===========\n',
    });
    const score = await new SandboxGoldenTestbenchScorer(runner).score(CANDIDATE, GOLDEN, LIMITS);

    expect(score.verdict.kind).toBe('passed');
  });

  it('errors a run the sandbox already classified error, carrying its diagnostics', async () => {
    const runner = new FakeToolRunner({
      verdict: 'error',
      exitCode: 1,
      stdout: '',
      stderr: 'testbench.v:20: syntax error\n',
    });
    const score = await new SandboxGoldenTestbenchScorer(runner).score(CANDIDATE, GOLDEN, LIMITS);

    expect(score.verdict.kind).toBe('error');
    expect(score.diagnostics).toContain('syntax error');
  });
});

describe('SandboxGoldenTestbenchScorer.score - the TIMEOUT cause is carried, not re-derived', () => {
  it('given a timed-out run, when scored, then the score says so and the verdict is error', async () => {
    // GIVEN the shape the real path produces on a wall-clock kill: no exit code, no streams,
    // nothing to infer from. Mutation calibration needs this distinction, because a golden
    // testbench that HANGS on a mutant is a kill and one that failed to BUILD is not a usable
    // mutant at all.
    const runner = new FakeToolRunner({
      verdict: 'error',
      timedOut: true,
      exitCode: null,
      stdout: '',
      stderr: '',
    });

    const score = await new SandboxGoldenTestbenchScorer(runner).score(CANDIDATE, GOLDEN, LIMITS);

    expect(score.timedOut).toBe(true);
    // The banner still decides the verdict; a timed-out run printed none, so it is already error.
    expect(score.verdict.kind).toBe('error');
  });

  it('given a run that errored WITHOUT a timeout, when scored, then timedOut is false', () => {
    // The non-vacuity of the assertion above: a compile failure is `error` too, and must stay
    // distinguishable from a hang.
    const runner = new FakeToolRunner({
      verdict: 'error',
      timedOut: false,
      exitCode: 1,
      stderr: 'candidate.v:3: error: unknown module type\n',
    });

    return new SandboxGoldenTestbenchScorer(runner)
      .score(CANDIDATE, GOLDEN, LIMITS)
      .then((score) => {
        expect(score.timedOut).toBe(false);
        expect(score.verdict.kind).toBe('error');
      });
  });

  it('given a candidate we refuse to submit, when scored, then it is NOT reported as a timeout', async () => {
    // No run happened, so nothing exceeded a cap. Reporting `true` would claim a measurement that
    // was never made - and would turn a refusal into a golden KILL at the calibration layer.
    const runner = new FakeToolRunner();

    const score = await new SandboxGoldenTestbenchScorer(runner).score(
      { path: CANDIDATE_WORKSPACE_FILENAME, contents: '' },
      GOLDEN,
      LIMITS,
    );

    expect(score.timedOut).toBe(false);
    expect(runner.jobs).toHaveLength(0);
  });
});

describe('SandboxGoldenTestbenchScorer.score - refusing to submit a bad candidate', () => {
  it('errors an empty candidate without invoking the toolchain', async () => {
    const runner = new FakeToolRunner();
    const score = await new SandboxGoldenTestbenchScorer(runner).score(
      { path: CANDIDATE_WORKSPACE_FILENAME, contents: '' },
      GOLDEN,
      LIMITS,
    );

    expect(score.verdict.kind).toBe('error');
    expect(runner.jobs).toHaveLength(0);
  });

  it('errors an over-large candidate without invoking the toolchain', async () => {
    const runner = new FakeToolRunner();
    const score = await new SandboxGoldenTestbenchScorer(runner).score(
      { path: CANDIDATE_WORKSPACE_FILENAME, contents: 'x'.repeat(200_001) },
      GOLDEN,
      LIMITS,
    );

    expect(score.verdict.kind).toBe('error');
    expect(runner.jobs).toHaveLength(0);
  });
});
