// testbench-in-order-scoreboard, Property 6: the Scoreboard_Scaffold is deterministic, and its
// structure keeps comparison timing in product code.
//
// The structural claims are read off the rendered text, because the scaffold IS text: the drain
// bound is declared once, every CHECK line it can print is one the oracle parser reads under a
// fixed or a required name, and only the capture and compare blocks write scaffold state after
// initialization (Req 4.1).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { renderScoreboardScaffold, SCOREBOARD_CHECK_NAMES } from '@app/agent';
import type { ModuleInterface, Port } from '@app/core';
import { readCheckSignals } from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY_6 =
  'Feature: testbench-in-order-scoreboard, Property 6: Scaffold determinism and structure';

const arbWidth = fc.integer({ min: 1, max: 16 });

/** A clocked interface with exactly one Output_Qualifier, the only shape the scaffold renders. */
const arbScoreboardInterface: fc.Arbitrary<ModuleInterface> = fc
  .record({
    dataInputs: fc.array(arbWidth, { maxLength: 3 }),
    dataOutputs: fc.array(arbWidth, { minLength: 1, maxLength: 3 }),
    inputQualifier: fc.boolean(),
    reset: fc.option(fc.boolean(), { nil: null }),
  })
  .map(({ dataInputs, dataOutputs, inputQualifier, reset }) => {
    const ports: Port[] = [{ name: 'clk', direction: 'input', width: 1 }];
    if (reset !== null) {
      ports.push({ name: 'rst', direction: 'input', width: 1 });
    }
    if (inputQualifier) {
      ports.push({ name: 'valid_in', direction: 'input', width: 1 });
    }
    dataInputs.forEach((width, i) =>
      ports.push({ name: `d${String(i)}`, direction: 'input', width }),
    );
    ports.push({ name: 'valid_out', direction: 'output', width: 1 });
    dataOutputs.forEach((width, i) =>
      ports.push({ name: `q${String(i)}`, direction: 'output', width }),
    );
    return {
      moduleName: 'dut_under_test',
      ports,
      clocking: {
        clockName: 'clk',
        resetName: reset === null ? null : 'rst',
        resetActiveLow: reset ?? false,
      },
      validityOutputName: null,
    };
  });

const arbCheckNames = fc.uniqueArray(fc.stringMatching(/^ac[1-9]_[a-z]{1,8}$/), {
  minLength: 1,
  maxLength: 4,
});

/** An assignment (not a comparison) to state Req 4.1 restricts to the two event blocks. */
const STATE_WRITE =
  /\b(sb_exp_\w+\[[^\]]*\]|txn_\w+\[[^\]]*\]|sb_head|sb_tail|sb_txn_count)\s*=(?!=)/;

/** Every string a `$display` prints, which is every line the scaffold can put on stdout. */
function displayedLines(text: string): readonly string[] {
  return [...text.matchAll(/\$display\("([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe(PROPERTY_6, () => {
  it('renders byte-identically and keeps timing and state in the scaffold', () => {
    fc.assert(
      fc.property(arbScoreboardInterface, arbCheckNames, (moduleInterface, checkNames) => {
        const first = renderScoreboardScaffold(moduleInterface, checkNames);
        const second = renderScoreboardScaffold(moduleInterface, checkNames);
        expect(first.ok).toBe(true);
        if (!first.ok || !second.ok) {
          return;
        }
        const text = first.value.text;
        expect(second.value.text).toBe(text);

        // Exactly one positive drain bound, stated as a liveness bound.
        expect(
          [...text.matchAll(/localparam integer DRAIN_BOUND = (\d+);/g)].map((m) => Number(m[1])),
        ).toEqual([expect.any(Number)]);
        expect(Number(/DRAIN_BOUND = (\d+)/.exec(text)?.[1])).toBeGreaterThan(0);
        expect(text).toContain('It is not a latency claim');

        // Every printable line is a CHECK the oracle reads, under a fixed or a required name.
        const allowed = new Set<string>([...Object.values(SCOREBOARD_CHECK_NAMES), ...checkNames]);
        for (const line of displayedLines(text)) {
          const reading = readCheckSignals(line.replace(/%[0-9]*[hd]/g, '0'));
          expect(reading.unreadableSignals).toBe(0);
          expect(reading.checks).toHaveLength(1);
          expect(allowed.has(reading.checks[0]?.name ?? '')).toBe(true);
        }

        // State writes occur only inside the capture and compare blocks, or at initialization.
        const lines = text.split('\n');
        const captureStart = lines.findIndex((line) => line.includes('Input_Transaction capture'));
        const compareEnd = lines.findIndex((line) => line.includes('Liveness:'));
        const initLine = lines.findIndex((line) => line.includes('sb_head = 0; sb_tail = 0'));
        let writesInBlocks = 0;
        lines.forEach((line, index) => {
          if (!STATE_WRITE.test(line)) {
            return;
          }
          const inBlocks = index > captureStart && index < compareEnd;
          writesInBlocks += inBlocks ? 1 : 0;
          expect(inBlocks || index === initLine).toBe(true);
        });
        // Non-vacuity: the capture block appends to the queue, so a pattern that matched
        // nothing would make the loop above assert nothing.
        expect(writesInBlocks).toBeGreaterThan(0);

        // The comparison moment is the qualifier in the settled part of the period, nothing else.
        expect(text).toContain("if (!sb_in_reset && valid_out === 1'b1) begin");
        expect(text).toMatch(/always @\(posedge clk\) begin\n {4}#2;/);
      }),
      propertyParameters(),
    );
  });
});
