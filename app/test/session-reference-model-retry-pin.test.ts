// stimulus-transaction-structure, task 7.6 (C6: Session refusal handling, Req 2.8).
//
// C6 IS A NO-CHANGE COMPONENT: the Role_Parser refusal and the Harness_Renderer refusal this
// feature widens the vocabulary of already flow through the existing Reference_Model retry
// limit, unchanged. This file adds no behaviour; it pins the three facts criterion 2.8 names,
// so a future change that weakens the handling - a retry that keeps a refused draft, or a
// widened or narrowed retry limit - fails here instead of going unnoticed.
//
// WHY THIS LIVES IN app/test, DRIVING THE REAL LiveReferenceModelGenerator
//   `session.ts`'s `generateReferenceModelPool` does exactly one thing per pool slot:
//   `testbenches.push(await generator.generate(spec, ledger))`, with no catch around it.
//   Whatever `ReferenceModelGenerator.generate` resolves with is the only thing that can ever
//   reach the Testbench_Pool, and whatever it rejects with reaches nothing - so pinning
//   `generate`'s own refusal and exhaustion behaviour pins exactly what the Session does with
//   it, with no need to also stand up the other four `ConsensusSessionDeps` to show that.
//   The retry limit itself, `MAX_REFERENCE_MODEL_ATTEMPTS`, is a module-private constant in
//   `app/eval/consensus-regression/live-wiring.ts` - not exported, and this task changes no
//   production file to make it so. Its value is pinned the same way the prompt digest in
//   `prompt-version.test.ts` is: by driving the real, unmodified `LiveReferenceModelGenerator`
//   through a scripted router and asserting the observed attempt count against a hardcoded
//   literal, which a future bump of that constant would move away from.

import { describe, expect, it } from 'vitest';

import {
  makeBudgetLedger,
  type ModelRouter,
  type ModelTask,
  type RoutedModelResult,
} from '@app/agent';
import { makeTimingContract, ok, type ModuleInterface, type Result, type Spec } from '@app/core';

import {
  LiveReferenceModelGenerator,
  modelIdFor,
} from '../eval/consensus-regression/live-wiring.js';

/** One input port carrying a role, one output: enough for the Role_Parser and the Harness_Renderer to run for real. */
const MODULE_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'comb_or',
  ports: [
    { name: 'en', direction: 'input', width: 1 },
    { name: 'out', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
};

/** A reply the Role_Parser accepts and the Harness_Renderer renders without refusal. */
const ACCEPTED_REPLY = JSON.stringify({
  functions: [
    { name: 'ece_reset_state', body: "ece_reset_state = 128'd0;" },
    { name: 'ece_next_state', body: 'ece_next_state = s;' },
    { name: 'ece_expect', body: "ece_expect = 1'b0;" },
  ],
  roles: [{ port: 'en', role: 'data' }],
});

/** Not JSON at all: the Role_Parser refuses this before any Role_Declaration is even read. */
const REFUSED_REPLY = 'this is not a Reference_Model_Reply';

/** A Spec over `moduleInterface`, with a total combinational Timing_Contract. */
function specFor(moduleInterface: ModuleInterface): Spec {
  const built = makeTimingContract(moduleInterface, [{ portName: 'out', timing: 'combinational' }]);
  if (!built.ok) {
    throw new Error(`fixture built an invalid timing contract: ${built.error.message}`);
  }
  return {
    id: 'spec-1',
    projectId: 'proj-1',
    goal: 'A combinational passthrough',
    constraints: [],
    architecture: 'n/a',
    moduleInterface,
    timingContract: built.value,
    acceptanceCriteria: [],
    approved: true,
    version: 1,
  };
}

/** A `ModelRouter` that answers each successive call with the next of `replies`, counting its own calls. */
class ScriptedRouter implements ModelRouter {
  calls = 0;

  readonly #replies: readonly string[];

  constructor(replies: readonly string[]) {
    this.#replies = replies;
  }

  invoke(task: ModelTask): Promise<Result<RoutedModelResult, never>> {
    const outputText = this.#replies[this.calls] ?? '';
    this.calls += 1;
    return Promise.resolve(
      ok({
        task,
        provider: 'bedrock-mantle' as const,
        modelId: 'fake',
        outputText,
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

/** One `LiveReferenceModelGenerator` wired to a single scripted router at model arm 0 - `generate` is only ever called once per scenario below. */
function generatorWith(replies: readonly string[]): {
  readonly generator: LiveReferenceModelGenerator;
  readonly router: ScriptedRouter;
} {
  const router = new ScriptedRouter(replies);
  return {
    generator: new LiveReferenceModelGenerator(new Map([[modelIdFor(0), router]])),
    router,
  };
}

describe('Session Reference_Model refusal handling is unchanged (C6, Req 2.8)', () => {
  it('a refused reply adds no Reference_Model_Testbench, reaching the retry limit adds none either, and the retry limit is still 3', async () => {
    const spec = specFor(MODULE_INTERFACE);

    // Two refusals, then an accepted reply at the retry boundary: `generate` resolves with
    // exactly ONE artifact. The two refused replies before it were never returned, so
    // `generateReferenceModelPool`'s `testbenches.push(...)` had nothing of theirs to push.
    const recovering = generatorWith([REFUSED_REPLY, REFUSED_REPLY, ACCEPTED_REPLY]);
    const produced = await recovering.generator.generate(
      spec,
      makeBudgetLedger(100_000, 'session-token-budget'),
    );

    expect(produced.testbenchId).toBeTruthy();
    expect(recovering.router.calls).toBe(3); // the pinned Reference_Model retry limit

    // Every reply refused: the retry limit is reached and `generate` rejects outright, so the
    // same `testbenches.push(await generator.generate(...))` never runs for this slot either -
    // not even a partial or defaulted `GeneratedReferenceModel`.
    const exhausting = generatorWith([REFUSED_REPLY, REFUSED_REPLY, REFUSED_REPLY]);

    await expect(
      exhausting.generator.generate(spec, makeBudgetLedger(100_000, 'session-token-budget')),
    ).rejects.toThrow(/no acceptable reference-model reply/);
    expect(exhausting.router.calls).toBe(3); // the same pinned limit, reached rather than beaten
  });
});
