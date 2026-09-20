---
type: pattern
title: Prefer a port's memoized decision over the post-hoc fallback that predates it
status: candidate
provenance: task 6.6 (instrument-precheck-and-attribution spec), spec-task-execution subagent
tags: [eval, eval-harness, instrument-admission, ports, typescript, exactOptionalPropertyTypes]
timestamp: 2026-09-20T22:50:00Z
verifiedBy:
---

# Pattern

When a new port lets a loop decide something DURING a run that a harness used to decide only
AFTER the run, thread the port down optionally and have the harness prefer the port's memoized
answer, falling back to the pre-existing after-the-loop code path UNCHANGED whenever the port
was never actually consulted (not wired, or a runner that ignores it).

# When to use

- Requirement 4.14's exact shape: "WHERE no Recorded_Instrument_Verdict reached the Eval_Harness
  through the Instrument_Admission port, THE Eval_Harness SHALL run the Instrument_Control after
  the Verification_Loop has returned, exactly as it does today."
- Any time a port is added to run a check EARLIER than an existing collaborator already runs it,
  and the "at most once" invariant (Req 4.12 here) must hold across BOTH the new and the old
  path without duplicating the check.

# Recipe / example

`app/eval/harness.ts#runSample`:
1. Build a per-sample adapter (`MemoizingInstrumentAdmission`) only if the underlying collaborator
   (`instrumentControl`) is wired; otherwise pass `undefined` through so a runner that doesn't
   know about the port sees nothing.
2. Forward the adapter into the existing drive call as an added OPTIONAL field on the request
   (`EvalSampleRequest.instrumentAdmission`), never widening the loop runner port's other fields.
3. After the drive call returns, decide the final result as
   `adapter?.recorded() ?? (await legacyFallback(...))` - the memoized non-null result wins; a
   `null` memo (adapter never consulted) or no adapter at all falls back to the ORIGINAL,
   byte-for-byte-unchanged post-loop method.
4. Keep the legacy method's body completely untouched. It is not dead code - it is the fallback
   for exactly the runners/paths that never reach the new port.

# Pitfalls

- `exactOptionalPropertyTypes: true` (already on in this repo's tsconfig) rejects
  `{ instrumentAdmission: request.instrumentAdmission }` when the source type is
  `X | undefined` and the target property is optional-but-not-undefined (`instrumentAdmission?:
  X`, not `instrumentAdmission?: X | undefined`). Conditionally spread instead:
  `...(value === undefined ? {} : { key: value })`. This bit both the harness -> loop-runner
  request and the loop-runner -> `VerificationLoop` constructor call in this task.
- Do not re-run the wrapped check "just to be safe" when the memo is present - that is exactly
  the double-run this pattern exists to prevent (see
  [[gotcha-per-sample-sink-must-be-scoped-to-scheduled-slot]] for a sibling per-sample-scoping
  lesson in the same harness).
- Existing tests that fake the OLD port only (e.g. `ScriptedRunner implements EvalLoopRunner` in
  `harness-instrument-control.test.ts`, which never reads `request.instrumentAdmission`) exercise
  the fallback path for free and should keep passing unmodified - if they start asserting 0 or 2
  calls to the wrapped control, the adapter's memoization or the harness's preference logic broke.

# Links

- `app/eval/harness.ts` (`#buildAdmission`, `#drive`, `#runSample`)
- `app/eval/instrument-admission.ts` (`MemoizingInstrumentAdmission`)
- `app/eval/loop-runner.ts` (`EvalSampleRequest.instrumentAdmission`)
- `app/eval/verification-loop-runner.ts` (`#buildLoop`)
- [[gotcha-per-sample-sink-must-be-scoped-to-scheduled-slot]]
