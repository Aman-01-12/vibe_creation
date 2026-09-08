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
// given check name. Keeping the format in one small helper (rather than scattering
// string literals through the prompt) means the example test can assert a
// round-trip against the real `readCheckSignals` oracle, so the two sides cannot
// drift.

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
 * Whether a testbench source emits a `CHECK <name>` signal for the given name.
 *
 * The check name must appear as the token immediately following the `CHECK`
 * keyword (separated by spaces/tabs), matching the oracle's line grammar. This is
 * the deterministic coverage predicate over untrusted model output: it does not
 * run the testbench, it confirms the source contains the emission the oracle will
 * later parse. A word boundary after the name prevents `reset` from matching a
 * `reset_clears` emission.
 */
export function sourceEmitsCheck(source: string, name: string): boolean {
  const pattern = new RegExp(`${CHECK_KEYWORD}[ \\t]+${escapeRegExp(name)}\\b`);
  return pattern.test(source);
}
