// The pass@k measurement seam for the eval gate (task 19.5).
//
// The gate decision (`decideGateRun`) needs a pass@k MEASUREMENT. Producing one
// honestly means running the Eval_Harness (task 19.3) over the fixed subset
// through the REAL Simulator oracle under student-session caps. This module is the
// narrow seam that supplies that measurement, plus the honest default used until
// the real path exists.
//
// Two pieces live here:
//   - `measureViaHarness`: the real measurement path. Given fully-wired harness deps
//     (an `EvalVerificationLoopRunner` over the real oracle) it runs the subset and
//     reads the aggregate pass@k. This is what an ARMED gate calls on a provisioned
//     host.
//   - `createDefaultMeasurementProvider`: the honest default for environments where
//     the real path is not composed (including this CI). It probes for the EDA
//     toolchain and, finding it absent - or present but with no measurement provider
//     supplied - returns `unavailable` with a sanitized reason. It NEVER fabricates a
//     pass@k, upholding the prime directive.
//
// The probe deliberately treats only a spawn error (e.g. ENOENT) as "binary
// missing"; a non-zero exit from a version flag does not, mirroring the existing
// real-oracle probe used by the integration suites.

import { spawnSync } from 'node:child_process';

import { createEvalHarness, type EvalHarnessDeps } from '../harness.js';
import type { EvalProblem } from '../problem.js';
import type { GateMeasurement } from './gate-run.js';

/** Supplies a pass@k measurement for a given k, or reports why it cannot. */
export interface GateMeasurementProvider {
  measure(k: number): Promise<GateMeasurement>;
}

/**
 * Measure pass@k by running the Eval_Harness over the subset (the real path).
 *
 * Returns `measured` with the aggregate pass@k for `k` on success, or
 * `unavailable` when the harness config is invalid or the harness did not report
 * the requested k. The harness itself decides each sample with the Simulator
 * oracle; this function never inspects model output.
 */
export async function measureViaHarness(
  deps: EvalHarnessDeps,
  subset: readonly EvalProblem[],
  k: number,
): Promise<GateMeasurement> {
  const built = createEvalHarness(deps);
  if (!built.ok) {
    return { status: 'unavailable', reason: `eval harness misconfigured: ${built.error.message}` };
  }
  const report = await built.value.run(subset);
  const value = report.aggregatePassAtK[k];
  if (value === undefined) {
    return { status: 'unavailable', reason: `the harness did not report pass@${k}` };
  }
  return { status: 'measured', k, passAtK: value };
}

/**
 * Whether a binary is launchable on PATH (a spawn error means it is absent).
 *
 * Exported so the FORMAL chain probe in `../sweep/host-facts.ts` applies this exact rule
 * rather than a second copy of it: "only a spawn error counts as missing" is a measured
 * decision (a probe flag's exit status says nothing about whether a tool works), and two
 * copies could drift into disagreeing about whether a host can decide a verdict.
 */
export function binaryPresent(bin: string, args: readonly string[]): boolean {
  const result = spawnSync(bin, [...args], { encoding: 'utf8' });
  return result.error === undefined;
}

/** The outcome of probing the host for the real Icarus EDA toolchain. */
export interface OracleToolchainProbe {
  readonly available: boolean;
  readonly reason: string;
}

/**
 * Probe for the real Icarus toolchain (`iverilog` + `vvp`) on PATH.
 *
 * Used only to produce an accurate `unavailable` reason - presence of the tools is
 * necessary but not sufficient to measure pass@k, because a wired
 * `EvalVerificationLoopRunner` (model host, credential, sandbox runtime) is also
 * required.
 */
export function probeOracleToolchain(): OracleToolchainProbe {
  if (!binaryPresent('iverilog', ['-V'])) {
    return { available: false, reason: 'iverilog is not installed on PATH' };
  }
  if (!binaryPresent('vvp', ['-V'])) {
    return { available: false, reason: 'vvp is not installed on PATH' };
  }
  return { available: true, reason: 'iverilog + vvp are present' };
}

/**
 * Build the reason a default (unwired) environment cannot measure pass@k for `k`.
 *
 * Precise on purpose so a skipped measurement is never mistaken for a pass: it
 * names either the missing toolchain or the missing harness wiring.
 */
function defaultUnavailableReason(k: number, probe: OracleToolchainProbe): string {
  if (!probe.available) {
    return `real EDA toolchain absent (${probe.reason}); pass@${k} cannot be measured here`;
  }
  return (
    `real EDA toolchain present, but this run supplied no wired measurement provider ` +
    `(an EvalVerificationLoopRunner needs a model host, a credential, and a sandbox ` +
    `runtime); pass@${k} cannot be measured here`
  );
}

/**
 * The honest default measurement provider for environments without a wired real
 * oracle path (including CI).
 *
 * It probes the toolchain to produce an accurate reason and always returns
 * `unavailable`; it never fabricates a pass@k. A provisioned host arms the gate by
 * supplying a provider backed by `measureViaHarness` over a wired
 * `EvalVerificationLoopRunner` instead of this one.
 */
export function createDefaultMeasurementProvider(): GateMeasurementProvider {
  const probe = probeOracleToolchain();
  return {
    measure: (k: number): Promise<GateMeasurement> =>
      Promise.resolve({ status: 'unavailable', reason: defaultUnavailableReason(k, probe) }),
  };
}
