// formal-property-oracle, task 5.2: `refuted` is sourced from the BASE CASE, and the two induction
// failures are named apart.
//
// WHY THIS FILE EXISTS RATHER THAN WAITING FOR THE PROPERTY TESTS IN TASKS 5.4-5.8
//   The defect this task closes is a FALSE REFUTATION of a CORRECT design, which is at least as
//   serious as a false proof: the shipped code read `refuted` off the INDUCTION check's `FAILED`,
//   and `yosys-smtbmc`'s k-induction emits no simple-path constraints, so a correct design reports
//   a PASSING base case with a FAILING inductive step at every depth - measured on a constructed
//   `bounded_ctr`, on `counter_12`'s `out != 4'd13`, and on the Yosys issue-3378 ROM case at depths
//   1, 5, 20, and 40. Upstream SymbiYosys treats that situation as UNKNOWN rather than as a
//   failure. So the one direction that must never regress silently gets its own assertion now,
//   ahead of the broader properties.
//
// THE OTHER HALF OF THE SAME CONTRACT, MEASURED IN THE OPPOSITE DIRECTION
//   Induction is still REQUIRED for a proof, because plain BMC passed the `JC_counter` mutant
//   `!Q[0]` -> `!Q[1]` at depths 20, 64, AND 66 and failed only at 70. So a bounded pass is
//   `induction-inconclusive` (the remedy is more depth) and an induction failure over a passing
//   base case is `induction-engine-incomplete` (no depth is known to help). Conflating the two is
//   the error this file pins apart.
//
// WHAT IS ASSERTED, AND WHY EACH LINE IS HERE
//   1. A report shaped exactly like the worker's `_SmtBmcCheck.as_dict` / `_CrossCheck.as_dict`
//      output - FOUR checks, plus `tracePath` and `crossCheck` - validates. Before this task the
//      schema pinned three checks and knew neither field, so a report from the real worker did not
//      validate at all and every run fell to `toolchain-unavailable`.
//   2. A THREE-check report is REJECTED. The parse must reject what it does not recognize
//      (Req 11.10); a permissive parse here would read an absent Base_Check as a satisfied one.
//   3. `refuted` iff the base case FAILED with the earlier conditions satisfied AND a counterexample
//      registered - each conjunct asserted by removing it and watching the verdict change
//      (Req 1.10, 1.17, 4.8, and design.md's Property 6).
//   4. An induction `FAILED` over a PASSING base case is `induction-engine-incomplete`, never
//      `refuted` (Req 4.10, 4.11, 4.12).
//   5. A disagreeing Solver_Cross_Check is `toolchain-unavailable`, preferring neither solver
//      (Req 4.16).
//
// The report bodies below are built by SPREAD from one all-passing document, so each case states
// only the field it is about: a fixture per case would let two cases drift in a field neither is
// asserting.

import { describe, expect, it } from 'vitest';

import {
  COUNTEREXAMPLE_ARTIFACT_KEY,
  interpretFormalReport,
  parseFormalReport,
  validateExpression,
  type ArtifactBlobRef,
  type FormalProperty,
  type FormalRunContext,
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

const TRACE: ArtifactBlobRef = {
  name: 'formal-trace-base-bitwuzla.vcd',
  sizeBytes: 512,
  sha256: 'a'.repeat(64),
};

/** A completed run, carrying whatever artifacts the case is about. */
function sandboxResult(artifacts: Readonly<Record<string, ArtifactBlobRef>> = {}): SandboxResult {
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
    resourceUsage: { wallMs: 10, maxMemMb: 1, cpuMs: 10 },
  };
}

/** The check shape every invocation reports, with the case's own fields spread over it. */
function check(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { exitCode: 0, status: 'PASSED', elapsedMs: 1, ...over };
}

/**
 * A report in which ALL FIVE conditions hold, carrying the two fields the reworked worker writes.
 *
 * The cover reports `Status: FAILED` beside a reached step ON PURPOSE: in `-c` mode that string is
 * reported both for an unreached cover and for an assert failing on a covering path, so the
 * condition is read from the step and never from the status.
 */
function provingReport(checks: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lowering: { exitCode: 0, stderrTail: '' },
    assertionCount: 2,
    checks: {
      presat: check({ tracePath: 'formal-trace-presat-bitwuzla.vcd' }),
      base: check(),
      cover: check({ status: 'FAILED', reachedStep: 13 }),
      induct: check({
        inductionSuccessful: true,
        crossCheck: {
          solver: 'z3',
          exitCode: 0,
          status: 'PASSED',
          elapsedMs: 9,
          inductionSuccessful: true,
        },
      }),
      ...checks,
    },
  };
}

/** Parse the document the way production does, failing the test on a rejection. */
function interpret(
  document: Record<string, unknown>,
  artifacts: Readonly<Record<string, ArtifactBlobRef>> = {},
): PropertyResult {
  const parsed = parseFormalReport(JSON.stringify(document));
  if (!parsed.ok) {
    throw new Error(`report rejected: ${parsed.error.reason}`);
  }
  return interpretFormalReport(sandboxResult(artifacts), parsed.value, PROPERTY, RUN);
}

/** The cause of a `could-not-verify`, or a loud failure naming the verdict that arrived instead. */
function cause(result: PropertyResult): string {
  if (result.verdict !== 'could-not-verify') {
    throw new Error(`expected could-not-verify, got ${result.verdict}`);
  }
  return result.cause;
}

describe('the formal report schema matches what the worker emits', () => {
  it('accepts a four-check report carrying tracePath and crossCheck', () => {
    expect(parseFormalReport(JSON.stringify(provingReport())).ok).toBe(true);
  });

  it('rejects a report with no base check, rather than reading its absence as satisfied', () => {
    const document = provingReport();
    const checks = document.checks as Record<string, unknown>;
    delete checks.base;

    const parsed = parseFormalReport(JSON.stringify(document));

    expect(parsed.ok).toBe(false);
  });
});

describe('refuted is sourced from the base case and never from induction', () => {
  it('reports proved when all five conditions hold', () => {
    expect(interpret(provingReport()).verdict).toBe('proved');
  });

  it('reports refuted for a FAILED base case carrying its counterexample', () => {
    const document = provingReport({ base: check({ status: 'FAILED' }) });

    const result = interpret(document, { [COUNTEREXAMPLE_ARTIFACT_KEY]: TRACE });

    expect(result.verdict).toBe('refuted');
    expect(result.verdict === 'refuted' && result.counterexample).toEqual(TRACE);
  });

  it('reports toolchain-unavailable for a FAILED base case with no counterexample', () => {
    const document = provingReport({ base: check({ status: 'FAILED' }) });

    expect(cause(interpret(document))).toBe('toolchain-unavailable');
  });

  it('reports the earlier condition, not refuted, when the assumptions are contradictory', () => {
    const document = provingReport({
      presat: check({ status: 'PREUNSAT' }),
      base: check({ status: 'FAILED' }),
    });

    const result = interpret(document, { [COUNTEREXAMPLE_ARTIFACT_KEY]: TRACE });

    expect(cause(result)).toBe('contradictory-assumptions');
  });

  it('never refutes a correct design whose inductive step failed', () => {
    const document = provingReport({ induct: check({ status: 'FAILED' }) });

    const result = interpret(document, { [COUNTEREXAMPLE_ARTIFACT_KEY]: TRACE });

    expect(cause(result)).toBe('induction-engine-incomplete');
  });

  it('names a bounded pass induction-inconclusive, apart from an engine incompleteness', () => {
    const document = provingReport({ induct: check({ inductionSuccessful: false }) });

    expect(cause(interpret(document))).toBe('induction-inconclusive');
  });

  it('prefers neither solver when the cross-check disagrees', () => {
    const document = provingReport({
      base: check({
        crossCheck: { solver: 'z3', exitCode: 1, status: 'FAILED', elapsedMs: 3 },
      }),
    });

    expect(cause(interpret(document))).toBe('toolchain-unavailable');
  });

  // The unreached arm carries `coverAnswered: true`, which is what the worker writes for a cover
  // that printed `Unreached cover statement`: the analysis ANSWERED, in the negative. The three-way
  // distinction that field makes possible - answered reached, answered unreached, answered nothing -
  // is asserted in `formal-interpreter-single-cases.test.ts`; what is asserted here is only that
  // the two ends of it do not collapse.
  it('distinguishes an unreached antecedent from a cover that answered nothing', () => {
    const unreached = provingReport({ cover: check({ status: 'FAILED', coverAnswered: true }) });
    const unrun = provingReport({ cover: { exitCode: null, status: null, elapsedMs: 0 } });

    expect(cause(interpret(unreached))).toBe('antecedent-unreached');
    expect(cause(interpret(unrun))).toBe('toolchain-unavailable');
  });
});
