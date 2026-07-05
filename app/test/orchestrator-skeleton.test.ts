// Unit tests for the M0 Orchestrator skeleton (task 6.1; Req 1.4, 1.5).
//
// These drive the skeleton end to end through the real Simulator + sandbox chain
// (`IcarusSimulatorAdapter` over a `SandboxToolRunner` over a `FakeSandboxRuntime`)
// and a `TraceActionRecorder` over `InMemoryTracePersistence`. The fake runtime is
// scripted to reproduce the pass, fail, and error (timeout / infrastructure)
// trajectories so we can assert both the reported verdict AND that the run was
// recorded as an ordered, sanitized Trace span. A separate stub proves the
// fail-safe path: an exception from the oracle is classified `error`, never thrown.

import { describe, expect, it } from 'vitest';

import {
  InMemoryTracePersistence,
  OrchestratorSkeleton,
  SECRET_PLACEHOLDER,
  TraceActionRecorder,
  containsSecret,
  type SkeletonSimulationRequest,
} from '@app/agent';
import { newUlid, type Ulid } from '@app/core';
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type FakeCaptureScript,
  type RawRunCapture,
  type ResourceLimits,
  type SimulatorAdapter,
  type SourceFile,
} from '@app/tools';

/** A syntactically valid VCD artifact ref (64-hex sha256) the schema accepts. */
const VCD_ARTIFACT = { name: 'vcd', sizeBytes: 128, sha256: 'a'.repeat(64) } as const;

/** Benign observed resource usage for a completed run. */
const RESOURCE_USAGE = { wallMs: 12, maxMemMb: 8, cpuMs: 10 } as const;

/** The single module under test and its independently derived testbench. */
const RTL: readonly SourceFile[] = [
  { path: 'counter.v', contents: 'module counter(input clk, output reg [3:0] q); endmodule' },
];
const TESTBENCH: SourceFile = {
  path: 'counter_tb.v',
  contents:
    'module counter_tb; initial begin $display("CHECK counts_up PASS"); $finish; end endmodule',
};

/** Sandbox caps; `wallMs` is the sole time bound the skeleton relies on (Req 1.4). */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 16, diskMb: 64, wallMs: 5_000 };

/** A capture for a run whose every spec check passed. */
function passCapture(
  stdout = 'CHECK reset_clears_output PASS\nCHECK counts_up PASS\n',
): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout,
    stderr: '',
    artifacts: { vcd: VCD_ARTIFACT },
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
  };
}

/** A capture whose testbench signalled a failing spec check (a functional fail). */
function failCapture(): RawRunCapture {
  return passCapture('CHECK reset_clears_output PASS\nCHECK counts_up FAIL\n');
}

/** A capture for a run the sandbox killed at the wall-clock cap (Req 2.4). */
function timeoutCapture(): RawRunCapture {
  return {
    timedOut: true,
    infraFailure: false,
    exitCode: null,
    stdout: null,
    stderr: null,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: { wallMs: LIMITS.wallMs, maxMemMb: 4, cpuMs: 5 },
  };
}

/** A capture for a run the runtime never managed to execute (infra failure). */
function infraCapture(): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: true,
    exitCode: null,
    stdout: null,
    stderr: null,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
  };
}

/** Build the real Simulator-over-sandbox chain backed by a scripted fake runtime. */
function simulatorFor(script: RawRunCapture | FakeCaptureScript): SimulatorAdapter {
  return new IcarusSimulatorAdapter(new SandboxToolRunner(new FakeSandboxRuntime(script)));
}

/** A deterministic clock so recorded `startedAt`/`durationMs` are stable under test. */
function steppingClock(startMs = 1_700_000_000_000, stepMs = 5): () => number {
  let current = startMs - stepMs;
  return () => (current += stepMs);
}

/** Wire a skeleton around a scripted simulator plus a fresh in-memory recorder. */
function skeletonFor(script: RawRunCapture | FakeCaptureScript): {
  skeleton: OrchestratorSkeleton;
  recorder: TraceActionRecorder;
} {
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const skeleton = new OrchestratorSkeleton(simulatorFor(script), recorder, steppingClock());
  return { skeleton, recorder };
}

/** A minimal request for a session; override fields per test. */
function request(overrides: Partial<SkeletonSimulationRequest> = {}): SkeletonSimulationRequest {
  return { sessionId: newUlid(), rtl: RTL, testbench: TESTBENCH, limits: LIMITS, ...overrides };
}

describe('OrchestratorSkeleton oracle path (Req 1.5)', () => {
  it('reports pass and records one ordered simulate span when every check passes', async () => {
    const { skeleton, recorder } = skeletonFor(passCapture());
    const sessionId: Ulid = newUlid();

    const result = await skeleton.runSkeletonSimulation(request({ sessionId }));

    expect(result.simulation.verdict).toBe('pass');
    expect(result.simulation.checks).toEqual([
      { name: 'reset_clears_output', passed: true },
      { name: 'counts_up', passed: true },
    ]);
    expect(result.simulation.vcd).toEqual(VCD_ARTIFACT);

    const trace = await recorder.getTrace(sessionId);
    expect(trace.spans).toHaveLength(1);
    const [span] = trace.spans;
    expect(span?.seq).toBe(0);
    expect(span?.stageOrTool).toBe('Simulator');
    expect(span?.exitCode).toBe(0);
    expect(span?.costCents).toBe(0);
    expect(span?.retryCount).toBe(0);
    expect(span?.failureClass).toBeUndefined();
    // The returned span is the recorded one, so it is the run's provenance handle.
    expect(span?.id).toBe(result.span.id);
  });

  it('records the sanitized run inputs and verdict outputs on the span', async () => {
    const { skeleton, recorder } = skeletonFor(passCapture());
    const sessionId = newUlid();

    await skeleton.runSkeletonSimulation(request({ sessionId }));

    const trace = await recorder.getTrace(sessionId);
    const [span] = trace.spans;
    expect(span?.sanitizedInputs).toEqual({
      job: 'simulate',
      rtlFiles: ['counter.v'],
      testbenchFile: 'counter_tb.v',
      limits: { cpu: 1, memMb: 256, procs: 16, diskMb: 64, wallMs: 5_000 },
    });
    expect(span?.outputs).toMatchObject({ verdict: 'pass', exitCode: 0, vcdCaptured: true });
    expect(span?.startedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(span?.durationMs).toBe(5);
  });

  it('reports fail with a functional-fail span when a spec check fails', async () => {
    const { skeleton, recorder } = skeletonFor(failCapture());
    const sessionId = newUlid();

    const result = await skeleton.runSkeletonSimulation(request({ sessionId }));

    expect(result.simulation.verdict).toBe('fail');
    expect(result.simulation.checks).toContainEqual({ name: 'counts_up', passed: false });

    const trace = await recorder.getTrace(sessionId);
    expect(trace.spans[0]?.failureClass).toBe('functional-fail');
    expect(trace.spans[0]?.outputs).toMatchObject({ verdict: 'fail' });
  });

  it('reports error on a sandbox timeout and records a tool-error span', async () => {
    const { skeleton, recorder } = skeletonFor(timeoutCapture());
    const sessionId = newUlid();

    const result = await skeleton.runSkeletonSimulation(request({ sessionId }));

    expect(result.simulation.verdict).toBe('error');
    expect(result.simulation.checks).toEqual([]);
    expect(result.simulation.vcd).toBeNull();

    const trace = await recorder.getTrace(sessionId);
    expect(trace.spans[0]?.failureClass).toBe('tool-error');
    expect(trace.spans[0]?.exitCode).toBeNull();
  });

  it('reports error on an infrastructure failure', async () => {
    const { skeleton, recorder } = skeletonFor(infraCapture());
    const sessionId = newUlid();

    const result = await skeleton.runSkeletonSimulation(request({ sessionId }));

    expect(result.simulation.verdict).toBe('error');
    const trace = await recorder.getTrace(sessionId);
    expect(trace.spans[0]?.failureClass).toBe('tool-error');
  });
});

describe('OrchestratorSkeleton wall-clock bound (Req 1.4)', () => {
  it('passes the caller wall-clock cap through to the sandbox that enforces it', async () => {
    let observedWallMs = -1;
    const script: FakeCaptureScript = (job) => {
      observedWallMs = job.limits.wallMs;
      return timeoutCapture();
    };
    const { skeleton } = skeletonFor(script);

    const result = await skeleton.runSkeletonSimulation(request({ limits: LIMITS }));

    // The skeleton owns no timer; the wall-clock cap it relies on reaches the
    // sandbox, which is what bounds and terminates the run (Session_Budget is M1).
    expect(observedWallMs).toBe(LIMITS.wallMs);
    expect(result.simulation.verdict).toBe('error');
  });
});

describe('OrchestratorSkeleton fail-safe and recording invariants', () => {
  it('classifies a thrown sandbox failure as error and still records the span', async () => {
    const throwingSimulator: SimulatorAdapter = {
      simulate: () => Promise.reject(new Error('sandbox capture failed')),
    };
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const skeleton = new OrchestratorSkeleton(throwingSimulator, recorder, steppingClock());
    const sessionId = newUlid();

    const result = await skeleton.runSkeletonSimulation(request({ sessionId }));

    expect(result.simulation.verdict).toBe('error');
    const trace = await recorder.getTrace(sessionId);
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]?.failureClass).toBe('tool-error');
    expect(trace.spans[0]?.outputs).toMatchObject({ error: 'sandbox capture failed' });
  });

  it('assigns a monotonic seq across repeated runs in one session', async () => {
    const { skeleton, recorder } = skeletonFor(passCapture());
    const sessionId = newUlid();

    await skeleton.runSkeletonSimulation(request({ sessionId }));
    await skeleton.runSkeletonSimulation(request({ sessionId }));

    const trace = await recorder.getTrace(sessionId);
    expect(trace.spans.map((span) => span.seq)).toEqual([0, 1]);
  });

  it('redacts secret-shaped tokens in recorded fields at the recorder boundary', async () => {
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const { skeleton, recorder } = skeletonFor(passCapture(`CHECK ${secret} PASS\n`));
    const sessionId = newUlid();

    await skeleton.runSkeletonSimulation(request({ sessionId }));

    const trace = await recorder.getTrace(sessionId);
    const serialized = JSON.stringify(trace);
    expect(containsSecret(serialized)).toBe(false);
    expect(serialized).toContain(SECRET_PLACEHOLDER);
  });
});
