---
okf_version: "0.1"
---

# chipAgent Knowledge Vault - Root Map of Content

This vault is our knowledge base + continuous-learning memory. It is OKF-conformant (markdown + frontmatter + links), so it doubles as the authoring surface for the product's shipped knowledge. Design + guardrails: `../product-ece/ECE-OBSIDIAN-KNOWLEDGE-MEMORY.md`.

How agents use it: read this MOC first, follow only the relevant links (progressive disclosure), pull the few relevant notes into context, and capture new learnings as `candidate` notes in `_inbox/`. A note only becomes `trusted` after the eval harness validates it.

## Sections
- [[decisions/index|Decisions]] - why we chose things (ADRs).
- [[patterns/index|Patterns]] - reusable build patterns.
- [[gotchas/index|Gotchas & dead-ends]] - failures and their causes (continuity; fed by the action-recorder).
- [[verification/index|Verification recipes]] - how to independently test a class of design.
- [[domain/index|Domain knowledge]] - HDL / embedded / PCB (becomes the shipped OKF concepts).
- [[glossary/index|Glossary]] - terms.
- [[_inbox/index|Inbox]] - freshly captured `candidate` notes awaiting curation.

## Rules
- One concept per note; every note has frontmatter with a `type` and `status`.
- `status: candidate` until eval-gated; only then `status: trusted`.
- Never store secrets/PII here (use `_private/`, which is gitignored).
- Knowledge improves the proposal; the deterministic oracle still decides correctness.
- See [[_SCHEMA]] for the note schema and conventions.
