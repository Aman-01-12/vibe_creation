---
type: domain-note
title: VCD waveform dumping ($dumpfile / $dumpvars)
tags: [toolchain, vcd, waveform, icarus, simulation]
status: candidate
provenance: authored for the M1 OKF seed; standard Verilog VCD usage, not yet eval-gated in this vault
timestamp: 2026-07-05T00:00:00Z
validUntil:
verifiedBy:
---

# Concept

A value-change dump (VCD) is the timing artifact a simulation writes so the run can be rendered as a waveform in the Editor.
`$dumpfile` and `$dumpvars` request the dump.
In this product a testbench does not call them: the product-written Simulation_Harness is the sole owner of `dump.vcd`, and the Dialect_Normalizer removes a model's own dump calls before the run so the two cannot compete for the file.
This note explains what the artifact is and how to read it; it is never itself the correctness verdict.

# Details

The harness requests the dump once, at the start of its own initial block:

```verilog
initial begin
  $dumpfile("dump.vcd");   // artifact name the sandbox expects to capture
  $dumplimit(DUMP_LIMIT_BYTES);
  $dumpvars;               // every scope in the compilation, so the DUT is captured
end
```

- `$dumpfile("<name>.vcd")` names the output file; the sandbox job lists this as a required output and classifies the run `error` if it cannot be captured (capture-all-or-error).
- `$dumpvars` with no arguments selects every scope in the compilation. With arguments, `$dumpvars(level, scope)` limits it: level `0` dumps the given scope and all nested scopes, and a positive level limits depth.
- `$dumplimit(<bytes>)` bounds the file, so a hung dumping run stops writing rather than filling the workspace, and keeps running until the Watchdog ends it.
- The VCD is downstream of the run; the Waveform_Viewer renders it via a VCD-to-WaveJSON adapter, and its Trust_Tier follows the source artifact it depicts.

Common gotchas:

- A testbench that writes its own `$dumpfile` gains nothing: the call is removed before the run, and a second dump file that survived would steal the dump from the one the sandbox captures.
- Dumping a very large hierarchy every timestep bloats the file; the dump limit is what keeps that bounded here.
- VCD is for visualization, not verification; a rendered waveform is not proof, the recorded `CHECK` results are.

# Citations

- Dump and Watchdog ownership: `app/tools/simulator/simulation-harness.ts`
- Waveform rendering decision (WaveDrom, VCD-to-WaveJSON): `.kiro/specs/hdl-creation-loop/design.md` (OD-5)
- Capture-all-or-error rule: `.kiro/specs/hdl-creation-loop/design.md` (Tool_Runner sandbox design)
