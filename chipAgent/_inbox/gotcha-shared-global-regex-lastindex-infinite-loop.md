---
type: gotcha
title: Sharing one module-level /g regex across nested scan loops hangs the whole vitest suite
status: candidate
provenance: session fixing app/agent/orchestrator/dialect/normalizer.ts
tags: [regex, infinite-loop, vitest-hang, dialect-normalizer, gotcha]
timestamp: 2025-01-01T00:00:00Z
---

# What happened

`npx vitest run` never completed (killed after 5+ minutes against a 39-second baseline).
No assertion failure, no output - a synchronous hang, so vitest's own `testTimeout` could not interrupt it.
Root file: `app/agent/orchestrator/dialect/normalizer.ts`.

# Root cause

One module-level regex with the `/g` flag was shared by three functions:

```ts
const WORD_TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;
```

`moduleScopeNamesOf` drove a `while (WORD_TOKEN.exec(source))` loop that depends on `lastIndex` advancing.
From inside that loop it called `declaredNamesAfter`, which did `WORD_TOKEN.lastIndex = 0` and `exec` on a DIFFERENT string.
Control returned to the outer loop with `lastIndex` rewound, so the outer scan restarted from offset 0 forever.
A `/g` regex object carries mutable `lastIndex` state; sharing the object couples every scan site that touches it.

Reproduced in isolation:

```
node -e '... while loop that resets lastIndex mid-scan ...'
-> "still scanning after 50 iters, lastIndex=1"
```

The bug only fires when a `DECLARATION_KEYWORDS` token sits at block depth zero, e.g.

```verilog
module m;
  reg a, b;
  integer i;
endmodule
```

# Fix / rule

Never share a mutable `/g` regex across functions or loops. Each scanning site owns its regex, or avoids `exec`-loop state:

- `moduleScopeNamesOf` - `for (const match of source.matchAll(tokens))` with `tokens` a LOCAL `/g` literal. Fresh instance per call, no cross-call state.
- `declaredNamesAfter` - non-global `/[A-Za-z_$][A-Za-z0-9_$]*/` with `.exec(...)`. It only needs the first identifier per comma-separated entry, and a non-global regex has no `lastIndex` at all, so the hazard is removed by construction rather than by careful resetting.
- `takenIdentifiersOf` - `matchAll` with its own local instance, so a future edit cannot reintroduce the coupling.
- Deleted the shared `WORD_TOKEN` constant so no future caller can pick it back up.

Each site carries a comment naming the hazard so this cannot regress silently.

Note: `app/agent/orchestrator/dialect/unnamed-begin.ts` has the same nested-scan structure but is accidentally safe - it uses TWO separate regex objects (`CODE_TOKEN` outer, `IDENTIFIER_TOKEN` inner). Benign today, fragile by accident; do not collapse them into one.

Debugging rule learned: a hanging vitest suite is a blocking defect, not an environment quirk.
`pkill -9 -f vitest` first (a previous hung run keeps burning CPU), then bisect by directory (`npx vitest run app/agent`, then `app/eval`, then `app/test`).
macOS has no `timeout` binary by default, so a hard wall-clock cap needs `gtimeout` or a background-and-kill pattern.

# Links

- `app/agent/orchestrator/dialect/normalizer.ts`
- `app/agent/orchestrator/dialect/unnamed-begin.ts`
- `.kiro/specs/testbench-dialect-normalization/tasks.md`
