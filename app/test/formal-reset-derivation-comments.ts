// formal-gate-first-light, Component 20: the nine source comments criterion 4.11 names.
//
// WHY THE TABLE HOLDS AN EXACT SUBSTRING RATHER THAN A DESCRIPTION
//   The measurement has to say which comments currently claim `LIFObuffer`'s reset is refused, and
//   a description cannot be checked against a file. A substring can: the driver re-reads each
//   file, so a comment someone corrected after this table was taken is reported as ALREADY
//   CORRECTED rather than named as a live claim.
//
// AND WHY EACH ENTRY PINS TWO SUBSTRINGS RATHER THAN ONE
//   Task 4.30 corrected all nine, so a single pinned claim would now be absent for two different
//   reasons: the comment was corrected, or the substring was wrong in the first place. The second
//   substring separates them. `claim` is the old refusal text and must be GONE; `correction` is
//   the text that replaced it and must be PRESENT. A wrong substring then fails rather than
//   reading as the comfortable answer that nobody claims anything.

/** One source comment that describes `LIFObuffer`'s reset, or the class it belongs to. */
export interface ResetClaimComment {
  /** Repository-relative path, re-read on every run. */
  readonly path: string;
  /** What the comment is, for a reader of the record. */
  readonly site: string;
  /** An exact substring of the refusal claim as it stood, which must now be GONE. */
  readonly claim: string;
  /** An exact substring of the text that replaced it, which must now be PRESENT. */
  readonly correction: string;
  /** Whether the comment names `LIFObuffer` itself rather than the enable-gated class. */
  readonly namesLifoBuffer: boolean;
}

/**
 * The nine comments, found by a direct search, each now carrying the text that replaced it.
 *
 * Five name `LIFObuffer` by name and four described the enable-gated refusal class. The split
 * matters because correcting them was two different edits: one restates a design's behaviour, the
 * other restates a rule.
 */
export const RESET_CLAIM_COMMENTS: readonly ResetClaimComment[] = Object.freeze([
  {
    path: 'app/tools/formal/conditions.ts',
    site: 'the comment on `reset-contract-unresolved` in COULD_NOT_VERIFY_CAUSES',
    claim: 'an ENABLE-GATED reset (1 of 33 corpus references)',
    correction: 'An enable-gated reset does NOT arrive here',
    namesLifoBuffer: false,
  },
  {
    path: 'app/tools/formal/prepass.ts',
    site: "the doc comment on PrepassResetFinding's refused member",
    claim: 'an ENABLE-GATED reset all arrive as',
    correction: 'An enable-gated reset is not one of them: it DERIVES',
    namesLifoBuffer: false,
  },
  {
    path: 'app/tools/formal/prepass.ts',
    site: "the doc comment on ResetContract's non-derived member",
    claim: 'an enable-gated reset, or none at all where the design DOES',
    correction: 'An enable-gated reset is NOT in that list: it derives',
    namesLifoBuffer: false,
  },
  {
    path: 'app/tools/formal/prepass.ts',
    site: "the derivation's fixed-order doc comment, item 2",
    claim: 'reset-bearing corpus references (`LIFObuffer`)',
    correction: 'NOT cover an enable-gated reset: the pre-pass derives that enable',
    namesLifoBuffer: true,
  },
  {
    path: 'app/tools/sandbox/worker/src/tool_runner_worker/eda.py',
    site: "_derived_reset's docstring",
    claim: 'an ENABLE-GATED reset refuses under the same cause',
    correction: 'An ENABLE-GATED reset does NOT refuse',
    namesLifoBuffer: false,
  },
  {
    path: 'app/tools/sandbox/worker/tests/test_formal_prepass.py',
    site: 'the docstring of test_a_cell_set_with_no_reset_entry_refuses_with_no_guess',
    claim: "``LIFObuffer``'s ENABLE-GATED reset arrives here",
    correction: '``LIFObuffer`` does NOT arrive here',
    namesLifoBuffer: true,
  },
  {
    path: 'app/test/formal-prepass-vocabulary.test.ts',
    site: 'the header item naming the shape',
    claim: '`LIFObuffer` shape, 1 of 33 reset-bearing corpus references',
    correction: 'This is NOT the `LIFObuffer` shape',
    namesLifoBuffer: true,
  },
  {
    path: 'app/test/formal-prepass-vocabulary.test.ts',
    site: 'the comment on the no-reset-entry case',
    claim: 'The `LIFObuffer` shape (Req 14.19)',
    correction: "NOT the `LIFObuffer` shape: that design's enable-gated reset derives",
    namesLifoBuffer: true,
  },
  {
    path: 'app/test/formal-reset-contract-derivation.property.test.ts',
    site: 'the row-share table',
    claim: "`LIFObuffer`'s shape, `posedge`",
    correction: "`asyn_fifo`'s shape, `posedge`",
    namesLifoBuffer: true,
  },
]);

/** One comment as the record carries it, after the file was re-read. */
export interface ResetClaimReading extends ResetClaimComment {
  /**
   * Whether the refusal claim is still in the file.
   *
   * `false` means the comment no longer claims the refusal, which the record reports rather than
   * treating as a current claim.
   */
  readonly present: boolean;
  /** Whether the text that replaced the claim is in the file. */
  readonly corrected: boolean;
}

/** Re-read every comment, reporting which claims are still live and which were corrected. */
export function readResetClaims(
  readFileText: (path: string) => string | null,
): readonly ResetClaimReading[] {
  return RESET_CLAIM_COMMENTS.map((comment) => {
    const text = readFileText(comment.path);
    return {
      ...comment,
      // An unreadable file is not a corrected comment, so both fields fail safe: the claim reads
      // as still standing and the correction as not found.
      present: text === null ? true : text.includes(comment.claim),
      corrected: text === null ? false : text.includes(comment.correction),
    };
  });
}
