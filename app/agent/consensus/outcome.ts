// The Session_Outcome union, the Checked_Summary, and the Session_Record (C17,
// Req 1.1, 2.7, 6.8, 7.8, 8.7, 10.6, 12.6, 14.1-14.7, 15.5).
//
// Two members with DIFFERENT fields, not one optional-everything record: a
// Verified_Outcome has no field an unmet condition could sit in, and an
// Unverified_Outcome has no field a delivered design set could. Neither carries a
// free-text field, host name, path, or raw model output - there is nothing to
// sanitize because there is no field to put it in.

import type { Ulid } from '@app/core';
import type { RoleDeclaration } from '@app/tools';

import type { AgreementCluster } from './agreement.js';
import type { BudgetCause } from './budget.js';
import type { GrantConditionId } from './grant.js';
import type { FaultVerdict } from './fault-attributor.js';
import type { RunMatrix } from './run-matrix.js';
import type { WaveformSignature } from './signature.js';
import type { AttributionStatus, TestbenchTrust } from './trust-vote.js';

/** Every reason a Session can fail to grant (Req 14.4). */
export type UnmetCondition =
  GrantConditionId | BudgetCause | 'formal-refutation' | 'escalation-pending';

/** The figures reported on a non-granted Session; recomputed from the record, never self-referential. */
export interface CheckedSummary {
  readonly poolSize: number;
  readonly distinctModelFamilyCount: number;
  readonly trustedTestbenchCount: number;
  readonly consensusRunCount: number;
  readonly largestClusterCardinality: number;
  readonly structuralGateChecks: readonly { readonly designId: Ulid; readonly admitted: boolean }[];
}

/** The closed set of options a Student may take next; derived from `UnmetCondition`. */
export type NextAction =
  'answer-behaviour-question' | 'request-another-attempt' | 'accept-unverified';

/** One Repair_Attempt's partition and decision, retained for the Session_Record. */
export interface RepairAttemptRecord {
  readonly steeringSetDesignIds: readonly Ulid[];
  readonly heldOutDesignIds: readonly Ulid[];
  readonly accepted: boolean;
}

/** One testbench's mutant census, retained for the Session_Record. */
export interface MutantCensusRecord {
  readonly testbenchId: Ulid;
  readonly killedMutantIds: readonly string[];
  readonly survivingMutantIds: readonly string[];
}

/** Pool_Correctness's two figure sets (C14), retained for the Session_Record. */
export interface PoolCorrectnessRecord {
  readonly poolCorrectness: number;
  readonly attributionStatus: AttributionStatus;
  readonly faultVerdicts: readonly {
    readonly designId: Ulid;
    readonly testbenchId: Ulid;
    readonly verdict: FaultVerdict;
  }[];
}

/**
 * The full replay record every Session carries, required on both outcome members
 * so a success path cannot skip it.
 */
export interface SessionRecord {
  readonly clusters: readonly AgreementCluster[];
  readonly signaturesByDesign: readonly {
    readonly designId: Ulid;
    readonly testbenchId: Ulid;
    readonly signature: WaveformSignature;
    /** `distinctOutputCount(signature)`, computed once here rather than re-derived by a reader (Req 6.1). */
    readonly distinctOutputCount: number;
  }[];
  readonly modelFamilyByArtifact: readonly { readonly artifactId: Ulid; readonly family: string }[];
  /**
   * The Role_Declaration each testbench's draft was granted on (Req 6.2). No body field:
   * the model's own source is a diagnostic the eval side owns, and this record has never
   * held model source.
   */
  readonly roleDeclarations: readonly {
    readonly testbenchId: Ulid;
    readonly roles: RoleDeclaration;
  }[];
  readonly testbenchTrust: readonly TestbenchTrust[];
  readonly mutantCensus: readonly MutantCensusRecord[];
  readonly poolCorrectness: PoolCorrectnessRecord;
  readonly repairAttempts: readonly RepairAttemptRecord[];
  readonly tokensSpent: number;
  readonly runMatrix: RunMatrix;
}

export interface VerifiedOutcome {
  readonly kind: 'verified';
  /** The Strict_Majority cluster's own designIds, named at the top level (Req 1.2). */
  readonly deliveredDesignIds: readonly Ulid[];
  readonly cluster: AgreementCluster;
  readonly record: SessionRecord;
}

export interface UnverifiedOutcome {
  readonly kind: 'unverified';
  readonly unmetCondition: UnmetCondition;
  readonly checked: CheckedSummary;
  readonly nextActions: readonly NextAction[];
  readonly record: SessionRecord;
}

export type SessionOutcome = VerifiedOutcome | UnverifiedOutcome;

/** Causes that end a Session with no further attempt available (Req 14.6). */
const BUDGET_EXHAUSTED: ReadonlySet<UnmetCondition> = new Set([
  'session-token-budget',
  'run-token-budget',
]);

/**
 * The `NextAction` set an `UnmetCondition` permits (Req 14.6).
 *
 * A budget exhaustion offers no further attempt; an escalation offers the
 * Behaviour_Question; every other cause offers a retry.
 */
function nextActionsFor(unmetCondition: UnmetCondition): readonly NextAction[] {
  if (BUDGET_EXHAUSTED.has(unmetCondition)) {
    return ['accept-unverified'];
  }
  if (unmetCondition === 'escalation-pending') {
    return ['answer-behaviour-question', 'accept-unverified'];
  }
  return ['request-another-attempt', 'accept-unverified'];
}

/** The grant/unmet facts `buildOutcome` turns into a `SessionOutcome`. */
export type OutcomeInput =
  | { readonly kind: 'granted'; readonly cluster: AgreementCluster }
  | {
      readonly kind: 'unmet';
      readonly unmetCondition: UnmetCondition;
      readonly checked: CheckedSummary;
    };

/**
 * Build the `SessionOutcome` for one Session (Req 14.1-14.7): a `VerifiedOutcome`
 * when `input` is granted, else an `UnverifiedOutcome` whose `NextAction` set is
 * derived from the unmet cause. `record` is required on both members.
 */
export function buildOutcome(input: OutcomeInput, record: SessionRecord): SessionOutcome {
  if (input.kind === 'granted') {
    return {
      kind: 'verified',
      deliveredDesignIds: input.cluster.designIds,
      cluster: input.cluster,
      record,
    };
  }
  return {
    kind: 'unverified',
    unmetCondition: input.unmetCondition,
    checked: input.checked,
    nextActions: nextActionsFor(input.unmetCondition),
    record,
  };
}
