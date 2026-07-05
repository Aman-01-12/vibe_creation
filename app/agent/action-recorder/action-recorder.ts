// The Action_Recorder: the single owner that appends ordered, sanitized Trace
// spans and reads them back (Requirements 3.1-3.6, 8.8).
//
// Responsibilities:
//   - Assign a monotonic per-session `seq` so ordering is total and stable for
//     replay. The recorder is the single writer for a session, so `seq` is owned
//     here and nowhere else; no past span is ever mutated (Req 3.1, 3.5).
//   - Redact secrets/credentials and PII from inputs AND outputs at this boundary
//     BEFORE anything is persisted, so a leaked secret or PII value can never be
//     written even if a caller passes one in (Req 3.2, 3.3).
//   - Record failure classification and recovery attempts as further spans in the
//     same Trace (Req 3.4), and carry verdict/iteration/cost in the recorded
//     outputs and cost fields (Req 8.8).
//   - Persist behind an injectable port and expose the ordered, human-readable
//     history read (Req 3.5, 3.6).

import {
  newUlid,
  type FailureClass,
  type Json,
  type Trace,
  type TraceSpan,
  type Ulid,
} from '@app/core';

import { renderHistory, type HistoryEntry } from './history.js';
import type { TracePersistencePort } from './persistence-port.js';
import { redactJson } from './redaction.js';

/**
 * The unsanitized description of a step a caller asks to record.
 *
 * The caller supplies RAW `inputs` and `outputs`; the recorder redacts both
 * before persistence, which is why this type is distinct from the persisted
 * `TraceSpan` (whose `sanitizedInputs` is already clean). The caller does NOT
 * supply `seq`: it is owned and assigned by the recorder.
 */
export interface SpanDraft {
  /** Optional explicit span id; a fresh ULID is generated when omitted. */
  readonly id?: Ulid;
  readonly sessionId: Ulid;
  readonly stageOrTool: string;
  /** Raw inputs; redacted before persistence. */
  readonly inputs: Json;
  /** Raw outputs (may carry a verdict, iteration count, etc.); redacted before persistence. */
  readonly outputs: Json;
  readonly exitCode: number | null;
  /** ISO-8601 start timestamp. */
  readonly startedAt: string;
  readonly durationMs: number;
  readonly retryCount: number;
  readonly costCents: number;
  /** Set on a failed step to record its classification (Req 3.4). */
  readonly failureClass?: FailureClass;
  /** Set when this step attempts to recover an earlier failed step (Req 3.4). */
  readonly recoveryOf?: Ulid;
}

/** Appends ordered, sanitized Trace spans and reads the Trace back for replay. */
export interface ActionRecorder {
  /** Sanitize, order, and persist one step; resolves with the persisted span. */
  record(draft: SpanDraft): Promise<TraceSpan>;
  /** Load the ordered, replayable Trace for a session. */
  getTrace(sessionId: Ulid): Promise<Trace>;
  /** Read the ordered, human-readable step history for a session (Req 3.6). */
  getHistory(sessionId: Ulid): Promise<readonly HistoryEntry[]>;
}

/** Build the persisted, sanitized span from a draft and its assigned `seq`. */
function buildSanitizedSpan(draft: SpanDraft, seq: number, newId: () => Ulid): TraceSpan {
  const base = {
    id: draft.id ?? newId(),
    sessionId: draft.sessionId,
    seq,
    stageOrTool: draft.stageOrTool,
    sanitizedInputs: redactJson(draft.inputs),
    outputs: redactJson(draft.outputs),
    exitCode: draft.exitCode,
    startedAt: draft.startedAt,
    durationMs: draft.durationMs,
    retryCount: draft.retryCount,
    costCents: draft.costCents,
  };
  const withFailure =
    draft.failureClass === undefined ? base : { ...base, failureClass: draft.failureClass };
  return draft.recoveryOf === undefined
    ? withFailure
    : { ...withFailure, recoveryOf: draft.recoveryOf };
}

/**
 * The default Action_Recorder, persisting through an injected `TracePersistencePort`.
 *
 * `seq` is assigned synchronously from a per-session counter before any `await`,
 * so concurrent `record` calls always receive distinct, increasing values.
 * Persistence writes for a session are chained so spans reach the port in
 * ascending `seq` order; a failed write is surfaced to its caller without
 * poisoning subsequent writes for that session.
 */
export class TraceActionRecorder implements ActionRecorder {
  readonly #persistence: TracePersistencePort;
  readonly #newId: () => Ulid;
  readonly #nextSeq = new Map<Ulid, number>();
  readonly #appendTails = new Map<Ulid, Promise<void>>();

  constructor(persistence: TracePersistencePort, newId: () => Ulid = newUlid) {
    this.#persistence = persistence;
    this.#newId = newId;
  }

  async record(draft: SpanDraft): Promise<TraceSpan> {
    const seq = this.#assignSeq(draft.sessionId);
    const span = buildSanitizedSpan(draft, seq, this.#newId);
    await this.#appendInOrder(span);
    return span;
  }

  getTrace(sessionId: Ulid): Promise<Trace> {
    return this.#persistence.loadTrace(sessionId);
  }

  async getHistory(sessionId: Ulid): Promise<readonly HistoryEntry[]> {
    const trace = await this.#persistence.loadTrace(sessionId);
    return renderHistory(trace);
  }

  /** Reserve the next monotonic `seq` for a session (synchronous, race-free). */
  #assignSeq(sessionId: Ulid): number {
    const next = this.#nextSeq.get(sessionId) ?? 0;
    this.#nextSeq.set(sessionId, next + 1);
    return next;
  }

  /** Chain persistence writes per session so spans are stored in `seq` order. */
  async #appendInOrder(span: TraceSpan): Promise<void> {
    const previous = this.#appendTails.get(span.sessionId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => this.#persistence.appendSpan(span));
    this.#appendTails.set(
      span.sessionId,
      write.catch(() => undefined),
    );
    await write;
  }
}
