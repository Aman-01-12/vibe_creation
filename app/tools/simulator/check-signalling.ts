// The testbench-to-Simulator per-check signalling convention (Req 7.6, 8.10).
//
// The Simulator adapter is the deterministic oracle's reader: it turns what a
// completed simulation printed into a per-spec-check pass/fail signal. The
// simulation itself does not decide the verdict; the testbench emits one
// machine-readable line per spec-derived check and this module parses those lines
// into the core `CheckResult[]` that the verdict rules consume.
//
// THIS MODULE IS THE ENFORCEMENT BOUNDARY, NOT THE PROMPT
//
//   The testbench is model-authored, so its output is untrusted input like any
//   other. The Testbench_Agent prompt states the convention, but a prompt is
//   advice a model may ignore; this reader is what actually decides. It therefore
//   fails SAFE in both directions: it reads the shapes a reasonable testbench
//   actually writes, and anything it cannot read is surfaced rather than dropped.
//
// SIGNALLING CONVENTION (the contract the Testbench_Agent MUST emit)
//
//   For every acceptance-criterion check it exercises, the generated testbench
//   prints one line to standard output of the form:
//
//       CHECK <name> PASS
//       CHECK <name> FAIL
//       CHECK <name> FAIL at cycle 0: expected 10000000, got 11101011
//
//   - `CHECK` is a literal, uppercase keyword anchoring the line.
//   - `<name>` is a single whitespace-free token naming the check, traceable back
//     to a Spec acceptance criterion (for example `reset_clears_output`). A
//     whitespace-free token keeps the line unambiguously parseable.
//   - The status is the literal `PASS` or `FAIL`, uppercase, and must be a
//     COMPLETE word: `PASSED` and `FAILURE` are not a status, so a status can
//     never be read out of the prefix of another word.
//   - Anything after the status word is a human-readable diagnostic and is
//     ignored, whether it is separated by whitespace (`FAIL at cycle 0: ...`) or
//     attached directly (`FAIL: reset state incorrect`). This is the shape that
//     motivated the fix: a testbench that appends its reason to the failure line
//     is writing the natural thing, and a reader anchored at both ends silently
//     dropped exactly those FAIL lines. Both forms have been observed from real
//     generated testbenches, so both are read rather than one being discarded.
//   - Tokens are separated by one or more spaces/tabs; surrounding whitespace on
//     the line is ignored. A line that does not begin with the `CHECK` keyword
//     (banner text, `$display` diagnostics, waveform notes) is not a signal at all
//     and is ignored, so the testbench is free to print freely alongside it.
//
//   The testbench must emit every check line and then finish normally (`$finish`).
//   A run that prints no readable CHECK line verified nothing and is classified
//   `error` by the adapter (fail-safe), never a silent pass.
//
// WHY AN UNREADABLE `CHECK`-LIKE LINE IS NOT DISCARDED
//
//   A line that begins with the `CHECK` keyword but yields no `(name, status)`
//   pair means the testbench TRIED to signal something and we could not read it.
//   Silently discarding it was the root cause of a severity-1 defect: the run then
//   showed only the lines that did parse, and if those were all passes the oracle
//   reported `pass` for a design that had actually failed. Such a line is counted
//   here and carried to the verdict, where it forces a non-passing outcome.
//
//   Only the COUNT crosses this boundary, never the offending text. The line is
//   raw model-authored tool output that routinely names a sandbox workspace path,
//   and the full stdout is already carried for diagnostics, so a count is both
//   sufficient to decide the verdict and structurally incapable of leaking a path
//   into one.

import { missingCheckNames, type CheckResult } from '@app/core';

import { WATCHDOG_SENTINEL } from './simulation-harness.js';

/**
 * Matches one per-check signalling line: `CHECK <name> PASS|FAIL[diagnostic]`.
 *
 * Group 1 is the whitespace-free check name; group 2 is the uppercase status. The
 * line is matched after trimming, so leading/trailing whitespace is tolerated.
 *
 * The status is required NOT to be followed by a word character, which is exactly
 * "the status is a complete word and never the prefix of a longer one": `PASSED`,
 * `FAILURE`, and `PASSes` do not match, while `FAIL:` and `FAIL at cycle 0` do.
 * The two rejected and the two accepted shapes have all been seen from real
 * generated testbenches, so the boundary is drawn where the evidence puts it - a
 * whitespace-only delimiter would have thrown away legible `FAIL:` verdicts, and a
 * looser rule would have read a verdict out of the word `PASSED`.
 *
 * Linear on untrusted input: `[ \t]+` and `\S+` match disjoint character sets, so
 * no position is reachable by two different splits, the boundary test is a
 * single-character lookahead, and the trailing `.*` runs to end-of-line with
 * nothing after it to backtrack for.
 */
const CHECK_LINE_PATTERN = /^CHECK[ \t]+(\S+)[ \t]+(PASS|FAIL)(?![A-Za-z0-9_]).*$/;

/**
 * Matches a line that CLAIMS to be a check signal: the `CHECK` keyword as a
 * complete leading token.
 *
 * Requiring the keyword to be followed by whitespace or end-of-line keeps
 * unrelated output such as `CHECKSUM 5` classified as banner text rather than as a
 * broken signal. The keyword is case-sensitive, matching the convention, so
 * lowercase prose that happens to start with "check" is also just banner text.
 */
const CHECK_KEYWORD_PATTERN = /^CHECK(?:[ \t]|$)/;

/**
 * What the reader made of a run's standard output.
 *
 * The two fields are reported together, and deliberately not as a bare check list,
 * because a caller that receives only the readable checks cannot tell a clean run
 * from one whose failure signal it failed to parse - which is the defect this
 * shape exists to make unrepresentable.
 */
export interface CheckSignalReading {
  /** The readable checks, in emission order, duplicates preserved. */
  readonly checks: readonly CheckResult[];
  /**
   * How many `CHECK`-like lines yielded no `(name, status)` pair.
   *
   * Greater than zero means the testbench signalled something unreadable, so the
   * run cannot be treated as having verified everything it reported.
   */
  readonly unreadableSignals: number;
}

/** Parse one already-trimmed line into a `CheckResult`, or `null` if it is not one. */
function parseCheckLine(line: string): CheckResult | null {
  const match = CHECK_LINE_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  // Both capture groups are guaranteed present by the pattern's fixed arity.
  const [, name, status] = match;
  return { name: name as string, passed: status === 'PASS' };
}

/**
 * Read the testbench's per-check signalling out of a run's standard output.
 *
 * Returns the readable checks in the order they were printed, preserving
 * duplicates so a check reported both `PASS` and `FAIL` still fails pass
 * integrity, plus a count of the `CHECK`-like lines that could not be read.
 *
 * Non-signal lines are ignored. An empty check list means the run emitted no
 * readable check, which the adapter treats as `error` (it verified nothing); a
 * non-zero `unreadableSignals` likewise keeps the run from passing.
 */
export function readCheckSignals(stdout: string): CheckSignalReading {
  const checks: CheckResult[] = [];
  let unreadableSignals = 0;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    const check = parseCheckLine(line);
    if (check !== null) {
      checks.push(check);
      continue;
    }
    if (CHECK_KEYWORD_PATTERN.test(line)) {
      unreadableSignals += 1;
    }
  }
  return { checks, unreadableSignals };
}

/** Whether the Watchdog ended the run, and which Required_Checks it left unprinted. */
export type WatchdogReading =
  | { readonly stopped: false }
  | { readonly stopped: true; readonly timedOutChecks: readonly string[] };

/**
 * The Watchdog reading of one completed run's stdout (Req 5.3, 5.4); never reads source.
 * Stopped when a trimmed stdout line is the sentinel; unprinted Required_Checks timed out.
 */
export function readWatchdogStop(
  stdout: string,
  reading: CheckSignalReading,
  requiredCheckNames: readonly string[],
): WatchdogReading {
  const stopped = stdout.split('\n').some((line) => line.trim() === WATCHDOG_SENTINEL);
  if (!stopped) {
    return { stopped: false };
  }
  return { stopped: true, timedOutChecks: missingCheckNames(reading.checks, requiredCheckNames) };
}
