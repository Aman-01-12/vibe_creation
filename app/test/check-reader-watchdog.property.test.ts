// testbench-spec-grounding, Property 11: the Check_Reader's Watchdog rule. A sentinel line with a
// TestbenchRun fails every unprinted Required_Check; otherwise interpretation is unchanged.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyVerdict } from '@app/core';
import {
  WATCHDOG_SENTINEL,
  interpretSandboxResult,
  readCheckSignals,
  type SandboxResult,
} from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY_11 =
  "Feature: testbench-spec-grounding, Property 11: The Check_Reader's Watchdog rule";

const NAMES = ['alpha_ok', 'beta_ok', 'gamma_ok', 'known_answer_x'] as const;

const arbCheckLine = fc
  .tuple(fc.constantFrom(...NAMES), fc.constantFrom('PASS', 'FAIL', 'FAIL: expected 3'))
  .map(([name, word]) => `CHECK ${name} ${word}`);
const arbNoise = fc.constantFrom('VCD info: dumpfile dump.vcd opened', 'tick 3', '', '  ');
const arbSentinel = fc.constantFrom(WATCHDOG_SENTINEL, `  ${WATCHDOG_SENTINEL}\r`);

/** Stdout lines, with the sentinel placed somewhere when `withSentinel`. */
const arbStdout = fc
  .record({
    lines: fc.array(fc.oneof(arbCheckLine, arbNoise), { maxLength: 8 }),
    sentinel: fc.option(arbSentinel, { nil: undefined }),
    at: fc.nat(),
  })
  .map(({ lines, sentinel, at }) => {
    if (sentinel === undefined) {
      return { stdout: lines.join('\n'), stopped: false };
    }
    const index = at % (lines.length + 1);
    const placed = [...lines.slice(0, index), sentinel, ...lines.slice(index)];
    return { stdout: placed.join('\n'), stopped: true };
  });

const arbRequired = fc.subarray([...NAMES]);

function result(stdout: string, verdict: 'pass' | 'fail'): SandboxResult {
  return {
    verdict,
    timedOut: false,
    exitCode: verdict === 'pass' ? 0 : 1,
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
  };
}

describe(PROPERTY_11, () => {
  it('fails exactly the unprinted Required_Checks on a sentinel, and changes nothing otherwise', () => {
    fc.assert(
      fc.property(
        arbStdout,
        arbRequired,
        fc.constantFrom<'pass' | 'fail'>('pass', 'fail'),
        (out, required, verdict) => {
          const raw = result(out.stdout, verdict);
          const without = interpretSandboxResult(raw, []);
          const withRun = interpretSandboxResult(raw, [], { requiredCheckNames: required });
          expect(without.watchdog).toEqual({ stopped: false });
          if (!out.stopped) {
            expect(withRun).toEqual(without);
            return;
          }
          const reading = readCheckSignals(out.stdout);
          const printed = new Set(reading.checks.map((check) => check.name));
          const timedOut = required.filter((name) => !printed.has(name));
          const checks = [...reading.checks, ...timedOut.map((name) => ({ name, passed: false }))];
          expect(withRun.watchdog).toEqual({ stopped: true, timedOutChecks: timedOut });
          expect(withRun.checks).toEqual(checks);
          expect(withRun.verdict).toBe(
            classifyVerdict({
              timedOut: false,
              toolFailure: false,
              completed: true,
              checks,
              unreadableCheckSignals: reading.unreadableSignals,
              diskLimitExceeded: false,
              stdoutTruncated: false,
            }),
          );
          // Without a TestbenchRun the sentinel is just another stdout line.
          expect(without.checks).toEqual(reading.checks);
        },
      ),
      propertyParameters(),
    );
  });
});
