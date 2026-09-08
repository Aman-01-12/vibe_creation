---
type: gotcha
title: A Testbench_Agent prompt change does not change the config identity, so a resumed campaign pools two experiments
status: candidate
provenance: code survey while writing .kiro/specs/eval-campaign-readiness (grep for promptVersion across app returned nothing; confirmed against config.ts, config-identity.ts, manifest.ts)
tags:
  [
    eval,
    sweep,
    config-identity,
    resume,
    prompt,
    context-engineering,
    certified-configuration,
    campaign,
    honesty,
  ]
timestamp: 2026-09-22
---

# What is missing

There is no `promptVersion`, `promptId`, or equivalent anywhere in `app`.
Confirmed by `grep -rn --include='*.ts' "promptVersion\|promptId" app` returning nothing outside `dist/`.

So the sweep's experiment identity is `{arms, problem selection, sampling, caps, limits, concurrency, retry policy, kill switch, prices, negativeControl}` and the code that produced the samples is captured only as a git commit in the manifest.
`ECE-CONTEXT-ENGINEERING.md` section 7 states the certified configuration is {model + host + prompt version + context strategy}. Two of those four are in the identity.

# Why that is load-bearing, not cosmetic

Resume works by keying a completed sample on `(arm, problemId, sampleIndex)` under a config hash and skipping it.
Change a role prompt - which is exactly what a Testbench_Agent repair does - and a "completed" sample from the old run answers a different question, but the hash is IDENTICAL, so the resume index happily reuses it and the summary pools both populations into one pass@k.

Nothing in the rendered summary would show it.
This is the same failure mode the repo already guards against for `minKillRate` and `mutantWallMs` (both deliberately IN the identity, so two thresholds are two experiments) - the guard just does not extend to the prompt, which is the input most likely to change between campaigns.

The measured precedent that a prompt change moves a measured number is already recorded: `tbfix-verify` / `tbfix-verify2` moved instrument-valid from 0/3 to 2/3 on the same three problems with nothing but prompt edits.

# Where the fix goes, and the two traps in it

- The version constant belongs in `app/agent/roles/testbench/` (its own file, so bumping it is a one-line edit that does not collide with prompt edits).
- `app/eval/sweep/config-identity.ts` should read it DIRECTLY rather than take it as a parameter. Reason: `sweepConfigHash(config, digest)` is called from `app/eval/sweep/cli.ts`, and widening the signature drags the composition root into the change. `manifest.ts` already establishes the read-it-directly pattern for the pinned corpus constants, with the stated reason that a manifest must not be able to claim a corpus the code will not import - the identical argument applies here.
- Trap 1: bumping the version invalidates the resume index for every existing record. That is CORRECT (a new experiment) but it must be a deliberate, announced cost, not a surprise.
- Trap 2: a version constant nobody bumps is worse than none, because it asserts an identity that is false. Pin it with a test that digests the assembled prompt for a canonical fixture Spec, so changing a rule without bumping the version fails loudly.

# Two adjacent facts found in the same survey

- **The transport retry is NOT in the model router.** `createRetryingHttpPort`, `TransportCircuitBreaker`, and `backoffDelayMs` live in `app/eval/sweep/transport-retry.ts`, wrapping the `JsonHttpPort` from `@app/agent`. Anyone told "the throttling code is in `app/agent/model-router/*`" will look in the wrong place.
- **`Retry-After` is unreachable today.** `JsonHttpResponse` is `{ status, body }` and `HostFetchResponse` is `{ status, body }`; no reply header crosses the port, deliberately, because that boundary exists to let nothing about the call escape. Honoring `Retry-After` therefore requires widening that seam with a single PARSED, bounded number - not a header map.

# Links

- app/eval/sweep/config-identity.ts (`IDENTITY_EXCLUDED_FIELDS`, `canonicalSweepConfigJson`)
- app/eval/sweep/manifest.ts (the read-the-constant-directly precedent)
- app/eval/sweep/transport-retry.ts, app/agent/model-router/json-http-port.ts
- .kiro/specs/eval-campaign-readiness/ (the spec that closes this)
- [[gotcha-three-testbench-defect-classes-that-fail-the-reference-design]]
- [[decision-diagnostic-only-config-fields-are-excluded-from-configHash]]
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]]
- product-ece/ECE-CONTEXT-ENGINEERING.md (section 7, the certified configuration)
