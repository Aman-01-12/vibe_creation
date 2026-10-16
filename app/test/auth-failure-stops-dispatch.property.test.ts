// Feature: formal-gate-first-light, Property 23: Dispatch stops at the first
// Auth_Failure_Cause.
//
// WHAT IS UNDER TEST, AND WHY A LOOP APPEARS IN THIS FILE
//   Req 7.7 is a claim about a SEQUENCE, so it cannot be read off one call. Production
//   composes three pieces to make it true (`app/eval/sweep/cli.ts`, `runSweep`):
//     1. `AuthFailureWatch` wraps the results log and counts, as records land, how many
//        samples completed and how many were deferred for the Auth_Failure_Cause.
//     2. `outage: () => breaker.outage() || watch.stopDispatch()` reports a refused
//        credential through the breaker's own seam.
//     3. `SweepKillSwitch.shouldStop` is what the runner's admission gate asks before it
//        consumes the next unit of work, and a `providerOutage` answer is `'provider-outage'`
//        and therefore `exhausted` - no further sample is dispatched.
//   All three are the real units here. Only the worker pool is reduced, to one sequential
//   worker: the runner's own header states samples are independent and order-independent, so
//   a pool changes which sample is last in flight and not whether dispatch stopped.
//
// CLASSIFICATION IS BY TYPED CAUSE, WHICH IS THE PILOT'S DEFECT
//   The pilot read six dead-credential slots as a network outage because it classified by
//   message. So every auth-failure record generated here carries a note naming the NETWORK
//   cause, and every network deferral carries a note naming the AUTH cause. A watch that
//   read the note would stop on the wrong sample, and the `null` oracle below would catch it.
//
// THE ORACLE IS INDEPENDENT
//   `expectedDispatchCount` re-derives the stop point from the generated kinds alone, without
//   consulting the watch, so a watch that stopped one sample late or never would be caught
//   rather than agreed with.
//
// Not `propertyTag(23, ...)`: that helper's `FEATURE_TAG` is another spec's slug.
//
// Validates: Requirements 7.7
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import {
  appendedSampleFacts,
  AuthFailureWatch,
  DEFAULT_KILL_SWITCH_BOUNDS,
  encodeSampleRecord,
  RESULTS_SCHEMA_VERSION,
  SweepKillSwitch,
  type NoVerdictCause,
  type ResultsLogPort,
  type SweepSampleRecord,
  type SweepStopReason,
} from '@app/eval';

import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 23: Dispatch stops at the first Auth_Failure_Cause';

/** The Auth_Failure_Cause: a provider ANSWERED and refused the credential. */
const AUTH_FAILURE_CAUSE = 'provider-refused-credential' satisfies NoVerdictCause;

/** The deferral that is a transport failure instead, which must NOT stop dispatch. */
const NETWORK_CAUSE = 'provider-unreachable' satisfies NoVerdictCause;

/** The stop reason a refused credential is reported through (see the watch's own note). */
const OUTAGE_REASON = 'provider-outage' satisfies SweepStopReason;

/** The five kinds of appended line this claim tells apart. */
const SAMPLE_KINDS = [
  'verified-pass',
  'judged-failure',
  'auth-failure',
  'network-deferral',
  'undecodable',
] as const;
type SampleKind = (typeof SAMPLE_KINDS)[number];

/** The two kinds that reached an oracle verdict, so they are measured and finished. */
const COMPLETED_KINDS: readonly SampleKind[] = ['verified-pass', 'judged-failure'];

/** One sample as the generator draws it: what happened, and what the note says about it. */
interface PlannedSample {
  readonly kind: SampleKind;
  readonly note: string | null;
}

/**
 * Every field this property does not read, at values the decoder accepts unchanged.
 *
 * The verified pass, as `formal-summary-aggregation.property.test.ts` states it. Each kind
 * below is an overlay, so no fixture states a shape the runner never writes - which is the
 * trap that makes a decoder-refused fixture pass a test for the wrong reason.
 */
const VERIFIED_PASS: SweepSampleRecord = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  strategyArm: 'control',
  checkingApproach: 'cycle-timed',
  designGroup: 'cycle-exact',
  testbenchPromptVersion: 4,
  simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
  testbenchParseRefusal: null,
  positiveControlRun: null,
  // The base sample's testbench was measured and gave every failure report a value.
  valuelessFailureReports: 0,
  configHash: 'cfg-property-23',
  armName: 'arm-a',
  modelSignature: 'zai.glm-5',
  problemId: 'rtllm/arithmetic/adder_8bit',
  sampleIndex: 0,
  seed: 1,
  passed: true,
  outcomeStatus: 'verified',
  iterations: 1,
  costCents: 1,
  costKnown: true,
  promptTokens: 800,
  completionTokens: 200,
  totalTokens: 1_000,
  unreportedUsageCalls: 0,
  stopReason: null,
  goldenVerdict: 'passed',
  goldenFailureCount: 0,
  instrumentValidity: 'valid',
  instrumentDefect: null,
  instrumentUncheckedReason: null,
  mutation: {
    validCount: 4,
    killedCount: 4,
    noVerdictKills: 0,
    coverageGapOperators: [],
    candidateEquivalentOperators: [],
    goldenSurvivedCount: 2,
    goldenTimeoutCount: 0,
    nonCompilingCount: 1,
    goldenErroredCount: 0,
    elapsedMs: 3_200,
  },
  repairAttempted: false,
  repairAccepted: false,
  repairDeclineReason: null,
  checkNameVisibilitySignal: false,
  formal: null,
  formalFallbackReason: null,
  formalFallbackRoute: 'not-applicable',
  formalResetContract: null,
  formalAssertionGateEmitted: false,
  formalClockPolarity: null,
  propertySetAdmitted: 'not-gated',
  propertySetAuthoredUpFront: false,
  propertySetSurvivorCount: 0,
  formalMutationCounts: null,
  durationMs: 1_000,
  completedAtMs: 1_000,
  failureNote: null,
  noVerdictCause: null,
};

/** A sample the oracle judged and failed: completed, but not passed. */
const JUDGED_FAILURE: Partial<SweepSampleRecord> = {
  passed: false,
  outcomeStatus: 'unverified',
  iterations: 3,
  stopReason: 'max-iterations',
  goldenVerdict: 'failed',
  goldenFailureCount: 2,
};

/**
 * A deferred sample: no candidate, so no verdict, no golden judgement, no mutation probe.
 *
 * `setup-failed` is the only status a transport-level cause is written beside, and a fixture
 * stating otherwise is one the decoder refuses by a cross-field rule.
 */
const DEFERRED: Partial<SweepSampleRecord> = {
  passed: false,
  outcomeStatus: 'setup-failed',
  iterations: 0,
  costCents: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  stopReason: null,
  goldenVerdict: null,
  goldenFailureCount: null,
  instrumentValidity: 'unchecked',
  instrumentUncheckedReason: 'no-testbench',
  mutation: null,
  valuelessFailureReports: null,
};

/** The overlay that makes each decodable kind. */
const OVERLAY_BY_KIND: Record<Exclude<SampleKind, 'undecodable'>, Partial<SweepSampleRecord>> = {
  'verified-pass': {},
  'judged-failure': JUDGED_FAILURE,
  'auth-failure': { ...DEFERRED, noVerdictCause: AUTH_FAILURE_CAUSE },
  'network-deferral': { ...DEFERRED, noVerdictCause: NETWORK_CAUSE },
};

/** The appended line for one planned sample, at its slot. */
function lineFor(sample: PlannedSample, sampleIndex: number): string {
  if (sample.kind === 'undecodable') {
    // A record at a version this decoder does not accept: parseable, and still unclassifiable.
    return JSON.stringify({ ...VERIFIED_PASS, schemaVersion: RESULTS_SCHEMA_VERSION + 1 });
  }
  return encodeSampleRecord({
    ...VERIFIED_PASS,
    ...OVERLAY_BY_KIND[sample.kind],
    sampleIndex,
    failureNote: sample.note,
  });
}

/** What one modelled dispatch did. */
interface DispatchTrace {
  readonly dispatched: number;
  readonly stopReason: SweepStopReason | null;
  readonly persisted: readonly string[];
}

/**
 * Dispatch a planned sequence through the real watch, the real kill switch, and the real
 * encoder, stopping where the runner's admission gate would.
 *
 * The sample cap is set above the plan and the clock is frozen, so neither of the other two
 * bounds can be what stopped the run - the assertions on `stopReason` pin that.
 */
async function driveDispatch(plan: readonly PlannedSample[]): Promise<DispatchTrace> {
  const persisted: string[] = [];
  const log: ResultsLogPort = {
    appendLine: (line: string): Promise<void> => {
      persisted.push(line);
      return Promise.resolve();
    },
    readAll: (): Promise<string> => Promise.resolve(persisted.join('\n')),
  };
  const watch = new AuthFailureWatch(log, appendedSampleFacts);
  const killSwitch = new SweepKillSwitch(
    { ...DEFAULT_KILL_SWITCH_BOUNDS, maxSamples: plan.length + 1 },
    () => 0,
  );
  let dispatched = 0;
  let stopReason: SweepStopReason | null = null;
  for (const [sampleIndex, sample] of plan.entries()) {
    // The production composition, at the admission gate the runner asks it from.
    stopReason = killSwitch.shouldStop({
      dispatchedSamples: dispatched,
      providerOutage: watch.stopDispatch(),
    });
    if (stopReason !== null) {
      break;
    }
    dispatched += 1;
    await watch.appendLine(lineFor(sample, sampleIndex));
  }
  return { dispatched, stopReason, persisted };
}

/**
 * How many samples a correct dispatch runs, derived from the kinds alone.
 *
 * The stop point is the first slot after which a credential has been refused AND a sample has
 * completed. Both halves are cumulative, so an auth failure that lands before the first
 * completed sample stops nothing until that sample lands - which is Req 7.7's "after at least
 * one sample has completed" read in the only order-independent way it can be. An undecodable
 * line is neither, because guessing a classification is what the typed cause exists to avoid.
 */
function expectedDispatchCount(plan: readonly PlannedSample[]): number {
  let authFailures = 0;
  let completed = 0;
  for (const [index, sample] of plan.entries()) {
    authFailures += sample.kind === 'auth-failure' ? 1 : 0;
    completed += COMPLETED_KINDS.includes(sample.kind) ? 1 : 0;
    if (authFailures > 0 && completed > 0) {
      return index + 1;
    }
  }
  return plan.length;
}

/**
 * Notes that would fool a message-level classifier.
 *
 * Each names a cause the typed field does not carry, so a watch reading the note would stop
 * on a network deferral or walk past a refused credential.
 */
function arbNote(): fc.Arbitrary<string | null> {
  return fc.oneof(
    fc.constant(null),
    fc.constant(`${NETWORK_CAUSE}: all providers failed`),
    fc.constant(`${AUTH_FAILURE_CAUSE}: see the operator log`),
    fc.constant('ALL_PROVIDERS_FAILED'),
    fc.string({ minLength: 1, maxLength: 40 }),
  );
}

/** A dispatch plan: a short sequence of sample kinds, each with an unhelpful note. */
function arbPlan(): fc.Arbitrary<readonly PlannedSample[]> {
  return fc.array(fc.record({ kind: fc.constantFrom(...SAMPLE_KINDS), note: arbNote() }), {
    minLength: 1,
    maxLength: 8,
  });
}

/** One plan of fixed kinds, so a named sequence reads as the sequence it is. */
function planOf(...kinds: readonly SampleKind[]): readonly PlannedSample[] {
  // The note names the rival cause on every sample, which is the arm a note-reading watch fails.
  return kinds.map((kind) => ({
    kind,
    note: kind === 'auth-failure' ? `${NETWORK_CAUSE}: all providers failed` : AUTH_FAILURE_CAUSE,
  }));
}

describe(PROPERTY, () => {
  it('dispatches no sample after the first refusal that follows a completed sample', async () => {
    // Which rows the population actually produced, so a pass cannot be a pass over one shape.
    const seen = { stopped: false, ranToEnd: false, refusalBeforeCompletion: false };

    await fc.assert(
      fc.asyncProperty(arbPlan(), async (plan) => {
        const expected = expectedDispatchCount(plan);
        const trace = await driveDispatch(plan);

        expect(trace.dispatched).toBe(expected);
        // Every sample that was dispatched was also recorded: the stop is taken at a sample
        // boundary, so nothing paid for is thrown away.
        expect(trace.persisted).toHaveLength(trace.dispatched);

        if (expected < plan.length) {
          seen.stopped = true;
          // And it stopped for the refusal, not for the cap or the clock.
          expect(trace.stopReason).toBe(OUTAGE_REASON);
          const firstAuth = plan.findIndex((sample) => sample.kind === 'auth-failure');
          seen.refusalBeforeCompletion ||= firstAuth < expected - 1;
        } else {
          seen.ranToEnd = true;
          expect(trace.stopReason).toBeNull();
        }
      }),
      // Above the shared 100: the rarest row is a refusal that lands before the first
      // completed sample, which needs both kinds drawn in one order inside a short plan.
      propertyParameters({ numRuns: 300 }),
    );

    expect(seen.stopped, 'no generated plan stopped dispatch').toBe(true);
    expect(seen.ranToEnd, 'no generated plan ran to the end').toBe(true);
    expect(seen.refusalBeforeCompletion, 'no plan refused before completing').toBe(true);
  });

  it('keeps dispatching a refusal that no completed sample has followed yet', async () => {
    // The left half of Req 7.7: a credential refused before anything was measured leaves no
    // partial result to protect, so the run keeps going and the exit status is what reports it.
    const allRefused = await driveDispatch(planOf('auth-failure', 'auth-failure', 'auth-failure'));

    expect(allRefused.dispatched).toBe(3);
    expect(allRefused.stopReason).toBeNull();

    // Until one completes. Then the next slot is the one that is not dispatched.
    const thenCompleted = await driveDispatch(
      planOf('auth-failure', 'auth-failure', 'verified-pass', 'verified-pass'),
    );

    expect(thenCompleted.dispatched).toBe(3);
    expect(thenCompleted.stopReason).toBe(OUTAGE_REASON);
  });

  it('is decided by the typed cause, and a network deferral is not a refusal', async () => {
    // A full plan of network deferrals beside completed samples, every one of them carrying a
    // note that names the Auth_Failure_Cause verbatim. A message-level classifier stops here.
    const networkOnly = await driveDispatch(
      planOf('verified-pass', 'network-deferral', 'judged-failure', 'network-deferral'),
    );

    expect(networkOnly.dispatched).toBe(4);
    expect(networkOnly.stopReason).toBeNull();

    // The same shape with one typed Auth_Failure_Cause in it, whose note names the NETWORK
    // cause, stops at that sample. The note is the opposite of the decision in both arms.
    const oneRefusal = await driveDispatch(
      planOf('verified-pass', 'auth-failure', 'judged-failure', 'network-deferral'),
    );

    expect(oneRefusal.dispatched).toBe(2);
    expect(oneRefusal.stopReason).toBe(OUTAGE_REASON);
  });

  it('counts an undecodable line as neither, which leaves dispatch running', async () => {
    // Non-vacuity first: the undecodable flavour really is unclassifiable, so the clause below
    // is not quietly grading a line the decoder accepted.
    const line = lineFor({ kind: 'undecodable', note: null }, 0);

    expect(appendedSampleFacts(line)).toBeNull();

    // Stopping on a line we cannot classify would end a healthy campaign, so it does not.
    const trace = await driveDispatch(
      planOf('verified-pass', 'undecodable', 'undecodable', 'judged-failure'),
    );

    expect(trace.dispatched).toBe(4);
    expect(trace.stopReason).toBeNull();
    expect(trace.persisted).toHaveLength(4);
  });
});
