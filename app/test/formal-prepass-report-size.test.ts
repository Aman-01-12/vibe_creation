// timing-contract-inference, task 4.3: `MAX_PREPASS_REPORT_CHARS` re-measured against TWO findings.
//
// WHAT WAS MEASURED, AND WHY THE FIGURES ARE LITERALS HERE
//   The bound's old justification covered a reset finding and a predicate, and task 4.1 added a
//   REQUIRED `timing` field, so the worst case it claimed was no longer the worst case. The figures
//   below come from running the worker's own `YOSYS_PREPASS_SCRIPT` and `_prepass_report` over every
//   reference design of `.eval-corpus/rtllm` on Yosys 0.69+post - 48 of the 50 elaborate, with
//   `float_multi` and `synchronizer` refused by the Yosys FRONTEND and so producing no report at all
//   - and serializing each finding the way the worker writes it.
//   They are pinned HERE rather than computed, because a figure computed from the same objects the
//   module uses asserts only that serialization is deterministic. A finding that GROWS - one more
//   per-port field, a second enable - changes a length below and fails here, which is the point: the
//   alternative is discovering it on a production report the parse refuses.
//
//   The widest timing finding is `alu`'s: six declared output ports over three input ports, which is
//   the port-count times source-count product the shape is driven by. The widest reset finding is
//   `LIFObuffer`'s, the one enable-gated reset in the corpus, which carries `resetEnable` on top of
//   the three facts every derived reset carries.
//
// THE TWO SEPARATOR CONVENTIONS, WHICH ARE A REAL 75-CHARACTER DIFFERENCE AND NOT A ROUNDING
//   The worker writes with `json.dumps`, whose DEFAULT separators are `", "` and `": "`, so the file
//   on disk is wider than `JSON.stringify`'s compact form of the same value. Both are recorded: the
//   compact figures are what this file can construct and assert directly, and the worker-written
//   figures are what the bound actually has to admit, so the headroom claim is made against those.
//
// WHY THE REJECTION DIRECTION IS ASSERTED TOO
//   The bound REJECTS and does not truncate, and it is checked BEFORE `JSON.parse`. A bound that
//   truncated would hand on a document that is not a report; one checked after the parse would do
//   the work it exists to avoid. So a document one character over is asserted to fail as
//   `report-too-large` SPECIFICALLY - a size refusal arriving as `not-json` would mean the text was
//   cut and then parsed - and the same document one character shorter is asserted to pass, which is
//   what makes the first assertion about the SIZE rather than about the content.
//
// **Validates: Requirements 1.13**
import { describe, expect, it } from 'vitest';

import {
  MAX_PREPASS_REPORT_CHARS,
  parseFormalPrepassReport,
  type FormalPrepassDocument,
  type PrepassResetFinding,
  type PrepassTimingFinding,
} from '@app/tools';

/** `alu`'s finding, measured: the widest the corpus produces, and the widest shape it can produce. */
const WIDEST_TIMING_FINDING: PrepassTimingFinding = {
  derived: true,
  ports: [
    { port: 'r', sources: ['a', 'aluc', 'b'], reachesState: false, undriven: false },
    { port: 'zero', sources: ['a', 'aluc', 'b'], reachesState: false, undriven: false },
    { port: 'carry', sources: [], reachesState: false, undriven: true },
    { port: 'negative', sources: [], reachesState: false, undriven: true },
    { port: 'overflow', sources: [], reachesState: false, undriven: true },
    { port: 'flag', sources: ['a', 'aluc', 'b'], reachesState: false, undriven: false },
  ],
};

/** `LIFObuffer`'s finding, measured: the only corpus reset carrying an enable, so the widest. */
const WIDEST_RESET_FINDING: PrepassResetFinding = {
  derived: true,
  resetName: 'Rst',
  resetActiveLow: false,
  resetKind: 'sync',
  resetEnable: { name: 'EN', activeLow: false },
};

/** The worker's own `MAX_INITIAL_STATE_PREDICATE_CHARS`: nothing longer is handed across. */
const WORKER_PREDICATE_CHARS = 4096;

/** The predicate's two JSON quotes. SMT-LIB bodies carry no quote or backslash to escape. */
const ENCODED_PREDICATE_CHARS = WORKER_PREDICATE_CHARS + 2;

/** Measured, compact: `JSON.stringify(WIDEST_TIMING_FINDING).length`. */
const TIMING_FINDING_CHARS = 473;

/** Measured, compact: `JSON.stringify(WIDEST_RESET_FINDING).length`. */
const RESET_FINDING_CHARS = 122;

/** Measured, compact: the four field names, the polarity string, and the punctuation around them. */
const ENVELOPE_CHARS = 71;

/** Measured, compact: all four parts at once. No single design reaches this. */
const WORST_CASE_CHARS = 4764;

/** The same worst case as the worker's `json.dumps` writes it, which is what the bound admits. */
const WORKER_WRITTEN_WORST_CASE_CHARS = 4839;

/** The widest document the corpus actually produces, worker-written: `alu`'s. */
const WORKER_WRITTEN_WIDEST_DOCUMENT_CHARS = 628;

/** One report text carrying both widest findings and a predicate of the given length. */
function reportText(predicateChars: number): string {
  const document: FormalPrepassDocument = {
    reset: WIDEST_RESET_FINDING,
    clockPolarity: 'posedge',
    initialStatePredicate: 'x'.repeat(predicateChars),
    timing: WIDEST_TIMING_FINDING,
  };
  return JSON.stringify(document);
}

describe('the pre-pass report size bound against two findings', () => {
  it('serializes the widest corpus timing finding to its measured width', () => {
    expect(JSON.stringify(WIDEST_TIMING_FINDING)).toHaveLength(TIMING_FINDING_CHARS);
  });

  it('serializes the widest corpus reset finding to its measured width', () => {
    expect(JSON.stringify(WIDEST_RESET_FINDING)).toHaveLength(RESET_FINDING_CHARS);
  });

  it("admits both widest findings alongside a predicate at the worker's own bound", () => {
    const text = reportText(WORKER_PREDICATE_CHARS);

    // The decomposition is asserted rather than described, so the module comment's breakdown and the
    // measurement cannot drift apart.
    expect(WORST_CASE_CHARS).toBe(
      ENCODED_PREDICATE_CHARS + RESET_FINDING_CHARS + TIMING_FINDING_CHARS + ENVELOPE_CHARS,
    );
    expect(text).toHaveLength(WORST_CASE_CHARS);
    expect(WORKER_WRITTEN_WORST_CASE_CHARS).toBeLessThan(MAX_PREPASS_REPORT_CHARS);
    expect(WORKER_WRITTEN_WIDEST_DOCUMENT_CHARS).toBeLessThan(WORKER_WRITTEN_WORST_CASE_CHARS);
    expect(parseFormalPrepassReport(text).ok).toBe(true);
  });

  it('rejects a document one character over the bound as too large, rather than truncating it', () => {
    const padding = MAX_PREPASS_REPORT_CHARS - reportText(0).length;
    const atBound = reportText(padding);
    const overBound = reportText(padding + 1);
    expect(atBound).toHaveLength(MAX_PREPASS_REPORT_CHARS);
    expect(overBound).toHaveLength(MAX_PREPASS_REPORT_CHARS + 1);
    // Valid JSON and schema-valid at one character shorter, so the only thing the refusal below can
    // be about is the size.
    expect(parseFormalPrepassReport(atBound).ok).toBe(true);

    const rejected = parseFormalPrepassReport(overBound);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.reason).toBe('report-too-large');
    }
  });
});
