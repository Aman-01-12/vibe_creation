// Pure unit tests for `yosys-portlist.ts`: the `portlist` line parser and the comparator
// against `parseDeclaredModule`'s reading (task 8.2, C7). No Yosys is spawned here - the real
// toolchain is exercised separately by `interface-parser-yosys.integration.test.ts`.

import { describe, expect, it } from 'vitest';

import type { DeclaredModule } from '@app/tools';

import {
  compareDeclaredToYosysPortlist,
  describeInterfaceMismatch,
  parsePortlistOutput,
  type YosysPortlist,
} from './yosys-portlist.js';

/** The exact text shape Yosys 0.69+post writes for `tee -q -o ports.txt portlist <top>`. */
const SAMPLE_PORTLIST_TEXT = `module sample
input [0:0] clk
input [7:0] a
output [15:0] sum
inout [0:0] bus
`;

describe('parsePortlistOutput', () => {
  it('reads the module name and every port, including an implicit 1-bit [0:0] range', () => {
    const result = parsePortlistOutput(SAMPLE_PORTLIST_TEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.portlist).toEqual<YosysPortlist>({
      moduleName: 'sample',
      ports: [
        { name: 'clk', msb: 0, lsb: 0 },
        { name: 'a', msb: 7, lsb: 0 },
        { name: 'sum', msb: 15, lsb: 0 },
        { name: 'bus', msb: 0, lsb: 0 },
      ],
    });
  });

  it('reads a module with no ports as an empty port list', () => {
    const result = parsePortlistOutput('module leaf\n');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.portlist).toEqual<YosysPortlist>({ moduleName: 'leaf', ports: [] });
  });

  it('fails closed on empty text', () => {
    const result = parsePortlistOutput('');

    expect(result).toEqual({ ok: false, reason: 'portlist output is empty' });
  });

  it('fails closed when the first line is not a "module <name>" header', () => {
    // The measured shape of a selection that matched no module (e.g. a frontend-rejected
    // design): a warning line, no `module` header, no port lines.
    const result = parsePortlistOutput('Warning: Selection "top" did not match any module.\n');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('module <name>');
  });

  it('fails closed on a line that is not a readable port declaration', () => {
    const result = parsePortlistOutput('module sample\ninput garbled line\n');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('unreadable portlist line');
  });
});

describe('compareDeclaredToYosysPortlist', () => {
  const DECLARED: DeclaredModule = {
    name: 'sample',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'a', direction: 'input', width: 8 },
      { name: 'sum', direction: 'output', width: 16 },
    ],
  };

  const AGREEING_YOSYS: YosysPortlist = {
    moduleName: 'sample',
    ports: [
      { name: 'clk', msb: 0, lsb: 0 },
      { name: 'a', msb: 7, lsb: 0 },
      { name: 'sum', msb: 15, lsb: 0 },
    ],
  };

  it('reports no mismatch when every port name and width agree', () => {
    expect(compareDeclaredToYosysPortlist(DECLARED, AGREEING_YOSYS)).toEqual([]);
  });

  it('reports a planted width disagreement, naming the port and both widths', () => {
    const narrowed: YosysPortlist = {
      moduleName: 'sample',
      // `sum` reported one bit narrower than parseDeclaredModule read: msb 14 instead of 15.
      ports: [
        AGREEING_YOSYS.ports[0] as never,
        AGREEING_YOSYS.ports[1] as never,
        { name: 'sum', msb: 14, lsb: 0 },
      ],
    };

    const mismatches = compareDeclaredToYosysPortlist(DECLARED, narrowed);

    expect(mismatches).toEqual([
      { kind: 'width-mismatch', name: 'sum', declaredWidth: 16, yosysWidth: 15 },
    ]);
    expect(describeInterfaceMismatch('sample', mismatches[0] as never)).toBe(
      'sample: port "sum" is declared width 16 but Yosys reports width 15',
    );
  });

  it('reports a planted missing port, naming the port', () => {
    const dropped: YosysPortlist = {
      moduleName: 'sample',
      ports: [AGREEING_YOSYS.ports[0] as never, AGREEING_YOSYS.ports[1] as never],
    };

    const mismatches = compareDeclaredToYosysPortlist(DECLARED, dropped);

    expect(mismatches).toEqual([{ kind: 'missing-port', name: 'sum' }]);
    expect(describeInterfaceMismatch('sample', mismatches[0] as never)).toBe(
      'sample: port "sum" is declared but Yosys reports no such port',
    );
  });

  it('reports an extra port Yosys reports that was never declared', () => {
    const extra: YosysPortlist = {
      moduleName: 'sample',
      ports: [...AGREEING_YOSYS.ports, { name: 'enable', msb: 0, lsb: 0 }],
    };

    const mismatches = compareDeclaredToYosysPortlist(DECLARED, extra);

    expect(mismatches).toEqual([{ kind: 'extra-port', name: 'enable' }]);
    expect(describeInterfaceMismatch('sample', mismatches[0] as never)).toBe(
      'sample: Yosys reports port "enable" which is not declared',
    );
  });
});
