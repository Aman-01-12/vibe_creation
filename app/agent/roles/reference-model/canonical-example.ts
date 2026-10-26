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

// The second worked example: the case the down counter cannot show.
//
// WHY A SECOND EXAMPLE AT ALL
//   `ece_example_down`'s registered outputs are a function of `cnt`, which IS the state, so its
//   `ece_expect` reads `s` without the author ever deciding to put an output register into the
//   state. A registered output the INPUT determines is the case that decision is forced, and 0 of
//   8 draws on an edge-detect-shaped design made it: every one wrote the pre-register expression
//   over `in`, which is the value the output takes one edge LATER, and mismatched at every step.
//   This example shows the state carrying the output register itself.

/** What the second example design does, in one sentence. */
export const EXAMPLE2_GOAL =
  'A 2-bit input `d` with a registered output `changed` that is 1 for the step after `d` ' +
  'differs from its value one clock earlier.';

export const EXAMPLE2_INTERFACE: ModuleInterface = {
  moduleName: 'ece_example_changed',
  ports: [
    { name: 'd', direction: 'input', width: 2 },
    { name: 'changed', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

export const EXAMPLE2_TIMING: TimingContract = {
  entries: [{ portName: 'changed', timing: 'registered' }],
};

/**
 * State layout: s[1:0] holds `d` as of the last edge, and s[2] holds `changed` ITSELF.
 *
 * `changed` is a register, so what it shows now is part of the state, not something `in` can
 * say anything about - which is why `ece_expect` reads `s[2]` and never `in`.
 */
export const EXAMPLE2_DRAFT: ReferenceModelDraft = {
  resetStateBody: "ece_reset_state = 128'd0;",
  nextStateBody: [
    'reg [1:0] prev_d;',
    'reg changed_next;',
    'begin',
    '  prev_d = s[1:0];',
    '  changed_next = (in[1:0] != prev_d);',
    "  ece_next_state = {125'd0, changed_next, in[1:0]};",
    'end',
  ].join('\n'),
  expectBody: 'ece_expect = s[2];',
  roles: [{ portName: 'd', role: 'data' }],
};
