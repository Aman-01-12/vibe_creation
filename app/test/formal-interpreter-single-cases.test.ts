// formal-property-oracle, task 5.10: the interpreter's NAMED SINGLE-CASE rules.
//
// WHY THESE ARE UNIT TESTS AND NOT PROPERTIES
//   Each rule below is one named input shape mapping to one named cause. A property over them
//   would have to GENERATE that shape, which means spelling the shape in the arbitrary and then
//   asserting the interpreter agrees with it - a test of the generator. Group 5's six property
//   files already own every quantified claim (the five-condition iff, the fixed order, the
//   zero-assertion override, induction and refutation, build-failure attribution, the closed
//   vocabularies), so what is left here is the enumerated residue: seven rules whose whole content
//   is a single case, plus the handful of clauses those properties hold as PRECONDITIONS and so
//   never assert.
//
// WHAT WAS FOUND STATED IN A COMMENT AND ASSERTED NOWHERE
//   The module header of `interpret.ts` documents an eight-step order, and six of the eight are
//   already pinned by the property files. Three clauses were not pinned anywhere:
//     1. The cross-check disagreement sits AHEAD OF THE REFUTATION. `formal-refutation-source`
//        asserts a disagreement over a PASSING base case; a disagreement over a FAILING one -
//        where the competing outcome is `refuted` rather than `proved` - was unasserted, and that
//        is the direction where preferring one solver would blame the design.
//     2. `crossCheckDisagrees` compares the INDUCTION LINE as well as the `Status:` string. Two
//        solvers reporting the same `PASSED` while disagreeing about temporal induction disagree
//        about the one fact `proved` rests on, and nothing asserted that.
//     3. `solversDisagreed` scans ALL FOUR checks. A disagreement on the presat or cover check -
//        neither of which the gate would otherwise reach on a proving run - was unasserted, so a
//        reader narrowed to the induction check alone would have kept every test green.
//   Each gets one case below, in the 4.16 block.
//
// CRITERION 5.12 IS NOW CLOSED, AND THIS TASK CLOSED IT
//   Task 5.2 could only implement half of 5.12 and left a `ponytail:` comment saying so: the
//   report carried `reachedStep` and nothing else about the cover line, so "the analysis answered
//   UNREACHED" and "the analysis printed neither line" were THE SAME DOCUMENT, and the interpreter
//   inferred an answer from the `Status:` line's presence. The worker now reports `coverAnswered`
//   beside `reachedStep` (`_parse_check` already had the stdout in hand), the report schema carries
//   it, and `reportedReachability` reads the field. The three-way table in the 5.12 block below is
//   what that buys, and the middle and bottom rows were indistinguishable before it.
//
// EVERY REPORT IS BUILT BY SPREAD over one all-conditions-hold document, so each case states only
// the field it is about; a fixture per case would let two cases drift in a field neither asserts.
//
// TASK 20.4 ADDED THE TWO GUARDS `interpretFormalReport` GAINED IN TASKS 20.1 AND 20.2
//   Req 11.19: a Cover_Check naming a reached step at or past the depth its own invocation searched
//   to is a document the real tool cannot write, refused as `toolchain-unavailable`. Req 7.23: a run
//   the Tool_Runner killed reads `proof-timeout` AHEAD of any lowering failure it also reported. Each
//   block pairs the refusal with a POSITIVE CONTROL, so the guard cannot be satisfied by a reader
//   that refuses everything, and the 7.23 block runs the SAME document unkilled so the attribution
//   it must not reach is shown to be the one that would have been read.
//
// **Validates: Requirements 1.15, 1.16, 4.16, 5.11, 5.12, 7.23, 11.15, 11.19, 12.20**

import { describe, expect, it } from 'vitest';

import {
  COUNTEREXAMPLE_ARTIFACT_KEY,
  interpretFormalReport,
  parseFormalReport,
  validateExpression,
  type ArtifactBlobRef,
  type CoverCondition,
  type FormalProperty,
  type FormalRunContext,
  type ProofConditions,
  type PropertyResult,
  type SandboxResult,
  type ValidatedExpression,
} from '@app/tools';

/** One accepted expression, or a loud failure: an unvalidated string cannot build a property. */
function expression(text: string): ValidatedExpression {
  const validated = validateExpression(text);
  if (!validated.ok) {
    throw new Error(`test expression rejected: ${validated.error.reason}`);
  }
  return validated.value;
}

/** A clocked property WITH an antecedent, so the Cover_Check condition is live rather than waived. */
const PROPERTY: FormalProperty = {
  kind: 'clocked',
  id: 'p1',
  criterionRef: '1.1',
  clock: expression('clk'),
  antecedent: expression('en'),
  consequent: expression('q == 1'),
};

const RUN: FormalRunContext = {
  depth: 20,
  elapsedMs: 5,
  designFileName: 'design.v',
  wrapperFileName: 'wrapper.v',
};

/** The base case's counterexample, under the one key a refutation travels through. */
const BASE_TRACE: ArtifactBlobRef = {
  name: 'formal-trace-base-bitwuzla.vcd',
  sizeBytes: 512,
  sha256: 'a'.repeat(64),
};

/** A SIBLING trace, registered under its own filename the way the worker registers non-base ones. */
const COVER_TRACE: ArtifactBlobRef = {
  name: 'formal-trace-cover-bitwuzla.vcd',
  sizeBytes: 256,
  sha256: 'b'.repeat(64),
};

/** The four check slots, as an explicit tuple. See `formal-zero-assertion-guard` for why not `Object.values`. */
const CHECK_NAMES = ['presat', 'base', 'cover', 'induct'] as const;

/** A completed, unkilled run carrying whatever artifacts the case is about. */
function sandboxResult(
  artifacts: Readonly<Record<string, ArtifactBlobRef>> = {},
  stderr = '',
): SandboxResult {
  return {
    verdict: 'pass',
    timedOut: false,
    exitCode: 0,
    stdout: '',
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts,
    deniedOperations: [],
    resourceUsage: { wallMs: 10, maxMemMb: 1, cpuMs: 10 },
  };
}

/** The check shape every invocation reports, with the case's own fields spread over it. */
function check(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { exitCode: 0, status: 'PASSED', elapsedMs: 1, ...over };
}

/**
 * A report in which ALL FIVE conditions hold. Spread over, never mutated.
 *
 * The cover reports `Status: FAILED` beside a reached step and `coverAnswered: true`, which is a
 * MEASURED shape and not a contrivance: in `-c` mode `FAILED` is reported both for an unreached
 * cover and for an assert failing on a covering path that printed `Reached cover statement in step
 * 1` in the same run. Starting from that shape means every case below inherits the one document
 * that would break a `Status:`-reading implementation.
 */
function provingReport(checks: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lowering: { exitCode: 0, stderrTail: '' },
    assertionCount: 2,
    checks: {
      presat: check(),
      base: check(),
      cover: check({ status: 'FAILED', reachedStep: 13, coverAnswered: true }),
      induct: check({ inductionSuccessful: true }),
      ...checks,
    },
  };
}

/**
 * Parse the document the way production does, failing the test on a rejection, and interpret it
 * against the given invocation result and run context.
 */
function interpretRun(
  result: SandboxResult,
  document: Record<string, unknown>,
  run: FormalRunContext = RUN,
): PropertyResult {
  const parsed = parseFormalReport(JSON.stringify(document));
  if (!parsed.ok) {
    throw new Error(`report rejected: ${parsed.error.reason}`);
  }
  return interpretFormalReport(result, parsed.value, PROPERTY, run);
}

/** An unkilled, completed run carrying the given artifacts, interpreted against the default run. */
function interpret(
  document: Record<string, unknown>,
  artifacts: Readonly<Record<string, ArtifactBlobRef>> = {},
): PropertyResult {
  return interpretRun(sandboxResult(artifacts), document);
}

/** The cause of a `could-not-verify`, or a loud failure naming the verdict that arrived instead. */
function cause(result: PropertyResult): string {
  if (result.verdict !== 'could-not-verify') {
    throw new Error(`expected could-not-verify, got ${result.verdict}`);
  }
  return result.cause;
}

/**
 * The five conditions the result RECORDED, whichever member it is.
 *
 * `ProvedEvidence` is assignable to `ProofConditions` - each of its five fields is the admitting
 * literal of the corresponding field - which is what makes one reader enough for all three members.
 */
function recordedConditions(result: PropertyResult): ProofConditions {
  return result.verdict === 'proved' ? result.evidence : result.conditions;
}

// ---------------------------------------------------------------------------
// Req 4.16: a disagreeing Solver_Cross_Check, preferring NEITHER solver
// ---------------------------------------------------------------------------

/** The audit shape, as the worker's `_CrossCheck.as_dict` writes it. */
function audit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { solver: 'z3', exitCode: 0, status: 'PASSED', elapsedMs: 9, ...over };
}

describe('a disagreeing Solver_Cross_Check stops the gate and prefers neither solver (Req 4.16)', () => {
  it('reads no verdict from the MAIN solver when the audit contradicts it', () => {
    // bitwuzla says the induction proof succeeded; z3 says it failed. Preferring the main run
    // would report `proved` on evidence the audit contradicts, which is the direction a
    // disagreement is least safe in.
    const document = provingReport({
      induct: check({ inductionSuccessful: true, crossCheck: audit({ status: 'FAILED' }) }),
    });

    const result = interpret(document);

    expect(result.verdict).not.toBe('proved');
    expect(cause(result)).toBe('toolchain-unavailable');
  });

  it('reads no verdict from the AUDIT when it is the audit that reports the proof', () => {
    // The mirror image, and the half that says "prefers NEITHER" rather than "prefers bitwuzla":
    // the main run reports no induction success and z3 does. `proved` is still refused, and so is
    // `induction-inconclusive` - naming the main run's shortfall would be reading its result.
    const document = provingReport({
      induct: check({
        inductionSuccessful: false,
        crossCheck: audit({ inductionSuccessful: true }),
      }),
    });

    const result = interpret(document);

    expect(result.verdict).not.toBe('proved');
    expect(cause(result)).toBe('toolchain-unavailable');
  });

  it('reports a disagreement about the INDUCTION LINE under two identical Status: strings', () => {
    // THE CONJUNCT NOTHING ELSE ASSERTS. Both solvers report `PASSED`, so a status-only comparison
    // reads this document as agreement - and a bounded pass and an unbounded proof BOTH report
    // `PASSED`, so what the two solvers disagree about here is precisely the one fact `proved`
    // rests on.
    const document = provingReport({
      induct: check({
        inductionSuccessful: true,
        crossCheck: audit({ status: 'PASSED', inductionSuccessful: false }),
      }),
    });

    expect(cause(interpret(document))).toBe('toolchain-unavailable');
  });

  it('reads a report where only ONE side carries the induction line as a disagreement', () => {
    // A shape we do not recognize, and `!==` reads it as a disagreement, which is the fail-safe
    // direction: an audit that answered a different question than the check it audits has not
    // confirmed it.
    const document = provingReport({
      induct: check({ inductionSuccessful: true, crossCheck: audit() }),
    });

    expect(cause(interpret(document))).toBe('toolchain-unavailable');
  });

  it.each(CHECK_NAMES)('stops the gate on a disagreement over the %s check', (name) => {
    // ONE ASSERTION PER CHECK, because the claim is about a closed key set: the scan is over all
    // four slots, so a reader narrowed to the induction check alone must fail here. On a proving
    // run the gate never otherwise looks at the presat or cover verdicts at all.
    const document = provingReport({
      [name]: check({
        ...(name === 'cover' ? { status: 'FAILED', reachedStep: 13, coverAnswered: true } : {}),
        ...(name === 'induct' ? { inductionSuccessful: true } : {}),
        crossCheck: audit({ status: 'PREUNSAT' }),
      }),
    });

    expect(cause(interpret(document))).toBe('toolchain-unavailable');
  });

  it('refuses to report refuted when the base case FAILED and its audit disagrees', () => {
    // THE ORDERING CLAUSE THE HEADER STATES AND NOTHING ASSERTED: the disagreement guard sits
    // AHEAD of the refutation. With the counterexample registered this document is otherwise a
    // textbook `refuted`, and reporting it would blame the design on the word of one solver the
    // other contradicts.
    const document = provingReport({
      base: check({ status: 'FAILED', crossCheck: audit({ status: 'PASSED' }) }),
    });

    const result = interpret(document, { [COUNTEREXAMPLE_ARTIFACT_KEY]: BASE_TRACE });

    expect(result.verdict).not.toBe('refuted');
    expect(cause(result)).toBe('toolchain-unavailable');
  });

  it('reports refuted where the COVER audit differs and the base case FAILED', () => {
    // refutation-lost-to-cover-cross-check, measured on `RAM` and `adder_pipe_64bit`. Cover mode's
    // `Status:` is overloaded at its source: smtbmc breaks out on a failed assertion before it can
    // report every cover reached, so `FAILED` there means "unreached" OR "an assert failed on the
    // covering path". Once the base case has failed only the second is possible, so this is not a
    // disagreement, and the counterexample's own existence proves the antecedent was reached.
    const document = provingReport({
      base: check({ status: 'FAILED' }),
      cover: check({
        status: 'PASSED',
        reachedStep: 2,
        coverAnswered: true,
        crossCheck: audit({ status: 'FAILED' }),
      }),
    });

    const result = interpret(document, { [COUNTEREXAMPLE_ARTIFACT_KEY]: BASE_TRACE });

    expect(result.verdict).toBe('refuted');
  });

  it('still stops the gate on a COVER audit disagreement where the base case PASSED', () => {
    // The false-proof guard, and the reason the exemption above is scoped to a failed base case.
    // No assertion can fail on the covering path of a property whose base check passed, so a
    // differing cover status there can only be a real reachability disagreement, and that is the
    // case gating `proved`.
    const document = provingReport({
      cover: check({
        status: 'PASSED',
        reachedStep: 2,
        coverAnswered: true,
        crossCheck: audit({ status: 'FAILED' }),
      }),
    });

    const result = interpret(document);

    expect(result.verdict).not.toBe('proved');
    expect(cause(result)).toBe('toolchain-unavailable');
  });

  it('records WHICH source produced toolchain-unavailable, so a record can name its cause', () => {
    // The same cause has several sources, and the measured run's record could not tell them
    // apart: 5 of its 11 no-verdicts were this disagreement and every one was recorded `false`.
    const disagreed = interpret(
      provingReport({
        induct: check({ inductionSuccessful: true, crossCheck: audit({ status: 'FAILED' }) }),
      }),
    );
    // A failed base with no counterexample is the SAME cause from a different source.
    const noEvidence = interpret(provingReport({ base: check({ status: 'FAILED' }) }));

    expect(cause(disagreed)).toBe('toolchain-unavailable');
    expect(cause(noEvidence)).toBe('toolchain-unavailable');
    expect(disagreed.verdict === 'could-not-verify' && disagreed.crossCheckDisagreed).toBe(true);
    expect(noEvidence.verdict === 'could-not-verify' && noEvidence.crossCheckDisagreed).toBe(false);
  });

  it('treats a check that was NOT audited as agreement, not as silence', () => {
    // The non-vacuity half. Without it every assertion above would hold for a reader that called
    // any report a disagreement, and `proved` would be unreachable.
    expect(interpret(provingReport()).verdict).toBe('proved');
  });
});

// ---------------------------------------------------------------------------
// Req 5.11: the antecedent condition comes from the reached STEP, never from the `-c` `Status:`
// ---------------------------------------------------------------------------

describe('the antecedent condition is read from the reached step (Req 5.11)', () => {
  it('records a cover reached at its step even where the -c run reported Status: FAILED', () => {
    // THE MEASURED TWO-FACTS-ONE-STRING CASE: `Status: FAILED` and `Reached cover statement in
    // step 1` in the SAME run, which is an assert failing on a path the cover DID reach. A
    // `Status:`-reading implementation calls this an unreached antecedent and reports
    // `antecedent-unreached` for a property whose antecedent was demonstrably reached.
    const document = provingReport({
      cover: check({ status: 'FAILED', reachedStep: 1, coverAnswered: true }),
    });

    const result = interpret(document);

    expect(result.verdict).toBe('proved');
    expect(recordedConditions(result).cover).toEqual<CoverCondition>({ reached: true, step: 1 });
  });

  it('records a cover as UNREACHED where the -c run reported Status: PASSED with no step', () => {
    // The same rule read in the FALSE-PASS direction, which is the one that matters: a
    // `Status:`-reading implementation calls `PASSED` a reached cover and admits a proof of a
    // property that was never evaluated - measured on `multi_booth_8bit`, whose antecedent is
    // first reachable at step 19.
    const document = provingReport({
      cover: check({ status: 'PASSED', coverAnswered: true }),
    });

    const result = interpret(document);

    expect(cause(result)).toBe('antecedent-unreached');
    expect(recordedConditions(result).cover).toEqual<CoverCondition>({ reached: false });
  });

  it.each([0, 1, 2, 13, 19])(
    'carries the reported step %i through rather than a default',
    (step) => {
      // Req 5.5 records the step a cover was reached at, and Req 1.16's no-threshold rule applied to
      // the one step the report DOES carry: the verdict is the same at every step, so no comparison
      // over it decides anything. A `step > 0` or `step > 1` guard added to `coverCondition` fails
      // the first two rows; a defaulted step fails all five.
      const document = provingReport({
        cover: check({ status: 'FAILED', reachedStep: step, coverAnswered: true }),
      });

      const result = interpret(document);

      expect(result.verdict).toBe('proved');
      expect(recordedConditions(result).cover).toEqual<CoverCondition>({ reached: true, step });
    },
  );
});

// ---------------------------------------------------------------------------
// Req 5.12: an unanswered reachability question is not an unreached antecedent
// ---------------------------------------------------------------------------

/** One cover shape, the cause it must report, and what the analysis actually did. */
interface CoverCase {
  readonly what: string;
  readonly cover: Record<string, unknown>;
  readonly expected: string;
}

/**
 * The THREE outcomes of one question, which is one more than `reachedStep` alone can express.
 *
 * Rows two and three carry NO reached step and the SAME `Status: FAILED`, so before `coverAnswered`
 * existed they were the same document - and they are opposite facts. Row two is a finding about the
 * property: the analysis answered, in the negative. Row three is a gap in our instrument: it
 * answered nothing, and attributing that to the design is what 5.12 forbids.
 */
const COVER_CASES: readonly CoverCase[] = Object.freeze([
  {
    what: 'answered REACHED at a step',
    cover: { exitCode: 0, status: 'FAILED', elapsedMs: 1, reachedStep: 4, coverAnswered: true },
    expected: 'proved',
  },
  {
    what: 'answered UNREACHED',
    cover: { exitCode: 1, status: 'FAILED', elapsedMs: 1, coverAnswered: true },
    expected: 'antecedent-unreached',
  },
  {
    what: 'printed NEITHER cover line',
    cover: { exitCode: 1, status: 'FAILED', elapsedMs: 1, coverAnswered: false },
    expected: 'toolchain-unavailable',
  },
]);

describe('a Cover_Check that answered nothing is toolchain-unavailable (Req 5.12)', () => {
  it.each(COVER_CASES)('reports $expected for a cover that $what', ({ cover, expected }) => {
    const result = interpret(provingReport({ cover }));

    expect(result.verdict === 'proved' ? 'proved' : cause(result)).toBe(expected);
  });

  it('reports toolchain-unavailable for a cover the lowering never ran', () => {
    // The half task 5.2 could already close, kept here because it is the same rule's other end:
    // a check that never ran answered nothing either, and it used to report `antecedent-unreached`.
    const document = provingReport({ cover: { exitCode: null, status: null, elapsedMs: 0 } });

    expect(cause(interpret(document))).toBe('toolchain-unavailable');
  });

  it('refuses an answer claimed by a check that reports it did not run', () => {
    // The consistency guard on untrusted text. `coverAnswered: true` beside `exitCode: null` is a
    // document claiming a check both did not run and printed a cover line; the fail-safe reading
    // reports our instrument rather than attributing an unreached antecedent to the design.
    const document = provingReport({
      cover: { exitCode: null, status: 'FAILED', elapsedMs: 0, coverAnswered: true },
    });

    expect(cause(interpret(document))).toBe('toolchain-unavailable');
  });

  it('records the collapsed cover condition as not-reached whichever of the two it was', () => {
    // `CoverCondition` has no `not-run` member, so both rows record `reached: false` - the only
    // non-admitting value there is. That collapse costs no ATTRIBUTION precisely because the cause
    // carries what happened, which is the pair of assertions above; this one pins the collapse
    // itself so a reader is not left wondering whether the record distinguishes them.
    const answered = provingReport({ cover: check({ status: 'FAILED', coverAnswered: true }) });
    const silent = provingReport({ cover: check({ status: 'FAILED', coverAnswered: false }) });

    expect(recordedConditions(interpret(answered)).cover).toEqual<CoverCondition>({
      reached: false,
    });
    expect(recordedConditions(interpret(silent)).cover).toEqual<CoverCondition>({ reached: false });
  });
});

// ---------------------------------------------------------------------------
// Req 1.15 and 1.16: the failing step
// ---------------------------------------------------------------------------

/**
 * A captured failing `yosys-smtbmc` output, in the measured shape both criteria are written about.
 *
 * Req 1.15 says a failing step, WHERE one is read, comes from the last `Checking assertions in step
 * N..` line preceding `BMC failed!` and never from the `Assert failed` line - and the two disagree
 * in this very capture: the assert line says `step 1` and the last checking line says `step 14`.
 * That disagreement is why the rule exists, and it is what makes the text below a probe rather than
 * a decoration.
 */
const FAILING_SMTBMC_OUTPUT = [
  'Solver: bitwuzla',
  'Checking assertions in step 0..',
  'Checking assertions in step 13..',
  'Checking assertions in step 14..',
  'BMC failed!',
  'Assert failed in top: step 1',
  'Status: FAILED',
].join('\n');

describe('no failing step reaches a Proof_Condition or a verdict (Req 1.15, 1.16)', () => {
  it.each(CHECK_NAMES)('refuses a report that carries a failing step on the %s check', (name) => {
    // THE STRUCTURAL FORM OF 1.16, AND THE STRONGEST ONE AVAILABLE. No threshold over a failing
    // step can be written in the gate because no validated report can CARRY one: the schema is
    // closed at every level, so a field naming a step on any check is a document we do not
    // recognize. The day a worker starts reporting one, this fails and whoever added it has to come
    // back and read 1.15 and 1.16 before the value can reach a condition.
    const document = provingReport({ [name]: check({ failingStep: 14 }) });

    expect(parseFormalReport(JSON.stringify(document)).ok).toBe(false);
  });

  it('refuses a failing step smuggled onto a Solver_Cross_Check', () => {
    const document = provingReport({ base: check({ crossCheck: audit({ failingStep: 14 }) }) });

    expect(parseFormalReport(JSON.stringify(document)).ok).toBe(false);
  });

  it('records the same conditions for a refutation whichever step its output reported', () => {
    // 1.15's `WHERE` clause is VACUOUS in the delivered code and this is what says so out loud:
    // the whole captured output above travels only as untrusted DIAGNOSTIC text, so a refutation's
    // verdict and its five recorded conditions are identical to one whose output carried no step
    // at all. Both thresholds that were measured and rejected - `step > 0` admits every failing
    // clocked property because a clocked assertion samples step 0 and reports at step 1, and
    // `step > 1` discards every genuine reset-state bug - are unreachable from here by
    // construction, because the number is not in the document.
    const document = provingReport({ base: check({ status: 'FAILED' }) });
    const artifacts = { [COUNTEREXAMPLE_ARTIFACT_KEY]: BASE_TRACE };
    const parsed = parseFormalReport(JSON.stringify(document));
    if (!parsed.ok) {
      throw new Error(`report rejected: ${parsed.error.reason}`);
    }

    const withSteps = interpretFormalReport(
      sandboxResult(artifacts, FAILING_SMTBMC_OUTPUT),
      parsed.value,
      PROPERTY,
      RUN,
    );
    const withoutSteps = interpretFormalReport(
      sandboxResult(artifacts, ''),
      parsed.value,
      PROPERTY,
      RUN,
    );

    expect(withSteps.verdict).toBe('refuted');
    expect(withSteps).toEqual(withoutSteps);
  });
});

// ---------------------------------------------------------------------------
// Req 11.15: `yosys-smtbmc -s bitwuzla` present but not invocable
// ---------------------------------------------------------------------------

/**
 * The measured unshimmed-bitwuzla shape: every check exits non-zero with NO parseable `Status:`.
 *
 * `smtio.py:229` builds `bitwuzla --smt2 -i` and bitwuzla 0.9.x rejects both flags, so
 * `yosys-smtbmc` dies before it prints a status line. The LOWERING still completes - Yosys does not
 * call the solver - which is exactly what makes this shape indistinguishable from a working run
 * anywhere upstream of the status parse.
 */
function notInvocableReport(checks: Record<string, unknown> = {}): Record<string, unknown> {
  const died = (): Record<string, unknown> => ({ exitCode: 1, status: null, elapsedMs: 2 });
  return {
    lowering: { exitCode: 0, stderrTail: '' },
    assertionCount: 2,
    checks: { presat: died(), base: died(), cover: died(), induct: died(), ...checks },
  };
}

describe('a present-but-not-invocable solver is toolchain-unavailable (Req 11.15)', () => {
  it('reports toolchain-unavailable, and witnesses no check as having run', () => {
    const result = interpret(notInvocableReport());

    expect(cause(result)).toBe('toolchain-unavailable');
    // Not a restatement of the cause: `not-run` is what keeps a check nobody could invoke out of
    // its own failing value, and `base: 'failed'` in particular is the one value that can refute a
    // design. A default to anything but `not-run` here would read a dead solver as a measurement.
    const conditions = recordedConditions(result);
    expect(conditions.presat).toBe('not-run');
    expect(conditions.base).toBe('not-run');
    expect(conditions.induction).toBe('not-run');
  });

  it('reads no verdict from a z3 result on that path, whatever the audit reports', () => {
    // The second half of 11.15: there is NO `-s z3` re-run on this path, because the solver choice
    // is part of the Formal_Oracle_Version and a verdict from another solver would make the
    // recorded experiment identity a lie. Asserted at the gate, which is where it is observable: a
    // document carrying a full proving audit beside an unreadable main run is still
    // `toolchain-unavailable`, so no z3 result can stand in for the solver that version names.
    const document = notInvocableReport({
      induct: {
        exitCode: 1,
        status: null,
        elapsedMs: 2,
        crossCheck: audit({ inductionSuccessful: true }),
      },
    });

    const result = interpret(document);

    expect(result.verdict).not.toBe('proved');
    expect(cause(result)).toBe('toolchain-unavailable');
  });
});

// ---------------------------------------------------------------------------
// Req 12.20: an absent Counterexample trace is not an error on that ground alone
// ---------------------------------------------------------------------------

describe('a completed run that registered no trace is not an error (Req 12.20)', () => {
  it('reports proved for an admitting run that registered no artifacts at all', () => {
    // A successful proof writes no counterexample, so an empty artifact map is the ORDINARY shape
    // of a run that found none. This is also why the trace is registered opportunistically rather
    // than named as a required output: a required output's absence classifies the whole invocation
    // `error`, which would make every proof an error.
    const result = interpret(provingReport(), {});

    expect(result.verdict).toBe('proved');
  });

  it('reports the cause it actually had, not a trace complaint, when a run could not verify', () => {
    // A bounded pass with no trace: the cause is the shallow depth, and the missing trace adds
    // nothing. The ONE place an absent trace decides anything is a FAILED base case, which is Req
    // 1.17 and is asserted in `formal-refutation-source.test.ts`.
    const document = provingReport({ induct: check({ inductionSuccessful: false }) });

    expect(cause(interpret(document, {}))).toBe('induction-inconclusive');
  });

  it('requires the base case\u2019s own trace key, not merely some registered trace', () => {
    // The `vcd` key is a CHANNEL, not a name: the worker registers the base case's trace under it
    // precisely because `refutation()` reads that key, and every sibling trace under its own
    // filename. A refutation whose base-case trace is missing while a cover trace survives is
    // therefore still `toolchain-unavailable` - the evidence we could hand back is not evidence of
    // this refutation.
    const document = provingReport({ base: check({ status: 'FAILED' }) });

    expect(cause(interpret(document, { [COVER_TRACE.name]: COVER_TRACE }))).toBe(
      'toolchain-unavailable',
    );
  });
});

// ---------------------------------------------------------------------------
// Req 11.19: a cover step the invocation that reported it cannot have reached
// ---------------------------------------------------------------------------

/** One cover step against the depth the SAME invocation searched to, and the reading it must get. */
interface CoverStepCase {
  readonly what: string;
  readonly depth: number;
  readonly step: number;
  readonly expected: 'proved' | 'toolchain-unavailable';
}

/**
 * The boundary at two depths, plus one step well past it.
 *
 * `yosys-smtbmc -c` prints `Reached cover statement in step N` only for an N strictly BELOW the depth
 * it searched to, so `depth - 1` is the last step the tool can report and `depth` is the first it
 * cannot. The depth-1 rows are the combinational property's ladder rung, where the only reachable
 * step is 0 - the shape a fixture with a hard-coded step most easily gets wrong.
 */
const COVER_STEP_CASES: readonly CoverStepCase[] = Object.freeze([
  { what: 'the last step the tool could reach', depth: 20, step: 19, expected: 'proved' },
  {
    what: 'exactly the depth',
    depth: 20,
    step: 20,
    expected: 'toolchain-unavailable',
  },
  {
    what: 'well past the depth',
    depth: 20,
    step: 64,
    expected: 'toolchain-unavailable',
  },
  { what: 'the only step a depth-1 rung reaches', depth: 1, step: 0, expected: 'proved' },
  {
    what: 'exactly the depth of a depth-1 rung',
    depth: 1,
    step: 1,
    expected: 'toolchain-unavailable',
  },
]);

/** The run context at a given depth; every other field is the default run's. */
function runAtDepth(depth: number): FormalRunContext {
  return { ...RUN, depth };
}

/** A cover that answered REACHED at `step`, in the measured `Status: FAILED` shape. */
function coverReachedAt(step: number): Record<string, unknown> {
  return check({ status: 'FAILED', reachedStep: step, coverAnswered: true });
}

describe('a Cover_Check naming a step its own depth could not reach is refused (Req 11.19)', () => {
  it.each(COVER_STEP_CASES)(
    'reports $expected for a cover reached at step $step of depth $depth ($what)',
    ({ depth, step, expected }) => {
      // The pair is the point: `depth - 1` is the POSITIVE CONTROL, and it has to stay `proved`
      // for the refusal beside it to mean anything. A guard written as `step >= 1`, or one that
      // refused every named step, fails the control rows; a guard written `>` instead of `>=`
      // fails the "exactly the depth" rows, which is the boundary a forged document sits on.
      const result = interpretRun(
        sandboxResult(),
        provingReport({ cover: coverReachedAt(step) }),
        runAtDepth(depth),
      );

      expect(result.verdict === 'proved' ? 'proved' : cause(result)).toBe(expected);
    },
  );

  it('refuses the impossible step for a FAILED base case too, and never sources a refutation from it', () => {
    // THE DIRECTION THE SPEC REFUSES THROUGHOUT. With the counterexample registered and the base
    // case failing, this is otherwise a textbook `refuted`; a guard that gated only the `proved`
    // return would let a forged report blame the design. The control is the same document one step
    // lower, which must still be `refuted` so the refusal is shown to come from the step alone.
    const artifacts = { [COUNTEREXAMPLE_ARTIFACT_KEY]: BASE_TRACE };
    const base = check({ status: 'FAILED' });

    const forged = interpretRun(
      sandboxResult(artifacts),
      provingReport({ base, cover: coverReachedAt(RUN.depth) }),
    );
    const genuine = interpretRun(
      sandboxResult(artifacts),
      provingReport({ base, cover: coverReachedAt(RUN.depth - 1) }),
    );

    expect(genuine.verdict).toBe('refuted');
    expect(forged.verdict).not.toBe('refuted');
    expect(cause(forged)).toBe('toolchain-unavailable');
  });

  it('reads a zero-assertion report that also names an impossible step as toolchain-unavailable', () => {
    // THE ONE CORNER WHERE REQ 11.19 AND REQ 2.2 CONTRADICT, AND THE DECISION IS RECORDED HERE.
    // Req 1.5 allows exactly one cause and both criteria are unconditional, so one has to bend.
    // The guard sits AHEAD of the five-condition order, so 11.19 wins: a document that names an
    // impossible step is corrupt, and reading `zero-assertions` off it would be reading a condition
    // from a report already judged untrustworthy. The control is the same zero count with a
    // reachable step, which is still `zero-assertions`, so Req 2.2 is intact everywhere else.
    const impossible = interpretRun(sandboxResult(), {
      ...provingReport({ cover: coverReachedAt(RUN.depth) }),
      assertionCount: 0,
    });
    const reachable = interpretRun(sandboxResult(), {
      ...provingReport({ cover: coverReachedAt(RUN.depth - 1) }),
      assertionCount: 0,
    });

    expect(cause(reachable)).toBe('zero-assertions');
    expect(cause(impossible)).toBe('toolchain-unavailable');
  });
});

// ---------------------------------------------------------------------------
// Req 7.23: a killed invocation reads proof-timeout, whatever its lowering reported
// ---------------------------------------------------------------------------

/** One lowering failure, and the attribution it gets when the clock did NOT kill the run. */
interface LoweringFailureCase {
  readonly what: string;
  readonly stderrTail: string;
  readonly unkilledCause: 'frontend-rejected' | 'property-build-failed';
}

/**
 * The three attributions `attributeLoweringFailure` can make, each over a diagnostic that would
 * really earn it. The first row is the one that matters: it is the design-blaming reading a killed
 * run must never reach.
 */
const LOWERING_FAILURES: readonly LoweringFailureCase[] = Object.freeze([
  {
    what: 'names the submitted design',
    stderrTail: 'design.v:3: ERROR: syntax error, unexpected TOK_ENDMODULE',
    unkilledCause: 'frontend-rejected',
  },
  {
    what: 'names the property wrapper',
    stderrTail: 'wrapper.v:7: ERROR: syntax error, unexpected TOK_ENDMODULE',
    unkilledCause: 'property-build-failed',
  },
  {
    what: 'names neither file',
    stderrTail: 'ERROR: Killed while reading the design',
    unkilledCause: 'property-build-failed',
  },
]);

/** A report whose lowering exited non-zero, so none of its four checks ran. */
function failedLoweringReport(stderrTail: string): Record<string, unknown> {
  const neverRan = (): Record<string, unknown> => ({ exitCode: null, status: null, elapsedMs: 0 });
  return {
    lowering: { exitCode: 1, stderrTail },
    assertionCount: 0,
    checks: { presat: neverRan(), base: neverRan(), cover: neverRan(), induct: neverRan() },
  };
}

/** The result of an invocation the Tool_Runner killed on the wall clock. */
function killedResult(): SandboxResult {
  return { ...sandboxResult(), verdict: 'error', timedOut: true };
}

describe('a killed invocation that also reported a failed lowering reads proof-timeout (Req 7.23)', () => {
  it.each(LOWERING_FAILURES)(
    'reports proof-timeout and not an attribution when the lowering $what',
    ({ stderrTail, unkilledCause }) => {
      // A lowering our own wall clock stopped exits non-zero. Read in the other order it reaches
      // `attributeLoweringFailure` and becomes `frontend-rejected` - attributable to the candidate
      // design, counted in the recorded quarantine, for a budget that is ours. The verdict is
      // `could-not-verify` either way; only the CAUSE moves, and the cause is what blames.
      const document = failedLoweringReport(stderrTail);

      const unkilled = interpret(document);
      const killed = interpretRun(killedResult(), document);

      // The control: the SAME document, unkilled, gets the attribution the killed one must not.
      expect(cause(unkilled)).toBe(unkilledCause);
      expect(cause(killed)).toBe('proof-timeout');
      expect(cause(killed)).not.toBe('frontend-rejected');
    },
  );
});
