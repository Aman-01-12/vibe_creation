// The shared type vocabulary for every Dialect_Normalizer module (design.md Component 2).
//
// WHY THIS FILE IS SEPARATE FROM `normalizer.ts`
//   `normalizer.ts` imports `planUnnamedBeginLabels`, `planSizedLiteralRewrites`, and
//   `findProseAsStatements` from the three rule modules, and each rule module needs
//   `DialectClass` / `DialectFinding` / `DialectDeclineCause` / `SpanEdit`. A rule module
//   importing those types back from `normalizer.ts` would be a circular import. This file has
//   no dependency on any rule module or on `normalizer.ts`, so it is the one safe common
//   ancestor: `normalizer.ts` and all three rule files import from here, and `normalizer.ts`
//   re-exports these types for external consumers per design.md's public surface (Req 4.4).
//
// No logic lives here, only the closed vocabulary every rule and the report are built from.

/** The closed vocabulary of mechanical defect classes the normalizer names (design.md Component 2). */
export type DialectClass =
  | 'unnamed-begin-declaration'
  | 'malformed-sized-literal'
  | 'prose-as-statement'
  | 'model-dump-task';

/** Why one site was left alone; closed, so a new reason cannot arrive as prose. */
export type DialectDeclineCause =
  | 'value-not-determinable' //  `9'di`, `{1'b0, 64{1'b1}}`
  | 'would-shadow-module-scope' //  Req 5.4
  | 'unbalanced-block' //  `begin` with no matching `end` inside the scanned region
  | 'declaration-not-relocatable' //  `genvar`: rejected as a block item at ANY position
  | 'rewrite-context-not-established' //  `#8'd-1`: the VALUE is plain, the ADJACENCY is not cleared
  | 'reported-only'; //  prose-as-statement: detected by contract, never rewritten

// WHY `rewrite-context-not-established` IS A SEPARATE CAUSE FROM `value-not-determinable`
//   The two answer different questions, and collapsing them would make the report say something
//   false. `value-not-determinable` is a claim about the SITE'S OWN TEXT: `9'di` carries no
//   intended value, so no rewrite exists to perform. A `#`-preceded `8'd-1` carries an entirely
//   plain value; what the rule has not established is that emitting the parenthesized form is
//   safe in THAT ADJACENCY. Filing the second under the first would report "we could not tell
//   what this meant" about a literal whose meaning is unambiguous, and the per-reason decline
//   counts Requirements 1 through 3 exist to make trustworthy would then mis-attribute why the
//   transform stood down. The name is phrased as "not established" rather than "would create an
//   ambiguity" because the hazard is what this transform has not cleared, not a property the
//   toolchain was measured to have (see `sized-literal.ts`'s `#` guard for that measurement).

/** One thing a rule did, or refused to do, at one place in the source. */
export interface DialectFinding {
  readonly dialectClass: DialectClass;
  /** 1-based line of the site, from `SourceMask.lineStarts`. */
  readonly line: number;
  /**
   * Whether the site was rewritten or deliberately left alone.
   *
   * `declined` is a first-class outcome, not a failure: a rewrite the normalizer cannot
   * perform without changing meaning is reported rather than attempted.
   */
  readonly action: 'rewritten' | 'declined';
  /** Why a declined site was declined; absent on a rewritten one. */
  readonly declinedBecause?: DialectDeclineCause;
}

/** One planned edit over the ORIGINAL source offsets. */
export interface SpanEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly finding: DialectFinding;
}
