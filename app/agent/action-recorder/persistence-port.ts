// Persistence port for the Action_Recorder, plus an in-memory implementation
// (Requirement 3.5).
//
// The Action_Recorder persists a Trace behind this port so the concrete durable
// store (Neon/Postgres via the Project_Store, task 12.1) can be injected later
// without touching the recorder. The port stores only already-sanitized spans:
// redaction happens in the recorder before a span reaches this seam, so no
// implementation of this port ever sees a raw secret or PII value.
//
// The in-memory implementation is sufficient for post-session replay and the
// human-readable history read, so task 4.1 is self-contained and testable
// without a database.

import type { Trace, TraceSpan, Ulid } from '@app/core';

/**
 * Durable, append-only storage for Trace spans, keyed by session.
 *
 * Spans arrive already sanitized and carry a monotonic `seq` assigned by their
 * single owner (the Action_Recorder). An implementation MUST preserve total,
 * stable ordering by `seq` and MUST NOT mutate a previously stored span.
 */
export interface TracePersistencePort {
  /**
   * Append one sanitized span. A span whose `seq` is less than or equal to the
   * last stored span for its session is a stale or duplicate delivery and is
   * discarded, so ordering stays total and stable (see `TraceSpan.seq`).
   */
  appendSpan(span: TraceSpan): Promise<void>;

  /** Load the ordered Trace for a session; an unknown session yields an empty Trace. */
  loadTrace(sessionId: Ulid): Promise<Trace>;

  /** The highest `seq` stored for a session, or `-1` when none exists yet. */
  lastSeq(sessionId: Ulid): Promise<number>;
}

/**
 * An in-memory `TracePersistencePort` for local runs, replay, and tests.
 *
 * Spans are held per session in append order. Because the recorder delivers
 * spans in strictly ascending `seq`, the discard-stale rule only ever drops a
 * genuine duplicate, never a distinct span.
 */
export class InMemoryTracePersistence implements TracePersistencePort {
  readonly #spansBySession = new Map<Ulid, TraceSpan[]>();

  appendSpan(span: TraceSpan): Promise<void> {
    const spans = this.#spansBySession.get(span.sessionId) ?? [];
    const last = spans.at(-1);
    if (last !== undefined && span.seq <= last.seq) {
      return Promise.resolve();
    }
    spans.push(span);
    this.#spansBySession.set(span.sessionId, spans);
    return Promise.resolve();
  }

  loadTrace(sessionId: Ulid): Promise<Trace> {
    const spans = this.#spansBySession.get(sessionId) ?? [];
    return Promise.resolve({ sessionId, spans: [...spans] });
  }

  lastSeq(sessionId: Ulid): Promise<number> {
    const spans = this.#spansBySession.get(sessionId) ?? [];
    const last = spans.at(-1);
    return Promise.resolve(last === undefined ? -1 : last.seq);
  }
}
