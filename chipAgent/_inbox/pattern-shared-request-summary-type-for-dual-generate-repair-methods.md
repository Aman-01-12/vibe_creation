---
type: pattern
title: Pick<> a request-summary type when two sibling methods share private helpers but take different request shapes
status: candidate
provenance: testbench-repair-loop spec, task 4.2 (TestbenchAgent#repairTestbench)
tags: [hdl, verification, testbench-agent, typescript, repair-loop]
timestamp: 2025-06-17T19:41:00Z
verifiedBy: 
---

# Pattern

When a new method (`repairTestbench`) needs to reuse an existing method's
(`generateTestbench`) private helpers (`#validateCoverage`, `#fail`, `#record`,
`#recordGenerated`, `#recordCoverageGap`) verbatim, but the two methods take
different request types (`GenerateTestbenchRequest` vs `RepairTestbenchRequest`),
retype the shared helpers' request parameter to a `Pick<...>` of only the fields
they actually read, instead of widening to a union or duplicating the helpers.

```ts
type TestbenchRequestSummary = Pick<GenerateTestbenchRequest, 'sessionId' | 'spec' | 'testbenchId'>;
```

Both request types satisfy this structurally (TS structural typing), so no cast,
no `any`, no duplicated helper body, and no coupling of the helper to whichever
concrete request type happens to be broader.

# When to use

Two call sites need the identical downstream gate/record logic (here: "hold a
repaired testbench to the exact same coverage gate and Trace-recording discipline
a first draft gets" - Req 6.3) but arrive with structurally different request
objects. Reach for this before widening a helper's parameter type to a union or
copy-pasting the helper for the second call site.

# Recipe / example

1. Diff the two request types; find the fields the shared helper(s) actually read.
2. Define `type XSummary = Pick<WiderRequest, 'field1' | 'field2' | ...>`.
3. Retype every shared private helper's request parameter to `XSummary`.
4. Confirm both concrete request types are structural subtypes of `XSummary`
   (if either is missing a field, either add it or don't include it in the Pick).

# Pitfalls

- Only works when the helpers never need a field unique to one request type. If
  `repairTestbench`-only logic needs `request.hint` inside a shared helper, this
  pattern breaks down and the helper needs its own repair-specific parameter or a
  branch.
- Don't widen to `GenerateTestbenchRequest | RepairTestbenchRequest` instead - that
  forces every helper body to narrow/discriminate for no benefit when a `Pick` of
  the common fields is sufficient and simpler.

# Links

- `app/agent/roles/testbench/testbench-agent.ts` (`TestbenchRequestSummary`)
- `.kiro/specs/testbench-repair-loop/design.md` section 5 (`TestbenchAgent#repairTestbench`)
