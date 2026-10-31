---
type: verification-recipe
title: Boundary, error, and known-answer checks
tags: [verification, testbench, boundary, known-answer]
status: candidate
provenance: authored for the M1 OKF seed; standard verification practice, not yet eval-gated in this vault
timestamp: 2026-07-05T00:00:00Z
verifiedBy:
---

# What this verifies

This recipe lists the stimulus classes a spec-derived testbench should cover beyond the nominal case, so the oracle exercises the edges where synchronous designs actually break.
It is a hint for the Testbench_Agent; the Simulator still decides each check.

# Independent oracle (never the model)

Expected values for every boundary and known-answer check are computed from the Spec or from a documented reference behavior, never from the generated RTL.

# Steps

Cover, where the Spec defines or implies them:

- Reset behavior: assert reset, then confirm every output reaches its defined reset value before any functional stimulus.
- Boundary values: the minimum and maximum of each input range, and the wrap or saturation point of any counter or accumulator (for example `2**WIDTH - 1` then the next increment).
- Off-by-one edges: the first and last valid index, address, or count, not just a middle value.
- Error and invalid inputs: inputs the Spec calls illegal or out of range, checking the defined response rather than leaving behavior unobserved.
- Known-answer anchors: where the Spec names a standard block with a known reference (a counter sequence, a parity or CRC value, a fixed truth table), check a handful of precomputed input/output pairs from that reference.
- Timing edges: behavior across a clock edge and, for synchronous reset, that reset only takes effect on the active edge.

Each of these is reported as its own check, with a distinct, stable name, by the mechanism in [[check-line-signalling]].

# Anti-circularity note

Known-answer values come from the reference behavior in the Spec or a cited source, not from running the design under test.
This is what lets a known-answer check catch an implementation that is internally consistent but wrong.

# Pitfalls

- Testing only nominal inputs lets saturation, wrap, and reset bugs pass unseen.
- Reusing one generic check name for several distinct checks collapses them in the trace and hides which edge failed; give each a unique name.

# Links

- Per-check signalling contract (authority): [[check-line-signalling]]
- Self-checking structure: [[self-checking-testbench]]
- Counter wrap behavior: [[synchronous-counter]]
- FSM checks: [[finite-state-machine]]
