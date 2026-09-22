---
type: pattern
title: A Verilog adjacency scan must `continue` past non-code spans, because a comment is whitespace
status: candidate
provenance: session implementing testbench-dialect-normalization tasks 13.1-13.3
tags: [verilog, source-mask, dialect-normalizer, adjacency-scan, false-rewrite, pattern]
timestamp: 2025-09-22T02:10:00Z
---

# Pattern

Any scan of the form "which token is adjacent on this side" over a Verilog source must treat a comment, a string, and a directive span as WHITESPACE, i.e. `continue` past it, never stop at it.
In Verilog a comment is lexically equivalent to whitespace and is stripped before the parser sees the token stream, so a scan that stops at a comment is answering a different question than the parser answers.

Two shared helpers now own that walk, both in `app/tools/verilog/source-mask.ts` next to `scanSource` / `SourceMask` / `sourceLineAt`:

- `precedingCodeOffset(source, mask, beforeOffset): number | null`
- `followingCodeOffset(source, mask, fromOffset): number | null`

`dialect/` reaches them through `@app/tools` (it may never import `@app/eval`).

# When to use

Any time you need "the nearest real token before/after offset N" in `dialect/` or a future Verilog rewriter.
Do not spell the walk again; call the pair. `sized-literal.ts` keeps a two-line character-valued adapter (`precedingCodeCharacter`) over `precedingCodeOffset` because its call sites compare characters.

# Recipe / example

```ts
// named-block test: `begin // c` newline `: blk` IS a named block (iverilog 13.0 -g2012, exit 0)
const offset = followingCodeOffset(source, mask, beginEnd);
return offset !== null && source.charAt(offset) === ':';
```

Reading a declared NAME out of a span needs the same rule, but blanking rather than skipping: `codeOnlyText` (in `unnamed-begin.ts`) rebuilds `[start, end)` with every non-code character replaced by a SPACE.
Deleting instead of blanking would join the tokens on either side, so `reg a/*x*/b;` would read as the single identifier `ab`.

# Pitfalls

Three real defects, all one root cause, all found AFTER the rules had landed and all gate-clean at the time:

1. `prose-as-statement.ts` walked raw text, landed on a comment's last character, then a `mask.code[...] !== 1` guard returned `false`. Cost: the Prose_As_Statement site was MISSED whenever a comment intervened. Live in captured data - 4 samples in `.eval-runs/stage1-screen-repair-v1`, all `qwen.qwen3-coder-30b-a3b-instruct`, each a `// Final check` line immediately before a bare `CHECK <name> PASS;`.
2. `unnamed-begin.ts`'s `isAlreadyNamed` used `mask.code[index] === 1` as a LOOP CONJUNCT, so the walk exited at the comment and judged an already-named block unnamed. Cost: a confirmed FALSE REWRITE - ` : tbnorm_blk_1` inserted after `begin`, turning an input iverilog accepts at exit 0 into output it rejects at exit 2 (`syntax error` plus `Malformed statement`). Reproduced locally against real iverilog through `TestbenchPrecheck`, both the line-comment and block-comment variants.
3. `declaredNamesAfter` existed in TWO near-duplicate copies (`unnamed-begin.ts` and `normalizer.ts`), both slicing the RAW body, so `reg /*x*/ a;` yielded the declared name `x` rather than `a` and defeated the Requirement 5.4 `would-shadow-module-scope` decline. Collapsed to ONE exported owner in `unnamed-begin.ts` - `normalizer.ts` already imported `DECLARATION_KEYWORDS` from there, so no new import edge and no new shared module were needed.

A `mask.code` check belongs in the `continue` guard, never in the loop CONDITION. That single shape difference is what separated the two broken walks from the four correct ones (`sized-literal.ts`'s `precedingCodeCharacter`, and `precedingOperandCharacter` / `conditionOpenParen` / `matchingCloseParen` in `app/eval/corpus/verilog-mutation.ts`).

`verilog-mutation.ts`'s three walks were deliberately left alone: they are already correct, and their `WHITESPACE` Set is not byte-identical to `/\s/`, so swapping them onto the shared pair would be a behaviour change to a calibrated module rather than a refactor.

The surviving `declaredNamesAfter` keeps the NON-GLOBAL `FIRST_WORD_TOKEN` regex and its explanation - see `[[gotcha-shared-global-regex-lastindex-infinite-loop]]`. It is called from inside two different outer `/g` token scans, so a `/g`-with-`lastIndex`-reset form would hang the whole suite. Deleting `unnamed-begin.ts`'s old `/g` `IDENTIFIER_TOKEN` also removed the "safe only by accident" second regex that note flagged.

# Links

- `app/tools/verilog/source-mask.ts`
- `app/agent/orchestrator/dialect/unnamed-begin.ts`
- `app/agent/orchestrator/dialect/prose-as-statement.ts`
- `app/test/dialect-comments-are-whitespace.test.ts`
- `.kiro/specs/testbench-dialect-normalization/design.md` - "Comments are lexically whitespace, and two adjacency scans did not know it"
- `[[gotcha-shared-global-regex-lastindex-infinite-loop]]`
