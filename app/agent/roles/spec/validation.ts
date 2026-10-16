// Deterministic Spec validation: the positive-width interface gate (Req 5.3, 5.9)
// and the measurable-criterion gate (Req 5.4).
//
// This is the trust boundary for untrusted model output: a `SpecDraft` becomes a
// core `Spec` core only when every interface signal is a well-formed positive-width
// port and every acceptance criterion is verifiable by a rigorous method. Width
// validation is NOT reimplemented here; it is delegated to the core `makePort`
// constructor, and this module only translates its typed `DomainError` into a
// student-facing issue that names the offending signal.

import {
  makePort,
  type AcceptanceCriterion,
  type AcceptanceMethod,
  type DomainError,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type Result,
  type Ulid,
  err,
  ok,
} from '@app/core';

import type {
  AcceptanceCriterionDraft,
  ModuleInterfaceDraft,
  PortDraft,
  SignalValidationIssue,
  SpecDraft,
  SpecValidationError,
  UnmeasurableCriterionFlag,
} from './types.js';

/**
 * The rigorous verification methods an acceptance criterion may claim (Req 5.4).
 *
 * This mirrors the closed core `AcceptanceMethod` union as a runtime set so an
 * untrusted method string can be checked for membership; the two are kept in sync
 * deliberately (the core union has no runtime form to derive this from).
 */
const RIGOROUS_ACCEPTANCE_METHODS: ReadonlySet<AcceptanceMethod> = new Set<AcceptanceMethod>([
  'simulation',
  'formal',
  'manual-inspection',
]);

/** The interface port directions the core `PortDirection` union permits. */
const PORT_DIRECTIONS: ReadonlySet<PortDirection> = new Set<PortDirection>([
  'input',
  'output',
  'inout',
]);

/** The measurable-replacement request attached to every flagged criterion (Req 5.4). */
const MEASURABLE_REPLACEMENT_REQUEST =
  'Replace with a criterion measurable by simulation, formal verification, or manual inspection.';

/** The core Spec content produced once a draft passes both validation gates. */
export interface ValidatedSpecCore {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly moduleInterface: ModuleInterface;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly architecture: string;
}

/** Narrow an untrusted string to a core `PortDirection`. */
function isPortDirection(direction: string): direction is PortDirection {
  return PORT_DIRECTIONS.has(direction as PortDirection);
}

/** Narrow an untrusted string to a rigorous core `AcceptanceMethod`. */
export function isRigorousMethod(method: string): method is AcceptanceMethod {
  return RIGOROUS_ACCEPTANCE_METHODS.has(method as AcceptanceMethod);
}

/**
 * The explicit measurability predicate over an acceptance criterion (Req 5.4).
 *
 * A criterion is verifiable only when it is both marked measurable AND its method
 * is one of the rigorous methods; either failing flags it for replacement. This is
 * the single definition Property 16 states over.
 */
export function isCriterionMeasurable(draft: AcceptanceCriterionDraft): boolean {
  return draft.measurable && isRigorousMethod(draft.method);
}

/** The student-facing label for a signal, falling back to its position when unnamed. */
function signalLabel(draft: PortDraft, index: number): string {
  return draft.name.trim().length > 0 ? draft.name : `signal #${index + 1}`;
}

/** Translate the typed `makePort` rejection into a signal issue naming the offender. */
function issueFromPortError(
  error: DomainError,
  draft: PortDraft,
  label: string,
): SignalValidationIssue {
  if (error.code === 'PORT_WIDTH_NOT_POSITIVE_INTEGER') {
    return {
      signalName: label,
      reason: `bit width ${draft.width} is not a positive integer`,
      request: 'Declare a positive integer bit width for this signal.',
    };
  }
  return {
    signalName: label,
    reason: 'signal name must not be empty',
    request: 'Give this signal a non-empty name.',
  };
}

/** Validate a single port draft into a core `Port`, or the issue that rejects it. */
function validatePort(draft: PortDraft, index: number): Result<Port, SignalValidationIssue> {
  const label = signalLabel(draft, index);
  if (!isPortDirection(draft.direction)) {
    return err({
      signalName: label,
      reason: `direction "${draft.direction}" is not one of input, output, inout`,
      request: 'Declare the signal direction as input, output, or inout.',
    });
  }
  // Width validation is delegated to makePort (Req 5.3, 5.9); we only translate.
  const built = makePort({ name: draft.name, direction: draft.direction, width: draft.width });
  if (!built.ok) {
    return err(issueFromPortError(built.error, draft, label));
  }
  return ok(built.value);
}

/**
 * Validate every interface signal (Req 5.3, 5.9).
 *
 * Returns the built `ModuleInterface` when all ports have a name, a valid
 * direction, and a positive integer width; otherwise returns every offending
 * signal so the student can correct them in one pass.
 */
export function validateInterface(
  draft: ModuleInterfaceDraft,
): Result<ModuleInterface, readonly SignalValidationIssue[]> {
  const issues: SignalValidationIssue[] = [];
  if (draft.moduleName.trim().length === 0) {
    issues.push({
      signalName: '(module)',
      reason: 'module name must not be empty',
      request: 'Give the module a non-empty name.',
    });
  }
  const ports: Port[] = [];
  draft.ports.forEach((portDraft, index) => {
    const result = validatePort(portDraft, index);
    if (result.ok) {
      ports.push(result.value);
    } else {
      issues.push(result.error);
    }
  });
  if (issues.length > 0) {
    return err(issues);
  }
  // The draft has no Validity_Output concept yet; a later task wires the Spec
  // role's own proposal through. `null` here changes no behaviour.
  return ok({
    moduleName: draft.moduleName,
    ports,
    clocking: draft.clocking,
    validityOutputName: null,
  });
}

/** Explain why a criterion is not verifiable by a rigorous method (Req 5.4). */
function unmeasurableReason(draft: AcceptanceCriterionDraft): string {
  if (!draft.measurable) {
    return 'criterion is not marked measurable';
  }
  return `verification method "${draft.method}" is not simulation, formal, or manual-inspection`;
}

/**
 * Partition acceptance criteria into validated ones and flagged ones (Req 5.4).
 *
 * A measurable criterion is turned into a core `AcceptanceCriterion` with a fresh
 * id and its method narrowed to the rigorous union; an unmeasurable one is flagged
 * with a measurable-replacement request and never becomes part of the Spec.
 */
export function partitionAcceptanceCriteria(
  drafts: readonly AcceptanceCriterionDraft[],
  newId: () => Ulid,
): {
  readonly criteria: readonly AcceptanceCriterion[];
  readonly flags: readonly UnmeasurableCriterionFlag[];
} {
  const criteria: AcceptanceCriterion[] = [];
  const flags: UnmeasurableCriterionFlag[] = [];
  for (const draft of drafts) {
    // `isRigorousMethod` both decides measurability and narrows the method type;
    // it is exactly `isCriterionMeasurable` inlined so TS can narrow the union.
    if (draft.measurable && isRigorousMethod(draft.method)) {
      criteria.push({ id: newId(), text: draft.text, measurable: true, method: draft.method });
    } else {
      flags.push({
        criterionText: draft.text,
        reason: unmeasurableReason(draft),
        replacementRequest: MEASURABLE_REPLACEMENT_REQUEST,
      });
    }
  }
  return { criteria, flags };
}

/**
 * Validate a whole `SpecDraft` into core Spec content, or the aggregate reasons it
 * cannot be approved (Req 5.3, 5.4, 5.9).
 *
 * Both gates run so a student sees every problem at once: a draft is approvable
 * only when there are no signal issues AND no unmeasurable criteria. This is the
 * single deterministic path the presentation, edit, and approval flows share.
 */
export function validateSpecDraft(
  draft: SpecDraft,
  newId: () => Ulid,
): Result<ValidatedSpecCore, SpecValidationError> {
  const interfaceResult = validateInterface(draft.moduleInterface);
  const { criteria, flags } = partitionAcceptanceCriteria(draft.acceptanceCriteria, newId);
  if (!interfaceResult.ok || flags.length > 0) {
    const signalIssues = interfaceResult.ok ? [] : interfaceResult.error;
    return err({ code: 'SPEC_NOT_APPROVABLE', signalIssues, unmeasurableCriteria: flags });
  }
  return ok({
    goal: draft.goal,
    constraints: draft.constraints,
    moduleInterface: interfaceResult.value,
    acceptanceCriteria: criteria,
    architecture: draft.architecture,
  });
}
