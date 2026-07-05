// Unit tests for the Simulator adapter (task 3.5).
//
// Three concerns, all exercised without a real iverilog/vvp (the real-oracle path
// is task 3.8): (1) job assembly - the RTL and testbench become workspace files
// with the correct kind, required outputs, and limits; (2) per-check stdout
// parsing - `CHECK <name> PASS|FAIL` lines become `CheckResult[]`, with malformed
// or absent signalling yielding no checks; (3) verdict interpretation - all-pass
// is `pass`, any-fail is `fail`, a missing VCD or a timeout/infra failure is
// `error`, and a completed run that verified nothing is `error`. The end-to-end
// cases drive the adapter through a real `SandboxToolRunner` backed by the
// `FakeSandboxRuntime`, so the injected-runner seam is exercised too.

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
  parseCheckResults,
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
    exitCode: 0,
    stdout: '',
    stderr: '',
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

describe('parseCheckResults (per-check stdout signalling)', () => {
  it('parses each CHECK line into a named result in emission order', () => {
    const stdout = 'CHECK reset_clears_output PASS\nCHECK counts_up FAIL\n';
    expect(parseCheckResults(stdout)).toEqual([
      { name: 'reset_clears_output', passed: true },
      { name: 'counts_up', passed: false },
    ]);
  });

  it('ignores non-signal diagnostic lines around the CHECK lines', () => {
    const stdout =
      'VCD info: dumpfile dump.vcd opened\nCHECK counts_up PASS\nsimulation finished\n';
    expect(parseCheckResults(stdout)).toEqual([{ name: 'counts_up', passed: true }]);
  });

  it('tolerates surrounding whitespace and tab separators', () => {
    const stdout = '   CHECK\treset_clears_output\tFAIL   ';
    expect(parseCheckResults(stdout)).toEqual([{ name: 'reset_clears_output', passed: false }]);
  });

  it('rejects malformed CHECK lines (missing or non-PASS/FAIL status)', () => {
    const stdout = 'CHECK counts_up\nCHECK counts_up MAYBE\nCHECK\ncheck counts_up pass';
    expect(parseCheckResults(stdout)).toEqual([]);
  });

  it('returns no checks for output that contains no signalling at all', () => {
    expect(parseCheckResults('nothing machine-readable here')).toEqual([]);
  });

  it('preserves a duplicated check name so a later FAIL still fails pass integrity', () => {
    const stdout = 'CHECK edge PASS\nCHECK edge FAIL';
    expect(parseCheckResults(stdout)).toEqual([
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
});
