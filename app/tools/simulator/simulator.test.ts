// Unit tests for the Simulator adapter (task 3.5).
//
// Three concerns, all exercised without a real iverilog/vvp (the real-oracle path
// is task 3.8): (1) job assembly - the RTL and testbench become workspace files
// with the correct kind, required outputs, and limits; (2) per-check stdout
// reading - `CHECK <name> PASS|FAIL [diagnostic]` lines become `CheckResult[]`,
// while a `CHECK`-like line that yields no (name, status) pair is COUNTED as
// unreadable rather than discarded; (3) verdict interpretation - all-readable and
// all-passing is `pass`, any-fail is `fail`, a missing VCD or a timeout/infra
// failure is `error`, and a completed run that verified nothing (no readable check,
// or a check signal it could not read) is `error`. The end-to-end cases drive the
// adapter through a real `SandboxToolRunner` backed by the `FakeSandboxRuntime`, so
// the injected-runner seam is exercised too.

import { describe, expect, it } from 'vitest';

import {
  FakeSandboxRuntime,
  SandboxToolRunner,
  type RawRunCapture,
  type ResourceUsage,
  type SandboxResult,
  type SourceFile,
} from '../sandbox/index.js';
import {
  IcarusSimulatorAdapter,
  assembleSimulateJob,
  interpretSandboxResult,
  readCheckSignals,
} from './index.js';

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 } as const;

const RESOURCE_USAGE: ResourceUsage = { wallMs: 12, maxMemMb: 8, cpuMs: 10 };

const RTL: readonly SourceFile[] = [{ path: 'counter.v', contents: 'module counter(); endmodule' }];

const TESTBENCH: SourceFile = {
  path: 'counter_tb.v',
  contents: 'module counter_tb(); endmodule',
};

const VCD_ARTIFACT = { name: 'dump.vcd', sizeBytes: 4, sha256: 'a'.repeat(64) } as const;

/** A `SandboxResult` for the adapter's interpretation, defaulting to a clean completed run. */
function sandboxResult(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    verdict: 'pass',
    timedOut: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: VCD_ARTIFACT },
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
    ...overrides,
  };
}

/** A fully captured, successful raw run; override fields to model each scenario. */
function capture(overrides: Partial<RawRunCapture> = {}): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: VCD_ARTIFACT },
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
    ...overrides,
  };
}

/** Drive the adapter end-to-end through a real sandbox runner backed by a scripted fake. */
function simulateWith(
  rawCapture: RawRunCapture,
): Promise<ReturnType<typeof interpretSandboxResult>> {
  const runner = new SandboxToolRunner(new FakeSandboxRuntime(rawCapture));
  return new IcarusSimulatorAdapter(runner).simulate(RTL, TESTBENCH, LIMITS);
}

describe('assembleSimulateJob (job assembly)', () => {
  const job = assembleSimulateJob(RTL, TESTBENCH, LIMITS);

  it('marks the job as a simulate run', () => {
    expect(job.kind).toBe('simulate');
  });

  it('places both the RTL sources and the testbench in the workspace files', () => {
    expect(job.workspaceFiles).toEqual([...RTL, TESTBENCH]);
  });

  it('requires stdout, exitCode, and the VCD waveform as outputs', () => {
    expect(job.requiredOutputs).toContain('stdout');
    expect(job.requiredOutputs).toContain('exitCode');
    expect(job.requiredOutputs).toContain('vcd');
  });

  it('applies the caller-provided resource limits unchanged', () => {
    expect(job.limits).toEqual(LIMITS);
  });
});

describe('readCheckSignals (per-check stdout signalling)', () => {
  it('given two well-formed lines when read then each becomes a named result in order', () => {
    const stdout = 'CHECK reset_clears_output PASS\nCHECK counts_up FAIL\n';
    expect(readCheckSignals(stdout)).toEqual({
      checks: [
        { name: 'reset_clears_output', passed: true },
        { name: 'counts_up', passed: false },
      ],
      unreadableSignals: 0,
    });
  });

  it('given surrounding banner text when read then only the CHECK line is a signal', () => {
    const stdout =
      'VCD info: dumpfile dump.vcd opened\nCHECK counts_up PASS\nsimulation finished\n';
    expect(readCheckSignals(stdout)).toEqual({
      checks: [{ name: 'counts_up', passed: true }],
      unreadableSignals: 0,
    });
  });

  it('given padding and tab separators when read then the signal is still parsed', () => {
    const stdout = '   CHECK\treset_clears_output\tFAIL   ';
    expect(readCheckSignals(stdout)).toEqual({
      checks: [{ name: 'reset_clears_output', passed: false }],
      unreadableSignals: 0,
    });
  });

  it('given a FAIL with a trailing diagnostic when read then the FAIL is parsed', () => {
    // The severity-1 shape: the testbench appended its reason to the status line.
    // The old both-ends-anchored grammar matched nothing here and dropped the FAIL.
    const stdout = 'CHECK shifts_right FAIL at cycle 0: expected 10000000, got 11101011\n';
    expect(readCheckSignals(stdout)).toEqual({
      checks: [{ name: 'shifts_right', passed: false }],
      unreadableSignals: 0,
    });
  });

  it('given a PASS with a trailing diagnostic when read then the PASS is parsed', () => {
    const stdout = 'CHECK shifts_right PASS after 12 cycles\n';
    expect(readCheckSignals(stdout)).toEqual({
      checks: [{ name: 'shifts_right', passed: true }],
      unreadableSignals: 0,
    });
  });

  it('given PASSED or FAILURE as the status when read then neither is accepted', () => {
    // The status must be a COMPLETE word: a longer word that merely starts with
    // PASS or FAIL is not a verdict, so it can never be read as one.
    const stdout = 'CHECK a PASSED\nCHECK b FAILURE\nCHECK c PASSes\nCHECK d FAILed';
    expect(readCheckSignals(stdout)).toEqual({ checks: [], unreadableSignals: 4 });
  });

  it('given a diagnostic attached to the status by a colon when read then the status is read', () => {
    // The shape a real generated testbench writes: `CHECK <name> FAIL: <reason>`.
    // A colon ends the word, so this is a legible FAIL and must be read as one
    // rather than degraded to an unreadable signal.
    expect(readCheckSignals('CHECK a FAIL: Reset state incorrect')).toEqual({
      checks: [{ name: 'a', passed: false }],
      unreadableSignals: 0,
    });
    expect(readCheckSignals('CHECK a PASS.').checks).toEqual([{ name: 'a', passed: true }]);
  });

  it('given a CHECK-like line that does not parse when read then it is COUNTED, not dropped', () => {
    // The root cause of the defect was silent discard. A line that begins with the
    // keyword tried to signal something; not being able to read it is a fact the
    // verdict must see.
    const stdout = 'CHECK counts_up\nCHECK counts_up MAYBE\nCHECK';
    expect(readCheckSignals(stdout)).toEqual({ checks: [], unreadableSignals: 3 });
  });

  it('given a lowercase check line when read then it is banner text, not a broken signal', () => {
    // The keyword is uppercase by convention, so prose is never mistaken for a
    // testbench that tried and failed to signal.
    expect(readCheckSignals('check counts_up pass')).toEqual({
      checks: [],
      unreadableSignals: 0,
    });
  });

  it('given a word merely starting with CHECK when read then it is not a signal at all', () => {
    expect(readCheckSignals('CHECKSUM 5 PASS\nCHECKPOINT reached')).toEqual({
      checks: [],
      unreadableSignals: 0,
    });
  });

  it('given output with no signalling when read then there are no checks and nothing unreadable', () => {
    expect(readCheckSignals('nothing machine-readable here')).toEqual({
      checks: [],
      unreadableSignals: 0,
    });
  });

  it('given a duplicated name reported both ways when read then both occurrences survive', () => {
    const stdout = 'CHECK edge PASS\nCHECK edge FAIL';
    expect(readCheckSignals(stdout).checks).toEqual([
      { name: 'edge', passed: true },
      { name: 'edge', passed: false },
    ]);
  });
});

describe('interpretSandboxResult (verdict interpretation)', () => {
  it('is pass when every spec-derived check passed', () => {
    const result = interpretSandboxResult(
      sandboxResult({ stdout: 'CHECK a PASS\nCHECK b PASS\n' }),
    );
    expect(result.verdict).toBe('pass');
    expect(result.checks).toEqual([
      { name: 'a', passed: true },
      { name: 'b', passed: true },
    ]);
  });

  it('is fail when any spec-derived check failed', () => {
    const result = interpretSandboxResult(
      sandboxResult({ stdout: 'CHECK a PASS\nCHECK b FAIL\n' }),
    );
    expect(result.verdict).toBe('fail');
  });

  it('is error when a completed run produced no parseable check (verified nothing)', () => {
    const result = interpretSandboxResult(sandboxResult({ stdout: 'simulation finished\n' }));
    expect(result.verdict).toBe('error');
    expect(result.checks).toEqual([]);
  });

  it('is fail when the only failing check carries a trailing diagnostic', () => {
    // Before the fix this run read as `pass`: the FAIL line matched no pattern and
    // was dropped, leaving only the passing line behind.
    const result = interpretSandboxResult(
      sandboxResult({
        stdout: 'CHECK a PASS\nCHECK a FAIL at cycle 0: expected 10000000, got 11101011\n',
      }),
    );
    expect(result.verdict).toBe('fail');
  });

  it('is error, never pass, when a completed run emitted an unreadable CHECK line', () => {
    const result = interpretSandboxResult(
      sandboxResult({ stdout: 'CHECK a PASS\nCHECK b MAYBE\n' }),
    );
    // The readable check passed, but something the testbench signalled could not be
    // read, so the run did not establish correctness.
    expect(result.verdict).toBe('error');
    expect(result.checks).toEqual([{ name: 'a', passed: true }]);
  });

  it('is fail when a readable check failed alongside an unreadable one', () => {
    const result = interpretSandboxResult(
      sandboxResult({ stdout: 'CHECK a FAIL\nCHECK b MAYBE\n' }),
    );
    expect(result.verdict).toBe('fail');
  });

  it('propagates a sandbox error verdict without deriving checks', () => {
    const result = interpretSandboxResult(
      sandboxResult({ verdict: 'error', stdout: 'CHECK a PASS\n', artifacts: {} }),
    );
    expect(result.verdict).toBe('error');
    expect(result.checks).toEqual([]);
  });

  it('surfaces the captured VCD waveform reference for a completed run', () => {
    const result = interpretSandboxResult(sandboxResult({ stdout: 'CHECK a PASS\n' }));
    expect(result.vcd).toEqual(VCD_ARTIFACT);
  });

  it('reports a null waveform when the errored run produced none', () => {
    const result = interpretSandboxResult(sandboxResult({ verdict: 'error', artifacts: {} }));
    expect(result.vcd).toBeNull();
  });

  it('is error, never pass, when every retained check passed but stdout was truncated', () => {
    // The Tool_Runner bounds how much output it retains, so a `CHECK ... FAIL`
    // line may be among the discarded bytes and the retained prefix cannot rule it
    // out. This is the same fail-safe as the unreadable-signal rule, one step
    // earlier in the pipeline.
    //
    // The `pass` verdict paired with a truncated stdout is a hand-built input the
    // sandbox would never produce - it refuses such a run first. That is the point:
    // this asserts the READER's own rule, so the layer that depends on stdout keeps
    // its precondition independently of the sandbox's coarse process-exit check.
    const result = interpretSandboxResult(
      sandboxResult({ stdout: 'CHECK a PASS\nCHECK b PASS\n', stdoutTruncated: true }),
    );
    expect(result.verdict).toBe('error');
    // The checks it COULD read are still reported, so diagnostics are not lost.
    expect(result.checks).toEqual([
      { name: 'a', passed: true },
      { name: 'b', passed: true },
    ]);
  });

  it('is fail when a retained check failed even though stdout was truncated', () => {
    // A legible failure outranks the evidence gap; blurring it into `error` would
    // discard the stronger, actionable fact.
    const result = interpretSandboxResult(
      sandboxResult({ stdout: 'CHECK a PASS\nCHECK b FAIL\n', stdoutTruncated: true }),
    );
    expect(result.verdict).toBe('fail');
  });

  it('is unaffected by truncated stderr, which carries no check signalling', () => {
    const result = interpretSandboxResult(
      sandboxResult({ stdout: 'CHECK a PASS\n', stderrTruncated: true }),
    );
    expect(result.verdict).toBe('pass');
  });

  it('is byte-identical to an untruncated run when nothing was dropped', () => {
    const stdout = 'CHECK a PASS\nCHECK b PASS\n';
    const result = interpretSandboxResult(sandboxResult({ stdout }));
    expect(result.verdict).toBe('pass');
    expect(result.stdout).toBe(stdout);
  });
});

describe('IcarusSimulatorAdapter (driven through the injected sandbox runner)', () => {
  it('returns pass and the waveform when all checks pass on a clean run', async () => {
    const verdict = await simulateWith(capture({ stdout: 'CHECK counts_up PASS\n' }));
    expect(verdict.verdict).toBe('pass');
    expect(verdict.vcd).toEqual(VCD_ARTIFACT);
  });

  it('returns fail when a check fails even though the process exited cleanly', async () => {
    const verdict = await simulateWith(capture({ exitCode: 0, stdout: 'CHECK counts_up FAIL\n' }));
    expect(verdict.verdict).toBe('fail');
  });

  it('returns error when the required VCD waveform is missing', async () => {
    const verdict = await simulateWith(
      capture({ stdout: 'CHECK counts_up PASS\n', artifacts: {} }),
    );
    expect(verdict.verdict).toBe('error');
    expect(verdict.vcd).toBeNull();
  });

  it('returns error when the run exceeds its wall-clock limit', async () => {
    const verdict = await simulateWith(
      capture({ timedOut: true, stdout: 'CHECK counts_up PASS\n' }),
    );
    expect(verdict.verdict).toBe('error');
  });

  it('returns error on an infrastructure failure', async () => {
    const verdict = await simulateWith(capture({ infraFailure: true }));
    expect(verdict.verdict).toBe('error');
  });

  it('returns error when a completed run emitted no checks', async () => {
    const verdict = await simulateWith(capture({ stdout: 'no signalling here\n' }));
    expect(verdict.verdict).toBe('error');
  });

  it('returns error end-to-end when the captured stdout was bounded by the output cap', async () => {
    // Driven through the real `SandboxToolRunner`, so the truncation flag is proven
    // to survive the seam's own result validation on the way to the verdict - and
    // the whole layered chain refuses the pass, not just the reader in isolation.
    const verdict = await simulateWith(
      capture({ stdout: 'CHECK counts_up PASS\n', stdoutTruncated: true }),
    );
    expect(verdict.verdict).toBe('error');
  });
});
