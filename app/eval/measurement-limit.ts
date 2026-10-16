// Every limit this spec's measurements run under, and the reason each one exists.
//
// The vocabulary holds no cost member, so a limit that would name spend cannot be
// declared at all. Why a registry and not a reason per call site: see design.md, Component 3.
// Pure: no clock, no I/O, no randomness.

import { domainError, err, ok, type DomainError, type Result } from '@app/core';
import { DEFAULT_PROPERTY_TIME_BUDGET_MS } from '@app/tools';

/** The only reasons a limit may exist: make a measurement halt, catch a bad run, keep a population honest. */
export const LIMIT_REASONS = ['termination', 'anomaly-detection', 'population-honesty'] as const;

/** Why one limit exists; exactly one per limit. */
export type LimitReason = (typeof LIMIT_REASONS)[number];

/** One declared bound a measurement runs under, carrying the reason it exists. */
export interface MeasurementLimit {
  /** The name a measurement asks for the limit by; equals its key in `DECLARED_LIMITS`. */
  readonly name: string;
  readonly value: number;
  // 'multiple' is a fifth unit beyond design.md's four: the Anomaly_Guard's 10 is dimensionless.
  readonly unit: 'ms' | 'tokens' | 'designs' | 'steps' | 'multiple';
  readonly reason: LimitReason;
}

/**
 * The declared limits, without the name their key already carries.
 *
 * The shipped ceiling reads the product's own constant rather than restating 150 000, so a
 * `population-honesty` observation is taken under the budget the Student_Path actually runs under.
 */
const LIMIT_VALUES: Readonly<Record<string, Omit<MeasurementLimit, 'name'>>> = Object.freeze({
  'proof-depth': { value: 20, unit: 'steps', reason: 'termination' },
  'shipped-property-time-budget': {
    value: DEFAULT_PROPERTY_TIME_BUDGET_MS,
    unit: 'ms',
    reason: 'population-honesty',
  },
  'uncapped-property-time-budget': { value: 1_800_000, unit: 'ms', reason: 'termination' },
  'cost-pilot-design-count': { value: 3, unit: 'designs', reason: 'anomaly-detection' },
  'anomaly-guard': { value: 10, unit: 'multiple', reason: 'anomaly-detection' },
});

/**
 * Every limit this spec declares, by name; a measurement reads its limits from here.
 *
 * Each entry's `name` is derived from its key rather than written twice, so the two cannot drift.
 */
export const DECLARED_LIMITS: Readonly<Record<string, MeasurementLimit>> = Object.freeze(
  Object.fromEntries(
    Object.entries(LIMIT_VALUES).map(([name, limit]): [string, MeasurementLimit] => [
      name,
      Object.freeze({ name, ...limit }),
    ]),
  ),
);

/**
 * The limit a measurement runs under, or a typed refusal naming the limit it asked for.
 *
 * `Object.hasOwn` guards the lookup because property access reaches the prototype, so a name
 * like `toString` would otherwise resolve to a function instead of refusing.
 */
export function limitOrRefuse(name: string): Result<MeasurementLimit, DomainError> {
  const limit = Object.hasOwn(DECLARED_LIMITS, name) ? DECLARED_LIMITS[name] : undefined;
  if (limit === undefined) {
    return err(
      domainError(
        'MEASUREMENT_LIMIT_NOT_DECLARED',
        `no Measurement_Limit is declared under the name "${name}"`,
        'name',
      ),
    );
  }
  return ok(limit);
}
