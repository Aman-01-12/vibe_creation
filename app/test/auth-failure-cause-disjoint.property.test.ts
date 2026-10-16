// Feature: formal-gate-first-light, Property 21: A provider refusal is a cause of its own,
// disjoint from every other.
//
// WHAT IS UNDER TEST, AND WHY IT IS THREE SURFACES
//   The claim spans the only three places a credential refusal is decided as a VALUE:
//     1. `checkCredential` (`app/eval/sweep/preflight.ts`) turns one provider answer into one
//        outcome, and a credential-rejecting answer must not land on the network code.
//     2. `NO_VERDICT_CAUSES` (`app/eval/no-verdict-cause.ts`) holds the recorded vocabulary, so
//        the Auth_Failure_Cause is checked against every member of it rather than against the
//        one rival a reader happens to think of.
//     3. `decodeSampleRecord` (`app/eval/sweep/results-log.ts`) is what ADMITS a cause onto a
//        persisted record, so "collides with no Could_Not_Verify_Cause" is proven by the
//        decoder refusing all eleven of them rather than by a string comparison in this file.
//
// BOTH VOCABULARIES ARE EXHAUSTED, NOT SAMPLED
//   Each is a closed frozen array, so coverage of it is a fact a `for` loop establishes on
//   every run. fast-check is kept for the two parts that have no closed form: the provider's
//   HTTP status, and the operator-facing note text.
//
// THE NOTE TEXT IS THE TRAP THIS PROPERTY IS AIMED AT
//   The pilot classified six slots by message, so an expired key read as a network outage.
//   The note arm therefore holds the note FIXED and varies only the typed cause, including
//   notes that name the rival cause verbatim and notes at `MAX_FAILURE_NOTE_LENGTH`. If the
//   note were load-bearing anywhere on this path, the pair would come back equal.
//
// Not `propertyTag(21, ...)`: that helper's `FEATURE_TAG` is another spec's slug, whose
// Property 21 is a different claim.
//
// Validates: Requirements 7.4, 7.5
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { DEFAULT_CREDENTIAL_FILE, RefreshingSecretManager } from '@app/agent';
import {
  checkCredential,
  decodeSampleRecord,
  encodeSampleRecord,
  isDeferrableCause,
  MAX_FAILURE_NOTE_LENGTH,
  NO_VERDICT_CAUSES,
  RESULTS_SCHEMA_VERSION,
  type ModelListAnswer,
  type NoVerdictCause,
  type PreflightFailureCode,
  type SweepSampleRecord,
} from '@app/eval';
import { COULD_NOT_VERIFY_CAUSES } from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 21: A provider refusal is a cause of its own, disjoint from every other';

/** The Auth_Failure_Cause: a provider ANSWERED and refused the credential. */
const AUTH_FAILURE_CAUSE = 'provider-refused-credential' satisfies NoVerdictCause;

/** The recorded cause that names a network failure, which Req 7.5 separates it from. */
const NETWORK_CAUSE = 'provider-unreachable' satisfies NoVerdictCause;

/** The preflight outcome a credential-rejecting answer must land on. */
const REFUSED_CODE = 'credential-refused' satisfies PreflightFailureCode;

/** The preflight outcome a transport failure must land on. */
const UNREACHABLE_CODE = 'provider-unreachable' satisfies PreflightFailureCode;

/** The two statuses that mean the provider read the credential and rejected it. */
const CREDENTIAL_REJECTING_STATUSES: readonly number[] = [401, 403];

/** An obviously fake token, so the probe resolves and the answer is what decides. */
const FAKE_CREDENTIAL = 'not-a-real-token-0000';

/** The answer shape that is a transport failure rather than an answer at all. */
const TRANSPORT_FAILURE: ModelListAnswer = { kind: 'unreachable' };

/**
 * Which preflight outcome the probe reads one provider answer as.
 *
 * `null` is an acceptance. The credential is resolved through a `RefreshingSecretManager` over
 * a fake `readFile` rather than a hand-rolled port, so the probe runs its real resolve path and
 * no real file is touched.
 */
async function probeCode(answer: ModelListAnswer): Promise<PreflightFailureCode | null> {
  const failure = await checkCredential({
    secretManager: new RefreshingSecretManager({
      path: DEFAULT_CREDENTIAL_FILE,
      readFile: () => Promise.resolve(FAKE_CREDENTIAL),
    }),
    credentialFilePath: DEFAULT_CREDENTIAL_FILE,
    modelList: () => Promise.resolve(answer),
  });
  return failure === null ? null : failure.code;
}

/**
 * One deferred sample as the runner writes it, minus the two fields each arm varies.
 *
 * A `setup-failed` record, because that is the only status a transport-level cause is written
 * beside: no candidate existed, so no golden verdict, no mutation probe and no formal run. A
 * fixture stating otherwise is one the decoder refuses by a cross-field rule, which would make
 * every assertion below pass for the wrong reason.
 */
const DEFERRED_RECORD: Omit<SweepSampleRecord, 'failureNote' | 'noVerdictCause'> = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  strategyArm: 'control',
  checkingApproach: 'cycle-timed',
  designGroup: 'cycle-exact',
  testbenchPromptVersion: 4,
  simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
  testbenchParseRefusal: null,
  positiveControlRun: null,
  // No candidate existed, so no testbench was measured.
  valuelessFailureReports: null,
  configHash: 'cfg-property-21',
  armName: 'arm-a',
  modelSignature: 'zai.glm-5',
  problemId: 'rtllm/arithmetic/adder_8bit',
  sampleIndex: 0,
  seed: 1,
  passed: false,
  outcomeStatus: 'setup-failed',
  iterations: 0,
  costCents: 0,
  costKnown: true,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  unreportedUsageCalls: 0,
  stopReason: null,
  goldenVerdict: null,
  goldenFailureCount: null,
  instrumentValidity: 'unchecked',
  instrumentDefect: null,
  instrumentUncheckedReason: 'no-testbench',
  mutation: null,
  repairAttempted: false,
  repairAccepted: false,
  repairDeclineReason: null,
  checkNameVisibilitySignal: false,
  durationMs: 1_000,
  completedAtMs: 1_000,
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
};

/** One deferred record at a given note and cause. */
function recordWith(failureNote: string | null, noVerdictCause: NoVerdictCause): SweepSampleRecord {
  return { ...DEFERRED_RECORD, failureNote, noVerdictCause };
}

/** The cause a record carrying this note and cause READS BACK as, once persisted. */
function persistedCause(
  failureNote: string | null,
  noVerdictCause: NoVerdictCause,
): NoVerdictCause | null | 'undecodable' {
  const line = encodeSampleRecord(recordWith(failureNote, noVerdictCause));
  const decoded = decodeSampleRecord(JSON.parse(line));
  return decoded === null ? 'undecodable' : decoded.noVerdictCause;
}

/**
 * Note texts that would fool a message-level classifier, including the truncation case.
 *
 * Every arm names a cause the typed field does NOT carry, or buries one past
 * `MAX_FAILURE_NOTE_LENGTH` so a truncated note loses it. The empty string is excluded: the
 * decoder reads it as an absent note, which is a different fact and not this claim's.
 */
function arbFailureNote(): fc.Arbitrary<string | null> {
  const padding = fc.string({ minLength: 1, maxLength: 40 });
  return fc.oneof(
    fc.constant(null),
    padding.map((tail) => `${NETWORK_CAUSE}: ${tail}`),
    padding.map((tail) => `${AUTH_FAILURE_CAUSE}: ${tail}`),
    padding.map((head) => `${head} ALL_PROVIDERS_FAILED`),
    // At the cap, with a rival cause name past it: what a truncated note actually looks like.
    fc.constant(`${'x'.repeat(MAX_FAILURE_NOTE_LENGTH)}${NETWORK_CAUSE}`),
    padding,
  );
}

describe(PROPERTY, () => {
  it('reads a credential-rejecting answer as a refusal and a transport failure as neither', async () => {
    // Clause 1. The answer is the only input, so a rejecting answer and a transport failure
    // cannot reach the same outcome - which is the misreading the pilot's six slots were.
    const transportCode = await probeCode(TRANSPORT_FAILURE);

    expect(transportCode).toBe(UNREACHABLE_CODE);
    expect(transportCode).not.toBe(REFUSED_CODE);

    // The rejecting statuses are a closed pair, so they are EXHAUSTED rather than waited on
    // from a 500-wide draw: at 100 runs the discriminating case would otherwise be graded on
    // only about a third of runs, and it is the one the pilot's defect fails.
    for (const status of CREDENTIAL_REJECTING_STATUSES) {
      expect(await probeCode({ kind: 'reply', status }), String(status)).toBe(REFUSED_CODE);
    }

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 100, max: 599 }), async (status) => {
        const code = await probeCode({ kind: 'reply', status });
        const rejectsCredential = CREDENTIAL_REJECTING_STATUSES.includes(status);

        expect(code === REFUSED_CODE).toBe(rejectsCredential);
        if (rejectsCredential) {
          expect(code).not.toBe(transportCode);
        }
      }),
      propertyParameters(),
    );
  });

  it('carries the cause as a typed value that no note text can move', async () => {
    // Clause 2. The note is held FIXED across the pair and only the typed cause varies, so a
    // persisted cause that moved with the note would come back equal for the two halves.
    await fc.assert(
      fc.asyncProperty(arbFailureNote(), (note) => {
        expect(persistedCause(note, AUTH_FAILURE_CAUSE)).toBe(AUTH_FAILURE_CAUSE);
        expect(persistedCause(note, NETWORK_CAUSE)).toBe(NETWORK_CAUSE);
        return Promise.resolve();
      }),
      propertyParameters(),
    );
  });

  it('collides with no member of the recorded cause vocabulary but itself', () => {
    // Clause 3, over the whole closed vocabulary rather than the one rival a reader recalls.
    for (const cause of NO_VERDICT_CAUSES) {
      expect(cause === AUTH_FAILURE_CAUSE, cause).toBe(cause === 'provider-refused-credential');
    }

    // The network cause is the near miss: same deferral, different value. Equal deferrability
    // is why only the VALUE can tell an operator which remedy applies.
    expect(NETWORK_CAUSE).not.toBe(AUTH_FAILURE_CAUSE);
    expect(isDeferrableCause(AUTH_FAILURE_CAUSE)).toBe(true);
    expect(isDeferrableCause(NETWORK_CAUSE)).toBe(true);

    // Non-vacuity: the member this property is about is actually in the vocabulary, so the
    // loop above is not grading an empty set or a cause that was never added.
    expect(NO_VERDICT_CAUSES).toContain(AUTH_FAILURE_CAUSE);
  });

  it('collides with no member of the Could_Not_Verify_Cause vocabulary', () => {
    // Clause 4, proven by the decoder rather than by comparing strings here: a record whose
    // `noVerdictCause` holds a formal-oracle cause is read as carrying NO cause, so the two
    // vocabularies cannot be confused across the persistence boundary either.
    expect(COULD_NOT_VERIFY_CAUSES.length).toBeGreaterThan(0);

    for (const formalCause of COULD_NOT_VERIFY_CAUSES) {
      expect(formalCause, formalCause).not.toBe(AUTH_FAILURE_CAUSE);

      const decoded = decodeSampleRecord({
        ...recordWith(null, AUTH_FAILURE_CAUSE),
        noVerdictCause: formalCause,
      });

      expect(decoded, formalCause).not.toBeNull();
      expect(decoded?.noVerdictCause, formalCause).toBeNull();
    }

    // Non-vacuity: the decoder is not refusing every cause, only the foreign vocabulary.
    expect(persistedCause(null, AUTH_FAILURE_CAUSE)).toBe(AUTH_FAILURE_CAUSE);
  });
});
