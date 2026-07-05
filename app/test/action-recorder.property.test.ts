// Property 12 for the Action_Recorder: Traces are ordered, complete, and
// PII-redacted (task 4.2).
//
// This is the universal complement to the concrete examples in
// `action-recorder.test.ts`. Over generated sequences of raw `SpanDraft`s
// recorded into a FRESH recorder, it asserts the four guarantees the design
// binds to Property 12:
//
//   - Ordering: spans read back carry a monotonic `seq` (0..N-1) in append
//     order, even when the drafts are issued concurrently (Req 3.1, 3.5).
//   - Completeness: every persisted span carries all required fields, and a
//     failed step's classification plus any recovery link live in the same
//     Trace (Req 3.1, 3.4, 8.8).
//   - Redaction: secret-shaped tokens and email PII embedded in the raw inputs
//     and outputs never survive into the persisted Trace; they are replaced by
//     the fixed placeholders BEFORE persistence (Req 3.3).
//   - Replayability: the human-readable history read is ordered and consistent
//     with the Trace (Req 3.5, and the Req 3.6 read path).
//
// The property needs no fixed clock: ordering, completeness, and redaction are
// all shape assertions over the generated timestamps/costs the drafts carry, so
// a fresh recorder + in-memory persistence per run gives full independence.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemoryTracePersistence,
  PII_PLACEHOLDER,
  SECRET_PLACEHOLDER,
  TraceActionRecorder,
  containsEmail,
  containsSecret,
  redactJson,
  type SpanDraft,
} from '@app/agent';
import type { FailureClass, Json, Ulid } from '@app/core';
import {
  propertyParameters,
  propertyTag,
  secretEmbeddedInTextArbitrary,
  secretShapedTokenArbitrary,
} from '@app/test';

// --- Local character helpers -------------------------------------------------
// The shared secret generators are reused directly; emails and benign filler
// have no shared generator, so they are built here from explicit, redaction-safe
// alphabets. Every benign alphabet below deliberately excludes the characters
// the redaction patterns key on (`@`, `.`, `-`, `_`, and uppercase), so a benign
// value can never accidentally look like a secret or an email and make the
// "no raw secret survives" assertion vacuous or flaky.

const LOWER: readonly string[] = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS: readonly string[] = '0123456789'.split('');
/** Crockford base32 (no I, L, O, U): the ULID alphabet, safe from every pattern. */
const CROCKFORD: readonly string[] = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');

/** An arbitrary string of length `[min, max]` drawn from an explicit alphabet. */
function fromChars(chars: readonly string[], min: number, max: number): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('fromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: min, maxLength: max })
    .map((picked) => picked.join(''));
}

// --- Domain-shaped generators ------------------------------------------------

/** Every spine stage / tool name the recorder is expected to carry. */
const STAGE_OR_TOOL_NAMES: readonly string[] = [
  'Intent_Agent',
  'Spec_Agent',
  'Generation_Agent',
  'Testbench_Agent',
  'Simulator',
  'Model_Router',
  'Verification_Loop',
  'Knowledge_Retriever',
];

/** The closed set of failure classifications a failed span may record. */
const FAILURE_CLASSES: readonly FailureClass[] = [
  'compile-error',
  'functional-fail',
  'timeout',
  'tool-error',
  'sandbox-denied',
];

/** A syntactically valid, redaction-safe ULID-shaped identifier. */
function ulidArbitrary(): fc.Arbitrary<Ulid> {
  return fc
    .tuple(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7'), fromChars(CROCKFORD, 25, 25))
    .map(([head, rest]) => `${head}${rest}`);
}

/** An email address that matches the recorder's PII pattern. */
function emailArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fromChars([...LOWER, ...DIGITS], 1, 10),
      fromChars([...LOWER, ...DIGITS], 1, 8),
      fromChars(LOWER, 2, 4),
    )
    .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);
}

/** An email embedded in benign filler, as it would appear in free text. */
function emailInTextArbitrary(): fc.Arbitrary<string> {
  const filler = fromChars([...LOWER, ' '], 0, 20);
  return fc
    .tuple(filler, emailArbitrary(), filler)
    .map(([lead, email, trail]) => `${lead} ${email} ${trail}`.trim());
}

/** A string that always carries a secret-shaped token (bare or embedded). */
function secretBearingArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(secretShapedTokenArbitrary(), secretEmbeddedInTextArbitrary());
}

/** A string that always carries an email address (bare or embedded). */
function emailBearingArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(emailArbitrary(), emailInTextArbitrary());
}

/** A benign JSON leaf whose string values can never look like a secret or email. */
const benignLeafArbitrary: fc.Arbitrary<Json> = fc
  .oneof(
    fromChars([...LOWER, ...DIGITS, ' '], 0, 12),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.boolean(),
    fc.constant(null),
  )
  .map((value): Json => value);

/** Object keys drawn from the same redaction-safe alphabet as benign values. */
const benignKeyArbitrary: fc.Arbitrary<string> = fromChars([...LOWER, ...DIGITS], 1, 6);

/** A bounded-depth benign JSON value (objects, arrays, and leaves). */
function benignJsonArbitrary(depth: number): fc.Arbitrary<Json> {
  if (depth <= 0) {
    return benignLeafArbitrary;
  }
  const child = benignJsonArbitrary(depth - 1);
  return fc.oneof(
    benignLeafArbitrary,
    fc.array(child, { maxLength: 4 }).map((value): Json => value),
    fc.dictionary(benignKeyArbitrary, child, { maxKeys: 4 }).map((value): Json => value),
  );
}

/**
 * Raw inputs that ALWAYS embed a secret and an email (by value, and once under a
 * sensitive key), so redaction is exercised on every iteration rather than only
 * when a random value happens to look sensitive.
 */
function sensitiveInputsArbitrary(): fc.Arbitrary<Json> {
  return fc
    .record({
      note: secretBearingArbitrary(),
      contact: emailBearingArbitrary(),
      creds: fc.record({
        apiKey: benignLeafArbitrary,
        password: fc.integer({ min: 0, max: 99_999 }),
      }),
      payload: benignJsonArbitrary(2),
    })
    .map((value): Json => value);
}

/**
 * Raw outputs that embed a secret and an email alongside a benign `verdict`, so
 * the property also proves benign, non-sensitive output survives redaction.
 */
function sensitiveOutputsArbitrary(): fc.Arbitrary<Json> {
  return fc
    .record({
      verdict: fc.constantFrom('pass', 'fail', 'error'),
      token: secretBearingArbitrary(),
      reporter: emailBearingArbitrary(),
      detail: benignJsonArbitrary(2),
    })
    .map((value): Json => value);
}

/** An ISO-8601 timestamp within a sane bounded range. */
function isoTimestampArbitrary(): fc.Arbitrary<string> {
  return fc.integer({ min: 0, max: 4_102_444_800_000 }).map((ms) => new Date(ms).toISOString());
}

/** The raw, nullable fields fast-check produces before optional keys are shaped. */
interface RawDraftFields {
  readonly stageOrTool: string;
  readonly inputs: Json;
  readonly outputs: Json;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly retryCount: number;
  readonly costCents: number;
  readonly failureClass: FailureClass | null;
  readonly recoveryOf: Ulid | null;
}

/**
 * Assemble a `SpanDraft`, including the optional `failureClass`/`recoveryOf`
 * keys only when present so `exactOptionalPropertyTypes` stays satisfied.
 */
function buildDraft(sessionId: Ulid, raw: RawDraftFields): SpanDraft {
  const base: SpanDraft = {
    sessionId,
    stageOrTool: raw.stageOrTool,
    inputs: raw.inputs,
    outputs: raw.outputs,
    exitCode: raw.exitCode,
    startedAt: raw.startedAt,
    durationMs: raw.durationMs,
    retryCount: raw.retryCount,
    costCents: raw.costCents,
  };
  const withFailure =
    raw.failureClass === null ? base : { ...base, failureClass: raw.failureClass };
  return raw.recoveryOf === null ? withFailure : { ...withFailure, recoveryOf: raw.recoveryOf };
}

/** One raw, unsanitized draft for a given session. */
function draftArbitrary(sessionId: Ulid): fc.Arbitrary<SpanDraft> {
  return fc
    .record<RawDraftFields>({
      stageOrTool: fc.constantFrom(...STAGE_OR_TOOL_NAMES),
      inputs: sensitiveInputsArbitrary(),
      outputs: sensitiveOutputsArbitrary(),
      exitCode: fc.option(fc.integer({ min: 0, max: 255 }), { nil: null }),
      startedAt: isoTimestampArbitrary(),
      durationMs: fc.nat({ max: 600_000 }),
      retryCount: fc.nat({ max: 5 }),
      costCents: fc.nat({ max: 100_000 }),
      failureClass: fc.option(fc.constantFrom(...FAILURE_CLASSES), { nil: null }),
      recoveryOf: fc.option(ulidArbitrary(), { nil: null }),
    })
    .map((raw) => buildDraft(sessionId, raw));
}

/** A whole scenario: one session and a non-empty sequence of drafts for it. */
interface TraceScenario {
  readonly sessionId: Ulid;
  readonly drafts: readonly SpanDraft[];
}

function traceScenarioArbitrary(): fc.Arbitrary<TraceScenario> {
  return ulidArbitrary().chain((sessionId) =>
    fc
      .array(draftArbitrary(sessionId), { minLength: 1, maxLength: 12 })
      .map((drafts) => ({ sessionId, drafts })),
  );
}

// --- The property ------------------------------------------------------------

describe('Action_Recorder Trace (Property 12)', () => {
  // Feature: hdl-creation-loop, Property 12: Traces are ordered, complete, and PII-redacted
  it('records ordered, complete, PII-redacted, replayable Traces', async () => {
    await fc.assert(
      fc.asyncProperty(traceScenarioArbitrary(), async ({ sessionId, drafts }) => {
        // Fresh recorder + persistence per run: full independence between runs.
        const recorder = new TraceActionRecorder(new InMemoryTracePersistence());

        // Issue every record concurrently to exercise interleaving; `seq` is
        // assigned synchronously in call order, so append order is stable.
        const recorded = await Promise.all(drafts.map((draft) => recorder.record(draft)));
        const trace = await recorder.getTrace(sessionId);
        const history = await recorder.getHistory(sessionId);

        // Ordering + completeness: one span per draft, in order, monotonic seq.
        expect(trace.spans).toHaveLength(drafts.length);
        expect(recorded).toStrictEqual(trace.spans);

        trace.spans.forEach((span, index) => {
          const draft = drafts[index];
          expect(draft).toBeDefined();
          if (draft === undefined) {
            return;
          }

          // Ordering: monotonic, gapless, ascending seq bound to this session.
          expect(span.seq).toBe(index);
          expect(span.sessionId).toBe(sessionId);

          // Completeness: every required field is present with the right shape.
          expect(typeof span.stageOrTool).toBe('string');
          expect(span.stageOrTool.length).toBeGreaterThan(0);
          expect(span.stageOrTool).toBe(draft.stageOrTool);
          expect(span.exitCode).toBe(draft.exitCode);
          expect(span.startedAt).toBe(draft.startedAt);
          expect(typeof span.durationMs).toBe('number');
          expect(span.durationMs).toBe(draft.durationMs);
          expect(typeof span.retryCount).toBe('number');
          expect(span.retryCount).toBe(draft.retryCount);
          expect(typeof span.costCents).toBe('number');
          expect(span.costCents).toBe(draft.costCents);

          // Boundary redaction: persisted payloads equal the redacted originals,
          // proving redaction ran before persistence and benign data survived.
          expect(span.sanitizedInputs).toStrictEqual(redactJson(draft.inputs));
          expect(span.outputs).toStrictEqual(redactJson(draft.outputs));

          // Failure classification and recovery link recorded in the same Trace.
          expect(span.failureClass).toBe(draft.failureClass);
          expect(span.recoveryOf).toBe(draft.recoveryOf);
        });

        // Redaction (whole Trace): no raw secret or email survives, and the
        // placeholders are present, so the check is non-vacuous.
        const serializedTrace = JSON.stringify(trace);
        expect(containsSecret(serializedTrace)).toBe(false);
        expect(containsEmail(serializedTrace)).toBe(false);
        expect(serializedTrace).toContain(SECRET_PLACEHOLDER);
        expect(serializedTrace).toContain(PII_PLACEHOLDER);

        // Replayability: the history read is ordered and consistent with the Trace.
        expect(history).toHaveLength(trace.spans.length);
        history.forEach((entry, index) => {
          const span = trace.spans[index];
          expect(span).toBeDefined();
          if (span === undefined) {
            return;
          }
          expect(entry.seq).toBe(span.seq);
          expect(entry.step).toBe(span.stageOrTool);
          expect(entry.durationMs).toBe(span.durationMs);
          expect(entry.retryCount).toBe(span.retryCount);
          expect(entry.costCents).toBe(span.costCents);
          expect(entry.recoveryOf).toBe(span.recoveryOf);
        });
        const historySeqs = history.map((entry) => entry.seq);
        expect(historySeqs).toStrictEqual([...historySeqs].sort((left, right) => left - right));
        expect(containsSecret(JSON.stringify(history))).toBe(false);
        expect(containsEmail(JSON.stringify(history))).toBe(false);
      }),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 12 tag is asserted, not just written in a
// comment: `Feature: hdl-creation-loop, Property 12: Traces are ordered, complete, and PII-redacted`.
describe('Property 12 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(propertyTag(12, 'Traces are ordered, complete, and PII-redacted')).toBe(
      'Feature: hdl-creation-loop, Property 12: Traces are ordered, complete, and PII-redacted',
    );
  });
});
