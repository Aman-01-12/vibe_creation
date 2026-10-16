// formal-gate-first-light, Component 19: the Warm_Up_Boundary_Measurement (criteria 13.9 to
// 13.15, 13.20 to 13.22).
//
// WHAT THIS FILE HANDS TO THE DETERMINISTIC_ORACLE
//   Component 18 ships a Warm_Up_Ceiling of `FIRST_CLOCKED_RUNG - 1 - CLOCKED_CHECK_DELAY`. That
//   is a CLAIM about two things: where `yosys-smtbmc`'s base case stops, read from the installed
//   0.69 script, and the one-step delay a clocked check is reported with, measured on 0.66. No
//   proof at the ceiling has decided either on this toolchain. The ceiling-deep boundary pair over
//   `counter_12` decides them here: both halves either land at the first clocked rung or they do
//   not, and the toolchain says which.
//
// WHY THE REACHED STEP IS ASSERTED AND NOT JUST THE TWO VERDICTS
//   At a ceiling of 18 the delay model and a no-delay model predict the SAME pair of verdicts, so
//   the verdicts alone cannot separate them. The guarded half's cover carries the gate terms, so
//   it first opens at the state-18 sample and is reported one step later, at the first rung minus
//   one. A different step is a toolchain whose step semantics moved, and it reopens FL-21 on that
//   evidence rather than being tuned away (criterion 13.20).
//
// PREDICTED, NOT A RESULT
//   At the ceiling of 18 both halves are predicted to decide at rung 20 - `proved` and `refuted` -
//   with the cover reported at step 19. This file does not assume that; it reports what came back.
//
// IT PERSISTS NO Measurement_Record
//   Its output is the pass-or-fail report. Every failure message carries the observed verdict, the
//   Proof_Depth, the reached step, the Proof_Conditions, this host's Toolchain_Provenance and
//   `FORMAL_ORACLE_VERSION`, so a failure is placeable without a written record.
//
// THE ENABLE-GATED PAIR BELOW IS A SECOND MEASUREMENT IN THE SAME FILE
//   It measures the emitted RESET ASSUME rather than the Warm_Up_Ceiling, and it is here because
//   FL-25 widens that assume and over-constraining is the false-proof direction. See its own
//   section for why it lands before the change and why it reads the assume as text.
//
// SKIP
//   Gated on `FORMAL_PROBE.available` rather than on `probeFormalToolchainAvailability()` alone,
//   because the decision runs through the sandbox worker and so needs the worker Python too.

import { describe, expect, it } from 'vitest';

import { FORMAL_ORACLE_VERSION } from '@app/agent';
import type { ModuleInterface } from '@app/core';
import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  probeToolchainVersions,
  RTLLM_CHECKOUT_PATH,
  type ManifestToolchain,
} from '@app/eval';
import {
  CLOCKED_DEPTH_LADDER,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  type CoverCondition,
  type FormalVerdict,
  type PropertyResult,
  type SourceFile,
} from '@app/tools';

import {
  COUNTER_12_ID,
  LIFO_BUFFER_ID,
  PROPERTY_FIXTURE,
  type FixtureProperty,
} from './formal-fixtures.js';
import { FORMAL_PROBE, realFormalAdapter } from './real-oracle-harness.js';

// -- The boundary the pair measures -----------------------------------------

/**
 * The first clocked rung, read from the shipped ladder rather than restated as 20.
 *
 * `.at(0)` reads as `number | undefined`, and a fallback would be a second ceiling nothing
 * justifies, so an empty ladder fails the load here naming what it left unmeasurable.
 */
const FIRST_RUNG = CLOCKED_DEPTH_LADDER.at(0);
if (FIRST_RUNG === undefined) {
  throw new Error('the clocked ladder declares no rung, so there is no boundary to measure');
}

/**
 * The step the guarded half's cover is expected at: the first rung minus one.
 *
 * The last step that rung's cover check reaches, under the one-step clocked check delay. Without
 * the delay the same sample would be reported one step lower, which is the difference this
 * measurement exists to see.
 */
const EXPECTED_COVER_STEP = FIRST_RUNG - 1;

/** The criterion each half of the pair answers, which is how the fixture entry is found. */
const GUARDED_CRITERION = '13.9';
const UNCONDITIONAL_CRITERION = '13.10';

/** Measured sub-second per decision on a 4-bit state; the bound is for a climb, not the proof. */
const DECISION_TIMEOUT_MS = 180_000;

// -- Reading the host design and the pair -----------------------------------

/** The corpus is read only where a decision can actually be made. */
const CORPUS = FORMAL_PROBE.available
  ? await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH))
  : null;

/** The host design as the adapter needs it: its source and its declared interface. */
interface BoundaryDesign {
  readonly rtl: SourceFile;
  readonly moduleInterface: ModuleInterface;
}

/** One corpus design from the pinned checkout, or a throw naming what the checkout did not carry. */
function namedDesign(designId: string): BoundaryDesign {
  const reference = CORPUS?.references.get(designId);
  const problem = CORPUS?.problems.find((candidate) => candidate.id === designId);
  if (reference === undefined || problem === undefined) {
    throw new Error(`the pinned checkout carries no reference and problem for ${designId}`);
  }
  return { rtl: reference.rtl, moduleInterface: problem.spec.moduleInterface };
}

/** One fixture entry, or a throw naming the criterion the fixture does not answer. */
function fixtureEntry(designId: string, criterionRef: string): FixtureProperty {
  const entry = PROPERTY_FIXTURE.find(
    (candidate) => candidate.designId === designId && candidate.criterionRef === criterionRef,
  );
  if (entry === undefined) {
    throw new Error(`the fixture carries no ${designId} entry for criterion ${criterionRef}`);
  }
  return entry;
}

// -- Stating an observation so a failure is placeable -----------------------

/** The Cover_Check a result recorded, whichever member carries it. */
function recordedCover(result: PropertyResult): CoverCondition {
  return result.verdict === 'proved' ? result.evidence.cover : result.conditions.cover;
}

/** The step a cover reached, or the unreached arm it landed on instead. */
function statedStep(cover: CoverCondition): string {
  return cover.reached === true ? String(cover.step) : `unreached(${String(cover.reached)})`;
}

/** This host's Toolchain_Provenance, probed once and only where a decision runs. */
let probedToolchain: ManifestToolchain | null = null;
function toolchain(): ManifestToolchain {
  probedToolchain ??= probeToolchainVersions(FORMAL_PROBE.pythonBin);
  return probedToolchain;
}

/**
 * Everything a failure needs to be placed: the observation, the instrument, and the host.
 *
 * Built BEFORE any assertion and from the result alone, so a run that fails on its verdict or on
 * its depth still names the step it reached.
 */
function stated(result: PropertyResult): string {
  const conditions = result.verdict === 'proved' ? result.evidence : result.conditions;
  return [
    `verdict=${result.verdict}`,
    `proofDepth=${String(result.depth)}`,
    `reachedStep=${statedStep(recordedCover(result))}`,
    `conditions=${JSON.stringify(conditions)}`,
    `toolchain=${JSON.stringify(toolchain())}`,
    `formalOracleVersion=${String(FORMAL_ORACLE_VERSION)}`,
  ].join(', ');
}

// -- The measurement --------------------------------------------------------

/** One decided half, with the two facts both halves are held to already asserted. */
interface DecidedHalf {
  readonly result: PropertyResult;
  readonly context: string;
}

/**
 * Decide one half through the real adapter, then assert its verdict and its Proof_Depth.
 *
 * A fresh adapter per half, as every other real-formal suite builds one, so neither half's
 * artifact retention can resolve a ref the other filled.
 */
async function decide(criterionRef: string): Promise<DecidedHalf> {
  const entry = fixtureEntry(COUNTER_12_ID, criterionRef);
  const design = namedDesign(COUNTER_12_ID);
  const real = realFormalAdapter(FORMAL_PROBE.pythonBin);
  const result = await real.oracle.prove({
    designSource: design.rtl,
    designInterface: design.moduleInterface,
    property: entry.property,
    budgetMs: DEFAULT_PROPERTY_TIME_BUDGET_MS,
  });
  const context = stated(result);

  expect(result.verdict, context).toBe(entry.expectedVerdict);
  // A deeper rung means the gate evaluated nothing at the first one, so the ceiling is one long.
  expect(result.depth, context).toBe(FIRST_RUNG);
  return { result, context };
}

describe.skipIf(!FORMAL_PROBE.available)(
  'the Warm_Up_Boundary_Measurement decides the Warm_Up_Ceiling at the first clocked rung',
  () => {
    it(
      'proves the guarded half at the first rung with its cover reached one step below it',
      async () => {
        const { result, context } = await decide(GUARDED_CRITERION);
        // The expect above throws on a mismatch, so this only narrows for the cover read.
        if (result.verdict !== 'proved') {
          return;
        }
        const cover = result.evidence.cover;

        // An unreached cover is the ladder's climb signal, and `not-applicable` would mean the
        // guarded half lost its antecedent and with it the only read that sees the step delay.
        expect(statedStep(cover), context).toBe(String(EXPECTED_COVER_STEP));
      },
      DECISION_TIMEOUT_MS,
    );

    it(
      'refutes the unconditional half at the first rung with a Counterexample',
      async () => {
        const { result, context } = await decide(UNCONDITIONAL_CRITERION);
        if (result.verdict !== 'refuted') {
          return;
        }

        // Criterion 2.7: a refutation reported without its Counterexample is not a refutation.
        expect(result.counterexample.sizeBytes, context).toBeGreaterThan(0);
      },
      DECISION_TIMEOUT_MS,
    );
  },
);

// -- The enable-gated extension (criteria 13.21, 13.22) ---------------------
//
// FL-25 widens `resetAssumeLine` to assert an enabling signal beside the reset. A widened assume
// constrains the solver further, and over-constraining is the FALSE-PROOF direction: an assume
// that excludes a reachable path turns a false property into a vacuous pass, which is the one
// failure no verdict announces. So this pair lands BEFORE that change, and it reads the emitted
// assume as TEXT - `ResetContract` carries no enable yet, so a field read could not compile today
// and a pair written after the change could not witness it.

/** The criterion the new half answers: false on the design, so no assume may prove it. */
const ENABLE_GATED_FALSE_CRITERION = '13.21';

/** The criterion the existing half answers: the half the contract change is meant to move. */
const RESET_DEPENDENT_CRITERION = '4.8';

/**
 * The names the reset assume line spells that are not signals it pins.
 *
 * `$initstate` is the step-0 guard the line is written as an implication over, and the other two
 * are the statement itself; every other name on that line is a signal being assumed.
 */
const ASSUME_VOCABULARY: ReadonlySet<string> = new Set(['assume', 'property', '$initstate']);

/** The reset assume one rendered wrapper carries, or `null` where it carries none. */
function emittedResetAssume(wrapper: string): string | null {
  return wrapper.split('\n').find((line) => line.includes('assume property')) ?? null;
}

/**
 * Whether the emitted assume pins a second signal beside the reset: the widened shape.
 *
 * Read as text rather than off a contract field, for the reason the section header gives. A
 * widened line names the enable as well as the reset, so one unrecognised identifier is the whole
 * signal this reading needs (criterion 13.22).
 */
function assertsSecondSignal(assumeLine: string, resetName: string): boolean {
  return [...assumeLine.matchAll(/\$?[A-Za-z_][A-Za-z0-9_$]*/g)]
    .map((match) => match[0])
    .some((name) => !ASSUME_VOCABULARY.has(name) && name !== resetName);
}

/** A false property cannot be proved by narrowing the assume, so this half does not branch. */
const FALSE_UNDER_EITHER_ASSUME: readonly FormalVerdict[] = ['refuted'];

/**
 * A failed Base_Check, under both verdicts it can be reported as.
 *
 * `refuted` where the Counterexample was readable, and `could-not-verify` where it was not, which
 * criterion 2.7's fail-safe reports rather than a refutation stripped of its evidence. Both say
 * the base case failed, which is what the narrow assume admits by leaving the enable free.
 */
const BASE_CHECK_FAILED: readonly FormalVerdict[] = ['refuted', 'could-not-verify'];

/**
 * The Formal_Verdicts one half may land on, computed from the EMITTED assume (criterion 13.22).
 *
 * @param criterionRef The criterion the half answers, which is what its expectation is keyed on.
 * @param widenedAssume Whether the emitted assume pinned a second signal beside the reset.
 * @returns Every verdict admissible for that half under that assume; one entry where it is exact.
 */
function expectedVerdicts(criterionRef: string, widenedAssume: boolean): readonly FormalVerdict[] {
  if (criterionRef === ENABLE_GATED_FALSE_CRITERION) {
    // Invariant across the branch, and that is the whole point: this half is false on the design,
    // so a widened assume returning anything but `refuted` has excluded a reachable path.
    return FALSE_UNDER_EITHER_ASSUME;
  }
  // The reset-dependent half's truth needs a reset step that actually fired. The narrow assume
  // pins the reset and leaves the enable free, so the assumed step need not fire and the base case
  // can fail; the widened assume makes it fire, which is the move the contract change is for.
  return widenedAssume ? ['proved'] : BASE_CHECK_FAILED;
}

/** One enable-gated half as decided, against the expectation its own wrapper text produced. */
interface EnableGatedHalf {
  readonly result: PropertyResult;
  readonly expected: readonly FormalVerdict[];
  readonly context: string;
}

/**
 * Decide both enable-gated halves in ONE run, keyed by the criterion each answers.
 *
 * One `proveSet` rather than two `prove` calls, for two reasons: one pre-pass derives the single
 * contract both expectations are computed from, and `FormalOutcome` hands back the wrapper text
 * the solver actually ran on, so the assume read here is not a second render that could disagree
 * with the submitted one.
 */
async function decideEnableGatedPair(): Promise<ReadonlyMap<string, EnableGatedHalf>> {
  const design = namedDesign(LIFO_BUFFER_ID);
  const criteria = [ENABLE_GATED_FALSE_CRITERION, RESET_DEPENDENT_CRITERION];
  const real = realFormalAdapter(FORMAL_PROBE.pythonBin);
  const outcome = await real.oracle.proveSet({
    designSource: design.rtl,
    designInterface: design.moduleInterface,
    properties: criteria.map((criterionRef) => fixtureEntry(LIFO_BUFFER_ID, criterionRef).property),
    budgetMs: DEFAULT_PROPERTY_TIME_BUDGET_MS,
  });

  const contract = outcome.resetContract;
  if (contract === null || !contract.derived) {
    throw new Error(
      `the pre-pass derived no Reset_Contract for ${LIFO_BUFFER_ID}, so no reset assume was ` +
        `emitted for either half's expectation to be computed from`,
    );
  }

  const halves = new Map<string, EnableGatedHalf>();
  for (const [index, criterionRef] of criteria.entries()) {
    const result = outcome.results[index];
    const wrapper = outcome.propertyWrapperSources[index] ?? null;
    if (result === undefined || wrapper === null) {
      throw new Error(`the run returned no result and wrapper for criterion ${criterionRef}`);
    }
    const assumeLine = emittedResetAssume(wrapper);
    if (assumeLine === null) {
      throw new Error(
        `the wrapper for criterion ${criterionRef} carries no reset assume under a derived ` +
          `contract, so there is no emitted text to compute an expectation from`,
      );
    }
    halves.set(criterionRef, {
      result,
      expected: expectedVerdicts(criterionRef, assertsSecondSignal(assumeLine, contract.resetName)),
      context: `${stated(result)}, resetAssume=${assumeLine.trim()}`,
    });
  }
  return halves;
}

/** The pair's one run, memoised: one run is what makes the two halves one reading. */
let decidedPair: Promise<ReadonlyMap<string, EnableGatedHalf>> | null = null;

/** One decided half, or a throw naming the criterion the run did not carry a half for. */
async function enableGatedHalf(criterionRef: string): Promise<EnableGatedHalf> {
  decidedPair ??= decideEnableGatedPair();
  const half = (await decidedPair).get(criterionRef);
  if (half === undefined) {
    throw new Error(`the enable-gated run decided no half for criterion ${criterionRef}`);
  }
  return half;
}

describe.skipIf(!FORMAL_PROBE.available)(
  'the Warm_Up_Boundary_Measurement decides an enable-gated reset assume from its emitted text',
  () => {
    it(
      'refutes the false half, which no reset assume may turn into a proof',
      async () => {
        const half = await enableGatedHalf(ENABLE_GATED_FALSE_CRITERION);

        // A `proved` here, or a `could-not-verify` with `induction-engine-incomplete`, is a reset
        // assume that excluded a reachable path on a property whose falsity is not in question.
        expect(half.expected, half.context).toContain(half.result.verdict);
        expect(half.result.depth, half.context).toBe(FIRST_RUNG);
        if (half.result.verdict !== 'refuted') {
          return;
        }

        // Criterion 2.7: a refutation reported without its Counterexample is not a refutation.
        expect(half.result.counterexample.sizeBytes, half.context).toBeGreaterThan(0);
      },
      DECISION_TIMEOUT_MS,
    );

    it(
      'decides the reset-dependent half as the emitted assume admits',
      async () => {
        const half = await enableGatedHalf(RESET_DEPENDENT_CRITERION);

        expect(half.expected, half.context).toContain(half.result.verdict);
        expect(half.result.depth, half.context).toBe(FIRST_RUNG);
      },
      DECISION_TIMEOUT_MS,
    );
  },
);

if (!FORMAL_PROBE.available) {
  console.warn(
    `[formal-warm-up-boundary] The Warm_Up_Ceiling of ${String(EXPECTED_COVER_STEP)} was NOT ` +
      `decided on this host: ${FORMAL_PROBE.reason}. Component 18's claim stands unmeasured here.`,
  );
}
