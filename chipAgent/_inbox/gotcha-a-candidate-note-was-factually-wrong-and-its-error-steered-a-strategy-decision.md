---
type: gotcha
title: A candidate note was factually wrong about its own measurement, and the error steered a strategy decision before a cross-tab caught it
status: candidate
provenance: spec testbench-dialect-normalization, task 14.1; the superseded note gotcha-testbench-repair-loop-measured-near-zero-2-of-259-locobs-condition.md
tags: [vault, knowledge-memory, methodology, eval, measurement, candidate-vs-trusted, dead-end]
timestamp: 2026-09-28
---

# What happened

A `status: candidate` note recorded the `stage1-screen-repair-v1` post-mortem as "259 repair attempts, 2 accepted, and 48 of them fired with no hint - the literal placebo condition."
Both halves of that were wrong, and the note was written by the same session that ran the campaign.

- The 48 `repairHint: null` samples were NOT a no-feedback condition. They carry a verbatim iverilog diagnostic. `null` on disk recorded a PERSISTENCE gap (`hint` built as a local in `#repairPrecheckFailure`), not an absent signal.
- The 259 was not one population. Declined control-path repairs persist `attempted: false`, so 259 mixes 48 real precheck attempts with 211 "admissible revisions produced".

The next session read that note, believed it, and built a strategy on it: the first `decision-council` run concluded "retrieval-augmented repair, because our feedback is the `LocObs` condition the literature measures as worthless."
That conclusion was downstream of the error. It survived five advisers and five peer reviews, because every adviser was reasoning over the same wrong premise.

# What caught it

Not re-reading the note, and not the council. A cross-tab of two persisted sources that should have agreed:

```sh
# results.jsonl has no repairHint field at all - so counting "hints" there is meaningless
jq -r 'select(.repairAttempted==true) | [.repairAccepted, .instrumentValidity, .instrumentDefect] | @tsv' results.jsonl
# the per-sample artifact document is where repairHint lives
jq -r 'select(.repairAttempted==true) | [(if (.repairHint//null)==null then "no-hint" else "hint" end), (.failureNote//"-")] | @tsv' */*/*/outcome.json
```

The second command split cleanly: 48 `no-hint` were all `instrument-refused: testbench-build-failed` (the loop's precheck path) and 211 `hint` were all `instrument-inadmissible` (the harness's control path).
Two arms, two mechanisms, one field name. The original note had read the field without reading which code path wrote it.

# Root cause

The note reported a DERIVED number (a hint count) as if it were a measured one, and derived it from the wrong file.
`repairHint` is an artifact-document field, never a `results.jsonl` field.

# Rule

- A candidate note is authoritative as a record of what the oracle said, and NOT as a record of a number the session computed on top of it. When a note states a count, record the exact command and the file it was read from, so the next session can re-run it rather than inherit it.
- Before a strategy decision rests on a note's number, re-derive that number from the persisted artifacts. The cost here was one `jq` cross-tab against a conclusion that had already passed a five-adviser review.
- Two code paths writing one field name is what made the error invisible. A field that can be written by two mechanisms should record WHICH one wrote it.

# Links

- [[gotcha-testbench-repair-near-zero-is-two-mechanical-dialect-classes-not-a-feedback-problem]] (the corrected record that replaced the wrong note)
- `.kiro/specs/testbench-dialect-normalization/clarification-answers.md` (both council runs, and why Council B governs)
- `app/eval/harness.ts` `#repairIfTriggered`, `app/agent/orchestrator/verification-loop.ts` `#repairPrecheckFailure`
