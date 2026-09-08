---
type: decision
title: A per-role model bake-off routes with NO fallback, because a silent fallback misattributes a verified artifact
status: candidate
provenance: hdl-creation-loop task 19.4 (production eval loop-runner + eval routing policy)
tags: [eval, model-router, routing, bake-off, pass-at-k, cpva, attribution, honesty]
timestamp: 2026-09-04T21:26:32Z
---

# Decision

The eval routing policy builder (`app/eval/routing-policy.ts`) produces single-entry
model chains with `maxAttempts: 1` by default. A bake-off arm gets NO fallback unless
the caller names one per role.

# Context / options considered

The Model_Router's `RoutingPolicy` gives each `ModelTask` an ordered chain of
`{provider, modelId}` selections and retries down the chain on failure. That bounded
fallback is exactly right in production - a transient provider failure should not cost
a student their session. Reusing it unchanged for a bake-off was the obvious default,
and the option we rejected.

# Rationale

The bake-off asks "what does model M score in role R?" and answers with
oracle-verified pass@k and Cost per Verified Artifact. If M's call fails and the
router silently retries on model N, the router returns SUCCESS, the loop proceeds,
the oracle verifies the artifact, and the harness banks a `verified` sample plus its
cost against the arm under test. Both numbers move in the flattering direction, and
nothing in the aggregate report shows it happened - the per-attempt `modelId` is on
the Trace span, but the report reads only the outcome.

Attribution integrity therefore outranks robustness here: a bake-off run SHOULD
record M failing, because that failure rate is part of what is being measured. The
harness already tolerates per-sample failures (it takes k samples and reports pass@k),
so nothing is lost by letting an arm fail honestly.

An opt-in `fallbackModel` (same provider, per role) stays available for the other
legitimate question - "how does the SHIPPING stack, escalation included, score?" -
because a certified configuration includes its fallback behaviour. It must be
explicit so it can never be mistaken for a clean bake-off.

# Rules learned

- Hold ONE context configuration constant across arms; permute the model id per role.
  Per-role ids are the permutation knob, so validate them at the boundary (non-blank,
  every role present) and THROW at composition time. A mis-wired arm that starts
  anyway gets read as a model's poor score.
- Never validate model ids against a hardcoded catalog allow-list: the host catalog
  changes without our code changing. Validate shape, not membership.
- Gotcha found in the same surface: `attemptCap` did `Math.max(1, Math.trunc(n))`, so
  a non-finite `maxAttempts` produced `slice(0, NaN)` - an EMPTY chain. The router
  then made zero attempts and reported `ALL_PROVIDERS_FAILED`, i.e. a wiring mistake
  wearing a provider outage's clothes. Any "cap" that reaches a `slice`/`length` needs
  a finiteness guard, not just a floor.
- A hosted provider is not bit-deterministic even at temperature 0 (batching, kernel
  selection, silent model-server revisions). The OpenAI-compatible `seed` is a hint,
  not a guarantee - which is why an eval takes k samples rather than trusting one.

# Revisit trigger

If the harness report ever carries per-attempt model attribution (so a fallback is
visible in the aggregate), the no-fallback default could be relaxed without losing
attribution integrity.

# Links

- app/eval/routing-policy.ts, app/eval/verification-loop-runner.ts
- app/agent/model-router/routing.ts (`singleProviderRoutingPolicy`, `attemptCap`)
- product-ece/ECE-CONTEXT-ENGINEERING.md section 7 (model bake-off, CPVA)
