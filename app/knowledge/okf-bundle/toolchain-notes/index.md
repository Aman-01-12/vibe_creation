---
type: moc
title: Toolchain notes - map of content
tags: [toolchain, iverilog, vcd]
status: trusted
provenance: founding seed (task 10.1)
timestamp: 2026-07-05T00:00:00Z
---

# Toolchain notes

Open-source simulation toolchain basics for the M1 loop: Icarus Verilog (`iverilog` + `vvp`) as the backend oracle and VCD waveform dumping.
Both notes are `candidate` hints; the recorded oracle verdict, not these notes, decides correctness.
Tool invocation details can drift across versions, so version-specific facts should carry a `validUntil` when a note pins a version.

## Concepts
- [[toolchain-notes/icarus-iverilog-vvp|Icarus Verilog toolchain (iverilog + vvp)]]
- [[toolchain-notes/vcd-waveform-dumping|VCD waveform dumping ($dumpfile / $dumpvars)]]
