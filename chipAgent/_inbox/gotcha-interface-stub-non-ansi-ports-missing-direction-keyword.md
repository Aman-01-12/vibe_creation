---
type: gotcha
title: buildInterfaceStub's non-ANSI ports had no direction keyword, so Icarus refused every stub it ever built
status: candidate
provenance: task 3.4 (instrument-precheck-and-attribution), caught only by the real-toolchain unit test over the measured adder_16bit testbench; the mock-backed property test (task 3.3) could not see it
tags:
  [
    testbench-precheck,
    interface-stub,
    icarus,
    verilog,
    non-ansi-ports,
    real-oracle-integration,
    app-agent,
    measured,
  ]
timestamp: 2026-09-22T00:00:00Z
verifiedBy:
---

# What happened

Task 3.4 asked for a real-toolchain unit test asserting the real `adder_16bit` testbench
(measured artifact, `.eval-runs/tbslice-v1/artifacts/kimi-k2_5/rtllm_arithmetic_adder_16bit/sample-0/testbench.v`)
builds against its own `buildInterfaceStub`-derived stub. It never did. Every stub
`buildInterfaceStub` ever produced, for any interface, failed elaboration:

```
testbench_precheck_stub.v:1: error: Port a (1) of module adder_16bit has no direction declaration.
testbench_precheck_stub.v:1: error: signal a in module tb.uut is not a port.
testbench_precheck_stub.v:1:      : Are you missing an input/output/inout declaration?
```

Reproduced by hand with the simplest possible case - a 3-port combinational stub, no
widths, no clocking - so this was never an edge case:

```verilog
module dut (clk, rst, count);
  reg clk;
  reg rst;
  wire [3:0] count;
endmodule
```

`iverilog -g2012` refuses this unconditionally. The mock-backed property tests (3.2, 3.3)
never caught it because they assert against `FixedSimulator`/string-content, never against
a real compiler - they check the STRING SHAPE `buildInterfaceStub` promises, not whether
that shape actually elaborates.

# Root cause

`declareSignal` rendered ONLY the net type (`reg`/`wire`) for each port, relying on the
module header's bare name list (`module adder_16bit (a, b, Cin, y, Co);`) to imply
direction. That is Verilog's **non-ANSI** port style, and in non-ANSI style the direction
(`input`/`output`/`inout`) MUST be declared separately from the net type - `reg foo;` alone
declares a plain variable, not a port, no matter what the header lists. Icarus's error is
exact about this: "Port ... has no direction declaration."

The design doc and the property tests both described the STRING content correctly
(`reg`/`wire`, ranges, no procedural block) but neither actually elaborated the result
through a real compiler, so the missing direction keyword was invisible until this task's
real-toolchain assertion ran.

# Fix / rule

`declareSignal` now emits TWO lines per port: the direction keyword line
(`input [15:0] a;`) and the net-type line (`reg [15:0] a;`), in that order. Confirmed by
hand that a direction line and a net-type line cannot be combined onto one non-ANSI
declaration (`input reg [15:0] a;` does not parse); two separate lines is the form Icarus
accepts.

This did NOT require touching the header line, and does not change the two locked-in
property test assertions (3.2 counts `reg|wire`-prefixed lines and expects exactly one per
port; the new direction line does not match that prefix, so the count is unchanged. 3.3
never actually elaborates a stub, so it was unaffected either way).

**Rule for anyone touching a non-ANSI Verilog port renderer**: a string-shape or mock-
backed test can never catch a missing direction declaration, because nothing in the
string's structure is wrong by that test's own criteria - it is wrong only against the
grammar a real compiler enforces. Any new "derive a stub/harness module from a port list"
renderer needs at least one real-`iverilog` assertion before it is trusted, exactly the
gap the `real-oracle-integration-dual-trajectory-pattern` exists to close.

# Links

- `app/agent/orchestrator/testbench-precheck.ts` (`declareSignal`, `buildInterfaceStub`)
- `app/test/testbench-precheck-measured-cases.integration.test.ts` (task 3.4, the test that caught this)
- `app/test/interface-stub-shape.property.test.ts` (task 3.2, confirmed unaffected)
- `app/test/testbench-precheck-decision-table.property.test.ts` (task 3.3, confirmed unaffected - and confirms `'built'` is never actually returned by the current decision table; see that file's header)
- `app/agent/roles/generation/candidate-compiler.ts` (`buildCompileHarness`, the design's named mirror - unaffected because it plays the opposite role: it is the ACTIVE module instantiating the DUT by name, not a DUT declaring its own ports, so non-ANSI direction rules never applied to it)
- [[real-oracle-integration-dual-trajectory-pattern]]
- [[gotcha-precompiling-a-testbench-needs-a-spec-derived-stub-and-stopping-early-nearly-kills-the-golden-denominator]] (the stub-vs-mutated-stub measurement this task's non-vacuity test mirrors)
