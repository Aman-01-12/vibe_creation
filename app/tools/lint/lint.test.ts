// Unit tests for the Lint_Adapter (task 4.4).
//
// Exercised without a real Yosys: (1) job assembly - the RTL becomes workspace files with the
// `lint` kind, the `lintReport` and `exitCode` required outputs, and the caller's limits and
// topModule; (2) result interpretation - the decision table of Requirement 5, read as the pure
// `interpretLintResult`; (3) end-to-end through the injected `ToolRunner` and `ArtifactTextReader`
// - a thrown `SandboxContractError`, a rejected run, and a retention miss (`readText` resolving
// `null`) all degrade to `could-not-run`, and `lint` never throws; (4) `LintResult` carries no
// `verdict`/trust field and is not assignable to or from `Verdict` or `SandboxResult['verdict']`.

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Verdict } from '@app/core';

import {
  FakeSandboxRuntime,
  SandboxContractError,
  SandboxToolRunner,
  type ArtifactBlobRef,
  type ArtifactTextReader,
  type RawRunCapture,
  type ResourceUsage,
  type SandboxResult,
  type SourceFile,
  type ToolRunner,
} from '../sandbox/index.js';
import {
  assembleLintJob,
  interpretLintResult,
  LINT_RESULT_REASONS,
  YosysCheckLintAdapter,
  type LintResult,
} from './index.js';

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 } as const;

const RESOURCE_USAGE: ResourceUsage = { wallMs: 20, maxMemMb: 16, cpuMs: 18 };

const RTL: readonly SourceFile[] = [{ path: 'alu.v', contents: 'module alu(); endmodule' }];

const TOP_MODULE = 'alu';

const LINT_REPORT_ARTIFACT: ArtifactBlobRef = {
  name: 'lint-report.json',
  sizeBytes: 64,
  sha256: 'a'.repeat(64),
};

/** A `SandboxResult` for interpretation, defaulting to a clean run with the report registered. */
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
    artifacts: { lintReport: LINT_REPORT_ARTIFACT },
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
    ...overrides,
  };
}

/** An `ArtifactTextReader` that answers a fixed text for every artifact, or `null`. */
function reader(text: string | null): ArtifactTextReader {
  return { readText: () => Promise.resolve(text) };
}

/** A `ToolRunner` whose `run` resolves to a fixed result. */
function runnerResolvingTo(result: SandboxResult): ToolRunner {
  return { run: () => Promise.resolve(result) };
}

/** A `ToolRunner` whose `run` rejects, modelling an infrastructure failure. */
function runnerRejecting(error: Error): ToolRunner {
  return {
    run: () => Promise.reject(error),
  };
}

/** A `ToolRunner` whose `run` throws synchronously, as `SandboxToolRunner` does on a bad job. */
function runnerThrowing(error: unknown): ToolRunner {
  return {
    run: () => {
      throw error;
    },
  };
}

describe('assembleLintJob (job assembly)', () => {
  const job = assembleLintJob(RTL, TOP_MODULE, LIMITS);

  it('marks the job as a lint run', () => {
    expect(job.kind).toBe('lint');
  });

  it('places the RTL sources in the workspace files', () => {
    expect(job.workspaceFiles).toEqual([...RTL]);
  });

  it('requires the lint report and the exit code as outputs', () => {
    expect(job.requiredOutputs).toContain('lintReport');
    expect(job.requiredOutputs).toContain('exitCode');
  });

  it('applies the caller-provided resource limits unchanged', () => {
    expect(job.limits).toEqual(LIMITS);
  });

  it('carries the top module on the lint payload', () => {
    expect(job.lint).toEqual({ topModule: TOP_MODULE });
  });
});

describe('interpretLintResult (the Lint_Result decision table)', () => {
  it('is could-not-run when the sandbox classified the run error', () => {
    const outcome = interpretLintResult(sandboxResult({ verdict: 'error' }), null);
    expect(outcome).toEqual({
      kind: 'could-not-run',
      reason: LINT_RESULT_REASONS['could-not-run'],
    });
  });

  it('is could-not-run when the report text is null', () => {
    const outcome = interpretLintResult(sandboxResult(), null);
    expect(outcome.kind).toBe('could-not-run');
  });

  it('is could-not-run when the report text is not JSON', () => {
    const outcome = interpretLintResult(sandboxResult(), 'not json at all');
    expect(outcome.kind).toBe('could-not-run');
  });

  it('is could-not-run when the report carries a key outside its two fields', () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: 0, extra: 'nope' });
    expect(interpretLintResult(sandboxResult(), text).kind).toBe('could-not-run');
  });

  it('is could-not-run when reachedCheck is false', () => {
    const text = JSON.stringify({ reachedCheck: false, problemCount: null });
    expect(interpretLintResult(sandboxResult(), text).kind).toBe('could-not-run');
  });

  it('is could-not-run when reachedCheck is true but problemCount is negative', () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: -1 });
    expect(interpretLintResult(sandboxResult(), text).kind).toBe('could-not-run');
  });

  it('is could-not-run when reachedCheck is true but problemCount is not an integer', () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: 1.5 });
    expect(interpretLintResult(sandboxResult(), text).kind).toBe('could-not-run');
  });

  it('is clean when reachedCheck is true and problemCount is 0', () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: 0 });
    const outcome = interpretLintResult(sandboxResult(), text);
    expect(outcome).toEqual({ kind: 'clean', reason: LINT_RESULT_REASONS.clean });
  });

  it('is findings carrying the count when reachedCheck is true and problemCount is at least 1', () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: 3 });
    const outcome = interpretLintResult(sandboxResult(), text);
    expect(outcome).toEqual({
      kind: 'findings',
      problemCount: 3,
      reason: LINT_RESULT_REASONS.findings,
    });
  });
});

describe('YosysCheckLintAdapter (driven through injected ports)', () => {
  it('returns clean when the run and the report are both well-formed', async () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: 0 });
    const adapter = new YosysCheckLintAdapter(runnerResolvingTo(sandboxResult()), reader(text));

    const outcome = await adapter.lint(RTL, TOP_MODULE, LIMITS);

    expect(outcome.kind).toBe('clean');
  });

  it('degrades to could-not-run when toolRunner.run throws a SandboxContractError', async () => {
    const violation = { code: 'SANDBOX_JOB_INVALID' as const, message: 'bad job', issues: [] };
    const adapter = new YosysCheckLintAdapter(
      runnerThrowing(new SandboxContractError(violation)),
      reader(null),
    );

    const outcome = await adapter.lint(RTL, TOP_MODULE, LIMITS);

    expect(outcome).toEqual({
      kind: 'could-not-run',
      reason: LINT_RESULT_REASONS['could-not-run'],
    });
  });

  it('degrades to could-not-run when toolRunner.run rejects', async () => {
    const adapter = new YosysCheckLintAdapter(
      runnerRejecting(new Error('/host/internal/path: ECONNRESET')),
      reader(null),
    );

    const outcome = await adapter.lint(RTL, TOP_MODULE, LIMITS);

    expect(outcome).toEqual({
      kind: 'could-not-run',
      reason: LINT_RESULT_REASONS['could-not-run'],
    });
  });

  it('degrades to could-not-run on a retention miss (readText resolves null)', async () => {
    const adapter = new YosysCheckLintAdapter(runnerResolvingTo(sandboxResult()), reader(null));

    const outcome = await adapter.lint(RTL, TOP_MODULE, LIMITS);

    expect(outcome).toEqual({
      kind: 'could-not-run',
      reason: LINT_RESULT_REASONS['could-not-run'],
    });
  });

  it('degrades to could-not-run when artifacts.readText rejects', async () => {
    const rejectingReader: ArtifactTextReader = {
      readText: () => Promise.reject(new Error('/host/.store/blob: EACCES')),
    };
    const adapter = new YosysCheckLintAdapter(runnerResolvingTo(sandboxResult()), rejectingReader);

    const outcome = await adapter.lint(RTL, TOP_MODULE, LIMITS);

    expect(outcome).toEqual({
      kind: 'could-not-run',
      reason: LINT_RESULT_REASONS['could-not-run'],
    });
  });

  it('reports could-not-run with no lintReport artifact registered, without calling the reader', async () => {
    let readCalled = false;
    const trackingReader: ArtifactTextReader = {
      readText: () => {
        readCalled = true;
        return Promise.resolve(null);
      },
    };
    const adapter = new YosysCheckLintAdapter(
      runnerResolvingTo(sandboxResult({ artifacts: {} })),
      trackingReader,
    );

    const outcome = await adapter.lint(RTL, TOP_MODULE, LIMITS);

    expect(outcome.kind).toBe('could-not-run');
    expect(readCalled).toBe(false);
  });

  it('runs end-to-end through a real SandboxToolRunner backed by a scripted fake runtime', async () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: 2 });
    const capture: RawRunCapture = {
      timedOut: false,
      infraFailure: false,
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      diskLimitExceeded: false,
      artifacts: { lintReport: LINT_REPORT_ARTIFACT },
      deniedOperations: [],
      resourceUsage: RESOURCE_USAGE,
    };
    const toolRunner = new SandboxToolRunner(new FakeSandboxRuntime(capture));
    const adapter = new YosysCheckLintAdapter(toolRunner, reader(text));

    const outcome = await adapter.lint(RTL, TOP_MODULE, LIMITS);

    expect(outcome).toEqual({
      kind: 'findings',
      problemCount: 2,
      reason: LINT_RESULT_REASONS.findings,
    });
  });
});

describe('LINT_RESULT_REASONS (sanitized reasons)', () => {
  it('provides a non-empty reason for every LintResultKind', () => {
    for (const reason of Object.values(LINT_RESULT_REASONS)) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('never leaks paths, URLs, or stack-trace shapes in a reason', () => {
    for (const reason of Object.values(LINT_RESULT_REASONS)) {
      expect(reason).not.toMatch(/\//);
      expect(reason).not.toMatch(/https?:/i);
      expect(reason).not.toMatch(/\bat\s+\w+.*:\d+/);
    }
  });
});

describe('LintResult type (an admission check, never a verdict)', () => {
  it('has no verdict or trust field', () => {
    expectTypeOf<LintResult>().not.toHaveProperty('verdict');
    expectTypeOf<LintResult>().not.toHaveProperty('trust');
  });

  it('is not assignable to or from Verdict', () => {
    expectTypeOf<LintResult>().not.toExtend<Verdict>();
    expectTypeOf<Verdict>().not.toExtend<LintResult>();
  });

  it('is not assignable to or from SandboxResult["verdict"]', () => {
    expectTypeOf<LintResult>().not.toExtend<SandboxResult['verdict']>();
    expectTypeOf<SandboxResult['verdict']>().not.toExtend<LintResult>();
  });
});
