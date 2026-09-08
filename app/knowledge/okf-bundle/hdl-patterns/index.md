---
type: moc
title: HDL patterns - map of content
tags: [hdl, patterns, verilog]
status: trusted
provenance: founding seed (task 10.1)
timestamp: 2026-07-05T00:00:00Z
---

# HDL patterns

Standard-block Verilog coding idioms the M1 single-module hero loop relies on.
Each note is a `candidate` hint: it improves the proposal, but the deterministic oracle plus an independently derived testbench still decide correctness, and none of these idioms has been through our eval gate yet.

## Concepts
- [[hdl-patterns/reset-conventions|Reset conventions (synchronous vs asynchronous)]]
- [[hdl-patterns/synchronous-counter|Synchronous counter (up, with reset and enable)]]
- [[hdl-patterns/finite-state-machine|Finite state machine (two-block Moore FSM)]]

## Covered inline
Blocking vs non-blocking assignment, avoiding inferred latches and combinational loops, and parameterized widths are documented as pitfalls and recipes inside the notes above (the counter carries the width parameter and non-blocking rule, the FSM carries the latch-avoiding default-assignment rule, and reset conventions carry the sensitivity-list rule).
