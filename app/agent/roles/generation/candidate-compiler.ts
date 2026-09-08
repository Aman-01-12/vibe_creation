// The compiler seam the Generation_Agent revises against, and a Simulator-backed
// implementation of it (Req 6.2, 6.3).
//
// The Generation_Agent depends only on the narrow `CandidateCompiler` port: "compile
// this RTL, tell me whether it compiled and the compiler errors if it did not". It
// does NOT depend on the independent testbench or the pass verdict, keeping the
// generation seam decoupled from the Verification_Loop (task 14).
//
// `SimulatorCandidateCompiler` bridges that port onto the existing `SimulatorAdapter`
// (iverilog/vvp behind the Tool_Runner sandbox): it assembles a minimal compile
// harness derived ONLY from the Spec interface - never from any testbench - so the
// compiler has a top to elaborate, then maps the run outcome to a compile verdict.
// A run the sandbox classifies `error` (a compile failure never produces the VCD,
// so capture-all-or-error yields `error`) is reported as "did not compile" with the
// tool's stderr/stdout as diagnostics; any run that reached simulation compiled.

import type { ModuleInterface } from '@app/core';
import type { ResourceLimits, SimulationVerdict, SimulatorAdapter, SourceFile } from '@app/tools';

import { expectedInterfacePorts } from './spec-view.js';
import type { CandidateCompiler, CompileOutcome, PortSignature } from './types.js';

/** The harness module name; distinct from any Spec module so it never clashes with the DUT. */
const HARNESS_MODULE = 'generation_compile_harness' as const;

/** The single check line a clean compile emits, matching the Simulator signalling convention. */
const COMPILE_OK_CHECK = 'CHECK compile_ok PASS' as const;

/** A Verilog range suffix for a port wider than one bit, or empty for width 1. */
function rangeSuffix(width: number): string {
  return width > 1 ? ` [${width - 1}:0]` : '';
}

/** Declare a harness signal driving/observing one DUT port (inputs are reg, others wire). */
function declareSignal(port: PortSignature): string {
  const netType = port.direction === 'input' ? 'reg' : 'wire';
  return `  ${netType}${rangeSuffix(port.width)} ${port.name};`;
}

/** Connect one DUT port by name in the instantiation. */
function connectPort(port: PortSignature): string {
  return `    .${port.name}(${port.name})`;
}

/**
 * Build a minimal compile harness that instantiates the module under test using the
 * Spec interface, dumps a VCD, emits one passing check, and finishes.
 *
 * Derived solely from the Spec Module_Interface (never from a testbench), its only
 * job is to give the compiler a top to elaborate so syntax and elaboration errors
 * surface. It is not a functional testbench and asserts nothing about behavior.
 */
export function buildCompileHarness(moduleInterface: ModuleInterface): SourceFile {
  const ports = expectedInterfacePorts(moduleInterface);
  const declarations = ports.map(declareSignal).join('\n');
  const connections = ports.map(connectPort).join(',\n');
  const contents = [
    `module ${HARNESS_MODULE};`,
    declarations,
    `  ${moduleInterface.moduleName} dut (`,
    connections,
    '  );',
    '  initial begin',
    `    $dumpfile("dump.vcd");`,
    `    $dumpvars(0, ${HARNESS_MODULE});`,
    `    $display("${COMPILE_OK_CHECK}");`,
    '    $finish;',
    '  end',
    'endmodule',
  ].join('\n');
  return { path: `${HARNESS_MODULE}.v`, contents };
}

/** Join a run's standard error and output into a single, non-sensitive diagnostic blob. */
function diagnosticsOf(verdict: SimulationVerdict): string {
  return [verdict.stderr, verdict.stdout]
    .map((stream) => stream.trim())
    .filter((stream) => stream.length > 0)
    .join('\n');
}

/**
 * A `CandidateCompiler` backed by the Simulator adapter (iverilog/vvp in the sandbox).
 *
 * The `SimulatorAdapter` and the compile `ResourceLimits` are injected, so a
 * `FakeSandboxRuntime`-backed `IcarusSimulatorAdapter` can drive this in tests with
 * no real toolchain. The harness is derived from the Spec interface the caller
 * provides at construction, keeping generation isolated from the testbench.
 */
export class SimulatorCandidateCompiler implements CandidateCompiler {
  readonly #simulator: SimulatorAdapter;
  readonly #harness: SourceFile;
  readonly #limits: ResourceLimits;

  constructor(
    simulator: SimulatorAdapter,
    moduleInterface: ModuleInterface,
    limits: ResourceLimits,
  ) {
    this.#simulator = simulator;
    this.#harness = buildCompileHarness(moduleInterface);
    this.#limits = limits;
  }

  async compile(rtl: readonly SourceFile[]): Promise<CompileOutcome> {
    const verdict = await this.#simulator.simulate(rtl, this.#harness, this.#limits);
    // A compile failure never produces the required VCD, so the sandbox classifies
    // the whole run `error`; any run that reached simulation compiled.
    const compiled = verdict.verdict !== 'error';
    return { compiled, diagnostics: compiled ? '' : diagnosticsOf(verdict) };
  }
}
