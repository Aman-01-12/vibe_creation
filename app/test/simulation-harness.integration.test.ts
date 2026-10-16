// The Simulation_Harness on the REAL Icarus toolchain (testbench-spec-grounding, C6, C8).
//
// Everything here is a claim about a toolchain, not about our code: that `$dumpvars` with no
// arguments gives the Simulator the waveform it requires, that `$dumplimit` bounds the file
// without ending the run, that the Watchdog ends a hang inside the sandbox wall clock, and that
// a second `$dumpfile` the normalizer declined to remove cannot steal the dump.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DUMP_LIMIT_BYTES,
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SANDBOX_WORKER_IMAGE,
  SIMULATION_HARNESS,
  SandboxToolRunner,
  WATCHDOG_SENTINEL,
  type ResourceLimits,
  type SimulationVerdict,
} from '@app/tools';

import { PROBE } from './real-oracle-harness.js';

/** The Campaign's caps: a 30 s wall the Watchdog must beat, and the 128 MiB workspace. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 2048, procs: 64, diskMb: 128, wallMs: 30_000 };

/** A trivial DUT, so every claim below is about the harness and not about a design. */
const DUT = { path: 'dut.v', contents: 'module dut(input wire clk);\nendmodule\n' };

/** A testbench that prints its check and finishes, with no dump task of its own. */
const FINISHING_TB = [
  'module tb;',
  "  reg clk = 1'b0;",
  '  always #5 clk = ~clk;',
  '  dut d (.clk(clk));',
  '  initial begin',
  '    #100;',
  '    $display("CHECK a_ok PASS");',
  '    $finish;',
  '  end',
  'endmodule',
  '',
].join('\n');

/** A testbench that waits on a signal nothing ever drives: the measured hang shape. */
const HUNG_TB = [
  'module tb;',
  "  reg done = 1'b0;",
  "  reg clk = 1'b0;",
  '  always #5 clk = ~clk;',
  '  dut d (.clk(clk));',
  '  initial begin',
  '    $display("CHECK a_ok PASS");',
  '    wait (done);',
  '    $display("CHECK b_ok PASS");',
  '    $finish;',
  '  end',
  'endmodule',
  '',
].join('\n');

/** A hung testbench that also dumps hard, so the Dump_Limit is the thing under test. */
const HUNG_DUMPING_TB = [
  'module tb;',
  "  reg done = 1'b0;",
  "  reg [31:0] churn = 32'd0;",
  "  reg clk = 1'b0;",
  '  always #1 clk = ~clk;',
  "  always @(posedge clk) churn <= churn + 32'd1;",
  '  dut d (.clk(clk));',
  '  initial begin',
  '    $display("CHECK a_ok PASS");',
  '    wait (done);',
  '    $finish;',
  '  end',
  'endmodule',
  '',
].join('\n');

/** A testbench whose own `$dumpfile` the normalizer declined to remove (no `;` to anchor on). */
const SECOND_DUMPFILE_TB = [
  'module tb;',
  '  initial begin',
  '    $dumpfile("model.vcd");',
  '    $dumpvars(0, tb);',
  '    #50;',
  '    $display("CHECK a_ok PASS");',
  '    $finish;',
  '  end',
  'endmodule',
  '',
].join('\n');

/** Compile the harness with `contents` directly and list the `.vcd` files the run produced. */
function vcdFilesOf(contents: string): readonly string[] {
  const directory = mkdtempSync(join(tmpdir(), 'ece-harness-dump-'));
  try {
    writeFileSync(join(directory, 'tb.v'), contents, 'utf8');
    writeFileSync(join(directory, 'harness.v'), SIMULATION_HARNESS.contents, 'utf8');
    execFileSync('iverilog', ['-g2012', '-o', 'sim.vvp', 'tb.v', 'harness.v'], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('vvp', ['sim.vvp'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    return readdirSync(directory)
      .filter((entry) => entry.endsWith('.vcd'))
      .sort();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function adapter(): IcarusSimulatorAdapter {
  return new IcarusSimulatorAdapter(new SandboxToolRunner(new LocalWorkerRuntime(PROBE.pythonBin)));
}

/** Run one testbench as a Testbench_Run, so the harness and the entry are compiled in. */
function run(contents: string, requiredCheckNames: readonly string[]): Promise<SimulationVerdict> {
  return adapter().simulate([DUT], { path: 'tb.v', contents }, LIMITS, { requiredCheckNames });
}

if (!PROBE.available) {
  console.warn(`[simulation-harness] SKIPPED - the harness is NOT exercised here: ${PROBE.reason}`);
}

describe.skipIf(!PROBE.available)('the Simulation_Harness on real Icarus', () => {
  it('gives a no-dump testbench a waveform and a per-check verdict (Req 4.2, 4.6)', async () => {
    const verdict = await run(FINISHING_TB, ['a_ok']);

    expect(verdict.failureCause).toBe('none');
    expect(verdict.verdict).toBe('pass');
    expect(verdict.vcd?.name).toBe('dump.vcd');
    expect(verdict.vcd?.sizeBytes ?? 0).toBeGreaterThan(0);
    // A run that reached `$finish` first never reaches the delay, so nothing is printed.
    expect(verdict.watchdog).toEqual({ stopped: false });
    expect(verdict.stdout).not.toContain(WATCHDOG_SENTINEL);
  }, 120_000);

  it('ends a hang with the sentinel and fails only its unprinted checks (Req 5.2, 5.3, 5.4)', async () => {
    const startedAt = Date.now();
    const verdict = await run(HUNG_TB, ['a_ok', 'b_ok']);
    const elapsedMs = Date.now() - startedAt;

    expect(verdict.stdout).toContain(WATCHDOG_SENTINEL);
    expect(verdict.watchdog).toEqual({ stopped: true, timedOutChecks: ['b_ok'] });
    expect(verdict.checks).toEqual([
      { name: 'a_ok', passed: true },
      { name: 'b_ok', passed: false },
    ]);
    expect(verdict.verdict).toBe('fail');
    // Inside the sandbox wall clock, which is the whole point of a simulated-time bound.
    expect(elapsedMs).toBeLessThan(LIMITS.wallMs);
  }, 120_000);

  it('caps the waveform at the Dump_Limit and still ends the run (Req 4.4, 4.5)', async () => {
    const verdict = await run(HUNG_DUMPING_TB, ['a_ok']);

    expect(verdict.stdout).toContain('CHECK a_ok PASS');
    expect(verdict.stdout).toContain(WATCHDOG_SENTINEL);
    // `$dumplimit` stops writing at the bound; Icarus finishes the record it was mid-way through.
    expect(verdict.vcd?.sizeBytes ?? 0).toBeLessThan(DUMP_LIMIT_BYTES + 4096);
    expect(verdict.failureCause).toBe('none');
  }, 120_000);

  it('keeps the dump when a declined model `$dumpfile` remains (Req 4.2, 4.3)', async () => {
    const verdict = await run(SECOND_DUMPFILE_TB, ['a_ok']);

    expect(verdict.verdict).toBe('pass');
    expect(verdict.vcd?.name).toBe('dump.vcd');
    // The worker reports the alphabetically first `.vcd`, so the verdict above cannot tell
    // "the model's file was never written" from "it was written and not reported". Compiled
    // and run directly to list what the toolchain actually produced.
    expect(vcdFilesOf(SECOND_DUMPFILE_TB)).toEqual(['dump.vcd']);
  }, 120_000);

  it('compiles under -g2001 as well as -g2012, and declares its own timescale (Req 4.8)', () => {
    // Compiled directly, because the worker only ever passes `-g2012`: the claim under test is
    // that the harness TEXT is in the Verilog-2001 subset, which no sandbox job can ask.
    const directory = mkdtempSync(join(tmpdir(), 'ece-harness-'));
    try {
      const harnessPath = join(directory, 'harness.v');
      writeFileSync(harnessPath, SIMULATION_HARNESS.contents, 'utf8');
      for (const standard of ['-g2001', '-g2012']) {
        execFileSync(
          'iverilog',
          [standard, '-o', join(directory, `out-${standard}`), harnessPath],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(SIMULATION_HARNESS.contents.startsWith('`timescale 1ns/1ps\n')).toBe(true);
    // The image this harness must also compile under is the one the acceptance test pins.
    expect(SANDBOX_WORKER_IMAGE.length).toBeGreaterThan(0);
  });
});
