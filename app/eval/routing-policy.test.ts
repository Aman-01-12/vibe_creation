// Unit tests for the eval routing policy builder (Req 15.10; per-role bake-off).
//
// Pure and offline: a `RoutingPolicy` is data, so nothing here touches a provider, a
// credential, or the network. These examples pin the three things a bake-off depends
// on: every role resolves to the bedrock-mantle host with the model id the caller
// asked for; a wiring mistake fails LOUDLY at composition time instead of surfacing
// mid-run as an indistinguishable provider failure; and there is NO cross-model
// fallback unless one is asked for by name, so a verified artifact is never
// misattributed to the model under test.

import { describe, expect, it } from 'vitest';

import { MODEL_TASKS, primarySelectionFor, selectionChainFor, type ModelTask } from '@app/agent';

import {
  evalRoutingPolicy,
  singleModelEvalRoutingPolicy,
  type EvalRoleModels,
} from './routing-policy.js';

/** Realistic bedrock-mantle catalog ids, one distinct id per role. */
const PER_ROLE_MODELS: EvalRoleModels = {
  generation: 'qwen.qwen3-coder-480b-a35b-instruct',
  repair: 'deepseek.v3.2',
  orchestration: 'zai.glm-5',
  teaching: 'moonshotai.kimi-k2.5',
  'hard-planning': 'mistral.devstral-2-123b',
};

/** The per-role models with one role overridden, for the permutation examples. */
function withRole(role: ModelTask, modelId: string): EvalRoleModels {
  return { ...PER_ROLE_MODELS, [role]: modelId };
}

describe('evalRoutingPolicy - per-role mapping', () => {
  it('routes every model task to bedrock-mantle with that role own model id', () => {
    const policy = evalRoutingPolicy({ taskModel: PER_ROLE_MODELS });

    expect(MODEL_TASKS).toHaveLength(5);
    for (const task of MODEL_TASKS) {
      expect(primarySelectionFor(policy, task)).toEqual({
        provider: 'bedrock-mantle',
        modelId: PER_ROLE_MODELS[task],
      });
    }
  });

  it('permutes one role independently, which is what a bake-off arm changes', () => {
    const baseline = evalRoutingPolicy({ taskModel: PER_ROLE_MODELS });
    const arm = evalRoutingPolicy({ taskModel: withRole('generation', 'zai.glm-5') });

    expect(primarySelectionFor(arm, 'generation').modelId).toBe('zai.glm-5');
    for (const task of MODEL_TASKS.filter((other) => other !== 'generation')) {
      expect(primarySelectionFor(arm, task)).toEqual(primarySelectionFor(baseline, task));
    }
  });

  it('trims surrounding whitespace so a pasted id routes to the intended model', () => {
    const policy = evalRoutingPolicy({ taskModel: withRole('repair', '  deepseek.v3.2\n') });

    expect(primarySelectionFor(policy, 'repair').modelId).toBe('deepseek.v3.2');
  });
});

describe('singleModelEvalRoutingPolicy - one model everywhere', () => {
  it('serves every role from the one supplied model id', () => {
    const policy = singleModelEvalRoutingPolicy('deepseek.v3.2');

    for (const task of MODEL_TASKS) {
      expect(primarySelectionFor(policy, task)).toEqual({
        provider: 'bedrock-mantle',
        modelId: 'deepseek.v3.2',
      });
    }
  });

  it('inherits the no-fallback default', () => {
    const policy = singleModelEvalRoutingPolicy('deepseek.v3.2');

    expect(policy.maxAttempts).toBe(1);
    for (const task of MODEL_TASKS) {
      expect(selectionChainFor(policy, task)).toHaveLength(1);
    }
  });

  it('rejects a blank model id rather than routing to nothing', () => {
    expect(() => singleModelEvalRoutingPolicy('   ')).toThrow(/blank/);
  });
});

describe('evalRoutingPolicy - fallback is off unless asked for', () => {
  it('gives every role a single-entry chain and one attempt by default', () => {
    const policy = evalRoutingPolicy({ taskModel: PER_ROLE_MODELS });

    expect(policy.maxAttempts).toBe(1);
    for (const task of MODEL_TASKS) {
      const chain = selectionChainFor(policy, task);
      expect(chain).toHaveLength(1);
      expect(chain[0]?.modelId).toBe(PER_ROLE_MODELS[task]);
    }
  });

  it('appends an opt-in fallback for only the roles that named one, same provider', () => {
    const policy = evalRoutingPolicy({
      taskModel: PER_ROLE_MODELS,
      fallbackModel: { generation: 'deepseek.v3.2' },
    });

    expect(policy.maxAttempts).toBe(2);
    expect(selectionChainFor(policy, 'generation')).toEqual([
      { provider: 'bedrock-mantle', modelId: PER_ROLE_MODELS.generation },
      { provider: 'bedrock-mantle', modelId: 'deepseek.v3.2' },
    ]);
    expect(selectionChainFor(policy, 'repair')).toHaveLength(1);
  });

  it('honors an explicit attempt cap over the fallback-aware default', () => {
    const policy = evalRoutingPolicy({
      taskModel: PER_ROLE_MODELS,
      fallbackModel: { generation: 'deepseek.v3.2' },
      maxAttempts: 1,
    });

    // The cap wins: the configured fallback is present but never walked.
    expect(selectionChainFor(policy, 'generation')).toHaveLength(1);
  });
});

describe('evalRoutingPolicy - loud validation at the boundary', () => {
  it('rejects a blank primary model id, naming the role', () => {
    expect(() => evalRoutingPolicy({ taskModel: withRole('teaching', '') })).toThrow(
      /blank.*teaching|teaching.*blank/,
    );
  });

  it('rejects a missing primary model id rather than routing to undefined', () => {
    // Config arriving as JSON can omit a role entirely, which the compile-time type
    // cannot catch; the cast reproduces exactly that runtime shape.
    const incomplete: Record<string, string> = { ...PER_ROLE_MODELS };
    delete incomplete['hard-planning'];

    expect(() => evalRoutingPolicy({ taskModel: incomplete as EvalRoleModels })).toThrow(
      /hard-planning/,
    );
  });

  it('rejects a blank fallback id instead of silently dropping the fallback', () => {
    expect(() =>
      evalRoutingPolicy({ taskModel: PER_ROLE_MODELS, fallbackModel: { repair: '  ' } }),
    ).toThrow(/fallback.*repair|repair.*fallback/);
  });

  it('rejects a non-positive or fractional attempt cap', () => {
    for (const maxAttempts of [0, -1, 1.5, Number.NaN]) {
      expect(() => evalRoutingPolicy({ taskModel: PER_ROLE_MODELS, maxAttempts })).toThrow(
        /positive integer/,
      );
    }
  });

  it('names only the role in its message, never any configured model id', () => {
    // A policy is composed from operator-supplied config that could hold a pasted
    // credential, and this message can reach a log, so no value is ever echoed.
    let message = '';
    try {
      evalRoutingPolicy({ taskModel: withRole('generation', '') });
      expect.unreachable('a blank model id must throw');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('generation');
    for (const task of MODEL_TASKS) {
      expect(message).not.toContain(PER_ROLE_MODELS[task]);
    }
  });
});
