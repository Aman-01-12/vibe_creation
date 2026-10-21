// structural-gate-toolchain, Property 4: Four checks, in order, all run, admitted exactly when
// all pass (task 5.2; Req 6.4, 8.2, 8.4, 8.5, 8.6, 8.7, 8.10).
//
// THE ORACLE IS INDEPENDENT OF THE CODE UNDER TEST
//   The four booleans drawn below are the test's own ground truth for what each check should
//   report. The gate is wired, through fakes for `ToolRunner`/`SimulatorAdapter`/`LintAdapter`
//   plus a matching or mismatched Declared_Interface, so each check's outcome is forced to equal
//   its own drawn boolean. The assertions compare `admit`'s result against those four booleans
//   directly - never against anything `admit` itself computed - so this is a real check of the
//   composition, not a restatement of it.
//
// WHAT A SAMPLED DRAW WOULD MISS, PINNED BY CONSTRUCTION (per the task's own draw list)
//   - all four checks passing: the ordinary admitted case.
//   - all four checks failing: the ordinary refused case.
//   - exactly one failing check, at each of the four positions in turn: the only way run-all
//     (no short-circuiting) is actually visible, since the other three checks must still report
//     their own (passing) outcome around the one failure.
//
// Validates: Requirements 6.4, 8.2, 8.4, 8.5, 8.6, 8.7, 8.10

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { STRUCTURAL_GATE_CHECK_ORDER, ToolchainStructuralGate } from '@app/agent';
import type { ToolchainStructuralGateDeps } from '@app/agent';
import type { ModuleInterface, Spec } from '@app/core';
import type {
  LintAdapter,
  LintResult,
  ResourceLimits,
  SandboxJob,
  SandboxResult,
  SimulationVerdict,
  SimulatorAdapter,
  SourceFile,
  ToolRunner,
} from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY =
  'structural-gate-toolchain, Property 4: Four checks, in order, all run, admitted exactly when all pass';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 };

const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'alu',
  ports: [
    { name: 'a', direction: 'input', width: 8 },
    { name: 'y', direction: 'output', width: 8 },
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

/** A Declared_Interface the RTL below cannot satisfy, forcing the Interface_Check to fail. */
const MISMATCHED_MODULE_INTERFACE: ModuleInterface = {
  ...MODULE_INTERFACE,
  moduleName: 'not_the_rtl',
};

const RTL: readonly SourceFile[] = [
  { path: 'alu.v', contents: 'module alu(input [7:0] a, output [7:0] y); endmodule' },
];

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

/** A full resource-usage fixture every `SimulationVerdict`/`SandboxResult` needs. */
const RESOURCE_USAGE = { wallMs: 10, maxMemMb: 8, cpuMs: 9 };

/** A `SimulationVerdict` that compiled (any verdict other than `error`), for the compile check. */
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

/** A `SimulationVerdict` that failed to compile (the sandbox classifies a compile failure `error`). */
function uncompiledVerdict(): SimulationVerdict {
  return { ...compiledVerdict(), verdict: 'error', failureCause: 'build-failed' };
}

/** A fake `SimulatorAdapter` that always answers the given verdict, regardless of its arguments. */
function fakeSimulator(verdict: SimulationVerdict): SimulatorAdapter {
  return { simulate: () => Promise.resolve(verdict) };
}

/** A fake `LintAdapter` that always answers the given result. */
function fakeLint(result: LintResult): LintAdapter {
  return { lint: () => Promise.resolve(result) };
}

const CLEAN_LINT: LintResult = { kind: 'clean', reason: 'The lint check found no problems.' };
const FINDINGS_LINT: LintResult = {
  kind: 'findings',
  problemCount: 1,
  reason: 'The lint check found one or more problems.',
};

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

/** A `SandboxResult` the Synthesis_Check must fail: the sandbox classified the run `error`. */
function synthesizeFailResult(): SandboxResult {
  return { ...synthesizePassResult(), verdict: 'error', exitCode: null, artifacts: {} };
}

/** A `ToolRunner` whose `run` only ever receives `synthesize` jobs (lint goes through `LintAdapter`). */
function fakeToolRunner(synthesizeResult: SandboxResult): ToolRunner {
  return {
    run: (job: SandboxJob) => {
      if (job.kind !== 'synthesize') {
        throw new Error(`unexpected job kind in test fake: ${job.kind}`);
      }
      return Promise.resolve(synthesizeResult);
    },
  };
}

/** One drawn (or pinned) outcome per check, in `STRUCTURAL_GATE_CHECK_ORDER`. */
interface CheckFlags {
  readonly interfacePass: boolean;
  readonly compilePass: boolean;
  readonly lintPass: boolean;
  readonly synthesisPass: boolean;
}

/** Build the gate's deps so each check reports exactly the outcome its own flag names. */
function depsFor(flags: CheckFlags): ToolchainStructuralGateDeps {
  return {
    toolRunner: fakeToolRunner(
      flags.synthesisPass ? synthesizePassResult() : synthesizeFailResult(),
    ),
    simulator: fakeSimulator(flags.compilePass ? compiledVerdict() : uncompiledVerdict()),
    lint: fakeLint(flags.lintPass ? CLEAN_LINT : FINDINGS_LINT),
  };
}

/** The spec whose Declared_Interface matches the RTL iff `interfacePass` is true. */
function specFor(flags: CheckFlags): Spec {
  return specWith(flags.interfacePass ? MODULE_INTERFACE : MISMATCHED_MODULE_INTERFACE);
}

type StructuralGateCheckName = (typeof STRUCTURAL_GATE_CHECK_ORDER)[number];

const CHECK_FLAG_BY_NAME: Readonly<Record<StructuralGateCheckName, keyof CheckFlags>> = {
  interface: 'interfacePass',
  compile: 'compilePass',
  lint: 'lintPass',
  synthesis: 'synthesisPass',
};

describe(PROPERTY, () => {
  it('runs every check in order and admits exactly when all four pass, for any assignment', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (interfacePass, compilePass, lintPass, synthesisPass) => {
          const flags: CheckFlags = { interfacePass, compilePass, lintPass, synthesisPass };
          const gate = new ToolchainStructuralGate(depsFor(flags));

          const result = await gate.admit(specFor(flags), RTL, LIMITS);

          // (a) every check runs, exactly once, in the fixed order - never short-circuited.
          expect(result.checks.map((check) => check.name)).toEqual([
            ...STRUCTURAL_GATE_CHECK_ORDER,
          ]);
          // (b) each check's reported outcome equals the flag that was built to force it.
          for (const check of result.checks) {
            const flagName = CHECK_FLAG_BY_NAME[check.name as StructuralGateCheckName];
            expect(check.passed).toBe(flags[flagName]);
          }
          // (c) admitted iff all four passed.
          expect(result.admitted).toBe(interfacePass && compilePass && lintPass && synthesisPass);
        },
      ),
      propertyParameters(),
    );
  });

  it('admits when all four checks pass', async () => {
    const flags: CheckFlags = {
      interfacePass: true,
      compilePass: true,
      lintPass: true,
      synthesisPass: true,
    };
    const gate = new ToolchainStructuralGate(depsFor(flags));

    const result = await gate.admit(specFor(flags), RTL, LIMITS);

    expect(result.admitted).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it('refuses when all four checks fail', async () => {
    const flags: CheckFlags = {
      interfacePass: false,
      compilePass: false,
      lintPass: false,
      synthesisPass: false,
    };
    const gate = new ToolchainStructuralGate(depsFor(flags));

    const result = await gate.admit(specFor(flags), RTL, LIMITS);

    expect(result.admitted).toBe(false);
    expect(result.checks.every((check) => !check.passed)).toBe(true);
  });

  it.each<[string, CheckFlags]>([
    ['interface', { interfacePass: false, compilePass: true, lintPass: true, synthesisPass: true }],
    ['compile', { interfacePass: true, compilePass: false, lintPass: true, synthesisPass: true }],
    ['lint', { interfacePass: true, compilePass: true, lintPass: false, synthesisPass: true }],
    ['synthesis', { interfacePass: true, compilePass: true, lintPass: true, synthesisPass: false }],
  ])(
    'refuses with exactly the %s check failing, the other three still reported passed',
    async (failingName, flags) => {
      const gate = new ToolchainStructuralGate(depsFor(flags));

      const result = await gate.admit(specFor(flags), RTL, LIMITS);

      expect(result.admitted).toBe(false);
      for (const check of result.checks) {
        expect(check.passed).toBe(check.name !== failingName);
      }
    },
  );
});
