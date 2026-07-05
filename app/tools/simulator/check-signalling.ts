// The testbench-to-Simulator per-check signalling convention (Req 7.6, 8.10).
//
// The Simulator adapter is the deterministic oracle's reader: it turns what a
// completed simulation printed into a per-spec-check pass/fail signal. The
// simulation itself does not decide the verdict; the testbench emits one
// machine-readable line per spec-derived check and this module parses those lines
// into the core `CheckResult[]` that the verdict rules consume.
//
// SIGNALLING CONVENTION (the contract the Testbench_Agent in task 13.3 MUST emit)
//
//   For every acceptance-criterion check it exercises, the generated testbench
//   prints exactly one line to standard output of the form:
//
//       CHECK <name> PASS
//       CHECK <name> FAIL
//
//   - `CHECK` is a literal, uppercase keyword anchoring the line.
//   - `<name>` is a single whitespace-free token naming the check, traceable back
//     to a Spec acceptance criterion (for example `reset_clears_output`). A
//     whitespace-free token keeps the line unambiguously parseable.
//   - The status is the literal `PASS` or `FAIL`, uppercase.
//   - Tokens are separated by one or more spaces/tabs; surrounding whitespace on
//     the line is ignored. Any line that does not match this exact shape (banner
//     text, `$display` diagnostics, waveform notes) is ignored, so the testbench
//     is free to print human-readable output alongside the machine signal.
//
//   The testbench must emit every check line and then finish normally (`$finish`).
//   A run that prints no parseable CHECK line verified nothing and is classified
//   `error` by the adapter (fail-safe), never a silent pass.

import type { CheckResult } from '@app/core';

/**
 * Matches one per-check signalling line: `CHECK <name> PASS|FAIL`.
 *
 * Group 1 is the whitespace-free check name; group 2 is the uppercase status. The
 * line is matched after trimming, so leading/trailing whitespace is tolerated but
 * the keyword, name, and status shape are strict.
 */
const CHECK_LINE_PATTERN = /^CHECK[ \t]+(\S+)[ \t]+(PASS|FAIL)$/;

/** Parse one already-trimmed line into a `CheckResult`, or `null` if it is not a signal. */
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
 * Parse the testbench's per-check signalling lines out of a run's standard output.
 *
 * Returns the checks in the order they were printed, preserving duplicates so a
 * check reported both `PASS` and `FAIL` still fails pass integrity. Non-signal
 * lines are ignored. An empty result means the run emitted no parseable check,
 * which the adapter treats as `error` (it verified nothing).
 */
export function parseCheckResults(stdout: string): readonly CheckResult[] {
  const results: CheckResult[] = [];
  for (const rawLine of stdout.split('\n')) {
    const check = parseCheckLine(rawLine.trim());
    if (check !== null) {
      results.push(check);
    }
  }
  return results;
}
