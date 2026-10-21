// Structural parsing of untrusted Model_Router output into a `SpecDraft`.
//
// This is the FIRST half of the trust boundary: it proves the model returned a
// JSON object with the expected shape and primitive types, converting anything
// malformed into a single non-sensitive reason string. It deliberately does NOT
// apply the domain rules (positive width, valid direction, measurability): those
// belong to `validateSpecDraft` so the numbered gates (Req 5.3, 5.4, 5.9) run over
// a well-typed draft. Nothing here throws on bad input; a caller gets a `Result`.

import { err, ok, type Result } from '@app/core';

import { parseJsonEnvelope } from '../model-output-envelope.js';

import type {
  AcceptanceCriterionDraft,
  ClockingDraft,
  ModuleInterfaceDraft,
  PortDraft,
  SpecDraft,
  TimingContractEntryDraft,
} from './types.js';

/** Whether a value is a non-null plain object we can read keys from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a required non-empty string field, or explain why it is missing. */
function readNonEmptyString(
  source: Record<string, unknown>,
  field: string,
): Result<string, string> {
  const value = source[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return err(`field "${field}" must be a non-empty string`);
  }
  return ok(value);
}

/** Read a required finite-number field, or explain why it is malformed. */
function readNumber(source: Record<string, unknown>, field: string): Result<number, string> {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return err(`field "${field}" must be a finite number`);
  }
  return ok(value);
}

/** Read a required string field (may be empty), narrowing an untrusted union. */
function readString(source: Record<string, unknown>, field: string): Result<string, string> {
  const value = source[field];
  if (typeof value !== 'string') {
    return err(`field "${field}" must be a string`);
  }
  return ok(value);
}

/** Read a nullable-string field, preserving an explicit null. */
function readNullableString(
  source: Record<string, unknown>,
  field: string,
): Result<string | null, string> {
  const value = source[field];
  if (value === null) {
    return ok(null);
  }
  if (typeof value !== 'string') {
    return err(`field "${field}" must be a string or null`);
  }
  return ok(value);
}

/** Read an array of strings, or explain the first non-string element. */
function readStringArray(source: Record<string, unknown>, field: string): Result<string[], string> {
  const value = source[field];
  if (!Array.isArray(value)) {
    return err(`field "${field}" must be an array`);
  }
  const out: string[] = [];
  for (const element of value) {
    if (typeof element !== 'string') {
      return err(`field "${field}" must contain only strings`);
    }
    out.push(element);
  }
  return ok(out);
}

/** Parse one untrusted port declaration into a `PortDraft`. */
function parsePort(value: unknown): Result<PortDraft, string> {
  if (!isRecord(value)) {
    return err('each port must be an object');
  }
  const name = readString(value, 'name');
  if (!name.ok) {
    return err(`port ${name.error}`);
  }
  const direction = readString(value, 'direction');
  if (!direction.ok) {
    return err(`port ${direction.error}`);
  }
  const width = readNumber(value, 'width');
  if (!width.ok) {
    return err(`port ${width.error}`);
  }
  return ok({ name: name.value, direction: direction.value, width: width.value });
}

/** Parse the untrusted ports array into `PortDraft`s. */
function parsePorts(value: unknown): Result<PortDraft[], string> {
  if (!Array.isArray(value)) {
    return err('field "ports" must be an array');
  }
  const ports: PortDraft[] = [];
  for (const element of value) {
    const port = parsePort(element);
    if (!port.ok) {
      return err(port.error);
    }
    ports.push(port.value);
  }
  return ok(ports);
}

/** Parse the untrusted clock/reset contract. */
function parseClocking(value: unknown): Result<ClockingDraft, string> {
  if (!isRecord(value)) {
    return err('field "clocking" must be an object');
  }
  const clockName = readNullableString(value, 'clockName');
  if (!clockName.ok) {
    return err(clockName.error);
  }
  const resetName = readNullableString(value, 'resetName');
  if (!resetName.ok) {
    return err(resetName.error);
  }
  const resetActiveLow = value['resetActiveLow'];
  if (typeof resetActiveLow !== 'boolean') {
    return err('field "resetActiveLow" must be a boolean');
  }
  return ok({ clockName: clockName.value, resetName: resetName.value, resetActiveLow });
}

/** Parse the untrusted module interface. */
function parseModuleInterface(value: unknown): Result<ModuleInterfaceDraft, string> {
  if (!isRecord(value)) {
    return err('field "moduleInterface" must be an object');
  }
  const moduleName = readNonEmptyString(value, 'moduleName');
  if (!moduleName.ok) {
    return err(moduleName.error);
  }
  const ports = parsePorts(value['ports']);
  if (!ports.ok) {
    return err(ports.error);
  }
  const clocking = parseClocking(value['clocking']);
  if (!clocking.ok) {
    return err(clocking.error);
  }
  return ok({ moduleName: moduleName.value, ports: ports.value, clocking: clocking.value });
}

/** Parse one untrusted acceptance criterion into a draft (measurability checked later). */
function parseCriterion(value: unknown): Result<AcceptanceCriterionDraft, string> {
  if (!isRecord(value)) {
    return err('each acceptance criterion must be an object');
  }
  const text = readNonEmptyString(value, 'text');
  if (!text.ok) {
    return err(`acceptance criterion ${text.error}`);
  }
  const method = readString(value, 'method');
  if (!method.ok) {
    return err(`acceptance criterion ${method.error}`);
  }
  const measurable = value['measurable'];
  if (typeof measurable !== 'boolean') {
    return err('acceptance criterion field "measurable" must be a boolean');
  }
  return ok({ text: text.value, measurable, method: method.value });
}

/** Parse the untrusted acceptance-criteria array. */
function parseCriteria(value: unknown): Result<AcceptanceCriterionDraft[], string> {
  if (!Array.isArray(value)) {
    return err('field "acceptanceCriteria" must be an array');
  }
  const criteria: AcceptanceCriterionDraft[] = [];
  for (const element of value) {
    const criterion = parseCriterion(element);
    if (!criterion.ok) {
      return err(criterion.error);
    }
    criteria.push(criterion.value);
  }
  return ok(criteria);
}

/**
 * Parse one untrusted Timing_Contract entry, checking shape only.
 *
 * `timing` stays an arbitrary non-empty string on purpose: it is validated against
 * the closed `PortTiming` set in `validateSpecDraft`, which is the component that
 * reports student-facing issues. Narrowing it here would turn a reportable issue
 * into a silent parse failure, so do not add a vocabulary check.
 */
function parseTimingContractEntry(value: unknown): Result<TimingContractEntryDraft, string> {
  if (!isRecord(value)) {
    return err('each timing contract entry must be an object');
  }
  const portName = readNonEmptyString(value, 'portName');
  if (!portName.ok) {
    return err(`timing contract entry ${portName.error}`);
  }
  const timing = readNonEmptyString(value, 'timing');
  if (!timing.ok) {
    return err(`timing contract entry ${timing.error}`);
  }
  return ok({ portName: portName.value, timing: timing.value });
}

/**
 * Parse the untrusted timing-contract entries array.
 *
 * An absent field yields `[]`: a model that omitted it has stated nothing rather
 * than something malformed, and stating nothing is what reaches the Req 4.6
 * refusal and its clarifying question. A duplicate `portName` is carried through
 * unresolved; `makeTimingContract` refuses it and validation reports it.
 */
function parseTimingContractEntries(value: unknown): Result<TimingContractEntryDraft[], string> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err('field "timingContractEntries" must be an array');
  }
  const entries: TimingContractEntryDraft[] = [];
  for (const element of value) {
    const entry = parseTimingContractEntry(element);
    if (!entry.ok) {
      return err(entry.error);
    }
    entries.push(entry.value);
  }
  return ok(entries);
}

/**
 * Parse untrusted model output text into a structurally valid `SpecDraft`.
 *
 * Returns a single non-sensitive reason string on any malformed shape or type, so
 * the caller can fail safe without leaking the raw output. Domain validity is a
 * separate step (`validateSpecDraft`). A provider may wrap the object in a markdown
 * code fence, which is presentation and not a contract violation, so the shared
 * envelope helper strips one fence before parsing; every field check below is
 * unchanged.
 */
export function parseSpecDraft(outputText: string): Result<SpecDraft, string> {
  const envelope = parseJsonEnvelope(outputText);
  if (!envelope.ok) {
    return err('model output was not valid JSON');
  }
  const root = envelope.value;
  if (!isRecord(root)) {
    return err('model output must be a JSON object');
  }
  const goal = readNonEmptyString(root, 'goal');
  if (!goal.ok) {
    return err(goal.error);
  }
  const architecture = readNonEmptyString(root, 'architecture');
  if (!architecture.ok) {
    return err(architecture.error);
  }
  const constraints = readStringArray(root, 'constraints');
  if (!constraints.ok) {
    return err(constraints.error);
  }
  const moduleInterface = parseModuleInterface(root['moduleInterface']);
  if (!moduleInterface.ok) {
    return err(moduleInterface.error);
  }
  const timingContractEntries = parseTimingContractEntries(root['timingContractEntries']);
  if (!timingContractEntries.ok) {
    return err(timingContractEntries.error);
  }
  const acceptanceCriteria = parseCriteria(root['acceptanceCriteria']);
  if (!acceptanceCriteria.ok) {
    return err(acceptanceCriteria.error);
  }
  return ok({
    goal: goal.value,
    constraints: constraints.value,
    moduleInterface: moduleInterface.value,
    timingContractEntries: timingContractEntries.value,
    acceptanceCriteria: acceptanceCriteria.value,
    architecture: architecture.value,
  });
}
