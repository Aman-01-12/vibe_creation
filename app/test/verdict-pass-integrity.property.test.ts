// Property 5: A pass verdict requires all spec-derived checks to pass (task 2.4).
//
// Design: Property 5 (Req 8.10). A recorded verdict of `pass` implies every
// Testbench check derived from the Spec acceptance criteria passed; a merely
// completed or partially passing run never yields a `pass` verdict.
//
// This property pins the single owner of the pass-integrity rule, across the two
// public surfaces that enforce it, over many generated inputs:
//
//   1. `passIntegrityHolds(verdict, allChecksPassed)` - the rule itself: false
//      exactly when a `pass` verdict is paired with checks that did not all pass,
//      and true for every other combination (any non-`pass` verdict, or a `pass`
//      with all checks passed).
//   2. `allSpecChecksPassed(checks)` - true iff the check set is non-empty and
//      every check passed, so an empty run (which verified nothing) is never a
//      pass.
//   3. `makeVerificationResult(input)` - the constructor refuses to build a
//      `pass` VerificationResult whose checks did not all pass or that lacks a
//      valid oracle span, while accepting a well-formed `pass` and any valid
//      non-`pass` run. A partially passing run therefore cannot be laundered into
//      a `pass` result.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  allSpecChecksPassed,
  isErr,
  isOk,
  isUlid,
  makeVerificationResult,
  newUlid,
  passIntegrityHolds,
  type CheckResult,
  type Ulid,
  type Verdict,
} from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(5, 'A pass verdict requires all spec-derived checks to pass');

// -- Generators -------------------------------------------------------------

/** Every closed verdict value, so the rule is exercised on `pass` and non-`pass`. */
const verdictArbitrary = (): fc.Arbitrary<Verdict> => fc.constantFrom('pass', 'fail', 'error');

/** A fresh, syntactically valid ULID from the core helper (never hand-rolled). */
const ulidArbitrary = (): fc.Arbitrary<Ulid> => fc.constant(null).map(() => newUlid());

/**
 * A string that is never a valid ULID: wrong length or non-base32 content. The
 * filter guarantees invalidity so the oracle-span rejection path is always hit.
 */
const invalidUlidArbitrary = (): fc.Arbitrary<string> =>
  fc
    .oneof(
      fc.constant(''),
      fc.string({ maxLength: 25 }),
      fc.string({ minLength: 27, maxLength: 48 }),
    )
    .filter((candidate) => !isUlid(candidate));

/** One spec-derived check result. */
const checkArbitrary = (): fc.Arbitrary<CheckResult> =>
  fc.record({
    name: fc.string({ minLength: 1, maxLength: 24 }),
    passed: fc.boolean(),
  });

/** Any check set, including the empty set (which must never count as a pass). */
const checksArbitrary = (): fc.Arbitrary<readonly CheckResult[]> =>
  fc.array(checkArbitrary(), { maxLength: 8 });

/** A non-empty check set in which at least one check failed (a partial run). */
const partiallyPassingChecksArbitrary = (): fc.Arbitrary<readonly CheckResult[]> =>
  fc
    .array(checkArbitrary(), { minLength: 1, maxLength: 8 })
    .filter((checks) => !allSpecChecksPassed(checks));

/** The identifiers, counts, and cost every VerificationResult needs, all valid. */
const verificationScaffoldArbitrary = () =>
  fc.record({
    id: ulidArbitrary(),
    moduleVersionId: ulidArbitrary(),
    testbenchId: ulidArbitrary(),
    iterations: fc.nat({ max: 64 }),
    costCents: fc.nat({ max: 100_000 }),
  });

// -- Property 5 -------------------------------------------------------------

describe(PROPERTY, () => {
  it('passIntegrityHolds is false exactly for a pass with checks that did not all pass', () => {
    // Validates: Requirements 8.10
    fc.assert(
      fc.property(verdictArbitrary(), fc.boolean(), (verdict, allChecksPassed) => {
        const violatesRule = verdict === 'pass' && allChecksPassed === false;
        expect(passIntegrityHolds(verdict, allChecksPassed)).toBe(!violatesRule);
      }),
      propertyParameters(),
    );
  });

  it('allSpecChecksPassed is true iff the check set is non-empty and every check passed', () => {
    // Validates: Requirements 8.10
    fc.assert(
      fc.property(checksArbitrary(), (checks) => {
        const expected = checks.length > 0 && checks.every((check) => check.passed);
        expect(allSpecChecksPassed(checks)).toBe(expected);
      }),
      propertyParameters(),
    );
  });

  it('rejects a pass VerificationResult unless all checks passed and the oracle span is valid', () => {
    // Validates: Requirements 8.10
    fc.assert(
      fc.property(
        verificationScaffoldArbitrary(),
        fc.boolean(),
        fc.oneof(ulidArbitrary(), invalidUlidArbitrary()),
        (scaffold, allChecksPassed, oracleSpanId) => {
          const result = makeVerificationResult({
            ...scaffold,
            verdict: 'pass',
            allChecksPassed,
            oracleSpanId,
          });

          const wellFormed = allChecksPassed === true && isUlid(oracleSpanId);
          expect(isOk(result)).toBe(wellFormed);

          if (!wellFormed) {
            // Pass integrity is checked before oracle provenance, so a run that
            // fails both surfaces reports the all-checks-passed violation first.
            const expectedCode =
              allChecksPassed === false
                ? 'PASS_VERDICT_REQUIRES_ALL_CHECKS_PASSED'
                : 'PASS_VERDICT_REQUIRES_ORACLE_SPAN';
            expect(isErr(result) && result.error.code).toBe(expectedCode);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('never constructs a pass from a partially passing run, but accepts valid non-pass runs', () => {
    // Validates: Requirements 8.10
    fc.assert(
      fc.property(
        verificationScaffoldArbitrary(),
        partiallyPassingChecksArbitrary(),
        fc.constantFrom<Verdict>('fail', 'error'),
        ulidArbitrary(),
        (scaffold, partialChecks, nonPassVerdict, oracleSpanId) => {
          const allChecksPassed = allSpecChecksPassed(partialChecks);
          expect(allChecksPassed).toBe(false);

          // A partial run mislabeled `pass` is refused: its checks did not all pass.
          const forgedPass = makeVerificationResult({
            ...scaffold,
            verdict: 'pass',
            allChecksPassed,
            oracleSpanId,
          });
          expect(isErr(forgedPass) && forgedPass.error.code).toBe(
            'PASS_VERDICT_REQUIRES_ALL_CHECKS_PASSED',
          );

          // The same partial run recorded honestly as a non-pass verdict is valid.
          const honest = makeVerificationResult({
            ...scaffold,
            verdict: nonPassVerdict,
            allChecksPassed,
            oracleSpanId,
          });
          expect(isOk(honest)).toBe(true);
        },
      ),
      propertyParameters(),
    );
  });
});
