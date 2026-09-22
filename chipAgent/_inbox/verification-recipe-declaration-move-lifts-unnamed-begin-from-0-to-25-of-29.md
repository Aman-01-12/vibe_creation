---
type: verification-recipe
title: The intra-block declaration MOVE lifts unnamed-begin from 0 of 29 to 25 of 29 - position, not the label, is the discriminator
status: candidate
provenance: testbench-dialect-normalization tasks 15.1-15.5 (app/agent/orchestrator/dialect/unnamed-begin.ts)
tags: [verification-recipe, dialect-normalizer, iverilog, verilog, declaration-move, fixtures, unnamed-begin]
timestamp: 2025-06-19T00:00:00Z
---

# What this verifies

Keeping the `: tbnorm_blk_<n>` label and ADDING a move of each block's block-item declarations to
the top of that same block takes the `unnamed-begin-declaration` class from **0 of 29** committed
fixtures fixed to **25 of 29**, measured through the real toolchain.

The 4-fixture residue is fully explained and enumerated, not slippage:

- 3 declined `unbalanced-block` (two use C-style `}` instead of `end`, one is a bare prose `CHECK`
  line, so a `begin` never finds its `end`)
- 1 declined `declaration-not-relocatable` (`genvar i;` in a function body; `genvar` is rejected as
  a block item at ANY position)

Against the fixtures this class can own, 25 of 25.

Also measured on the same 29: code-token multiset of output equals input 29 of 29 (sole addition
the inserted labels) and the comment multiset is unchanged 29 of 29. Zero
`would-shadow-module-scope` declines remain.

# Independent oracle (never the model)

Icarus Verilog 13.0 with `-g2012`, reached through the real `SimulatorAdapter`, one fixture compiled
ALONE (`simulate([], file, limits)`), reading the PRESENCE of a `<path>:<line>: syntax error` line
and never the exit code. Recipe unchanged from
`verification-recipe-dialect-fixtures-parse-alone-through-simulatoradapter-pins-0-of-29.md`.

# Steps

Four detection defects had to be fixed BEFORE the move was correct. Each one was written as a
failing assertion first, in `app/agent/orchestrator/dialect/unnamed-begin.test.ts`; all 12 failed
on the pre-fix code.

1. `declaredNamesAfter` read a parameterized range BOUND as the declared name, because
   `WIDTH-1` is identifier-shaped: `reg [WIDTH-1:0] a;` returned `[WIDTH]`. Fix: blank bracketed
   spans via `SourceMask.bracketDepth` in the same pass that blanks comment spans. `bracketDepth`
   was exactly the right existing tool - no new scan. Effectiveness is 25 of 29 with this fix and
   24 of 29 without, because the same reader builds `moduleScopeNames`, so the error sat on both
   sides of the `would-shadow-module-scope` comparison.
2. A declaration at code-PAREN depth > 0 is a `for` header, not a block item.
   `SourceMask.bracketDepth` is `[...]` only, so paren depth is computed locally (one linear pass,
   same open/close convention as `scanSource`). Without it, the move produced
   `for ( i < 86400; i = i + 1)` and dropped 25 -> 20.
3. "Is a statement before this declaration" must be decided over CODE CHARACTERS, not tokens:
   `#10;`, `@(posedge clk);`, `->ev;` and a bare `;` carry no identifier-shaped token, so a token
   reading judged those declarations already first. Decided with `followingCodeOffset` (the shared
   skip-whitespace-and-comments walk), with a cursor advanced past each earlier declaration span of
   the same block. Raised 24 -> 25.
4. `genvar` gets its own `NON_RELOCATABLE_KEYWORDS` set and stays IN `DECLARATION_KEYWORDS`:
   that set answers a detection question shared with `normalizer.ts`'s module-scope reader, where
   `genvar` is legal and must keep contributing a name. Removing it would make the block invisible
   rather than declined.

Shape decisions worth not re-deriving:

- A block whose declarations ALREADY precede its first statement is not a site and is left
  byte-identical - no label either. The label is measured to buy nothing from the oracle (accepted
  named or unnamed), so touching such a block is a diff with no gain.
- The shadow check runs BEFORE the "does anything need moving" gate, so a shadow hazard is still
  named on a block that needed no move. False declines only, and it keeps the existing
  `dialect-comments-are-whitespace` regression green.
- EVERY declaration of a site block is relocated, including one already sitting first. Relocating
  only the displaced ones would reorder them against the ones left behind.
- A moved block emits n + 1 `rewritten` findings (the block, plus one per place text was cut from),
  so a per-block finding count of 1 is the wrong assertion shape.
- The move is the first rule to REMOVE a span, which broke the "edits never overlap" invariant
  right-to-left splicing depends on: a malformed sized literal in a declaration initializer puts a
  narrow rewrite inside a wide removal, and splicing the narrow one first makes the wide one's
  recorded `end` stale. `normalizer.ts` gained `withoutEnclosedEdits` - the wider edit wins,
  because its replacement text already embeds the narrow span's original bytes. Measured at 0
  collisions across all 40 fixtures, so it is insurance for live campaign output, not a fixture fix.

# Anti-circularity note

`observed.firstSyntaxErrorLine` is ground truth from the campaign's iverilog; the fixed/not-fixed
verdict is this machine's iverilog, not our own opinion. The 27 remaining failures in
`app/test/dialect-fixtures.integration.test.ts` are the 0-of-29 pin and the 25 per-fixture
"still fails at the same line" assertions the fix correctly invalidates, left RED on purpose as the
input to the re-pin task - the same discipline the config-hash re-pins used.

One tally difference recorded rather than smoothed over: the spec's probe counted 26 blocks needing
a move and 19 carrying more than one declaration; this implementation moves 25 blocks, 17 of them
multi-declaration. The OUTCOME matches exactly (25 of 29, same residue), so the difference is in
what the probe counted as a block's declaration - most likely a `for`-header `integer`, which
task 15.2 exists to exclude.

# Links

- app/agent/orchestrator/dialect/unnamed-begin.ts
- app/agent/orchestrator/dialect/unnamed-begin.test.ts
- app/agent/orchestrator/dialect/normalizer.ts
- app/test/dialect-fixtures.integration.test.ts
- .kiro/specs/testbench-dialect-normalization/design.md
- chipAgent/_inbox/verification-recipe-dialect-fixtures-parse-alone-through-simulatoradapter-pins-0-of-29.md
- chipAgent/_inbox/pattern-verilog-adjacency-scans-must-continue-past-non-code-spans.md
