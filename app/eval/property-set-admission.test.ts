// The formal calibration vocabulary and its denominator arithmetic.
//
// THE THREE CLAIMS THAT MATTER HERE
//   1. The vocabulary is CLOSED at three members and the admission mapping is TOTAL over them.
//      A fourth member is already a compile error; what these tests add is that the mapping has
//      no member missing at RUNTIME either, which a partial object literal would not catch
//      under a `Readonly<Record<...>>` annotation alone once a member is added by a widened
//      template type.
//   2. A `formal-could-not-verify` mutant is COUNTED and EXCLUDED, and is reported as neither
//      killed nor survived. That is the whole measured reason this module exists: `counter_12`
//      with `if (!rst_n)` changed to `if (1'b0)` is accepted by iverilog and rejected by Yosys.
//   3. The two gates have DIFFERENT denominators over the SAME mutant set. One mutant that is
//      valid for the simulation gate and unscorable for the formal one is enough to show that a
//      shared denominator would claim a measurement nobody made.
//
// The cause is asserted through the record rather than through the calibration, because that is
// the shape decision: the closed three-member vocabulary cannot carry eleven causes.
//
// TASK 10.6 - THE CLOSED VOCABULARY AND THE STRUCTURAL CLAIMS (Req 9.1, 9.7, 10.4, 10.7, 10.10)
//   Where an earlier test already pins half a claim, it is CITED beside the test that adds the
//   other half rather than restated:
//   1. Three members, and an entry for each: the whole-list checks in the first block, plus one
//      row per member, so a failure names the member that broke.
//   2. One rule for two gates: the gate set against the Negative_Control's OWN scope, over every
//      input both can be handed. Property 23 holds the gate to an independent table instead.
//   3. Off the product path: a source scan of every product-path package, with a positive control.
//   4. No design verdict on an admission: the runtime key set and name scan, plus the TYPE.
//
// TASK 21.2 - NON-BLOCKING FOR THE MERGE GATE (Req 10.4, 10.10, 10.13; execution question E24)
//   Two additions, neither of which is a merge-gate item:
//   1. The two gates agree on the DECISION: over every kill pattern, the Property_Set gate refuses
//      if and only if the Negative_Control's own rule reports a coverage gap, driven through the
//      Negative_Control's real code. Claim 2 above compares only the mutant SCOPE.
//   2. The survivor projection as a property over generated full `Mutant`s, generalising the
//      single example beside the type pin.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { PROPERTY_SET_ADMISSION_OUTCOMES } from '@app/agent';
import {
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type CouldNotVerifyCause,
  type FormalVerdict,
  type ResourceLimits,
  type SimulationVerdict,
  type SimulatorAdapter,
  type SourceFile,
} from '@app/tools';

import type { GoldenTestbench, ReferenceDesign } from './corpus/corpus-types.js';
import type { GoldenScore, GoldenTestbenchScorer } from './corpus/golden-scorer.js';
import { goldenKilled, RtllmMutationCalibrator } from './corpus/mutation-calibration.js';
import { RtllmMutationNegativeControl } from './corpus/rtllm-negative-control.js';
import { generateMutants } from './corpus/verilog-mutation.js';
import {
  DEFAULT_MUTATION_CONFIG,
  judgeCoverageGaps,
  MAX_SITE_TEXT_CHARS,
  mutantIdOf,
  mutantIsValid,
  MUTATION_OPERATORS,
  type Mutant,
  type MutantCalibration,
  type MutantIdentity,
  type MutationConfig,
  type MutationOperatorId,
  type MutationSite,
} from './mutation-control.js';
import {
  admitPropertySet,
  formalCalibrationOf,
  formalKillRateOf,
  formalMutantIsScorable,
  formalMutationCounts,
  mutantIsInPropertySetGateSet,
  propertySetAdmissionFallsBack,
  propertySetAdmissionOutcomeOf,
  propertySetSurvivorCountOf,
  FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR,
  type CalibratedFormalMutant,
  type FormalMutantCalibration,
  type PropertySetAdmission,
} from './property-set-admission.js';

/** Every calibration, enumerated so a fourth member fails to compile in this file too. */
const EVERY_FORMAL_CALIBRATION: Readonly<Record<FormalMutantCalibration, true>> = {
  'formal-refuted': true,
  'formal-proved': true,
  'formal-could-not-verify': true,
};

/**
 * One calibrated mutant. Each test states only the parts it is about.
 *
 * The identity is the MEASURED one: `RESET_BRANCH_DISABLED` rewriting `!rst_n` to `1'b0`, which
 * is the operator and the exact text behind the `counter_12` exclusion this module exists for.
 * The id is derived through `mutantIdOf` rather than string-built, so these fixtures are keyed
 * the way a real mutant set is.
 */
function mutant(
  formal: FormalMutantCalibration,
  options: {
    readonly line?: number;
    readonly golden?: MutantCalibration;
    readonly cause?: CouldNotVerifyCause;
  } = {},
): CalibratedFormalMutant {
  const site = { line: options.line ?? 7, column: 3, before: '!rst_n', after: "1'b0" };
  const identity: MutantIdentity = {
    mutantId: mutantIdOf('RESET_BRANCH_DISABLED', site),
    operator: 'RESET_BRANCH_DISABLED',
    site,
  };
  const golden: MutantCalibration = options.golden ?? 'golden-killed';
  return formal === 'formal-could-not-verify'
    ? { identity, golden, formal, cause: options.cause ?? 'frontend-rejected' }
    : { identity, golden, formal };
}

/**
 * Field names that would read as a verdict about the candidate DESIGN rather than the property.
 *
 * Deliberately WIDER than the words this spec uses, because the claim being checked is about
 * how a field would be READ, not about one spelling: a `passed`, a `correct`, or a `verified`
 * on an admission outcome would each invite the one conclusion Req 10.10 forbids. Matched
 * case-insensitively, so `designVerdict` and `DesignVerdict` are the same finding.
 */
const DESIGN_VERDICT_FIELD_NAMES: readonly string[] = Object.freeze([
  'verdict',
  'designverdict',
  'formalverdict',
  'simulationverdict',
  'candidate',
  'candidatertl',
  'design',
  'rtl',
  'passed',
  'correct',
  'verified',
]);

/** Every field on `value` whose NAME would read as a verdict about the candidate design. */
function designVerdictFieldsOf(value: object): readonly string[] {
  return Object.keys(value).filter((key) => DESIGN_VERDICT_FIELD_NAMES.includes(key.toLowerCase()));
}

describe('the formal calibration vocabulary - three members, and a total admission mapping', () => {
  it('given the vocabulary, when enumerated, then it has exactly three members', () => {
    expect(Object.keys(EVERY_FORMAL_CALIBRATION).sort()).toEqual([
      'formal-could-not-verify',
      'formal-proved',
      'formal-refuted',
    ]);
  });

  it('given the admission mapping, when read, then it is total over the vocabulary and frozen', () => {
    // Total: an entry for every member, and no entry for anything else. Frozen, because the
    // denominator rule is not something a reader may edit in place.
    expect(Object.keys(FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR).sort()).toEqual(
      Object.keys(EVERY_FORMAL_CALIBRATION).sort(),
    );
    expect(Object.isFrozen(FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR)).toBe(true);
  });

  it('admits exactly the two calibrations the oracle REASONED to', () => {
    // A refutation and a proof are both measurements. A refusal to reason is not one, in either
    // direction: as a kill it inflates the gate with mutants it never saw, as a survival it
    // deflates the gate with the same mutants.
    const scorable = Object.keys(EVERY_FORMAL_CALIBRATION).filter((calibration) =>
      formalMutantIsScorable(calibration as FormalMutantCalibration),
    );

    expect(scorable.sort()).toEqual(['formal-proved', 'formal-refuted']);
    expect(formalMutantIsScorable('formal-could-not-verify')).toBe(false);
  });

  it('given every Formal_Verdict, when calibrated, then each maps to its own member', () => {
    // Total over the vocabulary `@app/tools` owns, so a mutant can never arrive with a verdict
    // that has no calibration.
    const calibrations = FORMAL_VERDICTS.map((verdict: FormalVerdict) =>
      formalCalibrationOf(verdict),
    );

    expect(calibrations.sort()).toEqual(Object.keys(EVERY_FORMAL_CALIBRATION).sort());
    expect(formalCalibrationOf('could-not-verify')).toBe('formal-could-not-verify');
  });
});

/** What one calibration member IS: the verdict that records it, and its denominator rule. */
interface CalibrationMemberFacts {
  readonly recordedFor: FormalVerdict;
  readonly admitsToDenominator: boolean;
}

/**
 * Each member's own facts, stated once per member. Total over the vocabulary, so a fourth member,
 * or a missing one, fails to compile here as well as in `EVERY_FORMAL_CALIBRATION`.
 */
const FACTS_OF_EACH_CALIBRATION: Readonly<Record<FormalMutantCalibration, CalibrationMemberFacts>> =
  {
    'formal-refuted': { recordedFor: 'refuted', admitsToDenominator: true },
    'formal-proved': { recordedFor: 'proved', admitsToDenominator: true },
    'formal-could-not-verify': { recordedFor: 'could-not-verify', admitsToDenominator: false },
  };

describe('the formal calibration vocabulary, one member at a time (task 10.6; Req 9.1, 9.7)', () => {
  // ALREADY PINNED ABOVE, AND NOT RESTATED: the member count, the mapping's key set, the admitting
  // pair, and the verdict tie, each as ONE comparison of a whole list. A whole-list comparison says
  // that SOMETHING broke; one row per member says WHICH member did, and reads that member's entry
  // straight off the mapping rather than through `formalMutantIsScorable`.
  it.each(Object.keys(FACTS_OF_EACH_CALIBRATION) as FormalMutantCalibration[])(
    'given %s, then its own verdict records it and the mapping holds its own entry for it',
    (member) => {
      const facts = FACTS_OF_EACH_CALIBRATION[member];

      expect(formalCalibrationOf(facts.recordedFor)).toBe(member);
      // `Object.entries` lists OWN entries only, so this is an entry OF the mapping, with this
      // member's value, rather than any value a lookup happens to reach.
      expect(Object.entries(FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR)).toContainEqual([
        member,
        facts.admitsToDenominator,
      ]);
    },
  );
});

describe('the formal denominator - an unscorable mutant is counted and excluded', () => {
  it('given a mixed population, when tallied, then the counts partition it', () => {
    const population = [
      mutant('formal-refuted', { line: 1 }),
      mutant('formal-refuted', { line: 2 }),
      mutant('formal-proved', { line: 3 }),
      mutant('formal-could-not-verify', { line: 4 }),
    ];

    const counts = formalMutationCounts(population);

    expect(counts).toEqual({
      totalCount: 4,
      denominator: 3,
      killedCount: 2,
      survivedCount: 1,
      couldNotVerifyCount: 1,
    });
    expect(counts.killedCount + counts.survivedCount + counts.couldNotVerifyCount).toBe(
      counts.totalCount,
    );
    expect(counts.killedCount + counts.survivedCount).toBe(counts.denominator);
  });

  it('given a wholly unscorable population, when tallied, then there is no rate at all', () => {
    // The mutants are counted - never silently dropped - and the rate is `null` rather than 0,
    // because 0 would read as a Property_Set that killed nothing.
    const counts = formalMutationCounts([
      mutant('formal-could-not-verify', { line: 1 }),
      mutant('formal-could-not-verify', { line: 2 }),
    ]);

    expect(counts.totalCount).toBe(2);
    expect(counts.denominator).toBe(0);
    expect(counts.killedCount).toBe(0);
    expect(counts.survivedCount).toBe(0);
    expect(formalKillRateOf(counts)).toBeNull();
  });

  it('given an empty population, when tallied, then every count is zero and the rate is null', () => {
    expect(formalMutationCounts([])).toEqual({
      totalCount: 0,
      denominator: 0,
      killedCount: 0,
      survivedCount: 0,
      couldNotVerifyCount: 0,
    });
    expect(formalKillRateOf(formalMutationCounts([]))).toBeNull();
  });

  it('given a scorable population, when rated, then the rate is over the FORMAL denominator', () => {
    // Two kills out of three SCORED mutants, not out of four calibrated ones: the excluded
    // mutant changes the total and must not change the rate.
    const rate = formalKillRateOf(
      formalMutationCounts([
        mutant('formal-refuted', { line: 1 }),
        mutant('formal-refuted', { line: 2 }),
        mutant('formal-proved', { line: 3 }),
        mutant('formal-could-not-verify', { line: 4 }),
      ]),
    );

    expect(rate).toBeCloseTo(2 / 3);
  });
});

describe('the cause is on the mutant record, so a rejection is not a timeout', () => {
  it('given an unscorable mutant, when read, then its cause is readable and specific', () => {
    // `counter_12`'s `RESET_BRANCH_DISABLED` mutant is a FRONTEND rejection: Yosys would not
    // read it. A spent Property_Time_Budget is a different fact with a different remedy, and
    // the record keeps them apart because the calibration value cannot.
    const rejected = mutant('formal-could-not-verify', { cause: 'frontend-rejected' });
    const timedOut = mutant('formal-could-not-verify', { cause: 'proof-timeout' });

    // Read back through the discriminant, which is the only way the cause is reachable: the
    // scorable arm has no `cause` field to read, so a non-refusal cannot carry a refusal reason.
    const causes: readonly (CouldNotVerifyCause | null)[] = [rejected, timedOut].map((entry) =>
      entry.formal === 'formal-could-not-verify' ? entry.cause : null,
    );

    expect(causes).toEqual(['frontend-rejected', 'proof-timeout']);
    expect(rejected.formal).toBe(timedOut.formal);
  });
});

describe('the two gates exclude different mutants, so they report different denominators', () => {
  it('given one mutant the judge killed and Yosys could not read, then the gates disagree', () => {
    // This is the measured `counter_12` row. The simulation gate scores it - it compiled, ran,
    // and the independent judge killed it - and the formal gate cannot, because its frontend
    // rejected the same text. One denominator over both would claim a measurement nobody made.
    const unreadable = mutant('formal-could-not-verify', { golden: 'golden-killed' });

    expect(mutantIsValid(unreadable.golden)).toBe(true);
    expect(formalMutantIsScorable(unreadable.formal)).toBe(false);
    expect(formalMutationCounts([unreadable]).denominator).toBe(0);
  });
});

describe('the property-set gate - a proof of a judge-killed mutant refuses the Property_Set', () => {
  it('given a mutant the judge killed and the property PROVED, then it is refused by name', () => {
    // The `JC_counter` row this gate exists for: a true, non-trivial, PROVABLE invariant that
    // the independent judge's own mutants walk straight through. The refusal has to name the
    // survivor, or it is a bare verdict nobody can act on.
    const admission = admitPropertySet([
      mutant('formal-refuted', { line: 1 }),
      mutant('formal-proved', { line: 2, golden: 'golden-killed' }),
    ]);

    expect(admission.kind).toBe('refused');
    const survivors = admission.kind === 'refused' ? admission.survivors : [];
    expect(survivors.map((identity) => identity.mutantId)).toEqual([
      mutantIdOf('RESET_BRANCH_DISABLED', {
        line: 2,
        column: 3,
        before: '!rst_n',
        after: "1'b0",
      }),
    ]);
    expect(survivors[0]?.operator).toBe('RESET_BRANCH_DISABLED');
    expect(survivors[0]?.site.line).toBe(2);
  });

  it('given several survivors, when refused, then every one is named in population order', () => {
    // Attributable to a specific weakness means ALL of them: a refusal that named one survivor
    // out of three would send a reader to fix one property and re-run into the same refusal.
    const admission = admitPropertySet([
      mutant('formal-proved', { line: 5 }),
      mutant('formal-refuted', { line: 6 }),
      mutant('formal-proved', { line: 7 }),
    ]);

    const survivors = admission.kind === 'refused' ? admission.survivors : [];
    expect(survivors.map((identity) => identity.site.line)).toEqual([5, 7]);
  });

  it('given a property that refuted every judge-killed mutant, then it is ADMITTED', () => {
    // The control that keeps the gate from being a blanket refusal. Without this row, a gate
    // hardcoded to refuse would pass every other test in this block.
    const admission = admitPropertySet([
      mutant('formal-refuted', { line: 1, golden: 'golden-killed' }),
      mutant('formal-refuted', { line: 2, golden: 'golden-timeout' }),
      // Not in the gate set, and must not change the outcome: the judge PASSES it, so the
      // property set proving it is no evidence of weakness.
      mutant('formal-proved', { line: 3, golden: 'golden-survived' }),
    ]);

    expect(admission.kind).toBe('admitted');
  });

  it('given an unscorable mutant the judge killed, when gated, then it NEVER refuses', () => {
    // Req 10.5, and the measured `counter_12` row: Yosys would not read this mutant, so no
    // property could have killed it. Refusing over it would accuse the Property_Set of a
    // weakness nobody demonstrated. The judge killing it does not change that.
    const admission = admitPropertySet([
      mutant('formal-could-not-verify', {
        line: 1,
        golden: 'golden-killed',
        cause: 'frontend-rejected',
      }),
      mutant('formal-could-not-verify', {
        line: 2,
        golden: 'golden-timeout',
        cause: 'proof-timeout',
      }),
    ]);

    expect(admission.kind).toBe('no-gate-set');
    expect(
      mutantIsInPropertySetGateSet(mutant('formal-could-not-verify', { golden: 'golden-killed' })),
    ).toBe(false);
  });

  it('given a mutant the judge did NOT kill, when the property proved it, then no refusal', () => {
    // A mutant the independent judge passes is candidate-equivalent as far as this gate knows,
    // and one that did not build was never measured by anyone. Neither is a demonstrated
    // weakness in the property, so neither may refuse it.
    for (const golden of ['golden-survived', 'non-compiling', 'golden-errored'] as const) {
      const admission = admitPropertySet([mutant('formal-proved', { golden })]);
      expect(admission.kind).toBe('no-gate-set');
    }
  });

  it('given an empty population, when gated, then the gate has nothing to say', () => {
    // Not `admitted`: killing nothing proves nothing, which is the vacuity `judgeCoverageGaps`
    // already refuses to report as `closed`.
    expect(admitPropertySet([])).toEqual({ kind: 'no-gate-set' });
  });
});

/**
 * Every golden calibration. Total, so a sixth member fails to compile here. `MutantCalibration`'s
 * owner exports the vocabulary as a TYPE only - the runtime list in `corpus/mutation-calibration.ts`
 * is module-private - so this compile error is what keeps a new member from slipping past.
 */
const EVERY_GOLDEN_CALIBRATION: Readonly<Record<MutantCalibration, true>> = {
  'golden-killed': true,
  'golden-timeout': true,
  'golden-survived': true,
  'non-compiling': true,
  'golden-errored': true,
};

/** A `Mutant` must carry its RTL, and neither gate's SCOPE reads it, so none is held. */
const NO_RTL = '';

/** Whether a gate holds its instrument to one calibrated mutant. */
type GateScope = (input: CalibratedFormalMutant) => boolean;

/**
 * The Negative_Control's OWN scope, applied to the same mutant: the two calls its probe makes.
 *
 * `mutantIsValid` is the calibration's valid-set filter, and `goldenKilled` is what both the probe's
 * survivor bucketing and `goldenKilledCountOf` - the count `judgeCoverageGaps` reads - call. Both
 * are imported from the Negative_Control's own modules and neither is restated, so this IS its rule.
 */
function negativeControlHolds(input: CalibratedFormalMutant): boolean {
  const entry = { mutant: { ...input.identity, rtl: NO_RTL }, calibration: input.golden };
  return mutantIsValid(input.golden) && goldenKilled(entry);
}

/**
 * Every calibrated mutant either gate can be handed, read off the vocabulary owners: each golden
 * calibration, against each calibration `@app/tools`' Formal_Verdicts record, against - on the
 * unscorable arm - each Could_Not_Verify_Cause, which no scope may read.
 */
function everyCalibratedMutant(): readonly CalibratedFormalMutant[] {
  const formals = FORMAL_VERDICTS.map((verdict) => formalCalibrationOf(verdict));
  return (Object.keys(EVERY_GOLDEN_CALIBRATION) as MutantCalibration[]).flatMap((golden) =>
    formals.flatMap((formal) =>
      formal === 'formal-could-not-verify'
        ? COULD_NOT_VERIFY_CAUSES.map((cause) => mutant(formal, { golden, cause }))
        : [mutant(formal, { golden })],
    ),
  );
}

/** One input as `golden/formal`, plus `/cause` on the unscorable arm. */
function inputLabelOf(input: CalibratedFormalMutant): string {
  const cause = input.formal === 'formal-could-not-verify' ? `/${input.cause}` : '';
  return `${input.golden}/${input.formal}${cause}`;
}

/**
 * Every input on which `scope` departs from the Negative_Control's own scope over the mutants the
 * Formal_Oracle SCORED, sorted.
 *
 * The restriction to scored mutants is Req 10.5, and it is the ONE place the two gates may differ:
 * a mutant Yosys could not read leaves the Property_Set's gate set whatever the judge did, so the
 * difference runs in the EXCLUDING direction only. Everywhere else the answer is the
 * Negative_Control's.
 */
function departuresFromTheNegativeControl(scope: GateScope): readonly string[] {
  const expected = (input: CalibratedFormalMutant): boolean =>
    formalMutantIsScorable(input.formal) && negativeControlHolds(input);
  return everyCalibratedMutant()
    .filter((input) => scope(input) !== expected(input))
    .map(inputLabelOf)
    .sort();
}

describe('the property-set gate applies the Negative_Control rule (task 10.6; Req 10.4)', () => {
  // NOT ALREADY PINNED. Property 23 (`app/test/formal-property-set-admission.property.test.ts`)
  // holds this gate to its OWN judge-kill table and imports no production predicate, on purpose.
  // That shows the gate is right by one statement of the rule. It cannot show the gate applies the
  // SAME rule as the Negative_Control, because it never consults the Negative_Control: edit that
  // gate's kill rule and Property 23 stays green while the two gates apply different rules.

  it('given every input both gates can be handed, then the gate set is the Negative_Control scope among scored mutants', () => {
    expect(departuresFromTheNegativeControl(mutantIsInPropertySetGateSet)).toEqual([]);
  });

  it('given a scope that re-spells the kill rule, then the comparison names each input it departs on', () => {
    // NOT A COMPARISON THAT CANNOT FAIL. Among scored mutants the inputs meet the
    // Negative_Control's scope answering both ways, and among unscored ones they meet it answering
    // `true`, which is where the exclusion bites...
    const inputs = everyCalibratedMutant();
    const scored = inputs.filter((input) => formalMutantIsScorable(input.formal));
    expect(new Set(scored.map(negativeControlHolds))).toEqual(new Set([true, false]));
    expect(
      inputs.some((input) => !formalMutantIsScorable(input.formal) && negativeControlHolds(input)),
    ).toBe(true);

    // ...and the likeliest drift, a hang no longer counted as a kill, is reported input by input.
    const reportedFailuresOnly: GateScope = (input) =>
      formalMutantIsScorable(input.formal) && input.golden === 'golden-killed';
    expect(departuresFromTheNegativeControl(reportedFailuresOnly)).toEqual([
      'golden-timeout/formal-proved',
      'golden-timeout/formal-refuted',
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// TASK 21.2 - THE TWO GATES DECIDE ALIKE, NOT ONLY SCOPE ALIKE (Req 10.4; execution question E24)
//
// NON-BLOCKING FOR THE MERGE GATE, and recorded as such so it is not mistaken for a gate item:
// this is traceability evidence for Req 10.4 and is not one of the task 14 merge-gate checks.
//
// WHAT THE GROUP ABOVE CANNOT SEE. It compares the Property_Set gate's mutant-SCOPE predicate with
// the Negative_Control's scope. A change to the Negative_Control's DECISION rule - which survivors
// count as a coverage gap - would leave every one of those comparisons green while the two gates
// applied different rules, which is the drift Req 10.4 names.
//
// HOW THE NEGATIVE_CONTROL'S RULE IS REACHED. Its decision is made in `fold` (private) and
// `judgeCoverageGaps`, so the only honest route is the one production takes: the REAL
// `RtllmMutationCalibrator` and the REAL `RtllmMutationNegativeControl`, driven through their two
// ports. Only the two tool ports are faked - the judge's score and our simulator's verdict - and
// neither decides anything; every bucket, every validity filter and the final `judgeCoverageGaps`
// are the production code. No rule is re-spelled in this file to compute an expectation.
//
// THE PAIRING THE COMPARISON RESTS ON. Both gates ask one question of an instrument: did it fail
// to kill a mutant the independent judge killed? The instrument's answers pair by meaning, not
// by spelling: `proved` is a `pass` (it certified a broken design), `refuted` is a `fail` (it
// refused), `could-not-verify` is an `error` (it reached no verdict). The pairing is this
// file's assumption, so it is stated once in `SIMULATION_VERDICT_OF` and checked to be a bijection.
//
// WHERE THE TWO GATES ARE ALLOWED TO DIFFER, AND DO NOT ON THE DECISION. The Negative_Control
// COUNTS an `error` as a kill (`no-verdict`), and the Property_Set gate EXCLUDES a
// `could-not-verify` from its gate set (Req 10.5). The treatment differs; the decision does not,
// because neither leaves a survivor. That row is asserted like any other, so a Negative_Control
// that began to read an `error` as a survivor would surface here as a named departure.
//
// WHAT THIS DOES NOT PIN. It pins AGREEMENT, not CONTENT: a change to `mutantWasGoldenKilled`
// moves both gates together and stays green here, by design, because that predicate is the one
// rule both gates import. Property 23 holds the gate's content to an independent table.
// ---------------------------------------------------------------------------------------

/** One kill pattern: how the independent judge scored a mutant, and what the instrument made of it. */
interface KillPattern {
  readonly golden: MutantCalibration;
  readonly verdict: FormalVerdict;
}

/** The pairing the comparison rests on; total over the Formal_Verdicts, so a fourth fails to compile. */
const SIMULATION_VERDICT_OF: Readonly<Record<FormalVerdict, SimulationVerdict['verdict']>> = {
  proved: 'pass',
  refuted: 'fail',
  'could-not-verify': 'error',
};

/** Every simulation verdict, total, so a fourth fails to compile here as well. */
const EVERY_SIMULATION_VERDICT: Readonly<Record<SimulationVerdict['verdict'], true>> = {
  pass: true,
  fail: true,
  error: true,
};

/** Every kill pattern: each golden calibration against each Formal_Verdict, exhausted. */
const EVERY_KILL_PATTERN: readonly KillPattern[] = (
  Object.keys(EVERY_GOLDEN_CALIBRATION) as MutantCalibration[]
).flatMap((golden) => FORMAL_VERDICTS.map((verdict) => ({ golden, verdict })));

/** One pattern as `golden/verdict`. */
function patternLabelOf(pattern: KillPattern): string {
  return `${pattern.golden}/${pattern.verdict}`;
}

/** The kill pattern one gate input stands for. */
function patternOf(input: CalibratedFormalMutant): KillPattern {
  return { golden: input.golden, verdict: FACTS_OF_EACH_CALIBRATION[input.formal].recordedFor };
}

/** One pattern as the Property_Set gate's input. */
function gateInputOf(pattern: KillPattern, line: number): CalibratedFormalMutant {
  return mutant(formalCalibrationOf(pattern.verdict), { line, golden: pattern.golden });
}

/** Whether the Property_Set gate refuses a population of patterns. */
function propertySetGateRefuses(patterns: readonly KillPattern[]): boolean {
  const population = patterns.map((pattern, index) => gateInputOf(pattern, index + 1));
  return admitPropertySet(population).kind === 'refused';
}

/** The score the judge's port returns for a calibration: the raw evidence, never the calibration. */
interface GoldenEvidence {
  readonly kind: GoldenScore['verdict']['kind'];
  readonly timedOut: boolean;
  readonly diagnostics: string;
}

/**
 * The evidence that makes the REAL calibrator reach each calibration. Checked below against the
 * calibrator itself, because a fixture that lands on another calibration would compare the gates
 * on a pattern nobody named.
 */
const GOLDEN_EVIDENCE_OF: Readonly<Record<MutantCalibration, GoldenEvidence>> = {
  'golden-killed': { kind: 'failed', timedOut: false, diagnostics: '' },
  'golden-timeout': { kind: 'error', timedOut: true, diagnostics: '' },
  'golden-survived': { kind: 'passed', timedOut: false, diagnostics: '' },
  'non-compiling': { kind: 'error', timedOut: false, diagnostics: 'dut_mutant.v:4: syntax error' },
  'golden-errored': { kind: 'error', timedOut: false, diagnostics: '' },
};

const CONTROL_PROBLEM_ID = 'rtllm/control/counter';
const CONTROL_TESTBENCH = 'module counter_tb; endmodule\n';
const CONTROL_LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 };
const CONTROL_MUTANT_WALL_MS = 500;
const CONTROL_REFERENCE_RTL = `module counter (input clk, input rst_n, output reg [7:0] q);
  always @(posedge clk or negedge rst_n)
    if (!rst_n)
      q <= 8'd0;
    else
      q <= q + 1;
endmodule
`;

/** One golden score carrying the given evidence. */
function goldenScoreOf(evidence: GoldenEvidence): GoldenScore {
  return {
    problemId: CONTROL_PROBLEM_ID,
    verdict: {
      kind: evidence.kind,
      failureCount: evidence.kind === 'failed' ? 1 : null,
      banners: [],
    },
    timedOut: evidence.timedOut,
    diskLimitExceeded: false,
    exitCode: 0,
    diagnostics: evidence.diagnostics,
  };
}

/** One simulation verdict with the given outcome and nothing else of interest. */
function simulationVerdictOf(verdict: SimulationVerdict['verdict']): SimulationVerdict {
  return {
    verdict,
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: verdict === 'error' ? null : 0,
    resourceUsage: { cpuMs: 1, wallMs: 1, maxMemMb: 1 },
    failureCause: verdict === 'error' ? 'tool-failed' : 'none',
    attributedFiles: [],
    watchdog: { stopped: false },
  };
}

/** The real calibrator and Negative_Control over one population, with only the two tool ports faked. */
interface ControlRun {
  readonly calibrator: RtllmMutationCalibrator;
  readonly negativeControl: RtllmMutationNegativeControl;
  /** How many times our testbench was run, so a fake that was never reached is noticed. */
  readonly simulations: () => number;
}

/**
 * The control over `patterns`: mutant `i` carries pattern `i`.
 *
 * The fakes answer by the mutant's RTL text rather than by call order, because the probe runs
 * only the VALID mutants and an index would drift the moment one is filtered out.
 */
function controlFor(patterns: readonly KillPattern[]): ControlRun {
  const config: MutationConfig = {
    maxMutantsPerProblem: patterns.length,
    operators: DEFAULT_MUTATION_CONFIG.operators,
  };
  const mutants = generateMutants(CONTROL_REFERENCE_RTL, config);
  expect(mutants).toHaveLength(patterns.length);
  expect(new Set(mutants.map((generated) => generated.rtl)).size).toBe(patterns.length);
  const patternByRtl = new Map(
    mutants.flatMap((generated, index) => {
      const pattern = patterns[index];
      return pattern === undefined ? [] : [[generated.rtl, pattern] as const];
    }),
  );
  const patternFor = (rtl: string): KillPattern => {
    const pattern = patternByRtl.get(rtl);
    if (pattern === undefined) {
      throw new Error('the fake was handed RTL that no fixture mutant carries');
    }
    return pattern;
  };
  const scorer: GoldenTestbenchScorer = {
    score: (rtl) =>
      Promise.resolve(goldenScoreOf(GOLDEN_EVIDENCE_OF[patternFor(rtl.contents).golden])),
  };
  let simulations = 0;
  const simulator: SimulatorAdapter = {
    simulate: (rtl: readonly SourceFile[]) => {
      simulations += 1;
      const contents = rtl[0]?.contents ?? '';
      return Promise.resolve(
        simulationVerdictOf(SIMULATION_VERDICT_OF[patternFor(contents).verdict]),
      );
    },
  };
  const reference: ReferenceDesign = {
    problemId: CONTROL_PROBLEM_ID,
    rtl: { path: 'dut_reference.v', contents: CONTROL_REFERENCE_RTL },
    topModuleRenamedFrom: 'verified_counter',
  };
  const golden: GoldenTestbench = {
    problemId: CONTROL_PROBLEM_ID,
    moduleName: 'counter',
    testbench: { path: 'testbench.v', contents: 'module tb; endmodule\n' },
    dataFiles: [],
    overriddenParameters: [],
  };
  const calibrator = new RtllmMutationCalibrator({
    scorer,
    golden: new Map([[CONTROL_PROBLEM_ID, golden]]),
    references: new Map([[CONTROL_PROBLEM_ID, reference]]),
    config,
    mutantWallMs: CONTROL_MUTANT_WALL_MS,
    cacheKey: {
      corpusCommit: 'commit1',
      mutationConfigHash: 'hash1',
      mutantWallMs: CONTROL_MUTANT_WALL_MS,
    },
  });
  return {
    calibrator,
    negativeControl: new RtllmMutationNegativeControl({ simulator, calibrator }),
    simulations: () => simulations,
  };
}

/**
 * Whether the Negative_Control's OWN rule reports a coverage gap over a population of patterns.
 *
 * "Reports a coverage gap" is `judgeCoverageGaps` answering `open` on the probe's report - the
 * one function the Negative_Control's validity gate reads. A probe with nothing to report is
 * NOT a gap. The two guards keep that from being a silent `false`: a fake that threw would be
 * swallowed into `probe-errored`, so the outcome must be a measurement unless every mutant was
 * invalid, and our testbench must have been run once per VALID mutant.
 */
async function negativeControlReportsGap(patterns: readonly KillPattern[]): Promise<boolean> {
  const run = controlFor(patterns);
  const outcome = await run.negativeControl.probe({
    problemId: CONTROL_PROBLEM_ID,
    testbench: CONTROL_TESTBENCH,
    limits: CONTROL_LIMITS,
    requiredCheckNames: [],
  });
  const validCount = patterns.filter((pattern) => mutantIsValid(pattern.golden)).length;
  expect(run.simulations()).toBe(validCount);
  expect(outcome.kind === 'unavailable' ? outcome.reason : 'measured').toBe(
    validCount === 0 ? 'no-valid-mutants' : 'measured',
  );
  return outcome.kind === 'measured' && judgeCoverageGaps(outcome.report) === 'open';
}

describe('the two gates decide alike - refused iff the Negative_Control reports a coverage gap (task 21.2; Req 10.4; E24; non-blocking for the merge gate)', () => {
  let gapOf: ReadonlyMap<string, boolean>;

  beforeAll(async () => {
    gapOf = new Map(
      await Promise.all(
        EVERY_KILL_PATTERN.map(
          async (pattern) =>
            [patternLabelOf(pattern), await negativeControlReportsGap([pattern])] as const,
        ),
      ),
    );
  });

  /** The Negative_Control's answer for one pattern, as measured through its real rule above. */
  const reportsGap = (pattern: KillPattern): boolean => gapOf.get(patternLabelOf(pattern)) === true;

  /** The Property_Set gate's answer for one input: does a population of it alone get refused. */
  const refuses = (input: CalibratedFormalMutant): boolean =>
    admitPropertySet([input]).kind === 'refused';

  /** Every gate input on which the refusal and the coverage gap differ, sorted. */
  function departures(
    gateRefuses: (input: CalibratedFormalMutant) => boolean,
    negativeControlGap: (pattern: KillPattern) => boolean,
  ): readonly string[] {
    return everyCalibratedMutant()
      .filter((input) => gateRefuses(input) !== negativeControlGap(patternOf(input)))
      .map(inputLabelOf)
      .sort();
  }

  it('given the pairing, then it is a bijection over both closed vocabularies', () => {
    expect(Object.keys(SIMULATION_VERDICT_OF).sort()).toEqual([...FORMAL_VERDICTS].sort());
    expect(Object.values(SIMULATION_VERDICT_OF).sort()).toEqual(
      Object.keys(EVERY_SIMULATION_VERDICT).sort(),
    );
    expect(EVERY_KILL_PATTERN).toHaveLength(
      Object.keys(EVERY_GOLDEN_CALIBRATION).length * FORMAL_VERDICTS.length,
    );
  });

  it.each(Object.keys(EVERY_GOLDEN_CALIBRATION) as MutantCalibration[])(
    'given the fixture for %s, then the REAL calibrator lands on exactly that calibration',
    async (calibration) => {
      // A fixture that reaches another calibration would compare the gates on a pattern nobody
      // named, and the agreement below would then say nothing about this row.
      const { calibrator } = controlFor([{ golden: calibration, verdict: 'proved' }]);

      const calibrated = await calibrator.calibrate(CONTROL_PROBLEM_ID, CONTROL_LIMITS);

      expect(calibrated?.valid.map((entry) => entry.calibration)).toEqual(
        mutantIsValid(calibration) ? [calibration] : [],
      );
      expect(calibrated?.nonCompilingCount).toBe(calibration === 'non-compiling' ? 1 : 0);
      expect(calibrated?.goldenErroredCount).toBe(calibration === 'golden-errored' ? 1 : 0);
    },
  );

  it('given every kill pattern, then the gate refuses if and only if the Negative_Control reports a gap', () => {
    expect(gapOf.size).toBe(EVERY_KILL_PATTERN.length);

    expect(departures(refuses, reportsGap)).toEqual([]);

    // NOT AN AGREEMENT ON ONE ANSWER: the patterns are decided both ways, so a gate that refused
    // everything, or nothing, would depart somewhere above.
    expect(new Set(gapOf.values())).toEqual(new Set([true, false]));
  });

  it('given every PAIR of kill patterns, then the two gates still decide alike', async () => {
    // The population half of the claim. One pattern cannot tell "any survivor" from "every
    // survivor", and the gate's refusal and the Negative_Control's `open` are both decided over a
    // population, so the pairs are where an aggregation drift on either side becomes visible.
    const pairs = EVERY_KILL_PATTERN.flatMap((first) =>
      EVERY_KILL_PATTERN.map((second) => [first, second] as const),
    );

    const decisions = await Promise.all(
      pairs.map(async (pair) => ({
        label: `${patternLabelOf(pair[0])} + ${patternLabelOf(pair[1])}`,
        gap: await negativeControlReportsGap(pair),
        refused: propertySetGateRefuses(pair),
      })),
    );

    expect(decisions.filter((decision) => decision.gap !== decision.refused)).toEqual([]);
    // Non-vacuity: pairs whose two members are decided DIFFERENTLY exist, and both outcomes do.
    expect(pairs.some(([first, second]) => reportsGap(first) !== reportsGap(second))).toBe(true);
    expect(new Set(decisions.map((decision) => decision.gap))).toEqual(new Set([true, false]));
  });

  it('given a drifted rule on EITHER side, then the comparison names every input it departs on', () => {
    // CONTROLS, so the agreement above is not a comparison that cannot fail. The expected lists
    // encode TODAY'S kill rule (a hang is a kill), as the group above's own control does, so a
    // deliberate change to that rule edits them together with Property 23.
    // Gate side: a hang no longer counted as a kill.
    const hangIsNoKill = (input: CalibratedFormalMutant): boolean =>
      input.formal === 'formal-proved' && input.golden === 'golden-killed';
    expect(departures(hangIsNoKill, reportsGap)).toEqual(['golden-timeout/formal-proved']);

    // Negative_Control side: an `error` read as a survivor, which the Property_Set gate cannot
    // follow because it excludes a could-not-verify mutant from its gate set (Req 10.5).
    const errorIsSurvivor = (pattern: KillPattern): boolean =>
      reportsGap(pattern) ||
      (pattern.verdict === 'could-not-verify' && pattern.golden === 'golden-killed');
    expect(departures(refuses, errorIsSurvivor)).toEqual(
      COULD_NOT_VERIFY_CAUSES.map(
        (cause) => `golden-killed/formal-could-not-verify/${cause}`,
      ).sort(),
    );
  });
});

/** A text no identity field can hold, so its absence from a serialized refusal means something. */
const FULL_MUTANT_RTL_MARKER = '<<mutated-reference-rtl>>';

/** A site in the closed four-scalar shape the mutant generator produces, as a plain object. */
const arbMutationSite: fc.Arbitrary<MutationSite> = fc
  .record({
    line: fc.integer({ min: 1, max: 10_000 }),
    column: fc.integer({ min: 1, max: 200 }),
    before: fc.string({ maxLength: MAX_SITE_TEXT_CHARS }),
    after: fc.string({ maxLength: MAX_SITE_TEXT_CHARS }),
  })
  .map(({ line, column, before, after }) => ({ line, column, before, after }));

/** A full `Mutant`: an identity plus the mutated reference RTL, which is what a real gate holds. */
const arbFullMutant: fc.Arbitrary<Mutant> = fc
  .tuple(fc.constantFrom(...MUTATION_OPERATORS), arbMutationSite, fc.string({ maxLength: 120 }))
  .map(([operator, site, text]) => ({
    mutantId: mutantIdOf(operator, site),
    operator,
    site,
    rtl: `${FULL_MUTANT_RTL_MARKER}${text}`,
  }));

/** One calibrated mutant whose identity is a full `Mutant`, on whichever arm `formal` names. */
function calibratedWith(
  identity: Mutant,
  golden: MutantCalibration,
  formal: FormalMutantCalibration,
  cause: CouldNotVerifyCause,
): CalibratedFormalMutant {
  return formal === 'formal-could-not-verify'
    ? { identity, golden, formal, cause }
    : { identity, golden, formal };
}

/** Any calibrated mutant at all, over every golden calibration, calibration and cause. */
const arbCalibratedFullMutant: fc.Arbitrary<CalibratedFormalMutant> = fc
  .tuple(
    arbFullMutant,
    fc.constantFrom(...(Object.keys(EVERY_GOLDEN_CALIBRATION) as MutantCalibration[])),
    fc.constantFrom(...FORMAL_VERDICTS.map(formalCalibrationOf)),
    fc.constantFrom(...COULD_NOT_VERIFY_CAUSES),
  )
  .map(([identity, golden, formal, cause]) => calibratedWith(identity, golden, formal, cause));

/**
 * A calibrated mutant the gate must refuse over: the property PROVED a mutant the judge killed.
 *
 * `golden-killed` ALONE, the one calibration that is a kill under any reading of the rule, so a
 * deliberate change to how a hang is scored does not turn this generator into a false red. The
 * property asserts that the admission really is a refusal, which is what keeps this in step
 * with the gate.
 */
const arbRefusedFullMutant: fc.Arbitrary<CalibratedFormalMutant> = arbFullMutant.map(
  (identity): CalibratedFormalMutant => ({
    identity,
    golden: 'golden-killed',
    formal: 'formal-proved',
  }),
);

describe('a Property_Set admission is evidence about the PROPERTY SET and never about the design', () => {
  it('given any outcome, when its fields are read, then it carries only the gate facts', () => {
    const refused = admitPropertySet([mutant('formal-proved')]);
    const admitted = admitPropertySet([mutant('formal-refuted')]);

    expect(Object.keys(refused).sort()).toEqual(['kind', 'survivors']);
    expect(Object.keys(admitted)).toEqual(['kind']);
    expect(Object.keys(admitPropertySet([]))).toEqual(['kind']);
  });

  it('given a refusal, when scanned for a design verdict, then it carries none', () => {
    // A reader who mistook this refusal for a statement about the candidate design would draw
    // exactly the WRONG conclusion: a weak property set says nothing about whether the design
    // is correct. The scan is run against a DECOY first, because a scan that cannot fire would
    // pass this assertion while checking nothing.
    expect(designVerdictFieldsOf({ kind: 'refused', survivors: [], verdict: 'fail' })).toEqual([
      'verdict',
    ]);

    expect(designVerdictFieldsOf(admitPropertySet([mutant('formal-proved')]))).toEqual([]);
    expect(designVerdictFieldsOf(admitPropertySet([mutant('formal-refuted')]))).toEqual([]);
  });

  it('types every outcome with the gate facts and nothing else (compile-time; tsc -b)', () => {
    // THE HALF THE TWO TESTS ABOVE CANNOT SEE (task 10.6). Both read a VALUE `admitPropertySet`
    // built, so a field the TYPE declares and the function never sets - an optional
    // `designVerdict?` - passes both. `tsc -b` evaluates these and vitest does not. The arm keys
    // pinned here, `kind` and `survivors`, are the ones the name scan above already clears.
    expectTypeOf<PropertySetAdmission>().toEqualTypeOf<
      | { readonly kind: 'admitted' }
      | { readonly kind: 'no-gate-set' }
      | { readonly kind: 'refused'; readonly survivors: readonly MutantIdentity[] }
    >();
    // A refusal carries every field of each survivor's identity, so a field added there is a field
    // added to the refusal. Pinned to the depth of its values, so such a field is weighed against
    // Req 10.10 rather than arriving unread. `MutantIdentity` rather than `Mutant` above is what
    // keeps a mutant's RTL off the refusal's type.
    expectTypeOf<MutantIdentity>().toEqualTypeOf<{
      readonly mutantId: string;
      readonly operator: MutationOperatorId;
      readonly site: {
        readonly line: number;
        readonly column: number;
        readonly before: string;
        readonly after: string;
      };
    }>();
  });

  it('given a gate that supplies a FULL mutant as the identity, then no RTL reaches the refusal', () => {
    // THE HALF THE TYPE PIN ABOVE CANNOT SEE (task 21.1; Req 10.10, 10.13). `Mutant extends
    // MutantIdentity`, so a `PropertySetGate` that sets `identity` straight from
    // `generateMutants` TYPE-CHECKS, and structural typing then says nothing about what rides
    // on the object at runtime. Before `admitPropertySet` projected, it handed survivors back
    // BY REFERENCE and the whole mutated reference RTL landed on the refusal.
    //
    // The fixture is deliberately a `Mutant` in a typed const rather than an inline literal:
    // excess-property checking would reject the literal and this test would then be checking
    // a shape no real gate can produce. This one passes the way a real gate would.
    const full: Mutant = {
      ...mutant('formal-proved').identity,
      rtl: "module counter_12(input clk, input rst_n); always @(posedge clk) if (1'b0) ; endmodule",
    };
    const admission = admitPropertySet([
      { identity: full, golden: 'golden-killed', formal: 'formal-proved' },
    ]);

    const survivors = admission.kind === 'refused' ? admission.survivors : [];
    expect(survivors).toHaveLength(1);
    expect(Object.keys(survivors[0]!).sort()).toEqual(['mutantId', 'operator', 'site']);
    expect(survivors[0]).not.toBe(full);
    expect(JSON.stringify(admission)).not.toContain('module counter_12');
  });

  it('given ANY gate that supplies full mutants as identities, then no refusal carries an rtl field', () => {
    // THE GENERALISATION OF THE EXAMPLE ABOVE (task 21.2; Req 10.10, 10.13). Every identity is a
    // full `Mutant`, typed as one for the reason the example gives, inside a population that also
    // holds mutants which are NOT survivors, so a projection that leaked from the wrong element
    // would show. One refuser is placed at a random position in every draw, so the refusal is
    // guaranteed rather than hoped for, and the guarantee is itself asserted.
    //
    // WHAT THIS COVERS. Each survivor is a NEW object whose own keys are exactly `mutantId`,
    // `operator` and `site`, so no `rtl` field and no other top-level field rides on it, and the
    // serialized refusal holds none of the RTL text. Only `rtl` is GENERATED as an extra
    // top-level field; the key-set assertion is what would also catch any other.
    //
    // WHAT THIS DOES NOT COVER, AND WHAT `identityOf` DOES NOT DO. `site` is passed through by
    // reference, so a gate that hung text UNDER `site` would reach the refusal. The generated
    // sites are the closed four-scalar `MutationSite` shape the generator produces, which is why
    // the claim stops here: `identityOf` documents that bound, and this does not test past it.
    fc.assert(
      fc.property(
        fc.array(arbCalibratedFullMutant, { maxLength: 6 }),
        arbRefusedFullMutant,
        fc.array(arbCalibratedFullMutant, { maxLength: 6 }),
        (before, refuser, after) => {
          const population = [...before, refuser, ...after];

          const admission = admitPropertySet(population);

          expect(admission.kind).toBe('refused');
          const survivors = admission.kind === 'refused' ? admission.survivors : [];
          const supplied = new Set<MutantIdentity>(population.map((entry) => entry.identity));
          for (const survivor of survivors) {
            expect(Object.keys(survivor).sort()).toEqual(['mutantId', 'operator', 'site']);
            expect('rtl' in survivor).toBe(false);
            expect(supplied.has(survivor)).toBe(false);
          }
          expect(survivors.map((survivor) => survivor.mutantId)).toContain(
            refuser.identity.mutantId,
          );
          expect(JSON.stringify(admission)).not.toContain(FULL_MUTANT_RTL_MARKER);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('the hand-off to the Verification_Loop - three measured outcomes onto four members', () => {
  it('given each measured outcome, then it maps onto the member of the same name', () => {
    // The identity mapping, asserted rather than assumed: these are two separately declared
    // vocabularies, because `app/agent` holds no import of `app/eval` (Req 11.11, 13.6), and
    // the only thing stopping them drifting is this table.
    expect(propertySetAdmissionOutcomeOf({ kind: 'admitted' })).toBe('admitted');
    expect(propertySetAdmissionOutcomeOf({ kind: 'no-gate-set' })).toBe('no-gate-set');
    expect(
      propertySetAdmissionOutcomeOf({
        kind: 'refused',
        survivors: [mutant('formal-proved').identity],
      }),
    ).toBe('refused');
  });

  it('given every measured outcome, then NONE of them maps onto `not-gated`', () => {
    // `'not-gated'` means NO gate ran, which is a fact about the wiring and not an outcome
    // this gate can measure. A mapping that produced it would report the product path for a
    // sample the gate actually scored.
    const measured = [
      propertySetAdmissionOutcomeOf({ kind: 'admitted' }),
      propertySetAdmissionOutcomeOf({ kind: 'no-gate-set' }),
      propertySetAdmissionOutcomeOf({ kind: 'refused', survivors: [] }),
    ];

    expect(measured).not.toContain('not-gated');
  });

  it('given a refusal, then the survivor count is DERIVED from the named survivors', () => {
    const admission = admitPropertySet([
      mutant('formal-proved', { line: 2, golden: 'golden-killed' }),
      mutant('formal-proved', { line: 5, golden: 'golden-killed' }),
      mutant('formal-refuted', { line: 9, golden: 'golden-killed' }),
    ]);

    expect(propertySetSurvivorCountOf(admission)).toBe(2);
    // The count and the names are one fact read two ways, so they cannot disagree.
    expect(propertySetSurvivorCountOf(admission)).toBe(
      admission.kind === 'refused' ? admission.survivors.length : -1,
    );
  });

  it('given an admitted or ungated outcome, then the survivor count is a real zero', () => {
    expect(propertySetSurvivorCountOf({ kind: 'admitted' })).toBe(0);
    expect(propertySetSurvivorCountOf({ kind: 'no-gate-set' })).toBe(0);
  });

  it('given each of the FOUR members, then `refused` ALONE takes the Simulation_Fallback', () => {
    // THE DECISION, asserted member by member rather than as one truthy check.
    //
    // `'refused'` falls back because the gate demonstrated the Property_Set PROVES a mutant an
    // independent judge killed (Req 10.3). `'no-gate-set'` does NOT, and that is the
    // deliberate reading of a case criterion 10.3 does not name: an empty gate set
    // demonstrated no weakness, so refusing the Property_Set over it would be the
    // accusation-without-measurement Req 10.5 exists to prevent one layer down. `'not-gated'`
    // does not, for the same reason one step further out. Requirement 10.9's refused-sample
    // count is over `'refused'` ALONE, so a rule that folded any other member in would make
    // the wrong tally the easy one.
    expect(propertySetAdmissionFallsBack('refused')).toBe(true);
    expect(propertySetAdmissionFallsBack('no-gate-set')).toBe(false);
    expect(propertySetAdmissionFallsBack('not-gated')).toBe(false);
    expect(propertySetAdmissionFallsBack('admitted')).toBe(false);
  });

  it('given the whole vocabulary, then exactly ONE member falls back', () => {
    // The structural half of the claim above: a fifth member added without a decision, or a
    // second member flipped to `true`, fails here rather than quietly widening the fallback.
    const fallsBack = PROPERTY_SET_ADMISSION_OUTCOMES.filter(propertySetAdmissionFallsBack);

    expect(fallsBack).toEqual(['refused']);
  });
});

/**
 * The layers a student session loads: `web -> api -> agent -> {knowledge, tools} -> core`.
 *
 * Read from `eslint.config.js`, whose header names that chain and whose `ALLOWED_INNER` lets none
 * of these six import `@app/eval` - only `test` may - and corroborated by the TypeScript project
 * references, where no tsconfig of these six references `../eval` and only `app/test`'s does.
 */
const PRODUCT_PATH_PACKAGES: readonly string[] = [
  'core',
  'knowledge',
  'tools',
  'agent',
  'api',
  'web',
];

/** The two layers a student session never loads: this harness, and the test package. */
const OFF_PRODUCT_PATH_PACKAGES: readonly string[] = ['eval', 'test'];

/** The workspace's `app/` directory, resolved from this file. */
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The scope every workspace package is published under. */
const WORKSPACE_SCOPE = '@app/';

/** A specifier naming a path relative to the importing file. */
const RELATIVE_SPECIFIER = /^\.\.?\//;

/** Directories a source walk never enters: build output, and installed dependencies. */
const PRUNED_DIRECTORIES: readonly string[] = ['dist', 'node_modules'];

/** A TypeScript source file's name. */
const TYPESCRIPT_SOURCE = /\.tsx?$/;

/**
 * One statement that loads a module at RUNTIME, capturing its specifier.
 *
 * The rule `app/tools/formal/structural-claims.test.ts` and
 * `app/test/testbench-rtl-isolation.property.test.ts` read imports by - every line-leading `import`
 * except `import type`, which `verbatimModuleSyntax` erases - plus every line-leading RE-EXPORT,
 * `export *` or `export {` with a `from`, which loads its module exactly as an import does and is
 * how a barrel would surface one. `export type` is erased in the same way and is not matched.
 */
const RUNTIME_LOAD = /^(?:import(?!\s+type\b)|export\s*[*{])[^;]*?['"]([^'"]+)['"]/gm;

/** Every TypeScript source under `dir`, with build output and dependencies pruned. */
function sourceFilesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return PRUNED_DIRECTORIES.includes(entry.name) ? [] : sourceFilesUnder(path);
    }
    return TYPESCRIPT_SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The `app/` package a path lies inside, or `null` for a path outside `app/`. */
function packageOf(path: string): string | null {
  const fromApp = relative(APP_DIR, path);
  const outside = fromApp === '..' || fromApp.startsWith(`..${sep}`);
  return outside ? null : (fromApp.split(sep)[0] ?? null);
}

/** Whether one runtime load from `file` stays inside the product-path packages. */
function staysOnTheProductPath(file: string, specifier: string): boolean {
  if (specifier.startsWith(WORKSPACE_SCOPE)) {
    const name = specifier.slice(WORKSPACE_SCOPE.length).split('/')[0] ?? '';
    return PRODUCT_PATH_PACKAGES.includes(name);
  }
  if (RELATIVE_SPECIFIER.test(specifier)) {
    return PRODUCT_PATH_PACKAGES.includes(packageOf(resolve(dirname(file), specifier)) ?? '');
  }
  // A `node:` builtin or a third-party dependency, neither of which loads this workspace's code.
  return true;
}

/**
 * Every runtime load in `source` that LEAVES the product path, as `file: specifier`.
 *
 * A load leaves it by naming an `@app/*` package off the product path, or by a relative path that
 * resolves outside every product package: into `app/eval`, into `app/test`, or out of `app/`. So
 * a product path with no such load cannot reach the admission module through a static import.
 */
function offProductPathLoadsIn(file: string, source: string): readonly string[] {
  return [...source.matchAll(RUNTIME_LOAD)]
    .map((match) => match[1] ?? '')
    .filter((specifier) => !staysOnTheProductPath(file, specifier))
    .map((specifier) => `${relative(APP_DIR, file)}: ${specifier}`);
}

describe('the admission module lives in app/eval, off the product path (task 10.6; Req 10.7)', () => {
  // NOT ALREADY PINNED by any test. ESLint's boundary rule refuses the SPECIFIER `@app/eval` in
  // every product layer, so it cannot see a relative path that climbs into `app/eval/`; this scan
  // resolves the path, and checks every load against the product path as a whole.
  //
  // WHAT THESE CANNOT SEE.
  //   - A load that is not a line-leading statement: a dynamic `import()`, a `require()`, or an
  //     `import` that is indented or shares its line.
  //   - A specifier computed at runtime, or redirected by an alias the scan does not model: a
  //     `package.json` `imports` map, a tsconfig `paths` entry, or a bundler or vitest alias.
  //   - `import type`, skipped ON PURPOSE: it is erased, so it loads nothing, and ESLint already
  //     refuses it in every product layer.
  //   - The BUILT output: `dist/` is pruned. It is compiled from these sources, so it can only lag
  //     them, until `tsc -b` next runs.
  //   - Text that only LOOKS like a load, such as a template literal or a block comment holding a
  //     line that starts with `import`, is read as one. That errs toward a false report, which
  //     fails loudly, rather than toward a missed edge.
  const productSources = PRODUCT_PATH_PACKAGES.flatMap((name) =>
    sourceFilesUnder(join(APP_DIR, name)),
  );
  const loopModule = join(APP_DIR, 'agent', 'orchestrator', 'verification-loop.ts');

  it('given the workspace, then every app/ package is classified and the admission module is in eval', () => {
    // A package added to `app/` later fails here until it is placed on one side or the other.
    const packages = readdirSync(APP_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect([...PRODUCT_PATH_PACKAGES, ...OFF_PRODUCT_PATH_PACKAGES].sort()).toEqual(
      packages.sort(),
    );

    const admissionModule = fileURLToPath(new URL('./property-set-admission.ts', import.meta.url));
    expect(existsSync(admissionModule)).toBe(true);
    expect(packageOf(admissionModule)).toBe('eval');
  });

  it('given every product-path source, then none loads anything off the product path', () => {
    // NOT A WALK THAT SAW NOTHING: every product package contributed sources, and the file the
    // positive control below edits is one of them.
    expect(new Set(productSources.map(packageOf))).toEqual(new Set(PRODUCT_PATH_PACKAGES));
    expect(productSources).toContain(loopModule);

    expect(
      productSources.flatMap((file) => offProductPathLoadsIn(file, readFileSync(file, 'utf8'))),
    ).toEqual([]);
  });

  it('given a product module with harness loads appended, then each runtime one is reported', () => {
    // Positive control over the REAL text of the Verification_Loop, the product-side owner of the
    // admission outcome and so the likeliest place for this edge to appear. ESLint would refuse
    // the package import and the re-export too; the relative path is the one it cannot see; and
    // the `import type` loads nothing, so it is not reported.
    const source = readFileSync(loopModule, 'utf8');
    const appended = [
      "import { admitPropertySet } from '@app/eval';",
      "import { formalCalibrationOf } from '../../eval/property-set-admission.js';",
      "export { mutantIsInPropertySetGateSet } from '@app/eval';",
      "import type { PropertySetAdmission } from '@app/eval';",
    ].join('\n');

    expect(offProductPathLoadsIn(loopModule, source)).toEqual([]);
    expect(offProductPathLoadsIn(loopModule, `${source}\n${appended}\n`)).toEqual([
      'agent/orchestrator/verification-loop.ts: @app/eval',
      'agent/orchestrator/verification-loop.ts: ../../eval/property-set-admission.js',
      'agent/orchestrator/verification-loop.ts: @app/eval',
    ]);
  });
});
