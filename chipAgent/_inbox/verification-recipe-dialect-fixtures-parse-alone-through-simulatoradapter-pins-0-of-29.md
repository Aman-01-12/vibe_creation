---
type: verification-recipe
title: Dialect fixtures verified by compiling each ALONE through SimulatorAdapter - pins 0/29, 3/7, 0/4
status: candidate
provenance: testbench-dialect-normalization task 14.2 (app/test/dialect-fixtures.integration.test.ts)
tags: [verification, verification-recipe, dialect-normalizer, integration-tests, iverilog, fixtures, parse-level, check-signalling]
timestamp: 2025-06-18T00:00:00Z
verifiedBy: npx tsc -b --force; npx eslint app --max-warnings=0; npx prettier --check .; npx vitest run (1847 passed / 6 skipped / 0 failed); npm run build
---

# What this verifies

The 40 committed fixtures in `app/test/fixtures/dialect/` all FAIL before normalization at their
committed `observed.firstSyntaxErrorLine` (40 of 40, exact line match), and the transform's
per-class effect is PINNED at 0 of 29 `unnamed-begin-declaration`, 3 of 7
`malformed-sized-literal`, 0 of 4 `prose-as-statement`.

The 0 of 29 reproduced independently here, so the measurement in
`.kiro/specs/testbench-dialect-normalization/task-14.2-questions.md` is confirmed, not assumed.
It is a DOCUMENTED KNOWN-FAILING state against Requirement 9.5, not a passing claim: the rule
fires on 25 of 29 and the first `syntax error` lands on the identical line before and after.

# Independent oracle (never the model)

Icarus Verilog 13.0 with `-g2012`, reached through the real `SimulatorAdapter`
(`realOracleAdapter()` -> `SandboxToolRunner` -> `LocalWorkerRuntime` -> the Python worker ->
`iverilog -g2012`). No fake simulator twin: the fact under test IS the parser's verdict, so a
fake would be asserting a hand-written answer about Verilog syntax.

# Steps

- Compile each fixture ALONE: `simulate([], file, limits)` with an EMPTY rtl list. No stub, no
  DUT, so the reading is a pure PARSE fact. The verdict is always `error` (the instantiated DUT
  does not exist) and is therefore never read - only `verdict.stderr` is.
- `.eval-corpus/` and `.eval-runs/` are gitignored, so no Spec and no reference design exists for
  the 11 RTLLM DUTs. With a non-matching stub, iverilog reports `Unknown module type` AT a
  testbench line, `attributedFiles` correctly attributes it to the testbench, and
  `TestbenchPrecheck` answers `testbench-build-failed` both BEFORE and AFTER normalization - the
  whole after-half goes vacuous. Parse-level is structural, not convenience.
- Read the PRESENCE of a `<submittedPath>:<line>: syntax error` line, never the exit code: a
  rejected parse was observed exiting 1, 2, and 4 across these fixtures.
- Do all 80 compiles in ONE `beforeAll` into a `Map`, then let each `it` assert off the table.
  Each phase then compiles exactly once and the count pins are independent assertions.
- Keep ONE `TestbenchPrecheck` case, over the smallest fixture with a HAND-WRITTEN
  `ModuleInterface`, and anchor it with `runWithDiagnostic`: asserting
  `diagnostic.sourceLine.lineNumber` is the fixture's own error line proves the stub matched and
  the refusal is the real defect rather than `Unknown module type`. Deriving 40 interfaces from
  the fixtures' own instantiations was rejected - a test-only Verilog parser whose failure mode
  is a confusing red gate rather than a real finding.

# The defect this recipe cost, worth not repeating

"Every check name in the fixture survives the transform" was first written with a hand-rolled
enumerator, `CHECK\s+(\S+)\s+(?:PASS|FAIL)\b`, and then graded with the production predicate
`sourceEmitsCheck`. Three of 40 went red, and none of them was a real loss:

- `CHECK ac1_produces_the: PASS;` captured the name WITH its trailing colon; `sourceEmitsCheck`
  ends in `\b`, which needs a word character before it, so the predicate cannot find `name:`.
- a comment quoting the convention, `// the prompt asks to print "CHECK <name> PASS/FAIL"`,
  captured the literal `<name>`, which the same `\b` rejects.
- `CHECK ac1_produces_the: <long prose> PASS` (our own prompt prose emitted as a statement)
  matched nothing at all, so the fixture enumerated ZERO names and the non-vacuity guard fired.

Root cause: two grammars for one question. Fix: enumerate with the PREDICATE'S grammar -
`CHECK[ \t]+([A-Za-z0-9_$]+)` - and assert the INPUT side too, so a disagreement between the two
graders fails as a test defect instead of masquerading as a dropped check.

`readCheckSignals` is the WRONG owner for this question: it parses a run's STDOUT and anchors
`CHECK` at the start of a line, so `$display("CHECK <name> PASS");` inside a SOURCE matches
nothing and every such assertion passes vacuously. `sourceEmitsCheck` is the owner for source.

# Anti-circularity note

`observed.firstSyntaxErrorLine` is GROUND TRUTH - iverilog reported it during the campaign,
external to us - and `classified.dialectClass` is the TOOL'S LABEL. The suite asserts against
both, so it never tests the tool against its own opinion. Nothing it reads comes from a reference
design; no reference observation was added to the repository's test inputs.

# Links

- app/test/dialect-fixtures.integration.test.ts
- app/test/fixtures/dialect/index.json
- .kiro/specs/testbench-dialect-normalization/task-14.2-questions.md
- chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md
- chipAgent/_inbox/real-oracle-integration-dual-trajectory-pattern.md
