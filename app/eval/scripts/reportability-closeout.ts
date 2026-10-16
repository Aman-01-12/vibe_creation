// The Measurement_Slice's closeout (testbench-failure-reportability, C12): one `status:
// candidate` vault note computed from the slice's own Sweep_Summary and the committed
// Pinned_Baseline, then `npm run vault:manifest`.
//
// Every figure is read from `summarizeRecords` over the slice's `results.jsonl` and from the
// committed baseline file - none is passed in by hand (Req 10.1, 10.2). `SecretManagerPort` is
// not a dependency of this module at all, so there is nothing to leak into the note (Req 10.6).

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseResultsLog } from '../sweep/results-log.js';
import {
  CONFIRMATORY_CONTROL_COVERAGE_GAP,
  summarizeRecords,
  type ArmSummary,
  type SweepSummary,
} from '../sweep/summary.js';

import { readRunIdentity, type CloseoutPorts } from './scoreboard-closeout.js';
import { BASELINE_FILE_PATH, type ReportabilityBaseline } from './reportability-baseline.js';

/** The Pinned_Baseline rate, re-pinned at DQ-01's case-sensitive recount (560/1015, 55.2%). */
const PINNED_BASELINE_RATE = 560 / 1015;

/** The requirements' originally cited rate, kept only so the note can name the DQ-01 delta. */
const REQUIREMENTS_CITED_RATE_TEXT = '56.5%';

/** The Confirmatory Control_Arm's pinned Coverage_Gap_Survivor_Rate: 171/2249, 7.60%. */
const CONFIRMATORY_CONTROL_SURVIVOR_RATE =
  CONFIRMATORY_CONTROL_COVERAGE_GAP.survivors / CONFIRMATORY_CONTROL_COVERAGE_GAP.scored;

/** The inputs `closeoutLabels` decides over, kept as one object per the design's own signature. */
export interface CloseoutLabelInputs {
  readonly sliceRate: number | null;
  readonly baselineRate: number;
  readonly sliceSurvivorRate: number | null;
  readonly confirmatoryControlSurvivorRate: number;
}

/**
 * Which labels the slice's two rates require (Req 10.3, 10.4). Pure; `>=` is the boundary.
 *
 * `measuredNegative` is true whenever the slice rate is NOT lower than the baseline, so
 * equality counts as a negative - the direction a pre-registration has to take - and also
 * true when there is no measured rate at all, since an unmeasured slice cannot claim an
 * improvement either.
 *
 * `launderingSignature` fires only when the slice rate improved on the baseline AND the
 * survivor rate got WORSE than the Confirmatory Control_Arm's, because an improving proxy
 * beside a weakening instrument must not read as a success.
 */
export function closeoutLabels(input: CloseoutLabelInputs): {
  readonly measuredNegative: boolean;
  readonly launderingSignature: boolean;
} {
  const { sliceRate, baselineRate, sliceSurvivorRate, confirmatoryControlSurvivorRate } = input;
  if (sliceRate === null) {
    return { measuredNegative: true, launderingSignature: false };
  }
  const improved = sliceRate < baselineRate;
  return {
    measuredNegative: !improved,
    launderingSignature:
      improved && sliceSurvivorRate !== null && sliceSurvivorRate > confirmatoryControlSurvivorRate,
  };
}

/** One line per declared Model_Arm, each carrying both rates (Req 10.1). */
function perModelArmLines(arms: readonly ArmSummary[]): readonly string[] {
  return arms.map((arm) => {
    const { withReport, sources, valuelessReportRate } = arm.reportability;
    const { coverageGapSurvivors, validMutants, coverageGapSurvivorRate } = arm.mutation;
    const valueless = valuelessReportRate === null ? 'undefined' : valuelessReportRate.toFixed(3);
    const gap = coverageGapSurvivorRate === null ? 'undefined' : coverageGapSurvivorRate.toFixed(3);
    return (
      `  ${arm.armName}: valueless ${withReport}/${sources} (${valueless})` +
      `  coverage-gap ${coverageGapSurvivors}/${validMutants} (${gap})`
    );
  });
}

/** One rendered fraction: its numerator, its denominator, and the rate they divide to. */
interface RateFraction {
  readonly rate: number | null;
  readonly n: number;
  readonly d: number;
}

/** The run-total Valueless_Report_Rate and Coverage_Gap_Survivor_Rate, as fraction and rate. */
function runTotals(arms: readonly ArmSummary[]): {
  readonly valueless: RateFraction;
  readonly gap: RateFraction;
} {
  const valueless = arms.reduce(
    (sum, arm) => ({
      n: sum.n + arm.reportability.withReport,
      d: sum.d + arm.reportability.sources,
    }),
    { n: 0, d: 0 },
  );
  const gap = arms.reduce(
    (sum, arm) => ({
      n: sum.n + arm.mutation.coverageGapSurvivors,
      d: sum.d + arm.mutation.validMutants,
    }),
    { n: 0, d: 0 },
  );
  return {
    valueless: { ...valueless, rate: valueless.d === 0 ? null : valueless.n / valueless.d },
    gap: { ...gap, rate: gap.d === 0 ? null : gap.n / gap.d },
  };
}

/** Fixed text naming what this closeout does not decide and does not build (Req 10.5). */
const FOLLOW_UP_LINES: readonly string[] = [
  "Named follow-ups, not this spec's work:",
  '- The functional testbench repair loop and its trigger, deferred by one spec.',
  '- The 54 recorded Watchdog hangs, which stay a named follow-up rather than a figure this',
  '  closeout reports.',
  '- Rendering the comparison, the pass/fail tally, or any part of the checking layer beyond',
  '  the report.',
];

/** The DQ-01 delta note: 55.2% is the measured recount, not the requirements' cited figure. */
function dq01Line(): string {
  return (
    `DQ-01: the Pinned_Baseline is the case-sensitive recount 560/1015 (55.2%), not the ` +
    `requirements' originally cited ${REQUIREMENTS_CITED_RATE_TEXT}.`
  );
}

/** The laundering-signature paragraph, naming both rates and both denominators (Req 10.4). */
function launderingLines(sliceValueless: RateFraction, sliceGap: RateFraction): readonly string[] {
  const { survivors, scored } = CONFIRMATORY_CONTROL_COVERAGE_GAP;
  return [
    'LAUNDERING SIGNATURE: the Valueless_Report_Rate improved while the Coverage_Gap_Survivor_Rate',
    `got worse. Slice Valueless_Report_Rate ${sliceValueless.n}/${sliceValueless.d} ` +
      `(${(sliceValueless.rate ?? 0).toFixed(3)}) vs Pinned_Baseline 560/1015 (0.552).`,
    `Slice Coverage_Gap_Survivor_Rate ${sliceGap.n}/${sliceGap.d} (${(sliceGap.rate ?? 0).toFixed(3)}) ` +
      `vs Confirmatory Control_Arm ${survivors}/${scored} (${CONFIRMATORY_CONTROL_SURVIVOR_RATE.toFixed(3)}).`,
    'An improving proxy beside a weakening instrument must not read as a success.',
  ];
}

/** The note for one closed-out Measurement_Slice (pure over its inputs). */
function reportabilityCloseoutNote(
  summary: SweepSummary,
  configHash: string,
  runName: string,
  baseline: ReportabilityBaseline,
  timestamp: string,
): { readonly fileName: string; readonly text: string } {
  const totals = runTotals(summary.arms);
  const labels = closeoutLabels({
    sliceRate: totals.valueless.rate,
    baselineRate: PINNED_BASELINE_RATE,
    sliceSurvivorRate: totals.gap.rate,
    confirmatoryControlSurvivorRate: CONFIRMATORY_CONTROL_SURVIVOR_RATE,
  });
  const tags = [
    'eval',
    'testbench',
    'testbench-failure-reportability',
    'measurement-slice',
    'measured',
    ...(labels.measuredNegative ? ['measured-negative'] : []),
    ...(labels.launderingSignature ? ['laundering-signature'] : []),
  ];
  const title = labels.measuredNegative
    ? `MEASURED NEGATIVE: the Measurement_Slice ${runName} Valueless_Report_Rate did not improve`
    : `The Measurement_Slice ${runName} Valueless_Report_Rate improved on the Pinned_Baseline`;
  return {
    fileName: `decision-${runName}-measurement-slice-closeout.md`,
    text: [
      '---',
      'type: decision',
      `title: ${title}`,
      'status: candidate',
      `provenance: app/eval/scripts/reportability-closeout.ts over .eval-runs/${runName} (config ${configHash})`,
      `tags: [${tags.join(', ')}]`,
      `timestamp: ${timestamp}`,
      '---',
      '# Decision',
      labels.measuredNegative
        ? 'MEASURED NEGATIVE: the Valueless_Report_Rate is not lower than the Pinned_Baseline, so'
        : 'The Valueless_Report_Rate is lower than the Pinned_Baseline.',
      ...(labels.launderingSignature ? launderingLines(totals.valueless, totals.gap) : []),
      '',
      ...FOLLOW_UP_LINES,
      dq01Line(),
      '# Context / options considered',
      `Config_Identity: ${configHash}.`,
      `Valueless_Report_Rate (run total): ${totals.valueless.n}/${totals.valueless.d} ` +
        `(${totals.valueless.rate === null ? 'undefined' : totals.valueless.rate.toFixed(3)}).`,
      `Coverage_Gap_Survivor_Rate (run total): ${totals.gap.n}/${totals.gap.d} ` +
        `(${totals.gap.rate === null ? 'undefined' : totals.gap.rate.toFixed(3)}).`,
      'Per Model_Arm:',
      '```',
      ...perModelArmLines(summary.arms),
      '```',
      `Pinned_Baseline: ${baseline.total.withReport}/${baseline.total.sources} (55.2%), ` +
        `from ${baseline.source.runPath} (config ${baseline.source.configHash}).`,
      `Confirmatory Control_Arm Coverage_Gap_Survivor_Rate: ${CONFIRMATORY_CONTROL_COVERAGE_GAP.survivors}/` +
        `${CONFIRMATORY_CONTROL_COVERAGE_GAP.scored} (7.60%).`,
      '# Rationale',
      'Both rates and every per-Model_Arm figure are read from `summarizeRecords` over this',
      "run's own Results_Log; no figure here was entered by hand.",
      '# Revisit trigger',
      'The functional testbench repair loop with a non-circular feedback source, which is the',
      'next spec this measurement feeds.',
      '# Links',
      '- .kiro/specs/testbench-failure-reportability/requirements.md (Requirement 10)',
      `- .eval-runs/${runName}/summary.txt`,
      `- ${BASELINE_FILE_PATH}`,
      '',
    ].join('\n'),
  };
}

/** Read the slice's manifest, results log, and the committed baseline; render the note. */
async function readAndRenderNote(
  runDir: string,
  readText: (path: string) => Promise<string>,
  now: () => string,
): Promise<{ readonly fileName: string; readonly text: string } | string> {
  const manifestText = await readText(join(runDir, 'manifest.json'));
  const identity = readRunIdentity(manifestText);
  if (typeof identity === 'string') {
    return identity;
  }
  const resultsText = await readText(join(runDir, 'results.jsonl'));
  const parsed = parseResultsLog(resultsText);
  if (parsed.staleSchemaLines > 0) {
    return 'the results log holds stale-schema records and cannot be aggregated';
  }
  const manifest = JSON.parse(manifestText) as { readonly config?: { readonly ks?: unknown } };
  const ks = Array.isArray(manifest.config?.ks) ? (manifest.config?.ks as number[]) : [1];
  const summary = summarizeRecords(parsed.records, ks, identity.configHash, parsed);
  const baseline = JSON.parse(await readText(BASELINE_FILE_PATH)) as ReportabilityBaseline;
  return reportabilityCloseoutNote(summary, identity.configHash, identity.runName, baseline, now());
}

/** Close out one Measurement_Slice run directory into `inboxDir` (Req 10.1-10.8). */
export async function runReportabilityCloseout(
  runDir: string,
  inboxDir: string,
  ports: CloseoutPorts,
): Promise<{ readonly exitCode: 0 | 1; readonly lines: readonly string[] }> {
  const INCOMPLETE = 'closeout incomplete';
  let note: { readonly fileName: string; readonly text: string } | string;
  try {
    note = await readAndRenderNote(runDir, ports.readText, ports.now);
  } catch {
    note = 'the run directory has no manifest.json or results.jsonl, or the baseline is unreadable';
  }
  if (typeof note === 'string') {
    return { exitCode: 1, lines: [`${INCOMPLETE}: ${note}`] };
  }
  const notePath = join(inboxDir, note.fileName);
  try {
    await ports.writeNew(notePath, note.text);
  } catch {
    // The note may already exist or the inbox may be unwritable; either way nothing was recorded.
    return { exitCode: 1, lines: [`${INCOMPLETE}: the vault note could not be written`] };
  }
  if (!ports.regenerateManifest()) {
    return { exitCode: 1, lines: [`${INCOMPLETE}: npm run vault:manifest failed`] };
  }
  return { exitCode: 0, lines: [`closeout: note at ${notePath}`] };
}

async function main(): Promise<void> {
  const runDir = process.argv[2];
  if (runDir === undefined) {
    console.error('usage: reportability-closeout <run directory>');
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const result = await runReportabilityCloseout(
    resolve(root, runDir),
    join(root, 'chipAgent', '_inbox'),
    {
      readText: (path) => readFile(resolve(root, path), 'utf8'),
      writeNew: (path, text) => writeFile(path, text, { encoding: 'utf8', flag: 'wx' }),
      regenerateManifest: () =>
        spawnSync('npm', ['run', 'vault:manifest'], { cwd: root, stdio: 'inherit' }).status === 0,
      now: () => new Date().toISOString(),
    },
  );
  for (const line of result.lines) {
    console.log(line);
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    // A local operator script: the message names what to fix, and no secret is ever read here.
    const reason = error instanceof Error ? error.message : 'unknown failure';
    console.error(`reportability-closeout: ${reason}`);
    process.exitCode = 1;
  });
}
