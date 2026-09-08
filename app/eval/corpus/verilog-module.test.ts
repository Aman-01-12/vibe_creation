// Unit tests for the reference-RTL module-declaration parser.
//
// Fixtures are reduced but STRUCTURALLY FAITHFUL excerpts of the declaration styles
// RTLLM actually uses at the pinned commit - ANSI headers, Verilog-1995 non-ANSI
// bodies, parameterized ranges, multi-name declarations, comment-laden headers, and a
// multi-module file whose top is not first. Using fixtures rather than the checkout is
// deliberate: these tests must run with no network fetch and no toolchain.

import { describe, expect, it } from 'vitest';

import {
  listDeclaredModuleNames,
  parseDeclaredModule,
  stripVerilogNoise,
  type DeclaredPort,
} from './verilog-module.js';

/** Parse a module, failing the test if it did not parse. */
function ports(source: string, moduleName: string): readonly DeclaredPort[] {
  const result = parseDeclaredModule(source, moduleName);
  if (!result.ok) {
    throw new Error(`expected "${moduleName}" to parse but got: ${result.reason}`);
  }
  return result.module.ports;
}

/** The refusal reason, failing the test if the module parsed. */
function reason(source: string, moduleName: string): string {
  const result = parseDeclaredModule(source, moduleName);
  if (result.ok) {
    throw new Error(`expected "${moduleName}" to be refused but it parsed`);
  }
  return result.reason;
}

/** Render ports compactly so an expectation reads as one line. */
function signature(list: readonly DeclaredPort[]): readonly string[] {
  return list.map((port) => `${port.direction} ${port.name}[${port.width}]`);
}

// -- Fixtures ----------------------------------------------------------------

/** ANSI header with a shared range across two names (`adder_8bit` style). */
const ANSI_SHARED_RANGE = `module verified_adder_8bit(
    input [7:0] a, b,
    input cin,
    output [7:0] sum,
    output cout);
    assign {cout, sum} = a + b + cin;
endmodule
`;

/** ANSI header with wire/reg qualifiers and trailing comments (`multi_16bit` style). */
const ANSI_QUALIFIED = `module verified_multi_16bit(
    input clk,          // Chip clock signal.
    input rst_n,        // Active-low reset.
    input [15:0] ain,   // Multiplicand.
    output [31:0] yout, // Product.
    output reg done     // Completion flag.
);
endmodule
`;

/** Parameterized ANSI header whose msb is an expression (`adder_pipe_64bit` style). */
const ANSI_PARAMETERIZED = `module verified_adder_64bit
#(
    parameter DATA_WIDTH = 64,
    parameter STG_WIDTH = 16
)
(
    input clk,
    input [DATA_WIDTH-1:0] adda,
    output [DATA_WIDTH:0] result,
    output reg o_en
);
endmodule
`;

/** Verilog-1995 non-ANSI: bare header names, directions in the body (`calendar` style). */
const NON_ANSI = `module verified_calendar(CLK,RST,Hours,Mins,Secs);
input CLK,RST;
output [5:0] Hours,Mins,Secs;
reg [5:0] Hours,Mins,Secs;
endmodule
`;

/** Parameterized AND non-ANSI, with body ranges in terms of the parameter. */
const NON_ANSI_PARAMETERIZED = `module verified_multi_pipe_8bit#(
    parameter size = 8
)(
          clk,
          rst_n,
          mul_a,
          mul_en_out,
          mul_out
);
   input clk;
   input rst_n;
   input [size-1:0] mul_a;
   output reg mul_en_out;
   output reg [size*2-1:0] mul_out;
endmodule
`;

/** Descending range that does not start at 0 (`adder_32bit` style: `[32:1]`). */
const NON_ANSI_OFFSET_RANGE = `module verified_adder_32bit(A,B,S,C32);
     input [32:1] A;
     input [32:1] B;
     output [32:1] S;
     output C32;
endmodule
`;

/** Two modules where the TOP is declared second (`asyn_fifo` style). */
const SUBMODULE_FIRST = `\`timescale 1ns/1ns
/* the RAM the FIFO instantiates */
module dual_port_RAM #(parameter DEPTH = 16, parameter WIDTH = 8)
(
     input wclk,
     input [$clog2(DEPTH)-1:0] waddr,
     output reg [WIDTH-1:0] rdata
);
endmodule
module verified_asyn_fifo#(
    parameter WIDTH = 8,
    parameter DEPTH = 16
)(
    input wclk,
    input [WIDTH-1:0] wdata,
    output wire wfull
);
endmodule
`;

// -- Tests ------------------------------------------------------------------

describe('stripVerilogNoise', () => {
  it('removes line comments, block comments, and backtick directives', () => {
    const cleaned = stripVerilogNoise('`timescale 1ns/1ns\n/* block */ module m(); // trailing\n');
    expect(cleaned).not.toContain('timescale');
    expect(cleaned).not.toContain('block');
    expect(cleaned).not.toContain('trailing');
    expect(cleaned).toContain('module m()');
  });
});

describe('listDeclaredModuleNames', () => {
  it('lists every declared module in declaration order', () => {
    expect(listDeclaredModuleNames(SUBMODULE_FIRST)).toEqual([
      'dual_port_RAM',
      'verified_asyn_fifo',
    ]);
  });

  it('does not report a module named inside a comment', () => {
    expect(listDeclaredModuleNames('// module ghost();\nmodule real_one();\nendmodule\n')).toEqual([
      'real_one',
    ]);
  });
});

describe('parseDeclaredModule - ANSI headers', () => {
  it('applies a shared range to every name in one declaration', () => {
    expect(signature(ports(ANSI_SHARED_RANGE, 'verified_adder_8bit'))).toEqual([
      'input a[8]',
      'input b[8]',
      'input cin[1]',
      'output sum[8]',
      'output cout[1]',
    ]);
  });

  it('ignores wire/reg qualifiers and trailing comments', () => {
    expect(signature(ports(ANSI_QUALIFIED, 'verified_multi_16bit'))).toEqual([
      'input clk[1]',
      'input rst_n[1]',
      'input ain[16]',
      'output yout[32]',
      'output done[1]',
    ]);
  });

  it("resolves parameterized ranges from the module's own defaults", () => {
    // `[DATA_WIDTH:0]` is 65 bits, one wider than `[DATA_WIDTH-1:0]`.
    expect(signature(ports(ANSI_PARAMETERIZED, 'verified_adder_64bit'))).toEqual([
      'input clk[1]',
      'input adda[64]',
      'output result[65]',
      'output o_en[1]',
    ]);
  });
});

describe('parseDeclaredModule - Verilog-1995 non-ANSI headers', () => {
  it('takes directions and widths from the body, in header order', () => {
    expect(signature(ports(NON_ANSI, 'verified_calendar'))).toEqual([
      'input CLK[1]',
      'input RST[1]',
      'output Hours[6]',
      'output Mins[6]',
      'output Secs[6]',
    ]);
  });

  it('resolves body ranges written in terms of a header parameter', () => {
    expect(signature(ports(NON_ANSI_PARAMETERIZED, 'verified_multi_pipe_8bit'))).toEqual([
      'input clk[1]',
      'input rst_n[1]',
      'input mul_a[8]',
      'output mul_en_out[1]',
      'output mul_out[16]',
    ]);
  });

  it('computes width from a range that does not start at zero', () => {
    expect(signature(ports(NON_ANSI_OFFSET_RANGE, 'verified_adder_32bit'))).toEqual([
      'input A[32]',
      'input B[32]',
      'output S[32]',
      'output C32[1]',
    ]);
  });

  it('never mistakes a task argument for a module port', () => {
    // `input` also opens a task argument list; only header-listed names are ports.
    const withTask = `module m(a, y);
input a;
output y;
task check;
  input [7:0] not_a_port;
  begin end
endtask
endmodule
`;
    expect(signature(ports(withTask, 'm'))).toEqual(['input a[1]', 'output y[1]']);
  });
});

describe('parseDeclaredModule - selecting the right module in a multi-module file', () => {
  it('parses the named top even when a submodule is declared first', () => {
    expect(signature(ports(SUBMODULE_FIRST, 'verified_asyn_fifo'))).toEqual([
      'input wclk[1]',
      'input wdata[8]',
      'output wfull[1]',
    ]);
  });

  it('parses a submodule whose range uses $clog2 when asked for it directly', () => {
    expect(signature(ports(SUBMODULE_FIRST, 'dual_port_RAM'))).toEqual([
      'input wclk[1]',
      'input waddr[4]',
      'output rdata[8]',
    ]);
  });
});

describe('parseDeclaredModule - refusals (quarantine, never a guess)', () => {
  it('refuses a module that is not declared in the source', () => {
    expect(reason(ANSI_SHARED_RANGE, 'not_present')).toContain('no parseable declaration');
  });

  it('refuses a range that depends on an undeclared parameter', () => {
    const unresolvable = `module m(input [MISSING-1:0] a, output y);
endmodule
`;
    expect(reason(unresolvable, 'm')).toContain('unresolved parameter');
  });

  it('refuses a non-ANSI header whose port is never declared in the body', () => {
    const incomplete = `module m(a, y);
input a;
endmodule
`;
    expect(reason(incomplete, 'm')).toContain('never declared in the body');
  });

  it('refuses an ANSI list whose first entry declares no direction', () => {
    // The later `input b` makes this an ANSI list, so `[7:0] a` cannot inherit a
    // direction from anywhere and must be refused rather than assumed to be an input.
    expect(reason('module m([7:0] a, input b);\nendmodule\n', 'm')).toContain(
      'no direction keyword',
    );
  });

  it('refuses a module with an empty port list', () => {
    expect(reason('module m();\nendmodule\n', 'm')).toContain('no ports');
  });

  it('refuses oversized source rather than scanning it', () => {
    const huge = `module m(input a);\n${'// pad\n'.repeat(40_000)}endmodule\n`;
    expect(reason(huge, 'm')).toContain('maximum parseable size');
  });
});
