// Unit tests for `ToolchainStructuralGate` and `interfaceCheckPassed` (task 5.1; Req 6.3, 6.4,
// 8.1 to 8.12, 9.1, 9.2, 13.7).
//
// Driven entirely through hand-rolled fakes for the three injected ports (`ToolRunner`,
// `SimulatorAdapter`, `LintAdapter`): no real Yosys, Icarus, or lint toolchain. Each fake answers
// by `SandboxJob.kind` so one scripted fixture can drive the compile check (through the
// `SimulatorAdapter`) and the lint/synthesis checks (through the `ToolRunner`) independently.
//
// WHAT THESE COVER
//   - all four checks pass -> admitted true, every check reported passed.
//   - each check failing alone -> admitted false, that check reported failed, the other three
//     still run and reported passed (Req 8.5, 8.6).
//   - `interfaceCheckPassed` reads a helper module declared ahead of the top by NAME, not by
//     position, so a Candidate_Design with a helper module is read correctly (Req 8.3).
//   - the `expectTypeOf` pin that `ToolchainStructuralGate` satisfies `StructuralGate`.
//
// The `node:child_process` source-text assertion lives in
// `app/test/consensus-import-boundary.test.ts`, which already carries Node's ambient types and
// this exact style of scan; `app/agent`'s own tsconfig deliberately carries none (see
// `app/agent/roles/testbench/prompt-version.test.ts`'s header for the same constraint).

import { describe, expect, expectTypeOf, it } from 'vitest';

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

import {
  interfaceCheckPassed,
  STRUCTURAL_GATE_CHECK_ORDER,
  ToolchainStructuralGate,
  type ToolchainStructuralGateDeps,
} from './structural-gate-adapter.js';
import type { StructuralGate } from './structural-gate.js';

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

/** The gate's deps with all four checks passing by default; override one seam per test. */
function depsAllPassing(
  overrides: Partial<ToolchainStructuralGateDeps> = {},
): ToolchainStructuralGateDeps {
  return {
    toolRunner: fakeToolRunner(synthesizePassResult()),
    simulator: fakeSimulator(compiledVerdict()),
    lint: fakeLint(CLEAN_LINT),
    ...overrides,
  };
}

/** Read one check's reported outcome out of a `StructuralGateResult`, by name. */
function checkNamed(
  result: Awaited<ReturnType<StructuralGate['admit']>>,
  name: string,
): boolean | undefined {
  return result.checks.find((check) => check.name === name)?.passed;
}

describe('ToolchainStructuralGate.admit - all four checks pass', () => {
  it('admits the design and reports every check passed, in Check_Order', async () => {
    const gate = new ToolchainStructuralGate(depsAllPassing());

    const result = await gate.admit(specWith(MODULE_INTERFACE), RTL, LIMITS);

    expect(result.admitted).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([...STRUCTURAL_GATE_CHECK_ORDER]);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });
});

describe('ToolchainStructuralGate.admit - one failing check, the other three still run', () => {
  it('refuses on a failing Interface_Check, with compile/lint/synthesis still reported passed', async () => {
    const gate = new ToolchainStructuralGate(depsAllPassing());
    const mismatchedInterface: ModuleInterface = { ...MODULE_INTERFACE, moduleName: 'not_the_rtl' };

    const result = await gate.admit(specWith(mismatchedInterface), RTL, LIMITS);

    expect(result.admitted).toBe(false);
    expect(checkNamed(result, 'interface')).toBe(false);
    expect(checkNamed(result, 'compile')).toBe(true);
    expect(checkNamed(result, 'lint')).toBe(true);
    expect(checkNamed(result, 'synthesis')).toBe(true);
  });

  it('refuses on a failing Compile_Check, with interface/lint/synthesis still reported passed', async () => {
    const gate = new ToolchainStructuralGate(
      depsAllPassing({ simulator: fakeSimulator(uncompiledVerdict()) }),
    );

    const result = await gate.admit(specWith(MODULE_INTERFACE), RTL, LIMITS);

    expect(result.admitted).toBe(false);
    expect(checkNamed(result, 'interface')).toBe(true);
    expect(checkNamed(result, 'compile')).toBe(false);
    expect(checkNamed(result, 'lint')).toBe(true);
    expect(checkNamed(result, 'synthesis')).toBe(true);
  });

  it('refuses on a failing Lint_Check, with interface/compile/synthesis still reported passed', async () => {
    const gate = new ToolchainStructuralGate(depsAllPassing({ lint: fakeLint(FINDINGS_LINT) }));

    const result = await gate.admit(specWith(MODULE_INTERFACE), RTL, LIMITS);

    expect(result.admitted).toBe(false);
    expect(checkNamed(result, 'interface')).toBe(true);
    expect(checkNamed(result, 'compile')).toBe(true);
    expect(checkNamed(result, 'lint')).toBe(false);
    expect(checkNamed(result, 'synthesis')).toBe(true);
  });

  it('refuses on a failing Synthesis_Check, with interface/compile/lint still reported passed', async () => {
    const gate = new ToolchainStructuralGate(
      depsAllPassing({ toolRunner: fakeToolRunner(synthesizeFailResult()) }),
    );

    const result = await gate.admit(specWith(MODULE_INTERFACE), RTL, LIMITS);

    expect(result.admitted).toBe(false);
    expect(checkNamed(result, 'interface')).toBe(true);
    expect(checkNamed(result, 'compile')).toBe(true);
    expect(checkNamed(result, 'lint')).toBe(true);
    expect(checkNamed(result, 'synthesis')).toBe(false);
  });

  it("converts a thrown error from a dependency into that check's not-passed outcome (Req 8.7, 8.10)", async () => {
    const throwingToolRunner: ToolRunner = {
      run: () => {
        throw new Error('/host/internal/path: ECONNRESET');
      },
    };
    const gate = new ToolchainStructuralGate(depsAllPassing({ toolRunner: throwingToolRunner }));

    const result = await gate.admit(specWith(MODULE_INTERFACE), RTL, LIMITS);

    expect(result.admitted).toBe(false);
    expect(checkNamed(result, 'synthesis')).toBe(false);
    // The thrown error's text (a host path) never reaches the result (Req 8.11).
    expect(JSON.stringify(result)).not.toMatch(/\/host\//);
  });
});

describe('interfaceCheckPassed - selecting the Top_Module by name (Req 8.3)', () => {
  it('reads the top module correctly even when a helper module is declared ahead of it', () => {
    const rtlWithHelper: readonly SourceFile[] = [
      {
        path: 'alu.v',
        contents: [
          'module helper(input x, output y); assign y = x; endmodule',
          'module alu(input [7:0] a, output [7:0] y); endmodule',
        ].join('\n'),
      },
    ];

    expect(interfaceCheckPassed(MODULE_INTERFACE, rtlWithHelper)).toBe(true);
  });

  it('fails when the top module is not present in the RTL at all', () => {
    const rtlMissingTop: readonly SourceFile[] = [
      { path: 'helper.v', contents: 'module helper(input x, output y); assign y = x; endmodule' },
    ];

    expect(interfaceCheckPassed(MODULE_INTERFACE, rtlMissingTop)).toBe(false);
  });

  it('fails when the top module exists but its ports diverge from the Declared_Interface', () => {
    const rtlWrongPorts: readonly SourceFile[] = [
      { path: 'alu.v', contents: 'module alu(input [7:0] a, output [3:0] y); endmodule' },
    ];

    expect(interfaceCheckPassed(MODULE_INTERFACE, rtlWrongPorts)).toBe(false);
  });
});

describe('ToolchainStructuralGate satisfies StructuralGate (compile-time; tsc -b)', () => {
  it('is assignable to the StructuralGate port with no adapter in between', () => {
    expectTypeOf<ToolchainStructuralGate>().toExtend<StructuralGate>();
  });
});
