// The replayable action trace: an ordered set of recorded spans per session.
//
// Spans are append-only and carry a monotonic `seq` for ordering; stale updates
// (seq <= current) are discarded by the writer (Action_Recorder, task 4). Inputs
// are sanitized and PII-redacted before persistence, so `sanitizedInputs` holds
// only already-cleaned JSON.

import type { FailureClass } from './enums.js';
import type { Ulid } from './identifier.js';

/**
 * An immutable JSON value.
 *
 * Arrays and objects are `readonly`, so a persisted span payload cannot be
 * mutated in place after recording.
 */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** One recorded step in a session: a spine stage or a tool invocation. */
export interface TraceSpan {
  readonly id: Ulid;
  readonly sessionId: Ulid;
  /** Monotonic ordering key; stale updates (seq <= current) are discarded. */
  readonly seq: number;
  /** The spine stage or tool name this span records. */
  readonly stageOrTool: string;
  /** Inputs with secrets and PII already excluded before persistence. */
  readonly sanitizedInputs: Json;
  readonly outputs: Json;
  readonly exitCode: number | null;
  /** ISO-8601 timestamp. */
  readonly startedAt: string;
  readonly durationMs: number;
  readonly retryCount: number;
  readonly costCents: number;
  /** Present only on a failed span. */
  readonly failureClass?: FailureClass;
  /** The span id this span attempts to recover, when it is a recovery attempt. */
  readonly recoveryOf?: Ulid;
}

/** The ordered, replayable set of spans recorded for one session. */
export interface Trace {
  readonly sessionId: Ulid;
  readonly spans: readonly TraceSpan[];
}
