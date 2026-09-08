// Model_Router credential smoke test (task 9.4).
//
// A focused, deterministic smoke check of the single guarantee the design's Smoke
// tests section names: "Model_Router starts with each adapter resolving only its
// own credential from the secret manager" (Req 12.8). It is intentionally NOT a
// numbered property - the universal, generated form of this guarantee lives in
// `model-router-credential-confinement.property.test.ts` (Property 11) and must
// not be duplicated here. This test proves the one concrete start-up fact per
// provider with fixed, distinct synthetic tokens.
//
// How own-ref-only resolution is proven: an `InMemorySecretManager` is seeded with
// a distinct synthetic token per provider and records every ref it is asked to
// resolve. A capturing transport is wired for EVERY provider - including
// `bedrock-mantle`, which no default route selects - so any adapter that reached
// for a sibling's credential would be observable in `accessedRefs` or in the
// sibling's capture. After routing a task to a given provider we assert
// (1) the secret manager resolved EXACTLY that provider's ref and no sibling's,
// (2) only that provider's transport ran, and (3) it received that provider's OWN
// token value. Every token here is synthetic; no real credential is ever used.

import { describe, expect, it } from 'vitest';

import {
  InMemorySecretManager,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TraceActionRecorder,
  createModelRouter,
  providerCredentialRef,
  type ModelResult,
  type ModelTask,
  type ProviderCallError,
  type ProviderName,
  type ProviderTransport,
  type SessionBudgetHandle,
} from '@app/agent';
import { isOk, makeSessionBudget, newUlid, ok, type Result } from '@app/core';

// --- Fixtures ----------------------------------------------------------------

/** Every provider whose credential is loaded into the secret manager. */
const PROVIDERS: readonly ProviderName[] = ['deepseek', 'gemini', 'claude', 'bedrock-mantle'];

/**
 * A distinct, deliberately NOT secret-shaped synthetic token per provider.
 *
 * Distinct values let a sibling-credential leak be caught by a direct value
 * comparison, and the "SYNTHETIC" prefix makes it unmistakable in any output that
 * no real credential is in play.
 */
const TOKENS: Readonly<Record<ProviderName, string>> = {
  deepseek: 'SYNTHETIC-DEEPSEEK-CREDENTIAL-smoke-0001',
  gemini: 'SYNTHETIC-GEMINI-CREDENTIAL-smoke-0002',
  claude: 'SYNTHETIC-CLAUDE-CREDENTIAL-smoke-0003',
  'bedrock-mantle': 'SYNTHETIC-BEDROCK-MANTLE-CREDENTIAL-smoke-0004',
};

/** Each task paired with the provider it routes to as its configured primary. */
const ROUTES: ReadonlyArray<readonly [ModelTask, ProviderName]> = [
  ['generation', 'deepseek'],
  ['orchestration', 'gemini'],
  ['hard-planning', 'claude'],
];

/** A fresh secret manager seeded with one distinct token per provider. */
function seededSecretManager(): InMemorySecretManager {
  return new InMemorySecretManager({
    [providerCredentialRef('deepseek')]: TOKENS.deepseek,
    [providerCredentialRef('gemini')]: TOKENS.gemini,
    [providerCredentialRef('claude')]: TOKENS.claude,
    [providerCredentialRef('bedrock-mantle')]: TOKENS['bedrock-mantle'],
  });
}

/** A generous budget so routing (not the budget) drives the executed path. */
function generousBudget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 100,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) {
    throw new Error('test budget must be valid');
  }
  return new InMemorySessionBudgetHandle(built.value);
}

/**
 * A capturing transport for one provider: records the credential it is handed at
 * the point of use and returns a scripted success. It never echoes the credential.
 */
function capturingTransport(
  provider: ProviderName,
  captured: Map<ProviderName, string>,
): ProviderTransport {
  return ({ credential }): Promise<Result<ModelResult, ProviderCallError>> => {
    captured.set(provider, credential);
    return Promise.resolve(
      ok({ provider, outputText: `${provider}-response`, tokensUsed: 5, costCents: 1 }),
    );
  };
}

// --- The smoke test ----------------------------------------------------------

describe('Model_Router credential smoke: each adapter resolves only its own credential (Req 12.8)', () => {
  it.each(ROUTES)(
    'routing %s resolves only the %s credential ref and no sibling',
    async (task, provider) => {
      const secrets = seededSecretManager();
      const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
      const captured = new Map<ProviderName, string>();
      // Wire every provider's transport so a reach for a sibling's credential would
      // be observable in accessedRefs or in the sibling's capture.
      const router = createModelRouter({
        secretManager: secrets,
        recorder,
        now: () => new Date(0),
        transports: {
          deepseek: capturingTransport('deepseek', captured),
          gemini: capturingTransport('gemini', captured),
          claude: capturingTransport('claude', captured),
          'bedrock-mantle': capturingTransport('bedrock-mantle', captured),
        },
      });

      const result = await router.invoke(task, { prompt: 'p' }, generousBudget());

      expect(isOk(result)).toBe(true);

      // (1) Exactly this provider's ref was resolved - never a sibling's.
      expect(secrets.accessedRefs).toEqual([providerCredentialRef(provider)]);
      for (const sibling of PROVIDERS) {
        if (sibling !== provider) {
          expect(secrets.accessedRefs).not.toContain(providerCredentialRef(sibling));
        }
      }

      // (2) Only this provider's transport ran; no sibling adapter was invoked.
      expect([...captured.keys()]).toEqual([provider]);

      // (3) The credential delivered at the point of use is this provider's OWN
      // token value, not a sibling's.
      expect(captured.get(provider)).toBe(TOKENS[provider]);
      for (const sibling of PROVIDERS) {
        if (sibling !== provider) {
          expect(captured.get(provider)).not.toBe(TOKENS[sibling]);
        }
      }
    },
  );
});
