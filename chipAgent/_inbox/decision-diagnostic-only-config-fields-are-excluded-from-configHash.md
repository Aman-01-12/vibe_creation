---
type: decision
title: A sweep config field that cannot move a measured number is excluded from configHash, so adding observability never orphans paid samples
status: candidate
provenance: eval artifact capture (app/eval/sweep/config-identity.ts)
tags: [eval, sweep, resume, config-identity, observability, cost, honesty]
timestamp: 2025-06-04T00:00:00Z
---

# Decision

`captureArtifacts` (per-sample artifact capture, default ON) is DELIBERATELY excluded from
`sweepConfigHash` via `IDENTITY_EXCLUDED_FIELDS` in `app/eval/sweep/config-identity.ts`. It is
the first entry on that list, and the list has a narrow admission rule: a field belongs there
only if it cannot change what a sample measures.

# Context / options considered

`canonicalSweepConfigJson` hashed the WHOLE config, and resume works by skipping samples whose
`configHash` matches. So any new config field changes the hash of every existing experiment.

1. Include it (the old blanket rule, "conservative"). Costs a full re-run of every recorded
   campaign the moment the option ships.
2. Exclude it, documented, with a fixed rule for what else may ever be excluded. Chosen.
3. Keep capture out of the config entirely (env var / CLI flag). Rejected: the config file is
   the artifact a result is cited against, and a run's own manifest should state whether its
   evidence was captured.

# Rationale

The concrete stake, not a hypothetical: `.eval-runs/smoke-v1/results.jsonl` holds three PAID
samples keyed by `8b0fc1d9be13801f`. Including a diagnostic flag in the identity would have
made all three invisible to the resume index and silently re-run them - for numbers that are
still exactly right. The hash exists to stop two experiments blending into one number; it is
not there to invalidate measurements when a log file is switched on.

Direction of the rule matters and is asymmetric: an unnecessary re-run costs money, while a
wrongly reused sample corrupts a result and nothing in the report shows it. So when in doubt a
field stays IN the identity. Only provably measurement-neutral fields are excluded.

Pinned by a regression test in `sweep/manifest.test.ts`: the committed smoke config must still
hash to `8b0fc1d9be13801f`, so any future config change that would orphan those samples fails a
test instead of quietly re-paying for them.

# Revisit trigger

Before adding a SECOND entry to `IDENTITY_EXCLUDED_FIELDS`: prove the field cannot reach the
model, the prompt, the caps, the seed, the corpus selection, the sandbox, or the oracle. If it
can reach any of those, it stays in the identity. Also revisit if artifact capture ever gains a
mode that changes what the loop is given (it must not - capture runs only after a sample is
fully measured).

# Links

- app/eval/sweep/config-identity.ts (`IDENTITY_EXCLUDED_FIELDS`)
- app/eval/sweep/config.ts (`DEFAULT_CAPTURE_ARTIFACTS`)
- app/eval/sweep/manifest.test.ts (smoke-run hash regression guard)
- .eval-runs/smoke-v1/results.jsonl
