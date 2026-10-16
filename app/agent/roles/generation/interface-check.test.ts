// Unit tests for the interface-exactness core (task 13.1).
//
// These are example-based tests over the pure parser and comparator that the
// numbered Property 17 (task 13.2) will state over: the interface is derived from
// the RTL itself, and a candidate matches only when its module name, port set
// (including the clock/reset contract), directions, and widths agree with the Spec
// exactly - no missing ports (Req 6.1) and no extra ports (Req 6.4).

import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';

import { checkInterfaceExact, parseModuleInterface } from './interface-check.js';

/** A Spec interface for a byte register: two data ports plus a clock/reset contract. */
const REGISTER_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'byte_reg',
  ports: [
    { name: 'd', direction: 'input', width: 8 },
    { name: 'q', direction: 'output', width: 8 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
};

/** RTL whose ANSI header matches REGISTER_INTERFACE exactly. */
const MATCHING_RTL = [
  'module byte_reg (',
  '  input  wire        clk,',
  '  input  wire        rst_n,',
  '  input  wire [7:0]  d,',
  '  output reg  [7:0]  q',
  ');',
  '  always @(posedge clk) q <= d;',
  'endmodule',
].join('\n');

describe('parseModuleInterface', () => {
  it('extracts the module name and ANSI port list with directions and widths', () => {
    const parsed = parseModuleInterface(MATCHING_RTL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.moduleName).toBe('byte_reg');
    expect(parsed.value.ports).toEqual([
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'rst_n', direction: 'input', width: 1 },
      { name: 'd', direction: 'input', width: 8 },
      { name: 'q', direction: 'output', width: 8 },
    ]);
  });

  it('carries direction and width across comma continuations', () => {
    const rtl = 'module m (\n  input [3:0] a, b,\n  output c\n);\nendmodule';
    const parsed = parseModuleInterface(rtl);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.ports).toEqual([
      { name: 'a', direction: 'input', width: 4 },
      { name: 'b', direction: 'input', width: 4 },
      { name: 'c', direction: 'output', width: 1 },
    ]);
  });

  it('ignores line and block comments in the header', () => {
    const rtl = 'module m ( // ports\n  input a, /* the input */ output b\n);\nendmodule';
    const parsed = parseModuleInterface(rtl);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.ports).toEqual([
      { name: 'a', direction: 'input', width: 1 },
      { name: 'b', direction: 'output', width: 1 },
    ]);
  });

  it('tolerates a parameter list before the port list', () => {
    const rtl = 'module m #(parameter W = 8) (\n  input [7:0] a\n);\nendmodule';
    const parsed = parseModuleInterface(rtl);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.moduleName).toBe('m');
    expect(parsed.value.ports).toEqual([{ name: 'a', direction: 'input', width: 8 }]);
  });

  it('fails closed when no module declaration is present', () => {
    const parsed = parseModuleInterface('// just a comment, no module');
    expect(parsed.ok).toBe(false);
  });
});

describe('checkInterfaceExact', () => {
  it('matches when the RTL implements the Spec interface (including clock/reset) exactly', () => {
    const parsed = parseModuleInterface(MATCHING_RTL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const match = checkInterfaceExact(REGISTER_INTERFACE, parsed.value);
    expect(match.matches).toBe(true);
    expect(match.missingPorts).toEqual([]);
    expect(match.extraPorts).toEqual([]);
    expect(match.mismatchedPorts).toEqual([]);
  });

  it('flags a port that is absent from the generated module (Req 6.1)', () => {
    const rtl =
      'module byte_reg (\n  input wire clk,\n  input wire rst_n,\n  output reg [7:0] q\n);\nendmodule';
    const parsed = parseModuleInterface(rtl);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const match = checkInterfaceExact(REGISTER_INTERFACE, parsed.value);
    expect(match.matches).toBe(false);
    expect(match.missingPorts.map((p) => p.name)).toEqual(['d']);
    expect(match.extraPorts).toEqual([]);
  });

  it('flags a port that is not declared in the Spec (Req 6.4)', () => {
    const rtl = [
      'module byte_reg (',
      '  input wire clk,',
      '  input wire rst_n,',
      '  input wire [7:0] d,',
      '  input wire en,',
      '  output reg [7:0] q',
      ');',
      'endmodule',
    ].join('\n');
    const parsed = parseModuleInterface(rtl);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const match = checkInterfaceExact(REGISTER_INTERFACE, parsed.value);
    expect(match.matches).toBe(false);
    expect(match.extraPorts.map((p) => p.name)).toEqual(['en']);
    expect(match.missingPorts).toEqual([]);
  });

  it('flags a port whose width diverges from the Spec', () => {
    const rtl = [
      'module byte_reg (',
      '  input wire clk,',
      '  input wire rst_n,',
      '  input wire [3:0] d,',
      '  output reg [7:0] q',
      ');',
      'endmodule',
    ].join('\n');
    const parsed = parseModuleInterface(rtl);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const match = checkInterfaceExact(REGISTER_INTERFACE, parsed.value);
    expect(match.matches).toBe(false);
    expect(match.mismatchedPorts).toEqual([
      {
        name: 'd',
        expected: { direction: 'input', width: 8 },
        actual: { direction: 'input', width: 4 },
      },
    ]);
  });

  it('flags a wrong module name', () => {
    const rtl = MATCHING_RTL.replace('byte_reg', 'wrong_name');
    const parsed = parseModuleInterface(rtl);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const match = checkInterfaceExact(REGISTER_INTERFACE, parsed.value);
    expect(match.matches).toBe(false);
    expect(match.moduleNameMatches).toBe(false);
  });
});
