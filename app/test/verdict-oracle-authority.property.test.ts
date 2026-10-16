// **Feature: formal-gate-first-light, Property 34: A verdict is the oracle's or it is
// Not_Measured**
//
// WHAT IS ASSERTED HERE, AND WHAT THE TYPE ALREADY SETTLES
//   `PropertyOnlyOutcome` makes four of this property's clauses UNREPRESENTABLE in process, so a
//   property test asserting them over typed values would be vacuous however wrong the code was:
//   the `not-measured` arm declares no `verdict` field, the `measured` arm declares `conditions`
//   as required, `couldNotVerifyCause` exists exactly on the `could-not-verify` arm, and no field
//   anywhere names either solver's own verdict. Those are stated in `record.ts`'s own header and
//   are not re-asserted below.
//   What is left is everything that happens at a SEAM, where the type system is not present:
//   the decode of a persisted file, which is external input even when we wrote it, and the
//   interpreter's resolution of a Solver_Cross_Check disagreement.
//
// WHY THE DISAGREEMENT IS GENERATED IN BOTH ORDERS
//   Req 11.7 says the recorded verdict is `could-not-verify` and NEITHER solver is preferred.
//   A test generating one order only would pass against an implementation that silently took
//   whichever solver it read first, because that implementation also answers `could-not-verify`
//   on the single order it was shown. So every draw builds the same disagreement twice, with the
//   two sides swapped AND the two solver names swapped with them, and asserts the verdict and its
//   cause are the same either way. `PropertyResult` has no solver field at all, so this symmetry
//   is what "prefers neither solver" can mean for a value of that type.
//
// THE NON-VACUITY TWIN
//   Reaching the disagreement branch needs a completed lowering, an unkilled run, a reachable
//   cover step, and a usable assertion count, all of which this file forces. A third report is
//   therefore built per draw with the chosen check UNAUDITED and nothing else changed, and the
//   run asserts that some twin reached a verdict other than `could-not-verify`. Without it the
//   whole property could pass on preconditions that answer `could-not-verify` by themselves.
//   That counter is also the falsification witness: on the draws it counts, the primary side's own
//   verdict is NOT `could-not-verify`, so an implementation taking the solver it read first would
//   return that verdict here and fail the assertion below.
//
// RUN COUNT: 500 for the interpreter clause, sized to its RAREST required row rather than to the
//   shared 100. Measured over 500 draws: the twin reached a verdict other than `could-not-verify`
//   73 times (14.6%), and 18 draws (3.6%) disagreed by the INDUCTION LINE alone - two solvers
//   reporting the same `Status:` while disagreeing about the one fact `proved` rests on. At 100
//   runs that second row is missed about once in 40, which is a flake rather than a claim; at 500
//   it is missed about once in 1e8.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 11.1, 11.2, 11.3, 11.7**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  decodePropertyOnlyMeasurement,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  type ManifestToolchain,
  type PropertyOnlyOutcome,
} from '@app/eval';
import {
  COULD_NOT_VERIFY_CAUSES,
  COUNTEREXAMPLE_ARTIFACT_KEY,
  FORMAL_VERDICTS,
  interpretFormalReport,
  type ArtifactBlobRef,
  type FormalCheckReport,
  type FormalChecksReport,
  type FormalCrossCheckReport,
  type FormalReport,
  type FormalRunContext,
  type ProofConditions,
  type SandboxResult,
} from '@app/tools';

import { arbFormalProperty, arbFormalReport, arbProofConditions } from './formal-arbitraries.js';
import { withCoverStepBelowDepth } from './formal-cover-depth.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  "formal-gate-first-light, Property 34: A verdict is the oracle's or it is Not_Measured";

/** See the RUN COUNT note: the non-vacuity twin is verdict-shaped on roughly 7% of draws. */
const CROSS_CHECK_NUM_RUNS = 500;

// ---------------------------------------------------------------------------
// The Solver_Cross_Check clause (Req 11.7, 11.1)
// ---------------------------------------------------------------------------

/** The four check slots every report carries, in the worker's own run order. */
const CHECK_NAMES = ['presat', 'base', 'cover', 'induct'] as const;
type CheckName = (typeof CHECK_NAMES)[number];

/**
 * The two solver names, swapped with the sides so neither is constant across the two orders.
 *
 * If one name stayed on the primary side, an implementation preferring that name by itself would
 * answer both orders alike and the symmetry assertion would not see it.
 */
const SOLVERS = ['bitwuzla', 'z3'] as const;

/** `Status:` strings a check can report, measured and unrecognized, plus an unparsed status. */
const STATUS_LINES: readonly (string | null)[] = Object.freeze([
  'PASSED',
  'FAILED',
  'PREUNSAT',
  'UNKNOWN',
  null,
]);

/** One solver's side of a disagreement: the `Status:` it reported, and its induction line. */
interface SolverSide {
  readonly status: string | null;
  readonly inductionSuccessful?: boolean;
}

/** One solver's audit of a check: the side it reported, and which solver reported it. */
interface Audit {
  readonly side: SolverSide;
  readonly solver: string;
}

/** What one draw injects into one check: the primary's side, and the audit of it. */
interface Injection {
  readonly name: CheckName;
  readonly primary: SolverSide;
  /** The audit, or `null` for an unaudited check - the non-vacuity twin. */
  readonly audit: Audit | null;
  readonly assertionCount: number;
}

/** The induction line a side carries, including the absent case a bounded pass prints. */
function arbInductionLine(): fc.Arbitrary<boolean | undefined> {
  return fc.constantFrom<boolean | undefined>(true, false, undefined);
}

/** A side with its induction line present only where the solver reported one. */
function side(status: string | null, inductionSuccessful: boolean | undefined): SolverSide {
  return { status, ...(inductionSuccessful === undefined ? {} : { inductionSuccessful }) };
}

/**
 * Two sides that DISAGREE, by `Status:` or by the induction line.
 *
 * The line is drawn only for the induction check, which is the one check where the status alone
 * is not the whole result: a bounded pass and an unbounded proof both report `PASSED`.
 */
function arbDisagreeingSides(name: CheckName): fc.Arbitrary<readonly [SolverSide, SolverSide]> {
  const statuses = fc.tuple(fc.constantFrom(...STATUS_LINES), fc.constantFrom(...STATUS_LINES));
  if (name !== 'induct') {
    return statuses
      .filter(([left, right]) => left !== right)
      .map(([left, right]) => [side(left, undefined), side(right, undefined)]);
  }
  return fc
    .tuple(statuses, arbInductionLine(), arbInductionLine())
    .filter(([[left, right], leftLine, rightLine]) => left !== right || leftLine !== rightLine)
    .map(([[left, right], leftLine, rightLine]) => [side(left, leftLine), side(right, rightLine)]);
}

/** One draw: which check disagrees, the two sides of that disagreement, and a usable count. */
function arbDisagreement(): fc.Arbitrary<{
  readonly name: CheckName;
  readonly sides: readonly [SolverSide, SolverSide];
  readonly assertionCount: number;
}> {
  return fc
    .constantFrom(...CHECK_NAMES)
    .chain((name) =>
      fc
        .tuple(arbDisagreeingSides(name), fc.integer({ min: 1, max: 64 }))
        .map(([sides, assertionCount]) => ({ name, sides, assertionCount })),
    );
}

/** The run context. Only `depth` is read, and only to keep the generated cover step reachable. */
const RUN: FormalRunContext = Object.freeze({
  depth: 20,
  elapsedMs: 1_234,
  designFileName: 'design.v',
  wrapperFileName: 'wrapper.v',
});

/** A counterexample trace, so the non-vacuity twin can reach `refuted` and not only `proved`. */
const TRACE: ArtifactBlobRef = Object.freeze({
  name: 'formal-trace-base-bitwuzla.vcd',
  sizeBytes: 512,
  sha256: 'd'.repeat(64),
});

/** A run that COMPLETED and was not killed, both of which are weighed ahead of the audit. */
const RESULT: SandboxResult = Object.freeze({
  verdict: 'pass',
  timedOut: false,
  exitCode: 0,
  stdout: '',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  diskLimitExceeded: false,
  artifacts: { [COUNTEREXAMPLE_ARTIFACT_KEY]: TRACE },
  deniedOperations: [],
  resourceUsage: { wallMs: 10, maxMemMb: 1, cpuMs: 10 },
});

/** The audit record, shaped as the worker's `_CrossCheck.as_dict` writes it. */
function auditOf(reporter: SolverSide, solver: string): FormalCrossCheckReport {
  return {
    solver,
    exitCode: 0,
    status: reporter.status,
    elapsedMs: 7,
    ...(reporter.inductionSuccessful === undefined
      ? {}
      : { inductionSuccessful: reporter.inductionSuccessful }),
  };
}

/**
 * The chosen check as one side reported it, optionally audited by the other side.
 *
 * REBUILT FIELD BY FIELD rather than spread-and-override, because `status`, the induction line,
 * and the audit are all owned by this file, and the last two are optional fields that
 * `exactOptionalPropertyTypes` will not let an override clear by assigning `undefined`.
 */
function reportedBy(
  check: FormalCheckReport,
  reporter: SolverSide,
  audit: Audit | null,
): FormalCheckReport {
  return {
    exitCode: check.exitCode,
    elapsedMs: check.elapsedMs,
    status: reporter.status,
    ...(check.reachedStep === undefined ? {} : { reachedStep: check.reachedStep }),
    ...(check.coverAnswered === undefined ? {} : { coverAnswered: check.coverAnswered }),
    ...(check.tracePath === undefined ? {} : { tracePath: check.tracePath }),
    ...(reporter.inductionSuccessful === undefined
      ? {}
      : { inductionSuccessful: reporter.inductionSuccessful }),
    ...(audit === null ? {} : { crossCheck: auditOf(audit.side, audit.solver) }),
  };
}

/** The four checks with the chosen one replaced and the other three left as generated. */
function mapChecks(
  checks: FormalChecksReport,
  name: CheckName,
  replace: (check: FormalCheckReport) => FormalCheckReport,
): FormalChecksReport {
  const pick = (key: CheckName): FormalCheckReport =>
    key === name ? replace(checks[key]) : checks[key];
  return {
    presat: pick('presat'),
    base: pick('base'),
    cover: pick('cover'),
    induct: pick('induct'),
  };
}

/**
 * The generated report with one injected check, and the four preconditions forced.
 *
 * A failed lowering, a killed run, an impossible cover step, and a zero assertion count are each
 * weighed AHEAD of the audit, so leaving any of them free would let the property pass on a branch
 * the audit never reached.
 */
function reportWith(report: FormalReport, injection: Injection): FormalReport {
  const replace = (check: FormalCheckReport): FormalCheckReport =>
    reportedBy(check, injection.primary, injection.audit);
  return withCoverStepBelowDepth(
    {
      ...report,
      assertionCount: injection.assertionCount,
      lowering: { ...report.lowering, exitCode: 0 },
      checks: mapChecks(report.checks, injection.name, replace),
    },
    RUN.depth,
  );
}

/** The cause a result carries, or `null` for a result that is not a refusal. */
function causeOf(result: ReturnType<typeof interpretFormalReport>): string | null {
  return result.verdict === 'could-not-verify' ? result.cause : null;
}

/** Whether any check's generated audit already disagrees with the check it audits. */
function anyAuditDisagrees(report: FormalReport): boolean {
  return CHECK_NAMES.map((name) => report.checks[name]).some(
    (check) =>
      check.crossCheck !== undefined &&
      (check.crossCheck.status !== check.status ||
        check.crossCheck.inductionSuccessful !== check.inductionSuccessful),
  );
}

/**
 * Reports whose only disagreement is the one this file injects.
 *
 * `arbFormalReport()` audits a check on about a third of draws and draws the audit's status
 * independently, so roughly two thirds of reports already disagree somewhere. Those are dropped
 * rather than stripped, so the three checks this file does not choose stay exactly as generated
 * and are identical across the two orders. The agreeing and unaudited shapes that remain are what
 * make the INJECTED disagreement the thing the verdict can be attributed to.
 */
function arbSingleDisagreementReport(): fc.Arbitrary<FormalReport> {
  return arbFormalReport().filter((report) => !anyAuditDisagrees(report));
}

// ---------------------------------------------------------------------------
// The persisted-record clauses (Req 11.2, 11.3, 11.7)
// ---------------------------------------------------------------------------

/** A toolchain stub: this property reads no version, so the fields only have to be present. */
const TOOLCHAIN: ManifestToolchain = {
  iverilogVersion: '13.0',
  vvpVersion: '13.0',
  workerPython: null,
  yosysVersion: { kind: 'read', value: '0.69+post' },
  yosysBuildId: { kind: 'read', value: 'f'.repeat(40) },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'answers --version with usage' },
  bitwuzlaVersion: { kind: 'read', value: '0.9.1' },
  z3Version: { kind: 'read', value: '4.15.4' },
};

/** The five Proof_Conditions by name, for a draw that removes exactly one of them. */
const CONDITION_FIELDS = ['assertionCount', 'presat', 'cover', 'base', 'induction'] as const;

/** Every verdict that is not a refusal, derived so a fourth verdict would be covered too. */
const DECIDED_VERDICTS = FORMAL_VERDICTS.filter((verdict) => verdict !== 'could-not-verify');

/** The measured arm of an outcome, which is the only arm a verdict can sit on. */
type MeasuredOutcome = Extract<PropertyOnlyOutcome, { readonly kind: 'measured' }>;

/**
 * Proof_Conditions a persisted record can actually carry.
 *
 * `arbProofConditions()` draws `-1`, `0.5`, `NaN`, and `Infinity` counts on purpose, to exercise
 * the gate's own guard, but the worker's report schema bounds the count to a non-negative integer
 * so none of them reaches a record. The filter removes unreachable records, not malformed ones.
 */
function arbPersistableConditions(): fc.Arbitrary<ProofConditions> {
  return arbProofConditions().filter(
    ({ assertionCount }) => Number.isInteger(assertionCount) && assertionCount >= 0,
  );
}

/** A measured outcome whose cause and disagreement flag match its verdict's arm. */
function arbMeasuredOutcome(): fc.Arbitrary<MeasuredOutcome> {
  return fc
    .tuple(
      fc.constantFrom(...FORMAL_VERDICTS),
      fc.constantFrom(...COULD_NOT_VERIFY_CAUSES),
      fc.boolean(),
      arbPersistableConditions(),
    )
    .map(([verdict, cause, disagreed, conditions]): MeasuredOutcome =>
      verdict === 'could-not-verify'
        ? {
            kind: 'measured',
            verdict,
            couldNotVerifyCause: cause,
            crossCheckDisagreed: disagreed,
            conditions,
          }
        : {
            kind: 'measured',
            verdict,
            couldNotVerifyCause: null,
            crossCheckDisagreed: false,
            conditions,
          },
    );
}

/** A copy of one object without one key, as the persisted text would hold it. */
function without(source: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  delete copy[key];
  return copy;
}

/** The persisted file around one outcome, which is the only part this property varies. */
function fileHolding(outcome: unknown): string {
  return JSON.stringify({
    schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
    runName: 'property-only-v1',
    measurementKind: PROPERTY_ONLY_MEASUREMENT_KIND,
    omittedStudentPathSteps: [],
    results: [
      {
        designId: 'rtllm/arithmetic/adder_8bit',
        authoringModel: 'zai.glm-5',
        population: 'admitted',
        prepassRefusalCause: null,
        properties: [{ propertyId: 'p1', outcome }],
        unexpressedCriteria: [],
        promptTokens: 0,
        completionTokens: 0,
        elapsedMs: 0,
        toolchain: TOOLCHAIN,
        formalOracleVersion: 2,
      },
    ],
    limits: [],
  });
}

/** The one outcome a decoded file holds, or `null` where the file was refused. */
function decodedOutcome(file: string): PropertyOnlyOutcome | null {
  return decodePropertyOnlyMeasurement(file)?.results[0]?.properties[0]?.outcome ?? null;
}

describe(PROPERTY, () => {
  it('resolves a Solver_Cross_Check disagreement to could-not-verify in either order', () => {
    let movedTheVerdict = 0;
    let lineOnlyDisagreements = 0;
    let exemptCoverCases = 0;

    fc.assert(
      fc.property(
        arbSingleDisagreementReport(),
        arbFormalProperty(),
        arbDisagreement(),
        (report, property, { name, sides, assertionCount }) => {
          const [left, right] = sides;
          const shared = { name, assertionCount };
          const forward = reportWith(report, {
            ...shared,
            primary: left,
            audit: { side: right, solver: SOLVERS[1] },
          });
          const mirrored = reportWith(report, {
            ...shared,
            primary: right,
            audit: { side: left, solver: SOLVERS[0] },
          });
          const twin = reportWith(report, { ...shared, primary: left, audit: null });

          const first = interpretFormalReport(RESULT, forward, property, RUN);
          const second = interpretFormalReport(RESULT, mirrored, property, RUN);
          const unaffected = interpretFormalReport(RESULT, twin, property, RUN);

          if (left.status === right.status) {
            lineOnlyDisagreements += 1;
          }
          if (unaffected.verdict !== 'could-not-verify') {
            movedTheVerdict += 1;
          }

          // A COVER disagreement on a run whose Base_Check failed is not a disagreement at all:
          // cover mode's `Status:` reports FAILED both for an unreached cover and for an assertion
          // failing on the covering path, and only the second is possible once the base failed.
          // The claim there is STRONGER than could-not-verify - the audit must not be consulted,
          // so the verdict must equal the same report carrying no audit.
          if (name === 'cover' && forward.checks.base.status === 'FAILED') {
            exemptCoverCases += 1;
            expect(first.verdict).toBe(unaffected.verdict);
            expect(second.verdict).toBe(unaffected.verdict);
            return;
          }

          expect(first.verdict).toBe('could-not-verify');
          expect(second.verdict).toBe('could-not-verify');
          expect(causeOf(second)).toBe(causeOf(first));
        },
      ),
      propertyParameters({ numRuns: CROSS_CHECK_NUM_RUNS }),
    );

    expect(movedTheVerdict).toBeGreaterThan(0);
    expect(lineOnlyDisagreements).toBeGreaterThan(0);
    // Non-vacuity on the exemption itself: if no exempt case was drawn, the branch above asserted
    // nothing and this property would silently stop covering the case the fix turns on.
    expect(exemptCoverCases).toBeGreaterThan(0);
  });

  it('drops a verdict smuggled onto a Not_Measured outcome rather than reading it as one', () => {
    fc.assert(
      fc.property(arbMeasuredOutcome(), fc.string({ minLength: 1 }), (measured, reason) => {
        const outcome = decodedOutcome(fileHolding({ ...measured, kind: 'not-measured', reason }));

        expect(outcome).not.toBeNull();
        expect(outcome === null ? [] : Object.keys(outcome).sort()).toEqual(['kind', 'reason']);
      }),
      propertyParameters(),
    );
  });

  it('refuses a measured verdict whose Proof_Conditions are absent or short one condition', () => {
    fc.assert(
      fc.property(
        arbMeasuredOutcome(),
        fc.constantFrom<'whole' | (typeof CONDITION_FIELDS)[number]>('whole', ...CONDITION_FIELDS),
        (measured, removed) => {
          const broken =
            removed === 'whole'
              ? without(measured, 'conditions')
              : { ...measured, conditions: without(measured.conditions, removed) };

          expect(decodePropertyOnlyMeasurement(fileHolding(broken))).toBeNull();
          // The positive control, so the refusal above is about the condition and not the frame.
          expect(decodedOutcome(fileHolding(measured))).not.toBeNull();
        },
      ),
      propertyParameters(),
    );
  });

  it('refuses a cross-check disagreement recorded on anything but could-not-verify', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DECIDED_VERDICTS),
        fc.constantFrom(...COULD_NOT_VERIFY_CAUSES),
        arbPersistableConditions(),
        (verdict, couldNotVerifyCause, conditions) => {
          const preferred = {
            kind: 'measured',
            verdict,
            couldNotVerifyCause: null,
            crossCheckDisagreed: true,
            conditions,
          };
          const refusal = {
            kind: 'measured',
            verdict: 'could-not-verify',
            couldNotVerifyCause,
            crossCheckDisagreed: true,
            conditions,
          };

          expect(decodePropertyOnlyMeasurement(fileHolding(preferred))).toBeNull();
          // `toEqual` and not `toStrictEqual`: `arbProofConditions()` is an `fc.record`, whose
          // objects carry a null prototype the decoded plain object cannot strictly equal.
          expect(decodedOutcome(fileHolding(refusal))).toEqual(refusal);
        },
      ),
      propertyParameters(),
    );
  });
});
