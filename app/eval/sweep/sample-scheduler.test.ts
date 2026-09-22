// Unit tests for one-sample scheduling.
//
// The money property: a slot the sweep did not schedule must never reach the inner runner,
// because reaching it means a model call and a sandbox run for work that is dispatched
// elsewhere. The honesty property: a declined slot is a `setup-failed` - never a pass, and
// never a fabricated verdict.

import { describe, expect, it } from 'vitest';

import { NO_REPAIR } from '@app/agent';
import type { SessionBudgetHandle, VerificationOutcome } from '@app/agent';
import type { ResourceLimits } from '@app/tools';
import type { Spec } from '@app/core';

import type {
  EvalArtifactDescriptor,
  EvalArtifactSink,
  EvalSampleArtifacts,
} from '../artifact-sink.js';
import type { EvalLoopRunner, EvalSampleRequest } from '../loop-runner.js';
import type { EvalProblem } from '../problem.js';
import {
  captureOneSample,
  scheduleOneSample,
  SLOT_NOT_SCHEDULED_DETAIL,
} from './sample-scheduler.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 64, procs: 8, diskMb: 8, wallMs: 1_000 };

/** A budget handle that is never charged on the declined path. */
const BUDGET: SessionBudgetHandle = {
  sessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  canAfford: () => true,
  charge: () => null,
  stopReason: () => null,
};

/** One problem, shaped only as far as the scheduler reads it. */
function problem(id: string): EvalProblem {
  return { id, title: id, source: 'RTLLM', spec: {} as Spec, intentSummary: '' };
}

/** A request for the given problem and sample index. */
function request(problemId: string, sampleIndex: number): EvalSampleRequest {
  return {
    problem: problem(problemId),
    sampleIndex,
    seed: 1,
    temperature: 0,
    budget: BUDGET,
    limits: LIMITS,
  };
}

/** An inner runner that counts how many times it was actually reached. */
function countingRunner(): EvalLoopRunner & { calls: number } {
  const runner = {
    calls: 0,
    runSample(): Promise<VerificationOutcome> {
      runner.calls += 1;
      return Promise.resolve({
        status: 'verified',
        iterations: 1,
      } as unknown as VerificationOutcome);
    },
  };
  return runner;
}

describe('scheduleOneSample', () => {
  it('delegates the scheduled slot to the inner runner', async () => {
    const inner = countingRunner();
    const scheduled = scheduleOneSample(inner, { problemId: 'p1', sampleIndex: 2 });
    const outcome = await scheduled.runSample(request('p1', 2));
    expect(inner.calls).toBe(1);
    expect(outcome.status).toBe('verified');
  });

  it('never reaches the inner runner for a different sample index', async () => {
    const inner = countingRunner();
    const scheduled = scheduleOneSample(inner, { problemId: 'p1', sampleIndex: 2 });
    await scheduled.runSample(request('p1', 0));
    await scheduled.runSample(request('p1', 1));
    await scheduled.runSample(request('p1', 3));
    expect(inner.calls).toBe(0);
  });

  it('never reaches the inner runner for a different problem', async () => {
    const inner = countingRunner();
    const scheduled = scheduleOneSample(inner, { problemId: 'p1', sampleIndex: 0 });
    await scheduled.runSample(request('p2', 0));
    expect(inner.calls).toBe(0);
  });

  it('declines with a sanitized setup-failed, which can never read as a pass', async () => {
    const scheduled = scheduleOneSample(countingRunner(), { problemId: 'p1', sampleIndex: 0 });
    const outcome = await scheduled.runSample(request('p1', 1));
    expect(outcome.status).toBe('setup-failed');
    expect(outcome).toMatchObject({ detail: SLOT_NOT_SCHEDULED_DETAIL });
  });

  it('holds no shared state, so two schedulers over one runner do not interfere', async () => {
    const inner = countingRunner();
    const first = scheduleOneSample(inner, { problemId: 'p1', sampleIndex: 0 });
    const second = scheduleOneSample(inner, { problemId: 'p1', sampleIndex: 1 });
    await Promise.all([first.runSample(request('p1', 0)), second.runSample(request('p1', 1))]);
    expect(inner.calls).toBe(2);
    await first.runSample(request('p1', 1));
    expect(inner.calls).toBe(2);
  });
});

/** The artifacts of a slot the harness measured as declined. */
function declinedArtifacts(): EvalSampleArtifacts {
  return {
    outcomeStatus: 'setup-failed',
    passed: false,
    iterations: 0,
    stopReason: null,
    failureNote: `generation-unavailable: ${SLOT_NOT_SCHEDULED_DETAIL}`,
    candidateRtl: null,
    testbenchSource: null,
    simulation: null,
    runFailureCause: null,
    attributedFiles: [],
    rejectedTestbenchDraft: null,
    missingCheckNames: [],
    missingCheckNamesTruncated: false,
    failingCase: null,
    goldenVerdict: null,
    // A declined slot produced no testbench, so there was no instrument to validate.
    instrumentVerdict: { validity: 'unchecked', reason: 'no-testbench' },
    controlStdout: null,
    controlStderr: null,
    controlExitCode: null,
    mutation: null,
    repairProvenance: NO_REPAIR,
    rejectedPreRepairTestbench: null,
    repairHint: null,
    precheckDiagnostic: null,
    repairDeclineReason: null,
    checkNameVisibilitySignal: false,
    preNormalizationTestbench: null,
    normalizerReport: null,
    normalizerReportFindingsTruncated: false,
  };
}

/** A sink that counts the writes it was actually handed. */
function countingSink(): EvalArtifactSink & { readonly seen: EvalArtifactDescriptor[] } {
  const sink = {
    seen: [] as EvalArtifactDescriptor[],
    write(descriptor: EvalArtifactDescriptor): Promise<void> {
      sink.seen.push(descriptor);
      return Promise.resolve();
    },
  };
  return sink;
}

/** A descriptor for the given slot. */
function descriptor(problemId: string, sampleIndex: number): EvalArtifactDescriptor {
  return { problemId, sampleIndex, seed: 7 };
}

describe('captureOneSample', () => {
  it('captures the scheduled slot', async () => {
    const sink = countingSink();
    const scoped = captureOneSample(sink, { problemId: 'p1', sampleIndex: 2 });
    await scoped.write(descriptor('p1', 2), declinedArtifacts());
    expect(sink.seen).toEqual([descriptor('p1', 2)]);
  });

  it('captures nothing for a slot the sweep declined, so no false evidence is written', async () => {
    // The harness measures every slot of the problem it is handed, and a declined slot looks
    // like `setup-failed`. Writing those would fill the run directory with captures for
    // samples that were never run - and a reader would take them for real failures.
    const sink = countingSink();
    const scoped = captureOneSample(sink, { problemId: 'p1', sampleIndex: 2 });
    await scoped.write(descriptor('p1', 0), declinedArtifacts());
    await scoped.write(descriptor('p1', 1), declinedArtifacts());
    await scoped.write(descriptor('p2', 2), declinedArtifacts());
    expect(sink.seen).toEqual([]);
  });

  it('holds no shared state, so two scopes over one sink do not interfere', async () => {
    const sink = countingSink();
    const first = captureOneSample(sink, { problemId: 'p1', sampleIndex: 0 });
    const second = captureOneSample(sink, { problemId: 'p1', sampleIndex: 1 });
    await Promise.all([
      first.write(descriptor('p1', 0), declinedArtifacts()),
      second.write(descriptor('p1', 1), declinedArtifacts()),
    ]);
    expect(sink.seen).toHaveLength(2);
    await first.write(descriptor('p1', 1), declinedArtifacts());
    expect(sink.seen).toHaveLength(2);
  });
});
