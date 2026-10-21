// The production `StructuralGate`: the four ADR-018 layer 1 checks composed over the real
// Interface_Check, Compile_Check, Lint_Check, and Synthesis_Check (C8; Req 6.3, 6.4, 8.1 to
// 8.12, 9.1, 9.2).
//
// Every check runs for every call, regardless of what an earlier check returned (Req 8.6): the
// four private helpers below are awaited one after another in `STRUCTURAL_GATE_CHECK_ORDER`, not
// short-circuited, and `admitted` is read only after all four have settled. `#settle` is the one
// place a thrown error (a bad job, a rejected promise, a defect in a dependency) becomes that
// check's `passed: false` instead of ending the whole call (Req 8.7, 8.10).
//
// `StructuralGateResult` carries only `{name, passed}` per check: `CompileOutcome.diagnostics`,
// every `SandboxResult` stream, and every `LintResult` reason are read here and then dropped, so
// no tool output, path, or host name ever reaches the result this gate returns (Req 8.11).
//
// Imports `SimulatorCandidateCompiler` and `checkInterfaceExact` from their own generation files
// directly, never through `app/agent/roles/generation/index.ts` or the role barrel - the same
// reason this file is one of the `MODEL_FREE_ROOTS` in `app/test/consensus-import-boundary.test.ts`:
// a gate that could reach the Model_Router could spend tokens admitting a design.
//
// The adapter spawns nothing itself (Req 9.1, 9.2): the Interface_Check runs in process over
// already-submitted source text, and the other three each go through the injected `ToolRunner` or
// through the `SimulatorAdapter`, which itself submits through that same `ToolRunner`.

import type { ModuleInterface, Spec } from '@app/core';
import {
  assembleSynthesizeJob,
  parseDeclaredModule,
  synthesisCheckPassed,
  type LintAdapter,
  type ResourceLimits,
  type SimulatorAdapter,
  type SourceFile,
  type ToolRunner,
} from '@app/tools';

import { SimulatorCandidateCompiler } from '../roles/generation/candidate-compiler.js';
import { checkInterfaceExact } from '../roles/generation/interface-check.js';
import type { StructuralGate, StructuralGateResult } from './structural-gate.js';

/** The four ADR-018 layer 1 checks, in the fixed order every `StructuralGateResult` reports them. */
export const STRUCTURAL_GATE_CHECK_ORDER = ['interface', 'compile', 'lint', 'synthesis'] as const;

/** One name from `STRUCTURAL_GATE_CHECK_ORDER` (Req 8.2). */
export type StructuralGateCheckName = (typeof STRUCTURAL_GATE_CHECK_ORDER)[number];

/** The injected seams `ToolchainStructuralGate` composes its four checks from (Req 8.12). */
export interface ToolchainStructuralGateDeps {
  readonly toolRunner: ToolRunner;
  readonly simulator: SimulatorAdapter;
  readonly lint: LintAdapter;
}

/**
 * The Interface_Check, pure: does the Top_Module's header, parsed out of the RTL, match the
 * Declared_Interface exactly (Req 8.3)?
 *
 * The sources are joined with newlines - the same join the regression harness gives the
 * Independent_Judge - and read with `parseDeclaredModule` SELECTING BY NAME, so a Candidate_Design
 * that declares a helper module ahead of its top is still read correctly; `parseDeclaredModule`
 * locates `moduleInterface.moduleName`'s own header wherever it sits in the joined text. A parse
 * failure (no such module, or one it cannot read) is a failed check, never a thrown error.
 */
export function interfaceCheckPassed(
  moduleInterface: ModuleInterface,
  rtl: readonly SourceFile[],
): boolean {
  const joined = rtl.map((file) => file.contents).join('\n');
  const parsed = parseDeclaredModule(joined, moduleInterface.moduleName);
  if (!parsed.ok) {
    return false;
  }
  return checkInterfaceExact(moduleInterface, {
    moduleName: parsed.module.name,
    ports: parsed.module.ports,
  }).matches;
}

/**
 * `StructuralGate` backed by the real toolchain: the Interface_Check in process, the
 * Compile_Check through `SimulatorCandidateCompiler`, the Lint_Check through the injected
 * `LintAdapter`, and the Synthesis_Check through a Synthesize_Job with no Schematic_Request
 * (Req 7.1, 8.3, 8.9).
 *
 * Every dependency is injected (Req 8.12, 9.1, 9.2), so a fake `ToolRunner`/`SimulatorAdapter`/
 * `LintAdapter` can drive every check in a unit test with no real Yosys, Icarus, or lint toolchain
 * present.
 */
export class ToolchainStructuralGate implements StructuralGate {
  readonly #toolRunner: ToolRunner;
  readonly #simulator: SimulatorAdapter;
  readonly #lint: LintAdapter;

  constructor(deps: ToolchainStructuralGateDeps) {
    this.#toolRunner = deps.toolRunner;
    this.#simulator = deps.simulator;
    this.#lint = deps.lint;
  }

  /**
   * Await one check, mapping a thrown error or a rejected promise to `false` rather than letting
   * it end the whole `admit` call (Req 8.7, 8.10). The fail-safe answer for a check that could not
   * run to a result is that it did not pass.
   */
  async #settle(check: () => boolean | Promise<boolean>): Promise<boolean> {
    try {
      return await check();
    } catch {
      return false;
    }
  }

  /**
   * Run every check in `STRUCTURAL_GATE_CHECK_ORDER` for one Candidate_Design and report each
   * check's own outcome (Req 8.1, 8.2, 8.4, 8.5, 8.6, 8.8, 8.9, 8.11).
   *
   * The checks are awaited one after another, but none is skipped on an earlier failure: every
   * `#settle` call runs regardless of what the prior ones returned, so a failing Interface_Check
   * still reports whether the design compiles, lints clean, and synthesizes.
   */
  async admit(
    spec: Spec,
    rtl: readonly SourceFile[],
    limits: ResourceLimits,
  ): Promise<StructuralGateResult> {
    const topModule = spec.moduleInterface.moduleName;

    const interfacePassed = await this.#settle(() =>
      interfaceCheckPassed(spec.moduleInterface, rtl),
    );
    const compilePassed = await this.#settle(async () => {
      const compiler = new SimulatorCandidateCompiler(
        this.#simulator,
        spec.moduleInterface,
        limits,
      );
      const outcome = await compiler.compile(rtl);
      return outcome.compiled;
    });
    const lintPassed = await this.#settle(async () => {
      const result = await this.#lint.lint(rtl, topModule, limits);
      return result.kind === 'clean';
    });
    const synthesisPassed = await this.#settle(async () => {
      const job = assembleSynthesizeJob(rtl, topModule, limits, false);
      const result = await this.#toolRunner.run(job);
      return synthesisCheckPassed(result);
    });

    const checks: readonly {
      readonly name: StructuralGateCheckName;
      readonly passed: boolean;
    }[] = [
      { name: 'interface', passed: interfacePassed },
      { name: 'compile', passed: compilePassed },
      { name: 'lint', passed: lintPassed },
      { name: 'synthesis', passed: synthesisPassed },
    ];

    return { admitted: checks.every((check) => check.passed), checks };
  }
}
