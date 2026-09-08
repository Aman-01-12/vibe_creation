---
type: gotcha
title: A per-sample collaborator given to EvalHarness must be scoped to the scheduled slot, or the sweep persists evidence for slots that never ran
status: candidate
provenance: eval artifact capture (app/eval/artifact-sink.ts + sweep/sample-scheduler.ts)
tags: [eval, eval-harness, sweep, sample-scheduler, artifacts, observability, honesty]
timestamp: 2025-06-04T00:00:00Z
---

# What happened

Wiring the new `EvalArtifactSink` into `EvalHarness` and then into `SweepRunner`, two runner
tests failed immediately: the sink received sample index 0 AND 1 when only index 1 was
dispatched, and a 2-sample run called the sink 4 times instead of 2.

# Root cause

`SweepRunner#measure` schedules ONE slot by handing the harness a loop runner that declines
every other slot (`scheduleOneSample`). But `EvalHarness.run` still iterates every sample
index of the problem, so each declined slot is fully MEASURED as `setup-failed` (that is what
a decline returns). The sweep already refuses to persist those as records - `#measure` reads
out only the scheduled sample - but the artifact sink was called from inside the harness's
per-sample path, so it saw the declined slots too.

Left unfixed, a sampleCount=5 campaign would write n*(n-1) = 20 bogus `setup-failed` artifact
directories per problem, each looking like a real generation failure. That is worse than no
capture: a reader would count them as failures the models caused.

# Fix / rule

Scope the sink to the slot, next to the runner it mirrors: `captureOneSample(sink, slot)` in
`sweep/sample-scheduler.ts` drops any write whose descriptor is not the scheduled slot, and
`#measure` wraps the arm's shared sink with it. The harness stays ignorant of scheduling.

The general rule: `EvalHarness` measures EVERY slot of the problem it is handed, so ANY
per-sample collaborator the sweep injects (a sink, a recorder, a tracer) must be scoped to the
scheduled slot the same way the loop runner is. One-sample scheduling is not a harness
concept, so the harness will never do this for you.

Second, cheaper lesson: a declined slot is indistinguishable from a real `setup-failed` at the
harness layer. Anything that persists a `setup-failed` from a sweep-driven harness call must be
slot-scoped, or it will fabricate failures.

# Links

- app/eval/sweep/sample-scheduler.ts (`scheduleOneSample`, `captureOneSample`)
- app/eval/sweep/runner.ts (`#measure`)
- app/eval/artifact-sink.ts
- app/eval/sweep/sample-scheduler.test.ts (captures nothing for a declined slot)
