// The Editor's view state and the pure reducer that folds gateway stream events
// into it (Design: Components and Interfaces, Editor; Req 1.1, 17.6).
//
// The state machine is deliberately tiny and framework-agnostic: a render layer
// (or M1's React surface) subscribes to state changes while the stream consumer
// drives transitions. Keeping the reducer pure makes the streaming behavior
// unit-testable against a fake event source with no browser.
//
// Security posture (security-sensitive steering): every field of a streamed
// event's `data` is UNTRUSTED and DISPLAY-ONLY. The reducer never derives a
// trust label or correctness claim itself - the server owns the verdict. A
// malformed or missing verdict fails safe to `error`, never to `pass`.

import type { GatewayStreamEvent } from '@app/api';
import type { Verdict } from '@app/core';

/** One streamed progress line, tagged with the event `seq` it arrived on. */
export interface ProgressEntry {
  readonly seq: number;
  readonly message: string;
}

/** The lifecycle phase of a single skeleton simulation run. */
export type EditorPhase = 'idle' | 'running' | 'passed' | 'failed' | 'errored';

/** The terminal outcome, present only once a run reaches a terminal phase. */
export interface EditorOutcome {
  readonly verdict: Verdict;
  /** A human-readable, display-only summary derived from the terminal event. */
  readonly detail: string;
}

/**
 * The complete, immutable view state.
 *
 * `lastEventId` is the highest `seq` observed so far; it is the resumable-stream
 * cursor the consumer would replay from via Last-Event-ID (OD-6). `outcome` is
 * non-null iff `phase` is terminal.
 */
export interface EditorViewState {
  readonly phase: EditorPhase;
  readonly progress: readonly ProgressEntry[];
  readonly lastEventId: number | null;
  readonly outcome: EditorOutcome | null;
}

/** The starting state before any event is observed. */
export function initialEditorViewState(): EditorViewState {
  return { phase: 'idle', progress: [], lastEventId: null, outcome: null };
}

/** A phase is terminal once a verdict or error has been rendered. */
export function isTerminalPhase(phase: EditorPhase): boolean {
  return phase === 'passed' || phase === 'failed' || phase === 'errored';
}

/**
 * Fold one gateway event into the next view state (pure, total).
 *
 * Late events after a terminal phase are ignored defensively: a well-behaved
 * server sends exactly one terminal event, but the reducer must not corrupt a
 * settled verdict if the transport delivers a stray frame.
 */
export function applyStreamEvent(
  state: EditorViewState,
  event: GatewayStreamEvent,
): EditorViewState {
  if (isTerminalPhase(state.phase)) {
    return state;
  }
  switch (event.kind) {
    case 'progress':
      return applyProgress(state, event);
    case 'result':
      return applyResult(state, event);
    case 'error':
      return applyError(state, event);
    default:
      return assertNever(event.kind);
  }
}

/** Append a progress line and move to (or stay in) the running phase. */
function applyProgress(state: EditorViewState, event: GatewayStreamEvent): EditorViewState {
  const entry: ProgressEntry = { seq: event.seq, message: readMessage(event.data, 'working') };
  return {
    phase: 'running',
    progress: [...state.progress, entry],
    lastEventId: event.seq,
    outcome: null,
  };
}

/** Settle on the server's verdict; an unreadable verdict fails safe to `error`. */
function applyResult(state: EditorViewState, event: GatewayStreamEvent): EditorViewState {
  const verdict = readVerdict(event.data) ?? 'error';
  return {
    phase: phaseForVerdict(verdict),
    progress: state.progress,
    lastEventId: event.seq,
    outcome: { verdict, detail: readMessage(event.data, verdict) },
  };
}

/** A stream/tool error event is terminal and always maps to the `error` verdict. */
function applyError(state: EditorViewState, event: GatewayStreamEvent): EditorViewState {
  return {
    phase: 'errored',
    progress: state.progress,
    lastEventId: event.seq,
    outcome: { verdict: 'error', detail: readMessage(event.data, 'run failed') },
  };
}

/** Map a settled verdict onto its terminal phase. */
function phaseForVerdict(verdict: Verdict): EditorPhase {
  if (verdict === 'pass') {
    return 'passed';
  }
  return verdict === 'fail' ? 'failed' : 'errored';
}

/** The set of valid verdict strings, used to validate untrusted stream data. */
const VERDICTS: ReadonlySet<string> = new Set<Verdict>(['pass', 'fail', 'error']);

/** Read a `verdict` field from untrusted data, or null if absent/invalid. */
function readVerdict(data: unknown): Verdict | null {
  const value = readField(data, 'verdict');
  return typeof value === 'string' && VERDICTS.has(value) ? (value as Verdict) : null;
}

/** Read a display message from untrusted data, falling back to a safe default. */
function readMessage(data: unknown, fallback: string): string {
  const value = readField(data, 'message');
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Safely read a property off an unknown value without throwing. */
function readField(data: unknown, key: string): unknown {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  return (data as Record<string, unknown>)[key];
}

/** Exhaustiveness guard: unreachable for a well-typed `GatewayStreamEvent.kind`. */
function assertNever(value: never): never {
  throw new Error(`Unhandled gateway event kind: ${String(value)}`);
}
