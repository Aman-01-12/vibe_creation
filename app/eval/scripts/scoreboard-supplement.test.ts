// The supplement script applies the runner's own rule: designs outside the baseline that route
// In_Order_Scoreboard under Treatment, and every Campaign design's Design_Group (Req 8.4, 8.8).

import type { Port, Spec } from '@app/core';
import { describe, expect, it } from 'vitest';

import type { EvalProblem } from '../problem.js';
import { scoreboardCampaignLists } from './scoreboard-supplement.js';

/** A problem whose interface is clocked, with or without one output qualifier. */
function problem(id: string, streaming: boolean): EvalProblem {
  const ports: Port[] = [
    { name: 'clk', direction: 'input', width: 1 },
    { name: 'data_in', direction: 'input', width: 8 },
    ...(streaming ? [{ name: 'valid_out', direction: 'output' as const, width: 1 }] : []),
    { name: 'data_out', direction: 'output', width: 8 },
  ];
  const spec = {
    moduleInterface: {
      moduleName: id,
      ports,
      clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
    },
  } as unknown as Spec;
  return { id, title: id, source: 'RTLLM', spec, intentSummary: id };
}

describe('scoreboardCampaignLists', () => {
  const scored = [
    problem('base-exact', false),
    problem('base-streaming', true),
    problem('extra-streaming', true),
    problem('extra-exact', false),
  ];

  it('keeps the baseline ids, then adds exactly the streaming designs outside them', () => {
    const lists = scoreboardCampaignLists(scored, ['base-exact', 'base-streaming']);
    expect(lists.streamingSupplement).toEqual(['extra-streaming']);
    expect(lists.problemIds).toEqual(['base-exact', 'base-streaming', 'extra-streaming']);
    expect(lists.designGroups).toEqual({
      'base-exact': 'cycle-exact',
      'base-streaming': 'streaming',
      'extra-streaming': 'streaming',
    });
  });

  it('refuses a baseline id the scored corpus does not hold', () => {
    expect(() => scoreboardCampaignLists(scored, ['gone'])).toThrow('gone');
  });
});
