# Clarification questions - instrument-precheck-and-attribution

Three genuinely contested decisions. Everything else in the spec was settled from the measured evidence or from an existing constraint, and the reasoning is recorded in the document itself rather than here.

All three documents (`requirements.md`, `design.md`, `tasks.md`) are written encoding the **recommended** option for each question, so they are readable and reviewable as they stand. Each question names the exact sections a reversal would change, so the blast radius of overruling me is bounded and visible.

Please answer in `clarification-answers.md` in this folder.

---

## Q1 - Is the instrument gate unconditional, or a policy the config can select?

**Maps to:** Requirement 1 (the precheck), Requirement 4 (the admission port), Requirement 7.4-7.8 (the identity carrier), design section "Where the harness's control moves".

**The tension.** The spec makes both gates unconditional: every run, in eval and in the product, refuses a testbench that cannot build and refuses an instrument the positive control falsifies. That is the simplest shape and it means the certified configuration is one thing rather than two.

But it also means **there is no longer any way to measure the un-truncated flow.** `tbslice-v1`'s golden pass@1 of 0.700 was measured with every sample running its full 6 iterations. After this change a refused sample's candidate is judged as a first candidate with no repair, so 0.700 has no successor number to compare against - not because the schema bumped, but because the flow itself changed and cannot be run the old way.

Why it matters: golden pass@k is the one number in this harness that is meant to be a capability claim, and a capability claim with no baseline is hard to defend. Against that, a selectable policy is a second configuration to certify, and `ECE-CONTEXT-ENGINEERING` section 7 says the certified configuration must be identical in eval and prod.

**Options.**

| | option | consequence |
| --- | --- | --- |
| A | **Unconditional, as written.** One policy, one certified configuration. | 0.700 has no comparable successor. The `INSTRUMENT_POLICY_VERSION` constant exists but only ever moves when we change the gate. |
| B | A `SweepConfig` field selecting the gate, IN the identity, defaulting to on. One slice run with the gate off gives a comparable baseline, one with it on gives the cheap number. Two configs, two hashes, two experiments - never pooled. | Costs one extra full slice run (roughly 200k tokens at `tbslice-v1` rates) and adds a second code path the product must never take. |
| C | Unconditional in the product, config-selectable in eval only. | Rejected on sight: it makes the eval flow differ from the shipped flow, which is the one thing the certified-configuration rule forbids. |

**Recommended: A.** Repair driven by a testbench that rejects the known-good reference design is not capability, it is noise, so the "baseline" B buys is a measurement of the flow producing candidates under a broken instrument - and 6 of the 11 candidates were already correct before any repair ran. If you want the baseline anyway, B is cheap and honest and I would implement it as a fourth requirement rather than by relaxing anything.

---

## Q2 - When a student's testbench will not build, does the session end, or does the loop regenerate the testbench once?

**Maps to:** Requirement 1.8, Requirement 1.11, Requirement 5 (the `Instrument_Refused` outcome), design section "3. testbench-precheck.ts".

**The tension.** Requirement 1.8 ends the run. For an eval sample that is exactly right: the sample measures nothing either way, and stopping saves the budget.

For a **student**, it is a different call. A session that ends at iteration 0 with no `Verified` module, because *our* testbench generator emitted an illegal declaration, spends the student's session on our defect and hands back nothing. One testbench regeneration would plausibly have produced a working instrument: the defect is a single mechanical Verilog-2001 dialect slip in both measured cases, and the precheck gives a regenerated draft a free, deterministic re-check before any iteration runs.

Against that: regeneration is new capability, it spends a model call the student did not get a verdict for, and it is the kind of change that wants its own measurement rather than being added quietly inside a spec about attribution.

**Options.**

| | option | consequence |
| --- | --- | --- |
| A | **Refuse, as written.** Matches the existing fail-closed `coverage-incomplete` precedent exactly. | A student loses the session to our defect. Shortest diff; nothing new to measure. |
| B | Regenerate the testbench at most once, re-run the precheck, then refuse. | Bounded (one extra generation call), and the precheck makes the retry verifiable rather than hopeful. But it changes the Testbench_Agent's budget accounting and needs its own before/after number. |
| C | Refuse now, spec regeneration separately once the precheck has measured how often the build actually fails. | Keeps this spec mechanical and gives the follow-on a measured frequency to justify itself. |

**Recommended: C.** It is A's diff plus a named follow-on, and the precheck this spec adds is precisely the instrument that would tell us whether B is worth building - we currently have one 2-of-12 data point on a single arm at n=1.

---

## Q3 - Does the campaign-readiness slice re-run gate the merge?

**Maps to:** Requirement 8.6-8.8, task 12.1.

**The tension.** Task 12.1 re-runs the committed slice and compares three numbers against `tbslice-v1`. It is the only task that costs model spend, and it is the only check that can falsify the whole premise of the spec - in particular Requirement 8.8, that the golden denominator does not shrink, which is the one way this change could do real damage.

But it is also a live run against a hosted provider, so it can fail for reasons that have nothing to do with the code (the same rate-limit burst that cost 31 of 46 cells on `instrument-calibration`), and making it a merge gate makes the merge hostage to a provider.

**Options.**

| | option | consequence |
| --- | --- | --- |
| A | **Blocking: the code merges only after the slice re-run confirms all three comparisons.** | Strongest guarantee; merge can be blocked by a provider outage unrelated to the change. |
| B | Non-blocking: merge on the offline gate, run the slice immediately after, revert if a comparison fails. | Fast; but a shrunken golden denominator would sit on the main branch for as long as the run takes. |
| C | Blocking on the offline proxy only - the fake-runner assertion in checkpoint 8 that a refused sample still yields a golden verdict - with the live slice run tracked as a separate follow-up. | The specific damage mode (a lost candidate) is caught deterministically and offline; the aggregate numbers are confirmed later. |

**Recommended: C.** Requirement 8.8's real risk is structural (a refused outcome surrendering no candidate) and that is fully checkable offline by Property 9 and checkpoint 8. The live run is still worth doing and task 12.1 keeps it, but holding a deterministic change behind a hosted provider buys less than it costs.

---

## Not asked, and why

For the record, so these do not read as oversights:

- **The waveform / `$dumpvars` question is settled by constraint, not preference.** `SIMULATE_REQUIRED_OUTPUTS` makes the VCD a required output, so dropping it classifies every run `error`; and eval limits must equal student limits, so the disk cap cannot be raised for eval alone. The only in-scope move is honest classification plus visibility, which is Requirement 3.
- **The 44-character check-name brittleness is not decided either way**, deliberately. Requirement 6.8 leaves the matching rule alone because the artifacts cannot currently say whether the model mangled the token or omitted the check. Requirement 6 persists that evidence; the rule change waits for it. Deciding now would be specifying a fix for an unmeasured cause.
- **The negative control is not reordered because reordering it is a no-op.** `#probeMutants` already returns `null` unless the positive control reported `valid`, so a mutant set runs for the same samples in either order.
- **`CONTROL_RUN_ERRORED` on `calendar` is named as unclassified and left alone**, per the same rule.
