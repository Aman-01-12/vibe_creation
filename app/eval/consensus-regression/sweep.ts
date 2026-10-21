// Task 18.2 PARKED, paid: the full Benchmark_Regression_Suite over the retained RTLLM
// corpus, with the real live wiring, writing one sample file per problem into a FRESH
// `.eval-runs/<name>/samples/` directory as each completes, plus a small `summary.json` with
// the reduced figures. Operator script, not a shipped component.
//
// ONE FILE PER PROBLEM, NOT ONE GROWING ARRAY
//
//   A `ConsensusRegressionSample` carries full Run_Matrix traces (2048 steps x 64+ cells,
//   Req 2.7/7.8/15.5's own full-replay requirement), so one sample serializes to tens of MB.
//   An earlier version of this script accumulated every sample into one array and rewrote the
//   WHOLE array via `JSON.stringify` after each problem; at sample 24 of a 46-problem corpus
//   that string exceeded V8's maximum string length and the process crashed, losing the
//   JUST-COMPLETED (real, paid) sample along with it, because the crash happened between
//   appending it to the array and finishing that write. Each problem's result now gets its
//   OWN file, written once, never rewritten - a later problem's write can never touch an
//   earlier problem's file, and no single write grows with the run's own length.
//
// Drives `runConsensusRegressionSample` (harness.ts) per included problem, with the real
// `GoldenJudge` and the retained corpus's own reference RTL - the ground truth
// `reduceGatedFigures` (figures.ts) needs for Attribution_Accuracy and Misattribution_Share.
// Everything else (the gate table, exclusions, config identity) is this spec's existing code;
// this file only assembles the real deps and loops the corpus.
//
// Pilot_Pass_Share is supplied by the caller from task 18.1's own recorded run (`--pilot-pass-share`),
// never re-measured here: this sweep's own testbench pool is judged against the DELIVERED
// design's correctness, not against the reference the way the pilot holds a testbench to it.
//
// `--resume-from <runDir>` CONTINUES an interrupted run rather than restarting the whole
// corpus: it loads every already-written `samples/*.json` from that directory, skips those
// problem ids, and keeps writing into the SAME directory. Resuming is refused (never
// silently accepted) when the target directory's `summary.json` carries a different
// `configIdentity` than the version constants running right now (Req 16.3's own "never
// silently compare a new run against an old baseline" - a resumed population must be one
// population, not two runs under one name).

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RtllmGoldenJudge, SandboxGoldenTestbenchScorer } from '../corpus/index.js';
import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import {
  reduceGatedFigures,
  reduceQualitySignals,
  renderQualitySignals,
  type SweepQualitySignals,
} from './figures.js';
import { decideConsensusRegressionGate, type GatedFigures, type PilotDesign } from './gate.js';
import {
  consensusRegressionConfigIdentity,
  isExcludedFromConsensusRegression,
  runConsensusRegressionSample,
  type ConsensusRegressionDeps,
  type ConsensusRegressionSample,
  type ReferenceModelRecord,
} from './harness.js';
import { liveConsensusSessionDeps, LIVE_WIRING_LIMITS, REPOSITORY_ROOT } from './live-wiring.js';

/** A problem id made filesystem-safe, so every sample file lands under one flat directory. */
function sampleFilenameFor(problemId: string): string {
  return `${problemId.replace(/[^A-Za-z0-9_-]/gu, '_')}.json`;
}

/**
 * Pilot_Pass_Share (Req 5.8) comes from task 18.1's own run; omitting a design reports `null`
 * for it, never a silent zero.
 */
export interface PilotPassShareInput {
  readonly counter_12: number | null;
  readonly traffic_light: number | null;
  readonly accu: number | null;
}

/** One problem whose Session could not complete - a live-wiring throw, never swallowed. */
export interface SweepProblemFailure {
  readonly problemId: string;
  readonly message: string;
}

/**
 * One problem whose Reference_Model_Record write failed (Req 8.6). The problem's own sample
 * is already on disk by the time this can happen - the record write runs strictly after it,
 * in its own `try` - so this is a diagnostic-only loss, never a sample loss.
 */
export interface SweepRecordWriteFailure {
  readonly problemId: string;
  readonly message: string;
}

/**
 * The sweep's SUMMARY: everything except the raw samples, which live one-file-per-problem
 * under the run directory's own `samples/` folder (see the module header). Small by
 * construction - no Run_Matrix trace ever reaches this shape - so this is the one object
 * `JSON.stringify`'d as a whole, as often as the caller likes, with no size ceiling risk.
 */
export interface SweepSummary {
  readonly configIdentity: ReturnType<typeof consensusRegressionConfigIdentity>;
  /** Problem ids with a persisted sample file, in completion order; the samples themselves are not held here. */
  readonly completedProblemIds: readonly string[];
  readonly excludedProblemIds: readonly string[];
  /** Problems a Session could not complete for (model noise, a live-wiring throw); never silently dropped. */
  readonly failures: readonly SweepProblemFailure[];
  /** Problems whose Reference_Model_Record write failed (Req 8.6); the sample itself still landed. */
  readonly recordWriteFailures: readonly SweepRecordWriteFailure[];
  /** `null` when the run's own population was too small to compute every gated figure (e.g. a `--limit` smoke run). */
  readonly gatedFigures: GatedFigures | null;
  readonly verdict: ReturnType<typeof decideConsensusRegressionGate> | null;
  /**
   * Distinct_Output_Count against mutation outcome, and the per-port Input_Role assignments
   * each run was rendered under (C9; Req 6.1-6.5) - persisted so the Introduction's own
   * measured table is reproducible from a later run's own output. The gate reads neither
   * field: `decideConsensusRegressionGate` takes only `GatedFigures` above, which gains no
   * field for this (Req 6.6).
   */
  readonly qualitySignals: SweepQualitySignals;
}

/** A reduced figure, or a thrown error naming which one is unmeasured - never a silent zero. */
function required(value: number | null, name: string): number {
  if (value === null) {
    throw new Error(`sweep: ${name} is unmeasured (empty population); cannot gate on it`);
  }
  return value;
}

/** Fold the sample reduction and the pilot's own figures into one `GatedFigures`. */
function assembleGatedFigures(
  reduced: ReturnType<typeof reduceGatedFigures>,
  pilotPassShare: PilotPassShareInput,
): GatedFigures {
  const pilotShare = (design: PilotDesign): number =>
    required(pilotPassShare[design], `Pilot_Pass_Share (${design})`);
  return {
    wrongLabelShare: required(reduced.wrongLabelShare, 'Wrong_Label_Share'),
    verifiedCorrectShare: required(reduced.verifiedCorrectShare, 'Verified_Correct_Share'),
    pilotPassShare: {
      counter_12: pilotShare('counter_12'),
      traffic_light: pilotShare('traffic_light'),
      accu: pilotShare('accu'),
    },
    attributionAccuracyTestbench: required(
      reduced.attributionAccuracyTestbench,
      'Attribution_Accuracy (TESTBENCH)',
    ),
    attributionAccuracyRtl: required(reduced.attributionAccuracyRtl, 'Attribution_Accuracy (RTL)'),
    misattributionShare: required(reduced.misattributionShare, 'Misattribution_Share'),
  };
}

/** Figures and a verdict from `samples`, or `null`+`null` when a figure's population is empty. */
function gateFrom(
  samples: readonly ConsensusRegressionSample[],
  pilotPassShare: PilotPassShareInput,
): {
  readonly gatedFigures: GatedFigures | null;
  readonly verdict: ReturnType<typeof decideConsensusRegressionGate> | null;
} {
  try {
    const gatedFigures = assembleGatedFigures(reduceGatedFigures(samples), pilotPassShare);
    return { gatedFigures, verdict: decideConsensusRegressionGate(gatedFigures) };
  } catch (error) {
    console.log(
      `consensus sweep: gated figures not computed (${error instanceof Error ? error.message : 'unknown'})`,
    );
    return { gatedFigures: null, verdict: null };
  }
}

/** The already-persisted samples a resumed run reuses, loaded once up front. */
export interface ResumeState {
  readonly samples: readonly ConsensusRegressionSample[];
  readonly completedProblemIds: readonly string[];
}

/**
 * Load every `samples/*.json` file in `samplesDir` for a resumed run, refusing (never
 * silently accepting) a stale population: `expectedConfigIdentity` must equal the resume
 * directory's own `summary.json.configIdentity`, or this throws rather than mixing two
 * `configIdentity` snapshots into one population (Req 16.3).
 */
export async function loadResumeState(
  outDir: string,
  expectedConfigIdentity: ReturnType<typeof consensusRegressionConfigIdentity>,
): Promise<ResumeState> {
  const summaryRaw = await readFile(join(outDir, 'summary.json'), 'utf8').catch(() => null);
  if (summaryRaw !== null) {
    const priorSummary = JSON.parse(summaryRaw) as SweepSummary;
    const same =
      JSON.stringify(priorSummary.configIdentity) === JSON.stringify(expectedConfigIdentity);
    if (!same) {
      throw new Error(
        `sweep: --resume-from ${outDir} was run under a different configIdentity; ` +
          'resuming would mix two populations under one Req 16.3 baseline',
      );
    }
  }
  const samplesDir = join(outDir, 'samples');
  const filenames = await readdir(samplesDir).catch(() => [] as string[]);
  const samples: ConsensusRegressionSample[] = [];
  for (const filename of filenames) {
    const raw = await readFile(join(samplesDir, filename), 'utf8');
    samples.push(JSON.parse(raw) as ConsensusRegressionSample);
  }
  return { samples, completedProblemIds: samples.map((sample) => sample.problemId) };
}

/**
 * Run the sweep over the included retained-corpus problems, one real Session each.
 *
 * `problemLimit`/`onlyProblemIds` narrow the included list - for a smoke run proving the real
 * wiring on a deliberately varied slice before the full-corpus spend, never for a run whose
 * figures are meant to gate anything. A narrowed population routinely has too few samples to
 * measure every gated figure, so `gatedFigures`/`verdict` report `null` rather than throwing.
 *
 * `resume`, when given, SKIPS every problem id it already names (loaded by
 * `loadResumeState`) rather than re-running and re-paying for it, and its samples are folded
 * into the gate computation and `completedProblemIds` exactly as if this run had produced
 * them. A single problem's own throw (model noise exhausting `GenerationAgent`'s revision
 * budget, or a live-wiring defect) is caught and recorded in `failures`, never left to abort
 * the whole run - every PRIOR problem's real paid Session result is already on disk under
 * `writeSample` either way, because `writeSample` is called and awaited before the loop
 * moves on, not batched into one end-of-run write. `onSummary`, when given, is called after
 * every problem (success or failure) so a caller can persist the small summary incrementally too.
 *
 * `writeReferenceModelRecords` runs strictly AFTER `writeSample` has already landed, inside
 * its own `try` (Req 8.1, 8.6): a serialization or disk failure on the diagnostic record is
 * caught and recorded in `recordWriteFailures`, never left to threaten the sample that is
 * already safely on disk.
 */
export async function runSweep(
  pilotPassShare: PilotPassShareInput,
  writeSample: (sample: ConsensusRegressionSample) => Promise<void>,
  problemLimit?: number,
  onlyProblemIds?: readonly string[],
  onSummary?: (partial: SweepSummary) => Promise<void>,
  resume?: ResumeState,
  writeReferenceModelRecords?: (
    problemId: string,
    records: readonly ReferenceModelRecord[],
  ) => Promise<void>,
): Promise<SweepSummary> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const allIncluded = corpus.problems.filter(
    (problem) => !isExcludedFromConsensusRegression(problem.id),
  );
  const onlySet = onlyProblemIds === undefined ? null : new Set(onlyProblemIds);
  const narrowed = onlySet === null ? allIncluded : allIncluded.filter((p) => onlySet.has(p.id));
  const limited = problemLimit === undefined ? narrowed : narrowed.slice(0, problemLimit);
  const resumedIds = new Set(resume?.completedProblemIds ?? []);
  const included = limited.filter((problem) => !resumedIds.has(problem.id));
  const excludedProblemIds = corpus.problems
    .filter((problem) => isExcludedFromConsensusRegression(problem.id))
    .map((problem) => problem.id);

  const { sessionDeps, toolRunner } = liveConsensusSessionDeps();
  const deps: ConsensusRegressionDeps = {
    sessionDeps,
    goldenJudge: new RtllmGoldenJudge(new SandboxGoldenTestbenchScorer(toolRunner), corpus.golden),
    limits: LIVE_WIRING_LIMITS,
    references: corpus.references,
  };

  // Figures need every sample's own ground truth, so they are kept here for gateFrom - but
  // each one is ALSO written to its own file as soon as it completes, which is what survives
  // a later crash. Holding them in memory for the gate computation is fine: that is one
  // array of references, not one ever-growing JSON string. Seeded from `resume` so a
  // resumed run's gate figures cover the WHOLE population, not just the problems this
  // invocation itself ran.
  const samples: ConsensusRegressionSample[] = [...(resume?.samples ?? [])];
  const completedProblemIds: string[] = [...(resume?.completedProblemIds ?? [])];
  const failures: SweepProblemFailure[] = [];
  const recordWriteFailures: SweepRecordWriteFailure[] = [];
  for (const problem of included) {
    console.log(`consensus sweep: running ${problem.id}`);
    try {
      const { sample, referenceModelRecords } = await runConsensusRegressionSample(
        { problemId: problem.id, spec: problem.spec },
        deps,
      );
      await writeSample(sample);
      samples.push(sample);
      completedProblemIds.push(problem.id);
      console.log(`consensus sweep: ${problem.id} -> ${sample.outcome.kind}`);

      // Written AFTER the sample, in its own try: a diagnostic write must never cost the
      // already-persisted paid sample (Req 8.6).
      if (writeReferenceModelRecords !== undefined) {
        try {
          await writeReferenceModelRecords(problem.id, referenceModelRecords);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          recordWriteFailures.push({ problemId: problem.id, message });
          console.log(`consensus sweep: ${problem.id} -> record write FAILED (${message})`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      failures.push({ problemId: problem.id, message });
      console.log(`consensus sweep: ${problem.id} -> FAILED (${message})`);
    }
    if (onSummary !== undefined) {
      await onSummary({
        configIdentity: consensusRegressionConfigIdentity(),
        completedProblemIds,
        excludedProblemIds,
        failures,
        recordWriteFailures,
        ...gateFrom(samples, pilotPassShare),
        qualitySignals: reduceQualitySignals(samples),
      });
    }
  }

  return {
    configIdentity: consensusRegressionConfigIdentity(),
    completedProblemIds,
    excludedProblemIds,
    failures,
    recordWriteFailures,
    ...gateFrom(samples, pilotPassShare),
    qualitySignals: reduceQualitySignals(samples),
  };
}

/** Validate the untrusted `--pilot-pass-share` CLI arg into `PilotPassShareInput`. */
function parsePilotPassShareArg(raw: string): PilotPassShareInput {
  const parsed: unknown = JSON.parse(raw);
  const field = (value: unknown): number | null =>
    typeof value === 'number' ? value : value === null ? null : NaN;
  const record = parsed as Record<string, unknown>;
  const result: PilotPassShareInput = {
    counter_12: field(record.counter_12),
    traffic_light: field(record.traffic_light),
    accu: field(record.accu),
  };
  for (const [design, value] of Object.entries(result)) {
    if (value !== null && Number.isNaN(value)) {
      throw new Error(`sweep: --pilot-pass-share.${design} must be a number or null`);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const pilotArgIndex = process.argv.indexOf('--pilot-pass-share');
  const pilotRaw = pilotArgIndex === -1 ? undefined : process.argv[pilotArgIndex + 1];
  if (pilotRaw === undefined) {
    throw new Error(
      'sweep: pass --pilot-pass-share \'{"counter_12":N,"traffic_light":N,"accu":N}\' from task 18.1\'s own recorded figures',
    );
  }
  const pilotPassShare = parsePilotPassShareArg(pilotRaw);

  const limitArgIndex = process.argv.indexOf('--limit');
  const limitRaw = limitArgIndex === -1 ? undefined : process.argv[limitArgIndex + 1];
  const problemLimit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (problemLimit !== undefined && (!Number.isInteger(problemLimit) || problemLimit <= 0)) {
    throw new Error('sweep: --limit must be a positive integer');
  }

  const onlyArgIndex = process.argv.indexOf('--only');
  const onlyRaw = onlyArgIndex === -1 ? undefined : process.argv[onlyArgIndex + 1];
  const onlyProblemIds = onlyRaw === undefined ? undefined : onlyRaw.split(',');

  const resumeArgIndex = process.argv.indexOf('--resume-from');
  const resumeDirArg = resumeArgIndex === -1 ? undefined : process.argv[resumeArgIndex + 1];

  const outDir =
    resumeDirArg ??
    join(
      REPOSITORY_ROOT,
      '.eval-runs',
      `consensus-sweep-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
    );
  const samplesDir = join(outDir, 'samples');
  const refmodelsDir = join(outDir, 'refmodels');
  await mkdir(samplesDir, { recursive: true });
  await mkdir(refmodelsDir, { recursive: true });
  console.log(`consensus sweep: ${outDir}${resumeDirArg === undefined ? '' : ' (resuming)'}`);

  const resume =
    resumeDirArg === undefined
      ? undefined
      : await loadResumeState(outDir, consensusRegressionConfigIdentity());
  if (resume !== undefined) {
    console.log(
      `consensus sweep: resuming with ${resume.completedProblemIds.length} already-completed problems`,
    );
  }

  const writeSample = (sample: ConsensusRegressionSample): Promise<void> =>
    writeFile(
      join(samplesDir, sampleFilenameFor(sample.problemId)),
      `${JSON.stringify(sample, null, 2)}\n`,
      'utf8',
    );
  const writeReferenceModelRecords = (
    problemId: string,
    records: readonly ReferenceModelRecord[],
  ): Promise<void> =>
    writeFile(
      join(refmodelsDir, sampleFilenameFor(problemId)),
      `${JSON.stringify(records, null, 2)}\n`,
      'utf8',
    );
  const summaryPath = join(outDir, 'summary.json');
  const persistSummary = (summary: SweepSummary): Promise<void> =>
    writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const summary = await runSweep(
    pilotPassShare,
    writeSample,
    problemLimit,
    onlyProblemIds,
    persistSummary,
    resume,
    writeReferenceModelRecords,
  );
  await persistSummary(summary);
  if (summary.verdict === null) {
    console.log('consensus sweep: NO VERDICT (gated figures not computed; see samples/)');
  } else {
    console.log(`consensus sweep: ${summary.verdict.passed ? 'PASSED' : 'FAILED'}`);
    console.log(JSON.stringify(summary.gatedFigures, null, 2));
    if (!summary.verdict.passed) {
      console.log(JSON.stringify(summary.verdict.failures, null, 2));
    }
  }
  // Printed after the gate's own verdict, never read by it (Req 6.6): see figures.ts's header
  // for why neither block of this feeds `GatedFigures`, `trustVote`, or the gate decision.
  console.log(renderQualitySignals(summary.qualitySignals));
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`consensus sweep failed: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  });
}
