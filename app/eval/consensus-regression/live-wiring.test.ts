// Task 6.1: the Live_Wiring reads `Spec.timingContract` instead of fabricating an all-`registered`
// one. Driven through a fake `ModelRouter`, so no model call and no toolchain.

import { describe, expect, it } from 'vitest';

import {
  makeBudgetLedger,
  type ModelRouter,
  type ModelTask,
  type RoutedModelResult,
} from '@app/agent';
import { makeTimingContract, ok, type ModuleInterface, type Result, type Spec } from '@app/core';

import { LiveReferenceModelGenerator, modelIdFor } from './live-wiring.js';

const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'comb_or',
  ports: [
    { name: 'en', direction: 'input', width: 1 },
    { name: 'out', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

/** A reply that parses and clears the Authoring_Contract, so `generate` reaches the harness render. */
const REPLY = JSON.stringify({
  functions: [
    { name: 'ece_reset_state', body: "ece_reset_state = 128'd0;" },
    { name: 'ece_next_state', body: 'ece_next_state = s;' },
    { name: 'ece_expect', body: "ece_expect = 1'b0;" },
  ],
  roles: [{ port: 'en', role: 'data' }],
});

/** A `ModelRouter` that answers every call with `REPLY`; it holds no credential and calls out nowhere. */
class ReplyingRouter implements ModelRouter {
  invoke(task: ModelTask): Promise<Result<RoutedModelResult, never>> {
    return Promise.resolve(
      ok({
        task,
        provider: 'bedrock-mantle' as const,
        modelId: 'fake',
        outputText: REPLY,
        tokensUsed: 0,
        costCents: 0,
        attempts: 1,
        fellBack: false,
      }),
    );
  }

  describeRouting() {
    return { tasks: [], providers: [] };
  }
}

function specWithOutTiming(timing: 'combinational' | 'registered'): Spec {
  const built = makeTimingContract(MODULE_INTERFACE, [{ portName: 'out', timing }]);
  if (!built.ok) {
    throw new Error(`fixture built an invalid timing contract: ${built.error.message}`);
  }
  return {
    id: 'spec-1',
    projectId: 'proj-1',
    goal: 'An enable-gated output',
    constraints: [],
    architecture: 'n/a',
    moduleInterface: MODULE_INTERFACE,
    timingContract: built.value,
    acceptanceCriteria: [],
    approved: true,
    version: 1,
  };
}

async function harnessFor(timing: 'combinational' | 'registered'): Promise<string> {
  const generator = new LiveReferenceModelGenerator(
    new Map([[modelIdFor(0), new ReplyingRouter()]]),
  );
  const produced = await generator.generate(
    specWithOutTiming(timing),
    makeBudgetLedger(100_000, 'session-token-budget'),
  );
  return produced.harness.contents;
}

describe('LiveReferenceModelGenerator harness request', () => {
  it('given a Spec placing an output port at combinational when a reference model is generated then the harness compares that port against the same-cycle expectation', async () => {
    const contents = await harnessFor('combinational');

    expect(contents).toContain('if (ece_exp_bits[0:0] === out)');
    // The deleted fabrication rendered this registered-only bundle for every corpus port.
    expect(contents).not.toContain('ece_exp_reg_bits');
  });

  it('given a Spec placing the same port at registered then the harness compares it against the registered expectation', async () => {
    const contents = await harnessFor('registered');

    expect(contents).toContain('if (ece_exp_reg_bits[0:0] === out)');
  });
});
