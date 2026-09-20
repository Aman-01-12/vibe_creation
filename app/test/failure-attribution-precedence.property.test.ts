// instrument-precheck-and-attribution, Property 2: A resource-bound kill
// outranks every other cause (task 1.2).
//
// `classifyRunFailure` (`app/tools/simulator/failure-attribution.ts`) ranks
// `result.timedOut` and `result.diskLimitExceeded` above every other signal on
// the incoming `SandboxResult`, and derives them from those two flags alone -
// never from `exitCode` or from `stderr` text. That ranking is the fix for the
// measured `multi_16bit` defect: a disk-cap kill leaves a real, non-zero exit
// code and a real stderr line behind, and that residue is plausible enough to
// read as a build failure if anything downstream is allowed to consult it before
// the kill flags are checked (Req 3.3; design "app/tools/simulator/failure-
// attribution.ts").
//
// This test asserts the ranking over `SandboxResult`s built to make that
// residue as misleading as possible: a kill flag set TOGETHER WITH a sentinel
// non-zero exit code and/or stderr text shaped exactly like the toolchain's own
// build-failure diagnostic (`<submitted-file>:<line>: syntax error`), citing a
// path from the same `submittedPaths` list `classifyRunFailure` would otherwise
// use to attribute a real build failure. If precedence were even one rank lower,
// this input would misclassify as `build-failed`.
//
// Validates: Requirements 2.2, 2.3, 3.3

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyRunFailure, type SandboxResult } from '@app/tools';
import { propertyParameters } from '@app/test';

const PROPERTY =
  'instrument-precheck-and-attribution, Property 2: A resource-bound kill outranks every other cause';

// -- Generators ---------------------------------------------------------------

/** A submitted workspace path shaped like the RTL/testbench files a real job submits. */
const submittedPathArbitrary: fc.Arbitrary<string> = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/), fc.constantFrom('v', '_tb.v'))
  .map(([name, suffix]) => `${name}${suffix}`);

/** A non-empty, deduplicated list of submitted paths, mirroring one run's RTL + testbench. */
const submittedPathsArbitrary: fc.Arbitrary<readonly string[]> = fc.uniqueArray(
  submittedPathArbitrary,
  { minLength: 1, maxLength: 4 },
);

/**
 * A sentinel non-zero exit code, the shape a killed run's residual `exitCode`
 * plausibly carries. Never 0, so it can never itself resemble a clean run.
 */
const sentinelExitCodeArbitrary: fc.Arbitrary<number> = fc.integer({ min: 1, max: 255 });

/**
 * Stderr text shaped exactly like the toolchain's own build-failure diagnostic,
 * citing one of `submittedPaths` at a source line - the precise residue that
 * would attribute a `build-failed` cause if the kill flags were not checked
 * first. Built from the caller's own submitted paths so the contradiction is as
 * plausible as `classifyRunFailure`'s real attribution scan.
 */
function buildFailureLookingStderr(submittedPaths: readonly string[]): fc.Arbitrary<string> {
  return fc
    .tuple(fc.constantFrom(...submittedPaths), fc.integer({ min: 1, max: 999 }))
    .map(([path, line]) => `${path}:${line}: syntax error`);
}

/**
 * Which resource-bound flag is set for one generated case: `timedOut`,
 * `diskLimitExceeded`, or both. Both are drawn (never just one pinned true and
 * the other pinned false) so the ranking is asserted whichever kill fired, and
 * so the case where a run trips both bounds at once is covered too.
 */
const killFlagsArbitrary: fc.Arbitrary<{ timedOut: boolean; diskLimitExceeded: boolean }> = fc
  .tuple(fc.boolean(), fc.boolean())
  .filter(([timedOut, diskLimitExceeded]) => timedOut || diskLimitExceeded)
  .map(([timedOut, diskLimitExceeded]) => ({ timedOut, diskLimitExceeded }));

/**
 * A resource-killed `SandboxResult` carrying plausible contradicting residue: a
 * sentinel non-zero exit code, and stderr built to look exactly like a build
 * diagnostic naming one of the run's own submitted files. `verdict` is pinned
 * `'error'`, matching what a real killed run reports (`classifyVerdict` ranks a
 * kill above a functional result too), so the only question this arbitrary
 * isolates is whether `classifyRunFailure` reads the kill flags before the
 * residue - never whether it can tell a killed run from a passing one.
 */
function killedWithContradictingResidueArbitrary(): fc.Arbitrary<{
  result: SandboxResult;
  submittedPaths: readonly string[];
}> {
  return submittedPathsArbitrary.chain((submittedPaths) =>
    fc
      .record({
        kill: killFlagsArbitrary,
        exitCode: sentinelExitCodeArbitrary,
        stderr: buildFailureLookingStderr(submittedPaths),
        stdoutTruncated: fc.boolean(),
      })
      .map(({ kill, exitCode, stderr, stdoutTruncated }) => ({
        result: {
          verdict: 'error',
          timedOut: kill.timedOut,
          exitCode,
          stdout: '',
          stderr,
          stdoutTruncated,
          stderrTruncated: false,
          diskLimitExceeded: kill.diskLimitExceeded,
          artifacts: {},
          deniedOperations: [],
          resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
        },
        submittedPaths,
      })),
  );
}

// -- Property 2 -----------------------------------------------------------------

describe(PROPERTY, () => {
  it('ranks timed-out or disk-capped above a sentinel exit code and a build-failure-shaped stderr line', () => {
    fc.assert(
      fc.property(killedWithContradictingResidueArbitrary(), ({ result, submittedPaths }) => {
        const attribution = classifyRunFailure(result, submittedPaths);

        if (result.timedOut) {
          expect(attribution.cause).toBe('timed-out');
        } else {
          expect(attribution.cause).toBe('disk-capped');
        }
        // A resource-bound cause carries no attributed files: the kill is a fact
        // about our own resource limit, not about which submitted file failed.
        expect(attribution.attributedFiles).toEqual([]);
      }),
      propertyParameters(),
    );
  });

  it('ranks a wall-clock timeout above a disk-cap kill when both flags are set', () => {
    // classifyRunFailure checks `timedOut` first (Req 2.2 before 2.3), so a run
    // that tripped both bounds must still report `timed-out`, not `disk-capped`.
    const bothKilledArbitrary = submittedPathsArbitrary.chain((submittedPaths) =>
      fc
        .record({
          exitCode: sentinelExitCodeArbitrary,
          stderr: buildFailureLookingStderr(submittedPaths),
        })
        .map(({ exitCode, stderr }) => ({ submittedPaths, exitCode, stderr })),
    );

    fc.assert(
      fc.property(bothKilledArbitrary, ({ submittedPaths, exitCode, stderr }) => {
        const result: SandboxResult = {
          verdict: 'error',
          timedOut: true,
          exitCode,
          stdout: '',
          stderr,
          stdoutTruncated: false,
          stderrTruncated: false,
          diskLimitExceeded: true,
          artifacts: {},
          deniedOperations: [],
          resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
        };
        expect(classifyRunFailure(result, submittedPaths).cause).toBe('timed-out');
      }),
      propertyParameters(),
    );
  });

  it('never reports build-failed for a killed run, however many submitted paths its stderr names', () => {
    fc.assert(
      fc.property(killedWithContradictingResidueArbitrary(), ({ result, submittedPaths }) => {
        expect(classifyRunFailure(result, submittedPaths).cause).not.toBe('build-failed');
      }),
      propertyParameters(),
    );
  });

  it('reproduces the measured multi_16bit disk-cap residue as unchecked, not build-failed', () => {
    // The real diagnostic captured on the committed campaign-readiness slice:
    // `control-stderr.txt` reads a disk-cap message, not a syntax error, but the
    // point measured in requirements.md is the same - a kill's own diagnostic
    // line must never resolve to a build cause. This is the unit-example anchor
    // for the property above.
    const result: SandboxResult = {
      verdict: 'error',
      timedOut: false,
      exitCode: 137,
      stdout: '',
      stderr: 'workspace reached its 134217728-byte disk cap',
      stdoutTruncated: false,
      stderrTruncated: false,
      diskLimitExceeded: true,
      artifacts: {},
      deniedOperations: [],
      resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
    };

    const attribution = classifyRunFailure(result, ['multi_16bit_tb.v', 'multi_16bit.v']);

    expect(attribution.cause).toBe('disk-capped');
    expect(attribution.attributedFiles).toEqual([]);
  });
});
