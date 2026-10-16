// The Grounding Campaign's mechanical closeout (grounding-adoption-confirmatory, C8): one
// `status: candidate` vault note carrying the verdict, every clause, the Requirement 10
// blocks, and the Replay_Gate report, then `npm run vault:manifest`.
//
// MECHANICAL ON PURPOSE. Every figure is copied from the run directory, so the note cannot
// disagree with the summary, and a `failed` or `not-decided` verdict is labelled a
// Measured_Negative rather than written up as a near miss.

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StrategyArm } from '@app/agent';

import { CONFIRMATORY_CLAUSES, CROSS_RUN_LABEL } from '../sweep/grounding-report.js';
import {
  readRunIdentity,
  runCloseout,
  type CampaignSummary,
  type CloseoutNoteRenderer,
} from './scoreboard-closeout.js';

/** The Grounding Campaign's own summary reader and note renderer. */
export const GROUNDING_CLOSEOUT = {
  readSummary: (summaryText: string, manifestText: string) =>
    groundingSummaryOf(summaryText, manifestText),
  renderNote: (summary: CampaignSummary, timestamp: string, manifestText: string) =>
    groundingCloseoutNote(summary, timestamp, manifestText),
};

/** The verdict line the Grounding report prints. */
const GROUNDING_VERDICT_PREFIX = 'GROUNDING VERDICT:';

/** The Grounding table's header line. */
const GROUNDING_TABLE_HEADER = 'GROUNDING CAMPAIGN TABLE';

/** Every line of `summary.txt` from `prefix` to the next blank line. */
function blockFrom(lines: readonly string[], prefix: string): readonly string[] {
  const start = lines.findIndex((line) => line.startsWith(prefix));
  if (start === -1) {
    return [];
  }
  const end = lines.findIndex((line, index) => index > start && line.trim().length === 0);
  return lines.slice(start, end === -1 ? undefined : end);
}

/** Lines matching a prefix anywhere in the summary, in order. */
function linesStartingWith(lines: readonly string[], prefix: string): readonly string[] {
  return lines.filter((line) => line.trimStart().startsWith(prefix));
}

/** A `failed` or `not-decided` Campaign is a MEASURED NEGATIVE and is labelled as one. */
function isNegative(verdict: string): boolean {
  return verdict !== 'succeeded';
}

/**
 * The Student_Path arm this verdict requires: the single owner of that mapping (Req 11.1, 11.2).
 *
 * `succeeded` adopts, and every other verdict leaves the shipped default alone, which is the
 * same direction a deferral and a refusal point in.
 */
export function requiredStudentPathArm(verdict: string): StrategyArm {
  return verdict === 'succeeded' ? 'grounded' : 'control';
}

/** The fixed prefix of the line an operator and the adoption gate both read. */
export const REQUIRED_ARM_PREFIX = 'Required STUDENT_PATH_STRATEGY_ARM:';

/** What the verdict decides about the shipped Student_Path (Req 11.1 to 11.4, 11.6, 11.7). */
function decisionText(verdict: string): readonly string[] {
  const shared = [
    '',
    'Next work under every verdict: the functional testbench repair loop with a NON-CIRCULAR',
    'feedback source, which attacks the cause this Campaign does not address - a testbench that',
    'fails the reference is currently revised from its own output or not at all.',
    '',
    "The Exploratory_Run grounding-ab-v1's `failed` verdict STANDS unchanged. It was judged by a",
    'different recorded criterion, this build cannot read that criterion, and nothing here',
    're-judges it.',
  ];
  if (verdict === 'succeeded') {
    return [
      'The Grounded_Arm is ADOPTED: `STUDENT_PATH_STRATEGY_ARM` moves to `grounded`, so the',
      "shipped Student_Path gives the Testbench_Agent the Spec's Architecture_Text.",
      ...shared,
    ];
  }
  return [
    `The Grounded_Arm is NOT adopted: the Confirmatory_Criterion returned \`${verdict}\`, so`,
    '`STUDENT_PATH_STRATEGY_ARM` stays `control` PERMANENTLY for this treatment. No further',
    'Campaign measures these Grounded_Arm model inputs.',
    '',
    'The Grounded_Arm code is RETAINED for the eval plane, so the Strategy_Arm stays available',
    'to a sweep; what is refused is making it the shipped default.',
    ...shared,
  ];
}

/** The Replay_Gate report the manifest recorded, pretty-printed, or why there is none. */
function replayGateBlock(manifestText: string): readonly string[] {
  try {
    const manifest = JSON.parse(manifestText) as { readonly replayGate?: unknown };
    if (manifest.replayGate === undefined || manifest.replayGate === null) {
      return ['the Sweep_Manifest recorded no Replay_Gate report'];
    }
    return JSON.stringify(manifest.replayGate, null, 2).split('\n');
  } catch {
    return ['the Sweep_Manifest could not be read'];
  }
}

/** The note for one closed-out Grounding Campaign (pure over its inputs). */
export const groundingCloseoutNote: CloseoutNoteRenderer = (summary, timestamp, manifestText) => {
  const lines = summary.verdictLines;
  const negative = isNegative(summary.verdict);
  const tags = [
    'eval',
    'testbench',
    'grounding-adoption-confirmatory',
    'campaign',
    'measured',
    ...(negative ? ['measured-negative'] : []),
  ];
  const title = negative
    ? `MEASURED NEGATIVE: the Grounding Campaign ${summary.runName} verdict is ${summary.verdict}`
    : `The Grounding Campaign ${summary.runName} verdict is ${summary.verdict}`;
  return {
    fileName: `decision-${summary.runName}-campaign-verdict.md`,
    text: [
      '---',
      'type: decision',
      `title: ${title}`,
      'status: candidate',
      `provenance: app/eval/scripts/grounding-closeout.ts over .eval-runs/${summary.runName} (config ${summary.configHash})`,
      `tags: [${tags.join(', ')}]`,
      `timestamp: ${timestamp}`,
      '---',
      '# Decision',
      `${REQUIRED_ARM_PREFIX} ${requiredStudentPathArm(summary.verdict)}`,
      ...decisionText(summary.verdict),
      '# Context / options considered',
      `Config_Identity: ${summary.configHash}.`,
      'The verdict and every criterion, as the Sweep_Summary printed them:',
      '```',
      ...lines,
      '```',
      'Per Strategy_Arm, Model_Arm, and design, with the coverage-gap and operator blocks',
      '(Requirement 10.1 to 10.6):',
      '```',
      ...summary.groupLines,
      '```',
      '# Rationale',
      'The verdict is the pre-registered rule evaluated by `evaluateGroundingCriterion` over the',
      "Sweep_Manifest's own recorded criterion; no figure here was entered by hand.",
      '',
      'The size was chosen against the Exploratory_Run `773b798cf6bbe129`, whose per-mutant',
      "figures are recorded verbatim in this run's `powerArithmetic`.",
      '',
      'The Replay_Gate report the Campaign refused to start without:',
      '```json',
      ...replayGateBlock(manifestText),
      '```',
      '# Revisit trigger',
      'The functional repair loop with a non-circular feedback source, then reference-free',
      'checking: a Python reference model plus RTL-candidate adjudication, which removes the',
      'dependency on a benchmark reference design entirely.',
      '# Caveats',
      'Requirement 4.12 is a checked fact for the CAMPAIGN HOST ONLY: `runsc` cannot run on this',
      'development host, so `default-timescale-image.integration.test.ts` skipped here and the',
      "production image's Icarus was never asked whether it honours the Default_Timescale_Entry.",
      'See `real-oracle-and-containment-unexercised-m0`.',
      '# Links',
      '- .kiro/specs/grounding-adoption-confirmatory/requirements.md (Requirements 6 to 11)',
      `- .eval-runs/${summary.runName}/summary.txt`,
      `- .eval-runs/${summary.runName}/replay-gate.json`,
      '',
    ].join('\n'),
  };
};

/** Read the Grounding summary's own blocks, which have different headers from the scoreboard's. */
export function groundingSummaryOf(
  summaryText: string,
  manifestText: string,
): CampaignSummary | string {
  const identity = readRunIdentity(manifestText);
  if (typeof identity === 'string') {
    return identity;
  }
  const lines = summaryText.split('\n');
  const verdictLine = lines.find((line) => line.trimStart().startsWith(GROUNDING_VERDICT_PREFIX));
  if (verdictLine === undefined) {
    // A reason string, which the `readSummary` contract already allows; throwing here was
    // reported as the misleading "the run directory has no summary.txt or manifest.json".
    return 'the summary holds no GROUNDING VERDICT line';
  }
  const verdict =
    verdictLine
      .slice(verdictLine.indexOf(':') + 1)
      .trim()
      .split(' ')[0] ?? '';
  return {
    runName: identity.runName,
    configHash: identity.configHash,
    verdict: verdict as CampaignSummary['verdict'],
    verdictLines: [
      verdictLine.trim(),
      ...CONFIRMATORY_CLAUSES.flatMap((clause) => linesStartingWith(lines, `${clause.id} `)),
      ...linesStartingWith(lines, 'pairs observed'),
      ...linesStartingWith(lines, 'slot-pairs '),
      ...linesStartingWith(lines, 'deferred '),
    ],
    groupLines: [
      ...blockFrom(lines, GROUNDING_TABLE_HEADER).slice(1),
      ...linesStartingWith(lines, 'coverage-gap '),
      ...linesStartingWith(lines, 'operators '),
      ...blockFrom(lines, CROSS_RUN_LABEL),
    ],
  };
}

async function main(): Promise<void> {
  const runDir = process.argv[2];
  if (runDir === undefined) {
    console.error('usage: grounding-closeout <run directory>');
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const result = await runCloseout(
    resolve(root, runDir),
    join(root, 'chipAgent', '_inbox'),
    {
      readText: (path) => readFile(path, 'utf8'),
      writeNew: (path, text) => writeFile(path, text, { encoding: 'utf8', flag: 'wx' }),
      regenerateManifest: () =>
        spawnSync('npm', ['run', 'vault:manifest'], { cwd: root, stdio: 'inherit' }).status === 0,
      now: () => new Date().toISOString(),
    },
    GROUNDING_CLOSEOUT,
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
    console.error(`grounding-closeout: ${reason}`);
    process.exitCode = 1;
  });
}
