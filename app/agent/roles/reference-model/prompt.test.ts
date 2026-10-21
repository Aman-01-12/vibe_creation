// The Reference_Model prompt's Port_Timing read: declared, never defaulted.
//
// WHY THIS TEST EXISTS
//   `timingOf` read `?? 'registered'` until timing-contract-inference landed. That made the
//   prompt a FOURTH all-`registered` fabrication site, alongside the three the feature retired
//   (Corpus_Importer, Spec_Agent, Live_Wiring) and which its Requirement 9.3 enumerates. The
//   consequence was not cosmetic: the prompt renders the per-port timing into the text the model
//   authors against, so a combinational port described as `registered` instructs the model to
//   write `ece_expect` off retained state alone, and the Consensus_Harness then compares that
//   against the applied input. That is the exact shape that made 13 corpus designs unwinnable.
//
//   The contract reaching this function is total through both real paths, so the absent-entry
//   case is unreachable in production and the throw is defense in depth. It is asserted anyway,
//   because the thing being pinned is that NO value is invented here - a test that only checked
//   the reachable paths would pass just as happily with the old `?? 'registered'` restored.

import { describe, expect, it } from 'vitest';

import { makeTimingContract, newUlid, type ModuleInterface, type Spec } from '@app/core';

import { buildReferenceModelInput } from './prompt.js';

const INTERFACE: ModuleInterface = {
  moduleName: 'adder_2bit',
  ports: [
    { name: 'a', direction: 'input', width: 2 },
    { name: 'b', direction: 'input', width: 2 },
    { name: 'sum', direction: 'output', width: 2 },
    { name: 'cout', direction: 'output', width: 1 },
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

function specWith(spec: Partial<Spec> & Pick<Spec, 'timingContract'>): Spec {
  return {
    id: newUlid(),
    version: 1,
    goal: 'Add two 2-bit numbers.',
    constraints: [],
    architecture: '',
    moduleInterface: INTERFACE,
    acceptanceCriteria: [],
    approved: true,
    ...spec,
  } as Spec;
}

/** A contract built the one supported way, total over both declared output ports. */
function totalContract(timing: 'registered' | 'combinational') {
  const built = makeTimingContract(INTERFACE, [
    { portName: 'sum', timing },
    { portName: 'cout', timing },
  ]);
  if (!built.ok) throw new Error(`fixture defect: ${built.error.code}`);
  return built.value;
}

describe('the Reference_Model prompt renders the DECLARED Port_Timing', () => {
  it('describes a combinational port as able to depend on the applied input', () => {
    const prompt = buildReferenceModelInput(
      specWith({ timingContract: totalContract('combinational') }),
    ).prompt;

    expect(prompt).toContain('sum (combinational: may depend on `s` and on `in`)');
    expect(prompt).toContain('cout (combinational: may depend on `s` and on `in`)');
    // The registered phrasing must not appear for a combinational contract, which is the
    // substitution the old `?? 'registered'` default could silently make.
    expect(prompt).not.toContain('sum (registered: depends on `s` only)');
  });

  it('describes a registered port as depending on retained state alone', () => {
    const prompt = buildReferenceModelInput(
      specWith({ timingContract: totalContract('registered') }),
    ).prompt;

    expect(prompt).toContain('sum (registered: depends on `s` only)');
    expect(prompt).not.toContain('sum (combinational: may depend on `s` and on `in`)');
  });

  it('refuses to invent a Port_Timing for an output port the contract omits', () => {
    // Reachable only from a hand-built contract literal: both real paths go through
    // `makeTimingContract`, which is total. The point is that no value is substituted.
    expect(() => buildReferenceModelInput(specWith({ timingContract: { entries: [] } }))).toThrow(
      /unreachable: Timing_Contract carries no entry for output port "sum"/,
    );
  });

  it('refuses a partially-stated contract rather than defaulting the missing port', () => {
    expect(() =>
      buildReferenceModelInput(
        specWith({ timingContract: { entries: [{ portName: 'sum', timing: 'combinational' }] } }),
      ),
    ).toThrow(/unreachable: Timing_Contract carries no entry for output port "cout"/);
  });
});
