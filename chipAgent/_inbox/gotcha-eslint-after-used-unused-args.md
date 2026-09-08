---
type: gotcha
title: ESLint no-unused-vars (args after-used) flags trailing interface-method params even when underscore-prefixed
status: candidate
provenance: task 14.4 (self-healing.test.ts) - writing a fake SimulatorAdapter
tags: [eslint, typescript, testing, fakes]
timestamp: 2025-02-14
---

# What happened

While writing a fake `SimulatorAdapter` for the self-healing unit test, implementing
`simulate(rtl, _testbench, _limits)` failed lint with `@typescript-eslint/no-unused-vars`
on `_testbench` and `_limits`, even though they were underscore-prefixed. The same file's
generator fakes used underscore-prefixed params (`_input`, `_previousRtl`) with no error.

# Root cause

The repo ESLint config runs `no-unused-vars` with `args: "after-used"`: only parameters
that come AFTER the last USED parameter are reported. In the generator fakes the last param
(`budget`) is used, so the leading unused params are never reported. In `simulate` only the
first param (`rtl`) was used, so the trailing `_testbench`/`_limits` were flagged. The
`^_` argsIgnorePattern did not save them - after-used reporting takes precedence for that case.

# Fix / rule

A class method implementing a TS interface may declare FEWER parameters than the interface
(a narrower function is assignable). When a fake only needs the leading params, drop the
trailing ones entirely: `simulate(rtl: readonly SourceFile[]): Promise<SimulationVerdict>`.
This is cleaner than `// eslint-disable` and avoids the after-used trap. Reserve underscore
prefixing for unused params that must sit BEFORE a used one.

# Links

- app/agent/orchestrator/self-healing.test.ts (ScriptedSimulator)
- app/tools/simulator/adapter.ts (SimulatorAdapter interface)
