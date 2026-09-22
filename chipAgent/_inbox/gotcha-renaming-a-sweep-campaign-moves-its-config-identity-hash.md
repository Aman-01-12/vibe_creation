---
type: gotcha
title: Renaming a sweep campaign moves its config-identity hash - runName and outputDir ARE identity-bearing, and only captureArtifacts is excluded
status: candidate
provenance: testbench-dialect-normalization task 18.1 config authoring (sweep.config.stage1-screen-dialect-v1.json), measured live against app/eval/dist
tags: [eval, sweep, config-identity, resume, campaign-comparison, gotcha]
timestamp: 2026-09-22T14:45:00Z
verifiedBy:
---

# What happened

Authoring `sweep.config.stage1-screen-dialect-v1.json` as a copy of
`sweep.config.stage1-screen-repair-v1.json` with ONLY `runName` and `outputDir` changed, the
working assumption was that those two fields are naming/plumbing and therefore excluded from
`sweepConfigHash`. Measured live, they are not:

- `stage1-screen-repair-v1.json` -> `51e0766c570801a4`
- `stage1-screen-dialect-v1.json` -> `72f59f0d27078b0d`

Cause isolated in the same run: the base config with ONLY `runName` + `outputDir` swapped to the
new values hashes to exactly `72f59f0d27078b0d`, and the new config with them set back to the old
values hashes to exactly `51e0766c570801a4`. The two canonical JSONs are byte-identical once
those two fields are neutralized, so nothing else differed.

# Root cause

`IDENTITY_EXCLUDED_FIELDS` in `app/eval/sweep/config-identity.ts` contains exactly ONE entry,
`captureArtifacts`. Every other `SweepConfig` field participates, `runName` and `outputDir`
included - and the module's own docstring says so ("That includes the output directory..."). The
`_`-prefixed comment keys are a non-issue: the parser strips them, so they never reach the hash.

# Fix / rule

Do not assert "the rename does not change the identity" for a sweep config - it does. A copied
campaign under a new name is a new identity by construction, so:

- It can never resume into, or pool with, the campaign it was copied from. That is usually what
  you want for a re-measurement, and it is the case here (`RESULTS_SCHEMA_VERSION` 12 already
  refuses the prior run's v11 records, and `NORMALIZER_VERSION` 3 /
  `TESTBENCH_REPAIR_POLICY_VERSION` 2 had already moved the identity anyway).
- Comparing two campaigns is therefore done by reading the two summaries SIDE BY SIDE, never by
  pooling records under a shared hash. Any plan that depends on two differently-named configs
  sharing a hash is built on a false premise.
- Resume WITHIN a campaign is unaffected: the same config file always hashes to the same value.

The asymmetry in `IDENTITY_EXCLUDED_FIELDS` is deliberate and should not be "fixed" by adding
`runName`/`outputDir` to it - see
`decision-diagnostic-only-config-fields-are-excluded-from-configHash.md`. An extra re-run costs
money; a wrongly pooled sample corrupts a number silently.

# Links

- `app/eval/sweep/config-identity.ts` (`IDENTITY_EXCLUDED_FIELDS`, `identityBearingFields`)
- `app/eval/sweep/config-values.ts` (`COMMENT_KEY_PREFIX` - `_` keys are stripped before hashing)
- `app/eval/sweep/sweep.config.stage1-screen-dialect-v1.json`
- `chipAgent/_inbox/decision-diagnostic-only-config-fields-are-excluded-from-configHash.md`
