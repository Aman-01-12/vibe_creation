// formal-gate-first-light, Component 21: the Property_Author_Decline_Measurement (task 11.26).
//
// WHY THIS EXISTS
//   Declining is the DOMINANT outcome on this corpus, not a rare one. The FL-27 re-run measured
//   29 of 46 designs with nothing expressed for `zai.glm-5` and 20 of 46 for
//   `moonshotai.kimi-k2.5`. A property-only rate is therefore reported over a minority of its
//   population, and nothing recorded so far says WHY (Req 5.28, FL-28).
//
// THE TWO OUTCOMES IT HAS TO SEPARATE
//   A judgement the Property_Author reached about a criterion, and an artifact of how that
//   criterion is handed to it. They need different fixes, so collapsing them would be worse than
//   leaving the cause open. `criteriaHanded` is what makes them distinguishable: a design that
//   handed exactly one criterion and had it declined is a different observation from one that
//   handed several and had some declined.
//
// WHAT IT DOES NOT DO
//   It does not decide the cause. Deciding it needs the Property_Author's own stated reason for
//   declining, and the author returns only which criteria went unexpressed. So `cause` is always
//   Not_Measured here, carrying the reason it could not be decided, and no reader may take an
//   observation below as a cause.

import type { PropertyOnlyMeasurement } from './record.js';

/** The schema version of a decline record, bumped when a field's meaning changes. */
export const DECLINE_SCHEMA_VERSION = 1;

/** What one design under one Authoring_Model reported about expressing its criteria. */
export interface DeclineObservation {
  readonly designId: string;
  readonly authoringModel: string;
  /** The acceptance criteria the Property_Author reported as unexpressed (Req 5.19). */
  readonly unexpressedCriteria: readonly string[];
  /**
   * How many acceptance criteria the design handed the author, or `null` where that is unknown.
   *
   * `null` is a missing figure and never a zero: a zero would say the author was handed nothing,
   * which is itself a handoff artifact and the opposite of an unknown.
   */
  readonly criteriaHanded: number | null;
  /** Whether the author expressed any property at all for this design. */
  readonly expressedAny: boolean;
}

/**
 * Why the Property_Author declined.
 *
 * One arm only, on purpose. A second arm would invite a reader to treat a count as a cause, and
 * this measurement cannot decide one. The arm widens when the author reports its own reason.
 */
export interface DeclineCause {
  readonly kind: 'not-measured';
  readonly reason: string;
}

/** One model's decline figures, over that model's own designs and never pooled (Req 5.14). */
export interface ModelDeclineFigures {
  readonly authoringModel: string;
  readonly designCount: number;
  readonly declinedCount: number;
  /**
   * Declined designs that were handed exactly one criterion.
   *
   * The handoff-artifact signal: where this equals `declinedCount`, every decline was the
   * author turning down the only criterion it was given, which a judgement and an artifact
   * explain equally well, so the cause stays open rather than being read off this number.
   */
  readonly declinedOnSingleCriterion: number;
}

/** A decline record: the observations, the per-model figures, and the undecided cause. */
export interface DeclineMeasurement {
  readonly schemaVersion: number;
  readonly measurementKind: 'property-author-decline';
  readonly observations: readonly DeclineObservation[];
  readonly figures: readonly ModelDeclineFigures[];
  readonly cause: DeclineCause;
}

/** The reason the cause is undecided, stated once so every record carries the same words. */
export const DECLINE_CAUSE_NOT_MEASURED: DeclineCause = Object.freeze({
  kind: 'not-measured',
  reason:
    'the Property_Author reports which criteria went unexpressed but not why, so a judgement ' +
    'about a criterion and an artifact of how it was handed over are indistinguishable here',
});

/** Read one observation per recorded design result, in the order the record holds them. */
export function declineObservationsOf(
  measurement: PropertyOnlyMeasurement,
  criteriaHandedFor: (designId: string) => number | null,
): readonly DeclineObservation[] {
  return measurement.results.map((result) => ({
    designId: result.designId,
    authoringModel: result.authoringModel,
    unexpressedCriteria: result.unexpressedCriteria,
    criteriaHanded: criteriaHandedFor(result.designId),
    expressedAny: result.properties.length > 0,
  }));
}

/** Tally one model's declines; the denominator is that model's own designs. */
function figuresFor(
  authoringModel: string,
  observations: readonly DeclineObservation[],
): ModelDeclineFigures {
  const mine = observations.filter((one) => one.authoringModel === authoringModel);
  const declined = mine.filter((one) => !one.expressedAny);
  return {
    authoringModel,
    designCount: mine.length,
    declinedCount: declined.length,
    declinedOnSingleCriterion: declined.filter((one) => one.criteriaHanded === 1).length,
  };
}

/** Build the whole record. The cause is Not_Measured by construction, never derived. */
export function declineMeasurementOf(
  measurement: PropertyOnlyMeasurement,
  criteriaHandedFor: (designId: string) => number | null,
): DeclineMeasurement {
  const observations = declineObservationsOf(measurement, criteriaHandedFor);
  const models = [...new Set(observations.map((one) => one.authoringModel))];
  return {
    schemaVersion: DECLINE_SCHEMA_VERSION,
    measurementKind: 'property-author-decline',
    observations,
    figures: models.map((model) => figuresFor(model, observations)),
    cause: DECLINE_CAUSE_NOT_MEASURED,
  };
}
