// Ordered, human-readable session history (Requirement 3.6).
//
// This is a read-only projection over the persisted Trace, distinct from raw
// persistence: it turns the ordered spans of a session into a compact list of
// steps and their results that the Editor can show a Student. It derives its
// fields from already-sanitized span data and adds no new state.
//
// A FORMAL GATE STEP IS RENDERED FROM WHAT ITS OWN SPAN RECORDS (Req 1.19, 1.20).
// `#recordFormalRun` in the Verification_Loop writes, per property, the verdict and the
// `could-not-verify` cause into the span's `outputs`, and sets `failureClass` for a
// refutation only - so the general rule below, which renders any span carrying no failure
// class as `completed`, rendered a `could-not-verify` step exactly like a `proved` one.
// This is the live surface the Editor can show a Student, so the verdict counts AND each
// cause are rendered IN WORDS: explaining is the product.
//
// NO `TrustTier` MEMBER IS ADDED, and none is read here: the reason is rendered BESIDE the
// tier treatment, as Requirement 1.12 and the design require. A fourth tier would move the
// injective tier-to-treatment map, the `tierRequiresProvenance` invariant, and every
// exhaustive `Record` over the union, to express something `Unverified` already expresses
// fail-safely.
//
// REQUIREMENT 1.13'S DISPLAY_LAYER RENDERING IS DEFERRED to the first UI spec that renders
// a Formal_Verdict: `app/web` and `app/api` hold no reference to one today, so a rendering
// there would be unreachable code. This projection is the surface that is live now.

import type { Json, Trace, TraceSpan, Ulid } from '@app/core';
import {
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type CouldNotVerifyCause,
  type FormalVerdict,
} from '@app/tools';

/**
 * The `stageOrTool` name a formal gate run is recorded under.
 *
 * Its single writer is `FORMAL_STAGE` in `app/agent/orchestrator/verification-loop.ts`,
 * which does not export it. Naming it here rather than importing it keeps the
 * Action_Recorder from depending on the orchestrator it records.
 */
const FORMAL_STAGE = 'Formal_Oracle';

/** One step of a session rendered for a human reader. */
export interface HistoryEntry {
  /** Monotonic position in the session, ascending. */
  readonly seq: number;
  /** The spine stage or tool this step ran. */
  readonly step: string;
  /**
   * A short human-readable outcome, e.g. `ok`, `failed (timeout)`, `exit 1`, or for a
   * formal gate run `formal: 2 proved, 1 could not verify (proof timed out)`.
   */
  readonly result: string;
  /** ISO-8601 start timestamp. */
  readonly startedAt: string;
  readonly durationMs: number;
  readonly retryCount: number;
  readonly costCents: number;
  /** Present when this step was a recovery attempt for an earlier failed step. */
  readonly recoveryOf?: Ulid;
}

/** One per-property fact of a formal gate run, read back off the span's outputs. */
interface FormalPropertyReading {
  readonly verdict: FormalVerdict;
  /** Present only for `could-not-verify`; Req 1.5 requires exactly one cause there. */
  readonly cause: CouldNotVerifyCause | null;
}

/**
 * Each Formal_Verdict in words, total over the closed vocabulary.
 *
 * A fourth verdict is a compile error here rather than a missing phrase.
 */
const FORMAL_VERDICT_WORDS: Readonly<Record<FormalVerdict, string>> = Object.freeze({
  proved: 'proved',
  refuted: 'refuted',
  'could-not-verify': 'could not verify',
});

/**
 * Each Could_Not_Verify_Cause in words a Student can act on, total over the closed
 * vocabulary, so a twelfth cause is a compile error here rather than a missing phrase.
 *
 * Every phrase is a FIXED string chosen here: no host, path, diagnostic, or criterion text
 * from the run reaches this rendering, so a student-facing line cannot leak one.
 */
const COULD_NOT_VERIFY_WORDS: Readonly<Record<CouldNotVerifyCause, string>> = Object.freeze({
  'zero-assertions': 'no assertion reached the solver',
  'frontend-rejected': 'the design could not be read',
  'property-build-failed': 'the property did not build',
  'contradictory-assumptions': 'the assumptions cannot all hold at once',
  'antecedent-unreached': 'the property was never triggered',
  'induction-inconclusive': 'the proof needs more depth',
  'induction-engine-incomplete': 'the proof did not settle',
  'reset-contract-unresolved': 'the reset behaviour could not be established',
  'clock-contract-unsupported': 'this clocking cannot be checked faithfully',
  'proof-timeout': 'proof timed out',
  'toolchain-unavailable': 'the proof tool gave no usable answer',
});

/** Narrow a `Json` value to its object case, or `null` when it is not one. */
function jsonObject(value: Json | undefined): { readonly [key: string]: Json } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  // Asserted, not inferred: `Array.isArray`'s false branch does not remove
  // `readonly Json[]` from the union, so elimination leaves the object case unreachable
  // to the checker. The three guards above are what make it sound.
  return value as { readonly [key: string]: Json };
}

/** Narrow a `Json` value to its array case, or `null` when it is not one. */
function jsonArray(value: Json | undefined): readonly Json[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * Read one recorded property, or `null` where it is not readable as a Formal_Verdict.
 *
 * Both vocabularies are read by SEARCHING the closed member list rather than by indexing a
 * `Record` with the recorded string, because a `Record` index coerces its key and would
 * turn `["proved"]` into a match.
 */
function readFormalProperty(entry: Json): FormalPropertyReading | null {
  const fields = jsonObject(entry);
  if (fields === null) {
    return null;
  }
  const verdict = FORMAL_VERDICTS.find((member) => member === fields.verdict);
  if (verdict === undefined) {
    return null;
  }
  if (verdict !== 'could-not-verify') {
    return { verdict, cause: null };
  }
  const cause = COULD_NOT_VERIFY_CAUSES.find((member) => member === fields.cause);
  return cause === undefined ? null : { verdict, cause };
}

/**
 * Read a formal gate span's per-property verdicts, or `null` where they are unreadable.
 *
 * The span's `outputs` are `Json` read back from the Trace, so they are validated as
 * UNTRUSTED input at this boundary, and ANY unreadable entry makes the whole step
 * unreadable rather than silently shrinking the set (Req 1.20).
 */
function readFormalProperties(outputs: Json): readonly FormalPropertyReading[] | null {
  const recorded = jsonArray(jsonObject(outputs)?.properties);
  if (recorded === null) {
    return null;
  }
  const readings: FormalPropertyReading[] = [];
  for (const entry of recorded) {
    const reading = readFormalProperty(entry);
    if (reading === null) {
      return null;
    }
    readings.push(reading);
  }
  return readings;
}

/** The causes of a verdict's properties in words, parenthesised, or `''` where it has none. */
function describeCauses(under: readonly FormalPropertyReading[]): string {
  const causes = under.flatMap((reading) =>
    reading.cause === null ? [] : [COULD_NOT_VERIFY_WORDS[reading.cause]],
  );
  return causes.length === 0 ? '' : ` (${causes.join(', ')})`;
}

/**
 * Render a formal gate run as the count under each Formal_Verdict plus every
 * `could-not-verify` property's cause in words (Req 1.19).
 *
 * COUNTS RATHER THAN ONE DECIDING VERDICT, so this holds no second copy of the
 * refuted-over-could-not-verify precedence the Verification_Loop already owns.
 */
function describeFormalRun(readings: readonly FormalPropertyReading[]): string {
  if (readings.length === 0) {
    return 'formal: no property reported';
  }
  const counts = FORMAL_VERDICTS.flatMap((verdict) => {
    const under = readings.filter((reading) => reading.verdict === verdict);
    const words = FORMAL_VERDICT_WORDS[verdict];
    return under.length === 0 ? [] : [`${under.length} ${words}${describeCauses(under)}`];
  });
  return `formal: ${counts.join(', ')}`;
}

/** Derive a short, human-readable outcome label from a span's recorded result. */
function describeResult(span: TraceSpan): string {
  if (span.stageOrTool === FORMAL_STAGE) {
    // AHEAD of the failure-class branch, because the counts are what this step reports and
    // `failureClass` carries only the refuted bit. Unreadable outputs render as such and
    // never as `completed`, whatever else the span carries (Req 1.20).
    const readings = readFormalProperties(span.outputs);
    return readings === null ? 'formal: unreadable outputs' : describeFormalRun(readings);
  }
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
