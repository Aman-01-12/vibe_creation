// formal-property-oracle, Property 8: the Proof_Depth ladder is deterministic, clears a known reached
// step, climbs monotonically to a bound, and never climbs on an incomplete induction (task 6.6).
//
// WHAT IS CLAIMED, OVER WHAT
//   The REAL `YosysSmtBmcFormalOracle` is driven through a scripted `ToolRunner` double, over
//   generated prove requests - a generated design interface, a generated Formal_Property, and a
//   generated Property_Time_Budget that includes values no budget should be (zero, negative, NaN,
//   infinite, fractional, and past `Number.MAX_SAFE_INTEGER`) - and over a generated report for every
//   rung. The double answers each `formal` job in submission order and records the depth it was
//   submitted at, so what is observed is the depth the adapter actually chose. Five clauses, one per
//   clause of design.md's Property 8:
//     1. DETERMINISTIC (Req 4.5). `proofDepthsFor` returns the same ladder for a structurally
//        identical clone of its inputs, and ONE adapter asked a clone of the same request a second
//        time submits the same depth sequence and records the same depth.
//     2. A KNOWN FIRST-REACHED STEP IS CLEARED (Req 4.6). Where the double's cover is FAITHFUL, a
//        result that records the cover reached at step S records a Proof_Depth above S.
//     3. AN UNREACHED COVER CLIMBS (Req 4.7). A rung classified `antecedent-unreached` is followed by
//        the next rung whenever one remains and the budget is unspent, and a rung whose cover WAS
//        reached ends the climb, which is 4.7's "until the antecedent is reached".
//     4. MONOTONIC TO A BOUND, UNDER ANY BUDGET (Req 4.7). The submitted depths are a prefix of one of
//        the two fixed ladders and strictly increasing, no rung is entered once the budget is spent,
//        and the call returns. The double refuses a proof job past the longest fixed ladder, so a
//        climb that never ends fails here rather than hanging.
//     5. NO CLIMB ON AN INCOMPLETE INDUCTION (Req 4.13). A rung whose base case PASSED while its
//        induction check FAILED, classified `induction-engine-incomplete`, is the LAST rung
//        submitted: a deeper bounded check cannot repair an inductive step the engine is incomplete
//        on, so climbing there would spend the budget on work that cannot help.
//
// WHERE THE EXPECTATIONS COME FROM, AND WHAT IS NOT RE-IMPLEMENTED HERE
//   The ladder is the exported constant, the rule that picks between its two forms is driven as the
//   pure function it is exported as, and the climb itself is never re-coded: every clause above is a
//   LOCAL rule about one rung and the rung after it, checked against what the adapter submitted.
//   Each rung's classification comes from its single owner, `interpretFormalReport`, over exactly
//   the evidence the double served for that rung, so the rule is checked against the same answer
//   the adapter read and no part of the five-condition order is re-spelled. "The budget is spent" is
//   read off the double's own clock, which moves only while a job runs: the time charged since the
//   call began - the pre-pass plus every rung so far - has reached the budget.
//
// TWO ARMS, BECAUSE ONE GENERATOR CANNOT BE BOTH FREE AND FAITHFUL
//   - FAITHFUL (three quarters). The property carries an antecedent, and the double answers the
//     cover the way `yosys-smtbmc -c -t N` does: an antecedent first reachable at a generated step S
//     is REACHED at every depth above S and unreached at every depth at or below it. MEASURED,
//     `counter_12`'s `out == 11` is reached at step 13 and unreached at every depth below 14. Every
//     condition the fixed order weighs ahead of the cover is HELD on this arm, so an unreached cover
//     is the deciding condition wherever it occurs - a self-check below confirms it against the
//     owner - and the base case and the induction check are redrawn near the gate, so the clearing
//     rung lands on each outcome those two decide, `induction-engine-incomplete` among them. This
//     arm puts the counts behind clauses 2, 3, and 5.
//   - FREE (one quarter). `arbFormalReport()` exactly as drawn, over `arbFormalProperty()`: a failed
//     lowering, a zero count, a disagreeing audit, an unanswered cover, and a cover claiming a step
//     its own bound could not reach are all in this sample, and clauses 1, 3, 4, and 5 hold over
//     every one of them.
//
// TWO WORDINGS IN design.md's PROPERTY 8 THAT ARE NOT ASSERTABLE AS WRITTEN, STATED RATHER THAN
// FUDGED, AND ONE THAT WAS AMENDED SO THAT IT IS
// (`chipAgent/_inbox/gotcha-design-property-text-omits-the-guards-that-pre-empt-it.md`)
//   - "for any report whose cover was NOT reached, escalation to the next ladder rung occurs while a
//     rung remains, whatever its induction check reported" omits every guard the fixed order weighs
//     AHEAD of the cover (Req 1.7): a zero assertion count, an unsatisfiable presat, a disagreeing
//     Solver_Cross_Check, a failed lowering, and a cover that answered NOTHING, which is
//     `toolchain-unavailable` rather than unreached (Req 5.12). It also omits the budget, which Req
//     4.7 names as the climb's other bound. So clause 3 is asserted over the rungs the owner
//     classified `antecedent-unreached`, wherever a rung remains AND the budget is unspent.
//   - AMENDED, AND THIS FILE NOW CARRIES THE PROPERTY TEXT RATHER THAN A NARROWER READING OF IT.
//     The fifth clause now reads "for any report in which EVERY CONDITION AHEAD OF THE INDUCTION
//     CHECK HELD, the base case PASSED, and the induction check FAILED, no escalation occurs at
//     all", and Requirements 4.11 and 4.13 are worded over that same guard - "every Proof_Condition
//     ahead of the Induction_Check in the fixed order Acceptance Criterion 1.7 defines" - as decided
//     at execution question E19. The SUPERSEDED form was unconditional on the cover, and it
//     contradicted Req 4.7 on exactly the report this test measures: the fixed order puts the cover
//     first, so a rung whose cover was unreached is `antecedent-unreached` whatever induction said,
//     and 4.7 then requires the re-run the unguarded 4.13 would have forbidden. One 1000-run sample
//     of this test drew that report 110 times, which is what the amendment was made on. Clause 5 is
//     therefore asserted over the guarded signature as the gate classifies it,
//     `induction-engine-incomplete`, reported only where every condition ahead of the induction step
//     held - no longer a reading this test takes in place of the text, but the text itself. The same
//     amendment closes the identical looseness `formal-induction-and-refutation.property.test.ts`
//     read in Req 4.11, so nothing here is left open against the spec.
//   - "for any known first-reached antecedent step the chosen depth exceeds it" presumes a cover
//     that could actually have reached that step, which is Req 4.6's own premise ("a legitimately
//     reachable cover"). A free-arm document can claim a `reachedStep` at or beyond the depth its own
//     check ran at, so clause 2 is asserted over the faithful arm alone.
//
// RUN COUNTS
//   1000. The rarest required row is a rung classified `induction-engine-incomplete` with a rung
//   left AND the budget unspent - the only shape on which clause 5 could fail at all. On the
//   faithful arm it needs a first reachable step the second rung still clears (~0.3 of draws), a
//   budget that lasts through that rung (~0.66), and the base `PASSED` / induction `FAILED` pair
//   (9/64), which is ~2% of the whole sample; one measured run drew it 26 times in 1000, so a miss
//   is near e^-20 or rarer. The next rarest, the one-rung combinational ladder, drew 33. At the
//   shared 100-run default the rarest row would be ~2 expected and missed about one run in eight,
//   which is a flake rather than a claim
//   (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 4.5, 4.6, 4.7, 4.13**
//
// 4.13 is named here because design.md's Property 8 names it, and because clause 5 asserts it
// directly now that the criterion carries the fixed-order guard. design.md's own traceability
// section still says "neither property's `Validates:` line names either criterion" of 4.10 and
// 4.13, which contradicts the Property 8 heading two thousand lines above it; that sentence is
// design.md's to correct, not this file's.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CLOCKED_DEPTH_LADDER,
  COMBINATIONAL_DEPTH,
  COUNTEREXAMPLE_ARTIFACT_KEY,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  interpretFormalReport,
  parseFormalReport,
  proofDepthsFor,
  PROPERTY_WRAPPER_FILE_NAME,
  YosysSmtBmcFormalOracle,
  type ArtifactBlobRef,
  type CoverCondition,
  type FormalArtifactReader,
  type FormalCheckReport,
  type FormalProperty,
  type FormalProveRequest,
  type FormalReport,
  type FormalResourceCaps,
  type PropertyResult,
  type RequiredOutput,
  type SandboxJob,
  type SandboxResult,
  type ToolRunner,
} from '@app/tools';

import { arbDesignInterface, arbFormalProperty, arbFormalReport } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 8: Depth is deterministic, clears a known reached
// step, escalates monotonically to a bound, and never escalates on an induction failure**
const PROPERTY_8 =
  'formal-property-oracle, Property 8: Depth is deterministic, clears a known reached step, escalates monotonically to a bound, and never escalates on an induction failure';

/** See the RUN COUNTS note: the rarest required row is ~2% of this sample. */
const NUM_RUNS = 1000;

/**
 * Headroom, not a workaround: 1000 runs measured 0.32s here, well inside vitest's 5s default, and
 * the explicit bound only keeps a contended full-suite run from reading as a failure.
 */
const SLOW_PROPERTY_TIMEOUT_MS = 30_000;

/** The four caps every job carries. Not under test here, so any valid set serves. */
const CAPS: FormalResourceCaps = { cpu: 1, memMb: 512, procs: 64, diskMb: 64 };

/** The two fixed ladders, built from the exported constants and from nothing else (Req 4.5). */
const FIXED_LADDERS: readonly (readonly number[])[] = [CLOCKED_DEPTH_LADDER, [COMBINATIONAL_DEPTH]];

/** The longest fixed ladder's length: the most proof jobs one call may ever submit. */
const MAX_RUNGS = Math.max(...FIXED_LADDERS.map((ladder) => ladder.length));

/** The clocked ladder's top rung. */
const TOP_RUNG = Math.max(...CLOCKED_DEPTH_LADDER);

/**
 * The deepest first reachable step drawn: twice the top rung, so a step NO rung clears is drawn
 * about as often as one some rung does.
 */
const STEP_CEILING = 2 * TOP_RUNG;

/**
 * The ceiling of a TIGHT budget, in milliseconds: about one full climb's worth of scripted cost, so a
 * tight budget runs out before the first rung, between rungs, and not at all, each a real share.
 */
const TIGHT_BUDGET_CEILING_MS = 1_500;

/** Budgets that admit every climb: the shipped default, and the largest safe integer. */
const GENEROUS_BUDGETS_MS: readonly number[] = [
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  Number.MAX_SAFE_INTEGER,
];

/**
 * Budgets no run should be given: zero, negative, fractional, not a number, infinite, and past the
 * safe-integer range (`MAX_SAFE_INTEGER + 2` rounds to 2^53). Each must still end a climb.
 */
const UNUSABLE_BUDGETS_MS: readonly number[] = [
  0,
  -1,
  -DEFAULT_PROPERTY_TIME_BUDGET_MS,
  0.5,
  DEFAULT_PROPERTY_TIME_BUDGET_MS + 0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
];

/** The most one scripted pre-pass charges, in milliseconds. */
const MAX_PREPASS_COST_MS = 300;

/** The most one scripted rung charges, in milliseconds. */
const MAX_RUNG_COST_MS = 500;

/** The fewest assertions a faithful-arm report counts: one, so the count guard always holds. */
const MIN_ASSERTIONS = 1;

/** The keys the worker registers its two reports under: the seam's own required-output names. */
const PREPASS_REPORT_KEY: RequiredOutput = 'formalPrepassReport';
const FORMAL_REPORT_KEY: RequiredOutput = 'formalReport';

/** Hex characters in a SHA-256 digest. */
const SHA256_HEX_CHARS = 64;

/** A well-formed digest for every scripted artifact. The reader resolves refs by NAME. */
const SCRIPTED_DIGEST = '0'.repeat(SHA256_HEX_CHARS);

/** The workspace-relative name every candidate design is submitted under. */
const DESIGN_FILE_NAME = 'design.v';

/** The pre-pass's answer on every call: a DERIVED async reset on a posedge design, so rungs run. */
const DERIVED_PREPASS_TEXT = JSON.stringify({
  reset: { derived: true, resetName: 'rst_n', resetActiveLow: true, resetKind: 'async' },
  clockPolarity: 'posedge',
  initialStatePredicate: 'true',
});

const PREPASS_REPORT: ArtifactBlobRef = {
  name: 'formal-prepass-report.json',
  sizeBytes: DERIVED_PREPASS_TEXT.length,
  sha256: SCRIPTED_DIGEST,
};

/** The base case's trace, registered where a rung's script says a counterexample was written. */
const BASE_TRACE: ArtifactBlobRef = {
  name: 'trace_base.vcd',
  sizeBytes: 0,
  sha256: SCRIPTED_DIGEST,
};

/**
 * How the double answers the Cover_Check.
 *
 * `faithful` derives the answer from the depth the rung was SUBMITTED at, which is what makes the
 * clearing claim a claim about the adapter's choice rather than about a canned answer;
 * `firstReachableStep` is `null` for an antecedent no depth reaches. `as-generated` serves the
 * drawn report untouched, whatever its cover says.
 */
type CoverModel =
  | { readonly model: 'faithful'; readonly firstReachableStep: number | null }
  | { readonly model: 'as-generated' };

/** Which kind of budget was drawn. A label for the non-vacuity tally, never for an expectation. */
type BudgetKind = 'tight' | 'generous' | 'unusable';

/** What the double answers for one rung, whatever depth it is submitted at. */
interface RungScript {
  /** The rung's report. On the faithful arm its cover is replaced at serve time. */
  readonly report: FormalReport;
  /** Whether the run registered a base-case counterexample trace. */
  readonly counterexample: boolean;
  /** The milliseconds this invocation charges to the budget. */
  readonly costMs: number;
}

/** One generated prove call and everything the double will answer it with. */
interface LadderScenario {
  readonly request: FormalProveRequest;
  readonly budgetKind: BudgetKind;
  readonly cover: CoverModel;
  readonly prepassCostMs: number;
  /** One script per rung of the longest fixed ladder, served in submission order. */
  readonly rungs: readonly RungScript[];
}

/** One `formal` job the adapter submitted: its depth, what the double answered, and the charge. */
interface ServedRung {
  readonly depth: number;
  readonly report: FormalReport;
  readonly result: SandboxResult;
  readonly costMs: number;
  /** Milliseconds charged since the call began, before this rung ran. */
  readonly chargedBeforeMs: number;
  /** Milliseconds charged since the call began, once this rung had run. */
  readonly chargedAfterMs: number;
}

/** A generated request, with the label of the budget it carries. */
interface DrawnRequest {
  readonly request: FormalProveRequest;
  readonly budgetKind: BudgetKind;
}

/** The three fields the faithful arm redraws near the gate. */
interface DecisiveFields {
  readonly base: string | null;
  readonly induct: string | null;
  readonly inductionSuccessful: boolean;
}

/** The facts about one served rung that the climb's rule is stated over. */
interface RungFacts {
  readonly cause: string | null;
  readonly cover: CoverCondition;
  /** Whether the adapter submitted another rung after this one. */
  readonly climbed: boolean;
  /** Whether the ladder holds another rung after this one. */
  readonly rungRemains: boolean;
  /** Whether the time charged once this rung had run was still below the budget. */
  readonly budgetUnspent: boolean;
}

/** The non-vacuity rows. Every one must be drawn, because each is a shape a clause could fail on. */
const TALLY_ROWS = [
  // Clause 3: an unreached rung followed by the next one.
  'climbedOnAnUnreachedCover',
  // Clause 5 on the only shape it could fail on: a rung left and the budget unspent.
  'stoppedOnEngineIncompleteWithRoomToClimb',
  // Clause 4's bound: the BUDGET, not the ladder, ended a climb that still wanted a rung.
  'budgetSpentMidLadder',
  // Clause 4's other bound: every rung of a multi-rung ladder was submitted.
  'climbedTheWholeLadder',
  // Clause 2 where clearing the step took a climb past the first rung.
  'clearedAStepTheFirstRungDidNot',
  // Clause 4's "drawn from the fixed ladder", on the other fixed ladder.
  'ranTheCombinationalLadder',
  // Clause 4's "under any budget", on the budgets no run should be given.
  'drewAnUnusableBudget',
] as const;

type TallyRow = (typeof TALLY_ROWS)[number];

/** How often each row was drawn. A row never drawn is absent, and reads as zero. */
type Tally = Map<TallyRow, number>;

/** Count one draw of `row` when `drawn` holds. */
function tallyIf(tally: Tally, row: TallyRow, drawn: boolean): void {
  if (drawn) {
    tally.set(row, (tally.get(row) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A `Status:` string weighted toward the two measured verdicts, so each deciding pair is drawn. */
function nearGateStatusArbitrary(): fc.Arbitrary<string | null> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant<string | null>('PASSED') },
    { weight: 3, arbitrary: fc.constant<string | null>('FAILED') },
    { weight: 1, arbitrary: fc.constant<string | null>('PREUNSAT') },
    { weight: 1, arbitrary: fc.constant<string | null>(null) },
  );
}

/**
 * A generated report with every condition the fixed order weighs AHEAD of the cover held: a
 * completed lowering, at least one assertion, a satisfiable presat, and no Solver_Cross_Check that
 * could disagree. The base case and the induction check carry the redrawn `decisive` fields, which
 * only ever decide a rung whose cover was reached.
 */
function withEarlierConditionsHeld(report: FormalReport, decisive: DecisiveFields): FormalReport {
  const { presat, base, cover, induct } = report.checks;
  return {
    lowering: { ...report.lowering, exitCode: 0 },
    assertionCount: Math.max(MIN_ASSERTIONS, report.assertionCount),
    checks: {
      presat: { exitCode: 0, status: 'PASSED', elapsedMs: presat.elapsedMs },
      base: { exitCode: base.exitCode, status: decisive.base, elapsedMs: base.elapsedMs },
      // Replaced at serve time by the faithful answer for the depth the rung was submitted at.
      cover: { exitCode: cover.exitCode, status: cover.status, elapsedMs: cover.elapsedMs },
      induct: {
        exitCode: induct.exitCode,
        status: decisive.induct,
        elapsedMs: induct.elapsedMs,
        inductionSuccessful: decisive.inductionSuccessful,
      },
    },
  };
}

/** The milliseconds one rung charges. Zero included: a rung that costs nothing still climbs. */
function rungCostArbitrary(): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: MAX_RUNG_COST_MS });
}

/** The milliseconds the one pre-pass charges. */
function prepassCostArbitrary(): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: MAX_PREPASS_COST_MS });
}

/** A faithful-arm rung: the earlier conditions held, the deciding ones redrawn near the gate. */
function faithfulRungArbitrary(): fc.Arbitrary<RungScript> {
  return fc
    .tuple(
      arbFormalReport(),
      nearGateStatusArbitrary(),
      nearGateStatusArbitrary(),
      fc.boolean(),
      fc.boolean(),
      rungCostArbitrary(),
    )
    .map(([report, base, induct, inductionSuccessful, counterexample, costMs]): RungScript => ({
      report: withEarlierConditionsHeld(report, { base, induct, inductionSuccessful }),
      counterexample,
      costMs,
    }));
}

/** A free-arm rung: `arbFormalReport()` exactly as drawn. */
function freeRungArbitrary(): fc.Arbitrary<RungScript> {
  return fc.record<RungScript>({
    report: arbFormalReport(),
    counterexample: fc.boolean(),
    costMs: rungCostArbitrary(),
  });
}

/** A Property_Time_Budget, labelled with the kind it was drawn from. */
function budgetArbitrary(): fc.Arbitrary<{ readonly kind: BudgetKind; readonly budgetMs: number }> {
  const labelled =
    (kind: BudgetKind) =>
    (budgetMs: number): { readonly kind: BudgetKind; readonly budgetMs: number } => ({
      kind,
      budgetMs,
    });
  return fc.oneof(
    {
      weight: 5,
      arbitrary: fc.integer({ min: 1, max: TIGHT_BUDGET_CEILING_MS }).map(labelled('tight')),
    },
    { weight: 2, arbitrary: fc.constantFrom(...GENEROUS_BUDGETS_MS).map(labelled('generous')) },
    { weight: 1, arbitrary: fc.constantFrom(...UNUSABLE_BUDGETS_MS).map(labelled('unusable')) },
  );
}

/** One prove request over a generated design interface, property, and budget. */
function proveRequestArbitrary(property: fc.Arbitrary<FormalProperty>): fc.Arbitrary<DrawnRequest> {
  return fc
    .tuple(arbDesignInterface(), property, budgetArbitrary())
    .map(([designInterface, drawnProperty, budget]): DrawnRequest => ({
      request: {
        designSource: {
          path: DESIGN_FILE_NAME,
          contents: `module ${designInterface.moduleName}; endmodule\n`,
        },
        designInterface,
        property: drawnProperty,
        budgetMs: budget.budgetMs,
      },
      budgetKind: budget.kind,
    }));
}

/** A clocked property WITH an antecedent: the only kind a Cover_Check applies to (Req 5.10). */
function propertyWithAntecedentArbitrary(): fc.Arbitrary<FormalProperty> {
  return arbFormalProperty().filter(
    (property) => property.kind === 'clocked' && property.antecedent !== null,
  );
}

/**
 * The step an antecedent is first reachable at, or `null` for one no depth reaches.
 *
 * Both sides of every rung are drawn on purpose: `rung - 1` is the deepest step that rung still
 * clears, and `rung` itself is the shallowest it does not, because a cover is reached only at a
 * depth EXCEEDING the step.
 */
function firstReachableStepArbitrary(): fc.Arbitrary<number | null> {
  const rungBoundaries = CLOCKED_DEPTH_LADDER.flatMap((rung) => [rung - 1, rung]);
  return fc.oneof(
    { weight: 2, arbitrary: fc.constantFrom<number | null>(...rungBoundaries) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: STEP_CEILING }) },
    { weight: 1, arbitrary: fc.constant<number | null>(null) },
  );
}

/** The faithful arm: an antecedent, a faithful cover, and the earlier conditions held. */
function faithfulScenarioArbitrary(): fc.Arbitrary<LadderScenario> {
  return fc
    .tuple(
      proveRequestArbitrary(propertyWithAntecedentArbitrary()),
      firstReachableStepArbitrary(),
      prepassCostArbitrary(),
      fc.array(faithfulRungArbitrary(), { minLength: MAX_RUNGS, maxLength: MAX_RUNGS }),
    )
    .map(([drawn, firstReachableStep, prepassCostMs, rungs]): LadderScenario => ({
      ...drawn,
      cover: { model: 'faithful', firstReachableStep },
      prepassCostMs,
      rungs,
    }));
}

/** The free arm: any property, and every rung's report exactly as `arbFormalReport()` drew it. */
function freeScenarioArbitrary(): fc.Arbitrary<LadderScenario> {
  return fc
    .tuple(
      proveRequestArbitrary(arbFormalProperty()),
      prepassCostArbitrary(),
      fc.array(freeRungArbitrary(), { minLength: MAX_RUNGS, maxLength: MAX_RUNGS }),
    )
    .map(([drawn, prepassCostMs, rungs]): LadderScenario => ({
      ...drawn,
      cover: { model: 'as-generated' },
      prepassCostMs,
      rungs,
    }));
}

/** Both arms. See the header for why the faithful one carries the weight. */
function ladderScenarioArbitrary(): fc.Arbitrary<LadderScenario> {
  return fc.oneof(
    { weight: 3, arbitrary: faithfulScenarioArbitrary() },
    { weight: 1, arbitrary: freeScenarioArbitrary() },
  );
}

// ---------------------------------------------------------------------------
// The scripted double
// ---------------------------------------------------------------------------

/**
 * The Cover_Check `yosys-smtbmc -c -t <depth>` reports for an antecedent first reachable at a step.
 *
 * Reached exactly where the depth EXCEEDS the step: measured, `counter_12`'s `out == 11` is reached
 * at step 13 and unreached at every depth below 14. Both answers print a cover line, so both are
 * ANSWERED (Req 5.12), and both carry `Status: FAILED` - the measured `-c` mode string for an
 * unreached cover, which a reached step must override because the condition is read from the step
 * and never from the status (Req 5.11).
 */
function faithfulCover(
  elapsedMs: number,
  firstReachableStep: number | null,
  depth: number,
): FormalCheckReport {
  const unreached: FormalCheckReport = {
    exitCode: 1,
    status: 'FAILED',
    elapsedMs,
    coverAnswered: true,
  };
  return firstReachableStep !== null && firstReachableStep < depth
    ? { ...unreached, reachedStep: firstReachableStep }
    : unreached;
}

/** The report one rung serves at the depth it was submitted at. */
function reportServedAt(cover: CoverModel, report: FormalReport, depth: number): FormalReport {
  if (cover.model === 'as-generated') {
    return report;
  }
  return {
    ...report,
    checks: {
      ...report.checks,
      cover: faithfulCover(report.checks.cover.elapsedMs, cover.firstReachableStep, depth),
    },
  };
}

/** A run that completed inside its cap and registered `artifacts`. Only the artifacts are read. */
function completedRun(
  artifacts: Readonly<Record<string, ArtifactBlobRef>>,
  wallMs: number,
): SandboxResult {
  return {
    verdict: 'pass',
    timedOut: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts,
    deniedOperations: [],
    resourceUsage: { wallMs, maxMemMb: 1, cpuMs: wallMs },
  };
}

/**
 * The Tool_Runner AND the artifact reader the adapter is given, answering from one scenario.
 *
 * Every `formal` job is answered by the next rung's script in SUBMISSION order and recorded with
 * the depth it was submitted at, so the depths read back are the adapter's choices. The clock is
 * the double's own and moves only inside a job, by that job's scripted cost, which is what makes
 * "the budget is spent" a fact this file can read rather than a computation it would re-implement.
 * A proof job past the longest fixed ladder has no script and is refused by THROWING, so a climb
 * that never ends fails the property instead of hanging it.
 */
class ScriptedLadderRunner implements ToolRunner, FormalArtifactReader {
  readonly #scenario: LadderScenario;
  readonly #texts = new Map<string, string>([[PREPASS_REPORT.name, DERIVED_PREPASS_TEXT]]);
  #clockMs = 0;
  #chargedMs = 0;
  #served: ServedRung[] = [];

  constructor(scenario: LadderScenario) {
    this.#scenario = scenario;
  }

  /** The injected clock. It moves only while a job runs, and by exactly that job's cost. */
  readonly now = (): number => this.#clockMs;

  /** Every rung served since the last `beginCall`, in submission order. */
  get served(): readonly ServedRung[] {
    return this.#served;
  }

  /** Re-arm the script for one more call: nothing served and nothing charged. The clock runs on. */
  beginCall(): void {
    this.#served = [];
    this.#chargedMs = 0;
  }

  run(job: SandboxJob): Promise<SandboxResult> {
    return Promise.resolve(job.kind === 'formalPrepass' ? this.#prepass() : this.#rung(job));
  }

  readText(artifact: ArtifactBlobRef): Promise<string | null> {
    return Promise.resolve(this.#texts.get(artifact.name) ?? null);
  }

  #prepass(): SandboxResult {
    this.#charge(this.#scenario.prepassCostMs);
    return completedRun({ [PREPASS_REPORT_KEY]: PREPASS_REPORT }, this.#scenario.prepassCostMs);
  }

  #rung(job: SandboxJob): SandboxResult {
    const index = this.#served.length;
    const script = this.#scenario.rungs[index];
    const depth = job.formal?.depth;
    if (script === undefined || depth === undefined) {
      throw new Error(
        `proof job ${index + 1} has no script: a climb past the longest fixed ladder`,
      );
    }
    const report = reportServedAt(this.#scenario.cover, script.report, depth);
    const registered = this.#register(`formal-report-rung-${index}.json`, report);
    const result = completedRun(
      script.counterexample
        ? { [FORMAL_REPORT_KEY]: registered, [COUNTEREXAMPLE_ARTIFACT_KEY]: BASE_TRACE }
        : { [FORMAL_REPORT_KEY]: registered },
      script.costMs,
    );
    const chargedBeforeMs = this.#chargedMs;
    this.#charge(script.costMs);
    this.#served.push({
      depth,
      report,
      result,
      costMs: script.costMs,
      chargedBeforeMs,
      chargedAfterMs: this.#chargedMs,
    });
    return result;
  }

  /**
   * Register one report's text under its own name, refused loudly where the adapter's validating
   * parse would reject it: the adapter would then read NO report while the owner below classified
   * this one, and the two would be describing different rungs.
   */
  #register(name: string, report: FormalReport): ArtifactBlobRef {
    const text = JSON.stringify(report);
    if (!parseFormalReport(text).ok) {
      throw new Error(`scripted report ${name} fails the report schema; the generator is wrong`);
    }
    this.#texts.set(name, text);
    return { name, sizeBytes: text.length, sha256: SCRIPTED_DIGEST };
  }

  #charge(ms: number): void {
    this.#clockMs += ms;
    this.#chargedMs += ms;
  }
}

// ---------------------------------------------------------------------------
// Reading a rung and a result
// ---------------------------------------------------------------------------

/** The cause a `could-not-verify` carries, or `null` for any other verdict. */
function causeOf(result: PropertyResult): string | null {
  return result.verdict === 'could-not-verify' ? result.cause : null;
}

/** The Cover_Check condition a result recorded, whichever member it is. */
function recordedCover(result: PropertyResult): CoverCondition {
  return result.verdict === 'proved' ? result.evidence.cover : result.conditions.cover;
}

/** One served rung, classified by its single owner over exactly the evidence the double served. */
function classifiedRung(scenario: LadderScenario, rung: ServedRung): PropertyResult {
  return interpretFormalReport(rung.result, rung.report, scenario.request.property, {
    depth: rung.depth,
    elapsedMs: rung.costMs,
    designFileName: scenario.request.designSource.path,
    wrapperFileName: PROPERTY_WRAPPER_FILE_NAME,
  });
}

/** The facts the climb's rule is stated over, for the served rung at `index`. */
function rungFacts(
  scenario: LadderScenario,
  ladder: readonly number[],
  served: readonly ServedRung[],
  index: number,
): RungFacts {
  const rung = served[index];
  if (rung === undefined) {
    throw new Error(`no served rung at ${index}`);
  }
  const result = classifiedRung(scenario, rung);
  return {
    cause: causeOf(result),
    cover: recordedCover(result),
    climbed: served.length > index + 1,
    rungRemains: index + 1 < ladder.length,
    budgetUnspent: rung.chargedAfterMs < scenario.request.budgetMs,
  };
}

/** Whether every value is greater than the one before it. */
function strictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
}

// ---------------------------------------------------------------------------
// The clauses
// ---------------------------------------------------------------------------

/**
 * Clause 1's pure half, and clause 4's "drawn from the fixed ladder" (Req 4.5): the rule, driven as
 * the pure function it is exported as. Returns the ladder the request was given.
 */
function assertTheLadderIsFixedAndDeterministic(request: FormalProveRequest): readonly number[] {
  const ladder = proofDepthsFor(request.designInterface, request.property);
  // The same ladder for inputs EQUAL in value that share no reference with these, so the rule
  // reads their contents and not their identity, a clock, a random source, or state of its own.
  expect(
    proofDepthsFor(structuredClone(request.designInterface), structuredClone(request.property)),
    'the ladder chosen for a structurally identical clone of the request',
  ).toEqual(ladder);
  // One of the two fixed ladders - the exported constants - and never a ladder built per request.
  expect(FIXED_LADDERS, 'the ladder is one of the two fixed ladders').toContainEqual(ladder);
  return ladder;
}

/** Clause 4 (Req 4.7): a prefix of the ladder, strictly increasing, and bounded by the budget. */
function assertTheClimbIsMonotonicAndBounded(
  scenario: LadderScenario,
  ladder: readonly number[],
  served: readonly ServedRung[],
): void {
  const depths = served.map((rung) => rung.depth);
  // From the FIRST rung, in ladder order, and never longer than the ladder.
  expect(depths, 'the submitted depths are a prefix of the ladder').toEqual(
    ladder.slice(0, depths.length),
  );
  expect(strictlyIncreasing(depths), 'the submitted depths strictly increase').toBe(true);
  for (const rung of served) {
    // Entered only while the budget was unspent, so a `NaN` budget admits no rung at all.
    expect(rung.chargedBeforeMs, 'a rung entered once the budget was spent').toBeLessThan(
      scenario.request.budgetMs,
    );
  }
}

/** Clauses 3 and 5, stated over one served rung and whether the adapter climbed past it. */
function assertTheRungRule(scenario: LadderScenario, facts: RungFacts): void {
  if (scenario.cover.model === 'faithful' && facts.cover.reached === false) {
    // The faithful arm's own self-check: with every earlier condition held, an unreached cover is
    // the deciding condition, so the arm measures the clause it exists for.
    expect(facts.cause, 'faithful-arm self-check: an unreached cover decides the rung').toBe(
      'antecedent-unreached',
    );
  }
  if (facts.cause === 'antecedent-unreached' && facts.rungRemains && facts.budgetUnspent) {
    // Clause 3 (Req 4.7): an unreached cover raises the depth and re-runs.
    expect(facts.climbed, 'an unreached rung with a rung left and budget unspent').toBe(true);
  }
  if (facts.cause === 'induction-engine-incomplete') {
    // Clause 5 (Req 4.13): an incomplete inductive step is never climbed past.
    expect(facts.climbed, 'a rung classified induction-engine-incomplete').toBe(false);
  }
  if (facts.cover.reached === true) {
    // Req 4.7's "until the antecedent is reached": a reached cover ends the climb.
    expect(facts.climbed, 'a rung whose cover was reached').toBe(false);
  }
}

/** Every served rung under the rule, and the rows each one draws. */
function assertTheEscalationRule(
  scenario: LadderScenario,
  ladder: readonly number[],
  served: readonly ServedRung[],
  tally: Tally,
): void {
  for (const index of served.keys()) {
    const facts = rungFacts(scenario, ladder, served, index);
    assertTheRungRule(scenario, facts);
    const unreached = facts.cause === 'antecedent-unreached';
    tallyIf(tally, 'climbedOnAnUnreachedCover', unreached && facts.climbed);
    tallyIf(
      tally,
      'stoppedOnEngineIncompleteWithRoomToClimb',
      facts.cause === 'induction-engine-incomplete' && facts.rungRemains && facts.budgetUnspent,
    );
    tallyIf(
      tally,
      'budgetSpentMidLadder',
      unreached && !facts.climbed && facts.rungRemains && !facts.budgetUnspent,
    );
  }
}

/**
 * Clause 2 (Req 4.6): the depth the result records is the deepest rung it ran, and a step the cover
 * made known lies below it.
 */
function assertTheChosenDepth(
  scenario: LadderScenario,
  served: readonly ServedRung[],
  result: PropertyResult,
  tally: Tally,
): void {
  const deepest = served.at(-1);
  if (deepest === undefined) {
    return;
  }
  expect(result.depth, 'the recorded depth is the deepest rung run').toBe(deepest.depth);
  const cover = recordedCover(result);
  if (scenario.cover.model !== 'faithful' || cover.reached !== true) {
    return;
  }
  expect(cover.step, 'the reached step the faithful cover reported').toBe(
    scenario.cover.firstReachableStep,
  );
  expect(result.depth, 'the chosen depth exceeds the known reached step').toBeGreaterThan(
    cover.step,
  );
  tallyIf(tally, 'clearedAStepTheFirstRungDidNot', served.length > 1);
}

/** The rows a whole call draws, rather than one rung of it. */
function tallyTheCall(
  tally: Tally,
  scenario: LadderScenario,
  ladder: readonly number[],
  served: readonly ServedRung[],
): void {
  tallyIf(tally, 'climbedTheWholeLadder', ladder.length > 1 && served.length === ladder.length);
  tallyIf(tally, 'ranTheCombinationalLadder', ladder.length === 1 && served.length === 1);
  tallyIf(tally, 'drewAnUnusableBudget', scenario.budgetKind === 'unusable');
}

describe(PROPERTY_8, () => {
  it(
    'chooses one depth per request, climbs the fixed ladder on an unreached cover, and stops on an incomplete induction',
    async () => {
      const tally: Tally = new Map();
      let total = 0;
      await fc.assert(
        fc.asyncProperty(ladderScenarioArbitrary(), async (scenario) => {
          total += 1;
          const runner = new ScriptedLadderRunner(scenario);
          const oracle = new YosysSmtBmcFormalOracle({
            toolRunner: runner,
            artifacts: runner,
            caps: CAPS,
            now: runner.now,
          });

          runner.beginCall();
          const result = await oracle.prove(scenario.request);
          const served = runner.served;

          const ladder = assertTheLadderIsFixedAndDeterministic(scenario.request);
          assertTheClimbIsMonotonicAndBounded(scenario, ladder, served);
          assertTheEscalationRule(scenario, ladder, served, tally);
          assertTheChosenDepth(scenario, served, result, tally);

          // Clause 1's adapter half (Req 4.5): the SAME adapter, asked a clone of the same request
          // again, chooses the same depths. One instance, so state of its own would show here too.
          runner.beginCall();
          const repeated = await oracle.prove(structuredClone(scenario.request));
          expect(
            runner.served.map((rung) => rung.depth),
            'the depths the same adapter submits for a clone of the request',
          ).toEqual(served.map((rung) => rung.depth));
          expect(repeated.depth, 'the depth recorded for a clone of the request').toBe(
            result.depth,
          );

          tallyTheCall(tally, scenario, ladder, served);
        }),
        propertyParameters({ numRuns: NUM_RUNS }),
      );
      // Non-vacuity: every row is a shape one of the five clauses could fail on, so a sample that
      // never drew one says nothing about that clause.
      expect(total).toBe(NUM_RUNS);
      for (const row of TALLY_ROWS) {
        expect(tally.get(row) ?? 0, `non-vacuity row ${row}`).toBeGreaterThan(0);
      }
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});
