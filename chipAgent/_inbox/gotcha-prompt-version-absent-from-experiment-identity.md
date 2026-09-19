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

# Closed (tasks 9.1-9.4, eval-campaign-readiness Track C)

The fix landed exactly as scoped above, with no deviation:

- `app/agent/roles/testbench/prompt-version.ts` added, exporting `TESTBENCH_PROMPT_VERSION = 2`
  (2, not 1, because the prompt had already changed twice since the calibration run).
- `config-identity.ts` reads it DIRECTLY under the reserved key `__testbenchPromptVersion`
  (double-underscore prefix, no collision with any `SweepConfig` field); `sweepConfigHash`'s
  signature is unchanged, so `cli.ts` needed no edit - confirming the read-it-directly choice
  above was right.
- `manifest.ts` reads it the same way for `testbenchPromptVersion`, mirroring
  `corpus.pinnedCommit`.
- Pinned with `app/agent/roles/testbench/prompt-version.test.ts` (task 9.2): a SHA-256 digest
  of the prompt assembled for one fixed canonical fixture Spec (a 4-bit up-counter with reset),
  compared against a LITERAL pinned constant - not a self-recomputation, so it actually fails if
  a prompt rule changes without a version bump. Digest computed via a structural-cast
  `crypto.subtle`/`TextEncoder` idiom (see `pattern-host-crypto-digest-structural-cast-no-node-types.md`),
  because `app/agent`'s tsconfig has no ambient Node types and widening it collided with
  `fetch-json-http-port.ts`'s existing global casts.
- Trap 1 (predicted above) materialized exactly as expected: folding the version in moved
  `SMOKE_RUN_CONFIG_HASH` from `552626a05719c93c` to `9320f400d18b0ccc` in
  `app/eval/sweep/manifest.test.ts`. This was NOT a surprise - task 9.1 was explicitly scoped
  to cause it and task 9.4 was explicitly scoped to fix the pin, with the reason recorded as a
  4th bullet in that constant's history comment. Confirmed independently by observation (running
  the test), not by trusting a pre-computed number.
- Task 9.3 committed `app/eval/sweep/sweep.config.tbslice.json` - 15 real RTLLM problems
  spanning arithmetic/control/memory/miscellaneous, deliberately not `accu` (the design that
  motivated the whole Track C prompt fix) plus neighbours, so the rule is validated broadly
  rather than overfit to the one problem that surfaced it. Its hash is separately pinned as
  `TBSLICE_RUN_CONFIG_HASH = 5ede5f843ac2859b`.
- Property 16 (a prompt-version fold-in changes the identity) and the manifest/identity
  agreement property are both in `manifest.test.ts` now, fast-check based.
- Full gate after task 9.4: `1613 passed | 6 skipped | 0 failed` - zero failures, closing out
  the one expected carried-forward failure from task 9.1.
