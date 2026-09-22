---
type: gotcha
title: A stale "wired in task 6.4" comment outlived its own task and hid four terminal outcomes hardcoding repairProvenance to NO_REPAIR
status: candidate
provenance: testbench-dialect-normalization spec, task 5.2 (discovered while building a worked example for normalization threading)
tags: [verification-loop, repair-loop, accounting, stale-comment, regression, checkpoint-gap]
timestamp: 2025-06-19T00:00:00Z
verifiedBy:
---

# What happened

Task 5.2 built a worked example (repair attempted+accepted, then the run passes) to confirm
`NormalizationProvenance` threading. The example surfaced that the resulting `VerifiedModule`
still carried `repairProvenance: {attempted: false, accepted: false}` - the exact defect
checkpoint 2 of THIS SAME SPEC claimed was closed for good.

# Root cause

`#onPass`, `#unverified`, and `#failClosed` (via the shared `#refusePass`/`RefusedPass` path)
all hardcoded `repairProvenance: NO_REPAIR` in their return object literals, each annotated
with a comment reading "wired in task 6.4" or "no repair path exists yet". Task 6.4 is from the
PRIOR spec (`testbench-repair-loop`) and landed long ago - the comment was never updated once
that task actually shipped, so it kept asserting a false thing indefinitely. None of these
three constructors took a `repairProvenance` PARAMETER at all, so there was no compile error
to force the fix when `#admitInstrument`'s real `repairProvenance` became available in
`#iterate`.

Checkpoint 2 (task 2 of `testbench-dialect-normalization`) verified tasks 1.1/1.2/1.5/1.7 -
all of which fixed the CONTROL-PATH (`app/eval/harness.ts`) and the immediate refusal path in
`verification-loop.ts`. It never traced provenance all the way through a PASSING or EXHAUSTED
outcome, so the gate passed while this defect sat one layer downstream, untouched.

# Fix / rule

Threaded a `repairProvenance` local through `#iterate` (`const repairProvenance =
admission.repairProvenance;`, mirroring the existing `normalization` local pattern already
added by task 5.2), and added a `repairProvenance` parameter to every terminal-outcome
constructor that previously hardcoded `NO_REPAIR`: `#onPass`, `#unverified`, `#failClosed`,
`#incompleteEvidence` (the last two share the `RefusedPass` shape, so one field addition fixed
both). Left the ONE genuinely-different site alone: the mid-run `instrument-refused` literal
inside the simulate loop, because a mid-run build failure is a different trigger point than
the precheck-path repair (Req 3.4 is precheck-only) - reworded its stale comment but kept its
`NO_REPAIR` behavior, which is correct.

General rule: a comment that says "not yet wired, will land in task X" is a time bomb once
task X actually lands and the comment is not deleted. Grep for "wired in task" / "not yet" /
"no ... path exists yet" style comments whenever a task that comment references completes, and
treat a passing checkpoint as evidence for the SPECIFIC call sites it exercised, not as
evidence the invariant holds everywhere the same field is threaded.

# Links

- `app/agent/orchestrator/verification-loop.ts` (`#onPass`, `#unverified`, `#failClosed`, `#incompleteEvidence`, `#iterate`)
- `.kiro/specs/testbench-dialect-normalization/tasks.md` (checkpoint 2, task 5.2)
- [[verification-recipe-testbench-dialect-normalization-checkpoint-2-accounting-fixed]] (the checkpoint that passed while this sat undetected)
