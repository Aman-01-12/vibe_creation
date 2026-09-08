// Shared Model_Router test fixture: the provider -> model-id pairing that every
// fake `RoutedModelResult` must mirror.
//
// `RoutedModelResult.modelId` is not free-form. The real router copies it from the
// `{provider, modelId}` selection the routing policy resolved for the attempt that
// succeeded, so a fake result's `modelId` must be the id the policy pairs with that
// same fake's `provider` - a claude-provider result must not carry a qwen model id.
// Restating those ids as literals per test file would both scatter the same magic
// string across a dozen files and let the pairing drift from the policy silently,
// so the pairing is derived here, once, from the production policy itself.
//
// Scope note: each test file still builds its OWN local routed-result fixture,
// because the task, provider, and token/cost figures differ per stage under test.
// Only the provider -> model-id pairing is shared, because only that is a fact
// about production rather than a choice made by the test.

import { DEFAULT_ROUTING_POLICY, type ProviderName } from '@app/agent';

/**
 * Index the default routing policy's own selections by provider.
 *
 * A provider that the policy pairs with two different model ids has no single
 * "the" model id, so that is rejected loudly rather than resolved by picking
 * whichever selection happened to be visited last.
 */
function buildPolicyModelIds(): ReadonlyMap<ProviderName, string> {
  const pairing = new Map<ProviderName, string>();
  for (const chain of Object.values(DEFAULT_ROUTING_POLICY.taskRoute)) {
    for (const selection of chain) {
      const existing = pairing.get(selection.provider);
      if (existing !== undefined && existing !== selection.modelId) {
        throw new Error(
          `default routing policy pairs provider ${selection.provider} with more than one ` +
            `model id (${existing}, ${selection.modelId}); a fake routed result cannot ` +
            'mirror an ambiguous pairing',
        );
      }
      pairing.set(selection.provider, selection.modelId);
    }
  }
  return pairing;
}

/**
 * The model id the default routing policy pairs with each provider it routes to.
 *
 * Derived from the policy rather than restated, so it cannot drift from production
 * and introduces no model-id literal into test code. Providers the default policy
 * never routes to are deliberately absent rather than invented.
 */
const POLICY_MODEL_ID_BY_PROVIDER: ReadonlyMap<ProviderName, string> = buildPolicyModelIds();

/**
 * The `modelId` a fake `RoutedModelResult` must carry for a given provider.
 *
 * Throws (rather than returning a placeholder) when the default policy routes no
 * task to that provider, so a fake can never assert a provider/model pairing the
 * real router would never have produced.
 */
export function routedModelIdFor(provider: ProviderName): string {
  const modelId = POLICY_MODEL_ID_BY_PROVIDER.get(provider);
  if (modelId === undefined) {
    throw new Error(
      `the default routing policy routes no task to provider ${provider}, so it has no ` +
        'paired model id; a fake routed result must name a provider the policy routes to',
    );
  }
  return modelId;
}
