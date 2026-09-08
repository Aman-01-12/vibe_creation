// The SEVERITY-1 oracle regression: a CHECK FAIL line with a trailing diagnostic
// was silently discarded, so a FAILING design read as `pass`.
//
// WHAT WENT WRONG, AS MEASURED
//   `CHECK_LINE_PATTERN` was anchored at both ends: `/^CHECK\s+(\S+)\s+(PASS|FAIL)$/`.
//   A generated testbench that appended its reason to the status line -
//
//     CHECK ac1_under_simulation_right_shifter_produces FAIL at cycle 0: expected ...
//
//   - matched nothing, was dropped as banner text, and left only the ten preceding
//   PASS lines behind. `interpretSandboxResult` then saw no failing check and
//   returned `pass`. Reproduced deterministically against the persisted artifact:
//
//     raw FAIL lines present in stdout : 1
//     checks the oracle reader parsed  : 10
//     of those, failing                : 0
//
//   That can manufacture a false `Verified`, which is a prime-directive violation,
//   and it affects the shipped product, not only the eval harness - the positive
//   control reads stdout through the same reader.
//
// WHY THE FIXTURE IS THE REAL ARTIFACT
//   `fixtures/smoke-v3-tbfix/right-shifter-control-stdout.txt` is the stdout that
//   ACTUALLY fooled the parser, copied verbatim out of the smoke run's per-sample
//   artifacts so no test depends on a run directory. A hand-written string could be
//   made to fail on purpose and would prove nothing about the defect; this one
//   already produced a false `instrument=valid` beside a false `verified` in a paid
//   sweep. It also carries the duplicate-name case for free: it prints the SAME
//   check name ten times as PASS and then once as FAIL.
//
// WHAT THIS FILE PINS
//   The reader's new grammar (trailing diagnostics accepted, the status required to
//   be a complete token), the refusal to silently discard a `CHECK`-like line it
//   cannot read, the conservative resolution of duplicate names, and the two
//   required-set rules (a required check that printed nothing, and a name outside
//   the required set, can neither of them produce a pass).

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  allSpecChecksPassed,
  classifyVerdict,
  missingCheckNames,
  type CheckResult,
  type InvocationOutcome,
} from '@app/core';
import {
  interpretSandboxResult,
  readCheckSignals,
  type ResourceUsage,
  type SandboxResult,
} from '@app/tools';

// -- The real artifact ------------------------------------------------------

/** This suite's directory, for reading the captured fixture. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The check name the smoke run's testbench signalled its whole-design verdict with. */
const CHECK_NAME = 'ac1_under_simulation_right_shifter_produces';

/** The stdout that actually fooled the oracle reader, read verbatim from the fixture. */
function smokeRunStdout(): Promise<string> {
  return readFile(
    join(HERE, 'fixtures', 'smoke-v3-tbfix', 'right-shifter-control-stdout.txt'),
    'utf8',
  );
}

// -- Sandbox result plumbing ------------------------------------------------

const RESOURCE_USAGE: ResourceUsage = { wallMs: 116, maxMemMb: 8, cpuMs: 100 };

/**
 * A completed, fully captured sandbox result carrying the given stdout.
 *
 * `stdoutTruncated` defaults to `false` (the whole stream was retained); the
 * truncation cases pass `true` to model output the Tool_Runner had to bound.
 */
function completedRun(stdout: string, stdoutTruncated = false): SandboxResult {
  return {
    verdict: 'pass',
    timedOut: false,
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutTruncated,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 4, sha256: 'a'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
  };
}

/**
 * A completed invocation outcome over the given readable/unreadable signalling.
 *
 * `diskLimitExceeded` is `false` because these cases model a run that reached its
 * own end and printed its checks - the whole point of the fixture. A disk-cap kill
 * would classify `error` on its own and make every assertion below vacuous, so
 * these are deliberately runs no resource bound stopped; the disk rule is asserted
 * where it belongs, in the Property 7 suite.
 */
function completedOutcome(
  checks: readonly CheckResult[],
  unreadableCheckSignals = 0,
  stdoutTruncated = false,
): InvocationOutcome {
  return {
    timedOut: false,
    toolFailure: false,
    completed: true,
    checks,
    unreadableCheckSignals,
    diskLimitExceeded: false,
    stdoutTruncated,
  };
}

// -- The regression, on the real artifact -----------------------------------

describe('the right_shifter false pass, pinned to the stdout that caused it', () => {
  it('given the real stdout when the reader reads it then the trailing-diagnostic FAIL is parsed', async () => {
    const reading = readCheckSignals(await smokeRunStdout());

    // Eleven signals, not ten: the FAIL line is no longer invisible.
    expect(reading.checks).toHaveLength(11);
    expect(reading.checks.filter((check) => !check.passed)).toEqual([
      { name: CHECK_NAME, passed: false },
    ]);
    // And nothing in this run was unreadable, so the count does not mask the fix.
    expect(reading.unreadableSignals).toBe(0);
  });

  it('given the real stdout when the oracle interprets it then the run is NOT a pass', async () => {
    const simulation = interpretSandboxResult(completedRun(await smokeRunStdout()));

    // The whole defect in one assertion: this exact output was labeled `verified`.
    expect(simulation.verdict).toBe('fail');
  });

  it('given ten PASS then one FAIL for the SAME name when resolved then the check FAILED', async () => {
    const stdout = await smokeRunStdout();
    const reading = readCheckSignals(stdout);
    const occurrences = reading.checks.filter((check) => check.name === CHECK_NAME);

    // The exact sequence the artifact prints: ten passes, then one failure.
    expect(occurrences.map((check) => check.passed)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    // Conservative resolution: one FAIL for a name means that name did not pass,
    // however many times it also passed. There is no majority or last-wins rule.
    expect(allSpecChecksPassed(reading.checks)).toBe(false);
    expect(classifyVerdict(completedOutcome(reading.checks))).toBe('fail');
  });

  it('given the real stdout when the required check is the one that failed then no pass is possible', async () => {
    const reading = readCheckSignals(await smokeRunStdout());

    // The failing name IS the required check, so the run cannot be excused as
    // "an unknown name failed": the required check itself reported FAIL.
    expect(missingCheckNames(reading.checks, [CHECK_NAME])).toEqual([]);
    expect(classifyVerdict(completedOutcome(reading.checks))).not.toBe('pass');
  });
});

// -- The grammar ------------------------------------------------------------

describe('the check-signalling grammar', () => {
  it('given a status that is the prefix of a longer word then it is not a status', () => {
    const stdout = ['CHECK a PASSED', 'CHECK b FAILURE', 'CHECK c PASSING', 'CHECK d FAILS'].join(
      '\n',
    );

    const reading = readCheckSignals(stdout);

    // None of these is a verdict, and none of them is silently dropped either.
    expect(reading.checks).toEqual([]);
    expect(reading.unreadableSignals).toBe(4);
  });

  it('given an underscore after the status then it is part of a longer word, not a status', () => {
    // `_` is a word character, so `FAIL_LATER` is one word and not a verdict.
    const reading = readCheckSignals('CHECK b FAIL_LATER\nCHECK c PASS0');

    expect(reading.checks).toEqual([]);
    expect(reading.unreadableSignals).toBe(2);
  });

  it('given the status attached to its reason by punctuation then the status is still read', () => {
    // Observed shape from a real generated testbench in the smoke-v4-oracle run:
    // `$display("CHECK <name> FAIL: Reset state incorrect")`. Refusing this would
    // turn a legible functional failure into an unreadable signal, which is safe
    // but strictly less accurate - `fail` says more than `error`.
    expect(readCheckSignals('CHECK a FAIL: Reset state incorrect').checks).toEqual([
      { name: 'a', passed: false },
    ]);
    expect(readCheckSignals('CHECK a FAIL, see log').checks).toEqual([
      { name: 'a', passed: false },
    ]);
    expect(readCheckSignals('CHECK a PASS.').checks).toEqual([{ name: 'a', passed: true }]);
  });

  it('given a diagnostic separated from the status by whitespace then the status is read', () => {
    expect(readCheckSignals('CHECK a FAIL at cycle 7: expected 1, got 0').checks).toEqual([
      { name: 'a', passed: false },
    ]);
    expect(readCheckSignals('CHECK a\tPASS\tafter 12 cycles').checks).toEqual([
      { name: 'a', passed: true },
    ]);
  });

  it('given the well-formed cases that worked before then they behave identically', () => {
    // The relaxation must not have changed the shapes the old grammar accepted.
    expect(readCheckSignals('CHECK reset_clears_output PASS').checks).toEqual([
      { name: 'reset_clears_output', passed: true },
    ]);
    expect(readCheckSignals('   CHECK\tcounts_up\tFAIL   ').checks).toEqual([
      { name: 'counts_up', passed: false },
    ]);
    expect(readCheckSignals('VCD info: dumpfile dump.vcd opened').checks).toEqual([]);
    expect(readCheckSignals('check counts_up pass').unreadableSignals).toBe(0);
  });

  it('given a large volume of untrusted lines then reading stays linear', () => {
    // The reader parses model-authored tool output, so a pathological input must not
    // become a stall. 20k mixed lines, including near-miss shapes designed to make a
    // backtracking engine work, must complete well inside a second.
    const lines: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      lines.push(`CHECK name_${index} ${'PASS'.repeat(index % 3 === 0 ? 2 : 1)}`);
      lines.push(`CHECK ${'a'.repeat(200)} ${' '.repeat(50)}FAILURE`);
    }

    const startedAt = Date.now();
    const reading = readCheckSignals(lines.join('\n'));

    expect(Date.now() - startedAt).toBeLessThan(1000);
    // Every `PASSPASS` and `FAILURE` line is counted, never dropped.
    expect(reading.checks.length + reading.unreadableSignals).toBe(40_000);
  });
});

// -- The verdict rule -------------------------------------------------------

describe('the verdict rule over unreadable and missing signals', () => {
  it('given an unreadable CHECK line beside passing checks then the run is error, not pass', () => {
    const simulation = interpretSandboxResult(
      completedRun('CHECK a PASS\nCHECK b PASS\nCHECK c MAYBE\n'),
    );

    expect(simulation.verdict).toBe('error');
    // The readable checks are still reported, so the failure is diagnosable.
    expect(simulation.checks).toEqual([
      { name: 'a', passed: true },
      { name: 'b', passed: true },
    ]);
  });

  it('given a bare CHECK keyword then it counts as an unreadable signal', () => {
    expect(interpretSandboxResult(completedRun('CHECK a PASS\nCHECK\n')).verdict).toBe('error');
  });

  it('given a readable FAIL beside an unreadable line then the definite failure wins', () => {
    // Both are non-pass; `fail` is the stronger, more actionable statement.
    expect(interpretSandboxResult(completedRun('CHECK a FAIL\nCHECK b MAYBE\n')).verdict).toBe(
      'fail',
    );
  });

  it('given a required check with no line at all then it is reported as missing', () => {
    const reading = readCheckSignals('CHECK a PASS\nCHECK b PASS\n');

    // The oracle alone would call this a pass; the required set is what exposes it.
    expect(classifyVerdict(completedOutcome(reading.checks))).toBe('pass');
    expect(missingCheckNames(reading.checks, ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('given only names outside the required set then every required name is missing', () => {
    const reading = readCheckSignals('CHECK invented_one PASS\nCHECK invented_two PASS\n');

    expect(missingCheckNames(reading.checks, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('given a required name reported once as FAIL and once as PASS then it is still missing nothing but fails', () => {
    const reading = readCheckSignals('CHECK a FAIL\nCHECK a PASS\n');

    // Present, so not missing - and still not a pass, because one occurrence failed.
    expect(missingCheckNames(reading.checks, ['a'])).toEqual([]);
    expect(classifyVerdict(completedOutcome(reading.checks))).toBe('fail');
  });

  it('given no readable check at all then the run verified nothing', () => {
    expect(interpretSandboxResult(completedRun('simulation finished\n')).verdict).toBe('error');
    expect(classifyVerdict(completedOutcome([], 1))).toBe('error');
  });
});

// -- The same rule, one step earlier: output we never saw --------------------
//
// The Tool_Runner bounds how many bytes of a run's output it retains, because an
// unbounded capture of a runaway `$display` loop is a measured out-of-memory
// vector. That bound creates a second way for check evidence to be incomplete: not
// a line the reader could not parse, but a line the reader never received. It is
// handled by the same fail-safe and with the same precedence.

describe('the verdict rule over TRUNCATED output', () => {
  it('given all-passing retained checks on truncated stdout then the run is error, not pass', () => {
    const simulation = interpretSandboxResult(completedRun('CHECK a PASS\nCHECK b PASS\n', true));

    // A `CHECK ... FAIL` line may sit in the discarded bytes, and the retained
    // prefix cannot rule it out, so this run established nothing.
    expect(simulation.verdict).toBe('error');
    expect(simulation.checks).toEqual([
      { name: 'a', passed: true },
      { name: 'b', passed: true },
    ]);
  });

  it('given the identical stdout untruncated then the same run is a pass', () => {
    // The contrast that makes the rule above non-vacuous: only the truncation flag
    // differs between these two runs.
    expect(interpretSandboxResult(completedRun('CHECK a PASS\nCHECK b PASS\n')).verdict).toBe(
      'pass',
    );
  });

  it('given a readable FAIL on truncated stdout then the definite failure wins', () => {
    // Same precedence as the unreadable-signal rule: `fail` says strictly more than
    // `error`, and downgrading it would leave self-healing nothing to repair.
    expect(interpretSandboxResult(completedRun('CHECK a FAIL\n', true)).verdict).toBe('fail');
  });

  it('given truncation with no readable check then the run is error for want of evidence', () => {
    expect(interpretSandboxResult(completedRun('simulation started\n', true)).verdict).toBe(
      'error',
    );
  });

  it('given truncation as the only difference at the core rule then pass becomes error', () => {
    const reading = readCheckSignals('CHECK a PASS\nCHECK b PASS\n');

    expect(classifyVerdict(completedOutcome(reading.checks, 0, false))).toBe('pass');
    expect(classifyVerdict(completedOutcome(reading.checks, 0, true))).toBe('error');
  });
});
