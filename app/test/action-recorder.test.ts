// Example unit tests for the Action_Recorder (task 4.1).
//
// These are concrete example checks of the recorder's core behavior: boundary
// redaction of secrets and PII, monotonic single-owner ordering, recovery/failure
// spans in the same Trace, post-session replay, and the human-readable history
// read. The universal Property 12 (ordered, complete, PII-redacted) is a separate
// fast-check property in task 4.2; these examples complement it.

import { describe, expect, it } from 'vitest';

import {
  InMemoryTracePersistence,
  PII_PLACEHOLDER,
  SECRET_PLACEHOLDER,
  TraceActionRecorder,
  containsEmail,
  containsSecret,
  formatHistoryLines,
  redactJson,
  type SpanDraft,
} from '@app/agent';
import { newUlid, type Json } from '@app/core';

/** A minimal, valid draft with benign payloads; override per test. */
function draft(overrides: Partial<SpanDraft> & Pick<SpanDraft, 'sessionId'>): SpanDraft {
  return {
    stageOrTool: 'Model_Router',
    inputs: {},
    outputs: {},
    exitCode: 0,
    startedAt: '2025-01-01T00:00:00.000Z',
    durationMs: 5,
    retryCount: 0,
    costCents: 0,
    ...overrides,
  };
}

describe('redactJson', () => {
  it('replaces secret-shaped tokens wherever they appear in strings', () => {
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const result = redactJson({ note: `key is ${secret} - keep safe` });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain(SECRET_PLACEHOLDER);
    expect(containsSecret(JSON.stringify(result))).toBe(false);
  });

  it('redacts values under sensitive keys regardless of their shape', () => {
    const result = redactJson({ apiKey: 'plainish-value', password: 12345 });

    expect(result).toEqual({ apiKey: SECRET_PLACEHOLDER, password: SECRET_PLACEHOLDER });
  });

  it('redacts email PII by value and by field name', () => {
    const result = redactJson({
      body: 'contact me at jane.doe@example.com please',
      email: 'someone@else.org',
    });

    const serialized = JSON.stringify(result);
    expect(containsEmail(serialized)).toBe(false);
    expect(serialized).toContain(PII_PLACEHOLDER);
  });

  it('recurses through arrays and nested objects and leaves benign data intact', () => {
    const result = redactJson({ ports: [{ name: 'clk', width: 1 }], goal: 'counter' });

    expect(result).toEqual({ ports: [{ name: 'clk', width: 1 }], goal: 'counter' });
  });
});

describe('TraceActionRecorder ordering and ownership', () => {
  it('assigns a monotonic seq starting at 0 across sequential records', async () => {
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const sessionId = newUlid();

    const first = await recorder.record(draft({ sessionId }));
    const second = await recorder.record(draft({ sessionId }));
    const third = await recorder.record(draft({ sessionId }));

    expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
  });

  it('keeps per-session seq independent across sessions', async () => {
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const sessionA = newUlid();
    const sessionB = newUlid();

    const a0 = await recorder.record(draft({ sessionId: sessionA }));
    const b0 = await recorder.record(draft({ sessionId: sessionB }));

    expect(a0.seq).toBe(0);
    expect(b0.seq).toBe(0);
  });

  it('assigns distinct increasing seq to concurrently issued records', async () => {
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const sessionId = newUlid();

    const spans = await Promise.all(
      Array.from({ length: 25 }, () => recorder.record(draft({ sessionId }))),
    );

    const seqs = spans.map((span) => span.seq).sort((left, right) => left - right);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_unused, index) => index));
  });
});

describe('TraceActionRecorder persistence and boundary redaction', () => {
  it('persists only sanitized inputs and outputs', async () => {
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const sessionId = newUlid();

    await recorder.record(
      draft({
        sessionId,
        inputs: { prompt: 'use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
        outputs: { student: 'aria@example.com', verdict: 'pass' },
      }),
    );

    const trace = await recorder.getTrace(sessionId);
    const serialized = JSON.stringify(trace);
    expect(containsSecret(serialized)).toBe(false);
    expect(containsEmail(serialized)).toBe(false);
    // Benign, non-sensitive output survives redaction so the Trace stays useful.
    expect(serialized).toContain('pass');
  });

  it('replays the full ordered Trace after the session ends', async () => {
    const persistence = new InMemoryTracePersistence();
    const sessionId = newUlid();

    // A recorder used only for the "live" session, then discarded.
    const live = new TraceActionRecorder(persistence);
    await live.record(draft({ sessionId, stageOrTool: 'Intent_Agent' }));
    await live.record(draft({ sessionId, stageOrTool: 'Spec_Agent' }));

    // A fresh reader over the same persistence replays the completed session.
    const replayed = await new TraceActionRecorder(persistence).getTrace(sessionId);
    expect(replayed.spans.map((span) => span.stageOrTool)).toEqual(['Intent_Agent', 'Spec_Agent']);
    expect(replayed.spans.map((span) => span.seq)).toEqual([0, 1]);
  });
});

describe('TraceActionRecorder failure and recovery spans (Req 3.4)', () => {
  it('records failure classification and a linked recovery attempt in the same Trace', async () => {
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const sessionId = newUlid();

    const failed = await recorder.record(
      draft({ sessionId, stageOrTool: 'Simulator', exitCode: 1, failureClass: 'compile-error' }),
    );
    await recorder.record(
      draft({ sessionId, stageOrTool: 'Generation_Agent', recoveryOf: failed.id, retryCount: 1 }),
    );

    const trace = await recorder.getTrace(sessionId);
    expect(trace.spans[0]?.failureClass).toBe('compile-error');
    expect(trace.spans[1]?.recoveryOf).toBe(failed.id);
  });
});

describe('history read (Req 3.6)', () => {
  it('renders an ordered, human-readable list of steps and results', async () => {
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const sessionId = newUlid();

    await recorder.record(draft({ sessionId, stageOrTool: 'Intent_Agent', exitCode: 0 }));
    await recorder.record(
      draft({ sessionId, stageOrTool: 'Simulator', exitCode: 1, failureClass: 'functional-fail' }),
    );

    const history = await recorder.getHistory(sessionId);
    expect(history.map((entry) => entry.step)).toEqual(['Intent_Agent', 'Simulator']);
    expect(history[0]?.result).toBe('ok');
    expect(history[1]?.result).toBe('failed (functional-fail)');

    const trace = await recorder.getTrace(sessionId);
    const lines = formatHistoryLines(trace);
    expect(lines[0]).toContain('#0 Intent_Agent: ok');
    expect(lines[1]).toContain('#1 Simulator: failed (functional-fail)');
  });
});
// The formal gate step's rendering (task 23.1, Requirements 1.19 and 1.20).
//
// The Session_History is the live surface a Student can be shown, and before this it
// rendered a `could-not-verify` formal step as `completed` - exactly like a fully proved
// one - because the span carries no failure class. These are the two example checks that
// fail if that rendering regresses. The universal Property 19 over the real
// Verification_Loop is `app/test/formal-label-fail-closed.property.test.ts`.

/** One formal gate span's outputs, shaped as `#recordFormalRun` in the loop writes them. */
function formalOutputs(
  properties: readonly { readonly verdict: string; readonly cause: string | null }[],
): Json {
  return {
    stage: 'Formal_Oracle',
    properties: properties.map((property, index) => ({
      criterionRef: `c${index}`,
      verdict: property.verdict,
      cause: property.cause,
      depth: 20,
      elapsedMs: 10,
    })),
  };
}

/** Record one `Formal_Oracle` span and read back how the history rendered it. */
async function renderFormalStep(outputs: Json): Promise<string | undefined> {
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const sessionId = newUlid();
  await recorder.record(
    draft({
      sessionId,
      stageOrTool: 'Formal_Oracle',
      // `null` is what the loop records: a formal run reports no process exit code, and it
      // is the value that made this step render as `completed`.
      exitCode: null,
      outputs,
    }),
  );
  const history = await recorder.getHistory(sessionId);
  return history[0]?.result;
}

describe('formal gate step rendering (Req 1.19, 1.20)', () => {
  it('renders the count under each verdict and every could-not-verify cause in words', async () => {
    const proved = await renderFormalStep(
      formalOutputs([
        { verdict: 'proved', cause: null },
        { verdict: 'proved', cause: null },
      ]),
    );
    const unverified = await renderFormalStep(
      formalOutputs([
        { verdict: 'proved', cause: null },
        { verdict: 'proved', cause: null },
        { verdict: 'could-not-verify', cause: 'proof-timeout' },
      ]),
    );
    const refuted = await renderFormalStep(
      formalOutputs([
        { verdict: 'proved', cause: null },
        { verdict: 'proved', cause: null },
        { verdict: 'refuted', cause: null },
      ]),
    );

    expect(proved).toBe('formal: 2 proved');
    expect(unverified).toBe('formal: 2 proved, 1 could not verify (proof timed out)');
    expect(refuted).toBe('formal: 2 proved, 1 refuted');
    // The three read distinctly from each other, and none reads as a bare `completed`.
    expect(new Set([proved, unverified, refuted]).size).toBe(3);
    expect([proved, unverified, refuted]).not.toContain('completed');
  });

  it('renders outputs it cannot read as per-property verdicts as unreadable, never completed', async () => {
    // Every way the read can fail: no property list, a verdict outside the vocabulary, and a
    // `could-not-verify` whose cause is outside its own vocabulary (Req 1.5, 1.20).
    const unreadable = await Promise.all([
      renderFormalStep({ stage: 'Formal_Oracle' }),
      renderFormalStep(formalOutputs([{ verdict: 'passed', cause: null }])),
      renderFormalStep(formalOutputs([{ verdict: 'could-not-verify', cause: 'gremlins' }])),
      renderFormalStep(formalOutputs([{ verdict: 'could-not-verify', cause: null }])),
    ]);

    for (const result of unreadable) {
      expect(result).toBe('formal: unreadable outputs');
    }
  });
});
