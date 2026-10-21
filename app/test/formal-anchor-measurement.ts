// formal-gate-first-light, Component 5: the Scaling_Anchor measurement and its Budget_Observation.
//
// WHAT THIS MEASURES
//   Each of the three Scaling_Anchors is decided TWICE - once under the shipped 150 s
//   Property_Time_Budget the Student_Path actually runs under, and once under a flat 1800 s
//   ceiling - so the 150 s default is sized against observed cost rather than against an
//   inherited table. Six Budget_Observations, two per anchor.
//
// WHY A SEPARATE SCRIPT AND NOT THE DEFAULT SUITE
//   A 1800 s proof in the everyday gate would stop engineers running the gate, and a gate people
//   skip measures nothing. That is a quality argument and not a compute one. This file carries no
//   `.test.ts` suffix, so `vitest` never collects it; `npm run formal:anchors` runs it.
//
// EVERY CEILING IS A DECLARED Measurement_Limit, NEVER A BARE NUMBER
//   `ceiling` is the `MeasurementLimit` itself, so the reason a figure was taken under a bound
//   travels with the figure and there is no second place to look it up. The 1800 s ceiling is
//   declared flat with `termination` as its reason, rather than derived from the 150 s reading,
//   because deriving it would make it a function of a cost figure.
//
// AN UNDECIDED ANCHOR IS A RESULT AND NOT A FAILED CHECK
//   A `could-not-verify` inside its ceiling is recorded with the cause the run reported and
//   reported as measured. Only a verdict NO oracle invocation produced is Not_Measured.
//
// WHY `elapsedMs` IS THIS DRIVER'S OWN CLOCK
//   The adapter's reported `elapsedMs` keeps only its last ladder rung's time and never adds the
//   pre-pass, so it under-reports; see the chipAgent note on the Session_Budget under-charge. The
//   wall clock either side of the invocation is the figure criterion 3.5 asks for.
//
// THE PREDICTION, STATED BEFORE THE RUN AND NOT AS A RESULT
//   Under 150 s `multi_16bit` is expected to time out and `multi_booth_8bit` may, because its
//   cross-check alone repeats the inherited 117.3 s. Under 1800 s `multi_booth_8bit` is expected
//   `proved` with its cover reached, and `multi_16bit` is genuinely unknown - `proved` there is
//   its author's belief and that shape has never been measured. A contradiction with either
//   prediction, or with the inherited 2.09 s / 65.6 s / over-900 s figures, is RECORDED.

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModuleInterface } from '@app/core';
import { FORMAL_ORACLE_VERSION } from '@app/agent';
import {
  localTimingDerivation,
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  limitOrRefuse,
  probeToolchainVersions,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
  type ManifestToolchain,
  type MeasurementLimit,
} from '@app/eval';
import {
  assembleFormalPrepassJob,
  readFormalPrepassReport,
  type CouldNotVerifyCause,
  type FormalVerdict,
  type ProofConditions,
  type PropertyResult,
  type ResourceLimits,
  type SourceFile,
} from '@app/tools';

import {
  adjudicate,
  describeAdjudication,
  isCandidateShape,
  recordContradiction,
  unadjudicated,
  type Adjudication,
  type CandidateFalseRefutation,
  type CandidateResetContract,
} from './formal-false-refutation.js';
import { PROPERTY_FIXTURE, SCALING_ANCHOR_IDS, type FixtureProperty } from './formal-fixtures.js';
import {
  FORMAL_CAPS,
  FORMAL_PROBE,
  PROBE,
  realFormalAdapter,
  realOracleAdapter,
  type RealFormalOracle,
} from './real-oracle-harness.js';

// -- The record shape -------------------------------------------------------

/** One anchor decided once, under one named ceiling. */
export interface BudgetObservation {
  readonly designId: string;
  readonly verdict: FormalVerdict;
  readonly proofDepth: number;
  /** This driver's own wall clock around the invocation, in ms (Req 3.5, 12.7). */
  readonly elapsedMs: number;
  /** The limit the figure was taken under, carrying its Limit_Reason (Req 3.6, 3.7). */
  readonly ceiling: MeasurementLimit;
  /** Present exactly when the verdict is `could-not-verify` (Req 3.9). */
  readonly couldNotVerifyCause: CouldNotVerifyCause | null;
  readonly toolchain: ManifestToolchain;
  /** The Formal_Oracle_Version the verdict was decided under (Req 8.9). */
  readonly formalOracleVersion: number;
}

/**
 * A contradiction as the COMMITTED record carries it.
 *
 * A projection of `ContradictionRecord` rather than that type itself, because the candidate holds
 * the unmodified design and its counterexample trace, and the Property_Fixture carries no Verilog
 * source for any design it covers (Req 2.9). The adjudication survives whole: its evidence is
 * refs and check names, never bytes.
 */
export interface RecordedContradiction {
  readonly propertyId: string;
  readonly designId: string;
  /** The verdict as its AUTHOR stated it, never rewritten by an adjudication. */
  readonly authorExpectedVerdict: FormalVerdict;
  readonly actualVerdict: FormalVerdict;
  readonly resetContract: CandidateResetContract | null;
  readonly adjudication: Adjudication;
  /** Operator-facing words for the adjudication, so a reader needs no second lookup. */
  readonly adjudicationDescription: string;
  readonly fixtureMayMove: boolean;
}

/**
 * What one attempt produced: a Budget_Observation, or the reason no oracle invocation produced one.
 *
 * A union rather than a nullable observation beside a nullable reason, so "measured with no
 * verdict" and "not measured with a verdict" are not representable - the discipline
 * `Adjudication` and `ProbedVersion` both follow. The `not-measured` arm carries the ceiling
 * itself, so every attempt names its ceiling from exactly one place.
 */
export type AnchorOutcome =
  | {
      readonly kind: 'measured';
      readonly observation: BudgetObservation;
      /** The five conditions behind the verdict, whatever the verdict (Req 11.3). */
      readonly conditions: ProofConditions;
      /** Whether a Counterexample came back with the verdict (Req 2.7). */
      readonly counterexampleReturned: boolean;
      /** Recorded where the verdict contradicted the author's (Req 11.4). */
      readonly contradiction: RecordedContradiction | null;
    }
  | {
      readonly kind: 'not-measured';
      readonly ceiling: MeasurementLimit;
      /** Why no Formal_Verdict is traceable to a Deterministic_Oracle invocation (Req 11.2). */
      readonly reason: string;
    };

/** One anchor's attempt under one ceiling, with the fixture identity it was taken over. */
export interface AnchorDecision {
  readonly designId: string;
  readonly propertyId: string;
  /** The acceptance criterion the Fixture_Property answers, which is how a figure is attributed. */
  readonly criterionRef: string;
  /** The verdict the Fixture_Property's author stated; this driver never rewrites it (Req 11.5). */
  readonly expectedVerdict: FormalVerdict;
  readonly outcome: AnchorOutcome;
}

/** The whole measurement, as the committed record holds it. */
export interface AnchorMeasurementRecord {
  readonly schemaVersion: number;
  readonly measurementKind: 'scaling-anchor';
  /** The version every verdict below was decided under (Req 8.9). */
  readonly formalOracleVersion: number;
  /** The toolchain that decided them (Req 3.10, 8.5). */
  readonly toolchain: ManifestToolchain;
  /** Every limit this measurement ran under, each naming its Limit_Reason (Req 12.5). */
  readonly limits: readonly MeasurementLimit[];
  /** Model tokens spent: no property here was model-authored, so this is zero (Req 12.7). */
  readonly tokenCount: number;
  /** The whole measurement's elapsed wall clock, as provenance (Req 12.7). */
  readonly elapsedWallClockMs: number;
  readonly decisions: readonly AnchorDecision[];
}

/** This record's own shape version, bumped when a reader of an older file would misread a newer. */
export const ANCHOR_RECORD_SCHEMA_VERSION = 1;

/** The criterion whose Fixture_Property states each anchor's exact arithmetic result (Req 3.2). */
export const ANCHOR_CRITERION_REF = '3.2';

/** The two ceilings every anchor is measured under, by their `DECLARED_LIMITS` names. */
export const ANCHOR_CEILING_NAMES: readonly string[] = Object.freeze([
  'shipped-property-time-budget',
  'uncapped-property-time-budget',
]);

/** The Proof_Depth limit the measurement runs at, recorded so its reason travels with it. */
const PROOF_DEPTH_LIMIT_NAME = 'proof-depth';

// -- The pre-write check ----------------------------------------------------

/** The ceiling one attempt ran under, from whichever arm of the outcome holds it. */
export function ceilingOf(outcome: AnchorOutcome): MeasurementLimit {
  return outcome.kind === 'measured' ? outcome.observation.ceiling : outcome.ceiling;
}

/**
 * Everything wrong with one anchor's attempts, or an empty list.
 *
 * Checked over the two ATTEMPTS rather than over the two observations, because a host that
 * refused an invocation still owes a reader both ceilings; the record's own
 * `formalOracleVersion` places a `not-measured` attempt on one side of the version move.
 *
 * No Limit_Reason check here: `ceiling` is a `MeasurementLimit`, which carries exactly one reason
 * from the vocabulary by its own type, and `measurement-limit-reasons.property.test.ts` already
 * asserts that over the whole registry.
 */
function anchorProblems(
  designId: string,
  decisions: readonly AnchorDecision[],
  expectedVersion: number,
): readonly string[] {
  const mine = decisions.filter((decision) => decision.designId === designId);
  if (mine.length !== ANCHOR_CEILING_NAMES.length) {
    return [
      `${designId} has ${String(mine.length)} attempts, not ${String(ANCHOR_CEILING_NAMES.length)}`,
    ];
  }
  const problems: string[] = [];
  const names = mine.map((decision) => ceilingOf(decision.outcome).name);
  for (const expected of ANCHOR_CEILING_NAMES) {
    if (!names.includes(expected)) {
      problems.push(`${designId} has no attempt under the ceiling "${expected}"`);
    }
  }
  for (const { outcome } of mine) {
    if (
      outcome.kind === 'measured' &&
      outcome.observation.formalOracleVersion !== expectedVersion
    ) {
      problems.push(
        `${designId} under "${outcome.observation.ceiling.name}" names Formal_Oracle_Version ` +
          `${String(outcome.observation.formalOracleVersion)}, not ${String(expectedVersion)}`,
      );
    }
  }
  return problems;
}

/**
 * Everything that would make the record unreadable, or an empty list.
 *
 * The driver calls this BEFORE it writes, so a record that cannot be placed against a ceiling's
 * reason or against a Formal_Oracle_Version is never committed - which is why `expectedVersion`
 * defaults to the current one.
 *
 * A reader of an ALREADY COMMITTED record passes the version that record was taken under instead:
 * a record is never rewritten to a later version, because saying which gate decided it is the
 * whole point of the field, so checking a version-2 record against version 3 would ask it to lie.
 */
export function anchorRecordProblems(
  record: AnchorMeasurementRecord,
  expectedVersion: number = FORMAL_ORACLE_VERSION,
): readonly string[] {
  const problems = [...SCALING_ANCHOR_IDS].flatMap((designId) =>
    anchorProblems(designId, record.decisions, expectedVersion),
  );
  if (record.formalOracleVersion !== expectedVersion) {
    problems.push(
      `the record names Formal_Oracle_Version ${String(record.formalOracleVersion)}, ` +
        `not ${String(expectedVersion)}`,
    );
  }
  const strays = record.decisions
    .map((decision) => decision.designId)
    .filter((designId) => !SCALING_ANCHOR_IDS.includes(designId));
  for (const stray of new Set(strays)) {
    problems.push(`${stray} is not a Scaling_Anchor, so it has no place in this record`);
  }
  return problems;
}

// -- Reading one decision ---------------------------------------------------

/** One corpus design as the oracle takes it: its source, and its declared interface. */
interface FormalDesign {
  readonly source: SourceFile;
  readonly moduleInterface: ModuleInterface;
}

/** The five conditions behind a verdict; a proof's `evidence` holds them in admitting form. */
function conditionsOf(result: PropertyResult): ProofConditions {
  return result.verdict === 'proved' ? { ...result.evidence } : result.conditions;
}

/** The cause a `could-not-verify` reported, and `null` for every other verdict (Req 3.9). */
function causeOf(result: PropertyResult): CouldNotVerifyCause | null {
  return result.verdict === 'could-not-verify' ? result.cause : null;
}

/** How long the pre-pass behind a contradiction may run; it is measured at roughly 0.7 s. */
const PREPASS_WALL_MS = 60_000;

/** The Reset_Contract the real pre-pass derived for one design, or `null` where it derived none. */
async function derivedResetContract(
  real: RealFormalOracle,
  design: FormalDesign,
): Promise<CandidateResetContract | null> {
  const limits: ResourceLimits = { ...FORMAL_CAPS, wallMs: PREPASS_WALL_MS };
  const job = assembleFormalPrepassJob(design.source, design.moduleInterface, limits);
  const submitted = await real.toolRunner.run(job);
  const artifact = submitted.artifacts[job.requiredOutputs.at(0) ?? ''];
  const text = artifact === undefined ? null : await real.artifacts.readText(artifact);
  const report = readFormalPrepassReport(text ?? '');
  if (!report.ok || !report.value.reset.derived) {
    return null;
  }
  const { resetKind, resetActiveLow } = report.value.reset;
  return { kind: resetKind, polarity: resetActiveLow ? 'active-low' : 'active-high' };
}

/**
 * The contradiction a surprising refutation is recorded as, or `null` where there is none.
 *
 * Reached only on the `proved` expected / `refuted` returned shape, so the pre-pass submission it
 * needs for the Reset_Contract is paid on the rare path and not on every decision. An empty
 * counterexample text resolves no name, which `adjudicate` already reports as
 * `name-unresolvable-in-scope` - no special case needed for a trace the store could not hand back.
 */
async function contradictionOf(
  real: RealFormalOracle,
  design: FormalDesign,
  entry: FixtureProperty,
  result: PropertyResult,
): Promise<RecordedContradiction | null> {
  if (result.verdict !== 'refuted' || !isCandidateShape(entry.expectedVerdict, result.verdict)) {
    return null;
  }
  const counterexample = await real.artifacts.readText(result.counterexample);
  const candidate: CandidateFalseRefutation = {
    propertyId: entry.property.id,
    designId: entry.designId,
    design: design.source,
    designInterface: design.moduleInterface,
    expectedVerdict: entry.expectedVerdict,
    actualVerdict: result.verdict,
    counterexample: counterexample ?? '',
    resetContract: await derivedResetContract(real, design),
  };
  // `adjudicate` never produces `probe-unavailable`: it has a referee by its signature, so a host
  // with no iverilog is this caller's fact to report.
  const adjudication = PROBE.available
    ? await adjudicate(candidate, realOracleAdapter())
    : unadjudicated('probe-unavailable');
  const recorded = recordContradiction(candidate, adjudication);
  return {
    propertyId: candidate.propertyId,
    designId: candidate.designId,
    authorExpectedVerdict: recorded.authorExpectedVerdict,
    actualVerdict: candidate.actualVerdict,
    resetContract: candidate.resetContract,
    adjudication: recorded.adjudication,
    adjudicationDescription: describeAdjudication(recorded.adjudication),
    fixtureMayMove: recorded.fixtureMayMove,
  };
}

/** The fixture identity every attempt over one entry carries, measured or not. */
function identityOf(entry: FixtureProperty): Omit<AnchorDecision, 'outcome'> {
  return {
    designId: entry.designId,
    propertyId: entry.property.id,
    criterionRef: entry.criterionRef,
    expectedVerdict: entry.expectedVerdict,
  };
}

/**
 * Decide one anchor's Fixture_Property once, under one ceiling.
 *
 * The decision goes through the real adapter over the sandbox worker - the Property_Renderer and
 * the Formal_Oracle the Student_Path uses (Req 3.15) - so no part of the gate is re-implemented
 * here and the Proof_Depth is the ladder's own first rung rather than a number this file picked.
 */
export async function measureAnchor(
  real: RealFormalOracle,
  design: FormalDesign,
  entry: FixtureProperty,
  run: { readonly ceiling: MeasurementLimit; readonly toolchain: ManifestToolchain },
): Promise<AnchorDecision> {
  const startedAt = Date.now();
  let result: PropertyResult;
  try {
    result = await real.oracle.prove({
      designSource: design.source,
      designInterface: design.moduleInterface,
      property: entry.property,
      budgetMs: run.ceiling.value,
    });
  } catch {
    // Dropped rather than surfaced: an adapter rejection can quote the design source.
    return {
      ...identityOf(entry),
      outcome: {
        kind: 'not-measured',
        ceiling: run.ceiling,
        reason: 'the Formal_Oracle invocation threw, so no verdict is traceable to it',
      },
    };
  }
  return {
    ...identityOf(entry),
    outcome: {
      kind: 'measured',
      observation: {
        designId: entry.designId,
        verdict: result.verdict,
        proofDepth: result.depth,
        elapsedMs: Date.now() - startedAt,
        ceiling: run.ceiling,
        couldNotVerifyCause: causeOf(result),
        toolchain: run.toolchain,
        formalOracleVersion: FORMAL_ORACLE_VERSION,
      },
      conditions: conditionsOf(result),
      counterexampleReturned: result.verdict === 'refuted',
      contradiction: await contradictionOf(real, design, entry, result),
    },
  };
}

// -- The driver -------------------------------------------------------------

/** The Fixture_Property that states one anchor's exact arithmetic result, or a throw naming it. */
function anchorEntry(designId: string): FixtureProperty {
  const entry = PROPERTY_FIXTURE.find(
    (candidate) =>
      candidate.designId === designId && candidate.criterionRef === ANCHOR_CRITERION_REF,
  );
  if (entry === undefined) {
    throw new Error(
      `the Property_Fixture holds no criterion-${ANCHOR_CRITERION_REF} entry for ${designId}`,
    );
  }
  return entry;
}

/**
 * Every Scaling_Anchor's source and interface, read once from the pinned checkout.
 *
 * The same read-only port and the same importer every other corpus suite uses, so the designs
 * this measurement decides are the ones the corpus pins rather than copies held here.
 */
async function anchorDesigns(): Promise<ReadonlyMap<string, FormalDesign>> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const designs = new Map<string, FormalDesign>();
  for (const designId of SCALING_ANCHOR_IDS) {
    const reference = corpus.references.get(designId);
    const problem = corpus.problems.find((candidate) => candidate.id === designId);
    if (reference === undefined || problem === undefined) {
      throw new Error(`the pinned corpus has no reference or problem for ${designId}`);
    }
    designs.set(designId, {
      source: reference.rtl,
      moduleInterface: problem.spec.moduleInterface,
    });
  }
  return designs;
}

/** One limit by name, or a throw naming the limit that is not declared (Req 12.4). */
function declaredLimit(name: string): MeasurementLimit {
  const limit = limitOrRefuse(name);
  if (!limit.ok) {
    throw new Error(limit.error.message);
  }
  return limit.value;
}

/**
 * Decide all three anchors under both ceilings, in ceiling order.
 *
 * SEQUENTIAL, and the script has a measurement wave to itself for the same reason: concurrent
 * work moves the elapsed figures and can move a verdict across the 150 s ceiling.
 */
export async function runAnchorMeasurement(): Promise<AnchorMeasurementRecord> {
  const startedAt = Date.now();
  const toolchain = probeToolchainVersions(FORMAL_PROBE.pythonBin);
  const ceilings = ANCHOR_CEILING_NAMES.map(declaredLimit);
  const designs = await anchorDesigns();
  const decisions: AnchorDecision[] = [];
  for (const ceiling of ceilings) {
    for (const designId of SCALING_ANCHOR_IDS) {
      const design = designs.get(designId);
      if (design === undefined) {
        throw new Error(`no design was read for ${designId}`);
      }
      const real = realFormalAdapter(FORMAL_PROBE.pythonBin);
      decisions.push(
        await measureAnchor(real, design, anchorEntry(designId), { ceiling, toolchain }),
      );
    }
  }
  return {
    schemaVersion: ANCHOR_RECORD_SCHEMA_VERSION,
    measurementKind: 'scaling-anchor',
    formalOracleVersion: FORMAL_ORACLE_VERSION,
    toolchain,
    limits: [declaredLimit(PROOF_DEPTH_LIMIT_NAME), ...ceilings],
    // No property here was model-authored, so the measured token count is zero rather than absent.
    tokenCount: 0,
    elapsedWallClockMs: Date.now() - startedAt,
    decisions,
  };
}

// -- The committed record ---------------------------------------------------

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repository root, resolved from this module's own location in either layout.
 *
 * Authored at `app/test/` and compiled to `app/test/dist/`, so the distance differs by one level
 * between the tree vitest loads and the build output the script runs from. The directory name
 * decides it on evidence, the same way `fetch-node.ts` resolves its own root, rather than
 * trusting the working directory the script happened to be invoked from.
 */
function repositoryRoot(): string {
  const levelsUp = basename(HERE) === 'dist' ? 3 : 2;
  return resolve(HERE, ...new Array<string>(levelsUp).fill('..'));
}

/** The committed directory this measurement's record lands in, its own and no other's. */
export const ANCHOR_RECORD_DIRECTORY = join(repositoryRoot(), 'measurements', 'formal-anchors');

/** The committed record's filename. */
export const ANCHOR_RECORD_FILE_NAME = 'anchor-observations.json';

/** The record's absolute path. */
export const ANCHOR_RECORD_PATH = join(ANCHOR_RECORD_DIRECTORY, ANCHOR_RECORD_FILE_NAME);

/** One decision in one operator-facing line, measured verdict and all. */
function describeDecision(decision: AnchorDecision): string {
  const { outcome } = decision;
  const ceiling = ceilingOf(outcome);
  const under = `under ${ceiling.name} (${String(ceiling.value)} ms, ${ceiling.reason})`;
  if (outcome.kind === 'not-measured') {
    return `${decision.designId} ${under}: NOT MEASURED - ${outcome.reason}`;
  }
  const { verdict, couldNotVerifyCause, proofDepth, elapsedMs } = outcome.observation;
  const decided = couldNotVerifyCause === null ? verdict : `${verdict}: ${couldNotVerifyCause}`;
  const contradiction =
    outcome.contradiction === null
      ? ''
      : ` CONTRADICTION of expected ${decision.expectedVerdict}, ${outcome.contradiction.adjudicationDescription}`;
  return (
    `${decision.designId} ${under}: ${decided} at depth ${String(proofDepth)} ` +
    `in ${String(elapsedMs)} ms,` +
    ` counterexample ${outcome.counterexampleReturned ? 'returned' : 'not returned'}.${contradiction}`
  );
}

/** Write the record, after the check and never before it. */
async function writeAnchorRecord(record: AnchorMeasurementRecord): Promise<void> {
  await mkdir(ANCHOR_RECORD_DIRECTORY, { recursive: true });
  await writeFile(ANCHOR_RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * Run the measurement, or report the reason it could not run.
 *
 * Skip-gated on `FORMAL_PROBE`, which checks the composed `yosys-smtbmc -s bitwuzla` invocation
 * AND a worker-capable Python, because every decision goes through the sandbox worker. A skip
 * exits 0: an absent toolchain is not a failed measurement. A record that fails its own check
 * exits 1 and is NOT written, because an unreadable record is worse than no record.
 */
async function main(): Promise<void> {
  if (!FORMAL_PROBE.available) {
    console.log(`Scaling_Anchor measurement SKIPPED: ${FORMAL_PROBE.reason}`);
    return;
  }
  const record = await runAnchorMeasurement();
  const problems = anchorRecordProblems(record);
  if (problems.length > 0) {
    console.error('Scaling_Anchor record REFUSED, nothing was written:');
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  await writeAnchorRecord(record);
  console.log(
    `Scaling_Anchor measurement: ${String(record.decisions.length)} observations under ` +
      `Formal_Oracle_Version ${String(record.formalOracleVersion)}, ` +
      `corpus pinned at ${RTLLM_PINNED_COMMIT}.`,
  );
  for (const decision of record.decisions) {
    console.log(`  ${describeDecision(decision)}`);
  }
  console.log(
    `Whole run: ${String(record.elapsedWallClockMs)} ms wall clock, ` +
      `${String(record.tokenCount)} model tokens. Record: ${ANCHOR_RECORD_PATH}`,
  );
}

// Run only when executed directly, not when imported by a test.
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`Scaling_Anchor measurement failed: ${message}`);
    process.exitCode = 1;
  });
}
