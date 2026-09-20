---
type: decision
title: Testbench generation is its OWN ModelTask, and that cost two config-hash re-pins
status: candidate
provenance: founder-approved routing change (no spec doc); full gate re-run after the edit
tags:
  [
    model-router,
    routing,
    bake-off,
    testbench,
    config-identity,
    instrument-validity,
    model-tasks,
    resume,
  ]
timestamp: 2026-09-25T00:00:00Z
---

# Decision

`ModelTask` gained a sixth member, `'testbench'`, placed immediately after `'generation'` in
both the union and `MODEL_TASKS`.
`TESTBENCH_MODEL_TASK` in `app/agent/roles/testbench/testbench-agent.ts` moved from
`'generation'` to `'testbench'`.
Its default route MIRRORS `generation` exactly (`deepseek` primary, `claude` escalation), so no
call changes provider today.

NO testbench-repair role was added, deliberately.
There is no testbench repair path in the product: a coverage-incomplete draft is REFUSED, not
regenerated (`.kiro/specs/instrument-precheck-and-attribution/clarification-answers.md` Q2).
A role with no caller would assert a routing capability that does not exist, and would widen
every arm's role map - and therefore the experiment identity - for nothing.

# Context / options considered

Testbench generation and RTL generation shared one role, so they could not be assigned
different models. The per-role bake-off needs them separable, because the two are scored by
different instruments: the Generation_Agent is scored on oracle-verified pass@k, the
Testbench_Agent on instrument validity (does its testbench pass the reference design, and does
it cover every criterion). `gotcha-tbslice-v1-testbench-generator-is-the-bottleneck-1-of-12.md`
already measured those two capabilities diverging sharply on the SAME model - 1 of 12
testbenches passed its reference design - which is the whole reason a separate role is worth
its cost.

The rejected option was to keep one role and swap the shared model. That cannot express the
outcome we expect to ship: best-RTL-model for `generation`, best-testbench-model for
`testbench`, in one run.

# Rationale

The identity cost was the real decision, and it was paid on purpose.

Adding a role changes EVERY arm's canonical `roleModels` map - including single-`model` arms,
because `singleModelRoles` fills every role from the one id - so `canonicalSweepConfigJson`
changes and `sweepConfigHash` moves. Both pinned hashes in `app/eval/sweep/manifest.test.ts`
moved:

- `SMOKE_RUN_CONFIG_HASH`: `02c41167d2c20062` -> `87dcd6c3f78c23fa`
- `TBSLICE_RUN_CONFIG_HASH`: `7d878a2f9e6fec7d` -> `ded77955f2374691`

Both observed by running the test and reading the actual-vs-expected diff, never pre-computed -
the same discipline `gotcha-prompt-version-absent-from-experiment-identity.md` used when
`TESTBENCH_PROMPT_VERSION` moved the smoke hash.

That move is CORRECT, not collateral damage. A run that served testbench generation from the
`generation` model is a different experiment from one that served it from a separately chosen
model, so their samples must never pool into one pass@k - the identical argument already
recorded for `minKillRate`, `mutantWallMs`, `TESTBENCH_PROMPT_VERSION`, and
`INSTRUMENT_POLICY_VERSION`. The reason was appended to each constant's history comment rather
than the number being quietly swapped.

Routing defaults stay shared because a testbench is still a code-generation-class task
(ECE-TECH-DECISIONS Q1). Mirroring `generation` means the split is purely structural until a
bake-off decides otherwise: nothing about today's behaviour changes, only what is now
addressable.

Note this interacts with `decision-bakeoff-routing-has-no-cross-model-fallback.md`: an eval arm
gets single-entry chains and `maxAttempts: 1`, so the new role inherits no-fallback in a
bake-off and its failures are attributed to the model under test, as intended.

# Rules learned

- The compile-error safety net worked exactly as designed for TOTAL `Record<ModelTask, ...>`
  maps (`RoutingPolicy.taskRoute`, `EvalRoleModels`), and did NOT fire for the things that
  matter most at runtime: JSON `roleModels` literals (validated by `parseRoleModels`, so they
  fail as `ARM_ROLE_MODEL_MISSING` at parse time) and hand-rolled role LISTS in tests (a
  subset of `ModelTask[]` still type-checks). Widening this union means grepping, not just
  compiling - the same asymmetry recorded in
  `gotcha-union-widening-breaks-total-record-fakes.md`.
- Four local role lists were replaced with the imported `MODEL_TASKS` so the next widening is
  automatic: `app/test/model-router-credential-confinement.property.test.ts`,
  `app/test/model-router-routing.property.test.ts` (which SHADOWED the exported name), and
  `app/eval/sweep/config-parse.test.ts` (which also hardcoded `{ length: 5 }`).
- Prefer "every `ModelTask`" over a spelled-out count in prose. `app/eval/routing-policy.ts`
  said "all five" and had gone stale; a countless phrasing cannot.
- The anti-circular guarantee is independent of routing, as expected:
  `app/test/testbench-rtl-isolation.property.test.ts` passes unchanged. The Testbench_Agent is
  denied RTL by the SHAPE of its input types, not by which model answers it.
- **The role split was initially unobservable.** No test asserted which task the
  Testbench_Agent routes under - `testbench-agent.test.ts`'s `FakeModelRouter` did
  `void task`. Reverting `TESTBENCH_MODEL_TASK` to `'generation'` would have left the whole
  suite green. Fixed by recording `router.tasks` and adding one assertion; verified
  non-vacuous by actually flipping the constant back and watching it fail
  (`expected ['testbench'], received ['generation']`).
- Four testbench fixtures scripted a reply carrying `task: 'generation'` for a call the agent
  now makes as `'testbench'`. Type-legal and silently passing, but the fake was then lying
  about its own reply, which is exactly what makes a later assertion on `task` vacuous. All
  four corrected (`testbench-agent`, `testbench-rtl-isolation`, `testbench-coverage`,
  `testbench-signalling-known-answer`).
- Re-hit the trap already recorded in
  `gotcha-union-widening-breaks-total-record-fakes.md`: `@app/*` resolves to `dist`, so the
  first regression spot-check PASSED against a stale build and looked like a vacuous test.
  `npx tsc -b` before any single-file vitest spot-check, or the check measures the old code.
  The note was right; it is worth reading BEFORE the spot-check, not after.

# Cost and scope

- Gate after the change: `tsc -b` clean, `eslint app --max-warnings=0` clean,
  `prettier --check .` clean, `vitest run` 1697 passed / 6 skipped / 0 failed.
- The `+2` against the 1695 baseline is two NEW tests, not a behaviour change: the
  `['testbench', 'deepseek']` row in `model-router.test.ts`'s `it.each` routing table, and the
  routed-role assertion above. No pre-existing test changed outcome.
- No prompt text, no Testbench_Agent behaviour, and no `TESTBENCH_PROMPT_VERSION` was touched.
  `app/agent/roles/testbench/prompt.ts` was deliberately not opened.

# Revisit trigger

- If a testbench repair path is ever built (a coverage-incomplete draft regenerated rather
  than refused), revisit the no-repair-role decision - and expect another identity move.
- `.kiro/specs/hdl-creation-loop/design.md` still prints the five-member `ModelTask` union.
  Left alone on purpose (spec docs are not hand-edited); it should be corrected through the
  spec workflow so the design stops describing a narrower type than the code.

# Links

- app/agent/model-router/contract.ts (`ModelTask`), app/agent/model-router/routing.ts
  (`MODEL_TASKS`, `DEFAULT_ROUTING_POLICY`)
- app/agent/roles/testbench/testbench-agent.ts (`TESTBENCH_MODEL_TASK`)
- app/eval/sweep/manifest.test.ts (both pinned hashes and their history comments)
- app/eval/sweep/sweep.config.example.json (the per-role arm now names `testbench`)
- [[decision-bakeoff-routing-has-no-cross-model-fallback]]
- [[gotcha-prompt-version-absent-from-experiment-identity]]
- [[gotcha-tbslice-v1-testbench-generator-is-the-bottleneck-1-of-12]]
- [[gotcha-union-widening-breaks-total-record-fakes]]
- product-ece/ECE-CONTEXT-ENGINEERING.md section 7 (the certified configuration, CPVA)
