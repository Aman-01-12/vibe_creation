---
type: verification-recipe
title: Re-pinning a config-identity hash must observe live, every time - a prior sub-agent's reported value goes stale the moment another identity-moving task lands on top of it
status: candidate
provenance: testbench-dialect-normalization spec, tasks 10.4/12.1/12.2/13.5 (four sequential identity-moving tasks in one session)
tags: [config-identity, hash-pin, verification-recipe, sweep, resume-safety]
timestamp: 2026-09-21T20:51:49Z
verifiedBy:
---

# What happened, concretely, in one session

Four tasks in sequence each changed `app/eval/sweep/config-identity.ts`'s inputs:
- Task 10.4 bumped `TESTBENCH_REPAIR_POLICY_VERSION` 1->2. Its sub-agent observed and reported
  `SMOKE_RUN_CONFIG_HASH` -> `14c77fa3c70e44a2`, `TBSLICE_RUN_CONFIG_HASH` -> `64093185ef852d98`.
- Task 12.1 folded `NORMALIZER_VERSION` in on top. Its sub-agent independently observed and
  reported DIFFERENT values: `57510b0540933dd2` and `49c4a7f86dd25e1a`.
- Task 12.2 (the actual re-pin task) was explicitly told NOT to trust either prior report and
  to run the test itself, live, one more time. It observed `57510b0540933dd2` /
  `49c4a7f86dd25e1a` - matching 12.1's report, because no further identity-affecting change had
  landed between 12.1 and 12.2.
- Task 13.5 moved the pair AGAIN, off 12.2's freshly pinned `57510b0540933dd2` /
  `49c4a7f86dd25e1a` and onto `832f0bff098e4469` / `7ae7c413d6a8b221`, with
  `NORMALIZER_VERSION` going 1->2 the only identity-bearing constant that moved.

All four "observations" were genuinely correct AT THE MOMENT each sub-agent ran the test. The
task-10.4 numbers were real and then went stale the instant task 12.1's own code change landed.

That is four live observations and three distinct pairs in ONE session: 10.4's, the 12.1/12.2 pair
(those two coincided only because nothing landed between them), and 13.5's. The recurrence count is
the point. The pair moved on EVERY intervening identity-bearing change, not occasionally, so a
reported hash going stale is the expected case rather than the unlucky one - and a value reported
by an earlier sub-agent in the same session is already stale by the time the next task reads it.

# Rule

A config-identity hash observed by an earlier task is scoped to the code state at THAT task's
commit, not to the spec as a whole. Any task that re-pins such a hash must re-run the test
itself, in its own execution, immediately before writing the new value - never reuse a number
carried forward from an earlier report in the same conversation, even one from the immediately
preceding task, and even if no code has OBVIOUSLY changed since (an unrelated task running in
parallel, or a task the orchestrator dispatched between the two, could have moved it too).

This is exactly the discipline `testbench-dialect-normalization`'s own tasks.md already states
("never pre-compute them, never derive them by inspection, and never guess... a hand-invented
value produces a test whose obvious 'fix' is to paste whatever the code printed, which passes
even if the fold-in silently did not happen") - this note adds the concrete case that the
danger includes a value from an EARLIER STEP of the same multi-task change, not only a value
invented from nothing.

# Links

- `app/eval/sweep/manifest.test.ts` (`SMOKE_RUN_CONFIG_HASH`, `TBSLICE_RUN_CONFIG_HASH`)
- `app/eval/sweep/config-identity.ts` (`identityBearingFields`)
- `.kiro/specs/testbench-dialect-normalization/tasks.md` (tasks 10.4, 12.1, 12.2, 13.5, and the Overview's own "the identity change and the hash re-pin are two separate tasks, in that order" note)
