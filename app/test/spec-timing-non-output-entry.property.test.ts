// **Feature: timing-contract-inference, Property 24: An entry naming a non-output port refuses the draft**
//
// THE CLAIM
//   A timing statement is only ever about a declared OUTPUT port. So for any draft whose entries
//   include a name that is not one, `validateSpecDraft` refuses and the refusal NAMES that entry's
//   port name. Every bad name drawn is asserted present in `signalIssues`, in entry order, with the
//   reason that says why, so a validator that refused without saying which entry is wrong fails.
//
// THE FOUR NAME CLASSES, EACH ASSERTED TO HAVE BEEN DRAWN
//   A non-output name is not one shape. It can be a declared INPUT port, the CLOCK, the RESET, or a
//   name the interface never declares at all - and the undeclared case carries `__proto__`,
//   `constructor`, and `toString` on every draw that selects it, because the gate's output-port
//   lookup is a `Set` for exactly that reason: a record index would read all three through the
//   prototype chain and admit them as declared ports.
//
// THE TRAP IN THE CLOCK CASE
//   A `ModuleInterfaceDraft` names its clock and reset separately from its port list, so either may
//   ALSO be declared as a port - and a clock that happens to be a declared output would make the
//   case prove nothing. `clockAlsoInput`/`resetAlsoInput` exercise the overlap deliberately, and
//   every bad name is asserted to be absent from the output set before the gate is consulted.
//
// WHAT THE STATED SET DOES, AS MEASURED RATHER THAN ASSUMED
//   `validateTimingContract` adds a port named by ANY entry to its stated set, including a rejected
//   one. For a NON-OUTPUT name that addition is immaterial: `timingUnstated` is derived as the
//   output set minus the stated set, so a name outside the output set could never appear there. The
//   observable consequence is asserted both ways - no bad name in `timingUnstated`, and partial
//   coverage still reports exactly the genuinely uncovered output port.
//
// THE POSITIVE CONTROL
//   The same draw also builds a draft whose entries name ONLY declared output ports, in vocabulary
//   and covering every one. It must VALIDATE and carry the contract. Without it this property would
//   pass just as well on a validator that refused everything.
//
// Validates: Requirements 10.5

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  validateSpecDraft,
  type PortDraft,
  type SpecDraft,
  type TimingContractEntryDraft,
} from '@app/agent';
import { isErr, isOk, newUlid } from '@app/core';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'timing-contract-inference, Property 24: An entry naming a non-output port refuses the draft';

/** The kinds of non-output name an entry can carry; the property requires all four. */
type NameClass = 'input' | 'clock' | 'reset' | 'undeclared';

/** Iterated in this fixed order, so a drawn class set yields a deterministic entry order. */
const NAME_CLASSES: readonly NameClass[] = ['input', 'clock', 'reset', 'undeclared'];

/** Names the gate must not mistake for declared ports (Req 10.6's lookup is a `Set`). */
const PROTOTYPE_NAMES: readonly string[] = ['__proto__', 'constructor', 'toString'];

/** In-vocabulary timing values, so every refusal here is about the PORT NAME, not the value. */
const IN_VOCABULARY = ['registered', 'combinational'] as const;

/**
 * Distinct names, sliced into fixed slots so outputs, inputs, clock, reset, and the undeclared
 * name can never collide however the counts fall.
 */
const NAME_POOL_SIZE = 11;
const MAX_PORTS_PER_DIRECTION = 4;
const INPUT_SLOT = MAX_PORTS_PER_DIRECTION;
const CLOCK_SLOT = 8;
const RESET_SLOT = 9;
const FRESH_SLOT = 10;

const OUTPUT_WIDTH = 4;
const CONTROL_WIDTH = 1;

/** The draft fields no clause of this property varies. */
const ENVELOPE = {
  goal: 'A synchronous datapath block',
  constraints: ['synchronous active-high reset'],
  architecture: 'One clocked always block drives the registered outputs.',
  acceptanceCriteria: [
    { text: 'each output settles as stated within one clock', measurable: true, method: 'formal' },
  ],
} as const;

/** One generated case: the draft under test, its control, and what each must produce. */
interface TimingCase {
  /** Entries name every drawn bad name plus the in-vocabulary output statements. */
  readonly draft: SpecDraft;
  /** The same interface, stating only declared output ports and covering every one. */
  readonly controlDraft: SpecDraft;
  readonly controlEntries: readonly TimingContractEntryDraft[];
  readonly outputNames: readonly string[];
  /** The non-output names the entries carry, in the order the entries carry them. */
  readonly badNames: readonly string[];
  readonly classes: readonly NameClass[];
  /** Declared output ports with no statement at all: a question, not a mistake. */
  readonly unstatedOutputs: readonly string[];
  readonly clockAlsoInput: boolean;
}

/** Read a required slot out of the name pool. */
function at(names: readonly string[], slot: number): string {
  const name = names[slot];
  if (name === undefined) {
    throw new Error(`name pool is missing slot ${slot}`);
  }
  return name;
}

/** The non-output names contributed by each selected class, in `NAME_CLASSES` order. */
function badNamesFor(
  classes: readonly NameClass[],
  context: {
    readonly inputName: string;
    readonly clockName: string;
    readonly resetName: string | null;
    readonly freshName: string;
  },
): readonly string[] {
  const names: string[] = [];
  for (const nameClass of NAME_CLASSES) {
    if (!classes.includes(nameClass)) {
      continue;
    }
    if (nameClass === 'input') {
      names.push(context.inputName);
    } else if (nameClass === 'clock') {
      names.push(context.clockName);
    } else if (nameClass === 'reset' && context.resetName !== null) {
      // `resetName` is nullable in the draft; the class is only selectable when it is declared.
      names.push(context.resetName);
    } else if (nameClass === 'undeclared') {
      names.push(...PROTOTYPE_NAMES, context.freshName);
    }
  }
  return names;
}

/** The raw draw, before it is assembled into a draft. */
interface RawDraw {
  readonly names: readonly string[];
  readonly outputCount: number;
  readonly inputCount: number;
  readonly clockAlsoInput: boolean;
  readonly resetAlsoInput: boolean;
  readonly resetDeclaredDraw: boolean;
  readonly classes: readonly NameClass[];
  readonly statedTimings: readonly (typeof IN_VOCABULARY)[number][];
  readonly badTiming: (typeof IN_VOCABULARY)[number];
  readonly coverAllOutputs: boolean;
  readonly badFirst: boolean;
}

function buildCase(raw: RawDraw): TimingCase {
  const outputNames = raw.names.slice(0, raw.outputCount);
  const inputNames = raw.names.slice(INPUT_SLOT, INPUT_SLOT + raw.inputCount);
  const clockName = at(raw.names, CLOCK_SLOT);
  // A reset name is drawn only when declared, so the `null` case stays honestly representable.
  const resetDeclared = raw.resetDeclaredDraw || raw.classes.includes('reset');
  const resetName = resetDeclared ? at(raw.names, RESET_SLOT) : null;

  const ports: PortDraft[] = [
    ...inputNames.map((name) => ({ name, direction: 'input', width: CONTROL_WIDTH })),
    ...outputNames.map((name) => ({ name, direction: 'output', width: OUTPUT_WIDTH })),
  ];
  if (raw.clockAlsoInput) {
    ports.push({ name: clockName, direction: 'input', width: CONTROL_WIDTH });
  }
  if (resetName !== null && raw.resetAlsoInput) {
    ports.push({ name: resetName, direction: 'input', width: CONTROL_WIDTH });
  }

  const moduleInterface = {
    moduleName: 'datapath',
    ports,
    clocking: { clockName, resetName, resetActiveLow: false },
  };

  const controlEntries: readonly TimingContractEntryDraft[] = outputNames.map(
    (portName, index) => ({
      portName,
      timing: raw.statedTimings[index] ?? 'registered',
    }),
  );
  const statedEntries = raw.coverAllOutputs ? controlEntries : controlEntries.slice(0, -1);
  const unstatedOutputs = raw.coverAllOutputs ? [] : outputNames.slice(-1);

  const badNames = badNamesFor(raw.classes, {
    inputName: at(raw.names, INPUT_SLOT),
    clockName,
    resetName,
    freshName: at(raw.names, FRESH_SLOT),
  });
  const badEntries = badNames.map((portName) => ({ portName, timing: raw.badTiming }));
  const entries = raw.badFirst
    ? [...badEntries, ...statedEntries]
    : [...statedEntries, ...badEntries];

  return {
    draft: { ...ENVELOPE, moduleInterface, timingContractEntries: entries },
    controlDraft: { ...ENVELOPE, moduleInterface, timingContractEntries: controlEntries },
    controlEntries,
    outputNames,
    // Issues come back in entry order, so the expectation is read off the entries themselves.
    badNames: entries
      .map((entry) => entry.portName)
      .filter((portName) => !outputNames.includes(portName)),
    classes: raw.classes,
    unstatedOutputs,
    clockAlsoInput: raw.clockAlsoInput,
  };
}

function arbCase(): fc.Arbitrary<TimingCase> {
  return fc
    .record({
      // Length 6 at most, so no drawn name can be one of the prototype names (shortest is 8).
      names: fc.uniqueArray(stringFromChars(ASCII_IDENT_CHARS, 1, 6), {
        minLength: NAME_POOL_SIZE,
        maxLength: NAME_POOL_SIZE,
      }),
      // At least two of each, so a mistaken entry is distinguishable from a missing one.
      outputCount: fc.integer({ min: 2, max: MAX_PORTS_PER_DIRECTION }),
      inputCount: fc.integer({ min: 2, max: MAX_PORTS_PER_DIRECTION }),
      clockAlsoInput: fc.boolean(),
      resetAlsoInput: fc.boolean(),
      resetDeclaredDraw: fc.boolean(),
      classes: fc.uniqueArray(fc.constantFrom(...NAME_CLASSES), {
        minLength: 1,
        maxLength: NAME_CLASSES.length,
      }),
      statedTimings: fc.array(fc.constantFrom(...IN_VOCABULARY), {
        minLength: MAX_PORTS_PER_DIRECTION,
        maxLength: MAX_PORTS_PER_DIRECTION,
      }),
      badTiming: fc.constantFrom(...IN_VOCABULARY),
      coverAllOutputs: fc.boolean(),
      badFirst: fc.boolean(),
    })
    .map(buildCase);
}

/** The draw shapes without which a clause of this property would go unexercised. */
interface Coverage {
  input: number;
  clock: number;
  reset: number;
  undeclared: number;
  partialCoverage: number;
  clockAlsoInput: number;
}

function countDraw(coverage: Coverage, timingCase: TimingCase): void {
  for (const nameClass of timingCase.classes) {
    coverage[nameClass] += 1;
  }
  if (timingCase.unstatedOutputs.length > 0) {
    coverage.partialCoverage += 1;
  }
  if (timingCase.clockAlsoInput) {
    coverage.clockAlsoInput += 1;
  }
}

/** The refusal clause: every non-output entry is named, and no contract is produced. */
function assertRefusesAndNames(timingCase: TimingCase): void {
  // The fixture's own precondition: a bad name that WERE a declared output would prove nothing.
  for (const badName of timingCase.badNames) {
    expect(timingCase.outputNames).not.toContain(badName);
  }
  expect(timingCase.badNames.length).toBeGreaterThan(0);

  const result = validateSpecDraft(timingCase.draft, newUlid);

  // Refused, so no contract exists to read: `ValidatedSpecCore` is the only carrier of one.
  expect(isOk(result)).toBe(false);
  if (!isErr(result)) {
    throw new Error('expected a rejection');
  }
  expect(result.error.code).toBe('SPEC_NOT_APPROVABLE');
  // Attribution: the refusal is about the timing entries, not the criteria.
  expect(result.error.unmeasurableCriteria).toEqual([]);

  expect(result.error.signalIssues.map((issue) => issue.signalName)).toEqual(timingCase.badNames);
  for (const issue of result.error.signalIssues) {
    expect(issue.reason).toContain('not a declared output port');
    expect(issue.reason).toContain(issue.signalName);
  }

  // A non-output name is outside the set `timingUnstated` is derived from, so it cannot surface
  // there however the stated set treats it; a genuinely uncovered output port still does.
  expect(result.error.timingUnstated).toEqual(timingCase.unstatedOutputs);
  for (const badName of timingCase.badNames) {
    expect(result.error.timingUnstated).not.toContain(badName);
  }
}

/** The positive control: output-only entries, in vocabulary, covering every output, validate. */
function assertControlValidates(timingCase: TimingCase): void {
  const result = validateSpecDraft(timingCase.controlDraft, newUlid);

  expect(isOk(result)).toBe(true);
  if (!isOk(result)) {
    throw new Error('expected the control draft to validate');
  }
  expect(result.value.timingContract.entries).toEqual(timingCase.controlEntries);
}

describe(PROPERTY, () => {
  it('names every entry whose port is not a declared output, and validates the output-only control', () => {
    const coverage: Coverage = {
      input: 0,
      clock: 0,
      reset: 0,
      undeclared: 0,
      partialCoverage: 0,
      clockAlsoInput: 0,
    };

    fc.assert(
      fc.property(arbCase(), (timingCase) => {
        assertRefusesAndNames(timingCase);
        assertControlValidates(timingCase);
        countDraw(coverage, timingCase);
      }),
      propertyParameters(),
    );

    // NON-VACUITY: all four name classes must actually have been drawn, or the property would be
    // a claim about whichever shape the seed happened to favour. The last two rows keep the
    // `timingUnstated` clause and the clock-is-also-a-port overlap from going unexercised.
    expect({
      input: coverage.input > 0,
      clock: coverage.clock > 0,
      reset: coverage.reset > 0,
      undeclared: coverage.undeclared > 0,
      partialCoverage: coverage.partialCoverage > 0,
      clockAlsoInput: coverage.clockAlsoInput > 0,
    }).toEqual({
      input: true,
      clock: true,
      reset: true,
      undeclared: true,
      partialCoverage: true,
      clockAlsoInput: true,
    });
  });
});
