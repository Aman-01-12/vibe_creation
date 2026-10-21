// The Spec_Validation Port_Timing gate: four draft faults, four distinct outcomes
// (task 8.4; Req 10.1-10.6, 4.6).
//
// WHY FOUR SEPARATE CASES
//   Three of these faults are student mistakes to LIST, so they share the
//   `signalIssues` aggregate; the fourth is a QUESTION to ASK, so it is the separate
//   `timingUnstated` member a later task turns into a Behaviour_Question. Collapsing
//   them into one "it is rejected" assertion would let that distinction rot while
//   staying green. Every case also asserts NO contract is produced, because the
//   whole point of the gate is that an unreadable value is never coerced into one.

import { validateSpecDraft, type SpecDraft } from '@app/agent';
import { isErr, isOk, newUlid } from '@app/core';
import { describe, expect, it } from 'vitest';

/** A draft whose interface and criteria both pass, so only timing can reject it. */
const SOUND_DRAFT: SpecDraft = {
  goal: 'a 4-bit synchronous up counter',
  constraints: [],
  architecture: 'one clocked always block increments q on each rising clk edge',
  moduleInterface: {
    moduleName: 'counter',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'q', direction: 'output', width: 4 },
      { name: 'carry', direction: 'output', width: 1 },
    ],
    clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
  },
  timingContractEntries: [
    { portName: 'q', timing: 'registered' },
    { portName: 'carry', timing: 'combinational' },
  ],
  acceptanceCriteria: [
    { text: 'q increments by one per clock', measurable: true, method: 'simulation' },
  ],
};

/** Validate a draft whose timing statements are replaced by `entries`. */
function validateWithEntries(entries: SpecDraft['timingContractEntries']) {
  return validateSpecDraft({ ...SOUND_DRAFT, timingContractEntries: entries }, newUlid);
}

describe('Spec_Validation Port_Timing gate (Req 10.1-10.6, 4.6)', () => {
  it('given complete in-vocabulary statements when validated then the core carries the contract', () => {
    const result = validateSpecDraft(SOUND_DRAFT, newUlid);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      throw new Error('expected a validated core');
    }
    expect(result.value.timingContract.entries).toEqual([
      { portName: 'q', timing: 'registered' },
      { portName: 'carry', timing: 'combinational' },
    ]);
  });

  it('given a timing value outside the vocabulary when validated then it is an issue naming the port', () => {
    const result = validateWithEntries([
      { portName: 'q', timing: 'eventually-maybe' },
      { portName: 'carry', timing: 'combinational' },
    ]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) {
      throw new Error('expected a rejection');
    }
    expect(result.error.signalIssues).toHaveLength(1);
    expect(result.error.signalIssues[0]?.signalName).toBe('q');
    expect(result.error.signalIssues[0]?.reason).toContain('eventually-maybe');
    // Stated-but-inadmissible is a mistake to fix, not an unanswered question.
    expect(result.error.timingUnstated).toEqual([]);
  });

  it('given a prototype-chain name as the timing value when validated then it is not a member', () => {
    // Req 10.6: a `Record<PortTiming, ...>` index would read these through the
    // prototype chain and admit them; `Set.has` membership does not.
    for (const timing of ['__proto__', 'constructor', 'toString']) {
      const result = validateWithEntries([
        { portName: 'q', timing },
        { portName: 'carry', timing: 'combinational' },
      ]);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.signalIssues[0]?.signalName).toBe('q');
      }
    }
  });

  it('given an entry naming something that is not a declared output port when validated then it is an issue naming that entry', () => {
    const result = validateWithEntries([
      ...SOUND_DRAFT.timingContractEntries,
      { portName: 'clk', timing: 'registered' },
      { portName: 'not_a_port', timing: 'registered' },
    ]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) {
      throw new Error('expected a rejection');
    }
    expect(result.error.signalIssues.map((issue) => issue.signalName)).toEqual([
      'clk',
      'not_a_port',
    ]);
    expect(result.error.signalIssues[0]?.reason).toContain('not a declared output port');
    expect(result.error.timingUnstated).toEqual([]);
  });

  it('given a duplicate entry for one output port when validated then it is an issue naming that port', () => {
    const result = validateWithEntries([
      ...SOUND_DRAFT.timingContractEntries,
      { portName: 'q', timing: 'combinational' },
    ]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) {
      throw new Error('expected a rejection');
    }
    expect(result.error.signalIssues).toHaveLength(1);
    expect(result.error.signalIssues[0]?.signalName).toBe('q');
    expect(result.error.signalIssues[0]?.reason).toContain('more than one timing statement');
    expect(result.error.timingUnstated).toEqual([]);
  });

  it('given no statement for a declared output port when validated then it is unstated, not an issue', () => {
    const result = validateWithEntries([{ portName: 'q', timing: 'registered' }]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) {
      throw new Error('expected a rejection');
    }
    // An absent statement is a question to ask, so it is NOT in the issue list.
    expect(result.error.signalIssues).toEqual([]);
    expect(result.error.timingUnstated).toEqual(['carry']);
  });

  it('given every output port unstated when validated then every name is reported at once', () => {
    const result = validateWithEntries([]);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.timingUnstated).toEqual(['q', 'carry']);
    }
  });
});
