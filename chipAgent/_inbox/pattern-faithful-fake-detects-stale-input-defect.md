---
type: pattern
title: Faithful fake derives its output from its input to detect stale-input defects (spec-consistent re-verification)
status: candidate
provenance: task 16.3 (Property 21, spec-consistent re-verification), app/test/iteration-spec-consistent-reverify.property.test.ts
tags: [testing, property-based, fast-check, agent, iteration, anti-circular]
timestamp: 2025
verifiedBy: "npx tsc -b app/test --force; npx eslint <file> --max-warnings=0; npx vitest run <file> (1 passed, 100 runs)"
---

# Pattern

To prove a component passes the CURRENT (not a stale) value to a collaborator, make the collaborator fake DERIVE its returned artifact from the exact input it receives, then assert the artifact carries the current input's discriminator.
For Property 21, the `IterationReVerifier` fake builds its `Testbench` from `input.spec` (stamping `specId`/`specVersion`), and the current vs updated Spec differ by a bumped `version`.
If the Iteration_Agent had forwarded the stale `currentSpec`, the produced testbench would carry the old version and the assertion `testbench.specVersion === updatedSpec.version` fails loudly.
A capturing fake that just records the arg and returns a canned value would NOT catch a downstream re-derivation using the wrong version; deriving the output from the input does.

# When to use

Any property where "operates on the latest/updated X, never a stale copy" is the guarantee (spec-consistency, cache invalidation, config reload, version pinning).
Give the generated updated value a cheap unique discriminator (a bumped integer version) so current vs updated are always distinguishable even when other fields coincide.

# Recipe / example

- Independent interface-change oracle: script the Spec updater to either reuse the same `moduleInterface` reference (byte-identical -> no change) or rename the module (always different), so the expected `interfaceChanged` is a per-scenario boolean flag, not a call to the `interfaceChangedBetween` under test. Cross-check the helper against the flag for non-vacuity.
- Always bump `updatedSpec.version = currentSpec.version + 1` so `testbench.specVersion !== currentSpec.version` is a discriminating assertion.
- Assert the collaborator input shape has no partial-run channel: `Object.keys(reVerifyInput).sort()` equals `['intent','spec']` (structural "full testbench always" guarantee).
- Drive the streaming `run` generator, collect `phase`s, and assert `regenerating-testbench` appears IFF the interface changed and sits between `updating-spec` and `verifying`.

# Pitfalls

- A pure capturing fake (record-and-return-canned) is blind to a defect where the consumer re-derives from the wrong captured field; derive the return value from the input instead.
- Deriving expectations by calling the same helper the code uses is circular; use an independently constructed flag and cross-check the helper separately.

# Links

- app/test/iteration-spec-consistent-reverify.property.test.ts
- app/agent/roles/iteration/{iteration-agent,types,diff}.ts
- .kiro/specs/hdl-creation-loop/design.md (Property 21)
