---
type: gotcha
title: Widening a union breaks total Record fakes loudly, but turns hand-rolled aggregate assertions vacuous silently
status: candidate
provenance: repairing the whole-repo tsc failure after ProviderName gained 'bedrock-mantle' and RoutedModelResult gained modelId
tags: [typescript, testing, fakes, property-testing, model-router]
timestamp: 2025-02-14
---

# What happened

Adding one member to `ProviderName` (`'bedrock-mantle'`) broke 26 type errors across 14
test files. Every break was a test fake, never production: total `Record<ProviderName, T>`
maps (adapter maps, `fc.record` shapes, counter maps, token maps) and object literals
missing the newly required `RoutedModelResult.modelId`.

The compiler caught all of those. What it did NOT catch was the second-order damage: once
the fourth member is added to satisfy the type, assertions that AGGREGATE over providers
by hand quietly stop meaning what they say. In the routing property test:

```ts
const totalCalls =
  byProvider.deepseek.callCount + byProvider.gemini.callCount + byProvider.claude.callCount;
expect(totalCalls).toBe(1); // "exactly one provider call happened"
```

After widening, this still compiles and still passes, but it now tolerates an extra
off-chain call to the fourth adapter. The assertion silently weakened from "exactly one
call in total" to "exactly one call among three of the four".

# Root cause

Two different failure modes with opposite visibility:

1. A total `Record<Union, T>` is structurally checked, so widening the union fails the
   build at every construction site. Loud, mechanical, safe.
2. A hand-rolled fold over the union's members (`a + b + c`, or N explicit `expect` lines)
   has NO totality check. The union grows; the fold does not; the assertion's meaning
   shrinks with no compiler or test signal.

A new union member also arrives in test fakes as a DEAD PLACEHOLDER by default: it exists
only to satisfy the type, participates in nothing, and is asserted about nowhere.

# Fix / rule

- When a union widens, treat every total `Record` break as a prompt to ask what the new
  member should ASSERT, not just what value silences the compiler. Here `bedrock-mantle`
  is on no routing chain, so the honest assertion is that routing never reaches it -
  scripted to SUCCEED, so "the router did not call it" is a real claim rather than a
  tautology about an adapter that would have failed anyway.
- Verify the new entry is load-bearing by mutation, not by inspection. Injecting a
  deliberate fan-out (`await this.#adapters['bedrock-mantle'].call(...)`) into the router
  made all four affected files fail; that is the proof the entries are not placeholders.
  Note the build must be rebuilt for a mutation to reach the tests: `@app/*` resolves to
  `dist`, so mutating a `.ts` source without `tsc -b` produces a false all-green.
- Never restate production configuration as a literal in a fake. `modelId` had to pair
  correctly with `provider` on the same literal; deriving the pairing from
  `DEFAULT_ROUTING_POLICY` (see `app/test/model-router-fixtures.ts`) means the fake cannot
  drift from the policy and no model-id string appears in test code at all. Prefer a
  lookup that THROWS for an unrouted provider over one returning a plausible default.
- Keep the shared/local split on the axis of ownership: share only the facts that belong
  to production (the provider -> model-id pairing). Leave per-file fixture shape local,
  since task/provider/token figures are choices the individual test makes.

# Links

- app/test/model-router-fixtures.ts (policy-derived pairing helper)
- app/test/model-router-routing.property.test.ts (the aggregate-sum trap, Property 19)
- app/agent/model-router/routing.ts (DEFAULT_PROVIDER_MODEL, the pairing being mirrored)
- chipAgent/_inbox/gotcha-eslint-after-used-unused-args.md (sibling: fakes drift from the interfaces they stand in for)
