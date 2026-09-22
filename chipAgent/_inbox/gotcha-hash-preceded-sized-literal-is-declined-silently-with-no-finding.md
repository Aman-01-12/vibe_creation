---
type: gotcha
title: A `#`-preceded sized literal is declined SILENTLY - no finding, so the per-class decline count undercounts
status: candidate
provenance: testbench-dialect-normalization task 7.7 (app/test/dialect-decline-and-report.property.test.ts, Property 8)
tags: [gotcha, dialect-normalizer, sized-literal, accounting, decline-reporting, property-based, undercount, app-agent]
timestamp: 2025-06-19T12:00:00Z
verifiedBy:
---

# What happened

Property 8 ("a rewrite the transform cannot establish is declined and reported, never attempted")
was implemented as design.md states it, over all eight shapes it enumerates. Seven hold. The eighth
FAILS.

`planSizedLiteralRewrites` declines a decimal sized literal whose nearest preceding non-whitespace
CODE character is `#`. The source comes back byte-identical, which Property 8's first two conjuncts
require - and the report carries NO finding at all, which its third conjunct forbids.

Minimal reproducing input, whole source:

```verilog
module tbnorm_expr_tb;
  integer acc;
  initial begin : body
    #8'd-1 acc = 0;
  end
endmodule
```

Observed: `refusedWholeSource === null`, `findings === []`, `source` unchanged.
Expected by Property 8: one `malformed-sized-literal` finding with `action: 'declined'`.

The minimal PAIR that isolates it (same literal, one character of context apart):

```
module tb;\ninitial y = 8'd-1;\nendmodule\n       -> changed: true,  1 rewritten finding
module tb;\ninitial #8'd-1 y = 0;\nendmodule\n   -> changed: false, 0 findings
```

# Root cause

`planOneLiteral` returns `null` for the `#` branch. `null` is the same value it returns for "a
well-formed positive literal, nothing to report", so the two are indistinguishable downstream:
`planLiteralRewrites` only pushes non-null results, and a `DialectFinding` is only ever produced by
a returned `SpanEdit`. Every other decline in this folder rides a zero-width `SpanEdit` whose
`finding.action` is `'declined'` (see `declineFinding` in the same file, and `declinedFinding` in
`unnamed-begin.ts`); this branch is the one that does not.

Why it is not cosmetic: the per-class and per-reason decline counts that Requirements 1 through 3 of
this spec exist to make trustworthy are aggregated from these findings. A silently declined site is
an undercount of exactly the kind the 211-style accounting defect was - a campaign reports fewer
`malformed-sized-literal` declines than the transform actually made, and nothing downstream can
notice.

# Two adjacent observations found while pinning this, both measured, neither fixed

1. **The `#` guard fires on the DELAY position, not on the parameter-override position it
   documents.** The module comment says "the one place `(...)` is ambiguous is immediately after `#`
   (a parameter/delay override), so this rule declines there". But `precedingCodeCharacter` is read
   at the LITERAL's start, so in `dut #(8'd-1) u0();` the preceding character is `(`, not `#` - the
   guard does not fire and the literal IS rewritten to `dut #((-8'd1)) u0();`. Measured:
   `#8'd-1` declines, `#(8'd-1)` rewrites. Whether that is the wrong side of the ambiguity is a
   design question, not a bug report; it is recorded because the comment and the behaviour disagree.
2. **The signed-base marker is captured and dropped.** `SIZE_PREFIX_PATTERN` is
   `/(\d+)'([sS]?)([dD])/g` and the replacement re-emits groups 1 and 3 only, so `16'sd-1` would
   become `(-16'd1)` - signedness lost. Out of scope for the measured 8-sample population (it
   contained no `s` form) and therefore out of scope for Property 7, but it is a token change
   Property 2's multiset claim would also see.

# Fix / rule

NOT FIXED. A fix changes the rule's reporting behaviour, so it needs its own task, its own
`NORMALIZER_VERSION` decision, and its own config-hash consequence - and `NORMALIZER_VERSION`'s
stated contract is "must change whenever the set of rewrites changes", which a reporting-only change
arguably does not trigger. That judgement belongs in a task, not in a test.

The property is left RED rather than weakened. Weakening it to green would convert a real gap into a
passing regression test that defends it - the same trap group 13 avoided by fixing the false rewrite
BEFORE the fixtures froze it.

Rule for this folder going forward: a rule that decides not to rewrite a site it RECOGNISED must
return a zero-width `SpanEdit` carrying a `declined` finding, never `null`. `null` is reserved for
"this is not a site", and those two answers are not interchangeable because one of them is counted.

# Links

- `app/agent/orchestrator/dialect/sized-literal.ts` (`planOneLiteral`'s `#` branch, `declineFinding`)
- `app/test/dialect-decline-and-report.property.test.ts` (the red property, header records the same finding)
- `.kiro/specs/testbench-dialect-normalization/design.md` (Property 8; Component 4)
- `.kiro/specs/testbench-dialect-normalization/tasks.md` (tasks 4.3, 7.7)
- `chipAgent/_inbox/gotcha-stale-wired-in-task-comment-hid-repairprovenance-hardcoded-no-repair.md` (the same shape of accounting loss, found earlier in this spec)
