---
type: gotcha
title: The `#` guard in sized-literal.ts declines on the right side, but for a reason iverilog does NOT confirm - and the signed marker it dropped was a real meaning change
status: candidate
provenance: testbench-dialect-normalization group 16 (app/agent/orchestrator/dialect/sized-literal.ts, Property 8 turned green)
tags: [gotcha, dialect-normalizer, sized-literal, iverilog, measured, decline-reporting, signedness, app-agent]
timestamp: 2025-06-19T15:30:00Z
verifiedBy:
---

# What was measured

All with `iverilog -g2012` (Icarus 13.0), each case compiled ALONE, and run under `vvp` wherever
meaning rather than syntax was the question.

| source | context | verdict |
| --- | --- | --- |
| `#8'd-1 acc = 1;` | delay | REJECTED (`Syntax in assignment statement l-value`) |
| `#(-8'd1) acc = 1;` | delay | compiles; DELAYS, simulation time 0 -> 255. NOT read as an override |
| `#(8'd-1) acc = 1;` | delay | REJECTED |
| `dut #(8'd-1) u0();` | override | REJECTED (`Syntax error in parameter value assignment list`) |
| `dut #((-8'd1)) u0();` | override | compiles; parameter receives -1 |
| `dut #(-8'd1) u0();` | override | compiles; parameter receives -1 - IDENTICAL to the rewritten form |
| `dut #8'd1 u0();` | instantiation | REJECTED - no legal bare `#<sized literal>` instantiation form |
| `and #8'd1 g0(y,a,b);` | gate delay | REJECTED - nor a legal bare gate delay |
| `and #(8'd1) g0(y,a,b);` | gate delay | compiles |
| `16'sd-1` | expression | REJECTED |
| `(-16'sd1) < 0` | expression | compiles; **1**, and `$signed(-16'sd1)` prints **-1** |
| `(-16'd1) < 0` | expression | compiles; **0**, and prints **65535** |
| `(-16'Sd1)`, `(-16'sD1)`, `(-16'SD1)` | expression | all compile, all signed |

# What that settles, and what it does not

**The `#` guard's stated rationale does not survive measurement.** The claim under test was that
rewriting `#8'd-1` to `#(-8'd1)` CREATES a `#(` sequence, and that `#(` is the parameter-override
token sequence, so declining is correct. The first half is true; the second half does not hold in a
statement position. `#(-8'd1) acc = 1;` compiles and DELAYS - an override only follows a module
name, so `#(` after a statement boundary is unambiguously a delay control. And there is no legal
bare `#<sized literal>` in ANY position (not an instantiation, not a gate delay), so the input the
guard declines never compiles today and no working meaning can be flipped by rewriting it.

**The guard is nonetheless on the safe side, and was LEFT UNCHANGED.** Removing it would change the
SET OF REWRITES, which is its own `NORMALIZER_VERSION` decision and its own config-hash consequence.
It is now a measured-but-undecided question rather than an unexamined assumption. Note the semantics
if it is ever removed: `#(-8'd1)` delays **255**, not 1 and not -1, because `-8'd1` is an 8-bit
unsigned negation. The same bit pattern reaches an override as -1 only because the receiving
parameter is declared `signed`, so the rewrite's textual preservation is consistent in both
positions - the interpretation is the receiving context's, not the transform's.

**The other side of the guard was already right, and repairs rather than touches.**
`dut #(8'd-1) u0();` is rejected today; the rewritten `dut #((-8'd1)) u0();` compiles and delivers
the same -1 the hand-written `dut #(-8'd1) u0();` does. The extra paren nests inside an override
that was already there rather than creating one.

**The dropped signed marker was a genuine meaning change, not a cosmetic one.** `(-16'sd1) < 0` is
1; `(-16'd1) < 0` is 0 and reads as 65535. A signed literal silently becoming unsigned can flip a
check's verdict, which is exactly the failure mode a testbench normalizer must not have. Fixed by
re-emitting the captured `[sS]?` run verbatim; all four case spellings were measured legal and
measured signed, so verbatim is safe and is the only spelling that preserves the input's character
runs.

# Fix / rule

Three fixes landed under `NORMALIZER_VERSION` 3 -> 4 (one bump covers the set):

1. The `#` branch returns a zero-width `SpanEdit` carrying a `declined` finding instead of `null`,
   so the decline is COUNTED. `null` is now strictly "this is not a site".
2. A new `DialectDeclineCause`, `rewrite-context-not-established`, because the value at a
   `#`-preceded site is determinable - it is `-1` in the plainest possible text - and filing it
   under `value-not-determinable` would make the per-reason decline count mis-attribute why the
   transform stood down. Named "not established" rather than "would create an ambiguity" precisely
   because the measurement above does NOT support an ambiguity claim.
3. `SIZE_PREFIX_PATTERN`'s group 2 is re-emitted.

Generalizable rule this adds to the folder's existing one: when a guard's comment and its code
disagree, MEASURE before believing either. Here the code was on the defensible side and the comment
named a mechanism the toolchain does not exhibit - so the fix was documentation plus reporting, and
the behaviour change the comment seemed to invite would have been the wrong move to make blind.

Only 2 of the 40 committed fixtures carry an `s` form at all (`9'sd`, `17'sd`) and NONE carries the
malformed signed-negative shape, which is why fix 3 moved no fixture pin (25 of 29 / 3 of 7 / 0 of 4
all held). Worth recording because an earlier probe reported "no `s` form in the population" - `s`
forms are present, just never in the shape the rewrite touches, and those are different claims.

# Links

- `app/agent/orchestrator/dialect/sized-literal.ts` (the `#` guard's measurement table now lives in its header)
- `app/agent/orchestrator/dialect/sized-literal.test.ts` (the fail-before known-answer cases)
- `app/agent/orchestrator/dialect/types.ts` (`rewrite-context-not-established`, and why it is not `value-not-determinable`)
- `app/test/dialect-decline-and-report.property.test.ts` (Property 8, now green; its `hash-preceded-literal` row asks for a STRICTER cause than it did while red)
- `chipAgent/_inbox/gotcha-hash-preceded-sized-literal-is-declined-silently-with-no-finding.md` (the note this one closes)
- `chipAgent/_inbox/gotcha-a-build-constant-bump-is-invisible-to-vitest-until-tsc-b-rebuilds-dist.md` (applied again for the 3 -> 4 re-pin)
