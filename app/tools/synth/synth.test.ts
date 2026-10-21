// Unit tests for the Synth adapter (task 15.3).
//
// Exercised without a real Yosys/netlistsvg (the real path is task 15.8): (1) job
// assembly - the RTL becomes workspace files with the synthesize kind, the netlist
// JSON required output, and the caller's limits; (2) result interpretation - a
// clean run with both artifacts yields an `SvgArtifact`, while a sandbox error, a
// non-zero exit, or a missing artifact each degrades to an explicit, sanitized
// `UnavailableStatus`; (3) end-to-end - the adapter driven through a real
// `SandboxToolRunner` backed by the `FakeSandboxRuntime` surfaces the same
// classification, and never throws. The sanitized-reason table is asserted to
// carry no paths, hosts, or stack-trace shapes.

import { describe, expect, it } from 'vitest';

import {
  FakeSandboxRuntime,
  SandboxToolRunner,
  type ArtifactBlobRef,
  type RawRunCapture,
  type ResourceUsage,
  type SandboxResult,
  type SourceFile,
} from '../sandbox/index.js';
import {
  SYNTH_UNAVAILABLE_REASONS,
  YosysNetlistSvgAdapter,
  assembleSynthesizeJob,
  interpretSynthResult,
  synthesisCheckPassed,
  type SynthUnavailableCause,
} from './index.js';

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 } as const;

const RESOURCE_USAGE: ResourceUsage = { wallMs: 20, maxMemMb: 16, cpuMs: 18 };

const RTL: readonly SourceFile[] = [{ path: 'alu.v', contents: 'module alu(); endmodule' }];

const TOP_MODULE = 'alu';

const SVG_ARTIFACT: ArtifactBlobRef = {
  name: 'schematic.svg',
  sizeBytes: 2048,
  sha256: 'b'.repeat(64),
};
const NETLIST_ARTIFACT: ArtifactBlobRef = {
  name: 'netlist.json',
  sizeBytes: 512,
  sha256: 'c'.repeat(64),
};

/** A `SandboxResult` for interpretation, defaulting to a clean run with both artifacts. */
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
    artifacts: { svg: SVG_ARTIFACT, netlistJson: NETLIST_ARTIFACT },
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
    artifacts: { svg: SVG_ARTIFACT, netlistJson: NETLIST_ARTIFACT },
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
    ...overrides,
  };
}

/** Drive the adapter end-to-end through a real sandbox runner backed by a scripted fake. */
function synthesizeWith(
  rawCapture: RawRunCapture,
): Promise<ReturnType<typeof interpretSynthResult>> {
  const runner = new SandboxToolRunner(new FakeSandboxRuntime(rawCapture));
  return new YosysNetlistSvgAdapter(runner).netlistSvg(RTL, TOP_MODULE, LIMITS);
}

describe('assembleSynthesizeJob (job assembly)', () => {
  const job = assembleSynthesizeJob(RTL, TOP_MODULE, LIMITS, true);

  it('marks the job as a synthesize run', () => {
    expect(job.kind).toBe('synthesize');
  });

  it('places the RTL sources in the workspace files', () => {
    expect(job.workspaceFiles).toEqual([...RTL]);
  });

  it('requires the netlist JSON and exit code as outputs', () => {
    expect(job.requiredOutputs).toContain('netlistJson');
    expect(job.requiredOutputs).toContain('exitCode');
  });

  it('applies the caller-provided resource limits unchanged', () => {
    expect(job.limits).toEqual(LIMITS);
  });

  it('carries the top module and schematic request on the synthesize payload', () => {
    expect(job.synthesize).toEqual({ topModule: TOP_MODULE, schematic: true });
  });

  it('requests no schematic when the caller passes schematic: false', () => {
    const noSchematicJob = assembleSynthesizeJob(RTL, TOP_MODULE, LIMITS, false);
    expect(noSchematicJob.synthesize).toEqual({ topModule: TOP_MODULE, schematic: false });
  });
});

describe('interpretSynthResult (result classification)', () => {
  it('returns the schematic when the run is clean and both artifacts are present', () => {
    const outcome = interpretSynthResult(sandboxResult());
    expect(outcome).toEqual({
      status: 'available',
      svg: SVG_ARTIFACT,
      netlistJson: NETLIST_ARTIFACT,
    });
  });

  it('is unavailable with synthesis-error when the sandbox classified the run error', () => {
    const outcome = interpretSynthResult(sandboxResult({ verdict: 'error', artifacts: {} }));
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.cause).toBe('synthesis-error');
  });

  it('is unavailable with synthesis-failed when the toolchain exited non-zero', () => {
    const outcome = interpretSynthResult(sandboxResult({ verdict: 'fail', exitCode: 1 }));
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.cause).toBe('synthesis-failed');
  });

  it('is unavailable with no-schematic when a clean run produced no SVG', () => {
    const outcome = interpretSynthResult(
      sandboxResult({ artifacts: { netlistJson: NETLIST_ARTIFACT } }),
    );
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.cause).toBe('no-schematic');
  });

  it('is unavailable with no-schematic when a clean run produced no netlist JSON', () => {
    const outcome = interpretSynthResult(sandboxResult({ artifacts: { svg: SVG_ARTIFACT } }));
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.cause).toBe('no-schematic');
  });

  it('carries the sanitized reason string for the classified cause', () => {
    const outcome = interpretSynthResult(sandboxResult({ verdict: 'error' }));
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toBe(SYNTH_UNAVAILABLE_REASONS['synthesis-error']);
  });
});

describe('YosysNetlistSvgAdapter (driven through the injected sandbox runner)', () => {
  it('returns the schematic when synthesis and rendering both succeed', async () => {
    const outcome = await synthesizeWith(capture());
    expect(outcome.status).toBe('available');
    if (outcome.status !== 'available') return;
    expect(outcome.svg).toEqual(SVG_ARTIFACT);
  });

  it('degrades to unavailable when the run times out', async () => {
    const outcome = await synthesizeWith(capture({ timedOut: true }));
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.cause).toBe('synthesis-error');
  });

  it('degrades to unavailable on an infrastructure failure', async () => {
    const outcome = await synthesizeWith(capture({ infraFailure: true }));
    expect(outcome.status).toBe('unavailable');
  });

  it('degrades to unavailable when the required netlist JSON is missing', async () => {
    const outcome = await synthesizeWith(capture({ artifacts: { svg: SVG_ARTIFACT } }));
    // A missing required output forces the sandbox to classify the run error.
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.cause).toBe('synthesis-error');
  });

  it('degrades to unavailable with no-schematic when only the SVG is missing', async () => {
    const outcome = await synthesizeWith(capture({ artifacts: { netlistJson: NETLIST_ARTIFACT } }));
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.cause).toBe('no-schematic');
  });
});

describe('SYNTH_UNAVAILABLE_REASONS (sanitized reasons)', () => {
  const causes: readonly SynthUnavailableCause[] = [
    'synthesis-error',
    'synthesis-failed',
    'no-schematic',
  ];

  it('provides a non-empty reason for every cause', () => {
    for (const cause of causes) {
      expect(SYNTH_UNAVAILABLE_REASONS[cause].length).toBeGreaterThan(0);
    }
  });

  it('never leaks paths, URLs, or stack-trace shapes in a reason', () => {
    for (const cause of causes) {
      const reason = SYNTH_UNAVAILABLE_REASONS[cause];
      expect(reason).not.toMatch(/\//);
      expect(reason).not.toMatch(/https?:/i);
      expect(reason).not.toMatch(/\bat\s+\w+.*:\d+/);
    }
  });
});

describe('synthesisCheckPassed (SGT-Q05: reads synthesis, not the schematic)', () => {
  it('is true on exit 0 with netlistJson present and svg present', () => {
    expect(synthesisCheckPassed(sandboxResult())).toBe(true);
  });

  it('is true on exit 0 with netlistJson present and svg absent', () => {
    const result = sandboxResult({ artifacts: { netlistJson: NETLIST_ARTIFACT } });
    expect(synthesisCheckPassed(result)).toBe(true);
  });

  it('is false when the sandbox classified the run error', () => {
    const result = sandboxResult({
      verdict: 'error',
      artifacts: { netlistJson: NETLIST_ARTIFACT },
    });
    expect(synthesisCheckPassed(result)).toBe(false);
  });

  it('is false on a non-zero exit code', () => {
    const result = sandboxResult({ exitCode: 1 });
    expect(synthesisCheckPassed(result)).toBe(false);
  });

  it('is false when netlistJson is absent, even with exit code 0', () => {
    const result = sandboxResult({ artifacts: { svg: SVG_ARTIFACT } });
    expect(synthesisCheckPassed(result)).toBe(false);
  });
});
