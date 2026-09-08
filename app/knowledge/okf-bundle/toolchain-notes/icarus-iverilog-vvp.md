---
type: domain-note
title: Icarus Verilog toolchain (iverilog + vvp)
tags: [toolchain, icarus, iverilog, vvp, simulation]
status: candidate
provenance: authored for the M1 OKF seed; standard Icarus usage, exercised by our sandbox but not yet eval-gated in this vault
timestamp: 2026-07-05T00:00:00Z
validUntil:
verifiedBy:
---

# Concept

Icarus Verilog is the deterministic simulation oracle for this slice.
`iverilog` compiles the RTL plus the testbench into a simulation binary, and `vvp` runs it.
This note is a hint about how the toolchain behaves; the recorded oracle verdict, not this note, decides correctness.

# Details

Two-step flow the sandbox worker runs:

```
iverilog -o sim.vvp design.v tb.v
vvp sim.vvp
```

- `iverilog -o <out>` compiles the listed sources into an output the runtime executes.
  A compile error here is a compile failure the Generation_Agent reads and repairs (Req 6.3).
- `vvp <out>` runs the compiled simulation; its standard output carries the `CHECK` lines the adapter parses (see [[check-line-signalling]]).
- The testbench module is the top of the simulation; it instantiates the design under test.
- Reproducibility: the digital designs in scope are deterministic and seed-free, so the same sources produce the same verdict on every run.

Common gotchas:

- A missing source file or a module name that does not match its instantiation is a compile error, not a functional fail; the two are classified differently.
- `iverilog` defaults to an older Verilog standard; select the standard explicitly (for example `-g2012`) when the design uses SystemVerilog-2012 constructs, or keep the RTL within plain Verilog-2005.
- A simulation with no `$finish` can run until the sandbox wall-clock cap and be classified `error`; the testbench must finish itself.
- Toolchain flag behavior can change across Icarus versions; treat version-specific flags as time-sensitive and set `validUntil` when a note pins a version.

# Anti-circularity and trust note

The simulator is the oracle for compile and functional correctness, but only through an independently derived testbench.
Retrieved toolchain knowledge improves the proposal and never overrides the recorded Simulator verdict or changes a Trust_Tier.

# Citations

- Project oracle path: `app/tools/simulator/adapter.ts`, `app/tools/simulator/check-signalling.ts`
- Real oracle-path integration test: `app/test/icarus-oracle.integration.test.ts`
