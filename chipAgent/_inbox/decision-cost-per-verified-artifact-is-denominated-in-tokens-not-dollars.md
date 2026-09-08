---
type: decision
title: Cost per verified artifact is denominated in TOKENS and WALL CLOCK, because dollars are not measured
status: candidate
provenance: founder request after the smoke sweeps reported `cost: UNKNOWN` with an empty `prices` table; implemented across app/agent/model-router and app/eval
tags:
  [
    eval,
    sweep,
    cost,
    cpva,
    tokens,
    measurement,
    honesty,
    model-router,
    session-budget,
    schema-version,
  ]
timestamp: 2026-09-07
---

# Decision

The bake-off's primary efficiency metric is now **tokens per verified artifact** and **wall clock per verified artifact**.
The dollar cost per verified artifact is an OPTIONAL secondary figure that appears only when every model in the arm is priced.

The distinction that forced it: the endpoint returns `usage.prompt_tokens` / `usage.completion_tokens`, and the runner observes the clock, so tokens and wall clock are MEASURED.
No endpoint returns money.
Cents are therefore a token count multiplied by an external rate card, and with `prices: {}` the summary had no cost metric at all - it printed `cost: UNKNOWN` and stopped, which defeated the point of running a bake-off.

The founder's instinct not to hardcode a vendor rate card was right; the mistake was letting the unmeasured figure be the ONLY figure.

## THE POPULATION INVARIANT (the thing to remember)

> Both per-artifact rates are computed over the SAME set of samples pass@k is computed over.

One `eligible` list is built in `summarizeArm` and handed to BOTH `armPassAtK` and `armEfficiency`.
So a sample excluded from pass@k - no oracle verdict, or an instrument the controls could not prove - contributes neither tokens to the numerator nor a verified artifact to the divisor.
Without that, an arm could improve its efficiency by producing samples pass@k refuses to count.
Pinned by a test that gives an instrument-invalid sample 900,000 tokens and asserts the rate does not move.

The arm-wide totals are reported too, on their own line, because an excluded sample was still PAID FOR.
Two populations, both named in the rendered output, so the division on the rate line is reproducible from the numbers printed beside it.

The DOLLAR cost/verified was deliberately left on its old, wider population (every recorded sample, ungated verified count).
Re-basing a number that has already been cited would make two reports disagree with no visible reason, so the rendered line names its population instead.

## A SILENT PROVIDER IS NOT A FREE ONE

`AttemptCost.tokenUsage` is a three-state field and the three states are the whole design:

- `{ kind: 'reported', promptTokens, completionTokens }` - a model call the provider metered.
- `{ kind: 'unreported' }` - a model call whose reply carried no usable `usage` block, or which failed outright. NOT summed, but COUNTED.
- ABSENT - the charge made no model call at all (a simulate iteration). Genuinely zero tokens, which IS a measurement.

`MeteredSessionBudget` sums the first, counts the second in `unreportedUsageCalls`, and ignores the third.
The summary then labels the totals a `FLOOR` whenever that count is non-zero.
Collapsing `unreported` into zero would let a host that stopped metering win the efficiency comparison outright.

`parseChatCompletionsReply` already did the boundary validation correctly (an absent or malformed `usage` comes back `undefined`, not zeros); what was missing was a channel to carry that absence past `ModelResult`, whose `tokensUsed: number` had no way to say "unknown". The old code even documented the gap in a comment.

## What was already captured versus what was added

- ALREADY MEASURED: `MeteredSessionBudget.consumed()` returned `tokens` and `wallClockMs`, and `SweepSampleRecord.durationMs` recorded per-sample wall clock.
- DISCARDED: `SampleResult` read only `consumed().costCents`. Tokens were metered every sample and thrown away one line later.
- NOT AVAILABLE AT ALL: the prompt/completion split, collapsed into `tokensUsed` inside the transport.

So wall clock needed no new field (`durationMs` is it), and tokens were threaded exactly the way `costCents` already was.

# Context / options considered

- Hardcode a rate card so CPVA always works. Rejected by the founder, and correctly: a vendor price list goes stale, and a stale number cited as measured spend is worse than no number.
- Keep dollars primary and just document that `prices` is required. Rejected: it makes the campaign's headline metric depend on a table nobody maintains, and the smoke runs proved the result is no metric at all.
- Report tokens per verified artifact over ALL recorded samples. Rejected: an arm could then dilute its rate with samples pass@k excludes, in either direction.
- Report ONLY the population totals. Rejected: excluded samples cost real tokens, and an operator asking "what did this arm burn" would get a number that understates the bill.
- Add a second wall-clock field for the budget-charged (loop-only) time. Rejected: `durationMs` is already measured and covers the whole slot. Two wall clocks means an operator has to choose which one the rate used; one, with its scope stated in the field's doc comment, does not.
- Thread the prompt/completion split into the CORE `SessionBudget`. Rejected: the caps are on the total, so core would gain state no cap consults. The split lives on the eval layer's measuring wrapper; the total still comes from core, so the one number both layers could disagree about has exactly one owner.
- Make `AttemptCost.tokenUsage` required. Rejected: ~20 test fakes and both `simulateCost` helpers charge without a model call, and absence has a real meaning there. The Model_Router NORMALIZES every model call to `reported` or `unreported` before charging, so downstream absence unambiguously means "not a model call".
- Represent unreported usage as `tokens: 0`. Rejected outright - that is the defect. A failed provider call is `unreported` for the same reason.
- Migrate v5 records by defaulting the token counts to 0. Rejected: the default would be the numerator of the headline number, and 0 tokens per verified artifact reads as infinite efficiency.
- Bump `ARTIFACT_DOCUMENT_SCHEMA_VERSION`. Not done: `outcome.json` mirrors verdict and evidence fields and has never carried `costCents` either, so no artifact shape changed.

# Rationale

- Denominate a metric in what the instrument actually reports. This is the same rule as "tools decide correctness", applied to cost: dollars are an inference over a configured table, tokens are a reading.
- `RESULTS_SCHEMA_VERSION` 5 -> 6 is a REFUSAL, not a migration, following the established precedent. `STALE_SCHEMA_ADVICE` now states both reasons a v5-or-older file cannot be aggregated: missing token counts, and the older `instrumentValidity: valid` meaning.
- The rewritten `UNKNOWN` message is the fix for a misreading, not a cosmetic edit. `cost: UNKNOWN (... set prices.<modelId> to measure spend and CPVA)` told an operator that cost could not be measured without prices - true when written, false now. It is now labeled `cost (dollars)`, states it is the ONLY unmeasured figure in the block, and points at the measured lines printed ABOVE it. The measured block is rendered first so `UNKNOWN` is never the first cost word on the page. The wording is pinned by a test for exactly that reason.
- Nothing about pass@k, `countsInPassAtK`, the instrument-validity gate, seeds, or the control verdicts changed. This is additive measurement, and the population invariant is what keeps it additive.

# Revisit trigger

- The first campaign with a non-zero `unreportedUsageCalls`. If a host routinely omits `usage`, the token figures for that arm are floors and the arm is not comparable on efficiency; the finding belongs to the transport, not to the model ranking.
- Arming a CI gate on efficiency. The baseline must be measured with the same population rule, or the ratchet ratchets against a different denominator.
- If the dollar cost/verified is ever wanted on the same population as the token rate, it is a one-line change in `summarizeArm` - but it silently moves a previously cited number, so it needs a schema-style announcement rather than a quiet edit.
- A provider whose `total_tokens` diverges far from prompt + completion (cached / reasoning tokens). Both are kept and neither is derived, so the divergence is visible in the summary rather than reconciled away.

# Links

- app/agent/model-router/budget-handle.ts (`AttemptTokenUsage`, the three states)
- app/agent/model-router/bedrock-mantle-transport.ts (`tokenUsageOf`), chat-completions-reply.ts (the boundary)
- app/agent/model-router/router.ts (`attemptTokenUsage`, the normalizer)
- app/eval/metered-budget.ts (`unreportedUsageCalls`), app/eval/harness.ts, app/eval/report.ts
- app/eval/sweep/summary.ts (`ArmEfficiency`, `armEfficiency`, `efficiencyLines`, `costLines`)
- app/eval/sweep/results-log.ts (`RESULTS_SCHEMA_VERSION = 6`, `decodeTokenCounts`, `STALE_SCHEMA_ADVICE`)
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]]
- [[pattern-eval-harness-loop-runner-port-metered-budget]]
- [[decision-bakeoff-routing-has-no-cross-model-fallback]]
- product-ece/ECE-CONTEXT-ENGINEERING.md (section 7, model bake-off selection)
