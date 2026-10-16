// formal-property-oracle, task 5.9: the two closed vocabularies, and `admitProved` as the sole
// constructor of a `ProvedEvidence`.
//
// WHY THESE ARE UNIT TESTS AND NOT PROPERTIES
//   A closed vocabulary's claim is "exactly these members and no others", which is a statement about
//   a FIXED, SMALL, ENUMERATED set. A property over the union would draw its values FROM that union
//   and so could only ever confirm that the generator and the type agree - it would test the
//   generator. So each member gets ONE assertion naming it, and the closedness gets one more: eleven
//   names plus a count is exactly the claim, and a twelfth member added without a test fails the
//   count.
//   Each membership assertion goes through a TYPED constant rather than a bare string, so a RENAMED
//   member is a compile error here and not merely a failing assertion - which is the difference
//   between a test that catches the rename and a test that reports a puzzle.
//
// WHY THE VOCABULARY IS DERIVED FROM THE ARRAY RATHER THAN DECLARED BESIDE IT
//   `CouldNotVerifyCause` is `(typeof COULD_NOT_VERIFY_CAUSES)[number]`. The alternative - a separate
//   union plus an `as const satisfies readonly CouldNotVerifyCause[]` array - permits the array to be
//   INCOMPLETE, because `satisfies` checks that each member belongs to the type and never that the
//   type is covered. So this file can rest on the array being the whole vocabulary; that is a
//   property of how the type is declared, not an assumption.
//
// THE THREE CAUSES THE GATE NEVER RETURNS, AND WHY THAT IS NOT A GAP
//   `COULD_NOT_VERIFY_CAUSES` is the vocabulary for the WHOLE oracle rather than the range of
//   `admitProved`. `reset-contract-unresolved` and `clock-contract-unsupported` are reported by the
//   Reset_Contract_Prepass ahead of the whole fixed order, over the design alone, before any
//   Property_Wrapper exists; `induction-engine-incomplete` needs the Induction_Check's RAW reported
//   `FAILED` together with a passing Base_Check, and `ProofConditions['induction']` records what the
//   check ESTABLISHED rather than the string it printed, so the caller is the only layer that can
//   name it. The eight-of-eleven range is recorded in
//   `chipAgent/_inbox/gotcha-base-condition-field-is-base-not-basecase-and-admitproved-returns-only-eight-of-eleven-causes.md`,
//   and the exclusion is asserted in `formal-cause-ordering.property.test.ts`.
//
// WHAT "SOLE CONSTRUCTOR" MEANS, AND THE HONEST CEILING ON ASSERTING IT
//   `ProvedEvidence.assertionCount` is a `NonZeroAssertionCount`, a branded number whose brand key is
//   a module-private `unique symbol`. No other module can NAME that key, so no other module can build
//   the brand, and `admitProved` is the only exported function that returns a value carrying it. That
//   is a COMPILE-TIME guarantee and cannot be asserted at runtime - so it is pinned the only way it
//   can be: a hand-written evidence literal below is marked `@ts-expect-error`, and if the seal were
//   ever removed that suppression becomes unused and `tsc` fails. The ceiling stated plainly:
//   TypeScript's `as` can always be written by a caller who chooses to; the brand makes that a
//   deliberate, greppable act instead of something a `number` field lets happen by accident.
//   The runtime half asserted here is Req 2.6's: nothing reaches past the assertion-count condition -
//   not an extra argument, not a repeated call, not an environment variable.
//
// **Validates: Requirements 1.1, 1.4, 1.6, 2.4, 2.6, 4.12, 5.4, 5.8**

import { afterEach, describe, expect, it } from 'vitest';

import {
  admitProved,
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type CouldNotVerifyCause,
  type FormalVerdict,
  type ProofConditions,
  type ProvedEvidence,
} from '@app/tools';

/** The eleven-member count, stated once so the closedness assertion reads as the claim it is. */
const CAUSE_COUNT = 11;

/** The three-member Formal_Verdict count. */
const VERDICT_COUNT = 3;

/** The five conditions in their admitting form: the one input that yields evidence. */
const ADMITTING: ProofConditions = Object.freeze({
  assertionCount: 7,
  presat: 'satisfiable',
  cover: { reached: true, step: 3 },
  base: 'passed',
  induction: 'successful',
});

/**
 * Every count that is not a real count.
 *
 * Zero is the MEASURED trap (`adder_8bit` asserting `cout == 1'b0` reported `Status: PASSED` over 0
 * assertions); the other five are what an untrusted `number` can hold once it has crossed a seam, and
 * they are why the guard is `Number.isSafeInteger(count) && count > 0` rather than `count !== 0`.
 */
const UNUSABLE_COUNTS: readonly number[] = Object.freeze([
  0,
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
]);

/** An environment variable nothing reads, used to check that nothing reads one. */
const INVENTED_ENV_KEY = 'FORMAL_ORACLE_ALLOW_ZERO_ASSERTIONS';

describe('formal-property-oracle: the Could_Not_Verify_Cause vocabulary is closed at eleven members', () => {
  it('names the measured zero-assertion trap', () => {
    const cause: CouldNotVerifyCause = 'zero-assertions';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names a design Yosys refused to read or elaborate', () => {
    const cause: CouldNotVerifyCause = 'frontend-rejected';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names a Property_Wrapper that did not build, and every unattributable build failure', () => {
    const cause: CouldNotVerifyCause = 'property-build-failed';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names assumptions that cannot all hold, under which anything is provable', () => {
    const cause: CouldNotVerifyCause = 'contradictory-assumptions';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names an antecedent the Cover_Check did not reach, so the property was never evaluated', () => {
    const cause: CouldNotVerifyCause = 'antecedent-unreached';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names a bounded pass, whose remedy is more depth', () => {
    const cause: CouldNotVerifyCause = 'induction-inconclusive';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names an induction failure over a passing base case, which no depth is known to repair', () => {
    const cause: CouldNotVerifyCause = 'induction-engine-incomplete';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names a pre-pass that could not resolve the reset contract', () => {
    const cause: CouldNotVerifyCause = 'reset-contract-unresolved';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names a clocking the model cannot carry faithfully, the one false-refutation direction', () => {
    const cause: CouldNotVerifyCause = 'clock-contract-unsupported';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names a Property_Time_Budget spent before a verdict was reached', () => {
    const cause: CouldNotVerifyCause = 'proof-timeout';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('names a toolchain that produced no usable verdict at all', () => {
    const cause: CouldNotVerifyCause = 'toolchain-unavailable';
    expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
  });

  it('holds exactly eleven distinct members and nothing else', () => {
    // CLOSED is the load-bearing word: a twelfth fact has to arrive as a member every total map over
    // this vocabulary then fails to compile without, rather than as prose in a diagnostic string.
    expect(COULD_NOT_VERIFY_CAUSES).toHaveLength(CAUSE_COUNT);
    expect(new Set(COULD_NOT_VERIFY_CAUSES).size).toBe(CAUSE_COUNT);
  });
});

describe('formal-property-oracle: the Formal_Verdict vocabulary is closed at three members', () => {
  it('names proved', () => {
    const verdict: FormalVerdict = 'proved';
    expect(FORMAL_VERDICTS).toContain(verdict);
  });

  it('names refuted', () => {
    const verdict: FormalVerdict = 'refuted';
    expect(FORMAL_VERDICTS).toContain(verdict);
  });

  it('names could-not-verify, which is a THIRD member and not a shade of either other', () => {
    // Req 1.11: folding it into `refuted` would blame the student for our solver, and folding it into
    // `proved` is the severity-1 shape this spec exists to prevent.
    const verdict: FormalVerdict = 'could-not-verify';
    expect(FORMAL_VERDICTS).toContain(verdict);
  });

  it('holds exactly three distinct members and nothing else', () => {
    expect(FORMAL_VERDICTS).toHaveLength(VERDICT_COUNT);
    expect(new Set(FORMAL_VERDICTS).size).toBe(VERDICT_COUNT);
  });
});

describe('formal-property-oracle: the vocabulary claims exactly one antecedent case and two induction cases', () => {
  it('names the unreached antecedent once, claiming no distinction the toolchain cannot make', () => {
    // Req 5.4: `antecedent-unreached` covers an antecedent that is UNREACHABLE and one whose first
    // reachable step merely EXCEEDS the depth used, without claiming to tell them apart - nothing in
    // the toolchain does. `counter_12`'s `out == 11` is genuinely reached at step 13 and reports
    // unreached at every depth below 14, from one Cover_Check at one depth. A second member would
    // name a distinction we cannot measure.
    const antecedentCauses = COULD_NOT_VERIFY_CAUSES.filter((cause) =>
      cause.includes('antecedent'),
    );
    expect(antecedentCauses).toEqual(['antecedent-unreached']);
  });

  it('keeps the two induction failures as two distinct members', () => {
    // Req 4.12: the first names a depth that was too shallow, whose remedy is more depth; the second
    // names an incompleteness in `yosys-smtbmc`'s k-induction - it emits no simple-path constraints -
    // which no depth is known to repair. Collapsing them would make a CORRECT design's induction
    // failure indistinguishable from an under-deep run, and the tool gives no signal separating them:
    // its own `Loop detected, increasing induction depth will not help` message printed on NONE of
    // the measured failing cases.
    const shallow: CouldNotVerifyCause = 'induction-inconclusive';
    const engine: CouldNotVerifyCause = 'induction-engine-incomplete';
    expect(shallow).not.toBe(engine);
    const inductionCauses = COULD_NOT_VERIFY_CAUSES.filter((cause) =>
      cause.startsWith('induction-'),
    );
    expect(new Set(inductionCauses)).toEqual(new Set([shallow, engine]));
  });
});

describe('formal-property-oracle: admitProved is the sole constructor of a ProvedEvidence', () => {
  afterEach(() => {
    delete process.env[INVENTED_ENV_KEY];
  });

  it('builds the evidence from the five admitting conditions and from nothing else', () => {
    const admission = admitProved(ADMITTING);
    expect(admission).toEqual({
      assertionCount: ADMITTING.assertionCount,
      presat: 'satisfiable',
      cover: { reached: true, step: 3 },
      base: 'passed',
      induction: 'successful',
    });
  });

  it('refuses a hand-written evidence literal, because the brand key is module-private', () => {
    // Every field below is the admitting literal, so the ONE thing wrong with this object is the
    // brand: `assertionCount` is a `NonZeroAssertionCount`, whose brand key is a `unique symbol`
    // declared and NOT exported by `conditions.ts`, so a plain `1` cannot satisfy it. The suppression
    // sits on that property because that is where `tsc` reports it (TS2322).
    const forged: ProvedEvidence = {
      // @ts-expect-error TS2322 is the REGRESSION PIN for the seal: remove the brand and this
      // suppression becomes unused, which fails `tsc` rather than quietly widening what a `proved`
      // verdict may be built from.
      assertionCount: 1,
      presat: 'satisfiable',
      cover: { reached: true, step: 0 },
      base: 'passed',
      induction: 'successful',
    };
    expect(forged.base).toBe('passed');
  });

  it('takes exactly one parameter, so there is no second channel into the gate', () => {
    // Req 2.6: nothing can skip the assertion-count condition. The function reads one argument, no
    // module-level mutable state, no configuration value, and no environment variable, and the count
    // guard is its first statement.
    expect(admitProved).toHaveLength(1);
  });

  it('refuses every count that is not a positive safe integer, whatever the other four say', () => {
    for (const assertionCount of UNUSABLE_COUNTS) {
      // The object carries the admitting value for all four other conditions, so the count is the
      // only reason a refusal can arrive - and the refusal names the count.
      expect({ assertionCount, admission: admitProved({ ...ADMITTING, assertionCount }) }).toEqual({
        assertionCount,
        admission: 'zero-assertions',
      });
    }
  });

  it('ignores an extra argument and an environment variable, and answers the same on every call', () => {
    // An extra argument is assignable rather than cast, so this is a real call shape: a function of
    // one parameter satisfies a variadic type. Nothing a caller passes reaches the guard.
    const variadicGate: (conditions: ProofConditions, ...extra: readonly unknown[]) => unknown =
      admitProved;
    const zeroCount: ProofConditions = { ...ADMITTING, assertionCount: 0 };
    expect(variadicGate(zeroCount, { skipAssertionCountGuard: true })).toBe('zero-assertions');

    // The environment half, with its ceiling stated: a module-level read would happen at import time
    // and is out of reach here, so what this rules out is a PER-CALL read - which is the shape that
    // could otherwise make one run's verdict depend on how the process was launched.
    process.env[INVENTED_ENV_KEY] = '1';
    expect(admitProved(zeroCount)).toBe('zero-assertions');
    expect(admitProved(ADMITTING)).toEqual(admitProved(ADMITTING));
  });
});
