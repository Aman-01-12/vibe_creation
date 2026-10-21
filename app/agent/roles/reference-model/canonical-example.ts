// The one worked example the Reference_Model prompt carries (Q-19).
//
// A design outside every corpus, so it shows the encoding and not any benchmark's behaviour.
// `reference-model-example.integration.test.ts` runs these bodies against EXAMPLE_RTL.

import type { ModuleInterface, TimingContract } from '@app/core';

import type { ReferenceModelDraft } from './types.js';

/** What the example design does, in one sentence. */
export const EXAMPLE_GOAL =
  'A 3-bit down counter `cnt` that resets to 5, steps down when `en` is 1, wraps from 0 to 5, ' +
  'and raises `zero` while `cnt` is 0.';

export const EXAMPLE_INTERFACE: ModuleInterface = {
  moduleName: 'ece_example_down',
  ports: [
    { name: 'en', direction: 'input', width: 1 },
    { name: 'cnt', direction: 'output', width: 3 },
    { name: 'zero', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

export const EXAMPLE_TIMING: TimingContract = {
  entries: [
    { portName: 'cnt', timing: 'registered' },
    { portName: 'zero', timing: 'registered' },
  ],
};

/** State layout: s[2:0] holds `cnt`; the reset value 5 is not zero, so it is stated. */
export const EXAMPLE_DRAFT: ReferenceModelDraft = {
  resetStateBody: "ece_reset_state = {125'd0, 3'd5};",
  nextStateBody: [
    'reg [2:0] c;',
    'begin',
    '  c = s[2:0];',
    "  if (in[0]) c = (c == 3'd0) ? 3'd5 : c - 3'd1;",
    "  ece_next_state = {125'd0, c};",
    'end',
  ].join('\n'),
  expectBody: "ece_expect = {s[2:0] == 3'd0, s[2:0]};",
  // `en` gates whether the counter steps, so it is the one worked `enable` role declaration.
  roles: [{ portName: 'en', role: 'enable' }],
};
