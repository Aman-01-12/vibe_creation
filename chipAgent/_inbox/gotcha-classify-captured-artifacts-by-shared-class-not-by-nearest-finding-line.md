---
type: gotcha
title: Do NOT classify a captured artifact by which finding's line is nearest the compiler's error line - a block-scoped rule reports at the block's opening while the parser stalls deep inside it
status: candidate
provenance: testbench-dialect-normalization task 14.1 classification of 45 stage1-screen-repair-v1 samples; cost two script iterations; the decisive case is qwen.qwen3-235b-a22b-2507 / rtllm_arithmetic_multi_booth_8bit / sample-1, verified against the real compiled normalizeDialect (NORMALIZER_VERSION 2) and the sample's own control-stderr.txt
tags:
  [
    classification,
    measurement,
    methodology,
    dialect-normalizer,
    iverilog,
    fixtures,
    eval,
    artifacts,
    dead-end,
  ]
timestamp: 2026-09-30T00:00:00Z
---

# What happened

Classifying 45 captured testbench samples into the three `DialectClass` values meant joining two independent things per sample: the findings a rule-based tool (`normalizeDialect`) reports, and the first `syntax error` line the compiler recorded in that sample's `control-stderr.txt`.

The obvious join is "pick the finding whose `line` is nearest the compiler's error line".

That rule is wrong, and it cost two script iterations to find out.

On `qwen.qwen3-235b-a22b-2507 / rtllm_arithmetic_multi_booth_8bit / sample-1` the single finding sits at **line 37** and iverilog's `syntax error` sits at **line 225**.
188 lines apart, and they are the SAME defect: both are inside one unnamed `initial begin`.
Any nearest-line rule either drops this sample as unclassifiable or, worse, attaches it to whatever unrelated finding happens to sit closer to 225.

# Root cause

The two line numbers answer different questions, and neither is wrong.

A BLOCK-SCOPED rule reports ONE finding per BLOCK, positioned at the block's OPENING token - that is where the edit would go, so that is the line it names.
The compiler's parser, meanwhile, accepts the block opening fine and stalls at the first token INSIDE the block that violates the grammar, which can be arbitrarily deep.

So for any block-scoped class, the distance between the finding's line and the error's line is roughly the distance from the block's `begin` to the offending statement.
That distance carries no information about whether the classification is right.
Treating it as a confidence signal is treating block size as evidence.

# Fix / rule

Classify by CLASS AGREEMENT first, and let line distance decide only when the class is genuinely ambiguous:

1. If every finding in the sample shares ONE `dialectClass`, that class is the sample's class - **unambiguous regardless of line distance**. No line comparison at all.
2. Only when findings span MULTIPLE classes does exact line-match against the compiler's first `syntax error` line decide which one the compiler actually stalled on.
3. A sample with no findings is unclassified residue. Read it by hand at its exact error line; do not force it into a class.

Over 45 real samples, rule 2 was needed exactly **once**. Rule 1 settled 44 of 45. Building the line-matching machinery first, and the class-agreement check second, is therefore backwards - the cheap check does almost all the work.

Second rule, equally load-bearing: **a DECLINED finding classifies exactly as well as a REWRITTEN one.**
Classification identifies the CLASS the defect belongs to. The rule's chosen ACTION (rewrite, or decline with a cause) is a separate decision about what is safe to do about it. Filtering to `action: 'rewritten'` before classifying silently drops every sample the tool correctly refused to touch - which, in this corpus, was 9 of the 40 classified samples.

# The trap this sets for a later task

A classification that says "these 29 samples are class X" is a claim about what the DEFECT is.
It is NOT a claim that the rule attached to class X fixes it.
Those are two separate measurements, and the second one needs the compiler, before and after.

That gap bit this exact corpus: all 29 `unnamed-begin-declaration` samples are correctly classified, and the transform fixes **0** of them.
See [[gotcha-testbench-repair-near-zero-is-two-mechanical-dialect-classes-not-a-feedback-problem]] ("Measured correction, task 14.2") for that measurement.
So classify by class agreement, then measure the fix separately against the real toolchain, and never let the first result stand in for the second.

# Links

- `app/test/fixtures/dialect/index.json` - the resulting index; `classified.byTieBreak` is `true` on exactly one of 40 entries
- `app/agent/orchestrator/dialect/unnamed-begin.ts` - the block-scoped rule that reports at the block opening
- [[gotcha-testbench-repair-near-zero-is-two-mechanical-dialect-classes-not-a-feedback-problem]]
- [[gotcha-a-candidate-note-was-factually-wrong-and-its-error-steered-a-strategy-decision]] - the same lesson one level up: an unverified count steering a decision
