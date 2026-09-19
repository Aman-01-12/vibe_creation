---
type: gotcha
title: An orchestrator prompt that hands a subagent a "pre-verified" fact list must still be independently checked by the subagent
status: candidate
provenance: task 9.3 (eval-campaign-readiness spec, Track C slice config)
tags: [orchestrator, subagent, verification, rtllm, corpus, spec-workflow, dead-end]
timestamp: 2026-09-19T13:07:34Z
verifiedBy: 
---

# Gotcha

Dispatching task 9.3 (commit `sweep.config.tbslice.json`), the orchestrator's prompt to the
`spec-task-execution` subagent included a candidate list of 15 RTLLM problem ids and stated
they were "already verified against upstream and against existing test fixtures in this repo
for correct spelling" - plus a fully pre-written "expected" final gate result the subagent was
effectively invited to just confirm back.

That framing was itself only partially checked: the orchestrator's own quarantine list
(paraphrased in the prompt) named only 2 of the real 4 `STAGE0_QUARANTINE` entries in
`app/eval/corpus/stage0-quarantine.ts` (missed `freq_divbyeven` and `clkgenerator`). Had one
of the 15 candidate ids actually been one of the two omitted quarantined designs, a subagent
that trusted the "already verified" framing at face value would have committed a config
referencing an unusable design.

**What the subagent did right**: it did not take the "pre-verified" framing on faith. It
independently re-derived ground truth against the pinned checkout on disk (`.eval-corpus/rtllm/**`),
`File_list.md`, the FULL `app/eval/corpus/stage0-quarantine.ts` (not the orchestrator's
paraphrase of it), and the real id-construction logic in `pinned-source.ts`'s `rtllmProblemId`.
In this instance all 15 candidate ids turned out correct and non-quarantined - but that was
CONFIRMED, not assumed.

# Root cause

An orchestrator (or any dispatching agent) summarizing "already-verified" facts into a
downstream prompt is itself an unverified claim once it leaves the context where the
verification actually happened. Paraphrasing a list (e.g. "2 quarantined designs" instead of
reading the real 4-entry array) silently drops information without signaling that anything
was dropped.

# Rule going forward

When a task-dispatch prompt states a fact is "already verified" - a corpus id list, a hash, a
config shape - the receiving subagent (or any agent) should still re-derive it from the actual
source of truth (the real file, not a summary of the real file) before committing artifacts
that depend on it, especially for anything that is asserted at runtime (a bad problem id here
would only surface when `problem-selection.ts` refuses it against the live scored corpus, which
is exactly the kind of late, expensive-feedback failure this class of bug produces).

# Links

- `app/eval/corpus/stage0-quarantine.ts` - the real, authoritative 4-entry quarantine list.
- `app/eval/sweep/sweep.config.tbslice.json` - the artifact this check protected (task 9.3).
- `app/eval/sweep/problem-selection.ts` - where an unusable id would have surfaced, and only at
  campaign-run time, not at config-commit time.
