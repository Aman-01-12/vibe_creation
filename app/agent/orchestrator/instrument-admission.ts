// The Instrument_Admission port (Req 4.1-4.9; task 3.5).
//
// WHY THIS IS A PORT DECLARED HERE AND IMPLEMENTED IN @app/eval
//   The Verification_Loop is the only caller that needs to consult admission, and
//   it must consult it before the first iteration (design.md, "The new setup
//   sequence"). But deciding admissibility means running the Instrument_Control
//   against a reference design, and reference designs exist only in @app/eval - the
//   layer that holds the benchmark corpus. `@app/agent` must never import
//   `@app/eval` (Req 9.7), so the port lives here, undecided by any implementation,
//   and `MemoizingInstrumentAdmission` (task 6.4, `app/eval/instrument-admission.ts`)
//   implements it. This is the same role-local-port shape the repository already
//   uses to keep the orchestrator free of its callers.
//
// WHY `InstrumentAdmissionRequest` HAS EXACTLY ONE FIELD
//   This is not a convenience; it is the safety property (Property 7; Req 4.3,
//   4.4). `SessionBudgetHandle` (`../model-router/budget-handle.js`) is a mutable
//   accounting object: `canAfford()`, `charge()`, `stopReason()`. If a request
//   type carried one, an admission check could exhaust a student session's budget
//   merely by being consulted - the exact failure this port exists to prevent,
//   since Req 4.3 requires the request be "structurally incapable of consuming a
//   student session's allowance." Likewise, no field can carry candidate RTL: the
//   testbench is required to be judged independent of any candidate (Req 4.4), the
//   same discipline `GenerateTestbenchRequest` already applies for the same
//   reason. `InstrumentAdmissionRequest` therefore declares one field, the
//   testbench source, and nothing else - there is no field a `SessionBudgetHandle`
//   or any RTL source could occupy, by construction rather than by convention.
//
// WHY THE DECISION IS A CLOSED THREE-MEMBER UNION
//   `admit` must be total and fail-safe (design.md, "total and fail-safe"): a
//   throw is caught by the loop and treated as `undecided`, and `undecided`
//   always proceeds to the first iteration (Req 4.7, 4.8). There is no fourth
//   outcome, so the loop's dispatch on this union is exhaustive by construction.

/**
 * Whether a Testbench is an admissible measuring instrument, decided once per run
 * before the Verification_Loop spends any repair iteration on it.
 *
 * - `admissible`: the Testbench passed admission; the loop proceeds unchanged.
 * - `inadmissible`: the Testbench failed admission; the loop returns
 *   Instrument_Refused without running an iteration (Req 4.6).
 * - `undecided`: admission could not be determined; the loop proceeds exactly as
 *   it would with no port wired (Req 4.7).
 */
export type InstrumentAdmissionDecision = 'admissible' | 'inadmissible' | 'undecided';

/**
 * The request an Instrument_Admission port is asked to decide.
 *
 * Structurally incapable of carrying a budget handle or any RTL: the sole field
 * is the Testbench source under test, so there is no field a `SessionBudgetHandle`
 * or a candidate's RTL could occupy (Req 4.3, 4.4).
 */
export interface InstrumentAdmissionRequest {
  /** The generated Testbench source whose admissibility is being decided. */
  readonly testbench: string;
}

/**
 * A port the Verification_Loop consults at most once per run, after Loop_Setup has
 * produced a Testbench and the Testbench_Precheck build has succeeded, and before
 * the first iteration (Req 4.1, 4.2).
 *
 * No implementation lives in `@app/agent`; deciding admissibility needs a
 * reference design, which only `@app/eval` holds. See
 * `app/eval/instrument-admission.ts` for `MemoizingInstrumentAdmission`, the
 * eval-layer adapter that backs this port with the Instrument_Control.
 */
export interface InstrumentAdmission {
  admit(request: InstrumentAdmissionRequest): Promise<InstrumentAdmissionDecision>;
}
