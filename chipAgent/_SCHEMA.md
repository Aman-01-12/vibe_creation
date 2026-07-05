---
type: reference
title: Vault note schema and conventions
status: trusted
provenance: founding setup
timestamp: 2026-07-04T00:00:00Z
---

# Note schema and conventions

Every note is one concept, one file, with YAML frontmatter:

```yaml
---
type: decision | pattern | gotcha | verification-recipe | domain-note | glossary | moc | reference
title: <short human title>
tags: [hdl, verification, ...]
status: candidate | trusted        # trusted only after the eval gate
provenance: <who/what created it>  # NEVER auto-write untrusted web/model output as trusted
timestamp: <ISO 8601>
validUntil: <optional ISO 8601 expiry>
verifiedBy: <eval run id / oracle>  # required for trusted, behavior-changing notes
---
```

## Lifecycle (the flywheel)
execute -> capture (candidate in `_inbox/`) -> curate (link, tag, dedupe, move into a section) -> gate (eval harness -> `trusted`) -> retrieve (progressive disclosure) -> prune (expire/invalidate stale notes).

## Rules
- Candidate notes never steer generation as if proven; only `trusted` notes do.
- Behavior-changing lessons require `verifiedBy` (an eval run) before `trusted`.
- Cross-link generously with `[[wikilinks]]`; keep a section MOC (`index.md`) updated.
- Time-aware: set `timestamp`; add `validUntil` for facts that go stale (parts, tool versions).
- Secrets/PII live only in `_private/` (gitignored); never here.
