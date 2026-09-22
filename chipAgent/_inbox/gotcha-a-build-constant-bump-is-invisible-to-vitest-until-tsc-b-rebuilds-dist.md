---
type: gotcha
title: A build-constant bump is INVISIBLE to vitest until `tsc -b` rebuilds dist, so a config-hash pin passes when it should have failed
status: candidate
provenance: testbench-dialect-normalization tasks 15.8/15.9 (NORMALIZER_VERSION 2 -> 3, app/eval/sweep/manifest.test.ts)
tags: [gotcha, vitest, monorepo, dist-resolution, config-identity, hash-pin, build-constant, false-green]
timestamp: 2025-06-19T00:00:00Z
verifiedBy:
---

# What happened

Task 15.8 bumped `NORMALIZER_VERSION` 2 -> 3 in `app/agent/orchestrator/normalizer-version.ts`
and was EXPECTED to fail the two pinned hash assertions in `app/eval/sweep/manifest.test.ts`.

It did not. The full suite came back 1862 passed / 0 failed, and `manifest.test.ts` alone came
back 34 passed. Read at face value that says "the bump did not reach the config identity",
which is the exact wrong conclusion - and the next step, a re-pin task, would then have pinned
the STALE pair or reported a false discrepancy and stopped.

# Root cause

`vitest.config.ts` declares no `resolve.alias`. So `@app/agent` resolves the ordinary Node way:
through the workspace symlink in `node_modules` to `app/agent/package.json`'s `exports`, which
point at `dist/`. Vitest therefore executes the COMPILED constant, not the source one.

`app/eval/sweep/config-identity.ts` imports `NORMALIZER_VERSION` from `@app/agent`, so the hash
it computes under vitest is a function of `app/agent/dist/orchestrator/normalizer-version.js` -
which still read `= 2` until a rebuild. A test file's OWN source edits take effect immediately
(vitest transforms those); a CROSS-PACKAGE value does not.

# Fix / rule

After editing any `app/<pkg>` source that another package reads, run `npx tsc -b` (or
`--force`) BEFORE running any suite that asserts on it. Confirm the rebuild actually landed by
reading the emitted file, not by trusting the build's exit code:

```sh
npx tsc -b --force
grep -n "NORMALIZER_VERSION = " app/agent/dist/orchestrator/normalizer-version.js
```

With dist rebuilt, the two pins failed exactly as the task predicted, and the live-observed pair
was `f7a172ae94c67954` / `fa9ec5a014b07e0f`.

Specific corollary for a config-hash re-pin: an UNEXPECTEDLY GREEN pin after a version bump is a
stale-dist symptom first and a "the fold-in is broken" finding second. Check dist before
concluding anything about the identity - and never pin off a run whose dist predates the bump,
because that pins the pre-bump value and the guard stack cannot catch it (the value it would
write is the one the `.not.toBe` guards already name, so in this repo it fails loudly - which is
exactly why those guards are stacked rather than replaced).

# Links

- `vitest.config.ts` (no `resolve.alias`; resolution goes through package `exports`)
- `app/agent/package.json` (`exports` -> `dist/`)
- `app/eval/sweep/config-identity.ts` (`identityBearingFields` reads the constant from `@app/agent`)
- `app/eval/sweep/manifest.test.ts` (`SMOKE_RUN_CONFIG_HASH`, `TBSLICE_RUN_CONFIG_HASH`)
- `chipAgent/_inbox/verification-recipe-config-hash-repin-must-reobserve-live-never-reuse-a-prior-reports-number.md`
