---
okf_version: "0.1"
---

# chipAgent Knowledge Vault - Root Map of Content

This vault is our knowledge base + continuous-learning memory for BUILD time: it is what Kiro and the external agent CLIs read to know what past sessions already tried, learned, and ruled out.
It is OKF-conformant (markdown + frontmatter + links), so a note we promote can be curated straight into the product's shipped knowledge without reformatting.
It is not itself the product's knowledge: the shipped bundle is `../app/knowledge/okf-bundle/`, and the flow is one-way (vault -> curate -> copy into the bundle).
Design + guardrails: `../product-ece/ECE-OBSIDIAN-KNOWLEDGE-MEMORY.md`.

How agents use it: start at [[MANIFEST]] - the generated flat catalog of every note - scan it for your area, pull only the few relevant notes into context, and capture new learnings as `candidate` notes in `_inbox/`. A note only becomes `trusted` after the eval harness validates it.

The section maps below are the human-facing narrative and they lag: most notes still sit in `_inbox/` and are not linked from any map yet. Do not conclude a topic is uncovered because a section map looks empty - check [[MANIFEST]], which is generated from the notes themselves and is always complete.

## Sections
- [[MANIFEST|Manifest]] - **start here**: generated catalog of every note (regenerate with `npm run vault:manifest`).
- [[decisions/index|Decisions]] - why we chose things (ADRs).
- [[patterns/index|Patterns]] - reusable build patterns.
- [[gotchas/index|Gotchas & dead-ends]] - failures and their causes (continuity; fed by the action-recorder).
- [[verification/index|Verification recipes]] - how to independently test a class of design.
- [[domain/index|Domain knowledge]] - HDL / embedded / PCB (source material curated into the shipped OKF concepts).
- [[glossary/index|Glossary]] - terms.
- [[_inbox/index|Inbox]] - freshly captured `candidate` notes awaiting curation.

## Rules
- One concept per note; every note has frontmatter with a `type` and `status`.
- `status: candidate` until eval-gated; only then `status: trusted`.
- Never store secrets/PII here (use `_private/`, which is gitignored).
- Build-time only: this vault is never shipped and the product's runtime `retrieve` tool must never traverse it.
To put knowledge in front of a student, curate a `trusted` note into `../app/knowledge/okf-bundle/` instead.
- Knowledge improves the proposal; the deterministic oracle still decides correctness.
- See [[_SCHEMA]] for the note schema and conventions.
