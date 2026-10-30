// The runnable eval pass@k gate entry (task 19.5, Req 15.4, 15.7).
//
// This is the gate entry a CI job runs, via the `@app/eval` `gate` script. The
// `eval-gate` job in `.github/workflows/ci.yml` is still the disarmed echo
// placeholder and does NOT invoke it yet; that wiring belongs with arming the
// baseline. It:
//   1. reads the version-controlled `eval-baseline.json`,
//   2. resolves it to an `EvalGate` (unarmed by default, Req 15.7),
//   3. obtains a pass@k measurement (through the real oracle when wired), and
//   4. applies the REAL ratcheting decision `decideGateRun` -> `decideEvalGate`.
//
// It exits non-zero ONLY when the gate is armed AND the decision blocks. While
// unarmed it prints the measured pass@k (or why it could not be measured) and
// exits 0, so the lint/type/unit/property gates remain the merge authority and
// bootstrapping merges are never deadlocked (Req 15.7). Because no verified
// baseline exists yet - and the real EDA toolchain is absent here - it runs the
// real decision path but always allows the merge, ready to block the day the
// baseline in `eval-baseline.json` is armed.
//
// The `runEvalGate` function is dependency-injectable (config path + measurement
// provider) so it is unit-tested without the filesystem or a real oracle; the thin
// `main` wrapper wires the real defaults and owns stdout and the process exit code.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Result } from '@app/core';

import { parseBaselineConfig, type ParsedBaselineConfig } from './baseline-config.js';
import { decideGateRun, type GateRunResult } from './gate-run.js';
import { createDefaultMeasurementProvider, type GateMeasurementProvider } from './measure.js';

/** The committed baseline config filename, resolved relative to this module. */
const BASELINE_FILENAME = 'eval-baseline.json';

/**
 * The default path to `eval-baseline.json`.
 *
 * This module compiles to `app/eval/dist/gate/cli.js`, while the config lives at
 * the package root `app/eval/eval-baseline.json`, so the default climbs two
 * directories out of `dist/gate`. Tests inject an explicit path instead.
 */
function defaultConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', BASELINE_FILENAME);
}

/** Injectable dependencies for a gate run; all default to the real wiring. */
export interface RunEvalGateOptions {
  /** Path to the baseline config file; defaults to the committed one. */
  readonly configPath?: string;
  /** The pass@k measurement provider; defaults to the honest toolchain-probing one. */
  readonly measurementProvider?: GateMeasurementProvider;
}

/**
 * Load and validate the baseline config, returning a sanitized error string on
 * failure (never a path or stack trace). A broken or missing config is a real
 * misconfiguration, so the caller treats it as a blocking failure.
 */
async function loadConfig(configPath: string): Promise<Result<ParsedBaselineConfig, string>> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    return { ok: false, error: `could not read ${BASELINE_FILENAME}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${BASELINE_FILENAME} is not valid JSON` };
  }
  const parsed = parseBaselineConfig(raw);
  if (!parsed.ok) {
    return { ok: false, error: `${BASELINE_FILENAME} is invalid: ${parsed.error.message}` };
  }
  return { ok: true, value: parsed.value };
}

/**
 * Run the eval gate and return its decision without touching stdout or the process
 * exit code, so it is fully unit-testable. A configuration failure blocks (exit 1);
 * otherwise the outcome is the pure `decideGateRun` decision over the measurement.
 */
export async function runEvalGate(options: RunEvalGateOptions = {}): Promise<GateRunResult> {
  const configPath = options.configPath ?? defaultConfigPath();
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) {
    return {
      exitCode: 1,
      blocked: true,
      lines: ['eval pass@k gate: configuration error.', loaded.error],
    };
  }
  const provider = options.measurementProvider ?? createDefaultMeasurementProvider();
  const measurement = await provider.measure(loaded.value.k);
  return decideGateRun(loaded.value, measurement);
}

/** Wire the real defaults, print the decision to stdout, and set the exit code. */
async function main(): Promise<void> {
  const result = await runEvalGate();
  for (const line of result.lines) {
    console.log(line);
  }
  process.exitCode = result.exitCode;
}

// Run only when executed directly (e.g. `node app/eval/dist/gate/cli.js`), not when
// imported by a test. Any unexpected throw fails the job safely (non-zero exit).
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`eval pass@k gate failed: ${message}`);
    process.exitCode = 1;
  });
}
