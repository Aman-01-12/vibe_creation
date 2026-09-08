---
okf_version: "0.1"
type: moc
title: OKF seed bundle - root map of content
tags: [okf, hdl, verification, toolchain]
status: trusted
provenance: founding seed (task 10.1); distilled from product-ece decision docs and canonical HDL practice
timestamp: 2026-07-05T00:00:00Z
---

# OKF seed bundle - root map of content

This is the M1 curated Open Knowledge Format bundle the shipped product's Knowledge_Retriever traverses for HDL grounding.
It is OKF-conformant: one concept per markdown file, YAML frontmatter with a `type` and `status`, cross-linked with `[[wikilinks]]`, and a citations section on every concept note.
An agent uses it by progressive disclosure: read this map, follow only the relevant links, and pull the few concepts a sub-task needs.

Design and guardrails live in `product-ece/ECE-KNOWLEDGE-ARCHITECTURE.md` and `product-ece/ECE-TECH-DECISIONS.md` (Decision 3, OKF-first).
The retrieval logic itself is the Knowledge_Retriever (task 10.2); this bundle is only the content it reads.

## Sections
- [[hdl-patterns/index|HDL patterns]] - standard-block coding idioms a student's first modules rely on.
- [[verification-recipes/index|Verification recipes]] - how a spec-derived testbench proves an acceptance criterion, including the per-check signalling convention.
- [[toolchain-notes/index|Toolchain notes]] - Icarus Verilog compile-and-run and VCD basics.

## Authority rules (read before using anything here)
- Only `status: trusted` notes may steer generation as authority; `status: candidate` notes are hints, not authority.
- In this seed, the one `trusted` note is the per-check signalling contract ([[verification-recipes/check-line-signalling]]), because its ground truth is our own tested parser exercised by the real oracle-path integration test.
- Every other note is a `candidate` hint: canonical Verilog practice that improves the proposal but has not been through our eval gate, so it is not carried as authority.
- Knowledge here improves the proposal only.
- The deterministic oracle (the Icarus simulator plus an independently derived testbench) decides correctness; a note never overrides a Simulator verdict and never sets a Trust_Tier.
- A note becomes `trusted` only after the eval harness validates it, at which point its `verifiedBy` names the eval run or oracle.
- No secrets or PII are ever stored in this bundle.

## Provenance note
The vault sections `chipAgent/domain/hdl`, `chipAgent/verification`, and `chipAgent/patterns` were empty stubs when this seed was authored.
These concepts are therefore newly authored seed content, consistent with the ECE decision docs, `product-ece/ECE-VERIFICATION-METHODOLOGY.md`, and canonical Verilog practice, staged into the shipped bundle so retrieval is not a no-op.
As the vault accumulates eval-gated `trusted` notes, they should be promoted into this bundle.
