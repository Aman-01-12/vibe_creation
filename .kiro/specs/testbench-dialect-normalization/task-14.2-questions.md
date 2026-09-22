# Task 14.2 open decisions - the `unnamed-begin-declaration` rule does not fix the failure it was built for

Task 14.2 stopped before writing `app/test/dialect-fixtures.integration.test.ts`.
The reason is not an ergonomics problem and not a stub-harness problem.
One of the assertions the task requires is FALSE against the real toolchain, and it is the assertion the spec's "36 of 45" effect-size claim rests on.

Writing the suite as specified would produce a red gate.
Writing it with that assertion softened would produce a green gate that certifies a transform which does nothing, which is the exact failure mode group 14 exists to prevent.
So the decision is escalated here rather than absorbed.

## What was measured

Two probes, both against Icarus Verilog 13.0 (stable) with `-g2012`, the same flag the worker already passes.

### Probe 1 - the language fact, five minimal cases

Each case is one file, compiled alone with `iverilog -g2012 -t null`. No stub, no DUT, so the result is a pure PARSE fact.

| case | construct | exit | `syntax error` lines |
| --- | --- | --- | --- |
| a | unnamed `begin`, declaration FIRST in the block | 0 | 0 |
| b | NAMED `begin : blk`, declaration FIRST in the block | 0 | 0 |
| c | unnamed `begin`, declaration AFTER a statement | 2 | 1 |
| d | NAMED `begin : blk`, declaration AFTER a statement | **2** | **1** |
| e | declaration HOISTED to module scope | 0 | 0 |

Read (a) against (b): naming a block changes nothing, because iverilog already accepts a block-item declaration in an UNNAMED block.
Read (c) against (d): naming a block changes nothing there either.
The discriminator is the declaration's POSITION relative to the first statement, not whether the block carries a label.

`design.md` line 351 records the calibration as "iverilog 13.0 with `-g2012` accepts a declaration in `begin : label` and accepts it hoisted to module scope", and the vault note's calibration table records "declaration inside an UNNAMED `begin` -> syntax error / declaration inside a NAMED `begin : blk` -> compiles".
Both are case (b) versus case (e).
Neither is case (c), which is what the campaign actually captured.
The calibration varied the LABEL and attributed the effect to the label, while the variable that actually moved was the POSITION.

### Probe 2 - the 40 committed fixtures, before and after `normalizeDialect`

Same method: each fixture compiled alone with `iverilog -g2012 -t null`, so the missing DUT module cannot contaminate the reading. `NORMALIZER_VERSION` 2, the real compiled transform.

| class | fixtures | `observed.firstSyntaxErrorLine` reproduced locally | `syntax error` GONE after normalization |
| --- | --- | --- | --- |
| `unnamed-begin-declaration` | 29 | **29 / 29**, exact line match | **0 / 29** |
| `malformed-sized-literal` | 7 | 7 / 7, exact line match | 3 / 7 |
| `prose-as-statement` | 4 | 4 / 4, exact line match | 0 / 4 (correct - reported, never rewritten) |

Two things to read off that table.

The fixture capture and the ground truth are SOUND. All 40 reproduce their recorded `observed.firstSyntaxErrorLine` exactly, on this machine, today. Task 14.1's work is confirmed, and the before-half of task 14.2 is fully assertable.

The transform's effect on the largest class is ZERO. For all 29, the first `syntax error` after normalization sits on the identical line it sat on before. 25 of the 29 report `changed: true` with a rewritten finding, so the rule IS firing - it inserts its `: tbnorm_blk_<n>` label, and the parse error is untouched because the label was never the discriminator. The other 4 decline (`unbalanced-block` x3, `would-shadow-module-scope` x2, across 4 fixtures).

The `malformed-sized-literal` half behaves as the spec predicts: 3 rewritten and fixed, 4 declined and still failing, every decline `value-not-determinable`, which is the meaning-preserving outcome Requirement 5.7 demands.

So the honest effect size against these 40 fixtures is **3**, not 36. The `malformed-sized-literal` rule works. The `unnamed-begin-declaration` rule does not.

## Questions

### Q1 - What does task 14.2's assertion 3 become?

The task requires: "For each of the 29 `unnamed-begin-declaration` fixtures NORMALIZED, assert an outcome OTHER than `testbench-build-failed`."
Measured: 0 of 29 satisfy it.

| option | what the suite would assert | consequence |
| --- | --- | --- |
| **A (recommended)** | Land the suite NOW asserting measured reality: all 40 fail before; per-class fixed counts PINNED at 0/29, 3/7, 0/4; the 29 additionally asserted to still carry a `syntax error` at the SAME line. Then fix the rule under Q2 and flip the 0/29 pin in that task. | Gate goes green today on a true statement, and the pin is the thing that flips the moment a real fix lands. The suite becomes the regression test FOR the fix instead of a claim about it. Cost: the spec carries a documented "this class is unfixed" pin for one task cycle. |
| B | Fix the rule first (Q2), then write the suite once against the fixed transform, asserting the spec's original 29-of-29. | One suite, one truth, no pin to flip. Cost: task 14.2 stays blocked behind a new rule, a `NORMALIZER_VERSION` 2 -> 3 bump, and a third config-hash re-pin. |
| C | Drop `unnamed-begin-declaration` from the transform entirely; ship `malformed-sized-literal` alone; re-scope the effect-size claim to 7 of 45 (3 measured). | Smallest honest spec. Cost: abandons 29 of the 36 the spec was written to recover, and the 29 is the dominant class. |

Recommendation: **A**. It is the only option that puts a true assertion in front of the gate today, and the count pin is exactly the "a rule that silently stops firing changes a number" mechanism assertion 7 already asks for - it just starts at 0 instead of 29.

### Q2 - If the class is to be fixed, is HOISTING now the transform?

Probe 1 case (e) says hoisting the declaration to module scope compiles. Case (d) says naming does not. So hoisting is the only one of the two candidates that fixes the measured defect.

But `design.md`'s rejected-alternatives section and the vault note both rejected hoisting for a stated reason that is still true: hoisting WIDENS a scope, and two sibling blocks each declaring `integer i;` would alias into one shared module-scope `i` - a source that still compiles and still prints check lines while silently sharing a counter. That is a meaning change, and Requirement 5 forbids it.

So the choice is not "naming versus hoisting", it is "hoisting with a guard, or do not fix this class".

| option | rule | notes |
| --- | --- | --- |
| **A (recommended)** | Hoist, and DECLINE whenever the hoisted name is already declared at module scope OR declared in any other block in the file. | The existing `moduleScopeNames` computation plus a per-block declared-name pass gives the second half. `would-shadow-module-scope` already exists as a decline cause; this needs one sibling, e.g. `would-alias-sibling-block`. False declines only, never false rewrites - the same invariant `unnamed-begin.ts` already documents. |
| B | Hoist unconditionally. | Rejected: reintroduces the aliasing hazard the original decision correctly identified. |
| C | Keep naming, and additionally MOVE the declaration to the top of its own block (legal per case (b), scope unchanged, no aliasing possible). | Arguably the most meaning-preserving fix of all - the declaration stays block-local, so no scope widens. Cost: it is a MOVE, and Requirement 5.3's token preservation is currently satisfied "by construction" precisely because the rule only ever inserts. This option gives that up. Worth considering seriously if the founder weighs scope preservation above insert-only. |

Recommendation: **A**, with **C** as the genuinely competitive alternative. C preserves scope exactly and needs no aliasing analysis; A preserves the insert-only discipline but must reason about siblings. Whichever is chosen, the label insertion becomes dead and should be deleted rather than kept alongside.

### Q3 - Does the effect-size claim get restated in the spec and the vault note now?

Requirement 10.4's net-positive claim and the vault note's "36 of 45 are reachable by a deterministic source-to-source transform" are both downstream of the miscalibration.

Measured today: 3 of 40 committed fixtures are fixed; 7 of 45 are the reachable population if the `unnamed-begin` class stays unfixed; 36 of 45 is reachable only if Q2 lands.

Recommendation: restate both as a RANGE with the condition attached - "7 of 45 as shipped, 36 of 45 conditional on the unnamed-begin rule actually moving the declaration" - rather than leaving a bare 36 that a future session will read as measured. The vault note has already been extended with the correction (see Links); the spec documents are untouched and await this answer.

### Q4 - How should the suite build the Interface_Stub for a fixture?

Not a blocker, but it needs a recorded decision before the suite lands, because it is the one place the suite deviates from production.

`TestbenchPrecheck` derives its stub from a Spec-derived `ModuleInterface`. The fixtures instantiate 11 distinct RTLLM DUTs (`JC_counter`, `calendar`, `traffic_light`, ...), and neither the Specs nor the reference designs are committed - `.eval-corpus/` and `.eval-runs/` are both gitignored. With a stub that does not declare the instantiated module, iverilog reports `Unknown module type` AT a testbench line, which `attributedFiles` correctly attributes to the testbench, so the precheck returns `testbench-build-failed` for every fixture before AND after normalization. That would make the after-half vacuous.

| option | approach | notes |
| --- | --- | --- |
| **A (recommended)** | Assert at the PARSE level: compile each fixture alone through the real `SimulatorAdapter` and read whether a `syntax error` naming the fixture is present, cross-checked against the committed `observed.firstSyntaxErrorLine`. | This is what both probes above did, and it is the question the dialect classes are actually about. No stub, no fabricated interface, nothing derived from a reference design. Cost: it does not exercise `TestbenchPrecheck` itself, which the task text asks for. |
| B | Derive each fixture's `ModuleInterface` from the fixture's own instantiation: module name from the instantiated type, port names from the named connections, direction from whether the connected signal is the testbench's own `reg` or `wire`, width from that declaration's range. | Exercises the real `TestbenchPrecheck` as the task asks. Self-validating, since a wrong derivation fails the after-assertion. A prototype of this ran over all 40 and derived a usable interface for 38; 2 (`asyn_fifo`) use a shape the simple reader misses. Cost: roughly 80 lines of test-only Verilog reading, and the stub is fixture-derived rather than Spec-derived - a documented deviation from production. |
| C | Commit the 11 `ModuleInterface` values to `index.json`. | Simplest suite. Cost: their only available source is the gitignored reference RTL, which is the one thing task 14.1 deliberately refused to commit (Req 9.12). |

Recommendation: **A** for the fail-before / still-fails-after assertions, which are the load-bearing ones, plus ONE `TestbenchPrecheck` case over the smallest fixture with a hand-written interface, so the precheck path is still exercised end to end and named in the suite. That keeps the suite honest, keeps it off the gitignored corpus, and avoids a test-only Verilog parser whose failure mode is a confusing red gate rather than a real finding.

## Reproducing this

Both probes were throwaway scripts, run and deleted. To re-derive:

- Probe 1 is five ~6-line Verilog files and `iverilog -g2012 -t null` on each; the five constructs are the table's `construct` column verbatim.
- Probe 2 is: for each entry in `app/test/fixtures/dialect/index.json`, read the fixture, call `normalizeDialect` from `@app/agent`, and compile the raw and the normalized source each alone with `iverilog -g2012 -t null`, recording the first `instrument_control_tb.v:<n>: syntax error` line number for each.

Nothing in either probe depends on `.eval-runs/` or `.eval-corpus/`, so both re-run on a fresh checkout with iverilog installed.

## Links

- `app/test/fixtures/dialect/index.json` - 40 fixtures, all 40 reproducing their recorded `observed.firstSyntaxErrorLine`
- `app/agent/orchestrator/dialect/unnamed-begin.ts` - the rule that does not fix its class
- `app/agent/orchestrator/dialect/sized-literal.ts` - the rule that does (3 of 7)
- `design.md` line 351 - the calibration sentence that varied the label instead of the position
- `chipAgent/_inbox/gotcha-testbench-repair-near-zero-is-two-mechanical-dialect-classes-not-a-feedback-problem.md` - extended with this correction
- `chipAgent/_inbox/gotcha-classify-captured-artifacts-by-shared-class-not-by-nearest-finding-line.md` - the classification methodology gotcha captured alongside
