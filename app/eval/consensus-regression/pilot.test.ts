// The pilot's diagnosis rests on these three helpers, so each is pinned on a known input.

import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';

import { bodiesNamedBy, locateMismatches, renderRefModel } from './pilot.js';

const COUNTER: ModuleInterface = {
  moduleName: 'counter_12',
  ports: [
    { name: 'valid_count', direction: 'input', width: 1 },
    { name: 'out', direction: 'output', width: 4 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

const DRAFT = {
  resetStateBody: "ece_reset_state = 128'd0;",
  nextStateBody: 'ece_next_state = s;\n// two lines',
  expectBody: "ece_expect = 4'd0;",
  roles: [{ portName: 'valid_count', role: 'data' as const }],
};

describe('renderRefModel', () => {
  it('records the 1-based line range each body occupies', () => {
    const rendered = renderRefModel(COUNTER, DRAFT);
    const lines = rendered.file.contents.split('\n');

    expect(rendered.bodyLines.ece_reset_state).toEqual({ first: 2, last: 2 });
    expect(rendered.bodyLines.ece_next_state).toEqual({ first: 5, last: 6 });
    expect(rendered.bodyLines.ece_expect).toEqual({ first: 9, last: 9 });
    expect(lines[rendered.bodyLines.ece_expect.first - 1]).toBe(DRAFT.expectBody);
  });
});

describe('bodiesNamedBy', () => {
  it('maps a refmodel.v line diagnostic to the body that holds that line', () => {
    const rendered = renderRefModel(COUNTER, DRAFT);
    const stderr = "refmodel.v:6: error: Unable to bind wire `rst_n'\ndut_reference.v:3: warning";

    expect(bodiesNamedBy(stderr, rendered)).toEqual(['ece_next_state']);
  });

  it('names nothing for a diagnostic on a header line', () => {
    expect(bodiesNamedBy('refmodel.v:1: error: x', renderRefModel(COUNTER, DRAFT))).toEqual([]);
  });
});

describe('locateMismatches', () => {
  it('reports the first failing step and port, and counts failing steps', () => {
    const stdout = [
      'CHECK n1_out PASS',
      'ECE_SAMPLE n1 0 0',
      'CHECK n1_out FAIL: expected 1, got 0',
      'ECE_SAMPLE n1 1 0',
      'CHECK n1_out FAIL: expected 2, got 1',
      'ECE_SAMPLE n1 2 1',
      'ECE_SAMPLE_END n1 3',
    ].join('\n');

    expect(locateMismatches(stdout, 'n1')).toEqual({
      first: { step: 1, port: 'out', expected: '1', got: '0' },
      failingSteps: 2,
      sampledSteps: 3,
    });
  });

  it('ignores a FAIL line forged under another nonce', () => {
    const stdout = 'CHECK evil_out FAIL: expected 1, got 0\nECE_SAMPLE n1 0 0';
    expect(locateMismatches(stdout, 'n1').first).toBeNull();
  });
});
