// The ADMISSION-STAMPING Property_Set source (Req 6.3, 6.4, 6.5; task 9.2).
//
// WHAT THIS DECORATES
//   The second decorator in the per-sample chain `MemoizingPropertySetSource` starts. C11a
//   authors the set once so the Property_Set_Gate and the Verification_Loop share one artifact;
//   this one carries the gate's verdict on that artifact INTO the loop. Without it the
//   `PropertyAgent` stamps every set `'not-gated'`, so the loop's own refusal guard has nothing
//   to act on and a refused set would still reach the Formal_Oracle.
//
// WHY A DECORATOR AND NOT A LOOP PARAMETER
//   `app/agent` holds no import of `app/eval`, and admission is scored against a reference
//   design a student session does not have. Adding a parameter to the loop was rejected: it
//   would put an eval-only concept in the product path's signature. Decorating the existing
//   port moves no boundary and adds no type to `app/agent`.
//
// WHY THE EMPTYING IS BELT-AND-BRACES
//   `withheldSetRoute` in the loop already routes any set stamped refused to the
//   Fallback_Route `property-set-refused`, before anything reaches the `FormalOraclePort`. So
//   emptying `properties` here is the caller half of criterion 6.3, not the only thing standing
//   between a refusal and a `Verified` label.

import type {
  FormalPropertySet,
  PropertySetAdmissionOutcome,
  PropertySetSource,
  SessionBudgetHandle,
} from '@app/agent';
import type { Spec } from '@app/core';

import { propertySetAdmissionFallsBack } from './property-set-admission.js';

/**
 * A `PropertySetSource` that re-stamps its inner source's set with one sample's admission
 * outcome, and empties the set when that outcome means no Property_Set may decide the sample.
 *
 * One instance per sample, constructed after the gate has scored the authored set, so the
 * outcome is fixed for this instance's whole life.
 */
export class AdmissionStampingPropertySource implements PropertySetSource {
  readonly #inner: PropertySetSource;
  readonly #admitted: PropertySetAdmissionOutcome;

  constructor(inner: PropertySetSource, admitted: PropertySetAdmissionOutcome) {
    this.#inner = inner;
    this.#admitted = admitted;
  }

  /**
   * The inner source's set, stamped with this sample's admission outcome.
   *
   * `unexpressedCriteria` survives either way: it describes what the author could not express,
   * which a refusal does not make untrue. `properties` is emptied only for an outcome
   * `propertySetAdmissionFallsBack` names, which today is `'refused'` alone.
   */
  async propertySetFor(spec: Spec, budget: SessionBudgetHandle): Promise<FormalPropertySet> {
    const set = await this.#inner.propertySetFor(spec, budget);
    return {
      properties: propertySetAdmissionFallsBack(this.#admitted) ? [] : set.properties,
      unexpressedCriteria: set.unexpressedCriteria,
      propertySetAdmitted: this.#admitted,
    };
  }
}
