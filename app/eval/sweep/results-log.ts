// The append-only results log: one JSON line per completed sample, and the resume
// index built from it.
//
// WHY JSONL AND WHY APPEND-ONLY
//   A bake-off runs for hours. Buffering the matrix in memory and writing one report at
//   the end means a crash at hour six loses six hours of PAID samples. So each sample
//   is appended as it completes, and the file is never rewritten: an append either
//   lands whole or does not land, so a kill mid-write costs at most the line in flight,
//   and every line before it stays readable. That is also what makes the summary
//   runnable standalone over an old file with no re-run.
//
// THE RESULTS FILE IS UNTRUSTED INPUT
//   It is read back on resume and by the summarizer, and by then it may have been
//   hand-edited, truncated by a full disk, concatenated with another run's file, or
//   half-written when the process died. So every line is narrowed field by field and a
//   line that does not validate is COUNTED and SKIPPED, never partially trusted and
//   never fatal. A malformed tail must not stop a resume; it must be visible.
//
// RESUME IS SCOPED BY CONFIG IDENTITY
//   The index only admits records whose `configHash` matches the current config, so
//   resuming a DIFFERENT experiment cannot reuse this one's samples (see
//   `./config-identity.ts`). Records for arms the current config no longer declares are
//   simply never looked up.
//
// A SCHEMA BUMP IS A REFUSAL, NEVER A MIGRATION
//   When a field's MEANING changes - as it did when pass@k started depending on the
//   positive control's instrument verdict - an old record cannot be upgraded, because the
//   missing field is precisely the thing the new number depends on. Filling it in with a
//   default would produce a number that looks measured and is not. So an older-version line
//   is counted separately from corruption and the summary refuses to aggregate the file at
//   all, telling the operator to re-run into a fresh directory.
//
// NO SECRETS, NO PATHS, NO STACK TRACES
//   A record carries a verdict, counters, and sanitized classifications only. It is
//   the artifact a number is cited from, so it is safe to attach to a report.

import {
  CHECKING_APPROACHES,
  DESIGN_GROUPS,
  FALLBACK_ROUTES,
  PROPERTY_SET_ADMISSION_OUTCOMES,
  STRATEGY_ARMS,
  type CheckingApproach,
  type DesignGroup,
  type FallbackRoute,
  type FormalProvenance,
  type PropertySetAdmissionOutcome,
  type RepairDeclineReason,
  type StrategyArm,
  TESTBENCH_PARSE_REFUSALS,
  type TestbenchParseRefusal,
} from '@app/agent';
import type { BudgetStopReason } from '@app/core';
import {
  CLOCK_POLARITIES,
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type ClockPolarity,
  type CouldNotVerifyCause,
  type CoverCondition,
  type FormalVerdict,
  type ProofConditions,
  type PropertyResult,
  type ResetContract,
} from '@app/tools';

import { RECORDED_GOLDEN_KINDS, type RecordedGoldenKind } from '../golden-judge.js';
import type {
  InstrumentDefectCode,
  InstrumentUncheckedReason,
  InstrumentValidity,
  RecordedInstrumentVerdict,
} from '../instrument-control.js';
import {
  MUTATION_OPERATORS,
  type MutationOperatorId,
  type MutationSampleCounts,
} from '../mutation-control.js';
import { isDeferredSample, NO_VERDICT_CAUSES, type NoVerdictCause } from '../no-verdict-cause.js';
import type { FormalMutationCounts } from '../property-set-admission.js';
import type { SampleOutcomeStatus } from '../report.js';

/**
 * The record schema version, bumped only when a field's MEANING changes.
 *
 * v1 -> v2 (the positive control). pass@k started depending on `instrumentValidity`: a sample
 * counts in the denominator only if the loop reached an oracle verdict AND the control
 * proved its testbench valid. A v1 record has no such field, so aggregating one as if its
 * instrument had been validated would silently mix `unchecked` with `valid`.
 *
 * v2 -> v3 (the NEGATIVE control). `instrumentValidity: valid` now means BOTH controls
 * passed: the reference design is accepted AND the mutants the independent golden testbench
 * kills are also killed by our testbench. A v2 `valid` was decided by the positive control
 * alone, and the defect that motivated v3 is precisely a testbench that satisfies the
 * positive control and nothing else (`multi_pipe_8bit`, smoke-v4-oracle). So a v2 record's
 * `valid` is not the current `valid`, and blending the two would report testbenches that
 * pass everything as sound instruments.
 *
 * v3 -> v4 (the mutant DENOMINATOR). The negative control used to score our testbench only over
 * the mutants RTLLM's golden testbench kills, excluding the rest as likely-equivalent. That
 * excused our testbench for exactly the bugs the golden judge is blind to, so the denominator is
 * now every mutant that COMPILES and the threshold moved with it. A v3 `valid` therefore means
 * "killed all of a smaller, judge-shaped set"; a v4 `valid` means "killed at least 95% of
 * every valid mutant". The `mutation` block's fields changed with it, so a v3 record cannot even
 * describe the current measurement.
 *
 * v4 -> v5 (the GATE). The 95%-of-valid-mutants bar was itself unsound, in the opposite
 * direction: its denominator necessarily contains genuinely equivalent mutants, so it held an
 * instrument to killing mutants that may be unkillable in principle. Measured on
 * `rtllm/arithmetic/multi_pipe_8bit`, a testbench that kills two mutants the golden judge itself
 * misses scored 4/6 and was marked INVALID - a false negative on a demonstrably good instrument.
 * Validity is now ZERO COVERAGE-GAP SURVIVORS: our testbench must kill every valid mutant the
 * INDEPENDENT golden testbench killed, and nothing more. A v4 `valid` is a rate claim over a set
 * containing unkillable mutants; a v5 `valid` is "no independently-proven-catchable bug was
 * missed". The two are not the same population and one is not a relaxation of the other, so
 * pooling them would report both a false negative and a false positive as the same word.
 *
 * v5 -> v6 (MEASURED cost). The arm's efficiency figure used to be denominated in DOLLARS, and
 * dollars are not measured: no endpoint returns money, so `costCents` is `costKnown` tokens
 * multiplied by an external rate card, and an unpriced campaign had no efficiency number at all.
 * The primary figure is now tokens and wall clock per verified artifact, both of which the
 * endpoint and the clock actually report, so a record carries `promptTokens`,
 * `completionTokens`, `totalTokens`, and `unreportedUsageCalls`. A v5 record has none of them
 * and there is no way to recover them - they were metered per sample and discarded - so reading
 * one would put a 0 in the numerator of the headline number and report a campaign that spent
 * millions of tokens as infinitely efficient.
 *
 * v6 -> v7 (a TIMEOUT is a KILL). `instrumentValidity: valid` changed population again, and this
 * time the gate set GREW. A mutant the independent golden testbench never terminated on used to
 * classify `non-compiling`, which removed it from the valid set and therefore from the gate set -
 * so our testbench was never asked to catch a defect that demonstrably changes observable
 * behaviour. It is now a golden KILL, so a v7 `valid` requires strictly more than a v6 `valid`
 * did, and a v6 record can carry `valid` for a testbench that v7 would reject. Pooling them
 * would report the weaker claim under the stronger word.
 *
 * The `mutation` block also changed shape: `nonCompilingCount` narrowed to genuine build failures
 * only, and two counts joined it - `goldenTimeoutCount` (golden kills that were hangs, the
 * honesty counterpart of the enlarged gate set) and `goldenErroredCount` (a golden run that
 * crashed with nothing to show, which is an infrastructure fact rather than a broken mutant). A
 * v6 `nonCompilingCount` is the sum of all three with no way to recover the split.
 *
 * v7 -> v8 (a TRANSPORT FAILURE IS NOT A MEASUREMENT). The RESUME rule changed meaning, which is
 * the first time a bump has been about the matrix rather than about a number. A no-verdict record
 * used to be unconditionally final: it was in the file, so `CompletedSampleIndex` read the slot as
 * done and never ran it again. Measured on `.eval-runs/instrument-calibration` (one arm, 46
 * problems, n=1): 24 healthy samples, then an unbroken run of `setup-failed` records carrying
 * `ALL_PROVIDERS_FAILED`, then recovery under a fresh breaker. Two thirds of the matrix was
 * deleted by one rate-limit burst and the run reported itself `completed`. A record now carries
 * `noVerdictCause`, and an INFRASTRUCTURE cause makes the slot DEFERRED - kept as evidence,
 * excluded from the resume index, announced by the summary - while a FINDING stays final.
 *
 * There is no migration for it, and the reason is not that the field cannot be defaulted: `null`
 * decodes as not-deferrable, so a v7 file WOULD load. That default is precisely the false claim.
 * It asserts that every no-verdict sample in the file was a measurement, and in the only such
 * file that exists that assertion is wrong for 31 of 40 no-verdict records. A build that
 * announces it distinguishes outages from findings must not silently read an outage as a finding.
 *
 * v8 -> v9 (the GOLDEN OUTCOME VOCABULARY WIDENED). `goldenVerdict` used to be the independent
 * judge's BANNER grammar - `passed | failed | error` - and it is now the RECORDED vocabulary,
 * which splits that `error` into `did-not-build`, `no-output`, and `timed-out`. The reason is a
 * new number: pass@k is now ALSO reported over the golden denominator, the samples the
 * independent judge returned a verdict on the candidate's BEHAVIOUR for, and the three causes
 * behind an `error` are excluded from it for three different reasons that an operator has to be
 * able to tell apart. A v8 `error` is the sum of all three with no way to recover the split, so a
 * golden denominator computed over v8 records would report an exclusion bucket nobody can act on
 * - and, worse, the same total under a different composition run to run.
 *
 * As at every previous bump there is no default that would be honest. Reading a v8 `error` as any
 * one of the three asserts a cause that was never measured, and dropping it from the exclusion
 * tally would break the partition the golden block prints - the denominator plus its exclusions
 * equalling the arm's recorded samples is exactly what stops a shrunken denominator being cited
 * alone.
 *
 * v9 -> v10 (a REFUSED instrument stops the loop, and its cause is now PERSISTED). Two fields
 * changed meaning in the same bump, both driven by the same defect: `instrumentVerdictOf`
 * FLATTENED every `unchecked` record onto `control-unavailable`, regardless of the real cause,
 * because the reason was never written down. Measured on `tbslice-v1`: 3 of 15 samples are
 * `unchecked`, all three `setup-failed` with `iterations: 0`, and their real cause is
 * `no-testbench` - the Testbench_Agent refused to emit a testbench for missing check coverage -
 * not `control-unavailable`, which claims the control ran and could not speak. A v9 reader
 * cannot tell those apart because the field the answer lives in does not exist yet.
 *
 * First, the ITERATION COUNT. An `instrument-refused` sample now records `iterations: 0` for a
 * case that, under a v9 build, burned iterations repairing RTL against a testbench that could
 * never have measured it. The measured case: `rtllm/arithmetic/adder_8bit` ran 6 full iterations
 * against a testbench `iverilog -t null` reports a parse failure on, and the independent judge
 * then passed the candidate anyway. A v9 record's `iterations` for a functionally-equivalent
 * sample describes a flow - repair against a broken instrument - that no longer exists after this
 * spec, so the two counts are not measurements of the same thing and averaging them would blend
 * a cost this build no longer pays into one that still does.
 *
 * Second, the INSTRUMENT VERDICT. `instrumentUncheckedReason` is now PERSISTED: previously every
 * `unchecked` record was written with no reason field at all, and `instrumentVerdictOf` INVENTED
 * `control-unavailable` on every read no matter what actually happened. A v9 record has no real
 * reason to read, so "upgrading" it would either invent a specific cause nobody measured, or fall
 * back to `control-unavailable` for samples whose real cause was `no-testbench` or
 * `control-resource-exhausted` - exactly the misclassification this spec exists to close (the
 * measured `rtllm/arithmetic/multi_16bit` case: recorded `TESTBENCH_REFERENCE_UNBUILDABLE`, an
 * instrument defect, when its control run's own stderr read `workspace reached its
 * 134217728-byte disk cap`, a resource kill with nothing to say about the testbench).
 *
 * As at every previous bump there is no default that would be honest and no migration: the
 * reader REFUSES to aggregate a file containing older records and tells the operator to re-run
 * into a fresh output directory (see `STALE_SCHEMA_ADVICE`).
 *
 * v10 -> v11 (a REPAIRED instrument is distinguishable from a first-draft one - and this bump
 * is a different KIND from every one above it). Every prior bump changed what an EXISTING
 * field means: `instrumentValidity: valid` has gone through four different definitions across
 * v2, v3, v5, and v7 above, each one silently wrong to read under the next. This bump changes
 * none of that. `instrumentValidity`'s own meaning is UNCHANGED: a v10 record's
 * `instrumentValidity: 'valid'` already means exactly what a v11 record's `valid` means,
 * for the specific case where `repairAttempted` happens to be `false` - "our testbench passed
 * both controls," full stop, with no fourth redefinition added here. What v10 cannot express is
 * "valid AFTER repair": a testbench that failed the positive control once, was revised by
 * exactly one Testbench_Repair attempt, and THEN passed both controls under the identical
 * re-check standard a first draft is held to (`testbench-repair-loop` Requirement 4.4). A v10
 * reader has no field to hold that fact, so it silently pools "sound on the first draft" with
 * "fixed after failing" under the same `valid` - not because the word changed meaning, but
 * because the record has nothing to say about HOW that sample reached it.
 *
 * `repairAttempted` and `repairAccepted` are therefore two NEW required fields, not a
 * redefinition of an old one, and there is still no honest default for an older record: the
 * Testbench_Repair capability did not exist when a v10 record was written, so there is no
 * question a v10 record could have answered `false` to. Defaulting `repairAttempted` to
 * `false` would not be neutral, it would assert "this sample's instrument was never repaired,"
 * which is a fact about a capability the sample was never measured against - indistinguishable
 * from a genuine "no repair happened" only by coincidence, not by construction. So a v10 (or
 * older) file is refused wholesale on read, by the identical `record.schemaVersion !==
 * RESULTS_SCHEMA_VERSION` refusal this bump number change already triggers for a v9 record;
 * no separate special-case code is needed for the refusal itself.
 *
 * v11 -> v12 (a DECLINED repair now names WHICH STAGE declined, and a repaired instrument's
 * `repairAttempted`/`repairAccepted` pair CHANGED MEANING for that same population). Three
 * facts, not one.
 *
 * First, `RepairProvenance` (from `@app/agent`, `testbench-dialect-normalization` Requirement
 * 3) gained `RepairDeclineReason`: a closed five-member vocabulary - `no-admissible-revision`,
 * `coverage-validation-failed`, `recheck-failed`, `port-threw`, `port-unavailable` - naming
 * WHICH stage a decline happened at. `repairDeclineReason` is the new field that carries it.
 *
 * Second, and this is the meaning change, not just an addition: under v11 a declined
 * control-path repair attempt persisted as `repairAttempted: false` - the RC-1 defect this
 * spec fixes, where a decline recorded at the control trigger point could not be told apart
 * from no attempt at all. Separately, the control-path trigger itself is retired in this same
 * spec; there is no longer a second point a repair can be declined at. So for ANY sample where
 * a decline happened, a v11 record's `repairAttempted`/`repairAccepted` pair is not even the
 * same fact a v12 record's pair is - one of them may be silently misreporting an attempt as
 * absent, and the mechanism that produced it no longer exists to be reasoned about.
 *
 * Third, there is no honest default for `repairDeclineReason` on a v11 (or older) record, for
 * the identical reason `instrumentUncheckedReason` has none (see this constant's v9 -> v10
 * note): the vocabulary did not exist when the record was written, so there is no question a
 * v11 record could have answered. A fresh output directory is required.
 *
 * v12 -> v13 (a SECOND ORACLE now decides samples, and the record has to be able to explain
 * which one did). This bump is the same KIND as v10 -> v11 - new fields, no existing field
 * redefined - and it is the largest of them: a whole FAMILY of fields joins the record at
 * once, because the Formal_Oracle's verdict, the contract it was taken under, and the gate
 * applied to the Property_Set it rested on are one story that cannot be told in parts. The
 * family is still being completed inside THIS version - no v13 record has been written yet,
 * so a field added here costs no further bump - and the count is deliberately not stated,
 * because a number in this comment would go stale on the next field rather than fail.
 *
 * `passed` and `instrumentValidity` mean exactly what they meant in v12. What v12 cannot
 * express is WHICH ORACLE decided the sample. A v12 `passed: true` is the simulation oracle's
 * verdict, full stop; a v13 `passed: true` may have been decided by a formal proof of every
 * submitted property, or by the Simulation_Fallback after a `could-not-verify`, and those two
 * rest on different evidence. There is no field on a v12 record that distinguishes them,
 * because the Formal_Oracle did not exist when one was written.
 *
 * And there is no honest default, for the identical reason `repairAttempted` has none (see the
 * v10 -> v11 note). `formal: null` is not neutral: it asserts "no Formal_Property was ever
 * submitted for this sample", which is a fact about a capability the sample was never measured
 * against. `propertySetAdmitted: 'not-gated'` would assert the Property_Set_Admission gate did
 * not run, which is indistinguishable from a genuine `'not-gated'` only by coincidence. And
 * `formalResetContract: null` would assert the pre-pass was never reached, which cannot be told
 * from the `{ derived: false }` a pre-pass that RAN and refused records. So a v12 (or older)
 * file is refused wholesale on read, by the identical `record.schemaVersion !==
 * RESULTS_SCHEMA_VERSION` refusal this bump number change already triggers for a v11 record.
 *
 * v13 -> v14: `noVerdictCause` accepts `provider-refused-credential`, a provider that ANSWERED
 * and refused the credential. A v13 reader has no member for it, and `optionalMember` drops an
 * unknown cause to `null`, which `isDeferrableCause` reads as NOT deferrable. So a v14 record
 * read by a v13 build would turn a retakeable slot into a final one, which is the deletion
 * `no-verdict-cause.ts` exists to prevent, and the version is what refuses it instead.
 *
 * v14 -> v15 (testbench-in-order-scoreboard): every record names its Strategy_Arm,
 * Checking_Approach, Design_Group, and Testbench prompt version. A v14 record has none, and
 * defaulting them would pool a Treatment sample into the Control cell of the A/B Campaign.
 *
 * v15 -> v16 (testbench-spec-grounding): every record names the `SIMULATION_HARNESS_VERSION`
 * it ran under, the Testbench_Parser refusal that ended it (or `null`), and what its
 * Positive_Control run itself showed (or `null`). A v15 record has none of the three, and
 * defaulting them would read "the harness was absent" as "harness version unknown" and a
 * refused reply as a reply that parsed.
 *
 * v16 -> v17 (testbench-failure-reportability): every record names its
 * `valuelessFailureReports`, the count of failure reports in the measured testbench that carry
 * no observed value, or `null` when no testbench was measured. This bump redefines no existing
 * field, the way v10 -> v11 did not. There is still no honest default for a v16 record: the
 * detector did not exist when one was written, so `0` would assert "this sample's testbench
 * reported its failures with values" about a sample never measured for it.
 */
export const RESULTS_SCHEMA_VERSION = 17;

/**
 * What an operator must do about a results file written before the schema bump.
 *
 * States the cost explicitly rather than leaving it to be guessed, so the operator can decide
 * rather than wonder what a re-run is worth.
 */
export const STALE_SCHEMA_ADVICE: readonly string[] = Object.freeze([
  `this results file holds records from an older schema (current v${RESULTS_SCHEMA_VERSION}) and`,
  'CANNOT be aggregated, for ten independent reasons.',
  '(1) Those records carry NO token counts. The primary efficiency figure is now tokens and',
  'wall clock per verified artifact - the things the endpoint and the clock actually report -',
  'and a token count that was metered per sample and then discarded cannot be recovered from',
  'the record. Defaulting it to 0 would report a campaign that burned millions of tokens as',
  'infinitely efficient. Dollars are the optional secondary figure and still need',
  'prices.<modelId>.',
  '(2) `instrumentValidity: valid` means something DIFFERENT now than it did',
  'in the oldest of those records. It used to mean "our testbench passes the reference design',
  'AND kills at least 95% of every mutant that compiles"; it now means "AND kills EVERY mutant',
  'the independent golden testbench killed" - zero coverage gaps, with no rate bar at all. The',
  'rate bar was unsound because its denominator necessarily contains mutants no testbench can',
  'kill, so it failed instruments that were measurably good; the new gate only ever demands',
  'kills a third party has already demonstrated are possible. The kill rate is still recorded,',
  'as a quality signal rather than as the gate. The gated set then GREW again: a mutant the',
  'golden testbench never TERMINATED on used to be discarded as non-compiling, and is now a',
  'golden kill our testbench is required to catch, so a v7 `valid` demands strictly more than',
  'an older one did.',
  '(3) Those records cannot say whether a no-verdict sample was MEASURED or merely ATTEMPTED.',
  'A sample now records WHY it reached no oracle verdict, and an infrastructure cause - no',
  'provider answered - marks the slot DEFERRED so a resume runs it again instead of counting',
  'it as done. Older records have no such field, so reading one would repeat the defect this',
  'schema closes: a rate-limit burst was recorded as a wall of finished samples, the resume',
  'skipped every one of them, and the run reported a two-thirds-empty matrix as complete.',
  'Defaulting the field is not a migration, it is that same claim written down.',
  '(4) The GOLDEN OUTCOME VOCABULARY WIDENED, so `goldenVerdict` in those records means less',
  'than it does now. It used to be the independent judge\'s banner grammar - "passed",',
  '"failed", or a single "error" - and it is now the recorded vocabulary, which splits that',
  'error into "did-not-build", "no-output", and "timed-out". pass@k is now ALSO reported over',
  'the GOLDEN DENOMINATOR - the samples the independent judge returned a verdict on the',
  "candidate's behaviour for - and those three causes are excluded from it for three",
  'different reasons an operator has to be able to tell apart: a candidate the judge could',
  'not elaborate, our own infrastructure producing nothing, and a resource cap we imposed',
  'doing its job. An older record collapses all three, and no default recovers the split:',
  'picking one asserts a cause nobody measured, and dropping it would break the partition',
  'the golden block prints, which is the only thing stopping a shrunken denominator from',
  'being cited on its own.',
  '(5) TWO MORE THINGS CHANGED MEANING IN THE SAME BUMP: the ITERATION COUNT and the',
  'INSTRUMENT VERDICT. An `instrument-refused` sample now records `iterations: 0` for a case',
  'that an older build would have spent its whole repair budget on: measured on',
  '`rtllm/arithmetic/adder_8bit`, 6 full iterations ran against a testbench `iverilog -t null`',
  'reports a parse failure on, and the independent judge passed the candidate anyway. An older',
  "record's `iterations` for a functionally-equivalent sample describes that spent-budget flow,",
  'which no longer exists, so the two counts are not the same measurement. Separately, the',
  'reason an `unchecked` instrument is unchecked is now PERSISTED, where it used to be absent',
  'from every record and invented on read as `control-unavailable` regardless of the real',
  'cause. Measured on `rtllm/arithmetic/multi_16bit`: recorded `TESTBENCH_REFERENCE_UNBUILDABLE`',
  '- an instrument defect charged to our testbench - while its control run was actually killed',
  'by a disk cap, a fact its own stderr stated and nothing downstream read. An older record has',
  'no reason to read, so filling one in - even the falsely-reassuring `control-unavailable`',
  'every such record already implied - asserts a cause nobody measured.',
  '(6) `instrumentValidity` itself did NOT change meaning in this bump, unlike every reason',
  'above: a v10 `valid` already means exactly what a v11 `valid` means, for the case where no',
  'repair was attempted. What changed is that TWO NEW fields were introduced -',
  "`repairAttempted` and `repairAccepted` - to say whether a sample's testbench was revised",
  'by a Testbench_Repair attempt before it passed both controls. Older records have no such',
  'fields because the capability did not exist when they were written, so there is no honest',
  'default: filling in `false` would assert "never repaired" for a sample that was never',
  'measured against a repair capability at all, silently pooling "sound on the first draft"',
  'with "fixed after failing" under the identical word.',
  '(7) A DECLINED repair now names WHICH STAGE declined, and the pair of fields introduced in',
  '(6) changed meaning for that same population. `repairDeclineReason` is a new field: a',
  'closed five-member vocabulary naming the stage a Testbench_Repair attempt declined at.',
  'Separately, and this is the part that is not just an addition: under the older schema a',
  'declined CONTROL-PATH repair attempt persisted as `repairAttempted: false` - it could not',
  'be told apart from no attempt at all - and the control-path trigger that produced that',
  'defect no longer exists in this build. So for any sample where a decline happened, an',
  "older record's `repairAttempted`/`repairAccepted` pair is not the same fact a current",
  "record's pair is, and there is no honest default for `repairDeclineReason` on an older",
  'record for the same reason `instrumentUncheckedReason` has none: the vocabulary did not',
  'exist when the record was written.',
  '(8) A FORMAL VERDICT, ITS CONDITIONS, AND A FALLBACK REASON ARE NOW RECORDED, and an older',
  'record carries none of them. A sample now records the Formal_Verdict a second oracle',
  'reached, the Could_Not_Verify_Cause where one applies, which of the five Proof_Conditions',
  'held, the Proof_Depth, the elapsed time, and the Fallback_Reason naming why a sample took',
  'the Simulation_Fallback instead. It also records the Reset_Contract the run was taken',
  'under - the reset net, its polarity, its synchronous-or-asynchronous kind, and whether the',
  "design's initial state is free - together with the Clock_Contract's polarity and whether",
  'the `if (!$initstate)` assertion gate was emitted, because the gate emission is a FUNCTION',
  'of that contract and a record omitting it cannot explain its own verdict. Beside those, a',
  'sample records whether the Property_Set_Admission gate admitted the property set its formal',
  'verdict would have rested on, how many reference-design mutants survived it, and that',
  "gate's own mutant counts - killed, survived, the mutants the oracle could not reason about",
  'at all, and the FORMAL denominator those exclusions were taken out of, which is a different',
  "number from the negative control's valid-mutant count over the same mutants. `passed`",
  'itself did NOT change meaning, but an older record cannot say WHICH ORACLE decided it: a',
  'formal proof of every submitted property and a Simulation_Fallback after a',
  '`could-not-verify` rest on different evidence and an older record has no field that tells',
  'them apart. No default is honest: `null` would assert no property was ever submitted,',
  '"not-gated" would assert no admission gate ran, and an absent Reset_Contract would assert',
  'the pre-pass was never reached - which is a different fact from a pre-pass that RAN and',
  'refused to derive one.',
  '(9) A record now names its STRATEGY_ARM, CHECKING_APPROACH, DESIGN_GROUP, and Testbench',
  'prompt version. An older record has none, and defaulting them would pool a Treatment',
  'sample into a Control cell, which is the comparison the A/B Campaign exists to keep apart.',
  '(10) A record now counts its VALUELESS FAILURE REPORTS: the failure reports in its measured',
  'testbench that carry no observed value. This redefines no existing field, but there is no',
  'honest default for an older record, because the detector did not exist when it was',
  'written: `0` would assert "this sample\'s testbench reported its failures with values"',
  'about a sample never measured for it.',
  'Fix: re-run the campaign into a FRESH outputDir. The only records ever written at an older',
  'schema were throwaway smoke samples and one diagnostic calibration run.',
]);

/** The results log filename inside a run's output directory. */
export const RESULTS_LOG_FILENAME = 'results.jsonl';

/** Longest results file this reader will accept, in bytes (~64 MiB). */
export const MAX_RESULTS_FILE_BYTES = 67_108_864;

/** The outcome statuses a record may carry; a closed set, validated on read. */
const OUTCOME_STATUSES: readonly SampleOutcomeStatus[] = [
  'verified',
  'unverified',
  'blocked',
  'setup-failed',
  'runner-error',
  'instrument-refused',
];

/**
 * The ONE outcome status that cannot carry a formal run (Req 12.29).
 *
 * `satisfies` rather than a bare literal, so a rename of the status breaks here instead of
 * silently retiring the rule.
 */
const SETUP_FAILED = 'setup-failed' satisfies SampleOutcomeStatus;

/** The budget stop reasons a record may carry; a closed set, validated on read. */
const STOP_REASONS: readonly BudgetStopReason[] = [
  'max-iterations',
  'max-tokens',
  'max-wall-clock',
  'max-cost',
];

/**
 * The golden outcome kinds a record may carry; a closed set, validated on read.
 *
 * The RECORDED vocabulary from `../golden-judge.js`, read from its single owner rather than
 * restated, so the persisted set and the set the golden denominator is decided over cannot
 * drift. Deliberately NOT the banner grammar in `../corpus/golden-banner.js`: a v8 record's
 * single `error` is the sum of three causes, and the decoder must refuse it rather than pick
 * one (see `RESULTS_SCHEMA_VERSION`).
 */
const GOLDEN_KINDS: readonly RecordedGoldenKind[] = RECORDED_GOLDEN_KINDS;

/** The instrument validities a record may carry; a closed set, validated on read. */
const INSTRUMENT_VALIDITIES: readonly InstrumentValidity[] = ['valid', 'invalid', 'unchecked'];

/** The instrument defect codes a record may carry; a closed set, validated on read. */
const INSTRUMENT_DEFECTS: readonly InstrumentDefectCode[] = [
  'TESTBENCH_FAILED_REFERENCE',
  'TESTBENCH_REFERENCE_UNBUILDABLE',
  'CONTROL_RUN_ERRORED',
  'TESTBENCH_SURVIVED_MUTANTS',
];

/**
 * The instrument-unchecked reasons a record may carry; a closed set, validated on read.
 *
 * `../instrument-control.js` exports the type but no enumerable array of its members (unlike
 * `RECORDED_GOLDEN_KINDS`, which `../golden-judge.js` does export), so this list is kept here as
 * a local const, following the exact precedent of `INSTRUMENT_DEFECTS` above. Every member of
 * `InstrumentUncheckedReason` must appear exactly once; a member added there and not here is a
 * silent gap that a new reason would fail to round-trip against, which is what
 * `results-log.test.ts`'s exhaustive round-trip test over all 9 members would catch.
 */
const INSTRUMENT_UNCHECKED_REASONS: readonly InstrumentUncheckedReason[] = [
  'control-absent',
  'no-testbench',
  'no-reference',
  'testbench-unsubmittable',
  'control-unavailable',
  'no-mutants-generated',
  'no-valid-mutants',
  'no-golden-killed-mutants',
  'mutation-probe-unavailable',
  'control-resource-exhausted',
];

/**
 * The repair decline reasons a record may carry; a closed set, validated on read.
 *
 * `@app/agent` exports `RepairDeclineReason` as a type but no enumerable array of its
 * members, so this list is kept here as a local const, following the exact precedent of
 * `INSTRUMENT_UNCHECKED_REASONS` above. Every member must appear exactly once; a member
 * added there and not here is a silent gap a new reason would fail to round-trip against.
 */
const REPAIR_DECLINE_REASONS: readonly RepairDeclineReason[] = [
  'no-admissible-revision',
  'coverage-validation-failed',
  'recheck-failed',
  'port-threw',
  'port-unavailable',
];

/**
 * The Formal_Verdicts a record may carry; a closed set, validated on read (Req 12.12).
 *
 * Read from `@app/tools`, the vocabulary's single owner, rather than restated here - the same
 * rule `GOLDEN_KINDS` follows and the opposite of `INSTRUMENT_UNCHECKED_REASONS`, which is a
 * local const only because its owner exports no enumerable array. A fourth Formal_Verdict
 * therefore arrives here automatically instead of silently failing to round-trip.
 */
const FORMAL_VERDICT_MEMBERS: readonly FormalVerdict[] = FORMAL_VERDICTS;

/** The Could_Not_Verify_Causes a record may carry; a closed set, validated on read (Req 12.12). */
const COULD_NOT_VERIFY_MEMBERS: readonly CouldNotVerifyCause[] = COULD_NOT_VERIFY_CAUSES;

/** The Clock_Contract polarities a record may carry; a closed set, validated on read. */
const CLOCK_POLARITY_MEMBERS: readonly ClockPolarity[] = CLOCK_POLARITIES;

/**
 * The Property_Set admission outcomes a record may carry; a closed FOUR-member set.
 *
 * Read from `@app/agent`, which owns it. FOUR members and not two, and never a boolean: a gate
 * that ran and had NOTHING to hold the set to (`'no-gate-set'`) is neither an admission nor a
 * refusal, and no gate running at all (`'not-gated'`) is a third distinct fact. Collapsing
 * `'no-gate-set'` onto `'admitted'` would record a vacuous pass as a demonstrated one, onto
 * `'refused'` would record a refusal that never happened, and onto a `null` would conflate "no
 * gate ran" with "unknown".
 */
const PROPERTY_SET_ADMISSIONS: readonly PropertySetAdmissionOutcome[] =
  PROPERTY_SET_ADMISSION_OUTCOMES;

/**
 * The Fallback_Routes a record may carry; a closed FOUR-member set (Req 7.21).
 *
 * Read from `@app/agent`, which owns it, by the rule `PROPERTY_SET_ADMISSIONS` follows: the
 * Verification_Loop decides the route and this reader only validates it, so a fifth member
 * added there is covered here without an edit instead of being silently refused.
 */
const FALLBACK_ROUTE_MEMBERS: readonly FallbackRoute[] = FALLBACK_ROUTES;

/**
 * Most survived operator ids one record may carry.
 *
 * The mutant cap is well below this, so the bound is never reached by our own writer; it
 * exists because the results file is untrusted on read and a hand-edited line must not be
 * able to allocate without limit.
 */
export const MAX_RECORDED_SURVIVORS = 64;

/**
 * What the Formal_Oracle established for one sample, rolled up to the ONE result that
 * decided it (Req 12.11).
 *
 * THE PER-SAMPLE ROLL-UP RULE: `refuted` beats `could-not-verify` beats `proved`, because a
 * REFUTATION IS THE FINDING. A Property_Set holding both a refuted property and one that
 * could not be verified is decided `unverified` from the refutation (Req 7.17), fail-closed:
 * the alternative lets a passing Simulation_Fallback carry `Verified` on a design a formal
 * counterexample refuted, which is the severity-1 direction. This record matches that
 * precedence rather than restating it, so the verdict on the record and the verdict the loop
 * decided the sample from are the same fact.
 *
 * Every field below comes from the SAME chosen result, never mixed across properties: a depth
 * read off one property beside a cause read off another would describe a run that never
 * happened. The per-property detail stays on the sample's artifacts, which is where a reader
 * who needs all of it looks.
 *
 * Nested as ONE object rather than a spread of sibling nullable columns, for the reason
 * `mutation` is: "a property was submitted" and "none was" is a single decision that cannot
 * half-hold, so a record cannot carry a Proof_Depth without the verdict it belongs to.
 */
export interface RecordedFormalRun {
  /** The verdict the sample was decided from, under the precedence above. */
  readonly verdict: FormalVerdict;
  /** The single cause behind a `could-not-verify` verdict, `null` for the other two. */
  readonly cause: CouldNotVerifyCause | null;
  /**
   * Which of the FIVE Proof_Conditions held for that result.
   *
   * A `proved` result carries its `ProvedEvidence` here, which is the same five facts in
   * their admitting form, so the field is total over all three verdicts.
   */
  readonly conditions: ProofConditions;
  /** The Proof_Depth the result was reached at. */
  readonly depth: number;
  /** Wall clock that result's run took, including a run that timed out (Req 7.5). */
  readonly elapsedMs: number;
}

/** One completed sample of one arm: the unit of work, of resume, and of aggregation. */
/** The Positive_Control run facts a record carries: four booleans, no tool-written name. */
export interface RecordedPositiveControlRun {
  readonly passed: boolean;
  readonly watchdogStopped: boolean;
  readonly waveformMissing: boolean;
  readonly knownAnswerOnlyFailure: boolean;
}

export interface SweepSampleRecord {
  readonly schemaVersion: number;
  /** The experiment this sample belongs to; resume ignores any other. */
  readonly configHash: string;
  readonly armName: string;
  /**
   * The arm's model ids, rendered stably.
   *
   * Persisted so the file is self-describing: a row states which model produced it
   * without the reader holding the config. The summary also uses it to detect an arm
   * name reused for two different model sets in one file.
   */
  readonly modelSignature: string;
  readonly problemId: string;
  readonly sampleIndex: number;
  /** The deterministic seed this sample was drawn with. */
  readonly seed: number;
  /** Whether the loop's own Simulator oracle passed it - the sole pass authority. */
  readonly passed: boolean;
  readonly outcomeStatus: SampleOutcomeStatus;
  /** Loop iterations; 1 on a pass means the first candidate passed (first-try). */
  readonly iterations: number;
  /**
   * Cents this session consumed against its student caps - the SECONDARY cost figure.
   *
   * Secondary because it is not measured: the endpoint returns tokens, never money, so
   * this is a token count multiplied by an external rate card. Meaningless unless
   * `costKnown` is true. The measured figures are the token counts and `durationMs`.
   */
  readonly costCents: number;
  /**
   * Whether every model this arm used had a configured price.
   *
   * `false` means `costCents` is a FLOOR of unknown tightness, not a measurement, so
   * the summary reports the arm's cost in DOLLARS as UNKNOWN rather than printing a
   * misleading number. It says nothing about the token counts below, which are measured
   * whether or not a price was configured. Persisted per record so a standalone
   * summarize needs no config.
   */
  readonly costKnown: boolean;
  /**
   * Prompt tokens the providers reported for this session (MEASURED).
   *
   * Persisted flat beside `costCents`, not nested, because tokens are metered on every
   * sample - there is no "not measured" case for the tally to hold together as one
   * decision, which is why `mutation` below is nested and this is not.
   */
  readonly promptTokens: number;
  /** Completion tokens the providers reported for this session (MEASURED). */
  readonly completionTokens: number;
  /**
   * Total tokens the session's budget accounted (MEASURED).
   *
   * The provider's own total, kept rather than derived from the two counts above, because
   * a host may report a `total_tokens` that is not their sum.
   */
  readonly totalTokens: number;
  /**
   * Model calls whose provider reported no usable `usage` block.
   *
   * The honesty channel for the three counts above: non-zero means they are floors, so a
   * per-artifact rate computed from them understates real consumption. A session that made
   * no model call has 0 here AND 0 tokens, and that pair is a genuine measurement - which
   * is the distinction this field exists to preserve.
   */
  readonly unreportedUsageCalls: number;
  readonly stopReason: BudgetStopReason | null;
  /**
   * The INDEPENDENT golden judge's outcome, or null when the sample was unjudgeable.
   *
   * THE FIELD THE GOLDEN pass@k DENOMINATOR DEPENDS ON, which is why widening it bumped the
   * schema version. `passed` and `failed` are a verdict on the candidate's BEHAVIOUR and put
   * the sample INSIDE that denominator; the other three each say the judge reported no such
   * verdict, and each is excluded and counted under its own reason (see
   * `countsInGoldenPassAtK`). The narrower banner grammar collapsed all three into one
   * `error`, which is a bucket nobody can act on.
   */
  readonly goldenVerdict: RecordedGoldenKind | null;
  /** Failures the golden testbench reported, or null when it printed no count. */
  readonly goldenFailureCount: number | null;
  /**
   * Whether the POSITIVE CONTROL proved this sample's own testbench a usable instrument.
   *
   * The field pass@k's denominator depends on, which is why its introduction bumped the
   * schema version. `invalid` means the known-good reference design does not pass our
   * testbench, so `passed` above says nothing about the model and the sample is EXCLUDED
   * from the denominator while still being reported.
   */
  readonly instrumentValidity: InstrumentValidity;
  /**
   * How an invalid instrument failed, or null when it is not invalid.
   *
   * Recorded because "our testbench did not build with the reference" and "our testbench
   * built and rejected the reference" point at different defects.
   */
  readonly instrumentDefect: InstrumentDefectCode | null;
  /**
   * Why an `unchecked` instrument is unchecked, or null when it is not unchecked.
   *
   * Required rather than optional, matching `instrumentValidity` itself: a sample that IS
   * checked has no unchecked reason to carry, so `null` there is not a placeholder, it is
   * the accurate value. When `instrumentValidity === 'unchecked'` this is one of the 9 real
   * `InstrumentUncheckedReason` members, never absent-by-omission - `instrumentVerdictOf`
   * used to flatten every `unchecked` record onto `control-unavailable` for exactly the want
   * of this field (see `RESULTS_SCHEMA_VERSION`'s v9 -> v10 note). An unreadable reason on an
   * `unchecked` record REFUSES the whole record rather than degrading to a guessed reason:
   * unlike `noVerdictCause`, which degrades leniently because being wrong about deferrability
   * either wastes a re-run or spends money retrying a real result, an unchecked sample is
   * never re-run and never enters pass@k either way, so there is no such asymmetric cost to
   * lean on - only the cost of asserting a specific cause nobody measured, which is the exact
   * defect this field exists to close.
   */
  readonly instrumentUncheckedReason: InstrumentUncheckedReason | null;
  /**
   * What the NEGATIVE control measured for this sample, or `null` when it measured nothing.
   *
   * Nested as ONE object rather than a spread of sibling nullable columns, so "probed" and
   * "not probed" is a single decision that cannot half-hold: a record cannot carry a kill
   * count without the VALID count it is a fraction of.
   *
   * Survivors are persisted as OPERATOR IDS only - a closed set, no free text - and in TWO
   * lists, because the split between "the independent judge killed this and we did not" and
   * "neither of us killed it" is a golden-testbench fact the results file is the only record
   * of. The line, column, and source excerpt of each survivor live in the per-sample
   * artifacts, which is where source-bearing text already belongs.
   */
  readonly mutation: MutationSampleCounts | null;
  /**
   * Wall clock this whole sample took, measured by the sweep runner (MEASURED).
   *
   * The numerator of wall-clock per verified artifact. It covers EVERYTHING the slot did -
   * the loop's model calls and simulations, the independent golden judge, and both
   * instrument controls - because that is the elapsed time the sample actually cost an
   * operator. It is deliberately NOT the budget's charged wall clock, which counts only
   * the loop; one measured wall clock that a summary can name is worth more than two an
   * operator has to choose between.
   */
  readonly durationMs: number;
  readonly completedAtMs: number;
  /**
   * A short sanitized classification when the sweep itself could not obtain a verdict
   * (for example the harness threw), else null. Never a stack trace, host, or path.
   */
  readonly failureNote: string | null;
  /**
   * The TYPED reason this sample reached no oracle verdict, or null when it reached one.
   *
   * THE FIELD RESUME DEPENDS ON, which is why introducing it bumped the schema version.
   * `failureNote` above is the same fact as prose for an operator; this is the same fact as a
   * value, and it is the ONLY thing that separates a slot the campaign finished from a slot a
   * provider outage prevented it from starting. An infrastructure cause makes the record
   * DEFERRED: it stays in the file as evidence, `CompletedSampleIndex` leaves it out, and the
   * summary announces it. A finding - a testbench that misses a criterion, a budget cap doing
   * its job - stays final and is never re-run.
   *
   * Deliberately not derived from `failureNote`: the note renders as
   * `testbench-unavailable: ALL_PROVIDERS_FAILED` and matching that text would work today,
   * but it would make an operator-facing sentence load-bearing, so a reword or a truncation
   * at `MAX_FAILURE_NOTE_LENGTH` would silently turn deferred samples back into
   * measurements. See `../no-verdict-cause.ts`.
   */
  readonly noVerdictCause: NoVerdictCause | null;
  /**
   * Whether a Testbench_Repair was attempted for this sample at the one trigger point
   * that can reach one (`RepairProvenance.attempted` from `@app/agent`, copied verbatim).
   *
   * Required, not optional, matching `instrumentValidity` itself: the Testbench_Repair
   * capability either exists for the build that measured this sample or it does not, and a
   * record written under a build where it did not exist has no honest way to answer this
   * question - see `RESULTS_SCHEMA_VERSION`'s v10 -> v11 note. `false` is not a placeholder
   * here, it is the accurate value for the (still-common) case where the first draft passed
   * both controls and no repair was ever triggered.
   */
  readonly repairAttempted: boolean;
  /**
   * Whether the Testbench_Repair attempt produced the testbench this sample's final
   * `instrumentValidity` was decided from (`RepairProvenance.accepted` from `@app/agent`,
   * copied verbatim).
   *
   * Required, not optional, for the same reason `repairAttempted` is. Always `false` when
   * `repairAttempted` is `false` - an accepted repair implies an attempted one, so a record
   * claiming the opposite did not come from real code and is refused on decode rather than
   * trusted (see `decodeSampleRecord`).
   */
  readonly repairAccepted: boolean;
  /**
   * Which stage a declined Testbench_Repair attempt declined at, or `null` when this
   * sample's repair was accepted or never attempted (`repairDeclineReasonOf(provenance)`
   * from `@app/agent`, copied verbatim).
   *
   * Required, not optional, matching `repairAccepted` itself: `null` is the ACCURATE value
   * for an accepted-or-not-attempted record, not a placeholder standing in for one, and a
   * record where `repairAttempted` is `true` and `repairAccepted` is `false` has no honest
   * `null` to carry here - the same closed-vocabulary reasoning `instrumentUncheckedReason`
   * already applies to `instrumentValidity: 'unchecked'`. An unreadable value on a record
   * that IS declined is refused on decode rather than defaulted (see `decodeSampleRecord`),
   * because every reason string asserts a specific stage nobody may have measured.
   */
  readonly repairDeclineReason: RepairDeclineReason | null;
  /**
   * Council B's early-warning signal (Req 5.8, 5.11), copied verbatim from
   * `checkNameVisibilitySignalOf` in `../harness.js`: whether the Dialect_Normalizer changed
   * this sample's testbench, the changed testbench then passed the Positive_Control, and a
   * check name the pre-normalization source emitted is absent from the names the control's
   * own stdout reports.
   *
   * Sourced from two values the harness already computed for the sample's own verdict, so
   * persisting it costs no extra control run. Changes NO verdict: it is written here and to
   * the artifact only, and read back nowhere, matching `checkNameVisibilitySignalOf`'s own
   * doc comment - it cannot alter the Verification_Loop's oracle verdict or the
   * Golden_Judge's verdict for any sample.
   */
  readonly checkNameVisibilitySignal: boolean;
  /** The Strategy_Arm the sample's arm declared, `control` when it declared none (Req 7.4). */
  readonly strategyArm: StrategyArm;
  /** How the sample's testbench decided when to compare (Req 1.8). */
  readonly checkingApproach: CheckingApproach;
  /** Which half of the Campaign the design reports in (Req 7.4). */
  readonly designGroup: DesignGroup;
  /** The `TESTBENCH_PROMPT_VERSION` the sample was generated under (Req 7.5). */
  readonly testbenchPromptVersion: number;
  /** The `SIMULATION_HARNESS_VERSION` every Testbench_Run of this sample compiled (Req 9.5). */
  readonly simulationHarnessVersion: number;
  /** Why the Testbench_Parser refused this sample's reply, or `null` when it did not (Req 7.10). */
  readonly testbenchParseRefusal: TestbenchParseRefusal | null;
  /**
   * What the Positive_Control run itself showed, or `null` when none ran (Req 5.11).
   *
   * Four booleans: the control's own failing check NAMES are tool output and are reduced to
   * `knownAnswerOnlyFailure` by the harness before they could reach a record.
   */
  readonly positiveControlRun: RecordedPositiveControlRun | null;
  /**
   * Failure reports in the measured testbench that carry no observed value (Req 5.4), or
   * `null` when no testbench was measured; `null` is never folded into `0` (Req 2.8).
   */
  readonly valuelessFailureReports: number | null;
  /**
   * What the Formal_Oracle established for this sample, or `null` when no Formal_Property
   * was submitted at all (Req 12.11).
   *
   * `null` is the honest value and not a placeholder: the unit of this field is a submitted
   * property, so no submission is no record - the same reasoning `FormalProvenance.results`
   * applies to its own empty array. It covers three real cases the sibling fields below then
   * tell apart: no formal gate was wired, a gate ran over an empty Property_Set, and the
   * oracle port failed before any property could be submitted (where `formalFallbackReason`
   * is non-`null` over an absent run).
   *
   * See `RecordedFormalRun` for the roll-up precedence and why the five facts are nested.
   */
  readonly formal: RecordedFormalRun | null;
  /**
   * The Could_Not_Verify_Cause that made this sample take the Simulation_Fallback, or `null`
   * where it did not (Req 7.9).
   *
   * FLAT rather than inside `formal` above, and that is load-bearing: a run whose oracle port
   * threw records `toolchain-unavailable` here with NO submitted property, so nesting it would
   * delete the fallback from exactly the samples whose fallback is least expected.
   *
   * Copied verbatim from `FormalProvenance.fallbackReason`, so the closed shape the loop
   * recorded is the closed shape persisted (Req 7.8) - never re-derived from a note.
   */
  readonly formalFallbackReason: CouldNotVerifyCause | null;
  /**
   * WHY this sample did or did not take the Simulation_Fallback: one member of the closed
   * four-member Fallback_Route vocabulary, persisted for EVERY sample (Req 7.21).
   *
   * THE FIELD THAT MAKES A FALL BACK EXPLICABLE ON EVERY ROUTE. `formalFallbackReason` alone
   * answers only the cause-driven route: a REFUSED Property_Set and a Property_Set holding no
   * Formal_Property both reach the Simulation_Fallback with no cause to name, so both used to
   * persist as an all-`null` formal block that reads exactly like a sample no formal gate was
   * wired for. Reading them back took a join across `formal`, `formalFallbackReason`, and
   * `propertySetAdmitted`, and the join could not tell the empty set from the absent gate at
   * all. The route states the fact directly, which is why Req 7.22's per-route counts rest on
   * this field and not on a re-derivation.
   *
   * NEITHER OF THOSE TWO ROUTES IS A `CouldNotVerifyCause`, deliberately: every cause-keyed
   * count in the summary is built on that vocabulary, and a refusal says the Property_Set was
   * blunt while an empty set says nothing was asked - neither is a fact about the
   * Formal_Oracle's verdict. See `FALLBACK_ROUTES` in `@app/agent` for the whole argument.
   *
   * REQUIRED PRESENT and non-nullable, by the rule `propertySetAdmitted` follows:
   * `'not-applicable'` already states the fact an absent field would carry, so a deleted key
   * must refuse the record rather than read as "this sample did not fall back".
   *
   * Copied verbatim from `FormalProvenance.fallbackRoute`, never re-derived here, so the
   * record and the loop cannot disagree about which gate decided a sample.
   */
  readonly formalFallbackRoute: FallbackRoute;
  /**
   * The derived Reset_Contract this sample's formal run was taken under - its reset net, its
   * polarity, its kind as synchronous or asynchronous, its free-initial-state fact, and the
   * enable it fires under where one was named - or `null` where the pre-pass was NEVER REACHED
   * (Req 12.21).
   *
   * `null` AND `{ derived: false }` ARE DIFFERENT FACTS AND STAY SO THROUGH THE ROUND TRIP.
   * `null` means no contract was derived at all, because the pre-pass did not run or its
   * report could not be read. `{ derived: false }` means the pre-pass RAN and positively
   * REFUSED to derive one - two reset nets, two polarities, no net at all - which is a
   * recorded outcome rather than an error (Req 14.20). An enable-gated reset is NOT among them:
   * it derives, and the contract carries the enable (criterion 4.15 of
   * `formal-gate-first-light`, which AMENDS Req 14.19). The assertion-gate emission below is a
   * FUNCTION of this contract, so a record conflating the two could not explain its own gate.
   *
   * The `ResetContract` union `app/tools` already owns, not a parallel shape, for the reason
   * `FormalProvenance` gives: that union is `renderPropertyWrapper`'s own parameter, so a
   * second structurally-similar type would let the record and the wrapper drift apart on the
   * one value they must agree about.
   */
  readonly formalResetContract: ResetContract | null;
  /**
   * Whether the `if (!$initstate)` assertion gate was emitted into the Property_Wrapper
   * (Req 12.21).
   *
   * A separate persisted fact rather than one re-derived from the contract on read: the gate's
   * emission is the OUTPUT of a two-condition rule over a synchronous reset AND a free initial
   * state, and `emitsAssertionGate` also reads the PROPERTY, which this record does not carry.
   * Re-deriving it here would be a second implementation of that rule, free to disagree with
   * the wrapper that was actually built.
   *
   * A plain non-nullable boolean across every no-run case, because the gate genuinely was not
   * emitted in any of them; `formalResetContract` is the field that distinguishes a refusal
   * from a reading that never happened.
   */
  readonly formalAssertionGateEmitted: boolean;
  /**
   * The Clock_Contract this sample's formal run was taken under, or `null` where the pre-pass
   * was never reached (Req 12.21).
   *
   * `null` is NOT `'none'`: `'none'` is the SUPPORTED no-clocked-state finding, a real reading
   * of a real design, and collapsing an absent reading onto it would record a clock contract
   * the run was never taken under. A value outside the four-member vocabulary REFUSES the
   * record rather than defaulting, for the reason `goldenVerdict` is refused.
   */
  readonly formalClockPolarity: ClockPolarity | null;
  /**
   * What the Property_Set_Admission gate made of the Property_Set this sample's formal verdict
   * would have rested on (Req 10.8).
   *
   * One member of a closed FOUR-member vocabulary, never a boolean: the gate admitted the set,
   * the gate ran and had nothing to hold it to (`'no-gate-set'`), the gate refused it, or no
   * gate ran at all (`'not-gated'`). Never nullable, for the reason `instrumentValidity` is
   * never nullable - a sample nothing could be gated for is `'not-gated'`, which is a
   * statement, where an absent field would silently read as gated-and-passed.
   *
   * EVIDENCE ABOUT THE PROPERTY SET AND NEVER ABOUT THE CANDIDATE DESIGN (Req 10.10). A
   * refusal says the instrument is blunt; `passed` is still the simulation oracle's own
   * verdict for that sample (Req 10.3).
   */
  readonly propertySetAdmitted: PropertySetAdmissionOutcome;
  /**
   * Whether the harness authored this sample's Property_Set before the runner was called.
   *
   * REQUIRED PRESENT and non-nullable, by the rule `propertySetAdmitted` follows. It cannot be
   * derived from the admission outcome, which is the reason it exists: a gate that found no
   * reference design, or that threw, records `'not-gated'` AFTER the set was authored and
   * charged, so `'not-gated'` covers two samples with different `costCents`. A deleted key must
   * refuse the record rather than read as `false`, which would assert this sample paid for no
   * authoring.
   *
   * Rides task 7.5's bump of `RESULTS_SCHEMA_VERSION` to 14 and bumps nothing itself, so the
   * schema moves once and no sweep record is written between the two changes.
   */
  readonly propertySetAuthoredUpFront: boolean;
  /**
   * How many reference-design mutants survived this sample's Property_Set (Req 10.8).
   *
   * Zero for every outcome other than `'refused'`, and genuinely zero rather than defaulted:
   * an admitted set refuted every mutant in a non-empty gate set, and the other two outcomes
   * had no gate set for a mutant to survive. The survivor IDENTITIES stay in the eval layer's
   * own refusal, because a count is all a record needs to say how blunt the instrument was.
   */
  readonly propertySetSurvivorCount: number;
  /**
   * What the Property_Set_Admission gate's own calibrated mutant population measured, or
   * `null` where NO GATE RAN for this sample (Req 9.4, 9.6, 9.9).
   *
   * THE FIELD REQUIREMENT 9.4 HAD NO DATA PATH FOR. `couldNotVerifyCount` is the count of
   * mutants the Formal_Oracle could not reason about at all - a Yosys frontend rejection, a
   * proof timeout - and those mutants are COUNTED AND EXCLUDED rather than scored either way,
   * because counting one as a kill inflates the gate with mutants it never read and counting
   * one as a survival would refuse a Property_Set for a weakness nobody demonstrated. Until
   * this field existed the excluded mutant was tallied by `formalMutationCounts` and then
   * DROPPED one layer up, before the record, so no Sweep_Summary could report it.
   *
   * Nested as ONE object rather than five sibling nullable columns, for the reason `mutation`
   * is: the counts PARTITION one population - `totalCount === killedCount + survivedCount +
   * couldNotVerifyCount` - so a record cannot carry an excluded count without the denominator
   * it was excluded FROM. `denominator` here is the FORMAL gate's own and is NOT `mutation`'s
   * `validCount`: the two gates exclude different mutants, which is exactly why
   * `FormalMutationCounts` is its own type (Req 9.6).
   *
   * `null` IS A STATEMENT AND NOT A PLACEHOLDER, and it is the reading EVERY record carries
   * today: no production `PropertySetGate` is wired yet, so every sweep sample runs with the
   * gate absent and these counts read "NOT MEASURED" - which is the honest thing for the
   * summary to print, and is a reason to carry the field rather than a reason to defer it. A
   * `0` in its place would read as a gate that scored nothing, which is a different claim.
   * The key is therefore REQUIRED PRESENT on every record, explicitly `null` where no gate
   * ran (Req 12.34): deleting it from a line must not be able to assert a fact nobody
   * measured.
   */
  readonly formalMutationCounts: FormalMutationCounts | null;
}

/**
 * Project one run's `FormalProvenance` onto the fields a record persists (pure, total).
 *
 * THE PER-SAMPLE ROLL-UP RULE LIVES HERE: `refuted` beats `could-not-verify` beats `proved`,
 * because a refutation is the finding. See `RecordedFormalRun` for why, and Req 7.17 for the
 * fail-closed precedence this matches rather than restates.
 *
 * `propertySetAdmitted` and `propertySetSurvivorCount` are deliberately NOT derived here, even
 * though `FormalProvenance` carries an admission outcome: the authoritative measurement is the
 * eval-side gate's own, which the harness holds and the loop only receives a copy of. Deriving
 * it from the provenance would give one fact two sources, free to disagree.
 */
export function recordedFormalRun(formal: FormalProvenance): RecordedFormalRun | null {
  const deciding = decidingResult(formal.results);
  if (deciding === null) {
    return null;
  }
  return {
    verdict: deciding.verdict,
    cause: deciding.verdict === 'could-not-verify' ? deciding.cause : null,
    // A `proved` result carries its `ProvedEvidence`, the same five facts in admitting form.
    conditions: deciding.verdict === 'proved' ? deciding.evidence : deciding.conditions,
    depth: deciding.depth,
    elapsedMs: deciding.elapsedMs,
  };
}

/**
 * The ONE result a sample is recorded from, under the roll-up precedence, or `null` when no
 * Formal_Property was submitted.
 *
 * Fail-closed in the same direction `#runFormalGate` decides the sample: a refutation is looked
 * for before a `could-not-verify`, so a set holding both records the refutation. The first
 * member of the winning verdict is taken, which is deterministic because `results` is in
 * submission order.
 */
export function decidingResult(results: readonly PropertyResult[]): PropertyResult | null {
  return (
    results.find((result) => result.verdict === 'refuted') ??
    results.find((result) => result.verdict === 'could-not-verify') ??
    results.find((result) => result.verdict === 'proved') ??
    null
  );
}

/** The key identifying one sample slot within one experiment. */
export function sampleKey(armName: string, problemId: string, sampleIndex: number): string {
  return `${armName}\u0000${problemId}\u0000${sampleIndex}`;
}

/** Serialize one record as a single JSONL line (no trailing newline). */
export function encodeSampleRecord(record: SweepSampleRecord): string {
  return JSON.stringify(record);
}

/** Narrow an unknown to a plain object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A non-negative finite number, or null. */
function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A non-negative integer, or null. */
function nonNegativeInt(value: unknown): number | null {
  const numeric = nonNegative(value);
  return numeric !== null && Number.isInteger(numeric) ? numeric : null;
}

/** A member of a closed string set, or null (absent and invalid are the same). */
function member<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : null;
}

/** An optional member of a closed string set: null for absent, invalid, or explicit null. */
function optionalMember<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return value === null || value === undefined ? null : member(value, allowed);
}

/** The identity fields of a record, validated together. */
interface RecordIdentity {
  readonly configHash: string;
  readonly armName: string;
  readonly modelSignature: string;
  readonly problemId: string;
  readonly sampleIndex: number;
}

/** The Campaign and harness fields of a v17 record. */
interface RecordStrategy {
  readonly strategyArm: StrategyArm;
  readonly checkingApproach: CheckingApproach;
  readonly designGroup: DesignGroup;
  readonly testbenchPromptVersion: number;
  readonly simulationHarnessVersion: number;
  readonly testbenchParseRefusal: TestbenchParseRefusal | null;
  readonly positiveControlRun: RecordedPositiveControlRun | null;
  readonly valuelessFailureReports: number | null;
}

/** Decode the four Positive_Control booleans; any non-boolean makes the record undecodable. */
function decodePositiveControlRun(raw: unknown): RecordedPositiveControlRun | null | undefined {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const fields = raw as Record<string, unknown>;
  const read = (name: string): boolean | undefined => {
    const value = fields[name];
    return typeof value === 'boolean' ? value : undefined;
  };
  const passed = read('passed');
  const watchdogStopped = read('watchdogStopped');
  const waveformMissing = read('waveformMissing');
  const knownAnswerOnlyFailure = read('knownAnswerOnlyFailure');
  if (
    passed === undefined ||
    watchdogStopped === undefined ||
    waveformMissing === undefined ||
    knownAnswerOnlyFailure === undefined
  ) {
    return undefined;
  }
  return { passed, watchdogStopped, waveformMissing, knownAnswerOnlyFailure };
}

/**
 * Decode the Campaign fields by set membership, refusing a `control` record that claims the
 * scoreboard: the Control_Arm routes Cycle_Timed by construction, so that pair is not real.
 */
function decodeStrategyFields(raw: Record<string, unknown>): RecordStrategy | null {
  const strategyArm = member(raw.strategyArm, STRATEGY_ARMS);
  const checkingApproach = member(raw.checkingApproach, CHECKING_APPROACHES);
  const designGroup = member(raw.designGroup, DESIGN_GROUPS);
  const version = raw.testbenchPromptVersion;
  const harnessVersion = raw.simulationHarnessVersion;
  if (strategyArm === null || checkingApproach === null || designGroup === null) {
    return null;
  }
  for (const value of [version, harnessVersion]) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      return null;
    }
  }
  // The scoreboard is the Treatment_Arm's alone, so `control` and `grounded` both refuse it.
  if (checkingApproach === 'in-order-scoreboard' && strategyArm !== 'treatment') {
    return null;
  }
  // An unknown refusal code is undecodable rather than dropped: it would read as "parsed".
  const refusal =
    raw.testbenchParseRefusal === null
      ? null
      : member(raw.testbenchParseRefusal, TESTBENCH_PARSE_REFUSALS);
  if (refusal === null && raw.testbenchParseRefusal !== null) {
    return null;
  }
  const positiveControlRun = decodePositiveControlRun(raw.positiveControlRun);
  if (positiveControlRun === undefined) {
    return null;
  }
  // A malformed or absent count refuses the record: reading it as 0 would claim a measurement.
  const valuelessFailureReports = raw.valuelessFailureReports;
  if (
    valuelessFailureReports !== null &&
    (typeof valuelessFailureReports !== 'number' ||
      !Number.isSafeInteger(valuelessFailureReports) ||
      valuelessFailureReports < 0)
  ) {
    return null;
  }
  return {
    strategyArm,
    checkingApproach,
    designGroup,
    testbenchPromptVersion: version as number,
    simulationHarnessVersion: harnessVersion as number,
    testbenchParseRefusal: refusal,
    positiveControlRun,
    valuelessFailureReports,
  };
}

/** Validate the identity fields; every one is required for the record to be keyable. */
function decodeIdentity(raw: Record<string, unknown>): RecordIdentity | null {
  const configHash = str(raw.configHash);
  const armName = str(raw.armName);
  const problemId = str(raw.problemId);
  const sampleIndex = nonNegativeInt(raw.sampleIndex);
  if (configHash === null || armName === null || problemId === null || sampleIndex === null) {
    return null;
  }
  // A record written by an older build may lack the signature; treat it as unknown
  // rather than discarding an otherwise valid, already-paid-for sample.
  const modelSignature = str(raw.modelSignature) ?? 'unknown';
  return { configHash, armName, modelSignature, problemId, sampleIndex };
}

/** The measurement fields of a record, validated together. */
interface RecordMeasurement {
  readonly seed: number;
  readonly iterations: number;
  readonly costCents: number;
  readonly durationMs: number;
  readonly completedAtMs: number;
}

/** Validate the numeric measurement fields; all are required and non-negative. */
function decodeMeasurement(raw: Record<string, unknown>): RecordMeasurement | null {
  const seed = nonNegativeInt(raw.seed);
  const iterations = nonNegativeInt(raw.iterations);
  const costCents = nonNegative(raw.costCents);
  const durationMs = nonNegative(raw.durationMs);
  const completedAtMs = nonNegative(raw.completedAtMs);
  if (
    seed === null ||
    iterations === null ||
    costCents === null ||
    durationMs === null ||
    completedAtMs === null
  ) {
    return null;
  }
  return { seed, iterations, costCents, durationMs, completedAtMs };
}

/** The measured token fields of a record, validated together. */
interface RecordTokens {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly unreportedUsageCalls: number;
}

/**
 * Validate the token counts; ALL are required, so a missing one drops the record.
 *
 * Required rather than defaulted for the same reason `instrumentValidity` is: a default of
 * 0 is not a neutral placeholder here, it is the numerator of the campaign's headline
 * efficiency figure, and a zero would report the sample as having been produced for free.
 * `unreportedUsageCalls` is required for the mirror reason - without it a reader cannot
 * tell whether the counts beside it are complete or floors.
 *
 * Split out of `decodeMeasurement` rather than folded into it so each validator stays one
 * readable guard, matching `decodeMutationNumbers`.
 */
function decodeTokenCounts(raw: Record<string, unknown>): RecordTokens | null {
  const promptTokens = nonNegativeInt(raw.promptTokens);
  const completionTokens = nonNegativeInt(raw.completionTokens);
  const totalTokens = nonNegativeInt(raw.totalTokens);
  const unreportedUsageCalls = nonNegativeInt(raw.unreportedUsageCalls);
  if (
    promptTokens === null ||
    completionTokens === null ||
    totalTokens === null ||
    unreportedUsageCalls === null
  ) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens, unreportedUsageCalls };
}

/** A survivor-operator list from an untrusted record: bounded, closed-set, order kept. */
function decodeSurvivedOperators(raw: unknown): readonly MutationOperatorId[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const operators: MutationOperatorId[] = [];
  for (const entry of raw.slice(0, MAX_RECORDED_SURVIVORS)) {
    const operator = member(entry, MUTATION_OPERATORS);
    if (operator === null) {
      return null;
    }
    operators.push(operator);
  }
  return operators;
}

/** The numeric fields of a persisted mutation block, split out to keep the decoder small. */
type MutationCountNumbers = Omit<
  MutationSampleCounts,
  'coverageGapOperators' | 'candidateEquivalentOperators'
>;

/** The nested block's numeric fields, or `null` when any one of them is unreadable. */
function decodeMutationNumbers(record: Record<string, unknown>): MutationCountNumbers | null {
  const validCount = nonNegativeInt(record.validCount);
  const killedCount = nonNegativeInt(record.killedCount);
  const noVerdictKills = nonNegativeInt(record.noVerdictKills);
  const goldenSurvivedCount = nonNegativeInt(record.goldenSurvivedCount);
  const goldenTimeoutCount = nonNegativeInt(record.goldenTimeoutCount);
  const nonCompilingCount = nonNegativeInt(record.nonCompilingCount);
  const goldenErroredCount = nonNegativeInt(record.goldenErroredCount);
  const elapsedMs = nonNegative(record.elapsedMs);
  if (
    validCount === null ||
    killedCount === null ||
    noVerdictKills === null ||
    goldenSurvivedCount === null ||
    goldenTimeoutCount === null ||
    nonCompilingCount === null ||
    goldenErroredCount === null ||
    elapsedMs === null
  ) {
    return null;
  }
  return {
    validCount,
    killedCount,
    noVerdictKills,
    goldenSurvivedCount,
    goldenTimeoutCount,
    nonCompilingCount,
    goldenErroredCount,
    elapsedMs,
  };
}

/**
 * Decode the nested mutation counts, or `null` when the sample was not probed.
 *
 * Strict in the same way the rest of the record is: a partially readable block is dropped
 * whole rather than repaired, because a kill count without the VALID count it is a fraction of
 * would enter the summary as a kill rate that is not a fraction of anything real. `null` (not
 * probed) and unreadable therefore land in the same place - "no mutation evidence" - which is
 * the fail-safe direction, since the summary reports absent evidence as NOT MEASURED.
 *
 * The three internal-consistency checks are refusals, not repairs. More kills than valid
 * mutants, more no-verdict kills than kills, or more golden survivors than valid mutants each
 * mean the block did not come from a real probe, and inventing a plausible reading of it would
 * put a fabricated kill rate in a cited number.
 */
function decodeMutationCounts(raw: unknown): MutationSampleCounts | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const numbers = decodeMutationNumbers(record);
  const coverageGapOperators = decodeSurvivedOperators(record.coverageGapOperators);
  const candidateEquivalentOperators = decodeSurvivedOperators(record.candidateEquivalentOperators);
  if (numbers === null || coverageGapOperators === null || candidateEquivalentOperators === null) {
    return null;
  }
  if (
    numbers.killedCount > numbers.validCount ||
    numbers.noVerdictKills > numbers.killedCount ||
    numbers.goldenSurvivedCount > numbers.validCount
  ) {
    return null;
  }
  return { ...numbers, coverageGapOperators, candidateEquivalentOperators };
}

/**
 * Whether an untrusted golden-outcome value is READABLE at all.
 *
 * Absent and explicit `null` are readable and mean "this sample was never judged", which is a
 * real state the harness records. Anything else must be one of the five recorded kinds, and a
 * value outside them DROPS the whole record rather than degrading to `null`.
 *
 * That is deliberately stricter than `stopReason` and `instrumentDefect`, which do degrade.
 * `null` is not a neutral placeholder here: it asserts nobody judged the sample, so it would
 * move a judged sample from the golden denominator into the `unjudged` exclusion bucket and
 * quietly change both the numerator's divisor and the reason an operator is shown for it. The
 * value that most needs refusing is `error`, the banner-grammar kind older records carry: its
 * three causes are exactly what the widened vocabulary exists to distinguish, and there is no
 * reading of it that is not an invented cause.
 */
function readsAsGoldenKind(value: unknown): boolean {
  return value === null || value === undefined || member(value, GOLDEN_KINDS) !== null;
}

/**
 * Decode `instrumentUncheckedReason` against the validity it belongs to, or `null` when it is
 * unreadable - which INCLUDES the shape being wrong for the sample's own validity.
 *
 * Strict, matching `instrumentValidity` rather than `noVerdictCause`: an `unchecked` record
 * with no readable reason is refused whole rather than degraded to a guessed reason, because
 * every reason string asserts a specific unmeasured cause, and reading `control-unavailable`
 * into an unreadable field is the exact misclassification this field exists to stop repeating
 * (see the field's own doc comment on `SweepSampleRecord`). A `valid` or `invalid` sample must
 * carry `null` here - a checked instrument has no unchecked reason to carry - so a record that
 * claims BOTH a validity and an unrelated reason is exactly as untrustworthy as one missing a
 * reason it needs, and both are refused the same way.
 */
function decodeUncheckedReason(
  validity: InstrumentValidity,
  value: unknown,
): InstrumentUncheckedReason | null | typeof INVALID_SHAPE {
  if (validity !== 'unchecked') {
    return value === null || value === undefined ? null : INVALID_SHAPE;
  }
  const reason = member(value, INSTRUMENT_UNCHECKED_REASONS);
  return reason ?? INVALID_SHAPE;
}

/** Sentinel distinguishing "genuinely null" from "unreadable" in `decodeUncheckedReason`. */
const INVALID_SHAPE = Symbol('invalid-shape');

/**
 * Decode `repairDeclineReason` against this record's own `repairAttempted`/`repairAccepted`
 * pair, or `null` when it is unreadable - which INCLUDES the shape being wrong for that pair.
 *
 * Strict, matching `decodeUncheckedReason`'s exact reasoning: an accepted or never-attempted
 * record must carry `null` here - there is no decline to name a stage for - so a record
 * claiming BOTH is exactly as untrustworthy as a declined record missing its reason, and both
 * are refused the same way rather than one being defaulted and the other refused.
 */
function decodeRepairDeclineReason(
  attempted: boolean,
  accepted: boolean,
  value: unknown,
): RepairDeclineReason | null | typeof INVALID_SHAPE {
  if (accepted || !attempted) {
    return value === null || value === undefined ? null : INVALID_SHAPE;
  }
  const reason = member(value, REPAIR_DECLINE_REASONS);
  return reason ?? INVALID_SHAPE;
}

/**
 * An optional closed-set member, validated STRICTLY: absent and explicit `null` are readable
 * and mean "this fact does not apply", and any other non-member REFUSES the whole record.
 *
 * The strict counterpart of `optionalMember` above, which silently reads a non-member as `null`.
 * Used where `null` is itself a claim rather than a neutral placeholder - a `null`
 * `formalFallbackReason` asserts the sample did NOT take the Simulation_Fallback - which is the
 * same reasoning `readsAsGoldenKind` applies to a golden outcome.
 */
function strictOptionalMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null | typeof INVALID_SHAPE {
  if (value === null || value === undefined) {
    return null;
  }
  return member(value, allowed) ?? INVALID_SHAPE;
}

/** The Presat_Check values a record may carry; a closed set, validated on read. */
const PRESAT_CONDITIONS: readonly ProofConditions['presat'][] = [
  'satisfiable',
  'preunsat',
  'not-run',
];

/** The Base_Check values a record may carry; a closed set, validated on read. */
const BASE_CONDITIONS: readonly ProofConditions['base'][] = ['passed', 'failed', 'not-run'];

/** The Induction_Check values a record may carry; a closed set, validated on read. */
const INDUCTION_CONDITIONS: readonly ProofConditions['induction'][] = [
  'successful',
  'inconclusive',
  'not-run',
];

/** The Reset_Contract kinds a record may carry; a closed set, validated on read. */
const RESET_KINDS: readonly ('async' | 'sync')[] = ['async', 'sync'];

/**
 * Decode the antecedent Cover_Check, or `null` when it is unreadable.
 *
 * All three members stay distinct: a reached cover carries the STEP it was reached at,
 * `reached: false` is a cover that ran and was not reached, and `'not-applicable'` is the
 * unclocked case where no Cover_Check ran because an absent antecedent cannot be vacuous
 * (Req 5.10). A `reached: true` with no readable step is refused rather than read as
 * `reached: false`, which would turn a satisfied condition into a failed one.
 */
function decodeCoverCondition(raw: unknown): CoverCondition | null {
  const cover = asRecord(raw);
  if (cover === null) {
    return null;
  }
  if (cover.reached === true) {
    const step = nonNegativeInt(cover.step);
    return step === null ? null : { reached: true, step };
  }
  if (cover.reached === false) {
    return { reached: false };
  }
  return cover.reached === 'not-applicable' ? { reached: 'not-applicable' } : null;
}

/**
 * Decode the FIVE Proof_Conditions, or `null` when any one of them is unreadable.
 *
 * Strict and whole, like `decodeMutationCounts`: a partially readable set is dropped rather
 * than repaired, because four conditions beside a defaulted fifth is a record claiming a
 * condition was measured when it was not - and `admitProved` weighs all five.
 */
function decodeProofConditions(raw: unknown): ProofConditions | null {
  const conditions = asRecord(raw);
  if (conditions === null) {
    return null;
  }
  const assertionCount = nonNegativeInt(conditions.assertionCount);
  const presat = member(conditions.presat, PRESAT_CONDITIONS);
  const cover = decodeCoverCondition(conditions.cover);
  const base = member(conditions.base, BASE_CONDITIONS);
  const induction = member(conditions.induction, INDUCTION_CONDITIONS);
  if (
    assertionCount === null ||
    presat === null ||
    cover === null ||
    base === null ||
    induction === null
  ) {
    return null;
  }
  return { assertionCount, presat, cover, base, induction };
}

/**
 * Decode the derived Reset_Contract, keeping `null` and `{ derived: false }` DISTINCT.
 *
 * The whole point of this decoder. Absent or explicit `null` means the pre-pass was never
 * reached; `{ derived: false }` means it RAN and refused to derive a contract. Reading either
 * one as the other would leave the record unable to explain its own gate emission, because
 * `formalAssertionGateEmitted` is the output of a rule over this very value.
 *
 * A `derived: true` arm missing any of its four facts is refused rather than degraded to the
 * refused arm, which would record a refusal that never happened.
 */
function decodeResetContract(raw: unknown): ResetContract | null | typeof INVALID_SHAPE {
  if (raw === null || raw === undefined) {
    return null;
  }
  const contract = asRecord(raw);
  if (contract === null) {
    return INVALID_SHAPE;
  }
  if (contract.derived === false) {
    return { derived: false };
  }
  if (contract.derived !== true) {
    return INVALID_SHAPE;
  }
  const resetName = str(contract.resetName);
  const resetKind = member(contract.resetKind, RESET_KINDS);
  if (
    resetName === null ||
    resetKind === null ||
    typeof contract.resetActiveLow !== 'boolean' ||
    typeof contract.initialStateFree !== 'boolean'
  ) {
    return INVALID_SHAPE;
  }
  return {
    derived: true,
    resetName,
    resetActiveLow: contract.resetActiveLow,
    resetKind,
    initialStateFree: contract.initialStateFree,
  };
}

/**
 * Decode the rolled-up formal run, or `null` when no Formal_Property was submitted.
 *
 * Strict, like `readsAsGoldenKind` and for the same reason: `null` is not a neutral
 * placeholder here, it asserts that nothing was submitted, so a present-but-unreadable block
 * REFUSES the whole record rather than degrading to a claim nobody measured. Accepts only
 * members of the Formal_Verdict and Could_Not_Verify_Cause vocabularies (Req 12.12), and holds
 * the cause to the verdict it belongs to - exactly as `decodeUncheckedReason` holds a reason to
 * its own validity - so a `proved` record carrying a cause is as untrustworthy as a
 * `could-not-verify` record missing one.
 */
function decodeFormalRun(raw: unknown): RecordedFormalRun | null | typeof INVALID_SHAPE {
  if (raw === null || raw === undefined) {
    return null;
  }
  const run = asRecord(raw);
  const verdict = run === null ? null : member(run.verdict, FORMAL_VERDICT_MEMBERS);
  if (run === null || verdict === null) {
    return INVALID_SHAPE;
  }
  const conditions = decodeProofConditions(run.conditions);
  const depth = nonNegativeInt(run.depth);
  const elapsedMs = nonNegative(run.elapsedMs);
  const cause = decodeFormalCause(verdict, run.cause);
  if (conditions === null || depth === null || elapsedMs === null || cause === INVALID_SHAPE) {
    return INVALID_SHAPE;
  }
  return { verdict, cause, conditions, depth, elapsedMs };
}

/**
 * Decode the Could_Not_Verify_Cause against the verdict it belongs to, or `INVALID_SHAPE` when
 * the shape is wrong for that verdict.
 *
 * `decodeUncheckedReason`'s exact reasoning, one vocabulary over: a `could-not-verify` verdict
 * carries exactly one cause (Req 1.5), and a `proved` or `refuted` verdict has no cause to
 * carry, so a record claiming BOTH is exactly as untrustworthy as one missing a cause it needs
 * - and both are refused rather than one being defaulted.
 */
function decodeFormalCause(
  verdict: FormalVerdict,
  value: unknown,
): CouldNotVerifyCause | null | typeof INVALID_SHAPE {
  if (verdict !== 'could-not-verify') {
    return value === null || value === undefined ? null : INVALID_SHAPE;
  }
  return member(value, COULD_NOT_VERIFY_MEMBERS) ?? INVALID_SHAPE;
}

/**
 * Decode the Property_Set_Admission gate's own mutant counts, keeping ABSENT and `null`
 * DIFFERENT.
 *
 * Explicit `null` is readable and means NO GATE RAN, which is the state every sweep sample is
 * in until a production `PropertySetGate` is wired. An ABSENT key is `INVALID_SHAPE`, which
 * refuses the whole record: Req 12.34 requires every formal key present, because a deleted key
 * would otherwise read as that same "no gate ran" statement, letting a hand-edited line assert
 * a fact nobody measured. `strictOptionalMember` is therefore deliberately NOT the model here -
 * it reads absent as `null` - and the sentinel is used instead.
 *
 * Strict and WHOLE, like `decodeMutationCounts`: a partially readable block is dropped rather
 * than repaired, because an excluded-mutant count beside a defaulted denominator is a kill rate
 * that is not a fraction of anything real. The two internal refusals are the arithmetic this
 * type documents, and a block failing either did not come from `formalMutationCounts`, so
 * inventing a reading of it would put a fabricated exclusion tally in a cited number:
 *
 *   - THE PARTITION. Every calibrated mutant is killed, survived, or excluded, and nothing
 *     else: `totalCount === killedCount + survivedCount + couldNotVerifyCount`.
 *   - THE DENOMINATOR (Req 12.33). `denominator === killedCount + survivedCount`, because
 *     `formalMutationCounts` admits a mutant to the denominator on exactly the condition
 *     `formalMutantIsScorable` names, and the only unscorable calibration is the one
 *     `couldNotVerifyCount` tallies. So the denominator is not a free number beside the two
 *     scored counts, it IS their sum - which is what makes `formalKillRateOf`'s quotient a
 *     fraction of the mutants the oracle actually reasoned about. A denominator larger than
 *     that sum understates the kill rate over mutants nobody scored, and a smaller one
 *     overstates it; both read as a measurement.
 */
function decodeFormalMutationCounts(
  raw: unknown,
): FormalMutationCounts | null | typeof INVALID_SHAPE {
  if (raw === null) {
    return null;
  }
  const counts = asRecord(raw);
  if (counts === null) {
    return INVALID_SHAPE;
  }
  const totalCount = nonNegativeInt(counts.totalCount);
  const denominator = nonNegativeInt(counts.denominator);
  const killedCount = nonNegativeInt(counts.killedCount);
  const survivedCount = nonNegativeInt(counts.survivedCount);
  const couldNotVerifyCount = nonNegativeInt(counts.couldNotVerifyCount);
  if (
    totalCount === null ||
    denominator === null ||
    killedCount === null ||
    survivedCount === null ||
    couldNotVerifyCount === null ||
    totalCount !== killedCount + survivedCount + couldNotVerifyCount ||
    denominator !== killedCount + survivedCount
  ) {
    return INVALID_SHAPE;
  }
  return { totalCount, denominator, killedCount, survivedCount, couldNotVerifyCount };
}

/** The formal fields of a record, validated together; `null` when any one is unreadable. */
interface RecordFormal {
  readonly formal: RecordedFormalRun | null;
  readonly formalFallbackReason: CouldNotVerifyCause | null;
  readonly formalFallbackRoute: FallbackRoute;
  readonly formalResetContract: ResetContract | null;
  readonly formalAssertionGateEmitted: boolean;
  readonly formalClockPolarity: ClockPolarity | null;
  readonly propertySetAdmitted: PropertySetAdmissionOutcome;
  readonly propertySetAuthoredUpFront: boolean;
  readonly propertySetSurvivorCount: number;
  readonly formalMutationCounts: FormalMutationCounts | null;
}

/**
 * Every formal key a record of this schema version defines, as a TOTAL record of
 * `RecordFormal`'s own keys (Req 12.34).
 *
 * `satisfies` rather than a hand-kept list, so a tenth formal field added to `RecordFormal` is
 * a COMPILE ERROR here instead of a key that silently stops being required - which is the one
 * failure mode a presence rule has, since the rule is enforced by iterating this list.
 */
const FORMAL_KEY_PRESENCE = {
  formal: true,
  formalFallbackReason: true,
  formalFallbackRoute: true,
  formalResetContract: true,
  formalAssertionGateEmitted: true,
  formalClockPolarity: true,
  propertySetAdmitted: true,
  propertySetAuthoredUpFront: true,
  propertySetSurvivorCount: true,
  formalMutationCounts: true,
} satisfies Record<keyof RecordFormal, true>;

/** The formal keys, read off the total record above so the two cannot drift. */
const FORMAL_KEYS: readonly string[] = Object.keys(FORMAL_KEY_PRESENCE);

/** The ONE Fallback_Route a Fallback_Reason belongs to. `satisfies`, so a rename breaks here. */
const CAUSE_ROUTE = 'cause' satisfies FallbackRoute;

/** The ONE admission outcome a surviving mutant can be counted under. */
const REFUSED_ADMISSION = 'refused' satisfies PropertySetAdmissionOutcome;

/**
 * Validate the formal fields, or `null` when any one of them is unreadable.
 *
 * EVERY FORMAL KEY IS REQUIRED PRESENT (Req 12.34), and an explicit `null` is the only spelling
 * of a formal fact that does not apply. The guard is a single presence sweep over `FORMAL_KEYS`
 * rather than nine per-field checks, because the per-field decoders below read `undefined` as
 * `null` by design - `decodeFormalRun` reads it as "no Formal_Property was submitted",
 * `decodeResetContract` as "the pre-pass was never reached" - and each of those is a FACT, so a
 * deleted key would otherwise assert one nobody measured. `formalFallbackRoute`,
 * `formalAssertionGateEmitted`, `propertySetAdmitted`, `propertySetSurvivorCount`, and
 * `formalMutationCounts` already refuse an absent key on their own; the sweep makes the rule one
 * owner's rather than five separate accidents.
 *
 * `propertySetAdmitted` is non-nullable over its four members, matching `instrumentValidity`: a
 * sample nothing could be gated for carries `'not-gated'`, which is a statement, so an absent
 * field has no honest reading. `formalFallbackRoute` is non-nullable for the identical reason -
 * `'not-applicable'` is the statement an absent field would have to stand in for (Req 7.21).
 * Every other field here is optional in VALUE and strict in SHAPE - an explicit `null` means
 * the fact does not apply, and a non-member refuses the record rather than defaulting to a fact
 * nobody measured.
 *
 * TWO CROSS-FIELD RULES LIVE HERE, both over fields this function already holds, and each one
 * makes unreadable only a record no writer of this schema can produce:
 *
 *   - THE FALLBACK IFF (Req 12.31, 7.19). A Fallback_Reason sits beside the Fallback_Route
 *     `'cause'` and beside no other member. `formalProvenanceOf` in the Verification_Loop makes
 *     that true BY CONSTRUCTION off a discriminated `TakenRoute`, so neither half is
 *     producible: a reason under `'property-set-refused'` would name a Could_Not_Verify_Cause
 *     for a fall back no cause drove, and a `'cause'` route with no reason would claim a cause
 *     decided the sample while refusing to say which. Both read as measurements, and Req 7.22's
 *     per-route counts are computed off the route while the per-cause counts are computed off
 *     the reason, so a record violating the iff would be counted under a route and a cause that
 *     describe two different samples.
 *   - THE SURVIVOR RULE (Req 12.32, 10.8). A non-zero surviving-mutant count appears only
 *     beside `'refused'`. `recordedPropertySetAdmission` in the harness writes the count from
 *     the refusal's own survivors and zero for the other three outcomes, and that is not a
 *     convention but the arithmetic: an ADMITTED set refuted every mutant in a non-empty gate
 *     set, and `'no-gate-set'` and `'not-gated'` had no gate set for a mutant to survive. A
 *     survivor count under any of those three would report a demonstrated weakness in a
 *     Property_Set that was never refused for it.
 */
function decodeFormalFields(raw: Record<string, unknown>): RecordFormal | null {
  if (FORMAL_KEYS.some((key) => !Object.hasOwn(raw, key))) {
    return null;
  }
  const formal = decodeFormalRun(raw.formal);
  const formalResetContract = decodeResetContract(raw.formalResetContract);
  const formalFallbackReason = strictOptionalMember(
    raw.formalFallbackReason,
    COULD_NOT_VERIFY_MEMBERS,
  );
  const formalFallbackRoute = member(raw.formalFallbackRoute, FALLBACK_ROUTE_MEMBERS);
  const formalClockPolarity = strictOptionalMember(raw.formalClockPolarity, CLOCK_POLARITY_MEMBERS);
  const propertySetAdmitted = member(raw.propertySetAdmitted, PROPERTY_SET_ADMISSIONS);
  const propertySetSurvivorCount = nonNegativeInt(raw.propertySetSurvivorCount);
  const formalMutationCounts = decodeFormalMutationCounts(raw.formalMutationCounts);
  if (
    formal === INVALID_SHAPE ||
    formalResetContract === INVALID_SHAPE ||
    formalFallbackReason === INVALID_SHAPE ||
    formalClockPolarity === INVALID_SHAPE ||
    formalMutationCounts === INVALID_SHAPE ||
    formalFallbackRoute === null ||
    propertySetAdmitted === null ||
    propertySetSurvivorCount === null ||
    typeof raw.formalAssertionGateEmitted !== 'boolean' ||
    // Required present: an absent key would read as `false` and assert this sample paid for no
    // authoring, which is a fact nobody measured.
    typeof raw.propertySetAuthoredUpFront !== 'boolean'
  ) {
    return null;
  }
  if (
    // Req 12.31: the Fallback_Reason sits beside the `cause` route and beside nothing else.
    (formalFallbackReason !== null) !== (formalFallbackRoute === CAUSE_ROUTE) ||
    // Req 12.32: a survivor is counted only where the Property_Set was actually refused.
    (propertySetSurvivorCount > 0 && propertySetAdmitted !== REFUSED_ADMISSION)
  ) {
    return null;
  }
  return {
    formal,
    formalFallbackReason,
    formalFallbackRoute,
    formalResetContract,
    formalAssertionGateEmitted: raw.formalAssertionGateEmitted,
    formalClockPolarity,
    propertySetAdmitted,
    propertySetAuthoredUpFront: raw.propertySetAuthoredUpFront,
    propertySetSurvivorCount,
    formalMutationCounts,
  };
}

/**
 * Decode one untrusted record, or `null` when it is not a complete, valid record.
 *
 * Strict on purpose: a half-written or hand-edited line is DROPPED rather than
 * repaired, because a record with a plausible-looking default would enter the resume
 * index and the pass@k aggregation as if it were a real measured sample. `instrumentValidity`
 * is required for exactly that reason - defaulting it would invent a validated instrument,
 * `goldenVerdict` is refused for the mirror reason (see `readsAsGoldenKind`), and
 * `instrumentUncheckedReason` is refused for the same reason again (see
 * `decodeUncheckedReason`).
 */
export function decodeSampleRecord(raw: unknown): SweepSampleRecord | null {
  const record = asRecord(raw);
  if (record === null || record.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    return null;
  }
  const identity = decodeIdentity(record);
  const measurement = decodeMeasurement(record);
  const tokens = decodeTokenCounts(record);
  const outcomeStatus = member(record.outcomeStatus, OUTCOME_STATUSES);
  const instrumentValidity = member(record.instrumentValidity, INSTRUMENT_VALIDITIES);
  if (
    identity === null ||
    measurement === null ||
    tokens === null ||
    outcomeStatus === null ||
    instrumentValidity === null ||
    !readsAsGoldenKind(record.goldenVerdict)
  ) {
    return null;
  }
  if (
    typeof record.passed !== 'boolean' ||
    typeof record.costKnown !== 'boolean' ||
    typeof record.checkNameVisibilitySignal !== 'boolean'
  ) {
    return null;
  }
  if (typeof record.repairAttempted !== 'boolean' || typeof record.repairAccepted !== 'boolean') {
    return null;
  }
  // Internal-consistency refusal, mirroring `decodeMutationCounts`'s own contradictory-shape
  // checks: an accepted repair implies an attempted one, so a record claiming `accepted` with
  // no `attempted` did not come from real code and is refused rather than trusted.
  if (record.repairAccepted && !record.repairAttempted) {
    return null;
  }
  const instrumentUncheckedReason = decodeUncheckedReason(
    instrumentValidity,
    record.instrumentUncheckedReason,
  );
  if (instrumentUncheckedReason === INVALID_SHAPE) {
    return null;
  }
  const repairDeclineReason = decodeRepairDeclineReason(
    record.repairAttempted,
    record.repairAccepted,
    record.repairDeclineReason,
  );
  if (repairDeclineReason === INVALID_SHAPE) {
    return null;
  }
  const formalFields = decodeFormalFields(record);
  const strategy = decodeStrategyFields(record);
  if (formalFields === null || strategy === null) {
    return null;
  }
  // Req 12.29, the one cross-field rule that spans two decoders and therefore sits here rather
  // than in `decodeFormalFields`, which never sees the outcome status. A `setup-failed` sample
  // failed BEFORE a candidate or an independent testbench existed - `VerificationLoop#verify`
  // returns that outcome straight out of `#setup`, so no Formal_Property can have been
  // submitted and `recordedFormalRun` returns `null` for it by construction. A `setup-failed`
  // record carrying a formal run therefore did not come from real code, and reading one would
  // credit a Formal_Verdict to a sample whose candidate was never generated, putting it into
  // the per-verdict counts Req 12.17 reports.
  if (outcomeStatus === SETUP_FAILED && formalFields.formal !== null) {
    return null;
  }
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    ...identity,
    ...measurement,
    ...tokens,
    ...formalFields,
    ...strategy,
    passed: record.passed,
    outcomeStatus,
    costKnown: record.costKnown,
    checkNameVisibilitySignal: record.checkNameVisibilitySignal,
    repairAttempted: record.repairAttempted,
    repairAccepted: record.repairAccepted,
    repairDeclineReason,
    stopReason: optionalMember(record.stopReason, STOP_REASONS),
    goldenVerdict: optionalMember(record.goldenVerdict, GOLDEN_KINDS),
    goldenFailureCount: nonNegativeInt(record.goldenFailureCount),
    instrumentValidity,
    instrumentDefect: optionalMember(record.instrumentDefect, INSTRUMENT_DEFECTS),
    instrumentUncheckedReason,
    mutation: decodeMutationCounts(record.mutation),
    failureNote: str(record.failureNote),
    // Read leniently, unlike `instrumentValidity`, and the asymmetry is deliberate. An
    // unreadable cause resolves to `null`, which is NOT deferrable, so the slot reads as
    // final - the same reading it had before this field existed. The alternative, dropping
    // the whole record, would push a VERIFIED sample out of the index and re-charge for a
    // measurement that is already on disk. Being wrong towards "final" costs a re-run the
    // operator can ask for; being wrong towards "retry" spends money on its own.
    noVerdictCause: optionalMember(record.noVerdictCause, NO_VERDICT_CAUSES),
  };
}

/**
 * Rebuild the instrument verdict union from a record's flat fields.
 *
 * A record's `instrumentDefect` is untrusted, so an `invalid` record with no readable defect
 * resolves to `CONTROL_RUN_ERRORED` - still invalid, which is the fail-safe direction: the
 * sample stays out of the pass@k denominator. `instrumentUncheckedReason` is now PERSISTED and
 * decode-time validation already refuses any `unchecked` record whose reason is unreadable (see
 * `decodeUncheckedReason`), so a `SweepSampleRecord` that survived decoding can never actually
 * reach the `?? 'control-unavailable'` fallback below on a real `unchecked` record - it is kept
 * only for defense in depth, in case a `SweepSampleRecord` is ever constructed by a path other
 * than `decodeSampleRecord` (a test fixture, for instance).
 */
export function instrumentVerdictOf(record: SweepSampleRecord): RecordedInstrumentVerdict {
  if (record.instrumentValidity === 'valid') {
    return { validity: 'valid' };
  }
  if (record.instrumentValidity === 'invalid') {
    return { validity: 'invalid', defect: record.instrumentDefect ?? 'CONTROL_RUN_ERRORED' };
  }
  return {
    validity: 'unchecked',
    reason: record.instrumentUncheckedReason ?? 'control-unavailable',
  };
}

/** How healthy the results file a summary was computed from is. */
export interface ResultsLogHealth {
  /** Non-blank lines that did not decode; surfaced so corruption is visible. */
  readonly malformedLines: number;
  /**
   * Lines that ARE records but were written at a DIFFERENT schema version - older or newer.
   *
   * Counted separately from `malformedLines` because they are not corruption and the
   * remedy is different: corruption costs the affected lines, whereas another schema version
   * means the whole file must not be aggregated at all (see `STALE_SCHEMA_ADVICE`).
   *
   * Named for the older case, which is the one an operator meets: a lower version is what a
   * directory written before a bump holds. A HIGHER version is counted here too (Req 12.28)
   * and refuses the file by the same rule - see `readsAsOtherSchema` for why a record a newer
   * build wrote is history from the other direction rather than noise.
   */
  readonly staleSchemaLines: number;
}

/** What reading a results log produced, including how much of it was unusable. */
export interface ParsedResultsLog extends ResultsLogHealth {
  readonly records: readonly SweepSampleRecord[];
}

/** How one line of a results log classified. */
type LineOutcome =
  | { readonly kind: 'record'; readonly record: SweepSampleRecord }
  | { readonly kind: 'other-schema' }
  | { readonly kind: 'malformed' };

/**
 * Parse a whole results log.
 *
 * Blank lines are ignored; every other line is a record, a stale-schema record, or
 * malformed. Never throws, so a corrupt file degrades a resume into extra work rather than
 * into a crash - and a stale file degrades into a loud refusal rather than a wrong number.
 */
export function parseResultsLog(text: string): ParsedResultsLog {
  const records: SweepSampleRecord[] = [];
  let malformedLines = 0;
  let staleSchemaLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const outcome = decodeLine(line);
    if (outcome.kind === 'record') {
      records.push(outcome.record);
    } else if (outcome.kind === 'other-schema') {
      staleSchemaLines += 1;
    } else {
      malformedLines += 1;
    }
  }
  return { records, malformedLines, staleSchemaLines };
}

/** Decode one line's JSON then its shape, classifying another schema version separately. */
function decodeLine(line: string): LineOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // A non-JSON line is corruption, not an error to propagate: the caller counts it.
    return { kind: 'malformed' };
  }
  const record = decodeSampleRecord(raw);
  if (record !== null) {
    return { kind: 'record', record };
  }
  return readsAsOtherSchema(raw) ? { kind: 'other-schema' } : { kind: 'malformed' };
}

/**
 * Whether a line looks like a real record written at a DIFFERENT schema version - older or
 * NEWER (Req 12.10, 12.28).
 *
 * Deliberately narrow: it must be an object carrying an integer `schemaVersion` that is not the
 * current one. A line with a garbage version - a string, a float, an array - is corruption
 * rather than history, and stays malformed so the whole-file refusal cannot be triggered by
 * noise.
 *
 * A HIGHER VERSION USED TO BE COUNTED AS CORRUPTION, AND THAT WAS THE WRONG DIRECTION. The
 * reasoning was that nothing writes a future version, so one can only be noise. But a well-
 * formed record at a higher version is precisely what a NEWER BUILD writes, which happens
 * whenever an operator resumes into a directory a later build already wrote, or concatenates
 * two runs' files. Such a record carries fields this reader cannot interpret, and worse, it may
 * REDEFINE a field this reader thinks it understands - which is exactly what every bump
 * documented on `RESULTS_SCHEMA_VERSION` did to the version below it. Counting it as
 * `malformedLines` reports it as damage to a handful of lines and then AGGREGATES the file
 * anyway; counting it here refuses the file whole. The results file is read back as EVIDENCE a
 * cited number comes from, so its reader is a trust boundary, and refusal is the fail-safe
 * direction in both directions along the version axis.
 */
function readsAsOtherSchema(raw: unknown): boolean {
  const record = asRecord(raw);
  const version = record?.schemaVersion;
  return (
    typeof version === 'number' && Number.isInteger(version) && version !== RESULTS_SCHEMA_VERSION
  );
}

/** What the running build and its arms are, so resume never counts a record made by another. */
export interface RunningArms {
  readonly testbenchPromptVersion: number;
  /** The `SIMULATION_HARNESS_VERSION` the running build compiles into every Testbench_Run. */
  readonly simulationHarnessVersion: number;
  /** The Strategy_Arm the running config gives this arm name. */
  readonly strategyOf: (armName: string) => StrategyArm;
}

/**
 * Whether a record was made by the running prompt version and arm strategy (Req 7.5). The
 * config hash already folds both, so this is the rule stated on its own rather than new power.
 */
function matchesRunning(record: SweepSampleRecord, running: RunningArms | undefined): boolean {
  return (
    running === undefined ||
    (record.testbenchPromptVersion === running.testbenchPromptVersion &&
      record.simulationHarnessVersion === running.simulationHarnessVersion &&
      record.strategyArm === running.strategyOf(record.armName))
  );
}

/**
 * The set of sample slots already completed for one experiment.
 *
 * Built ONLY from records whose `configHash` matches, so a results file that also
 * holds another experiment's records cannot leak them into this run's resume decision.
 *
 * A DEFERRED record does not complete its slot. That is the whole content of this class
 * beyond the config scoping: a record whose `noVerdictCause` is infrastructure describes an
 * attempt, not a measurement, so the slot stays outstanding and the next run takes it again.
 *
 * WHY THE DECISION IS DERIVED HERE AND NOT REMEMBERED SOMEWHERE
 *   The alternative was to keep a side list of slots to retry. That list would have to
 *   survive `kill -9` between the moment a sample is deferred and the moment the list is
 *   written, and a resume is frequently a DIFFERENT PROCESS - which is exactly how the
 *   original defect was measured. Instead the index is rebuilt from the file on every start
 *   and `isDeferredSample` is a pure function of one persisted line, so any process reading
 *   the file reaches the same conclusion, and there is no window in which a crash can lose
 *   the deferral. The record write is one atomic append; nothing else has to happen.
 */
export class CompletedSampleIndex {
  readonly #keys: ReadonlySet<string>;
  readonly #deferredKeys: ReadonlySet<string>;

  private constructor(keys: ReadonlySet<string>, deferredKeys: ReadonlySet<string>) {
    this.#keys = keys;
    this.#deferredKeys = deferredKeys;
  }

  /**
   * Build the index for `configHash` from already-parsed records.
   *
   * ORDER-INDEPENDENT by construction: completed keys are only ever ADDED, and a deferred
   * record adds nothing. A slot that was deferred and later retried successfully therefore
   * resolves to complete no matter which of its two lines the file holds first - which
   * matters because samples finish out of order under concurrency.
   */
  static fromRecords(
    records: readonly SweepSampleRecord[],
    configHash: string,
    running?: RunningArms,
  ): CompletedSampleIndex {
    const keys = new Set<string>();
    const deferred = new Set<string>();
    for (const record of records) {
      if (record.configHash !== configHash || !matchesRunning(record, running)) {
        continue;
      }
      const key = sampleKey(record.armName, record.problemId, record.sampleIndex);
      if (isDeferredSample(record)) {
        deferred.add(key);
        continue;
      }
      keys.add(key);
    }
    for (const key of keys) {
      deferred.delete(key);
    }
    return new CompletedSampleIndex(keys, deferred);
  }

  /** How many sample slots are already complete for this experiment. */
  size(): number {
    return this.#keys.size;
  }

  /**
   * How many slots this file ATTEMPTED and did not measure, and will run again.
   *
   * Slots with a deferred record and no completed one. Surfaced so a resume can say out
   * loud that part of its work is re-running an outage rather than extending the matrix.
   */
  deferredSize(): number {
    return this.#deferredKeys.size;
  }

  /**
   * Whether this sample slot is already recorded and must be SKIPPED.
   *
   * The single resume decision in the sweep: `true` means no model call, no sandbox
   * run, and no second record for a sample that was already paid for.
   */
  isComplete(armName: string, problemId: string, sampleIndex: number): boolean {
    return this.#keys.has(sampleKey(armName, problemId, sampleIndex));
  }
}

/** The append-only sink and source the sweep persists its samples through. */
export interface ResultsLogPort {
  /** Append one line durably enough that a later crash cannot lose it. */
  appendLine(line: string): Promise<void>;
  /** The whole log's text, or `''` when it does not exist yet. */
  readAll(): Promise<string>;
}
