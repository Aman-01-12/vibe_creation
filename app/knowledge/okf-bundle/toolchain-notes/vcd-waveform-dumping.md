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
The testbench requests the dump with `$dumpfile` and `$dumpvars`.
This note is a hint; the VCD is a visualization artifact and is never itself the correctness verdict.

# Details

Add to the testbench, typically at the start of the initial block:

```verilog
initial begin
  $dumpfile("dump.vcd");   // artifact name the sandbox expects to capture
  $dumpvars(0, tb);        // level 0 = dump tb and everything below it recursively
  // ... stimulus and CHECK lines ...
  $finish;
end
```

- `$dumpfile("<name>.vcd")` names the output file; the sandbox job lists this as a required output and classifies the run `error` if it cannot be captured (capture-all-or-error).
- `$dumpvars(level, scope)` selects what to record.
  Level `0` dumps the given scope and all nested scopes; a positive level limits depth.
- Passing the testbench top (for example `tb`) as the scope captures the DUT as well, since it is instantiated inside the testbench.
- The VCD is downstream of the run; the Waveform_Viewer renders it via a VCD-to-WaveJSON adapter, and its Trust_Tier follows the source artifact it depicts.

Common gotchas:

- Forgetting `$dumpfile`/`$dumpvars` produces no VCD; if the job requires the artifact, the run is `error` rather than a silent pass.
- Dumping a very large hierarchy every timestep bloats the file; scope the dump to what the waveform needs.
- VCD is for visualization, not verification; a rendered waveform is not proof, the recorded `CHECK` results are.

# Citations

- Waveform rendering decision (WaveDrom, VCD-to-WaveJSON): `.kiro/specs/hdl-creation-loop/design.md` (OD-5)
- Capture-all-or-error rule: `.kiro/specs/hdl-creation-loop/design.md` (Tool_Runner sandbox design)
