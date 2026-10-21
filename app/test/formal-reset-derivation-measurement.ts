// formal-gate-first-light, Component 20: the Reset_Derivation_Measurement.
//
// WHAT IT ESTABLISHES
//   Whether the Reset_Contract_Prepass derives a contract for `LIFObuffer`, and if so whether it
//   derived one from a reset the parent spec's criterion 14.19 says must be REFUSED. Stage A
//   contradicted the prediction that this design refuses a reset; this measurement settles what
//   the derivation actually does and classifies the consequence.
//
// ONE RUN, SO THE CONTRACT AND THE CENSUS DESCRIBE ONE ELABORATION
//   Both `LIFObuffer` entries are decided in a single `proveSet`, and the contract is read off
//   that run's own `FormalOutcome.resetContract`. The cell census runs the worker's OWN pre-pass
//   script, asked for through the interpreter rather than restated, so the netlist it walks is the
//   one the pre-pass reads. Two scripts would let the census describe a netlist nobody proved over.
//
// IT RECORDS AND CLASSIFIES, AND IT DOES NOT FIX
//   The class came back a candidate breach, and FL-25 answered the fix direction with option (b):
//   the contract pins the enable too, and the parent's criterion 14.19 is AMENDED rather than
//   satisfied. That edit is task 4.30's, not this driver's: it still edits no pre-pass, worker, or
//   comment text, which is why the nine source comments are RE-READ on every run.
//
// Run with `npm run formal:reset-derivation`. No `.test.ts` suffix, so vitest never collects it.

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORMAL_ORACLE_VERSION } from '@app/agent';
import {
  localTimingDerivation,
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  probeToolchainVersions,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
  type ManifestToolchain,
} from '@app/eval';
import type { CouldNotVerifyCause, FormalVerdict, ProofConditions, ResetEnable } from '@app/tools';

import {
  adjudicate,
  describeAdjudication,
  isCandidateShape,
  recordContradiction,
  unadjudicated,
  type Adjudication,
  type CandidateFalseRefutation,
} from './formal-false-refutation.js';
import {
  classifyResetDerivation,
  isEnableGatedReset,
  requiresFixDirectionQuestion,
  type ResetCellEntry,
  type ResetDerivationClass,
} from './formal-reset-derivation-classify.js';
import { readResetClaims, type ResetClaimReading } from './formal-reset-derivation-comments.js';
import {
  readWorkerPrepassConstants,
  takeResetCellCensus,
  type CensusRefusal,
} from './formal-reset-derivation-census.js';
import { LIFO_BUFFER_ID, PROPERTY_FIXTURE, type FixtureProperty } from './formal-fixtures.js';
import {
  FORMAL_PROBE,
  PROBE,
  realFormalAdapter,
  realOracleAdapter,
} from './real-oracle-harness.js';

/** The reset facts the run derived, or the refusal. */
export interface DerivedResetFacts {
  readonly derived: boolean;
  readonly resetName: string | null;
  readonly resetKind: 'async' | 'sync' | null;
  readonly resetActiveLow: boolean | null;
  readonly initialStateFree: boolean | null;
  /**
   * The enable the reset fires under, recorded beside the kind and polarity (Req 4.17).
   *
   * ABSENT rather than null where the reset carries no enable, which is the same distinction the
   * contract makes: a missing key is "no enable was named", and `activeLow: false` would read as
   * "an enable asserted high".
   */
  readonly resetEnable?: ResetEnable;
}

/** One decided entry, with the conditions behind its verdict. */
export interface DecidedEntry {
  readonly propertyId: string;
  readonly criterionRef: string;
  readonly expectedVerdict: FormalVerdict;
  readonly verdict: FormalVerdict;
  readonly couldNotVerifyCause: CouldNotVerifyCause | null;
  readonly proofDepth: number;
  readonly conditions: ProofConditions;
  /** Present only where the verdict contradicted the author's expectation. */
  readonly contradiction: {
    readonly authorExpectedVerdict: FormalVerdict;
    readonly adjudication: Adjudication;
    readonly adjudicationDescription: string;
    readonly fixtureMayMove: boolean;
  } | null;
}

/** The whole measurement, as the committed record holds it. */
export interface ResetDerivationRecord {
  readonly schemaVersion: number;
  readonly measurementKind: 'reset-derivation';
  readonly designId: string;
  readonly formalOracleVersion: number;
  readonly toolchain: ManifestToolchain;
  readonly corpusCommit: string;
  /** No property here is model-authored, so this is zero rather than absent (Req 12.7). */
  readonly tokenCount: number;
  readonly elapsedWallClockMs: number;
  readonly reset: DerivedResetFacts;
  /** The rule that decided the outcome, named by the parent criterion it implements. */
  readonly decidingRule: string;
  readonly entries: readonly DecidedEntry[];
  readonly census:
    | { readonly kind: 'taken'; readonly cells: readonly ResetCellEntry[] }
    | { readonly kind: 'refused'; readonly reason: CensusRefusal };
  /** The enable-gated cells, which are what criterion 14.19 is about. */
  readonly enableGatedCells: readonly ResetCellEntry[];
  readonly classification: ResetDerivationClass;
  readonly sourceClaims: readonly ResetClaimReading[];
  /** Set where the class requires a decision before anything is fixed. */
  readonly openQuestion: string | null;
  /** Criterion 4.19's recorded gap, kept beside what the oracle actually returned. */
  readonly predictedRefutation: PredictedRefutation | null;
}

/**
 * Component 20's own `refuted` prediction for criterion 4.8's entry, beside the real outcome.
 *
 * Req 4.19 asks for the returned Could_Not_Verify_Cause beside the predicted verdict, so the
 * pairing lives in ONE field: a prediction recorded apart from its outcome is a prediction a
 * later reader has to go and match up, which is how the gap got lost the first time.
 */
export interface PredictedRefutation {
  readonly criterionRef: string;
  readonly predictedVerdict: FormalVerdict;
  readonly returnedVerdict: FormalVerdict;
  /** `null` where the entry was DECIDED, so no cause was returned to record. */
  readonly returnedCouldNotVerifyCause: CouldNotVerifyCause | null;
}

/** The entry whose author predicted a refutation, which is what Req 4.19 is about. */
const PREDICTED_REFUTATION_CRITERION = '4.8';

/** This record's own shape version. */
export const RESET_RECORD_SCHEMA_VERSION = 1;

/**
 * The rule that decided the outcome, in the derivation's FIXED order.
 *
 * Named by the parent criterion each step implements, so a reader can go to the rule rather than
 * infer it: the clock rule first, then the reset rule, then the initial-state rule.
 */
export function decidingRuleOf(reset: DerivedResetFacts, clockPolarity: string | null): string {
  if (clockPolarity === null) {
    return 'clock rule 14.30: no clock polarity was derived, so nothing downstream was reached';
  }
  if (!reset.derived) {
    return 'reset rule: no reset was derived, which is the refusal 14.19 describes';
  }
  if (reset.resetKind === 'async') {
    return 'reset rule 14.18: an asynchronous reset was derived';
  }
  return 'reset rule 14.17: a synchronous reset was derived';
}

/** Everything that would make the record unreadable, checked BEFORE it is written. */
export function resetRecordProblems(record: ResetDerivationRecord): readonly string[] {
  const problems: string[] = [];
  if (record.formalOracleVersion !== FORMAL_ORACLE_VERSION) {
    problems.push(
      `the record names Formal_Oracle_Version ${String(record.formalOracleVersion)}, not ${String(FORMAL_ORACLE_VERSION)}`,
    );
  }
  if (record.designId !== LIFO_BUFFER_ID) {
    problems.push(`${record.designId} is not the design this measurement is about`);
  }
  if (record.entries.length === 0) {
    problems.push('no entry was decided, so nothing was measured');
  }
  // The census's reading and the real run's contract must agree, or they describe two
  // elaborations and neither can be trusted about the other.
  const censusSaysGated = record.enableGatedCells.length > 0;
  if (
    record.classification === 'candidate-breach-14-19' &&
    !(record.reset.derived && censusSaysGated)
  ) {
    problems.push('the class claims a breach that the contract and the census do not jointly show');
  }
  if (record.classification === 'refusal-contradiction' && record.reset.derived) {
    problems.push('the class claims nothing was derived while the contract says otherwise');
  }
  if (requiresFixDirectionQuestion(record.classification) && record.openQuestion === null) {
    problems.push('a candidate breach was recorded with no open question naming the decision');
  }
  // Req 4.19: the entry whose author predicted a refutation is decided ALONGSIDE that
  // prediction, so a record holding the entry and not the pairing has lost the gap.
  const predicted = record.entries.some(
    (entry) => entry.criterionRef === PREDICTED_REFUTATION_CRITERION,
  );
  if (predicted && record.predictedRefutation === null) {
    problems.push(
      `criterion ${PREDICTED_REFUTATION_CRITERION} was decided with no predicted verdict recorded beside it`,
    );
  }
  return problems;
}

// -- The run ----------------------------------------------------------------

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, decided on evidence in either layout, as task 4.5's driver does. */
function repositoryRoot(): string {
  return resolve(HERE, ...new Array<string>(basename(HERE) === 'dist' ? 3 : 2).fill('..'));
}

/** The committed directory this measurement's record lands in, beside Component 5's. */
export const RESET_RECORD_DIRECTORY = join(
  repositoryRoot(),
  'measurements',
  'formal-reset-derivation',
);

/** The committed record's filename. */
export const RESET_RECORD_FILE_NAME = 'reset-derivation.json';

/** The record's absolute path. */
export const RESET_RECORD_PATH = join(RESET_RECORD_DIRECTORY, RESET_RECORD_FILE_NAME);

/** How long both entries get; a proof here is measured in seconds, not minutes. */
const RESET_BUDGET_MS = 600_000;

/** One file's text, or `null`, for the comment census. */
function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(resolve(repositoryRoot(), path), 'utf8');
  } catch {
    // An unreadable file is reported by the census as a claim still standing, never as cleared.
    return null;
  }
}

/** Run the measurement. Skip-gated by the caller on `FORMAL_PROBE`. */
export async function runResetDerivationMeasurement(): Promise<
  Omit<ResetDerivationRecord, 'sourceClaims'>
> {
  const startedAt = Date.now();
  const toolchain = probeToolchainVersions(FORMAL_PROBE.pythonBin);
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const reference = corpus.references.get(LIFO_BUFFER_ID);
  const problem = corpus.problems.find((candidate) => candidate.id === LIFO_BUFFER_ID);
  if (reference === undefined || problem === undefined) {
    throw new Error(`the pinned corpus has no reference or problem for ${LIFO_BUFFER_ID}`);
  }
  const designInterface = problem.spec.moduleInterface;
  const entries = PROPERTY_FIXTURE.filter((entry) => entry.designId === LIFO_BUFFER_ID);
  if (entries.length === 0) {
    throw new Error(`the Property_Fixture holds no entry for ${LIFO_BUFFER_ID}`);
  }

  // ONE run, so the contract and both verdicts come from one elaboration.
  const real = realFormalAdapter(FORMAL_PROBE.pythonBin);
  const outcome = await real.oracle.proveSet({
    designSource: reference.rtl,
    designInterface,
    properties: entries.map((entry) => entry.property),
    budgetMs: RESET_BUDGET_MS,
  });

  const contract = outcome.resetContract;
  const reset: DerivedResetFacts =
    contract !== null && contract.derived
      ? {
          derived: true,
          resetName: contract.resetName,
          resetKind: contract.resetKind,
          resetActiveLow: contract.resetActiveLow,
          initialStateFree: contract.initialStateFree,
          // A CONDITIONAL SPREAD, so an absent enable stays an absent KEY rather than becoming
          // one holding `undefined`; `exactOptionalPropertyTypes` enforces it.
          ...(contract.resetEnable === undefined ? {} : { resetEnable: contract.resetEnable }),
        }
      : {
          derived: false,
          resetName: null,
          resetKind: null,
          resetActiveLow: null,
          initialStateFree: null,
        };

  const decided: DecidedEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const result = outcome.results[index];
    if (result === undefined) {
      throw new Error(`the run returned no result for ${entry.property.id}`);
    }
    decided.push({
      propertyId: entry.property.id,
      criterionRef: entry.criterionRef,
      expectedVerdict: entry.expectedVerdict,
      verdict: result.verdict,
      couldNotVerifyCause: result.verdict === 'could-not-verify' ? result.cause : null,
      proofDepth: result.depth,
      conditions: result.verdict === 'proved' ? { ...result.evidence } : result.conditions,
      contradiction: await contradictionFor(
        real,
        reference.rtl,
        designInterface,
        entry,
        result,
        reset,
      ),
    });
  }

  const constants = readWorkerPrepassConstants(FORMAL_PROBE.pythonBin);
  const census =
    constants === null
      ? ({ kind: 'refused', reason: 'worker-constants-unreadable' } as const)
      : takeResetCellCensus(reference.rtl, designInterface.moduleName, constants);
  const cells = census.kind === 'taken' ? census.cells : [];
  const enableGatedCells = cells.filter(isEnableGatedReset);
  const classification = classifyResetDerivation({
    resetDerived: reset.derived,
    resetCells: cells,
  });

  return {
    schemaVersion: RESET_RECORD_SCHEMA_VERSION,
    measurementKind: 'reset-derivation',
    designId: LIFO_BUFFER_ID,
    formalOracleVersion: FORMAL_ORACLE_VERSION,
    toolchain,
    corpusCommit: RTLLM_PINNED_COMMIT,
    tokenCount: 0,
    elapsedWallClockMs: Date.now() - startedAt,
    reset,
    decidingRule: decidingRuleOf(reset, outcome.clockPolarity),
    entries: decided,
    census,
    enableGatedCells,
    classification,
    openQuestion: requiresFixDirectionQuestion(classification)
      ? 'FL-25, answered by section L of clarification-answers.md with option (b): the contract pins the enable too, and the parent criterion 14.19 is amended rather than satisfied'
      : null,
    predictedRefutation: predictedRefutationOf(decided),
  };
}

/** Criterion 4.8's entry as Req 4.19 records it, or `null` where that entry was not decided. */
function predictedRefutationOf(decided: readonly DecidedEntry[]): PredictedRefutation | null {
  const entry = decided.find(
    (candidate) => candidate.criterionRef === PREDICTED_REFUTATION_CRITERION,
  );
  return entry === undefined
    ? null
    : {
        criterionRef: entry.criterionRef,
        // Component 20's prediction, which is NOT the fixture's own `expectedVerdict` of `proved`.
        predictedVerdict: 'refuted',
        returnedVerdict: entry.verdict,
        returnedCouldNotVerifyCause: entry.couldNotVerifyCause,
      };
}

/** The contradiction a surprising verdict is recorded as, or `null` where there is none. */
async function contradictionFor(
  real: ReturnType<typeof realFormalAdapter>,
  design: Parameters<typeof adjudicate>[0]['design'],
  designInterface: Parameters<typeof adjudicate>[0]['designInterface'],
  entry: FixtureProperty,
  result: { readonly verdict: FormalVerdict } & Record<string, unknown>,
  reset: DerivedResetFacts,
): Promise<DecidedEntry['contradiction']> {
  if (result.verdict !== 'refuted' || !isCandidateShape(entry.expectedVerdict, result.verdict)) {
    return null;
  }
  const capture = result.counterexample as Parameters<typeof real.artifacts.readText>[0];
  const trace = await real.artifacts.readText(capture);
  const candidate: CandidateFalseRefutation = {
    propertyId: entry.property.id,
    designId: entry.designId,
    design,
    designInterface,
    expectedVerdict: entry.expectedVerdict,
    actualVerdict: result.verdict,
    counterexample: trace ?? '',
    resetContract:
      reset.resetKind === null
        ? null
        : { kind: reset.resetKind, polarity: reset.resetActiveLow ? 'active-low' : 'active-high' },
  };
  // `adjudicate` never produces `probe-unavailable`: it has a referee by its signature, so a
  // host with no iverilog is this caller's fact to report rather than dropping the candidate.
  const adjudication = PROBE.available
    ? await adjudicate(candidate, realOracleAdapter())
    : unadjudicated('probe-unavailable');
  const recorded = recordContradiction(candidate, adjudication);
  return {
    authorExpectedVerdict: recorded.authorExpectedVerdict,
    adjudication: recorded.adjudication,
    adjudicationDescription: describeAdjudication(recorded.adjudication),
    fixtureMayMove: recorded.fixtureMayMove,
  };
}

/** The reset facts for the console, enable included where one was named (Req 4.17). */
function describeReset(reset: DerivedResetFacts): string {
  if (!reset.derived) {
    return 'NOT derived';
  }
  const level = reset.resetActiveLow ? 'active-low' : 'active-high';
  const enable =
    reset.resetEnable === undefined
      ? ', no enable named'
      : `, enabled by ${reset.resetEnable.name} ${reset.resetEnable.activeLow ? 'active-low' : 'active-high'}`;
  return `DERIVED ${reset.resetName ?? '?'} ${reset.resetKind ?? '?'} ${level}${enable}`;
}

/** Write the record, after its check and never before it. */
async function writeRecord(record: ResetDerivationRecord): Promise<void> {
  await mkdir(RESET_RECORD_DIRECTORY, { recursive: true });
  await writeFile(RESET_RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** Run it, or report the reason it could not. A skip exits 0; a bad record exits 1 unwritten. */
async function main(): Promise<void> {
  if (!FORMAL_PROBE.available) {
    console.log(`Reset_Derivation_Measurement SKIPPED: ${FORMAL_PROBE.reason}`);
    return;
  }
  const base = await runResetDerivationMeasurement();
  const record: ResetDerivationRecord = {
    ...base,
    sourceClaims: readResetClaims(readTextOrNull),
  };
  const problems = resetRecordProblems(record);
  if (problems.length > 0) {
    console.error('Reset_Derivation record REFUSED, nothing was written:');
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  await writeRecord(record);
  console.log(
    `Reset_Derivation_Measurement on ${record.designId}, Formal_Oracle_Version ${String(record.formalOracleVersion)}:`,
  );
  console.log(`  reset: ${describeReset(record.reset)}`);
  console.log(`  deciding rule: ${record.decidingRule}`);
  for (const entry of record.entries) {
    const cause = entry.couldNotVerifyCause === null ? '' : `: ${entry.couldNotVerifyCause}`;
    console.log(
      `  ${entry.criterionRef} ${entry.propertyId}: ${entry.verdict}${cause} (author expected ${entry.expectedVerdict})`,
    );
  }
  console.log(
    `  census: ${record.census.kind === 'taken' ? `${String(record.census.cells.length)} reset cells, ${String(record.enableGatedCells.length)} enable-gated` : `REFUSED, ${record.census.reason}`}`,
  );
  console.log(`  CLASSIFICATION: ${record.classification}`);
  if (record.predictedRefutation !== null) {
    const { criterionRef, predictedVerdict, returnedVerdict, returnedCouldNotVerifyCause } =
      record.predictedRefutation;
    const cause = returnedCouldNotVerifyCause ?? 'none, the entry was decided';
    console.log(
      `  ${criterionRef} predicted ${predictedVerdict}, returned ${returnedVerdict}, cause ${cause}`,
    );
  }
  const live = record.sourceClaims.filter((claim) => claim.present);
  console.log(
    `  source claims still live: ${String(live.length)} of ${String(record.sourceClaims.length)}, ${String(live.filter((claim) => claim.namesLifoBuffer).length)} naming the design`,
  );
  if (record.openQuestion !== null) {
    console.log(`  OPEN QUESTION: ${record.openQuestion}`);
  }
  console.log(`Record: ${RESET_RECORD_PATH}`);
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`Reset_Derivation_Measurement failed: ${message}`);
    process.exitCode = 1;
  });
}
