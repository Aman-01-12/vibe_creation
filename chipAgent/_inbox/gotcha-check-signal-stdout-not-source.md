---
type: gotcha
title: CHECK signals are parsed from simulation stdout, not from testbench source
status: candidate
provenance: task 13.6 (testbench signalling + known-answer example tests)
tags: [testbench, signalling, oracle, testing]
timestamp: 2024-06-13
---

# What happened

While writing example tests for the per-check `CHECK <name> PASS|FAIL` signalling (Req 7.6), I nearly asserted `parseCheckResults(testbench.source)` returned the checks.
It does not: the testbench source emits the signal via `$display("CHECK <name> PASS")`, so each line after trim starts with `$display(...)`, not `CHECK`, and the oracle reader returns `[]`.

# Root cause

`parseCheckResults` (in `@app/tools` `check-signalling.ts`) matches `^CHECK[ \t]+(\S+)[ \t]+(PASS|FAIL)$` against each trimmed line.
That contract is over the SIMULATION STDOUT produced at run time, not over the generated Verilog source.
The generation-side predicate over source is a different helper.

# Fix / rule

- To assert a testbench SOURCE contains an emission, use `sourceEmitsCheck(source, name)` (regex for `CHECK[ \t]+name\b` anywhere in the text).
- To assert the ORACLE reads a signal, feed `parseCheckResults` a stdout string of raw `CHECK <name> PASS|FAIL` lines (what `formatCheckLine` produces), never the testbench source.
- `formatCheckLine` <-> `parseCheckResults` is the round-trip that proves the signal is unambiguous; keep those two as the drift check.

# Links

- app/agent/roles/testbench/signalling.ts (formatCheckLine, sourceEmitsCheck)
- app/tools/simulator/check-signalling.ts (parseCheckResults)
- app/test/testbench-signalling-known-answer.test.ts
