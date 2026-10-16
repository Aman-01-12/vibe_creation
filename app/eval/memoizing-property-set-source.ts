// The per-sample MEMOIZING PROPERTY_SET source (Req 6.7; task 9.1).
//
// WHAT THIS DECORATES
//   `PropertySetSource` (`@app/agent`) is the port the Verification_Loop authors a sample's
//   Property_Set through. On a gated eval run the set has to exist BEFORE the loop runs, because
//   the Property_Set_Gate scores it against a reference design and reference designs live only in
//   `@app/eval`. So the Eval_Harness authors up front, then hands the loop the same port.
//
//   Two callers, one artifact: this decorator is that single authoring. The gate makes no model
//   call of its own (Req 6.7) because it reads what this already authored.
//
// WHY A DECORATOR AND NOT A LOOP PARAMETER
//   `app/agent` holds no import of `app/eval`, and admission is an eval-only concept computed
//   from data a student session does not have. Adding a parameter to the loop was rejected for
//   exactly that reason: it would put an eval-only concept in the product path's signature. A
//   decorator over the existing port moves no boundary and adds no type to `app/agent`.
//
// WHY MEMOIZED, AND WHY PER-INSTANCE
//   A second authoring call would be a second MODEL call for one sample, and two sets would make
//   the recorded `propertySetAdmitted` describe an artifact the loop never saw. One instance per
//   sample, mirroring `MemoizingInstrumentAdmission` in this layer: there is no cross-sample
//   state, so the memo is a plain instance field and there is no lock to take.
//
//   The field holds the PROMISE rather than the resolved set. A sample is driven by one caller at
//   a time, so this costs nothing in the expected shape, and it keeps the at-most-once guarantee
//   true even if the gate and the loop ever overlap - where an "await, then set a flag" memo
//   would author twice. A rejected authoring stays memoized for the same reason: re-entering a
//   failed author is the second model call this class exists to prevent.

import type { FormalPropertySet, PropertySetSource, SessionBudgetHandle } from '@app/agent';
import type { Spec } from '@app/core';

/**
 * A `PropertySetSource` that authors its sample's Property_Set at most once.
 *
 * One instance per sample. Every caller after the first is served the identical
 * `FormalPropertySet` object, and `authored()` reads it back without re-entering the inner
 * source - the same read-after-the-fact shape `MemoizingInstrumentAdmission#recorded` has.
 */
export class MemoizingPropertySetSource implements PropertySetSource {
  readonly #inner: PropertySetSource;
  /** The one authoring call, pending or settled; `null` until the first `propertySetFor`. */
  #pending: Promise<FormalPropertySet> | null = null;
  /** The resolved set, so `authored()` can answer synchronously. */
  #authored: FormalPropertySet | null = null;

  constructor(inner: PropertySetSource) {
    this.#inner = inner;
  }

  /**
   * The sample's Property_Set, authored on the first call and replayed on every later one.
   *
   * `spec` and `budget` are read only on the first call, which is what charges the authoring
   * tokens to the sample's own handle. A later caller's arguments are deliberately ignored:
   * honouring them would mean a second model call for one sample.
   */
  propertySetFor(spec: Spec, budget: SessionBudgetHandle): Promise<FormalPropertySet> {
    this.#pending ??= this.#inner.propertySetFor(spec, budget).then((set) => {
      this.#authored = set;
      return set;
    });
    return this.#pending;
  }

  /** The set this sample was authored from, or `null` before the first call completes. */
  authored(): FormalPropertySet | null {
    return this.#authored;
  }
}
