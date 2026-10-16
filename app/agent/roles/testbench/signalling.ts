// The per-check signalling contract the Testbench_Agent emits (Req 7.6).
//
// The Simulator adapter's oracle reader (`@app/tools` check-signalling) parses one
// machine-readable line per spec-derived check of the exact form:
//
//     CHECK <name> PASS
//     CHECK <name> FAIL
//
// This module is the generation-side counterpart to that parser: it formats those
// lines and validates that a testbench source emits a `CHECK <name>` signal for a
// given check name, either as that text or as a Check_Report_Task call. Keeping
// the format in one small helper (rather than scattering string literals through
// the prompt) means the example test can assert a round-trip against the real
// `readCheckSignals` oracle, so the two sides cannot drift.

import { CHECK_REPORT_TASK_NAME, CHECK_REPORT_TASK_PATH } from '@app/tools';

/** The literal, uppercase keyword that anchors every per-check signalling line. */
export const CHECK_KEYWORD = 'CHECK' as const;

/**
 * Whether a candidate check name is a single whitespace-free, non-empty token.
 *
 * The oracle's line grammar matches a whitespace-free `<name>` token; a name with
 * spaces or tabs would split the line and be unparseable, so it is rejected here.
 */
export function isValidCheckName(name: string): boolean {
  return name.length > 0 && !/\s/.test(name);
}

/**
 * Format one per-check signalling line exactly as the oracle parses it (Req 7.6).
 *
 * Throws on an invalid check name rather than emitting an unparseable line, so a
 * malformed name is caught at construction rather than silently verifying nothing.
 */
export function formatCheckLine(name: string, passed: boolean): string {
  if (!isValidCheckName(name)) {
    throw new Error('check name must be a single whitespace-free token');
  }
  return `${CHECK_KEYWORD} ${name} ${passed ? 'PASS' : 'FAIL'}`;
}

/** Escape a string for safe interpolation into a regular expression. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a testbench source emits a per-check signal for `name`, in either accepted form.
 *
 * Two forms because there are two ways a compliant testbench names a check: the `CHECK <name>`
 * text it prints itself, and a Check_Report_Task call whose first argument is the name (the form
 * `CHECK_REPORT_RULE` requires). Recognising only the first would refuse every testbench that
 * obeys the rule, which is a coverage refusal rather than a coverage gap.
 *
 * Still a deterministic predicate over untrusted model output, and it still does not run the
 * testbench: it confirms the source contains an emission the oracle will later parse.
 */
export function sourceEmitsCheck(source: string, name: string): boolean {
  return emitsCheckText(source, name) || callsCheckReportTask(source, name);
}

/**
 * Whether a testbench source emits a `CHECK <name>` signal for the given name.
 *
 * The check name must appear as the token immediately following the `CHECK`
 * keyword (separated by spaces/tabs), matching the oracle's line grammar. A word
 * boundary after the name prevents `reset` from matching a `reset_clears` emission.
 */
function emitsCheckText(source: string, name: string): boolean {
  const pattern = new RegExp(`${CHECK_KEYWORD}[ \\t]+${escapeRegExp(name)}\\b`);
  return pattern.test(source);
}

/**
 * Whether a testbench source calls the Check_Report_Task with `name` as its first argument.
 *
 * The task is matched by its harness path or bare, but never as the tail of a longer identifier
 * or another scope's path. The literal must be exactly `"name"`, so `reset` does not match
 * a `reset_clears` call.
 */
function callsCheckReportTask(source: string, name: string): boolean {
  const task = `(?:${escapeRegExp(CHECK_REPORT_TASK_PATH)}|${escapeRegExp(CHECK_REPORT_TASK_NAME)})`;
  const pattern = new RegExp(`(?<![\\w$.])${task}\\s*\\(\\s*"${escapeRegExp(name)}"`);
  return pattern.test(source);
}
