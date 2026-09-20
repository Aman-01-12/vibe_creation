// Property 11 for the Model_Router: No secret ever appears outside its vendor
// adapter (task 9.3).
//
// This is the universal, security-critical complement to the concrete credential
// examples in `model-router.test.ts`. Over generated per-provider synthetic
// credential tokens, a routed `ModelTask`, and per-provider success/failure
// outcomes, driven through a real `createModelRouter` wired with an
// `InMemorySecretManager` and capturing vendor transports (each receives the
// credential at its point of use but never echoes it), plus a real
// `TraceActionRecorder` over `InMemoryTracePersistence`, it asserts the five
// guarantees the design binds to Property 11:
//
//   - Confinement (Req 12.6, 12.7, 12.9, 17.7): no credential token value ever
//     appears in the serialized Trace, in `describeRouting()` diagnostics, in the
//     `RoutedModelResult`/`ModelRouterFailure`, or in any error reason.
//   - Own-credential-only (Req 12.8, 3.2): the secret manager resolves EXACTLY the
//     credential refs of the providers actually on the executed routing path, so
//     an adapter can never reach a sibling provider's secret, and each invoked
//     transport receives only its own provider's token value.
//   - Redacted pointers only (Req 12.10): diagnostics expose the non-secret
//     `providerCredentialRef` pointer for every provider and no credential value.
//
// Absence, not merely redaction: the primary mode uses tokens that are NOT
// secret-shaped, so the redaction transform would leave them intact - their
// absence therefore proves the router never wrote them, rather than that
// redaction scrubbed them. A second mode uses secret-shaped tokens (which
// redaction WOULD scrub) to confirm redaction is a genuine second line of
// defense. Every token here is synthetic; no real credential is ever used.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROUTING_POLICY,
  InMemorySecretManager,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  MODEL_TASKS,
  TraceActionRecorder,
  containsSecret,
  createModelRouter,
  providerChainFor,
  providerCredentialRef,
  redactJson,
  type ModelResult,
  type ModelTask,
  type ProviderCallError,
  type ProviderName,
  type ProviderTransport,
  type SessionBudgetHandle,
} from '@app/agent';
import { err, makeSessionBudget, newUlid, ok, type Result } from '@app/core';
import { propertyParameters, propertyTag, secretShapedTokenArbitrary } from '@app/test';

// --- Constants ---------------------------------------------------------------

/**
 * Every task the router routes; iterating over all exercises every chain.
 *
 * Imported rather than re-listed: confinement is a claim about every routed task, so a
 * new role must widen this scenario space automatically instead of silently escaping it.
 */
const TASKS: readonly ModelTask[] = MODEL_TASKS;

/**
 * Every provider whose credential is loaded into the secret manager.
 *
 * Includes `bedrock-mantle`, which no default route selects: its token must still
 * never appear in the Trace, the diagnostics, or the result, and its credentialRef
 * must still be exposed as a redacted pointer. Confinement is a claim about every
 * wired adapter, not only the ones a task happens to route to.
 */
const PROVIDERS: readonly ProviderName[] = ['deepseek', 'gemini', 'claude', 'bedrock-mantle'];

/** Digits only, so a plain token can never grow a letter-based secret shape. */
const DIGITS: readonly string[] = '0123456789'.split('');

// --- Generators --------------------------------------------------------------

type Outcome = 'success' | 'failure';

/** A per-provider outcome record (which vendor calls succeed vs fail). */
type OutcomeMap = Readonly<Record<ProviderName, Outcome>>;

/** A per-provider synthetic credential token record. */
type TokenMap = Readonly<Record<ProviderName, string>>;

/** Which family of synthetic token a scenario loads. */
type TokenMode = 'plain' | 'secret-shaped';

interface Scenario {
  readonly task: ModelTask;
  readonly outcomes: OutcomeMap;
  readonly mode: TokenMode;
  readonly tokens: TokenMap;
  readonly prompt: string;
}

const outcomeArbitrary: fc.Arbitrary<Outcome> = fc.constantFrom('success', 'failure');

/**
 * A synthetic, deliberately NOT secret-shaped token for a provider.
 *
 * A distinctive uppercase prefix plus a digits-only random body: it carries no
 * `sk-`/`AKIA`/`ghp_`/`Bearer`/`api_` prefix, no JWT dot triple, and no letters in
 * its body, so `containsSecret` is false and redaction leaves it intact. Its
 * absence from any observable output therefore proves the router never wrote it.
 */
function plainTokenArbitrary(provider: ProviderName): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...DIGITS), { minLength: 16, maxLength: 28 })
    .map((body) => `SYNTHETIC-${provider.toUpperCase()}-CRED-${body.join('')}`);
}

/** A token arbitrary for a provider under the chosen mode. */
function tokenArbitraryFor(mode: TokenMode, provider: ProviderName): fc.Arbitrary<string> {
  return mode === 'plain' ? plainTokenArbitrary(provider) : secretShapedTokenArbitrary();
}

/** A full per-provider token record under the chosen mode. */
function tokensArbitrary(mode: TokenMode): fc.Arbitrary<TokenMap> {
  return fc.record<TokenMap>({
    deepseek: tokenArbitraryFor(mode, 'deepseek'),
    gemini: tokenArbitraryFor(mode, 'gemini'),
    claude: tokenArbitraryFor(mode, 'claude'),
    'bedrock-mantle': tokenArbitraryFor(mode, 'bedrock-mantle'),
  });
}

/** One whole scenario: a task, per-provider outcomes, and per-provider tokens. */
function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return fc
    .record({
      task: fc.constantFrom(...TASKS),
      outcomes: fc.record<OutcomeMap>({
        deepseek: outcomeArbitrary,
        gemini: outcomeArbitrary,
        claude: outcomeArbitrary,
        'bedrock-mantle': outcomeArbitrary,
      }),
      mode: fc.constantFrom<TokenMode>('plain', 'secret-shaped'),
      prompt: fc.string(),
    })
    .chain((base) => tokensArbitrary(base.mode).map((tokens) => ({ ...base, tokens })));
}

// --- Harness helpers ---------------------------------------------------------

/** A generous budget so routing outcomes (not the budget) drive the executed path. */
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
 * The providers actually invoked for a task under the given outcomes: walk the
 * chain, stopping at the first success. This mirrors the router's fallback loop,
 * so it is the exact set of adapters that resolve a credential when every
 * transport is wired.
 */
function executedProviders(task: ModelTask, outcomes: OutcomeMap): readonly ProviderName[] {
  const chain = providerChainFor(DEFAULT_ROUTING_POLICY, task);
  const path: ProviderName[] = [];
  for (const provider of chain) {
    path.push(provider);
    if (outcomes[provider] === 'success') {
      break;
    }
  }
  return path;
}

/**
 * A capturing vendor transport for one provider.
 *
 * It records the credential it was handed at the point of use (so the test can
 * prove point-of-use resolution delivered the provider's OWN credential) and
 * returns a scripted success or failure. It NEVER echoes the credential into its
 * result or error, exactly as the real vendor SDK seam must behave.
 */
function capturingTransport(
  provider: ProviderName,
  outcome: Outcome,
  captured: Map<ProviderName, string>,
): ProviderTransport {
  return ({ credential }): Promise<Result<ModelResult, ProviderCallError>> => {
    captured.set(provider, credential);
    if (outcome === 'success') {
      return Promise.resolve(
        ok({ provider, outputText: `${provider}-response`, tokensUsed: 7, costCents: 3 }),
      );
    }
    return Promise.resolve(
      err({ kind: 'provider-unavailable', reason: `${provider} unavailable` }),
    );
  };
}

// --- The property ------------------------------------------------------------

describe('Model_Router credential confinement (Property 11)', () => {
  // Feature: hdl-creation-loop, Property 11: No secret ever appears outside its vendor adapter
  it('never lets a credential value escape its vendor adapter, across tasks and outcomes', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary(), async ({ task, outcomes, mode, tokens, prompt }) => {
        // Non-vacuity guard on the generated tokens: plain tokens must survive
        // redaction (so their absence proves non-writing), and secret-shaped
        // tokens must be scrubbable (so the second-line-of-defense claim holds).
        for (const provider of PROVIDERS) {
          const token = tokens[provider];
          if (mode === 'plain') {
            expect(containsSecret(token)).toBe(false);
            expect(JSON.stringify(redactJson({ probe: token }))).toContain(token);
          } else {
            expect(containsSecret(token)).toBe(true);
          }
        }

        // Fresh secret manager, recorder, and router per run: full independence.
        const secrets = new InMemorySecretManager({
          [providerCredentialRef('deepseek')]: tokens.deepseek,
          [providerCredentialRef('gemini')]: tokens.gemini,
          [providerCredentialRef('claude')]: tokens.claude,
          [providerCredentialRef('bedrock-mantle')]: tokens['bedrock-mantle'],
        });
        const persistence = new InMemoryTracePersistence();
        const recorder = new TraceActionRecorder(persistence);
        const captured = new Map<ProviderName, string>();
        const router = createModelRouter({
          secretManager: secrets,
          recorder,
          now: () => new Date(0),
          transports: {
            deepseek: capturingTransport('deepseek', outcomes.deepseek, captured),
            gemini: capturingTransport('gemini', outcomes.gemini, captured),
            claude: capturingTransport('claude', outcomes.claude, captured),
            'bedrock-mantle': capturingTransport(
              'bedrock-mantle',
              outcomes['bedrock-mantle'],
              captured,
            ),
          },
        });
        const budget = generousBudget();

        const result = await router.invoke(task, { prompt }, budget);

        // Own-credential-only (Req 12.8): the secret manager resolved EXACTLY the
        // refs of the providers on the executed path, in order - never a sibling's.
        const path = executedProviders(task, outcomes);
        const expectedRefs = path.map((provider) => providerCredentialRef(provider));
        expect(secrets.accessedRefs).toEqual(expectedRefs);

        // Each invoked transport received only its OWN provider's token value.
        expect(new Set(captured.keys())).toEqual(new Set(path));
        for (const provider of path) {
          expect(captured.get(provider)).toBe(tokens[provider]);
        }

        // Confinement (Req 12.6, 12.7, 12.9, 17.7): no token value appears in the
        // Trace, the diagnostics, or the routed result/failure (which includes any
        // error reason, since the whole Result is serialized).
        const trace = await recorder.getTrace(budget.sessionId);
        const traceJson = JSON.stringify(trace);
        const diagnostics = router.describeRouting();
        const diagnosticsJson = JSON.stringify(diagnostics);
        const resultJson = JSON.stringify(result);
        for (const provider of PROVIDERS) {
          const token = tokens[provider];
          expect(traceJson).not.toContain(token);
          expect(diagnosticsJson).not.toContain(token);
          expect(resultJson).not.toContain(token);
        }

        // Redacted pointers only (Req 12.10): diagnostics expose the non-secret
        // credentialRef pointer for every provider, never a value.
        for (const provider of PROVIDERS) {
          expect(diagnosticsJson).toContain(providerCredentialRef(provider));
        }
      }),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 11 tag is asserted, not just written in a
// comment: `Feature: hdl-creation-loop, Property 11: No secret ever appears outside its vendor adapter`.
describe('Property 11 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(propertyTag(11, 'No secret ever appears outside its vendor adapter')).toBe(
      'Feature: hdl-creation-loop, Property 11: No secret ever appears outside its vendor adapter',
    );
  });
});
