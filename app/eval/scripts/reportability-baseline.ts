// The Pinned_Baseline (testbench-failure-reportability, C9): counts captured testbenches holding
// a valueless failure report. Filesystem reads and one pure detector only: no model router, no
// simulator, no sandbox (Req 7.5, 8.14), and no `results.jsonl`, whose v16 records v17 refuses.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countValuelessFailureReports } from '@app/tools';

/** One arm or one total: how many sources held at least one report, out of how many. */
export interface ReportabilityTally {
  readonly withReport: number;
  readonly sources: number;
}

/** The committed Pinned_Baseline (Req 7.1 to 7.5). Every figure is measured, none estimated. */
export interface ReportabilityBaseline {
  readonly schemaVersion: 1;
  /** The source run and its Config_Identity, read from its manifest rather than inferred. */
  readonly source: { readonly runPath: string; readonly configHash: string };
  /** The detector rule the figures were taken under, so a later recount is comparable. */
  readonly detector: { readonly literalSubstring: 'FAIL'; readonly caseSensitive: true };
  readonly total: ReportabilityTally;
  readonly perModelArm: Readonly<Record<string, ReportabilityTally>>;
  readonly perStrategyArm: Readonly<Record<string, ReportabilityTally>>;
  readonly label: 'measured';
}

/** One captured testbench, keyed by the `<model>.<strategy>` arm directory it sits under. */
export interface CapturedTestbench {
  readonly armDir: string;
  readonly source: string;
}

/** The only file counted; `pre-normalization-testbench.v` is the raw reply, not what ran. */
export const TESTBENCH_FILENAME = 'testbench.v';
/** The default source run, relative to the repository root. */
export const BASELINE_RUN_PATH = '.eval-runs/grounding-confirmatory-v1';
/** The committed baseline file, relative to the repository root. */
export const BASELINE_FILE_PATH = 'app/eval/reportability-baseline.json';

const CONFIG_HASH_PATTERN = /^[0-9a-f]{16}$/;
/** This module's directory, for the both-layouts path rule (dist runs one level deeper). */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** Split an arm directory at its last dot into the Model_Arm and the Strategy_Arm. */
export function splitArmDir(armDir: string): { readonly model: string; readonly strategy: string } {
  const dot = armDir.lastIndexOf('.');
  if (dot <= 0 || dot === armDir.length - 1) {
    throw new Error(`arm directory "${armDir}" is not <model>.<strategy>`);
  }
  return { model: armDir.slice(0, dot), strategy: armDir.slice(dot + 1) };
}

/** Add one source to the tally under `key`, creating the tally on first sight. */
function bump(tallies: Map<string, ReportabilityTally>, key: string, hasReport: boolean): void {
  const prior = tallies.get(key) ?? { withReport: 0, sources: 0 };
  tallies.set(key, {
    withReport: prior.withReport + (hasReport ? 1 : 0),
    sources: prior.sources + 1,
  });
}

/** Tally every source: a source counts when the detector finds at least one report in it. */
export function tallyBaseline(
  testbenches: readonly CapturedTestbench[],
  source: ReportabilityBaseline['source'],
): ReportabilityBaseline {
  const perModel = new Map<string, ReportabilityTally>();
  const perStrategy = new Map<string, ReportabilityTally>();
  const total = new Map<string, ReportabilityTally>();
  for (const { armDir, source: text } of testbenches) {
    const { model, strategy } = splitArmDir(armDir);
    const hasReport = countValuelessFailureReports(text) > 0;
    bump(perModel, model, hasReport);
    bump(perStrategy, strategy, hasReport);
    bump(total, 'all', hasReport);
  }
  const sorted = (tallies: Map<string, ReportabilityTally>) =>
    Object.fromEntries([...tallies].sort(([a], [b]) => a.localeCompare(b)));
  return {
    schemaVersion: 1,
    source,
    detector: { literalSubstring: 'FAIL', caseSensitive: true },
    total: total.get('all') ?? { withReport: 0, sources: 0 },
    perModelArm: sorted(perModel),
    perStrategyArm: sorted(perStrategy),
    label: 'measured',
  };
}

/** Directory entries that are directories, by name, in a stable order. */
async function subdirectories(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Read every `<arm>/<design>/<sample>/testbench.v` under `artifactsRoot`; absent ones skip. */
export async function collectTestbenches(
  artifactsRoot: string,
): Promise<readonly CapturedTestbench[]> {
  const found: CapturedTestbench[] = [];
  for (const armDir of await subdirectories(artifactsRoot)) {
    for (const design of await subdirectories(join(artifactsRoot, armDir))) {
      for (const sample of await subdirectories(join(artifactsRoot, armDir, design))) {
        const path = join(artifactsRoot, armDir, design, sample, TESTBENCH_FILENAME);
        const source = await readFile(path, 'utf8').catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
          }
          throw error;
        });
        if (source !== null) {
          found.push({ armDir, source });
        }
      }
    }
  }
  return found;
}

/** The run's recorded Config_Identity, refused when the manifest does not carry a valid one. */
export function configHashOf(manifestText: string): string {
  const parsed = JSON.parse(manifestText) as { readonly configHash?: unknown };
  if (typeof parsed.configHash !== 'string' || !CONFIG_HASH_PATTERN.test(parsed.configHash)) {
    throw new Error('manifest.json carries no 16-hex configHash');
  }
  return parsed.configHash;
}

/** One line per scope, so the run prints exactly what the committed file records. */
export function renderBaseline(baseline: ReportabilityBaseline): readonly string[] {
  const line = (scope: string, { withReport, sources }: ReportabilityTally) =>
    `${scope}: ${withReport}/${sources} (${((100 * withReport) / sources).toFixed(1)}%)`;
  return [
    `source ${baseline.source.runPath} (config ${baseline.source.configHash})`,
    line('all', baseline.total),
    ...Object.entries(baseline.perModelArm).map(([model, tally]) => line(model, tally)),
    ...Object.entries(baseline.perStrategyArm).map(([strategy, tally]) => line(strategy, tally)),
  ];
}

/** Count the run at `runPath` and write the baseline to `outPath`, both repository-relative. */
export async function runBaseline(runPath: string, outPath: string): Promise<readonly string[]> {
  const runDir = resolve(REPOSITORY_ROOT, runPath);
  const configHash = configHashOf(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  const testbenches = await collectTestbenches(join(runDir, 'artifacts'));
  const baseline = tallyBaseline(testbenches, {
    runPath: relative(REPOSITORY_ROOT, runDir),
    configHash,
  });
  await writeFile(resolve(REPOSITORY_ROOT, outPath), `${JSON.stringify(baseline, null, 2)}\n`);
  return renderBaseline(baseline);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [runPath = BASELINE_RUN_PATH, outPath = BASELINE_FILE_PATH] = process.argv.slice(2);
  runBaseline(runPath, outPath)
    .then((lines) => process.stdout.write(`${lines.join('\n')}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`reportability-baseline: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
