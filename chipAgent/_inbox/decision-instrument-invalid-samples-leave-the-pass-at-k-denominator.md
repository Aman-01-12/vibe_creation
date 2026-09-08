---
type: decision
title: A sample whose testbench fails the reference design is instrument-invalid and LEAVES the pass@k denominator
status: candidate
provenance: founder ruling after the smoke-v2 right_shifter finding; implemented in app/eval/instrument-control.ts
tags: [eval, pass-at-k, instrument-validity, positive-control, honesty, schema-version, denominator]
timestamp: 2026-09-06
---

# Decision

Every eval sample now carries a THIRD verdict, and it is a verdict on the INSTRUMENT rather than on the candidate.

After the loop finishes, the same generated testbench that judged the candidate is run against the problem's known-good REFERENCE design, through the same Tool_Runner sandbox rails the oracle and the golden judge already use.

- the reference PASSES our testbench -> the instrument is `valid` for this sample
- the reference FAILS, errors, or does not compile -> `invalid`
- no testbench was produced, no control was wired, no reference exists, or the control threw -> `unchecked`

The founder's ruling on what that means for the number: an `invalid` sample is EXCLUDED from the pass@k denominator and reported separately as a first-class number.
It is never silently dropped and never counted as a model failure.

## THE DENOMINATOR INVARIANT (the thing to remember)

> A sample counts in the pass@k denominator if and ONLY if the loop reached an oracle verdict AND the positive control proved its instrument `valid`.

One implementation, `countsInPassAtK`, and both the estimator and the reported `countedSamples` read it, so the denominator and the count describing it cannot disagree.

## How `unchecked` interacts with no-verdict (the part that needed working out)

The two conditions are nearly an implication, not an independent conjunction: a sample with no oracle verdict (`blocked`, `setup-failed`, `runner-error`) produced no testbench, so its instrument is necessarily `unchecked` and condition (2) already excludes it. Condition (1) is kept explicit because it is the older, more fundamental rule.

`unchecked` does NOT count, and that is the strict reading on purpose: "we could not prove the instrument" is not evidence that the instrument is sound.

The trap is what that does to a run where the control never ran at all - every sample is `unchecked`, the denominator is empty, and a naive implementation reports `pass@k = 0`, which reads as a total model failure. That would be a worse lie than the one being fixed. So:

- when the control WAS exercised for an arm (at least one checked sample), pass@k uses the strict rule and judged-but-unchecked samples are excluded and reported on their own line;
- when it was NOT exercised at all, pass@k falls back to the verdict-bearing-only estimate and the summary prints it labeled `UNVALIDATED` plus `instrument: NOT MEASURED`.

Two different claims, two different labels - not two denominators for one claim. This reuses the existing `golden judge: NOT MEASURED` convention rather than inventing a second vocabulary.

The harness's own `EvalRunReport.aggregatePassAtK` is deliberately NOT instrument-gated: it also serves the hand-written smoke subset and the CI gate, which have no reference designs and therefore cannot be controlled at all. The citable, gated number is the sweep summary's, computed from the persisted records.

## The schema version is a REFUSAL, not a migration

`RESULTS_SCHEMA_VERSION` went 1 -> 2 and `decodeSampleRecord` requires `instrumentValidity`.
A results file holding older records is refused wholesale: nothing is aggregated, and the operator is told to re-run into a fresh `outputDir`.
The message states the cost explicitly - the only v1 records that ever existed were six throwaway smoke samples - rather than making the operator guess.
`ARTIFACT_DOCUMENT_SCHEMA_VERSION` moved 1 -> 2 for the same reason.

# Context / options considered

- Count an instrument-invalid sample as a model failure. Rejected: that is exactly the bug. `pass@1 = 0.333` measured our testbench and attributed it to the model.
- Silently drop it. Rejected: the denominator then reports a corpus size that is not the one measured, and the defect becomes invisible - so it never gets fixed.
- Admit `unchecked` into the denominator as if valid. Rejected: it collapses "proven sound" and "unproven" into one number that claims to be the first. Reported separately instead.
- Zero out pass@k whenever nothing was checked. Rejected: a flat 0 is read as a model result. Labeled `UNVALIDATED` instead, which is the honest statement.
- Make the control a third opinion on the CANDIDATE (e.g. let it override a verdict). Rejected outright: it answers a different question. It decides whether a sample's verdict is admissible, never what the verdict is.
- Silently migrate v1 records by defaulting `instrumentValidity`. Rejected: the default would BE the false claim. Any default other than a refusal invents a validated instrument.
- Write a second module-name rename for the control path. Rejected: `importRtllmCorpus` already applies `renameTopModule` when it builds each `ReferenceDesign` (upstream's `verified_<name>` prefix), and Stage 0 already consumes that adapted reference. The control consumes `RtllmCorpus.references` and adds nothing.
- Reuse `SandboxGoldenTestbenchScorer` for the control. Rejected: it exists to read VCS banners and to require no VCD. Our testbench emits `CHECK <name> PASS|FAIL` and writes a waveform, so the control reuses `IcarusSimulatorAdapter` - the EXACT oracle that produced the loop's verdict. Only the RTL under the testbench changes, which is what removes "the control read the output differently" as an explanation for a disagreement.

# Rationale

- The prime directive is that tools decide correctness. This is the corollary the smoke run exposed: a tool that fails the known-good answer is not deciding anything. Every experiment reporting a failure rate needs a positive control, and RTLLM ships one per problem, so it is detectable per sample instead of by hand.
- Separating the three verdicts keeps each number meaning one thing. The loop's oracle drives repair. The golden judge stops pass@k being self-graded. The control says whether either verdict is admissible. Blending any two would produce a number that is a claim about two things at once.
- The control is deterministic and makes NO model calls, which is what makes it free to run unconditionally: no cost, no session budget, no extra sample or iteration. It runs after the sample is measured, receives no budget handle, and its result only lands in a new field - asserted by a test that the measured fields are byte-identical with and without it. Its only price is wall clock (one compile plus one simulation per sample), noted in the sweep config README.
- `RecordedInstrumentVerdict` is a closed discriminated union of enum members with no free text. It is persisted, echoed into artifacts, and printed to operators, so being structurally incapable of carrying a path or a tool message is stronger than sanitizing one. The toolchain's actual output goes to `control-stdout.txt` / `control-stderr.txt` beside the testbench that caused it - the established home for path-bearing text.
- Fail-safe in one direction only: a control that throws degrades to `unchecked`, which can only move a sample OUT of the denominator. It can never turn a broken instrument into a valid one, and it can never end a campaign with hours invested in it.

# Revisit trigger

- The first real bake-off with the control armed. If `instrument-invalid` is a meaningful fraction, the finding is about the Testbench_Agent prompt and the repair belongs there - not in the RTL generator, and not in the model ranking.
- A benchmark with no reference designs. Every instrument would be `unchecked`, so pass@k there is structurally unvalidatable and must be labeled as such rather than quietly reported.
- Arming the CI pass@k gate. The baseline must be measured with the control armed, or the ratchet ratchets against a number that includes broken instruments.
- Teaching the Testbench_Agent about phase-boundary state (see the defect class note). If the class disappears, `instrument-invalid` should trend to zero - which is the falsifiable test of the fix.

# Links

- app/eval/instrument-control.ts (`countsInPassAtK`, `summarizeInstrumentControl`, the verdict union)
- app/eval/corpus/rtllm-instrument-control.ts, app/eval/corpus/nonpass-cause.ts
- app/eval/harness.ts (`#controlInstrument`, the sibling of `#judgeIndependently`)
- app/eval/sweep/summary.ts (the gated denominator, the instrument block, the stale-schema refusal)
- app/eval/sweep/results-log.ts (`RESULTS_SCHEMA_VERSION = 2`, `STALE_SCHEMA_ADVICE`)
- app/eval/sweep/artifact-layout.ts (`control-stdout.txt`, `control-stderr.txt`, `instrumentVerdict`)
- [[gotcha-generated-testbench-assumes-a-reset-that-does-not-exist]]
- [[decision-independent-golden-judge-and-vcs-icarus-gap]]
- product-ece/ECE-VERIFICATION-METHODOLOGY.md
