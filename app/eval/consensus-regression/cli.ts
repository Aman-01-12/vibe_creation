// The Benchmark_Regression_Suite's runnable CLI and its run directory contract (C20; Req
// 16.3, 16.4, 16.7).
//
// SPENDS NO PAID WORK ITSELF (Req 16.1's own "free to build and test" header for group 16).
// By default it drives `decideConsensusRegressionGate` against a SYNTHETIC measurement built
// from the figures this spec's own requirements already cite - the honest "0% today" pilot
// figure included, so a run against the default demonstrates the suite's own gate catching a
// real, cited failure rather than only its passing cases. `--record <path>` reads a
// previously recorded measurement from disk instead (still no paid work: the paid run that
// PRODUCED that file is group 18, PARKED). Pointing this CLI at a live provider is a future
// caller's job, not this file's: `ConsensusRegressionMeasurementProvider` is the seam for it.
//
// WRITES INTO A NEW RUN DIRECTORY, NEVER AN EXISTING ONE. `.eval-runs/<runName>` is refused
// if it already exists, the same non-negotiable the sweep CLI's own output directory holds
// to, so two runs can never silently merge their records under one name.
//
// Reports the six gated figures and the five reported figures, EACH WITH ITS SAMPLE COUNT
// when the citation it was measured against stated one, because a share with no stated
// denominator is a claim, not a measurement, and this CLI only ever has what the citation
// gave it.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { domainError, err, ok, type DomainError, type Result } from '@app/core';

import {
  decideConsensusRegressionGate,
  PILOT_DESIGN_SET,
  type DiversityRecord,
  type GatedFigures,
  type GateVerdict,
  type PilotDesign,
} from './gate.js';
import { CONSENSUS_REGRESSION_DIVERSITY_RECORD } from './arms.js';
import {
  consensusRegressionConfigIdentity,
  type ConsensusRegressionConfigIdentity,
} from './harness.js';
import {
  STRUCTURAL_GATE_EXCLUSIONS,
  STRUCTURAL_GATE_EXCLUSION_NOTE,
  type StructuralGateExclusion,
} from './structural-gate-exclusions.js';

/** One figure's value, plus the sample size it was measured against, when the citation gave one. */
export interface MeasuredShare {
  readonly value: number;
  readonly sampleCount: number | null;
}

/** The full set of figures the suite reports: the six gated ones and the five reported ones. */
export interface ConsensusRegressionMeasuredFigures {
  readonly wrongLabelShare: MeasuredShare;
  readonly verifiedCorrectShare: MeasuredShare;
  readonly pilotPassShare: Readonly<Record<PilotDesign, MeasuredShare>>;
  readonly attributionAccuracyTestbench: MeasuredShare;
  readonly attributionAccuracyRtl: MeasuredShare;
  readonly misattributionShare: MeasuredShare;
  /** MEASURED: 99.7%; reported only, per Q-03 (gate.ts header). */
  readonly deliveredLabelCorrectShare: MeasuredShare;
  readonly firstAttemptVerifiedCorrectShare: MeasuredShare;
  readonly withinThreeAttemptsVerifiedCorrectShare: MeasuredShare;
  /** `null`: NOT YET MEASURED, the honest check on C12. */
  readonly peerCalibratedMutationGateAgreement: MeasuredShare | null;
  readonly diversity: DiversityRecord;
}

/** The default, no-paid-work demonstration measurement, built from this spec's own citations. */
export const DEFAULT_SYNTHETIC_MEASUREMENT: ConsensusRegressionMeasuredFigures = Object.freeze({
  wrongLabelShare: { value: 0.002, sampleCount: null },
  verifiedCorrectShare: { value: 0.449, sampleCount: null },
  pilotPassShare: Object.freeze({
    counter_12: { value: 0, sampleCount: null },
    traffic_light: { value: 0, sampleCount: null },
    accu: { value: 0, sampleCount: null },
  }),
  attributionAccuracyTestbench: { value: 0.995, sampleCount: 2545 },
  attributionAccuracyRtl: { value: 0.904, sampleCount: 468 },
  misattributionShare: { value: 0.006, sampleCount: null },
  deliveredLabelCorrectShare: { value: 0.997, sampleCount: null },
  firstAttemptVerifiedCorrectShare: { value: 0.456, sampleCount: null },
  withinThreeAttemptsVerifiedCorrectShare: { value: 0.634, sampleCount: null },
  peerCalibratedMutationGateAgreement: null,
  diversity: CONSENSUS_REGRESSION_DIVERSITY_RECORD,
});

/** Extract the six gated values `decideConsensusRegressionGate` reads, dropping sample counts. */
export function gatedFiguresOf(measured: ConsensusRegressionMeasuredFigures): GatedFigures {
  return {
    wrongLabelShare: measured.wrongLabelShare.value,
    verifiedCorrectShare: measured.verifiedCorrectShare.value,
    pilotPassShare: {
      counter_12: measured.pilotPassShare.counter_12.value,
      traffic_light: measured.pilotPassShare.traffic_light.value,
      accu: measured.pilotPassShare.accu.value,
    },
    attributionAccuracyTestbench: measured.attributionAccuracyTestbench.value,
    attributionAccuracyRtl: measured.attributionAccuracyRtl.value,
    misattributionShare: measured.misattributionShare.value,
  };
}

/** Supplies the suite's measurement for one run; the seam a future live provider wires through. */
export interface ConsensusRegressionMeasurementProvider {
  measure(): Promise<ConsensusRegressionMeasuredFigures>;
}

/** A provider that always returns the same, already-decided figures, with no I/O and no model call. */
export function syntheticMeasurementProvider(
  figures: ConsensusRegressionMeasuredFigures = DEFAULT_SYNTHETIC_MEASUREMENT,
): ConsensusRegressionMeasurementProvider {
  return { measure: (): Promise<ConsensusRegressionMeasuredFigures> => Promise.resolve(figures) };
}

/** Validate one untrusted `MeasuredShare` field from a `--record` file. */
function readMeasuredShare(value: unknown, field: string): Result<MeasuredShare, DomainError> {
  if (typeof value !== 'object' || value === null) {
    return err(
      domainError('CONSENSUS_REGRESSION_RECORD_INVALID', `${field} is not an object`, field),
    );
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.value !== 'number' || !Number.isFinite(candidate.value)) {
    return err(
      domainError(
        'CONSENSUS_REGRESSION_RECORD_INVALID',
        `${field}.value is not a finite number`,
        field,
      ),
    );
  }
  const sampleCount = candidate.sampleCount;
  if (sampleCount !== null && (typeof sampleCount !== 'number' || !Number.isInteger(sampleCount))) {
    return err(
      domainError(
        'CONSENSUS_REGRESSION_RECORD_INVALID',
        `${field}.sampleCount is neither null nor an integer`,
        field,
      ),
    );
  }
  return ok({ value: candidate.value, sampleCount });
}

/** Validate an untrusted `--record` JSON document into `ConsensusRegressionMeasuredFigures`. */
export function parseRecordedMeasurement(
  raw: unknown,
): Result<ConsensusRegressionMeasuredFigures, DomainError> {
  if (typeof raw !== 'object' || raw === null) {
    return err(
      domainError('CONSENSUS_REGRESSION_RECORD_INVALID', 'the record is not an object', 'root'),
    );
  }
  const document = raw as Record<string, unknown>;
  const scalarFields = [
    'wrongLabelShare',
    'verifiedCorrectShare',
    'attributionAccuracyTestbench',
    'attributionAccuracyRtl',
    'misattributionShare',
    'deliveredLabelCorrectShare',
    'firstAttemptVerifiedCorrectShare',
    'withinThreeAttemptsVerifiedCorrectShare',
  ] as const;
  const scalars: Partial<Record<(typeof scalarFields)[number], MeasuredShare>> = {};
  for (const field of scalarFields) {
    const parsed = readMeasuredShare(document[field], field);
    if (!parsed.ok) {
      return parsed;
    }
    scalars[field] = parsed.value;
  }
  const pilotRaw = document.pilotPassShare;
  if (typeof pilotRaw !== 'object' || pilotRaw === null) {
    return err(
      domainError(
        'CONSENSUS_REGRESSION_RECORD_INVALID',
        'pilotPassShare is not an object',
        'pilotPassShare',
      ),
    );
  }
  const pilotCandidate = pilotRaw as Record<string, unknown>;
  const pilotPassShare: Partial<Record<PilotDesign, MeasuredShare>> = {};
  for (const design of PILOT_DESIGN_SET) {
    const parsed = readMeasuredShare(pilotCandidate[design], `pilotPassShare.${design}`);
    if (!parsed.ok) {
      return parsed;
    }
    pilotPassShare[design] = parsed.value;
  }
  const peerRaw = document.peerCalibratedMutationGateAgreement;
  let peerCalibratedMutationGateAgreement: MeasuredShare | null = null;
  if (peerRaw !== null && peerRaw !== undefined) {
    const parsed = readMeasuredShare(peerRaw, 'peerCalibratedMutationGateAgreement');
    if (!parsed.ok) {
      return parsed;
    }
    peerCalibratedMutationGateAgreement = parsed.value;
  }
  return ok({
    wrongLabelShare: scalars.wrongLabelShare as MeasuredShare,
    verifiedCorrectShare: scalars.verifiedCorrectShare as MeasuredShare,
    pilotPassShare: pilotPassShare as Readonly<Record<PilotDesign, MeasuredShare>>,
    attributionAccuracyTestbench: scalars.attributionAccuracyTestbench as MeasuredShare,
    attributionAccuracyRtl: scalars.attributionAccuracyRtl as MeasuredShare,
    misattributionShare: scalars.misattributionShare as MeasuredShare,
    deliveredLabelCorrectShare: scalars.deliveredLabelCorrectShare as MeasuredShare,
    firstAttemptVerifiedCorrectShare: scalars.firstAttemptVerifiedCorrectShare as MeasuredShare,
    withinThreeAttemptsVerifiedCorrectShare:
      scalars.withinThreeAttemptsVerifiedCorrectShare as MeasuredShare,
    peerCalibratedMutationGateAgreement,
    diversity: CONSENSUS_REGRESSION_DIVERSITY_RECORD,
  });
}

/** The committed report one CLI run writes into its own fresh run directory. */
export interface ConsensusRegressionReport {
  /** Bumped from 1: a reader of a version-1 report would not know the two fields below exist. */
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly configIdentity: ConsensusRegressionConfigIdentity;
  readonly measured: ConsensusRegressionMeasuredFigures;
  readonly verdict: GateVerdict;
  readonly structuralGateExclusions: readonly StructuralGateExclusion[];
  readonly structuralGateExclusionNote: string;
}

/** Filesystem seam the CLI writes its run directory through; injectable for unit tests. */
export interface ConsensusRegressionRunDirPort {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
}

/** The real, Node-backed `ConsensusRegressionRunDirPort`. */
export function nodeRunDirPort(): ConsensusRegressionRunDirPort {
  return {
    async exists(path: string): Promise<boolean> {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(path: string): Promise<void> {
      await mkdir(path, { recursive: true });
    },
    async writeFile(path: string, contents: string): Promise<void> {
      await writeFile(path, contents, 'utf8');
    },
  };
}

/** The report filename written inside each run directory. */
export const REPORT_FILENAME = 'report.json';

export interface ConsensusRegressionCliResult {
  readonly exitCode: 0 | 1;
  readonly lines: readonly string[];
  readonly runDir: string;
}

/**
 * One `MeasuredShare` rendered as `value (n=sampleCount; excluded by the Structural_Gate: N)`,
 * so every gated and reported figure carries the exclusion count beside it (Req 12.8).
 */
function renderShare(name: string, share: MeasuredShare): string {
  const pct = `${(share.value * 100).toFixed(2)}%`;
  const denominator =
    share.sampleCount === null ? 'sample count not cited' : `n=${share.sampleCount}`;
  const exclusionCount = STRUCTURAL_GATE_EXCLUSIONS.length;
  return `  ${name}: ${pct} (${denominator}; excluded by the Structural_Gate: ${exclusionCount})`;
}

/** Render the full report as human-readable lines, every figure shown with its denominator. */
function reportLines(report: ConsensusRegressionReport): readonly string[] {
  const { measured, verdict } = report;
  const lines: string[] = [
    `Benchmark_Regression_Suite: ${verdict.passed ? 'PASSED' : 'FAILED'}`,
    'Gated figures:',
    renderShare('Wrong_Label_Share', measured.wrongLabelShare),
    renderShare('Verified_Correct_Share', measured.verifiedCorrectShare),
    ...PILOT_DESIGN_SET.map((design) =>
      renderShare(`Pilot_Pass_Share (${design})`, measured.pilotPassShare[design]),
    ),
    renderShare('Attribution_Accuracy (TESTBENCH)', measured.attributionAccuracyTestbench),
    renderShare('Attribution_Accuracy (RTL)', measured.attributionAccuracyRtl),
    renderShare('Misattribution_Share', measured.misattributionShare),
    'Reported figures (gate nothing):',
    renderShare('Delivered_Label_Correct_Share', measured.deliveredLabelCorrectShare),
    renderShare(
      'First-attempt Verified-and-correct share',
      measured.firstAttemptVerifiedCorrectShare,
    ),
    renderShare(
      'Within-3-attempts Verified-and-correct share',
      measured.withinThreeAttemptsVerifiedCorrectShare,
    ),
    measured.peerCalibratedMutationGateAgreement === null
      ? '  Peer-calibrated/golden-calibrated Mutation_Strength_Gate agreement: not yet measured'
      : renderShare(
          'Peer-calibrated/golden-calibrated Mutation_Strength_Gate agreement',
          measured.peerCalibratedMutationGateAgreement,
        ),
  ];
  if (!verdict.passed) {
    lines.push('Failures:');
    for (const failure of verdict.failures) {
      lines.push(
        `  ${failure.figure}: ${failure.value} is past its ${failure.bar.direction} bar of ${failure.bar.bar}`,
      );
    }
  }
  return lines;
}

/** One parsed CLI invocation. */
export type ConsensusRegressionCliCommand =
  | { readonly kind: 'run'; readonly runName: string | null; readonly recordPath: string | null }
  | { readonly kind: 'usage'; readonly problem: string };

/** Parse CLI arguments into a command (pure, no filesystem). */
export function parseConsensusRegressionArgs(
  argv: readonly string[],
): ConsensusRegressionCliCommand {
  let runName: string | null = null;
  let recordPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--run-name' && value !== undefined) {
      runName = value;
      index += 1;
    } else if (flag === '--record' && value !== undefined) {
      recordPath = value;
      index += 1;
    } else {
      return { kind: 'usage', problem: `unrecognized argument ${String(flag)}` };
    }
  }
  return { kind: 'run', runName, recordPath };
}

/** A fresh run name derived from the current time, when the caller supplies none. */
function defaultRunName(now: () => Date): string {
  return `consensus-regression-${now().toISOString().replace(/[:.]/gu, '-')}`;
}

/**
 * Run the suite CLI: measure, decide, and write the report into a FRESH `.eval-runs/<name>`
 * directory (Req 16.3, 16.4, 16.7).
 *
 * Refuses to write into a run directory that already exists, so two runs can never merge
 * their records under one name. Returns, never throws, on a refused directory or an invalid
 * `--record` file: both are reported as a configuration failure (exit 1) rather than a
 * suite regression.
 */
export async function runConsensusRegressionCli(
  command: Extract<ConsensusRegressionCliCommand, { readonly kind: 'run' }>,
  deps: {
    readonly evalRunsRoot: string;
    readonly fs: ConsensusRegressionRunDirPort;
    readonly provider?: ConsensusRegressionMeasurementProvider;
    readonly now?: () => Date;
  },
): Promise<ConsensusRegressionCliResult> {
  const now = deps.now ?? (() => new Date());
  const runName = command.runName ?? defaultRunName(now);
  const runDir = join(deps.evalRunsRoot, runName);

  if (await deps.fs.exists(runDir)) {
    return {
      exitCode: 1,
      runDir,
      lines: [
        `Benchmark_Regression_Suite: run directory ${runDir} already exists; refusing to reuse it.`,
      ],
    };
  }

  let measured: ConsensusRegressionMeasuredFigures;
  if (command.recordPath !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(command.recordPath, 'utf8'));
    } catch {
      return {
        exitCode: 1,
        runDir,
        lines: [`Benchmark_Regression_Suite: could not read or parse ${command.recordPath}.`],
      };
    }
    const parsed = parseRecordedMeasurement(raw);
    if (!parsed.ok) {
      return {
        exitCode: 1,
        runDir,
        lines: [
          `Benchmark_Regression_Suite: ${command.recordPath} is invalid: ${parsed.error.message}`,
        ],
      };
    }
    measured = parsed.value;
  } else {
    const provider = deps.provider ?? syntheticMeasurementProvider();
    measured = await provider.measure();
  }

  const verdict = decideConsensusRegressionGate(gatedFiguresOf(measured));
  const report: ConsensusRegressionReport = {
    schemaVersion: 2,
    generatedAt: now().toISOString(),
    configIdentity: consensusRegressionConfigIdentity(),
    measured,
    verdict,
    structuralGateExclusions: STRUCTURAL_GATE_EXCLUSIONS,
    structuralGateExclusionNote: STRUCTURAL_GATE_EXCLUSION_NOTE,
  };

  await deps.fs.mkdir(runDir);
  await deps.fs.writeFile(join(runDir, REPORT_FILENAME), `${JSON.stringify(report, null, 2)}\n`);

  return { exitCode: verdict.passed ? 0 : 1, runDir, lines: reportLines(report) };
}

/** The default `.eval-runs/` root, resolved from this module's own location in either layout. */
function defaultEvalRunsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // This module compiles to `app/eval/dist/consensus-regression/cli.js`; `.eval-runs/` lives
  // at the repository root, three levels above `dist/consensus-regression`.
  return resolve(here, '..', '..', '..', '.eval-runs');
}

/** Wire the real defaults, print the report, and set the process exit code. */
async function main(): Promise<void> {
  const command = parseConsensusRegressionArgs(process.argv.slice(2));
  if (command.kind === 'usage') {
    console.error(`consensus-regression: ${command.problem}`);
    process.exitCode = 1;
    return;
  }
  const result = await runConsensusRegressionCli(command, {
    evalRunsRoot: defaultEvalRunsRoot(),
    fs: nodeRunDirPort(),
  });
  for (const line of result.lines) {
    console.log(line);
  }
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`consensus-regression failed: ${message}`);
    process.exitCode = 1;
  });
}
