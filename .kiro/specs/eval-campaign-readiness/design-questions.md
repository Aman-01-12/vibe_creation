# Design questions - eval-campaign-readiness

Five decisions in this design are founder-level: each moves a denominator, an experiment identity, or a set of already-paid samples.
The spec currently encodes the **recommended** option for each, so no work is blocked.
Answering differently changes the requirements named beside each question.

Place answers in `clarification-answers.md` in this folder.

---

## Q1 - How is a `golden = error` sample treated?

**Maps to:** Requirements 2.5, 3.1-3.5. Design section "Area 1", Property 1.

**The tension.**
The independent judge returned no verdict on the candidate's behaviour: the run printed no banner, or hung, or was killed.
Counting it as a model failure risks charging the model for our own infrastructure and for the parameter-override gap the vault already records - six golden testbenches override module parameters our `ModuleInterface` has no concept of, so a candidate faithful to the Spec can fail to elaborate for a requirement the Spec never stated.
Excluding it risks the opposite: if candidates that will not build are excluded, the golden pass@k rises for the wrong reason, in the flattering direction.

On the measured n=1 run this is not hypothetical: 13 samples were judged and 9 passed, so if the other 4 are mostly `error`, exclusion moves golden pass@1 from 0.692 to 1.000.

**Options.**

- **A (recommended). Exclude all three no-verdict causes, split by cause, and print the exclusion tally inside the same block as the value.**
  Rationale: none of the three is a judgement about the candidate's behaviour, exclusion is the same fail-safe direction `unchecked` already takes in the instrument control, and splitting `did-not-build` / `no-output` / `timed-out` makes the excluded bucket actionable rather than a black box. The tally rendered beside the value is what stops a shrunken denominator being cited alone.
- **B. Count `did-not-build` as a model failure; exclude the other two.**
  Rationale: a design that will not compile is not a pass. Cost: the parameter-override gap becomes a model penalty, and we cannot separate the two from the record.
- **C. Count all three as model failures.**
  Rationale: the simplest denominator, and it can only understate capability. Cost: a judge hang or a crash of ours becomes a model result, which is the defect the deferred-slot work just removed elsewhere.

---

## Q2 - Does the Testbench_Agent prompt version enter the config identity?

**Maps to:** Requirement 11. Design section "Area 5". Task 9.1.

**The tension.**
Track C changes the prompt.
Today the prompt version is nowhere in the sweep config or the manifest, so a resumed campaign would pool samples measured under two different prompts under one hash and one summary, silently.
`ECE-CONTEXT-ENGINEERING.md` section 7 says the certified configuration is {model + host + prompt version + context strategy}; only the first two are captured.

Putting it in the identity is correct and expensive: every existing record becomes invisible to the resume index, including the 119 lines under `.eval-runs/instrument-calibration`.

**Options.**

- **A (recommended). Fold the prompt version into the config identity.**
  Rationale: two prompt versions are two experiments, exactly as two `minKillRate` values were, and their samples must not pool. The cost is a calibration run, not a campaign. It also makes the Track A results-schema bump free, since those records are lost to this change regardless.
- **B. Record it in the manifest only, and refuse to resume when it differs.**
  Rationale: preserves the resume index for runs at the same version while still preventing a silent pool. Cost: two mechanisms for one fact, and the refusal lives outside the hash that every record is already keyed by.
- **C. Leave it out entirely.**
  Rejected in the design: it is the mechanism by which the campaign's number becomes uncitable.

---

## Q3 - Should the throttle response be configurable?

**Maps to:** Requirement 8. Design section "Area 2". Task 5.7.

**The tension.**
Every other operational knob in this sweep - concurrency, the retry policy, the kill switch - is a config field.
A throttle knob would follow that precedent, and it would also enter the config identity, so introducing it would orphan every paid sample and two operators with different settings could not pool theirs.

**Options.**

- **A (recommended). Build constants only; no config field.**
  Rationale: throttle response is a safety property, not an experiment parameter. A bounded default that cannot be lowered is the correct surface, and it keeps the config hash still - which is also what keeps Track B off Track C's files.
- **B. A config field, accepting the hash move.**
  Rationale: consistency with the neighbouring knobs. Cost: the identity moves twice in this spec instead of once, and the protection becomes something an operator can turn down.

---

## Q4 - Does the golden population get its own efficiency figure?

**Maps to:** Requirement 4.5. Design section "Area 1".

**The tension.**
`tokens per verified artifact` and `wall clock per verified artifact` are computed over exactly the set the instrument-gated pass@k is computed over - the population invariant that stops an arm improving its rate with samples pass@k refuses to count.
Adding a golden denominator creates a second candidate population.

**Options.**

- **A (recommended). Leave both efficiency figures on the existing population and add none.**
  Rationale: the cost note is explicit that re-basing a cited number needs a schema-style announcement rather than a quiet edit, and a second pair of rates invites citing one denominator's tokens against another's verified count. The rendered lines already name their population.
- **B. Add a second pair over the golden population.**
  Rationale: CPVA over the capability number is arguably the number a model bake-off wants. Cost: four rates in one block, and the first misread of them is a wrong CPVA in a report.

---

## Q5 - Is a `RESULTS_SCHEMA_VERSION` bump acceptable here?

**Maps to:** Requirements 3.7, 3.8. Task 1.5.

**The tension.**
Splitting `golden = error` into three causes changes what the persisted `goldenVerdict` field can say, so a v7 `error` is the sum of three causes with no way to recover the split.
Every previous bump in this repository was a refusal rather than a migration, and a refusal costs whatever has already been recorded.

**Options.**

- **A (recommended). Bump 7 -> 8 as a refusal.**
  Rationale: the only defensible default for the widened field would itself be a false claim, and the records at risk are already forfeit to Q2's identity change. Answering Q2 as A makes this bump free.
- **B. Avoid the bump by leaving `error` undifferentiated and reporting one exclusion bucket.**
  Rationale: no records lost. Cost: the excluded bucket is a black box, and the first reviewer question about it has no answer.
