// The identity of the Dialect_Normalizer's transform behaviour (Req 8.1, 8.7,
// 8.12; task 4.1).
//
// WHY THIS EXISTS
//   Whether the Dialect_Normalizer rewrites a given mechanical defect class in a
//   generated Testbench source is part of the experiment, not part of the
//   harness: change the set of rewrites, and a sample measured before the change
//   answers a different question than one measured after - the same reasoning
//   `testbench-repair-policy-version.ts` already applies to the testbench-repair
//   loop's behaviour.
//
// WHY A FOURTH CONSTANT AND NOT A BUMP OF `TESTBENCH_PROMPT_VERSION`,
// `INSTRUMENT_POLICY_VERSION`, OR `TESTBENCH_REPAIR_POLICY_VERSION`
//   Neither the Testbench_Agent's first-draft prompt, the instrument-admission
//   policy, nor the testbench-repair-loop's behaviour changed - only the set of
//   mechanical rewrites applied to the generated Testbench source did. Bumping
//   any of the three existing constants would make that constant's own pin
//   assert something false. This is a separate build constant for a separate
//   concern (`app/eval/sweep/config-identity.ts` folds it in under its own
//   reserved key, `__normalizerVersion`, mirroring `__testbenchRepairPolicyVersion`'s
//   precedent), so all four identities can never be conflated and each is a
//   one-line edit that cannot collide with an unrelated one.
//
// THIS CONSTANT IDENTIFIES THE TRANSFORM ALONE
//   It must change whenever the set of rewrites the Dialect_Normalizer performs
//   changes, so two runs reporting the same NORMALIZER_VERSION applied the same
//   transform. It must never be bumped to carry a `TESTBENCH_PROMPT_VERSION`
//   change, because `prompt-version.test.ts` pins a digest of the assembled
//   prompt against that separate constant.
//
// WHY 1 -> 2 (testbench-dialect-normalization group 13, Req 8.1, 8.7)
//   The SET OF REWRITES changed, which is exactly the case the contract above
//   says cannot pass silently. Group 13 made every adjacency scan treat a Verilog
//   comment as the whitespace it lexically is, and two rewrite decisions moved
//   with it: an already-named block carrying a comment between `begin` and its
//   `:` label is no longer rewritten (version 1 judged it unnamed and inserted a
//   second label, turning a source iverilog accepted into one it rejected), and a
//   declaration written with an interior comment, as in `reg /*x*/ a;`, that
//   shadows a module-scope name is now DECLINED under `would-shadow-module-scope`
//   rather than rewritten (version 1 read the declared name out of the raw body
//   and saw `x`). A third change - a bare `CHECK <name> PASS;` behind a comment is
//   now REPORTED under `prose-as-statement` - moves what the transform reports
//   rather than what it rewrites, and is recorded here for completeness. A sample
//   measured under version 1 therefore carries a different transform than one
//   measured under version 2, so their samples must never pool.
//
// WHY 2 -> 3 (testbench-dialect-normalization group 15, Req 8.1, 8.7)
//   The SET OF REWRITES changed again, and by much more than the 1 -> 2 move did. The
//   `unnamed-begin-declaration` rule no longer only INSERTS a `: tbnorm_blk_<n>`
//   label: it now MOVES that block's block-item declarations to the top of the same
//   block, which is the thing the parser actually reads (measured with `-g2012`, a
//   block-item declaration is accepted as the FIRST item of its block and rejected
//   after a statement, whether or not the block carries a label). Four further
//   rewrite decisions moved with it: a block whose declarations already precede its
//   first statement is no longer touched AT ALL (version 2 inserted a label there,
//   buying nothing from the oracle), a `genvar`-carrying block is now DECLINED under
//   `declaration-not-relocatable` (`genvar` is rejected as a block item at any
//   position, so no move can help), a `for`-header declaration is no longer treated
//   as a block item at all (`for (integer i = 0; ...)` is legal, and lifting the
//   `integer` out of the header was a false rewrite), and a parameterized range bound
//   is no longer misread as a declared name (`reg [WIDTH-1:0] a;` read as declaring
//   `WIDTH`), which removes a class of false `would-shadow-module-scope` declines. A
//   sample normalized under version 2 therefore carries a materially different
//   transform than one normalized under version 3, so their samples must never pool.
//
// WHY 3 -> 4 (testbench-dialect-normalization group 16, Req 8.1, 8.7)
//   The SET OF REWRITES changed, on one narrow axis: the sized-literal rule now PRESERVES the
//   signed-base marker it previously captured and dropped, so `16'sd-1` normalizes to
//   `(-16'sd1)` where version 3 emitted `(-16'd1)`. That is not cosmetic - measured under `vvp`,
//   `(-16'sd1) < 0` is 1 while `(-16'd1) < 0` is 0 and reads as 65535 - so a signed literal a
//   version-3 run silently unsigned could have flipped a check's verdict, and a sample carrying
//   an `s` form is not poolable across the boundary.
//
//   Two further changes ride this bump because one bump covers a set, and both are RECORDED here
//   rather than given their own constant because neither moves what the transform rewrites.
//   First, a `#`-preceded decimal literal is now REPORTED when it is declined: version 3 returned
//   `null` for that branch, which is also what it returned for "not a site", so the decline
//   produced no `DialectFinding` and the per-class decline count undercounted. The source was
//   byte-identical before and after this change; only the report gained the site, under a new
//   `rewrite-context-not-established` cause rather than a `value-not-determinable` one that would
//   have claimed the value was unreadable when it was `-1`. Second, that guard's doc comment was
//   corrected: it described the rule as declining "inside a parameter/delay override" when the
//   code declines where a rewrite would CREATE `#(`, which are different rules. `iverilog -g2012`
//   was re-measured on both sides of the guard and the guard's BEHAVIOUR was left unchanged, so
//   this one is documentation only and moves nothing a sample could see.
export const NORMALIZER_VERSION = 4;
