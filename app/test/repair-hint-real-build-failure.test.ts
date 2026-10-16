// testbench-repair-loop, task 6.8: the real measured precheck build failure, carried
// verbatim into the Repair_Hint a model actually sees.
//
// Reuses the measured `rtllm/arithmetic/adder_8bit` testbench fixture from
// testbench-precheck-measured-cases.integration.test.ts (verbatim from the persisted
// tbslice-v1 campaign artifacts): a mid-block `integer pass_count; integer total_tests;`
// declaration after an executable statement already ran, which Icarus refuses in the
// Verilog-2001 dialect it compiles. That file already proves this fixture's real-toolchain
// outcome is `testbench-build-failed`; this test proves the diagnostic the precheck derives
// from that real failure crosses verbatim into `buildRepairHint`'s output: the toolchain's
// own words reach the model unmodified, nothing added, nothing dropped.
//
// Validates: Requirement 2.1

import { describe, expect, it } from 'vitest';

import {
  buildRepairHint,
  describePrecheckDiagnostic,
  TestbenchPrecheck,
  type BuildDiagnosticHint,
} from '@app/agent';
import { makePort, type ModuleInterface, type Port } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[repair-hint-real-build-failure] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'The measured-diagnostic assertion is SKIPPED in this environment.',
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

// -- Measured testbench: rtllm/arithmetic/adder_8bit, sample-0 --------------
//
// Verbatim from the persisted tbslice-v1 campaign artifact, matching the sibling
// integration test's own `ADDER_8BIT_TESTBENCH` fixture.

const ADDER_8BIT_INTERFACE: ModuleInterface = {
  validityOutputName: null,
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

describe.skipIf(!PROBE.available)(
  'buildRepairHint carries the real precheck build-failure diagnostic verbatim (Req 2.1)',
  () => {
    it('is byte-identical to describePrecheckDiagnostic for the real adder_8bit build failure', async () => {
      const precheck = new TestbenchPrecheck(realOracleAdapter());
      const { outcome, diagnostic } = await precheck.runWithDiagnostic(
        ADDER_8BIT_TESTBENCH,
        ADDER_8BIT_INTERFACE,
        REAL_LIMITS,
      );

      // Non-vacuous: the fixture must actually reproduce the real build failure, or this
      // test is checking the hint against nothing.
      expect(outcome).toBe('testbench-build-failed');
      expect(diagnostic.noDiagnosticCaptured).toBe(false);
      expect(diagnostic.firstError).not.toBeNull();

      const rendered = describePrecheckDiagnostic(diagnostic);
      const hint = buildRepairHint({ kind: 'precheck-build-failed', diagnostic: rendered });

      // The toolchain's own words, carried byte-identically into the model-facing hint:
      // not a superstring, not a trimmed or re-serialized copy.
      expect(hint).toEqual<BuildDiagnosticHint>({ kind: 'build-diagnostic', diagnostic: rendered });
      expect(hint.diagnostic).toBe(rendered);
    }, 60_000);
  },
);
