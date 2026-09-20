---
type: decision
title: Widen a refusal-or-null admission gate to a result object when a repair can swap the artifact being checked
status: candidate
provenance: testbench-repair-loop spec, task 6.4 (VerificationLoop#admitInstrument precheck-path repair wiring)
tags: [hdl, verification, verification-loop, repair-loop, typescript]
timestamp: 2025-06-17T20:10:00Z
verifiedBy: 
---

# Decision

`VerificationLoop#admitInstrument` previously returned `{ reason; attributedFiles } | null`
(refusal-or-proceed). Wiring in a precheck-path repair (task 6.4) needed to express a THIRD
outcome that plain refusal-or-null cannot: "proceed, but with a DIFFERENT testbench than the
one setup produced." Rather than adding a second, separately-threaded return value (which risks
desync - e.g. a caller reads the repaired-testbench flag but forgets to also read the new
refusal-or-null), the return type was widened to one object:

```ts
interface InstrumentAdmissionResult {
  readonly refusal: { reason: InstrumentRefusalReason; attributedFiles: readonly string[] } | null;
  readonly repairProvenance: RepairProvenance;
  readonly revisedTestbench?: { testbench: Testbench; testbenchFile: SourceFile };
}
```

The caller (`#iterate`) reassigns its `testbench`/`testbenchFile` locals from `const` to `let`
and swaps them in when `revisedTestbench` is present, before falling through to the rest of its
existing logic unchanged.

# Rationale

- One object, not two parallel return channels: `refusal`, `repairProvenance`, and
  `revisedTestbench` are read together at exactly one call site, so bundling them removes any
  chance of reading one without the other.
- `revisedTestbench` is optional and present ONLY when `repairProvenance.accepted` is `true`,
  making the "a repair changed what happens next" case structurally distinct from a plain
  refusal or a plain pass-through, rather than inferred from a boolean flag elsewhere.
- The unrepaired refusal shape is IDENTICAL on every declining path (re-check still fails,
  `coverage-incomplete`/`generation-failed`, or a thrown `repairTestbench`) - this was
  deliberately isolated into a single `unrepairedRefusal` value reused by every early-return in
  the new `#repairPrecheckFailure` helper, so "what an unrepaired failure looks like" has one
  definition, not four near-identical object literals that could drift.

# When to use

Any time an existing binary gate (refuse | proceed) needs a third branch that changes WHICH
downstream artifact the rest of the pipeline continues with - not just whether it proceeds.
Reach for a named result object over a second out-parameter or a mutated-in-place side effect.

# Links

- `app/agent/orchestrator/verification-loop.ts` (`InstrumentAdmissionResult`, `#admitInstrument`, `#repairPrecheckFailure`)
- `.kiro/specs/testbench-repair-loop/design.md`, "#admitInstrument wiring" and "The precheck-path sequence"
