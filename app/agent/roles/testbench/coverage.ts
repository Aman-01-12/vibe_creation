// The acceptance-criterion coverage mapping (Req 7.3, 7.5).
//
// This module deterministically derives, from the Spec alone, the set of per-check
// signals the generated Testbench MUST emit: one check per acceptance criterion
// that is verifiable by simulation, plus known-answer checks for any standard block
// the Spec describes. Each check name is whitespace-free and traceable back to its
// source (the criterion id, or the reference block).
//
// The coverage guarantee (Property 6, task 13.5) states directly over
// `requiredChecks`: because the Testbench_Agent only produces a Testbench when the
// source emits every required check, a produced Testbench covers every
// simulation-verifiable acceptance criterion by construction.

import type { AcceptanceCriterion, Spec } from '@app/core';

import type { StrategyArm } from './approach-router.js';
import {
  detectGroundedStandardBlocks,
  detectStandardBlocks,
  type StandardBlockReference,
} from './standard-blocks.js';
import { isValidCheckName } from './signalling.js';
import type { RequiredCheck } from './types.js';

/** The verification method whose criteria the Testbench exercises (Req 7.3). */
const SIMULATION_METHOD = 'simulation' as const;

/** Longest slug taken from criterion text, to keep check names compact. */
const MAX_SLUG_CHARS = 40;

/**
 * The acceptance criteria a Testbench exercises: those verifiable by simulation.
 *
 * Criteria verified by formal methods or manual inspection are out of the
 * Simulator oracle's reach and are intentionally excluded, matching Property 6's
 * scope ("every acceptance criterion verifiable by simulation").
 */
export function simulationCriteria(spec: Spec): readonly AcceptanceCriterion[] {
  return spec.acceptanceCriteria.filter(
    (criterion) => criterion.measurable && criterion.method === SIMULATION_METHOD,
  );
}

/** Reduce free-text to a compact, whitespace-free, lowercase slug for a check name. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/_+$/g, '');
  return slug.length > 0 ? slug : 'criterion';
}

/**
 * The whitespace-free check name for a criterion, traceable to its position.
 *
 * The `ac<n>_` prefix makes the name unique across criteria regardless of text and
 * anchors it to the criterion's position, while the slug keeps it human-readable
 * and traceable to the criterion's meaning.
 */
function criterionCheckName(criterion: AcceptanceCriterion, index: number): string {
  return `ac${index + 1}_${slugify(criterion.text)}`;
}

/** Build the criterion-derived required checks, one per simulation criterion. */
function criterionChecks(spec: Spec): readonly RequiredCheck[] {
  return simulationCriteria(spec).map((criterion, index) => ({
    name: criterionCheckName(criterion, index),
    kind: 'criterion' as const,
    criterionId: criterion.id,
    description: criterion.text,
  }));
}

/**
 * Build the known-answer required checks for any standard block the Spec describes.
 *
 * `detectStandardBlocks` is the single owner of the selection rule, and it requires
 * both a keyword match in the Spec's prose and a declared interface that can carry
 * the block's reference behavior - so a check whose truth table the declared ports
 * cannot justify never reaches this set.
 */
function knownAnswerChecks(
  references: readonly StandardBlockReference[],
): readonly RequiredCheck[] {
  return references.map((reference) => ({
    name: reference.checkName,
    kind: 'known-answer' as const,
    description: reference.description,
  }));
}

/**
 * The complete set of per-check signals the Testbench must emit for a Spec.
 *
 * Combines one check per simulation-verifiable acceptance criterion (Req 7.3) with
 * known-answer checks for recognized standard blocks (Req 7.5). Every returned
 * name is a valid whitespace-free signalling token and is unique within the set;
 * a known-answer check whose name collides with a criterion check is dropped so
 * the set stays a clean one-check-per-signal mapping.
 */
export function requiredChecks(spec: Spec): readonly RequiredCheck[] {
  return combine(criterionChecks(spec), knownAnswerChecks(detectStandardBlocks(spec)));
}

/**
 * The Required_Check list one Strategy_Arm derives for a Spec; `requiredChecks` is Control's.
 * Grounded drops only the up-counter known-answer check, an invented contract (Q-03).
 */
export function requiredChecksFor(spec: Spec, strategyArm: StrategyArm): readonly RequiredCheck[] {
  if (strategyArm !== 'grounded') {
    return requiredChecks(spec);
  }
  return combine(criterionChecks(spec), knownAnswerChecks(detectGroundedStandardBlocks(spec)));
}

/** Criterion checks first, then each valid known-answer check whose name is not taken. */
function combine(
  checks: readonly RequiredCheck[],
  knownAnswers: readonly RequiredCheck[],
): readonly RequiredCheck[] {
  const seen = new Set<string>(checks.map((check) => check.name));
  const combined = [...checks];
  for (const knownAnswer of knownAnswers) {
    if (!seen.has(knownAnswer.name) && isValidCheckName(knownAnswer.name)) {
      seen.add(knownAnswer.name);
      combined.push(knownAnswer);
    }
  }
  return combined;
}

/** The acceptance-criterion ids a set of required checks traces to (for `coversCriteria`). */
export function coveredCriterionIds(checks: readonly RequiredCheck[]): readonly string[] {
  const ids: string[] = [];
  for (const check of checks) {
    if (check.kind === 'criterion' && check.criterionId !== undefined) {
      ids.push(check.criterionId);
    }
  }
  return ids;
}
