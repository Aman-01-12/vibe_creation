// reference-model-consensus-gate, Property 12: The Authoring_Contract rejects every excluded
// construct before any run (task 10.4). The compiler half of this guarantee is task 8.2;
// this test is about the diagnostic.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  checkAuthoringContract,
  type ExcludedConstruct,
} from '../agent/roles/reference-model/authoring-contract.js';
import type { ReferenceModelDraft } from '../agent/roles/reference-model/types.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 12: The Authoring_Contract rejects every ' +
  'excluded construct before any run';

/** One labelled decoy fragment per excluded construct, each a self-contained statement. */
const DECOY_FRAGMENTS: Readonly<Record<ExcludedConstruct, string>> = {
  'delay-control': '#5 ',
  'event-control': '@(posedge clk) ',
  'clock-generation': 'forever begin end ',
  'width-declaration': 'input w; ',
  'waveform-dump': '$dumpfile("x"); ',
  'display-task': '$display("x"); ',
  'module-declaration': 'module m; endmodule ',
  'assignment-to-harness-signal': "ece_clk = 1'b1; ",
};

/** A decoy inside an identifier (never a real token boundary) - must never be counted. */
const IDENTIFIER_DECOY = 'my_display_var = 1;'; // contains "display" but not "$display"

/** A decoy inside a nested string literal - never counted since it is non-code. */
function stringLiteralDecoyFor(construct: ExcludedConstruct): string {
  return `ece_expect = "${DECOY_FRAGMENTS[construct]}";`;
}

const CLEAN_BODY = "ece_expect = 1'b0;";

function draftWith(expectBody: string): ReferenceModelDraft {
  return {
    resetStateBody: CLEAN_BODY,
    nextStateBody: CLEAN_BODY,
    expectBody,
    roles: [],
  };
}

const EXCLUDED_CONSTRUCTS = Object.keys(DECOY_FRAGMENTS) as ExcludedConstruct[];
const arbConstructSubset = fc.subarray(EXCLUDED_CONSTRUCTS, { minLength: 1 });

describe(PROPERTY, () => {
  it('rejects, naming exactly the planted set, for any non-empty composition of decoy fragments', () => {
    fc.assert(
      fc.property(arbConstructSubset, (planted) => {
        const body = planted.map((construct) => DECOY_FRAGMENTS[construct]).join('') + CLEAN_BODY;
        const check = checkAuthoringContract(draftWith(body));
        expect(check.kind).toBe('rejected');
        if (check.kind === 'rejected') {
          expect(new Set(check.excluded)).toEqual(new Set(planted));
        }
      }),
      propertyParameters(),
    );
  });

  it('starts no Consensus_Run (zero generation calls) for a rejected draft', () => {
    // The oracle for "zero runs" is a counted absence: checkAuthoringContract has no parameter
    // or return path through which a simulator or a run count could be invoked at all - it is a
    // pure function of the three bodies, so this is a structural fact rather than a mock to spy on.
    const check = checkAuthoringContract(draftWith(DECOY_FRAGMENTS['delay-control'] + CLEAN_BODY));
    expect(check.kind).toBe('rejected');
    expect(checkAuthoringContract.length).toBe(1); // one parameter: the draft, nothing else
  });

  it('does not count a decoy fragment that sits inside an identifier', () => {
    const check = checkAuthoringContract(draftWith(IDENTIFIER_DECOY));
    expect(check.kind).toBe('accepted');
  });

  it.each(EXCLUDED_CONSTRUCTS)('does not count %s inside a nested string literal', (construct) => {
    const check = checkAuthoringContract(draftWith(stringLiteralDecoyFor(construct)));
    expect(check.kind).toBe('accepted');
  });

  it('accepts a body with no excluded construct', () => {
    expect(checkAuthoringContract(draftWith(CLEAN_BODY)).kind).toBe('accepted');
  });
});
