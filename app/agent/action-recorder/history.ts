// Ordered, human-readable session history (Requirement 3.6).
//
// This is a read-only projection over the persisted Trace, distinct from raw
// persistence: it turns the ordered spans of a session into a compact list of
// steps and their results that the Editor can show a Student. It derives its
// fields from already-sanitized span data and adds no new state.

import type { Trace, TraceSpan, Ulid } from '@app/core';

/** One step of a session rendered for a human reader. */
export interface HistoryEntry {
  /** Monotonic position in the session, ascending. */
  readonly seq: number;
  /** The spine stage or tool this step ran. */
  readonly step: string;
  /** A short human-readable outcome, e.g. `ok`, `failed (timeout)`, `exit 1`. */
  readonly result: string;
  /** ISO-8601 start timestamp. */
  readonly startedAt: string;
  readonly durationMs: number;
  readonly retryCount: number;
  readonly costCents: number;
  /** Present when this step was a recovery attempt for an earlier failed step. */
  readonly recoveryOf?: Ulid;
}

/** Derive a short, human-readable outcome label from a span's recorded result. */
function describeResult(span: TraceSpan): string {
  if (span.failureClass !== undefined) {
    return `failed (${span.failureClass})`;
  }
  if (span.exitCode === null) {
    return 'completed';
  }
  return span.exitCode === 0 ? 'ok' : `exit ${span.exitCode}`;
}

/** Project one span into a history entry, carrying `recoveryOf` only when set. */
function toHistoryEntry(span: TraceSpan): HistoryEntry {
  const base = {
    seq: span.seq,
    step: span.stageOrTool,
    result: describeResult(span),
    startedAt: span.startedAt,
    durationMs: span.durationMs,
    retryCount: span.retryCount,
    costCents: span.costCents,
  };
  return span.recoveryOf === undefined ? base : { ...base, recoveryOf: span.recoveryOf };
}

/**
 * Render a Trace as an ordered list of history entries.
 *
 * Spans are already stored ascending by `seq`; this preserves that order so the
 * completed session can be read back step by step.
 */
export function renderHistory(trace: Trace): readonly HistoryEntry[] {
  return trace.spans.map(toHistoryEntry);
}

/** Format one history entry as a single stable, human-readable line. */
export function formatHistoryLine(entry: HistoryEntry): string {
  const recovery = entry.recoveryOf === undefined ? '' : ` (recovery of ${entry.recoveryOf})`;
  return `#${entry.seq} ${entry.step}: ${entry.result} [${entry.durationMs}ms, ${entry.retryCount} retries, ${entry.costCents}c]${recovery}`;
}

/** Render a Trace as ordered, human-readable text lines, one step per line. */
export function formatHistoryLines(trace: Trace): readonly string[] {
  return renderHistory(trace).map(formatHistoryLine);
}
