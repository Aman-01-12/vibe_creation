// The Scoreboard_Scaffold's refusals: each interface that cannot carry a scoreboard is refused
// before any model call could be made (testbench-in-order-scoreboard, task 3.4).

import { describe, expect, it } from 'vitest';

import { renderScoreboardScaffold } from '@app/agent';
import type { ModuleInterface, Port } from '@app/core';

function iface(ports: readonly Port[], clockName: string | null = 'clk'): ModuleInterface {
  return {
    validityOutputName: null,
    moduleName: 'm',
    ports,
    clocking: { clockName, resetName: null, resetActiveLow: false },
  };
}

const CLK: Port = { name: 'clk', direction: 'input', width: 1 };
const VALID_OUT: Port = { name: 'valid_out', direction: 'output', width: 1 };
const DATA_OUT: Port = { name: 'data_out', direction: 'output', width: 8 };
const DATA_IN: Port = { name: 'data_in', direction: 'input', width: 8 };

describe('renderScoreboardScaffold refusals', () => {
  it('accepts a clocked interface with one qualifier and one data output', () => {
    expect(renderScoreboardScaffold(iface([CLK, DATA_IN, VALID_OUT, DATA_OUT]), ['ac1_x']).ok).toBe(
      true,
    );
  });

  it('refuses a clockless interface', () => {
    expect(
      renderScoreboardScaffold(iface([DATA_IN, VALID_OUT, DATA_OUT], null), ['ac1_x']),
    ).toEqual({
      ok: false,
      error: { reason: 'no-clock' },
    });
  });

  it('refuses zero and two Output_Qualifiers', () => {
    const none = iface([CLK, DATA_IN, DATA_OUT]);
    const two = iface([
      CLK,
      DATA_IN,
      VALID_OUT,
      { name: 'done', direction: 'output', width: 1 },
      DATA_OUT,
    ]);
    expect(renderScoreboardScaffold(none, ['ac1_x'])).toEqual({
      ok: false,
      error: { reason: 'not-one-output-qualifier' },
    });
    expect(renderScoreboardScaffold(two, ['ac1_x'])).toEqual({
      ok: false,
      error: { reason: 'not-one-output-qualifier' },
    });
  });

  it('refuses a port that would alias scaffold state', () => {
    const prefixed = iface([
      CLK,
      { name: 'sb_count', direction: 'input', width: 4 },
      VALID_OUT,
      DATA_OUT,
    ]);
    const named = iface([
      CLK,
      { name: 'send_transaction', direction: 'input', width: 1 },
      VALID_OUT,
      DATA_OUT,
    ]);
    expect(renderScoreboardScaffold(prefixed, ['ac1_x'])).toEqual({
      ok: false,
      error: { reason: 'reserved-name', port: 'sb_count' },
    });
    expect(renderScoreboardScaffold(named, ['ac1_x'])).toEqual({
      ok: false,
      error: { reason: 'reserved-name', port: 'send_transaction' },
    });
  });

  it('refuses an interface whose only output is the qualifier', () => {
    expect(renderScoreboardScaffold(iface([CLK, DATA_IN, VALID_OUT]), ['ac1_x'])).toEqual({
      ok: false,
      error: { reason: 'no-data-output' },
    });
  });

  it('refuses a check name that could break the $display format', () => {
    for (const bad of ['ac1"x', 'ac1%s', 'a b', '']) {
      expect(renderScoreboardScaffold(iface([CLK, DATA_IN, VALID_OUT, DATA_OUT]), [bad])).toEqual({
        ok: false,
        error: { reason: 'invalid-check-name', check: bad },
      });
    }
  });
});
