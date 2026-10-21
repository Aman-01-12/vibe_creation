// Boundary validation for untrusted Reference_Model model output (C7, Req 1.1, 1.3-1.6, 1.8, 1.10).
//
// The model replies with a JSON object: { "functions": [...], "roles": [...] }.
// Exactly three function entries are required, named ece_reset_state/ece_next_state/ece_expect
// with no duplicate and no extra - any other count is a refusal, not a best-effort read.
// `roles` must be a Total_Role_Declaration over moduleInterface's input ports (C1, C2).

import { err, ok, type Result } from '@app/core';
import type { ModuleInterface } from '@app/core';
import { INPUT_ROLES, type InputRole, type PortRole, type RoleDeclaration } from '@app/tools';

import { parseJsonEnvelope } from '../model-output-envelope.js';
import type { ReferenceModelDraft, ReferenceModelParseError } from './types.js';

/** Bounds one function body's length, to bound memory from untrusted output. */
const MAX_BODY_CHARS = 20_000;

const EXPECTED_NAMES = ['ece_reset_state', 'ece_next_state', 'ece_expect'] as const;
type ExpectedName = (typeof EXPECTED_NAMES)[number];

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExpectedName(value: unknown): value is ExpectedName {
  return typeof value === 'string' && (EXPECTED_NAMES as readonly string[]).includes(value);
}

function isInputRole(value: unknown): value is InputRole {
  return typeof value === 'string' && (INPUT_ROLES as readonly string[]).includes(value);
}

function parseError(reason: string): ReferenceModelParseError {
  return { reason };
}

function parseEnvelope(raw: string): Result<UnknownRecord, ReferenceModelParseError> {
  const envelope = parseJsonEnvelope(raw);
  if (!envelope.ok) {
    return err(parseError('model output was not valid JSON'));
  }
  if (!isRecord(envelope.value)) {
    return err(parseError('model output was not a JSON object'));
  }
  return ok(envelope.value);
}

/** One name's body, or `undefined` if the entry is missing or unreadable. */
function readBody(entries: UnknownRecord[], name: ExpectedName): string | undefined {
  const matches = entries.filter((entry) => entry.name === name);
  if (matches.length !== 1) {
    return undefined;
  }
  const { body } = matches[0] as UnknownRecord;
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_BODY_CHARS) {
    return undefined;
  }
  return body;
}

/**
 * Parse the untrusted `roles` field into a Total_Role_Declaration over `inputPortNames`.
 *
 * Checks run in the fixed order criterion 1.4-1.6 names, so a reply with two faults
 * reports the first deterministically: no roles array, a malformed entry, an out-of-
 * vocabulary role, a duplicate port, an undeclared port, then an omitted input port.
 */
function parseRoleDeclaration(
  roles: unknown,
  inputPortNames: ReadonlySet<string>,
): Result<RoleDeclaration, ReferenceModelParseError> {
  if (!Array.isArray(roles)) {
    return err(parseError('model output carried no roles array'));
  }
  const entries: { readonly port: string; readonly role: string }[] = [];
  for (const entry of roles) {
    if (!isRecord(entry) || typeof entry.port !== 'string' || typeof entry.role !== 'string') {
      return err(parseError('model output had a malformed role entry'));
    }
    entries.push({ port: entry.port, role: entry.role });
  }
  for (const entry of entries) {
    if (!isInputRole(entry.role)) {
      return err(parseError('model output named a role outside {data, enable}'));
    }
  }
  const seenPorts = new Set<string>();
  for (const entry of entries) {
    if (seenPorts.has(entry.port)) {
      return err(parseError('model output named one input port twice'));
    }
    seenPorts.add(entry.port);
  }
  for (const entry of entries) {
    if (!inputPortNames.has(entry.port)) {
      return err(parseError('model output named a port the interface does not declare'));
    }
  }
  for (const portName of inputPortNames) {
    if (!seenPorts.has(portName)) {
      return err(parseError('model output omitted an input port'));
    }
  }
  const portRoles: PortRole[] = entries.map((entry) => ({
    portName: entry.port,
    role: entry.role as InputRole,
  }));
  return ok(portRoles);
}

/**
 * Parse the Reference_Model function bodies and Role_Declaration from untrusted model text.
 *
 * Requires exactly three `functions` entries, each a distinct expected name with a
 * non-empty, length-bounded body, plus a `roles` array that totally covers
 * `moduleInterface`'s input ports from the closed Role_Vocabulary. Any other function
 * count, a duplicate or unexpected function name, or a roles fault is a refusal.
 * `moduleInterface` is read for its input port NAME set only (Req 1.8): no RTL, mutant,
 * or signature field reaches this parser.
 */
export function parseReferenceModelDraft(
  raw: string,
  moduleInterface: ModuleInterface,
): Result<ReferenceModelDraft, ReferenceModelParseError> {
  const envelopeResult = parseEnvelope(raw);
  if (!envelopeResult.ok) {
    return envelopeResult;
  }
  const { functions, roles } = envelopeResult.value;
  if (!Array.isArray(functions) || functions.length !== EXPECTED_NAMES.length) {
    return err(parseError('model output did not supply exactly three function bodies'));
  }
  const entries = functions.filter(isRecord);
  if (entries.length !== functions.length) {
    return err(parseError('model output had a malformed function entry'));
  }
  const names = entries.map((entry) => entry.name);
  if (!names.every(isExpectedName) || new Set(names).size !== EXPECTED_NAMES.length) {
    return err(parseError('model output did not name the three required functions'));
  }
  const resetStateBody = readBody(entries, 'ece_reset_state');
  const nextStateBody = readBody(entries, 'ece_next_state');
  const expectBody = readBody(entries, 'ece_expect');
  if (resetStateBody === undefined || nextStateBody === undefined || expectBody === undefined) {
    return err(parseError('model output had an unreadable or oversized function body'));
  }
  const inputPortNames = new Set(
    moduleInterface.ports.filter((port) => port.direction === 'input').map((port) => port.name),
  );
  const rolesResult = parseRoleDeclaration(roles, inputPortNames);
  if (!rolesResult.ok) {
    return rolesResult;
  }
  return ok({ resetStateBody, nextStateBody, expectBody, roles: rolesResult.value });
}
