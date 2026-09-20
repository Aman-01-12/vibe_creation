// instrument-precheck-and-attribution, task 3.4: unit tests for the measured
// testbench cases.
//
// The property test (task 3.3, `testbench-precheck-decision-table.property.test.ts`)
// states the decision table over a synthetic verdict space with a `FixedSimulator`.
// This file is its real-toolchain, non-vacuous counterpart: it runs `TestbenchPrecheck`
// against the ACTUAL Icarus toolchain over testbenches that are themselves measured
// artifacts, not hand-written fixtures, following the dual real/fake trajectory
// pattern (`real-oracle-integration-dual-trajectory-pattern`).
//
// The two refused cases are the exact defect `gotcha-tbslice-v1-testbench-generator-
// is-the-bottleneck-1-of-12.md` diagnosed: `adder_8bit` and `multi_booth_8bit` both
// declare a variable (`integer pass_count;` / `reg counter_pass;`) INSIDE an `initial
// begin ... end` block after an executable statement has already run - legal in
// SystemVerilog, illegal in the Verilog-2001 dialect Icarus compiles. The testbench
// text below is copied verbatim from the persisted tbslice-v1 campaign artifacts
// (`.eval-runs/tbslice-v1/artifacts/kimi-k2_5/.../sample-0/testbench.v`), which is
// also where `control-stderr.txt` recorded the exact `testbench.v:49`/`:177` syntax
// errors this precheck now catches before any repair iteration is spent.
//
// The `adder_16bit` case is the non-vacuity anchor in the OTHER direction: its
// measured testbench (same campaign, `outcomeStatus: "verified"`) builds clean
// against its own Spec-derived stub - the decision table's `undecided` row, no
// build failure ever attributed to the testbench, never `testbench-build-failed`
// - and is then refused against a MUTATED stub with one port removed, proving
// the gate is not merely "always refuses" or "never refuses" but actually keyed
// to whether the stub can satisfy the testbench's port connections (mirroring
// the stub-vs-mutated-stub measurement in `gotcha-precompiling-a-testbench-
// needs-a-spec-derived-stub-...md`). `built` is a `PrecheckOutcome` member the
// current decision table never actually returns (design.md's table has exactly
// three outcomes: `testbench-build-failed` and two rows that both read
// `undecided`) - the passive, behaviourless stub (Req 1.3) can never make a
// testbench's functional checks literally PASS, so "the stub cannot influence
// which testbench is a sound measuring stick" is asserted here as the absence
// of a testbench-attributed build failure, not as a functional pass.
//
// This file also fixes a defect `buildInterfaceStub` had before this task: its
// non-ANSI port declarations (`reg [7:0] a;` alone, no `input`/`output`
// keyword) are not legal Verilog-2001 - Icarus refuses EVERY stub it built with
// "Port ... has no direction declaration", for any interface, which is exactly
// why this real-toolchain test is what caught it and the mock-backed property
// test (task 3.3) could not.
//
// Validates: Requirements 1.8, 1.9

import { describe, expect, it } from 'vitest';

import { buildInterfaceStub, TestbenchPrecheck } from '@app/agent';
import { makePort, type ModuleInterface, type Port } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[testbench-precheck-measured-cases.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'The measured-defect refusal and non-vacuous stub-mutation assertions are SKIPPED in this environment.',
  );
}

/** Generous real-run caps: local process startup plus a real iverilog+vvp run. */
const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** Build a `Port`, failing the test loudly rather than silently on a bad fixture. */
function port(input: {
  readonly name: string;
  readonly direction: Port['direction'];
  readonly width: number;
}): Port {
  const result = makePort(input);
  if (!result.ok) {
    throw new Error(`fixture declared an invalid port: ${result.error.code}`);
  }
  return result.value;
}

// -- Measured testbench 1: rtllm/arithmetic/adder_8bit, sample-0 -------------
//
// `integer pass_count; integer total_tests;` at (original) lines 49-50, after
// `$dumpfile`/`$dumpvars` already executed inside the same `initial begin` block.
// Verbatim from the persisted artifact; only the leading blank line is trimmed.

const ADDER_8BIT_INTERFACE: ModuleInterface = {
  moduleName: 'adder_8bit',
  ports: [
    port({ name: 'a', direction: 'input', width: 8 }),
    port({ name: 'b', direction: 'input', width: 8 }),
    port({ name: 'cin', direction: 'input', width: 1 }),
    port({ name: 'sum', direction: 'output', width: 8 }),
    port({ name: 'cout', direction: 'output', width: 1 }),
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
};

const ADDER_8BIT_TESTBENCH: SourceFile = {
  path: 'adder_8bit_tb.v',
  contents: `\`timescale 1ns/1ps

module tb;
  // Inputs
  reg [7:0] a;
  reg [7:0] b;
  reg cin;

  // Outputs
  wire [7:0] sum;
  wire cout;

  // Expected values
  reg [8:0] expected_full_sum;
  reg [7:0] expected_sum;
  reg expected_cout;

  // Instantiate the Unit Under Test (UUT)
  adder_8bit uut (
    .a(a),
    .b(b),
    .cin(cin),
    .sum(sum),
    .cout(cout)
  );

  // Task to check result
  task check_result;
    input [7:0] a_val;
    input [7:0] b_val;
    input cin_val;
    begin
      expected_full_sum = {1'b0, a_val} + {1'b0, b_val} + {8'b0, cin_val};
      expected_sum = expected_full_sum[7:0];
      expected_cout = expected_full_sum[8];

      if (sum !== expected_sum || cout !== expected_cout) begin
        $display("CHECK ac1_under_simulation_adder_8bit_produces_the FAIL: a=%h b=%h cin=%b, expected sum=%h cout=%b, got sum=%h cout=%b",
                 a_val, b_val, cin_val, expected_sum, expected_cout, sum, cout);
      end
    end
  endtask

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Test case counter and pass flag
    integer pass_count;
    integer total_tests;
    pass_count = 0;
    total_tests = 0;

    // Test 1: Basic addition without carry in
    a = 8'h00; b = 8'h00; cin = 0;
    #1; check_result(a, b, cin); total_tests = total_tests + 1;
    if (sum === expected_sum && cout === expected_cout) pass_count = pass_count + 1;

    // Final verdict
    if (pass_count == total_tests) begin
      $display("CHECK ac1_under_simulation_adder_8bit_produces_the PASS");
    end else begin
      $display("CHECK ac1_under_simulation_adder_8bit_produces_the FAIL: %0d/%0d tests passed", pass_count, total_tests);
    end

    $finish;
  end

endmodule
`,
};

// -- Measured testbench 2: rtllm/arithmetic/multi_booth_8bit, sample-0 -------
//
// `reg counter_pass; integer cycle_count; ...` at (original) lines 177-184, all
// declared inside the same top-level `initial begin` block AFTER the first `CHECK`
// stimulus phase has already executed statements. Verbatim from the persisted
// artifact, trimmed to the minimum prefix that still reproduces the mid-block
// declaration (the full 15-case stimulus phase is not needed to trigger the
// parse error; the declarations themselves are what Icarus refuses).

const MULTI_BOOTH_8BIT_INTERFACE: ModuleInterface = {
  moduleName: 'multi_booth_8bit',
  ports: [
    port({ name: 'a', direction: 'input', width: 8 }),
    port({ name: 'b', direction: 'input', width: 8 }),
    port({ name: 'p', direction: 'output', width: 16 }),
    port({ name: 'rdy', direction: 'output', width: 1 }),
  ],
  clocking: { clockName: 'clk', resetName: 'reset', resetActiveLow: false },
};

const MULTI_BOOTH_8BIT_TESTBENCH: SourceFile = {
  path: 'multi_booth_8bit_tb.v',
  contents: `module tb_multi_booth_8bit;

  // Clock and reset
  reg clk = 0;
  reg reset;

  // Inputs
  reg [7:0] a;
  reg [7:0] b;

  // Outputs
  wire [15:0] p;
  wire rdy;

  // Instantiate the DUT
  multi_booth_8bit dut (
    .clk(clk),
    .reset(reset),
    .a(a),
    .b(b),
    .p(p),
    .rdy(rdy)
  );

  // Clock generation: 10ns period
  always #5 clk = ~clk;

  // Main test sequence
  initial begin
    reg pass;
    reg all_pass;
    integer i;

    $dumpfile("dump.vcd");
    $dumpvars(0, tb_multi_booth_8bit);

    all_pass = 1'b1;

    // Initialize inputs
    a = 8'h00;
    b = 8'h00;

    // Apply reset
    reset = 1'b1;
    repeat(2) @(posedge clk);
    @(negedge clk);
    reset = 1'b0;
    @(posedge clk);

    // Print result for ac1
    if (all_pass)
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc PASS");
    else
      $display("CHECK ac1_under_simulation_multi_booth_8bit_produc FAIL");

    // ============================================
    // CHECK known_answer_counter_increments
    // Verify the internal counter behavior through rdy timing
    // ============================================

    reg counter_pass;
    integer cycle_count;
    reg [15:0] prev_p;
    reg prev_rdy;
    integer rdy_rise_cycle;
    integer rdy_fall_cycle;
    integer test_num;
    reg [15:0] expected_prod;

    counter_pass = 1'b1;

    if (counter_pass)
      $display("CHECK known_answer_counter_increments PASS");
    else
      $display("CHECK known_answer_counter_increments FAIL");

    $finish;
  end

endmodule
`,
};

// -- Measured testbench 3: rtllm/arithmetic/adder_16bit, sample-0 ------------
//
// The clean counterpart: `outcomeStatus: "verified"` on the same campaign. No
// mid-block declaration, no coverage gap - it built and passed against the real
// reference design. Trimmed to two of its twenty stimulus cases; the precheck
// only needs the stub to elaborate against the port list, so the remaining
// cases add real-toolchain runtime without adding coverage of this decision.

const ADDER_16BIT_INTERFACE: ModuleInterface = {
  moduleName: 'adder_16bit',
  ports: [
    port({ name: 'a', direction: 'input', width: 16 }),
    port({ name: 'b', direction: 'input', width: 16 }),
    port({ name: 'Cin', direction: 'input', width: 1 }),
    port({ name: 'y', direction: 'output', width: 16 }),
    port({ name: 'Co', direction: 'output', width: 1 }),
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
};

const ADDER_16BIT_TESTBENCH: SourceFile = {
  path: 'adder_16bit_tb.v',
  contents: `module tb;
  // Inputs
  reg [15:0] a;
  reg [15:0] b;
  reg Cin;

  // Outputs
  wire [15:0] y;
  wire Co;

  // Expected values
  reg [16:0] expected_full_sum;
  reg [15:0] expected_y;
  reg expected_Co;

  // Instantiate the Unit Under Test (UUT)
  adder_16bit uut (
    .a(a),
    .b(b),
    .Cin(Cin),
    .y(y),
    .Co(Co)
  );

  // VCD dumping
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
  end

  // Test stimulus
  initial begin
    // Test 1: Basic addition with non-zero, non-equal values
    a = 16'h1234;
    b = 16'h5678;
    Cin = 1'b0;
    #1;
    expected_full_sum = {1'b0, 16'h1234} + {1'b0, 16'h5678} + 1'b0;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    if (y === expected_y && Co === expected_Co)
      $display("CHECK ac1_under_simulation_adder_16bit_produces_th PASS");
    else
      $display("CHECK ac1_under_simulation_adder_16bit_produces_th FAIL: expected y=%h, Co=%b, got y=%h, Co=%b", expected_y, expected_Co, y, Co);

    // Test 2: Addition with Cin = 1
    a = 16'h1234;
    b = 16'h5678;
    Cin = 1'b1;
    #1;
    expected_full_sum = {1'b0, 16'h1234} + {1'b0, 16'h5678} + 1'b1;
    expected_y = expected_full_sum[15:0];
    expected_Co = expected_full_sum[16];
    if (y === expected_y && Co === expected_Co)
      $display("CHECK ac1_under_simulation_adder_16bit_produces_th PASS");
    else
      $display("CHECK ac1_under_simulation_adder_16bit_produces_th FAIL: expected y=%h, Co=%b, got y=%h, Co=%b", expected_y, expected_Co, y, Co);

    $finish;
  end
endmodule
`,
};

/** `ADDER_16BIT_INTERFACE` with its `Co` output port removed - the mutation the
 *  stub-gate measurement note used to prove the check is non-vacuous in the
 *  true-negative direction: the testbench connects `.Co(Co)`, which a stub
 *  missing that port cannot satisfy. */
const ADDER_16BIT_INTERFACE_MISSING_CO: ModuleInterface = {
  ...ADDER_16BIT_INTERFACE,
  ports: ADDER_16BIT_INTERFACE.ports.filter((declared) => declared.name !== 'Co'),
};

describe.skipIf(!PROBE.available)(
  'Testbench_Precheck over measured tbslice-v1 testbench artifacts (Req 1.8, 1.9)',
  () => {
    it('refuses the real adder_8bit testbench: a mid-block declaration Icarus cannot parse', async () => {
      const precheck = new TestbenchPrecheck(realOracleAdapter());
      const outcome = await precheck.run(ADDER_8BIT_TESTBENCH, ADDER_8BIT_INTERFACE, REAL_LIMITS);
      expect(outcome).toBe('testbench-build-failed');
    }, 60_000);

    it('refuses the real multi_booth_8bit testbench: the same mid-block declaration defect', async () => {
      const precheck = new TestbenchPrecheck(realOracleAdapter());
      const outcome = await precheck.run(
        MULTI_BOOTH_8BIT_TESTBENCH,
        MULTI_BOOTH_8BIT_INTERFACE,
        REAL_LIMITS,
      );
      expect(outcome).toBe('testbench-build-failed');
    }, 60_000);

    it('builds clean: the real adder_16bit testbench against its own Spec-derived stub', async () => {
      // "Builds clean" means the design's own decision table (design.md, the
      // precheck's four-row table): no build failure is ever attributed to the
      // Testbench, so the precheck proceeds. The stub is a PASSIVE DUT stand-in
      // with no behaviour (Req 1.3), so it can never make the testbench's
      // functional checks literally pass - only the ABSENCE of a testbench-
      // attributed build failure is asserted here, exactly what `undecided`
      // means for this row (never `testbench-build-failed`, the one refusing row).
      const precheck = new TestbenchPrecheck(realOracleAdapter());
      const outcome = await precheck.run(ADDER_16BIT_TESTBENCH, ADDER_16BIT_INTERFACE, REAL_LIMITS);
      expect(outcome).toBe('undecided');
    }, 60_000);

    it('refuses the SAME adder_16bit testbench against a stub with one port removed (non-vacuity)', async () => {
      // Proves the `undecided` result above is not vacuous - the gate is keyed
      // to whether the stub can actually satisfy the testbench's port
      // connections, not to the testbench alone. `buildInterfaceStub` is
      // exercised directly here only to document the mutation; `precheck.run`
      // derives its own stub from `ADDER_16BIT_INTERFACE_MISSING_CO` internally.
      const mutatedStub = buildInterfaceStub(ADDER_16BIT_INTERFACE_MISSING_CO);
      expect(mutatedStub.contents).not.toContain(' Co;');

      const precheck = new TestbenchPrecheck(realOracleAdapter());
      const outcome = await precheck.run(
        ADDER_16BIT_TESTBENCH,
        ADDER_16BIT_INTERFACE_MISSING_CO,
        REAL_LIMITS,
      );
      expect(outcome).toBe('testbench-build-failed');
    }, 60_000);
  },
);
