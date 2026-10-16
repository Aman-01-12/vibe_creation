// instrument-precheck-and-attribution, Property 6: Every precheck outcome
// other than a testbench build failure proceeds (task 3.3).
//
// `TestbenchPrecheck.run` (`app/agent/orchestrator/testbench-precheck.ts`) maps
// one simulate result through a four-row decision table to a `PrecheckOutcome`.
// Of those four rows, exactly one refuses: `failureCause === 'build-failed'`
// AND the testbench's own path is in `attributedFiles`. This test states over
// the whole space arriving at `run` - every other `failureCause` including
// `output-incomplete` (Req 1.12's "a missing waveform is an incomplete capture,
// not a build defect"), a `build-failed` cause that names only the stub (never
// the testbench), and a `simulate` call that throws outright (Req 1.10's "a
// precheck must never fail the thing it checks") - and asserts every one of
// those rows resolves to `undecided`, never a refusal and never a thrown
// rejection out of `run` itself.
//
// A property that only ever produced `undecided` would trivially satisfy
// "every non-build-failure proceeds" without checking that the FOURTH row (the
// one true refusal) still fires. `gotcha-golden-denominator-property-test-was-
// vacuous-for-new-status.md` is exactly this failure mode: a generator that
// quietly excludes the interesting member leaves the assertion green for the
// wrong reason. So this test also drives the `build-failed`-and-attributed
// case directly and asserts THAT one path, and only that one, refuses -
// making the `undecided` claim non-vacuous by construction.
//
// Validates: Requirements 1.8, 1.9, 1.10, 1.12

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TestbenchPrecheck } from '@app/agent';
import type { ModuleInterface } from '@app/core';
import type {
  ResourceLimits,
  RunFailureCause,
  SimulationVerdict,
  SimulatorAdapter,
  SourceFile,
} from '@app/tools';
import { propertyParameters } from '@app/test';

const PROPERTY =
  'instrument-precheck-and-attribution, Property 6: Every precheck outcome other than a testbench build failure proceeds';

/** A minimal Spec interface; the decision table under test never inspects its shape. */
const MODULE_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'dut',
  ports: [],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
};

const TESTBENCH: SourceFile = { path: 'testbench.v', contents: 'module tb; endmodule\n' };
const STUB_PATH = 'testbench_precheck_stub.v';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 64, procs: 8, diskMb: 8, wallMs: 5_000 };

/** A simulator that always answers with the given verdict; no real toolchain involved. */
class FixedSimulator implements SimulatorAdapter {
  constructor(private readonly answer: SimulationVerdict) {}

  simulate(): Promise<SimulationVerdict> {
    return Promise.resolve(this.answer);
  }
}

/** A simulator that always rejects, standing in for a toolchain call that throws. */
class ThrowingSimulator implements SimulatorAdapter {
  simulate(): Promise<SimulationVerdict> {
    return Promise.reject(new Error('the sandbox died'));
  }
}

/** Every `failureCause` other than `build-failed` (the whole non-refusing-cause space). */
const NON_BUILD_FAILED_CAUSES: readonly RunFailureCause[] = [
  'none',
  'timed-out',
  'disk-capped',
  'output-incomplete',
  'tool-failed',
];

/** Free-form diagnostic residue: never load-bearing for the decision, only noise. */
const residueArbitrary = fc.record({
  verdict: fc.constantFrom<'pass' | 'fail' | 'error'>('pass', 'fail', 'error'),
  stdout: fc.oneof(fc.constant(''), fc.constant('CHECK a PASS\n'), fc.string({ maxLength: 100 })),
  stderr: fc.oneof(fc.constant(''), fc.string({ maxLength: 100 })),
  exitCode: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 255 })),
});

/** Assemble a `SimulationVerdict` from a cause, its attributed files, and residue. */
function verdictOf(
  failureCause: RunFailureCause,
  attributedFiles: readonly string[],
  residue: {
    readonly verdict: 'pass' | 'fail' | 'error';
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
  },
): SimulationVerdict {
  return {
    verdict: residue.verdict,
    checks: [],
    vcd: null,
    stdout: residue.stdout,
    stderr: residue.stderr,
    exitCode: residue.exitCode,
    resourceUsage: { cpuMs: 1, maxMemMb: 1, wallMs: 1 },
    failureCause,
    attributedFiles,
    watchdog: { stopped: false },
  };
}

/**
 * A verdict whose cause is anything OTHER than `build-failed` (Req 1.9). Whatever
 * `attributedFiles` reads here is beside the point - Property 3 (a separate
 * design property) already guarantees a non-`build-failed` cause carries no
 * attribution in the real adapter, but this decision table does not lean on that:
 * it checks `failureCause` first, so this generator also throws in a stray
 * attribution list to prove the table ignores it.
 */
const nonBuildFailedVerdictArbitrary: fc.Arbitrary<SimulationVerdict> = fc
  .tuple(
    fc.constantFrom(...NON_BUILD_FAILED_CAUSES),
    fc.subarray([STUB_PATH, TESTBENCH.path]),
    residueArbitrary,
  )
  .map(([cause, attributedFiles, residue]) => verdictOf(cause, attributedFiles, residue));

/**
 * A `build-failed` verdict that attributes ONLY the stub - never the testbench.
 * This is the "decided but not the testbench" row: a real build failure, just
 * not one this precheck may charge to the Testbench (design's own stub/DUT
 * mirror, Req 1.5).
 */
const buildFailedStubOnlyVerdictArbitrary: fc.Arbitrary<SimulationVerdict> = fc
  .tuple(fc.constantFrom<readonly string[]>([], [STUB_PATH]), residueArbitrary)
  .map(([attributedFiles, residue]) => verdictOf('build-failed', attributedFiles, residue));

/** Every generated case this property asserts proceeds (`undecided`), one arbitrary. */
const proceedsVerdictArbitrary: fc.Arbitrary<SimulationVerdict> = fc.oneof(
  nonBuildFailedVerdictArbitrary,
  buildFailedStubOnlyVerdictArbitrary,
);

describe(PROPERTY, () => {
  it('returns undecided for every failureCause other than build-failed, never throwing', async () => {
    await fc.assert(
      fc.asyncProperty(proceedsVerdictArbitrary, async (answer) => {
        const precheck = new TestbenchPrecheck(new FixedSimulator(answer));
        const outcome = await precheck.run(TESTBENCH, MODULE_INTERFACE, LIMITS);
        expect(outcome).toBe('undecided');
      }),
      propertyParameters(),
    );
  });

  it('returns undecided for a build-failed verdict that attributes only the stub', async () => {
    await fc.assert(
      fc.asyncProperty(residueArbitrary, async (residue) => {
        const answer = verdictOf('build-failed', [STUB_PATH], residue);
        const precheck = new TestbenchPrecheck(new FixedSimulator(answer));
        const outcome = await precheck.run(TESTBENCH, MODULE_INTERFACE, LIMITS);
        expect(outcome).toBe('undecided');
      }),
      propertyParameters(),
    );
  });

  it('returns undecided, never rejecting, when the simulator throws (Req 1.10)', async () => {
    const precheck = new TestbenchPrecheck(new ThrowingSimulator());
    const outcome = await precheck.run(TESTBENCH, MODULE_INTERFACE, LIMITS);
    expect(outcome).toBe('undecided');
  });

  it('refuses (the one true row) only when build-failed attributes the testbench itself', async () => {
    // Non-vacuity anchor: proves the `undecided` assertions above are not
    // trivially true because `run` always returns `undecided`. Attributing the
    // testbench alongside the stub still refuses - `attributedFiles` is a
    // membership check, not an exact-match one.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<readonly string[]>([TESTBENCH.path], [STUB_PATH, TESTBENCH.path]),
        residueArbitrary,
        async (attributedFiles, residue) => {
          const answer = verdictOf('build-failed', attributedFiles, residue);
          const precheck = new TestbenchPrecheck(new FixedSimulator(answer));
          const outcome = await precheck.run(TESTBENCH, MODULE_INTERFACE, LIMITS);
          expect(outcome).toBe('testbench-build-failed');
        },
      ),
      propertyParameters(),
    );
  });
});
