// instrument-precheck-and-attribution, Property 11: A resource-bound kill is
// never charged to the instrument (task 6.3).
//
// `classifyControlRun` (`app/eval/corpus/rtllm-instrument-control.ts`) reads
// `simulation.failureCause` FIRST, before `classifyNonPass` ever runs a
// `stderr`/`verdict` re-derivation, because a resource-bound kill (`timed-out`,
// `disk-capped`) is a fact about the SANDBOX, not about the testbench: the run
// was stopped mid-execution, so nothing was proven either way. The measured
// defect this ordering exists to fix: `rtllm/arithmetic/multi_16bit` was
// recorded `TESTBENCH_REFERENCE_UNBUILDABLE` when its control run's own
// stderr said `workspace reached its 134217728-byte disk cap` - a residual
// diagnostic line left over from a kill, not evidence of a build failure
// (Req 3.1, 3.2, 3.3; design "app/eval/instrument-control.ts").
//
// `classifyControlRun` is module-private, so this test drives it the same way
// `rtllm-instrument-control.test.ts` already does: through
// `RtllmInstrumentControl.check`, with a `SpySimulator` standing in for the
// toolchain (no real sandbox, no model call).
//
// Validates: Requirements 3.1, 3.2, 3.3

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type {
  ResourceLimits,
  RunFailureCause,
  SimulationVerdict,
  SimulatorAdapter,
} from '@app/tools';
import { propertyParameters } from '@app/test';

import { RtllmInstrumentControl } from '../eval/corpus/rtllm-instrument-control.js';
import type { ReferenceDesign } from '../eval/corpus/corpus-types.js';

const PROPERTY =
  'instrument-precheck-and-attribution, Property 11: A resource-bound kill is never charged to the instrument';

/** Sandbox caps for the fake runs; never used, because no tool runs. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 64, procs: 8, diskMb: 8, wallMs: 5_000 };

const PROBLEM_ID = 'rtllm/arithmetic/multi_16bit';

/** One reference design, already top-module-renamed by the importer. */
const REFERENCE: ReferenceDesign = {
  problemId: PROBLEM_ID,
  rtl: { path: 'dut_reference.v', contents: 'module multi_16bit(clk, a, b, p); endmodule\n' },
  topModuleRenamedFrom: 'verified_multi_16bit',
};

/** A simulator that always answers with the given verdict; records nothing, needs no spy here. */
class FixedSimulator implements SimulatorAdapter {
  constructor(private readonly answer: SimulationVerdict) {}

  simulate(): Promise<SimulationVerdict> {
    return Promise.resolve(this.answer);
  }
}

/** The control over `PROBLEM_ID`, with the given simulator answer. */
function control(answer: SimulationVerdict): RtllmInstrumentControl {
  return new RtllmInstrumentControl({
    simulator: new FixedSimulator(answer),
    references: new Map([[PROBLEM_ID, REFERENCE]]),
  });
}

/** One check request against the controlled problem. */
function request(testbench = 'module tb; endmodule\n'): {
  readonly problemId: string;
  readonly testbench: string;
  readonly limits: ResourceLimits;
} {
  return { problemId: PROBLEM_ID, testbench, limits: LIMITS };
}

/** The two resource-bound causes Property 11 is scoped to. */
const resourceBoundCauseArbitrary: fc.Arbitrary<RunFailureCause> = fc.constantFrom(
  'timed-out',
  'disk-capped',
);

/**
 * Diagnostics text engineered to look like every OTHER classification path: a
 * clean pass-shaped stdout, a build-failure-shaped stderr line naming a
 * submitted file, an empty stream, or arbitrary free text. None of these may
 * move the verdict once `failureCause` is resource-bound - that is the whole
 * claim of Property 11.
 */
const misleadingResidueArbitrary: fc.Arbitrary<{
  readonly verdict: 'pass' | 'fail' | 'error';
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}> = fc
  .record({
    verdict: fc.constantFrom<'pass' | 'fail' | 'error'>('pass', 'fail', 'error'),
    stderr: fc.oneof(
      fc.constant(''),
      fc.constant('workspace reached its 134217728-byte disk cap'),
      fc.constant('tb.v:7: error: Unknown module type: multi_16bit'),
      fc.string({ maxLength: 200 }),
    ),
    stdout: fc.oneof(fc.constant(''), fc.constant('CHECK a PASS\n'), fc.string({ maxLength: 200 })),
    exitCode: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 255 })),
  })
  .map(({ verdict, stderr, stdout, exitCode }) => ({ verdict, stderr, stdout, exitCode }));

/** A `SimulationVerdict` whose `failureCause` is resource-bound, with misleading residue. */
const resourceBoundSimulationArbitrary: fc.Arbitrary<SimulationVerdict> = fc
  .tuple(resourceBoundCauseArbitrary, misleadingResidueArbitrary)
  .map(([failureCause, residue]) => ({
    verdict: residue.verdict,
    checks: [],
    vcd: null,
    stdout: residue.stdout,
    stderr: residue.stderr,
    exitCode: residue.exitCode,
    resourceUsage: { cpuMs: 1, maxMemMb: 1, wallMs: 1 },
    failureCause,
    // A resource-bound cause carries no attributed files (Req 2.4: empty unless
    // `build-failed`); generating a non-empty list here would test an
    // unreachable `SimulationVerdict`, not the classification itself.
    attributedFiles: [],
  }));

describe(PROPERTY, () => {
  it('classifies every resource-bound kill as unchecked/control-resource-exhausted, never a defect', async () => {
    await fc.assert(
      fc.asyncProperty(resourceBoundSimulationArbitrary, async (simulation) => {
        const result = await control(simulation).check(request());

        expect(result?.verdict).toEqual({
          validity: 'unchecked',
          reason: 'control-resource-exhausted',
        });
        expect(result?.verdict.validity).not.toBe('invalid');
      }),
      propertyParameters(),
    );
  });

  it('reproduces the measured multi_16bit disk-cap stderr as unchecked, not TESTBENCH_REFERENCE_UNBUILDABLE', async () => {
    // The real diagnostic captured on the committed campaign-readiness slice
    // (task 6.3's required unit anchor). Before this classification existed,
    // this exact stderr line resolved to `TESTBENCH_REFERENCE_UNBUILDABLE` - a
    // defect charged to the testbench generator for a kill the harness itself
    // caused.
    const simulation: SimulationVerdict = {
      verdict: 'error',
      checks: [],
      vcd: null,
      stdout: '',
      stderr: 'workspace reached its 134217728-byte disk cap',
      exitCode: 137,
      resourceUsage: { cpuMs: 1, maxMemMb: 1, wallMs: 1 },
      failureCause: 'disk-capped',
      attributedFiles: [],
    };

    const result = await control(simulation).check(request());

    expect(result?.verdict).toEqual({
      validity: 'unchecked',
      reason: 'control-resource-exhausted',
    });
    expect(result?.verdict).not.toEqual({
      validity: 'invalid',
      defect: 'TESTBENCH_REFERENCE_UNBUILDABLE',
    });
  });
});
