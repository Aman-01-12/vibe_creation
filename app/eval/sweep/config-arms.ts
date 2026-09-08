// Parsing the two parts of a sweep config that carry the experiment's identity: the
// ARMS and the PROBLEM SELECTION.
//
// These are separated from the rest of the parsing because they are where a mistake is
// most expensive. An arm with the wrong model id spends hours measuring something
// other than what the operator meant; a problem selection that matches nothing spends
// no time at all and produces an empty report that looks like a finished run. Both
// therefore fail loudly, at the boundary, naming the field.
//
// MODEL IDS ARE NOT CHECKED AGAINST A CATALOG - see `./model-catalog.ts` for why. The
// SHAPE is checked exhaustively: every role must name a non-blank id, an arm must name
// either one model or a complete per-role map (never both, never neither), and arm
// names must be unique because they key every persisted record.

import { MODEL_TASKS, type ModelTask } from '@app/agent';

import { asRtllmCategory, type RtllmCategory } from '../corpus/pinned-source.js';
import {
  SWEEP_CONFIG_BOUNDS,
  SWEEP_NAME_PATTERN,
  type SweepArmConfig,
  type SweepProblemSelection,
} from './config.js';
import {
  asArray,
  asRecord,
  asTrimmedString,
  configFailure,
  configValue,
  type SweepConfigResult,
} from './config-values.js';

/** The problem-selection kinds a config may declare. */
const SELECTION_KINDS = ['all', 'ids', 'categories'] as const;

/** Reject a name that would be unsafe in a filename, on stdout, or in a log line. */
function validName(name: string): boolean {
  return name.length <= SWEEP_CONFIG_BOUNDS.maxNameLength && SWEEP_NAME_PATTERN.test(name);
}

/** Build the per-role map for an arm that named ONE model for every role. */
function singleModelRoles(modelId: string): Readonly<Record<ModelTask, string>> {
  const roles = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) {
    roles[task] = modelId;
  }
  return roles;
}

/**
 * Read the per-role map, requiring a non-blank model id for EVERY role.
 *
 * A partial map is refused rather than back-filled from a default: a role silently
 * served by another arm's model would corrupt attribution, which is the one thing a
 * bake-off cannot survive.
 */
function parseRoleModels(
  raw: unknown,
  field: string,
): SweepConfigResult<Readonly<Record<ModelTask, string>>> {
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('ARM_INVALID', field, `${field} must be an object of role -> model id`);
  }
  const roles = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) {
    const modelId = asTrimmedString(record[task]);
    if (modelId === null) {
      return configFailure(
        'ARM_ROLE_MODEL_MISSING',
        `${field}.${task}`,
        `${field} must name a non-empty model id for every role (missing: ${task})`,
      );
    }
    roles[task] = modelId;
  }
  return configValue(roles);
}

/** Resolve the arm's models from whichever of the two declarations it used. */
function parseArmModels(
  record: Record<string, unknown>,
  field: string,
): SweepConfigResult<Readonly<Record<ModelTask, string>>> {
  const single = record.model;
  const perRole = record.roleModels;
  if (single !== undefined && perRole !== undefined) {
    return configFailure(
      'ARM_MODEL_AMBIGUOUS',
      field,
      `${field} must declare either "model" or "roleModels", not both`,
    );
  }
  if (perRole !== undefined) {
    return parseRoleModels(perRole, `${field}.roleModels`);
  }
  const modelId = asTrimmedString(single);
  if (modelId === null) {
    return configFailure(
      'ARM_INVALID',
      `${field}.model`,
      `${field} must declare "model" (one id for every role) or "roleModels" (one id per role)`,
    );
  }
  return configValue(singleModelRoles(modelId));
}

/** Parse one arm entry, attributing any failure to its index in the array. */
function parseArm(raw: unknown, index: number): SweepConfigResult<SweepArmConfig> {
  const field = `arms[${index}]`;
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('ARM_INVALID', field, `${field} must be an object`);
  }
  const name = asTrimmedString(record.name);
  if (name === null || !validName(name)) {
    return configFailure(
      'ARM_INVALID',
      `${field}.name`,
      `${field}.name must match ${SWEEP_NAME_PATTERN.source} and be at most ${SWEEP_CONFIG_BOUNDS.maxNameLength} characters`,
    );
  }
  const models = parseArmModels(record, field);
  if (!models.ok) {
    return models;
  }
  return configValue({ name, roleModels: models.value });
}

/**
 * Parse the whole arms array.
 *
 * Requires at least one arm, bounds the count, and rejects a duplicate name - a
 * duplicate would make two different model configurations share a record key, so the
 * resume index and every per-arm number would silently merge them.
 */
export function parseArms(raw: unknown): SweepConfigResult<readonly SweepArmConfig[]> {
  const entries = asArray(raw);
  if (entries === null) {
    return configFailure('FIELD_NOT_AN_ARRAY', 'arms', 'arms must be an array');
  }
  if (entries.length === 0 || entries.length > SWEEP_CONFIG_BOUNDS.maxArms) {
    return configFailure(
      'FIELD_OUT_OF_RANGE',
      'arms',
      `arms must declare between 1 and ${SWEEP_CONFIG_BOUNDS.maxArms} entries`,
    );
  }
  const arms: SweepArmConfig[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const arm = parseArm(entry, index);
    if (!arm.ok) {
      return arm;
    }
    if (seen.has(arm.value.name)) {
      return configFailure(
        'ARM_NAME_DUPLICATED',
        `arms[${index}].name`,
        `arm name ${arm.value.name} is declared more than once; names key every persisted record and must be unique`,
      );
    }
    seen.add(arm.value.name);
    arms.push(arm.value);
  }
  return configValue(arms);
}

/** Parse the explicit-id selection, bounding the list and requiring non-blank ids. */
function parseIdSelection(raw: unknown): SweepConfigResult<SweepProblemSelection> {
  const entries = asArray(raw);
  if (entries === null) {
    return configFailure(
      'PROBLEM_SELECTION_INVALID',
      'problems.ids',
      'problems.ids must be an array of problem ids',
    );
  }
  if (entries.length === 0 || entries.length > SWEEP_CONFIG_BOUNDS.maxProblemIds) {
    return configFailure(
      'PROBLEM_SELECTION_INVALID',
      'problems.ids',
      `problems.ids must name between 1 and ${SWEEP_CONFIG_BOUNDS.maxProblemIds} problems`,
    );
  }
  const ids: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const id = asTrimmedString(entry);
    if (id === null) {
      return configFailure(
        'PROBLEM_SELECTION_INVALID',
        `problems.ids[${index}]`,
        'each problem id must be a non-empty string',
      );
    }
    ids.push(id);
  }
  return configValue({ kind: 'ids', ids: [...new Set(ids)] });
}

/** Parse the category selection, narrowing each entry to a known RTLLM category. */
function parseCategorySelection(raw: unknown): SweepConfigResult<SweepProblemSelection> {
  const entries = asArray(raw);
  if (entries === null || entries.length === 0) {
    return configFailure(
      'PROBLEM_SELECTION_INVALID',
      'problems.categories',
      'problems.categories must be a non-empty array',
    );
  }
  const categories: RtllmCategory[] = [];
  for (const [index, entry] of entries.entries()) {
    const name = asTrimmedString(entry);
    const category = name === null ? null : asRtllmCategory(name);
    if (category === null) {
      return configFailure(
        'PROBLEM_SELECTION_INVALID',
        `problems.categories[${index}]`,
        'each category must be one of Arithmetic, Control, Memory, Miscellaneous',
      );
    }
    categories.push(category);
  }
  return configValue({ kind: 'categories', categories: [...new Set(categories)] });
}

/**
 * Parse the problem selection.
 *
 * The kind is required and closed: an unrecognized kind fails rather than defaulting
 * to `all`, because "run everything" is the most expensive possible interpretation of
 * a typo.
 */
export function parseProblemSelection(raw: unknown): SweepConfigResult<SweepProblemSelection> {
  const record = asRecord(raw);
  if (record === null) {
    return configFailure('PROBLEM_SELECTION_INVALID', 'problems', 'problems must be an object');
  }
  const kind = asTrimmedString(record.kind);
  if (kind === null || !SELECTION_KINDS.includes(kind as (typeof SELECTION_KINDS)[number])) {
    return configFailure(
      'PROBLEM_SELECTION_INVALID',
      'problems.kind',
      `problems.kind must be one of ${SELECTION_KINDS.join(', ')}`,
    );
  }
  if (kind === 'all') {
    return configValue({ kind: 'all' });
  }
  return kind === 'ids' ? parseIdSelection(record.ids) : parseCategorySelection(record.categories);
}
