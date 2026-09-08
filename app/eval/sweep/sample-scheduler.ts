// How the sweep schedules ONE sample at a time through the Eval_Harness.
//
// THE PROBLEM
//   `EvalHarness.run(subset)` is the measurement engine and we want all of it: it derives
//   each sample's deterministic seed, builds a fresh student-caps budget, drives the
//   loop fail-safely, reads the consumed cost, and asks the INDEPENDENT golden judge for
//   its second verdict. Reimplementing any of that in the sweep would be a second
//   implementation of the thing the numbers depend on.
//
//   But the harness iterates every sample index of every problem in one call and returns
//   at the end. The sweep needs the opposite shape: one sample as the unit of work, so a
//   completed sample can be appended the moment it finishes, an already-recorded sample
//   can be skipped without re-paying for it, and several samples can be in flight at
//   once against a rate-limited host.
//
// THE RESOLUTION
//   The sweep dispatches one unit of work per (arm, problem, sampleIndex) and, for each,
//   hands the harness a loop runner that DECLINES every slot except the scheduled one.
//   The harness then does all of its per-sample work for exactly that slot - with the
//   correct seed for that index, because the harness derives it from the index it is
//   iterating - and the declined slots cost nothing: no model call, no sandbox run, and
//   no judge call, because a declined slot produces no candidate RTL for the judge to
//   score.
//
// WHY A DECLINE IS NOT A FABRICATED VERDICT
//   A declined slot returns `setup-failed`, which in this codebase means exactly one
//   thing: THE LOOP WAS NEVER STARTED, so there is no verdict - and it can never be read
//   as a pass. That is the same classification the production runner returns for a sample
//   it refuses to start (an out-of-range seed), so the vocabulary is already established.
//   Crucially, the sweep never persists a declined slot: only the scheduled slot's result
//   becomes a record. The harness's own returned report for such a call is therefore
//   partial BY CONSTRUCTION and is used for nothing but reading out that one sample -
//   never for pass@k, which the summary computes from the persisted records.
//
// COST OF THE APPROACH
//   For sampleCount n, each problem runs n calls of n slots, so n*(n-1) slots are
//   declined per problem. A decline is one object allocation, so at n=5 that is 20
//   allocations against 5 real samples that each take tens of seconds of model and
//   simulator time. The bookkeeping is free; the correctness is not.

import type { VerificationSetupFailed } from '@app/agent';

import type {
  EvalArtifactDescriptor,
  EvalArtifactSink,
  EvalSampleArtifacts,
} from '../artifact-sink.js';
import type { EvalLoopRunner, EvalSampleRequest } from '../loop-runner.js';

/** The sanitized detail a declined slot carries; no path, host, or stack trace. */
export const SLOT_NOT_SCHEDULED_DETAIL =
  'this sample slot was not scheduled by the sweep; it is dispatched as its own unit of work';

/** Which slot a scheduled runner will actually execute. */
export interface ScheduledSlot {
  readonly problemId: string;
  readonly sampleIndex: number;
}

/**
 * The outcome a declined slot reports.
 *
 * `generation-unavailable` is the closest true statement the loop's own vocabulary
 * offers: generation was never attempted for this slot. The detail says so explicitly so
 * a reader of a trace is never left guessing.
 *
 * The cause is `inputs-inadmissible` and NOT `provider-unreachable`, even though nothing was
 * sent to a provider. A declined slot is never persisted - `#measure` reads out only the
 * scheduled slot - but if it ever leaked into a record, `provider-unreachable` would mark it
 * DEFERRED and a resume would keep re-running a slot that was never asked to run. So the
 * decline claims the only thing that is safe in both worlds: this call could not admit a
 * model call, and re-running it changes nothing.
 */
function declined(): VerificationSetupFailed {
  return {
    status: 'setup-failed',
    reason: 'generation-unavailable',
    detail: SLOT_NOT_SCHEDULED_DETAIL,
    cause: 'inputs-inadmissible',
  };
}

/**
 * Wrap a loop runner so it executes ONLY the scheduled slot.
 *
 * The wrapper is stateless: the target is fixed at construction, so concurrent samples
 * each get their own wrapper and there is no shared mutable selection to race on.
 */
export function scheduleOneSample(inner: EvalLoopRunner, slot: ScheduledSlot): EvalLoopRunner {
  return {
    runSample(request: EvalSampleRequest) {
      if (request.problem.id !== slot.problemId || request.sampleIndex !== slot.sampleIndex) {
        return Promise.resolve(declined());
      }
      return inner.runSample(request);
    },
  };
}

/**
 * Wrap an artifact sink so it captures ONLY the scheduled slot.
 *
 * The same scoping the loop runner needs, and for the same reason: the harness measures
 * every slot of the problem it is handed, and a DECLINED slot is measured as `setup-failed`
 * even though nothing ran. The sweep already refuses to persist those as records; without
 * this wrapper it would nevertheless write them as artifacts, filling the run directory with
 * `setup-failed` captures for samples that were dispatched as their own units of work. A
 * reader would take them for real generation failures, which is the exact kind of dishonest
 * evidence this capture exists to prevent.
 *
 * Stateless, like `scheduleOneSample`: the slot is fixed at construction, so concurrent
 * samples each get their own wrapper over the arm's shared sink.
 */
export function captureOneSample(inner: EvalArtifactSink, slot: ScheduledSlot): EvalArtifactSink {
  return {
    write(descriptor: EvalArtifactDescriptor, artifacts: EvalSampleArtifacts) {
      if (descriptor.problemId !== slot.problemId || descriptor.sampleIndex !== slot.sampleIndex) {
        return Promise.resolve();
      }
      return inner.write(descriptor, artifacts);
    },
  };
}
