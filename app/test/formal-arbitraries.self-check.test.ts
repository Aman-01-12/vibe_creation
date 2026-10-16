// formal-property-oracle: the self-check on `formal-arbitraries.ts`.
//
// WHY A GENERATOR NEEDS A TEST OF ITS OWN
//   Every property test in groups 5, 10, and 16 rests on these generators, and a generator is the
//   one piece of test infrastructure that NOTHING else falsifies: if `arbProofConditions()` quietly
//   pinned its base-case field to `passed`, Property 1's if-and-only-if would still pass - over a
//   sample in which the fifth condition never fails. That is worse than no test, because it
//   reports confidence that was never earned, and it is exactly the shape
//   `chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`
//   recorded when a widened union left an existing property vacuously passing.
//
//   So this file asserts COVERAGE of the generated sample rather than any behaviour of the code
//   under test. It is the smallest thing that fails if a soundness constraint on these generators
//   regresses, and every assertion below names the constraint it guards.
//
// WHAT IT WOULD CATCH, CONCRETELY
//   - a `base`, `presat`, or `induction` field pinned to any single value, or narrowed to two;
//   - an `assertionCount` that never generates the measured zero-assertion trap;
//   - a five-condition sample that never admits, so Property 1's iff cannot fail in one direction;
//   - a `FormalReport` whose four checks are derived from one another instead of drawn
//     independently, which would make the `bad_init` signature and the exit-code/status
//     disagreement unreachable;
//   - a cross-check that always agrees with the check it audits;
//   - a mutant population that never produces the unscorable calibration, or that derives the
//     independent judge's verdict from the formal one;
//   - an `arbResetContract()` that PINS the derived polarity, which alone would reduce Property 35
//     to an emission check, or that reaches only three of Property 31's four case-table rows;
//   - an `arbInitialStatePredicate()` that produces the ABSENT refusal but never the UNPARSEABLE
//     one, which every outcome-level assertion would still pass over;
//   - an `arbFormalProvenance()` that PINS any of `resetContract`, `clockPolarity`,
//     `assertionGateEmitted`, `propertySetAdmitted`, or `propertyWrapperSources` - the last
//     either to an all-`null` list or to one always as long as `results` - which is the trap
//     design.md's testing-strategy section names by the
//     case that produced it: when `NormalizationProvenance` became required, a pinned default would
//     have silently weakened every property that varies it. In particular a `resetContract` that
//     never generates `null`, or a `clockPolarity` that collapses `null` into `'none'`, would leave
//     every record-level property unable to tell "the pre-pass was never reached" from "it ran and
//     refused" - the one distinction design.md requires to survive encode and decode.
//
// HOW THE SAMPLE SIZE WAS CHOSEN, rather than guessed
//   `arbFormalReport`'s rarest required combination is a `FAILED` base case under a `PASSED`
//   induction check ALSO carrying `inductionSuccessful: true`, at about 4% of documents. At 500
//   samples the chance of missing it is `(1 - 0.04)^500` ~ 1e-9, so this file is not flaky; at the
//   shared 100-run default it would be ~1.7%, which is. The whole file is object construction with
//   no toolchain and no I/O.
//   The two generators task 16.3 added are both less demanding than that, so 500 still dominates:
//   `arbResetContract()`'s rarest required shape is one of the EIGHT derived kind-by-polarity-by-
//   initial-state combinations at 0.8 / 8 = 10%, missed with probability `(1 - 0.1)^500` ~ 1.3e-23,
//   and `arbInitialStatePredicate()`'s is the ABSENT arm at 2/11 ~ 18.2%, missed with probability
//   `(1 - 0.182)^500` ~ 4e-44.
//   Rule carried from
//   `chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`:
//   compute the share of the rarest required shape and size the sample to it; never weaken the
//   claim to fit 100.
//
// The tag strings are literals, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to
// a different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 1.2, 1.7, 6.6, 14.1, 14.21

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PROPERTY_SET_ADMISSION_OUTCOMES,
  type FormalProvenance,
  type PropertySetAdmissionOutcome,
} from '@app/agent';
import {
  admitProved,
  CLOCK_POLARITIES,
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  readFreeInitialState,
  type ClockPolarity,
  type CouldNotVerifyCause,
  type FormalVerdict,
  type ProofConditions,
  type ResetContract,
} from '@app/tools';

import {
  arbCalibratedMutantPopulation,
  arbFormalProvenance,
  arbFormalReport,
  arbInitialStatePredicate,
  arbProofConditions,
  arbResetContract,
  type CalibratedMutant,
} from './formal-arbitraries.js';

/** See the sample-size note in the header: sized to the rarest required combination, not to 100. */
const SAMPLE_SIZE = 500;

/** The four check slots a `FormalReport` always carries, in the worker's own run order. */
const CHECK_NAMES = ['presat', 'base', 'cover', 'induct'] as const;

/**
 * The distinct values one field takes across a sample.
 *
 * A `Set` of the read values rather than a count, because the claim is about how many DISTINCT
 * values were reachable, which a count cannot tell from one value drawn many times.
 */
function distinctValues<Sample, Value>(
  samples: readonly Sample[],
  read: (sample: Sample) => Value,
): ReadonlySet<Value> {
  return new Set(samples.map(read));
}

describe('formal-property-oracle, formal-arbitraries self-check: arbProofConditions', () => {
  const samples: readonly ProofConditions[] = fc.sample(arbProofConditions(), SAMPLE_SIZE);

  it('generates all three base-case values, so the fifth condition can fail', () => {
    // THE CONSTRAINT: the base-case field is GENERATED, never defaulted to `passed`. A pinned
    // `base` silently weakens Properties 1, 5, and 6 - the three the fifth condition exists for.
    expect(distinctValues(samples, (conditions) => conditions.base)).toEqual(
      new Set<ProofConditions['base']>(['passed', 'failed', 'not-run']),
    );
  });

  it('generates all three presat and all three induction values', () => {
    expect(distinctValues(samples, (conditions) => conditions.presat)).toEqual(
      new Set<ProofConditions['presat']>(['satisfiable', 'preunsat', 'not-run']),
    );
    expect(distinctValues(samples, (conditions) => conditions.induction)).toEqual(
      new Set<ProofConditions['induction']>(['successful', 'inconclusive', 'not-run']),
    );
  });

  it('generates all three cover shapes, including the unreached antecedent', () => {
    expect(distinctValues(samples, (conditions) => conditions.cover.reached)).toEqual(
      new Set<CoverReached>([true, false, 'not-applicable']),
    );
  });

  it('generates the measured zero-assertion trap and a usable count', () => {
    const counts = samples.map((conditions) => conditions.assertionCount);
    expect(counts).toContain(0);
    expect(counts.some((count) => Number.isSafeInteger(count) && count > 0)).toBe(true);
    // The values `isNonZeroAssertionCount`'s `Number.isSafeInteger` half exists for. Without them
    // that half of the guard is never exercised by any property in the suite.
    expect(counts.some((count) => !Number.isSafeInteger(count))).toBe(true);
  });

  it('generates combinations the gate both admits and refuses, so an iff can fail either way', () => {
    // The strongest single statement available about this generator: it can move the real gate in
    // both directions. A generator pinned anywhere would collapse one of these two sets.
    const outcomes = samples.map((conditions) => admitProved(conditions));
    expect(outcomes.some((outcome) => typeof outcome === 'object')).toBe(true);
    expect(outcomes.some((outcome) => typeof outcome === 'string')).toBe(true);
  });

  it('generates combinations with two or more failing conditions', () => {
    // Task 5.5 asserts the fixed cause order over COMBINATIONS; with mostly single-failure cases
    // the order would be asserted over samples in which only one cause was ever eligible.
    const withTwoFailures = samples.filter((conditions) => failureCount(conditions) >= 2);
    expect(withTwoFailures.length).toBeGreaterThan(0);
  });
});

describe('formal-property-oracle, formal-arbitraries self-check: arbFormalReport', () => {
  const samples = fc.sample(arbFormalReport(), SAMPLE_SIZE);

  it('varies every one of the four checks rather than deriving them from one another', () => {
    // THE CONSTRAINT: all four checks vary INDEPENDENTLY. A check pinned to one status, or copied
    // from a sibling, makes every combination property below unreachable.
    for (const name of CHECK_NAMES) {
      expect(distinctValues(samples, (report) => report.checks[name].status).size).toBeGreaterThan(
        1,
      );
      expect(
        distinctValues(samples, (report) => report.checks[name].exitCode).size,
      ).toBeGreaterThan(1);
      expect(
        distinctValues(samples, (report) => report.checks[name].elapsedMs).size,
      ).toBeGreaterThan(1);
    }
  });

  it('generates the measured bad_init signature: base FAILED under induction PASSED', () => {
    // THE CONSTRAINT: this combination must be reachable BY THE GENERATOR rather than only by a
    // hand-written fixture. It is the `bad_init` false-proof signature and also the signature a
    // wrong derived reset polarity produces.
    const badInitShaped = samples.filter(
      (report) =>
        report.checks.base.status === 'FAILED' && report.checks.induct.status === 'PASSED',
    );
    expect(badInitShaped.length).toBeGreaterThan(0);
    expect(badInitShaped.some((report) => report.checks.induct.inductionSuccessful === true)).toBe(
      true,
    );
  });

  it('generates an exit code that disagrees with its own Status: string', () => {
    const disagreeing = samples.filter((report) =>
      CHECK_NAMES.some((name) => {
        const check = report.checks[name];
        return check.status === 'PASSED' && check.exitCode !== 0;
      }),
    );
    expect(disagreeing.length).toBeGreaterThan(0);
  });

  it('generates a cross-check that disagrees with the check it audits, and reports on both', () => {
    // THE CONSTRAINT: a disagreeing audit is a CLASSIFICATION PATH - it is reported as
    // `could-not-verify` / `toolchain-unavailable` preferring neither solver - so it cannot be
    // reachable only by a fixture.
    const audits = samples.flatMap((report) =>
      CHECK_NAMES.map((name) => report.checks[name]).filter(
        (check) => check.crossCheck !== undefined,
      ),
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.some((check) => check.crossCheck?.status !== check.status)).toBe(true);
    expect(audits.some((check) => check.crossCheck?.status === check.status)).toBe(true);
  });

  it('generates both the presence and the absence of an optional trace path', () => {
    // A successful proof writes no trace, so ABSENCE is information; a generator that always
    // emitted one would make `refuted`'s missing-counterexample path unreachable.
    const traces = samples.flatMap((report) =>
      CHECK_NAMES.map((name) => report.checks[name].tracePath),
    );
    expect(traces.some((path) => path === undefined)).toBe(true);
    expect(traces.some((path) => typeof path === 'string')).toBe(true);
  });

  it('generates all three cover outcomes, and the two fields independently of each other', () => {
    // THE CONSTRAINT: the Cover_Check answers reachability in THREE ways - reached at a step,
    // answered UNREACHED, answered NOTHING - and only the third is `toolchain-unavailable`
    // (Req 5.12). A generator that always answered would delete `antecedent-unreached` from the
    // sample; one that never answered would delete it too, the other way round.
    const covers = samples.map((report) => report.checks.cover);
    expect(covers.some((cover) => cover.coverAnswered === true)).toBe(true);
    expect(covers.some((cover) => cover.coverAnswered === false)).toBe(true);
    expect(covers.some((cover) => cover.coverAnswered === undefined)).toBe(true);
    expect(
      covers.some((cover) => cover.coverAnswered === true && cover.reachedStep === undefined),
    ).toBe(true);
    expect(
      covers.some((cover) => cover.coverAnswered !== true && cover.reachedStep !== undefined),
    ).toBe(true);
    // And the field lands on the cover check ALONE, which is where its schema slot declares it.
    const others = samples.flatMap((report) =>
      (['presat', 'base', 'induct'] as const).map((name) => report.checks[name]),
    );
    expect(others.every((check) => check.coverAnswered === undefined)).toBe(true);
  });

  it('generates the zero assertion count the whole gate turns on', () => {
    const counts = samples.map((report) => report.assertionCount);
    expect(counts).toContain(0);
    expect(counts.some((count) => count > 0)).toBe(true);
  });
});

describe('formal-property-oracle, formal-arbitraries self-check: arbCalibratedMutantPopulation', () => {
  const populations = fc.sample(arbCalibratedMutantPopulation(), SAMPLE_SIZE);
  const mutants: readonly CalibratedMutant[] = populations.flat();

  it('mixes all three formal calibrations across the sample', () => {
    expect(distinctValues(mutants, (mutant) => mutant.formal)).toEqual(
      new Set(['formal-proved', 'formal-refuted', 'formal-could-not-verify']),
    );
  });

  it("varies the independent judge's verdict rather than deriving it from the formal one", () => {
    // If `golden` were derived from `formal`, the disagreeing pair Req 10.2 refuses - the oracle
    // PROVED a mutant the judge KILLED - could not be generated at all.
    expect(distinctValues(mutants, (mutant) => mutant.golden).size).toBeGreaterThan(1);
    const disagreeing = mutants.filter(
      (mutant) => mutant.formal === 'formal-proved' && mutant.golden === 'golden-killed',
    );
    expect(disagreeing.length).toBeGreaterThan(0);
  });

  it('gives every unscorable mutant its own cause, and varies which cause', () => {
    const unscorable = mutants.filter((mutant) => mutant.formal === 'formal-could-not-verify');
    expect(unscorable.length).toBeGreaterThan(0);
    expect(unscorable.every((mutant) => 'cause' in mutant && mutant.cause.length > 0)).toBe(true);
    expect(
      distinctValues(unscorable, (mutant) => ('cause' in mutant ? mutant.cause : null)).size,
    ).toBeGreaterThan(1);
  });

  it('generates an empty population and a populated one', () => {
    // The degenerate row group 10's counts must partition, and the one `judgeCoverageGaps` already
    // carries a `no-valid-mutants` member for.
    expect(populations.some((population) => population.length === 0)).toBe(true);
    expect(populations.some((population) => population.length > 1)).toBe(true);
  });

  it('gives every mutant in one population a distinct id', () => {
    for (const population of populations) {
      const ids = new Set(population.map((mutant) => mutant.identity.mutantId));
      expect(ids.size).toBe(population.length);
    }
  });
});

describe('formal-property-oracle, formal-arbitraries self-check: arbResetContract', () => {
  const samples: readonly ResetContract[] = fc.sample(arbResetContract(), SAMPLE_SIZE);
  const derived = samples.filter(isDerivedContract);

  it('generates both a derived and a refused contract', () => {
    // A refused contract is representable at the renderer's seam rather than thrown, so the
    // renderer's behaviour on it must be reachable by the generator and not only by a fixture.
    expect(distinctValues(samples, (contract) => contract.derived)).toEqual(new Set([true, false]));
  });

  it('generates the derived polarity rather than pinning it', () => {
    // THE CONSTRAINT: Property 35 asserts the assume's reset term is inverted if and only if the
    // polarity is ACTIVE-HIGH. A pinned `resetActiveLow` leaves that iff asserted over a sample in
    // which only one inversion was ever possible, which reduces Property 35 to "an assume appears".
    expect(distinctValues(derived, (contract) => contract.resetActiveLow)).toEqual(
      new Set([true, false]),
    );
  });

  it("generates all four rows of Property 31's case table, not three of them", () => {
    // THE CONSTRAINT: the gate is emitted for exactly ONE of these four rows - synchronous AND free.
    // The SET must equal the full cross; a `size > 1` check passes on a two-of-four narrowing, and
    // a three-of-four one would leave one row's claim asserted over an empty sample.
    expect(distinctValues(derived, gateRow)).toEqual(
      new Set(['async/free', 'async/pinned', 'sync/free', 'sync/pinned']),
    );
  });

  it('crosses both reset kinds against both polarities, so Property 35 spans the kinds', () => {
    // The eight-way cross is what makes 10% the rarest required shape; this is the half of it the
    // two assertions above do not pin between them.
    expect(distinctValues(derived, kindAndPolarity)).toEqual(
      new Set(['async/active-low', 'async/active-high', 'sync/active-low', 'sync/active-high']),
    );
  });
});

describe('formal-property-oracle, formal-arbitraries self-check: arbInitialStatePredicate', () => {
  const samples: readonly (string | null)[] = fc.sample(arbInitialStatePredicate(), SAMPLE_SIZE);

  it('generates all three outcomes of the free-initial-state read', () => {
    // THE CONSTRAINT: the read has THREE answers - free, pinned, and unreadable - and the third is a
    // REFUSAL rather than a default, because both defaults are unsafe in opposite directions. The SET
    // must equal all three: a generator reaching only two would leave Property 36's refusal
    // direction, or its emitting row, asserted over nothing.
    expect(distinctValues(samples, readFreeInitialState)).toEqual(
      new Set<boolean | null>([true, false, null]),
    );
  });

  it('generates the ABSENT and the UNPARSEABLE refusal as distinct shapes', () => {
    // THE CONSTRAINT, and the one an outcome-level assertion cannot make: both shapes refuse, so a
    // generator producing only `null` satisfies the assertion above while never once exercising this
    // side's own boundary check on a predicate body the worker did hand across.
    expect(samples.some((predicate) => predicate === null)).toBe(true);
    expect(
      samples.some((predicate) => predicate !== null && readFreeInitialState(predicate) === null),
    ).toBe(true);
  });

  it('generates the literal `true` WRAPPED in whitespace a reader must trim, not only bare', () => {
    // THE CONSTRAINT: the free reading must be reachable through the UNTRIMMED shape, because a
    // comparison written against the raw text reads these as pinned and so suppresses the gate on a
    // design whose step 0 IS a free-variable artifact - the false-refutation direction. `p !== p.trim()`
    // alone would be satisfied by the whitespace-only UNPARSEABLE arm, so the trim has to land on
    // `true` for this to be about the free reading at all.
    expect(
      samples.some(
        (predicate) => predicate !== null && predicate !== 'true' && predicate.trim() === 'true',
      ),
    ).toBe(true);
  });
});

/** The `reached` discriminant of a `CoverCondition`, as the three values it can take. */
type CoverReached = ProofConditions['cover']['reached'];

/** Narrow a `ResetContract` to its derived arm, so the fields below are readable without a cast. */
function isDerivedContract(
  contract: ResetContract,
): contract is Extract<ResetContract, { readonly derived: true }> {
  return contract.derived;
}

/** One row of Property 31's case table: the reset kind crossed with the initial-state shape. */
function gateRow(contract: Extract<ResetContract, { readonly derived: true }>): string {
  return `${contract.resetKind}/${contract.initialStateFree ? 'free' : 'pinned'}`;
}

/** The reset kind crossed with the derived polarity, which is the cross Property 35 spans. */
function kindAndPolarity(contract: Extract<ResetContract, { readonly derived: true }>): string {
  return `${contract.resetKind}/${contract.resetActiveLow ? 'active-low' : 'active-high'}`;
}

/** How many of the five conditions fail, so the two-or-more-failures sample can be counted. */
function failureCount(conditions: ProofConditions): number {
  const failures = [
    !(Number.isSafeInteger(conditions.assertionCount) && conditions.assertionCount > 0),
    conditions.presat !== 'satisfiable',
    conditions.cover.reached === false,
    conditions.base !== 'passed',
    conditions.induction !== 'successful',
  ];
  return failures.filter((failed) => failed).length;
}

/**
 * The shape of one `resetContract` field value, as the THREE facts it can carry.
 *
 * A string tag rather than the value, because the claim is about how many distinct FACTS were
 * reachable: `null` (the pre-pass was never reached), `refused` (it ran and refused), and `derived`
 * (it ran and derived a contract). Two of those are structurally similar and the whole point is
 * that they must not collapse.
 */
function resetContractShape(contract: ResetContract | null): string {
  if (contract === null) {
    return 'absent';
  }
  return contract.derived ? 'derived' : 'refused';
}

describe('formal-property-oracle, formal-arbitraries self-check: arbFormalProvenance', () => {
  const samples: readonly FormalProvenance[] = fc.sample(arbFormalProvenance(), SAMPLE_SIZE);

  it('generates all THREE resetContract shapes, so absent never collapses into refused', () => {
    // THE CONSTRAINT, and the one design.md names explicitly: `null` means the pre-pass was NEVER
    // REACHED and `{ derived: false }` means it RAN and REFUSED. A generator missing the `null` arm
    // leaves every record-level property unable to tell them apart while still reporting green.
    expect(distinctValues(samples, (formal) => resetContractShape(formal.resetContract))).toEqual(
      new Set(['absent', 'refused', 'derived']),
    );
  });

  it('generates every clockPolarity member AND the absent reading, which is not `none`', () => {
    // `'none'` is the SUPPORTED no-clocked-state finding; `null` is no reading at all. Spread from
    // the vocabulary rather than restated, so a fifth member fails here instead of silently going
    // ungenerated.
    expect(distinctValues(samples, (formal) => formal.clockPolarity)).toEqual(
      new Set<ClockPolarity | null>([...CLOCK_POLARITIES, null]),
    );
  });

  it('generates both assertionGateEmitted values, so the gate is never assumed unemitted', () => {
    expect(distinctValues(samples, (formal) => formal.assertionGateEmitted)).toEqual(
      new Set([true, false]),
    );
  });

  it('generates an empty wrapper list and both a PRESENT and an ABSENT wrapper entry', () => {
    // A string is the source the oracle submitted; `null` is "no wrapper was rendered for this
    // property". A generator that pinned every entry to `null` would leave `property-wrapper.v`'s
    // capture asserted over its absent direction alone, while still reporting green.
    expect(samples.some((formal) => formal.propertyWrapperSources.length === 0)).toBe(true);
    const entries = samples.flatMap((formal) => formal.propertyWrapperSources);
    expect(distinctValues(entries, (source) => (source === null ? 'absent' : 'present'))).toEqual(
      new Set(['absent', 'present']),
    );
  });

  it('generates wrapper lists both paired with and unpaired from the results by length', () => {
    // The pairing is BY INDEX, and the Artifact_Sink must read a list of another length as "no
    // wrapper" rather than mispair it. A generator that always aligned the two would make that
    // guard unfalsifiable; one that never did would leave the capture's present path unreached.
    expect(
      distinctValues(
        samples,
        (formal) => formal.propertyWrapperSources.length === formal.results.length,
      ),
    ).toEqual(new Set([true, false]));
  });

  it('generates all FOUR propertySetAdmitted members, so no admission fact reads as another', () => {
    // FOUR, not three, and not the `boolean | null` this field used to be. The members this
    // guards against losing are the two that look redundant and are not: `'not-gated'` is "no
    // gate ran" and `'no-gate-set'` is "the gate ran and had nothing to test". A generator
    // that dropped either would leave every record-level property unable to tell a vacuous
    // gate from an absent one, and Requirement 10.9's refused-sample count is over
    // `'refused'` ALONE, so a tally that confused them would be wrong rather than imprecise.
    // Spread from the vocabulary rather than restated, so a fifth member fails HERE.
    expect(distinctValues(samples, (formal) => formal.propertySetAdmitted)).toEqual(
      new Set<PropertySetAdmissionOutcome>([...PROPERTY_SET_ADMISSION_OUTCOMES]),
    );
  });

  it('generates the absent fallbackReason and every cause a fallback can name', () => {
    expect(distinctValues(samples, (formal) => formal.fallbackReason)).toEqual(
      new Set<CouldNotVerifyCause | null>([...COULD_NOT_VERIFY_CAUSES, null]),
    );
  });

  it('generates an EMPTY results list and all three verdicts among the non-empty ones', () => {
    // The empty list is the no-property-submitted state, which is a real value rather than a
    // placeholder, so a generator with `minLength: 1` would make it unreachable.
    expect(samples.some((formal) => formal.results.length === 0)).toBe(true);
    expect(samples.some((formal) => formal.results.length > 0)).toBe(true);
    const verdicts = new Set<FormalVerdict>(
      samples.flatMap((formal) => formal.results.map((result) => result.verdict)),
    );
    expect(verdicts).toEqual(new Set<FormalVerdict>([...FORMAL_VERDICTS]));
  });
});
