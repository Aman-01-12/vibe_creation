---
inclusion: always
---

# Knowledge memory - consult the vault before re-deriving anything

`chipAgent/` is our build-time knowledge vault: what past sessions already tried, learned, and ruled out.
It exists so we stop paying twice for the same discovery.
If you find yourself reconstructing a fact about this repo from the codebase, that fact probably has a note.

## The rule

Before non-trivial work, read `chipAgent/MANIFEST.md`.
It is a generated flat catalog of every note (status, title, tags, path), so this is ONE read - not a tree walk.
Scan it for your area, then open only the two or three notes that match.
Never read the whole vault; selection is the point.

Consulting is mandatory - not best-effort - when you are about to:
- debug a lint, `tsc`, or test failure (22 gotchas are recorded; most repeat failures are already written down)
- write a fake, a property test, or a test harness
- touch the verification loop, oracle, sandbox, model router, eval gate, or trust/display layer
- ask "why is it built this way" about an existing boundary or port
- re-explore an area a previous session already worked in

Do not navigate by `chipAgent/index.md` and the section `index.md` maps alone.
Those are the human-facing narrative and they lag reality: most notes still sit in `_inbox/` and are not linked from any map.
`MANIFEST.md` is the source of truth for what exists.

## How to read `status` (this distinction matters)

`trusted` - eval-gated. May steer generation and may be treated as a correctness claim.

`candidate` - not eval-gated. Authoritative as a **record of what happened**: what was attempted, what the deterministic oracle actually said, what failed and why, which paths were dead ends. Not authoritative as a **correctness claim** about HDL or product behavior.

So: never dismiss a `candidate` note as noise.
Almost every note is `candidate`, and their continuity value is exactly why the vault exists.
Use them to avoid repeating a dead end.
Do not use them to declare something correct - the deterministic oracle still decides that.

Respect `validUntil` when present; treat an expired note as a historical record, not current fact.

## Capture

When something worth remembering emerges - a decision, a reusable pattern, a gotcha or dead end, a verification recipe - write ONE short note into `chipAgent/_inbox/` using the matching `chipAgent/templates/` file.

- Frontmatter per `chipAgent/_SCHEMA.md`: `type`, `title`, `tags`, `provenance`, `timestamp`, and `status: candidate`.
- Never write `status: trusted` yourself. Promotion requires the eval harness (`verifiedBy`).
- Capture the decisive facts: what the oracle said, the root cause, the fix, the dead end. Not prose.
- Secrets and PII go only in `chipAgent/_private/` (gitignored), never in a committed note.
- Nothing genuinely new? Write nothing. Do not manufacture notes.

After adding, renaming, or deleting a vault note, run `npm run vault:manifest` so the catalog stays accurate.
`npm run vault:check` fails if it is stale.

## Guardrail (do not break this)

The vault is BUILD-time only.
It is never shipped, and the product's runtime `retrieve` tool reads only `app/knowledge/okf-bundle/` - never `chipAgent/`.
To put knowledge in front of a student, curate a `trusted` note into that bundle.
The flow is one-way: vault -> curate -> bundle.

Design rationale: `product-ece/ECE-OBSIDIAN-KNOWLEDGE-MEMORY.md`.
