// Deterministic Spec validation: the positive-width interface gate (Req 5.3, 5.9),
// the measurable-criterion gate (Req 5.4), and the Port_Timing gate (Req 10.1-10.6).
//
// This is the trust boundary for untrusted model output: a `SpecDraft` becomes a
// core `Spec` core only when every interface signal is a well-formed positive-width
// port, every acceptance criterion is verifiable by a rigorous method, and every
// declared output port carries a Port_Timing value from the closed vocabulary.
// Width validation is NOT reimplemented here; it is delegated to the core `makePort`
// constructor, and this module only translates its typed `DomainError` into a
// student-facing issue that names the offending signal. The same holds for timing:
// `makeTimingContract` builds the contract, and validation is its only caller on the
// production authoring path (it has others - `app/tools/formal/timing.ts` and many
// test fixtures call it), so no unvalidated model string reaches it while authoring.

import {
  isPortTiming,
  makePort,
  makeTimingContract,
  type AcceptanceCriterion,
  type AcceptanceMethod,
  type DomainError,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type Result,
  type TimingContract,
  type TimingContractEntry,
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
  TimingContractEntryDraft,
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

/** The correction asked of a student whose timing value is outside the vocabulary. */
const TIMING_VOCABULARY_REQUEST =
  'State the timing of this output port as either registered or combinational.';

/** The core Spec content produced once a draft passes all three validation gates. */
export interface ValidatedSpecCore {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly moduleInterface: ModuleInterface;
  /**
   * The contract built from the draft's own statements, already past
   * `makeTimingContract` (Req 10.3).
   *
   * Carrying it here is what makes the ordering structural rather than
   * conventional: a validated core cannot exist without a constructed contract,
   * so no unvalidated model string can reach the constructor downstream.
   */
  readonly timingContract: TimingContract;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly architecture: string;
}

/** Why a draft's timing statements could not produce a contract. */
interface TimingRejection {
  /** Student mistakes to list: a bad value, an unknown port, a second statement. */
  readonly issues: readonly SignalValidationIssue[];
  /** Declared output ports with no statement at all - a question, not a mistake. */
  readonly unstated: readonly string[];
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

/** The declared output port names of a validated interface. */
function outputPortNames(moduleInterface: ModuleInterface): ReadonlySet<string> {
  return new Set(
    moduleInterface.ports.filter((port) => port.direction === 'output').map((port) => port.name),
  );
}

/**
 * Validate one untrusted timing statement into a core entry, or the issue that
 * rejects it (Req 10.2, 10.4, 10.5).
 *
 * Membership is decided by the core `isPortTiming`, which is `Set.has` over the
 * closed vocabulary. A `Record<PortTiming, ...>` index would stringify the key and
 * walk the prototype chain, so `__proto__` and `constructor` would read as real
 * members even though neither is one (Req 10.6).
 */
function validateTimingEntry(
  entry: TimingContractEntryDraft,
  outputNames: ReadonlySet<string>,
  alreadyStated: ReadonlySet<string>,
): Result<TimingContractEntry, SignalValidationIssue> {
  if (!outputNames.has(entry.portName)) {
    return err({
      signalName: entry.portName,
      reason: `"${entry.portName}" is not a declared output port`,
      request: 'State timing only for declared output ports.',
    });
  }
  if (alreadyStated.has(entry.portName)) {
    return err({
      signalName: entry.portName,
      reason: `"${entry.portName}" has more than one timing statement`,
      request: 'Give this output port exactly one timing statement.',
    });
  }
  if (!isPortTiming(entry.timing)) {
    return err({
      signalName: entry.portName,
      reason: `timing "${entry.timing}" is not registered or combinational`,
      request: TIMING_VOCABULARY_REQUEST,
    });
  }
  return ok({ portName: entry.portName, timing: entry.timing });
}

/**
 * Build the Timing_Contract from the draft's own statements (Req 10.1-10.6, 4.6).
 *
 * Every fault is collected before returning, so a student sees all of them at once.
 * A port whose stated value is inadmissible is reported as an issue and NOT as
 * unstated: it was stated, just not admissibly, and nothing here coerces or
 * defaults it. A declared output port with no statement at all is `unstated`, which
 * is a question to ask rather than a mistake to list.
 */
function validateTimingContract(
  entries: readonly TimingContractEntryDraft[],
  moduleInterface: ModuleInterface,
): Result<TimingContract, TimingRejection> {
  const outputNames = outputPortNames(moduleInterface);
  const issues: SignalValidationIssue[] = [];
  const stated: TimingContractEntry[] = [];
  const statedNames = new Set<string>();
  for (const entry of entries) {
    const validated = validateTimingEntry(entry, outputNames, statedNames);
    if (validated.ok) {
      stated.push(validated.value);
    } else {
      issues.push(validated.error);
    }
    // Named by any entry at all counts as stated, so a rejected value stays an
    // issue to fix and does not also surface as an unanswered question.
    statedNames.add(entry.portName);
  }
  const unstated = [...outputNames].filter((name) => !statedNames.has(name));
  if (issues.length > 0 || unstated.length > 0) {
    return err({ issues, unstated });
  }
  const built = makeTimingContract(moduleInterface, stated);
  if (!built.ok) {
    // The three checks above cover every refusal this constructor has. A residual
    // one is still returned as an issue rather than thrown: no draft fault may
    // leave this trust boundary as an exception.
    return err({
      issues: [
        { signalName: '(timing)', reason: built.error.message, request: TIMING_VOCABULARY_REQUEST },
      ],
      unstated: [],
    });
  }
  return ok(built.value);
}

/**
 * Validate a whole `SpecDraft` into core Spec content, or the aggregate reasons it
 * cannot be approved (Req 5.3, 5.4, 5.9).
 *
 * Every gate runs so a student sees every problem at once: a draft is approvable
 * only when there are no signal issues, no unmeasurable criteria, and a contract
 * can be built from its own timing statements. This is the single deterministic
 * path the presentation, edit, and approval flows share.
 *
 * The timing gate runs third because it compares statements against the VALIDATED
 * output ports; when the interface itself is rejected there is no port list to
 * state timing about, so its issues are what the student must fix first.
 */
export function validateSpecDraft(
  draft: SpecDraft,
  newId: () => Ulid,
): Result<ValidatedSpecCore, SpecValidationError> {
  const interfaceResult = validateInterface(draft.moduleInterface);
  const { criteria, flags } = partitionAcceptanceCriteria(draft.acceptanceCriteria, newId);
  if (!interfaceResult.ok) {
    return err({
      code: 'SPEC_NOT_APPROVABLE',
      signalIssues: interfaceResult.error,
      unmeasurableCriteria: flags,
      timingUnstated: [],
    });
  }
  const timing = validateTimingContract(draft.timingContractEntries, interfaceResult.value);
  if (!timing.ok || flags.length > 0) {
    return err({
      code: 'SPEC_NOT_APPROVABLE',
      signalIssues: timing.ok ? [] : timing.error.issues,
      unmeasurableCriteria: flags,
      timingUnstated: timing.ok ? [] : timing.error.unstated,
    });
  }
  return ok({
    goal: draft.goal,
    constraints: draft.constraints,
    moduleInterface: interfaceResult.value,
    timingContract: timing.value,
    acceptanceCriteria: criteria,
    architecture: draft.architecture,
  });
}
