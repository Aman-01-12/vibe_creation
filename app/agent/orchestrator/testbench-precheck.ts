// The Testbench_Precheck: a deterministic, model-free build check of a generated
// Testbench against a Spec-derived Interface_Stub (Req 1.1-1.7, 1.12; task 3.1).
//
// WHY THIS EXISTS
//   `iverilog -t null` over the committed campaign-readiness artifacts refuses 2 of
//   12 testbenches outright (a syntax error) and would, on the reordering this spec
//   also adds, catch the 3 `TESTBENCH_REFERENCE_UNBUILDABLE` samples before any
//   reference design is loaded. Every one of those iterations was spent BEFORE
//   anything checked whether the testbench itself could compile. This module is
//   that check, run once, before the first repair iteration (design.md, "The new
//   setup sequence").
//
// WHY A STUB AND NOT THE TESTBENCH ALONE
//   Compiling the testbench alone refuses far more than it should: `iverilog -t
//   null` over a CLEAN testbench with no module to instantiate reports "Unknown
//   module type", which is indistinguishable from a real defect. `buildInterfaceStub`
//   is the deliberate mirror of `buildCompileHarness`
//   (`../roles/generation/candidate-compiler.js`): that one derives a testbench
//   stand-in from the Spec so a candidate can be compiled with no testbench; this
//   one derives a DUT stand-in from the Spec so a testbench can be compiled with no
//   candidate. Both read `expectedInterfacePorts` (`../roles/generation/spec-view.js`),
//   so the clocking ports the Spec declares separately from its port list are
//   present in both, and a testbench that connects `clk` is never refused for a
//   port the Spec does in fact declare (Req 1.1, 1.2).
//
// WHY THE STUB DECLARES NO BEHAVIOUR AND NO `$dumpfile`
//   The stub's only job is to give the compiler a top-level module to elaborate the
//   testbench against; it asserts nothing and drives nothing (Req 1.3). Unlike
//   `buildCompileHarness`, the stub is a PASSIVE DUT stand-in the testbench drives,
//   not an active harness that provides its own stimulus - the testbench itself
//   supplies clock generation, stimulus, and `$dumpvars`. A stub that emitted its
//   own `$dumpfile` would mask a testbench that omits one; instead, a testbench
//   missing a waveform dump yields `output-incomplete` from the Simulator, which
//   this precheck deliberately treats as `undecided` rather than a refusal
//   (Req 1.12) - a missing waveform is an incomplete capture, not a build defect.
//
// WHY THE PRECHECK CAN NEVER READ CANDIDATE RTL
//   The Testbench is required to be independent of any candidate; building it only
//   against the Spec-derived stub (never against generated RTL) keeps that
//   independence structural rather than conventional (Req 1.5, 1.6).

import type { ModuleInterface } from '@app/core';
import { expectedInterfacePorts, type PortSignature } from '../roles/generation/index.js';
import type { ResourceLimits, SimulatorAdapter, SourceFile } from '@app/tools';

/** The stub module name; distinct from any Spec module so it never clashes with the DUT. */
const INTERFACE_STUB_MODULE = 'testbench_precheck_stub' as const;

/** A Verilog range suffix for a port wider than one bit, or empty for width 1. */
function rangeSuffix(width: number): string {
  return width > 1 ? ` [${width - 1}:0]` : '';
}

/**
 * Declare the stub's own signal for one Spec port: its port direction (Req 1.1,
 * 1.2) plus its net type (inputs are `reg`, everything else `wire`), each on its
 * own line.
 *
 * The header below lists bare port names in Verilog-2001's non-ANSI style, which
 * requires the direction to be declared SEPARATELY in the module body; omitting
 * it (net-type-only, `reg foo;`) declares a plain variable, not a port, and
 * Icarus refuses to elaborate the module at all - "Port ... has no direction
 * declaration" - regardless of what the header lists. A direction keyword and a
 * net-type keyword cannot share one declaration in this dialect, so each port
 * gets two lines.
 */
function declareSignal(port: PortSignature): string {
  const range = rangeSuffix(port.width);
  const netType = port.direction === 'input' ? 'reg' : 'wire';
  return [`  ${port.direction}${range} ${port.name};`, `  ${netType}${range} ${port.name};`].join(
    '\n',
  );
}

/**
 * Build the Interface_Stub a generated Testbench is precheck-built against: a
 * module carrying the Spec's module name and every Spec-declared port, and no
 * procedural block (Property 5; Req 1.1, 1.2, 1.3).
 *
 * Derived solely from `moduleInterface` - never from a testbench or from candidate
 * RTL - so the check this stub enables cannot be influenced by anything the
 * Testbench_Agent or the Generation_Agent produced. The testbench instantiates this
 * module under whatever instance name it chose; the stub declares only the ports
 * a testbench could legally connect, with no behaviour to elaborate.
 */
export function buildInterfaceStub(moduleInterface: ModuleInterface): SourceFile {
  const ports = expectedInterfacePorts(moduleInterface);
  const portList = ports.map((port) => port.name).join(', ');
  const declarations = ports.map(declareSignal).join('\n');
  const contents = [
    `module ${moduleInterface.moduleName} (${portList});`,
    declarations,
    'endmodule',
  ].join('\n');
  return { path: `${INTERFACE_STUB_MODULE}.v`, contents };
}

/**
 * Why a Testbench_Precheck build ended the way it did.
 *
 * - `testbench-build-failed`: the toolchain named the Testbench file at a source
 *   location; the Testbench itself does not build.
 * - `undecided`: the precheck did not attribute a build failure to the
 *   Testbench - because the failure named only the stub, because the cause was
 *   something other than a build failure (including an incomplete waveform
 *   capture, Req 1.12), because the stub and the Testbench compiled and
 *   simulated cleanly, or because the simulate call itself threw. `undecided`
 *   always means "proceed exactly as before this precheck existed" (Property 6).
 */
export type PrecheckOutcome = 'testbench-build-failed' | 'undecided';

/**
 * A deterministic, model-free build check of a generated Testbench (Req 1.4, 1.6,
 * 1.7).
 *
 * Runs the SAME `SimulatorAdapter` and the same resource limits the
 * Verification_Loop's own oracle runs under (Req 1.7), so the precheck measures
 * exactly the build the oracle would later attempt. The `SimulatorAdapter` is
 * injected, never constructed internally, so a fake simulator can drive this
 * class in tests with no real toolchain.
 */
export class TestbenchPrecheck {
  readonly #simulator: SimulatorAdapter;

  constructor(simulator: SimulatorAdapter) {
    this.#simulator = simulator;
  }

  /**
   * Build `testbench` against the Interface_Stub derived from `moduleInterface`
   * and map the result through the design's four-row decision table.
   *
   * Reads no candidate RTL (Req 1.5): the stub built here is the only "RTL" this
   * call ever submits. Never throws outward (Req 1.10): a precheck must never fail
   * the thing it checks, so a thrown `simulate` call is caught and reported as
   * `undecided`, the same outcome a decided-but-inconclusive build reports.
   *
   * A thin wrapper over `runWithDiagnostic` that discards its `diagnostic` field,
   * so this method's signature and behaviour stay exactly what every existing
   * caller already depends on (design.md, "#admitInstrument wiring").
   */
  async run(
    testbench: SourceFile,
    moduleInterface: ModuleInterface,
    limits: ResourceLimits,
  ): Promise<PrecheckOutcome> {
    const { outcome } = await this.runWithDiagnostic(testbench, moduleInterface, limits);
    return outcome;
  }

  /**
   * The same build-and-decide `run` performs, but also surfacing the verbatim
   * build diagnostic (`SimulationVerdict.stderr`) from the one internal
   * `simulate` call both methods share - so a caller building a
   * `BuildDiagnosticHint` (task 6.4's `#admitInstrument`) reads the precheck's
   * own captured stderr rather than re-running the build a second time.
   *
   * `diagnostic` is `''` on every `undecided` row, including a thrown
   * `simulate` call: this method never throws outward, matching `run`'s own
   * "never throws outward" discipline (Req 1.10).
   */
  async runWithDiagnostic(
    testbench: SourceFile,
    moduleInterface: ModuleInterface,
    limits: ResourceLimits,
  ): Promise<{ outcome: PrecheckOutcome; diagnostic: string }> {
    const stub = buildInterfaceStub(moduleInterface);
    try {
      const verdict = await this.#simulator.simulate([stub], testbench, limits);
      if (verdict.failureCause !== 'build-failed') {
        // Any other cause - including `output-incomplete`, a testbench that built
        // and simply wrote no waveform - is not a build defect (Req 1.12).
        return { outcome: 'undecided', diagnostic: '' };
      }
      // Membership, not extraction: `attributedFiles` is already a filter of the
      // paths this run submitted (`SimulationVerdict.attributedFiles`), so checking
      // for the testbench's own path is a safe comparison against a value this
      // call constructed, never against untrusted diagnostic text.
      return verdict.attributedFiles.includes(testbench.path)
        ? { outcome: 'testbench-build-failed', diagnostic: verdict.stderr }
        : { outcome: 'undecided', diagnostic: '' };
    } catch {
      return { outcome: 'undecided', diagnostic: '' };
    }
  }
}
