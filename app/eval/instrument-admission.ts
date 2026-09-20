// The MEMOIZING INSTRUMENT_ADMISSION adapter (Req 4.10, 4.11, 4.12, 4.15, 8.5; task 6.4).
//
// WHAT THIS ADAPTS
//   `InstrumentAdmission` (`@app/agent`) is a port the Verification_Loop consults BEFORE its
//   first iteration: "is this Testbench a usable measuring stick?" Deciding that means running
//   the positive control against a reference design, and reference designs live only in
//   `@app/eval` (Req 9.7 forbids the reverse import), so the decision has to be made here and
//   handed to the loop through the port it already knows about.
//
//   `InstrumentControl` (`./instrument-control.ts`) already answers a related but different
//   question - "was this sample's testbench valid?" - as a `RecordedInstrumentVerdict` the
//   Eval_Harness records. This adapter is the ONE place those two questions share their answer:
//   `admit` decides the loop's question, `recorded()` hands the harness the exact
//   `InstrumentControlResult` the decision came from, and the control itself runs AT MOST ONCE
//   (Req 4.12) - so a sample's instrument is measured once and described once.
//
// WHY MEMOIZED, AND WHY PER-INSTANCE
//   The loop consults `admit` at most once per run (Req 4.1), but the harness may still read
//   `recorded()` afterward regardless of whether the loop actually called `admit` - a runner
//   that ignores the port, or a fallback path, must never trigger a second control run. One
//   `MemoizingInstrumentAdmission` is constructed per sample (design.md, "One instance per
//   sample, built by the harness"), so there is no cross-sample state to reset and no lock to
//   take: the memo is a plain instance field.
//
// WHY THIS IS PROVABLY MODEL-FREE
//   `Req 4.15` / `Req 8.5`: the Instrument_Control makes no model call, and admission rests on
//   a deterministic tool result alone. This class depends on the `InstrumentControl` PORT only
//   - never on a concrete corpus adapter, never on a `ModelRouter` - so there is no seam here
//   through which a model call could enter. `instrument-admission.test.ts` proves it: a fake
//   router is constructed and asserted untouched, alongside a synchronous, router-free fake
//   `InstrumentControl`.
//
// THE DECISION MAPPING (Req 4.11)
//   invalid    -> inadmissible   (the positive control falsified the instrument)
//   valid      -> admissible     (the reference design passes our testbench)
//   unchecked  -> undecided      (the control could not speak for this sample)
//   null       -> undecided      (no reference design for this problem)
//   throw      -> undecided      (fail-safe, mirrors `EvalHarness#controlInstrument`)
//   `undecided` lets the loop proceed exactly as it would with no port wired (Req 4.7, 4.8), so
//   every path that cannot produce a real answer degrades toward the loop's OLD behaviour
//   rather than toward a refusal.

import type {
  InstrumentAdmission,
  InstrumentAdmissionDecision,
  InstrumentAdmissionRequest,
} from '@app/agent';

import {
  uncheckedInstrument,
  type InstrumentControl,
  type InstrumentControlRequest,
  type InstrumentControlResult,
} from './instrument-control.js';

/** The control result for a run whose `check` call threw; no streams, no run. */
function uncheckedForThrow(): InstrumentControlResult {
  return {
    verdict: uncheckedInstrument('control-unavailable'),
    stdout: '',
    stderr: '',
    exitCode: null,
    mutation: null,
  };
}

/** How each `RecordedInstrumentVerdict` validity maps onto the loop's admission decision. */
function decisionFor(result: InstrumentControlResult | null): InstrumentAdmissionDecision {
  if (result === null) {
    return 'undecided';
  }
  if (result.verdict.validity === 'invalid') {
    return 'inadmissible';
  }
  if (result.verdict.validity === 'valid') {
    return 'admissible';
  }
  return 'undecided';
}

/**
 * The `InstrumentAdmission` port, backed by an injected `InstrumentControl`.
 *
 * One instance per sample. `admit` runs the control at most once and memoizes the whole
 * `InstrumentControlResult`, so a second `admit` call - or a harness that reads `recorded()`
 * without the loop ever having called `admit` - never re-runs the control (Req 4.12).
 */
export class MemoizingInstrumentAdmission implements InstrumentAdmission {
  readonly #control: InstrumentControl;
  readonly #request: Omit<InstrumentControlRequest, 'testbench'>;
  #memo: InstrumentControlResult | null = null;
  #ran = false;

  constructor(control: InstrumentControl, request: Omit<InstrumentControlRequest, 'testbench'>) {
    this.#control = control;
    this.#request = request;
  }

  async admit(request: InstrumentAdmissionRequest): Promise<InstrumentAdmissionDecision> {
    if (!this.#ran) {
      this.#memo = await this.#runControl(request.testbench);
      this.#ran = true;
    }
    return decisionFor(this.#memo);
  }

  /** The result the admission decision was taken from, or `null` if `admit` never ran. */
  recorded(): InstrumentControlResult | null {
    return this.#memo;
  }

  /**
   * Run the injected control exactly once, failing safe on a throw.
   *
   * Mirrors `EvalHarness#controlInstrument`'s catch-all: a control failure must never
   * propagate into the loop and abort a run, so it degrades to the same `control-unavailable`
   * shape that path already produces for the identical case.
   */
  async #runControl(testbench: string): Promise<InstrumentControlResult | null> {
    try {
      return await this.#control.check({ ...this.#request, testbench });
    } catch {
      // Sanitized, fail-safe: the control's error detail never reaches the loop or a record.
      return uncheckedForThrow();
    }
  }
}
