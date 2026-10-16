// Campaign_Closeout (C14): turn a finished A/B Campaign run directory into exactly one
// `status: candidate` vault note, then regenerate the vault manifest (Req 11.3-11.9).
//
// Every figure is copied from the run's own `summary.txt`, which `renderCampaignReport` computed
// from the Results_Log; the script has no input for a number. It reads nothing but the run
// directory and never writes into it, so a failed closeout leaves the evidence untouched.

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The verdicts `renderCampaignReport` prints; anything else is not a Campaign summary. */
const VERDICTS = ['succeeded', 'failed', 'not-decided'] as const;
type Verdict = (typeof VERDICTS)[number];

const TABLE_HEADER = 'A/B CAMPAIGN TABLE';
const VERDICT_PREFIX = 'CAMPAIGN VERDICT: ';
const CONFIG_HASH = /^[0-9a-f]{16}$/;
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What the closeout read out of the run directory. */
export interface CampaignSummary {
  readonly runName: string;
  readonly configHash: string;
  readonly verdict: Verdict;
  /** The verdict line and the criterion lines beneath it, verbatim. */
  readonly verdictLines: readonly string[];
  /** The table's Design_Group cells, one line per (Strategy_Arm, Model_Arm, Design_Group). */
  readonly groupLines: readonly string[];
}

/** The verdict block: the verdict line and every line after it. */
function verdictBlock(lines: readonly string[]): readonly string[] | null {
  const start = lines.findIndex((line) => line.startsWith(VERDICT_PREFIX));
  return start === -1 ? null : lines.slice(start).filter((line) => line.trim().length > 0);
}

/** The table's model headers and its Design_Group cells; per-design cells name a `/` path. */
function groupCellLines(lines: readonly string[]): readonly string[] {
  const start = lines.findIndex((line) => line.startsWith(TABLE_HEADER));
  if (start === -1) {
    return [];
  }
  const end = lines.findIndex((line, index) => index > start && line.trim().length === 0);
  const table = lines.slice(start + 1, end === -1 ? undefined : end);
  return table.filter((line) => line.startsWith('  model-arm ') || /^ {4}\S+ +[a-z-]+:/.test(line));
}

/** A run's own identity, validated: its name and the Config_Identity it ran under. */
export interface RunIdentity {
  readonly runName: string;
  readonly configHash: string;
}

/**
 * The run's identity from its manifest, or a sanitized reason string (never throws).
 *
 * One owner for both Campaigns, so neither can hardcode a run name or accept an unvalidated
 * one. The manifest is untrusted file input: a name outside the safe pattern is refused rather
 * than interpolated into a file path.
 */
export function readRunIdentity(manifestText: string): RunIdentity | string {
  let manifest: { readonly runName?: unknown; readonly configHash?: unknown };
  try {
    manifest = JSON.parse(manifestText) as typeof manifest;
  } catch {
    return 'the run manifest is not JSON';
  }
  const { runName, configHash } = manifest;
  if (typeof runName !== 'string' || !RUN_NAME.test(runName)) {
    return 'the run manifest names no valid run';
  }
  if (typeof configHash !== 'string' || !CONFIG_HASH.test(configHash)) {
    return 'the run manifest carries no valid config hash';
  }
  return { runName, configHash };
}

/** Read the Campaign summary out of a run's `summary.txt` and `manifest.json`, or why not. */
export function readCampaignSummary(
  summaryText: string,
  manifestText: string,
): CampaignSummary | string {
  const identity = readRunIdentity(manifestText);
  if (typeof identity === 'string') {
    return identity;
  }
  const { runName, configHash } = identity;
  const lines = summaryText.split('\n');
  const verdictLines = verdictBlock(lines);
  const verdict = verdictLines?.[0]?.slice(VERDICT_PREFIX.length).split(' ')[0];
  if (verdictLines === null || !VERDICTS.includes(verdict as Verdict)) {
    return 'the summary holds no Campaign verdict';
  }
  return {
    runName,
    configHash,
    verdict: verdict as Verdict,
    verdictLines,
    groupLines: groupCellLines(lines),
  };
}

/** What the verdict decides for the Student_Path; under every verdict it stays Cycle_Timed. */
function decisionText(verdict: Verdict): readonly string[] {
  if (verdict === 'succeeded') {
    return [
      'The pre-registered Success_Criterion held.',
      'The Student_Path keeps Cycle_Timed: making In_Order_Scoreboard its default is decided together with the reference-free checking spec that follows this one (Req 11.6).',
    ];
  }
  return [
    `Measured negative: the Campaign_Verdict is \`${verdict}\`, so In_Order_Scoreboard is not adopted.`,
    'The Student_Path keeps Cycle_Timed as its default Checking_Approach (Req 11.1, 11.2).',
  ];
}

/** The one vault note, from the template's sections, with every figure copied from the summary. */
export function closeoutNote(summary: CampaignSummary, timestamp: string): string {
  return [
    '---',
    'type: decision',
    `title: In_Order_Scoreboard A/B Campaign ${summary.runName} verdict is ${summary.verdict}`,
    'status: candidate',
    `provenance: app/eval/scripts/scoreboard-closeout.ts over .eval-runs/${summary.runName} (config ${summary.configHash})`,
    'tags: [eval, testbench, testbench-in-order-scoreboard, campaign, measured]',
    `timestamp: ${timestamp}`,
    '---',
    '# Decision',
    ...decisionText(summary.verdict),
    '# Context / options considered',
    `Config_Identity: ${summary.configHash}.`,
    'Criteria 10.5 to 10.8 and the per-Model_Arm Streaming_Group figures, as the Sweep_Summary printed them:',
    '```',
    ...summary.verdictLines,
    '```',
    'Per Strategy_Arm, Model_Arm, and Design_Group:',
    '```',
    ...summary.groupLines,
    '```',
    '# Rationale',
    'The verdict is the pre-registered rule evaluated by `evaluateSuccessCriterion`; no figure here was entered by hand.',
    '# Revisit trigger',
    'The reference-free checking spec, or a Campaign under a new TESTBENCH_PROMPT_VERSION.',
    '# Links',
    '- .kiro/specs/testbench-in-order-scoreboard/requirements.md (Requirements 10, 11)',
    `- .eval-runs/${summary.runName}/summary.txt`,
    '',
  ].join('\n');
}

/** The filesystem and process effects the closeout needs, injected so a test can fail each. */
export interface CloseoutPorts {
  readonly readText: (path: string) => Promise<string>;
  /** Writes a NEW file; must refuse to overwrite. */
  readonly writeNew: (path: string, text: string) => Promise<void>;
  /** Runs `npm run vault:manifest`; true when it succeeded. */
  readonly regenerateManifest: () => boolean;
  readonly now: () => string;
}

export interface CloseoutResult {
  readonly exitCode: 0 | 1;
  readonly lines: readonly string[];
}

const INCOMPLETE = 'closeout incomplete';

/** Renders the vault note for one closed-out Campaign; the Campaign supplies its own. */
export type CloseoutNoteRenderer = (
  summary: CampaignSummary,
  timestamp: string,
  manifestText: string,
) => { readonly fileName: string; readonly text: string };

/** How one Campaign reads its own summary and renders its own note. */
export interface CampaignCloseout {
  /** Returns the summary, or a sanitized reason string the caller reports as incomplete. */
  readonly readSummary: (summaryText: string, manifestText: string) => CampaignSummary | string;
  readonly renderNote: CloseoutNoteRenderer;
}

/** The scoreboard Campaign's own pair, so `runCloseout` has no Campaign-specific branch. */
const SCOREBOARD_CLOSEOUT: CampaignCloseout = {
  readSummary: readCampaignSummary,
  renderNote: (summary, timestamp) => ({
    fileName: `decision-${summary.runName}-campaign-verdict.md`,
    text: closeoutNote(summary, timestamp),
  }),
};

/** Close out one run directory into `inboxDir` (Req 11.3-11.9). */
export async function runCloseout(
  runDir: string,
  inboxDir: string,
  ports: CloseoutPorts,
  closeout: CampaignCloseout = SCOREBOARD_CLOSEOUT,
): Promise<CloseoutResult> {
  let summary: CampaignSummary | string;
  let manifestText = '';
  try {
    manifestText = await ports.readText(join(runDir, 'manifest.json'));
    summary = closeout.readSummary(await ports.readText(join(runDir, 'summary.txt')), manifestText);
  } catch {
    summary = 'the run directory has no summary.txt or manifest.json';
  }
  if (typeof summary === 'string') {
    return { exitCode: 1, lines: [`${INCOMPLETE}: ${summary}`] };
  }
  const note = closeout.renderNote(summary, ports.now(), manifestText);
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
  return { exitCode: 0, lines: [`closeout: ${summary.verdict}, note at ${notePath}`] };
}

async function main(): Promise<void> {
  const runDir = process.argv[2];
  if (runDir === undefined) {
    console.error('usage: scoreboard-closeout <run directory>');
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const result = await runCloseout(resolve(root, runDir), join(root, 'chipAgent', '_inbox'), {
    readText: (path) => readFile(path, 'utf8'),
    writeNew: (path, text) => writeFile(path, text, { encoding: 'utf8', flag: 'wx' }),
    regenerateManifest: () =>
      spawnSync('npm', ['run', 'vault:manifest'], { cwd: root, stdio: 'inherit' }).status === 0,
    now: () => new Date().toISOString(),
  });
  for (const line of result.lines) {
    console.log(line);
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main();
}
