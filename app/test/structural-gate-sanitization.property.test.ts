// structural-gate-toolchain, Property 2: No tool output reaches a Lint_Result or a
// StructuralGateResult, and neither adapter throws (task 5.4; Req 5.6, 5.7, 8.10, 8.11).
//
// TWO ADAPTERS, ONE CLAIM
//   `YosysCheckLintAdapter.lint` (`app/tools/lint/adapter.ts`) wraps its run-and-read in one
//   `try` that always degrades to the fixed `could-not-run` reason; `ToolchainStructuralGate.admit`
//   (`app/agent/consensus/structural-gate-adapter.ts`) wraps every check in `#settle`, which maps a
//   throw to `false` and otherwise keeps only `{name, passed}`. Both are therefore sanitizing BY
//   CONSTRUCTION - a `LintResult` carries only a reason drawn from a fixed table, and a
//   `StructuralGateResult` carries no field wide enough to hold tool output at all. This property
//   proves that holds under every dependency failure shape the task names, not just the ones each
//   adapter's own unit tests happened to construct.
//
// THE PLANTED NEEDLE
//   `arbPlantedString` draws a host-path-or-URL-shaped string with a random suffix, so it is both
//   a plausible leak (a real sandbox path or an internal host) and, by its randomness, never a
//   substring of either adapter's fixed prose. Per
//   `chipAgent/_inbox/gotcha-a-credential-leak-property-written-as-containment-is-both-unsound-and-weak.md`,
//   a containment check over a RANDOM value this way is sound (no fixed string can coincidentally
//   contain it); it would not be sound over a short, colliding value, which is why the needle here
//   is a long random suffix rather than a short fixed guess.
//
// WHERE THE NEEDLE IS PLANTED, PER THE TASK'S OWN DRAW LIST
//   `interpretLintResult` and `ToolchainStructuralGate`'s per-check closures read nothing from
//   `SandboxResult.stdout`/`.stderr`, `SimulationVerdict.stdout`/`.stderr`, or a thrown/rejected
//   error's `.message` - those are exactly the fields a naive implementation could have forwarded,
//   so the needle lives there, never inside a well-formed lint report (whose text IS read, but only
//   through `interpretLintResult`'s fixed-reason table, per that function's own header comment).
//
// WHAT A SAMPLED DRAW WOULD MISS, PINNED BY CONSTRUCTION (per the task's own draw list)
//   - a dependency that throws synchronously - the shape a bad job or a defect in the dependency
//     itself takes, caught at the first synchronous step before any `await`.
//   - a dependency whose promise rejects - the shape an infrastructure failure takes.
//   - a dependency that resolves normally but plants the needle in a stream or a result field a
//     naive caller might read directly instead of through the adapter's own interpretation.
//   Every one of the four Lint_Adapter shapes and nine Structural_Gate_Adapter shapes
//   (3 dependencies x 3 fault kinds) is tracked and asserted drawn at least once, rather than
//   trusted to turn up by chance, per
//   `chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`.
//
// Validates: Requirements 5.6, 5.7, 8.10, 8.11

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { STRUCTURAL_GATE_CHECK_ORDER, ToolchainStructuralGate } from '@app/agent';
import type { ToolchainStructuralGateDeps } from '@app/agent';
import type { ModuleInterface, Spec } from '@app/core';
import {
  YosysCheckLintAdapter,
  type ArtifactBlobRef,
  type ArtifactTextReader,
  type LintAdapter,
  type LintResult,
  type ResourceLimits,
  type SandboxJob,
  type SandboxResult,
  type SimulationVerdict,
  type SimulatorAdapter,
  type SourceFile,
  type ToolRunner,
} from '@app/tools';

import { LOWER_ALPHA, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'structural-gate-toolchain, Property 2: No tool output reaches a Lint_Result or a ' +
  'StructuralGateResult, and neither adapter throws';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 };
const TOP_MODULE = 'alu';
const RTL: readonly SourceFile[] = [{ path: 'alu.v', contents: 'module alu(); endmodule' }];
const RESOURCE_USAGE = { wallMs: 10, maxMemMb: 8, cpuMs: 9 };

/** A host-path-or-URL-shaped string with a random suffix: a plausible leak, never a coincidence. */
function arbPlantedString(): fc.Arbitrary<string> {
  const suffix = stringFromChars(LOWER_ALPHA, 8, 16);
  return fc.oneof(
    suffix.map((s) => `/host/secret-${s}/workspace`),
    suffix.map((s) => `https://internal-${s}.example/leak`),
  );
}

/** An `Error` whose message carries `needle`, as a thrown job defect or rejected run would. */
function plantedError(needle: string): Error {
  return new Error(`unexpected failure reaching /host/${needle}`);
}

// ---------------------------------------------------------------------------------------------
// YosysCheckLintAdapter.lint
// ---------------------------------------------------------------------------------------------

const LINT_REPORT_ARTIFACT: ArtifactBlobRef = {
  name: 'lint-report.json',
  sizeBytes: 32,
  sha256: 'a'.repeat(64),
};

/** A clean `SandboxResult` for a `lint` job, with `needle` planted in `stdout` and `stderr`. */
function lintSandboxResultWithPlant(needle: string): SandboxResult {
  return {
    verdict: 'pass',
    timedOut: false,
    exitCode: 0,
    stdout: `tool diagnostic mentioning ${needle}`,
    stderr: `tool diagnostic mentioning ${needle}`,
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { lintReport: LINT_REPORT_ARTIFACT },
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
  };
}

/** The four Lint_Adapter dependency-failure shapes the task names (plus the retention-miss shape
 * `lint.test.ts` already covers through `readText` resolving `null`, kept out of this closed set
 * because it carries no needle to check). */
type LintFault = 'runner-throws' | 'runner-rejects' | 'runner-resolves-planted' | 'reader-rejects';

const LINT_FAULTS: readonly LintFault[] = [
  'runner-throws',
  'runner-rejects',
  'runner-resolves-planted',
  'reader-rejects',
];

/** Build the `(ToolRunner, ArtifactTextReader)` pair for one `LintFault`, planting `needle`. */
function lintDepsFor(
  fault: LintFault,
  needle: string,
): { readonly toolRunner: ToolRunner; readonly artifacts: ArtifactTextReader } {
  switch (fault) {
    case 'runner-throws':
      return {
        toolRunner: {
          run: () => {
            throw plantedError(needle);
          },
        },
        artifacts: { readText: () => Promise.resolve(null) },
      };
    case 'runner-rejects':
      return {
        toolRunner: { run: () => Promise.reject(plantedError(needle)) },
        artifacts: { readText: () => Promise.resolve(null) },
      };
    case 'runner-resolves-planted':
      return {
        toolRunner: { run: () => Promise.resolve(lintSandboxResultWithPlant(needle)) },
        artifacts: {
          readText: () => Promise.resolve(JSON.stringify({ reachedCheck: true, problemCount: 0 })),
        },
      };
    case 'reader-rejects':
      return {
        toolRunner: { run: () => Promise.resolve(lintSandboxResultWithPlant('')) },
        artifacts: { readText: () => Promise.reject(plantedError(needle)) },
      };
    default: {
      const exhaustive: never = fault;
      return exhaustive;
    }
  }
}

describe(`${PROPERTY} (YosysCheckLintAdapter.lint)`, () => {
  it('never throws and never carries the planted string, for any run or read failure', async () => {
    const observed = new Set<LintFault>();

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...LINT_FAULTS),
        arbPlantedString(),
        async (fault, needle) => {
          observed.add(fault);
          const { toolRunner, artifacts } = lintDepsFor(fault, needle);
          const adapter = new YosysCheckLintAdapter(toolRunner, artifacts);

          let result: LintResult;
          try {
            result = await adapter.lint(RTL, TOP_MODULE, LIMITS);
          } catch (error) {
            throw new Error(`adapter.lint threw instead of resolving: ${String(error)}`);
          }

          // A throw or a rejection never produced a result, so it must degrade to could-not-run.
          // `runner-resolves-planted` plants the needle only in stdout/stderr, which
          // `interpretLintResult` never reads, so that shape legitimately still reads clean -
          // its job is proving the needle does not leak, not that the run failed.
          if (fault !== 'runner-resolves-planted') {
            expect(result.kind).toBe('could-not-run');
          }
          expect(JSON.stringify(result)).not.toContain(needle);
        },
      ),
      propertyParameters(),
    );

    // Non-vacuity: every one of the four dependency-failure shapes must actually have been drawn.
    expect(observed).toEqual(new Set(LINT_FAULTS));
  });
});

// ---------------------------------------------------------------------------------------------
// ToolchainStructuralGate.admit
// ---------------------------------------------------------------------------------------------

const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'alu',
  ports: [
    { name: 'a', direction: 'input', width: 8 },
    { name: 'y', direction: 'output', width: 8 },
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

function specWith(moduleInterface: ModuleInterface): Spec {
  return {
    id: 'spec-1',
    projectId: 'proj-1',
    goal: 'A trivial module',
    constraints: [],
    moduleInterface,
    timingContract: { entries: [] },
    acceptanceCriteria: [],
    architecture: 'n/a',
    approved: true,
    version: 1,
  };
}

/** A `SimulationVerdict` that compiled, for the passing compile check. */
function compiledVerdict(): SimulationVerdict {
  return {
    verdict: 'pass',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: 0,
    resourceUsage: RESOURCE_USAGE,
    failureCause: 'none',
    attributedFiles: [],
    watchdog: { stopped: false },
  };
}

const CLEAN_LINT: LintResult = { kind: 'clean', reason: 'The lint check found no problems.' };

/** A clean `SandboxResult` for a `synthesize` job: non-error, exit 0, `netlistJson` present. */
function synthesizePassResult(): SandboxResult {
  return {
    verdict: 'pass',
    timedOut: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { netlistJson: { name: 'netlist.json', sizeBytes: 10, sha256: 'a'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
  };
}

/** The three dependency-failure shapes the task names, applied to one dependency at a time. */
type GateFault = 'throws' | 'rejects' | 'resolves-planted';

const GATE_FAULTS: readonly GateFault[] = ['throws', 'rejects', 'resolves-planted'];

/** The three injected dependencies, one of which is made faulty per draw. */
type GateDependency = 'toolRunner' | 'simulator' | 'lint';

const GATE_DEPENDENCIES: readonly GateDependency[] = ['toolRunner', 'simulator', 'lint'];

/** The `StructuralGateCheckName` each dependency's failure is reported under. */
const CHECK_NAME_FOR_DEPENDENCY: Readonly<Record<GateDependency, string>> = {
  toolRunner: 'synthesis',
  simulator: 'compile',
  lint: 'lint',
};

/** A passing `ToolRunner`, dispatching only `synthesize` jobs (lint goes through `LintAdapter`). */
function passingToolRunner(): ToolRunner {
  return {
    run: (job: SandboxJob) => {
      if (job.kind !== 'synthesize') {
        throw new Error(`unexpected job kind in test fake: ${job.kind}`);
      }
      return Promise.resolve(synthesizePassResult());
    },
  };
}

/** The `ToolRunner` for one draw: faulty with `needle` planted iff this is the targeted dependency. */
function toolRunnerFor(dependency: GateDependency, fault: GateFault, needle: string): ToolRunner {
  if (dependency !== 'toolRunner') {
    return passingToolRunner();
  }
  switch (fault) {
    case 'throws':
      return {
        run: () => {
          throw plantedError(needle);
        },
      };
    case 'rejects':
      return { run: () => Promise.reject(plantedError(needle)) };
    case 'resolves-planted':
      return {
        run: (job: SandboxJob) => {
          if (job.kind !== 'synthesize') {
            throw new Error(`unexpected job kind in test fake: ${job.kind}`);
          }
          return Promise.resolve({
            ...synthesizePassResult(),
            stdout: `tool diagnostic mentioning ${needle}`,
            stderr: `tool diagnostic mentioning ${needle}`,
          });
        },
      };
    default: {
      const exhaustive: never = fault;
      return exhaustive;
    }
  }
}

/** The `SimulatorAdapter` for one draw: faulty with `needle` planted iff this is the target. */
function simulatorFor(
  dependency: GateDependency,
  fault: GateFault,
  needle: string,
): SimulatorAdapter {
  if (dependency !== 'simulator') {
    return { simulate: () => Promise.resolve(compiledVerdict()) };
  }
  switch (fault) {
    case 'throws':
      return {
        simulate: () => {
          throw plantedError(needle);
        },
      };
    case 'rejects':
      return { simulate: () => Promise.reject(plantedError(needle)) };
    case 'resolves-planted':
      return {
        simulate: () =>
          Promise.resolve({
            ...compiledVerdict(),
            stdout: `tool diagnostic mentioning ${needle}`,
            stderr: `tool diagnostic mentioning ${needle}`,
          }),
      };
    default: {
      const exhaustive: never = fault;
      return exhaustive;
    }
  }
}

/**
 * The `LintAdapter` for one draw: faulty with `needle` planted iff this is the targeted dependency.
 *
 * `resolves-planted` plants `needle` into the `LintResult.reason` field itself rather than into a
 * stream: `ToolchainStructuralGate` reads only `result.kind`, so this is the shape that proves the
 * gate discards a `LintAdapter`'s reason text, not merely that a well-behaved `LintAdapter` never
 * produces contaminated text in the first place (that is Property 1's job, task 4.5).
 */
function lintFor(dependency: GateDependency, fault: GateFault, needle: string): LintAdapter {
  if (dependency !== 'lint') {
    return { lint: () => Promise.resolve(CLEAN_LINT) };
  }
  switch (fault) {
    case 'throws':
      return {
        lint: () => {
          throw plantedError(needle);
        },
      };
    case 'rejects':
      return { lint: () => Promise.reject(plantedError(needle)) };
    case 'resolves-planted':
      return {
        lint: () =>
          Promise.resolve({
            kind: 'clean',
            reason: `tool diagnostic mentioning ${needle}`,
          }),
      };
    default: {
      const exhaustive: never = fault;
      return exhaustive;
    }
  }
}

/** Build the gate's deps for one draw, with `needle` planted on exactly the targeted dependency. */
function gateDepsFor(
  dependency: GateDependency,
  fault: GateFault,
  needle: string,
): ToolchainStructuralGateDeps {
  return {
    toolRunner: toolRunnerFor(dependency, fault, needle),
    simulator: simulatorFor(dependency, fault, needle),
    lint: lintFor(dependency, fault, needle),
  };
}

describe(`${PROPERTY} (ToolchainStructuralGate.admit)`, () => {
  it('never throws and never carries the planted string, for any single dependency failure', async () => {
    const observed = new Set<string>();

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...GATE_DEPENDENCIES),
        fc.constantFrom(...GATE_FAULTS),
        arbPlantedString(),
        async (dependency, fault, needle) => {
          observed.add(`${dependency}:${fault}`);
          const gate = new ToolchainStructuralGate(gateDepsFor(dependency, fault, needle));

          let result;
          try {
            result = await gate.admit(specWith(MODULE_INTERFACE), RTL, LIMITS);
          } catch (error) {
            throw new Error(`gate.admit threw instead of resolving: ${String(error)}`);
          }

          // Every check still runs, in the fixed order. A throw or a rejection never produced an
          // outcome, so `#settle` must report the targeted check failed; `resolves-planted` only
          // plants the needle in stdout/stderr, which no check reads, so that shape legitimately
          // still reports passed - its job is proving the needle does not leak, not that the
          // dependency failed.
          expect(result.checks.map((check) => check.name)).toEqual([
            ...STRUCTURAL_GATE_CHECK_ORDER,
          ]);
          if (fault !== 'resolves-planted') {
            const targetedCheckName = CHECK_NAME_FOR_DEPENDENCY[dependency];
            const targetedCheck = result.checks.find((check) => check.name === targetedCheckName);
            expect(targetedCheck?.passed).toBe(false);
          }
          expect(JSON.stringify(result)).not.toContain(needle);
        },
      ),
      propertyParameters(),
    );

    // Non-vacuity: every one of the nine (dependency, fault) shapes must actually have been drawn.
    const expected = new Set(
      GATE_DEPENDENCIES.flatMap((dependency) =>
        GATE_FAULTS.map((fault) => `${dependency}:${fault}`),
      ),
    );
    expect(observed).toEqual(expected);
  });
});
